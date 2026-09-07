/* global CVA, api */

const listEl = document.getElementById('list');
const ffmpegEl = document.getElementById('ffmpeg');
const ffmpegCmdEl = document.getElementById('ffmpeg-cmd');
const saveAsEl = document.getElementById('saveAs');
const saveSubsEl = document.getElementById('saveSubtitles');
const qualityEl = document.getElementById('quality');
const qualityNoteEl = document.getElementById('quality-note');
const runFfmpegEl = document.getElementById('run-ffmpeg');
const ffmpegStatusEl = document.getElementById('ffmpeg-status');

let currentTab = null;
let helperEnabled = false;
let lastManifestUrl = '';
// Whether anything in this tab actually offers a choice of size. A plain file
// is served at one size only, so the note has to say so rather than implying
// the preference will do something it cannot.
let hasStream = false;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

// Show the tail of the URL — the filename is what identifies a video, and the
// CSS uses direction:rtl to keep that end visible when it overflows.
function displayUrl(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

/* -------------------------------- quality -------------------------------- */

for (const choice of CVA.QUALITY_CHOICES) {
  qualityEl.append(el('option', { value: choice.value, textContent: choice.label }));
}

function syncQualityNote() {
  const q = CVA.normalizeQuality(qualityEl.value);
  if (!hasStream) {
    qualityNoteEl.textContent =
      'Only streams come in several sizes. A plain file is saved exactly as the site serves it.';
    return;
  }
  qualityNoteEl.textContent = q === 'ask'
    ? 'The build page will list every size the stream offers and let you pick one.'
    : `Streams build at ${CVA.qualityLabel(q).toLowerCase()}. You can still change it on the build page.`;
}

qualityEl.addEventListener('change', async () => {
  await api.storage.local.set({ quality: CVA.normalizeQuality(qualityEl.value) });
  syncQualityNote();
});

function facts(item) {
  const out = [];
  const kindLabel = { file: 'file', manifest: 'stream', blob: 'in-page', data: 'embedded' }[item.kind] || item.kind;
  out.push(el('span', { className: `tag kind-${item.kind}`, textContent: kindLabel }));
  const ext = CVA.extensionFor(item.url, item.mimeType);
  if (ext) out.push(el('span', { className: 'tag', textContent: ext }));
  if (item.width && item.height) {
    out.push(el('span', { className: 'tag', textContent: `${item.width}x${item.height}` }));
  }
  if (item.size) out.push(el('span', { className: 'tag', textContent: CVA.humanSize(item.size) }));
  if (item.duration) {
    const m = Math.floor(item.duration / 60);
    const s = String(item.duration % 60).padStart(2, '0');
    out.push(el('span', { className: 'tag', textContent: `${m}:${s}` }));
  }
  if (item.source === 'network') out.push(el('span', { className: 'tag', textContent: 'sniffed' }));
  return out;
}

function render(items, lastFfmpeg) {
  listEl.textContent = '';
  hasStream = items.some((i) => i.kind === 'manifest');
  syncQualityNote();

  if (!items.length) {
    listEl.append(
      el('p', {
        className: 'empty',
        textContent:
          'No downloadable media found yet. Start playing the video, then hit Rescan — many players only request the file once you press play.',
      }),
    );
  }

  for (const item of items) {
    const status = el('p', { className: 'status' });
    const isHls = item.kind === 'manifest' && /\.m3u8(?=$|[?#])/i.test(item.url);
    const button = el('button', {
      className: 'primary',
      type: 'button',
      textContent: item.kind !== 'manifest' ? 'Save' : (isHls ? 'Build video' : 'Get command'),
    });

    button.addEventListener('click', async () => {
      button.disabled = true;
      status.className = 'status';
      status.textContent = item.kind === 'manifest' ? 'Opening...' : 'Saving...';

      const msg = item.kind === 'manifest'
        ? { type: 'saveManifest', url: item.url, pageTitle: currentTab.title, tabId: currentTab.id }
        : { type: 'download', url: item.url, pageTitle: currentTab.title, mimeType: item.mimeType, tabId: currentTab.id };

      const res = await api.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: String(e) }));

      if (res?.ok && item.kind === 'manifest') {
        if (res.opened) {
          // The build page took over in its own tab; the popup is about to close.
          status.textContent = 'Opened the stream builder.';
          window.close();
        } else {
          status.textContent = 'Command ready below.';
        }
        if (res.cmd) showFfmpeg(res.cmd, item.url);
      } else if (res?.ok) {
        status.textContent = 'Saved to Downloads.';
      } else {
        status.className = 'status error';
        status.textContent = res?.error || 'Failed.';
      }
      button.disabled = false;
    });

    const buttons = [button];

    // Only offered when a helper is actually configured — a button that
    // always fails is worse than no button.
    if (helperEnabled) {
      const send = el('button', { type: 'button', textContent: 'Helper' });
      send.title = 'Send this URL to your helper service';
      send.addEventListener('click', async () => {
        send.disabled = true;
        status.className = 'status';
        status.textContent = 'Opening...';
        const res = await api.runtime
          .sendMessage({ type: 'sendToHelper', url: item.url, pageTitle: currentTab.title, tabId: currentTab.id })
          .catch((e) => ({ ok: false, error: String(e) }));
        if (res?.ok) window.close();
        else {
          status.className = 'status error';
          status.textContent = res?.error || 'Failed.';
          send.disabled = false;
        }
      });
      buttons.push(send);
    }

    listEl.append(
      el('div', { className: 'item' }, [
        el('div', { className: 'meta' }, [
          el('div', { className: 'facts' }, facts(item)),
          el('span', { className: 'url', title: item.url, textContent: displayUrl(item.url) }),
          status,
        ]),
        el('div', { className: 'btns' }, buttons),
      ]),
    );
  }

  // Only show a command that came from THIS tab, or a previous site's command
  // lingers and looks like it belongs to the page you are on.
  if (lastFfmpeg?.cmd && lastFfmpeg.tabId === currentTab?.id) {
    showFfmpeg(lastFfmpeg.cmd, lastFfmpeg.url);
  }
}

function showFfmpeg(cmd, url) {
  ffmpegCmdEl.textContent = cmd;
  if (url) lastManifestUrl = url;
  ffmpegEl.hidden = false;
  // The button only does the work when something is there to do it.
  runFfmpegEl.textContent = helperEnabled ? 'Run it for me' : 'Set up one-click';
}

// Hands the same job to the helper service so nothing has to be pasted into a
// terminal. The copy button stays as the fallback for when no helper is running.
runFfmpegEl.addEventListener('click', async () => {
  if (!helperEnabled) {
    api.tabs.create({ url: api.runtime.getURL('options.html?tab=helper') });
    window.close();
    return;
  }
  runFfmpegEl.disabled = true;
  ffmpegStatusEl.className = 'status';
  ffmpegStatusEl.textContent = 'Sending to the helper...';
  const res = await api.runtime
    .sendMessage({
      type: 'sendToHelper',
      url: lastManifestUrl,
      pageTitle: currentTab.title,
      tabId: currentTab.id,
    })
    .catch((e) => ({ ok: false, error: String(e) }));
  if (res?.ok) {
    window.close();
  } else {
    ffmpegStatusEl.className = 'status error';
    ffmpegStatusEl.textContent = res?.error || 'Failed.';
    runFfmpegEl.disabled = false;
  }
});

document.getElementById('copy-ffmpeg').addEventListener('click', async (e) => {
  await navigator.clipboard.writeText(ffmpegCmdEl.textContent);
  e.target.textContent = 'Copied';
  setTimeout(() => { e.target.textContent = 'Copy command'; }, 1500);
});

saveAsEl.addEventListener('change', () => {
  api.storage.local.set({ saveAs: saveAsEl.checked });
});

saveSubsEl.addEventListener('change', () => {
  api.storage.local.set({ saveSubtitles: saveSubsEl.checked });
});

// The same file can arrive from both the DOM scan and the network sniffer;
// merge on URL so the user sees one row with the best facts from each.
function merge(detections, dom) {
  const byUrl = new Map();
  for (const d of [...dom, ...detections]) {
    if (!d.url || d.kind === 'unknown') continue;
    if (d.kind === 'blob' || d.kind === 'data') continue;
    const prev = byUrl.get(d.url);
    byUrl.set(d.url, prev ? { ...prev, ...d, size: d.size || prev.size, width: d.width || prev.width, height: d.height || prev.height, duration: d.duration || prev.duration } : d);
  }
  const items = [...byUrl.values()];
  // Playable files first, then streams; largest first within each group.
  const rank = { file: 0, manifest: 1 };
  return items.sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2) || (b.size || 0) - (a.size || 0));
}

async function load() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  const { saveAs = false, saveSubtitles = false, quality, helper } = await api.storage.local.get(
    ['saveAs', 'saveSubtitles', 'quality', 'helper'],
  );
  saveAsEl.checked = saveAs;
  saveSubsEl.checked = saveSubtitles;
  qualityEl.value = CVA.normalizeQuality(quality ?? CVA.DEFAULT_QUALITY);
  helperEnabled = Boolean(helper?.enabled && helper?.endpoint);

  const state = await api.runtime.sendMessage({ type: 'getState', tabId: tab.id })
    .catch(() => ({ detections: [], dom: [] }));

  render(merge(state.detections || [], state.dom || []), state.lastFfmpeg);
}

document.getElementById('open-options').addEventListener('click', () => {
  // Opened directly rather than via openOptionsPage so the tab can be
  // deep-linked; the link offers helper settings, so land the user there.
  api.tabs.create({ url: api.runtime.getURL('options.html?tab=helper') });
  window.close();
});

document.getElementById('refresh').addEventListener('click', load);
load();
