import { describe, expect, it } from 'vitest';

import { criarChave } from '../src/pix/chave.ts';
import { ErroDeAplicacao } from '../src/erros.ts';

describe('chave PIX', () => {
  it('gera uma chave aleatória no formato de UUID', () => {
    const { tipo, chave } = criarChave('aleatoria');
    expect(tipo).toBe('aleatoria');
    expect(chave).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('valida o CPF pelos dígitos verificadores', () => {
    expect(criarChave('cpf', '529.982.247-25').chave).toBe('52998224725');
    expect(() => criarChave('cpf', '111.111.111-11')).toThrow(ErroDeAplicacao);
    expect(() => criarChave('cpf', '123')).toThrow(ErroDeAplicacao);
  });

  it('normaliza e-mail e rejeita inválido', () => {
    expect(criarChave('email', 'Felipe@Exemplo.Test').chave).toBe('felipe@exemplo.test');
    expect(() => criarChave('email', 'sem-arroba')).toThrow(ErroDeAplicacao);
  });

  it('normaliza telefone para E.164 do Brasil', () => {
    expect(criarChave('telefone', '(19) 99360-9517').chave).toBe('+5519993609517');
    expect(() => criarChave('telefone', '123')).toThrow(ErroDeAplicacao);
  });
});
