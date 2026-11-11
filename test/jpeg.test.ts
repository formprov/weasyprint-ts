// SPDX-License-Identifier: BSD-3-Clause

/**
 * JPEG codec parity with the oracle's Pillow.
 *
 * Fixtures come from parity/gen_jpeg_fixtures.py, which runs the corpus in
 * parity/jpeg_parity.py inside the pinned oracle image. For every case we check
 * the port against Pillow:
 *
 *  - decode: samples, size and mode (L / RGB / CMYK) must match Pillow's;
 *  - re-save: when upstream re-saves the image (EXIF orientation, or an explicit
 *    jpeg_quality) the embedded bytes must match Pillow's, byte for byte;
 *  - embed: otherwise the original bytes are embedded unchanged;
 *  - rejection: files Pillow refuses are dropped like weasyprint does, and
 *    truncated files (embedded as-is by upstream, since it never decodes them)
 *    must still make our decoder throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeJpegLibjpeg } from '../src/jpeg/decode.ts';
import { ImageLoadingError, RasterImage } from '../src/images.ts';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jpeg');

interface Fixture {
  name: string;
  file: string;
  width?: number;
  height?: number;
  mode?: string;
  channels?: number;
  decoded?: string;
  resave: boolean;
  resaved?: string;
  error?: string;
  drop?: boolean;
}

const read = (file: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, file)));
const fixtures = JSON.parse(readFileSync(join(FIXTURES, 'fixtures.json'), 'utf8')) as Fixture[];

/** Compare two byte strings, reporting the first difference with context. */
function diff(actual: Uint8Array, expected: Uint8Array): string {
  if (actual.length !== expected.length) return `length ${actual.length} != ${expected.length}`;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      const fmt = (a: Uint8Array): string => Array.from(a.subarray(i, i + 4)).join(',');
      return `byte ${i}: port [${fmt(actual)}] Pillow [${fmt(expected)}]`;
    }
  }
  return 'no difference';
}

const decodable = fixtures.filter((fixture) => fixture.decoded);
const rejected = fixtures.filter((fixture) => fixture.drop);
const keptVerbatim = fixtures.filter((fixture) => fixture.error && !fixture.drop);

test('corpus covers the codec matrix', () => {
  assert.ok(fixtures.length >= 200, `${fixtures.length} fixtures`);
  const modes = new Set(decodable.map((fixture) => fixture.mode));
  assert.deepEqual([...modes].sort(), ['CMYK', 'L', 'RGB']);
  assert.ok(decodable.some((fixture) => fixture.resave), 'EXIF re-saves');
  assert.ok(rejected.length > 0, 'Pillow-rejected files');
});

test('decoder matches Pillow on every corpus layout', () => {
  for (const fixture of decodable) {
    const decoded = decodeJpegLibjpeg(read(fixture.file));
    assert.equal(`${decoded.width}x${decoded.height}`, `${fixture.width}x${fixture.height}`, fixture.name);
    assert.equal(decoded.channels ?? 3, fixture.channels, `${fixture.name} (${fixture.mode})`);
    assert.equal(diff(decoded.data, read(fixture.decoded!)), 'no difference', fixture.name);
  }
});

test('re-save matches Pillow byte for byte', () => {
  const resaves = decodable.filter((fixture) => fixture.resave);
  assert.ok(resaves.length > 0);
  for (const fixture of resaves) {
    // The production path: an EXIF JPEG is decoded, transposed and saved once at quality 75.
    const image = new RasterImage(fixture.name, read(fixture.file), 'image/jpeg', 75, false, null, 'from-image');
    assert.equal(diff(image.imageData, read(fixture.resaved!)), 'no difference', fixture.name);
  }
});

test('images upstream does not re-save keep their original bytes', () => {
  for (const fixture of decodable.filter((f) => !f.resave)) {
    const data = read(fixture.file);
    const image = new RasterImage(fixture.name, data, 'image/jpeg', null, false, null, 'from-image');
    assert.equal(diff(image.imageData, data), 'no difference', fixture.name);
  }
});

test('files Pillow rejects are dropped like weasyprint does', () => {
  assert.ok(rejected.length > 0);
  for (const fixture of rejected) {
    assert.throws(() => new RasterImage(fixture.name, read(fixture.file), 'image/jpeg', 75, false, null, 'from-image'),
      ImageLoadingError, `${fixture.name}: ${fixture.error}`);
  }
});

test('truncated streams that upstream embeds verbatim still fail to decode', () => {
  assert.ok(keptVerbatim.length > 0);
  for (const fixture of keptVerbatim) {
    const data = read(fixture.file);
    assert.throws(() => decodeJpegLibjpeg(data), `${fixture.name}: ${fixture.error}`);
    // Upstream never decodes it, so the original bytes reach the PDF unchanged.
    const image = new RasterImage(fixture.name, data, 'image/jpeg', null, false, null, 'from-image');
    assert.equal(diff(image.imageData, data), 'no difference', fixture.name);
  }
});
