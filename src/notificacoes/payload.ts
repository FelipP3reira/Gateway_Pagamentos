import { createHmac, timingSafeEqual } from 'node:crypto';

import { apresentar } from '../dominio/apresentacao.ts';
import type { Pagamento } from '../dominio/tipos.ts';

/**
 * Corpo da notificação para a loja. `sequencia` é o id da última transição:
 * cresce sempre para o mesmo pagamento, então a loja descarta um evento com
 * sequência menor do que a que já aplicou (entregas podem chegar fora de ordem
 * quando uma falha e é re-tentada). O QR do Pix fica de fora — a loja já o
 * recebeu na criação e pode reler em GET /pagamentos/:id.
 */
export function montarPayloadNotificacao(
  pagamento: Pagamento,
  eventoId: string,
  sequencia: number,
  ocorridoEm: Date,
) {
  const { pix: _pix, ...dados } = apresentar(pagamento);
  return {
    evento: 'pagamento.atualizado' as const,
    eventoId,
    sequencia,
    ocorridoEm: ocorridoEm.toISOString(),
    pagamento: dados,
  };
}

/**
 * Assinatura enviada em `X-Gateway-Assinatura: t=<ts>,v1=<hex>`:
 * HMAC-SHA256 (hex) de `<ts>.<corpo cru>` com LOJA_WEBHOOK_SECRET. O timestamp
 * entra no HMAC para a loja recusar reenvios antigos (replay).
 */
export function assinarNotificacao(corpo: string, segredo: string, ts: number): string {
  const hash = createHmac('sha256', segredo).update(`${ts}.${corpo}`).digest('hex');
  return `t=${ts},v1=${hash}`;
}

/**
 * Verificação do lado de quem recebe (a loja usa a mesma lógica). Exposta aqui
 * para os testes e como referência de implementação.
 */
export function verificarNotificacao(opcoes: {
  corpo: string;
  cabecalho: string | undefined;
  segredo: string;
  agoraSegundos: number;
  toleranciaSegundos?: number;
}): boolean {
  if (!opcoes.cabecalho) {
    return false;
  }
  const partes = Object.fromEntries(
    opcoes.cabecalho.split(',').map((parte) => {
      const igual = parte.indexOf('=');
      return [parte.slice(0, igual).trim(), parte.slice(igual + 1).trim()];
    }),
  ) as Record<string, string | undefined>;
  const ts = Number(partes.t);
  if (!Number.isInteger(ts) || !partes.v1) {
    return false;
  }
  if (Math.abs(opcoes.agoraSegundos - ts) > (opcoes.toleranciaSegundos ?? 300)) {
    return false;
  }
  const esperado = Buffer.from(
    assinarNotificacao(opcoes.corpo, opcoes.segredo, ts).split('v1=')[1]!,
  );
  const recebido = Buffer.from(partes.v1);
  return esperado.length === recebido.length && timingSafeEqual(esperado, recebido);
}
