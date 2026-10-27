'use strict';

/**
 * Sesión anónima firmada y tokens firmados sin estado.
 *
 * El identificador de sesión lo emite el servidor en una cookie HttpOnly
 * firmada con HMAC (`instadown_sid`). También incluye la cuota diaria firmada
 * para mantener coherencia entre invocaciones serverless (Vercel), y provee
 * tokens firmados para artefactos remotos ligados a la sesión del dueño.
 */

const crypto = require('crypto');

const SID_PATTERN = /^[a-f0-9]{32}$/;
const ARTIFACT_PREFIX = 's1.';

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

function createSessionToken(sid, secret, ttlMs, quota = null, expOverride = null) {
  const exp = typeof expOverride === 'number' ? expOverride : Date.now() + ttlMs;
  const body = { sid, exp };
  if (quota && typeof quota.day === 'string' && Number.isFinite(quota.count) && quota.count > 0) {
    body.q = { d: quota.day, c: quota.count };
  }
  const payload = base64url(JSON.stringify(body));
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

  let quota = null;
  if (data.q && typeof data.q.d === 'string' && Number.isInteger(data.q.c) && data.q.c >= 0) {
    quota = { day: data.q.d, count: data.q.c };
  }

  return { sid: data.sid, exp: data.exp, quota };
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
 * Actualiza el contador diario dentro de la cookie firmada `instadown_sid`
 * sin cambiar el `sid` del usuario.
 */
function syncSessionQuotaCookie(req, res, config, usage) {
  if (!req.sessionId || !usage) return;
  const ttlMs = config.sessionTtlDays * 24 * 60 * 60 * 1000;
  const token = createSessionToken(
    req.sessionId,
    config.sessionSecret,
    ttlMs,
    { day: usage.day, count: usage.count },
    req.sessionExp || undefined,
  );
  res.cookie(config.sessionCookieName, token, cookieOptions(config));
}

/**
 * Crea un token firmado sin estado para servir un archivo remoto del CDN de
 * Instagram ligado a la sesión del usuario y con tiempo de expiración.
 */
function createArtifactToken({ sid, url, name, type = 'file', inline = false, exp }, secret) {
  const payload = base64url(
    JSON.stringify({
      sid,
      u: url,
      n: name,
      t: type,
      ...(inline ? { i: 1 } : {}),
      exp,
    }),
  );
  return `${ARTIFACT_PREFIX}${payload}.${sign(`artifact:${payload}`, secret)}`;
}

function readArtifactToken(token, secret) {
  if (typeof token !== 'string' || !token.startsWith(ARTIFACT_PREFIX)) return null;
  const rest = token.slice(ARTIFACT_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot === -1) return null;
  const payload = rest.slice(0, dot);
  const signature = rest.slice(dot + 1);
  if (!payload || !signature) return null;
  if (!safeEqual(sign(`artifact:${payload}`, secret), signature)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || typeof data.sid !== 'string' || !SID_PATTERN.test(data.sid)) return null;
  if (typeof data.u !== 'string' || !data.u) return null;
  if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;

  return {
    sid: data.sid,
    url: data.u,
    name: typeof data.n === 'string' && data.n ? data.n : 'download',
    type: typeof data.t === 'string' ? data.t : 'file',
    inline: data.i === 1,
    exp: data.exp,
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
      req.sessionExp = existing.exp;
      req.sessionQuota = existing.quota;
      req.isNewSession = false;
      return next();
    }

    const sid = crypto.randomBytes(16).toString('hex');
    const exp = Date.now() + ttlMs;
    req.sessionId = sid;
    req.sessionExp = exp;
    req.sessionQuota = null;
    req.isNewSession = true;
    res.cookie(config.sessionCookieName, createSessionToken(sid, config.sessionSecret, ttlMs, null, exp), cookieOptions(config));
    return next();
  };
}

module.exports = {
  sessionMiddleware,
  createSessionToken,
  readSessionToken,
  syncSessionQuotaCookie,
  createArtifactToken,
  readArtifactToken,
  parseCookies,
  cookieOptions,
  SID_PATTERN,
};
