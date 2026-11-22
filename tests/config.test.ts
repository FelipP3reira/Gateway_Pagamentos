import { describe, expect, it } from 'vitest';

import { carregarConfig } from '../src/config.ts';

const CHAVE_FORTE = 'k'.repeat(40);
const BASE = { DATABASE_URL: 'postgres://x/y' };
// O mínimo que produção exige além da chave da API.
const LOJA = { LOJA_URL: 'https://loja.exemplo.com', LOJA_WEBHOOK_SECRET: 's'.repeat(40) };

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
      ...LOJA,
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
      ...LOJA,
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

  it('Mercado Pago: token sem segredo do webhook falha no boot', () => {
    expect(() =>
      carregarConfig({ ...BASE, FAKE_WEBHOOK_SECRET: 's', MERCADOPAGO_ACCESS_TOKEN: 'TEST-x' }),
    ).toThrow(/MERCADOPAGO_WEBHOOK_SECRET/);
  });

  it('Mercado Pago: URL de notificação precisa ser HTTPS', () => {
    expect(() =>
      carregarConfig({
        ...BASE,
        FAKE_WEBHOOK_SECRET: 's',
        MERCADOPAGO_URL_NOTIFICACAO: 'http://gateway.exemplo.com/webhooks/mercadopago',
      }),
    ).toThrow(/https/);
  });

  it('loja: URL e segredo andam juntos', () => {
    expect(() =>
      carregarConfig({ ...BASE, FAKE_WEBHOOK_SECRET: 's', LOJA_URL: 'http://localhost:3000' }),
    ).toThrow(/andam juntas/);
  });

  it('loja: obrigatória em produção, com HTTPS e segredo forte', () => {
    const producao = { ...BASE, AMBIENTE: 'producao', GATEWAY_API_KEY: CHAVE_FORTE };
    expect(() => carregarConfig(producao)).toThrow(/obrigatórias em produção/);
    expect(() =>
      carregarConfig({ ...producao, ...LOJA, LOJA_URL: 'http://loja.exemplo.com' }),
    ).toThrow(/https/);
    expect(() => carregarConfig({ ...producao, ...LOJA, LOJA_WEBHOOK_SECRET: 'curto' })).toThrow(
      /fraco/,
    );
    expect(carregarConfig({ ...producao, ...LOJA }).lojaUrl).toBe('https://loja.exemplo.com');
  });

  it('loja: opcional fora de produção (aceita http local)', () => {
    const config = carregarConfig({
      ...BASE,
      FAKE_WEBHOOK_SECRET: 's',
      LOJA_URL: 'http://localhost:3000',
      LOJA_WEBHOOK_SECRET: 'dev',
    });
    expect(config.lojaUrl).toBe('http://localhost:3000');
  });
});
