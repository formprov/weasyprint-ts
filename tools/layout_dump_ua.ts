// SPDX-License-Identifier: BSD-3-Clause

/**
 * Like layout_dump.ts, but matched to the upstream parity harness: the second argument REPLACES the user-agent
 * stylesheet (pass tests_ua.css, as upstream_diff.py does), and each box also records its text.
 * Run from parity/upstream-cases:  FONT_DIR=~/.cache/weasy-parity/oracle-fonts node ../../tools/layout_dump_ua.ts CASE.html tests_ua.css > port.json
 * Compare with parity/dump_layout_fake.py (oracle) using parity/cmp_layout.py.
 */
import '../src/document.ts'; // load order: importing css first throws 'layoutHooks before initialization'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { TargetCollector } from '../src/css/targets.ts';
import { buildFormattingStructure } from '../src/formatting_structure/build.ts';
import { HTML, decodeHtml, getAllComputedStyles } from '../src/html_document.ts';
import { LayoutContext, layoutDocument } from '../src/layout/index.ts';
import { NodeFetcher } from '../src/cli/node_fetcher.ts';
import { createFontConfiguration, defaultFontDirs } from '../src/cli/node_fonts.ts';
import { ImageLoader } from '../src/images.ts';
import '../src/text/line_break.ts';

const [file, uaFile] = process.argv.slice(2);
const fetcher = new NodeFetcher();
const path = resolve(file);
const profile = JSON.parse(readFileSync(new URL('../profiles/alpine_prod.json', import.meta.url), 'utf8'));
const fontDir = process.env.FONT_DIR ?? defaultFontDirs()[0];
const fontConfig = createFontConfiguration([fontDir], profile);

const html = new HTML(decodeHtml(readFileSync(path)), { baseUrl: pathToFileURL(path).href, fetcher });
const styleFor = await getAllComputedStyles(html, {
  fontConfig, userAgentCss: readFileSync(uaFile, 'utf8'), userAgentBaseUrl: pathToFileURL(resolve(uaFile)).href,
});
const loader = new ImageLoader();
let pages: any[] = [];
for (;;) {
  const targetCollector = new TargetCollector();
  const footnotes: any[] = [];
  const rootBox = buildFormattingStructure(
    html.root, (el, pseudo = null) => (styleFor.has(el, pseudo) ? styleFor.get(el, pseudo) : null), loader.getImageFromUri, html.baseUrl,
    targetCollector, html.counterStyle, footnotes);
  const context = new LayoutContext(styleFor, loader.getImageFromUri, fontConfig, html.counterStyle, targetCollector);
  context.footnotes = footnotes;
  pages = layoutDocument(html, rootBox, context);
  if (!loader.missing.size) break;
  for (const url of loader.missing) loader.sources.set(url, await fetcher.fetch(url).catch(() => null));
  loader.missing.clear();
}

const boxesOut: any[] = [];
const walk = (box: any, page: number): void => {
  boxesOut.push({
    type: box.constructor.name, tag: box.elementTag, page, x: box.positionX, y: box.positionY, width: box.width, height: box.height,
    text: box.text ?? null,
  });
  for (const child of box.children ?? []) if (child && typeof child === 'object' && 'positionX' in child) walk(child, page);
};
pages.forEach((p, i) => walk(p, i));
console.log(JSON.stringify({ pages: pages.length, boxes: boxesOut }));