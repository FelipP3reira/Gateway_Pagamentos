import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { AdaptadorMercadoPago } from '../src/provedores/mercadopago.ts';
import { RegistroDeProvedores } from '../src/provedores/registro.ts';
import { AdaptadorStripe, type ClienteStripe } from '../src/provedores/stripe.ts';
import { limparBanco } from './auxiliar.ts';
import { agoraEmSegundos, assinarMp, MercadoPagoFalso, SEGREDO_MP } from './mp-auxiliar.ts';

const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;
let mp: MercadoPagoFalso;

const PAGADOR = { email: 'cliente@exemplo.com', tipoDocumento: 'CPF', documento: '12345678909' };

beforeEach(async () => {
  await limparBanco(db);
  mp = new MercadoPagoFalso();
  const registro = new RegistroDeProvedores()
    .registrar(
      new AdaptadorMercadoPago({
        accessToken: 'TEST-x',
        segredoWebhook: SEGREDO_MP,
        http: mp.http,
      }),
    )
    // Stripe com cliente vazio: só para testar "método indisponível".
    .registrar(new AdaptadorStripe({} as ClienteStripe, 'whsec'));
  app = montarApp({ db, registro });
});
afterAll(() => db.destroy());

function criar(chave: string, corpo: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': chave },
    payload: { provedor: 'mercadopago', valorCentavos: 15_990, moeda: 'BRL', ...corpo },
  });
}

function criarPix(chave: string, corpo: Record<string, unknown> = {}) {
  return criar(chave, { metodo: 'pix', pagador: PAGADOR, ...corpo });
}

function criarCartao(chave: string, corpo: Record<string, unknown> = {}) {
  return criar(chave, {
    tokenMetodo: 'card_token',
    metodoPagamentoId: 'master',
    parcelas: 3,
    capturaAutomatica: true,
    pagador: PAGADOR,
    ...corpo,
  });
}

function webhook(dataId: string, opcoes: { idNotificacao?: number; segredo?: string } = {}) {
  const requestId = `req-${dataId}-${opcoes.idNotificacao ?? 1}`;
  return app.inject({
    method: 'POST',
    url: `/webhooks/mercadopago?data.id=${dataId}&type=payment`,
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'x-signature': assinarMp({
        dataId,
        requestId,
        ts: agoraEmSegundos(),
        segredo: opcoes.segredo,
      }),
    },
    payload: JSON.stringify({
      id: opcoes.idNotificacao ?? 1,
      type: 'payment',
      action: 'payment.updated',
      data: { id: dataId },
    }),
  });
}

async function transicoes(pagamentoId: number) {
  return db
    .selectFrom('transicoes')
    .select(['de_estado', 'para_estado'])
    .where('pagamento_id', '=', pagamentoId)
    .orderBy('id')
    .execute();
}

async function contarPagamentos(): Promise<number> {
  const linha = await db
    .selectFrom('pagamentos')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(linha.n);
}

describe('Pix pelo Mercado Pago', () => {
  it('cria pendente com o QR e liquida pelo webhook assinado', async () => {
    const criado = await criarPix('pix-1');
    expect(criado.statusCode).toBe(201);
    const pagamento = criado.json();
    expect(pagamento).toMatchObject({
      estado: 'pendente',
      metodo: 'pix',
      parcelas: 1,
      pix: {
        copiaECola: expect.stringContaining('br.gov.bcb.pix'),
        qrCodeBase64: expect.any(String),
        urlTicket: expect.stringContaining('/ticket'),
      },
    });
    // Validade padrão de 30 minutos.
    const expira = new Date(pagamento.pix.expiraEm as string).getTime();
    expect(expira - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(expira - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 5_000);

    // O cliente pagou: o Mercado Pago aprova e notifica.
    mp.definirStatus(pagamento.referenciaExterna as string, 'approved');
    const recebido = await webhook(pagamento.referenciaExterna as string);
    expect(recebido.statusCode).toBe(200);
    expect(recebido.json()).toEqual({ recebido: true, processado: true });

    const atual = await app.inject({ method: 'GET', url: `/pagamentos/${pagamento.id}` });
    expect(atual.json()).toMatchObject({ estado: 'capturado' });
    // O caminho inteiro fica auditado.
    expect(await transicoes(pagamento.id as number)).toEqual([
      { de_estado: null, para_estado: 'pendente' },
      { de_estado: 'pendente', para_estado: 'autorizado' },
      { de_estado: 'autorizado', para_estado: 'capturado' },
    ]);
  });

  it('a mesma notificação duas vezes liquida uma vez só', async () => {
    const pagamento = (await criarPix('pix-dup')).json();
    mp.definirStatus(pagamento.referenciaExterna as string, 'approved');

    expect((await webhook(pagamento.referenciaExterna as string)).json().processado).toBe(true);
    expect((await webhook(pagamento.referenciaExterna as string)).json().processado).toBe(false);
    expect(await transicoes(pagamento.id as number)).toHaveLength(3);
  });

  it('Pix expirado vira cancelado', async () => {
    const pagamento = (await criarPix('pix-exp')).json();
    mp.definirStatus(pagamento.referenciaExterna as string, 'cancelled');
    await webhook(pagamento.referenciaExterna as string);

    const atual = await app.inject({ method: 'GET', url: `/pagamentos/${pagamento.id}` });
    expect(atual.json()).toMatchObject({ estado: 'cancelado' });
  });

  it('se a consulta ao provedor falha, responde 502 e o reenvio funciona', async () => {
    const pagamento = (await criarPix('pix-502')).json();
    mp.definirStatus(pagamento.referenciaExterna as string, 'approved');

    mp.falharConsulta = true;
    const falhou = await webhook(pagamento.referenciaExterna as string);
    expect(falhou.statusCode).toBe(502);

    // O evento não ficou marcado como tratado: o reenvio do provedor aplica.
    mp.falharConsulta = false;
    const reenvio = await webhook(pagamento.referenciaExterna as string);
    expect(reenvio.json()).toEqual({ recebido: true, processado: true });
    const atual = await app.inject({ method: 'GET', url: `/pagamentos/${pagamento.id}` });
    expect(atual.json()).toMatchObject({ estado: 'capturado' });
  });

  it('notificação de pagamento alheio é aceita sem consultar o provedor', async () => {
    const recebido = await webhook('555555');
    expect(recebido.statusCode).toBe(200);
    expect(mp.chamadas.filter((c) => c.metodo === 'GET')).toHaveLength(0);
  });

  it('webhook com assinatura errada é 401 e não consulta nada', async () => {
    const pagamento = (await criarPix('pix-401')).json();
    const recebido = await webhook(pagamento.referenciaExterna as string, { segredo: 'errado' });
    expect(recebido.statusCode).toBe(401);
    expect(mp.chamadas.filter((c) => c.metodo === 'GET')).toHaveLength(0);
  });

  it('aceita validade personalizada e recusa parcelas no Pix', async () => {
    const longo = await criarPix('pix-60', { pixExpiraEmMinutos: 60 });
    expect(longo.statusCode).toBe(201);

    const curto = await criarPix('pix-10', { pixExpiraEmMinutos: 10 });
    expect(curto.statusCode).toBe(400);

    const parcelado = await criarPix('pix-3x', { parcelas: 3 });
    expect(parcelado.statusCode).toBe(400);
    expect(parcelado.json()).toMatchObject({ erro: { codigo: 'parcelas_invalidas' } });
    expect(await contarPagamentos()).toBe(1);
  });
});

describe('cartão pelo Mercado Pago', () => {
  it('aprovado na hora: capturado, com parcelas e bandeira', async () => {
    const criado = await criarCartao('c-1');
    expect(criado.statusCode).toBe(201);
    expect(criado.json()).toMatchObject({
      estado: 'capturado',
      metodo: 'cartao',
      parcelas: 3,
      metodoPagamentoId: 'master',
      pix: null,
    });
    expect(mp.chamadas[0]!.corpo).toMatchObject({ installments: 3, payment_method_id: 'master' });
  });

  it('recusa definitiva do provedor (400): falhou, sem ficar pendente', async () => {
    mp.proximaCriacao = { status: 400, corpo: { message: 'bad', cause: [{ code: 3003 }] } };
    const criado = await criarCartao('c-400');
    expect(criado.statusCode).toBe(201);
    expect(criado.json()).toMatchObject({ estado: 'falhou' });
  });

  it('recusado pelo banco (status rejected): falhou', async () => {
    mp.proximaCriacao = { status: 201, corpo: { status: 'rejected' } };
    expect((await criarCartao('c-rej')).json()).toMatchObject({ estado: 'falhou' });
  });

  it('provedor fora do ar (500): 502 e fica pendente', async () => {
    mp.proximaCriacao = { status: 500, corpo: {} };
    const criado = await criarCartao('c-500');
    expect(criado.statusCode).toBe(502);
    const linha = await db.selectFrom('pagamentos').select('estado').executeTakeFirstOrThrow();
    expect(linha.estado).toBe('pendente');
  });

  it('em análise (in_process) fica pendente e a reconciliação alcança o aprovado', async () => {
    mp.proximaCriacao = { status: 201, corpo: { status: 'in_process' } };
    const criado = (await criarCartao('c-analise')).json();
    expect(criado.estado).toBe('pendente');

    mp.definirStatus(criado.referenciaExterna as string, 'approved');
    const reconciliado = await app.inject({
      method: 'POST',
      url: `/pagamentos/${criado.id}/reconciliar`,
    });
    expect(reconciliado.json()).toMatchObject({ estado: 'capturado', ajustado: true });
  });

  it('autoriza, captura e estorna pelas rotas', async () => {
    const criado = (await criarCartao('c-manual', { capturaAutomatica: false })).json();
    expect(criado.estado).toBe('autorizado');

    const capturado = await app.inject({
      method: 'POST',
      url: `/pagamentos/${criado.id}/capturar`,
    });
    expect(capturado.json()).toMatchObject({ estado: 'capturado' });
    const estornado = await app.inject({
      method: 'POST',
      url: `/pagamentos/${criado.id}/estornar`,
    });
    expect(estornado.json()).toMatchObject({ estado: 'estornado' });
  });
});

describe('validações antes de gravar', () => {
  it.each([
    ['cartão sem token', { tokenMetodo: undefined }, 'token_obrigatorio'],
    ['sem pagador', { pagador: undefined }, 'pagador_obrigatorio'],
    ['sem bandeira', { metodoPagamentoId: undefined }, 'metodo_pagamento_obrigatorio'],
    ['moeda diferente de BRL', { moeda: 'USD' }, 'moeda_invalida'],
    ['acima de 12 parcelas', { parcelas: 13 }, 'parcelas_invalidas'],
  ])('%s: 400 e nada gravado', async (_nome, corpo, codigo) => {
    const resposta = await criarCartao(`v-${codigo}`, corpo);
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json()).toMatchObject({ erro: { codigo } });
    expect(await contarPagamentos()).toBe(0);
    expect(mp.chamadas).toHaveLength(0);
  });

  it('provedor que não cobra Pix: metodo_indisponivel', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/pagamentos',
      headers: { 'idempotency-key': 'stripe-pix' },
      payload: { provedor: 'stripe', metodo: 'pix', valorCentavos: 100, moeda: 'BRL' },
    });
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'metodo_indisponivel' } });
    expect(await contarPagamentos()).toBe(0);
  });
});
