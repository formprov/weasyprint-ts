// SPDX-License-Identifier: BSD-3-Clause

/** Util functions for SVG rendering (mirrors weasyprint/svg/utils.py). */
import { ANGLE_TO_RADIANS, LENGTHS_TO_PIXELS } from '../css/units.ts';
import { Matrix } from '../matrix.ts';
import { parseColor, type RGBA } from '../css/color.ts';

export class PointError extends Error {}

/** Python's float(): accepts a leading/trailing-space-stripped decimal, raises otherwise. */
const FLOAT_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
export function pyFloat(value: unknown): number {
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (FLOAT_RE.test(text)) return Number(text);
  if (/^[+-]?(inf|infinity)$/i.test(text)) return text.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(text)) return NaN;
  throw new Error(`could not convert string to float: '${value}'`);
}

/** Python's float() where a failure is an expected, non-raising outcome. */
function tryPyFloat(value: string): number | null {
  try {
    return pyFloat(value);
  } catch {
    return null;
  }
}

/** Python: ``matrix(a=…, b=…, …)`` with keyword arguments. */
export function matrix(opts: { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number } = {}): Matrix {
  return new Matrix(opts.a ?? 1, opts.b ?? 0, opts.c ?? 0, opts.d ?? 1, opts.e ?? 0, opts.f ?? 0);
}

/** Give a canonical version of a given value string. */
export function normalize(input: string | null | undefined): string {
  let string = (input ?? '').replace(/E/g, 'e');
  string = string.replace(/(?<!e)([+-])/g, ' $1');
  string = string.replace(/[ \n\r\t,]+/g, ' ');
  string = string.replace(/(\.[0-9-]+)(?=\.)/g, '$1 ');
  return string.trim();
}

/** Compute size from string, resolving units and percentages. */
export function size(input: string | number | null | undefined, fontSize: number | null = null,
  percentageReference: number | null = null): number {
  if (input === null || input === undefined || input === '') return 0;
  if (typeof input === 'number') return input;
  const direct = tryPyFloat(input);
  if (direct !== null) return direct;

  // Not a float, try something else
  const string = normalize(input).split(' ', 1)[0];
  if (string.endsWith('%')) {
    if (percentageReference === null) throw new Error('assertion: percentage reference');
    return pyFloat(string.slice(0, -1)) * percentageReference / 100;
  } else if (string.endsWith('rem')) {
    if (fontSize === null) throw new Error('assertion: font size');
    return fontSize * pyFloat(string.slice(0, -3));
  } else if (string.endsWith('em')) {
    if (fontSize === null) throw new Error('assertion: font size');
    return fontSize * pyFloat(string.slice(0, -2));
  } else if (string.endsWith('ex')) {
    // Assume that 1em == 2ex
    if (fontSize === null) throw new Error('assertion: font size');
    return fontSize * pyFloat(string.slice(0, -2)) / 2;
  }

  for (const [unit, coefficient] of Object.entries(LENGTHS_TO_PIXELS)) {
    if (string.endsWith(unit)) return pyFloat(string.slice(0, -unit.length)) * coefficient;
  }

  // Unknown size
  return 0;
}

/** Compute an angle in radians from an SVG transform value. */
export function angle(input: string): number {
  const string = normalize(input).split(' ', 1)[0];
  // Sort units by length to match grad between rad (stable, like Python's sorted()).
  const units = Object.keys(ANGLE_TO_RADIANS).sort((a, b) => b.length - a.length);
  for (const unit of units) {
    if (string.endsWith(unit)) return pyFloat(string.slice(0, -unit.length)) * ANGLE_TO_RADIANS[unit];
  }
  return pyFloat(string) * ANGLE_TO_RADIANS.deg;
}

/** Return opacity between 0 and 1 from str, number or percentage. */
export function alphaValue(value: string | number): number {
  let ratio = 1;
  let text: string | number = value;
  if (typeof text === 'string') {
    text = text.trim();
    if (text.endsWith('%')) {
      ratio = 100;
      text = text.slice(0, -1).trim();
    }
  }
  return Math.min(1, Math.max(0, pyFloat(text) / ratio));
}

/** Pop first two size values from a string. Returns [x, y, rest]. */
export function point(svg: any, input: string, fontSize: number): [number, number, string] {
  const match = /^(.*?) (.*?)(?: |$)/.exec(input);
  if (!match) throw new PointError();
  const [x, y] = [match[1], match[2]];
  const rest = input.slice(match[0].length);
  const [px, py] = svg.point(x, y, fontSize);
  return [px, py, rest];
}

/** Compute scale and translation needed to preserve ratio. */
export function preserveRatio(svg: any, node: any, fontSize: number, width: number, height: number,
  viewboxIn: number[] | null = null): [number, number, number, number] {
  const viewbox = viewboxIn ?? node.getViewbox();
  let viewboxWidth: number;
  let viewboxHeight: number;
  if (viewbox && viewbox.length) {
    viewboxWidth = viewbox[2];
    viewboxHeight = viewbox[3];
  } else if (svg.tree === node) {
    [viewboxWidth, viewboxHeight] = svg.getIntrinsicSize(fontSize);
    if (viewboxWidth === null || viewboxHeight === null) return [1, 1, 0, 0];
  } else {
    return [1, 1, 0, 0];
  }

  let scaleX = viewboxWidth ? width / viewboxWidth : 1;
  let scaleY = viewboxHeight ? height / viewboxHeight : 1;

  let aspectRatio: string[];
  if (viewbox && viewbox.length) {
    aspectRatio = (node.get('preserveAspectRatio') ?? 'xMidYMid').split(/\s+/).filter(Boolean);
  } else {
    aspectRatio = ['none'];
  }
  const align = aspectRatio[0];
  let xPosition: string;
  let yPosition: string;
  if (align === 'none') {
    xPosition = 'min';
    yPosition = 'min';
  } else {
    const meetOrSlice = aspectRatio.length > 1 ? aspectRatio[1] : null;
    const scaleValue = meetOrSlice === 'slice' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    scaleX = scaleY = scaleValue;
    xPosition = align.slice(1, 4).toLowerCase();
    yPosition = align.slice(5).toLowerCase();
  }

  let translateX: number;
  let translateY: number;
  if (node.tag === 'marker') {
    [translateX, translateY] = svg.point(node.get('refX'), node.get('refY') ?? '0', fontSize);
  } else {
    translateX = 0;
    if (xPosition === 'mid') translateX = (width - viewboxWidth * scaleX) / 2;
    else if (xPosition === 'max') translateX = width - viewboxWidth * scaleX;

    translateY = 0;
    if (yPosition === 'mid') translateY += (height - viewboxHeight * scaleY) / 2;
    else if (yPosition === 'max') translateY += height - viewboxHeight * scaleY;
  }

  if (viewbox && viewbox.length) {
    translateX -= viewbox[0] * scaleX;
    translateY -= viewbox[1] * scaleY;
  }

  return [scaleX, scaleY, translateX, translateY];
}

export interface ParsedUrl {
  scheme: string;
  netloc: string;
  path: string;
  query: string;
  fragment: string;
}

/** Parse a URL, possibly in a "url(…)" string (Python: urllib.parse.urlparse). */
export function parseUrl(input: string | null | undefined): ParsedUrl {
  let url = input ?? '';
  if (url && url.startsWith('url(') && url.endsWith(')')) {
    url = url.slice(4, -1);
    if (url.length >= 2) {
      for (const quote of ["'", '"']) {
        if (url[0] === quote && url[url.length - 1] === quote) {
          url = url.slice(1, -1);
          break;
        }
      }
    }
  }
  let fragment = '';
  const hash = url.indexOf('#');
  if (hash !== -1) {
    fragment = url.slice(hash + 1);
    url = url.slice(0, hash);
  }
  let query = '';
  const qmark = url.indexOf('?');
  if (qmark !== -1) {
    query = url.slice(qmark + 1);
    url = url.slice(0, qmark);
  }
  let scheme = '';
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (schemeMatch) {
    scheme = schemeMatch[1].toLowerCase();
    url = url.slice(schemeMatch[0].length);
  }
  let netloc = '';
  if (url.startsWith('//')) {
    const end = url.indexOf('/', 2);
    netloc = end === -1 ? url.slice(2) : url.slice(2, end);
    url = end === -1 ? '' : url.slice(end);
  }
  return { scheme, netloc, path: url, query, fragment };
}

/** Safely parse a color string and return a RGBA tuple. */
export function color(input: string | null | undefined): RGBA {
  const parsed = parseColor(input ?? '') ?? parseColor('black');
  return parsed as RGBA;
}

/** Get a matrix corresponding to the transform string. */
export function transform(transformString: string, transformOrigin: string, fontSize: number,
  normalizedDiagonal: number): Matrix {
  // TODO: merge with gather_anchors and css.validation.properties.transform
  let originX = 0;
  let originY = 0;
  const sizeStrings = normalize(transformOrigin).split(' ').filter(Boolean);
  if (sizeStrings.length === 2) {
    originX = size(sizeStrings[0]);
    originY = size(sizeStrings[1]);
  }
  let result = matrix({ e: originX, f: originY });

  const transformations = [...normalize(transformString).matchAll(/(\w+) ?\( ?(.*?) ?\)/g)];
  for (const [, transformationType, transformationValue] of transformations) {
    const values = transformationValue.split(' ').filter((v) => v);
    if (transformationType === 'matrix') {
      const numbers = values.map((v) => size(v, fontSize, normalizedDiagonal));
      result = new Matrix(...(numbers as [number, number, number, number, number, number])).matmul(result);
    } else if (transformationType === 'rotate') {
      let rotateX = 0;
      let rotateY = 0;
      if (values.length === 3) {
        rotateX = size(values[1], fontSize, normalizedDiagonal);
        rotateY = size(values[2], fontSize, normalizedDiagonal);
        result = matrix({ e: rotateX, f: rotateY }).matmul(result);
      }
      const rotation = angle(values[0]);
      const cosR = Math.cos(rotation);
      const sinR = Math.sin(rotation);
      result = matrix({ a: cosR, b: sinR, c: -sinR, d: cosR }).matmul(result);
      if (values.length === 3) result = matrix({ e: -rotateX, f: -rotateY }).matmul(result);
    } else if (transformationType.startsWith('skew')) {
      if (values.length === 1) values.push('0');
      if (transformationType === 'skewX' || transformationType === 'skew') {
        result = matrix({ c: Math.tan(angle(values.shift()!)) }).matmul(result);
      }
      if (transformationType === 'skewY' || transformationType === 'skew') {
        result = matrix({ b: Math.tan(angle(values.shift()!)) }).matmul(result);
      }
    } else if (transformationType.startsWith('translate')) {
      const numbers = values.map((v) => size(v, fontSize, normalizedDiagonal));
      if (numbers.length === 1) numbers.push(0);
      if (transformationType === 'translateX' || transformationType === 'translate') {
        result = matrix({ e: numbers.shift()! }).matmul(result);
      }
      if (transformationType === 'translateY' || transformationType === 'translate') {
        result = matrix({ f: numbers.shift()! }).matmul(result);
      }
    } else if (transformationType.startsWith('scale')) {
      const numbers = values.map((v) => size(v, fontSize, normalizedDiagonal));
      if (numbers.length === 1) numbers.push(numbers[0]);
      if (transformationType === 'scaleX' || transformationType === 'scale') {
        result = matrix({ a: numbers.shift()! }).matmul(result);
      }
      if (transformationType === 'scaleY' || transformationType === 'scale') {
        result = matrix({ d: numbers.shift()! }).matmul(result);
      }
    }
  }

  return matrix({ e: -originX, f: -originY }).matmul(result);
}

/** Python's int() on a string: optional sign and digits only, otherwise raises. */
export function pyInt(value: string): number {
  if (/^[+-]?\d+$/.test(value.trim())) return parseInt(value.trim(), 10);
  throw new Error(`invalid literal for int() with base 10: '${value}'`);
}

/** Python's ``a, b = s.split(' ', 1)`` unpacking: raises when there is no separator. */
export function splitOnce(string: string, separator = ' '): [string, string] {
  const index = string.indexOf(separator);
  if (index === -1) throw new Error('not enough values to unpack (expected 2, got 1)');
  return [string.slice(0, index), string.slice(index + separator.length)];
}

/** Python's ``s[0]``: raises on an empty string. */
export function charAt0(string: string): string {
  if (string.length === 0) throw new Error('string index out of range');
  return string[0];
}

/** Python ``s[1:]`` on a string that may be empty is fine; ``s[0]`` is the one that raises. */
export function pyStripTail(string: string): string {
  return string.slice(1).trim();
}
