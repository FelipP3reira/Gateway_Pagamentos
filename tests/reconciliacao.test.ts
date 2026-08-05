import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { ProvedorFake } from '../src/provedores/fake.ts';
import { RegistroDeProvedores } from '../src/provedores/registro.ts';
import { limparBanco } from './auxiliar.ts';

const db = criarBanco(process.env.DATABASE_URL);
// Fake explícito para conseguir "adiantar" o provedor sem passar pelas rotas.
let fake: ProvedorFake;
let app: FastifyInstance;

beforeEach(async () => {
  await limparBanco(db);
  fake = new ProvedorFake('segredo');
  const registro = new RegistroDeProvedores().registrar(fake);
  app = montarApp({ db, registro });
});
afterAll(() => db.destroy());

async function autorizar(): Promise<{ id: number; referencia: string }> {
  const r = await app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': `k-${Date.now()}` },
    payload: { provedor: 'fake', valorCentavos: 3000, moeda: 'BRL', tokenMetodo: 'tok_fake_ok' },
  });
  const corpo = r.json();
  return { id: corpo.id as number, referencia: corpo.referenciaExterna as string };
}

describe('reconciliação', () => {
  it('corrige o estado local quando o provedor está à frente', async () => {
    const { id, referencia } = await autorizar();

    // O provedor capturou (ex.: por fora), mas o webhook não chegou: local segue
    // em autorizado.
    await fake.capturar(referencia);

    const resposta = await app.inject({ method: 'POST', url: `/pagamentos/${id}/reconciliar` });

    expect(resposta.json()).toMatchObject({ estado: 'capturado', ajustado: true });
    const atual = await app.inject({ method: 'GET', url: `/pagamentos/${id}` });
    expect(atual.json()).toMatchObject({ estado: 'capturado' });
  });

  it('não muda nada quando já está consistente', async () => {
    const { id } = await autorizar();

    const resposta = await app.inject({ method: 'POST', url: `/pagamentos/${id}/reconciliar` });

    expect(resposta.json()).toMatchObject({ estado: 'autorizado', ajustado: false });
  });
});
