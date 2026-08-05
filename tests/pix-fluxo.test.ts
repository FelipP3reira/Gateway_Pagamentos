import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { config } from '../src/config.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { assinarHmac } from '../src/seguranca/hmac.ts';
import { limparBanco } from './auxiliar.ts';

const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;

beforeEach(async () => {
  await limparBanco(db);
  await db.deleteFrom('chaves_pix').execute();
  app = montarApp({ db });
});
afterAll(() => db.destroy());

async function criarCobranca(chaveIdem: string): Promise<{ pagamentoId: number; txid: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/pix/cobrancas',
    headers: { 'idempotency-key': chaveIdem },
    payload: { chave: 'felipe@exemplo.test', valorCentavos: 4990 },
  });
  expect(r.statusCode).toBe(201);
  return { pagamentoId: r.json().pagamentoId as number, txid: r.json().txid as string };
}

function webhook(txid: string, eventoId: string, status = 'CONCLUIDA') {
  const corpo = JSON.stringify({ id: eventoId, txid, status });
  return {
    payload: corpo,
    assinatura: assinarHmac(Buffer.from(corpo, 'utf8'), config.fakeWebhookSecret),
  };
}

async function estado(pagamentoId: number): Promise<string> {
  return (await app.inject({ method: 'GET', url: `/pagamentos/${pagamentoId}` })).json()
    .estado as string;
}

describe('fluxo PIX', () => {
  it('gera uma chave aleatória de sandbox', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/pix/chaves',
      payload: { tipo: 'aleatoria', titular: 'Felipe Pereira' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ tipo: 'aleatoria', sandbox: true });
    expect(r.json().chave).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cria a cobrança com copia-e-cola e QR', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/pix/cobrancas',
      headers: { 'idempotency-key': 'ped-1' },
      payload: { chave: 'felipe@exemplo.test', valorCentavos: 4990 },
    });
    const corpo = r.json();
    expect(corpo.estado).toBe('pendente');
    expect(corpo.copiaECola.startsWith('000201')).toBe(true);
    expect(corpo.qrCodeSvg).toContain('<svg');
    expect(corpo.qrCodePng.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('o webhook de confirmação liquida o pagamento (pendente → capturado)', async () => {
    const { pagamentoId, txid } = await criarCobranca('ped-2');
    expect(await estado(pagamentoId)).toBe('pendente');

    const { payload, assinatura } = webhook(txid, 'evt_pix_1');
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/pix',
      headers: { 'x-assinatura': assinatura, 'content-type': 'application/json' },
      payload,
    });

    expect(resposta.json()).toMatchObject({ processado: true });
    expect(await estado(pagamentoId)).toBe('capturado');
  });

  it('confirmação duplicada não liquida duas vezes', async () => {
    const { pagamentoId, txid } = await criarCobranca('ped-3');
    const { payload, assinatura } = webhook(txid, 'evt_pix_dup');
    const enviar = () =>
      app.inject({
        method: 'POST',
        url: '/webhooks/pix',
        headers: { 'x-assinatura': assinatura, 'content-type': 'application/json' },
        payload,
      });

    const w1 = await enviar();
    const w2 = await enviar();
    expect(w1.json().processado).toBe(true);
    expect(w2.json().processado).toBe(false);

    const capturas = await db
      .selectFrom('transicoes')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('pagamento_id', '=', pagamentoId)
      .where('para_estado', '=', 'capturado')
      .executeTakeFirstOrThrow();
    expect(Number(capturas.n)).toBe(1);
  });

  it('webhook PIX com assinatura inválida é rejeitado com 401', async () => {
    const { txid } = await criarCobranca('ped-4');
    const { payload } = webhook(txid, 'evt_pix_x');
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/pix',
      headers: { 'x-assinatura': 'forjada', 'content-type': 'application/json' },
      payload,
    });
    expect(resposta.statusCode).toBe(401);
  });

  it('a cobrança é idempotente pela chave', async () => {
    const a = await criarCobranca('ped-igual');
    const b = await criarCobranca('ped-igual');
    expect(b.pagamentoId).toBe(a.pagamentoId);
    expect(b.txid).toBe(a.txid);
  });
});
