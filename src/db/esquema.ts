import type { ColumnType, Generated } from 'kysely';

// Estados do pagamento. A máquina de estados (dominio/maquina-estados.ts) é
// quem define quais transições entre eles são válidas.
export type Estado = 'pendente' | 'autorizado' | 'capturado' | 'estornado' | 'cancelado' | 'falhou';

export type Provedor = 'stripe' | 'fake' | 'pix';

export type TipoChavePix = 'aleatoria' | 'cpf' | 'email' | 'telefone';

type CriadaEm = ColumnType<Date, Date | string | undefined, never>;

export interface TabelaPagamentos {
  id: Generated<number>;
  provedor: Provedor;
  // Id do pagamento no provedor (payment intent / charge). Nulo até o provedor
  // responder na criação.
  referencia_externa: ColumnType<string | null, string | null | undefined, string | null>;
  estado: ColumnType<Estado, Estado, Estado>;
  valor_centavos: number;
  moeda: string;
  // A mesma chave nunca cria dois pagamentos (idempotência da criação).
  chave_idempotencia: string;
  descricao: ColumnType<string | null, string | null | undefined, string | null>;
  criado_em: CriadaEm;
  atualizado_em: ColumnType<Date, Date | string | undefined, Date | string>;
}

// Log de auditoria: cada mudança de estado vira uma linha. Nunca se apaga.
export interface TabelaTransicoes {
  id: Generated<number>;
  pagamento_id: number;
  de_estado: ColumnType<Estado | null, Estado | null | undefined, never>;
  para_estado: Estado;
  motivo: ColumnType<string | null, string | null | undefined, never>;
  criado_em: CriadaEm;
}

// Idempotência de webhook: (provedor, evento_id) é único. Reprocessar o mesmo
// evento é no-op — é o que impede a cobrança dupla por webhook repetido.
export interface TabelaWebhookEventos {
  id: Generated<number>;
  provedor: Provedor;
  evento_id: string;
  tipo: string;
  pagamento_id: ColumnType<number | null, number | null | undefined, number | null>;
  recebido_em: CriadaEm;
}

export interface TabelaEstornos {
  id: Generated<number>;
  pagamento_id: number;
  valor_centavos: number;
  referencia_externa: ColumnType<string | null, string | null | undefined, string | null>;
  criado_em: CriadaEm;
}

// Chaves PIX geradas/registradas — em sandbox, não estão no DICT do Banco
// Central e não recebem dinheiro real.
export interface TabelaChavesPix {
  id: Generated<number>;
  tipo: TipoChavePix;
  chave: string;
  titular: string;
  criada_em: CriadaEm;
}

// Cobrança PIX: liga um pagamento ao seu txid e ao BR Code (copia e cola).
export interface TabelaCobrancasPix {
  id: Generated<number>;
  pagamento_id: number;
  txid: string;
  chave: string;
  copia_e_cola: string;
  criada_em: CriadaEm;
}

export interface BancoDeDados {
  pagamentos: TabelaPagamentos;
  transicoes: TabelaTransicoes;
  webhook_eventos: TabelaWebhookEventos;
  estornos: TabelaEstornos;
  chaves_pix: TabelaChavesPix;
  cobrancas_pix: TabelaCobrancasPix;
}
