'use strict';

/**
 * Persistencia mínima en JSON con escritura atómica.
 *
 * Antes los usuarios y los límites vivían en `new Map()`, así que cada reinicio
 * (o cada instancia nueva en un host con varias réplicas) devolvía descargas
 * gratis y perdía los Premium pagados. Esto no reemplaza a una base de datos,
 * pero sí sobrevive reinicios y no añade dependencias nativas.
 */

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const EMPTY_STATE = { version: 1, users: {}, processedEvents: [], updatedAt: null };

function todayKey(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

class JsonStore {
  constructor({ file, now = () => new Date() }) {
    this.file = file;
    this.now = now;
    this.state = structuredClone(EMPTY_STATE);
    this._writing = null;
    this._dirty = false;
  }

  async load() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.state = { ...structuredClone(EMPTY_STATE), ...parsed };
      if (!this.state.users || typeof this.state.users !== 'object') {
        this.state.users = {};
      }
      if (!Array.isArray(this.state.processedEvents)) this.state.processedEvents = [];
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Un archivo corrupto no debe tumbar el servicio: se arranca vacío y se
        // conserva una copia para diagnóstico.
        const backup = `${this.file}.corrupt-${Date.now()}`;
        try {
          await fsp.copyFile(this.file, backup);
        } catch { /* best effort */ }
        console.error(`[store] estado corrupto, copia en ${backup}: ${err.message}`);
      }
      this.state = structuredClone(EMPTY_STATE);
    }
    return this;
  }

  /**
   * Escritura atómica: se escribe a un temporal y se renombra.
   * Se serializa para que dos flush simultáneos no peleen por el mismo archivo.
   */
  async flush() {
    this._flushQueue = (this._flushQueue || Promise.resolve()).then(() => this._flushOnce());
    return this._flushQueue;
  }

  async _flushOnce() {
    this.state.updatedAt = this.now().toISOString();
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const payload = JSON.stringify(this.state, null, 2);
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(tmp, payload, 'utf8');
    await fsp.rename(tmp, this.file);
  }

  /** Agrupa escrituras seguidas para no golpear el disco en cada request. */
  scheduleSave() {
    this._dirty = true;
    if (this._writing) return this._writing;
    this._writing = (async () => {
      while (this._dirty) {
        this._dirty = false;
        await this.flush();
      }
    })().finally(() => {
      this._writing = null;
    });
    return this._writing;
  }

  saveSync() {
    this.state.updatedAt = this.now().toISOString();
    const tmp = `${this.file}.sync.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  getUser(id) {
    return this.state.users[id] || null;
  }

  /**
   * Crea el usuario si no existe y aplica una mutación.
   * `fn` recibe el usuario (mutable) y devuelve el valor a retornar.
   */
  upsertUser(id, fn = () => undefined) {
    const nowIso = this.now().toISOString();
    let user = this.state.users[id];
    if (!user) {
      user = {
        id,
        createdAt: nowIso,
        updatedAt: nowIso,
        plan: 'free',
        premium: null,
        usage: { day: todayKey(this.now()), count: 0 },
        artifacts: [],
      };
      this.state.users[id] = user;
    }
    const result = fn(user);
    user.updatedAt = nowIso;
    this.scheduleSave();
    // Si la mutación no devuelve nada, lo útil es el usuario.
    return result === undefined ? user : result;
  }

  hasProcessedEvent(eventId) {
    return this.state.processedEvents.includes(eventId);
  }

  markProcessedEvent(eventId) {
    // Se conservan los últimos 500 ids para acotar el archivo.
    this.state.processedEvents.push(eventId);
    if (this.state.processedEvents.length > 500) {
      this.state.processedEvents.splice(0, this.state.processedEvents.length - 500);
    }
    this.scheduleSave();
  }

  pruneArtifacts(userId, nowMs = this.now().getTime()) {
    return this.upsertUser(userId, (user) => {
      user.artifacts = (user.artifacts || []).filter((a) => a.expiresAt > nowMs);
      return user.artifacts;
    });
  }
}

module.exports = { JsonStore, todayKey, EMPTY_STATE };
