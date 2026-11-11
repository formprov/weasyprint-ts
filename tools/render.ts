// SPDX-License-Identifier: BSD-3-Clause

/** Render HTML to PDF: node tools/render.ts [-s style.css] in.html out.pdf */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CSS } from '../src/css/index.ts';
import { HTML, decodeHtml } from '../src/html_document.ts';
import { renderDocument } from '../src/document.ts';
import { NodeFetcher } from '../src/cli/node_fetcher.ts';
import { createFontConfiguration, defaultFontDirs } from '../src/cli/node_fonts.ts';
import '../src/text/line_break.ts';

const args = process.argv.slice(2);
const styles: string[] = [];
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-s') styles.push(args[++i]);
  else positional.push(args[i]);
}
const [input, output] = positional;
const fetcher = new NodeFetcher();
const profile = JSON.parse(readFileSync(new URL('../profiles/alpine_prod.json', import.meta.url), 'utf8'));
const fontConfig = createFontConfiguration(defaultFontDirs(), profile);
const path = resolve(input);
const html = new HTML(decodeHtml(readFileSync(path)), { baseUrl: pathToFileURL(path).href, fetcher });
const stylesheets = [];
for (const s of styles) stylesheets.push(await CSS.fromString(readFileSync(s, 'utf8'), { baseUrl: pathToFileURL(resolve(s)).href, fetcher }));
const doc = await renderDocument(html, { fontConfig, stylesheets });
writeFileSync(output, doc.writePdf({ uncompressedPdf: process.env.UNCOMPRESSED === '1' }));
console.error(`${doc.pages.length} page(s) -> ${output}`);