'use strict';

/**
 * Proveedor Stripe: Checkout + Suscripciones + webhooks firmados.
 *
 * La activación de Premium ocurre ÚNICAMENTE aquí, cuando Stripe confirma el
 * cobro. El navegador nunca puede activarla por su cuenta.
 */

const crypto = require('crypto');
const { StripeClient, StripeError } = require('./stripe-client');

const STRIPE_MIN_CHARGE = { usd: 50, eur: 50, ars: 50, mxn: 1000, brl: 50, cop: 50, clp: 1, pen: 100 };

class SignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SignatureError';
  }
}

/**
 * Verifica la cabecera `Stripe-Signature` (esquema v1).
 * Rechaza firmas inválidas y eventos fuera de la ventana de tolerancia (replay).
 */
function verifyStripeSignature({ rawBody, header, secret, toleranceSec = 300, nowMs = Date.now() }) {
  if (!secret) throw new SignatureError('STRIPE_WEBHOOK_SECRET no está configurado');
  if (typeof header !== 'string' || !header.trim()) throw new SignatureError('Falta la cabecera Stripe-Signature');

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=').map((s) => s && s.trim());
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) throw new SignatureError('Cabecera Stripe-Signature malformada');

  const timestampMs = Number.parseInt(timestamp, 10) * 1000;
  if (!Number.isFinite(timestampMs)) throw new SignatureError('Timestamp inválido');
  if (Math.abs(nowMs - timestampMs) > toleranceSec * 1000) {
    throw new SignatureError('Evento fuera de la ventana de tolerancia');
  }

  const payload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();

  for (const candidate of signatures) {
    let received;
    try {
      received = Buffer.from(candidate, 'hex');
    } catch {
      continue;
    }
    if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) {
      return true;
    }
  }
  throw new SignatureError('Firma de webhook inválida');
}

function periodEndFromSubscription(subscription) {
  // Las versiones recientes de la API movieron current_period_end a los items.
  const fromItems = subscription?.items?.data?.[0]?.current_period_end;
  const value = subscription?.current_period_end ?? fromItems ?? null;
  return value ? new Date(value * 1000).toISOString() : null;
}

function computePriceCents(config) {
  const currency = config.payments.currency;
  const min = STRIPE_MIN_CHARGE[currency];
  const amount = config.payments.priceCents;
  if (min && amount < min) {
    // Fallar rápido y claro es mejor que un cobro rechazado en producción.
    throw new Error(
      `El precio de ${amount / 100} ${currency.toUpperCase()} está por debajo del mínimo de Stripe (${min / 100} ${currency.toUpperCase()})`,
    );
  }
  return amount;
}

class StripeProvider {
  constructor(config, { logger = console } = {}) {
    this.name = 'stripe';
    this.config = config;
    this.logger = logger;
    this.client = new StripeClient({
      secretKey: config.payments.stripe.secretKey,
      apiBase: config.payments.stripe.apiBase,
    });
  }

  isConfigured() {
    return Boolean(this.config.payments.stripe.secretKey);
  }

  /** Los webhooks son obligatorios: sin secreto no se puede creer en el evento. */
  canReceiveWebhooks() {
    return Boolean(this.config.payments.stripe.webhookSecret);
  }

  async createCheckoutSession({ userId, email = null }) {
    const { priceId } = this.config.payments.stripe;
    const { currency, productName } = this.config.payments;

    const lineItem = priceId
      ? { price: priceId, quantity: 1 }
      : {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: computePriceCents(this.config),
            recurring: { interval: 'month' },
            product_data: { name: productName },
          },
        };

    const params = {
      mode: 'subscription',
      success_url: `${this.config.appUrl}/?checkout=success`,
      cancel_url: `${this.config.appUrl}/?checkout=cancelled`,
      client_reference_id: userId,
      line_items: [lineItem],
      // El userId viaja en metadata: es lo que une el pago con la cuenta.
      metadata: { userId },
      subscription_data: { metadata: { userId } },
      allow_promotion_codes: true,
      // Evita que un mismo clic cree dos suscripciones.
      // (Stripe deduplica con la Idempotency-Key del margen de la petición).
    };
    if (email) params.customer_email = email;

    const session = await this.client.createCheckoutSession(params);
    return { url: session.url, sessionId: session.id, subscriptionId: session.subscription || null };
  }

  async createPortalSession({ customerId }) {
    const session = await this.client.createBillingPortalSession({
      customer: customerId,
      return_url: `${this.config.appUrl}/?portal=return`,
    });
    return { url: session.url };
  }

  parseWebhook(rawBody, headers) {
    const header = headers['stripe-signature'];
    verifyStripeSignature({
      rawBody: Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || ''),
      header,
      secret: this.config.payments.stripe.webhookSecret,
      toleranceSec: this.config.payments.webhookToleranceSec,
    });

    let event;
    try {
      event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody);
    } catch {
      throw new SignatureError('Payload de webhook inválido');
    }
    if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') {
      throw new SignatureError('Evento sin id o type');
    }
    return event;
  }

  /**
   * Traduce un evento de Stripe a una acción normalizada e independiente del
   * proveedor. Devuelve null si el evento no nos interesa.
   */
  async normalizeEvent(event) {
    const object = event.data?.object || {};
    const userId = object.metadata?.userId || object.client_reference_id || null;

    switch (event.type) {
      case 'checkout.session.completed': {
        if (!userId) return null;
        let periodEnd = null;
        if (object.subscription) {
          // El objeto de la sesión no trae el fin de periodo: se consulta.
          try {
            const subscription = await this.client.retrieveSubscription(object.subscription);
            periodEnd = periodEndFromSubscription(subscription);
          } catch (err) {
            this.logger.warn?.(`[stripe] no se pudo leer la suscripción: ${err.message}`);
          }
        }
        return {
          type: 'subscription.activated',
          userId,
          subscription: {
            provider: 'stripe',
            providerSubscriptionId: object.subscription || null,
            customerId: object.customer || null,
            status: 'active',
            currentPeriodEnd: periodEnd,
            plan: 'monthly',
          },
        };
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        if (!userId) return null;
        const status = object.status; // active, past_due, canceled, unpaid, trialing...
        const activeStatuses = new Set(['active', 'trialing']);
        return {
          type: activeStatuses.has(status) ? 'subscription.activated' : 'subscription.past_due',
          userId,
          subscription: {
            provider: 'stripe',
            providerSubscriptionId: object.id || null,
            customerId: object.customer || null,
            status: activeStatuses.has(status) ? 'active' : status,
            currentPeriodEnd: periodEndFromSubscription(object),
            cancelAtPeriodEnd: Boolean(object.cancel_at_period_end),
            plan: 'monthly',
          },
        };
      }

      case 'customer.subscription.deleted': {
        if (!userId) return null;
        return {
          type: 'subscription.canceled',
          userId,
          subscription: {
            provider: 'stripe',
            providerSubscriptionId: object.id || null,
            customerId: object.customer || null,
            status: 'canceled',
            currentPeriodEnd: periodEndFromSubscription(object),
          },
        };
      }

      case 'invoice.payment_failed': {
        const subscriptionId = object.subscription || null;
        if (!userId) return null;
        return {
          type: 'subscription.past_due',
          userId,
          subscription: {
            provider: 'stripe',
            providerSubscriptionId: subscriptionId,
            customerId: object.customer || null,
            status: 'past_due',
          },
        };
      }

      default:
        return null;
    }
  }
}

module.exports = { StripeProvider, verifyStripeSignature, SignatureError, periodEndFromSubscription, computePriceCents, STRIPE_MIN_CHARGE };
