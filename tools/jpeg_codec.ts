// SPDX-License-Identifier: BSD-3-Clause
/**
 * Port side of the JPEG codec parity harness (see parity/jpeg_parity.py).
 *
 * Reads the corpus manifest written by the oracle (Pillow in weasy-alpine-prod),
 * decodes every JPEG with src/jpeg, re-saves the ones upstream would re-save
 * through the real RasterImage path, and prints a JSON report the Python driver
 * aggregates.
 *
 *   node tools/jpeg_codec.ts CORPUS_DIR [NAME_FILTER]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeJpegLibjpeg } from '../src/jpeg/decode.ts';
import { RasterImage } from '../src/images.ts';

interface Case {
  name: string;
  file: string;
  width: number;
  height: number;
  mode?: string;
  channels?: number;
  decoded?: string;
  resave: boolean;
  resaved?: string;
  error?: string;
  drop?: boolean;
}

interface Result { name: string; status: 'pass' | 'fail'; detail?: string }

function firstDiff(actual: Uint8Array, expected: Uint8Array): string {
  if (actual.length !== expected.length) return `length ${actual.length} != ${expected.length}`;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      const from = Math.max(0, i - 4);
      const fmt = (a: Uint8Array): string => Array.from(a.subarray(from, i + 5)).join(',');
      return `first differing byte at ${i}: port [${fmt(actual)}] oracle [${fmt(expected)}]`;
    }
  }
  return 'no difference';
}

const dir = process.argv[2];
const filter = process.argv[3] ?? '';
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Case[];
const report: Result[] = [];

for (const testCase of manifest) {
  if (filter && !testCase.name.includes(filter)) continue;
  const data = new Uint8Array(readFileSync(join(dir, testCase.file)));

  if (testCase.error) {
    if (testCase.drop) {
      // Upstream's load or re-save raised: weasyprint logs "Failed to load image" and drops it.
      try {
        new RasterImage(testCase.name, data, 'image/jpeg', 75, false, null, 'from-image');
        report.push({ name: testCase.name, status: 'fail', detail: `oracle rejected it (${testCase.error}) but the port loaded it` });
      } catch {
        report.push({ name: testCase.name, status: 'pass' });
      }
      continue;
    }
    // Upstream embeds the original bytes without touching the pixels, but a decoder must not
    // pretend a truncated stream is valid.
    let threw = false;
    try {
      decodeJpegLibjpeg(data);
    } catch {
      threw = true;
    }
    const image = new RasterImage(testCase.name, data, 'image/jpeg', null, false, null, 'from-image');
    if (!threw) {
      report.push({ name: testCase.name, status: 'fail', detail: `oracle rejected it (${testCase.error}) but the port decoded it` });
    } else if (image.imageData !== data) {
      report.push({ name: testCase.name, status: 'fail', detail: 'the original bytes must be embedded unchanged' });
    } else {
      report.push({ name: testCase.name, status: 'pass' });
    }
    continue;
  }

  let decoded;
  try {
    decoded = decodeJpegLibjpeg(data);
  } catch (error) {
    report.push({ name: testCase.name, status: 'fail', detail: `decode threw: ${(error as Error).message}` });
    continue;
  }
  const channels = decoded.channels ?? 3;
  if (decoded.width !== testCase.width || decoded.height !== testCase.height) {
    report.push({ name: testCase.name, status: 'fail', detail: `size ${decoded.width}x${decoded.height} != ${testCase.width}x${testCase.height}` });
    continue;
  }
  if (channels !== testCase.channels) {
    report.push({ name: testCase.name, status: 'fail', detail: `${channels} channels != oracle's ${testCase.channels} (${testCase.mode})` });
    continue;
  }
  const detail = firstDiff(decoded.data, new Uint8Array(readFileSync(join(dir, testCase.decoded!))));
  if (detail !== 'no difference') {
    report.push({ name: testCase.name, status: 'fail', detail: `decoded pixels: ${detail}` });
    continue;
  }

  if (testCase.resave) {
    let resaved;
    try {
      // The production path: upstream drops the original bytes for an EXIF/quality JPEG and
      // saves Pillow's transposed image once (images.py RasterImage.__init__).
      resaved = new RasterImage(testCase.name, data, 'image/jpeg', 75, false, null, 'from-image').imageData;
    } catch (error) {
      report.push({ name: testCase.name, status: 'fail', detail: `re-save threw: ${(error as Error).message}` });
      continue;
    }
    const diff = firstDiff(resaved, new Uint8Array(readFileSync(join(dir, testCase.resaved!))));
    if (diff !== 'no difference') {
      report.push({ name: testCase.name, status: 'fail', detail: `re-saved bytes: ${diff}` });
      continue;
    }
  }
  report.push({ name: testCase.name, status: 'pass' });
}

console.log(JSON.stringify(report));
