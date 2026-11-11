// SPDX-License-Identifier: BSD-3-Clause

/** Color parsing (subset of tinycss2.color5.parse_color): sRGB colors only. */
import { NAMED_COLORS } from './color_names.ts';
import type { Token } from './parser.ts';
import { parseComponentValueList } from './parser.ts';

export interface RGBA {
  /** 'srgb', 'device-cmyk' or a custom '--profile' space (tinycss2 color5 Color.space). */
  readonly space: string;
  readonly r: number; // 0..1 (an sRGB approximation for other spaces)
  readonly g: number;
  readonly b: number;
  readonly a: number;
  /** Channels in `space` for non-sRGB colors (C, M, Y, K for device-cmyk). */
  readonly coordinates?: readonly number[];
}
export type Color = RGBA | 'currentcolor';

export const rgba = (r: number, g: number, b: number, a = 1): RGBA => ({ space: 'srgb', r, g, b, a });

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

function stripWs(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
}

function parseHex(value: string): RGBA | null {
  if (!/^[0-9a-fA-F]+$/.test(value)) return null;
  const n = value.length;
  if (n === 3 || n === 4) {
    const d = [...value].map((c) => parseInt(c + c, 16) / 255);
    return rgba(d[0], d[1], d[2], n === 4 ? d[3] : 1);
  }
  if (n === 6 || n === 8) {
    const d = [0, 2, 4, 6].map((i) => (i < n ? parseInt(value.slice(i, i + 2), 16) / 255 : 1));
    return rgba(d[0], d[1], d[2], n === 8 ? d[3] : 1);
  }
  return null;
}

function alphaOf(token: Token | undefined): number | null {
  if (!token) return 1;
  if (token.type === 'number') return clamp01(token.value);
  if (token.type === 'percentage') return clamp01(token.value / 100);
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function parseFunction(name: string, args: Token[]): RGBA | null {
  const toks = stripWs(args);
  // Split into components by commas or '/' or spaces.
  const comps: Token[] = [];
  let alpha: Token | undefined;
  let commaSyntax = false;
  let seenSlash = false;
  for (const t of toks) {
    if (t.type === 'literal' && t.value === ',') {
      commaSyntax = true;
    } else if (t.type === 'literal' && t.value === '/') {
      seenSlash = true;
    } else if (seenSlash) {
      if (alpha) return null;
      alpha = t;
    } else comps.push(t);
  }
  if (commaSyntax && seenSlash) return null;
  if (commaSyntax && comps.length === 4) alpha = comps.pop();
  if (comps.length !== 3) return null;
  const a = alphaOf(alpha);
  if (a === null) return null;
  if (name === 'rgb' || name === 'rgba') {
    const vals = comps.map((t) => {
      if (t.type === 'number') return t.value / 255;
      if (t.type === 'percentage') return t.value / 100;
      return NaN;
    });
    if (vals.some(Number.isNaN)) return null;
    return rgba(clamp01(vals[0]), clamp01(vals[1]), clamp01(vals[2]), a);
  }
  if (name === 'hsl' || name === 'hsla') {
    const [h, s, l] = comps;
    let hue: number;
    if (h.type === 'number') hue = h.value;
    else if (h.type === 'dimension' && h.lowerUnit === 'deg') hue = h.value;
    else return null;
    const sat = s.type === 'percentage' ? s.value / 100 : s.type === 'number' ? s.value / 100 : NaN;
    const lig = l.type === 'percentage' ? l.value / 100 : l.type === 'number' ? l.value / 100 : NaN;
    if (Number.isNaN(sat) || Number.isNaN(lig)) return null;
    const [r, g, b] = hslToRgb(hue, sat, lig);
    return rgba(r, g, b, a);
  }
  return null;
}

/** Python: color5 Color('device-cmyk' | '--name', coordinates, alpha); r/g/b is the naive sRGB conversion. */
function spaced(space: string, coordinates: number[], a: number): RGBA {
  let [r, g, b] = [0, 0, 0];
  if (space === 'device-cmyk') {
    const [c, m, y, k] = coordinates;
    [r, g, b] = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  return { space, r, g, b, a, coordinates };
}

/** Python: tinycss2.color5.parse_color for device-cmyk() and color(--custom ...); undefined for other functions. */
function parseColor5(name: string, args: Token[]): RGBA | null | undefined {
  if (name !== 'device-cmyk' && name !== 'color') return undefined;
  let tokens = stripWs(args);
  let space: Token | undefined;
  if (name === 'color') [space, ...tokens] = tokens;
  let alphaTokens: Token[] = [];
  const isComma = (t: Token): boolean => t.type === 'literal' && t.value === ',';
  const oldSyntax = tokens.filter((_, i) => i % 2 === 1).every(isComma);
  if (oldSyntax) tokens = tokens.filter((_, i) => i % 2 === 0);
  else {
    const slash = tokens.findIndex((t) => t.type === 'literal' && t.value === '/');
    if (slash !== -1) {
      alphaTokens = tokens.slice(slash + 1);
      tokens = tokens.slice(0, slash);
    }
  }
  let alpha: number | null = 1;
  if (alphaTokens.length === 1) alpha = alphaOf(alphaTokens[0]);
  else if (alphaTokens.length > 1) alpha = null;
  const types = new Set(tokens.map((t) => t.type));
  const channel = (t: Token): number => (t.type === 'number' ? t.value : (t as any).value / 100);
  if (name === 'device-cmyk') {
    if (oldSyntax ? !(types.size === 1 && types.has('number')) : [...types].some((t) => t !== 'number' && t !== 'percentage')) return null;
    if (tokens.length !== 4) return null;
    if (alpha === null) return null;
    return spaced('device-cmyk', tokens.map((t) => clamp01(channel(t))), alpha);
  }
  if (name === 'color') {
    if (!space) return undefined;
    if (space.type !== 'ident' || !space.value.startsWith('--')) return undefined; // predefined spaces: color4
    if ([...types].some((t) => t !== 'number' && t !== 'percentage')) return null;
    if (alpha === null) return null;
    return spaced(space.value, tokens.map(channel), alpha);
  }
  return undefined;
}

/** Parse one color token (or CSS string); null when not a (supported) color. */
export function parseColor(input: Token | string): Color | null {
  const token: Token | undefined = typeof input === 'string'
    ? stripWs(parseComponentValueList(input))[0]
    : input;
  if (!token) return null;
  if (token.type === 'ident') {
    const v = token.lowerValue;
    if (v === 'currentcolor') return 'currentcolor';
    if (v === 'transparent') return rgba(0, 0, 0, 0);
    const named = NAMED_COLORS[v];
    if (named) return rgba(named[0] / 255, named[1] / 255, named[2] / 255, 1);
    return null;
  }
  if (token.type === 'hash') return parseHex(token.value);
  if (token.type === 'function') {
    const color5 = parseColor5(token.lowerName, token.arguments);
    if (color5 !== undefined) return color5;
    return parseFunction(token.lowerName, token.arguments);
  }
  return null;
}