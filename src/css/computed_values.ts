import { PercentageInMath, resolveMath } from './math.ts';
// SPDX-License-Identifier: BSD-3-Clause

/** Convert specified property values into computed values (mirrors css/computed_values.py). */
import { LOGGER } from '../logger.ts';
import { parseColor } from './color.ts';
import { hooks } from './hooks.ts';
import { BORDER_WIDTH_KEYWORDS, FONT_SIZE_KEYWORDS, INITIAL_PAGE_SIZE } from './page_sizes.ts';
import { INITIAL_VALUES, ZERO_PIXELS, dim } from './properties.ts';
import type { Dimension } from './properties.ts';
import { LENGTH_UNITS, toPixels } from './units.ts';
import type { Style } from './style.ts';

type Computer = (style: Style, name: string, value: any) => any;
export const COMPUTER_FUNCTIONS: Record<string, Computer> = {};

const register = (names: string[], fn: Computer): void => {
  for (const n of names) COMPUTER_FUNCTIONS[n.replace(/-/g, '_')] = fn;
};

export const FONT_WEIGHT_RELATIVE: Record<string, Record<number, number>> = {
  bolder: { 100: 400, 200: 400, 300: 400, 400: 700, 500: 700, 600: 900, 700: 900, 800: 900, 900: 900 },
  lighter: { 100: 100, 200: 100, 300: 100, 400: 100, 500: 100, 600: 400, 700: 400, 800: 700, 900: 700 },
};

INITIAL_VALUES.size = INITIAL_PAGE_SIZE.map((d) => toPixels(d, null, 'size'));

const isDimension = (v: any): v is Dimension => v !== null && typeof v === 'object' && 'value' in v && 'unit' in v;

export function length(style: Style, name: string, value0: any, fontSize: number | null = null, pixelsOnly = false): any {
  if (value0 === 'auto' || value0 === 'content' || value0 === 'from-font') return value0;
  let value = value0;
  if (value && typeof value === 'object' && value.type === 'function') {
    // Math function kept from validation: resolve it with this element's style (Python: resolve_math).
    let resolved: any;
    try {
      resolved = resolveMath(value, style, name);
    } catch (error) {
      // Percentages inside math are resolved by layout against the containing block.
      if (!(error instanceof PercentageInMath)) throw error;
      return value;
    }
    if (resolved === null) return pixelsOnly ? 0 : ZERO_PIXELS;
    value = resolved;
  }
  if (!isDimension(value)) return value;
  if (value.value === 0) return pixelsOnly ? 0 : ZERO_PIXELS;
  if (value.unit === null || !LENGTH_UNITS.has(value.unit.toLowerCase())) return value;
  const pixels = toPixels(value, style, name, fontSize);
  return pixelsOnly ? pixels : dim(pixels, 'px');
}

const lengthPx = (style: Style, name: string, value: any, fontSize: number | null = null): any =>
  length(style, name, value, fontSize, true);

register(['background-image'], (style, name, values) => values.map((v: any) => v));
register(
  ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'column-rule-color', 'outline-color', 'text-decoration-color'],
  (_style, _name, value) => {
    if (value === 'currentcolor') return value;
    if (typeof value === 'object' && value !== null && 'space' in value) return value;
    return parseColor(value);
  },
);
register(['box-shadow'], (style, name, values) => values.map(([x, y, blur, spread, color, inset]: any[]) => [
  length(style, name, x), length(style, name, y), length(style, name, blur), length(style, name, spread),
  typeof color === 'string' || 'space' in color ? color : parseColor(color), inset,
]));
register(['background-position', 'object-position'], (style, name, values) =>
  values.map(([ox, px, oy, py]: any[]) => [ox, length(style, name, px), oy, length(style, name, py)]));
register(['transform-origin'], (style, name, values) => values.map((v: any) => length(style, name, v)));
register(['border-spacing', 'size', 'clip'], (style, name, values) => values.map((v: any) => lengthPx(style, name, v)));
register(['break-after', 'break-before'], (_s, _n, value) => (value === 'always' ? 'page' : value));
register(
  ['top', 'right', 'left', 'bottom', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'height', 'width',
    'block-size', 'inline-size', 'min-width', 'min-height', 'min-block-size', 'min-inline-size', 'max-width',
    'max-height', 'max-block-size', 'max-inline-size', 'padding-top', 'padding-right', 'padding-bottom',
    'padding-left', 'text-indent', 'hyphenate-limit-zone', 'flex-basis', 'text-underline-offset',
    'text-decoration-thickness'],
  (style, name, value) => length(style, name, value),
);
register(['bleed-left', 'bleed-right', 'bleed-top', 'bleed-bottom'], (style, name, value) => {
  if (value === 'auto') return dim((style.get('marks') as string[]).includes('crop') ? 8 : 0, 'px');
  return length(style, name, value);
});
register(['letter-spacing'], (style, name, value) => (value === 'normal' ? value : lengthPx(style, name, value)));
register(['background-size'], (style, name, values) => values.map((v: any) =>
  v === 'contain' || v === 'cover' ? v : v.map((x: any) => length(style, name, x))));
register(['image-orientation'], (_s, _n, values) => {
  if (values === 'none' || values === 'from-image') return values;
  const [angle, flip] = values;
  return [((Math.round((angle / Math.PI) * 2) % 4) + 4) % 4 * 90, flip];
});
register(
  ['border-top-width', 'border-right-width', 'border-left-width', 'border-bottom-width', 'column-rule-width', 'outline-width'],
  (style, name, value) => {
    const borderStyle = style.get(name.replace('width', 'style'));
    if (borderStyle === 'none' || borderStyle === 'hidden') return 0;
    if (typeof value === 'string' && value in BORDER_WIDTH_KEYWORDS) return BORDER_WIDTH_KEYWORDS[value];
    if (typeof value === 'number') return value;
    return lengthPx(style, name, value);
  },
);
const fillFour = (values: any[]): any[] => {
  const v = values.slice();
  if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  if (v.length === 2) return [...v, ...v];
  if (v.length === 3) return [...v, v[1]];
  return v;
};
register(['border-image-slice', 'mask-border-slice'], (_s, _n, values) => {
  const computed: any[] = [];
  let fill: any = null;
  for (const value of values) {
    if (value === 'fill') fill = value;
    else if (value.unit === null) computed.push(value.value);
    else computed.push(dim(value.value, '%'));
  }
  return [...fillFour(computed), fill];
});
register(['border-image-width', 'mask-border-width'], (_s, _n, values) =>
  fillFour(values.map((v: any) => (v === 'auto' ? v : v.unit === null ? v.value : v))));
register(['border-image-outset', 'mask-border-outset'], (style, name, values) =>
  fillFour(values.map((v: any) => (typeof v === 'number' ? v : v.unit === null ? v.value : length(style, name, v)))));
register(['border-image-repeat', 'mask-border-repeat'], (_s, _n, values) => (values.length === 1 ? [values[0], values[0]] : values));
register(['column-width', 'outline-offset'], (style, name, value) => lengthPx(style, name, value));
register(
  ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius'],
  (style, name, values) => values.map((v: any) => length(style, name, v)),
);
register(['column-gap', 'row-gap'], (style, name, value) => (value === 'normal' ? value : length(style, name, value)));

const CONTENT_TYPES = new Set(['string', 'content', 'url', 'quote', 'leader()', 'counter()', 'counters()', 'content()',
  'element()', 'string()', 'attr()', 'target-counter()', 'target-counters()', 'target-text()']);
const contentList = (values: any[]): any[] => {
  const out: any[] = [];
  for (const v of values) {
    if (CONTENT_TYPES.has(v[0])) out.push(v);
    else LOGGER.warning(`Unable to compute content: ${JSON.stringify(v)}`);
  }
  return out;
};
register(['bookmark-label'], (_s, _n, values) => contentList(values));
register(['string-set'], (_s, _n, values) => values.map((v: any) => [v[0], contentList(v[1])]));
register(['content'], (style, _n, values) => {
  if (values.length === 1) {
    const value = values[0];
    if (value === 'normal') return style.pseudoType ? 'inhibit' : 'contents';
    if (value === 'none') return 'inhibit';
  }
  return contentList(values);
});

register(['display'], (style, _n, value: string[]) => {
  const float = style.specified.float;
  const position = style.specified.position;
  if (position === 'absolute' || position === 'fixed' || float !== 'none' || style.isRootElement) {
    if (value.length === 1 && value[0] === 'inline-table') return ['block', 'table'];
    if (value.length === 1 && value[0].startsWith('table-')) return ['block', 'flow'];
    if (value[0] === 'inline') {
      if (value.includes('list-item')) return ['block', 'flow', 'list-item'];
      return ['block', 'flow'];
    }
  }
  return value;
});
register(['float'], (style, _n, value) => {
  const position = style.specified.position;
  if (position === 'absolute' || position === 'fixed' || (Array.isArray(position) && ['running()', 'note()'].includes(position[0]))) {
    return 'none';
  }
  return value;
});
register(['font-size'], (style, name, value) => {
  if (typeof value === 'string' && value in FONT_SIZE_KEYWORDS) return FONT_SIZE_KEYWORDS[value];
  const keywordValues = Object.values(FONT_SIZE_KEYWORDS);
  const parentFontSize: number = style.parentStyle === null ? INITIAL_VALUES.font_size : style.parentStyle.get('font_size');
  if (value === 'larger') {
    for (const kv of keywordValues) if (kv > parentFontSize) return kv;
    return parentFontSize * 1.2;
  }
  if (value === 'smaller') {
    for (const kv of keywordValues.slice().reverse()) if (kv < parentFontSize) return kv;
    return parentFontSize * 0.8;
  }
  if (isDimension(value) && value.unit === '%') return (value.value * parentFontSize) / 100;
  return length(style, name, value, parentFontSize, true);
});
register(['font-weight'], (style, _n, value) => {
  if (value === 'normal') return 400;
  if (value === 'bold') return 700;
  if (value === 'bolder' || value === 'lighter') {
    const parent = style.parentStyle === null ? INITIAL_VALUES.font_weight : style.parentStyle.get('font_weight');
    return FONT_WEIGHT_RELATIVE[value][parent];
  }
  return value;
});
register(['line-height'], (style, name, value) => {
  if (value === 'normal') return value;
  if (value.unit === null) return value.value;
  if (value.unit === '%') return dim((value.value / 100) * style.get('font_size'), 'px');
  return length(style, name, value);
});
register(['lang'], (_s, _n, values) => {
  const [name, value] = values;
  return name === 'string' ? value : null;
});
register(['tab-size'], (style, name, value) => (typeof value === 'number' ? value : length(style, name, value)));
register(['transform'], (style, name, value) => value.map(([fn, args]: any[]) =>
  [fn, fn === 'translate' ? args.map((a: any) => length(style, name, a)) : args]));
register(['vertical-align'], (style, name, value) => {
  if (['baseline', 'middle', 'text-top', 'text-bottom', 'top', 'bottom'].includes(value)) return value;
  if (value === 'super') return style.get('font_size') * 0.5;
  if (value === 'sub') return style.get('font_size') * -0.5;
  if (value.unit === '%') return (hooks.strut(style)[0] * value.value) / 100;
  return lengthPx(style, name, value);
});
register(['word-spacing'], (style, name, value) => (value === 'normal' ? 0 : lengthPx(style, name, value)));

export { FONT_SIZE_KEYWORDS, BORDER_WIDTH_KEYWORDS };