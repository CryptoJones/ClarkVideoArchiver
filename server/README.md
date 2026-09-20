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

Tested on Linux, macOS and Windows.

```bash
# Debian/Ubuntu
sudo apt install ffmpeg
pip install yt-dlp

# macOS
brew install ffmpeg yt-dlp

# Windows (winget; or install from python.org, ffmpeg.org and yt-dlp's releases)
winget install Python.Python.3.13
winget install Gyan.FFmpeg
winget install yt-dlp.yt-dlp
```

## Run it

```bash
./cva_helper.py               # Linux / macOS
python server\cva_helper.py   # Windows — see the Windows section below
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

## Keep it running

### Linux (systemd)

`cva-helper.service` is a systemd **user** unit: it starts the helper at login
and restarts it three seconds after a failure.

```bash
cp server/cva-helper.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cva-helper.service
```

Edit the `ExecStart` path in the unit if the repository is not at
`~/source/repos/ClarkVideoArchiver`. On a headless machine, run
`sudo loginctl enable-linger "$USER"` once so it starts at boot rather than at
login.

### Windows

There is no systemd on Windows, so the same job is done by a per-user
**Scheduled Task**. It runs as you, only while you are logged on, needs no
administrator rights and stores no password.

**Prerequisites.** Python 3.9+, `ffmpeg` and (optionally) `yt-dlp`, all
findable on `PATH` — see the `winget` lines under [Requirements](#requirements).
Open a **new** terminal after installing so the updated `PATH` is picked up,
then confirm everything resolves:

```powershell
powershell -ExecutionPolicy Bypass -File server\run-windows.ps1 -Check
```

```
python   C:\WINDOWS\py.exe -3 (3.13.2)
ffmpeg   C:\...\ffmpeg.exe
yt-dlp   not found (page URLs unavailable; winget install yt-dlp.yt-dlp)
script   C:\...\ClarkVideoArchiver\server\cva_helper.py
log      C:\Users\you\AppData\Local\ClarkVideoArchiver\cva-helper.log
```

`-ExecutionPolicy Bypass` is needed because the scripts are unsigned and a
stock Windows install refuses to run unsigned scripts. It applies to that one
command only. If `python` is not found or the wrong one is found, set
`CVA_PYTHON` to the interpreter you want.

**Run it by hand.** Either call the service directly, exactly as on Linux:

```powershell
python server\cva_helper.py
python server\cva_helper.py --port 9000 --token s3cret
```

or through `run-windows.ps1`, which adds what the systemd unit provides — the
environment for yt-dlp, a log file, and a restart after any crash:

```powershell
powershell -ExecutionPolicy Bypass -File server\run-windows.ps1
powershell -ExecutionPolicy Bypass -File server\run-windows.ps1 --port 9000
```

Ctrl-C stops it either way.

**Start at logon.**

```powershell
powershell -ExecutionPolicy Bypass -File server\install-windows.ps1
```

This registers a Scheduled Task named `ClarkVideoArchiverHelper` that launches
`run-windows.ps1` (hidden) when you log on, never times it out, and retries if
it dies; `run-windows.ps1` in turn restarts `cva_helper.py` three seconds after
any failure, matching `Restart=on-failure` / `RestartSec=3` in the unit. Five
failures in quick succession (the port already taken, say) make it give up,
like systemd's start limit, and the task tries again a minute later. The
helper and any ffmpeg or yt-dlp it is running are held in a Windows job object
tied to the task, so `Stop-ScheduledTask` ends all of them. The
installer starts the task immediately and checks that
`http://127.0.0.1:8788/api/health` answers. Paths are taken from where the
script lives, so re-run it if you move the repository. A console window may
flash briefly at logon while PowerShell hides itself.

Verify, stop, start:

```powershell
Get-ScheduledTask -TaskName ClarkVideoArchiverHelper | Select-Object TaskName, State
Invoke-RestMethod http://127.0.0.1:8788/api/health
Get-Content "$env:LOCALAPPDATA\ClarkVideoArchiver\cva-helper.log" -Tail 20
Stop-ScheduledTask  -TaskName ClarkVideoArchiverHelper
Start-ScheduledTask -TaskName ClarkVideoArchiverHelper
```

The log is the Windows stand-in for `journalctl --user -u cva-helper`; it is
rotated once to `cva-helper.1.log` when it passes 5 MB.

**Configure.** The unit's `Environment=` lines have a counterpart in the
configuration block at the top of `run-windows.ps1`: permanent arguments for
`cva_helper.py` (port, token, output directory), `CVA_YTDLP_JS_RUNTIME` (set to
`node` automatically when Node is on `PATH`) and
`CVA_YTDLP_COOKIES_FROM_BROWSER` (off by default; uncomment and name your
browser for YouTube). Values already set in your user environment are left
alone. After editing, restart the task with the two commands above.

**Uninstall.**

```powershell
powershell -ExecutionPolicy Bypass -File server\install-windows.ps1 -Uninstall
```

That stops the helper and removes the task. Nothing else was installed; the
log directory can be deleted by hand.

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
