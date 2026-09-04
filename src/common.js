// Shared helpers, loaded first in every context (background, content, popup).
// Chrome exposes only `chrome`; Firefox exposes both, but only `browser` is
// promise-based there, so prefer it when it is a real extension namespace.
globalThis.api = globalThis.browser?.runtime?.id ? globalThis.browser : globalThis.chrome;

const MEDIA_EXT = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|m4s|ts|mp3|m4a)(?=$|[?#])/i;
const MANIFEST_EXT = /\.(m3u8|mpd)(?=$|[?#])/i;

// A manifest is a playlist of segments, not a playable file, so it can never be
// written straight to disk. We still surface it — ffmpeg can mux it.
function classifyUrl(url, mimeType) {
  if (!url) return null;
  if (url.startsWith('blob:')) return 'blob';
  if (url.startsWith('data:')) return 'data';
  if (MANIFEST_EXT.test(url)) return 'manifest';
  if (MEDIA_EXT.test(url)) return 'file';
  if (mimeType && /^(video|audio)\//.test(mimeType)) return 'file';
  if (/[?&]mime=(video|audio)/.test(url)) return 'file';
  return null;
}

function extensionFor(url, mimeType) {
  const m = String(url).match(MEDIA_EXT);
  if (m) return m[1].toLowerCase();
  const byMime = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
  };
  return byMime[String(mimeType).split(';')[0].trim()] || 'mp4';
}

// Windows has the strictest filename rules of the three desktop platforms,
// so sanitize to those and every platform is satisfied.
function sanitizeFilename(name, fallback = 'video') {
  const out = String(name || '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
    .replace(/\.+$/, '')
    .trim();
  return out || fallback;
}

function buildFilename({ pageTitle, url, mimeType, index }) {
  const ext = extensionFor(url, mimeType);
  let base = sanitizeFilename(pageTitle);
  if (base === 'video') {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      if (last) base = sanitizeFilename(last.replace(MEDIA_EXT, ''), 'video');
    } catch {
      // Relative or opaque URL; the fallback base is fine.
    }
  }
  const suffix = index ? ` (${index})` : '';
  return `ClarkVideoArchiver/${base}${suffix}.${ext}`;
}

function humanSize(bytes) {
  const n0 = Number(bytes);
  if (!n0 || n0 < 0 || !Number.isFinite(n0)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = n0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// Manifests need remuxing rather than a plain download; give the user a command
// they can paste instead of pretending we saved a playable file.
function ffmpegCommand(url, filename) {
  const out = String(filename).split('/').pop().replace(/\.[^.]+$/, '') || 'video';
  return `ffmpeg -i "${url}" -c copy "${out}.mp4"`;
}

globalThis.CVA = {
  classifyUrl,
  extensionFor,
  sanitizeFilename,
  buildFilename,
  humanSize,
  ffmpegCommand,
  MEDIA_EXT,
  MANIFEST_EXT,
};
