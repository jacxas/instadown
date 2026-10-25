# Imagen de producción: Node sirve la web y la API, Python ejecuta el descargador.
FROM node:22-slim

# Python es necesario porque server.js lo invoca como proceso hijo.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias primero (mejor caché de capas).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Código
COPY server.js ./
COPY instagram_downloader.py ./
COPY src ./src
COPY public ./public

# El store JSON y las descargas necesitan escritura: usuario sin privilegios.
RUN mkdir -p /app/data /app/downloads \
    && chown -R node:node /app/data /app/downloads
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    DOWNLOADS_DIR=/app/downloads

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
