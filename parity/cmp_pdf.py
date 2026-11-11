# SPDX-License-Identifier: BSD-3-Clause

"""Rasterize two PDFs with Ghostscript and report pixel differences: cmp_pdf.py a.pdf b.pdf [dpi]"""
import subprocess, sys, tempfile, os
from PIL import Image, ImageChops

a, b = sys.argv[1], sys.argv[2]
dpi = sys.argv[3] if len(sys.argv) > 3 else '96'
tmp = tempfile.mkdtemp()
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
        out = f'/tmp/diff-{i}.png'
        Image.eval(gray, lambda v: 255 if v else 0).save(out)
        print('  diff mask', out)