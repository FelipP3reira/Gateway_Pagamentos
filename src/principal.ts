import { config } from './config.ts';
import { criarServidor } from './servidor.ts';

const app = criarServidor();

app.listen({ port: config.porta, host: '0.0.0.0' }).catch((erro: unknown) => {
  app.log.error(erro);
  process.exit(1);
});
