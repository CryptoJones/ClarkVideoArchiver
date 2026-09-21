#!/usr/bin/env bash
# Assemble loadable extension directories and zips for both browsers.
# The two builds differ only in the manifest: Chrome needs a single
# service_worker file, Firefox needs a background.scripts list.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$root/dist"

shared=(
  common.js hls.js subs.js helper.js background.js content.js
  popup.html popup.css popup.js
  downloader.html downloader.css downloader.js
  options.html options.js
)

# Pack a directory into a zip. Git Bash on Windows ships without `zip`, so fall
# back to Python's zipfile. `python3` there can be the Microsoft Store stub, which
# exists on PATH but does not run, so probe each candidate before trusting it.
pack() {
  local dir="$1" zipfile="$2" py
  if command -v zip >/dev/null 2>&1; then
    ( cd "$dir" && zip -qr "$zipfile" . )
    return
  fi
  for py in python3 python py; do
    if "$py" -c 'import zipfile' >/dev/null 2>&1; then
      "$py" -c 'import shutil, sys; shutil.make_archive(sys.argv[2][:-4], "zip", sys.argv[1])' "$dir" "$zipfile"
      return
    fi
  done
  echo "error: need either 'zip' or a working Python to pack $zipfile" >&2
  return 1
}

build_one() {
  local browser="$1"
  local out="$dist/$browser"

  rm -rf "$out"
  mkdir -p "$out/icons"

  for f in "${shared[@]}"; do
    cp "$root/src/$f" "$out/$f"
  done
  cp "$root/icons/"*.png "$out/icons/"
  cp "$root/src/manifest.$browser.json" "$out/manifest.json"

  # Only Chrome loads the importScripts shim.
  if [ "$browser" = "chrome" ]; then
    cp "$root/src/sw.js" "$out/sw.js"
  fi

  pack "$out" "$dist/clark-video-archiver-$browser.zip"
  echo "built  $out"
  echo "packed $dist/clark-video-archiver-$browser.zip"
}

if [ ! -f "$root/icons/icon-128.png" ]; then
  python3 "$root/scripts/make_icons.py"
fi

mkdir -p "$dist"
rm -f "$dist"/*.zip
build_one chrome
build_one firefox
