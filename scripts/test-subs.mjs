// Unit tests for the WebVTT handling in src/subs.js.
// Run: node scripts/test-subs.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { globalThis: null, console };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'src/subs.js'), 'utf8'), sandbox);
const Subs = sandbox.Subs;

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

const SIMPLE = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello there

00:00:05.500 --> 00:00:07.250
Second line
wrapped across two
`;

console.log('parseCues');
test('reads both cues', () => assert.equal(Subs.parseCues(SIMPLE).length, 2));
test('reads start and end times', () => {
  const c = Subs.parseCues(SIMPLE)[0];
  assert.equal(c.start, 1);
  assert.equal(c.end, 4);
});
test('handles fractional seconds', () => {
  const c = Subs.parseCues(SIMPLE)[1];
  assert.equal(c.start, 5.5);
  assert.equal(c.end, 7.25);
});
test('keeps multi-line cue text', () => {
  assert.equal(Subs.parseCues(SIMPLE)[1].text, 'Second line\nwrapped across two');
});
test('ignores the WEBVTT header', () => {
  assert.ok(Subs.parseCues(SIMPLE).every((c) => !c.text.includes('WEBVTT')));
});
test('skips NOTE and STYLE blocks', () => {
  const withNote = `WEBVTT

NOTE this is a comment

STYLE
::cue { color: white }

00:00:01.000 --> 00:00:02.000
Real cue
`;
  const cues = Subs.parseCues(withNote);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'Real cue');
});
test('accepts MM:SS.mmm without an hours field', () => {
  const c = Subs.parseCues('WEBVTT\n\n01:02.500 --> 01:04.000\nShort form\n');
  assert.equal(c.length, 1);
  assert.equal(c[0].start, 62.5);
});
test('keeps cue settings', () => {
  const c = Subs.parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 line:90% align:middle\nPositioned\n');
  assert.equal(c[0].settings, 'line:90% align:middle');
});
test('handles a cue identifier line', () => {
  const c = Subs.parseCues('WEBVTT\n\ncue-7\n00:00:01.000 --> 00:00:02.000\nIdentified\n');
  assert.equal(c.length, 1);
  assert.equal(c[0].text, 'Identified');
});
test('handles CRLF line endings', () => {
  assert.equal(Subs.parseCues(SIMPLE.replace(/\n/g, '\r\n')).length, 2);
});
test('drops a cue with no text', () => {
  assert.equal(Subs.parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n').length, 0);
});

console.log('timestampMapOffset');
test('reads an MPEGTS/LOCAL pair', () => {
  const off = Subs.timestampMapOffset('WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n');
  assert.equal(off, 10); // 900000 / 90000 Hz
});
test('returns null when absent', () => {
  assert.equal(Subs.timestampMapOffset('WEBVTT\n\n'), null);
});

console.log('mergeSegments');
test('joins segments and keeps order', () => {
  const segs = [
    { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n', start: 0, duration: 10 },
    { text: 'WEBVTT\n\n00:00:11.000 --> 00:00:12.000\nTwo\n', start: 10, duration: 10 },
  ];
  const cues = Subs.mergeSegments(segs);
  assert.equal(cues.length, 2);
  assert.equal(cues.map((c) => c.text).join(','), 'One,Two');
});

test('absolute segment times are left alone', () => {
  // The second segment's cue is already past its own start, so it is absolute
  // and must not be shifted again.
  const segs = [
    { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n', start: 0, duration: 10 },
    { text: 'WEBVTT\n\n00:00:11.000 --> 00:00:12.000\nTwo\n', start: 10, duration: 10 },
  ];
  assert.equal(Subs.mergeSegments(segs)[1].start, 11);
});

test('segment-local times are shifted by the segment start', () => {
  // Both cues sit inside their own segment duration, so the second is local
  // and needs its segment start added.
  const segs = [
    { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOne\n', start: 0, duration: 10 },
    { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTwo\n', start: 10, duration: 10 },
  ];
  const cues = Subs.mergeSegments(segs);
  assert.equal(cues[1].start, 11, 'expected 1s local + 10s segment start');
  assert.equal(cues[1].end, 12);
});

test('a cue repeated across a boundary appears once', () => {
  const dup = 'WEBVTT\n\n00:00:09.000 --> 00:00:11.000\nSpanning\n';
  const segs = [
    { text: dup, start: 0, duration: 10 },
    { text: dup, start: 10, duration: 10 },
  ];
  const cues = Subs.mergeSegments(segs);
  assert.equal(cues.length, 1, 'boundary-spanning cue should be de-duplicated');
});

test('output is sorted by start time', () => {
  const segs = [
    { text: 'WEBVTT\n\n00:00:20.000 --> 00:00:21.000\nLate\n', start: 0, duration: 30 },
    { text: 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nEarly\n', start: 0, duration: 30 },
  ];
  assert.equal(Subs.mergeSegments(segs).map((c) => c.text).join(','), 'Early,Late');
});

test('empty segment list yields no cues', () => {
  assert.equal(Subs.mergeSegments([]).length, 0);
});

console.log('formatTime');
test('formats with milliseconds', () => assert.equal(Subs.formatTime(3661.5), '01:01:01.500'));
test('formats zero', () => assert.equal(Subs.formatTime(0), '00:00:00.000'));
test('clamps negatives to zero', () => assert.equal(Subs.formatTime(-5), '00:00:00.000'));
test('uses a comma separator when asked', () => assert.equal(Subs.formatTime(1.25, ','), '00:00:01,250'));

console.log('toVtt');
test('emits a WEBVTT header', () => {
  const out = Subs.toVtt(Subs.parseCues(SIMPLE));
  assert.ok(out.startsWith('WEBVTT\n\n'), out.slice(0, 30));
});
test('round-trips through parse without loss', () => {
  const once = Subs.parseCues(SIMPLE);
  const twice = Subs.parseCues(Subs.toVtt(once));
  assert.equal(twice.length, once.length);
  assert.equal(twice[1].text, once[1].text);
  assert.equal(twice[1].start, once[1].start);
});
test('preserves cue settings', () => {
  const cues = Subs.parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:middle\nX\n');
  assert.match(Subs.toVtt(cues), /align:middle/);
});

console.log('toSrt');
test('numbers cues from 1', () => {
  const out = Subs.toSrt(Subs.parseCues(SIMPLE));
  assert.ok(out.startsWith('1\n'), out.slice(0, 20));
  assert.match(out, /\n2\n/);
});
test('uses comma before milliseconds', () => {
  const out = Subs.toSrt(Subs.parseCues(SIMPLE));
  assert.match(out, /00:00:01,000 --> 00:00:04,000/);
});
test('drops cue settings, which SRT has no syntax for', () => {
  const cues = Subs.parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:middle\nX\n');
  assert.ok(!Subs.toSrt(cues).includes('align:middle'));
});

console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
