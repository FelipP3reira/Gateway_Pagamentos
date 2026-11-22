import { montarApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db/conexao.ts';
import { EntregadorDeNotificacoes } from './notificacoes/entregador.ts';

const app = montarApp();

// Entrega das notificações para a loja, no próprio processo (o serviço fica
// sempre ligado). Sem LOJA_URL (desenvolvimento), não roda.
const entregador =
  config.lojaUrl && config.lojaWebhookSecret
    ? new EntregadorDeNotificacoes(db, {
        urlLoja: config.lojaUrl,
        segredo: config.lojaWebhookSecret,
        aoErro: (erro) => app.log.error({ err: erro }, 'entregador de notificações'),
      })
    : undefined;

// Desligamento limpo: a plataforma manda SIGTERM no deploy. Para de aceitar
// conexões, termina as requisições em andamento e fecha o pool do banco.
async function encerrar(sinal: string): Promise<void> {
  app.log.info({ sinal }, 'encerrando');
  try {
    await app.close();
    await entregador?.parar();
    await db.destroy();
    process.exit(0);
  } catch (erro) {
    app.log.error(erro);
    process.exit(1);
  }
}

for (const sinal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sinal, () => void encerrar(sinal));
}

app
  .listen({ port: config.porta, host: '0.0.0.0' })
  .then(() => {
    if (entregador) {
      entregador.iniciar();
    } else {
      app.log.warn('LOJA_URL ausente: notificações para a loja desligadas.');
    }
  })
  .catch((erro: unknown) => {
    app.log.error(erro);
    process.exit(1);
  });
