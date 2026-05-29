#!/usr/bin/env bash
# Install Open WebBridge locally:
#   1. build the daemon and copy it to ~/.open-webbridge/bin/
#   2. install the skill into detected AI-agent skill directories
#   3. start the daemon and print next steps
#
# Flags:
#   --no-start    build + install but do not start the daemon
#   --no-skill    skip skill installation
#   -h | --help   show usage
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DAEMON_DIR="$ROOT/open-webbridge-daemon"
SKILL_DIR="$ROOT/open-webbridge-skill"
EXT_DIR="$ROOT/open-webbridge-extension"
INSTALL_BIN_DIR="$HOME/.open-webbridge/bin"

NO_START=0
NO_SKILL=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --no-skill) NO_SKILL=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

echo "==> Building daemon"
cd "$ROOT"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$DAEMON_DIR/bin/open-webbridge" ./open-webbridge-daemon

echo "==> Installing binary to $INSTALL_BIN_DIR"
mkdir -p "$INSTALL_BIN_DIR"
cp "$DAEMON_DIR/bin/open-webbridge" "$INSTALL_BIN_DIR/open-webbridge"
BIN="$INSTALL_BIN_DIR/open-webbridge"

if [[ "$NO_SKILL" -eq 0 ]]; then
  echo "==> Installing skill"
  # Install into any agent skill dir that already exists on this machine.
  CANDIDATES=(
    "$HOME/.claude/skills"
    "$HOME/.agents/skills"
    "$HOME/.config/agents/skills"
    "$HOME/.codex/skills"
  )
  installed_any=0
  for base in "${CANDIDATES[@]}"; do
    if [[ -d "$base" ]]; then
      dest="$base/open-webbridge"
      rm -rf "$dest"
      mkdir -p "$dest"
      cp -R "$SKILL_DIR/." "$dest/"
      echo "    -> $dest"
      installed_any=1
    fi
  done
  [[ "$installed_any" -eq 0 ]] && echo "    (no agent skill directories found; skipped)"
fi

if [[ "$NO_START" -eq 0 ]]; then
  echo "==> Starting daemon"
  "$BIN" start || true
fi

cat <<EOF

Open WebBridge installed.

Next steps (one-time):
  1) Load the browser extension:
       chrome://extensions  ->  Developer mode  ->  Load unpacked
       select: $EXT_DIR
  2) Connect it to the daemon:
       $BIN url            # copy the printed ws://…?token=… URL
     Click the extension's toolbar icon, paste the URL, press Connect.
  3) Verify:
       $BIN status         # expect "extension_connected":true

Add $INSTALL_BIN_DIR to your PATH for convenience:
  export PATH="\$PATH:$INSTALL_BIN_DIR"
EOF
