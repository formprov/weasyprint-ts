// SPDX-License-Identifier: BSD-3-Clause

/** Page sizes and font-size keywords (from weasyprint/css/computed_values.py). */
import { dim } from './properties.ts';
import type { Dimension } from './properties.ts';

export const FONT_SIZE_KEYWORDS: Record<string, number> = Object.fromEntries(
  ([
    ['xx-small', 3 / 5], ['x-small', 3 / 4], ['small', 8 / 9], ['medium', 1], ['large', 6 / 5],
    ['x-large', 3 / 2], ['xx-large', 2],
  ] as Array<[string, number]>).map(([name, factor]) => [name, 16 * factor]),
);

export const BORDER_WIDTH_KEYWORDS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

const sizes: Array<[string, number, number, string]> = [
  ['a10', 26, 37, 'mm'], ['a9', 37, 52, 'mm'], ['a8', 52, 74, 'mm'], ['a7', 74, 105, 'mm'], ['a6', 105, 148, 'mm'],
  ['a5', 148, 210, 'mm'], ['a4', 210, 297, 'mm'], ['a3', 297, 420, 'mm'], ['a2', 420, 594, 'mm'],
  ['a1', 594, 841, 'mm'], ['a0', 841, 1189, 'mm'],
  ['b10', 31, 44, 'mm'], ['b9', 44, 62, 'mm'], ['b8', 62, 88, 'mm'], ['b7', 88, 125, 'mm'], ['b6', 125, 176, 'mm'],
  ['b5', 176, 250, 'mm'], ['b4', 250, 353, 'mm'], ['b3', 353, 500, 'mm'], ['b2', 500, 707, 'mm'],
  ['b1', 707, 1000, 'mm'], ['b0', 1000, 1414, 'mm'],
  ['c10', 28, 40, 'mm'], ['c9', 40, 57, 'mm'], ['c8', 57, 81, 'mm'], ['c7', 81, 114, 'mm'], ['c6', 114, 162, 'mm'],
  ['c5', 162, 229, 'mm'], ['c4', 229, 324, 'mm'], ['c3', 324, 458, 'mm'], ['c2', 458, 648, 'mm'],
  ['c1', 648, 917, 'mm'], ['c0', 917, 1297, 'mm'],
  ['jis-b10', 32, 45, 'mm'], ['jis-b9', 45, 64, 'mm'], ['jis-b8', 64, 91, 'mm'], ['jis-b7', 91, 128, 'mm'],
  ['jis-b6', 128, 182, 'mm'], ['jis-b5', 182, 257, 'mm'], ['jis-b4', 257, 364, 'mm'], ['jis-b3', 364, 515, 'mm'],
  ['jis-b2', 515, 728, 'mm'], ['jis-b1', 728, 1030, 'mm'], ['jis-b0', 1030, 1456, 'mm'],
  ['letter', 8.5, 11, 'in'], ['legal', 8.5, 14, 'in'], ['ledger', 11, 17, 'in'],
];

export const PAGE_SIZES: Record<string, [Dimension, Dimension]> = Object.fromEntries(
  sizes.map(([name, w, h, unit]) => [name, [dim(w, unit), dim(h, unit)] as [Dimension, Dimension]]),
);
export const INITIAL_PAGE_SIZE = PAGE_SIZES.a4;