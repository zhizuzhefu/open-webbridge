#!/usr/bin/env bash
# Regenerate the Chrome icons from the full-resolution logo using ImageMagick.
set -euo pipefail
cd "$(dirname "$0")"
for s in 16 32 48; do
  magick source/logo.png -resize "${s}x${s}" "PNG32:${s}.png"
done
# The Chrome Web Store icon has a 96px artwork area and transparent padding.
magick source/logo.png -resize 96x96 -background none -gravity center -extent 128x128 PNG32:128.png
echo "regenerated 16/32/48/128 png from source/logo.png"
