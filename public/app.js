'use strict';

/**
 * InstaDown — frontend.
 *
 * Reglas principales:
 *  1. El estado del plan y de la cuota SIEMPRE viene del servidor (`/api/me`).
 *     El cliente no puede "activar" Premium: solo pide un checkout.
 *  2. No se usa `innerHTML` con datos de Instagram sin escapar (evita XSS).
 *  3. Sin `onclick` inline: se usan `data-action`, compatible con la CSP.
 *  4. Las URLs de la API son relativas: funciona en cualquier dominio (local, Docker, Vercel, Render).
 *  5. Detección automática del tipo de entrada (URL de post/reel/historia/perfil vs @usuario)
 *     para que pegar un enlace en la pestaña por defecto (`PERFIL`) funcione sin dar 404.
 */

const API = '';
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const RESERVED_PATHS = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'share',
  'explore',
  'accounts',
  'direct',
  'about',
  'legal',
  'developer',
  'graphql',
  'api',
]);

const state = {
  config: null,
  me: null,
  tab: 'perfil',
  busy: false,
};

const PLACEHOLDERS = {
  perfil: 'Inserta nombre de usuario o enlace (ej: instagram)',
  foto: 'Inserta enlace de la publicación (ej: https://www.instagram.com/p/...)',
  video: 'Inserta enlace del video (ej: https://www.instagram.com/p/...)',
  historias: 'Inserta nombre de usuario o enlace de historia',
  reels: 'Inserta enlace del reel (ej: https://www.instagram.com/reel/...)',
  dp: 'Inserta nombre de usuario',
  destacados: 'Inserta nombre de usuario',
};

class ApiError extends Error {
  constructor(message, status, code, payload) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

function $(selector, root = document) {
  return root.querySelector(selector);
}

function $all(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

/**
 * Acepta URLs http(s) absolutas y rutas relativas del mismo origen (`/api/files/...`),
 * rechazando `javascript:`, `data:` o URLs relativas de protocolo (`//otro.sitio`).
 */
function safeUrl(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw || raw.startsWith('//')) return null;
  try {
    const base = typeof window !== 'undefined' && window.location ? window.location.origin : 'http://localhost';
    const url = new URL(raw, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat('es-AR').format(number) : '—';
}

/**
 * Clasifica la entrada del usuario para enrutar correctamente aunque no haya
 * cambiado manualmente de pestaña.
 */
function classifyInput(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return { kind: 'empty' };

  let maybeUrl = value;
  if (/^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\//i.test(maybeUrl)) {
    maybeUrl = `https://${maybeUrl}`;
  }

  if (/^https?:\/\//i.test(maybeUrl)) {
    try {
      const parsed = new URL(maybeUrl);
      const host = parsed.hostname.toLowerCase();
      const isIg =
        host === 'instagram.com' ||
        host.endsWith('.instagram.com') ||
        host === 'instagr.am' ||
        host.endsWith('.instagr.am');
      if (!isIg) {
        return { kind: 'invalid_url', url: maybeUrl };
      }

      const parts = parsed.pathname.split('/').filter(Boolean);

      if (parts[0]?.toLowerCase() === 'share' && parts.length >= 2) {
        return {
          kind: 'post',
          subtype: parts[1] === 'reel' || parts[1] === 'reels' ? 'reels' : 'foto',
          url: parsed.href,
        };
      }
      if (parts.length >= 2 && ['p', 'reel', 'reels', 'tv'].includes(parts[0])) {
        return {
          kind: 'post',
          subtype: parts[0] === 'p' ? 'foto' : 'reels',
          url: parsed.href,
        };
      }
      if (
        parts.length >= 3 &&
        ['p', 'reel', 'reels', 'tv'].includes(parts[1]) &&
        !RESERVED_PATHS.has(parts[0].toLowerCase()) &&
        USERNAME_RE.test(parts[0])
      ) {
        return {
          kind: 'post',
          subtype: parts[1] === 'p' ? 'foto' : 'reels',
          url: parsed.href,
        };
      }
      if (host.endsWith('instagr.am') && parts.length === 1) {
        return { kind: 'post', subtype: 'foto', url: parsed.href };
      }
      if (parts[0] === 'stories' && parts.length >= 2) {
        if (parts[1] === 'highlights') {
          return { kind: 'highlights_url', url: parsed.href };
        }
        if (USERNAME_RE.test(parts[1])) {
          return { kind: 'stories', username: parts[1] };
        }
      }
      if (parts.length >= 1 && !RESERVED_PATHS.has(parts[0].toLowerCase()) && USERNAME_RE.test(parts[0])) {
        return { kind: 'username', username: parts[0] };
      }

      return { kind: 'invalid_url', url: parsed.href };
    } catch {
      return { kind: 'invalid' };
    }
  }

  const cleanUser = value.replace(/^@/, '');
  if (USERNAME_RE.test(cleanUser)) {
    return { kind: 'username', username: cleanUser };
  }

  return { kind: 'invalid' };
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${API}${path}`, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('No se pudo conectar con el servidor', 0, 'network_error');
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    /* respuesta sin JSON */
  }

  if (!response.ok || payload?.success === false) {
    const fallbackMsg =
      response.status === 404
        ? 'El servicio de descargas no encontró la ruta solicitada (Error 404).'
        : `Error ${response.status}`;
    throw new ApiError(payload?.error || fallbackMsg, response.status, payload?.code, payload);
  }
  return payload;
}

// -----------------------------------------------------------------------------
// Notificaciones y modales
// -----------------------------------------------------------------------------

function notify(message, type = 'info') {
  let container = $('#notificationContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'notificationContainer';
    document.body.appendChild(container);
  }

  const item = document.createElement('div');
  item.className = `notification ${type}`;

  const text = document.createElement('span');
  text.textContent = message; // textContent, no innerHTML

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '×';
  close.setAttribute('aria-label', 'Cerrar');
  close.addEventListener('click', () => item.remove());

  item.append(text, close);
  container.appendChild(item);

  setTimeout(() => {
    item.classList.add('fade-out');
    setTimeout(() => item.remove(), 300);
  }, 4500);
}

function openModal(name) {
  const modal = $(`#${name}Modal`);
  if (!modal) return;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  const focusable = modal.querySelector('button, input, a');
  focusable?.focus?.();
}

function closeModal(name) {
  const modals = name ? [$(`#${name}Modal`)] : $all('.modal');
  modals.filter(Boolean).forEach((modal) => {
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
  });
  document.body.style.overflow = '';
}

// -----------------------------------------------------------------------------
// UI dependiente del estado
// -----------------------------------------------------------------------------

function renderPrice() {
  const price = state.config?.price;
  if (!price) return;
  const amount = (price.amountCents / 100).toFixed(2).replace(/\.00$/, '');
  $all('[data-price-amount]').forEach((node) => {
    node.textContent = `$${amount}`;
  });
  $all('[data-price-full]').forEach((node) => {
    node.textContent = `${price.display}/mes`;
  });
}

function renderPlan() {
  const me = state.me;
  const counter = $('#downloadCount');
  const planLabel = $('#planLabel');

  if (!me) return;

  if (counter) {
    counter.textContent = me.premium ? '∞' : `${me.remainingDownloads}/${me.dailyLimit}`;
  }
  if (planLabel) {
    planLabel.textContent = me.premium ? 'Premium' : 'Gratis';
  }

  const multiple = $('#multipleDownload');
  if (multiple) {
    multiple.classList.toggle('premium-active', Boolean(me.premium));
    const textarea = $('#multipleUrls', multiple);
    if (textarea) textarea.disabled = !me.premium;
    const lockButton = $('[data-action="open-premium"]', multiple);
    if (lockButton) lockButton.hidden = Boolean(me.premium);
    const runButton = $('#multipleButton');
    if (runButton) runButton.hidden = !me.premium;
  }

  // Botón de gestión de suscripción (portal de Stripe) solo si hay cliente.
  const manage = $('#manageSubscription');
  if (manage) {
    const canManage = Boolean(me.subscription?.currentPeriodEnd) && state.config?.provider === 'stripe';
    manage.hidden = !canManage;
  }

  $all('.pricing-card .btn').forEach((button) => {
    if (button.dataset.action === 'open-premium' && me.premium) {
      button.textContent = 'Plan activo';
      button.disabled = true;
    }
  });
}

function renderPremiumModal() {
  const note = $('#checkoutNote');
  const payButton = $('#payButton');
  const emailField = $('#checkoutEmail');
  const enabled = Boolean(state.config?.paymentsEnabled);

  if (note) {
    if (!enabled) {
      note.textContent =
        'Los pagos todavía no están configurados en este servidor. Un administrador debe definir STRIPE_SECRET_KEY y STRIPE_WEBHOOK_SECRET.';
      note.hidden = false;
    } else if (state.config.mockMode) {
      note.textContent =
        'Modo de prueba activo: el pago es simulado y no se cobra ninguna tarjeta. Sirve para validar el flujo.';
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  const hideForm = !enabled || Boolean(state.me?.premium);
  if (payButton) payButton.hidden = hideForm;
  if (emailField) emailField.closest('.form-group').hidden = hideForm;
}

async function loadState() {
  const [config, me] = await Promise.all([api('/api/config'), api('/api/me')]);
  state.config = config.data;
  state.me = me.data;
  renderPrice();
  renderPlan();
  renderPremiumModal();
}

// -----------------------------------------------------------------------------
// Descargas
// -----------------------------------------------------------------------------

function setBusy(busy, label) {
  state.busy = busy;
  const button = $('#downloadButton');
  if (!button) return;
  button.disabled = busy;
  const text = button.querySelector('span');
  if (text) text.textContent = busy ? label || 'Procesando…' : 'Descargar';
}

function currentInput() {
  const input = $('#urlInput');
  return input ? input.value.trim() : '';
}

function activateTabSilently(tabName) {
  const target = $(`.tab[data-tab="${tabName}"]`);
  if (!target) return;
  $all('.tab').forEach((entry) => entry.classList.toggle('active', entry === target));
  state.tab = tabName;
  const input = $('#urlInput');
  if (input) {
    input.placeholder = PLACEHOLDERS[state.tab] || 'Inserta enlace o nombre de usuario';
  }
}

function resolveAction(tab, rawValue) {
  const classified = classifyInput(rawValue);

  // Si el usuario pegó un enlace directo de post/reel/video, siempre descargamos
  // la publicación aunque haya dejado seleccionada la pestaña PERFIL por defecto.
  if (classified.kind === 'post') {
    if (!['foto', 'video', 'reels'].includes(tab)) {
      activateTabSilently(classified.subtype || 'foto');
    }
    return { mode: 'download', path: '/api/download/post', body: { url: classified.url } };
  }

  // Si pegó un enlace de historia `/stories/<usuario>/...`, ir a historias.
  if (classified.kind === 'stories') {
    activateTabSilently('historias');
    return { mode: 'download', path: '/api/download/stories', body: { username: classified.username } };
  }

  if (classified.kind === 'highlights_url') {
    return {
      mode: 'error',
      message: 'Para descargar destacados ingresá el nombre de usuario de la cuenta (ej: instagram).',
    };
  }

  if (classified.kind === 'invalid_url') {
    return {
      mode: 'error',
      message: 'URL inválida: ingresá un enlace válido de instagram.com o un nombre de usuario.',
    };
  }

  if (classified.kind === 'username') {
    const username = classified.username;
    switch (tab) {
      case 'historias':
        return { mode: 'download', path: '/api/download/stories', body: { username } };
      case 'dp':
        return { mode: 'download', path: '/api/download/profile-pic', body: { username } };
      case 'destacados':
        return { mode: 'download', path: '/api/download/highlights', body: { username } };
      case 'perfil':
        return { mode: 'profile', username };
      case 'foto':
      case 'video':
      case 'reels':
        // Si escribió un @usuario estando en FOTO/VÍDEO/REELS, consultamos el perfil
        // en lugar de fallar exigiendo una URL.
        activateTabSilently('perfil');
        return { mode: 'profile', username };
      default:
        return { mode: 'profile', username };
    }
  }

  if (['foto', 'video', 'reels'].includes(tab)) {
    return {
      mode: 'error',
      message: 'Pegá el enlace completo de la publicación o reel de Instagram (ej: https://www.instagram.com/p/...).',
    };
  }

  return {
    mode: 'error',
    message: 'Ingresá un enlace válido de Instagram o un nombre de usuario (ej: @instagram).',
  };
}

function resultsArea() {
  let area = $('#resultsArea');
  if (!area) {
    area = document.createElement('div');
    area.id = 'resultsArea';
    area.className = 'results-area';
    $('.downloader .container')?.appendChild(area);
  }
  return area;
}

function fileList(files) {
  const list = document.createElement('ul');
  list.className = 'file-list';
  files.forEach((file) => {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'btn btn-primary btn-small';
    link.href = safeUrl(file.url) || '#';
    if (file.name) link.setAttribute('download', file.name);
    link.rel = 'noopener';
    const label = file.highlight ? `${file.highlight} — ${file.name}` : file.name;
    link.textContent = file.type === 'video' ? `Descargar video (${label})` : `Descargar (${label})`;
    item.appendChild(link);
    list.appendChild(item);
  });
  return list;
}

function showResults({ title, subtitle, files, extraNodes = [] }) {
  const area = resultsArea();
  const card = document.createElement('div');
  card.className = 'download-result';

  const heading = document.createElement('h3');
  heading.textContent = title;
  card.appendChild(heading);

  if (subtitle) {
    const paragraph = document.createElement('p');
    paragraph.className = 'download-note';
    paragraph.textContent = subtitle;
    card.appendChild(paragraph);
  }

  extraNodes.forEach((node) => card.appendChild(node));
  if (files?.length) card.appendChild(fileList(files));

  area.replaceChildren(card);
  area.style.display = 'block';
}

function showError(message) {
  const area = resultsArea();
  const card = document.createElement('div');
  card.className = 'download-result error';
  const heading = document.createElement('h3');
  heading.textContent = 'No se pudo completar la descarga';
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  card.append(heading, paragraph);
  area.replaceChildren(card);
  area.style.display = 'block';
}

async function handleDownload() {
  if (state.busy) return;

  const value = currentInput();
  if (!value) {
    notify('Ingresá un enlace o un nombre de usuario', 'error');
    return;
  }

  const plan = resolveAction(state.tab, value);
  if (plan.mode === 'error') {
    showError(plan.message);
    notify(plan.message, 'error');
    return;
  }

  setBusy(true);
  try {
    if (plan.mode === 'profile') {
      const info = await api('/api/user', { method: 'POST', body: { username: plan.username } });
      renderProfile(info.data);
      notify('Perfil encontrado', 'success');
      return;
    }

    const result = await api(plan.path, { method: 'POST', body: plan.body });
    applyServerState(result);
    const ttlMin = Math.max(
      1,
      Math.round((new Date(result.data.files[0].expiresAt).getTime() - Date.now()) / 60000),
    );
    showResults({
      title: 'Descarga lista',
      subtitle: `${result.data.files.length} archivo(s) disponible(s). Los enlaces caducan en ${ttlMin} minutos.`,
      files: result.data.files,
      extraNodes: result.data.caption
        ? [Object.assign(document.createElement('p'), { className: 'caption', textContent: result.data.caption })]
        : [],
    });
    notify('Descarga completada', 'success');
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

function handleError(error) {
  if (error instanceof ApiError) {
    if (error.code === 'quota_exceeded' || error.payload?.requiresPremium) {
      renderPlan();
      notify(error.message, 'warning');
      openModal('premium');
      return;
    }
    showError(error.message);
    notify(error.message, 'error');
    return;
  }
  showError('Error inesperado');
  notify('Error inesperado', 'error');
}

/** Sincroniza contador/plan con lo que respondió el servidor. */
function applyServerState(payload) {
  if (!state.me) return;
  if (typeof payload.premium === 'boolean') state.me.premium = payload.premium;
  if (payload.remainingDownloads !== undefined) {
    state.me.remainingDownloads = payload.remainingDownloads;
  }
  renderPlan();
}

function renderProfile(profile) {
  const avatar = safeUrl(profile.avatar_url || profile.profile_pic_url);
  const wrapper = document.createElement('div');
  wrapper.className = 'profile-info';

  if (avatar) {
    const image = document.createElement('img');
    image.src = avatar;
    image.alt = `Foto de perfil de ${profile.username || 'usuario'}`;
    image.className = 'profile-pic';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    wrapper.appendChild(image);
  }

  const details = document.createElement('div');
  details.className = 'profile-details';

  const name = document.createElement('h4');
  name.textContent = profile.full_name || profile.username || '';
  const handle = document.createElement('p');
  handle.className = 'username';
  handle.textContent = `@${profile.username || ''}`;
  const bio = document.createElement('p');
  bio.className = 'bio';
  bio.textContent = profile.biography || '';
  details.append(name, handle, bio);

  const stats = document.createElement('div');
  stats.className = 'stats';
  [
    ['Seguidores', profile.follower_count],
    ['Siguiendo', profile.following_count],
    ['Publicaciones', profile.media_count],
  ].forEach(([label, value]) => {
    const block = document.createElement('div');
    block.className = 'stat';
    const labelNode = document.createElement('span');
    labelNode.className = 'label';
    labelNode.textContent = label;
    const valueNode = document.createElement('span');
    valueNode.className = 'value';
    valueNode.textContent = formatNumber(value);
    block.append(labelNode, valueNode);
    stats.appendChild(block);
  });

  details.appendChild(stats);
  wrapper.appendChild(details);

  const actions = document.createElement('div');
  actions.className = 'profile-actions';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-primary';
  button.textContent = 'Descargar foto de perfil';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api('/api/download/profile-pic', {
        method: 'POST',
        body: { username: profile.username },
      });
      applyServerState(result);
      showResults({ title: 'Foto de perfil descargada', files: result.data.files });
      notify('Descarga completada', 'success');
    } catch (error) {
      handleError(error);
    } finally {
      button.disabled = false;
    }
  });
  actions.appendChild(button);

  showResults({
    title: 'Perfil',
    subtitle: profile.is_private ? 'Esta cuenta es privada: el contenido puede no estar disponible.' : null,
    extraNodes: [wrapper, actions],
  });
}

async function handleMultipleDownload() {
  const textarea = $('#multipleUrls');
  if (!textarea) return;
  if (!state.me?.premium) {
    notify('La descarga múltiple es una función Premium', 'warning');
    openModal('premium');
    return;
  }

  const urls = textarea.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);

  if (urls.length === 0) {
    notify('Pegá al menos un enlace', 'error');
    return;
  }

  const button = $('#multipleButton');
  if (button) button.disabled = true;

  const collected = [];
  try {
    for (const url of urls) {
      try {
        const result = await api('/api/download/post', { method: 'POST', body: { url } });
        collected.push(...result.data.files);
      } catch (error) {
        notify(`${url}: ${error.message}`, 'error');
      }
    }
    if (collected.length) {
      showResults({ title: 'Descargas listas', subtitle: `${collected.length} archivo(s)`, files: collected });
      notify(`${collected.length} archivo(s) descargados`, 'success');
    }
  } finally {
    if (button) button.disabled = false;
  }
}

// -----------------------------------------------------------------------------
// Pagos
// -----------------------------------------------------------------------------

async function startCheckout() {
  const button = $('#payButton');
  if (button) {
    button.disabled = true;
    button.dataset.originalText = button.textContent;
    button.textContent = 'Redirigiendo…';
  }

  try {
    const emailInput = $('#checkoutEmail');
    const email = emailInput?.value.trim() || undefined;
    const result = await api('/api/billing/checkout', { method: 'POST', body: { email } });

    // El cobro se completa en Stripe: el servidor activa Premium al recibir el
    // webhook firmado, nunca antes.
    window.location.assign(safeUrl(result.data.url) || '/');
  } catch (error) {
    handleError(error);
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.originalText || 'Continuar al pago';
    }
  }
}

async function openPortal() {
  try {
    const result = await api('/api/billing/portal', { method: 'POST' });
    window.location.assign(safeUrl(result.data.url) || '/');
  } catch (error) {
    handleError(error);
  }
}

function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('checkout');
  if (!status) return;

  if (status === 'success') {
    notify('Pago recibido. Estamos confirmándolo con la pasarela…', 'info');
    // El webhook puede tardar unos segundos: se reintenta la consulta.
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts += 1;
      try {
        const me = await api('/api/me');
        state.me = me.data;
        renderPlan();
        renderPremiumModal();
        if (me.data.premium) {
          clearInterval(poll);
          notify('¡Premium activado! Ya tenés descargas ilimitadas.', 'success');
        }
      } catch {
        /* se reintenta */
      }
      if (attempts >= 10) clearInterval(poll);
    }, 2000);
  } else if (status === 'cancelled') {
    notify('Pago cancelado. No se cobró nada.', 'warning');
  }

  // Limpia el parámetro para que un refresh no repita el mensaje.
  params.delete('checkout');
  const query = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
}

// -----------------------------------------------------------------------------
// Eventos
// -----------------------------------------------------------------------------

function bindEvents() {
  // Delegación: reemplaza todos los onclick inline.
  document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;

    switch (action) {
      case 'open-premium':
        event.preventDefault();
        openModal('premium');
        break;
      case 'close-modal':
        event.preventDefault();
        closeModal(trigger.dataset.modal);
        break;
      case 'download':
        event.preventDefault();
        handleDownload();
        break;
      case 'multiple-download':
        event.preventDefault();
        handleMultipleDownload();
        break;
      case 'checkout':
        event.preventDefault();
        startCheckout();
        break;
      case 'manage-subscription':
        event.preventDefault();
        openPortal();
        break;
      case 'select-tab':
        event.preventDefault();
        selectTab(trigger);
        break;
      case 'pick-type': {
        event.preventDefault();
        const tab = $(`.tab[data-tab="${trigger.dataset.tab}"]`);
        if (tab) selectTab(tab);
        $('#urlInput')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        break;
      }
      default:
        break;
    }
  });

  $all('.modal').forEach((modal) => {
    modal.addEventListener('click', (event) => {
      if (event.target === modal) closeModal(modal.id.replace(/Modal$/, ''));
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });

  $all('.tab').forEach((tab) => {
    tab.addEventListener('click', () => selectTab(tab));
  });

  $all('.faq-question').forEach((question) => {
    question.addEventListener('click', () => {
      const item = question.parentElement;
      const isActive = item.classList.contains('active');
      $all('.faq-item').forEach((entry) => entry.classList.remove('active'));
      if (!isActive) item.classList.add('active');
    });
  });

  const input = $('#urlInput');
  if (input) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleDownload();
      }
    });
  }

  $('#checkoutForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    startCheckout();
  });
}

function selectTab(tab) {
  $all('.tab').forEach((entry) => entry.classList.toggle('active', entry === tab));
  state.tab = tab.dataset.tab;
  const input = $('#urlInput');
  if (input) {
    input.placeholder = PLACEHOLDERS[state.tab] || 'Inserta enlace o nombre de usuario';
    input.focus();
  }
}

// -----------------------------------------------------------------------------
// Arranque
// -----------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();

  const activeTab = $('.tab.active');
  if (activeTab) state.tab = activeTab.dataset.tab;

  try {
    await loadState();
  } catch (error) {
    notify('No se pudo cargar el estado de la cuenta', 'error');
    console.error(error);
  }

  handleCheckoutReturn();
});
