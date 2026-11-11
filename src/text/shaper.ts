// SPDX-License-Identifier: BSD-3-Clause

/**
 * Text shaping with fontkit, reproducing HarfBuzz/Pango metrics conventions
 * (see memory weasyprint-pango-semantics): fixed-point em scaling applied
 * separately to base advances and GPOS adjustments, 'latn' for common
 * characters, fallback widths for missing Unicode spaces.
 */
import type { FontFace } from './font_config.ts';
import { mirrorChar } from './bidi.ts';
import { normalizeForShaping } from './normalize.ts';
import { positionFallbackMarks } from './fallback_marks.ts';

/** HarfBuzz em_scale: `(v * ((size << 16) / upem) + 32768) >> 16`, size in Pango units. */
export function scale(v: number, size: number, upem: number): number {
  const mult = (BigInt(size) << 16n) / BigInt(upem);
  return Number((BigInt(v) * mult + 32768n) >> 16n);
}

export const PANGO_SCALE = 1024;
export const PANGO_GLYPH_EMPTY = 0x0fffffff;
export const PANGO_GLYPH_UNKNOWN_FLAG = 0x10000000;

export interface ShapedGlyph {
  /** Glyph id, PANGO_GLYPH_EMPTY, or UNKNOWN_FLAG | codepoint. */
  gid: number;
  advance: number;
  xOffset: number;
  yOffset: number;
  /** Index of the first code point of the cluster, in code points of the shaped text. */
  cluster: number;
  /** Number of code points in the cluster. */
  clusterLength: number;
}

const IGNORABLE = new Set([0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff,
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2061, 0x2062, 0x2063, 0x2064]);

const em = (n: number) => (_f: any, size: number): number => Math.trunc((size + Math.trunc(n / 2)) / n);
const adv = (f: any, cp: number, size: number): number => scale(f.glyphForCodePoint(cp).advanceWidth, size, f.unitsPerEm);
const SPACE_FALLBACK: Record<number, (f: any, size: number) => number> = {
  0x2000: em(2), 0x2001: em(1), 0x2002: em(2), 0x2003: em(1), 0x2004: em(3), 0x2005: em(4),
  0x2006: em(6), 0x2009: em(5), 0x200a: em(16), 0x3000: em(1),
  0x2007: (f, size) => adv(f, 0x30, size),
  0x2008: (f, size) => adv(f, 0x2e, size),
  0x202f: (f, size) => Math.trunc(adv(f, 0x20, size) / 2),
  0x205f: (_f, size) => Math.trunc((size * 4) / 18),
};

/**
 * fontkit registers `frac`, `numr` and `dnom` as *local* features (applied only
 * to glyphs around U+2044) and silently ignores a user request for a feature that is
 * already registered, so `font-variant-numeric: diagonal-fractions` never reached
 * the GSUB lookups. HarfBuzz applies a requested feature to the whole run (the font's
 * own contextual lookups, e.g. Fira's, then pick the digits around an ASCII slash).
 * Wrap the plan once so requested local features become global.
 */
let planPatched = false;
function ensureRequestedFeaturesAreGlobal(font: any): void {
  if (planPatched) return;
  font.layout('a', [], 'latn'); // creates the layout engine
  const engine = font._layoutEngine?.engine;
  if (!engine) return;
  // The engine builds a ShapingPlan during layout and clears it again afterwards:
  // capture the instance on assignment to reach its class.
  let captured: any = null;
  let stored: any = engine.plan ?? null;
  Object.defineProperty(engine, 'plan', {
    configurable: true, enumerable: true,
    get() { return stored; },
    set(value: any) { stored = value; if (value && !captured) captured = value; },
  });
  font.layout('a', [], 'latn');
  Object.defineProperty(engine, 'plan', { configurable: true, enumerable: true, writable: true, value: stored });
  if (!captured) return;
  const proto = Object.getPrototypeOf(captured);
  const original = proto.setFeatureOverrides;
  if (typeof original !== 'function') return;
  proto.setFeatureOverrides = function (this: any, requested: any): void {
    original.call(this, requested);
    const tags: string[] = Array.isArray(requested) ? requested : Object.keys(requested ?? {}).filter((t) => requested[t]);
    for (const tag of tags) if (this.allFeatures[tag] != null) this.globalFeatures[tag] = true;
  };
  planPatched = true;
}

/**
 * Shape `codePoints` (a run in one font) at `size` (Pango units, 1/1024 px).
 * `features` maps OpenType tags to values (0 disables).
 */
export function shapeRun(
  face: FontFace, codePoints: number[], size: number, features: Record<string, number>, vertical = false,
  rtl = false, script = 'latn',
): ShapedGlyph[] {
  void vertical;
  // HarfBuzz mirrors characters with a Bidi_Mirroring_Glyph in right-to-left runs (hb_ot_mirror_chars).
  if (rtl) codePoints = codePoints.map((c) => mirrorChar(c) ?? c);
  const f = face.fk;
  ensureRequestedFeaturesAreGlobal(f);
  const featureObj: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(features)) featureObj[k] = v !== 0;
  // hb-ot-shaper-hangul.cc override_features_hangul: Uniscribe does not apply
  // 'calt' for Hangul, and Noto Sans CJK's calt lookups otherwise substitute
  // glyphs around jamo (including a different space glyph).
  if (script === 'hang') featureObj.calt = false;
  // HarfBuzz normalizes before shaping: full canonical decomposition, marks
  // sorted by combining class, then recomposition wherever this font has the
  // composed glyph (hb-ot-shape-normalize.cc).
  const kept: number[] = [];
  const keptOrig: number[] = [];
  codePoints.forEach((c, i) => {
    if (!IGNORABLE.has(c)) { kept.push(c); keptOrig.push(i); }
  });
  const norm = normalizeForShaping(kept, (cp) => f.hasGlyphForCodePoint(cp));
  const text = String.fromCodePoint(...norm.map((n) => n.cp));
  const run = f.layout(text, featureObj, script, undefined, rtl ? 'rtl' : 'ltr');
  // fontkit returns right-to-left runs in visual order; HarfBuzz positions in
  // logical order and reverses at the very end, so do the same.
  if (rtl) {
    run.glyphs.reverse();
    run.positions.reverse();
  }
  // Fonts without GPOS get HarfBuzz's fallback mark positioning (Arial's Hebrew
  // niqqud and Arabic harakat are placed this way). Marks are always zero-width
  // by GDEF class, GPOS or not (hb-ot-shape.cc zero_mark_widths_by_gdef).
  const fallbackScaled = (f as any).GPOS
    ? new Set<number>()
    : positionFallbackMarks(f, run.glyphs, run.positions, rtl, size, f.unitsPerEm);
  zeroGdefMarkAdvances(f, run.glyphs, run.positions);
  const out: ShapedGlyph[] = [];
  const spaceId = f.glyphForCodePoint(32).id;
  // Map each fontkit glyph back to code point indices in the *original* array.
  let ci = 0;
  const normStart = norm.map((n) => keptOrig[n.start]);
  const normEnd = norm.map((n) => keptOrig[n.end]);
  // Ignorable code points become zero-width EMPTY glyphs, merged into clusters.
  const emptyAt = new Map<number, number>();
  codePoints.forEach((c, i) => {
    if (IGNORABLE.has(c)) emptyAt.set(i, c);
  });

  const glyphs: ShapedGlyph[] = [];
  let filtered = 0;
  // HarfBuzz kern-machine parity (hb-kern.hh): for a legacy 'kern' pair k,
  // HarfBuzz applies first.xAdvance += k>>1, second.xAdvance += k-(k>>1) and
  // second.xOffset += k-(k>>1) (after scaling), while fontkit folds all of k
  // into the first glyph's advance. Re-split so the emitted TJ adjustments and
  // glyph offsets match Pango/HarfBuzz byte-for-byte.
  const kernTables = (f as any).kern?.tables ?? [];
  const kernPair = (left: number, right: number): number => {
    // Mirrors fontkit's KernProcessor.getKerning (format 0 only; 2/3 are AAT).
    let res = 0;
    for (const table of kernTables) {
      if (table.coverage?.crossStream) continue;
      if (table.version === 0 && !table.coverage?.horizontal) continue;
      if (table.version === 1 && (table.coverage?.vertical || table.coverage?.variation)) continue;
      let val = 0;
      const s = table.subtable;
      if (table.format === 0) {
        const pairs = s.pairs;
        let lo = 0;
        let hi = pairs.length - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const p = pairs[mid];
          const c = left - p.left || right - p.right;
          if (c === 0) { val = p.value; break; }
          if (c < 0) hi = mid - 1;
          else lo = mid + 1;
        }
      } else continue;
      if (table.coverage.override) res = val;
      else res += val;
    }
    return res;
  };
  const kernSplit: Array<[number, number]> = [];
  if (kernTables.length && run.glyphs.length > 1) {
    for (let gi2 = 0; gi2 < run.glyphs.length - 1; gi2++) {
      const kFont = kernPair(run.glyphs[gi2].id, run.glyphs[gi2 + 1].id);
      if (!kFont) continue;
      const kScaled = scale(kFont, size, f.unitsPerEm);
      if (!kScaled) continue;
      const k1 = kScaled >> 1;
      kernSplit.push([gi2, kScaled - k1]);
    }
  }
  let previousCluster = 0;
  run.glyphs.forEach((g: any, i: number) => {
    const p = run.positions[i];
    const n = g.codePoints.length;
    // A glyph without code points (an extra glyph of a multiple substitution, e.g. Arabic) belongs to the cluster
    // of the glyph before it, as HarfBuzz reports it.
    const cluster = n === 0 && i > 0 ? previousCluster : normStart[filtered] ?? codePoints.length;
    const lastOrig = n === 0 ? cluster : normEnd[Math.min(filtered + n, norm.length) - 1] ?? cluster;
    filtered += n;
    previousCluster = cluster;
    const cp = g.codePoints[0];
    let gid = g.id;
    let advance: number;
    if (gid === 0 && cp in SPACE_FALLBACK) {
      gid = spaceId;
      advance = SPACE_FALLBACK[cp](f, size);
    } else {
      const base = g.advanceWidth;
      advance = scale(base, size, f.unitsPerEm) + scale(p.xAdvance - base, size, f.unitsPerEm);
    }
    if (gid === 0 && cp !== undefined) gid = PANGO_GLYPH_UNKNOWN_FLAG | cp;
    glyphs.push({
      gid, advance,
      xOffset: fallbackScaled.has(i) ? p.xOffset : scale(p.xOffset, size, f.unitsPerEm),
      yOffset: fallbackScaled.has(i) ? -p.yOffset : -scale(p.yOffset, size, f.unitsPerEm),
      cluster, clusterLength: lastOrig - cluster + 1,
    });
  });
  // Apply the HarfBuzz kern split (see comment above): fontkit put the whole
  // kern on the first glyph's advance; move the second half to the second glyph.
  for (const [gi2, k2] of kernSplit) {
    const a = glyphs[gi2];
    const b = glyphs[gi2 + 1];
    a.advance -= k2;
    b.advance += k2;
    b.xOffset += k2;
  }
  void ci;
  // Interleave ignorable characters as EMPTY glyphs at their position. Glyphs
  // stay in logical order with non-decreasing cluster values, so a cluster can
  // hold several glyphs (a base plus its marks) and composition can make a
  // later code point join an earlier cluster.
  let gi = 0;
  for (let i = 0; i < codePoints.length; i++) {
    if (emptyAt.has(i)) {
      out.push({ gid: PANGO_GLYPH_EMPTY, advance: 0, xOffset: 0, yOffset: 0, cluster: i, clusterLength: 1 });
      continue;
    }
    while (gi < glyphs.length && glyphs[gi].cluster <= i) out.push({ ...glyphs[gi++] });
  }
  while (gi < glyphs.length) out.push({ ...glyphs[gi++] });
  // Pango cluster lengths span to the next different cluster value, which is
  // also how a base+marks group reports the whole range.
  let nextCluster = codePoints.length;
  for (let k = out.length - 1; k >= 0; k--) {
    if (k < out.length - 1 && out[k + 1].cluster > out[k].cluster) nextCluster = out[k + 1].cluster;
    out[k].clusterLength = Math.max(1, nextCluster - out[k].cluster);
  }
  return out;
}

/** Zero the advance of every glyph GDEF classifies as a mark (class 3). */
function zeroGdefMarkAdvances(font: any, glyphs: any[], positions: any[]): void {
  const records: Array<{ start: number; end: number; class: number }> | undefined =
    font.GDEF?.glyphClassDef?.classRangeRecord;
  if (!records?.length) return;
  const isMark = (gid: number): boolean => {
    let lo = 0;
    let hi = records.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const record = records[mid];
      if (gid < record.start) hi = mid - 1;
      else if (gid > record.end) lo = mid + 1;
      else return record.class === 3;
    }
    return false;
  };
  for (let i = 0; i < glyphs.length; i++) {
    if (isMark(glyphs[i].id)) {
      positions[i].xAdvance = 0;
      positions[i].yAdvance = 0;
    }
  }
}

export interface FontExtents {
  ascent: number; // Pango units
  descent: number; // negative or positive as in hhea: stored positive below baseline
  height: number;
}

/** Ascent/descent like HarfBuzz h-extents: OS/2 typo metrics when USE_TYPO_METRICS, else hhea. */
export function fontExtents(face: FontFace, size: number): { ascent: number; descent: number } {
  const f = face.fk;
  const os2 = f['OS/2'];
  const typo = os2.fsSelection.useTypoMetrics;
  const asc = typo ? os2.typoAscender : f.hhea.ascent;
  const desc = typo ? os2.typoDescender : f.hhea.descent;
  return { ascent: scale(asc, size, f.unitsPerEm), descent: -scale(desc, size, f.unitsPerEm) };
}