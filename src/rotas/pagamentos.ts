import type { FastifyInstance } from 'fastify';

import { ErroDeAplicacao } from '../erros.ts';
import type { ServicoDePagamento } from '../dominio/servico-pagamento.ts';
import type { Pagamento } from '../dominio/tipos.ts';

interface CorpoCriar {
  provedor: 'stripe' | 'fake';
  valorCentavos: number;
  moeda: string;
  tokenMetodo: string;
  descricao?: string;
  capturaAutomatica?: boolean;
}

const schemaCriar = {
  type: 'object',
  required: ['provedor', 'valorCentavos', 'moeda', 'tokenMetodo'],
  additionalProperties: false,
  properties: {
    provedor: { type: 'string', enum: ['stripe', 'fake'] },
    valorCentavos: { type: 'integer', minimum: 1 },
    moeda: { type: 'string', minLength: 3, maxLength: 3 },
    tokenMetodo: { type: 'string', minLength: 1 },
    descricao: { type: 'string' },
    capturaAutomatica: { type: 'boolean' },
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
    criadoEm: p.criadoEm,
    atualizadoEm: p.atualizadoEm,
  };
}

export function registrarRotasPagamentos(
  app: FastifyInstance,
  deps: { servico: ServicoDePagamento },
): void {
  const { servico } = deps;

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
      const pagamento = await servico.criar({
        provedor: corpo.provedor,
        valorCentavos: corpo.valorCentavos,
        moeda: corpo.moeda,
        tokenMetodo: corpo.tokenMetodo,
        descricao: corpo.descricao,
        capturaAutomatica: corpo.capturaAutomatica ?? false,
        chaveIdempotencia: chave,
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
}
