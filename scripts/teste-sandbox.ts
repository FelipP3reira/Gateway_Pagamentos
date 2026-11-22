// Teste de ponta a ponta contra o gateway publicado, com o Mercado Pago em
// SANDBOX (credenciais de teste). Não usa o banco: fala só HTTP, como a loja.
//
//   GATEWAY_URL=https://gateway.exemplo.com \
//   GATEWAY_API_KEY=... \
//   MERCADOPAGO_PUBLIC_KEY=TEST-... \
//   PAGADOR_EMAIL=test_user_123@testuser.com \
//   node --experimental-strip-types scripts/teste-sandbox.ts
//
// Cobre: saúde; cartão aprovado (titular APRO) em 3x; cartão recusado (OTHE);
// idempotência (mesma chave = mesmo pagamento); estorno; Pix com QR e
// cancelamento; consulta por referência; reconciliação; e, se a loja estiver
// configurada, a notificação assinada para ela.
//
// Cartões de teste: https://www.mercadopago.com.br/developers/pt/docs/checkout-api/integration-test/test-cards

type Json = Record<string, unknown>;

const URL_GATEWAY = exigir('GATEWAY_URL').replace(/\/$/, '');
const CHAVE = exigir('GATEWAY_API_KEY');
const CHAVE_PUBLICA = exigir('MERCADOPAGO_PUBLIC_KEY');
const EMAIL = exigir('PAGADOR_EMAIL');
const CPF_TESTE = '12345678909';

if (!CHAVE_PUBLICA.startsWith('TEST-') && process.env.PERMITIR_PRODUCAO !== 'sim') {
  console.error('MERCADOPAGO_PUBLIC_KEY não é de teste (TEST-...). Abortado.');
  process.exit(1);
}

function exigir(nome: string): string {
  const v = process.env[nome];
  if (!v) {
    console.error(`Defina ${nome}.`);
    process.exit(1);
  }
  return v;
}

const resultados: { etapa: string; ok: boolean; detalhe: string }[] = [];
function registrar(etapa: string, ok: boolean, detalhe = '') {
  resultados.push({ etapa, ok, detalhe });
  console.log(`${ok ? '✓' : '✗'} ${etapa}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function gateway(
  metodo: 'GET' | 'POST',
  caminho: string,
  corpo?: Json,
  idempotencia?: string,
): Promise<{ status: number; dados: Json }> {
  const r = await fetch(`${URL_GATEWAY}${caminho}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${CHAVE}`,
      ...(corpo ? { 'content-type': 'application/json' } : {}),
      ...(idempotencia ? { 'idempotency-key': idempotencia } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await r.text();
  return { status: r.status, dados: texto ? (JSON.parse(texto) as Json) : {} };
}

// O navegador faz isto com o SDK (Secure Fields); aqui a API pública de tokens.
async function tokenDoCartao(titular: 'APRO' | 'OTHE'): Promise<string> {
  const r = await fetch(
    `https://api.mercadopago.com/v1/card_tokens?public_key=${encodeURIComponent(CHAVE_PUBLICA)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        card_number: '5031433215406351', // Mastercard de teste
        expiration_month: 11,
        expiration_year: new Date().getFullYear() + 4,
        security_code: '123',
        cardholder: { name: titular, identification: { type: 'CPF', number: CPF_TESTE } },
      }),
    },
  );
  const dados = (await r.json()) as Json;
  if (!r.ok || typeof dados.id !== 'string')
    throw new Error(`Token do cartão falhou (${r.status}): ${JSON.stringify(dados)}`);
  return dados.id;
}

async function esperarEstado(id: number, alvos: string[], segundos = 30): Promise<string> {
  const limite = Date.now() + segundos * 1000;
  let estado = '';
  while (Date.now() < limite) {
    const { dados } = await gateway('GET', `/pagamentos/${id}`);
    estado = String(dados.estado);
    if (alvos.includes(estado)) return estado;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return estado;
}

const pagador = { email: EMAIL, tipoDocumento: 'CPF', documento: CPF_TESTE };

async function principal() {
  const saude = await fetch(`${URL_GATEWAY}/saude`);
  registrar('saúde', saude.ok, `HTTP ${saude.status}`);

  const semChave = await fetch(`${URL_GATEWAY}/pagamentos/1`);
  registrar('API exige a chave', semChave.status === 401, `HTTP ${semChave.status}`);

  // Cartão aprovado, 3x.
  const ref = `sandbox-${Date.now()}`;
  const chave = crypto.randomUUID();
  const corpoCartao = {
    provedor: 'mercadopago',
    metodo: 'cartao',
    valorCentavos: 15_000,
    moeda: 'BRL',
    tokenMetodo: await tokenDoCartao('APRO'),
    metodoPagamentoId: 'master',
    parcelas: 3,
    capturaAutomatica: true,
    descricao: 'Teste sandbox Pandim',
    pagador,
    referenciaPedido: ref,
  };
  const aprovado = await gateway('POST', '/pagamentos', corpoCartao, chave);
  const idAprovado = Number(aprovado.dados.id);
  const estadoAprovado = await esperarEstado(idAprovado, ['capturado', 'falhou']);
  registrar('cartão aprovado em 3x', estadoAprovado === 'capturado', `estado ${estadoAprovado}`);

  // Mesma Idempotency-Key: devolve o mesmo pagamento, não cobra de novo.
  const repetido = await gateway('POST', '/pagamentos', corpoCartao, chave);
  registrar(
    'idempotência',
    Number(repetido.dados.id) === idAprovado,
    `id ${String(repetido.dados.id)} = ${idAprovado}`,
  );

  const porRef = await gateway('GET', `/pagamentos?referenciaPedido=${ref}`);
  const lista = (porRef.dados.pagamentos as Json[] | undefined) ?? [];
  registrar('consulta por referência', lista.length === 1, `${lista.length} pagamento(s)`);

  const recon = await gateway('POST', `/pagamentos/${idAprovado}/reconciliar`);
  registrar('reconciliação', recon.status === 200, `estado ${String(recon.dados.estado)}`);

  const estorno = await gateway('POST', `/pagamentos/${idAprovado}/estornar`);
  const estadoEstorno = await esperarEstado(idAprovado, ['estornado']);
  registrar('estorno', estadoEstorno === 'estornado', `HTTP ${estorno.status}, ${estadoEstorno}`);

  // Cartão recusado.
  const recusado = await gateway(
    'POST',
    '/pagamentos',
    { ...corpoCartao, tokenMetodo: await tokenDoCartao('OTHE'), referenciaPedido: `${ref}-r` },
    crypto.randomUUID(),
  );
  const estadoRecusado = await esperarEstado(Number(recusado.dados.id), ['falhou', 'cancelado']);
  registrar('cartão recusado', estadoRecusado === 'falhou', `estado ${estadoRecusado}`);

  // Pix: QR e copia e cola; no sandbox não dá para pagar, então cancela.
  const pix = await gateway(
    'POST',
    '/pagamentos',
    {
      provedor: 'mercadopago',
      metodo: 'pix',
      valorCentavos: 9_990,
      moeda: 'BRL',
      pagador,
      pixExpiraEmMinutos: 30,
      referenciaPedido: `${ref}-pix`,
    },
    crypto.randomUUID(),
  );
  const dadosPix = pix.dados.pix as Json | null;
  registrar(
    'Pix com QR e copia e cola',
    pix.status === 201 && typeof dadosPix?.copiaECola === 'string',
    `estado ${String(pix.dados.estado)}`,
  );
  const cancelado = await gateway('POST', `/pagamentos/${String(pix.dados.id)}/cancelar`);
  registrar('Pix cancelado', cancelado.dados.estado === 'cancelado', `HTTP ${cancelado.status}`);

  // Notificação para a loja (só se o gateway tiver LOJA_URL).
  const notif = await gateway('GET', `/notificacoes?pagamentoId=${idAprovado}`);
  if (notif.status === 200) {
    const itens = (notif.dados.notificacoes as Json[] | undefined) ?? [];
    const entregues = itens.filter((n) => n.status === 'entregue').length;
    registrar(
      'notificação assinada para a loja',
      entregues > 0,
      `${entregues}/${itens.length} entregue(s)`,
    );
  }

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} etapas ok.`);
  process.exit(falhas.length ? 1 : 0);
}

principal().catch((erro: unknown) => {
  console.error(erro);
  process.exit(1);
});
