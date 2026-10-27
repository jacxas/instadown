'use strict';

/**
 * API HTTP de InstaDown.
 *
 * Principio general: el cliente no decide nada sobre su plan ni sobre su cuota.
 * Todo lo que el navegador puede hacer es pedir una acción; el servidor valida
 * sesión, plan, cuota y entradas.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const express = require('express');

const { runInstagramAction, InstagramError } = require('./instagram');
const {
  classifyInstagramInput,
  normalizeInstagramUrl,
  isAllowedInstagramCdnUrl,
} = require('./instagram-native');
const {
  isPremium,
  ensureUsageDay,
  canDownload,
  consumeDownload,
  publicUser,
} = require('./entitlements');
const {
  syncSessionQuotaCookie,
  createArtifactToken,
  readArtifactToken,
} = require('./session');
const { applyPaymentEvent, subscriptionSummary } = require('./payments/apply-event');
const { PaymentUnavailableError } = require('./payments');
const { rateLimit, constantTimeEquals } = require('./security');
const { todayKey } = require('./store');

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const MAX_URL_LENGTH = 500;
const SAFE_MEDIA_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'application/octet-stream',
]);

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function fail(res, status, error, code, extra = {}) {
  return res.status(status).json({ success: false, error, code, ...extra });
}

function isInstagramUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    return (
      host === 'instagram.com' ||
      host.endsWith('.instagram.com') ||
      host === 'instagr.am' ||
      host.endsWith('.instagr.am')
    );
  } catch {
    return false;
  }
}

function parseUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@/, '');
  return USERNAME_RE.test(username) ? username : null;
}

/**
 * Acepta tanto `@usuario` como enlaces de perfil o historias de Instagram
 * (`https://www.instagram.com/usuario/`). Mantiene `parseUsername` estricto.
 */
function parseUsernameOrProfileUrl(value) {
  const direct = parseUsername(value);
  if (direct) return direct;
  const classified = classifyInstagramInput(value);
  if (classified.kind === 'username' || classified.kind === 'stories') {
    return classified.username;
  }
  return null;
}

function sanitizeFilename(name, fallback = 'instadown_media') {
  const cleaned = String(name || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

function formatPrice({ priceCents, currency }) {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(priceCents / 100);
  } catch {
    return `${(priceCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

/**
 * Convierte los elementos devueltos por el descargador (archivos locales en disco
 * o URLs remotas verificadas del CDN de Instagram) en artefactos con token ligados
 * a la sesión del usuario y con expiración.
 */
function registerArtifacts(store, config, userId, outDir, items) {
  const now = Date.now();
  const expiresAt = now + config.artifactTtlMs;

  return store.upsertUser(userId, (user) => {
    user.artifacts = (user.artifacts || []).filter((a) => a.expiresAt > now);
    return items.map((item, idx) => {
      if (item.remoteUrl) {
        if (!isAllowedInstagramCdnUrl(item.remoteUrl)) {
          throw new Error('URL de medio fuera del CDN permitido');
        }
        const defaultExt = item.type === 'video' ? 'mp4' : 'jpg';
        const name = sanitizeFilename(
          item.name || `instadown_${String(idx + 1).padStart(2, '0')}.${defaultExt}`,
        );
        const token = createArtifactToken(
          {
            sid: userId,
            url: item.remoteUrl,
            name,
            type: item.type || 'file',
            inline: false,
            exp: expiresAt,
          },
          config.sessionSecret,
        );
        return {
          token,
          remoteUrl: item.remoteUrl,
          type: item.type || 'file',
          highlight: item.highlight || null,
          name,
          expiresAt,
        };
      }

      const absolute = path.resolve(item.file);
      const root = path.resolve(outDir);
      // Defensa en profundidad: nunca se sirve un archivo fuera del directorio.
      if (!absolute.startsWith(root + path.sep)) {
        throw new Error('Ruta de descarga fuera del directorio permitido');
      }
      const token = crypto.randomBytes(24).toString('base64url');
      const record = {
        token,
        path: absolute,
        type: item.type || 'file',
        highlight: item.highlight || null,
        name: sanitizeFilename(path.basename(absolute)),
        expiresAt,
      };
      user.artifacts.push(record);
      return record;
    });
  });
}

function publicArtifact(record) {
  return {
    token: record.token,
    url: `/api/files/${record.token}`,
    type: record.type,
    name: record.name,
    highlight: record.highlight,
    expiresAt: new Date(record.expiresAt).toISOString(),
  };
}

function safeMediaContentType(rawHeader, itemType) {
  const base = String(rawHeader || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (SAFE_MEDIA_MIMES.has(base)) return base;
  if (itemType === 'video') return 'video/mp4';
  if (itemType === 'photo') return 'image/jpeg';
  return 'application/octet-stream';
}

function attachAvatarProxy(profile, sessionId, config) {
  if (!profile || !isAllowedInstagramCdnUrl(profile.profile_pic_url)) {
    return profile;
  }
  const avatarToken = createArtifactToken(
    {
      sid: sessionId,
      url: profile.profile_pic_url,
      name: sanitizeFilename(`${profile.username || 'avatar'}.jpg`),
      type: 'photo',
      inline: true,
      exp: Date.now() + config.artifactTtlMs,
    },
    config.sessionSecret,
  );
  return {
    ...profile,
    avatar_url: `/api/files/${avatarToken}`,
  };
}

function buildApiRouter({ config, store, payments, logger = console }) {
  const router = express.Router();

  const downloadLimiter = rateLimit({ ...config.rateLimits.download });
  const checkoutLimiter = rateLimit({ ...config.rateLimits.checkout });

  const loadUser = (req, res, next) => {
    req.user = store.upsertUser(req.sessionId, (user) => {
      // Sincroniza la cuota diaria firmada en cookie (útil cuando una función
      // serverless arranca en una nueva instancia con /tmp vacío).
      const today = todayKey();
      const usage = ensureUsageDay(user);
      if (
        req.sessionQuota &&
        req.sessionQuota.day === today &&
        req.sessionQuota.count > usage.count
      ) {
        user.usage = { day: today, count: req.sessionQuota.count };
      }
      return user;
    });
    next();
  };

  // ---------------------------------------------------------------------------
  // Configuración pública (el frontend arma la UI con esto, no con constantes)
  // ---------------------------------------------------------------------------
  router.get('/config', (req, res) => {
    res.json({
      success: true,
      data: {
        paymentsEnabled: payments.isConfigured() && !(payments.name === 'mock' && config.isProduction),
        provider: payments.name,
        mockMode: payments.name === 'mock',
        price: {
          amountCents: config.payments.priceCents,
          currency: config.payments.currency,
          display: formatPrice(config.payments),
          period: 'mes',
        },
        dailyLimit: config.freeDailyLimit,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Usuario / plan
  // ---------------------------------------------------------------------------
  router.get('/me', loadUser, (req, res) => {
    res.json({
      success: true,
      data: { ...publicUser(req.user, config), ...subscriptionSummary(req.user) },
    });
  });

  // ---------------------------------------------------------------------------
  // Descargas
  // ---------------------------------------------------------------------------
  function quotaGuard(req, res, next) {
    if (!canDownload(req.user, config)) {
      return fail(
        res,
        403,
        'Alcanzaste el límite gratuito de hoy. Pasate a Premium para descargas ilimitadas.',
        'quota_exceeded',
        {
          requiresPremium: true,
          remainingDownloads: 0,
        },
      );
    }
    return next();
  }

  async function performDownload(req, res, { action, argument, kind }) {
    const outDir = path.join(config.downloadsDir, crypto.randomUUID());

    let data;
    try {
      data = await runInstagramAction(action, argument, { config, outDir, logger });
    } catch (err) {
      // No se consume cuota si la descarga no se completó.
      if (err instanceof InstagramError) {
        return fail(res, err.status, err.message, err.code, { retryable: err.retryable });
      }
      throw err;
    }

    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) {
      return fail(res, 422, 'No se encontró contenido descargable', 'empty_result');
    }

    const records = registerArtifacts(store, config, req.sessionId, outDir, items);
    store.upsertUser(req.sessionId, (user) => {
      user.lastAction = { kind, at: new Date().toISOString() };
    });

    let remaining = null;
    if (!isPremium(req.user)) {
      remaining = store.upsertUser(req.sessionId, (user) => {
        const rem = consumeDownload(user, config);
        syncSessionQuotaCookie(req, res, config, user.usage);
        return rem;
      });
    }

    return res.json({
      success: true,
      data: {
        kind,
        ...(data.type ? { type: data.type } : {}),
        ...(data.caption !== undefined
          ? { caption: data.caption, likes: data.likes, comments: data.comments }
          : {}),
        ...(data.username ? { username: data.username } : {}),
        files: records.map(publicArtifact),
      },
      remainingDownloads: remaining,
      premium: isPremium(req.user),
    });
  }

  router.post(
    '/download/post',
    downloadLimiter,
    loadUser,
    quotaGuard,
    asyncHandler(async (req, res) => {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      const normalized = normalizeInstagramUrl(rawUrl);
      const candidate = normalized ? normalized.href : rawUrl;
      if (!isInstagramUrl(candidate)) {
        return fail(res, 400, 'URL inválida: debe ser un enlace de instagram.com', 'invalid_url');
      }
      return performDownload(req, res, { action: 'download_post', argument: candidate, kind: 'post' });
    }),
  );

  router.post(
    '/download/profile-pic',
    downloadLimiter,
    loadUser,
    quotaGuard,
    asyncHandler(async (req, res) => {
      const username = parseUsernameOrProfileUrl(req.body?.username);
      if (!username) return fail(res, 400, 'Usuario inválido', 'invalid_username');
      return performDownload(req, res, {
        action: 'download_profile_pic',
        argument: username,
        kind: 'profile-pic',
      });
    }),
  );

  router.post(
    '/download/stories',
    downloadLimiter,
    loadUser,
    quotaGuard,
    asyncHandler(async (req, res) => {
      const username = parseUsernameOrProfileUrl(req.body?.username);
      if (!username) return fail(res, 400, 'Usuario inválido', 'invalid_username');
      return performDownload(req, res, {
        action: 'download_stories',
        argument: username,
        kind: 'stories',
      });
    }),
  );

  router.post(
    '/download/highlights',
    downloadLimiter,
    loadUser,
    quotaGuard,
    asyncHandler(async (req, res) => {
      const username = parseUsernameOrProfileUrl(req.body?.username);
      if (!username) return fail(res, 400, 'Usuario inválido', 'invalid_username');
      return performDownload(req, res, {
        action: 'download_highlights',
        argument: username,
        kind: 'highlights',
      });
    }),
  );

  // Información de perfil: es solo metadata, no consume cuota.
  async function handleUserInfo(req, res, rawInput) {
    const username = parseUsernameOrProfileUrl(rawInput);
    if (!username) return fail(res, 400, 'Usuario inválido', 'invalid_username');
    try {
      const data = await runInstagramAction('get_user_info', username, {
        config,
        outDir: path.join(config.downloadsDir, crypto.randomUUID()),
        logger,
      });
      return res.json({
        success: true,
        data: attachAvatarProxy(data, req.sessionId, config),
      });
    } catch (err) {
      if (err instanceof InstagramError) {
        return fail(res, err.status, err.message, err.code, { retryable: err.retryable });
      }
      throw err;
    }
  }

  router.get(
    '/user/:username',
    downloadLimiter,
    loadUser,
    asyncHandler(async (req, res) => handleUserInfo(req, res, req.params.username)),
  );

  router.post(
    '/user',
    downloadLimiter,
    loadUser,
    asyncHandler(async (req, res) => handleUserInfo(req, res, req.body?.username)),
  );

  // ---------------------------------------------------------------------------
  // Archivos descargados (privados, con token y expiración)
  // ---------------------------------------------------------------------------
  router.get(
    '/files/:token',
    loadUser,
    asyncHandler(async (req, res) => {
      const rawToken = String(req.params.token || '');

      // 1) Token firmado sin estado (artefactos remotos del CDN de Instagram)
      if (rawToken.startsWith('s1.')) {
        const parsed = readArtifactToken(rawToken, config.sessionSecret);
        if (!parsed || !constantTimeEquals(parsed.sid, req.sessionId)) {
          return fail(res, 404, 'Archivo no encontrado o expirado', 'file_not_found');
        }
        if (!isAllowedInstagramCdnUrl(parsed.url)) {
          return fail(res, 403, 'Acceso denegado', 'forbidden');
        }

        const fetchImpl = config.instagram?.fetchImpl || fetch;
        const upstreamHeaders = {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: '*/*',
        };
        if (req.headers.range) {
          upstreamHeaders.Range = req.headers.range;
        }

        let upstream;
        try {
          upstream = await fetchImpl(parsed.url, { method: 'GET', headers: upstreamHeaders });
        } catch (err) {
          logger.error?.(`[files] error conectando al CDN: ${err.message}`);
          return fail(res, 502, 'No se pudo obtener el archivo desde Instagram', 'cdn_unreachable');
        }

        if (!upstream.ok && upstream.status !== 206) {
          return fail(res, 410, 'El enlace del archivo en Instagram expiró. Volvé a descargarlo.', 'file_gone');
        }

        const safeName = sanitizeFilename(parsed.name);
        const disposition = parsed.inline && parsed.type === 'photo' ? 'inline' : 'attachment';
        const contentType = safeMediaContentType(upstream.headers.get('content-type'), parsed.type);

        res.status(upstream.status === 206 ? 206 : 200);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        const contentLength = upstream.headers.get('content-length');
        if (contentLength) res.setHeader('Content-Length', contentLength);
        const contentRange = upstream.headers.get('content-range');
        if (contentRange) res.setHeader('Content-Range', contentRange);

        if (!upstream.body) {
          const buf = Buffer.from(await upstream.arrayBuffer());
          return res.end(buf);
        }

        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.on('error', (err) => {
          logger.error?.(`[files] stream interrumpido: ${err.message}`);
          if (!res.headersSent) {
            fail(res, 502, 'Descarga interrumpida', 'stream_error');
          } else {
            res.destroy();
          }
        });
        req.on('close', () => {
          if (!res.writableEnded) nodeStream.destroy();
        });
        return nodeStream.pipe(res);
      }

      // 2) Artefactos locales en disco
      const now = Date.now();
      const artifacts = (req.user.artifacts || []).filter((a) => a.expiresAt > now);
      const record = artifacts.find((a) => a.path && constantTimeEquals(a.token, rawToken));

      if (!record) {
        return fail(res, 404, 'Archivo no encontrado o expirado', 'file_not_found');
      }
      const absolute = path.resolve(record.path);
      if (!absolute.startsWith(path.resolve(config.downloadsDir) + path.sep)) {
        logger.error(`[files] intento de acceso fuera del directorio: ${absolute}`);
        return fail(res, 403, 'Acceso denegado', 'forbidden');
      }
      if (!fs.existsSync(absolute)) {
        return fail(res, 410, 'El archivo ya no está disponible en el servidor', 'file_gone');
      }

      res.setHeader('Cache-Control', 'private, no-store');
      return res.download(absolute, record.name, (err) => {
        if (err && !res.headersSent) {
          logger.error(`[files] error al enviar: ${err.message}`);
          fail(res, 500, 'No se pudo enviar el archivo', 'send_failed');
        }
      });
    }),
  );

  // ---------------------------------------------------------------------------
  // Pagos
  // ---------------------------------------------------------------------------
  router.post(
    '/billing/checkout',
    checkoutLimiter,
    loadUser,
    asyncHandler(async (req, res) => {
      const current = subscriptionSummary(req.user);
      if (current.premium) {
        return fail(res, 409, 'Ya tenés una suscripción Premium activa', 'already_premium');
      }

      const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 254) : null;
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
        return fail(res, 400, 'Email inválido', 'invalid_email');
      }

      try {
        const session = await payments.createCheckoutSession({ userId: req.sessionId, email });
        return res.json({ success: true, data: { url: session.url, sessionId: session.sessionId } });
      } catch (err) {
        if (err instanceof PaymentUnavailableError) {
          logger.warn(`[billing] checkout no disponible: ${err.message}`);
          return fail(res, err.status, err.message, err.code);
        }
        logger.error(`[billing] error creando checkout: ${err.message}`);
        return fail(
          res,
          502,
          'No se pudo iniciar el pago. Intentá de nuevo en unos minutos.',
          'checkout_failed',
        );
      }
    }),
  );

  router.post(
    '/billing/portal',
    checkoutLimiter,
    loadUser,
    asyncHandler(async (req, res) => {
      const customerId = req.user?.premium?.customerId;
      if (!customerId) {
        return fail(res, 409, 'No hay una suscripción que administrar', 'no_subscription');
      }
      if (typeof payments.createPortalSession !== 'function') {
        return fail(res, 501, 'Gestión de suscripción no disponible', 'portal_unavailable');
      }
      try {
        const session = await payments.createPortalSession({ customerId });
        return res.json({ success: true, data: { url: session.url } });
      } catch (err) {
        logger.error(`[billing] error creando portal: ${err.message}`);
        return fail(res, 502, 'No se pudo abrir la gestión de la suscripción', 'portal_failed');
      }
    }),
  );

  // Checkout simulado: solo existe en desarrollo y con PAYMENTS_PROVIDER=mock.
  router.get('/billing/mock/complete', loadUser, (req, res) => {
    if (config.isProduction || payments.name !== 'mock') {
      return fail(res, 404, 'No encontrado', 'not_found');
    }
    const entry = payments.consume(String(req.query.token || ''));
    if (!entry) return fail(res, 400, 'Token de pago simulado inválido o expirado', 'invalid_token');

    applyPaymentEvent(
      store,
      {
        type: 'subscription.activated',
        userId: entry.userId,
        subscription: {
          provider: 'mock',
          providerSubscriptionId: `mock_sub_${crypto.randomBytes(6).toString('hex')}`,
          customerId: `mock_cus_${crypto.randomBytes(6).toString('hex')}`,
          status: 'active',
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          plan: 'monthly',
        },
      },
      { logger },
    );
    return res.redirect(303, '/?checkout=success');
  });

  // ---------------------------------------------------------------------------
  // Administración (solo si ADMIN_TOKEN está definido)
  // ---------------------------------------------------------------------------
  router.post('/admin/grant', loadUser, (req, res) => {
    if (!config.adminToken) return fail(res, 404, 'No encontrado', 'not_found');
    const provided = req.headers['x-admin-token'];
    if (!constantTimeEquals(provided, config.adminToken)) {
      return fail(res, 401, 'No autorizado', 'unauthorized');
    }
    const target = typeof req.body?.userId === 'string' ? req.body.userId : null;
    const username = parseUsername(req.body?.username);
    const userId = target || (username ? `ig:${username}` : null);
    if (!userId || !/^[a-zA-Z0-9_:.-]{1,80}$/.test(userId)) {
      return fail(res, 400, 'userId requerido', 'invalid_user');
    }

    applyPaymentEvent(
      store,
      {
        type: 'subscription.activated',
        userId,
        subscription: {
          provider: 'manual',
          providerSubscriptionId: null,
          customerId: null,
          status: 'active',
          currentPeriodEnd: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          plan: 'manual',
        },
      },
      { logger },
    );
    return res.json({ success: true, data: { userId, plan: 'premium' } });
  });

  router.use((req, res) => fail(res, 404, 'Endpoint no encontrado', 'not_found'));

  return router;
}

/**
 * Handler del webhook. Se registra ANTES de `express.json()` para poder
 * verificar la firma sobre el cuerpo crudo (si se parsea, la firma no coincide).
 */
function createWebhookHandler({ config, store, payments, logger = console }) {
  const rawParser = express.raw({ type: '*/*', limit: '256kb' });

  async function processRawWebhook(req, res, rawBody) {
    if (!payments.canReceiveWebhooks()) {
      logger.error('[webhook] recibido pero el proveedor no está configurado para verificarlo');
      return res.status(503).json({ success: false, error: 'Webhook no configurado', code: 'webhook_unavailable' });
    }

    let event;
    try {
      event = payments.parseWebhook(rawBody, req.headers);
    } catch (err) {
      // Firma inválida: 400 y nunca se aplica nada.
      logger.warn(`[webhook] rechazado: ${err.message}`);
      return res.status(400).json({ success: false, error: 'Firma inválida', code: 'invalid_signature' });
    }

    if (store.hasProcessedEvent(event.id)) {
      return res.json({ success: true, received: true, duplicate: true });
    }

    try {
      const normalized = await payments.normalizeEvent(event);
      if (normalized) {
        applyPaymentEvent(store, normalized, { logger });
      }
      store.markProcessedEvent(event.id);
      return res.json({ success: true, received: true });
    } catch (err) {
      // Se responde 500 para que el proveedor reintente; el evento no se marca.
      logger.error(`[webhook] error aplicando ${event.type}: ${err.message}`);
      return res.status(500).json({ success: false, error: 'Error procesando el evento' });
    }
  }

  return (req, res) => {
    if (Buffer.isBuffer(req.body)) {
      return processRawWebhook(req, res, req.body);
    }
    if (typeof req.body === 'string') {
      return processRawWebhook(req, res, Buffer.from(req.body, 'utf8'));
    }

    return rawParser(req, res, (parseErr) => {
      if (parseErr) {
        return res.status(413).json({ success: false, error: 'Payload demasiado grande', code: 'payload_too_large' });
      }
      return processRawWebhook(req, res, req.body);
    });
  };
}

module.exports = {
  buildApiRouter,
  createWebhookHandler,
  isInstagramUrl,
  parseUsername,
  parseUsernameOrProfileUrl,
  formatPrice,
};
