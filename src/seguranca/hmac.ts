import { createHmac, timingSafeEqual } from 'node:crypto';

// Assina o corpo cru com HMAC-SHA256. É o que o provider fake usa nos webhooks;
// a Stripe traz o seu próprio esquema de assinatura.
export function assinarHmac(corpo: Buffer, segredo: string): string {
  return createHmac('sha256', segredo).update(corpo).digest('hex');
}

// Comparação em tempo constante: nunca comparar assinatura com === (vaza o
// tamanho do prefixo acertado por timing). Diferença de tamanho já é inválida.
export function verificarHmac(corpo: Buffer, assinatura: string, segredo: string): boolean {
  const esperada = Buffer.from(assinarHmac(corpo, segredo), 'hex');
  let recebida: Buffer;
  try {
    recebida = Buffer.from(assinatura, 'hex');
  } catch {
    return false;
  }
  if (recebida.length !== esperada.length) {
    return false;
  }
  return timingSafeEqual(recebida, esperada);
}
