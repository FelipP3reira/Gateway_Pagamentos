import { randomUUID } from 'node:crypto';

import { ErroDeAplicacao } from '../erros.ts';

export type TipoChave = 'aleatoria' | 'cpf' | 'email' | 'telefone';

export interface ChavePix {
  tipo: TipoChave;
  chave: string;
}

// Chave aleatória (EVP): um UUID. Em sandbox não está registrada no DICT do
// Banco Central, então não recebe dinheiro de verdade — é só o identificador.
function gerarEvp(): string {
  return randomUUID();
}

// Validação de CPF pelos dígitos verificadores (não só o formato).
function cpfValido(cpf: string): boolean {
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) {
    return false;
  }
  const digito = (ate: number): number => {
    let soma = 0;
    for (let i = 0; i < ate; i++) {
      soma += Number(cpf[i]) * (ate + 1 - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(cpf[9]) && digito(10) === Number(cpf[10]);
}

function so_digitos(valor: string): string {
  return valor.replace(/\D/g, '');
}

/**
 * Cria/normaliza uma chave PIX a partir do tipo. `aleatoria` gera um EVP; os
 * outros validam e normalizam o valor informado. Formato inválido é 400.
 */
export function criarChave(tipo: TipoChave, valor?: string): ChavePix {
  if (tipo === 'aleatoria') {
    return { tipo, chave: gerarEvp() };
  }

  if (!valor || valor.trim() === '') {
    throw new ErroDeAplicacao(
      400,
      'chave_invalida',
      `A chave do tipo ${tipo} precisa de um valor.`,
    );
  }

  if (tipo === 'cpf') {
    const cpf = so_digitos(valor);
    if (!cpfValido(cpf)) {
      throw new ErroDeAplicacao(400, 'chave_invalida', 'CPF inválido.');
    }
    return { tipo, chave: cpf };
  }

  if (tipo === 'email') {
    const email = valor.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new ErroDeAplicacao(400, 'chave_invalida', 'E-mail inválido.');
    }
    return { tipo, chave: email };
  }

  // telefone: normaliza para o formato E.164 do Brasil (+55DDDNÚMERO).
  const numero = so_digitos(valor);
  const nacional = numero.startsWith('55') ? numero : `55${numero}`;
  if (nacional.length < 12 || nacional.length > 13) {
    throw new ErroDeAplicacao(400, 'chave_invalida', 'Telefone inválido.');
  }
  return { tipo, chave: `+${nacional}` };
}
