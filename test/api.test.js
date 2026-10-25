'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startApp, writeFakePython, signStripePayload, makeClient } = require('./helpers');

// El servidor invoca este script en lugar de python3 instagram_downloader.py.
process.env.PYTHON_BIN = writeFakePython();

const POST_URL = 'https://www.instagram.com/p/ABC123/';

async function context(overrides = {}) {
  const ctx = await startApp({ PAYMENTS_PROVIDER: 'mock', ...overrides });
  ctx.dispose = async () => {
    await ctx.store.flush();
    await ctx.close();
  };
  return ctx;
}

// -----------------------------------------------------------------------------
// Salud, estáticos y cabeceras
// -----------------------------------------------------------------------------

test('health responde y no filtra el proveedor de pagos sin configurar', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const { status, json } = await ctx.client.get('/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.payments.provider, 'mock');
});

test('solo se sirve /public: el código fuente ya no es accesible', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const index = await ctx.client.get('/');
  assert.equal(index.status, 200);
  assert.match(index.text, /InstaDown/);

  for (const path of ['/server.js', '/package.json', '/src/config.js', '/instagram_downloader.py', '/.env', '/data/store.json']) {
    const response = await ctx.client.get(path);
    assert.equal(response.status, 404, `${path} no debería servirse`);
  }
});

test('cabeceras de seguridad presentes y sin X-Powered-By', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const { headers } = await ctx.client.get('/');
  assert.match(headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  // En desarrollo no se envía X-Frame-Options (el preview usa iframe);
  // en producción la CSP y la cabecera bloquean el embedding.
  assert.equal(headers.get('x-frame-options'), null);
  assert.match(headers.get('content-security-policy'), /frame-ancestors/);
  assert.equal(headers.get('x-powered-by'), null);
  assert.equal(headers.get('access-control-allow-origin'), null);
});

test('las escrituras desde otro origen se rechazan', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const response = await ctx.client.request('/api/download/post', {
    method: 'POST',
    body: { url: POST_URL },
    headers: { Origin: 'https://sitio-malicioso.example' },
  });
  assert.equal(response.status, 403);
  assert.equal(response.json.code, 'bad_origin');
});

// -----------------------------------------------------------------------------
// Estado y cuota
// -----------------------------------------------------------------------------

test('/api/config expone precio y límite', async (t) => {
  const ctx = await context({ PREMIUM_PRICE_CENTS: '100' });
  t.after(ctx.dispose);

  const { json } = await ctx.client.get('/api/config');
  assert.equal(json.data.price.amountCents, 100);
  assert.equal(json.data.price.currency, 'usd');
  assert.equal(json.data.dailyLimit, 2);
  assert.equal(json.data.paymentsEnabled, true);
  assert.equal(json.data.mockMode, true);
});

test('la sesión se emite firmada y el usuario arranca en gratis', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const me = await ctx.client.get('/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.data.premium, false);
  assert.equal(me.json.data.remainingDownloads, 2);
  assert.match(ctx.client.cookie, /^instadown_sid=/);
});

test('el userId del cliente se ignora: no se puede reclamar otra cuenta', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  await ctx.client.get('/api/me');
  const firstId = Object.keys(ctx.store.state.users)[0];

  // Intento de suplantación enviando userId en el body.
  await ctx.client.post('/api/download/post', { url: POST_URL, userId: firstId });

  // El servidor sigue usando el id de la cookie: hay un solo usuario.
  assert.deepEqual(Object.keys(ctx.store.state.users), [firstId]);
});

test('la cuota diaria se agota y devuelve 403 con requiresPremium', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const first = await ctx.client.post('/api/download/post', { url: POST_URL });
  assert.equal(first.status, 200);
  assert.equal(first.json.remainingDownloads, 1);
  assert.equal(first.json.data.files.length, 1);
  assert.match(first.json.data.files[0].url, /^\/api\/files\//);

  const second = await ctx.client.post('/api/download/post', { url: POST_URL });
  assert.equal(second.status, 200);
  assert.equal(second.json.remainingDownloads, 0);

  const third = await ctx.client.post('/api/download/post', { url: POST_URL });
  assert.equal(third.status, 403);
  assert.equal(third.json.code, 'quota_exceeded');
  assert.equal(third.json.requiresPremium, true);
});

test('el antiguo endpoint que regalaba Premium ya no existe', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const response = await ctx.client.post('/api/premium/activate', { userId: 'yo' });
  assert.equal(response.status, 404);

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.premium, false);
});

test('una descarga fallida no consume cuota', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const invalid = await ctx.client.post('/api/download/post', { url: 'https://evil.com/x' });
  assert.equal(invalid.status, 400);

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.remainingDownloads, 2);
});

// -----------------------------------------------------------------------------
// Archivos
// -----------------------------------------------------------------------------

test('los archivos descargados solo los puede bajar su dueño', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const download = await ctx.client.post('/api/download/post', { url: POST_URL });
  const fileUrl = download.json.data.files[0].url;

  const owner = await ctx.client.get(fileUrl);
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('content-disposition') || '', /attachment/);
  assert.equal(owner.headers.get('cache-control'), 'private, no-store');

  const stranger = makeClient(ctx.baseUrl);
  const denied = await stranger.get(fileUrl);
  assert.equal(denied.status, 404);
});

test('un token inexistente responde 404', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);
  await ctx.client.get('/api/me');

  const response = await ctx.client.get('/api/files/token-inventado');
  assert.equal(response.status, 404);
});

// -----------------------------------------------------------------------------
// Checkout simulado y pagos deshabilitados
// -----------------------------------------------------------------------------

test('el checkout simulado activa Premium y quita el límite', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const checkout = await ctx.client.post('/api/billing/checkout', {});
  assert.equal(checkout.status, 200);

  const url = new URL(checkout.json.data.url);
  const complete = await ctx.client.get(`${url.pathname}${url.search}`);
  assert.equal(complete.status, 303);

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.premium, true);
  assert.equal(me.json.data.remainingDownloads, null);

  // Con Premium, muchas descargas seguidas no fallan por cuota.
  for (let i = 0; i < 3; i += 1) {
    const response = await ctx.client.post('/api/download/post', { url: POST_URL });
    assert.equal(response.status, 200);
  }
});

test('un token de checkout simulado no se puede reutilizar', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const checkout = await ctx.client.post('/api/billing/checkout', {});
  const url = new URL(checkout.json.data.url);
  await ctx.client.get(`${url.pathname}${url.search}`);
  const replay = await ctx.client.get(`${url.pathname}${url.search}`);
  assert.equal(replay.status, 400);
});

test('sin proveedor configurado el checkout responde 503 y NO activa nada', async (t) => {
  const ctx = await context({ PAYMENTS_PROVIDER: 'disabled' });
  t.after(ctx.dispose);

  const config = await ctx.client.get('/api/config');
  assert.equal(config.json.data.paymentsEnabled, false);

  const checkout = await ctx.client.post('/api/billing/checkout', {});
  assert.equal(checkout.status, 503);
  assert.equal(checkout.json.code, 'payments_unavailable');

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.premium, false);
});

test('el modo simulado se ignora en producción', async (t) => {
  // En producción el mock se desactiva (fail-closed) aunque se pida explícito.
  const ctx = await context({ PAYMENTS_PROVIDER: 'mock', NODE_ENV: 'production' });
  t.after(ctx.dispose);

  assert.equal(ctx.payments.name, 'disabled');
  const checkout = await ctx.client.post('/api/billing/checkout', {});
  assert.equal(checkout.status, 503);
});

test('ya siendo Premium, un segundo checkout se rechaza', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const checkout = await ctx.client.post('/api/billing/checkout', {});
  const url = new URL(checkout.json.data.url);
  await ctx.client.get(`${url.pathname}${url.search}`);

  const again = await ctx.client.post('/api/billing/checkout', {});
  assert.equal(again.status, 409);
  assert.equal(again.json.code, 'already_premium');
});

// -----------------------------------------------------------------------------
// Webhooks de Stripe
// -----------------------------------------------------------------------------

const STRIPE_ENV = {
  PAYMENTS_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: 'sk_test_falsa',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secreto',
};

function subscriptionEvent(userId, { id = 'evt_1', status = 'active', periodEnd } = {}) {
  return {
    id,
    type: 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status,
        metadata: { userId },
        cancel_at_period_end: false,
        current_period_end: periodEnd || Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  };
}

test('un webhook firmado activa Premium', async (t) => {
  const ctx = await context(STRIPE_ENV);
  t.after(ctx.dispose);

  await ctx.client.get('/api/me');
  const userId = Object.keys(ctx.store.state.users)[0];

  const event = subscriptionEvent(userId, { id: 'evt_ok' });
  const { body, header } = signStripePayload(event, STRIPE_ENV.STRIPE_WEBHOOK_SECRET);

  const response = await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 200);

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.premium, true);
  assert.equal(me.json.data.subscription.status, 'active');
});

test('un webhook con firma inválida se rechaza y no cambia el plan', async (t) => {
  const ctx = await context(STRIPE_ENV);
  t.after(ctx.dispose);

  await ctx.client.get('/api/me');
  const userId = Object.keys(ctx.store.state.users)[0];

  const event = subscriptionEvent(userId, { id: 'evt_bad' });
  const body = JSON.stringify(event);

  const response = await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'Stripe-Signature': 't=123,v1=firmafalsa', 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 400);
  assert.equal(response.json.code, 'invalid_signature');

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.premium, false);
});

test('un webhook sin secreto configurado responde 503', async (t) => {
  const ctx = await context({ PAYMENTS_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_test_falsa' });
  t.after(ctx.dispose);

  const response = await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 503);
});

test('el mismo evento entregado dos veces es idempotente', async (t) => {
  const ctx = await context(STRIPE_ENV);
  t.after(ctx.dispose);

  await ctx.client.get('/api/me');
  const userId = Object.keys(ctx.store.state.users)[0];

  const event = subscriptionEvent(userId, { id: 'evt_dup' });
  const { body, header } = signStripePayload(event, STRIPE_ENV.STRIPE_WEBHOOK_SECRET);

  const first = await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' },
  });
  assert.equal(first.status, 200);

  const second = await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body,
    headers: { 'Stripe-Signature': header, 'Content-Type': 'application/json' },
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicate, true);
});

test('cancelar la suscripción quita Premium al vencer el período', async (t) => {
  const ctx = await context(STRIPE_ENV);
  t.after(ctx.dispose);

  await ctx.client.get('/api/me');
  const userId = Object.keys(ctx.store.state.users)[0];
  const secret = STRIPE_ENV.STRIPE_WEBHOOK_SECRET;

  const activate = subscriptionEvent(userId, { id: 'evt_a' });
  const signedActivate = signStripePayload(activate, secret);
  await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body: signedActivate.body,
    headers: { 'Stripe-Signature': signedActivate.header, 'Content-Type': 'application/json' },
  });
  assert.equal((await ctx.client.get('/api/me')).json.data.premium, true);

  const canceled = {
    id: 'evt_c',
    type: 'customer.subscription.deleted',
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'canceled',
        metadata: { userId },
        current_period_end: Math.floor(Date.now() / 1000) - 60, // ya venció
      },
    },
  };
  const signedCancel = signStripePayload(canceled, secret);
  await ctx.client.request('/api/billing/webhook', {
    method: 'POST',
    body: signedCancel.body,
    headers: { 'Stripe-Signature': signedCancel.header, 'Content-Type': 'application/json' },
  });

  assert.equal((await ctx.client.get('/api/me')).json.data.premium, false);
});

// -----------------------------------------------------------------------------
// Administración
// -----------------------------------------------------------------------------

test('el grant manual exige ADMIN_TOKEN', async (t) => {
  const ctx = await context({ ADMIN_TOKEN: 'token-admin-secreto' });
  t.after(ctx.dispose);
  await ctx.client.get('/api/me');
  const userId = Object.keys(ctx.store.state.users)[0];

  const denied = await ctx.client.post('/api/admin/grant', { userId });
  assert.equal(denied.status, 401);

  const wrong = await ctx.client.request('/api/admin/grant', {
    method: 'POST',
    body: { userId },
    headers: { 'x-admin-token': 'otro' },
  });
  assert.equal(wrong.status, 401);

  const granted = await ctx.client.request('/api/admin/grant', {
    method: 'POST',
    body: { userId },
    headers: { 'x-admin-token': 'token-admin-secreto' },
  });
  assert.equal(granted.status, 200);
  assert.equal((await ctx.client.get('/api/me')).json.data.premium, true);
});

test('sin ADMIN_TOKEN el endpoint no existe', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const response = await ctx.client.request('/api/admin/grant', {
    method: 'POST',
    body: { userId: 'x' },
    headers: { 'x-admin-token': 'cualquiera' },
  });
  assert.equal(response.status, 404);
});

// -----------------------------------------------------------------------------
// Perfil (no consume cuota)
// -----------------------------------------------------------------------------

test('la info de perfil no consume cuota', async (t) => {
  const ctx = await context();
  t.after(ctx.dispose);

  const profile = await ctx.client.get('/api/user/@instagram');
  assert.equal(profile.status, 200);
  assert.equal(profile.json.data.username, 'instagram');

  const me = await ctx.client.get('/api/me');
  assert.equal(me.json.data.remainingDownloads, 2);
});
