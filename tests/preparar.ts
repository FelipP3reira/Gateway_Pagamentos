import { beforeAll } from 'vitest';

import { migrar } from '../src/db/migrar.ts';

// Garante o esquema no banco de teste antes de qualquer suíte rodar.
beforeAll(async () => {
  await migrar(process.env.DATABASE_URL);
});
