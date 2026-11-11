// SPDX-License-Identifier: BSD-3-Clause

/** Dump computed styles of every element (for comparison with WeasyPrint). */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CSS } from '../src/css/index.ts';
import { HTML, decodeHtml, getAllComputedStyles } from '../src/html_document.ts';
import { NodeFetcher } from '../src/cli/node_fetcher.ts';
import { INITIAL_VALUES } from '../src/css/properties.ts';

const [file, stylesheet] = process.argv.slice(2);
const fetcher = new NodeFetcher();
const path = resolve(file);
const html = new HTML(decodeHtml(readFileSync(path)), { baseUrl: pathToFileURL(path).href, fetcher });
const user = stylesheet
  ? [await CSS.fromString(readFileSync(stylesheet, 'utf8'), { baseUrl: pathToFileURL(resolve(stylesheet)).href, fetcher })]
  : [];
const styleFor = await getAllComputedStyles(html, { userStylesheets: user });

const ser = (v: any): any => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : String(v);
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Set) return [...v].sort();
  if (Array.isArray(v)) return v.map(ser);
  if ('space' in v) return [v.r, v.g, v.b, v.a].map((x: number) => Math.round(x * 1e4) / 1e4);
  if ('value' in v && 'unit' in v) return [Number.isFinite(v.value) ? Math.round(v.value * 1e6) / 1e6 : String(v.value), v.unit];
  if ('type' in v) return `<${v.type}>`;
  return String(v);
};

const out: any[] = [];
for (const el of html.root.iterElements()) {
  const style = styleFor.get(el);
  const props: Record<string, any> = {};
  for (const key of Object.keys(INITIAL_VALUES).sort()) {
    if (key.includes('grid') || key.includes('mask') || key.includes('border_image') || key.includes('bookmark')) continue;
    props[key] = ser(style.get(key));
  }
  out.push({ tag: el.tag, id: el.get('id'), cls: el.get('class'), props });
}
console.log(JSON.stringify(out));