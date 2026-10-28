import { Pool } from 'pg';

export function createDatabasePool(): Pool {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    throw new Error('DATABASE_URL no está configurada.');
  }

  return new Pool({
    connectionString,
    max: Number(process.env['PG_POOL_MAX'] ?? 10),
    ssl: process.env['PG_SSL'] === 'true' ? { rejectUnauthorized: true } : undefined,
  });
}

export async function verifyDatabase(pool: Pool): Promise<void> {
  await pool.query('SELECT 1 FROM gestion_it.inventory_snapshot WHERE singleton_id = true');
}
