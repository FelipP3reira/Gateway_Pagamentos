import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { criarBanco } from '../src/db/conexao.ts';
import { RepositorioDePagamentos } from '../src/dominio/repositorio.ts';
import type { NovaCobranca } from '../src/dominio/tipos.ts';
import { TransicaoInvalida } from '../src/erros.ts';
import { limparBanco } from './auxiliar.ts';

const db = criarBanco(process.env.DATABASE_URL);
const repo = new RepositorioDePagamentos(db);

beforeEach(() => limparBanco(db));
afterAll(() => db.destroy());

function nova(chave: string): NovaCobranca {
  return {
    provedor: 'fake',
    valorCentavos: 1990,
    moeda: 'BRL',
    tokenMetodo: 'tok_fake_ok',
    capturaAutomatica: false,
    chaveIdempotencia: chave,
  };
}

async function contarTransicoes(pagamentoId: number): Promise<number> {
  const linha = await db
    .selectFrom('transicoes')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .where('pagamento_id', '=', pagamentoId)
    .executeTakeFirstOrThrow();
  return Number(linha.n);
}

describe('repositório de pagamentos', () => {
  it('cria em pendente e registra a transição inicial', async () => {
    const { pagamento, nova: eNova } = await repo.criarIdempotente(nova('k1'));

    expect(eNova).toBe(true);
    expect(pagamento.estado).toBe('pendente');
    expect(await contarTransicoes(pagamento.id)).toBe(1);
  });

  it('a mesma chave não cria um segundo pagamento', async () => {
    const primeira = await repo.criarIdempotente(nova('k1'));
    const segunda = await repo.criarIdempotente(nova('k1'));

    expect(segunda.nova).toBe(false);
    expect(segunda.pagamento.id).toBe(primeira.pagamento.id);
    // Não gerou uma transição inicial a mais.
    expect(await contarTransicoes(primeira.pagamento.id)).toBe(1);
  });

  it('transição válida muda o estado e grava a auditoria', async () => {
    const { pagamento } = await repo.criarIdempotente(nova('k1'));

    await repo.transicionar(pagamento.id, 'autorizado', 'provedor autorizou');
    const depois = await repo.transicionar(pagamento.id, 'capturado', 'capturado');

    expect(depois.estado).toBe('capturado');
    const atual = await repo.buscar(pagamento.id);
    expect(atual?.estado).toBe('capturado');
    // inicial + autorizado + capturado
    expect(await contarTransicoes(pagamento.id)).toBe(3);
  });

  it('transição inválida é rejeitada e não muda nada', async () => {
    const { pagamento } = await repo.criarIdempotente(nova('k1'));

    await expect(repo.transicionar(pagamento.id, 'capturado')).rejects.toThrow(TransicaoInvalida);

    const atual = await repo.buscar(pagamento.id);
    expect(atual?.estado).toBe('pendente');
    expect(await contarTransicoes(pagamento.id)).toBe(1);
  });

  it('transicionar um pagamento inexistente dá 404', async () => {
    await expect(repo.transicionar(999999, 'autorizado')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
