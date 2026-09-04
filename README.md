# Clark Video Archiver

A browser extension for Chrome and Firefox. Right-click a video on any page and
save it to your hard drive.

One codebase builds both browsers; the only difference is the manifest.

The same guide is built into the extension: **toolbar button → Setup guide &
helper settings**, or open `options.html` from the extension's own page.

## Quick start

```bash
./scripts/build.sh          # produces dist/chrome/ and dist/firefox/
```

Load it (details in [Install](#install) below), then:

1. **Right-click any video → "Save this video to disk".** On most sites that is
   all you need.
2. **No video option in the menu?** The site has a layer over the video. Use
   **right-click → Clark Video Archiver → Save video on this page**.
3. **Still nothing?** Open the **toolbar button**. It lists every media file
   seen in the tab, including streams that never appear in the page.
   **Press play first** — most players request nothing until playback starts —
   then press **Rescan**.
4. **Streaming video** shows **Build video** instead of Save. It opens a page
   that downloads every segment and joins them. Leave that tab open until done.

Files land in `Downloads/ClarkVideoArchiver/`, named after the page title.
Tick **Also save subtitles** in the popup to save any subtitle track alongside.

Want MP4 instead of `.ts`, or awkward sites handled by yt-dlp? That needs the
[optional helper service](#optional-helper-service).

## Install

Build first:

```bash
./scripts/build.sh
```

That produces `dist/chrome/`, `dist/firefox/`, and a zip of each.

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `dist/firefox/manifest.json`
On Firefox 153 the site-access permission is granted automatically, so there is
usually nothing else to do. If the extension finds nothing on any site, check
`about:addons` → the extension → **Permissions and data** → **Access your data
for all websites**.

A temporary add-on is removed when Firefox restarts; for a permanent install the
zip needs signing through [addons.mozilla.org](https://addons.mozilla.org/developers/).

### Chrome

1. Go to `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick the `dist/chrome/` folder

## Using it

**Right-click a video → "Save this video to disk".** That is the main path.

If the right-click menu lands on a player overlay instead of the video element
(common on sites that stack a div over the video), use
**right-click → Clark Video Archiver → Save video on this page**.

The **toolbar button** opens a list of every media file seen in the tab, with a
size and resolution for each, and a Save button per entry. The badge counts what
has been found. This is the fallback when the context menu comes up empty, and
it usually has more than the page does — it lists streams caught on the wire that
never appear in the DOM.

Files land in `Downloads/ClarkVideoArchiver/`, named after the page title. Tick
**Ask where to save each file** in the popup to get a save dialog instead.

## How it finds video

Three independent sources, because no single one is sufficient:

1. **DOM scan** — every `<video>`/`<audio>`, reading `currentSrc`, `src`, and
   `<source>` children. Re-runs on mutation and on `loadedmetadata`, since most
   players attach their real source only after playback starts.
2. **Network sniffing** — an observational `webRequest` listener records media
   responses by content-type. This is what catches players that never expose a
   URL in the DOM. Segments (`.ts`, `.m4s`) and sub-128 KB responses are dropped
   so the list stays readable.
3. **The URL you right-clicked** — `srcUrl` from the context menu, which beats
   any heuristic when it is available.

## Downloading, and the three cases that need care

- **A plain file URL** goes straight to the downloads API.
- **A URL that needs cookies or a Referer** fails that first attempt, so the
  extension retries by fetching from inside the page, where the request carries
  the page's own credentials and origin. Capped at 1.5 GB, since this route
  buffers the file in the tab.
- **A `blob:` URL** only resolves inside the page, so the content script handles
  it there.

## Building a video from an HLS playlist

Most streaming video is served as HLS: a `.m3u8` playlist pointing at hundreds
of separate segments. The extension follows the playlist and assembles the
segments into one file.

Click **Build video** on any `.m3u8` in the popup (or right-click → save on a
streamed video) and a build page opens. It reads the playlist, offers a quality
picker if it is a master playlist, then downloads every segment — six at a time,
each retried up to three times — and joins them in playlist order. Progress,
throughput, an ETA, and a cancel button are on the page.

**Keep that tab open until it finishes.** The work deliberately runs in a page
rather than the background: Chrome terminates an idle MV3 service worker after
about 30 seconds, which would kill a long download partway through.

### What comes out

| Playlist | Output | Why |
|---|---|---|
| Fragmented MP4 (`EXT-X-MAP` + `.m4s`) | `.mp4` | Init segment plus fragments concatenates into a valid MP4. Plays anywhere. |
| MPEG-TS (`.ts`) | `.ts` | Concatenated TS is a valid transport stream. Plays in VLC, mpv and ffmpeg. |

A `.ts` is **not** an MP4, so the extension does not name it one — that would
hand you a file that fails to open. To convert losslessly:

```
ffmpeg -i "Page Title.ts" -c copy "Page Title.mp4"
```

Doing that remux in-browser would mean bundling a TS demuxer and MP4 muxer; the
one-line ffmpeg call is the honest trade.

### Encryption

**AES-128 is handled.** This is ordinary HLS transport encryption — the key sits
in the clear at a URL named in the playlist, and every player fetches it exactly
this way. The extension does the same and decrypts with WebCrypto, deriving the
IV from the media sequence number when the playlist does not give one.

**SAMPLE-AES and other DRM are refused,** and reported as such rather than
failing obscurely.

### Two cases that need your attention

**Separate audio tracks.** Many streams carry audio as its own rendition, so the
video segments are silent on their own. The build page detects this, warns before
it starts, and then **saves both files** — the video, and the audio as
`<name>.audio.<ext>`. A browser cannot mux them, so joining is one command:

```
ffmpeg -i video.ts -i audio.ts -c copy merged.mp4
```

**Live playlists.** With no `EXT-X-ENDLIST` the stream has no defined end, so
only the segments listed at that moment are saved. You are warned before it
starts.

### Subtitles

HLS carries captions as a separate playlist of WebVTT segments, so they cannot
simply be concatenated — each segment is a standalone file with its own header,
and cues spanning a boundary appear in both. The extension parses the cues,
converts them to absolute presentation time, de-duplicates, and writes one file.

Saved as `<video name>.<language>.vtt` beside the video, which is the naming
players look for when auto-loading a sidecar track. Streams publishing several
languages get one file each.

Burned-in captions are part of the video picture and cannot be extracted. When a
stream lists no subtitle track you are told so rather than left wondering.

With the helper service enabled, subtitles are **embedded into the MP4** instead
(yt-dlp `--embed-subs`), since that path returns a single file.

## Tested against real sites

Streaming platforms differ more than the specs suggest, so the extension was
driven by hand against four unrelated commercial video platforms, in
both browsers. Every download
was checked with `ffprobe` for duration and streams, then forced through a full
decode — metadata can look perfect while the payload is garbage.

| Delivery shape | Result |
|---|---|
| HLS master, 3 variants, fragmented MP4 segments | `.mp4`, 532.1s, h264 + aac, decode clean |
| Progressive MP4 over rotating CDN paths | detected and de-duplicated correctly |
| Signed-URL HLS, MPEG-TS segments | `.ts`, 147.75s, h264 + aac, decode clean |
| HLS master, 3 variants, MPEG-TS, audio split out | `.ts`, 1855.5s, video-only **as warned** |

Every duration matched the source's advertised runtime exactly. Test files
were deleted afterwards.

Three bugs surfaced that no unit test had caught, all fixed:

- **One video listed many times.** A CDN served a single asset through rotating
  paths, so nine near-identical rows appeared. Detections are now keyed on an
  opaque filename when there is one, and on origin + path otherwise — which is
  what keeps two genuinely different renditions both named `rendition.m3u8` from
  being wrongly merged.
- **A stale ffmpeg command leaked between sites**, because it was stored
  globally rather than against the tab it came from.
- **The separate-audio warning told you to save the audio yourself, and then
  offered no way to do it.** Both files are now saved automatically. That gap
  existed precisely because the code was written against unit tests, where
  nobody reads the instruction and tries to follow it.

## Optional helper service

Two things are impossible inside a browser page: remuxing MPEG-TS into MP4, and
muxing separate audio and video tracks back together. Both need a real media
toolchain. So the extension can hand a URL to a small service you run yourself.

**It is entirely optional and off by default** — everything above works without
it, and no URL leaves your machine unless you press the Helper button.

```bash
./server/cva_helper.py          # listens on 127.0.0.1:8788
```

Then **toolbar button → Helper service settings**, tick *Enable*, press **Test
connection**. A **Helper** button appears beside each detected video; it opens a
progress page that submits the job, polls it, and saves the finished file.

The service needs Python 3.9+ and ffmpeg, plus yt-dlp for page URLs. Full
documentation, API and security notes: [`server/README.md`](server/README.md).

### Any backend, not just this one

The endpoint is whatever you configure — the extension is not bound to a
particular host or service. `src/helper.js` holds the adapters:

| Adapter | Handles |
|---|---|
| `cva-helper` | The bundled server. Video, audio, HLS, remuxing, yt-dlp. |
| `ytgrab` | An existing `ytgrab_web.py`. **YouTube URLs and MP3 audio only** — it validates `is_youtube_url()` and cannot accept `.m3u8` or return video. |

Adding another backend means implementing `health`, `submit` and `status`, and
registering it in `ADAPTERS`.

## What it will not do

**DASH (`.mpd`) is not assembled** — only HLS is parsed. DASH still falls back to
an ffmpeg command in the popup.

**DRM-protected video (Widevine, PlayReady, FairPlay) cannot be saved at all,**
by this or any extension. The decrypted frames never exist in a form the page or
an extension can reach. Netflix, Disney+, and similar services will show nothing
useful. If a video is streamed via MSE with no detectable manifest, you get a
message saying so rather than a silent failure.

## Troubleshooting

Also available in the extension under **Setup guide → Troubleshooting**.

| Symptom | What to do |
|---|---|
| No subtitles were saved | Only streams publishing a subtitle track have one. Burned-in captions are part of the picture and cannot be extracted. |
| The popup finds nothing | Press play, then **Rescan**. Most players request nothing until playback starts. |
| No video option when right-clicking | The site has a layer over the video. Use **Clark Video Archiver → Save video on this page**, or the toolbar button. |
| Nothing found on any site (Firefox) | Usually granted automatically. If not, `about:addons` → the extension → **Permissions and data** → **Access your data for all websites**. |
| Got a `.ts` file, not `.mp4` | The stream used MPEG-TS segments. That file is valid and plays in VLC or mpv. For MP4, use the helper service or convert: `ffmpeg -i in.ts -c copy out.mp4` |
| The video has no sound | That stream splits audio into its own track. The audio is saved alongside as `<name>.audio.<ext>`; join them with `ffmpeg -i video -i audio -c copy out.mp4` |
| Netflix, Disney+ and similar | DRM. The decrypted video never exists anywhere an extension can reach, so no extension can save them. Not fixable. |
| Helper "Test connection" fails | Check the helper terminal is still running and the port matches what it printed. If started with `--token`, the same token must be entered in settings. |
| A download stopped partway | Closing the build tab cancels it. Leave it open until it reports Saved. |

## Development

```bash
node scripts/test-common.mjs      # filename/classification helpers
node scripts/test-hls.mjs         # HLS playlist parser
node scripts/test-helper.mjs      # helper adapters, against a stubbed fetch
node scripts/test-subs.mjs        # WebVTT parsing, merging and SRT output

# End-to-end: generate real HLS streams with ffmpeg, assemble them, verify the
# result decodes. Covers MPEG-TS, fragmented MP4, and AES-128 encrypted.
./scripts/make-hls-fixtures.sh /tmp/cva-fixtures
node scripts/test-assemble.mjs /tmp/cva-fixtures

npx web-ext lint --source-dir dist/firefox --self-hosted
python3 scripts/make_icons.py     # regenerate icons
```

The assembly test is the one that matters: it runs the same parse → fetch →
decrypt → concatenate pipeline the extension uses, then forces a full decode of
the output with ffmpeg. A file can carry correct metadata and still be garbage
inside, so decoding every frame is what proves the segments were joined in the
right order.

### Layout

| Path | Role |
|---|---|
| `src/common.js` | URL classification, filename building. Loaded in every context. |
| `src/hls.js` | HLS playlist parsing. Pure functions, no I/O — all of it unit-tested. |
| `src/subs.js` | WebVTT cue parsing, segment merging, SRT conversion. Pure. |
| `src/downloader.*` | The stream build page: segment fetching, AES-128 decryption, assembly, progress. |
| `src/helper.js` | Helper-service adapters and job polling. Backend-agnostic. |
| `src/options.*` | Helper configuration UI. |
| `server/cva_helper.py` | The optional local helper service. Stdlib only. |
| `src/background.js` | Context menus, network sniffing, download orchestration. |
| `src/content.js` | DOM scanning; the in-page saves for `blob:` and cookie-gated URLs. |
| `src/popup.*` | The detected-media list. |
| `src/sw.js` | Chrome-only shim: MV3 allows one service worker file, so it `importScripts` the other two. |
| `src/manifest.chrome.json` | Chrome: `background.service_worker`. |
| `src/manifest.firefox.json` | Firefox: `background.scripts`, plus the gecko id block. |

Filenames are sanitized to Windows' rules — the strictest of the three desktop
platforms — which also strips the `..` sequences Chrome's downloads API rejects.

### Verification status

Verified: 124 unit tests (32 filename/classification helpers + 38 HLS parser +
25 service adapters + 29 WebVTT), plus an end-to-end assembly test against real
ffmpeg-generated streams. All scripts parse, the server compiles, and
`web-ext lint` reports 0 errors / 0 warnings.

The HLS pipeline is proven end-to-end against real ffmpeg-generated streams —
MPEG-TS, fragmented MP4, and AES-128 encrypted all assemble into files that
fully decode at the correct duration with both video and audio intact.

The helper service is proven end-to-end too: submitting a live `.m3u8` produced
a 12.03s MP4 (h264 + aac) that decodes cleanly, fetched back over the file
endpoint.

Both browsers were driven through the full flow by hand — loading, detection,
quality selection, download, and verification — against the four providers
above.

Still unverified:

- **Subtitles against a live stream.** The WebVTT parsing, merging and SRT
  conversion are unit-tested, but no provider tested so far exposed a subtitle
  rendition, so that path has never run against real data.
- **The separate-audio download.** The warning and the video-only result are
  confirmed live; the accompanying audio fetch is tested only in the suite.
- **DASH (`.mpd`).** None of the platforms tested served it. It is detected and handed to
  ffmpeg rather than assembled.
