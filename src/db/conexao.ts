import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { config } from '../config.ts';
import type { BancoDeDados } from './esquema.ts';

// INT8 (bigint) volta como string por padrão no driver; aqui os valores cabem
// em number com folga, então parseamos para number.
pg.types.setTypeParser(pg.types.builtins.INT8, (valor) => Number(valor));

export function criarBanco(url: string = config.databaseUrl): Kysely<BancoDeDados> {
  return new Kysely<BancoDeDados>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url }) }),
  });
}

export const db = criarBanco();
