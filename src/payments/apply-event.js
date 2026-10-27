'use strict';

/**
 * Aplica un evento de pago ya normalizado sobre el store.
 *
 * Es el ÚNICO lugar donde se activa o se revoca Premium. Tanto los webhooks de
 * Stripe como el checkout simulado pasan por aquí, para que no existan dos
 * caminos con reglas distintas.
 */

const { isPremium } = require('../entitlements');

function applyPaymentEvent(store, event, { now = () => new Date(), logger = console } = {}) {
  if (!event || !event.userId) return { applied: false, reason: 'evento sin usuario' };

  const nowDate = now();

  switch (event.type) {
    case 'subscription.activated': {
      store.upsertUser(event.userId, (user) => {
        user.premium = {
          ...event.subscription,
          status: 'active',
          activatedAt: user.premium?.activatedAt || nowDate.toISOString(),
          updatedAt: nowDate.toISOString(),
        };
      });
      logger.info?.(`[payments] Premium activado para ${event.userId}`);
      return { applied: true, plan: 'premium' };
    }

    case 'subscription.past_due': {
      store.upsertUser(event.userId, (user) => {
        if (!user.premium) {
          user.premium = { ...event.subscription };
          return;
        }
        // Se conserva el acceso hasta el fin del periodo ya pagado; Stripe
        // reintenta el cobro y, si falla, llega `subscription.canceled`.
        user.premium = {
          ...user.premium,
          ...event.subscription,
          status: 'past_due',
          updatedAt: nowDate.toISOString(),
        };
      });
      logger.warn?.(`[payments] Pago fallido para ${event.userId}`);
      return { applied: true, plan: 'premium' };
    }

    case 'subscription.canceled': {
      store.upsertUser(event.userId, (user) => {
        const periodEnd = event.subscription?.currentPeriodEnd;
        const stillPaid = periodEnd && new Date(periodEnd).getTime() > nowDate.getTime();
        user.premium = {
          ...(user.premium || {}),
          ...event.subscription,
          status: stillPaid ? 'active' : 'canceled',
          // Si ya pagó el periodo en curso, conserva Premium hasta que termine.
          cancelAtPeriodEnd: Boolean(stillPaid),
          canceledAt: nowDate.toISOString(),
          currentPeriodEnd: periodEnd || user.premium?.currentPeriodEnd || null,
        };
        if (!stillPaid) user.plan = 'free';
      });
      logger.info?.(`[payments] Suscripción cancelada para ${event.userId}`);
      return { applied: true, plan: 'free' };
    }

    default:
      return { applied: false, reason: `tipo no manejado: ${event.type}` };
  }
}

/** Vista para el cliente: indica si el usuario tiene Premium ahora mismo. */
function subscriptionSummary(user, now = new Date()) {
  return {
    premium: isPremium(user, now),
    subscription: user?.premium
      ? {
          provider: user.premium.provider || null,
          status: user.premium.status || null,
          currentPeriodEnd: user.premium.currentPeriodEnd || null,
          cancelAtPeriodEnd: Boolean(user.premium.cancelAtPeriodEnd),
        }
      : null,
  };
}

module.exports = { applyPaymentEvent, subscriptionSummary };
