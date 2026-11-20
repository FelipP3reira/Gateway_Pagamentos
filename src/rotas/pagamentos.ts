import type { FastifyInstance } from 'fastify';

import { ErroDeAplicacao } from '../erros.ts';
import type { ServicoDeReconciliacao } from '../dominio/reconciliacao.ts';
import type { ServicoDePagamento } from '../dominio/servico-pagamento.ts';
import type { Metodo, Pagador, Pagamento } from '../dominio/tipos.ts';

// Teto absoluto de parcelas aceito na API. Cada provedor ainda impõe o seu
// (`parcelasMaximas`), e a regra comercial (juros, parcela mínima) é da loja.
const PARCELAS_TETO = 24;

// Validade da cobrança Pix: o Mercado Pago aceita de 30 minutos a 30 dias.
const PIX_MINUTOS_MIN = 30;
const PIX_MINUTOS_MAX = 30 * 24 * 60;
const PIX_MINUTOS_PADRAO = 30;

interface CorpoCriar {
  provedor: 'stripe' | 'fake' | 'mercadopago';
  metodo?: Metodo;
  valorCentavos: number;
  moeda: string;
  tokenMetodo?: string;
  descricao?: string;
  capturaAutomatica?: boolean;
  parcelas?: number;
  metodoPagamentoId?: string;
  emissorId?: string;
  pagador?: Pagador;
  pixExpiraEmMinutos?: number;
}

const schemaCriar = {
  type: 'object',
  // tokenMetodo é obrigatório só no cartão — conferido na rota.
  required: ['provedor', 'valorCentavos', 'moeda'],
  additionalProperties: false,
  properties: {
    provedor: { type: 'string', enum: ['stripe', 'fake', 'mercadopago'] },
    metodo: { type: 'string', enum: ['cartao', 'pix'] },
    pixExpiraEmMinutos: { type: 'integer', minimum: PIX_MINUTOS_MIN, maximum: PIX_MINUTOS_MAX },
    valorCentavos: { type: 'integer', minimum: 1 },
    moeda: { type: 'string', minLength: 3, maxLength: 3 },
    tokenMetodo: { type: 'string', minLength: 1 },
    descricao: { type: 'string' },
    capturaAutomatica: { type: 'boolean' },
    parcelas: { type: 'integer', minimum: 1, maximum: PARCELAS_TETO },
    metodoPagamentoId: { type: 'string', minLength: 1, maxLength: 64 },
    emissorId: { type: 'string', minLength: 1, maxLength: 64 },
    pagador: {
      type: 'object',
      required: ['email'],
      additionalProperties: false,
      properties: {
        email: { type: 'string', format: 'email', maxLength: 254 },
        tipoDocumento: { type: 'string', enum: ['CPF', 'CNPJ'] },
        // Só dígitos: 11 (CPF) ou 14 (CNPJ). O dígito verificador a loja valida.
        documento: { type: 'string', pattern: '^(\\d{11}|\\d{14})$' },
      },
    },
  },
};

// Resposta pública do pagamento. Não há dado sensível para omitir — o token do
// método nunca é guardado —, mas a saída é explícita de propósito.
function apresentar(p: Pagamento) {
  return {
    id: p.id,
    provedor: p.provedor,
    estado: p.estado,
    valorCentavos: p.valorCentavos,
    moeda: p.moeda,
    referenciaExterna: p.referenciaExterna,
    descricao: p.descricao,
    parcelas: p.parcelas,
    metodoPagamentoId: p.metodoPagamentoId,
    emissorId: p.emissorId,
    metodo: p.metodo,
    // Copia e cola, QR (PNG base64) e validade da cobrança Pix do provedor.
    pix: p.pix,
    criadoEm: p.criadoEm,
    atualizadoEm: p.atualizadoEm,
  };
}

export function registrarRotasPagamentos(
  app: FastifyInstance,
  deps: { servico: ServicoDePagamento; reconciliacao: ServicoDeReconciliacao },
): void {
  const { servico, reconciliacao } = deps;

  app.post<{ Body: CorpoCriar }>(
    '/pagamentos',
    { schema: { body: schemaCriar } },
    async (requisicao, resposta) => {
      const chave = requisicao.headers['idempotency-key'];
      if (typeof chave !== 'string' || chave.length === 0) {
        // Idempotência é obrigatória: sem chave, um retry poderia cobrar de novo.
        throw new ErroDeAplicacao(
          400,
          'sem_chave_idempotencia',
          'Header Idempotency-Key é obrigatório.',
        );
      }

      const corpo = requisicao.body;
      const metodo = corpo.metodo ?? 'cartao';
      if (metodo === 'cartao' && !corpo.tokenMetodo) {
        throw new ErroDeAplicacao(
          400,
          'token_obrigatorio',
          'tokenMetodo é obrigatório no cartão (token gerado pelo SDK do provedor).',
        );
      }
      const pagamento = await servico.criar({
        provedor: corpo.provedor,
        metodo,
        valorCentavos: corpo.valorCentavos,
        moeda: corpo.moeda,
        // No Pix não há token; ignora o que vier.
        tokenMetodo: metodo === 'cartao' ? corpo.tokenMetodo : undefined,
        descricao: corpo.descricao,
        capturaAutomatica: corpo.capturaAutomatica ?? false,
        chaveIdempotencia: chave,
        parcelas: corpo.parcelas,
        metodoPagamentoId: corpo.metodoPagamentoId,
        emissorId: corpo.emissorId,
        pagador: corpo.pagador,
        pixExpiraEmMinutos:
          metodo === 'pix' ? (corpo.pixExpiraEmMinutos ?? PIX_MINUTOS_PADRAO) : undefined,
      });

      return resposta.status(201).send(apresentar(pagamento));
    },
  );

  const acoes = {
    capturar: (id: number) => servico.capturar(id),
    estornar: (id: number) => servico.estornar(id),
    cancelar: (id: number) => servico.cancelar(id),
  };

  for (const [nome, executar] of Object.entries(acoes)) {
    app.post<{ Params: { id: string } }>(`/pagamentos/:id/${nome}`, async (requisicao) => {
      const id = Number(requisicao.params.id);
      return apresentar(await executar(id));
    });
  }

  app.get<{ Params: { id: string } }>('/pagamentos/:id', async (requisicao) => {
    const id = Number(requisicao.params.id);
    return apresentar(await servico.buscar(id));
  });

  // Reconcilia o estado local com o do provedor (a fonte da verdade).
  app.post<{ Params: { id: string } }>('/pagamentos/:id/reconciliar', async (requisicao) => {
    const id = Number(requisicao.params.id);
    const { pagamento, ajustado } = await reconciliacao.reconciliar(id);
    return { ...apresentar(pagamento), ajustado };
  });
}
