'use strict';

/**
 * Configuración central. Todo se lee del entorno y se normaliza una sola vez,
 * para que el resto del código no dependa de `process.env` disperso.
 */

const path = require('path');
const crypto = require('crypto');

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const ROOT = path.join(__dirname, '..');

/**
 * La pasarela se elige explícitamente. Si no hay ninguna configurada, el
 * sistema queda en modo `disabled`: NO se puede activar Premium (fail-closed).
 * Antes existía un endpoint que regalaba Premium; ese comportamiento se eliminó.
 */
function resolvePaymentsProvider(env) {
  const explicit = (env.PAYMENTS_PROVIDER || '').trim().toLowerCase();
  const isProd = env.NODE_ENV === 'production';

  if (explicit === 'mock') {
    // El modo simulado es solo para desarrollo local y debe pedirse a propósito.
    if (isProd) return 'disabled';
    return 'mock';
  }
  if (explicit === 'stripe') return 'stripe';
  if (explicit === 'disabled') return 'disabled';
  return env.STRIPE_SECRET_KEY ? 'stripe' : 'disabled';
}

function loadConfig(env = process.env) {
  const port = int(env.PORT, 3000);
  const appUrl = (env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');

  let sessionSecret = env.SESSION_SECRET || '';
  let ephemeralSecret = false;
  if (!sessionSecret) {
    // Sin secreto estable las sesiones se invalidan al reiniciar. Aceptable en
    // desarrollo, pero en producción se exige uno explícito.
    sessionSecret = crypto.randomBytes(32).toString('hex');
    ephemeralSecret = true;
  }
  if (env.NODE_ENV === 'production' && ephemeralSecret) {
    throw new Error('SESSION_SECRET es obligatorio en producción');
  }

  const paymentsProvider = resolvePaymentsProvider(env);

  return {
    env: env.NODE_ENV || 'development',
    isProduction: env.NODE_ENV === 'production',
    port,
    appUrl,
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    dataDir: env.DATA_DIR || path.join(ROOT, 'data'),
    downloadsDir: env.DOWNLOADS_DIR || path.join(ROOT, 'downloads'),
    sessionSecret,
    ephemeralSecret,
    // Identificador de la cookie de sesión anónima (el usuario no se registra).
    sessionCookieName: 'instadown_sid',
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 180),
    freeDailyLimit: int(env.FREE_DAILY_LIMIT, 2),
    adminToken: env.ADMIN_TOKEN || '',
    instagram: {
      username: env.INSTAGRAM_USERNAME || '',
      password: env.INSTAGRAM_PASSWORD || '',
      // Corta el proceso de Python si Instagram no responde.
      timeoutMs: int(env.INSTAGRAM_TIMEOUT_MS, 90_000),
    },
    payments: {
      provider: paymentsProvider,
      // Precio en centavos (Stripe exige mínimo 50 = $0.50 USD).
      priceCents: int(env.PREMIUM_PRICE_CENTS, 100),
      currency: (env.PREMIUM_PRICE_CURRENCY || 'usd').toLowerCase(),
      productName: env.PREMIUM_PRODUCT_NAME || 'InstaDown Premium',
      stripe: {
        secretKey: env.STRIPE_SECRET_KEY || '',
        webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
        // Si se define, se usa un Price ya creado en el dashboard.
        priceId: env.STRIPE_PRICE_ID || '',
        apiBase: env.STRIPE_API_BASE || 'https://api.stripe.com',
      },
      // Tolerancia para la firma de los webhooks (segundos).
      webhookToleranceSec: int(env.WEBHOOK_TOLERANCE_SEC, 300),
    },
    rateLimits: {
      download: { windowMs: 60_000, max: int(env.RATE_DOWNLOAD_PER_MIN, 20) },
      checkout: { windowMs: 10 * 60_000, max: int(env.RATE_CHECKOUT_PER_10MIN, 5) },
    },
    // Los archivos descargados se borran del listado tras este tiempo.
    artifactTtlMs: int(env.ARTIFACT_TTL_MINUTES, 30) * 60_000,
  };
}

module.exports = { loadConfig, bool, int, ROOT };
