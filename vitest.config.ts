import { defineConfig } from 'vitest/config';

// O env vai aqui, aplicado antes de qualquer módulo carregar — senão o
// config.ts estoura no import por falta de DATABASE_URL. Os testes rodam contra
// o banco pagamentos_teste, nunca o de desenvolvimento.
export default defineConfig({
  test: {
    env: {
      AMBIENTE: 'teste',
      DATABASE_URL: 'postgres://pagamentos:pagamentos@localhost:5440/pagamentos_teste',
      FAKE_WEBHOOK_SECRET: 'segredo-fake-teste',
    },
    // O estado no Postgres é compartilhado; rodar os arquivos em série evita
    // corrida entre suítes.
    fileParallelism: false,
    setupFiles: ['tests/preparar.ts'],
  },
});
