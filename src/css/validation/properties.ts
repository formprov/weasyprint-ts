// SPDX-License-Identifier: BSD-3-Clause

/**
 * Validate properties (mirrors weasyprint/css/validation/properties.py).
 * Grid layout properties are not registered yet and will be reported as
 * "property not supported yet" like any other unsupported property.
 */
import type { Token } from '../parser.ts';
import { parseComponentValueList } from '../parser.ts';
import { parseColor } from '../color.ts';
import { INITIAL_VALUES, KNOWN_PROPERTIES, ZERO_PIXELS, dim } from '../properties.ts';
import type { Dimension } from '../properties.ts';
import {
  FunctionToken, InvalidValues, commaSeparatedList, getAngle, getCustomIdent, getKeyword, getLength,
  getNumber, getPercentage, getResolution, getSingleKeyword, getUrl, getImage, isVar, parse2dPosition,
  parsePosition, removeWhitespace, singleKeyword, singleToken,
} from '../tokens.ts';
import type { Validator } from '../tokens.ts';
import { FONT_SIZE_KEYWORDS, INITIAL_PAGE_SIZE, PAGE_SIZES } from '../page_sizes.ts';

export const PREFIX = '-weasy-';
export const PROPRIETARY = new Set<string>();
export const UNSTABLE = new Set<string>();

export interface RegisteredValidator {
  fn: Validator;
  wantsBaseUrl: boolean;
}
export const PROPERTIES = new Map<string, RegisteredValidator>();

function register(
  names: string | string[], fn: Validator,
  opts: { proprietary?: boolean; unstable?: boolean; wantsBaseUrl?: boolean } = {},
): Validator {
  for (const name of Array.isArray(names) ? names : [names]) {
    if (!KNOWN_PROPERTIES.has(name)) throw new Error(`Unknown property ${name}`);
    PROPERTIES.set(name, { fn, wantsBaseUrl: opts.wantsBaseUrl ?? false });
    if (opts.proprietary) PROPRIETARY.add(name);
    if (opts.unstable) UNSTABLE.add(name);
  }
  return fn;
}

export class Pending {
  tokens: Token[];
  name: string;
  constructor(tokens: Token[], name: string) {
    this.tokens = tokens;
    this.name = name;
  }
}

/** Validator for non-shorthand properties: returns [[name, value]]. */
export function validateNonShorthand(
  tokens: Token[], name: string, baseUrl: string | null = null, required = false,
): Array<[string, any]> {
  if (!required && !KNOWN_PROPERTIES.has(name) && !name.startsWith('--')) throw new InvalidValues('unknown property');
  if (!required && !PROPERTIES.has(name) && !name.startsWith('--')) throw new InvalidValues('property not supported yet');
  if (tokens.some(isVar)) return [[name, new Pending(tokens, name)]];
  if (name.startsWith('--')) return [[name, tokens]];
  const entry = PROPERTIES.get(name)!;
  const keyword = getSingleKeyword(tokens);
  let value: any;
  if (keyword === 'initial' || keyword === 'inherit') value = keyword;
  else {
    value = entry.fn(tokens, baseUrl);
    if (value === null || value === undefined) throw new InvalidValues();
  }
  return [[name, value]];
}

const kw = (...words: string[]): Validator => singleKeyword((k) => k !== null && words.includes(k));

// --- Colors -----------------------------------------------------------------
register(
  ['background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-block-start-color', 'border-block-end-color', 'border-inline-start-color', 'border-inline-end-color',
    'column-rule-color', 'text-decoration-color'],
  singleToken((t) => (parseColor(t) ? t : null)), { unstable: false },
);
UNSTABLE.add('column-rule-color');
register('outline-color', singleToken((t) => {
  if (getKeyword(t) === 'invert') return 'currentcolor';
  return parseColor(t) ? t : null;
}));
register('color', singleToken((t) => {
  const r = parseColor(t);
  if (r) return r === 'currentcolor' ? 'inherit' : t;
  return null;
}));
register('border-collapse', kw('separate', 'collapse'));
register('empty-cells', kw('show', 'hide'));

// --- Backgrounds ------------------------------------------------------------
register('background-attachment', commaSeparatedList(singleKeyword((k) => k === 'scroll' || k === 'fixed' || k === 'local')));
register('background-image', commaSeparatedList(singleToken((t, baseUrl) => {
  if (getKeyword(t) === 'none') return ['none', null];
  return getImage(t, baseUrl ?? null);
})), { wantsBaseUrl: true });
register('list-style-image', singleToken((t, baseUrl) => {
  if (getKeyword(t) === 'none') return ['none', null];
  const parsed = getUrl(t, baseUrl ?? null);
  if (parsed && parsed[1][0] === 'external') return ['url', parsed[1][1]];
  return null;
}), { wantsBaseUrl: true });
register('transform-origin', (tokens) => {
  if (tokens.length === 3) tokens = tokens.slice(0, 2);
  return parse2dPosition(tokens);
});
register('background-position', commaSeparatedList((tokens) => parsePosition(tokens)));
register('object-position', commaSeparatedList((tokens) => parsePosition(tokens)));
register('background-repeat', commaSeparatedList((tokens) => {
  const k = tokens.map(getKeyword);
  if (k.length === 1 && k[0] === 'repeat-x') return ['repeat', 'no-repeat'];
  if (k.length === 1 && k[0] === 'repeat-y') return ['no-repeat', 'repeat'];
  if (k.length === 1 && ['no-repeat', 'repeat', 'space', 'round'].includes(k[0]!)) return [k[0], k[0]];
  if (k.length === 2 && k.every((x) => x && ['no-repeat', 'repeat', 'space', 'round'].includes(x))) return k;
  return null;
}));
register('background-size', commaSeparatedList((tokens) => {
  if (tokens.length === 1) {
    const k = getKeyword(tokens[0]);
    if (k === 'contain' || k === 'cover') return k;
    if (k === 'auto') return ['auto', 'auto'];
    const l = getLength(tokens[0], false, true);
    if (l) return [l, 'auto'];
  } else if (tokens.length === 2) {
    const values: any[] = [];
    for (const t of tokens) {
      const l = getLength(t, false, true);
      if (l) values.push(l);
      else if (getKeyword(t) === 'auto') values.push('auto');
    }
    if (values.length === 2) return values;
  }
  return null;
}));
register(['background-clip', 'background-origin'], commaSeparatedList(kw('border-box', 'padding-box', 'content-box')));

register('border-spacing', (tokensIn) => {
  const tokens = removeWhitespace(tokensIn);
  const lengths = tokens.map((t) => getLength(t, false));
  if (lengths.every((l) => l !== null)) {
    if (lengths.length === 1) return [lengths[0], lengths[0]];
    if (lengths.length === 2) return lengths;
  }
  return null;
});
register(
  ['border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'border-top-left-radius',
    'border-start-start-radius', 'border-start-end-radius', 'border-end-start-radius', 'border-end-end-radius'],
  (tokens) => {
    const lengths = tokens.map((t) => getLength(t, false, true));
    if (lengths.every((l) => l !== null)) {
      if (lengths.length === 1) return [lengths[0], lengths[0]];
      if (lengths.length === 2) return lengths;
    }
    return null;
  },
);
register(
  ['border-top-style', 'border-right-style', 'border-left-style', 'border-bottom-style',
    'border-block-start-style', 'border-block-end-style', 'border-inline-start-style', 'border-inline-end-style',
    'column-rule-style'],
  kw('none', 'hidden', 'dotted', 'dashed', 'double', 'inset', 'outset', 'groove', 'ridge', 'solid'),
);
register('box-shadow', (tokens) => {
  if (getSingleKeyword(tokens) === 'none') return [];
  const shadows: any[] = [];
  let rest = tokens.slice();
  while (rest.length) {
    const lengths: Dimension[] = [];
    let color: Token | null = null;
    let inset = false;
    let lastLength = false;
    while (rest.length) {
      const token = rest.shift()!;
      if (token.type === 'literal' && token.value === ',' && rest.length) break;
      if (token.type === 'ident' && token.value === 'inset' && !inset) {
        inset = true;
        lastLength = false;
        continue;
      }
      const length = getLength(token);
      if (length && !(lengths.length && !lastLength)) {
        lengths.push(length);
        lastLength = true;
      } else if (!color && parseColor(token)) {
        color = token;
        lastLength = false;
      } else return null;
    }
    if (!(lengths.length >= 2 && lengths.length <= 4)) return null;
    const x = lengths.shift()!;
    const y = lengths.shift()!;
    const blur = lengths.length ? lengths.shift()! : ZERO_PIXELS;
    if (blur.value < 0) return null;
    const spread = lengths.length ? lengths.shift()! : ZERO_PIXELS;
    shadows.push([x, y, blur, spread, color ?? 'currentcolor', inset]);
  }
  return shadows;
});
register(['break-before', 'break-after'], kw(
  'auto', 'avoid', 'avoid-page', 'page', 'left', 'right', 'recto', 'verso', 'avoid-column', 'column', 'always'));
register('break-inside', kw('auto', 'avoid', 'avoid-page', 'avoid-column'));
register('box-decoration-break', kw('slice', 'clone'));
register('block-ellipsis', singleToken((t) => {
  if (t.type === 'string') return ['string', t.value];
  const k = getKeyword(t);
  if (k === 'none' || k === 'auto') return k;
  return null;
}));
register('continue', kw('auto', 'discard'), { unstable: true });
register('max-lines', singleToken((t) => {
  const n = getNumber(t, false, true);
  if (n) return n.value;
  if (getKeyword(t) === 'none') return 'none';
  return null;
}), { unstable: true });
register('margin-break', kw('auto', 'keep', 'discard'), { unstable: true });
register('page', singleToken((t) => (t.type === 'ident' ? (t.lowerValue === 'auto' ? 'auto' : t.value) : null)), { unstable: true });
register(['bleed-left', 'bleed-right', 'bleed-top', 'bleed-bottom'], singleToken((t) => {
  if (getKeyword(t) === 'auto') return 'auto';
  return getLength(t);
}), { unstable: true });
register('marks', (tokens) => {
  if (tokens.length === 2) {
    const k = tokens.map(getKeyword);
    if (k.includes('crop') && k.includes('cross')) return k;
  } else if (tokens.length === 1) {
    const k = getKeyword(tokens[0]);
    if (k === 'crop' || k === 'cross') return [k];
    if (k === 'none') return [];
  }
  return null;
}, { unstable: true });
register('outline-style', kw('none', 'dotted', 'dashed', 'double', 'inset', 'outset', 'groove', 'ridge', 'solid'));
register(
  ['border-top-width', 'border-right-width', 'border-left-width', 'border-bottom-width',
    'border-block-start-width', 'border-block-end-width', 'border-inline-start-width', 'border-inline-end-width',
    'column-rule-width', 'outline-width'],
  singleToken((t) => {
    const l = getLength(t, false);
    if (l) return l;
    const k = getKeyword(t);
    if (k === 'thin' || k === 'medium' || k === 'thick') return k;
    return null;
  }),
);
register(['border-image-source', 'mask-border-source'], singleToken((t, baseUrl) => {
  if (getKeyword(t) === 'none') return ['none', null];
  return getImage(t, baseUrl ?? null);
}), { wantsBaseUrl: true });
register(['border-image-slice', 'mask-border-slice'], (tokens) => {
  const values: any[] = [];
  let fill = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const pct = getPercentage(t, false);
    const num = getNumber(t, false);
    if (pct) values.push(pct);
    else if (getKeyword(t) === 'fill' && !fill && (i === 0 || i === tokens.length - 1)) {
      fill = true;
      values.push('fill');
    } else if (num) values.push(num);
    else return null;
  }
  const n = values.length - (fill ? 1 : 0);
  return n >= 1 && n <= 4 ? values : null;
});
register(['border-image-width', 'mask-border-width'], (tokens) => {
  const values: any[] = [];
  for (const t of tokens) {
    if (getKeyword(t) === 'auto') values.push('auto');
    else {
      const n = getNumber(t, false);
      const l = getLength(t, false, true);
      if (n) values.push(n);
      else if (l) values.push(l);
      else return null;
    }
  }
  return values.length >= 1 && values.length <= 4 ? values : null;
});
register(['border-image-outset', 'mask-border-outset'], (tokens) => {
  const values: any[] = [];
  for (const t of tokens) {
    const n = getNumber(t, false);
    const l = getLength(t, false);
    if (n) values.push(n);
    else if (l) values.push(l);
    else return null;
  }
  return values.length >= 1 && values.length <= 4 ? values : null;
});
register(['border-image-repeat', 'mask-border-repeat'], (tokens) => {
  if (tokens.length >= 1 && tokens.length <= 2) {
    const k = tokens.map(getKeyword);
    if (k.every((x) => x && ['stretch', 'repeat', 'round', 'space'].includes(x))) return k;
  }
  return null;
});
register('mask-border-mode', kw('luminance', 'alpha'));
register('column-width', singleToken((t) => {
  const l = getLength(t, false);
  if (l) return l;
  return getKeyword(t) === 'auto' ? 'auto' : null;
}), { unstable: true });
register('column-span', kw('all', 'none'), { unstable: true });
register('box-sizing', kw('padding-box', 'border-box', 'content-box'));
register('caption-side', kw('top', 'bottom'));
register('clear', kw('left', 'right', 'inline-start', 'inline-end', 'both', 'none'));
register('clip', singleToken((t) => {
  const fn = new FunctionToken(t);
  const args = fn.splitComma(true);
  if (fn.name === 'rect' && args && args.length === 4) {
    const values: any[] = [];
    for (const a of args) {
      if (getKeyword(a) === 'auto') values.push('auto');
      else {
        const l = getLength(a);
        if (l) values.push(l);
        else return null;
      }
    }
    return values;
  }
  if (getKeyword(t) === 'auto') return [];
  return null;
}));

// --- Content ----------------------------------------------------------------
function getString(token: Token): any {
  if (token.type === 'string') return ['string', token.value];
  if (token.type === 'function') {
    if (token.lowerName === 'attr') return checkAttr(token, 'string');
    if (token.lowerName === 'counter' || token.lowerName === 'counters') return checkCounter(token);
    if (token.lowerName === 'content') return checkContent(token);
    if (token.lowerName === 'string') return checkStringOrElement('string', token);
  }
  return null;
}

export function checkStringOrElement(kind: string, token: Token): any {
  const fn = new FunctionToken(token);
  const args = fn.splitComma(true);
  if (fn.name === kind && args && (args.length === 1 || args.length === 2)) {
    const custom = args.shift()!;
    if (custom.type !== 'ident') return null;
    let ident = 'first';
    if (args.length) {
      const i = args.shift()!;
      if (i.type !== 'ident' || !['first', 'start', 'last', 'first-except', 'all-once'].includes(i.lowerValue)) return null;
      ident = i.lowerValue;
    }
    return [`${kind}()`, [custom.value, ident]];
  }
  return null;
}

export function checkAttr(token: Token, allowedType: string | null = null): any {
  const fn = new FunctionToken(token);
  if (fn.name !== 'attr') return null;
  const parts = fn.splitComma(false, true);
  if (!parts) return null;
  let nameAndType: Token[];
  let fallback: string | Token[] = '';
  if (parts.length === 1) nameAndType = parts[0];
  else if (parts.length === 2) {
    nameAndType = parts[0];
    const f = parts[1];
    fallback = f.length >= 1 && f[0].type === 'string' ? f[0].value : '';
  } else return null;
  if (nameAndType.some((t) => t.type !== 'ident')) return null;
  const name = (nameAndType[0] as any).value;
  const typeOrUnit = nameAndType.length === 2 ? (nameAndType[1] as any).value : 'string';
  if (allowedType === null || allowedType === typeOrUnit) return ['attr()', [name, typeOrUnit, fallback]];
  return null;
}

export function checkCounter(token: Token): any {
  const fn = new FunctionToken(token);
  const args = fn.splitComma(true);
  if (!args) return null;
  if (fn.name === 'counter') {
    if (args.length !== 1 && args.length !== 2) return null;
  } else if (fn.name === 'counters') {
    if (args.length !== 2 && args.length !== 3) return null;
  } else return null;
  const result: any[] = [];
  const ident = args.shift()!;
  if (ident.type !== 'ident') return null;
  result.push(ident.value);
  if (fn.name === 'counters') {
    const s = args.shift()!;
    if (s.type !== 'string') return null;
    result.push(s.value);
  }
  if (args.length) {
    const style = listStyleType([args.shift()!]);
    if (style === null) return null;
    result.push(style);
  } else result.push('decimal');
  return [`${fn.name}()`, result];
}

export function checkContent(token: Token): any {
  const fn = new FunctionToken(token);
  if (fn.name === 'content') {
    const args = fn.splitComma(true);
    if (!args) return null;
    if (args.length === 0) return ['content()', 'text'];
    if (args.length === 1) {
      const a = args[0];
      if (a.type === 'ident' && ['text', 'before', 'after', 'first-letter', 'marker'].includes(a.lowerValue)) {
        return ['content()', a.lowerValue];
      }
    }
  }
  return null;
}

function getQuote(token: Token): string | null {
  const k = getKeyword(token);
  return k && ['open-quote', 'close-quote', 'no-open-quote', 'no-close-quote'].includes(k) ? k : null;
}

/** Validate a <target> token: target-counter(), target-counters(), target-text(). */
export function getTarget(token: Token, baseUrl: string | null): any {
  const fn = new FunctionToken(token);
  const args = fn.splitComma(true);
  if (!args) return null;
  if (fn.name === 'target-counter') {
    if (args.length !== 2 && args.length !== 3) return null;
  } else if (fn.name === 'target-counters') {
    if (args.length !== 3 && args.length !== 4) return null;
  } else if (fn.name === 'target-text') {
    if (args.length !== 1 && args.length !== 2) return null;
  } else return null;

  const values: any[] = [];
  const link = args.shift()!;
  const stringLink = getString(link);
  if (stringLink !== null) values.push(stringLink);
  else {
    const url = getUrl(link, baseUrl);
    if (url === null) return null;
    values.push(url);
  }

  if (fn.name.startsWith('target-counter')) {
    const ident = args.shift()!;
    if (ident.type !== 'ident') return null;
    values.push(ident.value);
    if (fn.name === 'target-counters') {
      // getString() returns a ('string', value) tuple, as Python's get_string(); build.ts reads it from there.
      const separator = getString(args.shift()!);
      if (separator === null) return null;
      values.push(separator);
    }
    let counterStyle: string;
    if (args.length) counterStyle = getKeyword(args.shift()!) ?? 'decimal';
    else counterStyle = 'decimal';
    values.push(counterStyle);
  } else {
    let content: string;
    if (args.length) {
      content = getKeyword(args.shift()!) ?? '';
      if (!['content', 'before', 'after', 'first-letter'].includes(content)) return null;
    } else content = 'content';
    values.push(content);
  }

  return [`${fn.name}()`, values];
}

export function getContentListToken(token: Token, baseUrl: string | null): any {
  const s = getString(token);
  if (s !== null) return s;
  if (getKeyword(token) === 'contents') return ['content()', 'text'];
  const url = getUrl(token, baseUrl);
  if (url !== null) return url;
  const quote = getQuote(token);
  if (quote !== null) return ['quote', quote];
  const target = getTarget(token, baseUrl);
  if (target !== null) return target;
  const fn = new FunctionToken(token);
  if (fn.name === 'element') return checkStringOrElement('element', token);
  if (fn.name === 'leader') {
    const args = fn.splitComma(true);
    if (!args || args.length !== 1) return null;
    const arg = args[0];
    let str: string | null = null;
    if (arg.type === 'ident') {
      str = arg.value === 'dotted' ? '.' : arg.value === 'solid' ? '_' : arg.value === 'space' ? ' ' : null;
      if (str === null) return null;
    } else if (arg.type === 'string') str = arg.value;
    return ['leader()', ['string', str]];
  }
  return null;
}

export function getContentList(tokens: Token[], baseUrl: string | null): any[] | null {
  const parsed = tokens.map((t) => getContentListToken(t, baseUrl));
  return parsed.includes(null) ? null : parsed;
}

register('content', (tokens, baseUrl) => {
  let rest = tokens.slice();
  const images: any[] = [];
  while (rest.length >= 2 && rest[1].type === 'literal' && rest[1].value === ',') {
    const token = rest[0];
    rest = rest.slice(2);
    const parsed = getImage(token, baseUrl ?? null) ?? getUrl(token, baseUrl ?? null);
    if (!parsed) return null;
    images.push(parsed);
  }
  if (rest.length === 0) return null;
  if (rest.length >= 3 && rest[rest.length - 1].type === 'string' && rest[rest.length - 2].type === 'literal'
    && (rest[rest.length - 2] as any).value === '/') {
    rest = rest.slice(0, -2);
  }
  const keyword = getSingleKeyword(rest);
  if (keyword === 'normal' || keyword === 'none') return [keyword];
  return getContentList(rest, baseUrl ?? null);
}, { wantsBaseUrl: true });

function counter(tokens: Token[], defaultInteger: number): any {
  if (getSingleKeyword(tokens) === 'none') return [];
  const results: any[] = [];
  let i = 0;
  let token: Token | undefined = tokens[i++];
  while (token !== undefined) {
    if (token.type !== 'ident') return null;
    const name = token.value;
    if (name === 'none' || name === 'initial' || name === 'inherit') throw new InvalidValues(`Invalid counter name: ${name}`);
    token = tokens[i++];
    let integer = defaultInteger;
    const num = token ? getNumber(token, true, true) : null;
    if (token && num) {
      integer = num.value;
      token = tokens[i++];
    }
    results.push([name, integer]);
  }
  return results;
}
register('counter-increment', (tokens) => counter(tokens, 1));
register('counter-reset', (tokens) => counter(tokens, 0));
register('counter-set', (tokens) => counter(tokens, 0));

const lengthPercentageOrAuto: Validator = singleToken((t) => {
  const l = getLength(t, true, true);
  if (l) return l;
  return getKeyword(t) === 'auto' ? 'auto' : null;
});
register(
  ['top', 'right', 'left', 'bottom', 'inset-block-start', 'inset-block-end', 'inset-inline-start', 'inset-inline-end',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-block-start', 'margin-block-end',
    'margin-inline-start', 'margin-inline-end', 'text-underline-offset'],
  lengthPercentageOrAuto,
);
const widthHeight: Validator = singleToken((t) => {
  const l = getLength(t, false, true);
  if (l) return l;
  return getKeyword(t) === 'auto' ? 'auto' : null;
});
register(['height', 'width', 'block-size', 'inline-size'], widthHeight);
register(['column-gap', 'row-gap'], singleToken((t) => {
  const l = getLength(t, false, true);
  if (l) return l;
  return getKeyword(t) === 'normal' ? 'normal' : null;
}), { unstable: true });
register('column-fill', kw('auto', 'balance'), { unstable: true });
register('direction', kw('ltr', 'rtl'));

register('display', (tokens) => {
  if (tokens.some((t) => t.type !== 'ident')) return null;
  const values = tokens.map((t) => (t as any).value as string);
  if (values.length === 1) {
    const v = values[0];
    if (['none', 'table-caption', 'table-row-group', 'table-cell', 'table-header-group', 'table-footer-group',
      'table-row', 'table-column-group', 'table-column'].includes(v)) return [v];
    if (['inline-table', 'inline-flex', 'inline-grid'].includes(v)) return v.split('-');
    if (v === 'inline-block') return ['inline', 'flow-root'];
  }
  let outside: string | null = null;
  let inside: string | null = null;
  let listItem: string | null = null;
  for (const v of values) {
    if (v === 'block' || v === 'inline') {
      if (outside) return null;
      outside = v;
    } else if (['flow', 'flow-root', 'table', 'flex', 'grid'].includes(v)) {
      if (inside) return null;
      inside = v;
    } else if (v === 'list-item') {
      if (listItem) return null;
      listItem = v;
    } else return null;
  }
  outside = outside ?? 'block';
  inside = inside ?? 'flow';
  if (listItem) {
    if (inside === 'flow' || inside === 'flow-root') return [outside, inside, listItem];
    return null;
  }
  return [outside, inside];
});
register('float', kw('left', 'right', 'inline-start', 'inline-end', 'footnote', 'none'));
register('font-family', commaSeparatedList((tokens) => {
  if (tokens.length === 1 && tokens[0].type === 'string') return tokens[0].value;
  if (tokens.length && tokens.every((t) => t.type === 'ident')) return tokens.map((t) => (t as any).value).join(' ');
  return null;
}));
register('font-kerning', kw('auto', 'normal', 'none'));
register('font-language-override', singleToken((t) => {
  if (getKeyword(t) === 'normal') return 'normal';
  return t.type === 'string' ? t.value : null;
}));

function keywordSet(tokens: Token[], couples: string[][], normalOnly: boolean, noneToo = false): any {
  if (tokens.length === 1) {
    const k = getKeyword(tokens[0]);
    if (k === 'normal' || (noneToo && k === 'none')) return k;
  }
  void normalOnly;
  const values: string[] = [];
  const all = couples.flat();
  for (const t of tokens) {
    if (t.type !== 'ident') return null;
    if (all.includes(t.value)) {
      const concurrent = couples.find((c) => c.includes(t.value))!;
      if (concurrent.some((v) => values.includes(v))) return null;
      values.push(t.value);
    } else return null;
  }
  return values.length ? values : null;
}
register('font-variant-ligatures', (tokens) => keywordSet(tokens, [
  ['common-ligatures', 'no-common-ligatures'], ['historical-ligatures', 'no-historical-ligatures'],
  ['discretionary-ligatures', 'no-discretionary-ligatures'], ['contextual', 'no-contextual']], false, true));
register('font-variant-position', kw('normal', 'sub', 'super'));
register('font-variant-caps', kw('normal', 'small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps'));
register('font-variant-numeric', (tokens) => keywordSet(tokens, [
  ['lining-nums', 'oldstyle-nums'], ['proportional-nums', 'tabular-nums'],
  ['diagonal-fractions', 'stacked-fractions'], ['ordinal'], ['slashed-zero']], false));
register('font-feature-settings', (tokens) => {
  if (tokens.length === 1 && getKeyword(tokens[0]) === 'normal') return 'normal';
  return commaSeparatedList((toks) => {
    let feature: string | null = null;
    let value: number | null = null;
    let t = toks;
    if (t.length === 2) {
      const last = t[1];
      t = t.slice(0, 1);
      if (last.type === 'ident') value = last.value === 'on' ? 1 : last.value === 'off' ? 0 : null;
      else {
        const n = getNumber(last, false, true);
        if (n) value = n.value;
      }
    } else if (t.length === 1) value = 1;
    if (t.length === 1) {
      const s = t[0];
      if (s.type === 'string' && s.value.length === 4 && [...s.value].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7f)) {
        feature = s.value;
      }
    }
    return feature !== null && value !== null ? [feature, value] : null;
  })(tokens);
});
register('font-variant-alternates', kw('normal', 'historical-forms'));
register('font-variant-east-asian', (tokens) => keywordSet(tokens, [
  ['jis78', 'jis83', 'jis90', 'jis04', 'simplified', 'traditional'], ['full-width', 'proportional-width'], ['ruby']], false));
register('font-variation-settings', (tokens) => {
  if (tokens.length === 1 && getKeyword(tokens[0]) === 'normal') return 'normal';
  return commaSeparatedList((toks) => {
    if (toks.length === 2 && toks[0].type === 'string' && toks[1].type === 'number') return [toks[0].value, toks[1].value];
    return null;
  })(tokens);
});
register('font-size', singleToken((t) => {
  const l = getLength(t, false, true);
  if (l) return l;
  const k = getKeyword(t);
  if (k === 'smaller' || k === 'larger') return k;
  if (k && k in FONT_SIZE_KEYWORDS) return k;
  return null;
}));
register('font-style', kw('normal', 'italic', 'oblique'));
register('font-stretch', kw('ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed', 'normal',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded'));
register('font-weight', singleToken((t) => {
  const k = getKeyword(t);
  if (k && ['normal', 'bold', 'bolder', 'lighter'].includes(k)) return k;
  if (t.type === 'number' && t.isInteger && [100, 200, 300, 400, 500, 600, 700, 800, 900].includes(t.value)) return t.value;
  return null;
}));
register('object-fit', kw('fill', 'contain', 'cover', 'none', 'scale-down'));
register('image-resolution', singleToken((t) => getResolution(t)), { unstable: true });
register(['letter-spacing', 'word-spacing'], singleToken((t) => {
  if (getKeyword(t) === 'normal') return 'normal';
  return getLength(t);
}));
register('outline-offset', singleToken((t) => getLength(t)));
register('line-height', singleToken((t) => {
  if (getKeyword(t) === 'normal') return 'normal';
  return getNumber(t, false) ?? getLength(t, false, true);
}));
register('list-style-position', kw('inside', 'outside'));
export const listStyleType: Validator = register('list-style-type', singleToken((t) => {
  if (t.type === 'ident') return t.value;
  if (t.type === 'string') return ['string', t.value];
  if (t.type === 'function' && t.name === 'symbols') {
    const allowed = ['cyclic', 'numeric', 'alphabetic', 'symbolic', 'fixed'];
    const fa = removeWhitespace(t.arguments);
    if (!fa.length) return null;
    const args: string[] = [];
    let index = 0;
    if (fa[0].type === 'ident') {
      if (allowed.includes(fa[0].value)) {
        index = 1;
        args.push(fa[0].value);
      } else return null;
    } else args.push('symbolic');
    if (fa.length < index + 1) return null;
    for (let i = index; i < fa.length; i++) {
      const a = fa[i];
      if (a.type !== 'string') return null;
      args.push(a.value);
    }
    if ((args[0] === 'alphabetic' || args[0] === 'numeric') && args.length < 3) return null;
    return ['symbols()', args];
  }
  return null;
}));
register(['min-width', 'min-height', 'min-block-size', 'min-inline-size'], singleToken((t) => {
  if (getKeyword(t) === 'auto') return 'auto';
  return getLength(t, false, true);
}));
register(
  ['padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-block-start', 'padding-block-end',
    'padding-inline-start', 'padding-inline-end'],
  singleToken((t) => getLength(t, false, true)),
);
register(['max-width', 'max-height', 'max-block-size', 'max-inline-size'], singleToken((t) => {
  const l = getLength(t, false, true);
  if (l) return l;
  return getKeyword(t) === 'none' ? dim(Infinity, 'px') : null;
}));
register('opacity', singleToken((t) => {
  const n = getNumber(t);
  if (n) return Math.min(1, Math.max(0, n.value));
  const p = getPercentage(t);
  if (p) return Math.min(1, Math.max(0, p.value / 100));
  return null;
}));
register('z-index', singleToken((t) => {
  if (getKeyword(t) === 'auto') return 'auto';
  const n = getNumber(t, true, true);
  return n ? n.value : null;
}));
register(['orphans', 'widows'], singleToken((t) => {
  const n = getNumber(t, false, true);
  return n && n.value >= 1 ? n.value : null;
}));
register('column-count', singleToken((t) => {
  const n = getNumber(t, false, true);
  if (n) return n.value >= 1 ? n.value : null;
  return getKeyword(t) === 'auto' ? 'auto' : null;
}), { unstable: true });
register('overflow', kw('auto', 'visible', 'hidden', 'scroll'));
register('text-overflow', kw('clip', 'ellipsis'));
register('position', singleToken((t) => {
  if (t.type === 'function' && (t.name === 'running' || t.name === 'note')) {
    if (t.arguments.length === 1 && t.arguments[0].type === 'ident') return [`${t.name}()`, (t.arguments[0] as any).value];
  }
  const k = getSingleKeyword([t]);
  return k && ['static', 'relative', 'absolute', 'fixed'].includes(k) ? k : null;
}));
register('quotes', (tokens) => {
  if (tokens.length === 1) {
    const k = getKeyword(tokens[0]);
    if (k === 'auto' || k === 'none') return k;
  }
  if (tokens.length && tokens.length % 2 === 0 && tokens.every((t) => t.type === 'string')) {
    const strings = tokens.map((t) => (t as any).value as string);
    return [strings.filter((_, i) => i % 2 === 0), strings.filter((_, i) => i % 2 === 1)];
  }
  return null;
});
register('table-layout', kw('fixed', 'auto'));
register('text-align-all', kw('left', 'right', 'center', 'justify', 'start', 'end'));
register('text-align-last', kw('auto', 'left', 'right', 'center', 'justify', 'start', 'end'));
register('text-decoration-line', (tokens) => {
  const keywords = new Set(tokens.map(getKeyword));
  if (keywords.size === 1 && keywords.has('none')) return 'none';
  const allowed = new Set(['underline', 'overline', 'line-through', 'blink']);
  if (tokens.length === keywords.size && [...keywords].every((k) => k && allowed.has(k))) return keywords;
  return null;
});
register('text-decoration-style', singleKeyword((k) => k !== null && ['solid', 'double', 'dotted', 'dashed', 'wavy'].includes(k)));
register('text-decoration-thickness', singleToken((t) => {
  const l = getLength(t, true, true);
  if (l) return l;
  const k = getKeyword(t);
  return k === 'auto' || k === 'from-font' ? k : null;
}));
register('text-indent', singleToken((t) => getLength(t, true, true)));
register('text-transform', kw('none', 'uppercase', 'lowercase', 'capitalize', 'full-width'));
register('vertical-align', singleToken((t) => {
  const l = getLength(t, true, true);
  if (l) return l;
  const k = getKeyword(t);
  return k && ['baseline', 'middle', 'sub', 'super', 'text-top', 'text-bottom', 'top', 'bottom'].includes(k) ? k : null;
}));
register('visibility', kw('visible', 'hidden', 'collapse'));
register('white-space', kw('normal', 'pre', 'nowrap', 'pre-wrap', 'pre-line'));
register('overflow-wrap', kw('anywhere', 'normal', 'break-word'));
register('word-break', kw('normal', 'break-all'));
register('flex-basis', singleToken((t) => {
  const b = widthHeight([t]);
  if (b !== null) return b;
  return getKeyword(t) === 'content' ? 'content' : null;
}));
register('flex-direction', kw('row', 'row-reverse', 'column', 'column-reverse'));
register(['flex-grow', 'flex-shrink'], singleToken((t) => {
  const n = getNumber(t);
  return n ? n.value : null;
}));
register('flex-wrap', kw('nowrap', 'wrap', 'wrap-reverse'));

// Box alignment
function alignment(
  singles: string[], safeTargets: string[], opts: { baselinePair?: boolean; legacy?: boolean } = {},
): Validator {
  return (tokens) => {
    if (tokens.length === 1) {
      const k = getKeyword(tokens[0]);
      if (k && singles.includes(k)) return [k];
      if (k === 'baseline' && opts.baselinePair !== false) return ['first', k];
    } else if (tokens.length === 2) {
      const k = tokens.map(getKeyword);
      if (k[0] === 'safe' || k[0] === 'unsafe') {
        if (k[1] && safeTargets.includes(k[1])) return k;
      } else if (opts.baselinePair !== false && k.includes('baseline')) {
        if (k.includes('first') || k.includes('last')) return k;
      } else if (opts.legacy && k.includes('legacy')) {
        if (k.some((x) => x === 'left' || x === 'right' || x === 'center')) return k;
      }
    }
    return null;
  };
}
register('justify-content', alignment(
  ['center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'normal', 'flex-start', 'flex-end', 'start', 'end', 'left', 'right'],
  ['center', 'start', 'end', 'flex-start', 'flex-end', 'left', 'right'], { baselinePair: false }));
register('justify-items', alignment(
  ['normal', 'stretch', 'center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end', 'left', 'right', 'legacy'],
  ['center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end', 'left', 'right'], { legacy: true }));
register('justify-self', alignment(
  ['auto', 'normal', 'stretch', 'center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end', 'left', 'right'],
  ['center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end', 'left', 'right']));
register('align-items', alignment(
  ['normal', 'stretch', 'center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end'],
  ['center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end']));
register('align-self', alignment(
  ['auto', 'normal', 'stretch', 'center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end'],
  ['center', 'start', 'end', 'self-start', 'self-end', 'flex-start', 'flex-end']));
register('align-content', alignment(
  ['center', 'space-between', 'space-around', 'space-evenly', 'stretch', 'normal', 'flex-start', 'flex-end', 'start', 'end'],
  ['center', 'start', 'end', 'flex-start', 'flex-end']));
register('order', singleToken((t) => {
  const n = getNumber(t, true, true);
  return n ? n.value : null;
}));
register('image-rendering', kw('auto', 'crisp-edges', 'pixelated'), { unstable: true });
register('image-orientation', (tokens) => {
  const keyword = getSingleKeyword(tokens);
  if (keyword === 'none' || keyword === 'from-image') return keyword;
  let angle: number | null = null;
  let flip: boolean | null = null;
  for (const t of tokens) {
    if (getKeyword(t) === 'flip') {
      if (flip !== null) return null;
      flip = true;
      continue;
    }
    if (angle === null) {
      angle = getAngle(t);
      if (angle !== null) continue;
    }
    return null;
  }
  return [angle ?? 0, flip ?? false];
}, { unstable: true });
register('size', (tokens) => {
  const lengths = tokens.map((t) => getLength(t, false));
  if (lengths.every((l) => l !== null)) {
    if (lengths.length === 1) return [lengths[0], lengths[0]];
    if (lengths.length === 2) return lengths;
  }
  const keywords = tokens.map(getKeyword);
  if (keywords.length === 1) {
    const k = keywords[0]!;
    if (k in PAGE_SIZES) return PAGE_SIZES[k];
    if (k === 'auto' || k === 'portrait') return INITIAL_PAGE_SIZE;
    if (k === 'landscape') return [INITIAL_PAGE_SIZE[1], INITIAL_PAGE_SIZE[0]];
  }
  if (keywords.length === 2) {
    let pageSize: string | null;
    let orientation: string;
    if (keywords[0] === 'portrait' || keywords[0] === 'landscape') {
      orientation = keywords[0];
      pageSize = keywords[1];
    } else if (keywords[1] === 'portrait' || keywords[1] === 'landscape') {
      orientation = keywords[1];
      pageSize = keywords[0];
    } else return null;
    if (pageSize && pageSize in PAGE_SIZES) {
      const wh = PAGE_SIZES[pageSize];
      return orientation === 'portrait' ? wh : [wh[1], wh[0]];
    }
  }
  return null;
}, { unstable: true });
register('anchor', singleToken((t) => (t.type === 'string' ? t.value : null)), { proprietary: true });
register('tab-size', singleToken((t) => {
  if (t.type === 'number' && t.isInteger && t.value) return t.value;
  return getLength(t, false);
}));
register('hyphens', singleToken((t) => {
  const k = getKeyword(t);
  return k === 'none' || k === 'manual' || k === 'auto' ? k : null;
}), { unstable: true });
register('hyphenate-character', singleToken((t) => {
  if (getKeyword(t) === 'auto') return '‐';
  return t.type === 'string' ? t.value : null;
}), { unstable: true });
register('hyphenate-limit-zone', singleToken((t) => getLength(t, false, true)), { unstable: true });
register('hyphenate-limit-chars', (tokens) => {
  const num = (t: Token): number | null => getNumber(t, true, true)?.value ?? null;
  if (tokens.length === 1) {
    if (getKeyword(tokens[0]) === 'auto') return [5, 2, 2];
    const n = num(tokens[0]);
    if (n !== null) return [n, 2, 2];
  } else if (tokens.length === 2) {
    const [total, left] = tokens;
    const tn = num(total);
    const ln = num(left);
    if (tn !== null) {
      if (ln !== null) return [tn, ln, ln];
      if (getKeyword(left) === 'auto') return [tn, 2, 2];
    } else if (getKeyword(total) === 'auto') {
      if (ln !== null) return [5, ln, ln];
      if (getKeyword(left) === 'auto') return [5, 2, 2];
    }
  } else if (tokens.length === 3) {
    const result: number[] = [];
    for (let i = 0; i < 3; i++) {
      if (getKeyword(tokens[i]) === 'auto') result.push(i === 0 ? 5 : 2);
      else {
        const n = num(tokens[i]);
        if (n === null) return null;
        result.push(n);
      }
    }
    return result;
  }
  return null;
}, { unstable: true });
register('lang', singleToken((t) => {
  if (getKeyword(t) === 'none') return 'none';
  return t.type === 'string' ? ['string', t.value] : null;
}), { proprietary: true });
register('bookmark-label', (tokens, baseUrl) => {
  const parsed = tokens.map((t) => getContentListToken(t, baseUrl ?? null));
  return parsed.includes(null) ? null : parsed;
}, { unstable: true, wantsBaseUrl: true });
register('bookmark-level', singleToken((t) => {
  const n = getNumber(t, false, true);
  if (n) return n.value >= 1 ? n.value : null;
  return getKeyword(t) === 'none' ? 'none' : null;
}), { unstable: true });
register('bookmark-state', kw('open', 'closed'), { unstable: true });
register('footnote-display', kw('block', 'inline', 'compact'), { unstable: true });
register('footnote-policy', kw('auto', 'line', 'block'), { unstable: true });
register('string-set', commaSeparatedList((tokens, baseUrl) => {
  if (tokens.length >= 2) {
    const name = getCustomIdent(tokens[0]);
    if (name === null) return null;
    const parsed = tokens.slice(1).map((t) => getContentListToken(t, baseUrl ?? null));
    return parsed.includes(null) ? null : [name, parsed];
  }
  if (tokens.length && getKeyword(tokens[0]) === 'none') return ['none', []];
  return null;
}), { unstable: true, wantsBaseUrl: true });
register('transform', (tokens) => {
  if (getSingleKeyword(tokens) === 'none') return [];
  const transforms: any[] = [];
  for (const token of tokens) {
    const fn = new FunctionToken(token);
    const args = fn.splitComma(true);
    if (args === null) return null;
    const allNumbers = args.length > 0 && args.every((a) => a.type === 'number');
    const num = (a: Token): number => (a as any).value;
    if (args.length === 1) {
      const angle = getAngle(args[0]);
      const length = getLength(args[0], true, true);
      if (fn.name === 'rotate' && angle !== null) transforms.push([fn.name, angle]);
      else if ((fn.name === 'skewx' || fn.name === 'skew') && angle !== null) transforms.push(['skew', [angle, 0]]);
      else if (fn.name === 'skewy' && angle !== null) transforms.push(['skew', [0, angle]]);
      else if ((fn.name === 'translatex' || fn.name === 'translate') && length) transforms.push(['translate', [length, ZERO_PIXELS]]);
      else if (fn.name === 'translatey' && length) transforms.push(['translate', [ZERO_PIXELS, length]]);
      else if (fn.name === 'scalex' && allNumbers) transforms.push(['scale', [num(args[0]), 1]]);
      else if (fn.name === 'scaley' && allNumbers) transforms.push(['scale', [1, num(args[0])]]);
      else if (fn.name === 'scale' && allNumbers) transforms.push(['scale', [num(args[0]), num(args[0])]]);
      else return null;
    } else if (args.length === 2) {
      if (fn.name === 'scale' && allNumbers) transforms.push([fn.name, args.map(num)]);
      else if (fn.name === 'translate') {
        const lengths = args.map((a) => getLength(a, true, true));
        if (lengths.every((l) => l !== null)) transforms.push([fn.name, lengths]);
        else return null;
      } else if (fn.name === 'skew') {
        const angles = args.map(getAngle);
        if (angles.every((a) => a !== null)) transforms.push([fn.name, angles]);
        else return null;
      } else return null;
    } else if (args.length === 6 && fn.name === 'matrix' && allNumbers) {
      transforms.push([fn.name, args.map(num)]);
    } else return null;
  }
  return transforms;
});
register('appearance', singleToken((t) => {
  const k = getKeyword(t);
  return k === 'none' || k === 'auto' ? k : null;
}));
register('color-scheme', (tokens) => {
  if (tokens.length === 1) {
    const k = getSingleKeyword(tokens);
    if (k === 'normal') return k;
    if (k !== 'only') return [k];
    return null;
  }
  const keywords: string[] = [];
  let only = false;
  for (let i = 0; i < tokens.length; i++) {
    const k = getKeyword(tokens[i]);
    if (k === 'only') {
      if (only || (i !== 0 && i !== tokens.length - 1)) return null;
      only = true;
    } else if (k === 'normal') return null;
    else if (k) keywords.push(k);
    else return null;
  }
  return keywords.length ? keywords : null;
});

export { INITIAL_VALUES, parseComponentValueList };
// --- Grid -------------------------------------------------------------------
// Ports weasyprint/css/validation/properties.py (grid section). Tuples are arrays.

const stripWs = (tokens: Token[]): Token[] => removeWhitespace(tokens);

/** Python: _inflexible_breadth. */
function inflexibleBreadth(token: Token): any {
  const keyword = getKeyword(token);
  if (keyword === 'auto' || keyword === 'min-content' || keyword === 'max-content') return keyword;
  if (keyword) return null;
  return getLength(token, false, true);
}

/** Python: _track_breadth. */
function trackBreadth(token: Token): any {
  if (token.type === 'dimension' && token.value >= 0 && token.unit.toLowerCase() === 'fr') {
    return dim(token.value, token.unit.toLowerCase());
  }
  return inflexibleBreadth(token);
}

/** Python: _track_size. */
function trackSize(token: Token): any {
  const breadth = trackBreadth(token);
  if (breadth) return breadth;
  const fn = new FunctionToken(token);
  const args = fn.splitComma(true) ?? [];
  if (fn.name === 'minmax') {
    if (args.length === 2) {
      const inflexible = inflexibleBreadth(args[0]);
      const track = trackBreadth(args[1]);
      if (inflexible && track) return ['minmax()', inflexible, track];
    }
  } else if (fn.name === 'fit-content') {
    if (args.length === 1) {
      const length = getLength(args[0], false, true);
      if (length) return ['fit-content()', length];
    }
  }
  return null;
}

/** Python: _fixed_size. */
function fixedSize(token: Token): any {
  const length = getLength(token, false, true);
  if (length) return length;
  const fn = new FunctionToken(token);
  const args = fn.splitComma(true) ?? [];
  if (fn.name === 'minmax' && args.length === 2) {
    const len = getLength(args[0], false, true);
    if (len) {
      const track = trackBreadth(args[1]);
      if (track) return ['minmax()', len, track];
    }
    const keyword = getKeyword(args[0]);
    if (keyword === 'min-content' || keyword === 'max-content' || keyword === 'auto' || len) {
      const fixed = getLength(args[1], false, true);
      if (fixed) return ['minmax()', len || keyword, fixed];
    }
  }
  return null;
}

/** Python: _line_names. */
function lineNames(token: Token): string[] | null {
  if (token.type === '[]') {
    const names: string[] = [];
    for (const t of token.content) {
      if (t.type === 'ident') names.push(t.value);
      else if (t.type !== 'whitespace') return null;
    }
    return names;
  }
  return null;
}

register('grid-auto-columns', gridAuto);
register('grid-auto-rows', gridAuto);
function gridAuto(tokensIn: Token[]): any {
  const out: any[] = [];
  for (const token of stripWs(tokensIn)) {
    const size = trackSize(token);
    if (!size) return null;
    out.push(size);
  }
  return out;
}

register('grid-auto-flow', (tokensIn) => {
  const tokens = stripWs(tokensIn);
  if (tokens.length === 1) {
    const keyword = getKeyword(tokens[0]);
    if (keyword === 'row' || keyword === 'column') return [keyword];
    if (keyword === 'dense') return ['dense', 'row'];
  } else if (tokens.length === 2) {
    const keywords = tokens.map((t) => getKeyword(t));
    if (keywords.includes('dense') && (keywords.includes('row') || keywords.includes('column'))) return keywords;
  }
  return null;
});

register(['grid-template-columns', 'grid-template-rows'], gridTemplate);
function gridTemplate(tokensIn: Token[]): any {
  const tokens = stripWs(tokensIn);
  if (tokens.length === 1 && getKeyword(tokens[0]) === 'none') return 'none';
  if (tokens.length === 0) return null;
  const out: any[] = [];
  if (getKeyword(tokens[0]) === 'subgrid') {
    out.push('subgrid');
    const subgrid: any[] = [];
    for (const token of tokens.slice(1)) {
      const names = lineNames(token);
      if (names !== null) {
        subgrid.push(names);
        continue;
      }
      const fn = new FunctionToken(token);
      const args = fn.splitComma(false);
      if (args === null || args.length !== 2) return null;
      const [repeatPart, tracks] = args;
      if (repeatPart.length !== 1 || !tracks.length) return null;
      const repeat = repeatPart[0];
      if (fn.name === 'repeat') {
        let number: any;
        if (repeat.type === 'number' && Number.isInteger(repeat.value) && repeat.value >= 1) number = repeat.value;
        else if (getKeyword(repeat) === 'auto-fill') number = 'auto-fill';
        else return null;
        const namesList: string[][] = [];
        for (const argument of tracks) {
          const names = lineNames(argument);
          if (names !== null) namesList.push(names);
        }
        subgrid.push(['repeat()', number, namesList]);
        continue;
      }
      return null;
    }
    out.push(subgrid);
    return out;
  }

  let includesAutoRepeat = false;
  let includesTrack = false;
  let lastIsLineName = false;
  for (const token of tokens) {
    const names = lineNames(token);
    if (names !== null) {
      if (lastIsLineName) return null;
      lastIsLineName = true;
      out.push(names);
      continue;
    }
    const fixed = fixedSize(token);
    if (fixed) {
      if (!lastIsLineName) out.push([]);
      lastIsLineName = false;
      out.push(fixed);
      continue;
    }
    const track = trackSize(token);
    if (track) {
      if (!lastIsLineName) out.push([]);
      lastIsLineName = false;
      out.push(track);
      includesTrack = true;
      continue;
    }
    const fn = new FunctionToken(token);
    const args = fn.splitComma(false);
    if (args === null || args.length !== 2) return null;
    const [repeatPart, tracks] = args;
    if (repeatPart.length !== 1 || !tracks.length) return null;
    const repeat = repeatPart[0];
    if (fn.name !== 'repeat') return null;
    let number: any;
    const numberToken = getNumber(repeat, false, true);
    if (numberToken && numberToken.value >= 1) {
      number = numberToken.value;
    } else if (getKeyword(repeat) === 'auto-fill' || getKeyword(repeat) === 'auto-fit') {
      // auto-repeat
      if (includesAutoRepeat) return null;
      number = getKeyword(repeat);
      includesAutoRepeat = true;
    } else return null;

    const namesAndSizes: any[] = [];
    let repeatLastIsLineName = false;
    for (const arg of tracks) {
      const names2 = lineNames(arg);
      if (names2 !== null) {
        if (repeatLastIsLineName) return null;
        namesAndSizes.push(names2);
        repeatLastIsLineName = true;
        continue;
      }
      const fixed2 = fixedSize(arg);
      if (fixed2) {
        if (!repeatLastIsLineName) namesAndSizes.push([]);
        repeatLastIsLineName = false;
        namesAndSizes.push(fixed2);
        continue;
      }
      const track2 = trackSize(arg);
      if (track2) {
        includesTrack = true;
        if (!repeatLastIsLineName) namesAndSizes.push([]);
        repeatLastIsLineName = false;
        namesAndSizes.push(track2);
        continue;
      }
      return null;
    }
    if (!lastIsLineName) out.push([]);
    lastIsLineName = false;
    if (!repeatLastIsLineName) namesAndSizes.push([]);
    out.push(['repeat()', number, namesAndSizes]);
  }
  if (includesAutoRepeat && includesTrack) return null;
  if (!lastIsLineName) out.push([]);
  return out;
}

register('grid-template-areas', (tokensIn) => {
  const tokens = stripWs(tokensIn);
  if (tokens.length === 1 && getKeyword(tokens[0]) === 'none') return 'none';
  const gridAreas: Array<Array<string | null>> = [];
  for (const token of tokens) {
    if (token.type !== 'string') return null;
    const row: Array<string | null> = [];
    let lastIsDot = false;
    for (const value of parseComponentValueList(token.value)) {
      if (value.type === 'ident') {
        row.push(value.value);
        lastIsDot = false;
      } else if (value.type === 'literal' && value.value === '.') {
        if (lastIsDot) continue;
        row.push(null);
        lastIsDot = true;
      } else if (value.type === 'whitespace') {
        lastIsDot = false;
      } else return null;
    }
    if (!row.length) return null;
    gridAreas.push(row);
  }
  // check row / column have the same sizes
  if (new Set(gridAreas.map((r) => r.length)).size !== 1) return null;
  // check areas are continuous rectangles
  const coordinates = new Set<string>();
  const areas = new Set<string>();
  const key = (x: number, y: number) => `${x},${y}`;
  for (let y = 0; y < gridAreas.length; y++) {
    const row = gridAreas[y];
    for (let x = 0; x < row.length; x++) {
      const area = row[x];
      if (coordinates.has(key(x, y)) || area === null) continue;
      if (areas.has(area)) return null;
      areas.add(area);
      coordinates.add(key(x, y));
      let nx = x;
      let broke = false;
      for (nx = x + 1; nx < row.length; nx++) {
        if (row[nx] !== area) {
          broke = true;
          break;
        }
        coordinates.add(key(nx, y));
      }
      if (!broke) nx += 1;
      for (let ny = y + 1; ny < gridAreas.length; ny++) {
        const slice = gridAreas[ny].slice(x, nx);
        if (slice.length && slice.every((a) => a === area)) {
          for (let nnx = x; nnx < nx; nnx++) coordinates.add(key(nnx, ny));
        } else break;
      }
    }
  }
  return gridAreas;
});

register(['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'], (tokensIn) => {
  const tokens = stripWs(tokensIn);
  if (tokens.length === 1) {
    const token = tokens[0];
    const keyword = getKeyword(token);
    if (keyword) {
      if (keyword === 'auto') return keyword;
      if (keyword !== 'span') return [null, null, (token as any).value];
    } else {
      const number = getNumber(token, true, true);
      if (number) {
        if (number.value !== 0) return [null, number.value, null];
      }
    }
    return null;
  }
  let number: number | null = null;
  let ident: string | null = null;
  let span: string | null = null;
  for (const token of tokens) {
    const keyword = getKeyword(token);
    if (keyword) {
      if (keyword === 'auto') return null;
      if (keyword === 'span') {
        if (span === null) {
          span = 'span';
          continue;
        }
      } else if (ident === null) {
        ident = (token as any).value;
        continue;
      }
    } else {
      const item = getNumber(token, true, true);
      if (item && item.value !== 0 && number === null) {
        number = item.value;
        continue;
      }
    }
    return null;
  }
  if (span) {
    if (number !== null && number < 0) return null;
    if (ident || number) return [span, number, ident];
    return null;
  }
  if (number) return [span, number, ident];
  return null;
});
