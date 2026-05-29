#!/usr/bin/env bash
# Build the Open WebBridge daemon binary into open-webbridge-daemon/bin/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
echo "==> go build (daemon)"
CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o open-webbridge-daemon/bin/open-webbridge ./open-webbridge-daemon
echo "==> built $ROOT/open-webbridge-daemon/bin/open-webbridge"
./open-webbridge-daemon/bin/open-webbridge version
