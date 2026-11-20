import { montarApp } from './app.ts';
import { config } from './config.ts';
import { db } from './db/conexao.ts';

const app = montarApp();

// Desligamento limpo: a plataforma manda SIGTERM no deploy. Para de aceitar
// conexões, termina as requisições em andamento e fecha o pool do banco.
async function encerrar(sinal: string): Promise<void> {
  app.log.info({ sinal }, 'encerrando');
  try {
    await app.close();
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

app.listen({ port: config.porta, host: '0.0.0.0' }).catch((erro: unknown) => {
  app.log.error(erro);
  process.exit(1);
});
