import type { Estado, Provedor } from '../db/esquema.ts';

// Os estados que um provedor pode reportar — o domínio inteiro menos `pendente`,
// que só existe do nosso lado antes de falar com o provedor.
export type EstadoProvedor = Exclude<Estado, 'pendente'>;

// Dados de uma cobrança do ponto de vista do provedor. O token é do método de
// pagamento (tokenização do provedor); o PAN nunca chega aqui.
export interface DadosCobranca {
  valorCentavos: number;
  moeda: string;
  tokenMetodo: string;
  descricao?: string;
  capturaAutomatica: boolean;
  // Repassada ao provedor para a operação ser idempotente do lado dele também.
  chaveIdempotencia: string;
}

export interface ResultadoProvedor {
  // Id do pagamento no provedor (payment intent / charge).
  referenciaExterna: string;
  estado: EstadoProvedor;
}

// Evento de webhook já normalizado e com a assinatura verificada.
export interface EventoWebhook {
  // Id do evento no provedor — a chave de idempotência do webhook.
  id: string;
  tipo: string;
  // Pagamento a que o evento se refere (referência externa), se houver.
  referenciaExterna: string | null;
  // Estado que o evento implica, ou null se não muda estado.
  estado: EstadoProvedor | null;
}

/**
 * Interface comum dos provedores. Cada adaptador (Stripe, fake) implementa isto;
 * o serviço de pagamento nunca conhece o provedor concreto.
 *
 * `verificarWebhook` é síncrono e SEMPRE valida a assinatura: sem assinatura
 * válida, lança `AssinaturaInvalida` e o evento não existe para o resto do
 * sistema.
 */
export interface ProvedorDePagamento {
  readonly nome: Provedor;
  autorizar(dados: DadosCobranca): Promise<ResultadoProvedor>;
  capturar(referenciaExterna: string): Promise<ResultadoProvedor>;
  estornar(
    referenciaExterna: string,
    valorCentavos: number,
  ): Promise<{ referenciaExterna: string }>;
  cancelar(referenciaExterna: string): Promise<void>;
  // Estado atual no provedor — a fonte da verdade para a reconciliação.
  consultar(referenciaExterna: string): Promise<EstadoProvedor>;
  verificarWebhook(corpoCru: Buffer, assinatura: string | undefined): EventoWebhook;
}
