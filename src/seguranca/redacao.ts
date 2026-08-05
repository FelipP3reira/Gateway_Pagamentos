// Redação de dados sensíveis antes de qualquer log. Regra do projeto: token de
// método, segredos e assinaturas nunca aparecem em texto claro. Cartão (PAN)
// nem entra no sistema — mas se por engano cair num objeto, a máscara pega.

const CHAVES_SENSIVEIS = [
  'token',
  'tokenmetodo',
  'authorization',
  'assinatura',
  'signature',
  'secret',
  'segredo',
  'cartao',
  'card',
  'number',
  'cvv',
  'cvc',
];

// Mostra só os últimos 4 caracteres: o suficiente para correlacionar sem expor.
export function mascarar(valor: string): string {
  if (valor.length <= 4) {
    return '****';
  }
  return `****${valor.slice(-4)}`;
}

function ehSensivel(chave: string): boolean {
  const normal = chave.toLowerCase();
  return CHAVES_SENSIVEIS.some((sensivel) => normal.includes(sensivel));
}

/**
 * Devolve uma cópia do objeto com os campos sensíveis mascarados, recursivo.
 * Use antes de logar qualquer coisa que venha do cliente ou do provedor.
 */
export function redigir(valor: unknown): unknown {
  if (Array.isArray(valor)) {
    return valor.map((item) => redigir(item));
  }
  if (valor !== null && typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor)) {
      if (ehSensivel(chave) && typeof item === 'string') {
        saida[chave] = mascarar(item);
      } else {
        saida[chave] = redigir(item);
      }
    }
    return saida;
  }
  return valor;
}
