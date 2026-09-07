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

/* --------------------------------- quality -------------------------------- */

// What the user wants when a stream offers the same video at several sizes.
// 'ask' shows the picker; 'best'/'worst' take an extreme; a bare number is a
// height ceiling. The ceiling is a ceiling, not a demand: a stream that tops
// out at 480p still downloads when 1080p was asked for.
const QUALITY_CHOICES = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'best', label: 'Best available' },
  { value: '2160', label: '2160p (4K) or lower' },
  { value: '1440', label: '1440p or lower' },
  { value: '1080', label: '1080p or lower' },
  { value: '720', label: '720p or lower' },
  { value: '480', label: '480p or lower' },
  { value: '360', label: '360p or lower' },
  { value: 'worst', label: 'Smallest file' },
];

const DEFAULT_QUALITY = 'ask';

// The whole string has to be digits: parseInt('4k') is 4, which would quietly
// turn a typo into a 4-pixel-tall ceiling.
const QUALITY_HEIGHT = /^\d{2,5}$/;

function normalizeQuality(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'ask' || v === 'best' || v === 'worst') return v;
  return QUALITY_HEIGHT.test(v) ? String(parseInt(v, 10)) : DEFAULT_QUALITY;
}

// 0 when the preference is not a height ceiling.
function maxHeightFor(quality) {
  const n = parseInt(normalizeQuality(quality), 10);
  return Number.isFinite(n) ? n : 0;
}

function qualityLabel(quality) {
  const q = normalizeQuality(quality);
  return QUALITY_CHOICES.find((c) => c.value === q)?.label || `${q}p or lower`;
}

// Choose one variant out of a master playlist's list. Never returns null for a
// non-empty list: a preference nothing satisfies falls back to the nearest
// thing on offer, because handing back "no match" would mean no download.
function pickVariant(variants, quality) {
  const list = (variants || []).filter(Boolean);
  if (!list.length) return null;

  // parseMaster already sorts best-first, but sorting here keeps this usable
  // on any list a caller hands over.
  const sorted = [...list].sort(
    (a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0),
  );

  const q = normalizeQuality(quality);
  if (q === 'worst') return sorted[sorted.length - 1];
  if (q === 'best' || q === 'ask') return sorted[0];

  const cap = maxHeightFor(q);
  // A variant with no RESOLUTION cannot be judged against a height ceiling, so
  // it is only reached when nothing that carries one qualifies.
  const known = sorted.filter((v) => v.height > 0);
  return known.find((v) => v.height <= cap) || known[known.length - 1] || sorted[0];
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
  QUALITY_CHOICES,
  DEFAULT_QUALITY,
  normalizeQuality,
  maxHeightFor,
  qualityLabel,
  pickVariant,
  MEDIA_EXT,
  MANIFEST_EXT,
};
