// SPDX-License-Identifier: BSD-3-Clause

/**
 * Legacy HTML attribute values (mirrors weasyprint/html.py: parse_integer, parse_legacy_color, map_to_pixel_length,
 * map_to_dimension_property, ...). Lives in the CSS layer so that the presentational hints can use it without
 * importing the HTML module, which depends on the box tree.
 */
import { parseColor } from './color.ts';
import { pyRound } from '../utils.ts';
import { urlJoin } from '../urls.ts';

/** Python: html.parse_url. Parse a valid URL potentially surrounded by spaces. */
export function parseUrl(s: string | null, baseUrl: string | null, allowRelative = false): string | null {
  if (!s) return null;
  let str = s.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '').replace(/[\t\n\r]/g, '');
  if (!str) return null;
  str = urlJoin(baseUrl ?? '', str, allowRelative, str) ?? '';
  return str || null;
}

/** Python's str(float): integral values keep a decimal point. */
export const pyFloat = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

export const WHITESPACE = ' \t\n\f\r';
const INTEGER_RE = /^[ \t\n\f\r]*([+-]?)([0-9]+)/;
const DIMENSION_RE = /^[ \t\n\f\r]*([0-9]+([.][0-9]*)?)(%)?/;

export function parseInteger(s: string | null): number | null {
  const m = INTEGER_RE.exec(s ?? '');
  return m ? (m[1] === '-' ? -1 : 1) * parseInt(m[2], 10) : null;
}

export function parseNonNegativeInteger(s: string | null): number | null {
  const i = parseInteger(s);
  return i !== null && i >= 0 ? i : null;
}

export function parseDimensionValue(s: string | null): [number, string] | null {
  const m = DIMENSION_RE.exec(s ?? '');
  return m ? [parseFloat(m[1]), m[3] === '%' ? '%' : 'px'] : null;
}

/** Python: parse_legacy_color. Returns '#rrggbb', or null on error. */
export function parseLegacyColor(input: string): string | null {
  const s = input.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');
  if (['transparent', 'currentcolor'].includes(s.toLowerCase())) return null;
  const c = parseColor(s);
  if (c === null || c === 'currentcolor') return null;
  // Python's round() rounds half to even.
  const h = (x: number): string => pyRound(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function mapToPixelLength(s: string | null): string | null {
  const v = parseNonNegativeInteger(s);
  return v !== null ? `${v}px` : null;
}

export function mapToDimensionProperty(s: string | null): string | null {
  const d = parseDimensionValue(s);
  return d !== null ? `${pyFloat(d[0])}${d[1]}` : null;
}

export function mapToDimensionPropertyIgnoringZero(s: string | null): string | null {
  const d = parseDimensionValue(s);
  return d !== null && d[0] !== 0 ? `${pyFloat(d[0])}${d[1]}` : null;
}
