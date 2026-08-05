import { describe, expect, it } from 'vitest';

import type { Estado } from '../src/db/esquema.ts';
import { ehTerminal, garantirTransicao, podeTransicionar } from '../src/dominio/maquina-estados.ts';
import { TransicaoInvalida } from '../src/erros.ts';

describe('máquina de estados', () => {
  it('permite o caminho feliz completo', () => {
    expect(podeTransicionar('pendente', 'autorizado')).toBe(true);
    expect(podeTransicionar('autorizado', 'capturado')).toBe(true);
    expect(podeTransicionar('capturado', 'estornado')).toBe(true);
  });

  it('proíbe pular a autorização (não vai direto de pendente a capturado)', () => {
    expect(podeTransicionar('pendente', 'capturado')).toBe(false);
    expect(() => garantirTransicao('pendente', 'capturado')).toThrow(TransicaoInvalida);
  });

  it('proíbe voltar no tempo', () => {
    expect(podeTransicionar('capturado', 'autorizado')).toBe(false);
    expect(podeTransicionar('estornado', 'capturado')).toBe(false);
  });

  it('não sai de um estado terminal', () => {
    const terminais: Estado[] = ['estornado', 'cancelado', 'falhou'];
    for (const estado of terminais) {
      expect(ehTerminal(estado)).toBe(true);
      expect(() => garantirTransicao(estado, 'capturado')).toThrow(TransicaoInvalida);
    }
  });

  it('capturado não é terminal — ainda pode estornar', () => {
    expect(ehTerminal('capturado')).toBe(false);
  });
});
