import { createHmac } from 'node:crypto';

import type { ClienteHttp } from '../src/provedores/mercadopago.ts';

export const SEGREDO_MP = 'segredo-webhook-mp-teste';

export interface ChamadaHttp {
  metodo: string;
  url: string;
  cabecalhos: Record<string, string>;
  corpo: Record<string, unknown> | undefined;
}

type Resposta = { status: number; corpo: unknown };

/**
 * Mercado Pago em memória: responde à API de pagamentos guardando o status de
 * cada pagamento, registra todas as chamadas e deixa o teste forçar respostas
 * (erro 400, 500, status específico na criação).
 */
export class MercadoPagoFalso {
  chamadas: ChamadaHttp[] = [];
  pagamentos = new Map<string, { status: string }>();
  // Próxima resposta do POST /v1/payments (para simular recusa ou status).
  proximaCriacao: Resposta | ((corpo: Record<string, unknown>) => Resposta) | null = null;
  // Falha forçada no GET (simula provedor fora do ar).
  falharConsulta = false;
  private sequencia = 1_000_000;

  http: ClienteHttp = (url, init) => {
    const metodo = init.method ?? 'GET';
    const corpo =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const cabecalhos = { ...(init.headers as Record<string, string>) };
    this.chamadas.push({ metodo, url, cabecalhos, corpo });

    const caminho = new URL(url).pathname;
    const resposta = this.responder(metodo, caminho, corpo ?? {});
    return Promise.resolve(
      new Response(JSON.stringify(resposta.corpo), {
        status: resposta.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };

  definirStatus(id: string, status: string): void {
    this.pagamentos.set(id, { status });
  }

  private responder(metodo: string, caminho: string, corpo: Record<string, unknown>): Resposta {
    if (metodo === 'POST' && caminho === '/v1/payments') {
      const forcada =
        typeof this.proximaCriacao === 'function'
          ? this.proximaCriacao(corpo)
          : this.proximaCriacao;
      this.proximaCriacao = null;
      if (forcada && forcada.status >= 400) {
        return forcada;
      }
      const id = String(this.sequencia++);
      const pix = corpo.payment_method_id === 'pix';
      const statusPadrao = pix ? 'pending' : corpo.capture === false ? 'authorized' : 'approved';
      const status = (forcada?.corpo as { status?: string } | undefined)?.status ?? statusPadrao;
      this.pagamentos.set(id, { status });
      return {
        status: 201,
        corpo: {
          id: Number(id),
          status,
          status_detail: pix ? 'pending_waiting_transfer' : 'accredited',
          ...(pix
            ? {
                date_of_expiration: corpo.date_of_expiration,
                point_of_interaction: {
                  type: 'PIX',
                  transaction_data: {
                    qr_code: `00020126580014br.gov.bcb.pix-${id}`,
                    qr_code_base64: 'iVBORw0KGgoAAAANSUhEUg==',
                    ticket_url: `https://www.mercadopago.com.br/payments/${id}/ticket`,
                  },
                },
              }
            : {}),
        },
      };
    }

    const reembolso = caminho.match(/^\/v1\/payments\/(\d+)\/refunds$/);
    if (metodo === 'POST' && reembolso) {
      const pagamento = this.pagamentos.get(reembolso[1]!);
      if (!pagamento) return { status: 404, corpo: { message: 'Payment not found' } };
      pagamento.status = 'refunded';
      return {
        status: 201,
        corpo: { id: 77_000 + (Number(reembolso[1]) % 1000), status: 'approved' },
      };
    }

    const unico = caminho.match(/^\/v1\/payments\/(\d+)$/);
    if (unico) {
      const pagamento = this.pagamentos.get(unico[1]!);
      if (!pagamento) {
        return { status: 404, corpo: { message: 'Payment not found.', cause: [{ code: 2000 }] } };
      }
      if (metodo === 'GET') {
        if (this.falharConsulta) return { status: 503, corpo: { message: 'unavailable' } };
        return { status: 200, corpo: { id: Number(unico[1]), status: pagamento.status } };
      }
      if (metodo === 'PUT' && corpo.capture === true) {
        pagamento.status = 'approved';
      } else if (metodo === 'PUT' && corpo.status === 'cancelled') {
        pagamento.status = 'cancelled';
      }
      return { status: 200, corpo: { id: Number(unico[1]), status: pagamento.status } };
    }

    return { status: 404, corpo: { message: 'rota desconhecida' } };
  }
}

// Monta um x-signature válido com o manifest documentado pelo SDK oficial.
export function assinarMp(opcoes: {
  dataId?: string;
  requestId?: string;
  ts: string;
  segredo?: string;
}): string {
  const partes: string[] = [];
  if (opcoes.dataId) partes.push(`id:${opcoes.dataId}`);
  if (opcoes.requestId) partes.push(`request-id:${opcoes.requestId}`);
  partes.push(`ts:${opcoes.ts}`);
  const hash = createHmac('sha256', opcoes.segredo ?? SEGREDO_MP)
    .update(`${partes.join(';')};`)
    .digest('hex');
  return `ts=${opcoes.ts},v1=${hash}`;
}

export function agoraEmSegundos(): string {
  return String(Math.floor(Date.now() / 1000));
}
