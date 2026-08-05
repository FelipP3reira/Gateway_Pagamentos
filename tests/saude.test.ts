import { afterAll, describe, expect, it } from 'vitest';

import { criarServidor } from '../src/servidor.ts';

const app = criarServidor();
afterAll(() => app.close());

describe('saúde', () => {
  it('responde ok', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/saude' });

    expect(resposta.statusCode).toBe(200);
    expect(resposta.json()).toMatchObject({ status: 'ok', ambiente: 'teste' });
  });

  it('rota inexistente devolve o envelope de erro', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/nada' });

    expect(resposta.statusCode).toBe(404);
    expect(resposta.json()).toMatchObject({ erro: { codigo: 'nao_encontrado' } });
  });
});
