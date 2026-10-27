'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { createSessionToken, readSessionToken, parseCookies } = require('../src/session');
const { verifyStripeSignature, computePriceCents } = require('../src/payments/stripe');
const { JsonStore, todayKey } = require('../src/store');
const {
  effectivePlan,
  remainingDownloads,
  consumeDownload,
  canDownload,
  publicUser,
} = require('../src/entitlements');
const { isInstagramUrl, parseUsername } = require('../src/routes');
const { makeConfig, signStripePayload } = require('./helpers');

const SECRET = 'secreto-de-prueba';

// -----------------------------------------------------------------------------
// Sesiones
// -----------------------------------------------------------------------------

test('la sesión sobrevive a ida y vuelta y rechaza manipulación', () => {
  const token = createSessionToken('a'.repeat(32), SECRET, 60_000);
  const parsed = readSessionToken(token, SECRET);
  assert.equal(parsed.sid, 'a'.repeat(32));

  // Cambiar un carácter de la firma debe invalidar el token.
  const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(readSessionToken(tampered, SECRET), null);

  // Otro secreto no valida el token.
  assert.equal(readSessionToken(token, 'otro-secreto'), null);
});

test('la sesión expira', () => {
  const token = createSessionToken('b'.repeat(32), SECRET, -1000);
  assert.equal(readSessionToken(token, SECRET), null);
});

test('un sid con formato inválido no se acepta aunque la firma sea válida', () => {
  const token = createSessionToken('../../etc/passwd', SECRET, 60_000);
  assert.equal(readSessionToken(token, SECRET), null);
});

test('parseCookies tolera valores codificados', () => {
  const cookies = parseCookies('a=1; instadown_sid=abc%3D%3D; b=2');
  assert.equal(cookies.a, '1');
  assert.equal(cookies.instadown_sid, 'abc==');
});

// -----------------------------------------------------------------------------
// Firma de webhooks de Stripe
// -----------------------------------------------------------------------------

test('una firma válida de Stripe se acepta', () => {
  const secret = 'whsec_test';
  const { body, header } = signStripePayload({ id: 'evt_1', type: 'x' }, secret);
  assert.equal(
    verifyStripeSignature({ rawBody: Buffer.from(body), header, secret }),
    true,
  );
});

test('firmas inválidas, cabeceras rotas o eventos viejos se rechazan', () => {
  const secret = 'whsec_test';
  const { body, header } = signStripePayload({ id: 'evt_1' }, secret);

  assert.throws(() => verifyStripeSignature({ rawBody: Buffer.from(body), header, secret: 'otro' }));
  assert.throws(() => verifyStripeSignature({ rawBody: Buffer.from(body), header: '', secret }));
  assert.throws(() => verifyStripeSignature({ rawBody: Buffer.from(body), header: 'basura', secret }));
  assert.throws(() => verifyStripeSignature({ rawBody: Buffer.from(body), header, secret: '' }));

  // Replay: un evento de hace 10 minutos queda fuera de la ventana (300 s).
  const old = signStripePayload({ id: 'evt_2' }, secret, Math.floor(Date.now() / 1000) - 600);
  assert.throws(
    () => verifyStripeSignature({ rawBody: Buffer.from(old.body), header: old.header, secret, toleranceSec: 300 }),
    /tolerancia/,
  );

  // El cuerpo alterado invalida la firma.
  assert.throws(() =>
    verifyStripeSignature({ rawBody: Buffer.from(`${body} `), header, secret }),
  );
});

test('el precio por debajo del mínimo de Stripe falla explícitamente', () => {
  const config = makeConfig({ PREMIUM_PRICE_CENTS: '25', PREMIUM_PRICE_CURRENCY: 'usd' });
  assert.throws(() => computePriceCents(config), /mínimo de Stripe/);

  const ok = makeConfig({ PREMIUM_PRICE_CENTS: '100', PREMIUM_PRICE_CURRENCY: 'usd' });
  assert.equal(computePriceCents(ok), 100);
});

// -----------------------------------------------------------------------------
// Store
// -----------------------------------------------------------------------------

test('el store persiste entre instancias', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instadown-store-'));
  const file = path.join(dir, 'store.json');

  const first = await new JsonStore({ file }).load();
  first.upsertUser('user-1', (user) => {
    user.plan = 'premium';
    user.usage = { day: todayKey(), count: 5 };
  });
  await first.scheduleSave();

  const second = await new JsonStore({ file }).load();
  const user = second.getUser('user-1');
  assert.equal(user.plan, 'premium');
  assert.equal(user.usage.count, 5);
});

test('un store corrupto no rompe el arranque', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instadown-corrupt-'));
  const file = path.join(dir, 'store.json');
  fs.writeFileSync(file, '{no es json');

  const store = await new JsonStore({ file }).load();
  assert.deepEqual(store.state.users, {});
});

test('los eventos procesados son idempotentes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instadown-events-'));
  const store = await new JsonStore({ file: path.join(dir, 'store.json') }).load();

  assert.equal(store.hasProcessedEvent('evt_1'), false);
  store.markProcessedEvent('evt_1');
  assert.equal(store.hasProcessedEvent('evt_1'), true);
});

// -----------------------------------------------------------------------------
// Planes y cuota
// -----------------------------------------------------------------------------

function userFixture(extra = {}) {
  return {
    id: 'u1',
    plan: 'free',
    premium: null,
    usage: { day: todayKey(), count: 0 },
    ...extra,
  };
}

test('la cuota gratuita es diaria y se agota', () => {
  const config = makeConfig({ FREE_DAILY_LIMIT: '2' });
  const user = userFixture();

  assert.equal(remainingDownloads(user, config), 2);
  assert.equal(consumeDownload(user, config), 1);
  assert.equal(consumeDownload(user, config), 0);
  assert.equal(canDownload(user, config), false);

  // Al día siguiente se repone.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  assert.equal(remainingDownloads(user, config, tomorrow), 2);
  assert.equal(canDownload(user, config, tomorrow), true);
});

test('Premium es ilimitado', () => {
  const config = makeConfig();
  const user = userFixture({
    plan: 'premium',
    premium: { status: 'active', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(effectivePlan(user), 'premium');
  assert.equal(remainingDownloads(user, config), null);
  assert.equal(consumeDownload(user, config), null);
  assert.equal(publicUser(user, config).premium, true);
});

test('una suscripción vencida degrada a gratis', () => {
  const user = userFixture({
    plan: 'premium',
    premium: { status: 'active', currentPeriodEnd: new Date(Date.now() - 1000).toISOString() },
  });
  assert.equal(effectivePlan(user), 'free');
  assert.equal(canDownload(user, makeConfig({ FREE_DAILY_LIMIT: '0' })), false);
});

test('past_due conserva el acceso hasta el fin del período pagado', () => {
  const vigente = userFixture({
    premium: { status: 'past_due', currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(effectivePlan(vigente), 'premium');

  const vencido = userFixture({
    premium: { status: 'past_due', currentPeriodEnd: new Date(Date.now() - 1000).toISOString() },
  });
  assert.equal(effectivePlan(vencido), 'free');
});

test('los estados sin acceso no habilitan Premium aunque el período no haya vencido', () => {
  for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
    const user = userFixture({
      premium: { status, currentPeriodEnd: new Date(Date.now() + 86400000).toISOString() },
    });
    assert.equal(effectivePlan(user), 'free', `estado ${status} no debe dar Premium`);
  }
});

// -----------------------------------------------------------------------------
// Validación de entradas
// -----------------------------------------------------------------------------

test('solo se aceptan URLs de Instagram', () => {
  assert.equal(isInstagramUrl('https://www.instagram.com/p/ABC/'), true);
  assert.equal(isInstagramUrl('https://instagram.com/reel/ABC/'), true);
  assert.equal(isInstagramUrl('http://instagr.am/p/ABC/'), true);

  assert.equal(isInstagramUrl('https://instagram.com.evil.com/p/ABC/'), false);
  assert.equal(isInstagramUrl('https://evil.com/instagram.com/p/ABC'), false);
  assert.equal(isInstagramUrl('javascript:alert(1)//instagram.com'), false);
  assert.equal(isInstagramUrl('https://www.instagram.com/p/' + 'a'.repeat(600)), false);
  assert.equal(isInstagramUrl('file:///etc/passwd'), false);
  assert.equal(isInstagramUrl(null), false);
});

test('los nombres de usuario se validan (evita path traversal)', () => {
  assert.equal(parseUsername('@instagram'), 'instagram');
  assert.equal(parseUsername('the.rock_01'), 'the.rock_01');
  assert.equal(parseUsername('../../etc/passwd'), null);
  assert.equal(parseUsername('a/b'), null);
  assert.equal(parseUsername('a'.repeat(31)), null);
  assert.equal(parseUsername(''), null);
  assert.equal(parseUsername(null), null);
});
