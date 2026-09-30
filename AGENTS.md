# Base44 Dev Environment

## Overview
InstaDown Pro — a Node.js Express app (`server.js`, port 3000) that serves a static
frontend (`index.html`, `styles.css`, `script.js`) and API routes. The API routes
spawn `python3 instagram_downloader.py` as child processes to interact with Instagram
via the `instagrapi` library.

A standalone Flask backend (`python_backend.py`, port 5000) exists as an alternative
but is not used by the main `server.js` app.

## Running the app
```bash
docker compose -f docker-compose.base44.yml up -d --build
```
The container (`Dockerfile.base44`) extends `node:22-slim` with Python 3 + pip and
pre-installs `requirements.txt`. On startup it runs `npm install` then `nodemon server.js`
with the source bind-mounted, so edits hot-reload.

## Key details
- **Port 3000** is the only exposed port (frontend + API on the same origin).
- **No external secrets required to boot.** The app starts without any credentials.
- Instagram download functionality requires Instagram login credentials at runtime
  (passed to `instagrapi`), but the frontend and API structure load without them.
- Health check: `GET /health` → `{"status":"ok"}`
- `node_modules` is isolated via an anonymous volume; deps are installed on container start.
