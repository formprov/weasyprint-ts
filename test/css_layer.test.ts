// SPDX-License-Identifier: BSD-3-Clause

/**
 * @layer cascade semantics (Python: _add_layer / _parse_layer in
 * weasyprint/css/__init__.py). Layer order beats specificity, unlayered
 * declarations beat every layer, and `@layer a, b;` fixes the order before
 * the blocks appear.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HTML, getAllComputedStyles } from '../src/html_document.ts';
import type { Fetcher } from '../src/fetch.ts';

const FETCHER = { fetch: async () => ({ body: new Uint8Array() }) };

async function styles(source: string, fetcher: Fetcher = FETCHER): Promise<Map<string, any>> {
  const html = new HTML(source, { baseUrl: 'file:///doc.html', fetcher });
  const styleFor = await getAllComputedStyles(html, {});
  const out = new Map<string, any>();
  for (const element of html.root.iterElements()) {
    if (element.tag === 'p') out.set(element.get('id') ?? element.get('class') ?? '', styleFor.get(element));
  }
  return out;
}

function rgb(style: any): string {
  const color = style.get('color');
  return `${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)}`;
}

test('layer order beats specificity', async () => {
  const stylesByKey = await styles(`<style>
    @layer base { #x { color: rgb(0, 0, 255) } }
    @layer theme { p { color: rgb(255, 0, 0) } }
    p.note { color: rgb(0, 128, 0) }
  </style><p id="x">a</p><p class="note">b</p>`);
  // `theme` is declared after `base`, so its lower-specificity rule wins.
  assert.equal(rgb(stylesByKey.get('x')), '255,0,0');
  // Unlayered declarations beat every layer.
  assert.equal(rgb(stylesByKey.get('note')), '0,128,0');
});

test('a layer statement fixes the order before the blocks', async () => {
  const stylesByKey = await styles(`<style>
    @layer later, earlier;
    @layer later { p { color: rgb(255, 0, 0) } }
    @layer earlier { p { color: rgb(0, 0, 255) } }
  </style><p id="x">a</p>`);
  // `earlier` comes second in the statement, so it wins even though its block
  // appears later in the source.
  assert.equal(rgb(stylesByKey.get('x')), '0,0,255');
});

test('nested and anonymous layers apply their declarations', async () => {
  const stylesByKey = await styles(`<style>
    @layer outer { @layer inner { p { font-weight: bold } } }
    @layer { p { text-decoration-line: underline } }
  </style><p id="x">a</p>`);
  const style = stylesByKey.get('x');
  assert.equal(style.get('font_weight'), 700);
  assert.ok(style.get('text_decoration_line').has('underline'));
});

test('@import layer() is registered at the import position', async () => {
  const fetcher = {
    fetch: async (url: string) => ({ body: new TextEncoder().encode('p { color: rgb(0, 0, 255) }'), redirectedUrl: url }),
  };
  // The imported sheet is in a layer declared after `base`, so it wins.
  const after = await styles(`<style>
    @layer base { p { color: rgb(255, 0, 0) } }
    @import url(theme.css) layer(theme);
  </style><p id="x">a</p>`, fetcher);
  assert.equal(rgb(after.get('x')), '0,0,255');

  // Declared before `base`, the imported layer loses.
  const before = await styles(`<style>
    @import url(theme.css) layer(theme);
    @layer base { p { color: rgb(255, 0, 0) } }
  </style><p id="x">a</p>`, fetcher);
  assert.equal(rgb(before.get('x')), '255,0,0');
});

test('@import layer (anonymous) joins the order like a named layer', async () => {
  const fetcher = {
    fetch: async (url: string) => ({ body: new TextEncoder().encode('p { color: rgb(0, 0, 255) }'), redirectedUrl: url }),
  };
  const result = await styles(`<style>
    @layer base { p { color: rgb(255, 0, 0) } }
    @import url(theme.css) layer;
  </style><p id="x">a</p>`, fetcher);
  assert.equal(rgb(result.get('x')), '0,0,255');
});
