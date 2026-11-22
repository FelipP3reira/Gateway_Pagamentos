import type { Estado, Provedor } from '../db/esquema.ts';
import type { Pagador } from '../provedores/provedor.ts';

export type { Estado, Pagador, Provedor };

// Dados para criar uma cobrança, no nível do domínio — sem detalhe de provedor.
export interface NovaCobranca {
  provedor: Provedor;
  valorCentavos: number;
  moeda: string;
  // Token do método de pagamento no provedor (ex.: pm_card_visa da Stripe).
  // NUNCA o número do cartão (PAN): a tokenização é do provedor.
  tokenMetodo: string;
  descricao?: string;
  // true captura na hora (autoriza + captura); false só autoriza.
  capturaAutomatica: boolean;
  // A mesma chave nunca cria dois pagamentos.
  chaveIdempotencia: string;
  // Parcelas do cartão; ausente = 1 (à vista).
  parcelas?: number;
  metodoPagamentoId?: string;
  emissorId?: string;
  // Repassado ao provedor e NÃO persistido aqui (o gateway não guarda dado
  // pessoal que não precisa — LGPD). A loja é a dona do cadastro.
  pagador?: Pagador;
}

export interface Pagamento {
  id: number;
  provedor: Provedor;
  referenciaExterna: string | null;
  estado: Estado;
  valorCentavos: number;
  moeda: string;
  descricao: string | null;
  parcelas: number;
  metodoPagamentoId: string | null;
  emissorId: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
}
