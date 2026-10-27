'use strict';

/**
 * Reglas de negocio de planes y cuota.
 *
 * Antes el límite gratuito era `free: 2` de por vida y se reponía solo al
 * reiniciar el proceso (mientras la UI prometía "2 descargas por día").
 * Ahora la cuota es diaria y se calcula contra el día UTC.
 */

const { todayKey } = require('./store');

const FREE = 'free';
const PREMIUM = 'premium';

/**
 * Estados que conservan el acceso mientras no venza el período ya pagado.
 * `past_due` entra aquí a propósito: si el cobro falla, Stripe reintenta
 * durante días y sería hostil cortar el servicio en el primer intento.
 */
const ACCESS_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Plan vigente según la suscripción guardada (nunca según lo que diga el cliente). */
function effectivePlan(user, now = new Date()) {
  if (!user || !user.premium) return FREE;

  const { status, currentPeriodEnd } = user.premium;
  if (!ACCESS_STATUSES.has(status)) return FREE;

  if (currentPeriodEnd && new Date(currentPeriodEnd).getTime() <= now.getTime()) {
    // Suscripción vencida: Stripe debería haber avisado, pero si no lo hizo,
    // se degrada en lugar de regalar Premium para siempre.
    return FREE;
  }
  return PREMIUM;
}

function isPremium(user, now = new Date()) {
  return effectivePlan(user, now) === PREMIUM;
}

/** Normaliza el contador de uso si cambió el día. */
function ensureUsageDay(user, now = new Date()) {
  const key = todayKey(now);
  if (!user.usage || user.usage.day !== key) {
    user.usage = { day: key, count: 0 };
  }
  return user.usage;
}

function remainingDownloads(user, config, now = new Date()) {
  if (isPremium(user, now)) return null; // ilimitado
  const usage = ensureUsageDay(user, now);
  return Math.max(0, config.freeDailyLimit - usage.count);
}

function canDownload(user, config, now = new Date()) {
  return isPremium(user, now) || remainingDownloads(user, config, now) > 0;
}

/** Consume una descarga de la cuota gratuita. Devuelve el restante. */
function consumeDownload(user, config, now = new Date()) {
  if (isPremium(user, now)) return null;
  const usage = ensureUsageDay(user, now);
  usage.count += 1;
  return Math.max(0, config.freeDailyLimit - usage.count);
}

function publicUser(user, config, now = new Date()) {
  const plan = effectivePlan(user, now);
  const usage = ensureUsageDay(user, now);
  return {
    id: user?.id || null,
    plan,
    premium: plan === PREMIUM,
    remainingDownloads: remainingDownloads(user, config, now),
    dailyLimit: config.freeDailyLimit,
    usedToday: usage.count,
    subscription: user?.premium
      ? {
          status: user.premium.status,
          currentPeriodEnd: user.premium.currentPeriodEnd || null,
          cancelAtPeriodEnd: Boolean(user.premium.cancelAtPeriodEnd),
        }
      : null,
  };
}

module.exports = {
  FREE,
  PREMIUM,
  effectivePlan,
  isPremium,
  ensureUsageDay,
  remainingDownloads,
  canDownload,
  consumeDownload,
  publicUser,
};
