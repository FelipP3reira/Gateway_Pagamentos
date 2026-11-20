import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { EntregadorDeNotificacoes } from '../src/notificacoes/entregador.ts';
import { verificarNotificacao } from '../src/notificacoes/payload.ts';
import { ProvedorFake } from '../src/provedores/fake.ts';
import { RegistroDeProvedores } from '../src/provedores/registro.ts';
import { assinarHmac } from '../src/seguranca/hmac.ts';
import { limparBanco } from './auxiliar.ts';

const SEGREDO_FAKE = 'segredo-fake';
const SEGREDO_LOJA = 'segredo-da-loja-0123456789abcdef0123';
const URL_LOJA = 'https://loja.exemplo.com';

const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;
let fake: ProvedorFake;

// Relógio controlado pelo teste.
let agora: Date;

interface Recebida {
  url: string;
  cabecalhos: Record<string, string>;
  corpo: string;
}

// Loja falsa: registra o que recebeu e responde com o status programado.
class LojaFalsa {
  recebidas: Recebida[] = [];
  respostas: (number | Error)[] = [];

  http = (url: string, init: RequestInit): Promise<Response> => {
    this.recebidas.push({
      url,
      cabecalhos: init.headers as Record<string, string>,
      corpo: init.body as string,
    });
    const proxima = this.respostas.shift() ?? 200;
    if (proxima instanceof Error) {
      return Promise.reject(proxima);
    }
    return Promise.resolve(new Response('{}', { status: proxima }));
  };
}

let loja: LojaFalsa;

function entregador(opcoes: { maxTentativas?: number } = {}) {
  return new EntregadorDeNotificacoes(db, {
    urlLoja: URL_LOJA,
    segredo: SEGREDO_LOJA,
    http: loja.http,
    agora: () => agora,
    // Jitter neutro: atraso = exatamente base * 2^(n-1).
    aleatorio: () => 0.5,
    maxTentativas: opcoes.maxTentativas,
  });
}

beforeEach(async () => {
  await limparBanco(db);
  // Um minuto à frente do relógio real: as notificações nascem com
  // proxima_tentativa_em = now() do banco e já estão vencidas para o entregador.
  agora = new Date(Date.now() + 60_000);
  loja = new LojaFalsa();
  fake = new ProvedorFake(SEGREDO_FAKE);
  app = montarApp({
    db,
    registro: new RegistroDeProvedores().registrar(fake),
    notificarLoja: true,
  });
});
afterAll(() => db.destroy());

function criar(chave: string, corpo: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': chave },
    payload: {
      provedor: 'fake',
      valorCentavos: 12_900,
      moeda: 'BRL',
      tokenMetodo: 'tok_fake_ok',
      ...corpo,
    },
  });
}

function webhookFake(evento: Record<string, unknown>) {
  const corpo = JSON.stringify(evento);
  return app.inject({
    method: 'POST',
    url: '/webhooks/fake',
    headers: {
      'content-type': 'application/json',
      'x-assinatura': assinarHmac(Buffer.from(corpo), SEGREDO_FAKE),
    },
    payload: corpo,
  });
}

function notificacoes() {
  return db.selectFrom('notificacoes_loja').selectAll().orderBy('id').execute();
}

describe('outbox: notificação na mesma transação da mudança', () => {
  it('Pix pago pelo webhook gera UMA notificação com o estado final', async () => {
    const pagamento = (await criar('pix', { metodo: 'pix', referenciaPedido: 'PED-1001' })).json();
    // Criar em pendente não notifica (a loja recebeu a resposta síncrona).
    expect(await notificacoes()).toHaveLength(0);

    await webhookFake({
      id: 'evt_1',
      tipo: 'pix.pago',
      referenciaExterna: pagamento.referenciaExterna,
      estado: 'capturado',
    });

    const fila = await notificacoes();
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ estado: 'capturado', status: 'pendente', tentativas: 0 });

    // A sequência é o id da última transição (autorizado → capturado).
    const ultima = await db
      .selectFrom('transicoes')
      .select('id')
      .where('pagamento_id', '=', pagamento.id as number)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(fila[0]!.sequencia).toBe(ultima.id);

    expect(fila[0]!.payload).toMatchObject({
      evento: 'pagamento.atualizado',
      eventoId: fila[0]!.evento_id,
      sequencia: ultima.id,
      pagamento: {
        id: pagamento.id,
        estado: 'capturado',
        referenciaPedido: 'PED-1001',
        metodo: 'pix',
        valorCentavos: 12_900,
      },
    });
    // O QR não vai na notificação.
    expect(JSON.stringify(fila[0]!.payload)).not.toContain('qrCodeBase64');
  });

  it('cada mudança feita pelas rotas também notifica, em sequência crescente', async () => {
    const pagamento = (await criar('cartao')).json(); // autorizado (1 notificação)
    await app.inject({ method: 'POST', url: `/pagamentos/${pagamento.id}/capturar` });
    await app.inject({ method: 'POST', url: `/pagamentos/${pagamento.id}/estornar` });

    const fila = await notificacoes();
    expect(fila.map((n) => n.estado)).toEqual(['autorizado', 'capturado', 'estornado']);
    const sequencias = fila.map((n) => n.sequencia);
    expect([...sequencias].sort((a, b) => a - b)).toEqual(sequencias);
    expect(new Set(fila.map((n) => n.evento_id)).size).toBe(3);
  });

  it('transição inválida não deixa notificação órfã', async () => {
    const pagamento = (await criar('dup', { capturaAutomatica: true })).json();
    const antes = (await notificacoes()).length;

    const repetida = await app.inject({
      method: 'POST',
      url: `/pagamentos/${pagamento.id}/capturar`,
    });
    expect(repetida.statusCode).toBe(409);
    expect(await notificacoes()).toHaveLength(antes);
  });

  it('webhook duplicado não duplica a notificação', async () => {
    const pagamento = (await criar('pix-dup', { metodo: 'pix' })).json();
    const evento = {
      id: 'evt_dup',
      tipo: 'pix.pago',
      referenciaExterna: pagamento.referenciaExterna,
      estado: 'capturado',
    };
    await webhookFake(evento);
    await webhookFake(evento);
    expect(await notificacoes()).toHaveLength(1);
  });

  it('desligado (sem LOJA_URL), nada é enfileirado', async () => {
    const semLoja = montarApp({
      db,
      registro: new RegistroDeProvedores().registrar(fake),
      notificarLoja: false,
    });
    await semLoja.inject({
      method: 'POST',
      url: '/pagamentos',
      headers: { 'idempotency-key': 'sem-loja' },
      payload: { provedor: 'fake', valorCentavos: 100, moeda: 'BRL', tokenMetodo: 't' },
    });
    expect(await notificacoes()).toHaveLength(0);
    await semLoja.close();
  });
});

describe('entregador', () => {
  it('entrega com POST assinado e marca como entregue', async () => {
    await criar('entrega');
    const resultado = await entregador().processarLote();
    expect(resultado).toEqual({ entregues: 1, falhas: 0 });

    const recebida = loja.recebidas[0]!;
    expect(recebida.url).toBe('https://loja.exemplo.com/api/webhooks/gateway');
    const [notificacao] = await notificacoes();
    expect(recebida.cabecalhos['X-Gateway-Evento']).toBe(notificacao!.evento_id);
    expect(JSON.parse(recebida.corpo)).toEqual(notificacao!.payload);

    // A loja consegue verificar a assinatura com o segredo compartilhado.
    const agoraSegundos = Math.floor(agora.getTime() / 1000);
    const base = { corpo: recebida.corpo, agoraSegundos };
    const cabecalho = recebida.cabecalhos['X-Gateway-Assinatura'];
    expect(verificarNotificacao({ ...base, cabecalho, segredo: SEGREDO_LOJA })).toBe(true);
    expect(verificarNotificacao({ ...base, cabecalho, segredo: 'outro' })).toBe(false);
    expect(
      verificarNotificacao({
        ...base,
        corpo: `${recebida.corpo} `,
        cabecalho,
        segredo: SEGREDO_LOJA,
      }),
    ).toBe(false);
    // Replay: a mesma assinatura uma hora depois é recusada.
    expect(
      verificarNotificacao({
        ...base,
        agoraSegundos: agoraSegundos + 3600,
        cabecalho,
        segredo: SEGREDO_LOJA,
      }),
    ).toBe(false);

    expect(notificacao).toMatchObject({ status: 'entregue', tentativas: 1, ultimo_erro: null });
    const tentativas = await db.selectFrom('tentativas_notificacao').selectAll().execute();
    expect(tentativas).toMatchObject([{ numero: 1, status_http: 200, erro: null }]);
  });

  it('falha com backoff exponencial e entrega quando a loja volta', async () => {
    await criar('backoff');
    loja.respostas = [500, new TypeError('fetch failed'), 200];
    const e = entregador();

    expect(await e.processarLote()).toEqual({ entregues: 0, falhas: 1 });
    let [notificacao] = await notificacoes();
    expect(notificacao).toMatchObject({
      status: 'pendente',
      tentativas: 1,
      ultimo_erro: 'HTTP 500',
    });
    // 1ª falha: espera 30 s.
    expect(notificacao!.proxima_tentativa_em.getTime() - agora.getTime()).toBe(30_000);

    // Antes de vencer, nada acontece.
    agora = new Date(agora.getTime() + 29_000);
    expect(await e.processarLote()).toEqual({ entregues: 0, falhas: 0 });

    // Venceu: erro de rede, 2ª falha → espera 60 s.
    agora = new Date(agora.getTime() + 1_000);
    expect(await e.processarLote()).toEqual({ entregues: 0, falhas: 1 });
    [notificacao] = await notificacoes();
    expect(notificacao!.ultimo_erro).toBe('TypeError: fetch failed');
    expect(notificacao!.proxima_tentativa_em.getTime() - agora.getTime()).toBe(60_000);

    agora = new Date(agora.getTime() + 60_000);
    expect(await e.processarLote()).toEqual({ entregues: 1, falhas: 0 });
    [notificacao] = await notificacoes();
    expect(notificacao).toMatchObject({ status: 'entregue', tentativas: 3 });

    const tentativas = await db
      .selectFrom('tentativas_notificacao')
      .select(['numero', 'status_http', 'erro'])
      .orderBy('id')
      .execute();
    expect(tentativas).toEqual([
      { numero: 1, status_http: 500, erro: 'HTTP 500' },
      { numero: 2, status_http: null, erro: 'TypeError: fetch failed' },
      { numero: 3, status_http: 200, erro: null },
    ]);
  });

  it('o backoff é limitado a 1 hora (com jitter de ±20%)', () => {
    const e = new EntregadorDeNotificacoes(db, {
      urlLoja: URL_LOJA,
      segredo: SEGREDO_LOJA,
      aleatorio: () => 1,
    });
    expect(e.atrasoMs(1)).toBe(36_000);
    expect(e.atrasoMs(30)).toBe(60 * 60_000 * 1.2);
  });

  it('esgota as tentativas, vai para falhou e o reenvio manual recomeça', async () => {
    await criar('esgota');
    loja.respostas = [503, 503, 200];
    const e = entregador({ maxTentativas: 2 });

    await e.processarLote();
    agora = new Date(agora.getTime() + 31_000);
    await e.processarLote();
    let [notificacao] = await notificacoes();
    expect(notificacao).toMatchObject({ status: 'falhou', tentativas: 2 });

    // Falhou não volta sozinha.
    agora = new Date(agora.getTime() + 24 * 60 * 60_000);
    expect(await e.processarLote()).toEqual({ entregues: 0, falhas: 0 });

    const listadas = await app.inject({ method: 'GET', url: '/notificacoes?status=falhou' });
    expect(listadas.json().notificacoes).toHaveLength(1);

    const reenvio = await app.inject({
      method: 'POST',
      url: `/notificacoes/${notificacao!.id}/reenviar`,
    });
    expect(reenvio.json()).toEqual({ id: notificacao!.id, status: 'pendente' });

    // O reenvio usa o relógio real; o entregador precisa estar "depois" dele.
    agora = new Date(Date.now() + 1_000);
    expect(await e.processarLote()).toEqual({ entregues: 1, falhas: 0 });
    [notificacao] = await notificacoes();
    expect(notificacao).toMatchObject({ status: 'entregue', tentativas: 1 });

    const jaEntregue = await app.inject({
      method: 'POST',
      url: `/notificacoes/${notificacao!.id}/reenviar`,
    });
    expect(jaEntregue.statusCode).toBe(404);
  });

  it('duas rodadas simultâneas não entregam a mesma notificação duas vezes', async () => {
    for (let i = 0; i < 5; i++) {
      await criar(`concorrente-${i}`);
    }
    const [a, b] = await Promise.all([entregador().processarLote(), entregador().processarLote()]);
    expect(a.entregues + b.entregues).toBe(5);
    expect(loja.recebidas).toHaveLength(5);
    expect(new Set(loja.recebidas.map((r) => r.cabecalhos['X-Gateway-Evento'])).size).toBe(5);
  });

  it('o laço entrega sozinho e para limpo', async () => {
    await criar('laco');
    const e = new EntregadorDeNotificacoes(db, {
      urlLoja: URL_LOJA,
      segredo: SEGREDO_LOJA,
      http: loja.http,
      intervaloMs: 10,
    });
    e.iniciar();
    for (let i = 0; i < 100 && loja.recebidas.length === 0; i++) {
      await new Promise((resolver) => setTimeout(resolver, 10));
    }
    await e.parar();
    expect(loja.recebidas).toHaveLength(1);
    const [notificacao] = await notificacoes();
    expect(notificacao!.status).toBe('entregue');
  });
});

describe('consulta por referência do pedido', () => {
  it('lista as tentativas do pedido, da mais recente para a mais antiga', async () => {
    const recusada = (
      await criar('t1', { referenciaPedido: 'PED-2002', tokenMetodo: 'tok_fake_falha' })
    ).json();
    const pix = (await criar('t2', { referenciaPedido: 'PED-2002', metodo: 'pix' })).json();
    await criar('t3', { referenciaPedido: 'PED-OUTRO' });

    const resposta = await app.inject({
      method: 'GET',
      url: '/pagamentos?referenciaPedido=PED-2002',
    });
    expect(resposta.statusCode).toBe(200);
    const { pagamentos } = resposta.json();
    expect(pagamentos.map((p: { id: number }) => p.id)).toEqual([pix.id, recusada.id]);
    expect(pagamentos[0]).toMatchObject({ referenciaPedido: 'PED-2002', estado: 'pendente' });
    expect(pagamentos[1]).toMatchObject({ estado: 'falhou' });
  });

  it('pedido sem pagamentos devolve lista vazia', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/pagamentos?referenciaPedido=NADA' });
    expect(resposta.json()).toEqual({ pagamentos: [] });
  });

  it('sem o filtro, ou com caracteres inválidos, é 400', async () => {
    expect((await app.inject({ method: 'GET', url: '/pagamentos' })).statusCode).toBe(400);
    const invalido = await app.inject({
      method: 'GET',
      url: `/pagamentos?referenciaPedido=${encodeURIComponent("x' OR 1=1")}`,
    });
    expect(invalido.statusCode).toBe(400);
    expect((await criar('ruim', { referenciaPedido: 'com espaço' })).statusCode).toBe(400);
  });
});
