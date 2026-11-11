# SPDX-License-Identifier: BSD-3-Clause

"""Rasterize two PDFs with Ghostscript and report pixel differences: cmp_pdf.py a.pdf b.pdf [dpi]"""
import math
import os
import subprocess
import sys
import tempfile
from PIL import Image, ImageChops

# Pages may be absurdly large (upstream's floating-point-error tests use
# @page size: 100000pt 100000px). Rasterizing those at 96 dpi would need tens of
# billions of pixels, so cap the raster area and lower the dpi for such pages.
MAX_PIXELS = 40_000_000
Image.MAX_IMAGE_PIXELS = None

a, b = sys.argv[1], sys.argv[2]
dpi = float(sys.argv[3]) if len(sys.argv) > 3 else 96.0
tmp = tempfile.mkdtemp()


def page_areas_in2(pdf):
    """Page areas in square inches, from each page's MediaBox (no rasterization)."""
    script = (f'({pdf}) (r) file runpdfbegin 1 1 pdfpagecount '
              '{ pdfgetpage /MediaBox get == } for quit')
    result = subprocess.run(
        ['gs', '-q', '-dNODISPLAY', '-dNOSAFER', '-c', script],
        capture_output=True, text=True, check=False)
    areas = []
    for line in result.stdout.splitlines():
        parts = line.strip().strip('[]').split()
        if len(parts) != 4:
            continue
        try:
            values = [float(v) for v in parts]
        except ValueError:
            continue
        areas.append(abs(values[2] - values[0]) / 72 * abs(values[3] - values[1]) / 72)
    return areas


areas = page_areas_in2(a) or page_areas_in2(b)
if areas:
    largest = max(areas)
    if largest > 0 and largest * dpi * dpi > MAX_PIXELS:
        dpi = max(1.0, math.floor(math.sqrt(MAX_PIXELS / largest) * 10) / 10)
        print(f'large page: rasterizing at {dpi} dpi')


def raster(pdf, tag):
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', f'-r{dpi}', '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                    f'-sOutputFile={tmp}/{tag}-%d.png', pdf], check=True)
    return sorted(f for f in os.listdir(tmp) if f.startswith(tag + '-'))


fa, fb = raster(a, 'a'), raster(b, 'b')
print('pages', len(fa), len(fb))
for i, (x, y) in enumerate(zip(fa, fb), 1):
    ia, ib = Image.open(f'{tmp}/{x}').convert('RGB'), Image.open(f'{tmp}/{y}').convert('RGB')
    if ia.size != ib.size:
        print(f'page {i}: size differs {ia.size} {ib.size}'); continue
    diff = ImageChops.difference(ia, ib)
    bbox = diff.getbbox()
    gray = diff.convert('L')
    hist = gray.histogram()
    total = ia.size[0] * ia.size[1]
    nz = total - hist[0]
    big = sum(hist[64:])
    print(f'page {i}: differing pixels {nz} ({100*nz/total:.3f}%), strongly differing (>=64) {big}, bbox {bbox}')
    if bbox:
        out = os.path.join(tmp, f'diff-{i}.png')
        Image.eval(gray, lambda v: 255 if v else 0).save(out)
        print('  diff mask', out)
