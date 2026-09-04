/* Helper-service integration.
 *
 * A helper is an optional local program that does what a browser extension
 * cannot: remux MPEG-TS to MP4, mux separate audio and video tracks, and hand
 * awkward sites to yt-dlp. The extension never requires one, and is never bound
 * to a particular host — the endpoint is whatever the user configures. The
 * adapters below describe how to talk to a given service.
 *
 * The parsing helpers are pure and unit-tested in scripts/test-helper.mjs.
 */

function joinUrl(base, path) {
  const b = String(base || '').replace(/\/+$/, '');
  const p = String(path || '').replace(/^\/+/, '');
  return p ? `${b}/${p}` : b;
}

function authHeaders(cfg) {
  return cfg?.token ? { Authorization: `Bearer ${cfg.token}` } : {};
}

async function asJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON, got: ${text.slice(0, 120)}`);
  }
}

/* --------------------------- cva-helper (JSON) ---------------------------- */

// The reference server in server/cva_helper.py. Anyone can run it locally;
// see server/README.md.
const cvaHelper = {
  id: 'cva-helper',
  label: 'Clark Video Archiver helper',
  note: 'Full support: video, audio, HLS, remuxing. Run server/cva_helper.py locally.',
  formats: ['video', 'audio'],

  async health(cfg) {
    const res = await fetch(joinUrl(cfg.endpoint, 'api/health'), { headers: authHeaders(cfg) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const body = await asJson(res);
    if (!body.ok) throw new Error(body.error || 'Service reported not ok');
    return {
      ok: true,
      info: `${body.service || 'service'} v${body.version || '?'}`,
      capabilities: body.capabilities || {},
    };
  },

  async submit(cfg, job) {
    const res = await fetch(joinUrl(cfg.endpoint, 'api/jobs'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(cfg) },
      body: JSON.stringify({
        url: job.url,
        format: job.format || 'video',
        title: job.title || '',
        referer: job.referer || '',
        subtitles: Boolean(job.subtitles),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Service rejected the job (HTTP ${res.status}): ${body.slice(0, 200)}`);
    }
    const body = await asJson(res);
    if (!body.id) throw new Error('Service did not return a job id');
    return { jobId: body.id };
  },

  async status(cfg, jobId) {
    const res = await fetch(joinUrl(cfg.endpoint, `api/jobs/${encodeURIComponent(jobId)}`), {
      headers: authHeaders(cfg),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const b = await asJson(res);
    return {
      state: b.state || 'running',
      progress: Number(b.progress) || 0,
      message: b.message || '',
      filename: b.filename || '',
      size: Number(b.size) || 0,
      downloadUrl: b.download_url ? joinUrl(cfg.endpoint, b.download_url) : '',
    };
  },
};

/* ------------------------- ytgrab (legacy, HTML) -------------------------- */

// ytgrab_web.py predates this extension: it validates is_youtube_url() and
// produces MP3 only, so it cannot accept an .m3u8 or a direct video URL. It
// also speaks HTML rather than JSON, hence the scraping below. Kept because it
// is a real service people already run — but cva-helper is the capable path.
function parseYtgrabJobId(finalUrl) {
  const m = String(finalUrl).match(/\/jobs\/([A-Za-z0-9]+)/);
  return m ? m[1] : '';
}

function parseYtgrabStatus(html, endpoint) {
  const statusMatch = html.match(/<span class="status">([^<]*)<\/span>/i);
  const raw = (statusMatch?.[1] || '').trim().toLowerCase();
  const state = { done: 'done', failed: 'error', queued: 'queued', running: 'running' }[raw] || 'running';

  if (state === 'error') {
    const err = html.match(/<p class="error">([^<]*)<\/p>/i);
    return {
      state,
      progress: 0,
      message: (err?.[1] || 'Download failed').trim(),
      filename: '',
      downloadUrl: '',
    };
  }

  if (state === 'done') {
    // <a class="button" href="/ytgrab/files/<job>/<name>">Download <name></a>
    const link = html.match(/<a class="button" href="([^"]*\/files\/[^"]+)"/i);
    if (!link) {
      return {
        state: 'error',
        progress: 100,
        message: 'Job finished but no file link was found',
        filename: '',
        downloadUrl: '',
      };
    }
    const href = link[1].replace(/&amp;/g, '&');
    const filename = decodeURIComponent(href.split('/').pop() || 'audio.mp3');
    let downloadUrl = href;
    try {
      // href is site-absolute (/ytgrab/files/...), so resolve it on the origin.
      downloadUrl = new URL(href, endpoint).href;
    } catch {
      // Leave it as-is; the caller surfaces the resulting fetch failure.
    }
    return { state, progress: 100, message: '', filename, downloadUrl };
  }

  return { state, progress: 0, message: '', filename: '', downloadUrl: '' };
}

const ytgrab = {
  id: 'ytgrab',
  label: 'ytgrab (legacy)',
  note: 'YouTube URLs only, MP3 audio only — it cannot accept .m3u8 or direct video URLs.',
  formats: ['audio'],

  async health(cfg) {
    const res = await fetch(joinUrl(cfg.endpoint, ''), { headers: authHeaders(cfg) });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    if (!/ytgrab|youtube/i.test(text)) throw new Error('That URL does not look like a ytgrab instance');
    return { ok: true, info: 'ytgrab (HTML API)', capabilities: { audio: true, video: false, hls: false } };
  },

  async submit(cfg, job) {
    if (!/(youtube\.com|youtu\.be)/i.test(job.url)) {
      throw new Error('ytgrab only accepts YouTube URLs. Use the Clark Video Archiver helper for anything else.');
    }
    const res = await fetch(joinUrl(cfg.endpoint, 'download'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...authHeaders(cfg) },
      body: new URLSearchParams({ url: job.url }).toString(),
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`ytgrab rejected the job (HTTP ${res.status})`);
    const jobId = parseYtgrabJobId(res.url);
    if (!jobId) throw new Error('Could not determine the ytgrab job id from the redirect');
    return { jobId };
  },

  async status(cfg, jobId) {
    const res = await fetch(joinUrl(cfg.endpoint, `jobs/${encodeURIComponent(jobId)}`), {
      headers: authHeaders(cfg),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return { size: 0, ...parseYtgrabStatus(await res.text(), cfg.endpoint) };
  },
};

/* --------------------------------- client -------------------------------- */

const ADAPTERS = { [cvaHelper.id]: cvaHelper, [ytgrab.id]: ytgrab };

function adapterFor(cfg) {
  const a = ADAPTERS[cfg?.adapter];
  if (!a) throw new Error(`Unknown helper type: ${cfg?.adapter}`);
  if (!cfg.endpoint) throw new Error('No helper endpoint configured');
  return a;
}

// Poll until the job leaves a running state. Backs off gradually so a long
// encode does not hammer the service, and gives up rather than looping forever.
async function waitForJob(cfg, jobId, { onProgress, signal, timeoutMs = 2 * 60 * 60 * 1000 } = {}) {
  const adapter = adapterFor(cfg);
  const startedAt = Date.now();
  let delay = 1000;

  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled.');
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for the helper service.');

    const st = await adapter.status(cfg, jobId);
    onProgress?.(st);

    if (st.state === 'done') return st;
    if (st.state === 'error') throw new Error(st.message || 'The helper service reported a failure.');

    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.3, 5000);
  }
}

const Helper = {
  ADAPTERS,
  adapterFor,
  joinUrl,
  waitForJob,
  parseYtgrabJobId,
  parseYtgrabStatus,
  DEFAULT_CONFIG: {
    enabled: false,
    adapter: 'cva-helper',
    endpoint: 'http://127.0.0.1:8788',
    token: '',
  },
};

if (typeof globalThis !== 'undefined') globalThis.Helper = Helper;
