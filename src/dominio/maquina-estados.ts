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

/**
 * Menor caminho válido de `de` até `para` (sem incluir `de`). Um evento do
 * provedor pode reportar um estado dois passos à frente — o Pix pago chega de
 * `pendente` direto como aprovado —, e o caminho percorre cada aresta para o
 * log de auditoria ficar completo. `[]` quando já está lá; `null` quando não
 * há caminho (divergência real, que não se "conserta" às escondidas).
 */
export function caminhoAte(de: Estado, para: Estado): Estado[] | null {
  if (de === para) {
    return [];
  }
  const anterior = new Map<Estado, Estado>();
  const fila: Estado[] = [de];
  while (fila.length > 0) {
    const atual = fila.shift()!;
    for (const proximo of TRANSICOES[atual]) {
      if (proximo === de || anterior.has(proximo)) {
        continue;
      }
      anterior.set(proximo, atual);
      if (proximo === para) {
        const caminho: Estado[] = [para];
        let passo = atual;
        while (passo !== de) {
          caminho.unshift(passo);
          passo = anterior.get(passo)!;
        }
        return caminho;
      }
      fila.push(proximo);
    }
  }
  return null;
}
