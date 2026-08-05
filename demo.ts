/**
 * Demo local do gateway de pagamentos — não faz parte do projeto (não commitado).
 * Roda os comportamentos que mais importam contra o Postgres do docker-compose,
 * usando o provider fake (sem rede, sem chave):
 *
 *   1. idempotência da criação (mesma chave → um pagamento, sem cobrar 2x)
 *   2. ciclo de vida: autorizar → capturar → estornar (com auditoria)
 *   3. máquina de estados barra transição inválida
 *   4. webhook: assinatura inválida é rejeitada
 *   5. webhook idempotente: mesmo evento 2x → captura 1x
 *   6. reconciliação: provedor à frente → corrige o local
 *   7. redação: token/segredo nunca vão para o log
 *
 *   node --env-file=.env demo.ts
 */
import { montarApp } from './src/app.ts';
import { config } from './src/config.ts';
import { criarBanco } from './src/db/conexao.ts';
import { migrar } from './src/db/migrar.ts';
import { ProvedorFake } from './src/provedores/fake.ts';
import { RegistroDeProvedores } from './src/provedores/registro.ts';
import { assinarHmac } from './src/seguranca/hmac.ts';
import { redigir } from './src/seguranca/redacao.ts';

function titulo(t: string): void {
  console.log(`\n\x1b[1m\x1b[36m${t}\x1b[0m`);
}
function ok(t: string): void {
  console.log(`  \x1b[32m✓\x1b[0m ${t}`);
}

async function main(): Promise<void> {
  await migrar(process.env.DATABASE_URL);
  const db = criarBanco(process.env.DATABASE_URL);
  await db.deleteFrom('webhook_eventos').execute();
  await db.deleteFrom('pagamentos').execute();

  const fake = new ProvedorFake(config.fakeWebhookSecret);
  const registro = new RegistroDeProvedores().registrar(fake);
  const app = montarApp({ db, registro });
  await app.ready();

  const criar = (chave: string, corpo: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: '/pagamentos',
      headers: { 'idempotency-key': chave },
      payload: { provedor: 'fake', valorCentavos: 4990, moeda: 'BRL', tokenMetodo: 'pm_card_ok_4242', ...corpo },
    });

  // 1. Idempotência da criação -------------------------------------------------
  titulo('1. Idempotência da criação (mesma chave, sem cobrança dupla)');
  const a1 = await criar('fatura-2026-08');
  const a2 = await criar('fatura-2026-08');
  const total = await db
    .selectFrom('pagamentos')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  ok(`duas requisições com a mesma Idempotency-Key → id ${a1.json().id} nas duas, ${Number(total.n)} pagamento no banco`);

  // 2. Ciclo de vida -----------------------------------------------------------
  titulo('2. Ciclo de vida: autorizar → capturar → estornar');
  const id = a1.json().id as number;
  ok(`estado inicial: ${a1.json().estado}`);
  ok(`após capturar:  ${(await app.inject({ method: 'POST', url: `/pagamentos/${id}/capturar` })).json().estado}`);
  ok(`após estornar:  ${(await app.inject({ method: 'POST', url: `/pagamentos/${id}/estornar` })).json().estado}`);
  const trans = await db
    .selectFrom('transicoes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('pagamento_id', '=', id)
    .executeTakeFirstOrThrow();
  ok(`transições auditadas: ${Number(trans.n)} (criado, autorizado, capturado, estornado)`);

  // 3. Máquina de estados ------------------------------------------------------
  titulo('3. Máquina de estados barra transição inválida');
  const invalida = await app.inject({ method: 'POST', url: `/pagamentos/${id}/capturar` });
  ok(`capturar um pagamento já estornado → HTTP ${invalida.statusCode} ${invalida.json().erro.codigo}`);

  // 4. Assinatura de webhook ---------------------------------------------------
  titulo('4. Webhook com assinatura inválida é rejeitado');
  const semAssinatura = await app.inject({
    method: 'POST',
    url: '/webhooks/fake',
    headers: { 'x-assinatura': 'forjada', 'content-type': 'application/json' },
    payload: JSON.stringify({ id: 'evt_x', tipo: 'payment_intent.succeeded' }),
  });
  ok(`assinatura forjada → HTTP ${semAssinatura.statusCode} ${semAssinatura.json().erro.codigo}`);

  // 5. Webhook idempotente -----------------------------------------------------
  titulo('5. Webhook idempotente: mesmo evento 2x captura 1x');
  const nova = await criar('assinatura-mensal');
  const ref = nova.json().referenciaExterna as string;
  const corpo = JSON.stringify({
    id: 'evt_captura_1',
    tipo: 'payment_intent.succeeded',
    referenciaExterna: ref,
    estado: 'capturado',
  });
  const assinatura = assinarHmac(Buffer.from(corpo, 'utf8'), config.fakeWebhookSecret);
  const enviar = () =>
    app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'x-assinatura': assinatura, 'content-type': 'application/json' },
      payload: corpo,
    });
  const w1 = await enviar();
  const w2 = await enviar();
  const capturas = await db
    .selectFrom('transicoes')
    .innerJoin('pagamentos', 'pagamentos.id', 'transicoes.pagamento_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('pagamentos.referencia_externa', '=', ref)
    .where('transicoes.para_estado', '=', 'capturado')
    .executeTakeFirstOrThrow();
  ok(`1º envio processado=${w1.json().processado}, 2º envio processado=${w2.json().processado}`);
  ok(`capturas registradas: ${Number(capturas.n)} (o duplicado virou no-op)`);

  // 6. Reconciliação -----------------------------------------------------------
  titulo('6. Reconciliação: provedor à frente corrige o local');
  const rec = await criar('pedido-777');
  const recId = rec.json().id as number;
  const recRef = rec.json().referenciaExterna as string;
  await fake.capturar(recRef); // provedor capturou; o webhook "se perdeu"
  ok(`antes: local=${rec.json().estado}, provedor=capturado (webhook perdido)`);
  const reconciliado = await app.inject({ method: 'POST', url: `/pagamentos/${recId}/reconciliar` });
  ok(`após /reconciliar: local=${reconciliado.json().estado}, ajustado=${reconciliado.json().ajustado}`);

  // 7. Redação -----------------------------------------------------------------
  titulo('7. Redação: token e segredo nunca vão para o log');
  const redigido = redigir({
    valorCentavos: 4990,
    tokenMetodo: 'pm_card_ok_4242',
    authorization: 'Bearer sk_test_supersecreto',
  }) as Record<string, unknown>;
  ok(`objeto logável: ${JSON.stringify(redigido)}`);

  await app.close();
  await db.destroy();
  console.log('\n\x1b[1m\x1b[32mDemo concluído.\x1b[0m');
}

main().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});
