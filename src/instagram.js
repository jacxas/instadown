'use strict';

/**
 * Puente hacia instagram_downloader.py.
 *
 * Reglas que antes no existían y causaban fallos y bloqueos:
 *  - timeout: si Instagram no responde, el proceso hijo se mata.
 *  - sin shell: `spawn` con array de argumentos (nada de interpolación).
 *  - entorno filtrado: el hijo no hereda secretos (SESSION_SECRET, STRIPE_*).
 *  - stdout acotado: un bucle infinito no puede llenar la memoria.
 */

const { spawn } = require('child_process');
const path = require('path');

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

/** Mensaje seguro para el cliente; el detalle técnico queda en logs. */
class InstagramError extends Error {
  constructor(message, { status = 502, code = 'instagram_error', retryable = false } = {}) {
    super(message);
    this.name = 'InstagramError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const ALLOWED_ENV = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'PYTHONPATH',
  'PYTHONUNBUFFERED',
  'TMPDIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'INSTAGRAM_USERNAME',
  'INSTAGRAM_PASSWORD',
];

function buildEnv(baseEnv = process.env) {
  const env = {};
  for (const key of ALLOWED_ENV) {
    if (baseEnv[key] !== undefined) env[key] = baseEnv[key];
  }
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONIOENCODING = 'utf-8';
  return env;
}

function parseResult(stdout) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Ejecuta una acción del descargador y devuelve sus datos.
 * @param {string} action
 * @param {string} argument
 * @param {{ config: object, outDir: string, logger?: Console }} options
 */
function runInstagramAction(action, argument, { config, outDir, logger = console }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(config.root, 'instagram_downloader.py');
    const pythonBin = process.env.PYTHON_BIN || 'python3';

    const args = [scriptPath, action, String(argument), '--out-dir', outDir];
    let child;
    try {
      child = spawn(pythonBin, args, {
        cwd: config.root,
        env: buildEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      reject(new InstagramError('No se pudo iniciar el descargador', { status: 500, code: 'spawn_failed' }));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch { /* ya terminó */ }
      finish(
        reject,
        new InstagramError('Instagram tardó demasiado en responder', {
          status: 504,
          code: 'instagram_timeout',
          retryable: true,
        }),
      );
    }, config.instagram.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        try {
          child.kill('SIGKILL');
        } catch { /* noop */ }
        finish(
          reject,
          new InstagramError('Respuesta demasiado grande', { status: 502, code: 'output_too_large' }),
        );
        return;
      }
      stdout += chunk.toString('utf8');
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      logger.error?.(`[instagram] error de spawn: ${err.message}`);
      finish(
        reject,
        new InstagramError('No se pudo iniciar el descargador', { status: 500, code: 'spawn_failed' }),
      );
    });

    child.on('close', (code, signal) => {
      const parsed = parseResult(stdout);

      if (stderr.trim()) {
        logger.warn?.(`[instagram] ${action}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
      }

      if (parsed && parsed.ok === false) {
        return finish(
          reject,
          new InstagramError(parsed.error || 'No se pudo completar la operación', {
            status: 422,
            code: 'instagram_rejected',
          }),
        );
      }

      if (code === 0 && parsed && parsed.ok === true) {
        return finish(resolve, parsed.data);
      }

      logger.error?.(`[instagram] ${action} terminó con code=${code} signal=${signal}`);
      return finish(
        reject,
        new InstagramError('No se pudo completar la operación con Instagram', {
          status: 502,
          code: 'instagram_failed',
          retryable: true,
        }),
      );
    });
  });
}

module.exports = { runInstagramAction, InstagramError, parseResult, buildEnv };
