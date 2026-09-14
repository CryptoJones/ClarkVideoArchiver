#!/usr/bin/env bash
# Produce a signed Firefox .xpi that installs on *release* Firefox and sticks
# across restarts (unlike a temporary add-on). Uses Mozilla's web-ext against
# the freshly built dist/firefox bundle.
#
# Prereqs:
#   - node/npx (web-ext is fetched via npx; no global install needed)
#   - AMO API credentials: addons.mozilla.org -> Developer Hub -> Manage API Keys
#
# Credentials are read from the environment (never commit them):
#   export AMO_JWT_ISSUER=user:12345:67       # the "JWT issuer" / API key
#   export AMO_JWT_SECRET=abcdef0123456789...  # the API secret
#
# Usage:
#   scripts/sign.sh                 # unlisted (self-distribution), default
#   scripts/sign.sh listed          # submit to AMO for public listing
#
# Note: every upload needs a NEW version. Bump "version" in
# src/manifest.firefox.json before re-signing, or AMO rejects the duplicate.
set -euo pipefail

channel="${1:-unlisted}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dist="$root/dist"
src_dir="$dist/firefox"

: "${AMO_JWT_ISSUER:?Set AMO_JWT_ISSUER (AMO API key). See scripts/sign.sh header.}"
: "${AMO_JWT_SECRET:?Set AMO_JWT_SECRET (AMO API secret). See scripts/sign.sh header.}"

# Always sign the current build, not a stale one.
echo "==> Building dist/firefox"
bash "$root/scripts/build.sh" >/dev/null

echo "==> Signing ($channel) from $src_dir"
npx --yes web-ext sign \
  --source-dir "$src_dir" \
  --artifacts-dir "$dist" \
  --channel "$channel" \
  --api-key "$AMO_JWT_ISSUER" \
  --api-secret "$AMO_JWT_SECRET"

echo
echo "Signed .xpi is in: $dist"
echo "Install it: Firefox -> about:addons -> gear -> Install Add-on From File..."
