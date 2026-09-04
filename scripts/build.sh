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

  ( cd "$out" && zip -qr "$dist/clark-video-archiver-$browser.zip" . )
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
