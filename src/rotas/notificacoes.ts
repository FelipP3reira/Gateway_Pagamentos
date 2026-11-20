import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import type { BancoDeDados } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';

/**
 * Operação das notificações para a loja (rotas autenticadas): ver o que falhou
 * e reenviar. O reenvio zera as tentativas para a notificação ter o ciclo de
 * backoff inteiro de novo; o histórico fica em tentativas_notificacao.
 */
export function registrarRotasNotificacoes(
  app: FastifyInstance,
  deps: { db: Kysely<BancoDeDados> },
): void {
  const { db } = deps;

  app.get<{ Querystring: { status?: 'pendente' | 'entregue' | 'falhou'; pagamentoId?: number } }>(
    '/notificacoes',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pendente', 'entregue', 'falhou'] },
            pagamentoId: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (requisicao) => {
      let consulta = db
        .selectFrom('notificacoes_loja')
        .select([
          'id',
          'pagamento_id as pagamentoId',
          'evento_id as eventoId',
          'sequencia',
          'estado',
          'status',
          'tentativas',
          'proxima_tentativa_em as proximaTentativaEm',
          'ultimo_erro as ultimoErro',
          'criada_em as criadaEm',
          'entregue_em as entregueEm',
        ])
        .orderBy('id', 'desc')
        .limit(100);
      if (requisicao.query.status) {
        consulta = consulta.where('status', '=', requisicao.query.status);
      }
      if (requisicao.query.pagamentoId) {
        consulta = consulta.where('pagamento_id', '=', requisicao.query.pagamentoId);
      }
      return { notificacoes: await consulta.execute() };
    },
  );

  app.post<{ Params: { id: string } }>('/notificacoes/:id/reenviar', async (requisicao) => {
    const id = Number(requisicao.params.id);
    const atualizada = await db
      .updateTable('notificacoes_loja')
      .set({ status: 'pendente', tentativas: 0, proxima_tentativa_em: new Date() })
      .where('id', '=', id)
      .where('status', '<>', 'entregue')
      .returning(['id', 'status'])
      .executeTakeFirst();
    if (!atualizada) {
      throw new ErroDeAplicacao(
        404,
        'nao_encontrado',
        'Notificação não encontrada ou já entregue.',
      );
    }
    return atualizada;
  });
}
