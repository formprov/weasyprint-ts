// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pluggable text engine seam (mirrors the Pango/HarfBuzz/FontConfig boundary in
 * weasyprint/text/*). All font matching, shaping, line breaking and font
 * metrics used by layout and drawing go through this interface, so alternative
 * backends (e.g. a HarfBuzz WASM build for complex scripts) can be installed
 * without touching layout code. Layout code never imports fontkit directly —
 * only the default engine implementation (font_config.ts, layout.ts, shaper.ts,
 * line_break.ts) does.
 */
import type { Style } from '../css/style.ts';
import type { FontConfiguration, FontFace } from './font_config.ts';
import type { Layout, LogAttr } from './layout.ts';
import type { ShapedGlyph } from './shaper.ts';
import type { FirstLineResult } from './line_break.ts';

export interface TextEngine {
  /** FontConfig equivalent: resolve font families of a style to concrete faces. */
  matchFont(
    config: FontConfiguration, families: string[], weight: number, fontStyle: string, fontStretch: string,
  ): FontFace[];
  /** HarfBuzz equivalent: shape one run of code points in one face (Pango units). */
  shape(
    face: FontFace, codePoints: number[], size: number, features: Record<string, number>, vertical?: boolean,
  ): ShapedGlyph[];
  /** Pango log attributes for text, including UAX #14 break opportunities. */
  breakOpportunities(text: string, lang: string | null): LogAttr[];
  /** Whether the text contains any break opportunity (fast path of breakOpportunities). */
  canBreakText(text: string, lang: string | null): boolean;
  /** Pango layout equivalent: fit as much text as possible on the first line. */
  firstLine(
    text: string, style: Style, context: any, maxWidth: number | null, justificationSpacing: number,
    isLineStart?: boolean, minimum?: boolean,
  ): FirstLineResult;
  /** Create a layout object for metrics queries (widths, baselines) without breaking. */
  createLayout(text: string, style: Style, context: any, maxWidth: number | null, justificationSpacing: number): Layout;
  metrics: {
    /** Line height and baseline for a style with no text (strut metrics). */
    strut(style: Style): [number, number];
    /** Size ratio of a font-relative unit ('ex', 'ch', …). */
    characterRatio(style: Style, unit: string): number;
    /** Font extents for a face at a given Pango-unit size. */
    fontExtents(face: FontFace, size: number): { ascent: number; descent: number };
  };
}

// The default backend is the fontkit + linebreak stack (Pango behavior port).
import { canBreakText, characterRatio, createLayout, getLogAttrs, splitFirstLine, strut } from './line_break.ts';
import { fontExtents, shapeRun } from './shaper.ts';

function defaultEngine(): TextEngine {
  return {
    matchFont: (config, families, weight, fontStyle, fontStretch) =>
      config.match(families, weight, fontStyle, fontStretch),
    shape: (face, codePoints, size, features, vertical) => shapeRun(face, codePoints, size, features, vertical),
    breakOpportunities: (text, lang) => getLogAttrs(text, lang),
    canBreakText,
    firstLine: splitFirstLine,
    createLayout,
    metrics: { strut, characterRatio, fontExtents },
  };
}

let engine: TextEngine | null = null;

/** The active text engine; defaults to the built-in fontkit/linebreak backend. */
export function getTextEngine(): TextEngine {
  if (engine === null) engine = defaultEngine();
  return engine;
}

/** Install an alternative text engine (HarfBuzz WASM, …). Pass null to restore the default. */
export function setTextEngine(override: TextEngine | null): void {
  engine = override;
}
