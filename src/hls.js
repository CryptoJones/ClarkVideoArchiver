/* Pure HLS playlist parsing. No I/O, no DOM — everything here is unit-tested
 * in scripts/test-hls.mjs. The download engine lives in downloader.js.
 *
 * Covers the parts of RFC 8216 that show up in real streams: master playlists
 * with variants, byte-range segments, EXT-X-MAP init segments, AES-128 keys,
 * and separate audio renditions.
 */

// Attribute lists can contain quoted values with commas inside them
// (CODECS="avc1.4d401f,mp4a.40.2"), so a naive split(',') corrupts them.
function parseAttributes(input) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(input)) !== null) {
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

function resolveUrl(url, baseUrl) {
  try {
    return new URL(url, baseUrl).href;
  } catch {
    return url;
  }
}

function lines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isMaster(text) {
  return /^#EXT-X-STREAM-INF:/m.test(String(text));
}

/* -------------------------------- master --------------------------------- */

// Renditions (audio/subtitles) that carry their own URI are separate streams.
// If the video variant points at one, the video segments contain no audio and
// the caller has to be told, or the user silently gets a mute file.
function parseMaster(text, baseUrl) {
  const rows = lines(text);
  const variants = [];
  const media = [];

  for (let i = 0; i < rows.length; i += 1) {
    const line = rows[i];

    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      media.push({
        type: a.TYPE || '',
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        isDefault: a.DEFAULT === 'YES',
        url: a.URI ? resolveUrl(a.URI, baseUrl) : '',
      });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      // The URI is the next line that is not a comment.
      let uri = '';
      for (let j = i + 1; j < rows.length; j += 1) {
        if (!rows[j].startsWith('#')) { uri = rows[j]; i = j; break; }
      }
      if (!uri) continue;

      const res = a.RESOLUTION || '';
      const [w, h] = res.split('x').map((n) => parseInt(n, 10) || 0);
      variants.push({
        url: resolveUrl(uri, baseUrl),
        bandwidth: parseInt(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || '0', 10) || 0,
        width: w || 0,
        height: h || 0,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || '',
        subtitleGroup: a.SUBTITLES || '',
        label: res || (a.BANDWIDTH ? `${Math.round(Number(a.BANDWIDTH) / 1000)} kbps` : 'variant'),
      });
    }
  }

  // Best first, so the default pick is the highest quality available.
  variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  return { isMaster: true, variants, media };
}

// Subtitle renditions carry their own playlist of WebVTT segments. A stream
// may offer several languages; all of them are returned so the caller can save
// each one, with the DEFAULT/forced track first.
function subtitleRenditions(media, group = '') {
  const subs = (media || []).filter(
    (m) => m.type === 'SUBTITLES' && m.url && (!group || m.groupId === group),
  );
  return subs.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

// The audio rendition a given variant depends on, if it is a separate stream.
function audioRenditionFor(variant, media) {
  if (!variant?.audioGroup) return null;
  const group = (media || []).filter(
    (m) => m.type === 'AUDIO' && m.groupId === variant.audioGroup && m.url,
  );
  if (!group.length) return null;
  return group.find((m) => m.isDefault) || group[0];
}

/* --------------------------------- media --------------------------------- */

function parseByteRange(value, previousEnd) {
  // "<length>[@<offset>]"; a missing offset means "directly after the last one".
  const [lenRaw, offRaw] = String(value).split('@');
  const length = parseInt(lenRaw, 10);
  if (!Number.isFinite(length)) return null;
  const offset = offRaw !== undefined ? parseInt(offRaw, 10) : previousEnd;
  if (!Number.isFinite(offset)) return null;
  return { offset, length };
}

function parseMedia(text, baseUrl) {
  const rows = lines(text);
  const segments = [];

  let currentKey = null;        // applies until the next EXT-X-KEY
  let pendingDuration = 0;
  let pendingByteRange = null;
  let initSegment = null;
  let mediaSequence = 0;
  let isLive = true;            // until an ENDLIST tag proves otherwise
  let targetDuration = 0;
  const byteCursor = new Map(); // url -> end offset of the previous range

  for (const line of rows) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.split(':')[1], 10) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      isLive = false;
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      if (/VOD/i.test(line)) isLive = false;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      const method = (a.METHOD || 'NONE').toUpperCase();
      currentKey = method === 'NONE' ? null : {
        method,
        url: a.URI ? resolveUrl(a.URI, baseUrl) : '',
        iv: a.IV || '',
        keyFormat: a.KEYFORMAT || 'identity',
      };
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      initSegment = {
        url: a.URI ? resolveUrl(a.URI, baseUrl) : '',
        byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null,
      };
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByteRange = line.slice('#EXT-X-BYTERANGE:'.length);
      continue;
    }
    if (line.startsWith('#')) continue;

    // Anything else is a segment URI.
    const url = resolveUrl(line, baseUrl);
    let byteRange = null;
    if (pendingByteRange) {
      byteRange = parseByteRange(pendingByteRange, byteCursor.get(url) || 0);
      if (byteRange) byteCursor.set(url, byteRange.offset + byteRange.length);
    }
    segments.push({
      url,
      duration: pendingDuration,
      seq: mediaSequence + segments.length,
      byteRange,
      key: currentKey,
    });
    pendingDuration = 0;
    pendingByteRange = null;
  }

  const methods = [...new Set(segments.filter((s) => s.key).map((s) => s.key.method))];

  return {
    isMaster: false,
    segments,
    initSegment,
    isLive,
    targetDuration,
    totalDuration: segments.reduce((n, s) => n + s.duration, 0),
    encryption: methods.length ? methods.join(',') : 'NONE',
  };
}

function parsePlaylist(text, baseUrl) {
  return isMaster(text) ? parseMaster(text, baseUrl) : parseMedia(text, baseUrl);
}

/* ------------------------------- decryption ------------------------------ */

// AES-128 is ordinary HLS transport encryption: the key sits in the clear at a
// URL named in the playlist, and every player fetches it exactly this way.
// SAMPLE-AES is the FairPlay/DRM path — that key comes from a licence server,
// so it is reported as unsupported rather than attempted.
function encryptionSupport(method) {
  const m = String(method || 'NONE').toUpperCase();
  if (m === 'NONE') return { supported: true, drm: false };
  if (m === 'AES-128') return { supported: true, drm: false };
  return {
    supported: false,
    drm: true,
    reason: `${m} is DRM-protected. The decryption key is issued by a licence server, so this stream cannot be saved.`,
  };
}

// Absent an explicit IV, HLS derives it from the segment's media sequence
// number as a 128-bit big-endian integer.
function ivForSegment(segment) {
  const out = new Uint8Array(16);
  if (segment.key?.iv) {
    const hex = segment.key.iv.replace(/^0[xX]/, '').padStart(32, '0').slice(0, 32);
    for (let i = 0; i < 16; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16) || 0;
    return out;
  }
  let n = segment.seq;
  for (let i = 15; i >= 12 && n > 0; i -= 1) { out[i] = n & 0xff; n = Math.floor(n / 256); }
  return out;
}

/* -------------------------------- output --------------------------------- */

// An EXT-X-MAP init segment means fragmented MP4, and concatenating those
// yields a genuinely playable .mp4. Bare MPEG-TS segments concatenate into a
// valid .ts, which plays in VLC/mpv/ffmpeg but is NOT an MP4 — naming it .mp4
// would hand the user a file that fails to open.
function containerFor(parsed) {
  if (parsed.initSegment) return { ext: 'mp4', mime: 'video/mp4', remuxNeeded: false };

  const first = parsed.segments?.[0]?.url || '';
  if (/\.(mp4|m4s)(?=$|[?#])/i.test(first)) {
    return { ext: 'mp4', mime: 'video/mp4', remuxNeeded: false };
  }
  return {
    ext: 'ts',
    mime: 'video/mp2t',
    remuxNeeded: true,
    note: 'MPEG-TS segments. The saved .ts plays in VLC, mpv and ffmpeg; remux losslessly if you need an .mp4.',
  };
}

const HLS = {
  parseAttributes,
  resolveUrl,
  isMaster,
  parseMaster,
  parseMedia,
  parsePlaylist,
  audioRenditionFor,
  subtitleRenditions,
  encryptionSupport,
  ivForSegment,
  containerFor,
};

if (typeof globalThis !== 'undefined') globalThis.HLS = HLS;
