'use strict';

/**
 * Proveedor simulado: SOLO para desarrollo local.
 *
 * Sirve para recorrer el flujo de checkout completo sin llaves de Stripe, pero
 * hay dos candados: el servidor se niega a usarlo con NODE_ENV=production y
 * requiere `PAYMENTS_PROVIDER=mock` explícito. Nunca se activa "por accidente".
 */

const crypto = require('crypto');

class MockProvider {
  constructor(config, { logger = console, now = () => Date.now() } = {}) {
    this.name = 'mock';
    this.config = config;
    this.logger = logger;
    this.now = now;
    this.pending = new Map(); // token -> { userId, expiresAt }
  }

  isConfigured() {
    return true;
  }

  canReceiveWebhooks() {
    return true; // el "webhook" simulado es una llamada interna
  }

  async createCheckoutSession({ userId }) {
    const token = crypto.randomBytes(24).toString('hex');
    this.pending.set(token, { userId, expiresAt: this.now() + 15 * 60_000 });
    return {
      url: `${this.config.appUrl}/api/billing/mock/complete?token=${token}`,
      sessionId: `mock_cs_${token.slice(0, 12)}`,
      subscriptionId: `mock_sub_${token.slice(0, 12)}`,
    };
  }

  /** Consume el token del checkout simulado (un solo uso, con expiración). */
  consume(token) {
    const entry = this.pending.get(token);
    if (!entry) return null;
    this.pending.delete(token);
    if (entry.expiresAt < this.now()) return null;
    return entry;
  }

  parseWebhook() {
    throw new Error('El proveedor simulado no recibe webhooks HTTP; usá /api/billing/mock/complete');
  }

  async normalizeEvent() {
    return null;
  }
}

module.exports = { MockProvider };
