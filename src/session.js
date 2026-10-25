'use strict';

/**
 * Sesión anónima firmada.
 *
 * El frontend viejo elegía su propio `userId` y lo mandaba en el body: eso
 * permitía (a) reclamar el Premium de otra persona y (b) "resetear" los límites
 * limpiando `localStorage`. Ahora el identificador lo emite el servidor, va en
 * una cookie HttpOnly firmada con HMAC y el cliente no puede fabricarlo ni
 * editarlo.
 */

const crypto = require('crypto');

const SID_PATTERN = /^[a-f0-9]{32}$/;

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

function createSessionToken(sid, secret, ttlMs) {
  const payload = base64url(JSON.stringify({ sid, exp: Date.now() + ttlMs }));
  return `${payload}.${sign(payload, secret)}`;
}

function readSessionToken(token, secret) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  if (!safeEqual(sign(payload, secret), signature)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.sid !== 'string' || !SID_PATTERN.test(data.sid)) return null;
  if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
  return { sid: data.sid, exp: data.exp };
}

function cookieOptions(config) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
  };
}

/**
 * Middleware: garantiza que cada visitante tenga una sesión válida.
 * Nunca confía en un identificador enviado por el cliente.
 */
function sessionMiddleware(config) {
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  return (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const existing = readSessionToken(cookies[config.sessionCookieName], config.sessionSecret);

    if (existing) {
      req.sessionId = existing.sid;
      req.isNewSession = false;
      return next();
    }

    const sid = crypto.randomBytes(16).toString('hex');
    req.sessionId = sid;
    req.isNewSession = true;
    res.cookie(config.sessionCookieName, createSessionToken(sid, config.sessionSecret, ttlMs), cookieOptions(config));
    next();
  };
}

module.exports = {
  sessionMiddleware,
  createSessionToken,
  readSessionToken,
  parseCookies,
  cookieOptions,
  SID_PATTERN,
};
