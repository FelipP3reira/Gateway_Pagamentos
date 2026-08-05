import { sql } from 'kysely';

import { criarBanco } from './conexao.ts';

// Migração de um arquivo só: CREATE TABLE IF NOT EXISTS na subida. Para este
// tamanho é mais honesto que uma ferramenta versionada — roda de novo sem
// quebrar e o esquema fica à vista.
export async function migrar(url?: string): Promise<void> {
  const db = criarBanco(url);
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS pagamentos (
        id BIGSERIAL PRIMARY KEY,
        provedor TEXT NOT NULL,
        referencia_externa TEXT,
        estado TEXT NOT NULL,
        valor_centavos BIGINT NOT NULL CHECK (valor_centavos > 0),
        moeda TEXT NOT NULL,
        chave_idempotencia TEXT NOT NULL,
        descricao TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(db);

    // Idempotência da criação: a mesma chave nunca gera dois pagamentos.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS ix_pagamentos_idempotencia
        ON pagamentos (chave_idempotencia)
    `.execute(db);

    await sql`
      CREATE TABLE IF NOT EXISTS transicoes (
        id BIGSERIAL PRIMARY KEY,
        pagamento_id BIGINT NOT NULL REFERENCES pagamentos (id) ON DELETE CASCADE,
        de_estado TEXT,
        para_estado TEXT NOT NULL,
        motivo TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(db);

    await sql`
      CREATE INDEX IF NOT EXISTS ix_transicoes_pagamento
        ON transicoes (pagamento_id, criado_em)
    `.execute(db);

    await sql`
      CREATE TABLE IF NOT EXISTS webhook_eventos (
        id BIGSERIAL PRIMARY KEY,
        provedor TEXT NOT NULL,
        evento_id TEXT NOT NULL,
        tipo TEXT NOT NULL,
        pagamento_id BIGINT REFERENCES pagamentos (id) ON DELETE SET NULL,
        recebido_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(db);

    // O que garante o processamento único do webhook: um evento por provedor.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS ix_webhook_eventos_unico
        ON webhook_eventos (provedor, evento_id)
    `.execute(db);

    await sql`
      CREATE TABLE IF NOT EXISTS estornos (
        id BIGSERIAL PRIMARY KEY,
        pagamento_id BIGINT NOT NULL REFERENCES pagamentos (id) ON DELETE CASCADE,
        valor_centavos BIGINT NOT NULL CHECK (valor_centavos > 0),
        referencia_externa TEXT,
        criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.execute(db);
  } finally {
    await db.destroy();
  }
}

// Permite rodar direto: `npm run migrar`.
const executadoDireto = process.argv[1]?.endsWith('migrar.ts');
if (executadoDireto) {
  migrar()
    .then(() => {
      console.log('Migração concluída.');
    })
    .catch((erro: unknown) => {
      console.error(erro);
      process.exit(1);
    });
}
