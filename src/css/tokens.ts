import { checkMath, PercentageInMath, RelativeLengthInMath, resolveMath } from './math.ts';
// SPDX-License-Identifier: BSD-3-Clause

/** CSS token parsers (mirrors weasyprint/css/tokens.py; math functions not supported yet). */
import type { Token } from './parser.ts';
import { parseColor } from './color.ts';
import { dim } from './properties.ts';
import type { Dimension } from './properties.ts';
import { ANGLE_TO_RADIANS, LENGTH_UNITS, RESOLUTION_TO_DPPX } from './units.ts';
import { getUrlTuple } from '../urls.ts';
import { LinearGradient, RadialGradient } from '../gradients.ts';
import type { UrlTuple } from '../urls.ts';

export class InvalidValues extends Error {}

export const ZERO_PERCENT = dim(0, '%');
export const FIFTY_PERCENT = dim(50, '%');
export const HUNDRED_PERCENT = dim(100, '%');
export const BACKGROUND_POSITION_PERCENTAGES: Record<string, Dimension> = {
  top: ZERO_PERCENT, left: ZERO_PERCENT, center: FIFTY_PERCENT, bottom: HUNDRED_PERCENT, right: HUNDRED_PERCENT,
};

export const isMath = (t: Token): boolean =>
  t.type === 'function' && ['calc', 'min', 'max', 'round', 'mod', 'rem', 'sin', 'cos', 'tan', 'asin', 'acos',
    'atan', 'atan2', 'clamp', 'pow', 'sqrt', 'hypot', 'log', 'exp', 'abs', 'sign'].includes(t.lowerName);
export const isVar = (t: Token): boolean => {
  if (t.type === 'function') {
    return t.lowerName === 'var' || t.arguments.some(isVar);
  }
  if (t.type === '()' || t.type === '[]' || t.type === '{}') return t.content.some(isVar);
  return false;
};

export function removeWhitespace(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
}

export function splitOnComma(tokens: readonly Token[]): Token[][] {
  const parts: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.type === 'literal' && t.value === ',') {
      parts.push(cur);
      cur = [];
    } else cur.push(t);
  }
  parts.push(cur);
  return parts;
}

export function getKeyword(token: Token): string | null {
  return token.type === 'ident' ? token.lowerValue : null;
}
export function getCustomIdent(token: Token): string | null {
  return token.type === 'ident' ? token.value : null;
}
export function getSingleKeyword(tokens: readonly Token[]): string | null {
  if (tokens.length === 1 && tokens[0].type === 'ident') return tokens[0].lowerValue;
  return null;
}

export function getNumber(token: Token, negative = true, integer = false): Dimension | null {
  if (token.type !== 'number') return null;
  if (integer) {
    if (token.isInteger && (negative || token.value >= 0)) return dim(token.value, null);
    return null;
  }
  if (negative || token.value >= 0) return dim(token.value, null);
  return null;
}

export function getPercentage(token: Token, negative = true): Dimension | null {
  if (token.type === 'percentage' && (negative || token.value >= 0)) return dim(token.value, '%');
  return null;
}

export function getLength(token: Token, negative = true, percentage = false): Dimension | null {
  if (checkMath(token)) {
    // Python: resolve_math(token) or token. Keep the function token when it needs a computed style.
    let resolved: any = null;
    try {
      resolved = resolveMath(token);
    } catch (error) {
      if (error instanceof PercentageInMath) return percentage ? (token as any) : null;
      if (error instanceof RelativeLengthInMath) return token as any;
      throw error;
    }
    if (resolved !== null) {
      token = resolved;
      // Range clamp.
      if (!negative && token.type !== 'function' && token.type !== 'number' && (token as any).value < 0) {
        token = { ...(token as any), value: 0 } as Token;
      }
    }
  }
  if (percentage && token.type === 'percentage') {
    if (negative || token.value >= 0) return dim(token.value, '%');
  }
  if (token.type === 'dimension' && LENGTH_UNITS.has(token.lowerUnit)) {
    if (negative || token.value >= 0) return dim(token.value, token.lowerUnit);
  }
  if (token.type === 'number' && token.value === 0) return dim(0, null);
  return null;
}

export function getAngle(token: Token): number | null {
  if (token.type === 'number' && token.value === 0) return 0;
  if (token.type === 'dimension') {
    const f = ANGLE_TO_RADIANS[token.lowerUnit];
    if (f !== undefined) return token.value * f;
  }
  return null;
}

export function getResolution(token: Token): number | null {
  if (token.type === 'dimension') {
    const f = RESOLUTION_TO_DPPX[token.lowerUnit];
    if (f !== undefined) return token.value * f;
  }
  return null;
}

export type UrlValue = ['url', UrlTuple];

export function getUrl(token: Token, baseUrl: string | null): UrlValue | null {
  let url: UrlTuple | null;
  if (token.type === 'url') url = getUrlTuple(token.value, baseUrl);
  else if (token.type === 'function' && token.name === 'url' && token.arguments.length >= 1 && token.arguments.length <= 2) {
    const a = token.arguments[0];
    url = getUrlTuple(a.type === 'string' ? a.value : '', baseUrl);
  } else return null;
  if (url === null) throw new InvalidValues('Relative URI reference without a base URI');
  return ['url', url];
}

/** <image>: only url() supported so far (gradients: TODO). */
/** Python: DIRECTION_KEYWORDS: ('angle', radians) clockwise from up, or ('corner', name). */
const DIRECTION_KEYWORDS: Record<string, [string, any]> = {
  'to top': ['angle', 0],
  'to right': ['angle', Math.PI / 2],
  'to bottom': ['angle', Math.PI],
  'to left': ['angle', (Math.PI * 3) / 2],
  'to top left': ['corner', 'top_left'],
  'to left top': ['corner', 'top_left'],
  'to top right': ['corner', 'top_right'],
  'to right top': ['corner', 'top_right'],
  'to bottom left': ['corner', 'bottom_left'],
  'to left bottom': ['corner', 'bottom_left'],
  'to bottom right': ['corner', 'bottom_right'],
  'to right bottom': ['corner', 'bottom_right'],
};

/** Python: parse_color_hint. */
function parseColorHint(tokens: Token[]): Dimension | null {
  if (tokens.length === 1) return getLength(tokens[0], true, true);
  return null;
}

/** Python: parse_color_stop. Returns [color, position|null] or throws InvalidValues. */
function parseColorStop(tokens: Token[]): [any, Dimension | null] {
  if (tokens.length === 1) {
    const color = parseColor(tokens[0]);
    if (color === 'currentcolor') {
      // TODO: return the current color instead (the reference uses black).
      return [parseColor('black'), null];
    }
    if (color !== null) return [color, null];
  } else if (tokens.length === 2) {
    const color = parseColor(tokens[0]);
    const position = getLength(tokens[1], true, true);
    if (color !== null && position !== null) return [color, position];
  }
  throw new InvalidValues();
}

/** Python: parse_color_stops_and_hints. */
function parseColorStopsAndHints(colorStopsHints: Token[][]): [Array<[any, Dimension | null]>, Dimension[]] {
  if (!colorStopsHints.length) throw new InvalidValues();
  const colorStops: Array<[any, Dimension | null]> = [parseColorStop(colorStopsHints[0])];
  const colorHints: Dimension[] = [];
  let previousWasColorStop = true;
  for (const tokens of colorStopsHints.slice(1)) {
    const hint = parseColorHint(tokens);
    if (hint) {
      colorHints.push(hint);
      previousWasColorStop = false;
    } else if (previousWasColorStop) {
      colorHints.push(FIFTY_PERCENT);
      colorStops.push(parseColorStop(tokens));
      previousWasColorStop = true;
    } else {
      colorStops.push(parseColorStop(tokens));
      previousWasColorStop = true;
    }
  }
  if (!previousWasColorStop) throw new InvalidValues();
  return [colorStops, colorHints];
}

/** Python: parse_linear_gradient_parameters. Returns [direction, remaining argument lists]. */
function parseLinearGradientParameters(args: Token[][]): [[string, any], Token[][]] {
  const firstArg = args[0];
  if (firstArg.length === 1) {
    const angle = getAngle(firstArg[0]);
    if (angle !== null) return [['angle', angle], args.slice(1)];
  } else {
    const key = firstArg.map((t) => getKeyword(t) ?? '').join(' ');
    const result = DIRECTION_KEYWORDS[key];
    if (result !== undefined) return [result, args.slice(1)];
  }
  return [['angle', Math.PI], args]; // Default direction is 'to bottom'
}

/** Python: parse_radial_gradient_parameters. Returns [shape, size, position, colorStops] or null. */
function parseRadialGradientParameters(args: Token[][]): [string, [string, any], any[], Token[][]] | null {
  let shape: string | null = null;
  let position: any[] | null = null;
  let size: [string, any] | null = null;
  let sizeShape: string | null = null;
  const stack: Token[] = [...args[0]].reverse();
  while (stack.length) {
    const token = stack.pop()!;
    const keyword = getKeyword(token);
    if (keyword === 'at') {
      position = parsePosition(stack.slice().reverse());
      if (position === null) return null;
      break;
    } else if ((keyword === 'circle' || keyword === 'ellipse') && shape === null) {
      shape = keyword;
    } else if (['closest-corner', 'farthest-corner', 'closest-side', 'farthest-side'].includes(keyword ?? '') && size === null) {
      size = ['keyword', keyword];
    } else {
      if (stack.length && size === null) {
        const length1 = getLength(token, true, true);
        const length2 = getLength(stack[stack.length - 1], true, true);
        if (length1 !== null && length2 !== null) {
          size = ['explicit', [length1, length2]];
          sizeShape = 'ellipse';
          stack.pop();
        }
      }
      if (size === null) {
        const length1 = getLength(token, true, false);
        if (length1 !== null) {
          size = ['explicit', [length1, length1]];
          sizeShape = 'circle';
        }
      }
      if (size === null) return null;
    }
  }
  if (shape === 'circle' && sizeShape === 'ellipse') return null;
  return [shape ?? sizeShape ?? 'ellipse', size ?? ['keyword', 'farthest-corner'],
    position ?? ['left', FIFTY_PERCENT, 'top', FIFTY_PERCENT], args.slice(1)];
}

/** Python: split_on_comma on the arguments of a gradient function, one token list per argument. */
const splitArgs = (fn: FunctionToken): Token[][] => ((fn.splitComma(false) ?? []) as unknown) as Token[][];

export function getImage(token: Token, baseUrl: string | null): any {
  const parsed = getUrl(token, baseUrl);
  if (parsed && parsed[1][0] === 'external') return ['url', parsed[1][1]];
  if (token.type !== 'function') return null;
  const fn = new FunctionToken(token);
  const args = splitArgs(fn);
  if (!args.length) return null;
  const repeating = fn.name?.startsWith('repeating-') ?? false;
  // Gradient classes live in gradients.ts (Python: images.LinearGradient / RadialGradient).
  if (fn.name === 'linear-gradient' || fn.name === 'repeating-linear-gradient') {
    const [direction, colorStopArgs] = parseLinearGradientParameters(args);
    const [colorStops, colorHints] = parseColorStopsAndHints(colorStopArgs);
    return ['linear-gradient', new LinearGradient(colorStops, direction, repeating, colorHints)];
  }
  if (fn.name === 'radial-gradient' || fn.name === 'repeating-radial-gradient') {
    const result = parseRadialGradientParameters(args);
    let shape: string;
    let size: [string, any];
    let position: any[];
    let colorStopArgs: Token[][];
    if (result !== null) {
      [shape, size, position, colorStopArgs] = result;
    } else {
      shape = 'ellipse';
      size = ['keyword', 'farthest-corner'];
      position = ['left', FIFTY_PERCENT, 'top', FIFTY_PERCENT];
      colorStopArgs = args;
    }
    const [colorStops, colorHints] = parseColorStopsAndHints(colorStopArgs);
    return ['radial-gradient', new RadialGradient(colorStops, shape, size, position, repeating, colorHints)];
  }
  return null;
}

export function parse2dPosition(tokens: Token[]): [Dimension, Dimension] | null {
  if (tokens.length === 1) {
    tokens = [tokens[0], { type: 'ident', value: 'center', lowerValue: 'center' }];
  } else if (tokens.length !== 2) return null;
  const [t1, t2] = tokens;
  const l1 = getLength(t1, true, true);
  const l2 = getLength(t2, true, true);
  if (l1 && l2) return [l1, l2];
  const k1 = getKeyword(t1);
  const k2 = getKeyword(t2);
  const P = BACKGROUND_POSITION_PERCENTAGES;
  if (l1 && k2 && ['top', 'center', 'bottom'].includes(k2)) return [l1, P[k2]];
  if (l2 && k1 && ['left', 'center', 'right'].includes(k1)) return [P[k1], l2];
  if (k1 && k2 && ['left', 'center', 'right'].includes(k1) && ['top', 'center', 'bottom'].includes(k2)) return [P[k1], P[k2]];
  if (k1 && k2 && ['top', 'center', 'bottom'].includes(k1) && ['left', 'center', 'right'].includes(k2)) return [P[k2], P[k1]];
  return null;
}

export function parsePosition(tokens: Token[]): any[] | null {
  const result = parse2dPosition(tokens);
  if (result) return ['left', result[0], 'top', result[1]];
  if (tokens.length === 4) {
    const k1 = getKeyword(tokens[0]);
    const k2 = getKeyword(tokens[2]);
    const l1 = getLength(tokens[1], true, true);
    const l2 = getLength(tokens[3], true, true);
    if (l1 && l2) {
      if (k1 && k2 && ['left', 'right'].includes(k1) && ['top', 'bottom'].includes(k2)) return [k1, l1, k2, l2];
      if (k1 && k2 && ['left', 'right'].includes(k2) && ['top', 'bottom'].includes(k1)) return [k2, l2, k1, l1];
    }
  }
  if (tokens.length === 3) {
    let length = getLength(tokens[2], true, true);
    let keyword: string | null;
    let other: string | null;
    if (length) {
      keyword = getKeyword(tokens[1]);
      other = getKeyword(tokens[0]);
    } else {
      length = getLength(tokens[1], true, true);
      other = getKeyword(tokens[2]);
      keyword = getKeyword(tokens[0]);
    }
    if (length) {
      if (other === 'center') {
        if (keyword && ['top', 'bottom'].includes(keyword)) return ['left', FIFTY_PERCENT, keyword, length];
        if (keyword && ['left', 'right'].includes(keyword)) return [keyword, length, 'top', FIFTY_PERCENT];
      } else if (keyword && other && ['left', 'right'].includes(keyword) && ['top', 'bottom'].includes(other)) {
        return [keyword, length, other, ZERO_PERCENT];
      } else if (keyword && other && ['top', 'bottom'].includes(keyword) && ['left', 'right'].includes(other)) {
        return [other, ZERO_PERCENT, keyword, length];
      }
    }
  }
  return null;
}

/** Function-token helper (mirrors css/functions.py Function). */
export class FunctionToken {
  name: string | null;
  arguments: Token[] | null;
  constructor(token: Token) {
    if (token.type === 'function') {
      this.name = token.lowerName;
      this.arguments = token.arguments;
    } else {
      this.name = null;
      this.arguments = null;
    }
  }

  splitSpace(): Token[] | null {
    if (!this.arguments) return null;
    return this.arguments.filter((a) => a.type !== 'whitespace' && a.type !== 'comment');
  }

  /** Split on commas; when singleTokens, each part must be one token and the list is flattened. */
  splitComma(singleTokens: true, trailing?: boolean): Token[] | null;
  splitComma(singleTokens: false, trailing?: boolean): Token[][] | null;
  splitComma(singleTokens = true, trailing = false): any {
    if (!this.arguments) return null;
    const parts: Token[][] = [[]];
    for (const t of this.arguments) {
      if (t.type === 'literal' && t.value === ',') {
        parts.push([]);
        continue;
      }
      if (t.type !== 'comment' && t.type !== 'whitespace') parts[parts.length - 1].push(t);
    }
    if (trailing) {
      const head = parts.slice(0, -1);
      const last = parts[parts.length - 1];
      if (singleTokens) {
        if (head.every((p) => p.length === 1) && last.length <= 1) return head.map((p) => p[0]);
      } else if (head.every((p) => p.length > 0)) return parts;
    } else if (singleTokens) {
      if (parts.every((p) => p.length === 1)) return parts.map((p) => p[0]);
    } else if (parts.every((p) => p.length > 0)) return parts;
    return [];
  }
}

/** Decorators of the Python validators, as higher-order functions. */
export type Validator = (tokens: Token[], baseUrl?: string | null) => any;

export const singleKeyword = (pred: (k: string | null) => boolean): Validator => (tokens) => {
  const k = getSingleKeyword(tokens);
  return pred(k) ? k : null;
};

export const singleToken = (fn: (t: Token, baseUrl?: string | null) => any): Validator => (tokens, baseUrl) =>
  tokens.length === 1 ? fn(tokens[0], baseUrl) : null;

export function commaSeparatedList(fn: Validator): Validator {
  const wrapper: Validator = (tokens, baseUrl) => {
    const results: any[] = [];
    for (const part of splitOnComma(tokens)) {
      const r = fn(removeWhitespace(part), baseUrl);
      if (r === null || r === undefined) return null;
      results.push(r);
    }
    return results;
  };
  (wrapper as any).singleValue = fn;
  return wrapper;
}

export { parseColor };