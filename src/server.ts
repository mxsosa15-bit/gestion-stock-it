import 'dotenv/config';
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import { join } from 'node:path';
import { createDatabasePool, verifyDatabase } from './server/database';
import { createInventoryApi } from './server/inventory-api';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
app.set('trust proxy', process.env['TRUST_PROXY'] === 'true' ? 1 : false);
const angularApp = new AngularNodeAppEngine();
const databasePool = createDatabasePool();
app.use(express.json({ limit: '5mb' }));
app.use(
  '/api',
  createInventoryApi(databasePool, process.env['SESSION_SECRET'] ?? ''),
);

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  verifyDatabase(databasePool)
    .then(() => {
      app.listen(port, (error) => {
        if (error) throw error;
        console.log(`Node Express server listening on http://localhost:${port}`);
      });
    })
    .catch((error: unknown) => {
      console.error('No se pudo conectar con PostgreSQL o falta aplicar la migración.', error);
      process.exitCode = 1;
    });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
