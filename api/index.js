'use strict';

/**
 * Punto de entrada Serverless para Vercel (`@vercel/node`).
 *
 * Reutiliza la misma instancia de Express entre invocaciones en caliente y
 * normaliza la ruta reescrita desde `vercel.json` (`/api/*` y `/health`).
 */

const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

let appPromise = null;

function getApp() {
  if (!appPromise) {
    appPromise = createApp({ config: loadConfig() }).then(({ app }) => app);
  }
  return appPromise;
}

function normalizeVercelUrl(req) {
  if (!req || typeof req.url !== 'string') return;
  try {
    const parsed = new URL(req.url, 'http://localhost');
    const rewrittenPath = parsed.searchParams.get('__path');
    if (!rewrittenPath) return;

    parsed.searchParams.delete('__path');
    const qs = parsed.searchParams.toString();
    const isFunctionEntry =
      parsed.pathname === '/api' ||
      parsed.pathname === '/api/' ||
      parsed.pathname === '/api/index' ||
      parsed.pathname === '/api/index.js';

    const targetPath = isFunctionEntry
      ? rewrittenPath.startsWith('/')
        ? rewrittenPath
        : `/${rewrittenPath}`
      : parsed.pathname;

    req.url = `${targetPath}${qs ? `?${qs}` : ''}`;
  } catch {
    /* conservar req.url original */
  }
}

async function handler(req, res) {
  normalizeVercelUrl(req);
  const app = await getApp();
  return app(req, res);
}

// Desactiva el pre-parseo automático de Vercel para que el webhook de Stripe
// reciba el cuerpo crudo exacto y Express maneje JSON de forma uniforme.
handler.config = {
  api: {
    bodyParser: false,
  },
};

module.exports = handler;
