// End-to-end check that the parse -> fetch -> decrypt -> concatenate pipeline
// produces a genuinely playable video, not just a plausible byte stream.
//
// It mirrors what downloader.js does, substituting disk reads for fetch() and
// node:crypto for WebCrypto (both are AES-128-CBC with PKCS#7, so the decrypt
// path is equivalent). Every output is verified with ffprobe.
//
// Run: node scripts/test-assemble.mjs <fixture-dir>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = process.argv[2];

if (!fixtures || !existsSync(fixtures)) {
  console.log('no fixture directory supplied; skipping assembly test');
  process.exit(0);
}

const sandbox = { globalThis: null, URL, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'src/hls.js'), 'utf8'), sandbox);
const HLS = sandbox.HLS;

let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

const readUrl = (url) => readFileSync(fileURLToPath(url));

function ffprobe(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,codec_name',
    '-of', 'json', file,
  ], { encoding: 'utf8' });
  const j = JSON.parse(out);
  return {
    duration: parseFloat(j.format?.duration || '0'),
    codecs: (j.streams || []).map((s) => `${s.codec_type}:${s.codec_name}`),
  };
}

// The core of downloader.js run(), with disk reads standing in for the network.
function assemble(playlistPath) {
  const playlistUrl = pathToFileURL(playlistPath).href;
  const parsed = HLS.parsePlaylist(readFileSync(playlistPath, 'utf8'), playlistUrl);
  assert.equal(parsed.isMaster, false, 'fixture should be a media playlist');

  const support = HLS.encryptionSupport(parsed.encryption);
  assert.ok(support.supported, support.reason || 'unsupported encryption');

  const parts = [];
  if (parsed.initSegment?.url) parts.push(readUrl(parsed.initSegment.url));

  for (const seg of parsed.segments) {
    let buf = readUrl(seg.url);
    if (seg.byteRange) {
      buf = buf.subarray(seg.byteRange.offset, seg.byteRange.offset + seg.byteRange.length);
    }
    if (seg.key) {
      const key = readUrl(seg.key.url);
      const iv = Buffer.from(HLS.ivForSegment(seg));
      const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
      buf = Buffer.concat([d.update(buf), d.final()]);
    }
    parts.push(buf);
  }

  const container = HLS.containerFor(parsed);
  const out = join(fixtures, `assembled.${container.ext}`);
  writeFileSync(out, Buffer.concat(parts));
  return { out, parsed, container };
}

const SOURCE = ffprobe(join(fixtures, 'source.mp4'));
console.log(`source: ${SOURCE.duration.toFixed(2)}s  [${SOURCE.codecs.join(', ')}]\n`);

for (const [name, dir] of [['MPEG-TS', 'ts'], ['fMP4', 'fmp4'], ['AES-128 encrypted', 'aes']]) {
  const playlist = join(fixtures, dir, 'index.m3u8');
  if (!existsSync(playlist)) continue;

  console.log(name);
  let result;

  test('assembles without error', () => {
    result = assemble(playlist);
    assert.ok(existsSync(result.out));
  });
  if (!result) continue;

  test('parsed every segment', () => assert.equal(result.parsed.segments.length, 12));

  test('output is a decodable video', () => {
    const probed = ffprobe(result.out);
    assert.ok(probed.duration > 0, 'ffprobe reported no duration');
    result.probed = probed;
  });

  test('duration matches the source', () => {
    const delta = Math.abs(result.probed.duration - SOURCE.duration);
    assert.ok(delta < 1.0, `expected ~${SOURCE.duration}s, got ${result.probed.duration}s`);
  });

  test('video stream survived', () => {
    assert.ok(result.probed.codecs.some((c) => c.startsWith('video:')), result.probed.codecs.join(','));
  });

  test('audio stream survived', () => {
    assert.ok(result.probed.codecs.some((c) => c.startsWith('audio:')), result.probed.codecs.join(','));
  });

  test('frames actually decode', () => {
    // A file can carry correct metadata and still be garbage inside; forcing a
    // full decode is what proves the segments were joined in the right order.
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', result.out, '-f', 'null', '-'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(out.trim(), '', `decoder reported: ${out.trim().slice(0, 300)}`);
  });

  console.log(`       -> ${result.container.ext}, ${result.probed.duration.toFixed(2)}s\n`);
}

console.log(failed ? `${failed} test(s) failed` : 'all assembly tests passed');
process.exit(failed ? 1 : 0);
