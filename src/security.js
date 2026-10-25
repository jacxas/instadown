'use strict';

/**
 * Middlewares de seguridad sin dependencias externas.
 *
 * Sustituyen al `app.use(cors())` anterior, que aceptaba peticiones de
 * cualquier origen y permitía que otro sitio usara la API (y el saldo de
 * descargas) en nombre del usuario.
 */

const crypto = require('crypto');

function securityHeaders(config) {
  // La CSP es estricta: sin 'unsafe-inline' para scripts, así que el HTML ya no
  // usa atributos onclick (se reemplazaron por listeners en app.js).
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com data:",
    "img-src 'self' data: https://*.cdninstagram.com https://*.fbcdn.net https://scontent.cdninstagram.com",
    "connect-src 'self'",
    "form-action 'self' https://checkout.stripe.com",
    // En producción nadie puede embeber el sitio. Fuera de producción se permite
    // porque el entorno de desarrollo lo muestra dentro de un iframe de preview.
    config.isProduction ? "frame-ancestors 'none'" : "frame-ancestors *",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (config.isProduction) res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    if (config.isProduction) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    res.removeHeader('X-Powered-By');
    next();
  };
}

/**
 * CORS: por defecto no se emite ninguna cabecera CORS (same-origin).
 * Si se necesita otro origen, debe listarse explícitamente en CORS_ORIGINS.
 */
function corsAllowlist(config, env = process.env) {
  const allowed = (env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return (req, res, next) => {
    const origin = req.headers.origin;
    res.vary('Origin');

    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    } else if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      // Bloquea escrituras cross-origin no autorizadas (CSRF por formulario).
      const sameOrigin = isSameOrigin(req, config);
      if (!sameOrigin) {
        return res.status(403).json({ success: false, error: 'Origen no permitido', code: 'bad_origin' });
      }
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(origin && allowed.includes(origin) ? 204 : 204);
    }
    return next();
  };
}

function isSameOrigin(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true; // clientes no-navegador (curl, tests)
  try {
    const originUrl = new URL(origin);
    const host = req.headers.host;
    if (host && originUrl.host === host) return true;
    return [config.appUrl, `http://localhost:${config.port}`, `http://127.0.0.1:${config.port}`]
      .filter(Boolean)
      .some((base) => {
        try {
          return new URL(base).host === originUrl.host;
        } catch {
          return false;
        }
      });
  } catch {
    return false;
  }
}

/** Limita peticiones por sesión (y por IP como respaldo). */
function rateLimit({ windowMs, max, keyFn }) {
  const hits = new Map();

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, Math.max(windowMs, 30_000));
  if (typeof timer.unref === 'function') timer.unref();

  const middleware = (req, res, next) => {
    const key = keyFn ? keyFn(req) : req.sessionId || req.ip;
    const now = Date.now();
    let entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }

    entry.count += 1;
    const remaining = Math.max(0, max - entry.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({
        success: false,
        error: 'Demasiadas peticiones. Esperá un momento.',
        code: 'rate_limited',
      });
    }
    return next();
  };

  middleware.reset = () => hits.clear();
  return middleware;
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { securityHeaders, corsAllowlist, rateLimit, isSameOrigin, constantTimeEquals };
