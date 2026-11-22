import type { ColumnType, Generated } from 'kysely';

// Estados do pagamento. A máquina de estados (dominio/maquina-estados.ts) é
// quem define quais transições entre eles são válidas.
export type Estado = 'pendente' | 'autorizado' | 'capturado' | 'estornado' | 'cancelado' | 'falhou';

export type Provedor = 'stripe' | 'fake' | 'pix' | 'mercadopago';

export type MetodoPagamento = 'cartao' | 'pix';

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
  // Número de parcelas do cartão (1 = à vista). Pix e débito são sempre 1.
  parcelas: ColumnType<number, number | undefined, number>;
  // Método no provedor (ex.: "visa", "master", "pix" no Mercado Pago).
  metodo_pagamento_id: ColumnType<string | null, string | null | undefined, string | null>;
  // Banco emissor do cartão, quando o provedor exige (issuer_id do Mercado Pago).
  emissor_id: ColumnType<string | null, string | null | undefined, string | null>;
  metodo: ColumnType<MetodoPagamento, MetodoPagamento | undefined, MetodoPagamento>;
  // Cobrança Pix vinda do provedor (Mercado Pago). O Pix simulado continua na
  // tabela cobrancas_pix.
  pix_copia_e_cola: ColumnType<string | null, string | null | undefined, string | null>;
  pix_qr_code_base64: ColumnType<string | null, string | null | undefined, string | null>;
  pix_url_ticket: ColumnType<string | null, string | null | undefined, string | null>;
  pix_expira_em: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  // Id do pedido na loja. Não é único: um pedido pode ter várias tentativas.
  referencia_pedido: ColumnType<string | null, string | null | undefined, string | null>;
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

export type StatusNotificacao = 'pendente' | 'entregue' | 'falhou';

// Outbox de notificações para a loja: gravada na MESMA transação da mudança de
// estado, então nenhuma mudança fica sem aviso. O entregador lê daqui.
export interface TabelaNotificacoesLoja {
  id: Generated<number>;
  pagamento_id: number;
  // Id do evento para a loja deduplicar (UUID).
  evento_id: string;
  // Id da última transição: ordem monotônica por pagamento, para a loja
  // ignorar um evento mais antigo que chegue atrasado.
  sequencia: number;
  estado: Estado;
  payload: ColumnType<unknown, string, string>;
  status: ColumnType<StatusNotificacao, StatusNotificacao | undefined, StatusNotificacao>;
  tentativas: ColumnType<number, number | undefined, number>;
  proxima_tentativa_em: ColumnType<Date, Date | string | undefined, Date | string>;
  ultimo_erro: ColumnType<string | null, string | null | undefined, string | null>;
  criada_em: CriadaEm;
  entregue_em: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

// Registro de cada tentativa de entrega (sucesso ou falha). Nunca se apaga.
export interface TabelaTentativasNotificacao {
  id: Generated<number>;
  notificacao_id: number;
  numero: number;
  status_http: ColumnType<number | null, number | null | undefined, never>;
  erro: ColumnType<string | null, string | null | undefined, never>;
  duracao_ms: number;
  criada_em: CriadaEm;
}

export interface BancoDeDados {
  pagamentos: TabelaPagamentos;
  transicoes: TabelaTransicoes;
  webhook_eventos: TabelaWebhookEventos;
  estornos: TabelaEstornos;
  chaves_pix: TabelaChavesPix;
  cobrancas_pix: TabelaCobrancasPix;
  notificacoes_loja: TabelaNotificacoesLoja;
  tentativas_notificacao: TabelaTentativasNotificacao;
}
