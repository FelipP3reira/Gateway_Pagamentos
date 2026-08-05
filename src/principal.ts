import { montarApp } from './app.ts';
import { config } from './config.ts';

const app = montarApp();

app.listen({ port: config.porta, host: '0.0.0.0' }).catch((erro: unknown) => {
  app.log.error(erro);
  process.exit(1);
});
