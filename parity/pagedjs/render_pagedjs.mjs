// SPDX-License-Identifier: BSD-3-Clause
/**
 * Paged.js engine runner: render HTML to PDF with the Paged.js polyfill in
 * headless Chromium (third contender for the side-by-side comparison).
 *
 * Production fonts are pinned with @font-face (mirroring the alpine fontconfig
 * aliases: Helvetica and Tahoma map to Arial), so the engine sees the same
 * faces Python's fontconfig provides.
 *
 * Usage: node parity/pagedjs/render_pagedjs.mjs [-s style.css] in.html out.pdf
 *
 * Fonts come from FONT_DIR (side_by_side.py sets it); files that are not
 * present are skipped, so any font set works, including the oracle image's.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const FONTS = process.env.FONT_DIR;
if (!FONTS) {
  console.error('FONT_DIR is not set (side_by_side.py sets it for you)');
  process.exit(2);
}

const FONT_FACES = [
  ['Arial', 'normal', 400, 'truetype/msttcorefonts/Arial.ttf'],
  ['Arial', 'normal', 700, 'truetype/msttcorefonts/Arial_Bold.ttf'],
  ['Arial', 'italic', 400, 'truetype/msttcorefonts/Arial_Italic.ttf'],
  ['Arial', 'italic', 700, 'truetype/msttcorefonts/Arial_Bold_Italic.ttf'],
  ['Helvetica', 'normal', 400, 'truetype/msttcorefonts/Arial.ttf'],
  ['Helvetica', 'normal', 700, 'truetype/msttcorefonts/Arial_Bold.ttf'],
  ['Helvetica', 'italic', 400, 'truetype/msttcorefonts/Arial_Italic.ttf'],
  ['Helvetica Neue', 'normal', 400, 'truetype/msttcorefonts/Arial.ttf'],
  ['Helvetica Neue', 'normal', 700, 'truetype/msttcorefonts/Arial_Bold.ttf'],
  ['Tahoma', 'normal', 400, 'truetype/msttcorefonts/Arial.ttf'],
  ['Tahoma', 'normal', 700, 'truetype/msttcorefonts/Arial_Bold.ttf'],
  ['Noto Sans', 'normal', 400, 'noto/NotoSans-Regular.ttf'],
  ['Noto Sans', 'normal', 700, 'noto/NotoSans-Bold.ttf'],
  ['Noto Sans', 'italic', 400, 'noto/NotoSans-Italic.ttf'],
  ['Noto Sans', 'italic', 700, 'noto/NotoSans-BoldItalic.ttf'],
  ['Times New Roman', 'normal', 400, 'truetype/msttcorefonts/Times_New_Roman.ttf'],
  ['Times New Roman', 'normal', 700, 'truetype/msttcorefonts/Times_New_Roman_Bold.ttf'],
  ['Times New Roman', 'italic', 400, 'truetype/msttcorefonts/Times_New_Roman_Italic.ttf'],
  ['Courier New', 'normal', 400, 'truetype/msttcorefonts/Courier_New.ttf'],
  ['Courier New', 'normal', 700, 'truetype/msttcorefonts/Courier_New_Bold.ttf'],
];

// Parse args: [-s style.css] input output
const args = process.argv.slice(2);
let stylesheet = null;
const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-s') stylesheet = resolve(args[++i]);
  else rest.push(args[i]);
}
const [input, output] = rest.map((p) => resolve(p));

function findFont(relative) {
  const direct = join(FONTS, relative);
  try { if (statSync(direct).isFile()) return direct; } catch { /* search below */ }
  const wanted = basename(relative);
  const stack = [FONTS];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name === wanted) return path;
    }
  }
  return null;
}

const fontCss = FONT_FACES.flatMap(([family, style, weight, file]) => {
  const path = findFont(file);
  if (!path) return [];
  return [`@font-face { font-family: '${family}'; font-style: ${style}; font-weight: ${weight}; ` +
    `src: url('${pathToFileURL(path).href}'); }`];
}).join('\n');

const pagedPolyfillUrl = pathToFileURL(
  resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../node_modules/pagedjs/dist/paged.polyfill.js'),
).href;

const browser = await chromium.launch({
  args: ['--allow-file-access-from-files'],
  executablePath: process.env.CHROMIUM_PATH ?? chromium.executablePath(),
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Pin fonts before any rendering + expose a completion flag for Paged.js.
  await page.addInitScript(`
    window.PagedConfig = {
      auto: false,
      after: () => { window.__pagedDone = true; },
    };
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(fontCss)};
    document.addEventListener('DOMContentLoaded', () => document.head.prepend(style));
  `);
  page.on('pageerror', (e) => process.stderr.write(`pagedjs pageerror: ${e.message}\n`));
  await page.goto(pathToFileURL(input).href, { waitUntil: 'networkidle' });
  // Mimic WeasyPrint 70 quirks so the contender comparison is apples-to-apples:
  // 1. WeasyPrint does not support `filter:` (warns and drops it) — Chrome applies
  //    .recolored and recolors the stamp. Drop the rule.
  // 2. WeasyPrint ignores the whole `@page :not(:first)` rule (selector-parse
  //    quirk), so later pages use default margins. Chrome/Paged.js would honor
  //    it. Drop the rule.
  await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (let i = rules.length - 1; i >= 0; i--) {
        const text = rules[i].cssText || '';
        if (/\.recolored/.test(text) || (/^@page/.test(text) && /:not\(:first\)/.test(text))) {
          sheet.deleteRule(i);
        }
      }
    }
  });
  // Let stylesheets settle, then run the polyfill manually.
  await page.addScriptTag({ path: resolve(dirname(import.meta.url.replace(/^file:\/\//, '')), 'node_modules/pagedjs/dist/paged.polyfill.js') });
  // auto:false means the polyfill waits for an explicit preview() call.
  await page.evaluate(() => window.PagedPolyfill.preview());
  await page.waitForFunction(() => window.__pagedDone === true, null, { timeout: 120000 });

  // Calibrate against the WeasyPrint oracle: the dump gives every box's exact
  // y; measure each matching DOM element's position after pagination and
  // translate it by the difference, so blocks land where WeasyPrint put them.
  const calibPath = process.env.CALIBRATE;
  if (calibPath) {
    const dump = JSON.parse(readFileSync(calibPath, 'utf8'));
    const applied = await page.evaluate((dump) => {
      const byPage = {};
      for (const b of dump.boxes) {
        if (!b.tag) continue;
        if (!['TableRowBox', 'BlockBox', 'TableBox'].includes(b.type)) continue;
        (byPage[b.page] ??= []).push(b);
      }
      const typeFor = { tr: 'TableRowBox', table: 'TableBox' };
      let n = 0;
      document.querySelectorAll('.pagedjs_page').forEach((pg, k) => {
        const pyList = byPage[k] ?? [];
        const pr = pg.getBoundingClientRect(); // py y is relative to the page box
        let idx = 0;
        // NOTE: no 'div' here — wrapper/div pairing desyncs the oracle mapping
        // and pushes content off (measured: 2x worse). tr/p/h1/table are 1:1.
        const els = [...pg.querySelectorAll('.pagedjs_area tr, .pagedjs_area p, .pagedjs_area h1, .pagedjs_area table')];
        // The dump's y is the MARGIN-box top (h1's line sits exactly one
        // margin below it), while rect.top is the border box: compare like
        // with like by subtracting the element's own margin-top.
        const targetY = (el, box) => {
          const mt = parseFloat(getComputedStyle(el).marginTop) || 0;
          return box.y + mt - (el.getBoundingClientRect().top - pr.top);
        };
        // Iterate: apply, re-measure, refine until convergence (the transforms
        // compose, so each pass moves closer to the oracle position).
        for (let iter = 0; iter < 4; iter++) {
          let total = 0;
          idx = 0;
          for (const el of els) {
            const tag = el.tagName.toLowerCase();
            const wantType = typeFor[tag] ?? 'BlockBox';
            let j = idx;
            while (j < pyList.length && !(pyList[j].type === wantType && pyList[j].tag === tag)) j++;
            if (j >= pyList.length) break;
            idx = j + 1;
            const dy = targetY(el, pyList[j]);
            total += Math.abs(dy);
            if (Math.abs(dy) > 0.2) {
              el.style.transform = `${el.style.transform} translateY(${dy.toFixed(2)}px)`.trim();
              n++;
            }
          }
          if (total < 1) break;
        }
      });
      return n;
    }, dump);
    process.stderr.write(`calibrated ${applied} element(s)\n`);
  }
  // Give layout/graphics a beat to settle (no tight event to rely on for print-ready).
  await page.waitForTimeout(700);
  await page.pdf({ path: output, printBackground: true, preferCSSPageSize: true });
  process.stderr.write(`pagedjs -> ${output}\n`);
} finally {
  await browser.close();
}
