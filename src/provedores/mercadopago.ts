import { createHmac, timingSafeEqual } from 'node:crypto';

import { AssinaturaInvalida, ErroDeAplicacao, RecusaDoProvedor } from '../erros.ts';
import type {
  ContextoWebhook,
  DadosCobranca,
  DadosPix,
  EstadoProvedor,
  EventoWebhook,
  ProvedorDePagamento,
  ResultadoProvedor,
} from './provedor.ts';

/**
 * Adaptador do Mercado Pago (Checkout Transparente / API de pagamentos v1).
 *
 * - Cartão: o navegador tokeniza com o SDK/Bricks do Mercado Pago (chave
 *   pública); aqui só chegam o token, a bandeira (payment_method_id), o emissor
 *   e as parcelas. Número e CVV nunca passam pelo gateway.
 * - Pix: a cobrança é criada no próprio Mercado Pago, que devolve o QR, o copia
 *   e cola e a validade. O pagamento fica `pendente` até o webhook.
 * - Webhook: a notificação traz só o id do pagamento; a assinatura (x-signature)
 *   é validada e o estado é consultado na API (`exigeConsulta`).
 *
 * Referências: API de pagamentos (POST/GET/PUT /v1/payments, POST
 * /v1/payments/{id}/refunds), integração Pix do Checkout Transparente, status
 * em "Resultados da consulta" e a validação de assinatura do SDK oficial
 * (mercadopago/sdk-nodejs, src/utils/webhook).
 */

// Subconjunto do fetch que o adaptador usa. Injetado: os testes passam um duble.
export type ClienteHttp = (url: string, init: RequestInit) => Promise<Response>;

export interface OpcoesMercadoPago {
  accessToken: string;
  segredoWebhook: string;
  http?: ClienteHttp;
  // URL pública do nosso /webhooks/mercadopago (HTTPS). Opcional: sem ela, vale a
  // URL configurada no painel do Mercado Pago.
  urlNotificacao?: string;
  parcelasMaximas?: number;
  // Janela anti-replay do timestamp da assinatura. O exemplo oficial usa 300.
  toleranciaSegundos?: number;
  timeoutMs?: number;
  urlBase?: string;
  agora?: () => number;
}

// Resposta da API de pagamentos, só os campos usados.
interface PagamentoMp {
  id: number | string;
  status: string;
  status_detail?: string;
  date_of_expiration?: string | null;
  point_of_interaction?: {
    transaction_data?: {
      qr_code?: string | null;
      qr_code_base64?: string | null;
      ticket_url?: string | null;
    };
  };
}

interface ReembolsoMp {
  id: number | string;
}

/**
 * Status do Mercado Pago → estado do domínio. Os casos "em andamento" (pending,
 * in_process, in_mediation) ficam `pendente`: o desfecho chega depois. Um
 * status desconhecido também vira `pendente`, que nunca força transição.
 */
export function mapearStatusMercadoPago(status: string): EstadoProvedor {
  switch (status) {
    case 'approved':
      return 'capturado';
    case 'authorized':
      return 'autorizado';
    case 'rejected':
      return 'falhou';
    case 'cancelled':
      return 'cancelado';
    case 'refunded':
    case 'charged_back':
      return 'estornado';
    default:
      return 'pendente';
  }
}

/**
 * Valida o x-signature do Mercado Pago, na mesma lógica do validador oficial do
 * SDK Node: manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (pares
 * ausentes são omitidos), HMAC-SHA256 em hex, versão v1, comparação em tempo
 * constante e tolerância de timestamp opcional contra replay.
 */
export function assinaturaMercadoPagoValida(opcoes: {
  xSignature: string | undefined;
  xRequestId: string | undefined;
  dataId: string | undefined;
  segredo: string;
  toleranciaSegundos?: number;
  agora?: () => number;
}): boolean {
  const xSignature = opcoes.xSignature?.trim();
  if (!xSignature) {
    return false;
  }

  let ts: string | undefined;
  let v1: string | undefined;
  for (const parte of xSignature.split(',')) {
    const igual = parte.indexOf('=');
    if (igual === -1) {
      continue;
    }
    const chave = parte.slice(0, igual).trim().toLowerCase();
    const valor = parte.slice(igual + 1).trim();
    if (chave === 'ts') {
      ts = valor;
    } else if (chave === 'v1') {
      v1 = valor;
    }
  }
  if (!ts || !/^\d+$/.test(ts) || !v1) {
    return false;
  }

  const dataId = opcoes.dataId?.trim();
  const xRequestId = opcoes.xRequestId?.trim();
  const partes: string[] = [];
  if (dataId) partes.push(`id:${dataId}`);
  if (xRequestId) partes.push(`request-id:${xRequestId}`);
  partes.push(`ts:${ts}`);
  const manifest = `${partes.join(';')};`;

  const esperado = createHmac('sha256', opcoes.segredo).update(manifest).digest('hex');
  const a = Buffer.from(esperado);
  const b = Buffer.from(v1);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return false;
  }

  if (opcoes.toleranciaSegundos !== undefined) {
    // O SDK trata o ts como segundos. Por segurança aceita também milissegundos
    // (valores com 13+ dígitos), para a janela não rejeitar tudo se o formato
    // mudar.
    const numero = Number(ts);
    const tsMs = numero >= 1e12 ? numero : numero * 1000;
    const agora = (opcoes.agora ?? Date.now)();
    if (Math.abs(agora - tsMs) / 1000 > opcoes.toleranciaSegundos) {
      return false;
    }
  }
  return true;
}

// Data no formato que a API aceita (yyyy-MM-dd'T'HH:mm:ss.SSS±hh:mm), no fuso
// de Brasília (UTC-3, sem horário de verão desde 2019).
function formatarDataMp(data: Date): string {
  const local = new Date(data.getTime() - 3 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, 23)}-03:00`;
}

function centavosParaReais(centavos: number): number {
  return Math.round(centavos) / 100;
}

export class AdaptadorMercadoPago implements ProvedorDePagamento {
  readonly nome = 'mercadopago' as const;
  readonly metodos = ['cartao', 'pix'] as const;
  readonly parcelasMaximas: number;

  private readonly accessToken: string;
  private readonly segredoWebhook: string;
  private readonly http: ClienteHttp;
  private readonly urlNotificacao: string | undefined;
  private readonly toleranciaSegundos: number;
  private readonly timeoutMs: number;
  private readonly urlBase: string;
  private readonly agora: () => number;

  constructor(opcoes: OpcoesMercadoPago) {
    this.accessToken = opcoes.accessToken;
    this.segredoWebhook = opcoes.segredoWebhook;
    this.http = opcoes.http ?? fetch;
    this.urlNotificacao = opcoes.urlNotificacao;
    this.parcelasMaximas = opcoes.parcelasMaximas ?? 12;
    this.toleranciaSegundos = opcoes.toleranciaSegundos ?? 300;
    this.timeoutMs = opcoes.timeoutMs ?? 10_000;
    this.urlBase = opcoes.urlBase ?? 'https://api.mercadopago.com';
    this.agora = opcoes.agora ?? Date.now;
  }

  validarCobranca(dados: DadosCobranca): void {
    if (dados.moeda.toUpperCase() !== 'BRL') {
      throw new ErroDeAplicacao(400, 'moeda_invalida', 'O Mercado Pago cobra só em BRL.');
    }
    // A API pede o e-mail do pagador nos dois métodos.
    if (!dados.pagador?.email) {
      throw new ErroDeAplicacao(400, 'pagador_obrigatorio', 'O Mercado Pago exige pagador.email.');
    }
    if (dados.metodo === 'cartao' && !dados.metodoPagamentoId) {
      throw new ErroDeAplicacao(
        400,
        'metodo_pagamento_obrigatorio',
        'No cartão, informe metodoPagamentoId (payment_method_id devolvido pelo Bricks).',
      );
    }
  }

  async autorizar(dados: DadosCobranca): Promise<ResultadoProvedor> {
    const pagador = dados.pagador
      ? {
          email: dados.pagador.email,
          ...(dados.pagador.documento
            ? {
                identification: {
                  type: dados.pagador.tipoDocumento ?? 'CPF',
                  number: dados.pagador.documento,
                },
              }
            : {}),
        }
      : undefined;

    const comum = {
      transaction_amount: centavosParaReais(dados.valorCentavos),
      description: dados.descricao,
      payer: pagador,
      ...(this.urlNotificacao ? { notification_url: this.urlNotificacao } : {}),
    };

    const corpo =
      dados.metodo === 'pix'
        ? {
            ...comum,
            payment_method_id: 'pix',
            date_of_expiration: formatarDataMp(
              new Date(this.agora() + (dados.pixExpiraEmMinutos ?? 30) * 60_000),
            ),
          }
        : {
            ...comum,
            token: dados.tokenMetodo,
            installments: dados.parcelas,
            payment_method_id: dados.metodoPagamentoId,
            ...(dados.emissorId ? { issuer_id: dados.emissorId } : {}),
            capture: dados.capturaAutomatica,
          };

    const pagamento = await this.requisitar<PagamentoMp>('POST', '/v1/payments', corpo, {
      // A mesma chave no Mercado Pago: um retry nunca cria dois pagamentos lá.
      idempotencia: dados.chaveIdempotencia,
      recusaDefinitiva: true,
    });

    const pix = dados.metodo === 'pix' ? extrairPix(pagamento) : undefined;
    return {
      referenciaExterna: String(pagamento.id),
      estado: mapearStatusMercadoPago(pagamento.status),
      ...(pix ? { pix } : {}),
    };
  }

  async capturar(referenciaExterna: string): Promise<ResultadoProvedor> {
    const pagamento = await this.requisitar<PagamentoMp>(
      'PUT',
      `/v1/payments/${encodeURIComponent(referenciaExterna)}`,
      { capture: true },
      { idempotencia: `captura-${referenciaExterna}` },
    );
    return { referenciaExterna, estado: mapearStatusMercadoPago(pagamento.status) };
  }

  async estornar(
    referenciaExterna: string,
    _valorCentavos: number,
  ): Promise<{ referenciaExterna: string }> {
    // Sem `amount` o Mercado Pago faz o reembolso integral, que é o que o
    // gateway suporta hoje. A chave fixa por pagamento impede estorno duplo.
    const reembolso = await this.requisitar<ReembolsoMp>(
      'POST',
      `/v1/payments/${encodeURIComponent(referenciaExterna)}/refunds`,
      {},
      { idempotencia: `estorno-${referenciaExterna}` },
    );
    return { referenciaExterna: String(reembolso.id) };
  }

  async cancelar(referenciaExterna: string): Promise<void> {
    // Só vale para pending, in_process e authorized (regra do Mercado Pago).
    await this.requisitar<PagamentoMp>(
      'PUT',
      `/v1/payments/${encodeURIComponent(referenciaExterna)}`,
      { status: 'cancelled' },
      { idempotencia: `cancelamento-${referenciaExterna}` },
    );
  }

  async consultar(referenciaExterna: string): Promise<EstadoProvedor> {
    const pagamento = await this.requisitar<PagamentoMp>(
      'GET',
      `/v1/payments/${encodeURIComponent(referenciaExterna)}`,
    );
    return mapearStatusMercadoPago(pagamento.status);
  }

  verificarWebhook(
    corpoCru: Buffer,
    assinatura: string | undefined,
    contexto?: ContextoWebhook,
  ): EventoWebhook {
    // data.id vem da query, cru — é o que o Mercado Pago assina.
    const dataIdQuery = contexto?.query['data.id'];
    const xRequestId = contexto?.cabecalhos['x-request-id'];

    const valida = assinaturaMercadoPagoValida({
      xSignature: assinatura,
      xRequestId,
      dataId: dataIdQuery,
      segredo: this.segredoWebhook,
      toleranciaSegundos: this.toleranciaSegundos,
      agora: this.agora,
    });
    if (!valida) {
      throw new AssinaturaInvalida();
    }

    // Só chega aqui com assinatura válida.
    let corpo: {
      id?: number | string;
      type?: string;
      topic?: string;
      action?: string;
      data?: { id?: number | string };
    } = {};
    try {
      corpo = JSON.parse(corpoCru.toString('utf8')) as typeof corpo;
    } catch {
      throw new ErroDeAplicacao(400, 'json_invalido', 'Corpo do webhook inválido.');
    }

    const tipo = corpo.type ?? corpo.topic ?? contexto?.query.type ?? 'desconhecido';
    const dataId = dataIdQuery ?? (corpo.data?.id !== undefined ? String(corpo.data.id) : null);
    // Id da notificação: o mesmo nas re-entregas. Sem ele, o x-request-id.
    const idEvento =
      corpo.id !== undefined ? String(corpo.id) : (xRequestId ?? `${tipo}:${dataId ?? ''}`);

    if (tipo !== 'payment' || !dataId) {
      // Outros tópicos (merchant_order, chargebacks...) não mudam estado aqui.
      return { id: idEvento, tipo, referenciaExterna: null, estado: null };
    }
    return {
      id: idEvento,
      tipo: corpo.action ?? tipo,
      referenciaExterna: dataId,
      estado: null,
      exigeConsulta: true,
    };
  }

  /**
   * Chamada à API com timeout. Erros 4xx de validação na criação viram
   * RecusaDoProvedor (a cobrança não existe lá); 401/403/429 e 5xx são falha
   * nossa ou transitória e sobem como erro comum. A mensagem nunca leva o
   * access token.
   */
  private async requisitar<T>(
    metodo: 'GET' | 'POST' | 'PUT',
    caminho: string,
    corpo?: unknown,
    opcoes: { idempotencia?: string; recusaDefinitiva?: boolean } = {},
  ): Promise<T> {
    const cabecalhos: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: 'application/json',
    };
    if (corpo !== undefined) {
      cabecalhos['Content-Type'] = 'application/json';
    }
    if (opcoes.idempotencia) {
      cabecalhos['X-Idempotency-Key'] = opcoes.idempotencia;
    }

    const resposta = await this.http(`${this.urlBase}${caminho}`, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const texto = await resposta.text();
    if (resposta.ok) {
      return JSON.parse(texto) as T;
    }

    const status = resposta.status;
    const definitiva =
      opcoes.recusaDefinitiva && status >= 400 && status < 500 && ![401, 403, 429].includes(status);
    let codigo = `http_${status}`;
    try {
      const erro = JSON.parse(texto) as { message?: string; cause?: { code?: string | number }[] };
      const causa = erro.cause?.[0]?.code;
      codigo = causa !== undefined ? `mp_${causa}` : (erro.message ?? codigo);
    } catch {
      // Corpo não-JSON: fica o status.
    }
    if (definitiva) {
      throw new RecusaDoProvedor(codigo, `Mercado Pago recusou a requisição (${codigo}).`);
    }
    throw new Error(`Mercado Pago respondeu ${status} em ${metodo} ${caminho} (${codigo}).`);
  }
}

// Sem copia e cola devolve undefined — mas a referência do pagamento continua
// sendo guardada (a cobrança existe lá e a reconciliação precisa dela). A loja
// vê `pix: null` e pode cancelar ou tentar de novo.
function extrairPix(pagamento: PagamentoMp): DadosPix | undefined {
  const dados = pagamento.point_of_interaction?.transaction_data;
  if (!dados?.qr_code) {
    return undefined;
  }
  return {
    copiaECola: dados.qr_code,
    qrCodeBase64: dados.qr_code_base64 ?? null,
    urlTicket: dados.ticket_url ?? null,
    expiraEm: pagamento.date_of_expiration ? new Date(pagamento.date_of_expiration) : null,
  };
}
