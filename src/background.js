/* global CVA, api */
// Loaded after common.js (Chrome: importScripts via manifest; Firefox: scripts array).

const MENU_ROOT = 'cva-root';
const MENU_SAVE_THIS = 'cva-save-this';
const MENU_SAVE_PICK = 'cva-save-pick';
const MENU_LIST = 'cva-list';

// Detections live in session storage rather than a plain Map: Chrome terminates
// the MV3 service worker after ~30s idle, which would drop everything sniffed.
const STORE_KEY = 'detections';
const MAX_PER_TAB = 60;

async function readStore() {
  try {
    const got = await api.storage.session.get(STORE_KEY);
    return got?.[STORE_KEY] || {};
  } catch {
    return {};
  }
}

async function writeStore(store) {
  try {
    await api.storage.session.set({ [STORE_KEY]: store });
  } catch {
    // Session storage is best-effort; losing the cache only costs a re-sniff.
  }
}

// Deciding whether two URLs are the same video is not as simple as comparing
// them: CDNs hand out the same asset through rotating hosts, tokenised path
// segments and signed query strings. Observed on one course site: eight rows
// for one video, identical filenames, different paths.
//
// A long opaque filename (a UUID or content hash) identifies an asset on its
// own, so it is used alone. Short generic names like "video.mp4" are not
// unique, so those keep the full origin and path.
const OPAQUE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{19,}$/;

function identityOf(url) {
  try {
    const u = new URL(url);
    const base = decodeURIComponent(u.pathname.split('/').pop() || '');
    const stem = base.replace(/\.[^.]+$/, '');
    if (OPAQUE_NAME.test(stem)) return `name:${base.toLowerCase()}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url);
  }
}

async function recordDetection(tabId, entry) {
  if (tabId == null || tabId < 0) return;
  const store = await readStore();
  const list = store[tabId] || [];
  const id = identityOf(entry.url);
  const existing = list.find((e) => identityOf(e.url) === id);
  if (existing) {
    // Keep the largest response seen; it is closest to the whole file.
    if ((entry.size || 0) > (existing.size || 0)) {
      existing.size = entry.size;
      await writeStore(store);
    }
    return;
  }
  list.unshift({ ...entry, at: Date.now() });
  store[tabId] = list.slice(0, MAX_PER_TAB);
  await writeStore(store);
  updateBadge(tabId, store[tabId].length);
}

async function getDetections(tabId) {
  const store = await readStore();
  return store[tabId] || [];
}

async function clearTab(tabId) {
  const store = await readStore();
  if (store[tabId]) {
    delete store[tabId];
    await writeStore(store);
  }
}

function updateBadge(tabId, count) {
  const action = api.action || api.browserAction;
  if (!action?.setBadgeText) return;
  action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
  action.setBadgeBackgroundColor?.({ tabId, color: '#b3261e' }).catch(() => {});
}

/* ------------------------------- sniffing -------------------------------- */

// Observational webRequest still works under MV3 (only the blocking form was
// removed), which is what lets us catch streams that never appear in the DOM.
function headerValue(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h?.value || '';
}

api.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { tabId, url, responseHeaders, statusCode } = details;
    if (statusCode >= 400) return;
    // 206 Partial Content is one chunk of a range request. Players fetch a
    // progressive MP4 in many chunks, and listing each one fills the popup with
    // rows that all point at the same video.
    if (statusCode === 206) return;
    const mimeType = headerValue(responseHeaders, 'content-type').split(';')[0].trim();
    const kind = CVA.classifyUrl(url, mimeType);
    if (!kind || kind === 'blob' || kind === 'data') return;

    const size = Number(headerValue(responseHeaders, 'content-length')) || 0;
    // Media segments arrive in hundreds of tiny chunks; only the manifest that
    // stitches them together is worth showing, so drop the noise.
    const isSegment = /\.(m4s|ts)(?=$|[?#])/i.test(url);
    if (isSegment) return;
    if (kind === 'file' && size && size < 128 * 1024) return;

    recordDetection(tabId, { url, kind, mimeType, size, source: 'network' });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders'],
);

api.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
api.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A committed navigation means the old tab's media is gone.
  if (changeInfo.status === 'loading' && changeInfo.url) {
    clearTab(tabId).then(() => updateBadge(tabId, 0));
  }
});

/* ----------------------------- context menus ----------------------------- */

function buildMenus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: MENU_SAVE_THIS,
      title: 'Save this video to disk',
      contexts: ['video'],
    });
    api.contextMenus.create({
      id: MENU_ROOT,
      title: 'Clark Video Archiver',
      contexts: ['page', 'frame', 'link', 'audio'],
    });
    api.contextMenus.create({
      id: MENU_SAVE_PICK,
      parentId: MENU_ROOT,
      title: 'Save video on this page',
      contexts: ['page', 'frame', 'link', 'audio'],
    });
    api.contextMenus.create({
      id: MENU_LIST,
      parentId: MENU_ROOT,
      title: 'Show detected media',
      contexts: ['page', 'frame', 'link', 'audio'],
    });
  });
}

api.runtime.onInstalled.addListener(buildMenus);
api.runtime.onStartup.addListener(buildMenus);

api.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;

  if (info.menuItemId === MENU_SAVE_THIS) {
    // srcUrl is what the user actually right-clicked, so it beats any guess.
    await saveFromContext({ tab, srcUrl: info.srcUrl, frameId: info.frameId });
    return;
  }
  if (info.menuItemId === MENU_SAVE_PICK) {
    const found = await askContent(tab.id, { type: 'collect' }, info.frameId);
    const best = (found?.videos || [])[0];
    if (!best) {
      await notify('No video found', 'No <video> element was found in this frame. Try "Show detected media".');
      return;
    }
    await saveFromContext({ tab, srcUrl: best.url, frameId: info.frameId, poster: best });
    return;
  }
  if (info.menuItemId === MENU_LIST) {
    const action = api.action || api.browserAction;
    action.openPopup?.().catch(() => {
      notify('Detected media', 'Open the Clark Video Archiver toolbar button to see the list.');
    });
  }
});

/* ------------------------------ downloading ------------------------------ */

async function askContent(tabId, message, frameId) {
  try {
    const opts = frameId != null ? { frameId } : undefined;
    return await api.tabs.sendMessage(tabId, message, opts);
  } catch {
    // No content script in this frame (e.g. a PDF viewer or the web store).
    return null;
  }
}

async function notify(title, message) {
  try {
    await api.notifications.create({
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon-128.png'),
      title,
      message,
    });
  } catch {
    // Notifications can be disabled by the user; never let it break a save.
  }
}

async function saveFromContext({ tab, srcUrl, frameId }) {
  if (!srcUrl) {
    await notify('Nothing to save', 'Could not read a source URL for that video.');
    return;
  }
  const kind = CVA.classifyUrl(srcUrl, '');

  if (kind === 'blob') {
    // A blob: URL only resolves inside the page, so hand it back to the frame.
    const res = await askContent(tab.id, { type: 'saveBlob', url: srcUrl, title: tab.title }, frameId);
    if (res?.ok) return;
    // MediaSource-backed blobs cannot be fetched; the sniffed stream is the
    // only real route, so point at what we actually captured.
    const detections = await getDetections(tab.id);
    const manifest = detections.find((d) => d.kind === 'manifest');
    if (manifest) {
      await handleManifest(manifest.url, tab.title, tab.id);
      return;
    }
    await notify(
      'Streamed video',
      'This player uses Media Source Extensions, so there is no single file to save. Open the toolbar button to see the streams detected so far.',
    );
    return;
  }

  if (kind === 'manifest') {
    await handleManifest(srcUrl, tab.title, tab.id);
    return;
  }

  await download({ url: srcUrl, pageTitle: tab.title, tabId: tab.id, frameId });
}

// HLS playlists get assembled segment-by-segment in a dedicated page. DASH
// (.mpd) has a different manifest format that this build does not parse, so it
// still falls back to handing over an ffmpeg command.
async function handleManifest(url, pageTitle, tabId) {
  const filename = CVA.buildFilename({ pageTitle, url, mimeType: '' });
  const cmd = CVA.ffmpegCommand(url, filename);
  await api.storage.local.set({ lastFfmpeg: { url, cmd, at: Date.now(), tabId } });

  if (/\.m3u8(?=$|[?#])/i.test(url)) {
    const page = api.runtime.getURL(
      `downloader.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(pageTitle || '')}`,
    );
    await api.tabs.create({ url: page });
    return { ok: true, opened: true, cmd };
  }

  await notify(
    'DASH playlist detected',
    'This build assembles HLS (.m3u8) streams. For DASH, the ffmpeg command is in the toolbar popup.',
  );
  return { ok: true, opened: false, cmd };
}

async function download({ url, pageTitle, mimeType, tabId, frameId }) {
  const filename = CVA.buildFilename({ pageTitle, url, mimeType });
  const { saveAs = false } = await api.storage.local.get('saveAs');
  try {
    const id = await api.downloads.download({ url, filename, saveAs });
    return { ok: true, id };
  } catch (err) {
    // Common cause: the origin requires a Referer or a cookie the download
    // request doesn't carry. Retrying inside the page gets both for free.
    if (tabId != null) {
      const res = await askContent(tabId, { type: 'saveViaFetch', url, title: pageTitle }, frameId);
      if (res?.ok) return { ok: true };
      if (res?.error) {
        await notify('Download failed', res.error);
        return { ok: false, error: res.error };
      }
    }
    const msg = String(err?.message || err);
    await notify('Download failed', msg);
    return { ok: false, error: msg };
  }
}

/* ------------------------------- messaging ------------------------------- */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = msg.tabId ?? sender.tab?.id;

    switch (msg.type) {
      case 'getState': {
        const [detections, dom] = await Promise.all([
          getDetections(tabId),
          askContent(tabId, { type: 'collect' }),
        ]);
        const { lastFfmpeg } = await api.storage.local.get('lastFfmpeg');
        sendResponse({ detections, dom: dom?.videos || [], lastFfmpeg });
        return;
      }
      case 'download': {
        const res = await download({
          url: msg.url,
          pageTitle: msg.pageTitle,
          mimeType: msg.mimeType,
          tabId,
        });
        sendResponse(res);
        return;
      }
      case 'saveManifest': {
        sendResponse(await handleManifest(msg.url, msg.pageTitle, tabId));
        return;
      }
      case 'domFound': {
        // The content script reports <video> elements it sees, including ones
        // whose bytes were fetched before the extension started listening.
        for (const v of msg.videos || []) {
          if (CVA.classifyUrl(v.url, v.mimeType) === 'file') {
            await recordDetection(tabId, { url: v.url, kind: 'file', mimeType: v.mimeType || '', size: 0, source: 'dom' });
          }
        }
        sendResponse({ ok: true });
        return;
      }
      case 'sendToHelper': {
        // The build page owns the job: it polls and fetches the result, which
        // an idle-terminated service worker could not see through.
        const page = api.runtime.getURL(
          `downloader.html?mode=helper&url=${encodeURIComponent(msg.url)}`
          + `&title=${encodeURIComponent(msg.pageTitle || '')}`
          + `&format=${msg.format === 'audio' ? 'audio' : 'video'}`
          + `&referer=${encodeURIComponent(msg.referer || '')}`,
        );
        await api.tabs.create({ url: page });
        sendResponse({ ok: true, opened: true });
        return;
      }
      case 'helperConfig': {
        const { helper } = await api.storage.local.get('helper');
        sendResponse({ ok: true, helper: helper || null });
        return;
      }
      case 'clear': {
        await clearTab(tabId);
        updateBadge(tabId, 0);
        sendResponse({ ok: true });
        return;
      }
      default:
        sendResponse({ ok: false, error: `unknown message: ${msg.type}` });
    }
  })();
  return true; // keep the channel open for the async work above
});
