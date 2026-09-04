// Unit tests for the helper-service layer in src/helper.js.
// Adapters are exercised against a stubbed fetch, so the request each one
// actually builds is checked rather than assumed.
// Run: node scripts/test-helper.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let stub = null;
const sandbox = {
  globalThis: null,
  URL,
  URLSearchParams,
  console,
  setTimeout,
  fetch: (...args) => stub(...args),
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(root, 'src/helper.js'), 'utf8'), sandbox);
const Helper = sandbox.Helper;

let failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

function reply(body, { status = 200, url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    url,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const CFG = { adapter: 'cva-helper', endpoint: 'http://127.0.0.1:8788', token: '' };
const YT = { adapter: 'ytgrab', endpoint: 'http://pluto.local/ytgrab' };

/* -------------------------------- joinUrl -------------------------------- */
test('joinUrl joins cleanly', () => {
  assert.equal(Helper.joinUrl('http://x/', 'api/health'), 'http://x/api/health');
});
test('joinUrl tolerates double slashes', () => {
  assert.equal(Helper.joinUrl('http://x//', '/api/health'), 'http://x/api/health');
});
test('joinUrl with empty path returns the base', () => {
  assert.equal(Helper.joinUrl('http://x/y/', ''), 'http://x/y');
});

/* ------------------------------- adapterFor ------------------------------ */
test('adapterFor resolves a known adapter', () => {
  assert.equal(Helper.adapterFor(CFG).id, 'cva-helper');
});
test('adapterFor rejects an unknown type', () => {
  assert.throws(() => Helper.adapterFor({ adapter: 'nope', endpoint: 'http://x' }), /Unknown helper type/);
});
test('adapterFor requires an endpoint', () => {
  assert.throws(() => Helper.adapterFor({ adapter: 'cva-helper', endpoint: '' }), /No helper endpoint/);
});

/* ------------------------------- cva-helper ------------------------------ */
test('health reads service identity and capabilities', async () => {
  stub = async (url) => {
    assert.equal(url, 'http://127.0.0.1:8788/api/health');
    return reply({ ok: true, service: 'cva-helper', version: '1', capabilities: { video: true } });
  };
  const h = await Helper.ADAPTERS['cva-helper'].health(CFG);
  assert.equal(h.ok, true);
  assert.match(h.info, /cva-helper/);
  assert.equal(h.capabilities.video, true);
});

test('health rejects a service reporting not-ok', async () => {
  stub = async () => reply({ ok: false, error: 'ffmpeg missing' });
  await assert.rejects(() => Helper.ADAPTERS['cva-helper'].health(CFG), /ffmpeg missing/);
});

test('health surfaces non-JSON as a clear error', async () => {
  stub = async () => reply('<html>not the droid you want</html>');
  await assert.rejects(() => Helper.ADAPTERS['cva-helper'].health(CFG), /Expected JSON/);
});

test('submit posts the job as JSON and returns the id', async () => {
  let seen = null;
  stub = async (url, opts) => {
    seen = { url, opts };
    return reply({ id: 'abc123', state: 'queued' }, { status: 201 });
  };
  const { jobId } = await Helper.ADAPTERS['cva-helper'].submit(CFG, {
    url: 'http://host/v.m3u8', format: 'video', title: 'My Clip',
  });
  assert.equal(jobId, 'abc123');
  assert.equal(seen.url, 'http://127.0.0.1:8788/api/jobs');
  assert.equal(seen.opts.method, 'POST');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.url, 'http://host/v.m3u8');
  assert.equal(body.title, 'My Clip');
  assert.equal(body.format, 'video');
});

test('submit sends a bearer token when configured', async () => {
  let headers = null;
  stub = async (url, opts) => { headers = opts.headers; return reply({ id: 'x' }, { status: 201 }); };
  await Helper.ADAPTERS['cva-helper'].submit({ ...CFG, token: 's3cret' }, { url: 'http://h/v.mp4' });
  assert.equal(headers.Authorization, 'Bearer s3cret');
});

test('submit omits the auth header when no token is set', async () => {
  let headers = null;
  stub = async (url, opts) => { headers = opts.headers; return reply({ id: 'x' }, { status: 201 }); };
  await Helper.ADAPTERS['cva-helper'].submit(CFG, { url: 'http://h/v.mp4' });
  assert.equal(headers.Authorization, undefined);
});

test('submit fails loudly when no id comes back', async () => {
  stub = async () => reply({ state: 'queued' }, { status: 201 });
  await assert.rejects(() => Helper.ADAPTERS['cva-helper'].submit(CFG, { url: 'http://h/v.mp4' }), /did not return a job id/);
});

test('status makes the download URL absolute', async () => {
  stub = async () => reply({
    id: 'a', state: 'done', progress: 100, filename: 'Clip.mp4', size: 1234,
    download_url: '/api/files/a/Clip.mp4',
  });
  const st = await Helper.ADAPTERS['cva-helper'].status(CFG, 'a');
  assert.equal(st.state, 'done');
  assert.equal(st.downloadUrl, 'http://127.0.0.1:8788/api/files/a/Clip.mp4');
  assert.equal(st.size, 1234);
});

/* --------------------------------- ytgrab -------------------------------- */
test('ytgrab extracts the job id from the redirect URL', () => {
  assert.equal(Helper.parseYtgrabJobId('http://h/ytgrab/jobs/deadbeef00'), 'deadbeef00');
});
test('ytgrab returns empty for an unrelated URL', () => {
  assert.equal(Helper.parseYtgrabJobId('http://h/ytgrab/'), '');
});

test('ytgrab parses a running job', () => {
  const st = Helper.parseYtgrabStatus('<p><span class="status">running</span></p>', YT.endpoint);
  assert.equal(st.state, 'running');
});

test('ytgrab parses a finished job and its file link', () => {
  const html = '<span class="status">done</span>'
    + '<a class="button" href="/ytgrab/files/abc/My%20Song.mp3">Download My Song.mp3</a>';
  const st = Helper.parseYtgrabStatus(html, YT.endpoint);
  assert.equal(st.state, 'done');
  assert.equal(st.filename, 'My Song.mp3');
  assert.equal(st.downloadUrl, 'http://pluto.local/ytgrab/files/abc/My%20Song.mp3');
});

test('ytgrab parses a failure and its message', () => {
  const html = '<span class="status">failed</span><p class="error">Video unavailable</p>';
  const st = Helper.parseYtgrabStatus(html, YT.endpoint);
  assert.equal(st.state, 'error');
  assert.equal(st.message, 'Video unavailable');
});

test('ytgrab treats a done job with no link as an error', () => {
  const st = Helper.parseYtgrabStatus('<span class="status">done</span>', YT.endpoint);
  assert.equal(st.state, 'error');
  assert.match(st.message, /no file link/i);
});

test('ytgrab refuses a non-YouTube URL rather than failing later', async () => {
  stub = async () => reply('should not be called');
  await assert.rejects(
    () => Helper.ADAPTERS.ytgrab.submit(YT, { url: 'https://example.com/video.m3u8' }),
    /only accepts YouTube/,
  );
});

test('ytgrab accepts a YouTube URL and reads the redirect', async () => {
  stub = async (url, opts) => {
    assert.equal(url, 'http://pluto.local/ytgrab/download');
    assert.match(opts.body, /^url=/);
    return reply('ok', { url: 'http://pluto.local/ytgrab/jobs/ff00aa' });
  };
  const { jobId } = await Helper.ADAPTERS.ytgrab.submit(YT, { url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal(jobId, 'ff00aa');
});

/* ------------------------------- waitForJob ------------------------------ */
test('waitForJob resolves once the job is done', async () => {
  const states = ['queued', 'running', 'done'];
  let i = 0;
  stub = async () => reply({
    state: states[i++], progress: i * 30, filename: 'out.mp4', download_url: '/api/files/a/out.mp4',
  });
  const seen = [];
  const final = await Helper.waitForJob(CFG, 'a', { onProgress: (s) => seen.push(s.state) });
  assert.equal(final.state, 'done');
  assert.deepEqual([...seen], ['queued', 'running', 'done']);
});

test('waitForJob rejects with the service message on error', async () => {
  stub = async () => reply({ state: 'error', message: 'ffmpeg exploded' });
  await assert.rejects(() => Helper.waitForJob(CFG, 'a'), /ffmpeg exploded/);
});

test('waitForJob honours an abort signal', async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  stub = async () => reply({ state: 'running' });
  await assert.rejects(() => Helper.waitForJob(CFG, 'a', { signal: ctrl.signal }), /Cancelled/);
});

/* --------------------------------- runner -------------------------------- */
const results = [];
for (const [name, fn] of tests) {
  try {
    await fn();
    results.push(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    results.push(`  FAIL ${name}\n       ${err.message}`);
  }
}
console.log(results.join('\n'));
console.log(failed ? `\n${failed} test(s) failed` : '\nall tests passed');
process.exit(failed ? 1 : 0);
