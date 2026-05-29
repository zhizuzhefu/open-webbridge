#!/usr/bin/env bash
# Open WebBridge one-click installer.
#
#   curl -fsSL https://raw.githubusercontent.com/zhizuzhefu/open-webbridge/main/scripts/install.sh | bash
#
# Downloads the prebuilt daemon binary for this OS/arch from GitHub Releases,
# installs the skill into detected AI-agent directories, and starts the daemon.
# No Go toolchain required. The browser extension is NOT installed here — get it
# from the Chrome Web Store, or load it unpacked yourself.
#
# Env / flags:
#   OWB_VERSION=v1.0.0   install a specific release (default: latest)
#   --no-start           install but do not start the daemon
#   --no-skill           skip skill installation
#   -h | --help          show this help
set -euo pipefail

REPO="zhizuzhefu/open-webbridge"
BASE_DIR="$HOME/.open-webbridge"
BIN_DIR="$BASE_DIR/bin"
BIN="$BIN_DIR/open-webbridge"

NO_START=0
NO_SKILL=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --no-skill) NO_SKILL=1 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- detect platform ---------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$OS" in
  darwin|linux) ;;
  *) echo "unsupported OS: $OS (prebuilt binaries are darwin/linux only; build from source with scripts/dev-install.sh)" >&2; exit 1 ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

VERSION="${OWB_VERSION:-latest}"
if [[ "$VERSION" == "latest" ]]; then
  DL="https://github.com/$REPO/releases/latest/download"
else
  DL="https://github.com/$REPO/releases/download/$VERSION"
fi

BIN_ASSET="open-webbridge-${OS}-${ARCH}"

echo "==> Installing Open WebBridge ($VERSION, ${OS}/${ARCH})"
mkdir -p "$BIN_DIR"

echo "    downloading daemon: $DL/$BIN_ASSET"
if ! curl -fSL --progress-bar "$DL/$BIN_ASSET" -o "$BIN"; then
  echo "failed to download the daemon binary." >&2
  echo "If no release exists yet, build from source: scripts/dev-install.sh" >&2
  exit 1
fi
chmod +x "$BIN"

# The extension is NOT installed by this script — install it from the Chrome
# Web Store, or load it unpacked yourself (see the next-steps message below).

# --- skill -------------------------------------------------------------------
TMP="$(mktemp -d)"
if [[ "$NO_SKILL" -eq 0 ]]; then
  echo "    installing skill"
  if curl -fsSL "$DL/open-webbridge-skill.tar.gz" -o "$TMP/skill.tgz"; then
    for base in "$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.config/agents/skills" "$HOME/.codex/skills"; do
      if [[ -d "$base" ]]; then
        dest="$base/open-webbridge"
        rm -rf "$dest"; mkdir -p "$dest"
        tar -C "$dest" -xzf "$TMP/skill.tgz"
        echo "    -> $dest"
      fi
    done
  fi
fi
rm -rf "$TMP"

# --- start -------------------------------------------------------------------
if [[ "$NO_START" -eq 0 ]]; then
  echo "==> Starting daemon"
  "$BIN" start || true
fi

cat <<EOF

Open WebBridge installed to $BIN.

Next steps (one-time):
  1) Install the Open WebBridge extension, either:
       - from the Chrome Web Store (auto-updates), or
       - manually: build it (cd open-webbridge-extension && npm install && npm run build)
         then chrome://extensions -> Developer mode -> Load unpacked -> select dist/
  2) Connect it:  $BIN url     # paste the printed ws://… URL into the popup
  3) Verify:      $BIN status  # expect "extension_connected":true

Add the binary to your PATH:
  export PATH="\$PATH:$BIN_DIR"

Remote automation (drive this machine's Chrome from elsewhere):
  $BIN bind remote   # exposes /command only; the extension link stays loopback
EOF
