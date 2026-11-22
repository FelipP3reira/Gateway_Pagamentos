import type { FastifyInstance } from 'fastify';

import type { Provedor } from '../db/esquema.ts';
import { ErroDeAplicacao } from '../erros.ts';
import type { ProcessadorDeWebhook } from '../webhooks/processador.ts';

const PROVEDORES: Provedor[] = ['stripe', 'fake', 'mercadopago'];

// Cada provedor manda a assinatura no seu próprio cabeçalho. (O PIX tem rota
// própria em /webhooks/pix; entra aqui só para o tipo ficar completo.)
const CABECALHO_ASSINATURA: Record<Provedor, string> = {
  stripe: 'stripe-signature',
  fake: 'x-assinatura',
  pix: 'x-assinatura',
  mercadopago: 'x-signature',
};

// Limite por IP aplicado às rotas públicas de webhook (@fastify/rate-limit).
export interface LimiteDeTaxa {
  max: number;
  timeWindow: string;
}

function cabecalho(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

export function registrarRotasWebhook(
  app: FastifyInstance,
  deps: { processador: ProcessadorDeWebhook; limite: LimiteDeTaxa },
): void {
  app.post<{ Params: { provedor: string } }>(
    '/webhooks/:provedor',
    { config: { rateLimit: deps.limite } },
    async (requisicao, resposta) => {
      const nome = requisicao.params.provedor;
      if (!PROVEDORES.includes(nome as Provedor)) {
        throw new ErroDeAplicacao(
          404,
          'provedor_desconhecido',
          'Provedor de webhook desconhecido.',
        );
      }
      const provedor = nome as Provedor;

      const corpoCru = requisicao.corpoCru;
      if (!corpoCru || corpoCru.length === 0) {
        throw new ErroDeAplicacao(400, 'corpo_vazio', 'Webhook sem corpo.');
      }

      const assinatura = cabecalho(requisicao.headers[CABECALHO_ASSINATURA[provedor]]);
      // Cabeçalhos e query crus: o Mercado Pago assina data.id (query) e o
      // x-request-id, além do timestamp.
      const cabecalhos: Record<string, string | undefined> = {};
      for (const [nome, valor] of Object.entries(requisicao.headers)) {
        cabecalhos[nome] = cabecalho(valor);
      }
      const query: Record<string, string | undefined> = {};
      for (const [nome, valor] of Object.entries(
        (requisicao.query ?? {}) as Record<string, string | string[] | undefined>,
      )) {
        query[nome] = cabecalho(valor);
      }
      const resultado = await deps.processador.processar(provedor, corpoCru, assinatura, {
        cabecalhos,
        query,
      });

      // 200 mesmo em duplicado: o provedor não deve re-tentar um evento já visto.
      return resposta.status(200).send({ recebido: true, processado: resultado.processado });
    },
  );
}
