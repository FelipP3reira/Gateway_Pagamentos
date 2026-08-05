import type Stripe from 'stripe';

import { AssinaturaInvalida } from '../erros.ts';
import type {
  DadosCobranca,
  EstadoProvedor,
  EventoWebhook,
  ProvedorDePagamento,
  ResultadoProvedor,
} from './provedor.ts';

// Só o pedaço da SDK da Stripe que usamos. O cliente é injetado no construtor,
// então os testes passam um duble e nada bate na rede.
export interface ClienteStripe {
  paymentIntents: {
    create(
      params: Stripe.PaymentIntentCreateParams,
      options: Stripe.RequestOptions,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
    capture(id: string): Promise<Stripe.Response<Stripe.PaymentIntent>>;
    cancel(id: string): Promise<Stripe.Response<Stripe.PaymentIntent>>;
    retrieve(
      id: string,
      params: Stripe.PaymentIntentRetrieveParams,
    ): Promise<Stripe.Response<Stripe.PaymentIntent>>;
  };
  refunds: {
    create(params: Stripe.RefundCreateParams): Promise<Stripe.Response<Stripe.Refund>>;
  };
  webhooks: {
    constructEvent(corpo: Buffer, assinatura: string, segredo: string): Stripe.Event;
  };
}

export class AdaptadorStripe implements ProvedorDePagamento {
  readonly nome = 'stripe' as const;

  constructor(
    private readonly stripe: ClienteStripe,
    private readonly segredoWebhook: string,
  ) {}

  async autorizar(dados: DadosCobranca): Promise<ResultadoProvedor> {
    const intent = await this.stripe.paymentIntents.create(
      {
        amount: dados.valorCentavos,
        currency: dados.moeda.toLowerCase(),
        payment_method: dados.tokenMetodo,
        confirm: true,
        capture_method: dados.capturaAutomatica ? 'automatic' : 'manual',
        // Sem redirecionamentos: cobramos server-side com um método já tokenizado.
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        description: dados.descricao,
      },
      // A idempotência da Stripe: a mesma chave não cria dois intents.
      { idempotencyKey: dados.chaveIdempotencia },
    );
    return { referenciaExterna: intent.id, estado: mapearStatus(intent.status) };
  }

  async capturar(referenciaExterna: string): Promise<ResultadoProvedor> {
    const intent = await this.stripe.paymentIntents.capture(referenciaExterna);
    return { referenciaExterna: intent.id, estado: mapearStatus(intent.status) };
  }

  async estornar(
    referenciaExterna: string,
    valorCentavos: number,
  ): Promise<{ referenciaExterna: string }> {
    const estorno = await this.stripe.refunds.create({
      payment_intent: referenciaExterna,
      amount: valorCentavos,
    });
    return { referenciaExterna: estorno.id };
  }

  async cancelar(referenciaExterna: string): Promise<void> {
    await this.stripe.paymentIntents.cancel(referenciaExterna);
  }

  async consultar(referenciaExterna: string): Promise<EstadoProvedor> {
    const intent = await this.stripe.paymentIntents.retrieve(referenciaExterna, {
      expand: ['latest_charge'],
    });
    const cobranca = intent.latest_charge;
    if (cobranca && typeof cobranca !== 'string' && cobranca.refunded) {
      return 'estornado';
    }
    return mapearStatus(intent.status);
  }

  verificarWebhook(corpoCru: Buffer, assinatura: string | undefined): EventoWebhook {
    if (!assinatura) {
      throw new AssinaturaInvalida();
    }
    let evento: Stripe.Event;
    try {
      // A Stripe verifica a assinatura contra o corpo cru; adulterou, estoura.
      evento = this.stripe.webhooks.constructEvent(corpoCru, assinatura, this.segredoWebhook);
    } catch {
      throw new AssinaturaInvalida();
    }
    return normalizar(evento);
  }
}

function mapearStatus(status: Stripe.PaymentIntent.Status): EstadoProvedor {
  switch (status) {
    case 'succeeded':
      return 'capturado';
    case 'requires_capture':
      return 'autorizado';
    case 'canceled':
      return 'cancelado';
    default:
      return 'falhou';
  }
}

// Traduz o evento da Stripe para o nosso formato normalizado. Só os tipos que
// mudam estado importam; o resto passa como evento sem efeito (estado null).
function normalizar(evento: Stripe.Event): EventoWebhook {
  const objeto = evento.data.object as {
    id?: string;
    payment_intent?: string | { id: string } | null;
  };

  const refDireta = typeof objeto.id === 'string' ? objeto.id : null;
  const refPagamento =
    typeof objeto.payment_intent === 'string'
      ? objeto.payment_intent
      : (objeto.payment_intent?.id ?? null);

  const base = { id: evento.id, tipo: evento.type };

  switch (evento.type) {
    case 'payment_intent.succeeded':
      return { ...base, referenciaExterna: refDireta, estado: 'capturado' };
    case 'payment_intent.amount_capturable_updated':
      return { ...base, referenciaExterna: refDireta, estado: 'autorizado' };
    case 'payment_intent.canceled':
      return { ...base, referenciaExterna: refDireta, estado: 'cancelado' };
    case 'payment_intent.payment_failed':
      return { ...base, referenciaExterna: refDireta, estado: 'falhou' };
    case 'charge.refunded':
      return { ...base, referenciaExterna: refPagamento, estado: 'estornado' };
    default:
      return { ...base, referenciaExterna: refDireta ?? refPagamento, estado: null };
  }
}
