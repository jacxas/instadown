'use strict';

/**
 * InstaDown — punto de entrada.
 *
 * Responsabilidades de este archivo: cargar configuración, arrancar el servidor
 * HTTP y cerrar ordenadamente. La lógica vive en `src/`.
 */

require('dotenv').config();

const { createApp } = require('./src/app');
const { loadConfig } = require('./src/config');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`✗ Configuración inválida: ${err.message}`);
    process.exit(1);
  }

  const { app, store } = await createApp({ config });

  // 0.0.0.0: necesario para contenedores y para el proxy del entorno de preview.
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n✓ InstaDown escuchando en el puerto ${config.port}`);
    console.log(`  Entorno:   ${config.env}`);
    console.log(`  Pagos:     ${config.payments.provider}`);
    console.log(`  Precio:    ${(config.payments.priceCents / 100).toFixed(2)} ${config.payments.currency.toUpperCase()}/mes`);
    console.log(`  Health:    ${config.appUrl}/health\n`);
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} recibido, cerrando...`);
    server.close(async () => {
      try {
        await store.flush();
      } catch (err) {
        console.error(`✗ No se pudo guardar el estado: ${err.message}`);
      }
      process.exit(0);
    });
    // Si algún cliente mantiene la conexión abierta, no colgar el cierre.
    setTimeout(() => process.exit(0), 8_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`✗ No se pudo iniciar InstaDown: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
