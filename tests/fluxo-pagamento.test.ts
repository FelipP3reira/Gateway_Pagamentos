import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { TOKEN_QUE_FALHA } from '../src/provedores/fake.ts';
import { limparBanco } from './auxiliar.ts';

const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;

beforeEach(async () => {
  await limparBanco(db);
  app = montarApp({ db });
});
afterAll(() => db.destroy());

function criar(chave: string, corpo: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': chave },
    payload: {
      provedor: 'fake',
      valorCentavos: 1990,
      moeda: 'BRL',
      tokenMetodo: 'tok_fake_ok',
      ...corpo,
    },
  });
}

describe('fluxo de pagamento pelas rotas', () => {
  it('autoriza, captura e estorna', async () => {
    const criado = await criar('k1');
    expect(criado.statusCode).toBe(201);
    expect(criado.json()).toMatchObject({ estado: 'autorizado' });
    const id = criado.json().id as number;

    const capturado = await app.inject({ method: 'POST', url: `/pagamentos/${id}/capturar` });
    expect(capturado.json()).toMatchObject({ estado: 'capturado' });

    const estornado = await app.inject({ method: 'POST', url: `/pagamentos/${id}/estornar` });
    expect(estornado.json()).toMatchObject({ estado: 'estornado' });

    const estornos = await db
      .selectFrom('estornos')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('pagamento_id', '=', id)
      .executeTakeFirstOrThrow();
    expect(Number(estornos.n)).toBe(1);
  });

  it('captura na hora quando capturaAutomatica é true', async () => {
    const criado = await criar('k-auto', { capturaAutomatica: true });
    expect(criado.json()).toMatchObject({ estado: 'capturado' });
  });

  it('a mesma chave de idempotência não cria dois pagamentos nem cobra de novo', async () => {
    const primeira = await criar('mesma');
    const segunda = await criar('mesma');

    expect(segunda.json().id).toBe(primeira.json().id);
    const total = await db
      .selectFrom('pagamentos')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(total.n)).toBe(1);
  });

  it('sem Idempotency-Key devolve 400', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/pagamentos',
      payload: { provedor: 'fake', valorCentavos: 1990, moeda: 'BRL', tokenMetodo: 'tok_fake_ok' },
    });
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'sem_chave_idempotencia' } });
  });

  it('token que falha deixa o pagamento como falhou', async () => {
    const criado = await criar('k-falha', { tokenMetodo: TOKEN_QUE_FALHA });
    expect(criado.json()).toMatchObject({ estado: 'falhou' });
  });

  it('capturar duas vezes é barrado pela máquina de estados', async () => {
    const id = (await criar('k-dup')).json().id as number;
    await app.inject({ method: 'POST', url: `/pagamentos/${id}/capturar` });

    const segunda = await app.inject({ method: 'POST', url: `/pagamentos/${id}/capturar` });
    expect(segunda.statusCode).toBe(409);
    expect(segunda.json()).toMatchObject({ erro: { codigo: 'transicao_invalida' } });
  });

  it('valor inválido é rejeitado na validação', async () => {
    const resposta = await app.inject({
      method: 'POST',
      url: '/pagamentos',
      headers: { 'idempotency-key': 'k-neg' },
      payload: { provedor: 'fake', valorCentavos: 0, moeda: 'BRL', tokenMetodo: 'tok_fake_ok' },
    });
    expect(resposta.statusCode).toBe(400);
  });
});
