import type { Estado } from '../db/esquema.ts';
import { TransicaoInvalida } from '../erros.ts';

/**
 * Transições válidas, explícitas. A ausência de uma aresta é proibição: se não
 * está listado aqui, não pode acontecer. A captura automática não pula direto
 * de `pendente` para `capturado` — passa por `autorizado`, e as duas transições
 * ficam no log de auditoria.
 *
 *   pendente ──▶ autorizado ──▶ capturado ──▶ estornado
 *      │             │
 *      ├──▶ falhou   ├──▶ cancelado
 *      └──▶ cancelado└──▶ falhou
 */
const TRANSICOES: Record<Estado, readonly Estado[]> = {
  pendente: ['autorizado', 'falhou', 'cancelado'],
  autorizado: ['capturado', 'cancelado', 'falhou'],
  capturado: ['estornado'],
  estornado: [],
  cancelado: [],
  falhou: [],
};

export function podeTransicionar(de: Estado, para: Estado): boolean {
  return TRANSICOES[de].includes(para);
}

// Garante a transição ou lança — é o portão único por onde toda mudança passa.
export function garantirTransicao(de: Estado, para: Estado): void {
  if (!podeTransicionar(de, para)) {
    throw new TransicaoInvalida(`Transição inválida: ${de} → ${para}.`);
  }
}

// Estado do qual não se sai mais (capturado ainda pode estornar, então não é
// terminal; estornado, cancelado e falhou são).
export function ehTerminal(estado: Estado): boolean {
  return TRANSICOES[estado].length === 0;
}
