import type { Kysely } from 'kysely';

import type { BancoDeDados } from '../src/db/esquema.ts';

// Zera as tabelas na ordem certa (as FKs cascateiam a partir de pagamentos)
// para cada teste partir de um estado conhecido.
export async function limparBanco(db: Kysely<BancoDeDados>): Promise<void> {
  await db.deleteFrom('webhook_eventos').execute();
  await db.deleteFrom('pagamentos').execute();
}
