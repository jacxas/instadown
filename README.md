# InstaDown

Descargador de Instagram (fotos, vídeos, reels, historias, destacados y foto de perfil)
con planes **Gratis** y **Premium**, cuota diaria y cobro real mediante Stripe.

El servidor Node (`server.js` en contenedores/servidores persistentes y `api/index.js` en
Vercel Serverless) sirve el frontend y la API en el mismo origen. Extrae publicaciones,
reels, vídeos, carruseles y perfiles públicos directamente desde Node.js (sin requerir
Python), y puede usar `instagram_downloader.py` o `INSTAGRAM_SESSIONID` cuando se
configuran credenciales.

---

## Arranque rápido

```bash
cp .env.example .env        # completar SESSION_SECRET como mínimo
npm install
npm run dev                 # http://localhost:3000
```

Sin llaves de Stripe el sitio funciona con el plan gratuito, pero **no se puede comprar
Premium** (el checkout responde 503 en lugar de regalar el plan).

Para recorrer el flujo de pago completo en local:

```bash
PAYMENTS_PROVIDER=mock SESSION_SECRET=dev npm run dev
```

En ese modo `/api/billing/mock/complete` simula el webhook. El servidor ignora este modo
si `NODE_ENV=production`.

Requisitos: Node >= 18.17 y Python 3.10+ con `pip install -r requirements.txt`.

---

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `SESSION_SECRET` | sí en producción | Firma la cookie de sesión. `openssl rand -hex 32` |
| `APP_URL` | sí en producción | URL pública; se usa en los redirects de Stripe |
| `PAYMENTS_PROVIDER` | no | `stripe` \| `disabled` \| `mock` (este último solo en dev) |
| `STRIPE_SECRET_KEY` | para cobrar | Clave secreta de Stripe (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | para cobrar | Secreto del endpoint de webhooks (`whsec_…`) |
| `STRIPE_PRICE_ID` | no | Usar un Price del dashboard en vez de precio inline |
| `PREMIUM_PRICE_CENTS` | no | Precio en centavos. Por defecto `100` ($1) |
| `PREMIUM_PRICE_CURRENCY` | no | Por defecto `usd` |
| `FREE_DAILY_LIMIT` | no | Descargas gratis por día (por defecto `2`) |
| `INSTAGRAM_SESSIONID` | no | Cookie de sesión opcional para habilitar historias y destacados en Node/Vercel |
| `INSTAGRAM_USERNAME` / `INSTAGRAM_PASSWORD` | no | Cuenta dedicada opcional para el cliente Python (`instagrapi`) |
| `ADMIN_TOKEN` | no | Si se define, habilita `POST /api/admin/grant` |
| `DATA_DIR` / `DOWNLOADS_DIR` | no | Persistencia y archivos temporales |
| `CORS_ORIGINS` | no | Vacío = mismo origen (recomendado) |

> **El precio mínimo de Stripe es 0.50 USD.** El antiguo `$0.25/mes` no se puede cobrar;
> el servidor falla al arrancar un checkout si el precio configurado está por debajo.

---

## API

Todas las rutas son relativas al mismo origen. La sesión viaja en una cookie
`HttpOnly` firmada; el cliente **no** envía ni elige su identificador.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Estado del servicio y de los pagos |
| `GET` | `/api/config` | Precio, límite diario y si el checkout está disponible |
| `GET` | `/api/me` | Plan, cuota restante y estado de la suscripción |
| `GET` | `/api/user/:username` | Info de perfil (no consume cuota) |
| `POST` | `/api/download/post` | `{ url }` → fotos/vídeos/carruseles |
| `POST` | `/api/download/profile-pic` | `{ username }` |
| `POST` | `/api/download/stories` | `{ username }` |
| `POST` | `/api/download/highlights` | `{ username }` |
| `GET` | `/api/files/:token` | Descarga un archivo propio (caduca en 30 min) |
| `POST` | `/api/billing/checkout` | `{ email? }` → `{ url }` de Stripe Checkout |
| `POST` | `/api/billing/portal` | `{ url }` del portal de Stripe para gestionar/cancelar |
| `POST` | `/api/billing/webhook` | Webhooks de Stripe (firma obligatoria) |
| `POST` | `/api/admin/grant` | Comp de Premium manual (requiere `X-Admin-Token`) |

Las respuestas de error tienen la forma `{ success: false, error, code }`.

### Ejemplo

```bash
curl -c cookies.txt http://localhost:3000/api/me
curl -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/download/post \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.instagram.com/p/ABC123/"}'
```

---

## Cómo funcionan los pagos

```
Navegador ──POST /api/billing/checkout──▶ Servidor ──▶ Stripe Checkout
                                            │
Stripe ──webhook firmado──▶ /api/billing/webhook ──▶ store: premium = active
```

1. El botón "Continuar al pago" pide una sesión de Checkout (`mode=subscription`).
2. El usuario paga en el dominio de Stripe; los datos de la tarjeta nunca pasan por aquí.
3. Stripe llama al webhook. Se verifica la firma `Stripe-Signature` (HMAC-SHA256 +
   ventana de 300 s contra replays) y **solo entonces** se activa Premium.
4. Los eventos se registran por `event.id`: un reintento de Stripe no duplica nada.
5. `customer.subscription.deleted` quita el plan al terminar el período ya pagado;
   `invoice.payment_failed` mantiene el acceso hasta el vencimiento (período de gracia).

Para añadir otra pasarela (por ejemplo MercadoPago) hay que implementar la interfaz de
`src/payments/index.js` (`createCheckoutSession`, `parseWebhook`, `normalizeEvent`) y
registrarla en `PROVIDERS`. El resto del sistema no cambia.

---

## Pruebas

```bash
npm test        # 42 tests: sesiones, firmas, cuotas, checkout, webhooks, seguridad
npm run check   # sintaxis JS
npm run python:check
```

Los tests usan un script falso en lugar de Python/Instagram, así que no necesitan red
ni credenciales.

---

## Despliegue

### Vercel (Serverless + CDN estático)

`vercel.json` y `api/index.js` enrutan `/api/*` y `/health` a la aplicación Express en
`@vercel/node`, mientras `public/` se sirve desde el CDN. Las descargas públicas usan el
extractor nativo en Node.js y tokens firmados sin estado (`/api/files/s1...`), por lo que
funcionan entre múltiples instancias serverless sin disco compartido.

Variables recomendadas en el dashboard de Vercel: `SESSION_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (y opcionalmente `INSTAGRAM_SESSIONID` para historias/destacados).

### Docker (recomendado para servidor dedicado)

```bash
docker build -t instadown .
docker run -p 3000:3000 --env-file .env \
  -v instadown-data:/app/data -v instadown-files:/app/downloads instadown
```

### Render / Railway

`render.yaml` y `railway.json` ya están configurados para el servicio Node.

1. Variables de entorno: `SESSION_SECRET`, `APP_URL`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`.
2. Disco persistente montado en `DATA_DIR` y `DOWNLOADS_DIR` (sin esto, los planes y las
   cuotas se pierden en cada deploy).
3. Webhook de Stripe apuntando a `https://TU-DOMINIO/api/billing/webhook`, eventos:
   `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
   `invoice.payment_failed`.

### Escalado

El store es un JSON con escritura atómica: sirve para **una instancia**. Con varias
réplicas hace falta una base de datos (Postgres) o un Redis para el estado, porque el
archivo es local al contenedor.

---

## Seguridad

- Sesión anónima firmada (HMAC) en cookie `HttpOnly`; el plan y la cuota se calculan
  siempre en el servidor.
- Webhooks verificados con firma y ventana anti-replay; sin secreto se rechazan (503).
- Solo se publica `public/`: el código fuente ya no es accesible por HTTP.
- CSP estricta (sin `unsafe-inline` para scripts), `nosniff`, `Referrer-Policy`,
  `frame-ancestors 'none'` en producción.
- Validación de URLs de Instagram y de nombres de usuario (bloquea path traversal).
- Archivos descargados accesibles solo por su dueño, con token y caducidad.
- Rate limiting por sesión en descargas y en checkout.

---

## Estructura

```
server.js                 arranque HTTP
src/app.js                composición de Express
src/config.js             configuración desde el entorno
src/routes.js             API
src/payments/             proveedores (stripe, mock, disabled) + firma
src/entitlements.js       planes y cuota diaria
src/store.js              persistencia JSON atómica
src/session.js            cookie de sesión firmada
src/security.js           cabeceras, CORS y rate limit
src/instagram.js          puente al proceso Python
public/                   frontend (index.html, app.js, styles.css)
instagram_downloader.py   CLI de descargas
python_backend.py         backend Flask opcional (legacy)
test/                     pruebas (node:test)
```

`python_backend.py` se mantiene solo como alternativa: **no** gestiona planes ni pagos y
exige `API_KEY` si se expone en producción.

---

## Aviso legal

InstaDown no está asociado con Instagram. Descargá únicamente contenido de cuentas
públicas y respetá los términos de servicio y los derechos de autor.
