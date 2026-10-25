# Base44 Dev Environment

## Overview

InstaDown Pro — a Node.js Express app (`server.js`, port 3000) that serves a static
frontend from `public/` (`index.html`, `styles.css`, `app.js`) and a JSON API.
API routes for downloads spawn `python3 instagram_downloader.py` as child processes
to interact with Instagram via the `instagrapi` library.

Payments go through `src/payments/` (Stripe Checkout + signed webhooks). Premium is
only ever granted by a verified webhook or by the simulated provider in development.

A standalone Flask backend (`python_backend.py`, port 5000) exists as a legacy
alternative; it is not used by the main app and has no plans/quota logic.

## Running the app

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

The container (`Dockerfile.base44`) extends `node:22-slim` with Python 3 + pip and
pre-installs `requirements.txt`. On startup it runs `npm install` then
`node --watch server.js` with the source bind-mounted, so edits hot-reload.

Or without Docker:

```bash
npm install && npm run dev
```

## Key details

- **Port 3000** is the only exposed port (frontend + API on the same origin).
- **No external secrets required to boot.** Without Stripe keys the app serves the free
  plan and the checkout returns 503 (fail-closed: it never grants Premium for free).
- `PAYMENTS_PROVIDER=mock` in `docker-compose.base44.yml` simulates a successful
  checkout in development. It is ignored when `NODE_ENV=production`.
- Instagram downloads require either `INSTAGRAM_USERNAME`/`INSTAGRAM_PASSWORD` or fall
  back to anonymous access, which Instagram rate-limits aggressively.
- Health check: `GET /health` → `{"status":"ok", ...}`
- Persistence: `DATA_DIR/store.json` (atomic writes) and `DOWNLOADS_DIR` for artifacts.
  Both default to `./data` and `./downloads`, which are gitignored.
- Tests: `npm test` (node:test, no network needed). They replace Python with a fake
  script via `PYTHON_BIN`.
- `node_modules` is isolated via an anonymous volume; deps are installed on container start.

## Conventions

- Never trust client-provided identity, plan or quota: the session id comes from a
  signed HttpOnly cookie (`src/session.js`).
- Only `public/` is served over HTTP. Never add `express.static(__dirname)`.
- No inline `onclick` in HTML: the CSP forbids inline scripts. Use `data-action`
  attributes handled in `public/app.js`.
- Anything rendered from Instagram data must go through `textContent`/`esc()`.
