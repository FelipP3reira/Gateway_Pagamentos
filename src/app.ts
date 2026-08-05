import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';

import { db as dbPadrao } from './db/conexao.ts';
import type { BancoDeDados } from './db/esquema.ts';
import { ServicoDeReconciliacao } from './dominio/reconciliacao.ts';
import { RepositorioDePagamentos } from './dominio/repositorio.ts';
import { ServicoDePagamento } from './dominio/servico-pagamento.ts';
import { montarRegistro, type RegistroDeProvedores } from './provedores/registro.ts';
import { registrarRotasPagamentos } from './rotas/pagamentos.ts';
import { registrarRotasWebhook } from './rotas/webhooks.ts';
import { criarServidor } from './servidor.ts';
import { ProcessadorDeWebhook } from './webhooks/processador.ts';

export interface Dependencias {
  db: Kysely<BancoDeDados>;
  registro: RegistroDeProvedores;
}

// Monta o servidor com as dependências ligadas. Os testes injetam um db e um
// registro próprios; em produção usa os padrões.
export function montarApp(deps: Partial<Dependencias> = {}): FastifyInstance {
  const db = deps.db ?? dbPadrao;
  const registro = deps.registro ?? montarRegistro();
  const repo = new RepositorioDePagamentos(db);
  const servico = new ServicoDePagamento(db, repo, registro);
  const reconciliacao = new ServicoDeReconciliacao(repo, registro);
  const processador = new ProcessadorDeWebhook(db, repo, registro);

  const app = criarServidor();
  registrarRotasPagamentos(app, { servico, reconciliacao });
  registrarRotasWebhook(app, { processador });
  return app;
}
