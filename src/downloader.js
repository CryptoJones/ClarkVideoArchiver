/* global CVA, HLS, Subs, Helper, api */
// The HLS download engine. This runs as a full extension page rather than in
// the background: a multi-thousand-segment download takes minutes, and Chrome
// terminates an idle MV3 service worker after ~30 seconds. A page also gives
// the user somewhere to watch progress and a way to cancel.

const CONCURRENCY = 6;
const RETRIES = 3;

const els = {
  status: document.getElementById('status'),
  detail: document.getElementById('detail'),
  variants: document.getElementById('variants'),
  variantList: document.getElementById('variant-list'),
  progressWrap: document.getElementById('progress-wrap'),
  bar: document.getElementById('bar'),
  counts: document.getElementById('counts'),
  rate: document.getElementById('rate'),
  start: document.getElementById('start'),
  cancel: document.getElementById('cancel'),
  warnings: document.getElementById('warnings'),
  source: document.getElementById('source'),
};

const params = new URLSearchParams(location.search);
const playlistUrl = params.get('url') || '';
const pageTitle = params.get('title') || 'video';
// 'helper' hands the URL to a local service instead of assembling in-browser.
const mode = params.get('mode') || 'hls';
const format = params.get('format') === 'audio' ? 'audio' : 'video';

let controller = null;
let plan = null;
// Subtitle tracks live in the master playlist, so they have to be kept from
// that parse — by the time a variant is chosen the master is out of scope.
let subtitleTracks = [];
// Likewise the audio rendition, when the video variant has no sound of its own.
let audioTrack = null;

function setStatus(text, kind = '') {
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

function warn(text, kind = 'warn') {
  const p = document.createElement('p');
  p.className = `notice ${kind}`;
  p.textContent = text;
  els.warnings.append(p);
}

function clearWarnings() {
  els.warnings.textContent = '';
}

async function fetchWithRetry(url, { byteRange, signal, asText = false } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const headers = {};
      if (byteRange) {
        const end = byteRange.offset + byteRange.length - 1;
        headers.Range = `bytes=${byteRange.offset}-${end}`;
      }
      const res = await fetch(url, { headers, signal, credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return asText ? await res.text() : await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      // Back off before retrying; a CDN under load recovers given a moment.
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

/* ------------------------------- planning -------------------------------- */

async function loadPlaylist(url) {
  const text = await fetchWithRetry(url, { asText: true });
  if (!/#EXTM3U/.test(text)) throw new Error('That URL did not return an HLS playlist.');
  return HLS.parsePlaylist(text, url);
}

async function buildPlan(mediaUrl, variantLabel) {
  const parsed = await loadPlaylist(mediaUrl);
  if (parsed.isMaster) throw new Error('Nested master playlist; pick a variant.');

  if (!parsed.segments.length) throw new Error('The playlist contains no segments.');

  const enc = HLS.encryptionSupport(parsed.encryption);
  const container = HLS.containerFor(parsed);

  return { ...parsed, mediaUrl, variantLabel, enc, container };
}

function describePlan(p) {
  const mins = Math.floor(p.totalDuration / 60);
  const secs = String(Math.round(p.totalDuration % 60)).padStart(2, '0');
  const bits = [
    `${p.segments.length} segments`,
    p.totalDuration ? `${mins}:${secs}` : null,
    p.variantLabel || null,
    `.${p.container.ext}`,
    p.encryption !== 'NONE' ? `encrypted (${p.encryption})` : null,
  ].filter(Boolean);
  return bits.join('  ·  ');
}

/* ------------------------------ decryption ------------------------------- */

const keyCache = new Map();

async function keyFor(segment, signal) {
  const url = segment.key.url;
  if (!keyCache.has(url)) {
    const raw = await fetchWithRetry(url, { signal });
    keyCache.set(url, await crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']));
  }
  return keyCache.get(url);
}

async function fetchSegment(segment, signal) {
  const buf = await fetchWithRetry(segment.url, { byteRange: segment.byteRange, signal });
  if (!segment.key) return buf;

  const key = await keyFor(segment, signal);
  const iv = HLS.ivForSegment(segment);
  try {
    // HLS AES-128 is CBC with PKCS#7 padding, which WebCrypto strips for us.
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
  } catch (err) {
    throw new Error(`Segment ${segment.seq} failed to decrypt (${err.message}).`);
  }
}

/* ------------------------------ downloading ------------------------------ */

// Fetch one media playlist end to end and return it as a single Blob. Used for
// the audio rendition, which is its own playlist of segments.
async function assembleTrack(mediaUrl, signal, onProgress) {
  const parsed = await loadPlaylist(mediaUrl);
  if (parsed.isMaster) throw new Error('Expected a media playlist for this track.');
  if (!parsed.segments.length) throw new Error('That track lists no segments.');

  const support = HLS.encryptionSupport(parsed.encryption);
  if (!support.supported) throw new Error(support.reason);

  const container = HLS.containerFor(parsed);
  const total = parsed.segments.length;
  const parts = new Array(total).fill(null);
  let initBlob = null;
  let done = 0;

  if (parsed.initSegment?.url) {
    const buf = await fetchWithRetry(parsed.initSegment.url, {
      byteRange: parsed.initSegment.byteRange,
      signal,
    });
    initBlob = new Blob([buf]);
  }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= total) return;
      const buf = await fetchSegment(parsed.segments[i], signal);
      parts[i] = new Blob([buf]);
      done += 1;
      onProgress?.(done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  if (signal.aborted) throw new Error('Cancelled.');

  const ordered = initBlob ? [initBlob, ...parts] : parts;
  return { blob: new Blob(ordered, { type: container.mime }), container };
}

// A browser cannot mux audio into video, so when the stream splits them the
// honest thing is to save both and hand over the one-line join.
async function maybeSaveAudioTrack(signal) {
  if (!audioTrack?.url) return;
  try {
    setStatus('Downloading the separate audio track...');
    els.bar.style.width = '0%';
    const { blob, container } = await assembleTrack(audioTrack.url, signal, (d, t) => {
      els.bar.style.width = `${Math.round((d / t) * 100)}%`;
      els.counts.textContent = `audio: ${d} / ${t} segments`;
    });

    const base = CVA.buildFilename({ pageTitle, url: 'x.mp4', mimeType: '' }).replace(/\.mp4$/, '');
    const filename = `${base}.audio.${container.ext}`;
    const objectUrl = URL.createObjectURL(blob);
    await api.downloads.download({ url: objectUrl, filename });
    setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);

    setStatus(`Saved video and audio (${CVA.humanSize(blob.size)} audio)`, 'ok');
    warn(
      `Audio saved separately as "${filename.split('/').pop()}". Join them with:  `
      + 'ffmpeg -i <video> -i <audio> -c copy merged.mp4',
      'info',
    );
  } catch (err) {
    // The video already saved; a failed audio track must not undo that.
    warn(`Could not save the separate audio track: ${String(err.message || err)}`, 'warn');
  }
}

async function run() {
  clearWarnings();
  controller = new AbortController();
  const { signal } = controller;
  els.start.disabled = true;
  els.cancel.hidden = false;
  els.progressWrap.hidden = false;

  const total = plan.segments.length;
  // Blobs rather than ArrayBuffers: the browser can page blob data out to disk,
  // which is what keeps a multi-GB assembly from exhausting memory.
  const parts = new Array(total).fill(null);
  let done = 0;
  let bytes = 0;
  const startedAt = Date.now();

  const tick = () => {
    const pct = Math.round((done / total) * 100);
    els.bar.style.width = `${pct}%`;
    els.counts.textContent = `${done} / ${total} segments  ·  ${CVA.humanSize(bytes)}`;
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed > 2 && done > 0) {
      const perSeg = elapsed / done;
      const eta = Math.round(perSeg * (total - done));
      els.rate.textContent = `${CVA.humanSize(bytes / elapsed)}/s  ·  about ${eta}s left`;
    }
  };

  if (plan.initSegment?.url) {
    setStatus('Fetching init segment...');
    const initBuf = await fetchWithRetry(plan.initSegment.url, {
      byteRange: plan.initSegment.byteRange,
      signal,
    });
    plan.initBlob = new Blob([initBuf]);
    bytes += initBuf.byteLength;
  }

  setStatus('Downloading segments...');

  // A fixed pool of workers pulling from a shared cursor. Results go into their
  // own index, so segments are written in playlist order no matter what order
  // the network returns them in.
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= total) return;
      const buf = await fetchSegment(plan.segments[i], signal);
      parts[i] = new Blob([buf]);
      bytes += buf.byteLength;
      done += 1;
      tick();
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));

  if (signal.aborted) throw new Error('Cancelled.');

  setStatus('Assembling file...');
  const ordered = plan.initBlob ? [plan.initBlob, ...parts] : parts;
  const blob = new Blob(ordered, { type: plan.container.mime });

  const filename = CVA.buildFilename({
    pageTitle,
    url: `x.${plan.container.ext}`,
    mimeType: plan.container.mime,
  });

  const objectUrl = URL.createObjectURL(blob);
  await api.downloads.download({ url: objectUrl, filename });
  setTimeout(() => URL.revokeObjectURL(objectUrl), 120_000);

  setStatus(`Saved — ${CVA.humanSize(blob.size)}`, 'ok');
  els.rate.textContent = '';
  els.cancel.hidden = true;

  if (plan.container.remuxNeeded) {
    warn(`${plan.container.note}  Command: ffmpeg -i "${filename.split('/').pop()}" -c copy "output.mp4"`, 'info');
  }

  await maybeSaveAudioTrack(signal);
  await maybeSaveSubtitles(signal);
}

/* ------------------------------- subtitles ------------------------------- */

// Each subtitle track is its own playlist of WebVTT segments. They are small,
// so they are fetched in order rather than in parallel.
async function fetchSubtitleTrack(track, signal) {
  const text = await fetchWithRetry(track.url, { asText: true, signal });
  const parsed = HLS.parsePlaylist(text, track.url);
  if (parsed.isMaster || !parsed.segments?.length) return null;

  const segments = [];
  let clock = 0;
  for (const seg of parsed.segments) {
    const body = await fetchWithRetry(seg.url, { asText: true, signal });
    segments.push({ text: body, start: clock, duration: seg.duration });
    clock += seg.duration;
  }
  return Subs.mergeSegments(segments);
}

async function maybeSaveSubtitles(signal) {
  const { saveSubtitles = false, subtitleFormat = 'vtt' } = await api.storage.local.get([
    'saveSubtitles',
    'subtitleFormat',
  ]);
  if (!saveSubtitles) return;

  if (!subtitleTracks.length) {
    warn('Subtitles were requested, but this stream lists no subtitle track.', 'info');
    return;
  }

  for (const track of subtitleTracks) {
    try {
      setStatus(`Fetching subtitles (${track.name || track.language || 'track'})...`);
      const cues = await fetchSubtitleTrack(track, signal);
      if (!cues?.length) {
        warn(`Subtitle track "${track.name || track.language}" was empty.`, 'info');
        continue;
      }

      const ext = subtitleFormat === 'srt' ? 'srt' : 'vtt';
      const body = ext === 'srt' ? Subs.toSrt(cues) : Subs.toVtt(cues);
      const lang = track.language || track.name || 'subs';
      // Same base name as the video, with the language before the extension,
      // which is what players look for when auto-loading a sidecar file.
      const base = CVA.buildFilename({ pageTitle, url: 'x.mp4', mimeType: '' }).replace(/\.mp4$/, '');
      const blob = new Blob([body], { type: ext === 'srt' ? 'text/plain' : 'text/vtt' });
      const objectUrl = URL.createObjectURL(blob);
      await api.downloads.download({ url: objectUrl, filename: `${base}.${CVA.sanitizeFilename(lang, 'subs')}.${ext}` });
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);

      setStatus(`Saved with subtitles (${cues.length} cues)`, 'ok');
    } catch (err) {
      // A missing subtitle track must not invalidate a video that already saved.
      warn(`Could not save subtitles: ${String(err.message || err)}`, 'warn');
    }
  }
}

/* ---------------------------- variant selection --------------------------- */

function showVariants(master) {
  els.variants.hidden = false;
  els.variantList.textContent = '';

  for (const v of master.variants) {
    const audio = HLS.audioRenditionFor(v, master.media);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'variant';
    const label = v.height ? `${v.height}p` : v.label;
    const rate = v.bandwidth ? ` · ${Math.round(v.bandwidth / 1000)} kbps` : '';
    btn.innerHTML = `<strong></strong><span></span>`;
    btn.querySelector('strong').textContent = label;
    btn.querySelector('span').textContent = `${v.width && v.height ? `${v.width}x${v.height}` : ''}${rate}`;

    btn.addEventListener('click', async () => {
      els.variants.hidden = true;
      subtitleTracks = HLS.subtitleRenditions(master.media, v.subtitleGroup);
      await prepare(v.url, label, audio);
    });
    els.variantList.append(btn);
  }
}

async function prepare(mediaUrl, label, audioRendition) {
  audioTrack = audioRendition || null;
  try {
    setStatus('Reading playlist...');
    plan = await buildPlan(mediaUrl, label);

    if (plan.isLive) {
      warn('This is a live playlist with no end marker. Only the segments currently listed will be saved.');
    }
    if (!plan.enc.supported) {
      setStatus('Cannot save this stream', 'error');
      warn(plan.enc.reason, 'error');
      return;
    }
    if (plan.encryption === 'AES-128') {
      warn('Stream uses standard AES-128 transport encryption; the key will be fetched from the playlist as any player does.', 'info');
    }
    // Separate audio means the video segments are silent. Saying so up front
    // beats handing over a mute file and letting the user discover it.
    if (audioRendition) {
      warn(
        `This variant carries audio as a separate track ("${audioRendition.name || audioRendition.language || 'audio'}"). `
        + 'The video and the audio will be saved as two files, because a browser cannot mux them. '
        + 'Join them with:  ffmpeg -i video -i audio -c copy merged.mp4',
      );
    }

    els.detail.textContent = describePlan(plan);
    setStatus('Ready');
    els.start.hidden = false;
    els.start.disabled = false;
  } catch (err) {
    setStatus('Failed', 'error');
    warn(String(err.message || err), 'error');
  }
}

/* ---------------------------- helper service ----------------------------- */

// The service does the work; the browser only tracks the job and fetches the
// result. Polling lives here rather than in the background worker because a
// long encode outlives an idle MV3 service worker.
async function runHelper() {
  const { helper: cfg } = await api.storage.local.get('helper');
  if (!cfg?.enabled || !cfg.endpoint) {
    setStatus('No helper configured', 'error');
    warn('Enable and configure a helper service in the extension settings first.', 'error');
    return;
  }

  const adapter = Helper.adapterFor(cfg);
  document.querySelector('h1').textContent = `Sending to ${adapter.label}`;

  controller = new AbortController();
  els.cancel.hidden = false;
  els.progressWrap.hidden = false;

  const { saveSubtitles = false } = await api.storage.local.get('saveSubtitles');

  setStatus('Submitting job...');
  const { jobId } = await adapter.submit(cfg, {
    url: playlistUrl,
    format,
    title: pageTitle,
    referer: params.get('referer') || '',
    subtitles: saveSubtitles,
  });

  setStatus('Service is working...');
  const final = await Helper.waitForJob(cfg, jobId, {
    signal: controller.signal,
    onProgress: (st) => {
      const pct = Math.max(0, Math.min(100, st.progress || 0));
      els.bar.style.width = `${pct}%`;
      els.counts.textContent = st.message || `${Math.round(pct)}%`;
      els.rate.textContent = st.filename || '';
    },
  });

  if (!final.downloadUrl) throw new Error('The service finished but returned no file to download.');

  setStatus('Fetching the finished file...');
  const filename = CVA.buildFilename({
    pageTitle: final.filename ? final.filename.replace(/\.[^.]+$/, '') : pageTitle,
    url: final.filename || playlistUrl,
    mimeType: '',
  });

  // Route through the downloads API so it lands in the normal place and shows
  // up in the browser's download list like any other save.
  await api.downloads.download({ url: final.downloadUrl, filename });

  els.bar.style.width = '100%';
  setStatus(`Saved${final.size ? ` — ${CVA.humanSize(final.size)}` : ''}`, 'ok');
  els.counts.textContent = final.filename || '';
  els.rate.textContent = '';
  els.cancel.hidden = true;
}

/* -------------------------------- startup -------------------------------- */

async function init() {
  els.source.textContent = playlistUrl;
  if (!playlistUrl) {
    setStatus('No URL supplied', 'error');
    return;
  }

  if (mode === 'helper') {
    try {
      await runHelper();
    } catch (err) {
      const msg = String(err.message || err);
      setStatus(msg === 'Cancelled.' ? 'Cancelled' : 'Failed', 'error');
      if (msg !== 'Cancelled.') warn(msg, 'error');
      els.cancel.hidden = true;
    }
    return;
  }

  try {
    setStatus('Reading playlist...');
    const parsed = await loadPlaylist(playlistUrl);
    if (parsed.isMaster) {
      if (!parsed.variants.length) throw new Error('Master playlist lists no variants.');
      setStatus('Choose a quality');
      showVariants(parsed);
      return;
    }
    subtitleTracks = [];
    await prepare(playlistUrl, '', null);
  } catch (err) {
    setStatus('Failed', 'error');
    warn(String(err.message || err), 'error');
  }
}

els.start.addEventListener('click', () => {
  run().catch((err) => {
    setStatus(String(err.message || err) === 'Cancelled.' ? 'Cancelled' : 'Failed', 'error');
    if (String(err.message || err) !== 'Cancelled.') warn(String(err.message || err), 'error');
    els.start.disabled = false;
    els.cancel.hidden = true;
  });
});

els.cancel.addEventListener('click', () => {
  controller?.abort();
  setStatus('Cancelling...');
});

init();
