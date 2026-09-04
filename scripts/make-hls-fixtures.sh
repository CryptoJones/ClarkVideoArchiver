#!/usr/bin/env bash
# Generate real HLS streams to test the assembly pipeline against.
# Produces three variants from one source: plain MPEG-TS, fragmented MP4, and
# AES-128 encrypted TS.
#
# Usage: ./scripts/make-hls-fixtures.sh [output-dir]
set -euo pipefail

out="${1:-${TMPDIR:-/tmp}/cva-hls-fixtures}"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }

rm -rf "$out"
mkdir -p "$out/ts" "$out/fmp4" "$out/aes"

# Video and audio both present, so the tests can prove both survive assembly.
ffmpeg -y -loglevel error \
  -f lavfi -i testsrc=size=640x360:rate=25 \
  -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 12 \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac "$out/source.mp4"

# A keyframe every second, otherwise -hls_time cannot split finely and we get
# too few segments to meaningfully test ordering.
common=(-c:v libx264 -preset ultrafast -g 25 -keyint_min 25
        -force_key_frames "expr:gte(t,n_forced*1)" -c:a aac
        -f hls -hls_time 1 -hls_playlist_type vod)

ffmpeg -y -loglevel error -i "$out/source.mp4" "${common[@]}" \
  -hls_segment_filename "$out/ts/seg%d.ts" "$out/ts/index.m3u8"

ffmpeg -y -loglevel error -i "$out/source.mp4" "${common[@]}" \
  -hls_segment_type fmp4 -hls_fmp4_init_filename "init.mp4" \
  -hls_segment_filename "$out/fmp4/seg%d.m4s" "$out/fmp4/index.m3u8"

ffmpeg -y -loglevel error -i "$out/source.mp4" "${common[@]}" -hls_enc 1 \
  -hls_segment_filename "$out/aes/seg%d.ts" "$out/aes/index.m3u8"

# ffmpeg writes the key URI relative to its working directory rather than to the
# playlist, which no real packager does; normalise it so resolution works.
sed -i.bak 's|URI="[^"]*/index.m3u8.key"|URI="index.m3u8.key"|' "$out/aes/index.m3u8"
rm -f "$out/aes/index.m3u8.bak"

echo "fixtures in $out"
echo "  ts:   $(ls "$out"/ts/*.ts | wc -l) segments"
echo "  fmp4: $(ls "$out"/fmp4/*.m4s | wc -l) segments"
echo "  aes:  $(ls "$out"/aes/*.ts | wc -l) segments (encrypted)"
echo
echo "now run: node scripts/test-assemble.mjs $out"
