'use strict';

/**
 * Fábrica de proveedores de pago.
 *
 * Para añadir MercadoPago (o cualquier otra pasarela) basta con implementar la
 * misma interfaz y registrarla en `PROVIDERS`:
 *
 *   name, isConfigured(), canReceiveWebhooks(),
 *   createCheckoutSession({ userId, email }), parseWebhook(rawBody, headers),
 *   normalizeEvent(event)
 */

const { StripeProvider } = require('./stripe');
const { MockProvider } = require('./mock');

/** El cobro no está disponible (falta configuración). Nunca se "regala" Premium. */
class PaymentUnavailableError extends Error {
  constructor(message, { status = 503 } = {}) {
    super(message);
    this.name = 'PaymentUnavailableError';
    this.status = status;
    this.code = 'payments_unavailable';
  }
}

class DisabledProvider {
  constructor() {
    this.name = 'disabled';
  }

  isConfigured() {
    return false;
  }

  canReceiveWebhooks() {
    return false;
  }

  async createCheckoutSession() {
    throw new PaymentUnavailableError(
      'Los pagos no están configurados en este servidor. Definí STRIPE_SECRET_KEY (y STRIPE_WEBHOOK_SECRET) para habilitar Premium.',
    );
  }

  async createPortalSession() {
    throw new PaymentUnavailableError('Los pagos no están configurados en este servidor.');
  }

  parseWebhook() {
    throw new PaymentUnavailableError('Los pagos no están configurados en este servidor.');
  }

  async normalizeEvent() {
    return null;
  }
}

const PROVIDERS = {
  stripe: StripeProvider,
  mock: MockProvider,
  disabled: DisabledProvider,
};

function createPaymentProvider(config, deps = {}) {
  const key = config.payments.provider;
  const Provider = PROVIDERS[key] || DisabledProvider;

  // Defensa en profundidad: el modo simulado nunca corre en producción.
  if (key === 'mock' && config.isProduction) {
    return new DisabledProvider();
  }

  return new Provider(config, deps);
}

module.exports = {
  createPaymentProvider,
  PaymentUnavailableError,
  DisabledProvider,
  PROVIDERS,
};
