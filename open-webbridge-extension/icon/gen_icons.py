#!/usr/bin/env python3
"""Generate the Open WebBridge extension icons with no third-party deps.

Draws a teal rounded square with a simple white suspension-bridge motif
(a deck line plus two cables) and writes 16/32/48/128 px PNGs.
"""
import struct
import zlib
import os

TEAL = (14, 124, 134)
TEAL_DARK = (10, 91, 99)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def render(size):
    s = size
    r = s * 0.22  # corner radius
    px = bytearray()
    for y in range(s):
        for x in range(s):
            # rounded-rect mask
            cx = min(x, s - 1 - x)
            cy = min(y, s - 1 - y)
            inside = True
            if cx < r and cy < r:
                dx, dy = r - cx, r - cy
                if dx * dx + dy * dy > r * r:
                    inside = False
            if not inside:
                px += bytes((0, 0, 0, 0))
                continue
            # background vertical gradient
            col = lerp(TEAL, TEAL_DARK, y / s)
            a = 255

            fx, fy = x / s, y / s
            # deck line
            if 0.6 <= fy <= 0.66 and 0.16 <= fx <= 0.84:
                col, a = WHITE, 255
            # two towers
            elif (abs(fx - 0.34) < 0.035 or abs(fx - 0.66) < 0.035) and 0.30 <= fy <= 0.66:
                col, a = WHITE, 255
            # suspension cables (two shallow V's from tower tops)
            else:
                for tower in (0.34, 0.66):
                    span = 0.18
                    if abs(fx - tower) <= span and fy < 0.62:
                        # cable dips toward midspan between towers
                        cable_y = 0.30 + (abs(fx - tower) / span) * 0.20
                        if abs(fy - cable_y) < 0.025:
                            col, a = WHITE, 255
            px += bytes((col[0], col[1], col[2], a))
    return png(s, s, bytes(px))


def png(w, h, rgba):
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)  # filter type 0
        raw += rgba[y * stride:(y + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    for size in (16, 32, 48, 128):
        with open(os.path.join(here, f"{size}.png"), "wb") as f:
            f.write(render(size))
        print(f"wrote {size}.png")


if __name__ == "__main__":
    main()
