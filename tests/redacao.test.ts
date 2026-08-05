import { describe, expect, it } from 'vitest';

import { mascarar, redigir } from '../src/seguranca/redacao.ts';

describe('redação de dados sensíveis', () => {
  it('mascara mostrando só os últimos quatro', () => {
    expect(mascarar('pm_card_visa_9999')).toBe('****9999');
    expect(mascarar('abc')).toBe('****');
  });

  it('mascara campos sensíveis em objetos aninhados', () => {
    const entrada = {
      valorCentavos: 1990,
      tokenMetodo: 'pm_card_visa_4242',
      cliente: { authorization: 'Bearer sk_test_super_secreto', nome: 'Felipe' },
    };

    const saida = redigir(entrada) as typeof entrada;

    expect(saida.valorCentavos).toBe(1990);
    expect(saida.tokenMetodo).toBe('****4242');
    expect(saida.cliente.authorization).toMatch(/^\*\*\*\*/);
    expect(saida.cliente.authorization).not.toContain('secreto');
    // O que não é sensível passa intacto.
    expect(saida.cliente.nome).toBe('Felipe');
  });

  it('não vaza número de cartão se ele aparecer por engano', () => {
    const saida = redigir({ card: { number: '4242424242424242', cvv: '123' } }) as {
      card: { number: string; cvv: string };
    };

    expect(saida.card.number).not.toContain('4242424242424242');
    expect(saida.card.cvv).toBe('****');
  });
});
