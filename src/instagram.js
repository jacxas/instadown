'use strict';

/**
 * Orquestador de descargas de Instagram.
 *
 * - En entornos serverless (Vercel) o sin credenciales de Python/instagrapi,
 *   usa el extractor nativo en Node.js (`src/instagram-native.js`), evitando
 *   depender de `python3` ni `instagrapi`.
 * - Si se configura `PYTHON_BIN` (p. ej. en la suite de tests) o se definen
 *   `INSTAGRAM_USERNAME` + `INSTAGRAM_PASSWORD` en un servidor con Python,
 *   ejecuta `instagram_downloader.py` con timeout, entorno filtrado y fallback
 *   automático al extractor nativo.
 */

const { spawn } = require('child_process');
const path = require('path');

const { runNativeInstagramAction, NativeDownloadError } = require('./instagram-native');

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
  'INSTAGRAM_SESSIONID',
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

function runPythonAction(action, argument, { config, outDir, logger = console }) {
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
    } catch {
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
            code: parsed.code || 'instagram_rejected',
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

async function runNativeWrapped(action, argument, { config }) {
  try {
    return await runNativeInstagramAction(action, argument, {
      config,
      fetchImpl: config?.instagram?.fetchImpl || fetch,
    });
  } catch (err) {
    if (err instanceof NativeDownloadError) {
      throw new InstagramError(err.message, {
        status: err.status,
        code: err.code,
        retryable: err.retryable,
      });
    }
    throw new InstagramError('No se pudo completar la operación con Instagram', {
      status: 502,
      code: 'instagram_failed',
      retryable: true,
    });
  }
}

/**
 * Ejecuta una acción del descargador y devuelve sus datos.
 * @param {string} action
 * @param {string} argument
 * @param {{ config: object, outDir: string, logger?: Console }} options
 */
async function runInstagramAction(action, argument, { config, outDir, logger = console }) {
  // 1) Si PYTHON_BIN está definido explícitamente (p. ej. en tests), respetarlo de forma directa.
  if (process.env.PYTHON_BIN) {
    return runPythonAction(action, argument, { config, outDir, logger });
  }

  // 2) Si hay credenciales de usuario/contraseña de Instagram y no estamos en serverless,
  //    intentar primero con Python/instagrapi y usar el extractor Node.js como respaldo.
  const hasPythonCreds = Boolean(config?.instagram?.username && config?.instagram?.password);
  if (hasPythonCreds && !config?.isServerless) {
    try {
      return await runPythonAction(action, argument, { config, outDir, logger });
    } catch (pyErr) {
      logger.warn?.(`[instagram] fallback a extractor nativo Node tras fallo Python: ${pyErr.message}`);
      return runNativeWrapped(action, argument, { config });
    }
  }

  // 3) Por defecto (Vercel serverless, contenedores sin credenciales o ejecución local pura en Node):
  //    usar el extractor nativo en Node.js sin requerir Python ni instagrapi.
  return runNativeWrapped(action, argument, { config });
}

module.exports = { runInstagramAction, runPythonAction, InstagramError, parseResult, buildEnv };
