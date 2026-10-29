import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createDatabasePool } from '../server/database';

async function runMigration(): Promise<void> {
  let pool: ReturnType<typeof createDatabasePool> | undefined;

  try {
    pool = createDatabasePool();
    const migrationsDirectory = resolve(process.cwd(), 'database/migrations');
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => /^\d+.*\.sql$/.test(file))
      .sort();
    if (migrationFiles.length === 0) {
      throw new Error('No se encontraron archivos SQL de migración.');
    }

    for (const migrationFile of migrationFiles) {
      const migration = await readFile(resolve(migrationsDirectory, migrationFile), 'utf8');
      await pool.query(migration);
    }
    console.log(`Migraciones aplicadas correctamente: ${migrationFiles.join(', ')}`);
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
