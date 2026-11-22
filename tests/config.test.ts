import { describe, expect, it } from 'vitest';

import { carregarConfig } from '../src/config.ts';

const CHAVE_FORTE = 'k'.repeat(40);
const BASE = { DATABASE_URL: 'postgres://x/y' };

describe('config', () => {
  it('em produção, falha no boot sem GATEWAY_API_KEY', () => {
    expect(() => carregarConfig({ ...BASE, AMBIENTE: 'producao' })).toThrow(/GATEWAY_API_KEY/);
  });

  it('em produção, recusa chave curta (inclusive a anterior)', () => {
    expect(() =>
      carregarConfig({ ...BASE, AMBIENTE: 'producao', GATEWAY_API_KEY: 'curta' }),
    ).toThrow(/fraca/);
    expect(() =>
      carregarConfig({
        ...BASE,
        AMBIENTE: 'producao',
        GATEWAY_API_KEY: CHAVE_FORTE,
        GATEWAY_API_KEY_ANTERIOR: 'curta',
      }),
    ).toThrow(/fraca/);
  });

  it('em produção, não exige nem carrega o segredo do fake', () => {
    const config = carregarConfig({
      ...BASE,
      AMBIENTE: 'producao',
      GATEWAY_API_KEY: CHAVE_FORTE,
      FAKE_WEBHOOK_SECRET: 'nao-deveria-entrar',
    });
    expect(config.producao).toBe(true);
    expect(config.fakeWebhookSecret).toBeUndefined();
    expect(config.chavesApi).toEqual([CHAVE_FORTE]);
  });

  it('a chave anterior entra na lista para a rotação', () => {
    const config = carregarConfig({
      ...BASE,
      AMBIENTE: 'producao',
      GATEWAY_API_KEY: CHAVE_FORTE,
      GATEWAY_API_KEY_ANTERIOR: 'a'.repeat(40),
    });
    expect(config.chavesApi).toHaveLength(2);
  });

  it('fora de produção, a chave é opcional e o segredo do fake é obrigatório', () => {
    expect(() => carregarConfig({ ...BASE, AMBIENTE: 'desenvolvimento' })).toThrow(
      /FAKE_WEBHOOK_SECRET/,
    );
    const config = carregarConfig({ ...BASE, FAKE_WEBHOOK_SECRET: 's' });
    expect(config.ambiente).toBe('desenvolvimento');
    expect(config.chavesApi).toEqual([]);
  });

  it('rejeita AMBIENTE desconhecido e números inválidos', () => {
    expect(() => carregarConfig({ ...BASE, AMBIENTE: 'prod' })).toThrow(/AMBIENTE/);
    expect(() => carregarConfig({ ...BASE, FAKE_WEBHOOK_SECRET: 's', PORTA: 'abc' })).toThrow(
      /PORTA/,
    );
  });
});
