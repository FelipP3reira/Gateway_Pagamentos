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
  app = montarApp({ db });
});
afterAll(() => db.destroy());

// Cria um pagamento autorizado e devolve a referência do provedor.
async function autorizarPagamento(): Promise<string> {
  const resposta = await app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': `cobranca-${Date.now()}-${Math.random()}` },
    payload: { provedor: 'fake', valorCentavos: 5000, moeda: 'BRL', tokenMetodo: 'tok_fake_ok' },
  });
  expect(resposta.statusCode).toBe(201);
  return resposta.json().referenciaExterna as string;
}

function webhookCaptura(referencia: string, eventoId: string) {
  const corpo = JSON.stringify({
    id: eventoId,
    tipo: 'payment_intent.succeeded',
    referenciaExterna: referencia,
    estado: 'capturado',
  });
  return {
    payload: corpo,
    assinatura: assinarHmac(Buffer.from(corpo, 'utf8'), config.fakeWebhookSecret),
  };
}

async function contarCapturas(referencia: string): Promise<number> {
  const linha = await db
    .selectFrom('transicoes')
    .innerJoin('pagamentos', 'pagamentos.id', 'transicoes.pagamento_id')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('pagamentos.referencia_externa', '=', referencia)
    .where('transicoes.para_estado', '=', 'capturado')
    .executeTakeFirstOrThrow();
  return Number(linha.n);
}

describe('idempotência de webhook', () => {
  it('o mesmo evento duas vezes captura só uma vez', async () => {
    const referencia = await autorizarPagamento();
    const { payload, assinatura } = webhookCaptura(referencia, 'evt_unico');

    const primeira = await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'x-assinatura': assinatura, 'content-type': 'application/json' },
      payload,
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'x-assinatura': assinatura, 'content-type': 'application/json' },
      payload,
    });

    expect(primeira.json()).toMatchObject({ recebido: true, processado: true });
    // O duplicado é reconhecido e vira no-op.
    expect(segunda.json()).toMatchObject({ recebido: true, processado: false });

    // O que realmente importa: capturou uma vez só.
    expect(await contarCapturas(referencia)).toBe(1);
  });

  it('dois eventos distintos que mandam capturar não capturam duas vezes', async () => {
    const referencia = await autorizarPagamento();
    const a = webhookCaptura(referencia, 'evt_a');
    const b = webhookCaptura(referencia, 'evt_b');

    await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'x-assinatura': a.assinatura, 'content-type': 'application/json' },
      payload: a.payload,
    });
    const segunda = await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'x-assinatura': b.assinatura, 'content-type': 'application/json' },
      payload: b.payload,
    });

    // O segundo evento é novo (processado), mas a máquina de estados barra a
    // segunda captura: capturado não volta a capturar.
    expect(segunda.json()).toMatchObject({ processado: true });
    expect(await contarCapturas(referencia)).toBe(1);
  });

  it('webhook com assinatura inválida é rejeitado com 401', async () => {
    const referencia = await autorizarPagamento();
    const { payload } = webhookCaptura(referencia, 'evt_x');

    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'x-assinatura': 'assinatura-falsa', 'content-type': 'application/json' },
      payload,
    });

    expect(resposta.statusCode).toBe(401);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'assinatura_invalida' } });
    // E não capturou nada.
    expect(await contarCapturas(referencia)).toBe(0);
  });
});
