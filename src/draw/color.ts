// SPDX-License-Identifier: BSD-3-Clause

/** Draw colors (mirrors weasyprint/draw/color.py). */
import { parseColor, rgba } from '../css/color.ts';
import type { Color, RGBA } from '../css/color.ts';

/** Return color, taking care of possible currentColor value. */
export function getColor(style: { get(key: string): any }, key: string): RGBA {
  const value = style.get(key);
  return value !== 'currentcolor' ? value : style.get('color');
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const v = maxc;
  if (minc === maxc) return [0, 0, v];
  const s = (maxc - minc) / maxc;
  const rc = (maxc - r) / (maxc - minc);
  const gc = (maxc - g) / (maxc - minc);
  const bc = (maxc - b) / (maxc - minc);
  let h: number;
  if (r === maxc) h = bc - gc;
  else if (g === maxc) h = 2 + rc - bc;
  else h = 4 + gc - rc;
  h = (h / 6) % 1;
  if (h < 0) h += 1;
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  if (s === 0) return [v, v, v];
  const i = Math.trunc(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

const fromHsv = (h: number, s: number, v: number, alpha: number): RGBA => {
  const [r, g, b] = hsvToRgb(h, s, v);
  // The reference formats each channel with '%f' (6 decimals) AND a literal
  // '%', then re-parses it as a percentage: 0.333333 -> '0.333333%' -> 0.003333.
  // The alpha is formatted '%f' without '%' so it stays as-is.
  const q = (x: number): number => Number(x.toFixed(6)) / 100;
  return rgba(q(r), q(g), q(b), Number(alpha.toFixed(6)));
};

export function darken(color: RGBA): RGBA {
  // TODO: handle color spaces.
  let [hue, saturation, value] = rgbToHsv(color.r, color.g, color.b);
  value /= 1.5;
  saturation /= 1.25;
  return fromHsv(hue, saturation, value, color.a);
}

export function lighten(color: RGBA): RGBA {
  let [hue, saturation, value] = rgbToHsv(color.r, color.g, color.b);
  value = 1 - (1 - value) / 1.5;
  if (saturation) saturation = 1 - (1 - saturation) / 1.25;
  return fromHsv(hue, saturation, value, color.a);
}

/** Return inset, outset, ridge and groove border colors. */
export function styledColor(style: string, color: RGBA, side: string): RGBA | [RGBA, RGBA] {
  if (style === 'inset' || style === 'outset') {
    const doLighten = (side === 'top' || side === 'left') !== (style === 'inset');
    return (doLighten ? lighten : darken)(color);
  }
  if (style === 'ridge' || style === 'groove') {
    if ((side === 'top' || side === 'left') !== (style === 'ridge')) return [lighten(color), darken(color)];
    return [darken(color), lighten(color)];
  }
  return color;
}

export { parseColor };
export type { Color };