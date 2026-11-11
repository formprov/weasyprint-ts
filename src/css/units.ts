// SPDX-License-Identifier: BSD-3-Clause

/** Constants and helpers for units (mirrors weasyprint/css/units.py). */
import type { Dimension } from './properties.ts';
import { hooks } from './hooks.ts';

export const ANGLE_TO_RADIANS: Record<string, number> = {
  rad: 1, turn: 2 * Math.PI, deg: Math.PI / 180, grad: Math.PI / 200,
};
export const LENGTHS_TO_PIXELS: Record<string, number> = {
  px: 1, pt: 1 / 0.75, pc: 16, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, q: 96 / 25.4 / 4,
};
export const RESOLUTION_TO_DPPX: Record<string, number> = {
  dppx: 1, x: 1, dpi: 1 / 96, dpcm: 1 / (96 / 2.54),
};
export const ABSOLUTE_UNITS = new Set(Object.keys(LENGTHS_TO_PIXELS));
export const FONT_UNITS = new Set([
  'em', 'ex', 'cap', 'ch', 'ic', 'lh', 'rem', 'rex', 'rcap', 'rch', 'ric', 'rlh',
]);
const viewportBase = ['vw', 'vh', 'vi', 'vb', 'vmin', 'vmax'];
export const VIEWPORT_UNITS = new Set(
  ['', 'l', 's', 'd', 'p'].flatMap((p) => viewportBase.map((u) => p + u)),
);
export const RELATIVE_UNITS = new Set([...FONT_UNITS, ...VIEWPORT_UNITS]);
export const LENGTH_UNITS = new Set([...ABSOLUTE_UNITS, ...RELATIVE_UNITS]);
export const ANGLE_UNITS = new Set(Object.keys(ANGLE_TO_RADIANS));

/** Minimal view of a style needed to resolve font-relative units. */
export interface UnitStyle {
  get(key: string): any;
  rootStyle: UnitStyle | null;
  parentStyle: UnitStyle | null;
  initialPageSizes: { box: [number, number] | null; area: [number, number] | null };
}

export function toPixels(
  value: Dimension, style: UnitStyle | null, propertyName: string | null, fontSize: number | null = null,
): number {
  if (value.value === 0) return 0;
  const unit = (value.unit ?? '').toLowerCase();
  if (unit === 'px') return value.value;
  if (unit in LENGTHS_TO_PIXELS) return value.value * LENGTHS_TO_PIXELS[unit];
  if (FONT_UNITS.has(unit)) {
    if (style === null && fontSize === null) throw new Error('font-relative unit without style');
    const fs = fontSize ?? (style as UnitStyle).get('font_size');
    const st = style as UnitStyle;
    if (unit === 'em') return value.value * fs;
    if (unit === 'rem') return value.value * st.rootStyle!.get('font_size');
    if (unit === 'lh') {
      const target = propertyName === 'font_size' || propertyName === 'line_height'
        ? (st.parentStyle ?? st.rootStyle!) : st;
      return value.value * hooks.strut(target)[0];
    }
    if (unit === 'rlh') return value.value * hooks.strut(st.rootStyle!)[0];
    if (unit.startsWith('r')) {
      const ratio = hooks.characterRatio(st.rootStyle!, unit.slice(1));
      return value.value * st.rootStyle!.get('font_size') * ratio;
    }
    return value.value * fs * hooks.characterRatio(st, unit);
  }
  if (VIEWPORT_UNITS.has(unit)) {
    const s = style as UnitStyle;
    const size = s.initialPageSizes[unit[0] === 'p' ? 'box' : 'area'] ?? [816, 1056];
    const [w, h] = size;
    if (unit.endsWith('vw') || unit.endsWith('vi')) return (value.value / 100) * w;
    if (unit.endsWith('vh') || unit.endsWith('vb')) return (value.value / 100) * h;
    if (unit.endsWith('vmin')) return (value.value / 100) * Math.min(w, h);
    if (unit.endsWith('vmax')) return (value.value / 100) * Math.max(w, h);
  }
  throw new Error(`Unknown length unit ${unit}`);
}

export function toRadians(value: Dimension): number {
  const unit = (value.unit ?? '').toLowerCase();
  return value.value * ANGLE_TO_RADIANS[unit];
}