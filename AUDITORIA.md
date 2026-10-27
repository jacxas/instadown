# Auditoría del repositorio y del sistema de pagos

Fecha: 2026-10-25 · Rama: `arena/7dd5db21-instadown`

Resumen: el sistema de pagos **no era un sistema de pagos**, era una simulación que
regalaba Premium, y las descargas no funcionaban porque el backend invocaba una CLI de
Python que no existía. Se reescribió la capa de pagos, la sesión, la cuota y la
superficie HTTP; el frontend dejó de decidir el plan.

---

## 1. Hallazgos críticos

### C1 — Cualquiera podía activar Premium sin pagar

```js
// server.js (antes)
app.post('/api/premium/activate', (req, res) => {
    const { userId } = req.body;          // id elegido por el cliente
    limits.premium = true;
    limits.free = Infinity;               // sin pago, sin verificación
});
```

Verificado en ejecución: `POST /api/premium/activate {"userId":"cualquiera"}` devolvía
`{"success":true,"premium":true}`. El modal de pago del frontend (`#premiumModal`) no
enviaba nada: el formulario hacía `preventDefault()` y luego llamaba a ese endpoint.
`script.js` (versión 1) era todavía más directo: `confirm('…Esta es una demostración')`
y `isPremium = true` en el navegador.

**Corregido:** endpoint eliminado (ahora 404). Premium solo se activa desde un webhook
de Stripe con firma válida o, en desarrollo, desde el proveedor simulado. Test:
*«el antiguo endpoint que regalaba Premium ya no existe»*.

### C2 — Todas las descargas devolvían 500

`server.js` hacía `spawn('python3', ['instagram_downloader.py', 'get_user_info', username])`,
pero `instagram_downloader.py` no tenía interfaz de línea de comandos: su bloque
`if __name__ == "__main__"` solo contenía comentarios. La salida era vacía, el `JSON.parse`
fallaba y cada descarga terminaba en 500.

Verificado: `python3 instagram_downloader.py get_user_info instagram` → sin salida, exit 1.

**Corregido:** CLI real con `argparse`, JSON de una línea por stdout, errores a stderr y
código de salida distinto de cero. Además se cambió `decode_media_id` (no existe en
instagrapi 2.x) por `client.media_pk_from_url()`.

### C3 — Los archivos descargados eran públicos y los límites se perdían

- `app.use(express.static(__dirname))` servía todo el repositorio: `/server.js` y
  `/package.json` respondían **200** (verificado).
- Los archivos se servían en `/download/:filename` sin comprobar el dueño: adivinar el
  nombre daba acceso al contenido de otra persona. Además se filtraban rutas absolutas
  del servidor al cliente (`/tmp/instagram_downloads/...`).
- Los usuarios vivían en `new Map()`: cada reinicio devolvía descargas gratis y borraba
  los Premium pagados.

**Corregido:** solo se sirve `public/`; las descargas se entregan con token aleatorio,
ligado a la sesión, con caducidad de 30 minutos y `Content-Disposition: attachment`.
El estado persiste en `DATA_DIR/store.json` con escritura atómica.

### C4 — El precio era incobrable

`$0.25/mes` está por debajo del mínimo de Stripe (**0.50 USD** por cobro). Cualquier
intento de cobro habría fallado con un error de importe mínimo.

**Corregido:** precio de `$1/mes` (`PREMIUM_PRICE_CENTS=100`) y validación al arrancar
el checkout: si el precio configurado es inferior al mínimo de la moneda, el servidor
falla con un mensaje explícito en lugar de intentar el cobro.

> Nota comercial: a $1/mes, la comisión de Stripe (2.9% + $0.30) se lleva ~59% del
> cobro. Un plan anual (~$9.99) tiene mucho mejor margen. Es una decisión de producto,
> no técnica; con `PREMIUM_PRICE_CENTS` se cambia sin tocar código.

---

## 2. Hallazgos altos

| ID | Problema | Estado |
|---|---|---|
| A1 | El frontend llamaba a `https://instadown-backend-th3j.onrender.com`, un backend distinto del repo (y probablemente caído). | Frontend usa rutas relativas del mismo origen. |
| A2 | La identidad del usuario era `localStorage.userId`: se podía suplantar a otro y "resetear" la cuota limpiando el navegador. | Cookie `HttpOnly` firmada con HMAC; el `userId` del body se ignora. |
| A3 | `cors()` abierto: cualquier sitio podía llamar la API con las cookies del visitante. | Mismo origen por defecto; lista blanca opcional por `CORS_ORIGINS` y bloqueo de escrituras cross-origin. |
| A4 | XSS almacenado/reflejado: `innerHTML` con `caption`, `full_name` y `biography` de Instagram. | Todo se renderiza con `textContent` + `esc()`; URLs validadas con `safeUrl()`. |
| A5 | Sin límite de tiempo ni de salida en los procesos Python: una descarga colgada bloqueaba el request y un bucle podía consumir memoria. | Timeout de 90 s con `SIGKILL`, stdout acotado a 2 MB, entorno filtrado (el hijo no ve secretos). |
| A6 | Path traversal en los nombres de archivo: `f"stories_{username}"` con `username` arbitrario de la URL. | Regex `^[A-Za-z0-9._]{1,30}$` validado en Python y en Node; verificación de que la ruta final queda dentro del directorio. |
| A7 | Sin rate limiting: descargas y checkout se podían martillar. | Límites por sesión (20 descargas/min, 5 checkouts/10 min). |
| A8 | Webhooks inexistentes y, por tanto, ninguna fuente de verdad del pago. | `/api/billing/webhook` con verificación de firma, ventana anti-replay de 300 s e idempotencia por `event.id`. |

---

## 3. Hallazgos medios

- **Documentación contradictoria:** `vercel.json` desplegaba `server.js` en serverless
  (que no puede lanzar `python3` ni escribir en disco), mientras Render/Railway/Procfile
  apuntaban a `python_backend.py`, un servicio Flask sin cuotas ni autenticación.
  → `vercel.json` eliminado; Docker/Render/Railway apuntan al mismo servicio Node.
- **`requirements.txt` incompleto:** `python_backend.py` importa `flask` y `flask_cors`,
  que no estaban declarados (el deploy en Render fallaba al importar).
- **`cors` como dependencia innecesaria** en Node: se eliminó.
- **Cuota contradictoria:** la UI prometía "2 descargas por día", el backend daba 2
  descargas *de por vida* y las reponía al reiniciar. → cuota diaria real por día UTC.
- **`Infinity` serializado como `null`:** `/api/user-status` devolvía
  `remainingDownloads: null` para Premium y el frontend mostraba `null/2`.
- **`/tmp` sin limpieza:** las descargas se acumulaban hasta llenar el disco.
  → limpieza periódica por antigüedad.
- **Login/registro falsos:** los formularios "Crear Cuenta" solo mostraban
  "Cuenta creada exitosamente". → eliminados; el plan queda asociado a la sesión anónima
  y el Premium se gestiona desde el portal de Stripe.
- **Fugas en logs:** el manejador de errores devolvía `err.message` al cliente.

---

## 4. Qué se implementó

```
src/payments/stripe.js       Checkout + suscripciones + verificación de firma
src/payments/stripe-client.js  cliente HTTP mínimo (sin SDK)
src/payments/mock.js         proveedor simulado, solo desarrollo
src/payments/apply-event.js  único punto donde se activa/revoca Premium
src/payments/index.js        fábrica + interfaz para añadir MercadoPago
src/entitlements.js          planes, gracia por impago, cuota diaria
src/session.js               cookie HttpOnly firmada (HMAC-SHA256)
src/store.js                 persistencia atómica + idempotencia de eventos
src/security.js              CSP, cabeceras, CORS, rate limit
src/instagram.js             puente al proceso Python con timeout y sandbox de entorno
src/routes.js                API completa
```

Frontend: `public/` (antes en la raíz), `public/app.js` con delegación de eventos,
escape de HTML y checkout real.

Cobertura: **42 tests** (`npm test`) sobre sesiones, firmas, cuotas, checkout simulado,
webhooks (válido, inválido, duplicado, cancelación), exposición de archivos, CORS,
cabeceras y administración.

---

## 5. Pendientes recomendados (no bloqueantes)

1. **Base de datos real** (Postgres) antes de escalar a más de una réplica: el store JSON
   es local al contenedor.
2. **Cuenta de Instagram dedicada y estable**: sin credenciales el acceso anónimo es
   frágil y provoca errores intermitentes. Idealmente con proxy residencial.
3. **Aviso legal y términos**: descargar contenido de terceros tiene implicaciones de
   derechos de autor; el footer ya incluye una nota, pero conviene una página de términos.
4. **Emails transaccionales** (recibo, aviso de impago) desde el dashboard de Stripe.
5. **MercadoPago** si la clientela es argentina: implementar `src/payments/mercadopago.js`
   con la misma interfaz (`createCheckoutSession`, `parseWebhook`, `normalizeEvent`).
6. **Observabilidad**: logs estructurados y alerta si el webhook empieza a fallar (es el
   punto del que depende el ingreso).
7. **Revisar el precio**: $1/mes deja ~41% del ingreso después de comisiones.

---

## 6. Cómo verificar el sistema de pagos end-to-end

```bash
# 1. Tests
npm test

# 2. Arranque en modo simulado
PAYMENTS_PROVIDER=mock SESSION_SECRET=dev npm run dev

# 3. Flujo
curl -c /tmp/c.txt localhost:3000/api/config          # paymentsEnabled: true, mockMode: true
curl -b /tmp/c.txt -X POST localhost:3000/api/billing/checkout   # → { url }
# abrir esa url en el navegador → redirige a /?checkout=success
curl -b /tmp/c.txt localhost:3000/api/me              # premium: true

# 4. Webhook real de Stripe (con la CLI de Stripe)
stripe listen --forward-to localhost:3000/api/billing/webhook
stripe trigger customer.subscription.created
```

Un webhook con firma inválida responde `400 invalid_signature` y **no** modifica el plan
(verificado en tests).
