import type { Estado, Provedor } from '../db/esquema.ts';

export type { Estado, Provedor };

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
}

export interface Pagamento {
  id: number;
  provedor: Provedor;
  referenciaExterna: string | null;
  estado: Estado;
  valorCentavos: number;
  moeda: string;
  descricao: string | null;
  criadoEm: Date;
  atualizadoEm: Date;
}
