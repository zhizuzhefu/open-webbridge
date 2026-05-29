#!/usr/bin/env bash
# Regenerate the PNG icons from icon.svg (anti-aliased) using librsvg + sips.
# icon.svg is the source of truth; the PNGs are derived artifacts.
set -euo pipefail
cd "$(dirname "$0")"
command -v rsvg-convert >/dev/null || { echo "needs rsvg-convert (brew install librsvg)"; exit 1; }
master="$(mktemp -t owb-icon).png"
rsvg-convert -w 1024 -h 1024 icon.svg -o "$master"
for s in 16 32 48 128; do
  sips -z "$s" "$s" "$master" --out "${s}.png" >/dev/null
done
rm -f "$master"
echo "regenerated 16/32/48/128 png from icon.svg"
