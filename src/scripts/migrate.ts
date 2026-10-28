import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabasePool } from '../server/database';

async function runMigration(): Promise<void> {
  let pool: ReturnType<typeof createDatabasePool> | undefined;

  try {
    pool = createDatabasePool();
    const migration = await readFile(
      resolve(process.cwd(), 'database/migrations/001-initial.sql'),
      'utf8',
    );
    await pool.query(migration);
    console.log('Migración inicial aplicada correctamente.');
  } catch (error: unknown) {
    console.error('No se pudo aplicar la migración de Gestión IT.', error);
    process.exitCode = 1;
  } finally {
    if (pool) {
      await pool.end();
    }
  }
}

void runMigration();
