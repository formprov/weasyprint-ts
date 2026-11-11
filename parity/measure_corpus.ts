// Measure per-doc differing-pixel counts for the parity corpus (no allowlist).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decode as decodePng } from 'fast-png';

import { HTML, decodeHtml } from '../src/html_document.ts';
import { renderDocument } from '../src/document.ts';
import { createFontConfiguration } from '../src/cli/node_fonts.ts';
import { NodeFetcher } from '../src/cli/node_fetcher.ts';
import type { FontProfile } from '../src/text/font_config.ts';

const ROOT = new URL('..', import.meta.url).pathname;
const CORPUS = join(ROOT, 'test', 'corpus');
const EXPECTED = join(ROOT, 'test', 'expected');
const FONTS = join(ROOT, 'test', 'fonts');
const PROFILE = JSON.parse(readFileSync(join(ROOT, 'profiles', 'alpine_prod.json'), 'utf8')) as FontProfile;

function rasterize(pdfPath: string, workDir: string): Uint8Array[] {
  mkdirSync(workDir, { recursive: true });
  execFileSync('gs', [
    '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r96',
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
    `-sOutputFile=${join(workDir, 'page-%d.png')}`, pdfPath,
  ], { stdio: 'pipe' });
  return readdirSync(workDir).filter((f) => f.endsWith('.png')).sort().map(
    (f) => new Uint8Array(readFileSync(join(workDir, f))),
  );
}

function differingPixels(a: Uint8Array, b: Uint8Array): { n: number; strong: number; bbox: [number, number, number, number] | null } {
  const pa = decodePng(a);
  const pb = decodePng(b);
  let n = 0, strong = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const w = pa.width;
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(
      Math.abs(pa.data[i] - pb.data[i]),
      Math.abs(pa.data[i + 1] - pb.data[i + 1]),
      Math.abs(pa.data[i + 2] - pb.data[i + 2]),
    );
    if (d > 0) {
      n++;
      if (d >= 64) strong++;
      const p = i / 4;
      const x = p % w, y = Math.floor(p / w);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { n, strong, bbox: n ? [x0, y0, x1, y1] : null };
}

const work = mkdtempSync(join(tmpdir(), 'xcr-measure-'));
const docs = readdirSync(CORPUS).filter((f) => f.endsWith('.html')).sort();
for (const doc of docs) {
  const fetcher = new NodeFetcher();
  const fontConfig = createFontConfiguration([FONTS], PROFILE);
  const url = new URL(`test/corpus/${doc}`, new URL('file:///', import.meta.url).href);
  const html = new HTML(decodeHtml(readFileSync(join(CORPUS, doc))), { baseUrl: url.href, fetcher });
  const document = await renderDocument(html, { fontConfig });
  const actualPdf = join(work, doc + '.pdf');
  writeFileSync(actualPdf, document.writePdf());
  const expected = rasterize(join(EXPECTED, doc.replace(/\.html$/, '.pdf')), join(work, 'exp' + doc));
  const actual = rasterize(actualPdf, join(work, 'act' + doc));
  let total = 0, strong = 0;
  const boxes: string[] = [];
  for (let p = 0; p < Math.max(expected.length, actual.length); p++) {
    const r = differingPixels(expected[p], actual[p]);
    total += r.n; strong += r.strong;
    if (r.n) boxes.push(`p${p + 1}: ${r.n}px (${r.strong} strong) bbox ${r.bbox}`);
  }
  console.log(doc.padEnd(28), `total ${String(total).padStart(5)} px, strong ${strong}`, boxes.join('; '));
}
