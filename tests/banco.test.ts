import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { criarBanco } from '../src/db/conexao.ts';
import { limparBanco } from './auxiliar.ts';

const db = criarBanco(process.env.DATABASE_URL);

beforeEach(() => limparBanco(db));
afterAll(() => db.destroy());

describe('banco', () => {
  it('grava e lê um pagamento', async () => {
    const linha = await db
      .insertInto('pagamentos')
      .values({
        provedor: 'fake',
        estado: 'pendente',
        valor_centavos: 1990,
        moeda: 'BRL',
        chave_idempotencia: 'k1',
      })
      .returning(['id', 'estado'])
      .executeTakeFirstOrThrow();

    expect(linha.id).toBeGreaterThan(0);
    expect(linha.estado).toBe('pendente');
  });

  it('a chave de idempotência é única', async () => {
    const valores = {
      provedor: 'fake' as const,
      estado: 'pendente' as const,
      valor_centavos: 500,
      moeda: 'BRL',
      chave_idempotencia: 'repetida',
    };
    await db.insertInto('pagamentos').values(valores).execute();

    await expect(db.insertInto('pagamentos').values(valores).execute()).rejects.toThrow();
  });
});
