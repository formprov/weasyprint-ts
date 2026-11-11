"""JPEG codec parity harness for weasy-qfx.8.33.

Reference: Pillow inside the pinned ``weasy-alpine-prod`` image (the exact
library the Python WeasyPrint uses to decode and re-save JPEGs). Port:
``src/jpeg`` driven through ``tools/jpeg_codec.ts``.

The corpus is generated deterministically:

* ``pillow`` cases are encoded by Pillow itself (quality sweep, subsampling
  4:4:4/4:2:2/4:2:0, progressive, restart intervals, grayscale, CMYK, EXIF
  orientations, ICC profiles, large sizes);
* ``blocks`` cases use a tiny DC-only baseline writer in this file so we can
  cover layouts Pillow cannot save: 4:4:0, 4:1:1, 4:1:0, non-interleaved
  multi-scan, YCCK, Adobe-RGB, marker-less component id guessing, plus a few
  files Pillow must reject (12-bit, 16-bit, 2 components).

For every case the oracle records the decoded raw samples (Pillow's mode: L,
RGB or CMYK) and, when upstream would re-save the file (EXIF or an explicit
``jpeg_quality``), Pillow's re-encoded bytes at quality 75. The port must match
both byte for byte.

Usage (from weasyprint-ts/)::

    python3 parity/jpeg_parity.py                 # full run
    python3 parity/jpeg_parity.py --keep /tmp/jp  # keep the corpus/outputs
    python3 parity/jpeg_parity.py --filter cmyk   # subset by case name

In-container role (the driver invokes this)::

    docker run --rm -v "$PWD/parity:/p:ro" -v /tmp/out:/out weasy-alpine-prod:latest \
        /venv/bin/python /p/jpeg_parity.py --oracle /out
"""
import argparse
import io
import json
import os
import subprocess
import sys
import tempfile

# --------------------------------------------------------------------------
# DC-only baseline writer (arbitrary components, sampling factors and markers)
# --------------------------------------------------------------------------

NATURAL_ORDER = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]
STD_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]
STD_CHROMA = [
    17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
]
DC_LUMA_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
DC_LUMA_VALS = list(range(12))
DC_CHROMA_BITS = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
DC_CHROMA_VALS = list(range(12))
AC_LUMA_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7D]
AC_LUMA_VALS = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xA1, 0x08, 0x23, 0x42, 0xB1, 0xC1, 0x15, 0x52, 0xD1, 0xF0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0A, 0x16, 0x17, 0x18, 0x19, 0x1A, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2A, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7,
    0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3, 0xC4, 0xC5,
    0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA, 0xE1, 0xE2,
    0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF1, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
]
AC_CHROMA_BITS = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]
AC_CHROMA_VALS = [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xA1, 0xB1, 0xC1, 0x09, 0x23, 0x33, 0x52, 0xF0,
    0x15, 0x62, 0x72, 0xD1, 0x0A, 0x16, 0x24, 0x34, 0xE1, 0x25, 0xF1, 0x17, 0x18, 0x19, 0x1A, 0x26,
    0x27, 0x28, 0x29, 0x2A, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3A, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4A, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5A, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6A, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8A, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9A, 0xA2, 0xA3, 0xA4, 0xA5,
    0xA6, 0xA7, 0xA8, 0xA9, 0xAA, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xC2, 0xC3,
    0xC4, 0xC5, 0xC6, 0xC7, 0xC8, 0xC9, 0xCA, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8, 0xD9, 0xDA,
    0xE2, 0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xF2, 0xF3, 0xF4, 0xF5, 0xF6, 0xF7, 0xF8,
    0xF9, 0xFA,
]

TABLES = {
    'luma': (0, DC_LUMA_BITS, DC_LUMA_VALS, AC_LUMA_BITS, AC_LUMA_VALS),
    'chroma': (1, DC_CHROMA_BITS, DC_CHROMA_VALS, AC_CHROMA_BITS, AC_CHROMA_VALS),
}


def scaled(base, quality):
    q = max(1, min(100, int(quality)))
    scale = 5000 // q if q < 50 else 200 - q * 2
    return [max(1, min(255, (b * scale + 50) // 100)) for b in base]


def build_codes(bits, vals):
    code, size = [0] * 256, [0] * 256
    c = k = 0
    for length in range(1, 17):
        for _ in range(bits[length - 1]):
            sym = vals[k]
            k += 1
            code[sym] = c
            size[sym] = length
            c += 1
        c <<= 1
    return code, size


class BitWriter:
    def __init__(self):
        self.out = bytearray()
        self.acc = 0
        self.n = 0

    def put(self, value, length):
        for i in range(length - 1, -1, -1):
            self.acc = (self.acc << 1) | ((value >> i) & 1)
            self.n += 1
            if self.n == 8:
                self.out.append(self.acc)
                if self.acc == 0xFF:
                    self.out.append(0)
                self.acc = 0
                self.n = 0

    def flush(self):
        if self.n:
            self.put((1 << (8 - self.n)) - 1, 8 - self.n)


def magnitude(v):
    n = 0
    a = abs(v)
    while a:
        n += 1
        a >>= 1
    return n


def block_pattern(seed):
    """A deterministic per-block value; every 8x8 block is constant, so the DCT
    has a single coefficient and Pillow's output exercises the upsamplers and
    colour conversions without depending on this writer's IDCT fidelity."""
    return lambda bx, by: (bx * 37 + by * 91 + seed * 53) % 256


def encode_blocks(width, height, components, quality=75, adobe_transform=None, jfif=True,
                  restart_interval=0, non_interleaved=False, precision=8):
    """components: list of dicts {h, v, table, seed, id?}."""
    nc = len(components)
    hmax = max(c['h'] for c in components)
    vmax = max(c['v'] for c in components)
    mcus_x = (width + 8 * hmax - 1) // (8 * hmax)
    mcus_y = (height + 8 * vmax - 1) // (8 * vmax)
    lum_q = scaled(STD_LUMA, quality)
    chr_q = scaled(STD_CHROMA, quality)
    quant = {'luma': lum_q, 'chroma': chr_q}
    codes = {name: (build_codes(t[1], t[2]), build_codes(t[3], t[4])) for name, t in TABLES.items()}

    def write_scan(bw, scan):
        last_dc = {i: 0 for i in scan}
        if len(scan) > 1:
            units = [(mx, my) for my in range(mcus_y) for mx in range(mcus_x)]
        else:
            c = components[scan[0]]
            units = [(bx, by) for by in range(mcus_y * c['v']) for bx in range(mcus_x * c['h'])]
        for ui, (ux, uy) in enumerate(units):
            if restart_interval and ui and ui % restart_interval == 0:
                bw.flush()
                bw.out += b'\xff' + bytes([0xD0 + ((ui // restart_interval - 1) % 8)])
                bw.acc = bw.n = 0
                last_dc = {i: 0 for i in scan}
            for ci in scan:
                c = components[ci]
                (dc_code, dc_size), (ac_code, ac_size) = codes[c['table']]
                nbx = c['h'] if len(scan) > 1 else 1
                nby = c['v'] if len(scan) > 1 else 1
                for by in range(nby):
                    for bx in range(nbx):
                        if len(scan) > 1:
                            gx, gy = ux * c['h'] + bx, uy * c['v'] + by
                        else:
                            gx, gy = ux, uy
                        value = block_pattern(c['seed'])(gx, gy)
                        dc = round(8 * (value - 128) / quant[c['table']][0])
                        diff = dc - last_dc[ci]
                        last_dc[ci] = dc
                        n = magnitude(diff)
                        bw.put(dc_code[n], dc_size[n])
                        if n:
                            bw.put(diff - 1 if diff < 0 else diff, n)
                        bw.put(ac_code[0], ac_size[0])

    out = bytearray(b'\xff\xd8')
    if jfif:
        out += bytes.fromhex('ffe000104a46494600010100000100010000')
    if adobe_transform is not None:
        out += bytes([0xFF, 0xEE, 0x00, 0x0E]) + b'Adobe' + bytes([0x00, 0x64, 0x00, 0x00, 0x00, 0x00, adobe_transform])
    for table_id in sorted({TABLES[c['table']][0] for c in components}):
        table = lum_q if table_id == 0 else chr_q
        out += bytes([0xFF, 0xDB, 0x00, 0x43, table_id]) + bytes(table[n] for n in NATURAL_ORDER)
    sof = bytearray([precision, height >> 8, height & 0xFF, width >> 8, width & 0xFF, nc])
    for i, c in enumerate(components):
        sof += bytes([c.get('id', i + 1), (c['h'] << 4) | c['v'], TABLES[c['table']][0]])
    out += bytes([0xFF, 0xC0, 0x00, 2 + len(sof)]) + sof
    for table_id in sorted({TABLES[c['table']][0] for c in components}):
        _, dcb, dcv, acb, acv = [t for t in TABLES.values() if t[0] == table_id][0]
        out += bytes([0xFF, 0xC4, 0x00, 2 + 1 + 16 + len(dcv), table_id]) + bytes(dcb) + bytes(dcv)
        out += bytes([0xFF, 0xC4, 0x00, 2 + 1 + 16 + len(acv), 0x10 | table_id]) + bytes(acb) + bytes(acv)
    if restart_interval:
        out += bytes([0xFF, 0xDD, 0x00, 0x04, restart_interval >> 8, restart_interval & 0xFF])

    bw = BitWriter()
    scans = [[i] for i in range(nc)] if non_interleaved else [list(range(nc))]
    for scan in scans:
        sos = bytearray([len(scan)])
        for ci in scan:
            table_id = TABLES[components[ci]['table']][0]
            sos += bytes([components[ci].get('id', ci + 1), (table_id << 4) | table_id])
        sos += bytes([0, 63, 0])
        out += bytes([0xFF, 0xDA, 0x00, 2 + len(sos)]) + sos
        bw.out = bytearray()
        write_scan(bw, scan)
        bw.flush()
        out += bw.out
    out += b'\xff\xd9'
    return bytes(out)


# --------------------------------------------------------------------------
# Corpus
# --------------------------------------------------------------------------

SIZES = [(1, 1), (8, 8), (15, 17), (16, 16), (33, 1), (40, 24), (65, 41)]


def source_bytes(mode, width, height):
    channels = {'L': 1, 'RGB': 3, 'CMYK': 4}[mode]
    return bytes(
        (x * 7 + y * 11 + k * 53 + ((x * y) >> 3)) & 255
        for y in range(height) for x in range(width) for k in range(channels))


def pillow_case(name, mode, width, height, **save):
    return {'name': name, 'kind': 'pillow', 'mode': mode, 'width': width, 'height': height, 'save': save}


def blocks_case(name, width, height, components, **options):
    return {'name': name, 'kind': 'blocks', 'width': width, 'height': height,
            'components': components, 'options': options}


def ycbcr_layout(name, h, v, width, height, **options):
    return blocks_case(name, width, height, [
        {'h': h, 'v': v, 'table': 'luma', 'seed': 0},
        {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1},
        {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2},
    ], **options)


def cmyk_components(h=1, v=1):
    return [
        {'h': h, 'v': v, 'table': 'luma', 'seed': 0, 'id': 0x43},
        {'h': h, 'v': v, 'table': 'luma', 'seed': 1, 'id': 0x4D},
        {'h': h, 'v': v, 'table': 'luma', 'seed': 2, 'id': 0x59},
        {'h': h, 'v': v, 'table': 'luma', 'seed': 3, 'id': 0x4B},
    ]


def ycck_components(h, v):
    return [
        {'h': h, 'v': v, 'table': 'luma', 'seed': 0, 'id': 0x43},
        {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1, 'id': 0x4D},
        {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2, 'id': 0x59},
        {'h': h, 'v': v, 'table': 'luma', 'seed': 3, 'id': 0x4B},
    ]


def cases():
    out = []

    # --- Pillow-encoded RGB --------------------------------------------------
    for quality in (1, 10, 25, 50, 75, 90, 100):
        for width, height in ((15, 17), (40, 24)):
            out.append(pillow_case(f'rgb-q{quality}-{width}x{height}', 'RGB', width, height,
                                   quality=quality, subsampling=2))
    for subsampling in (0, 1, 2):
        for width, height in SIZES:
            out.append(pillow_case(f'rgb-s{subsampling}-{width}x{height}', 'RGB', width, height,
                                   quality=75, subsampling=subsampling))
    for subsampling in (0, 2):
        for width, height in ((15, 17), (40, 24), (65, 41)):
            out.append(pillow_case(f'rgb-progressive-s{subsampling}-{width}x{height}', 'RGB', width, height,
                                   quality=75, subsampling=subsampling, progressive=True))
    for blocks in (1, 3, 10):
        out.append(pillow_case(f'rgb-restart{blocks}-65x41', 'RGB', 65, 41, quality=75, subsampling=2,
                               restart_marker_blocks=blocks))
    for orientation in range(1, 9):
        out.append(pillow_case(f'rgb-exif{orientation}-40x24', 'RGB', 40, 24, quality=75, subsampling=2,
                               orientation=orientation))
    out.append(pillow_case('rgb-exif6-s444-40x24', 'RGB', 40, 24, quality=75, subsampling=0, orientation=6))
    out.append(pillow_case('rgb-icc-40x24', 'RGB', 40, 24, quality=75, subsampling=2, icc=True))
    out.append(pillow_case('rgb-large-1000x1415', 'RGB', 1000, 1415, quality=75, subsampling=2))
    for subsampling in (0, 1, 2):
        for width, height in ((17, 17), (24, 40), (100, 81), (255, 3), (64, 64), (129, 65)):
            out.append(pillow_case(f'rgb-s{subsampling}-{width}x{height}', 'RGB', width, height,
                                   quality=75, subsampling=subsampling))
    for subsampling in (0, 2):
        for width, height in ((15, 17), (33, 1)):
            out.append(pillow_case(f'rgb-exif6-s{subsampling}-{width}x{height}', 'RGB', width, height,
                                   quality=75, subsampling=subsampling, orientation=6))

    # --- Pillow-encoded grayscale -------------------------------------------
    for quality in (1, 25, 75, 100):
        for width, height in ((15, 17), (33, 1)):
            out.append(pillow_case(f'gray-q{quality}-{width}x{height}', 'L', width, height, quality=quality))
    for width, height in ((1, 1), (8, 8), (40, 24), (65, 41)):
        out.append(pillow_case(f'gray-{width}x{height}', 'L', width, height, quality=75))
    for width, height in ((17, 17), (24, 40), (100, 81), (255, 3), (64, 64), (129, 65)):
        out.append(pillow_case(f'gray-{width}x{height}', 'L', width, height, quality=75))
    for quality in (5, 10, 50, 90, 95):
        out.append(pillow_case(f'gray-q{quality}-65x41', 'L', 65, 41, quality=quality))
    out.append(pillow_case('gray-progressive-40x24', 'L', 40, 24, quality=75, progressive=True))
    out.append(pillow_case('gray-exif6-15x17', 'L', 15, 17, quality=75, orientation=6))
    out.append(pillow_case('gray-exif3-33x1', 'L', 33, 1, quality=75, orientation=3))
    out.append(pillow_case('gray-restart2-65x41', 'L', 65, 41, quality=75, restart_marker_blocks=2))
    out.append(pillow_case('gray-exif6-40x24', 'L', 40, 24, quality=75, orientation=6))

    # --- Pillow-encoded CMYK -------------------------------------------------
    for width, height in ((15, 17), (16, 16), (33, 1), (40, 24), (65, 41)):
        out.append(pillow_case(f'cmyk-{width}x{height}', 'CMYK', width, height, quality=75))
    for quality in (1, 25, 50, 90, 100):
        out.append(pillow_case(f'cmyk-q{quality}-40x24', 'CMYK', 40, 24, quality=quality))
    out.append(pillow_case('cmyk-progressive-40x24', 'CMYK', 40, 24, quality=75, progressive=True))
    out.append(pillow_case('cmyk-restart2-65x41', 'CMYK', 65, 41, quality=75, restart_marker_blocks=2))
    for orientation in (1, 3, 6, 8):
        out.append(pillow_case(f'cmyk-exif{orientation}-40x24', 'CMYK', 40, 24, quality=75, orientation=orientation))
    out.append(pillow_case('cmyk-icc-40x24', 'CMYK', 40, 24, quality=75, icc=True))
    out.append(pillow_case('cmyk-large-1000x1415', 'CMYK', 1000, 1415, quality=75))
    for width, height in ((17, 17), (24, 40), (100, 81), (255, 3), (64, 64), (129, 65)):
        out.append(pillow_case(f'cmyk-{width}x{height}', 'CMYK', width, height, quality=75))
    for width, height in ((15, 17), (33, 1), (24, 40)):
        out.append(pillow_case(f'cmyk-exif6-{width}x{height}', 'CMYK', width, height, quality=75, orientation=6))

    # --- Block-encoded sampling layouts -------------------------------------
    layouts = {
        '444': (1, 1), '422': (2, 1), '420': (2, 2), '440': (1, 2), '411': (4, 1), '410': (4, 2),
        'chroma-hi': (1, 1),  # luma 1x1 with 2x1 chroma: chroma is the full-size component
    }
    for lname, (h, v) in layouts.items():
        for width, height in ((1, 1), (8, 8), (15, 17), (24, 40), (33, 1), (40, 24), (65, 41), (100, 81)):
            comps = ([
                {'h': h, 'v': v, 'table': 'luma', 'seed': 0},
                {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1},
                {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2},
            ] if lname != 'chroma-hi' else [
                {'h': 1, 'v': 1, 'table': 'luma', 'seed': 0},
                {'h': 2, 'v': 1, 'table': 'chroma', 'seed': 1},
                {'h': 2, 'v': 1, 'table': 'chroma', 'seed': 2},
            ])
            out.append(blocks_case(f'layout-{lname}-{width}x{height}', width, height, comps, quality=75))
    for quality in (1, 5, 10, 25, 50, 75, 90, 95, 100):
        for lname in ('444', '420'):
            h, v = layouts[lname]
            out.append(blocks_case(f'layout-q{quality}-{lname}-40x24', 40, 24, [
                {'h': h, 'v': v, 'table': 'luma', 'seed': 0},
                {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1},
                {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2},
            ], quality=quality))
    for width, height in ((15, 17), (40, 24)):
        out.append(blocks_case(f'layout-multiscan-420-{width}x{height}', width, height, [
            {'h': 2, 'v': 2, 'table': 'luma', 'seed': 0},
            {'h': 2, 'v': 2, 'table': 'chroma', 'seed': 1},
            {'h': 2, 'v': 2, 'table': 'chroma', 'seed': 2},
        ], quality=75, non_interleaved=True))
        for interval in (1, 3):
            out.append(blocks_case(f'layout-restart{interval}-420-{width}x{height}', width, height, [
                {'h': 2, 'v': 2, 'table': 'luma', 'seed': 0},
                {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1},
                {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2},
            ], quality=75, restart_interval=interval))
        out.append(blocks_case(f'layout-gray-{width}x{height}', width, height, [
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 0},
        ], quality=75))

    # --- Block-encoded colour spaces ---------------------------------------
    for width, height in ((15, 17), (40, 24), (65, 41)):
        out.append(blocks_case(f'cmyk-blocks-{width}x{height}', width, height, cmyk_components(),
                               quality=75, adobe_transform=0))
    out.append(blocks_case('cmyk-blocks-no-adobe-40x24', 40, 24, cmyk_components(), quality=75))
    for width, height in ((15, 17), (40, 24), (65, 41)):
        out.append(blocks_case(f'cmyk-subsampled-2x1-{width}x{height}', width, height,
                               cmyk_components(2, 1), quality=75, adobe_transform=0))
    for h, v in ((1, 1), (2, 1), (2, 2), (4, 1)):
        for width, height in ((15, 17), (40, 24), (65, 41)):
            out.append(blocks_case(f'ycck-{h}x{v}-{width}x{height}', width, height, ycck_components(h, v),
                                   quality=75, adobe_transform=2))
    for width, height in ((15, 17), (40, 24)):
        out.append(blocks_case(f'rgb-adobe-{width}x{height}', width, height, [
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 0},
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 1},
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 2},
        ], quality=75, adobe_transform=0, jfif=False))
        out.append(blocks_case(f'rgb-ids-{width}x{height}', width, height, [
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 0, 'id': 0x52},
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 1, 'id': 0x47},
            {'h': 1, 'v': 1, 'table': 'luma', 'seed': 2, 'id': 0x42},
        ], quality=75, jfif=False))
        out.append(blocks_case(f'ycbcr-nojfif-{width}x{height}', width, height, [
            {'h': 2, 'v': 2, 'table': 'luma', 'seed': 0},
            {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1},
            {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2},
        ], quality=75, jfif=False))

    # --- Files Pillow refuses to open (the oracle drops the image) ----------
    out.append(blocks_case('reject-12bit-40x24', 40, 24, cmyk_components(), quality=75,
                           adobe_transform=0, precision=12))
    out.append(blocks_case('reject-16bit-gray-40x24', 40, 24, [
        {'h': 1, 'v': 1, 'table': 'luma', 'seed': 0},
    ], quality=75, precision=16))
    # libjpeg's MAX_BLOCKS_IN_MCU: 4 components at 2x2 (16 blocks) cannot be decoded.
    out.append(blocks_case('reject-mcu-cmyk-2x2-40x24', 40, 24, cmyk_components(2, 2), quality=75,
                           adobe_transform=0))
    out.append(blocks_case('reject-mcu-3comp-4x4-40x24', 40, 24, [
        {'h': 4, 'v': 4, 'table': 'luma', 'seed': 0},
        {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 1},
        {'h': 1, 'v': 1, 'table': 'chroma', 'seed': 2},
    ], quality=75))
    out.append(blocks_case('reject-2-component-40x24', 40, 24, [
        {'h': 1, 'v': 1, 'table': 'luma', 'seed': 0},
        {'h': 1, 'v': 1, 'table': 'luma', 'seed': 1},
    ], quality=75))

    # --- Truncated streams ---------------------------------------------------
    # Upstream only notices the corruption when it must re-save (EXIF/quality); a plain
    # truncated JPEG is embedded unchanged, so those cases check decode+embed behavior.
    for name, mode, width, height, kwargs in (
            ('truncated-rgb-65x41', 'RGB', 65, 41, {'subsampling': 2}),
            ('truncated-gray-40x24', 'L', 40, 24, {}),
            ('truncated-cmyk-40x24', 'CMYK', 40, 24, {})):
        case = pillow_case(name, mode, width, height, quality=75, **kwargs)
        case['truncate'] = 0.6
        out.append(case)
    for name, mode, width, height, kwargs in (
            ('truncated-rgb-exif6-40x24', 'RGB', 40, 24, {'subsampling': 2, 'orientation': 6}),
            ('truncated-cmyk-exif1-40x24', 'CMYK', 40, 24, {'orientation': 1})):
        case = pillow_case(name, mode, width, height, quality=75, **kwargs)
        case['truncate'] = 0.6
        out.append(case)
    for name, mode, width, height, kwargs in (
            ('nomarker-rgb-65x41', 'RGB', 65, 41, {'subsampling': 2}),
            ('nomarker-gray-40x24', 'L', 40, 24, {})):
        case = pillow_case(name, mode, width, height, quality=75, **kwargs)
        case['truncate_tail'] = 2
        out.append(case)
    return out


# --------------------------------------------------------------------------
# Oracle (runs in the pinned image)
# --------------------------------------------------------------------------

def case_bytes(case):
    """The JPEG bytes for one case (Pillow or the block writer), before truncation."""
    if case['kind'] == 'pillow':
        from PIL import Image, ImageCms
        save = dict(case['save'])
        orientation = save.pop('orientation', None)
        with_icc = save.pop('icc', False)
        image = Image.frombytes(case['mode'], (case['width'], case['height']),
                                source_bytes(case['mode'], case['width'], case['height']))
        if orientation:
            exif = Image.Exif()
            exif[274] = orientation
            save['exif'] = exif.tobytes()
        if with_icc:
            save['icc_profile'] = ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
        buf = io.BytesIO()
        image.save(buf, format='JPEG', **save)
        return buf.getvalue()
    return encode_blocks(case['width'], case['height'], case['components'], **case['options'])


def run_oracle(outdir):
    from PIL import Image, ImageOps

    os.makedirs(outdir, exist_ok=True)
    manifest = []
    for case in cases():
        name = case['name']
        path = os.path.join(outdir, name + '.jpg')
        data = case_bytes(case)
        if case.get('truncate'):
            data = data[:int(len(data) * case['truncate'])]
        if case.get('truncate_tail'):
            data = data[:-case['truncate_tail']]
        with open(path, 'wb') as handle:
            handle.write(data)

        entry = {
            'name': name, 'file': os.path.basename(path), 'width': case['width'], 'height': case['height'],
            'resave': False,
        }
        try:
            image = Image.open(io.BytesIO(data))
        except Exception as error:  # noqa: BLE001 - the oracle's failure is the expected result
            # Pillow rejects the file at open: weasyprint never draws it.
            entry['error'] = f'open: {type(error).__name__}: {error}'
            entry['drop'] = True
            manifest.append(entry)
            continue
        try:
            image.load()
            decoded = image.tobytes()
            width, height = image.size
            mode = image.mode
        except Exception as error:  # noqa: BLE001
            # The header is fine but the data is not (truncation). Upstream drops the image only
            # when its re-save path touches the pixels (EXIF or an explicit jpeg_quality).
            entry['error'] = f'load: {type(error).__name__}: {error}'
            entry['drop'] = 'exif' in image.info
            manifest.append(entry)
            continue

        channels = {'L': 1, 'RGB': 3, 'CMYK': 4}[mode]
        entry.update(width=width, height=height, mode=mode, channels=channels)
        decoded_name = name + '.decoded.raw'
        with open(os.path.join(outdir, decoded_name), 'wb') as handle:
            handle.write(decoded)
        entry['decoded'] = decoded_name

        # Upstream re-saves when Pillow's image carries EXIF or a jpeg_quality option is set
        # (images.py RasterImage.__init__): exif_transpose() then save(format='JPEG', quality=...).
        resave = bool(case.get('kind') == 'pillow' and ('exif' in case['save'] or 'orientation' in case['save']))
        entry['resave'] = resave
        if resave:
            buf = io.BytesIO()
            ImageOps.exif_transpose(image).save(buf, format='JPEG', quality=75)
            resaved_name = name + '.resaved.jpg'
            with open(os.path.join(outdir, resaved_name), 'wb') as handle:
                handle.write(buf.getvalue())
            entry['resaved'] = resaved_name
        manifest.append(entry)

    with open(os.path.join(outdir, 'manifest.json'), 'w') as handle:
        json.dump(manifest, handle, indent=1)
    print(f'oracle: {len(manifest)} cases in {outdir}')


# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IMAGE = 'weasy-alpine-prod:latest'


def run_checks(outdir, pattern):
    script = os.path.join(REPO, 'tools', 'jpeg_codec.ts')
    cmd = ['node', script, outdir]
    if pattern:
        cmd.append(pattern)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode not in (0, 1):
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(f'jpeg_codec.ts failed with {result.returncode}')
    report = json.loads(result.stdout)
    failures = [case for case in report if case['status'] != 'pass']
    print(f'{len(report) - len(failures)}/{len(report)} cases match the oracle')
    for case in failures:
        print(f'  FAIL {case["name"]}: {case["detail"]}')
    return not failures


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--oracle', help='in-container mode: generate the corpus and Pillow outputs into this dir')
    ap.add_argument('--dir', default=None, help='corpus/output directory (default: a fresh temp dir)')
    ap.add_argument('--keep', nargs='?', const='', default=None,
                    help='keep the corpus (optionally in the given directory)')
    ap.add_argument('--filter', default=None, help='only cases whose name contains this string')
    args = ap.parse_args()

    if args.oracle:
        run_oracle(args.oracle)
        return 0

    if args.keep is not None:
        outdir = args.keep or os.path.join(tempfile.gettempdir(), 'jpeg-parity')
        os.makedirs(outdir, exist_ok=True)
        keep = True
    else:
        outdir = args.dir or tempfile.mkdtemp(prefix='jpeg-parity-')
        keep = False

    cmd = ['docker', 'run', '--rm', '--user', f'{os.getuid()}:{os.getgid()}',
           '-v', f'{os.path.join(REPO, "parity")}:/p:ro', '-v', f'{outdir}:/out', IMAGE,
           '/venv/bin/python', '/p/jpeg_parity.py', '--oracle', '/out']
    subprocess.run(cmd, check=True)
    ok = run_checks(outdir, args.filter)
    if not keep:
        import shutil
        shutil.rmtree(outdir, ignore_errors=True)
    else:
        print(f'corpus kept in {outdir}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
