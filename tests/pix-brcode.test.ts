import { describe, expect, it } from 'vitest';

import { crc16, gerarBrCode } from '../src/pix/brcode.ts';

describe('BR Code (PIX copia e cola)', () => {
  it('o CRC16-CCITT bate com o vetor de referência', () => {
    // Vetor padrão do CRC-16/CCITT-FALSE.
    expect(crc16('123456789')).toBe('29B1');
  });

  it('monta um payload com os campos e o CRC no fim', () => {
    const brcode = gerarBrCode({
      chave: 'felipe@exemplo.test',
      valorCentavos: 4990,
      nomeRecebedor: 'Felipe Pereira',
      cidade: 'São Paulo',
      txid: 'PEDIDO123',
    });

    expect(brcode.startsWith('000201')).toBe(true);
    expect(brcode).toContain('br.gov.bcb.pix');
    expect(brcode).toContain('felipe@exemplo.test');
    expect(brcode).toContain('5405' + '49.90'); // campo 54 (valor), tamanho 05

    // O CRC no fim (últimos 4) confere com o recalculado sobre o resto.
    const corpo = brcode.slice(0, -4);
    const crc = brcode.slice(-4);
    expect(crc16(corpo)).toBe(crc);
  });

  it('tira acentos e caixa dos campos de nome e cidade', () => {
    const brcode = gerarBrCode({
      chave: 'k',
      valorCentavos: 100,
      nomeRecebedor: 'Ação Ltda',
      cidade: 'São Paulo',
      txid: 't',
    });
    expect(brcode).toContain('ACAO LTDA');
    expect(brcode).toContain('SAO PAULO');
    expect(brcode).not.toContain('Ação');
  });
});
