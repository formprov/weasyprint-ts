"""Generate the JPEG codec fixtures with the oracle's Pillow (run inside weasy-alpine-prod).

For each case: a deterministic RGB source (raw bytes), the Pillow JPEG encoding at quality 75 (baseline and
progressive), and Pillow's decode of that JPEG (raw RGB). test/jpeg.test.ts checks the port against them.

  docker run --rm -v "$PWD/parity:/p:ro" -v "$PWD/test/fixtures/jpeg:/out" weasy-alpine-prod:latest \
      /venv/bin/python /p/gen_jpeg_fixtures.py
"""
import io
import json
import math

from PIL import Image

CASES = [
    # name, width, height, progressive
    ('baseline-420-17x33', 17, 33, False),
    ('progressive-420-40x24', 40, 24, True),
    ('baseline-edge-65x41', 65, 41, False),
]


def source(width, height):
    data = bytearray()
    for y in range(height):
        for x in range(width):
            data += bytes((
                (x * 255 // max(width - 1, 1)) & 255,
                (y * 255 // max(height - 1, 1)) & 255,
                (int(127 + 127 * math.sin((x + y) / 7.0))) & 255,
            ))
    return bytes(data)


for name, width, height, progressive in CASES:
    raw = source(width, height)
    img = Image.frombytes('RGB', (width, height), raw)
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=75, progressive=progressive)
    jpeg = buf.getvalue()
    decoded = Image.open(io.BytesIO(jpeg)).convert('RGB').tobytes()
# Upstream re-saves a decoded JPEG as Pillow's default (baseline) JPEG at the requested quality:
    # pillow_image.save(format='JPEG', optimize=..., quality=jpeg_quality), see images.py RasterImage.__init__.
    re_encoded = io.BytesIO()
    Image.open(io.BytesIO(jpeg)).convert('RGB').save(re_encoded, format='JPEG', quality=75)
    base = f'/out/{name}'
    open(base + '.source.rgb', 'wb').write(raw)
    open(base + '.jpg', 'wb').write(jpeg)
    open(base + '.decoded.rgb', 'wb').write(decoded)
    open(base + '.reencoded.jpg', 'wb').write(re_encoded.getvalue())
    json.dump({'width': width, 'height': height, 'progressive': progressive}, open(base + '.json', 'w'))
    print(name, len(jpeg), 'bytes')

# Grayscale: Pillow's 'L' JPEG at quality 75 (upstream re-saves gray EXIF images this way).
gray_w, gray_h = 37, 23
gray_raw = bytes((x * 7 + y * 11) & 255 for y in range(gray_h) for x in range(gray_w))
gray_img = Image.frombytes('L', (gray_w, gray_h), gray_raw)
buf = io.BytesIO()
gray_img.save(buf, format='JPEG', quality=75)
gray_jpeg = buf.getvalue()
gray_decoded = Image.open(io.BytesIO(gray_jpeg)).convert('L').tobytes()
gray_resaved = io.BytesIO()
Image.open(io.BytesIO(gray_jpeg)).convert('L').save(gray_resaved, format='JPEG', quality=75)
base = '/out/gray-baseline-37x23'
open(base + '.source.rgb', 'wb').write(gray_raw)
open(base + '.jpg', 'wb').write(gray_jpeg)
open(base + '.decoded.rgb', 'wb').write(gray_decoded)
open(base + '.reencoded.jpg', 'wb').write(gray_resaved.getvalue())
json.dump({'width': gray_w, 'height': gray_h, 'progressive': False, 'channels': 1}, open(base + '.json', 'w'))
print('gray-baseline-37x23', len(gray_jpeg), 'bytes')
