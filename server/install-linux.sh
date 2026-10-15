#!/usr/bin/env bash
# Installs or removes the systemd user unit that keeps the helper running.
#
# The Linux counterpart of install-windows.ps1: checks the requirements,
# installs cva-helper.service with ExecStart pointing at this checkout (so the
# repository can be cloned anywhere; re-run after moving it), enables it,
# starts it, and checks that it answers.
#
#   ./server/install-linux.sh              # start at login, restart on failure
#   ./server/install-linux.sh --boot       # ... and at boot, before anyone logs in
#   ./server/install-linux.sh --no-start   # install and enable, but do not start now
#   ./server/install-linux.sh --uninstall  # stop, disable and remove the unit
#
# --boot turns on systemd "linger" for your user (loginctl enable-linger),
# which most systems allow only with sudo; you are asked for it if so.
set -euo pipefail

server_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit_name=cva-helper.service
unit_src="$server_dir/$unit_name"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit_dst="$unit_dir/$unit_name"
health=http://127.0.0.1:8788/api/health

boot=0 start=1 uninstall=0
for arg in "$@"; do
  case "$arg" in
    --boot) boot=1 ;;
    --no-start) start=0 ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

if ! systemctl --user show-environment >/dev/null 2>&1; then
  echo "error: no systemd user session here (systemctl --user does not answer)." >&2
  echo "Run the helper by hand instead: $server_dir/cva_helper.py" >&2
  exit 1
fi

if (( uninstall )); then
  if [[ ! -e "$unit_dst" ]]; then
    echo "$unit_name is not installed; nothing to do."
    exit 0
  fi
  systemctl --user disable --now "$unit_name" || true
  rm -f "$unit_dst"
  systemctl --user daemon-reload
  echo "Removed $unit_name. The helper is stopped and will not start again."
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == yes ]]; then
    echo "Linger is still on for $USER (other user services may rely on it)."
    echo "Turn it off with: sudo loginctl disable-linger $USER"
  fi
  exit 0
fi

# -- requirements -------------------------------------------------------------
# The unit runs with its own PATH, so check against that rather than this shell's.
unit_path="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
find_in_unit_path() { PATH="$unit_path" command -v "$1" 2>/dev/null; }

echo "Checking requirements..."
missing=0
python="$(find_in_unit_path python3 || true)"
if [[ -n "$python" ]] && "$python" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))'; then
  echo "  python   $python ($("$python" -c 'import platform; print(platform.python_version())'))"
else
  echo "  python   NOT FOUND - install Python 3.9+ (sudo apt install python3)"
  missing=1
fi
if ffmpeg="$(find_in_unit_path ffmpeg)"; then
  echo "  ffmpeg   $ffmpeg"
else
  echo "  ffmpeg   NOT FOUND - required (sudo apt install ffmpeg)"
  missing=1
fi
if ytdlp="$(find_in_unit_path yt-dlp)"; then
  # Captured first: with pipefail, grep -q quitting early could fail the pipe.
  targets="$("$ytdlp" --list-impersonate-targets 2>&1 || true)"
  if grep curl_cffi <<<"$targets" | grep -qv unavailable; then
    echo "  yt-dlp   $ytdlp (browser impersonation available)"
  else
    echo "  yt-dlp   $ytdlp - WITHOUT browser impersonation (curl_cffi missing)"
    echo "           Vimeo and similar sites will fail with HTTP 401/403. Fix:"
    echo "           pipx install --force \"yt-dlp[default,curl-cffi]\""
  fi
else
  echo "  yt-dlp   not found (page URLs unavailable; pipx install \"yt-dlp[default,curl-cffi]\")"
fi
(( missing )) && { echo "A requirement is missing (see above). Install it and run this again." >&2; exit 1; }

# -- unit -----------------------------------------------------------------------
mkdir -p "$unit_dir"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# Point ExecStart at this checkout and the interpreter found above.
sed -e "s|^ExecStart=.*|ExecStart=$python $server_dir/cva_helper.py|" \
    -e '/^# Adjust the path below/d' "$unit_src" > "$tmp"
# yt-dlp fails every job when told to read cookies from a browser that has no
# profile here, so only keep the unit's Firefox default when Firefox has one.
if [[ ! -d "$HOME/.mozilla/firefox" && ! -d "$HOME/snap/firefox/common/.mozilla/firefox" ]]; then
  sed -i 's|^Environment=CVA_YTDLP_COOKIES_FROM_BROWSER=|# &|' "$tmp"
  echo "No Firefox profile found, so yt-dlp will not read browser cookies."
  echo "  To use another browser's, edit CVA_YTDLP_COOKIES_FROM_BROWSER in $unit_dst"
fi
install -m 644 "$tmp" "$unit_dst"
systemctl --user daemon-reload
systemctl --user enable "$unit_name" >/dev/null
echo "Installed $unit_dst (starts at login, restarts on failure)."

if (( boot )); then
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == yes ]]; then
    echo "Linger already on: the helper starts at boot."
  elif loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER"; then
    echo "Linger on: the helper now starts at boot, before anyone logs in."
  else
    echo "warning: could not enable linger; the helper will start at login only." >&2
  fi
fi

if (( start )); then
  # restart, not start: a re-install must pick up the new unit.
  systemctl --user restart "$unit_name"
  echo "Started. Waiting for the helper to answer..."
  ok=0
  for _ in $(seq 15); do
    sleep 1
    if "$python" -c 'import sys, urllib.request; urllib.request.urlopen(sys.argv[1], timeout=2)' "$health" 2>/dev/null; then
      ok=1; break
    fi
  done
  if (( ok )); then
    echo "Helper is up: $health answered."
  else
    echo "warning: no answer on $health yet. Check: journalctl --user -u $unit_name -n 30" >&2
  fi
fi

cat <<EOF

Verify:   systemctl --user status $unit_name
Log:      journalctl --user -u $unit_name -f
Restart:  systemctl --user restart $unit_name
Remove:   $server_dir/install-linux.sh --uninstall
EOF
