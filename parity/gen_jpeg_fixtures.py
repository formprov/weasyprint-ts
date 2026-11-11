"""Generate the committed JPEG codec fixtures from the parity corpus.

Reuses the deterministic corpus and the oracle in ``parity/jpeg_parity.py``
(Pillow inside the pinned ``weasy-alpine-prod`` image, the exact library the
Python WeasyPrint uses). For every case we write:

* ``<name>.jpg``          - the input file
* ``<name>.raw``          - Pillow's decoded samples (mode L / RGB / CMYK)
* ``<name>.resaved.jpg``  - Pillow's re-save when upstream would re-save it
* ``fixtures.json``       - the manifest ``test/jpeg.test.ts`` iterates

The two 1000x1415 cases (multi-megabyte raw pixels) stay in the development
harness: they do not cover a layout the smaller cases miss.

  cd weasyprint-ts
  docker run --rm -v "$PWD/parity:/p:ro" -v "$PWD/test/fixtures/jpeg:/out" \\
      weasy-alpine-prod:latest /venv/bin/python /p/gen_jpeg_fixtures.py
"""
import io
import json
import os

from jpeg_parity import case_bytes, cases

OUT = '/out'
SKIP = ('large',)


def main():
    from PIL import Image, ImageOps

    os.makedirs(OUT, exist_ok=True)
    manifest = []
    for case in cases():
        name = case['name']
        if any(part in name for part in SKIP):
            continue
        data = case_bytes(case)
        if case.get('truncate'):
            data = data[:int(len(data) * case['truncate'])]
        if case.get('truncate_tail'):
            data = data[:-case['truncate_tail']]
        with open(os.path.join(OUT, name + '.jpg'), 'wb') as handle:
            handle.write(data)

        entry = {'name': name, 'file': name + '.jpg', 'resave': False}
        try:
            image = Image.open(io.BytesIO(data))
        except Exception as error:  # noqa: BLE001 - Pillow's rejection is the expected result
            entry.update(error=f'open: {type(error).__name__}: {error}', drop=True)
            manifest.append(entry)
            continue
        try:
            image.load()
            pixels = image.tobytes()
        except Exception as error:  # noqa: BLE001
            # Header parses but the stream is broken (truncation). Upstream only touches the
            # pixels when re-saving, so it drops the image just for the EXIF/quality cases.
            entry.update(error=f'load: {type(error).__name__}: {error}',
                         drop='exif' in image.info)
            manifest.append(entry)
            continue

        entry.update(width=image.width, height=image.height, mode=image.mode,
                     channels={'L': 1, 'RGB': 3, 'CMYK': 4}[image.mode])
        entry['decoded'] = name + '.raw'
        with open(os.path.join(OUT, entry['decoded']), 'wb') as handle:
            handle.write(pixels)
        if case['kind'] == 'pillow' and ('exif' in case['save'] or 'orientation' in case['save']):
            entry['resave'] = True
            buf = io.BytesIO()
            ImageOps.exif_transpose(image).save(buf, format='JPEG', quality=75)
            entry['resaved'] = name + '.resaved.jpg'
            with open(os.path.join(OUT, entry['resaved']), 'wb') as handle:
                handle.write(buf.getvalue())
        manifest.append(entry)

    with open(os.path.join(OUT, 'fixtures.json'), 'w') as handle:
        json.dump(manifest, handle, indent=1)
    print(f'{len(manifest)} fixtures in {OUT}')


if __name__ == '__main__':
    main()
