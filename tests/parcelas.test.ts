import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { montarApp } from '../src/app.ts';
import { criarBanco } from '../src/db/conexao.ts';
import { migrar } from '../src/db/migrar.ts';
import { ProvedorFake } from '../src/provedores/fake.ts';
import type { DadosCobranca, ResultadoProvedor } from '../src/provedores/provedor.ts';
import { RegistroDeProvedores } from '../src/provedores/registro.ts';
import { limparBanco } from './auxiliar.ts';

// Fake que guarda o que recebeu, para conferir o repasse ao provedor.
class FakeEspiao extends ProvedorFake {
  recebidos: DadosCobranca[] = [];

  override autorizar(dados: DadosCobranca): Promise<ResultadoProvedor> {
    this.recebidos.push(dados);
    return super.autorizar(dados);
  }
}

const db = criarBanco(process.env.DATABASE_URL);
let app: FastifyInstance;
let espiao: FakeEspiao;

beforeEach(async () => {
  await limparBanco(db);
  espiao = new FakeEspiao('segredo');
  app = montarApp({ db, registro: new RegistroDeProvedores().registrar(espiao) });
});
afterAll(() => db.destroy());

function criar(chave: string, corpo: Record<string, unknown> = {}) {
  return app.inject({
    method: 'POST',
    url: '/pagamentos',
    headers: { 'idempotency-key': chave },
    payload: {
      provedor: 'fake',
      valorCentavos: 59_880,
      moeda: 'BRL',
      tokenMetodo: 'tok_fake_ok',
      ...corpo,
    },
  });
}

async function contarPagamentos(): Promise<number> {
  const linha = await db
    .selectFrom('pagamentos')
    .select((eb) => eb.fn.countAll<number>().as('n'))
    .executeTakeFirstOrThrow();
  return Number(linha.n);
}

describe('parcelas', () => {
  it('sem parcelas, é à vista (1) e a resposta traz os campos novos', async () => {
    const resposta = await criar('k-avista');
    expect(resposta.statusCode).toBe(201);
    expect(resposta.json()).toMatchObject({
      parcelas: 1,
      metodoPagamentoId: null,
      emissorId: null,
    });
    expect(espiao.recebidos[0]?.parcelas).toBe(1);
  });

  it('persiste parcelas, método e emissor, e devolve no GET', async () => {
    const criado = await criar('k-6x', {
      parcelas: 6,
      metodoPagamentoId: 'visa',
      emissorId: '25',
    });
    expect(criado.statusCode).toBe(201);
    const id = criado.json().id as number;

    const linha = await db
      .selectFrom('pagamentos')
      .select(['parcelas', 'metodo_pagamento_id', 'emissor_id'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(linha).toEqual({ parcelas: 6, metodo_pagamento_id: 'visa', emissor_id: '25' });

    const consultado = await app.inject({ method: 'GET', url: `/pagamentos/${id}` });
    expect(consultado.json()).toMatchObject({
      parcelas: 6,
      metodoPagamentoId: 'visa',
      emissorId: '25',
    });
  });

  it('repassa parcelas, método, emissor e pagador ao provedor', async () => {
    const pagador = {
      email: 'cliente@exemplo.com',
      tipoDocumento: 'CPF',
      documento: '12345678909',
    };
    await criar('k-repasse', { parcelas: 3, metodoPagamentoId: 'master', emissorId: '7', pagador });

    expect(espiao.recebidos[0]).toMatchObject({
      parcelas: 3,
      metodoPagamentoId: 'master',
      emissorId: '7',
      pagador,
    });
  });

  it('não persiste os dados do pagador (LGPD)', async () => {
    await criar('k-lgpd', { pagador: { email: 'cliente@exemplo.com', documento: '12345678909' } });
    const linha = await db.selectFrom('pagamentos').selectAll().executeTakeFirstOrThrow();
    const gravado = JSON.stringify(linha);
    expect(gravado).not.toContain('cliente@exemplo.com');
    expect(gravado).not.toContain('12345678909');
  });

  it('acima do máximo do provedor: 400 e nada gravado', async () => {
    const resposta = await criar('k-13x', { parcelas: 13 });
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'parcelas_invalidas' } });
    expect(await contarPagamentos()).toBe(0);
    expect(espiao.recebidos).toHaveLength(0);
  });

  it.each([
    ['zero', { parcelas: 0 }],
    ['negativo', { parcelas: -2 }],
    ['fracionado', { parcelas: 1.5 }],
    ['acima do teto da API', { parcelas: 25 }],
    ['texto', { parcelas: 'seis' }],
    ['e-mail inválido', { pagador: { email: 'nao-e-email' } }],
    ['documento com máscara', { pagador: { email: 'a@b.com', documento: '123.456.789-09' } }],
    ['pagador sem e-mail', { pagador: { documento: '12345678909' } }],
  ])('rejeita %s na validação', async (_nome, corpo) => {
    const resposta = await criar(`k-invalido-${_nome}`, corpo);
    expect(resposta.statusCode).toBe(400);
    expect(await contarPagamentos()).toBe(0);
  });

  it('campo extra no pagador é descartado e não chega ao provedor', async () => {
    // Padrão do Fastify (removeAdditional): o que não está no schema some antes
    // da rota — um número de cartão enviado por engano nunca passa daqui.
    const resposta = await criar('k-extra', {
      pagador: { email: 'a@b.com', cartao: '4111111111111111' },
    });
    expect(resposta.statusCode).toBe(201);
    expect(espiao.recebidos[0]?.pagador).toEqual({ email: 'a@b.com' });
    expect(JSON.stringify(espiao.recebidos[0])).not.toContain('4111111111111111');
  });

  it('a repetição idempotente devolve as mesmas parcelas sem chamar o provedor de novo', async () => {
    const primeira = await criar('k-idem', { parcelas: 4 });
    const segunda = await criar('k-idem', { parcelas: 4 });
    expect(segunda.json()).toMatchObject({ id: primeira.json().id, parcelas: 4 });
    expect(espiao.recebidos).toHaveLength(1);
  });

  it('a migração é reexecutável com as colunas novas', async () => {
    await expect(migrar(process.env.DATABASE_URL)).resolves.toBeUndefined();
  });
});
