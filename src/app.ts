import type { FastifyInstance } from 'fastify';
import { sql, type Kysely } from 'kysely';

import { config } from './config.ts';
import { db as dbPadrao } from './db/conexao.ts';
import type { BancoDeDados } from './db/esquema.ts';
import { ServicoDeReconciliacao } from './dominio/reconciliacao.ts';
import { RepositorioDePagamentos } from './dominio/repositorio.ts';
import { ServicoDePagamento } from './dominio/servico-pagamento.ts';
import { ServicoPix } from './pix/servico-pix.ts';
import { montarRegistro, type RegistroDeProvedores } from './provedores/registro.ts';
import { registrarRotasNotificacoes } from './rotas/notificacoes.ts';
import { registrarRotasPagamentos } from './rotas/pagamentos.ts';
import { registrarRotasPix } from './rotas/pix.ts';
import { registrarRotasWebhook, type LimiteDeTaxa } from './rotas/webhooks.ts';
import { exigirChaveDaApi } from './seguranca/autenticacao.ts';
import { criarServidor } from './servidor.ts';
import { ProcessadorDeWebhook } from './webhooks/processador.ts';

export interface Dependencias {
  db: Kysely<BancoDeDados>;
  registro: RegistroDeProvedores;
  // Chaves aceitas em `Authorization: Bearer`. Vazio = API aberta (só fora de
  // produção; o config barra no boot).
  chavesApi: readonly string[];
  // Segredo do PIX simulado. Ausente (produção) = rotas /pix/* não existem.
  segredoPixSimulado: string | undefined;
  limiteWebhooksPorMinuto: number;
  // Grava notificações para a loja a cada mudança de estado (outbox).
  notificarLoja: boolean;
}

// Monta o servidor com as dependências ligadas. Os testes injetam o que
// precisam; em produção usa os padrões do config.
export function montarApp(deps: Partial<Dependencias> = {}): FastifyInstance {
  const db = deps.db ?? dbPadrao;
  const registro = deps.registro ?? montarRegistro();
  const chavesApi = deps.chavesApi ?? config.chavesApi;
  const segredoPix =
    'segredoPixSimulado' in deps ? deps.segredoPixSimulado : config.fakeWebhookSecret;
  const limite: LimiteDeTaxa = {
    max: deps.limiteWebhooksPorMinuto ?? config.limiteWebhooksPorMinuto,
    timeWindow: '1 minute',
  };

  const notificarLoja = deps.notificarLoja ?? Boolean(config.lojaUrl && config.lojaWebhookSecret);
  const repo = new RepositorioDePagamentos(db, { notificarLoja });
  const servico = new ServicoDePagamento(db, repo, registro);
  const reconciliacao = new ServicoDeReconciliacao(repo, registro);
  const processador = new ProcessadorDeWebhook(db, repo, registro);

  const app = criarServidor({
    verificarBanco: async () => {
      await sql`select 1`.execute(db);
    },
  });
  exigirChaveDaApi(app, chavesApi);

  // As rotas entram num plugin, registrado depois do rate limit: assim o
  // plugin de limite já está carregado quando elas são declaradas.
  void app.register((rotas, _opcoes, done) => {
    registrarRotasPagamentos(rotas, { servico, reconciliacao });
    registrarRotasWebhook(rotas, { processador, limite });
    registrarRotasNotificacoes(rotas, { db });
    // PIX simulado (BR Code próprio + webhook HMAC de teste): só fora de produção.
    if (segredoPix) {
      registrarRotasPix(rotas, { pix: new ServicoPix(db, repo, segredoPix), limite });
    }
    done();
  });
  return app;
}
