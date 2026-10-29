import 'dotenv/config';
import express from 'express';
import { createDatabasePool, verifyDatabase } from './server/database';
import { createHardwareAssetsApi } from './server/hardware-assets-api';
import { createInventoryApi } from './server/inventory-api';
import { createInventoryTransfersApi } from './server/inventory-transfers-api';
import { createTicketsApi } from './server/tickets-api';

const pool = createDatabasePool();
const app = express();
app.set('trust proxy', process.env['TRUST_PROXY'] === 'true' ? 1 : false);
app.use(express.json({ limit: '5mb' }));
app.use('/api', createInventoryApi(pool, process.env['SESSION_SECRET'] ?? ''));
app.use('/api', createInventoryTransfersApi(pool));
app.use('/api', createTicketsApi(pool));
app.use('/api', createHardwareAssetsApi(pool));

const port = Number(process.env['API_PORT'] ?? 4000);
verifyDatabase(pool)
  .then(() => {
    app.listen(port, () => {
      console.log(`API de Gestión IT disponible en http://localhost:${port}/api`);
    });
  })
  .catch((error: unknown) => {
    console.error('No se pudo conectar con PostgreSQL o falta aplicar la migración.', error);
    process.exitCode = 1;
  });
