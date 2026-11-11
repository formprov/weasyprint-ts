// SPDX-License-Identifier: BSD-3-Clause

/**
 * JPEG codec parity with the oracle's Pillow (fixtures from parity/gen_jpeg_fixtures.py, generated in the pinned
 * image): (a) the port decodes Pillow's JPEG to Pillow's RGB, (b) the port encodes Pillow's source RGB to the same
 * bytes Pillow writes at quality 75 (the re-save rule upstream applies to EXIF JPEGs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeJpegLibjpeg } from '../src/jpeg/decode.ts';
import { encodeJpegGrayscale, encodeJpegLibjpeg } from '../src/jpeg/encode.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jpeg');
const CASES = ['baseline-420-17x33', 'progressive-420-40x24', 'baseline-edge-65x41'];
const GRAY_CASE = 'gray-baseline-37x23';

for (const name of CASES) {
  const read = (suffix: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, `${name}.${suffix}`)));
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as { width: number; height: number };

  test(`jpeg decode matches Pillow: ${name}`, () => {
    const result = decodeJpegLibjpeg(read('jpg'));
    assert.equal(result.width, meta.width);
    assert.equal(result.height, meta.height);
    assert.deepEqual(result.data, read('decoded.rgb'));
  });

  test(`jpeg re-save matches Pillow quality 75: ${name}`, () => {
    // Upstream re-saves the decoded image, so the input is Pillow's decode of the file.
    const bytes = encodeJpegLibjpeg(read('decoded.rgb'), meta.width, meta.height, 75);
    assert.deepEqual(bytes, read('reencoded.jpg'));
  });
}

test(`grayscale jpeg decode matches Pillow: ${GRAY_CASE}`, () => {
  const read = (suffix: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, `${GRAY_CASE}.${suffix}`)));
  const result = decodeJpegLibjpeg(read('jpg'));
  assert.equal(result.channels, 1);
  assert.deepEqual(result.data, read('decoded.rgb'));
});

test(`grayscale jpeg re-save matches Pillow quality 75: ${GRAY_CASE}`, () => {
  const read = (suffix: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, `${GRAY_CASE}.${suffix}`)));
  const bytes = encodeJpegGrayscale(read('decoded.rgb'), 37, 23, 75);
  assert.deepEqual(bytes, read('reencoded.jpg'));
});
