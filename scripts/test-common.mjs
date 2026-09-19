// Unit tests for the pure helpers in src/common.js.
// Run: node scripts/test-common.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// A bare vm context gets only the ECMAScript built-ins, so the web globals the
// extension relies on have to be injected or buildFilename silently falls into
// its catch and every URL-derived name comes back as the fallback.
const sandbox = {
  globalThis: null,
  browser: undefined,
  chrome: {},
  URL,
  decodeURIComponent,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'src/common.js'), 'utf8'), sandbox);
const CVA = sandbox.CVA;

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

console.log('classifyUrl');
test('plain mp4 is a file', () => assert.equal(CVA.classifyUrl('https://x.com/a.mp4', ''), 'file'));
test('query string after extension still matches', () => assert.equal(CVA.classifyUrl('https://x.com/a.mp4?t=1', ''), 'file'));
test('hls playlist is a manifest', () => assert.equal(CVA.classifyUrl('https://x.com/a.m3u8', ''), 'manifest'));
test('dash playlist is a manifest', () => assert.equal(CVA.classifyUrl('https://x.com/a.mpd?x=1', ''), 'manifest'));
test('blob url is a blob', () => assert.equal(CVA.classifyUrl('blob:https://x.com/uuid', ''), 'blob'));
test('extensionless url with video mime is a file', () => assert.equal(CVA.classifyUrl('https://x.com/stream', 'video/mp4'), 'file'));
test('html page is not media', () => assert.equal(CVA.classifyUrl('https://x.com/watch', 'text/html'), null));
test('mp4 substring in a path does not false-positive', () => assert.equal(CVA.classifyUrl('https://x.com/mp4info', 'text/html'), null));

console.log('extensionFor');
test('reads extension from url', () => assert.equal(CVA.extensionFor('https://x.com/a.webm', ''), 'webm'));
test('falls back to mime', () => assert.equal(CVA.extensionFor('https://x.com/stream', 'video/webm'), 'webm'));
test('handles mime with charset', () => assert.equal(CVA.extensionFor('https://x.com/s', 'video/mp4; charset=utf-8'), 'mp4'));
test('defaults to mp4', () => assert.equal(CVA.extensionFor('https://x.com/s', ''), 'mp4'));

console.log('sanitizeFilename');
test('keeps ordinary spaces and words', () => assert.equal(CVA.sanitizeFilename('My Great Video'), 'My Great Video'));
test('keeps hyphens', () => assert.equal(CVA.sanitizeFilename('Part 1 - The Start'), 'Part 1 - The Start'));
test('strips path separators', () => assert.equal(CVA.sanitizeFilename('a/b\\c'), 'a b c'));
test('strips windows-illegal characters', () => assert.equal(CVA.sanitizeFilename('what? <yes> "no"|x*'), 'what yes no x'));
test('strips control characters', () => assert.equal(CVA.sanitizeFilename('a\x00b\x1fc'), 'abc'));
test('strips leading dots', () => assert.equal(CVA.sanitizeFilename('...hidden'), 'hidden'));
test('strips trailing dots', () => assert.equal(CVA.sanitizeFilename('name...'), 'name'));
test('empty falls back', () => assert.equal(CVA.sanitizeFilename('   '), 'video'));
test('truncates long titles', () => assert.ok(CVA.sanitizeFilename('x'.repeat(300)).length <= 120));
test('keeps unicode', () => assert.equal(CVA.sanitizeFilename('Café Über'), 'Café Über'));

console.log('buildFilename');
test('uses page title and url extension', () => assert.equal(
  CVA.buildFilename({ pageTitle: 'Cat Video', url: 'https://x.com/a.webm', mimeType: '' }),
  'ClarkVideoArchiver/Cat Video.webm',
));
test('falls back to url basename when title is unusable', () => assert.equal(
  CVA.buildFilename({ pageTitle: '', url: 'https://x.com/path/clip-42.mp4', mimeType: '' }),
  'ClarkVideoArchiver/clip-42.mp4',
));
test('adds an index suffix', () => assert.equal(
  CVA.buildFilename({ pageTitle: 'Show', url: 'https://x.com/a.mp4', index: 2 }),
  'ClarkVideoArchiver/Show (2).mp4',
));
test('percent-encoded basename is decoded', () => assert.equal(
  CVA.buildFilename({ pageTitle: '', url: 'https://x.com/My%20Clip.mp4' }),
  'ClarkVideoArchiver/My Clip.mp4',
));
test('never escapes the download folder', () => {
  const name = CVA.buildFilename({ pageTitle: '../../etc/passwd', url: 'https://x.com/a.mp4' });
  assert.ok(!name.slice('ClarkVideoArchiver/'.length).includes('/'), name);
  assert.ok(!name.includes('..'), name);
});

console.log('resolveDownloadName');
test('resolves a default into the download folder', () => {
  const resolved = CVA.resolveDownloadName({ name: 'Cat Video.mp4', fallback: 'Cat Video.mp4', extension: 'mp4' });
  assert.equal(resolved.base, 'ClarkVideoArchiver/Cat Video');
  assert.equal(resolved.path, 'ClarkVideoArchiver/Cat Video.mp4');
});
test('keeps dotted titles while adding the real extension', () => {
  assert.equal(
    CVA.resolveDownloadName({ name: 'Episode 1.2', fallback: 'Episode 1.2.mp4', extension: 'mp4' }).path,
    'ClarkVideoArchiver/Episode 1.2.mp4',
  );
});
test('replaces a mismatched media extension', () => {
  assert.equal(
    CVA.resolveDownloadName({ name: 'Movie.mkv', fallback: 'Movie.mp4', extension: 'mp4' }).path,
    'ClarkVideoArchiver/Movie.mp4',
  );
});
test('sanitizes traversal and keeps sidecars co-located', () => {
  const resolved = CVA.resolveDownloadName({ name: '../../Movie', fallback: 'Movie.mp4', extension: 'mp4' });
  assert.equal(resolved.base, 'ClarkVideoArchiver/Movie');
  assert.equal(resolved.path, 'ClarkVideoArchiver/Movie.mp4');
});
test('falls back for an empty name and invalid extension', () => {
  assert.equal(
    CVA.resolveDownloadName({ name: ' ', fallback: 'Fallback.mp4', extension: 'mp4/../../x' }).path,
    'ClarkVideoArchiver/Fallback.mp4',
  );
});
test('keeps the media extension after truncating a long name', () => {
  const path = CVA.resolveDownloadName({
    name: `${'x'.repeat(130)}.mp4`,
    fallback: 'Fallback.mp4',
    extension: 'mp4',
  }).path;
  assert.ok(path.endsWith('.mp4'), path);
  assert.ok(path.length <= 'ClarkVideoArchiver/'.length + 120 + '.mp4'.length, path);
});
test('keeps unicode and normalizes a known extension', () => {
  assert.equal(
    CVA.resolveDownloadName({ name: 'Café Über.MKV', fallback: 'Fallback.mp4', extension: 'MP4' }).path,
    'ClarkVideoArchiver/Café Über.mp4',
  );
});

console.log('humanSize');
test('formats bytes', () => assert.equal(CVA.humanSize(512), '512 B'));
test('formats megabytes', () => assert.equal(CVA.humanSize(5 * 1024 * 1024), '5.0 MB'));
test('zero is blank', () => assert.equal(CVA.humanSize(0), ''));
test('non-numeric is blank', () => assert.equal(CVA.humanSize('abc'), ''));

console.log('ffmpegCommand');
test('builds a copy-mux command', () => assert.equal(
  CVA.ffmpegCommand('https://x.com/a.m3u8', 'ClarkVideoArchiver/My Show.mp4'),
  'ffmpeg -i "https://x.com/a.m3u8" -c copy "My Show.mp4"',
));

console.log('normalizeQuality');
test('passes the named choices through', () => {
  assert.equal(CVA.normalizeQuality('best'), 'best');
  assert.equal(CVA.normalizeQuality('worst'), 'worst');
  assert.equal(CVA.normalizeQuality('ask'), 'ask');
});
test('is case and space insensitive', () => assert.equal(CVA.normalizeQuality('  BEST '), 'best'));
test('keeps a height as a string', () => assert.equal(CVA.normalizeQuality(720), '720'));
test('rubbish falls back to the default', () => {
  assert.equal(CVA.normalizeQuality('4k'), CVA.DEFAULT_QUALITY);
  assert.equal(CVA.normalizeQuality(undefined), CVA.DEFAULT_QUALITY);
  assert.equal(CVA.normalizeQuality('-720'), CVA.DEFAULT_QUALITY);
});

console.log('maxHeightFor');
test('reads the ceiling out of a height choice', () => assert.equal(CVA.maxHeightFor('1080'), 1080));
test('named choices have no ceiling', () => {
  assert.equal(CVA.maxHeightFor('best'), 0);
  assert.equal(CVA.maxHeightFor('worst'), 0);
  assert.equal(CVA.maxHeightFor('ask'), 0);
});

console.log('qualityLabel');
test('labels a named choice', () => assert.equal(CVA.qualityLabel('best'), 'Best available'));
test('labels a height choice', () => assert.equal(CVA.qualityLabel('720'), '720p or lower'));

console.log('pickVariant');
// Deliberately out of order: pickVariant must not trust the caller's sort.
const ladder = [
  { height: 480, bandwidth: 900_000 },
  { height: 1080, bandwidth: 5_000_000 },
  { height: 360, bandwidth: 500_000 },
  { height: 720, bandwidth: 2_500_000 },
];
test('best takes the tallest', () => assert.equal(CVA.pickVariant(ladder, 'best').height, 1080));
test('ask behaves as best until the user picks', () => assert.equal(CVA.pickVariant(ladder, 'ask').height, 1080));
test('worst takes the shortest', () => assert.equal(CVA.pickVariant(ladder, 'worst').height, 360));
test('a ceiling takes the tallest at or below it', () => assert.equal(CVA.pickVariant(ladder, '720').height, 720));
test('an exact match is not skipped', () => assert.equal(CVA.pickVariant(ladder, '480').height, 480));
test('a ceiling above everything takes the tallest', () => assert.equal(CVA.pickVariant(ladder, '2160').height, 1080));
test('a ceiling below everything takes the shortest rather than nothing', () => assert.equal(
  CVA.pickVariant(ladder, '240').height, 360,
));
test('ties break on bandwidth', () => {
  const tied = [
    { height: 720, bandwidth: 1_000_000 },
    { height: 720, bandwidth: 3_000_000 },
  ];
  assert.equal(CVA.pickVariant(tied, 'best').bandwidth, 3_000_000);
  assert.equal(CVA.pickVariant(tied, 'worst').bandwidth, 1_000_000);
});
test('variants with no resolution are a last resort, not a false match', () => {
  const mixed = [{ height: 0, bandwidth: 400_000, label: '400 kbps' }, { height: 1080, bandwidth: 5_000_000 }];
  // 0 <= 720 is true numerically, but an unknown height is not a 720p match.
  assert.equal(CVA.pickVariant(mixed, '720').height, 1080);
});
test('an unmeasurable ladder still yields something', () => {
  const opaque = [{ height: 0, bandwidth: 800_000 }, { height: 0, bandwidth: 200_000 }];
  assert.equal(CVA.pickVariant(opaque, '720').bandwidth, 800_000);
});
test('an empty list picks nothing', () => {
  assert.equal(CVA.pickVariant([], 'best'), null);
  assert.equal(CVA.pickVariant(undefined, 'best'), null);
});
test('the caller\'s array is left alone', () => {
  const before = ladder.map((v) => v.height);
  CVA.pickVariant(ladder, 'worst');
  assert.deepEqual(ladder.map((v) => v.height), before);
});

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
