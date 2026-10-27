'use strict';

/**
 * Extractor nativo de Instagram en Node.js (sin depender de Python ni instagrapi).
 *
 * Permite que InstaDown funcione tanto en entornos serverless (Vercel) como en
 * contenedores o desarrollo local sin paquetes de Python instalados.
 *
 * Estrategias en cascada para contenido público:
 *  1. GraphQL web de Instagram (`POST /graphql/query`)
 *  2. Página embed (`/p/<shortcode>/embed/captioned/` y `/<username>/embed/`)
 *  3. JSON embebido / etiquetas OpenGraph de la página pública
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IG_WEB_APP_ID = '936619743392459';
const DEFAULT_LSD = 'AVqbxe3J_YA';

const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
const SHORTCODE_RE = /^[A-Za-z0-9_-]{5,64}$/;

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

class NativeDownloadError extends Error {
  constructor(message, { status = 422, code = 'instagram_rejected', retryable = false } = {}) {
    super(message);
    this.name = 'NativeDownloadError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function isInstagramHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return (
    host === 'instagram.com' ||
    host.endsWith('.instagram.com') ||
    host === 'instagr.am' ||
    host.endsWith('.instagr.am')
  );
}

/**
 * Valida que una URL apunte estrictamente al CDN de medios de Instagram/Meta.
 * Evita SSRF al hacer streaming de archivos en `/api/files/:token`.
 */
function isAllowedInstagramCdnUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    // Bloquear literales IP o localhost
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':') || host === 'localhost') {
      return false;
    }
    return (
      host.endsWith('.cdninstagram.com') ||
      host === 'cdninstagram.com' ||
      host.endsWith('.fbcdn.net') ||
      host === 'fbcdn.net'
    );
  } catch {
    return false;
  }
}

/**
 * Normaliza enlaces pegados sin esquema (ej. `instagram.com/reel/ABC` o `www.instagram.com/p/ABC`).
 */
function normalizeInstagramUrl(raw) {
  if (typeof raw !== 'string') return null;
  let trimmed = raw.trim();
  if (!trimmed || trimmed.length > 500) return null;

  if (/^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!isInstagramHost(url.hostname)) return null;
    url.protocol = 'https:';
    return url;
  } catch {
    return null;
  }
}

/**
 * Clasifica cualquier entrada del usuario (URL de post/reel, historia, perfil o @username).
 */
function classifyInstagramInput(raw) {
  if (typeof raw !== 'string') return { kind: 'invalid' };
  const value = raw.trim();
  if (!value || value.length > 500) return { kind: 'invalid' };

  const url = normalizeInstagramUrl(value);
  if (url) {
    const segments = url.pathname.split('/').filter(Boolean);

    // /share/p/CODE, /share/reel/CODE, /share/CODE (debe evaluarse antes que /<user>/reel/CODE)
    if (segments[0]?.toLowerCase() === 'share' && segments.length >= 2) {
      return {
        kind: 'post',
        subtype: segments[1] === 'reel' || segments[1] === 'reels' ? 'reel' : 'post',
        shortcode: null,
        shareUrl: url.href,
        url: url.href,
      };
    }

    // /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE o /<user>/p/CODE, /<user>/reel/CODE
    if (segments.length >= 2 && ['p', 'reel', 'reels', 'tv'].includes(segments[0])) {
      const subtype = segments[0] === 'p' ? 'post' : 'reel';
      const shortcode = segments[1];
      if (SHORTCODE_RE.test(shortcode)) {
        return {
          kind: 'post',
          subtype,
          shortcode,
          url: `https://www.instagram.com/${segments[0] === 'reels' ? 'reel' : segments[0]}/${shortcode}/`,
        };
      }
    }

    if (
      segments.length >= 3 &&
      ['p', 'reel', 'reels', 'tv'].includes(segments[1]) &&
      !RESERVED_PATHS.has(segments[0].toLowerCase()) &&
      USERNAME_RE.test(segments[0])
    ) {
      const subtype = segments[1] === 'p' ? 'post' : 'reel';
      const shortcode = segments[2];
      if (SHORTCODE_RE.test(shortcode)) {
        return {
          kind: 'post',
          subtype,
          shortcode,
          url: `https://www.instagram.com/${segments[1] === 'reels' ? 'reel' : segments[1]}/${shortcode}/`,
        };
      }
    }

    // instagr.am/<shortcode>
    if (url.hostname.toLowerCase().endsWith('instagr.am') && segments.length === 1 && SHORTCODE_RE.test(segments[0])) {
      return {
        kind: 'post',
        subtype: 'post',
        shortcode: segments[0],
        url: `https://www.instagram.com/p/${segments[0]}/`,
      };
    }

    // /stories/highlights/<id> o /stories/<username>/<story_id?>
    if (segments[0] === 'stories' && segments.length >= 2) {
      if (segments[1] === 'highlights') {
        return { kind: 'highlights_url', highlightId: segments[2] || null, url: url.href };
      }
      if (USERNAME_RE.test(segments[1])) {
        return { kind: 'stories', username: segments[1], storyId: segments[2] || null, url: url.href };
      }
    }

    // /<username>/ (perfil)
    if (segments.length >= 1 && !RESERVED_PATHS.has(segments[0].toLowerCase()) && USERNAME_RE.test(segments[0])) {
      return { kind: 'username', username: segments[0] };
    }

    return { kind: 'invalid' };
  }

  const candidate = value.replace(/^@/, '');
  if (USERNAME_RE.test(candidate)) {
    return { kind: 'username', username: candidate };
  }

  return { kind: 'invalid' };
}

function unescapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x3D;/gi, '=')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function stripForLoopPrefix(text) {
  return String(text || '').replace(/^for\s*\(;;\);\s*/, '');
}

function baseHeaders(extra = {}, sessionId = '') {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
    'Accept-Language': 'es-AR,es;q=0.9,en-US;q=0.8,en;q=0.7',
    ...extra,
  };
  if (sessionId) {
    headers.Cookie = `sessionid=${sessionId}`;
  }
  return headers;
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resuelve enlaces `/share/...` o `instagr.am/...` siguiendo únicamente
 * redirecciones dentro de dominios de Instagram.
 */
async function resolvePostShortcode(rawUrl, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const initial = classifyInstagramInput(rawUrl);
  if (initial.kind === 'post' && initial.shortcode) {
    return { shortcode: initial.shortcode, canonicalUrl: initial.url };
  }
  if (initial.kind !== 'post' || !initial.shareUrl) {
    throw new NativeDownloadError('No se pudo interpretar la URL de la publicación. Usá un enlace /p/ o /reel/ de Instagram.');
  }

  let current = initial.shareUrl;
  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetchWithTimeout(
      fetchImpl,
      current,
      {
        method: 'GET',
        redirect: 'manual',
        headers: baseHeaders({ Accept: 'text/html,application/xhtml+xml' }),
      },
      timeoutMs,
    );

    const location = response.headers.get('location');
    if (!location) break;

    const nextUrl = new URL(location, current);
    if (!isInstagramHost(nextUrl.hostname)) {
      throw new NativeDownloadError('Redirección externa no permitida');
    }

    const classified = classifyInstagramInput(nextUrl.href);
    if (classified.kind === 'post' && classified.shortcode) {
      return { shortcode: classified.shortcode, canonicalUrl: classified.url };
    }
    current = nextUrl.href;
  }

  throw new NativeDownloadError('No se pudo resolver el enlace compartido de Instagram');
}

function pickBestImage(node) {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node.display_resources) && node.display_resources.length > 0) {
    const sorted = [...node.display_resources]
      .filter((r) => r && typeof r.src === 'string')
      .sort((a, b) => (b.config_width || 0) - (a.config_width || 0));
    if (sorted[0]?.src) return sorted[0].src;
  }

  if (Array.isArray(node.image_versions2?.candidates) && node.image_versions2.candidates.length > 0) {
    const sorted = [...node.image_versions2.candidates]
      .filter((c) => c && typeof c.url === 'string')
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    if (sorted[0]?.url) return sorted[0].url;
  }

  if (typeof node.display_url === 'string' && node.display_url) return node.display_url;
  if (typeof node.thumbnail_src === 'string' && node.thumbnail_src) return node.thumbnail_src;
  return null;
}

function pickBestVideo(node) {
  if (!node || typeof node !== 'object') return null;

  if (Array.isArray(node.video_versions) && node.video_versions.length > 0) {
    const sorted = [...node.video_versions]
      .filter((v) => v && typeof v.url === 'string')
      .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
    if (sorted[0]?.url) return sorted[0].url;
  }

  if (typeof node.video_url === 'string' && node.video_url) return node.video_url;
  return null;
}

function isVideoNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (node.is_video === true || node.media_type === 2) return true;
  if (typeof node.__typename === 'string' && node.__typename.toLowerCase().includes('video')) return true;
  if (Array.isArray(node.video_versions) && node.video_versions.length > 0) return true;
  return Boolean(node.video_url);
}

/**
 * Convierte un nodo `shortcode_media` / `xdt_shortcode_media` / `items[0]` en
 * la estructura normalizada de InstaDown.
 */
function extractFromMediaObject(media, shortcode = 'post') {
  if (!media || typeof media !== 'object') return null;

  const sidecarChildren =
    media.edge_sidecar_to_children?.edges?.map((edge) => edge?.node).filter(Boolean) ||
    (Array.isArray(media.carousel_media) ? media.carousel_media : null);

  const items = [];
  let kind = 'photo';

  if (sidecarChildren && sidecarChildren.length > 0) {
    kind = 'carousel';
    sidecarChildren.forEach((child, idx) => {
      const num = String(idx + 1).padStart(2, '0');
      if (isVideoNode(child)) {
        const videoUrl = pickBestVideo(child);
        if (videoUrl && isAllowedInstagramCdnUrl(videoUrl)) {
          items.push({ remoteUrl: videoUrl, type: 'video', name: `${shortcode}_${num}.mp4` });
        }
      } else {
        const imgUrl = pickBestImage(child);
        if (imgUrl && isAllowedInstagramCdnUrl(imgUrl)) {
          items.push({ remoteUrl: imgUrl, type: 'photo', name: `${shortcode}_${num}.jpg` });
        }
      }
    });
  } else if (isVideoNode(media)) {
    kind = 'video';
    const videoUrl = pickBestVideo(media);
    if (videoUrl && isAllowedInstagramCdnUrl(videoUrl)) {
      items.push({ remoteUrl: videoUrl, type: 'video', name: `${shortcode}.mp4` });
    }
  } else {
    kind = 'photo';
    const imgUrl = pickBestImage(media);
    if (imgUrl && isAllowedInstagramCdnUrl(imgUrl)) {
      items.push({ remoteUrl: imgUrl, type: 'photo', name: `${shortcode}.jpg` });
    }
  }

  if (items.length === 0) return null;

  const caption =
    media.edge_media_to_caption?.edges?.[0]?.node?.text ??
    media.caption?.text ??
    media.caption_text ??
    (typeof media.caption === 'string' ? media.caption : '');

  const likes =
    media.edge_media_preview_like?.count ??
    media.edge_liked_by?.count ??
    media.like_count ??
    0;

  const comments =
    media.edge_media_to_parent_comment?.count ??
    media.edge_media_to_comment?.count ??
    media.comment_count ??
    0;

  const username = media.owner?.username ?? media.user?.username ?? '';

  return {
    type: kind,
    items,
    caption: String(caption || ''),
    likes: Math.max(0, Number(likes) || 0),
    comments: Math.max(0, Number(comments) || 0),
    ...(username ? { username } : {}),
  };
}

/**
 * Busca recursivamente un objeto de media de Instagram dentro de estructuras SJS JSON.
 */
function findMediaNodeDeep(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;

  if (node.xdt_shortcode_media && typeof node.xdt_shortcode_media === 'object') {
    return node.xdt_shortcode_media;
  }
  if (node.shortcode_media && typeof node.shortcode_media === 'object') {
    return node.shortcode_media;
  }
  if (Array.isArray(node.xdt_api__v1__media__shortcode__web_info?.items)) {
    const first = node.xdt_api__v1__media__shortcode__web_info.items[0];
    if (first) return first;
  }
  if (
    (node.video_url || node.display_url || node.video_versions || node.image_versions2) &&
    (node.shortcode || node.code || node.pk || node.id)
  ) {
    return node;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findMediaNodeDeep(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findMediaNodeDeep(value, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Estrategia 1: GraphQL Web Query (`PolarisPostActionLoadPostQueryQuery`).
 */
async function tryGraphqlPost(shortcode, { fetchImpl, timeoutMs, sessionId }) {
  const docIds = ['8845758582119845', '10015901848480474'];
  const referer = `https://www.instagram.com/p/${shortcode}/`;

  for (const docId of docIds) {
    const variables = JSON.stringify({
      shortcode,
      fetch_comment_count: 2,
      fetch_related_profile_media_count: 0,
      parent_comment_count: 0,
      child_comment_count: 0,
      fetch_like_count: 10,
      fetch_tagged_user_count: null,
      fetch_preview_comment_count: 2,
      has_threaded_comments: true,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    });

    const body = new URLSearchParams({
      av: '0',
      __d: 'www',
      __user: '0',
      __a: '1',
      __req: '1',
      dpr: '1',
      __ccg: 'UNKNOWN',
      lsd: DEFAULT_LSD,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'PolarisPostActionLoadPostQueryQuery',
      variables,
      server_timestamps: 'true',
      doc_id: docId,
    }).toString();

    const response = await fetchWithTimeout(
      fetchImpl,
      'https://www.instagram.com/graphql/query',
      {
        method: 'POST',
        headers: baseHeaders(
          {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-IG-App-ID': IG_WEB_APP_ID,
            'X-FB-LSD': DEFAULT_LSD,
            'X-ASBD-ID': '129477',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: 'https://www.instagram.com',
            Referer: referer,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          sessionId,
        ),
        body,
      },
      timeoutMs,
    );

    if (!response.ok) continue;
    const raw = stripForLoopPrefix(await response.text());
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const media = parsed?.data?.xdt_shortcode_media || parsed?.data?.shortcode_media;
    if (media === null && parsed?.data && ('xdt_shortcode_media' in parsed.data || 'shortcode_media' in parsed.data)) {
      throw new NativeDownloadError(
        'La publicación no existe, fue eliminada o pertenece a una cuenta privada.',
        { status: 422, code: 'instagram_not_found' },
      );
    }

    const extracted = extractFromMediaObject(media, shortcode);
    if (extracted) return extracted;
  }

  return null;
}

function parseEmbedHtml(html, shortcode) {
  if (!html || typeof html !== 'string') return null;

  // 1) contextJSON embebido en el script del embed
  const ctxMatch = html.match(/"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/);
  let embedIsVideo = false;
  if (ctxMatch) {
    try {
      const jsonStr = JSON.parse(ctxMatch[1]);
      const ctxData = JSON.parse(jsonStr);
      const media =
        ctxData?.gql_data?.shortcode_media ||
        ctxData?.gql_data?.xdt_shortcode_media ||
        ctxData?.context?.media;
      if (media?.is_video || ctxData?.context?.is_video) embedIsVideo = true;
      const extracted = extractFromMediaObject(media, shortcode);
      if (extracted && (!embedIsVideo || extracted.items.some((i) => i.type === 'video'))) {
        return extracted;
      }
    } catch {
      /* continúa al fallback HTML */
    }
  }

  // 2) window.__additionalDataLoaded(...)
  const addMatch = html.match(/window\.__additionalDataLoaded\s*\([^,]+,\s*(\{[\s\S]*?\})\s*\)\s*;/);
  if (addMatch) {
    try {
      const addData = JSON.parse(addMatch[1]);
      const media = addData?.shortcode_media || addData?.graphql?.shortcode_media || findMediaNodeDeep(addData);
      const extracted = extractFromMediaObject(media, shortcode);
      if (extracted) return extracted;
    } catch {
      /* continúa */
    }
  }

  if (/EmbedVideo|SpritePlayButton|videoSpritePlayButton/i.test(html)) {
    embedIsVideo = true;
  }

  // 3) Etiqueta <video class="EmbeddedMediaVideo" ... src="...">
  const videoTag = html.match(/<video\b[^>]*class="[^"]*EmbeddedMediaVideo[^"]*"[^>]*>/i);
  if (videoTag) {
    const srcMatch = videoTag[0].match(/\bsrc="([^"]+)"/i);
    const videoUrl = unescapeHtml(srcMatch?.[1]);
    if (videoUrl && isAllowedInstagramCdnUrl(videoUrl)) {
      const captionMatch = html.match(/<div\b[^>]*class="[^"]*Caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const plainCaption = captionMatch
        ? unescapeHtml(captionMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        : '';
      return {
        type: 'video',
        items: [{ remoteUrl: videoUrl, type: 'video', name: `${shortcode}.mp4` }],
        caption: plainCaption,
        likes: 0,
        comments: 0,
      };
    }
  }

  // Si es un vídeo pero el embed HTML solo contiene el póster JPG, dejamos que
  // la siguiente estrategia busque el MP4 antes de conformarnos con la portada.
  if (embedIsVideo) return null;

  // 4) Etiqueta <img class="EmbeddedMediaImage" ...>
  const imgTag = html.match(/<img\b[^>]*class="[^"]*EmbeddedMediaImage[^"]*"[^>]*>/i);
  if (imgTag) {
    let bestUrl = null;
    const srcsetMatch = imgTag[0].match(/\bsrcset="([^"]+)"/i);
    if (srcsetMatch) {
      const candidates = unescapeHtml(srcsetMatch[1])
        .split(',')
        .map((entry) => {
          const parts = entry.trim().split(/\s+/);
          const url = parts[0];
          const width = Number.parseInt(parts[1], 10) || 0;
          return { url, width };
        })
        .filter((c) => isAllowedInstagramCdnUrl(c.url))
        .sort((a, b) => b.width - a.width);
      if (candidates[0]) bestUrl = candidates[0].url;
    }

    if (!bestUrl) {
      const srcMatch = imgTag[0].match(/\bsrc="([^"]+)"/i);
      const candidate = unescapeHtml(srcMatch?.[1]);
      if (isAllowedInstagramCdnUrl(candidate)) bestUrl = candidate;
    }

    if (bestUrl) {
      const captionMatch = html.match(/<div\b[^>]*class="[^"]*Caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const plainCaption = captionMatch
        ? unescapeHtml(captionMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
        : '';
      return {
        type: 'photo',
        items: [{ remoteUrl: bestUrl, type: 'photo', name: `${shortcode}.jpg` }],
        caption: plainCaption,
        likes: 0,
        comments: 0,
      };
    }
  }

  return null;
}

/**
 * Estrategia 2: Página `/p/<shortcode>/embed/captioned/`.
 */
async function tryEmbedPost(shortcode, { fetchImpl, timeoutMs, sessionId }) {
  const url = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: baseHeaders(
        {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.instagram.com/',
        },
        sessionId,
      ),
    },
    timeoutMs,
  );

  if (response.status === 404) {
    throw new NativeDownloadError('La publicación no existe o fue eliminada.', {
      status: 422,
      code: 'instagram_not_found',
    });
  }
  if (!response.ok) return null;

  const html = await response.text();
  if (/EmbedIsBroken|contenido no está disponible|content isn't available/i.test(html)) {
    throw new NativeDownloadError(
      'Esta publicación no está disponible o pertenece a una cuenta privada.',
      { status: 422, code: 'instagram_private_or_unavailable' },
    );
  }

  return parseEmbedHtml(html, shortcode);
}

function parseMetaProperty(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re1 = new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i');
  const m1 = html.match(re1);
  if (m1) return unescapeHtml(m1[1]);
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escaped}["']`, 'i');
  const m2 = html.match(re2);
  return m2 ? unescapeHtml(m2[1]) : null;
}

/**
 * Estrategia 3: Página pública `/p/<shortcode>/` (bloques JSON SJS + OpenGraph).
 */
async function tryPagePost(shortcode, { fetchImpl, timeoutMs, sessionId }) {
  const url = `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: baseHeaders(
        {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        sessionId,
      ),
    },
    timeoutMs,
  );

  if (response.status === 404) {
    throw new NativeDownloadError('La publicación no existe o fue eliminada.', {
      status: 422,
      code: 'instagram_not_found',
    });
  }
  if (!response.ok) return null;

  const html = await response.text();

  // Bloques <script type="application/json"> de Relay/SJS
  const scriptRe = /<script\b[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const content = match[1];
    if (
      !content.includes('shortcode_media') &&
      !content.includes('video_versions') &&
      !content.includes('image_versions2')
    ) {
      continue;
    }
    try {
      const parsed = JSON.parse(content);
      const media = findMediaNodeDeep(parsed);
      const extracted = extractFromMediaObject(media, shortcode);
      if (extracted) return extracted;
    } catch {
      /* continúa */
    }
  }

  // Respaldo con etiquetas OpenGraph
  const ogVideo = parseMetaProperty(html, 'og:video:secure_url') || parseMetaProperty(html, 'og:video');
  if (ogVideo && isAllowedInstagramCdnUrl(ogVideo)) {
    const desc = parseMetaProperty(html, 'og:description') || '';
    return {
      type: 'video',
      items: [{ remoteUrl: ogVideo, type: 'video', name: `${shortcode}.mp4` }],
      caption: desc,
      likes: 0,
      comments: 0,
    };
  }

  const ogImage = parseMetaProperty(html, 'og:image');
  if (ogImage && isAllowedInstagramCdnUrl(ogImage)) {
    // Evitar el ícono estático genérico de Instagram cuando pide login
    if (!ogImage.includes('rsrc.php') && !ogImage.includes('instagram_logo')) {
      const desc = parseMetaProperty(html, 'og:description') || '';
      return {
        type: 'photo',
        items: [{ remoteUrl: ogImage, type: 'photo', name: `${shortcode}.jpg` }],
        caption: desc,
        likes: 0,
        comments: 0,
      };
    }
  }

  return null;
}

async function nativeDownloadPost(url, options) {
  const { shortcode } = await resolvePostShortcode(url, options);

  const strategies = [tryGraphqlPost, tryEmbedPost, tryPagePost];
  let lastError = null;

  for (const strategy of strategies) {
    try {
      const result = await strategy(shortcode, options);
      if (result && Array.isArray(result.items) && result.items.length > 0) {
        return result;
      }
    } catch (err) {
      if (err instanceof NativeDownloadError) {
        throw err;
      }
      lastError = err;
    }
  }

  if (lastError?.name === 'AbortError') {
    throw new NativeDownloadError('Instagram tardó demasiado en responder. Intentá nuevamente.', {
      status: 504,
      code: 'instagram_timeout',
      retryable: true,
    });
  }

  throw new NativeDownloadError(
    'No se pudo obtener el contenido de la publicación. Verificá que la cuenta sea pública y el enlace sea válido.',
    { status: 502, code: 'instagram_unavailable', retryable: true },
  );
}

function parseCountToken(raw) {
  if (!raw) return 0;
  const cleaned = String(raw).trim().replace(/,/g, '');
  const match = cleaned.match(/^([\d.]+)\s*([KMBkmb]|mil|millones)?$/i);
  if (!match) {
    const digits = Number.parseInt(cleaned.replace(/\D+/g, ''), 10);
    return Number.isFinite(digits) ? digits : 0;
  }
  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num)) return 0;
  const unit = (match[2] || '').toLowerCase();
  if (unit === 'k' || unit === 'mil') return Math.round(num * 1_000);
  if (unit === 'm' || unit === 'millones') return Math.round(num * 1_000_000);
  if (unit === 'b') return Math.round(num * 1_000_000_000);
  return Math.round(num);
}

async function tryWebProfileInfo(username, { fetchImpl, timeoutMs, sessionId }) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: baseHeaders(
        {
          'X-IG-App-ID': IG_WEB_APP_ID,
          'X-ASBD-ID': '129477',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
        },
        sessionId,
      ),
    },
    timeoutMs,
  );

  if (response.status === 404) {
    throw new NativeDownloadError(`El usuario @${username} no existe en Instagram.`, {
      status: 422,
      code: 'instagram_user_not_found',
    });
  }
  if (!response.ok) return null;

  const raw = stripForLoopPrefix(await response.text());
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const user = parsed?.data?.user;
  if (!user) {
    if (parsed?.data && parsed.data.user === null) {
      throw new NativeDownloadError(`El usuario @${username} no existe en Instagram.`, {
        status: 422,
        code: 'instagram_user_not_found',
      });
    }
    return null;
  }

  return {
    id: String(user.id || user.pk || ''),
    username: user.username || username,
    full_name: user.full_name || '',
    biography: user.biography || '',
    follower_count: user.edge_followed_by?.count ?? user.follower_count ?? 0,
    following_count: user.edge_follow?.count ?? user.following_count ?? 0,
    media_count: user.edge_owner_to_timeline_media?.count ?? user.media_count ?? 0,
    profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url || '',
    is_private: Boolean(user.is_private),
  };
}

async function tryEmbedProfile(username, { fetchImpl, timeoutMs, sessionId }) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/embed/`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: baseHeaders(
        {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.instagram.com/',
        },
        sessionId,
      ),
    },
    timeoutMs,
  );

  if (response.status === 404) {
    throw new NativeDownloadError(`El usuario @${username} no existe en Instagram.`, {
      status: 422,
      code: 'instagram_user_not_found',
    });
  }
  if (!response.ok) return null;

  const html = await response.text();
  const ctxMatch = html.match(/"contextJSON"\s*:\s*("(?:\\.|[^"\\])*")/);
  if (ctxMatch) {
    try {
      const ctxData = JSON.parse(JSON.parse(ctxMatch[1]));
      const user = ctxData?.context?.graphql_user || ctxData?.context?.user || ctxData?.gql_data?.user;
      if (user) {
        return {
          id: String(user.id || user.pk || ''),
          username: user.username || username,
          full_name: user.full_name || '',
          biography: user.biography || '',
          follower_count: user.edge_followed_by?.count ?? user.followers_count ?? user.follower_count ?? 0,
          following_count: user.edge_follow?.count ?? user.following_count ?? 0,
          media_count: user.edge_owner_to_timeline_media?.count ?? user.media_count ?? 0,
          profile_pic_url: user.profile_pic_url_hd || user.profile_pic_url || '',
          is_private: Boolean(user.is_private),
        };
      }
    } catch {
      /* continúa */
    }
  }

  return null;
}

async function tryPageProfile(username, { fetchImpl, timeoutMs, sessionId }) {
  const url = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: baseHeaders(
        {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        sessionId,
      ),
    },
    timeoutMs,
  );

  if (response.status === 404) {
    throw new NativeDownloadError(`El usuario @${username} no existe en Instagram.`, {
      status: 422,
      code: 'instagram_user_not_found',
    });
  }
  if (!response.ok) return null;

  const html = await response.text();
  const ogImage = parseMetaProperty(html, 'og:image') || '';
  const ogTitle = parseMetaProperty(html, 'og:title') || '';
  const ogDesc = parseMetaProperty(html, 'og:description') || '';

  if (!ogTitle && (!ogImage || ogImage.includes('rsrc.php'))) {
    return null;
  }

  const nameMatch = ogTitle.match(/^(.+?)\s*\(@[A-Za-z0-9._]+\)/);
  const followersMatch = ogDesc.match(/([\d.,]+\s*(?:[KMBkmb]|mil|millones)?)\s+(?:Followers|seguidores)/i);
  const followingMatch = ogDesc.match(/([\d.,]+\s*(?:[KMBkmb]|mil|millones)?)\s+(?:Following|seguidos)/i);
  const postsMatch = ogDesc.match(/([\d.,]+\s*(?:[KMBkmb]|mil|millones)?)\s+(?:Posts|publicaciones)/i);

  return {
    id: '',
    username,
    full_name: nameMatch ? nameMatch[1].trim() : username,
    biography: '',
    follower_count: followersMatch ? parseCountToken(followersMatch[1]) : 0,
    following_count: followingMatch ? parseCountToken(followingMatch[1]) : 0,
    media_count: postsMatch ? parseCountToken(postsMatch[1]) : 0,
    profile_pic_url: isAllowedInstagramCdnUrl(ogImage) ? ogImage : '',
    is_private: false,
  };
}

async function nativeGetUserInfo(rawUsername, options) {
  const classified = classifyInstagramInput(rawUsername);
  const username = classified.kind === 'username' ? classified.username : String(rawUsername || '').trim().replace(/^@/, '');
  if (!USERNAME_RE.test(username)) {
    throw new NativeDownloadError('Nombre de usuario inválido', { status: 400, code: 'invalid_username' });
  }

  const strategies = [tryWebProfileInfo, tryEmbedProfile, tryPageProfile];
  for (const strategy of strategies) {
    try {
      const info = await strategy(username, options);
      if (info && info.username) return info;
    } catch (err) {
      if (err instanceof NativeDownloadError) throw err;
    }
  }

  throw new NativeDownloadError(
    `No se pudo consultar el perfil @${username} en este momento. Verificá que el usuario exista y sea público.`,
    { status: 502, code: 'instagram_profile_unavailable', retryable: true },
  );
}

async function nativeDownloadProfilePic(rawUsername, options) {
  const info = await nativeGetUserInfo(rawUsername, options);
  if (!info.profile_pic_url || !isAllowedInstagramCdnUrl(info.profile_pic_url)) {
    throw new NativeDownloadError('No se pudo obtener la foto de perfil pública del usuario.');
  }

  return {
    username: info.username,
    full_name: info.full_name,
    items: [
      {
        remoteUrl: info.profile_pic_url,
        type: 'photo',
        name: `${info.username}_avatar.jpg`,
      },
    ],
  };
}

function extractReelItems(reelItems = [], prefix = 'story') {
  const items = [];
  reelItems.forEach((entry, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    if (isVideoNode(entry)) {
      const videoUrl = pickBestVideo(entry);
      if (videoUrl && isAllowedInstagramCdnUrl(videoUrl)) {
        items.push({ remoteUrl: videoUrl, type: 'video', name: `${prefix}_${num}.mp4` });
      }
    } else {
      const imgUrl = pickBestImage(entry);
      if (imgUrl && isAllowedInstagramCdnUrl(imgUrl)) {
        items.push({ remoteUrl: imgUrl, type: 'photo', name: `${prefix}_${num}.jpg` });
      }
    }
  });
  return items;
}

async function nativeDownloadStories(rawUsername, options) {
  if (!options.sessionId) {
    throw new NativeDownloadError(
      'Instagram requiere una sesión autenticada en el servidor (INSTAGRAM_SESSIONID o INSTAGRAM_USERNAME/INSTAGRAM_PASSWORD) para descargar historias. Las fotos, reels, vídeos y fotos de perfil funcionan sin cuenta.',
      { status: 422, code: 'instagram_auth_required' },
    );
  }

  const info = await nativeGetUserInfo(rawUsername, options);
  if (!info.id) {
    throw new NativeDownloadError('No se pudo resolver el identificador numérico del perfil.');
  }

  const url = `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(info.id)}`;
  const response = await fetchWithTimeout(
    options.fetchImpl,
    url,
    {
      method: 'GET',
      headers: baseHeaders(
        {
          'X-IG-App-ID': IG_WEB_APP_ID,
          Referer: `https://www.instagram.com/stories/${encodeURIComponent(info.username)}/`,
        },
        options.sessionId,
      ),
    },
    options.timeoutMs,
  );

  if (!response.ok) {
    throw new NativeDownloadError('No se pudieron obtener las historias desde Instagram.', {
      status: 502,
      code: 'instagram_stories_failed',
      retryable: true,
    });
  }

  const parsed = JSON.parse(stripForLoopPrefix(await response.text()));
  const reel = parsed?.reels?.[info.id] || parsed?.reels_media?.[0];
  const items = extractReelItems(reel?.items || [], `${info.username}_story`);

  if (items.length === 0) {
    throw new NativeDownloadError('El usuario no tiene historias activas públicas en este momento.');
  }

  return { username: info.username, items };
}

async function nativeDownloadHighlights(rawUsername, options) {
  if (!options.sessionId) {
    throw new NativeDownloadError(
      'Instagram requiere una sesión autenticada en el servidor (INSTAGRAM_SESSIONID o INSTAGRAM_USERNAME/INSTAGRAM_PASSWORD) para descargar destacados. Las fotos, reels, vídeos y fotos de perfil funcionan sin cuenta.',
      { status: 422, code: 'instagram_auth_required' },
    );
  }

  const info = await nativeGetUserInfo(rawUsername, options);
  if (!info.id) {
    throw new NativeDownloadError('No se pudo resolver el identificador numérico del perfil.');
  }

  const trayUrl = `https://www.instagram.com/api/v1/highlights/${encodeURIComponent(info.id)}/highlights_tray/`;
  const trayRes = await fetchWithTimeout(
    options.fetchImpl,
    trayUrl,
    {
      method: 'GET',
      headers: baseHeaders({ 'X-IG-App-ID': IG_WEB_APP_ID }, options.sessionId),
    },
    options.timeoutMs,
  );

  if (!trayRes.ok) {
    throw new NativeDownloadError('No se pudieron obtener los destacados del usuario.');
  }

  const trayData = JSON.parse(stripForLoopPrefix(await trayRes.text()));
  const tray = Array.isArray(trayData?.tray) ? trayData.tray.slice(0, 5) : [];
  if (tray.length === 0) {
    throw new NativeDownloadError('El usuario no tiene destacados públicos.');
  }

  const reelIds = tray.map((h) => h.id).filter(Boolean);
  const query = reelIds.map((id) => `reel_ids=${encodeURIComponent(id)}`).join('&');
  const reelsRes = await fetchWithTimeout(
    options.fetchImpl,
    `https://www.instagram.com/api/v1/feed/reels_media/?${query}`,
    {
      method: 'GET',
      headers: baseHeaders({ 'X-IG-App-ID': IG_WEB_APP_ID }, options.sessionId),
    },
    options.timeoutMs,
  );

  if (!reelsRes.ok) {
    throw new NativeDownloadError('No se pudo descargar el contenido de los destacados.');
  }

  const reelsData = JSON.parse(stripForLoopPrefix(await reelsRes.text()));
  const items = [];
  for (const highlight of tray) {
    const reel = reelsData?.reels?.[highlight.id];
    const title = highlight.title || 'Destacado';
    const safePrefix = String(title).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 30) || 'highlight';
    const subItems = extractReelItems(reel?.items || [], safePrefix);
    subItems.forEach((item) => items.push({ ...item, highlight: title }));
  }

  if (items.length === 0) {
    throw new NativeDownloadError('Los destacados no contienen archivos descargables.');
  }

  return { username: info.username, items };
}

async function runNativeInstagramAction(action, argument, { config, fetchImpl = fetch } = {}) {
  const options = {
    fetchImpl,
    timeoutMs: Math.min(config?.instagram?.timeoutMs || 25_000, 25_000),
    sessionId: config?.instagram?.sessionId || process.env.INSTAGRAM_SESSIONID || '',
  };

  switch (action) {
    case 'download_post':
      return nativeDownloadPost(argument, options);
    case 'get_user_info':
      return nativeGetUserInfo(argument, options);
    case 'download_profile_pic':
      return nativeDownloadProfilePic(argument, options);
    case 'download_stories':
      return nativeDownloadStories(argument, options);
    case 'download_highlights':
      return nativeDownloadHighlights(argument, options);
    default:
      throw new NativeDownloadError(`Acción no soportada: ${action}`, { status: 400, code: 'invalid_action' });
  }
}

module.exports = {
  runNativeInstagramAction,
  NativeDownloadError,
  classifyInstagramInput,
  normalizeInstagramUrl,
  isAllowedInstagramCdnUrl,
  extractFromMediaObject,
  parseEmbedHtml,
  unescapeHtml,
};
