'use strict';

/**
 * Construcción de la app Express (sin `listen`), para poder testearla y
 * reutilizarla tanto en `server.js` como en funciones serverless (`api/index.js`).
 */

const express = require('express');
const path = require('path');

const { loadConfig } = require('./config');
const { JsonStore } = require('./store');
const { createPaymentProvider } = require('./payments');
const { sessionMiddleware } = require('./session');
const { securityHeaders, corsAllowlist } = require('./security');
const { buildApiRouter, createWebhookHandler } = require('./routes');
const { installCleanup } = require('./cleanup');

async function createApp({ config = loadConfig(), logger = console } = {}) {
  const store = new JsonStore({ file: path.join(config.dataDir, 'store.json') });
  await store.load();

  const payments = createPaymentProvider(config, { logger });

  if (payments.name === 'disabled') {
    logger.warn?.('[payments] proveedor deshabilitado: Premium no se puede comprar (fail-closed)');
  }
  if (payments.name === 'stripe' && !payments.canReceiveWebhooks()) {
    logger.warn?.('[payments] falta STRIPE_WEBHOOK_SECRET: los webhooks se rechazarán y Premium no se activará');
  }
  if (config.ephemeralSecret) {
    logger.warn?.(
      '[session] SESSION_SECRET no definido explícitamente: se usa secreto de respaldo (definí SESSION_SECRET en producción)',
    );
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Vercel/Render/Railway/Heroku pasan el cliente real en X-Forwarded-*

  app.use(securityHeaders(config));
  app.use(corsAllowlist(config));

  // El webhook va antes de express.json(): la firma se calcula sobre el cuerpo
  // crudo y volver a serializarlo produciría un hash distinto.
  app.post('/api/billing/webhook', createWebhookHandler({ config, store, payments, logger }));

  // Compatibilidad serverless (p. ej. @vercel/node): si el runtime ya parseó
  // req.body y consumió el stream, evitamos que body-parser lo sobrescriba con {}.
  app.use((req, res, next) => {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      req._body = true;
    } else if (typeof req.body === 'string' && req.body.length > 0) {
      try {
        req.body = JSON.parse(req.body);
        req._body = true;
      } catch {
        /* dejar que express.json() emita el 400 habitual */
      }
    }
    next();
  });

  app.use(express.json({ limit: '64kb' }));
  app.use(sessionMiddleware(config));

  app.use(
    express.static(config.publicDir, {
      index: 'index.html',
      dotfiles: 'deny',
      fallthrough: true,
      setHeaders(res, filePath) {
        // CSS/JS propios: no se cachean agresivamente para evitar versiones viejas.
        if (/\.(css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
        if (/\.html$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      payments: {
        provider: payments.name,
        checkoutEnabled: payments.isConfigured() && payments.name !== 'disabled',
        webhooksVerified: payments.canReceiveWebhooks() && payments.name !== 'mock',
      },
    });
  });

  app.use('/api', buildApiRouter({ config, store, payments, logger }));

  // Nada fuera de /public se sirve; el resto es 404 (antes se exponía server.js).
  app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ success: false, error: 'Endpoint no encontrado', code: 'not_found' });
    }
    return res.status(404).type('text/plain; charset=utf-8').send('No encontrado');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error?.(`[error] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    if (res.headersSent) return;
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({
      success: false,
      // Nunca se expone err.message en 500: puede filtrar rutas o detalles internos.
      error: status === 500 ? 'Error interno del servidor' : err.message,
      code: err.code || 'internal_error',
    });
  });

  if (!config.isServerless) {
    installCleanup({ config, store, logger });
  }

  return { app, store, payments, config };
}

module.exports = { createApp };
