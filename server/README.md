# Clark Video Archiver helper service

An **optional** local companion to the extension. The extension saves most video
on its own; this service exists for the jobs a browser page cannot do:

- **Remux MPEG-TS to MP4.** In-browser, HLS with `.ts` segments can only be
  saved as a `.ts` file. The helper produces a real `.mp4`.
- **Mux separate audio and video.** Many streams serve them as distinct tracks,
  which the extension can only save as two files.
- **Resolve awkward sites** by handing the URL to yt-dlp.

You run it yourself, on your own machine. Nothing is sent anywhere else.

## Requirements

- Python 3.9+ (standard library only — no `pip install` for the server itself)
- `ffmpeg` on `PATH` — required
- `yt-dlp` — optional; needed only for page URLs rather than direct media links

Tested on Linux and macOS.

```bash
# Debian/Ubuntu
sudo apt install ffmpeg
pip install yt-dlp

# macOS
brew install ffmpeg yt-dlp
```

## Run it

```bash
./cva_helper.py
```

```
cva-helper v1 on http://127.0.0.1:8788
  output   /home/you/Downloads/ClarkVideoArchiver
  ffmpeg   yes
  yt-dlp   yes
  token    not set
```

Then in the extension: **toolbar button → Helper service settings**, tick
*Enable*, leave the endpoint as `http://127.0.0.1:8788`, and press **Test
connection**. A **Helper** button appears next to each detected video.

### Options

| Flag | Default | Purpose |
|---|---|---|
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8788` | Port |
| `--output-dir` | `~/Downloads/ClarkVideoArchiver` | Where finished files are written |
| `--token` | none | Require `Authorization: Bearer <token>` |
| `--verbose` | off | Log every request |

## Security

**It binds to loopback by default, and should stay that way.** The service runs
ffmpeg and yt-dlp against URLs it is given, so anyone who can reach the port can
make your machine fetch arbitrary URLs and write files into the output
directory. If you do expose it, set `--token` and put it behind TLS.

Other measures already in place: only `http`/`https` URLs are accepted (never
`file://`), subprocesses are invoked with argument lists rather than a shell so
a crafted URL cannot inject commands, filenames are sanitized, and the file
endpoint serves only the exact path a job produced.

## API

Small enough to drive by hand, so the extension is not the only possible client.

```
GET  /api/health              -> {ok, service, version, capabilities}
POST /api/jobs                <- {url, format: "video"|"audio", quality, title,
                                  referer, subtitles}
                              -> 201 {id, state}
GET  /api/jobs/<id>           -> {id, state, quality, progress, message, filename,
                                  size, download_url}
GET  /api/files/<id>/<name>   -> the finished file
```

`state` is one of `queued`, `running`, `done`, `error`. Poll the job until it
leaves a running state, then fetch `download_url`.

`quality` is `"best"` (the default), `"worst"`, or a height ceiling as a string
— `"1080"`, `"720"`, `"480"`. Anything else is read as `"best"`, so a client
that gets the field wrong loses the preference, not the download.

How it is applied depends on which tool handles the URL:

- **ffmpeg** (direct media and manifests) — each variant of an HLS master
  playlist is a program, so `ffprobe -show_programs` finds the one at the right
  height and `-map 0:p:<id>` takes it, along with the audio rendition that
  belongs to it. Skipped entirely for `"best"`, which is ffmpeg's own default.
- **yt-dlp** (page URLs) — becomes an `-f` selector.

A ceiling nothing satisfies falls back to the *smallest* variant on offer, not
the largest: someone who capped the height wanted a smaller file.

```bash
curl -X POST http://127.0.0.1:8788/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/stream.m3u8","format":"video","quality":"720","title":"My Clip"}'

curl http://127.0.0.1:8788/api/jobs/<id>
```

Finished jobs and their files are removed after six hours.

## Writing another backend

The extension talks to helpers through adapters in `src/helper.js`. Anything
implementing the four endpoints above works as-is — point the extension at it
and pick *Clark Video Archiver helper*. To speak a different protocol, add an
adapter with `health`, `submit` and `status` methods and register it in
`ADAPTERS`.

### ytgrab (legacy)

`ytgrab_web.py` is supported by a second adapter, since it is a real service
some people already run. Its limits are its own, not the adapter's: it validates
`is_youtube_url()` and produces MP3 through `yt_audio_to_mp3`, so it **cannot
accept an `.m3u8` or a direct video URL, and cannot return video at all.** It
also speaks HTML rather than JSON, so the adapter scrapes its job page. Use it
for YouTube audio; use `cva_helper.py` for anything else.
