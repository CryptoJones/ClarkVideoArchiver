// Unit tests for the HLS parser in src/hls.js.
// Run: node scripts/test-hls.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const BASE = 'https://cdn.example.com/media/index.m3u8';

/* ------------------------------- attributes ------------------------------ */
console.log('parseAttributes');
test('parses simple pairs', () => {
  const a = HLS.parseAttributes('BANDWIDTH=1280000,RESOLUTION=1280x720');
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.RESOLUTION, '1280x720');
});
test('keeps commas inside quoted values', () => {
  const a = HLS.parseAttributes('CODECS="avc1.4d401f,mp4a.40.2",BANDWIDTH=800000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.BANDWIDTH, '800000');
});
test('handles hyphenated keys', () => {
  const a = HLS.parseAttributes('GROUP-ID="aud1",AVERAGE-BANDWIDTH=900');
  assert.equal(a['GROUP-ID'], 'aud1');
  assert.equal(a['AVERAGE-BANDWIDTH'], '900');
});

/* --------------------------------- master -------------------------------- */
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud1",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aud1"
high/index.m3u8
`;

console.log('parseMaster');
test('detects a master playlist', () => assert.equal(HLS.isMaster(MASTER), true));
test('finds both variants', () => assert.equal(HLS.parseMaster(MASTER, BASE).variants.length, 2));
test('sorts highest resolution first', () => {
  const { variants } = HLS.parseMaster(MASTER, BASE);
  assert.equal(variants[0].height, 720);
  assert.equal(variants[1].height, 360);
});
test('resolves variant URLs against the playlist', () => {
  const { variants } = HLS.parseMaster(MASTER, BASE);
  assert.equal(variants[0].url, 'https://cdn.example.com/media/high/index.m3u8');
});
test('parses resolution into width and height', () => {
  const v = HLS.parseMaster(MASTER, BASE).variants[0];
  assert.equal(v.width, 1280);
  assert.equal(v.height, 720);
  assert.equal(v.bandwidth, 2400000);
});
test('captures audio renditions', () => {
  const { media } = HLS.parseMaster(MASTER, BASE);
  assert.equal(media.length, 1);
  assert.equal(media[0].url, 'https://cdn.example.com/media/audio/en.m3u8');
});
test('links a variant to its separate audio track', () => {
  const p = HLS.parseMaster(MASTER, BASE);
  const audio = HLS.audioRenditionFor(p.variants[0], p.media);
  assert.ok(audio, 'expected the 720p variant to reference audio group aud1');
  assert.equal(audio.name, 'English');
});
test('variant without an audio group has no separate track', () => {
  const p = HLS.parseMaster(MASTER, BASE);
  assert.equal(HLS.audioRenditionFor(p.variants[1], p.media), null);
});

/* --------------------------------- media --------------------------------- */
const VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
seg0.ts
#EXTINF:9.009,
seg1.ts
#EXTINF:3.003,
seg2.ts
#EXT-X-ENDLIST
`;

console.log('parseMedia');
test('is not a master', () => assert.equal(HLS.isMaster(VOD), false));
test('reads every segment', () => assert.equal(HLS.parseMedia(VOD, BASE).segments.length, 3));
test('resolves segment URLs', () => {
  assert.equal(HLS.parseMedia(VOD, BASE).segments[0].url, 'https://cdn.example.com/media/seg0.ts');
});
test('sums total duration', () => {
  assert.ok(Math.abs(HLS.parseMedia(VOD, BASE).totalDuration - 21.021) < 0.001);
});
test('ENDLIST means not live', () => assert.equal(HLS.parseMedia(VOD, BASE).isLive, false));
test('no ENDLIST means live', () => {
  const live = VOD.replace('#EXT-X-ENDLIST\n', '');
  assert.equal(HLS.parseMedia(live, BASE).isLive, true);
});
test('numbers segments from the media sequence', () => {
  const shifted = VOD.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:100');
  const segs = HLS.parseMedia(shifted, BASE).segments;
  assert.equal(segs[0].seq, 100);
  assert.equal(segs[2].seq, 102);
});
test('unencrypted playlist reports NONE', () => assert.equal(HLS.parseMedia(VOD, BASE).encryption, 'NONE'));

/* ------------------------------- byteranges ------------------------------ */
const BYTERANGE = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:10,
#EXT-X-BYTERANGE:75232@0
all.ts
#EXTINF:10,
#EXT-X-BYTERANGE:82112
all.ts
#EXT-X-ENDLIST
`;

console.log('byte ranges');
// Compared field by field rather than with deepEqual: these objects are built
// inside the vm realm, so their prototype differs and assert/strict rejects
// them even when the structure matches exactly.
test('parses an explicit offset', () => {
  const { byteRange } = HLS.parseMedia(BYTERANGE, BASE).segments[0];
  assert.equal(byteRange.offset, 0);
  assert.equal(byteRange.length, 75232);
});
test('a missing offset continues from the previous range', () => {
  const { byteRange } = HLS.parseMedia(BYTERANGE, BASE).segments[1];
  assert.equal(byteRange.offset, 75232);
  assert.equal(byteRange.length, 82112);
});
test('both ranges point at the same file', () => {
  const segs = HLS.parseMedia(BYTERANGE, BASE).segments;
  assert.equal(segs[0].url, segs[1].url);
});

/* -------------------------------- fmp4 map ------------------------------- */
const FMP4 = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
seg0.m4s
#EXTINF:4,
seg1.m4s
#EXT-X-ENDLIST
`;

console.log('fMP4 / EXT-X-MAP');
test('captures the init segment', () => {
  assert.equal(HLS.parseMedia(FMP4, BASE).initSegment.url, 'https://cdn.example.com/media/init.mp4');
});
test('an init segment means a real mp4 container', () => {
  const c = HLS.containerFor(HLS.parseMedia(FMP4, BASE));
  assert.equal(c.ext, 'mp4');
  assert.equal(c.remuxNeeded, false);
});
test('bare ts segments yield a ts container needing remux', () => {
  const c = HLS.containerFor(HLS.parseMedia(VOD, BASE));
  assert.equal(c.ext, 'ts');
  assert.equal(c.remuxNeeded, true);
});

/* ------------------------------- encryption ------------------------------ */
const AES = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:10,
seg0.ts
#EXT-X-ENDLIST
`;

console.log('encryption');
test('detects AES-128', () => assert.equal(HLS.parseMedia(AES, BASE).encryption, 'AES-128'));
test('resolves the key URL', () => {
  assert.equal(HLS.parseMedia(AES, BASE).segments[0].key.url, 'https://cdn.example.com/media/key.bin');
});
test('AES-128 is supported and not DRM', () => {
  const s = HLS.encryptionSupport('AES-128');
  assert.equal(s.supported, true);
  assert.equal(s.drm, false);
});
test('SAMPLE-AES is refused as DRM', () => {
  const s = HLS.encryptionSupport('SAMPLE-AES');
  assert.equal(s.supported, false);
  assert.equal(s.drm, true);
  assert.match(s.reason, /licence server/i);
});
test('METHOD=NONE leaves segments unencrypted', () => {
  const none = AES.replace('METHOD=AES-128', 'METHOD=NONE');
  assert.equal(HLS.parseMedia(none, BASE).segments[0].key, null);
});
test('a key applies to following segments until replaced', () => {
  const multi = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="k1.bin"
#EXTINF:10,
a.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2.bin"
#EXTINF:10,
b.ts
#EXT-X-ENDLIST
`;
  const segs = HLS.parseMedia(multi, BASE).segments;
  assert.match(segs[0].key.url, /k1\.bin$/);
  assert.match(segs[1].key.url, /k2\.bin$/);
});

console.log('ivForSegment');
test('uses an explicit IV from the playlist', () => {
  const seg = HLS.parseMedia(AES, BASE).segments[0];
  const iv = HLS.ivForSegment(seg);
  assert.equal(iv.length, 16);
  assert.equal(iv[0], 0x01);
  assert.equal(iv[15], 0xef);
});
test('derives the IV from the sequence number when absent', () => {
  const noIv = AES.replace(',IV=0x0123456789ABCDEF0123456789ABCDEF', '');
  const seg = HLS.parseMedia(noIv, BASE).segments[0];
  seg.seq = 5;
  const iv = HLS.ivForSegment(seg);
  assert.equal(iv.length, 16);
  assert.equal(iv[15], 5);
  assert.equal(iv[0], 0);
});
test('derived IV is big-endian across byte boundaries', () => {
  const noIv = AES.replace(',IV=0x0123456789ABCDEF0123456789ABCDEF', '');
  const seg = HLS.parseMedia(noIv, BASE).segments[0];
  seg.seq = 258; // 0x0102
  const iv = HLS.ivForSegment(seg);
  assert.equal(iv[15], 0x02);
  assert.equal(iv[14], 0x01);
});

/* -------------------------------- dispatch ------------------------------- */
console.log('parsePlaylist');
test('routes a master playlist', () => assert.equal(HLS.parsePlaylist(MASTER, BASE).isMaster, true));
test('routes a media playlist', () => assert.equal(HLS.parsePlaylist(VOD, BASE).isMaster, false));
test('handles CRLF line endings', () => {
  assert.equal(HLS.parsePlaylist(VOD.replace(/\n/g, '\r\n'), BASE).segments.length, 3);
});
test('absolute segment URLs are left alone', () => {
  const abs = VOD.replace('seg0.ts', 'https://other.example.net/x/seg0.ts');
  assert.equal(HLS.parsePlaylist(abs, BASE).segments[0].url, 'https://other.example.net/x/seg0.ts');
});

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
