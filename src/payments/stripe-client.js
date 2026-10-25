'use strict';

/**
 * Cliente mínimo de la API de Stripe (sin SDK).
 *
 * Se usa `fetch` nativo para no añadir dependencias ni superficie de ataque:
 * el SDK completo no aporta nada aquí, solo necesitamos 3 llamadas.
 */

function encodeForm(params, prefix, out = []) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        const arrayName = `${name}[${index}]`;
        if (item && typeof item === 'object') encodeForm(item, arrayName, out);
        else out.push([arrayName, String(item)]);
      });
    } else if (typeof value === 'object') {
      encodeForm(value, name, out);
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}

function toFormBody(params) {
  return encodeForm(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

class StripeError extends Error {
  constructor(message, { status = 0, code = null, type = null } = {}) {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
    this.type = type;
  }
}

class StripeClient {
  constructor({ secretKey, apiBase = 'https://api.stripe.com', timeoutMs = 20_000 }) {
    this.secretKey = secretKey;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async request(method, path, params) {
    if (!this.secretKey) throw new StripeError('Stripe no está configurado', { status: 503 });

    const url = `${this.apiBase}${path}`;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        // Stripe puede devolver 429; se maneja abajo.
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (params) {
      if (method === 'GET') {
        const qs = toFormBody(params);
        const target = qs ? `${url}?${qs}` : url;
        return this.#send(target, init);
      }
      init.body = toFormBody(params);
    }
    return this.#send(url, init);
  }

  async #send(url, init) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      throw new StripeError(`No se pudo contactar a Stripe: ${err.message}`, { status: 502 });
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const error = payload?.error || {};
      throw new StripeError(error.message || `Stripe respondió ${response.status}`, {
        status: response.status,
        code: error.code || null,
        type: error.type || null,
      });
    }
    return payload;
  }

  createCheckoutSession(params) {
    return this.request('POST', '/v1/checkout/sessions', params);
  }

  retrieveSubscription(id) {
    return this.request('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  createBillingPortalSession(params) {
    return this.request('POST', '/v1/billing_portal/sessions', params);
  }
}

module.exports = { StripeClient, StripeError, toFormBody };
