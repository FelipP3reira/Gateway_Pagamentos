import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { chaveValida } from '../src/seguranca/autenticacao.ts';
import { limparBanco } from './auxiliar.ts';

const CHAVE_ATUAL = 'chave-atual-0123456789abcdef0123456789';
const CHAVE_ANTERIOR = 'chave-anterior-0123456789abcdef01234567';

const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;

beforeEach(async () => {
  await limparBanco(db);
  app = montarApp({ db, chavesApi: [CHAVE_ATUAL, CHAVE_ANTERIOR] });
});
afterAll(() => db.destroy());

function consultar(authorization?: string) {
  return app.inject({
    method: 'GET',
    url: '/pagamentos/1',
    headers: authorization ? { authorization } : {},
  });
}

describe('chave da API entre serviços', () => {
  it('sem Authorization devolve 401 com o envelope de erro', async () => {
    const resposta = await consultar();
    expect(resposta.statusCode).toBe(401);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'nao_autorizado' } });
  });

  it('chave errada devolve 401', async () => {
    expect((await consultar('Bearer chave-errada')).statusCode).toBe(401);
  });

  it('esquema diferente de Bearer devolve 401', async () => {
    expect((await consultar(`Basic ${CHAVE_ATUAL}`)).statusCode).toBe(401);
  });

  it('chave atual passa (404 do pagamento inexistente, não 401)', async () => {
    const resposta = await consultar(`Bearer ${CHAVE_ATUAL}`);
    expect(resposta.statusCode).toBe(404);
  });

  it('a chave anterior continua valendo durante a rotação', async () => {
    expect((await consultar(`Bearer ${CHAVE_ANTERIOR}`)).statusCode).toBe(404);
  });

  it('o 401 vem antes da validação do corpo e não cria pagamento', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/pagamentos',
      headers: { 'idempotency-key': 'k-sem-auth' },
      payload: { provedor: 'fake', valorCentavos: 100, moeda: 'BRL', tokenMetodo: 't' },
    });
    expect(resposta.statusCode).toBe(401);
    const total = await db
      .selectFrom('pagamentos')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(total.n)).toBe(0);
  });

  it('/saude é público e confere o banco', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/saude' });
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ status: 'ok' });
  });

  it('webhooks não exigem a chave (protegidos pela assinatura)', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/webhooks/fake',
      headers: { 'content-type': 'application/json' },
      payload: '{"id":"evt_1","tipo":"x"}',
    });
    // Passa pela autenticação e para na assinatura.
    expect(resposta.statusCode).toBe(401);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'assinatura_invalida' } });
  });

  it('chaveValida compara contra todas as chaves aceitas', () => {
    expect(chaveValida(CHAVE_ATUAL, [CHAVE_ATUAL])).toBe(true);
    expect(chaveValida(CHAVE_ANTERIOR, [CHAVE_ATUAL, CHAVE_ANTERIOR])).toBe(true);
    expect(chaveValida(`${CHAVE_ATUAL}x`, [CHAVE_ATUAL])).toBe(false);
    expect(chaveValida('qualquer', [])).toBe(false);
  });
});

describe('limite de taxa nos webhooks', () => {
  it('passa do limite por IP e recebe 429 com o envelope de erro', async () => {
    const limitado = montarApp({ db, chavesApi: [CHAVE_ATUAL], limiteWebhooksPorMinuto: 2 });
    const enviar = () =>
      limitado.inject({
        method: 'POST',
        url: '/webhooks/fake',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });

    expect((await enviar()).statusCode).toBe(401);
    expect((await enviar()).statusCode).toBe(401);
    const bloqueada = await enviar();
    expect(bloqueada.statusCode).toBe(429);
    expect(bloqueada.json()).toMatchObject({ erro: { codigo: 'limite_excedido' } });
    await limitado.close();
  });

  it('rotas autenticadas não entram no limite dos webhooks', async () => {
    const limitado = montarApp({ db, chavesApi: [CHAVE_ATUAL], limiteWebhooksPorMinuto: 1 });
    for (let i = 0; i < 3; i++) {
      const resposta = await limitado.inject({
        method: 'GET',
        url: '/pagamentos/1',
        headers: { authorization: `Bearer ${CHAVE_ATUAL}` },
      });
      expect(resposta.statusCode).toBe(404);
    }
    await limitado.close();
  });
});

describe('rotas de sandbox', () => {
  it('sem o segredo do PIX simulado (produção), /pix/* não existe', async () => {
    const semPix = montarApp({ db, chavesApi: [CHAVE_ATUAL], segredoPixSimulado: undefined });
    const resposta = await semPix.inject({
      method: 'POST',
      url: '/pix/chaves',
      headers: { authorization: `Bearer ${CHAVE_ATUAL}` },
      payload: { tipo: 'aleatoria', titular: 'Teste' },
    });
    expect(resposta.statusCode).toBe(404);
    await semPix.close();
  });
});
