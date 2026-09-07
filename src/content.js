/* global CVA, api */
// Runs in every frame. Two jobs: report the media it can see, and perform the
// saves that only work from inside the page's own origin.

const MAX_IN_PAGE_BYTES = 1536 * 1024 * 1024; // 1.5 GB: past this, buffering the file in a tab is a bad idea

function absolute(url) {
  if (!url) return '';
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return '';
  }
}

// A <video> can carry its URL in three places, and currentSrc is the only one
// that reflects which <source> the browser actually chose.
function sourcesFor(el) {
  const urls = [];
  if (el.currentSrc) urls.push(el.currentSrc);
  if (el.src) urls.push(absolute(el.getAttribute('src')));
  for (const s of el.querySelectorAll('source')) {
    const u = absolute(s.getAttribute('src'));
    if (u) urls.push(u);
  }
  return [...new Set(urls.filter(Boolean))];
}

function describe(el, index) {
  const urls = sourcesFor(el);
  const url = urls[0] || '';
  const typeAttr = el.querySelector('source[type]')?.getAttribute('type') || '';
  return {
    index,
    url,
    alternates: urls.slice(1),
    mimeType: typeAttr,
    kind: CVA.classifyUrl(url, typeAttr) || 'unknown',
    tag: el.tagName.toLowerCase(),
    width: el.videoWidth || el.clientWidth || 0,
    height: el.videoHeight || el.clientHeight || 0,
    duration: Number.isFinite(el.duration) ? Math.round(el.duration) : 0,
    poster: absolute(el.getAttribute('poster')),
    title: (el.getAttribute('title') || el.getAttribute('aria-label') || '').slice(0, 120),
  };
}

// Web components put their <video> inside a shadow root, where a plain
// querySelectorAll from the document never looks. Brightspace's media player
// (d2l-labs-media-player) is one such component, so walk into every open
// shadow root as well.
function findMedia(root, out = []) {
  out.push(...root.querySelectorAll('video, audio'));
  for (const host of root.querySelectorAll('*')) {
    if (host.shadowRoot) findMedia(host.shadowRoot, out);
  }
  return out;
}

function collect() {
  const els = findMedia(document);
  // Biggest first: on a page of thumbnails, the one being watched is the big one.
  return els
    .map(describe)
    .filter((v) => v.url)
    .sort((a, b) => b.width * b.height - a.width * a.height);
}

function triggerAnchorDownload(objectUrl, filename) {
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Save a URL by fetching it in page context, which carries the page's cookies,
// Referer and Origin — the three things a bare downloads.download() call lacks.
async function saveByFetching(url, pageTitle, mimeHint) {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { ok: false, error: `Server replied ${res.status} ${res.statusText}` };

    const len = Number(res.headers.get('content-length')) || 0;
    if (len > MAX_IN_PAGE_BYTES) {
      return {
        ok: false,
        error: `File is ${CVA.humanSize(len)} — too large to buffer in the page. Try the direct URL from the popup.`,
      };
    }

    const mimeType = res.headers.get('content-type') || mimeHint || '';
    const blob = await res.blob();
    const filename = CVA.buildFilename({ pageTitle, url, mimeType }).split('/').pop();
    const objectUrl = URL.createObjectURL(blob);
    triggerAnchorDownload(objectUrl, filename);
    // Give the download a moment to latch onto the object URL before revoking.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function saveBlobUrl(url, pageTitle) {
  try {
    // A blob: backed by a MediaSource throws here rather than returning bytes —
    // that is the signal the video is streamed and has no single file.
    const res = await fetch(url);
    const blob = await res.blob();
    if (!blob.size) return { ok: false, error: 'empty blob' };
    const filename = CVA.buildFilename({ pageTitle, url, mimeType: blob.type }).split('/').pop();
    const objectUrl = URL.createObjectURL(blob);
    triggerAnchorDownload(objectUrl, filename);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'collect':
        sendResponse({ videos: collect() });
        return;
      case 'saveBlob':
        sendResponse(await saveBlobUrl(msg.url, msg.title || document.title));
        return;
      case 'saveViaFetch':
        sendResponse(await saveByFetching(msg.url, msg.title || document.title, msg.mimeType));
        return;
      default:
        sendResponse({ ok: false });
    }
  })();
  return true;
});

// Report what is already in the DOM, then again as players swap sources in.
// Only send when something changed, so the periodic rescan below stays quiet.
let lastReport = '';
function report() {
  const videos = collect();
  if (!videos.length) return;
  const sig = JSON.stringify(videos.map((v) => [v.url, v.width, v.height, v.duration]));
  if (sig === lastReport) return;
  lastReport = sig;
  api.runtime.sendMessage({ type: 'domFound', videos }).catch(() => {});
}

let reportTimer = null;
function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(report, 800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleReport, { once: true });
} else {
  scheduleReport();
}

new MutationObserver((records) => {
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType === 1 && (n.matches?.('video, audio') || n.querySelector?.('video, audio'))) {
        scheduleReport();
        return;
      }
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

// currentSrc is often empty until playback starts, so catch it when it fills in.
document.addEventListener('loadedmetadata', scheduleReport, true);

// Neither the mutation observer nor loadedmetadata (not a composed event) sees
// inside a shadow root, so a slow rescan is the only reliable way to notice a
// player that lives in one. report() is a no-op when nothing has changed.
setInterval(() => {
  if (!document.hidden) report();
}, 2500);
