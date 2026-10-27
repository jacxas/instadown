'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const http = require('http');

const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { createArtifactToken, readArtifactToken } = require('../src/session');
const {
  classifyInstagramInput,
  isAllowedInstagramCdnUrl,
  parseEmbedHtml,
} = require('../src/instagram-native');
const vercelHandler = require('../api/index');
const { startApp, makeClient, silentLogger } = require('./helpers');

// -----------------------------------------------------------------------------
// Configuración serverless (Vercel) y normalización de rutas
// -----------------------------------------------------------------------------

test('loadConfig en entorno Vercel usa /tmp y secreto determinista sin fallar', () => {
  const env = {
    VERCEL: '1',
    NODE_ENV: 'production',
    VERCEL_PROJECT_ID: 'prj_instadown_123',
    VERCEL_GIT_REPO_SLUG: 'instadown',
    VERCEL_URL: 'instadown-preview.vercel.app',
  };

  const cfgA = loadConfig(env);
  const cfgB = loadConfig(env);

  assert.equal(cfgA.isServerless, true);
  assert.equal(cfgA.appUrl, 'https://instadown-preview.vercel.app');
  assert.equal(cfgA.dataDir.startsWith(os.tmpdir()), true);
  assert.equal(cfgA.downloadsDir.startsWith(os.tmpdir()), true);
  // Dos instancias frías generan el mismo secreto de respaldo
  assert.equal(cfgA.sessionSecret, cfgB.sessionSecret);
  assert.equal(cfgA.sessionSecret.length, 64);
});

test('api/index.js resuelve rutas reescritas por vercel.json sin dar 404', async (t) => {
  const server = http.createServer((req, res) => vercelHandler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections?.();
    server.close();
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const client = makeClient(base);

  // Simula la reescritura de vercel.json: /api/index.js?__path=/api/config
  const cfgRes = await client.get('/api/index.js?__path=/api/config');
  assert.equal(cfgRes.status, 200);
  assert.equal(cfgRes.json.success, true);

  const meRes = await client.get('/api/index.js?__path=/api/me');
  assert.equal(meRes.status, 200);
  assert.equal(meRes.json.success, true);

  const healthRes = await client.get('/api/index.js?__path=/health');
  assert.equal(healthRes.status, 200);
  assert.equal(healthRes.json.status, 'ok');
});

// -----------------------------------------------------------------------------
// Extractor nativo Node.js + artefactos firmados sin estado (sin Python)
// -----------------------------------------------------------------------------

function makeMockInstagramFetch() {
  return async (url) => {
    const href = String(url);

    // Redirección /share/reel/...
    if (href.includes('/share/reel/SHARE123')) {
      return new Response('', {
        status: 302,
        headers: { Location: 'https://www.instagram.com/reel/REEL999/' },
      });
    }

    // GraphQL para REEL999 (con prefijo for (;;); real de Instagram)
    if (href.includes('/graphql/query')) {
      // Simular fallo en EMBEDONLY para probar fallback a embed HTML
      return new Response(
        'for (;;);' +
          JSON.stringify({
            data: {
              xdt_shortcode_media: {
                __typename: 'XDTGraphVideo',
                shortcode: 'REEL999',
                is_video: true,
                video_url: 'https://scontent.cdninstagram.com/v/t50.2886-16/reel999.mp4?efg=1',
                display_url: 'https://scontent.cdninstagram.com/v/t51.29350-15/reel999.jpg',
                edge_media_to_caption: { edges: [{ node: { text: 'Reel de prueba' } }] },
                edge_media_preview_like: { count: 42 },
                edge_media_to_parent_comment: { count: 7 },
                owner: { username: 'creador_ar' },
              },
            },
          }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Perfil web_profile_info
    if (href.includes('/api/v1/users/web_profile_info/')) {
      return new Response(
        JSON.stringify({
          data: {
            user: {
              id: '25025320',
              username: 'instagram',
              full_name: 'Instagram',
              biography: 'Cuenta oficial',
              edge_followed_by: { count: 680000000 },
              edge_follow: { count: 100 },
              edge_owner_to_timeline_media: { count: 7800 },
              profile_pic_url_hd: 'https://scontent.cdninstagram.com/v/t51.2885-19/avatar_ig.jpg',
              is_private: false,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Descarga binaria desde el CDN (incluso si manda text/html malicioso, nuestro proxy sanea MIME)
    if (href.startsWith('https://scontent.cdninstagram.com/')) {
      return new Response(Buffer.from('FAKE_MEDIA_BYTES_12345'), {
        status: 200,
        headers: {
          'Content-Type': href.includes('.mp4') ? 'text/html' : 'image/jpeg',
          'Content-Length': '22',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  };
}

test('descarga nativa sin Python y streaming sin estado entre instancias distintas', async (t) => {
  const savedPythonBin = process.env.PYTHON_BIN;
  delete process.env.PYTHON_BIN;
  t.after(() => {
    if (savedPythonBin !== undefined) process.env.PYTHON_BIN = savedPythonBin;
  });

  const sharedSecret = 'secreto-compartido-entre-lambdas-0123456789';
  const mockFetch = makeMockInstagramFetch();

  // Instancia A (como primera Lambda en Vercel)
  const cfgA = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: sharedSecret,
    FREE_DAILY_LIMIT: '2',
  });
  cfgA.instagram.fetchImpl = mockFetch;
  const appA = await createApp({ config: cfgA, logger: silentLogger() });
  const srvA = await new Promise((r) => {
    const s = appA.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    srvA.closeAllConnections?.();
    srvA.close();
  });

  // Instancia B completamente separada con store vacío (simula cold start en otra Lambda)
  const cfgB = loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: sharedSecret,
    FREE_DAILY_LIMIT: '2',
  });
  cfgB.instagram.fetchImpl = mockFetch;
  const appB = await createApp({ config: cfgB, logger: silentLogger() });
  const srvB = await new Promise((r) => {
    const s = appB.app.listen(0, '127.0.0.1', () => r(s));
  });
  t.after(() => {
    srvB.closeAllConnections?.();
    srvB.close();
  });

  const clientA = makeClient(`http://127.0.0.1:${srvA.address().port}`);

  // 1) Descargar enlace compartido /share/reel/... sin esquema o con esquema en Instancia A
  const dl = await clientA.post('/api/download/post', {
    url: 'https://www.instagram.com/share/reel/SHARE123/',
  });
  assert.equal(dl.status, 200);
  assert.equal(dl.json.remainingDownloads, 1);
  assert.equal(dl.json.data.type, 'video');
  assert.equal(dl.json.data.caption, 'Reel de prueba');

  const fileUrl = dl.json.data.files[0].url;
  assert.match(fileUrl, /^\/api\/files\/s1\./);

  // 2) Bajar el archivo desde la Instancia B (store distinto) usando la misma cookie de sesión
  const resB = await fetch(`http://127.0.0.1:${srvB.address().port}${fileUrl}`, {
    headers: { Cookie: clientA.cookie },
  });
  assert.equal(resB.status, 200);
  // Aunque el upstream devolvió text/html, nuestro servidor fuerza video/mp4 + nosniff (sin XSS)
  assert.equal(resB.headers.get('content-type'), 'video/mp4');
  assert.equal(resB.headers.get('x-content-type-options'), 'nosniff');
  assert.match(resB.headers.get('content-disposition') || '', /attachment; filename="REEL999\.mp4"/);
  assert.equal(await resB.text(), 'FAKE_MEDIA_BYTES_12345');

  // 3) Otro visitante sin esa sesión NO puede descargar ese token (404)
  const strangerB = makeClient(`http://127.0.0.1:${srvB.address().port}`);
  const denied = await strangerB.get(fileUrl);
  assert.equal(denied.status, 404);

  // 4) La cuota firmada en la cookie persiste en la Instancia B aunque su store esté vacío
  const meOnB = await fetch(`http://127.0.0.1:${srvB.address().port}/api/me`, {
    headers: { Cookie: clientA.cookie },
  });
  const meJson = await meOnB.json();
  assert.equal(meJson.data.remainingDownloads, 1);

  // 5) POST /api/user acepta tanto @usuario como URL completa de perfil sin dar 404
  const profileRes = await clientA.post('/api/user', {
    username: 'https://www.instagram.com/instagram/?igsh=abc',
  });
  assert.equal(profileRes.status, 200);
  assert.equal(profileRes.json.data.username, 'instagram');
  assert.match(profileRes.json.data.avatar_url, /^\/api\/files\/s1\./);
});

test('fallback a HTML embed desescapa entidades &amp; y extrae máxima resolución', () => {
  const html = `
    <div class="Embed">
      <img class="EmbeddedMediaImage"
           src="https://scontent.cdninstagram.com/low.jpg?a=1&amp;b=2"
           srcset="https://scontent.cdninstagram.com/640.jpg?a=1&amp;b=2 640w, https://scontent.cdninstagram.com/1080.jpg?a=1&amp;b=2 1080w">
      <div class="Caption">Hola &amp; bienvenidos</div>
    </div>
  `;
  const parsed = parseEmbedHtml(html, 'POST123');
  assert.ok(parsed);
  assert.equal(parsed.type, 'photo');
  assert.equal(parsed.items[0].remoteUrl, 'https://scontent.cdninstagram.com/1080.jpg?a=1&b=2');
  assert.equal(parsed.caption, 'Hola & bienvenidos');
});

test('clasificador y validador anti-SSRF del CDN de Instagram', () => {
  assert.deepEqual(classifyInstagramInput('instagram.com/reel/C9xyz_1/'), {
    kind: 'post',
    subtype: 'reel',
    shortcode: 'C9xyz_1',
    url: 'https://www.instagram.com/reel/C9xyz_1/',
  });
  assert.deepEqual(classifyInstagramInput('https://www.instagram.com/leomessi/p/ABC12345/'), {
    kind: 'post',
    subtype: 'post',
    shortcode: 'ABC12345',
    url: 'https://www.instagram.com/p/ABC12345/',
  });
  assert.deepEqual(classifyInstagramInput('https://www.instagram.com/stories/leomessi/12345/'), {
    kind: 'stories',
    username: 'leomessi',
    storyId: '12345',
    url: 'https://www.instagram.com/stories/leomessi/12345/',
  });
  assert.deepEqual(classifyInstagramInput('https://www.instagram.com/leomessi?igsh=1'), {
    kind: 'username',
    username: 'leomessi',
  });

  // Anti-SSRF
  assert.equal(isAllowedInstagramCdnUrl('https://scontent-eze1-1.cdninstagram.com/v/x.mp4'), true);
  assert.equal(isAllowedInstagramCdnUrl('https://instagram.feze1-1.fna.fbcdn.net/v/x.jpg'), true);
  assert.equal(isAllowedInstagramCdnUrl('http://scontent.cdninstagram.com/v/x.jpg'), false);
  assert.equal(isAllowedInstagramCdnUrl('https://127.0.0.1/x.jpg'), false);
  assert.equal(isAllowedInstagramCdnUrl('https://169.254.169.254/latest/meta-data/'), false);
  assert.equal(isAllowedInstagramCdnUrl('https://cdninstagram.com.evil.com/x.jpg'), false);

  // Tokens firmados de artefactos expiran y rechazan manipulación
  const secret = 'test-secret';
  const sid = 'a'.repeat(32);
  const valid = createArtifactToken(
    { sid, url: 'https://scontent.cdninstagram.com/x.jpg', name: 'x.jpg', exp: Date.now() + 60_000 },
    secret,
  );
  assert.equal(readArtifactToken(valid, secret)?.sid, sid);
  assert.equal(readArtifactToken(`${valid}x`, secret), null);

  const expired = createArtifactToken(
    { sid, url: 'https://scontent.cdninstagram.com/x.jpg', name: 'x.jpg', exp: Date.now() - 1_000 },
    secret,
  );
  assert.equal(readArtifactToken(expired, secret), null);
});

test('isSameOrigin acepta X-Forwarded-Host detrás de proxies inversos (Vercel / Preview)', async (t) => {
  const ctx = await startApp({ PAYMENTS_PROVIDER: 'mock' });
  t.after(async () => {
    await ctx.store.flush();
    await ctx.close();
  });

  const res = await ctx.client.request('/api/user', {
    method: 'POST',
    body: { username: 'instagram' },
    headers: {
      Origin: 'https://instadown-preview.vercel.app',
      'X-Forwarded-Host': 'instadown-preview.vercel.app',
    },
  });
  // No debe ser rechazado con 403 bad_origin
  assert.notEqual(res.status, 403);
});
