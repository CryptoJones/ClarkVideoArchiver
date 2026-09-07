#!/usr/bin/env python3
"""Clark Video Archiver helper service.

An optional local companion to the browser extension. The extension can save
most video on its own; this service exists for the jobs a page sandbox cannot
do: remuxing MPEG-TS to MP4, muxing separate audio and video tracks, and
handing awkward sites to yt-dlp.

Runs anywhere Python 3.9+, ffmpeg and (optionally) yt-dlp are available.
Standard library only — no pip install needed for the server itself.

    ./cva_helper.py                       # listens on 127.0.0.1:8788
    ./cva_helper.py --port 9000 --token s3cret

Binds to loopback by default. It executes ffmpeg/yt-dlp on URLs it is given,
so do not expose it to a network you do not control; --host is deliberately
explicit about that.

Tested on Linux and macOS.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

VERSION = "1"
SERVICE = "cva-helper"
MAX_BODY = 64 * 1024
JOB_RETENTION_SECONDS = 6 * 60 * 60

QUALITY_HEIGHT = re.compile(r"^\d{2,5}$")

MEDIA_EXT = re.compile(r"\.(mp4|m4v|webm|mkv|mov|ts|m4s|mp3|m4a|aac|ogg|ogv)(?=$|[?#])", re.I)
MANIFEST_EXT = re.compile(r"\.(m3u8|mpd)(?=$|[?#])", re.I)

JOBS: dict[str, "Job"] = {}
JOBS_LOCK = threading.Lock()


@dataclass
class Job:
    id: str
    url: str
    fmt: str
    quality: str
    title: str
    referer: str
    subtitles: bool
    out_dir: Path
    state: str = "queued"          # queued | running | done | error
    progress: float = 0.0
    message: str = ""
    path: Path | None = None
    created_at: float = field(default_factory=time.time)

    def as_dict(self) -> dict[str, Any]:
        size = self.path.stat().st_size if self.path and self.path.exists() else 0
        name = self.path.name if self.path else ""
        return {
            "id": self.id,
            "state": self.state,
            "quality": self.quality,
            "progress": round(self.progress, 1),
            "message": self.message,
            "filename": name,
            "size": size,
            "download_url": f"/api/files/{self.id}/{name}" if self.state == "done" and name else "",
        }


# ---------------------------------------------------------------- utilities


def sanitize(name: str, fallback: str = "video") -> str:
    """Windows' filename rules are the strictest, so satisfying them is enough
    everywhere. Also strips '..' so a title can never walk out of the job dir."""
    out = re.sub(r'[<>:"/\\|?*]', " ", name or "")
    out = re.sub(r"[\x00-\x1f\x7f]", "", out)
    out = re.sub(r"\.{2,}", " ", out)
    out = re.sub(r"\s+", " ", out).strip().strip(".").strip()
    return out[:120] or fallback


def have(binary: str) -> bool:
    return shutil.which(binary) is not None


def normalise_quality(value: Any) -> str:
    """"best", "worst", or a height ceiling as a decimal string.

    Anything unrecognised becomes "best". A preference the client got wrong
    should cost the user the preference, not the download."""
    v = str(value or "").strip().lower()
    if v in {"best", "worst"}:
        return v
    return v if QUALITY_HEIGHT.match(v) else "best"


def ytdlp_format(quality: str) -> str:
    """yt-dlp does its own format selection; this only tells it the ceiling."""
    if quality == "worst":
        return "wv*+wa/w"
    if quality == "best":
        return "bv*+ba/b"
    # "<=?" keeps formats whose height yt-dlp could not determine. The trailing
    # worst-selector means a source with nothing that small still downloads
    # rather than erroring out with "requested format not available" — and it
    # falls back DOWN to the smallest, not up to the largest, because someone
    # who capped the height wanted a smaller file, not the biggest one going.
    return f"bv*[height<=?{quality}]+ba/b[height<=?{quality}]/wv*+wa/w"


def hls_variants(url: str, referer: str = "") -> list[tuple[int, int]]:
    """(program_id, height) per variant, tallest first.

    ffmpeg exposes each variant of a master playlist as a program, so quality
    selection is one -map away — but only once we know which program is which
    size. Empty for a media playlist or a plain file, where there is no
    choice to make."""
    cmd = ["ffprobe", "-v", "error"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    cmd += ["-show_programs", "-of", "json", url]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
        data = json.loads(res.stdout or "{}")
    except (json.JSONDecodeError, subprocess.SubprocessError):
        return []

    found: list[tuple[int, int]] = []
    for prog in data.get("programs") or []:
        pid = prog.get("program_id")
        if pid is None:
            continue
        heights = [int(st["height"]) for st in prog.get("streams") or [] if st.get("height")]
        found.append((int(pid), max(heights) if heights else 0))
    found.sort(key=lambda pair: pair[1], reverse=True)
    return found


def pick_program(variants: list[tuple[int, int]], quality: str) -> int | None:
    """Mirrors pickVariant() in src/common.js: the ceiling falls back to the
    nearest thing on offer instead of refusing."""
    if not variants:
        return None
    if quality == "worst":
        return variants[-1][0]
    if quality == "best":
        return variants[0][0]

    cap = int(quality)
    # A variant with no resolution cannot be measured against the ceiling, so
    # it is only reached when nothing that carries one qualifies.
    known = [v for v in variants if v[1] > 0]
    for pid, height in known:
        if height <= cap:
            return pid
    return known[-1][0] if known else variants[0][0]


def probe_duration(url: str, referer: str = "") -> float:
    """Total seconds, so ffmpeg progress can be turned into a percentage."""
    cmd = ["ffprobe", "-v", "error"]
    if referer:
        cmd += ["-headers", f"Referer: {referer}\r\n"]
    cmd += ["-show_entries", "format=duration", "-of", "csv=p=0", url]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=False)
        return float((out.stdout or "").strip() or 0)
    except (ValueError, subprocess.SubprocessError):
        return 0.0


def set_state(job: Job, **kw: Any) -> None:
    with JOBS_LOCK:
        for k, v in kw.items():
            setattr(job, k, v)


# ------------------------------------------------------------------ workers


def run_ffmpeg(job: Job) -> Path:
    """Direct media and HLS/DASH manifests. `-c copy` remuxes without
    re-encoding, which is fast and lossless; the container just changes."""
    duration = probe_duration(job.url, job.referer)
    ext = "mp3" if job.fmt == "audio" else "mp4"
    out = job.out_dir / f"{sanitize(job.title)}.{ext}"

    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    if job.referer:
        cmd += ["-headers", f"Referer: {job.referer}\r\n"]
    cmd += ["-i", job.url]

    # Only probed when a ceiling was actually asked for: "best" is ffmpeg's own
    # default stream selection, and re-deriving it would only add a round trip.
    map_args: list[str] = []
    if job.fmt == "video" and job.quality != "best":
        program = pick_program(hls_variants(job.url, job.referer), job.quality)
        if program is not None:
            # One -map per program takes the variant's audio rendition with it.
            map_args = ["-map", f"0:p:{program}"]
    cmd += map_args

    if job.fmt == "audio":
        cmd += ["-vn", "-c:a", "libmp3lame", "-q:a", "2"]
    else:
        # bsf is needed when TS-sourced H.264 goes into MP4.
        cmd += ["-c", "copy", "-bsf:a", "aac_adtstoasc"]
        if job.subtitles:
            # mov_text is the only subtitle codec MP4 accepts; ignore the flag
            # when the input turns out to carry no text stream.
            cmd += ["-c:s", "mov_text"]
    cmd += ["-progress", "pipe:1", "-nostats", str(out)]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    for line in proc.stdout:
        if line.startswith("out_time_us=") and duration > 0:
            try:
                secs = int(line.split("=", 1)[1]) / 1_000_000
                set_state(job, progress=min(99.0, secs / duration * 100))
            except ValueError:
                pass
    proc.wait()

    if proc.returncode != 0:
        err = (proc.stderr.read() if proc.stderr else "") or "ffmpeg failed"
        # aac_adtstoasc is only valid for AAC in TS; retry without it.
        if "aac_adtstoasc" in err:
            return run_ffmpeg_plain(job, out, map_args)
        raise RuntimeError(err.strip()[:500])
    return out


def run_ffmpeg_plain(job: Job, out: Path, map_args: list[str] | None = None) -> Path:
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    if job.referer:
        cmd += ["-headers", f"Referer: {job.referer}\r\n"]
    cmd += ["-i", job.url, *(map_args or []), "-c", "copy", str(out)]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise RuntimeError((res.stderr or "ffmpeg failed").strip()[:500])
    return out


YTDLP_PCT = re.compile(r"\[download\]\s+([0-9.]+)%")


def run_ytdlp(job: Job) -> Path:
    """Page URLs. yt-dlp resolves the real media, picks formats and, with
    ffmpeg present, muxes separate audio and video streams back together."""
    template = str(job.out_dir / "%(title).120s.%(ext)s")
    cmd = ["yt-dlp", "--no-playlist", "--newline", "--no-color", "-o", template]
    if job.fmt == "audio":
        cmd += ["-x", "--audio-format", "mp3"]
    else:
        cmd += ["-f", ytdlp_format(job.quality), "--merge-output-format", "mp4"]
        if job.subtitles:
            # Embedded rather than sidecar: the job API returns one file.
            cmd += ["--embed-subs", "--sub-langs", "all", "--write-auto-subs"]
    if job.referer:
        cmd += ["--referer", job.referer]
    cmd.append(job.url)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    assert proc.stdout is not None
    tail: list[str] = []
    for line in proc.stdout:
        tail.append(line)
        del tail[:-40]
        m = YTDLP_PCT.search(line)
        if m:
            try:
                set_state(job, progress=min(99.0, float(m.group(1))))
            except ValueError:
                pass
    proc.wait()

    if proc.returncode != 0:
        raise RuntimeError("".join(tail).strip()[-500:] or "yt-dlp failed")

    produced = sorted(
        (p for p in job.out_dir.iterdir() if p.is_file()),
        key=lambda p: p.stat().st_mtime,
    )
    if not produced:
        raise RuntimeError("yt-dlp reported success but produced no file")
    return produced[-1]


def looks_direct(url: str) -> bool:
    return bool(MANIFEST_EXT.search(url) or MEDIA_EXT.search(url))


def run_job(job_id: str) -> None:
    with JOBS_LOCK:
        job = JOBS[job_id]
    set_state(job, state="running", progress=0.0)

    try:
        job.out_dir.mkdir(parents=True, exist_ok=True)
        # A direct media or manifest URL is ffmpeg's job; anything else is a
        # page that needs resolving first, which is what yt-dlp is for.
        if looks_direct(job.url):
            path = run_ffmpeg(job)
        elif have("yt-dlp"):
            path = run_ytdlp(job)
        else:
            raise RuntimeError(
                "That URL needs yt-dlp to resolve, which is not installed. "
                "Install it (pip install yt-dlp) or pass a direct media URL."
            )
        set_state(job, state="done", progress=100.0, path=path, message="")
    except Exception as exc:  # noqa: BLE001 - surfaced to the client verbatim
        set_state(job, state="error", message=str(exc)[:500])


def reap_old_jobs(root: Path) -> None:
    cutoff = time.time() - JOB_RETENTION_SECONDS
    with JOBS_LOCK:
        stale = [j for j in JOBS.values() if j.created_at < cutoff]
        for job in stale:
            JOBS.pop(job.id, None)
    for job in stale:
        shutil.rmtree(root / job.id, ignore_errors=True)


# -------------------------------------------------------------------- server


class Handler(BaseHTTPRequestHandler):
    server_version = f"CVAHelper/{VERSION}"

    # -- plumbing ---------------------------------------------------------
    def _send(self, status: HTTPStatus, payload: Any, ctype: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _cors(self) -> None:
        # The extension calls from an extension origin, and a user may also
        # drive this from a page, so allow both explicitly.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _fail(self, status: HTTPStatus, message: str) -> None:
        self._send(status, {"ok": False, "error": message})

    def _authorised(self) -> bool:
        token = self.server.token  # type: ignore[attr-defined]
        if not token:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {token}"

    def log_message(self, fmt: str, *args: Any) -> None:
        if self.server.verbose:  # type: ignore[attr-defined]
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- routes -----------------------------------------------------------
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self._cors()
        self.end_headers()

    def do_HEAD(self) -> None:  # noqa: N802
        self.do_GET()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path

        if path == "/api/health":
            self._send(HTTPStatus.OK, {
                "ok": True,
                "service": SERVICE,
                "version": VERSION,
                "capabilities": {
                    "video": have("ffmpeg"),
                    "audio": have("ffmpeg"),
                    "hls": have("ffmpeg"),
                    "sites": have("yt-dlp"),
                    # Picking an HLS variant means reading the master playlist's
                    # programs first, which is ffprobe's job.
                    "quality": have("ffprobe"),
                },
            })
            return

        if not self._authorised():
            self._fail(HTTPStatus.UNAUTHORIZED, "bad or missing token")
            return

        if path.startswith("/api/jobs/"):
            job_id = path[len("/api/jobs/"):].strip("/")
            with JOBS_LOCK:
                job = JOBS.get(job_id)
            if not job:
                self._fail(HTTPStatus.NOT_FOUND, "no such job")
                return
            self._send(HTTPStatus.OK, job.as_dict())
            return

        if path.startswith("/api/files/"):
            self._serve_file(path[len("/api/files/"):])
            return

        self._fail(HTTPStatus.NOT_FOUND, "not found")

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/jobs":
            self._fail(HTTPStatus.NOT_FOUND, "not found")
            return
        if not self._authorised():
            self._fail(HTTPStatus.UNAUTHORIZED, "bad or missing token")
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0 or length > MAX_BODY:
            self._fail(HTTPStatus.BAD_REQUEST, "empty or oversized body")
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except json.JSONDecodeError as exc:
            self._fail(HTTPStatus.BAD_REQUEST, f"invalid JSON: {exc}")
            return

        url = str(payload.get("url", "")).strip()
        # Only http(s): the URL is handed to a subprocess, so file:// and
        # friends must never be reachable from a network request.
        if urlparse(url).scheme not in {"http", "https"}:
            self._fail(HTTPStatus.BAD_REQUEST, "url must be http or https")
            return

        fmt = "audio" if str(payload.get("format", "")).lower() == "audio" else "video"
        quality = normalise_quality(payload.get("quality"))
        if not have("ffmpeg"):
            self._fail(HTTPStatus.SERVICE_UNAVAILABLE, "ffmpeg is not installed on the server")
            return

        job_id = uuid.uuid4().hex
        root: Path = self.server.output_dir  # type: ignore[attr-defined]
        job = Job(
            id=job_id,
            url=url,
            fmt=fmt,
            quality=quality,
            title=sanitize(str(payload.get("title", "")), "video"),
            referer=str(payload.get("referer", "")).strip(),
            subtitles=bool(payload.get("subtitles", False)),
            out_dir=root / job_id,
        )
        with JOBS_LOCK:
            JOBS[job_id] = job

        reap_old_jobs(root)
        threading.Thread(target=run_job, args=(job_id,), daemon=True).start()
        self._send(HTTPStatus.CREATED, {"id": job_id, "state": "queued"})

    # -- files ------------------------------------------------------------
    def _serve_file(self, suffix: str) -> None:
        parts = suffix.split("/", 1)
        if len(parts) != 2:
            self._fail(HTTPStatus.NOT_FOUND, "file not found")
            return

        job_id, name = parts[0], unquote(parts[1])
        with JOBS_LOCK:
            job = JOBS.get(job_id)
        if not job or not job.path or not job.path.exists():
            self._fail(HTTPStatus.NOT_FOUND, "file not found")
            return

        # Resolve and confirm containment: the name comes off the wire, so it
        # must not be able to escape this job's directory.
        target = (job.out_dir / name).resolve()
        if target != job.path.resolve() or not target.is_file():
            self._fail(HTTPStatus.NOT_FOUND, "file not found")
            return

        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        size = target.stat().st_size
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(size))
        self.send_header("Content-Disposition", f'attachment; filename="{target.name}"')
        self._cors()
        self.end_headers()
        if self.command == "HEAD":
            return
        with target.open("rb") as fh:
            shutil.copyfileobj(fh, self.wfile)


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, handler, *, output_dir: Path, token: str, verbose: bool):
        super().__init__(addr, handler)
        self.output_dir = output_dir
        self.token = token
        self.verbose = verbose


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Clark Video Archiver helper service")
    p.add_argument("--host", default="127.0.0.1",
                   help="bind address (default: 127.0.0.1; only change if you understand the exposure)")
    p.add_argument("--port", type=int, default=8788, help="port (default: 8788)")
    p.add_argument("--output-dir", default="~/Downloads/ClarkVideoArchiver",
                   help="where finished files are written")
    p.add_argument("--token", default=os.environ.get("CVA_HELPER_TOKEN", ""),
                   help="require Authorization: Bearer <token> (default: none)")
    p.add_argument("--verbose", action="store_true", help="log every request")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    if not have("ffmpeg"):
        print("error: ffmpeg not found on PATH", file=sys.stderr)
        return 1

    out = Path(args.output_dir).expanduser().resolve()
    out.mkdir(parents=True, exist_ok=True)

    server = HelperServer(
        (args.host, args.port), Handler,
        output_dir=out, token=args.token, verbose=args.verbose,
    )

    print(f"{SERVICE} v{VERSION} on http://{args.host}:{args.port}")
    print(f"  output   {out}")
    print(f"  ffmpeg   {'yes' if have('ffmpeg') else 'NO'}")
    print(f"  yt-dlp   {'yes' if have('yt-dlp') else 'no (page URLs unavailable)'}")
    print(f"  token    {'required' if args.token else 'not set'}")
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        print("  WARNING: not bound to loopback; anyone who can reach this port can queue jobs")
    print("Ctrl-C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
