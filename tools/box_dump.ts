// SPDX-License-Identifier: BSD-3-Clause

/** Dump the box tree (after buildFormattingStructure, before layout), same shape as the parity box dumps (`parity/dump_layout.py`). */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CSS } from '../src/css/index.ts';
import { HTML, decodeHtml, getAllComputedStyles } from '../src/html_document.ts';
import { NodeFetcher } from '../src/cli/node_fetcher.ts';
import { TargetCollector } from '../src/css/targets.ts';
import { buildFormattingStructure } from '../src/formatting_structure/build.ts';
import * as boxes from '../src/formatting_structure/boxes.ts';

const [file, stylesheet] = process.argv.slice(2);
const fetcher = new NodeFetcher();
const path = resolve(file);
const html = new HTML(decodeHtml(readFileSync(path)), { baseUrl: pathToFileURL(path).href, fetcher });
const user = stylesheet
  ? [await CSS.fromString(readFileSync(stylesheet, 'utf8'), { baseUrl: pathToFileURL(resolve(stylesheet)).href, fetcher })]
  : [];
const styleFor = await getAllComputedStyles(html, { userStylesheets: user });
const box = buildFormattingStructure(
  html.root, (el, pseudo = null) => (styleFor.has(el, pseudo) ? styleFor.get(el, pseudo) : null),
  () => null, html.baseUrl, new TargetCollector(), html.counterStyle, []);

const dump = (b: any): any => {
  const d: any = { type: b.constructor.name, tag: b.elementTag };
  if (b instanceof boxes.TextBox) d.text = b.text;
  if (b.isParent) d.children = b.children.map(dump);
  const snake: Array<[string, string]> = [
    ['isTableWrapper', 'is_table_wrapper'], ['isFlexItem', 'is_flex_item'],
    ['isOutsideMarker', 'is_outside_marker'], ['isForRootElement', 'is_for_root_element'],
  ];
  const flags = snake.filter(([k]) => b[k]).map(([, n]) => n);
  if (flags.length) d.flags = flags;
  if (b.colspan !== 1) d.colspan = b.colspan;
  if (b.gridX !== undefined) d.grid_x = b.gridX;
  return d;
};
console.log(JSON.stringify(dump(box)));