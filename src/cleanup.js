'use strict';

/**
 * Limpieza periódica de archivos descargados.
 *
 * Antes las descargas se acumulaban en /tmp sin límite hasta llenar el disco
 * del contenedor. Ahora cada carpeta de descarga caduca.
 */

const fs = require('fs/promises');
const path = require('path');

async function cleanDownloadsDir(config, logger = console) {
  let entries;
  try {
    entries = await fs.readdir(config.downloadsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn?.(`[cleanup] no se pudo leer downloads: ${err.message}`);
    return 0;
  }

  const cutoff = Date.now() - config.artifactTtlMs;
  let removed = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const target = path.join(config.downloadsDir, entry.name);
    try {
      const stat = await fs.stat(target);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(target, { recursive: true, force: true });
        removed += 1;
      }
    } catch (err) {
      logger.warn?.(`[cleanup] ${target}: ${err.message}`);
    }
  }
  return removed;
}

function installCleanup({ config, store, logger = console }) {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await cleanDownloadsDir(config, logger);
      if (removed > 0) logger.info?.(`[cleanup] ${removed} carpeta(s) de descargas eliminadas`);

      const now = Date.now();
      let prunedUsers = 0;
      for (const user of Object.values(store.state.users)) {
        if (Array.isArray(user.artifacts) && user.artifacts.some((a) => a.expiresAt <= now)) {
          user.artifacts = user.artifacts.filter((a) => a.expiresAt > now);
          prunedUsers += 1;
        }
      }
      if (prunedUsers > 0) await store.scheduleSave();
    } catch (err) {
      logger.error?.(`[cleanup] ${err.message}`);
    } finally {
      running = false;
    }
  };

  const intervalMs = Math.min(Math.max(config.artifactTtlMs / 2, 5 * 60_000), 60 * 60_000);
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  // Una pasada al arrancar evita arrastrar basura de un proceso anterior.
  timer.unref?.();
  setImmediate(run);

  return { run, timer };
}

module.exports = { installCleanup, cleanDownloadsDir };
