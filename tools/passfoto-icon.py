#!/usr/bin/env python3
"""Draws the home screen icon for the passport booth.

No image library needed: the shapes are sampled onto a supersampled grid and
written out as PNG with zlib. Run from the repo root:

    python3 tools/passfoto-icon.py

Writes passfoto/icon-192.png and passfoto/icon-512.png. The colours are the
booth's own tokens, so the icon and the app stay the same object.
"""

import math
import os
import struct
import zlib

TEAK_DARK = (0x5A, 0x34, 0x18)
TEAK_LIGHT = (0xB7, 0x79, 0x3C)
STEEL = (0xB9, 0xBC, 0xBB)
STEEL_SHADOW = (0x6E, 0x72, 0x71)
GUIDE_CREAM = (0xF0, 0xE9, 0xD8)
LAMP_GLOW = (0xFB, 0xF3, 0xDE)
BUTTON_GREEN = (0x2E, 0x9E, 0x4A)
APERTURE = (0x24, 0x1A, 0x12)


def mix(a, b, t):
    t = max(0.0, min(1.0, t))
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def in_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def in_ellipse(x, y, cx, cy, rx, ry):
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0


def colour_at(x, y):
    """The colour at (x, y) in a 100x100 space."""
    # Teak panel: grain, then a vignette towards the edges.
    grain = 0.5 + 0.5 * math.sin(x * 2.4) * math.sin(x * 0.7 + 1.3)
    c = mix(TEAK_DARK, TEAK_LIGHT, 0.35 + grain * 0.3)
    vignette = math.hypot((x - 50) / 50, (y - 50) / 50)
    c = mix(c, TEAK_DARK, max(0.0, (vignette - 0.45)) * 1.15)

    # The light spilling out of the lamp bar, with no edge where it starts.
    c = mix(c, LAMP_GLOW, 0.30 * math.exp(-(((y - 21) / 30.0) ** 2)))

    # Lamp bar.
    if in_round_rect(x, y, 20, 15, 80, 27, 3):
        c = LAMP_GLOW if in_round_rect(x, y, 22, 17, 78, 25, 2) else STEEL

    # Bezel and aperture.
    if in_round_rect(x, y, 22, 33, 78, 78, 4):
        c = mix(STEEL, STEEL_SHADOW, (y - 33) / 45 * 0.55)
        if in_round_rect(x, y, 28, 38, 72, 73, 2):
            c = APERTURE
            if in_ellipse(x, y, 50, 52, 12.5, 15.5):            # head
                c = GUIDE_CREAM
            elif y > 62 and in_ellipse(x, y, 50, 92, 21, 24):   # shoulders
                c = GUIDE_CREAM

    # The shutter.
    if in_ellipse(x, y, 50, 87, 8, 8):
        c = STEEL
    if in_ellipse(x, y, 50, 87, 6, 6):
        c = mix(mix(BUTTON_GREEN, (0x6C, 0xD8, 0x88), 0.45), BUTTON_GREEN,
                min(1.0, math.hypot(x - 48, y - 85) / 7))
    return c


def draw(size, oversample):
    """Samples oversample x oversample points per pixel, which is the whole
    antialiasing story."""
    n = size * oversample
    step = 100.0 / n
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(oversample):
                y = (py * oversample + sy + 0.5) * step
                for sx in range(oversample):
                    x = (px * oversample + sx + 0.5) * step
                    c = colour_at(x, y)
                    r += c[0]; g += c[1]; b += c[2]
            d = oversample * oversample
            row += bytes((r // d, g // d, b // d))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", header))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "passfoto")
    for size, oversample in ((192, 4), (512, 2)):
        path = os.path.normpath(os.path.join(root, f"icon-{size}.png"))
        write_png(path, draw(size, oversample), size)
        print(path, os.path.getsize(path), "bytes")
