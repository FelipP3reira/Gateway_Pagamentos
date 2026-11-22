import type { Estado, Provedor } from '../db/esquema.ts';

// Os estados que um provedor pode reportar. Inclui `pendente`: o Pix fica
// aguardando a transferência e o cartão pode ficar em análise (in_process) —
// nesses casos o pagamento continua pendente até o webhook ou a reconciliação.
export type EstadoProvedor = Estado;

// Forma de pagamento. Cartão exige token do provedor; Pix não.
export type Metodo = 'cartao' | 'pix';

// Dados da cobrança Pix devolvidos pelo provedor, para a loja exibir.
export interface DadosPix {
  // "Copia e cola" (BR Code).
  copiaECola: string;
  // Imagem do QR em PNG base64 (sem o prefixo data:).
  qrCodeBase64: string | null;
  // Página do provedor com QR e instruções, quando houver.
  urlTicket: string | null;
  expiraEm: Date | null;
}

// Cabeçalhos e query da requisição do webhook, para provedores que assinam mais
// do que o corpo (o Mercado Pago assina data.id da query e o x-request-id).
export interface ContextoWebhook {
  cabecalhos: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

// Quem paga, no formato que os provedores brasileiros pedem (o Mercado Pago exige
// e-mail e documento). Só trafega até o provedor; o gateway não persiste.
export interface Pagador {
  email: string;
  tipoDocumento?: 'CPF' | 'CNPJ';
  documento?: string;
}

// Dados de uma cobrança do ponto de vista do provedor. O token é do método de
// pagamento (tokenização do provedor); o PAN nunca chega aqui.
export interface DadosCobranca {
  metodo: Metodo;
  valorCentavos: number;
  moeda: string;
  // Obrigatório no cartão (a rota garante); ausente no Pix.
  tokenMetodo?: string;
  descricao?: string;
  capturaAutomatica: boolean;
  // Repassada ao provedor para a operação ser idempotente do lado dele também.
  chaveIdempotencia: string;
  // Parcelas do cartão (1 = à vista). Já validado contra `parcelasMaximas`.
  parcelas: number;
  metodoPagamentoId?: string;
  emissorId?: string;
  pagador?: Pagador;
  // Validade da cobrança Pix, em minutos a partir de agora.
  pixExpiraEmMinutos?: number;
  // Id do pedido na loja, para aparecer no painel do provedor.
  referenciaPedido?: string;
}

export interface ResultadoProvedor {
  // Id do pagamento no provedor (payment intent / charge).
  referenciaExterna: string;
  estado: EstadoProvedor;
  // Presente nas cobranças Pix.
  pix?: DadosPix;
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
  // true quando o evento só avisa "mudou" e o estado precisa ser consultado no
  // provedor (é o caso do Mercado Pago: a notificação traz só o id).
  exigeConsulta?: boolean;
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
  // Maior número de parcelas que o adaptador sabe cobrar. O serviço recusa acima
  // disso antes de gravar o pagamento. 1 = só à vista.
  readonly parcelasMaximas: number;
  // Formas de pagamento que o adaptador cobra.
  readonly metodos: readonly Metodo[];
  /**
   * Regras próprias do provedor (ex.: e-mail do pagador obrigatório), checadas
   * ANTES de gravar o pagamento. Lança ErroDeAplicacao 400 se faltar algo.
   */
  validarCobranca?(dados: DadosCobranca): void;
  autorizar(dados: DadosCobranca): Promise<ResultadoProvedor>;
  capturar(referenciaExterna: string): Promise<ResultadoProvedor>;
  estornar(
    referenciaExterna: string,
    valorCentavos: number,
  ): Promise<{ referenciaExterna: string }>;
  cancelar(referenciaExterna: string): Promise<void>;
  // Estado atual no provedor — a fonte da verdade para a reconciliação.
  consultar(referenciaExterna: string): Promise<EstadoProvedor>;
  verificarWebhook(
    corpoCru: Buffer,
    assinatura: string | undefined,
    contexto?: ContextoWebhook,
  ): EventoWebhook;
}
