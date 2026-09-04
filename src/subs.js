/* WebVTT handling for HLS subtitle renditions.
 *
 * Subtitles arrive as their own playlist of .vtt segments, each a standalone
 * WebVTT file with its own header. Concatenating them produces an invalid file
 * (repeated WEBVTT headers) with duplicated cues at every segment boundary, so
 * the cues are parsed out, offset, de-duplicated and re-emitted as one file.
 *
 * Pure functions; unit-tested in scripts/test-subs.mjs.
 */

const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const CUE_RE = new RegExp(`${TIME_RE.source}\\s*-->\\s*${TIME_RE.source}(.*)`);

function toSeconds(h, m, s, ms) {
  return (Number(h) || 0) * 3600 + Number(m) * 60 + Number(s) + Number(String(ms).padEnd(3, '0')) / 1000;
}

function pad(n, width = 2) {
  return String(Math.floor(n)).padStart(width, '0');
}

function formatTime(seconds, msSep = '.') {
  const t = Math.max(0, seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${msSep}${pad(ms, 3)}`;
}

// X-TIMESTAMP-MAP ties the segment's local clock to the MPEG-TS presentation
// clock. Where it appears, the difference between the two is the real offset.
function timestampMapOffset(text) {
  const m = String(text).match(/X-TIMESTAMP-MAP\s*[=:]\s*(.+)/i);
  if (!m) return null;
  const mpegts = m[1].match(/MPEGTS\s*:\s*(\d+)/i);
  const local = m[1].match(/LOCAL\s*:\s*([\d:.,]+)/i);
  if (!mpegts) return null;
  const mpegSeconds = Number(mpegts[1]) / 90000; // 90 kHz clock
  let localSeconds = 0;
  if (local) {
    const p = local[1].match(TIME_RE);
    if (p) localSeconds = toSeconds(p[1], p[2], p[3], p[4]);
  }
  return mpegSeconds - localSeconds;
}

function parseCues(text) {
  const cues = [];
  const blocks = String(text).replace(/\r\n?/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;

    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx === -1) continue; // header, NOTE, STYLE, REGION

    const m = lines[idx].match(CUE_RE);
    if (!m) continue;

    const start = toSeconds(m[1], m[2], m[3], m[4]);
    const end = toSeconds(m[5], m[6], m[7], m[8]);
    const settings = (m[9] || '').trim();
    const body = lines.slice(idx + 1).join('\n').trim();
    if (!body) continue;

    cues.push({ start, end, settings, text: body });
  }
  return cues;
}

/* Merge one subtitle segment's cues into absolute presentation time.
 *
 * Segments come in two flavours in the wild: cue times already absolute across
 * the whole presentation, or local to the segment and needing its start time
 * added. Guessing wrong shifts every subtitle, so it is decided per segment. */
function offsetForSegment(cues, segmentStart) {
  if (!cues.length || !segmentStart) return 0;
  // If every cue ends before this segment begins, the times cannot be absolute,
  // so they are local and need the segment's start added. Comparing against the
  // segment's *duration* instead would misjudge a cue that spans a boundary —
  // those legitimately end past the segment start and must be left alone.
  const maxEnd = Math.max(...cues.map((c) => c.end));
  return maxEnd <= segmentStart ? segmentStart : 0;
}

function mergeSegments(segments) {
  const all = [];
  for (const seg of segments) {
    const cues = parseCues(seg.text);
    // An explicit timestamp map wins; otherwise fall back to the shape test.
    const mapped = timestampMapOffset(seg.text);
    const offset = mapped !== null && mapped > 0
      ? 0 // times are already tied to the presentation clock
      : offsetForSegment(cues, seg.start || 0);
    for (const c of cues) all.push({ ...c, start: c.start + offset, end: c.end + offset });
  }

  // A cue overlapping a segment boundary is emitted in both segments.
  const seen = new Set();
  const unique = [];
  for (const c of all) {
    const key = `${c.start.toFixed(3)}|${c.end.toFixed(3)}|${c.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }
  unique.sort((a, b) => a.start - b.start || a.end - b.end);
  return unique;
}

function toVtt(cues) {
  const body = cues
    .map((c) => {
      const timing = `${formatTime(c.start)} --> ${formatTime(c.end)}${c.settings ? ` ${c.settings}` : ''}`;
      return `${timing}\n${c.text}`;
    })
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

function toSrt(cues) {
  return `${cues
    .map((c, i) => {
      // SRT uses a comma before milliseconds and carries no cue settings.
      const timing = `${formatTime(c.start, ',')} --> ${formatTime(c.end, ',')}`;
      return `${i + 1}\n${timing}\n${c.text}`;
    })
    .join('\n\n')}\n`;
}

const Subs = {
  parseCues,
  mergeSegments,
  toVtt,
  toSrt,
  formatTime,
  timestampMapOffset,
};

if (typeof globalThis !== 'undefined') globalThis.Subs = Subs;
