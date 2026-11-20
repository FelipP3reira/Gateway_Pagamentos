import { createHmac } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { AssinaturaInvalida, ErroDeAplicacao, RecusaDoProvedor } from '../src/erros.ts';
import {
  AdaptadorMercadoPago,
  assinaturaMercadoPagoValida,
  mapearStatusMercadoPago,
} from '../src/provedores/mercadopago.ts';
import type { DadosCobranca } from '../src/provedores/provedor.ts';
import { assinarMp, MercadoPagoFalso, SEGREDO_MP } from './mp-auxiliar.ts';

// 2026-01-15 12:00:00 UTC
const AGORA = Date.UTC(2026, 0, 15, 12, 0, 0);
const TS = String(AGORA / 1000);

let mp: MercadoPagoFalso;
let adaptador: AdaptadorMercadoPago;

beforeEach(() => {
  mp = new MercadoPagoFalso();
  adaptador = new AdaptadorMercadoPago({
    accessToken: 'TEST-token-de-teste',
    segredoWebhook: SEGREDO_MP,
    http: mp.http,
    urlNotificacao: 'https://gateway.exemplo.com/webhooks/mercadopago',
    agora: () => AGORA,
  });
});

function cartao(sobrescrever: Partial<DadosCobranca> = {}): DadosCobranca {
  return {
    metodo: 'cartao',
    valorCentavos: 59_880,
    moeda: 'BRL',
    tokenMetodo: 'card_token_123',
    capturaAutomatica: true,
    chaveIdempotencia: 'idem-1',
    parcelas: 6,
    metodoPagamentoId: 'visa',
    emissorId: '25',
    pagador: { email: 'cliente@exemplo.com', tipoDocumento: 'CPF', documento: '12345678909' },
    descricao: 'Pedido 42',
    ...sobrescrever,
  };
}

describe('assinatura do webhook (x-signature)', () => {
  it('confere o manifest documentado: id;request-id;ts; com HMAC-SHA256 hex', () => {
    // Manifest escrito à mão, independente do código: se o formato mudar, falha.
    const manifest = 'id:123456;request-id:req-abc;ts:1700000000;';
    const hash = createHmac('sha256', 'segredo').update(manifest).digest('hex');

    expect(
      assinaturaMercadoPagoValida({
        xSignature: `ts=1700000000,v1=${hash}`,
        xRequestId: 'req-abc',
        dataId: '123456',
        segredo: 'segredo',
      }),
    ).toBe(true);
  });

  it('omite os pares ausentes do manifest (sem x-request-id)', () => {
    const hash = createHmac('sha256', 'segredo').update('id:9;ts:1700000000;').digest('hex');
    expect(
      assinaturaMercadoPagoValida({
        xSignature: `ts=1700000000,v1=${hash}`,
        xRequestId: undefined,
        dataId: '9',
        segredo: 'segredo',
      }),
    ).toBe(true);
  });

  it('preserva maiúsculas do data.id (como o SDK oficial)', () => {
    const assinatura = assinarMp({ dataId: 'ORD01ABC', requestId: 'r', ts: '1700000000' });
    const base = { xSignature: assinatura, xRequestId: 'r', segredo: SEGREDO_MP };
    expect(assinaturaMercadoPagoValida({ ...base, dataId: 'ORD01ABC' })).toBe(true);
    expect(assinaturaMercadoPagoValida({ ...base, dataId: 'ord01abc' })).toBe(false);
  });

  it.each([
    ['sem cabeçalho', undefined],
    ['lixo', 'isto-nao-e-assinatura'],
    ['sem ts', 'v1=abcdef'],
    ['sem v1', 'ts=1700000000'],
    ['ts não numérico', 'ts=abc,v1=abcdef'],
  ])('rejeita %s', (_nome, xSignature) => {
    expect(
      assinaturaMercadoPagoValida({
        xSignature,
        xRequestId: 'r',
        dataId: '1',
        segredo: SEGREDO_MP,
      }),
    ).toBe(false);
  });

  it('rejeita segredo errado, data.id trocado e request-id trocado', () => {
    const assinatura = assinarMp({ dataId: '1', requestId: 'r', ts: '1700000000' });
    const base = { xSignature: assinatura, xRequestId: 'r', dataId: '1', segredo: SEGREDO_MP };
    expect(assinaturaMercadoPagoValida(base)).toBe(true);
    expect(assinaturaMercadoPagoValida({ ...base, segredo: 'outro' })).toBe(false);
    expect(assinaturaMercadoPagoValida({ ...base, dataId: '2' })).toBe(false);
    expect(assinaturaMercadoPagoValida({ ...base, xRequestId: 'outro' })).toBe(false);
  });

  it('aplica a tolerância de tempo (segundos e milissegundos)', () => {
    const base = { xRequestId: 'r', dataId: '1', segredo: SEGREDO_MP, toleranciaSegundos: 300 };
    const dentro = assinarMp({ dataId: '1', requestId: 'r', ts: String(AGORA / 1000 - 200) });
    const fora = assinarMp({ dataId: '1', requestId: 'r', ts: String(AGORA / 1000 - 400) });
    const emMs = assinarMp({ dataId: '1', requestId: 'r', ts: String(AGORA - 10_000) });

    expect(assinaturaMercadoPagoValida({ ...base, xSignature: dentro, agora: () => AGORA })).toBe(
      true,
    );
    expect(assinaturaMercadoPagoValida({ ...base, xSignature: fora, agora: () => AGORA })).toBe(
      false,
    );
    expect(assinaturaMercadoPagoValida({ ...base, xSignature: emMs, agora: () => AGORA })).toBe(
      true,
    );
  });
});

describe('verificarWebhook', () => {
  const corpo = Buffer.from(
    JSON.stringify({ id: 12345, type: 'payment', action: 'payment.updated', data: { id: '999' } }),
  );

  it('evento de pagamento válido pede consulta do estado', () => {
    const evento = adaptador.verificarWebhook(
      corpo,
      assinarMp({ dataId: '999', requestId: 'req-1', ts: TS }),
      { cabecalhos: { 'x-request-id': 'req-1' }, query: { 'data.id': '999', type: 'payment' } },
    );
    expect(evento).toEqual({
      id: '12345',
      tipo: 'payment.updated',
      referenciaExterna: '999',
      estado: null,
      exigeConsulta: true,
    });
  });

  it('outros tópicos passam sem efeito', () => {
    const outro = Buffer.from(JSON.stringify({ id: 1, type: 'merchant_order', data: { id: '5' } }));
    const evento = adaptador.verificarWebhook(outro, assinarMp({ dataId: '5', ts: TS }), {
      cabecalhos: {},
      query: { 'data.id': '5' },
    });
    expect(evento).toMatchObject({ referenciaExterna: null, estado: null });
    expect(evento.exigeConsulta).toBeUndefined();
  });

  it('assinatura inválida lança AssinaturaInvalida', () => {
    expect(() =>
      adaptador.verificarWebhook(corpo, assinarMp({ dataId: '999', ts: TS, segredo: 'x' }), {
        cabecalhos: {},
        query: { 'data.id': '999' },
      }),
    ).toThrow(AssinaturaInvalida);
  });

  it('assinatura fora da janela de 300 s (replay) é rejeitada', () => {
    const antigo = String(AGORA / 1000 - 3600);
    expect(() =>
      adaptador.verificarWebhook(corpo, assinarMp({ dataId: '999', ts: antigo }), {
        cabecalhos: {},
        query: { 'data.id': '999' },
      }),
    ).toThrow(AssinaturaInvalida);
  });
});

describe('cobrança no cartão', () => {
  it('monta o corpo e os cabeçalhos da API de pagamentos', async () => {
    const resultado = await adaptador.autorizar(cartao());
    const chamada = mp.chamadas[0]!;

    expect(chamada.metodo).toBe('POST');
    expect(chamada.url).toBe('https://api.mercadopago.com/v1/payments');
    expect(chamada.cabecalhos.Authorization).toBe('Bearer TEST-token-de-teste');
    expect(chamada.cabecalhos['X-Idempotency-Key']).toBe('idem-1');
    expect(chamada.corpo).toEqual({
      transaction_amount: 598.8,
      description: 'Pedido 42',
      payer: {
        email: 'cliente@exemplo.com',
        identification: { type: 'CPF', number: '12345678909' },
      },
      notification_url: 'https://gateway.exemplo.com/webhooks/mercadopago',
      token: 'card_token_123',
      installments: 6,
      payment_method_id: 'visa',
      issuer_id: '25',
      capture: true,
    });
    expect(resultado).toEqual({ referenciaExterna: '1000000', estado: 'capturado' });
  });

  it('captura manual devolve autorizado', async () => {
    const resultado = await adaptador.autorizar(cartao({ capturaAutomatica: false }));
    expect(resultado.estado).toBe('autorizado');
    expect(mp.chamadas[0]!.corpo!.capture).toBe(false);
  });

  it('4xx de validação vira RecusaDoProvedor com o código da causa', async () => {
    mp.proximaCriacao = {
      status: 400,
      corpo: { message: 'invalid token', cause: [{ code: 3003 }] },
    };
    const erro = await adaptador.autorizar(cartao()).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(RecusaDoProvedor);
    expect((erro as RecusaDoProvedor).codigo).toBe('mp_3003');
  });

  it.each([401, 403, 429, 500, 503])('HTTP %i é falha comum, não recusa', async (status) => {
    mp.proximaCriacao = { status, corpo: { message: 'x' } };
    const erro = await adaptador.autorizar(cartao()).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(erro).not.toBeInstanceOf(RecusaDoProvedor);
  });

  it('a mensagem de erro nunca leva o access token', async () => {
    mp.proximaCriacao = { status: 500, corpo: {} };
    const erro = (await adaptador.autorizar(cartao()).catch((e: unknown) => e)) as Error;
    expect(erro.message).not.toContain('TEST-token-de-teste');
  });
});

describe('cobrança Pix', () => {
  it('cria com payment_method_id pix, validade no fuso de Brasília e devolve o QR', async () => {
    const resultado = await adaptador.autorizar(
      cartao({
        metodo: 'pix',
        tokenMetodo: undefined,
        parcelas: 1,
        metodoPagamentoId: undefined,
        emissorId: undefined,
        pixExpiraEmMinutos: 30,
      }),
    );
    const corpo = mp.chamadas[0]!.corpo!;

    expect(corpo.payment_method_id).toBe('pix');
    expect(corpo).not.toHaveProperty('token');
    expect(corpo).not.toHaveProperty('installments');
    // 12:30 UTC = 09:30 em Brasília.
    expect(corpo.date_of_expiration).toBe('2026-01-15T09:30:00.000-03:00');

    expect(resultado.estado).toBe('pendente');
    expect(resultado.pix).toEqual({
      copiaECola: '00020126580014br.gov.bcb.pix-1000000',
      qrCodeBase64: 'iVBORw0KGgoAAAANSUhEUg==',
      urlTicket: 'https://www.mercadopago.com.br/payments/1000000/ticket',
      expiraEm: new Date('2026-01-15T12:30:00.000Z'),
    });
  });
});

describe('captura, cancelamento, estorno e consulta', () => {
  it('usam os endpoints oficiais com chave de idempotência por operação', async () => {
    const { referenciaExterna } = await adaptador.autorizar(cartao({ capturaAutomatica: false }));

    expect(await adaptador.capturar(referenciaExterna)).toEqual({
      referenciaExterna,
      estado: 'capturado',
    });
    const estorno = await adaptador.estornar(referenciaExterna, 59_880);
    expect(estorno.referenciaExterna).toMatch(/^\d+$/);
    expect(await adaptador.consultar(referenciaExterna)).toBe('estornado');

    const [, captura, reembolso, consulta] = mp.chamadas;
    expect(captura).toMatchObject({ metodo: 'PUT', corpo: { capture: true } });
    expect(captura!.cabecalhos['X-Idempotency-Key']).toBe(`captura-${referenciaExterna}`);
    expect(reembolso).toMatchObject({ metodo: 'POST', corpo: {} });
    expect(reembolso!.url).toContain(`/v1/payments/${referenciaExterna}/refunds`);
    expect(reembolso!.cabecalhos['X-Idempotency-Key']).toBe(`estorno-${referenciaExterna}`);
    expect(consulta).toMatchObject({ metodo: 'GET', corpo: undefined });
  });

  it('cancela com status cancelled', async () => {
    const { referenciaExterna } = await adaptador.autorizar(cartao({ capturaAutomatica: false }));
    await adaptador.cancelar(referenciaExterna);
    expect(mp.chamadas[1]).toMatchObject({ metodo: 'PUT', corpo: { status: 'cancelled' } });
    expect(await adaptador.consultar(referenciaExterna)).toBe('cancelado');
  });

  it('mapeia todos os status documentados', () => {
    expect(mapearStatusMercadoPago('approved')).toBe('capturado');
    expect(mapearStatusMercadoPago('authorized')).toBe('autorizado');
    expect(mapearStatusMercadoPago('pending')).toBe('pendente');
    expect(mapearStatusMercadoPago('in_process')).toBe('pendente');
    expect(mapearStatusMercadoPago('in_mediation')).toBe('pendente');
    expect(mapearStatusMercadoPago('rejected')).toBe('falhou');
    expect(mapearStatusMercadoPago('cancelled')).toBe('cancelado');
    expect(mapearStatusMercadoPago('refunded')).toBe('estornado');
    expect(mapearStatusMercadoPago('charged_back')).toBe('estornado');
    expect(mapearStatusMercadoPago('algo_novo')).toBe('pendente');
  });
});

describe('validarCobranca', () => {
  it('exige BRL, e-mail do pagador e bandeira no cartão', () => {
    expect(() => adaptador.validarCobranca(cartao({ moeda: 'USD' }))).toThrow(ErroDeAplicacao);
    expect(() => adaptador.validarCobranca(cartao({ pagador: undefined }))).toThrow(
      /pagador.email/,
    );
    expect(() => adaptador.validarCobranca(cartao({ metodoPagamentoId: undefined }))).toThrow(
      /metodoPagamentoId/,
    );
    expect(() =>
      adaptador.validarCobranca(cartao({ metodo: 'pix', metodoPagamentoId: undefined })),
    ).not.toThrow();
  });
});
