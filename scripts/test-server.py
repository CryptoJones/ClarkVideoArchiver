#!/usr/bin/env python3
"""Checks for cva_helper.py that need no ffmpeg, network or running server."""
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))
import cva_helper  # noqa: E402

failures = 0


def check(name, ok):
    global failures
    print(("  ok   " if ok else "  FAIL ") + name)
    failures += 0 if ok else 1


def done_job(filename):
    out = Path(tempfile.mkdtemp())
    path = out / filename
    path.write_bytes(b"x")
    return cva_helper.Job(id="abc123", url="http://x/", fmt="video", quality="best",
                          title="t", referer="", subtitles=False, out_dir=out,
                          state="done", path=path)


for name in ("plain.mp4", "Top #1 video 100% real.mp4", "a&b=c+d;e.mp4", "caf\u00e9 \u2713.mp4"):
    url = done_job(name).as_dict()["download_url"]
    parts = urlsplit(url)
    check(f"download_url survives URL parsing: {ascii(name)}",
          not parts.fragment and not parts.query and unquote(parts.path) == f"/api/files/abc123/{name}")

vimeo_401 = (
    "[vimeo] 391559511: Downloading webpage\n" + "x" * 600 + "\n"
    "WARNING: [vimeo] The extractor is attempting impersonation, but no impersonate "
    "target is available. If you encounter errors, then see ...\n"
    "ERROR: [vimeo] 391559511: Unable to download webpage: HTTP Error 401: Unauthorized\n"
)
msg = cva_helper.ytdlp_failure(vimeo_401)
check("impersonation failure leads with the curl_cffi fix", msg.startswith(cva_helper.YTDLP_IMPERSONATE_FIX))
check("impersonation failure keeps yt-dlp's own error", msg.endswith("HTTP Error 401: Unauthorized"))
check("impersonation failure fits the 500-character job message", len(msg) <= 500)
check("other yt-dlp failures are passed through unchanged",
      cva_helper.ytdlp_failure("ERROR: Video unavailable\n") == "ERROR: Video unavailable")
check("an empty yt-dlp failure still says something", cva_helper.ytdlp_failure("") == "yt-dlp failed")

if failures:
    sys.exit(f"\n{failures} failed")
print("\nall tests passed")
