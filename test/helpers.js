'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

function tempDir(prefix = 'instadown-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Configuración aislada: directorios temporales y sin secretos reales. */
function makeConfig(overrides = {}) {
  const root = tempDir();
  const env = {
    NODE_ENV: 'test',
    PORT: '0',
    APP_URL: 'http://127.0.0.1',
    SESSION_SECRET: 'test-secret-0123456789abcdef',
    DATA_DIR: path.join(root, 'data'),
    DOWNLOADS_DIR: path.join(root, 'downloads'),
    FREE_DAILY_LIMIT: '2',
    ...overrides,
  };
  return loadConfig(env);
}

/** Arranca la app en un puerto efímero y devuelve utilidades de test. */
async function startApp(overrides = {}) {
  const config = makeConfig(overrides);
  const { app, store, payments } = await createApp({ config, logger: silentLogger() });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    config,
    store,
    payments,
    baseUrl,
    server,
    close: () =>
      new Promise((resolve) => {
        // fetch() mantiene sockets keep-alive abiertos: sin esto, close() espera para siempre.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    client: makeClient(baseUrl),
  };
}

function silentLogger() {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, log: noop };
}

/** Cliente HTTP mínimo con manejo de cookie de sesión. */
function makeClient(baseUrl) {
  let cookie = '';

  async function request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (cookie) init.headers.Cookie = cookie;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${pathname}`, init);

    const setCookie = response.headers.getSetCookie?.() || [];
    for (const entry of setCookie) {
      const pair = entry.split(';')[0];
      if (pair) cookie = pair;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  return {
    request,
    get: (p, opts) => request(p, opts),
    post: (p, body, opts = {}) => request(p, { ...opts, method: 'POST', body: body ?? {} }),
    get cookie() {
      return cookie;
    },
  };
}

/**
 * Script falso que imita a instagram_downloader.py. Permite testear la API sin
 * red ni credenciales: el servidor lo invoca vía PYTHON_BIN.
 */
function writeFakePython() {
  const dir = tempDir('instadown-fake-');
  const script = path.join(dir, 'fake.py');
  fs.writeFileSync(
    script,
    `#!/bin/sh
action="$2"
arg="$3"
outdir="$5"
mkdir -p "$outdir"
case "$action" in
  get_user_info)
    printf '{"ok":true,"data":{"id":"1","username":"%s","full_name":"Fake User","biography":"bio","follower_count":10,"following_count":5,"media_count":3,"profile_pic_url":"https://scontent.cdninstagram.com/x.jpg","is_private":false}}\\n' "$arg"
    ;;
  *)
    echo "contenido" > "$outdir/archivo.txt"
    printf '{"ok":true,"data":{"type":"photo","caption":"hola","likes":1,"comments":2,"items":[{"file":"%s/archivo.txt","type":"photo"}]}}\\n' "$outdir"
    ;;
esac
`,
    { mode: 0o755 },
  );
  return script;
}

/** Firma un payload igual que Stripe (`t=<ts>,v1=<hmac>`). */
function signStripePayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return { body, header: `t=${timestamp},v1=${signature}` };
}

module.exports = {
  makeConfig,
  startApp,
  makeClient,
  writeFakePython,
  signStripePayload,
  tempDir,
  silentLogger,
};
