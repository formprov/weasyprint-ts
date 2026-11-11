// SPDX-License-Identifier: BSD-3-Clause

/**
 * HarfBuzz's text normalization (hb-ot-shape-normalize.cc) in COMPOSED_DIACRITICS
 * mode, which is what Pango uses:
 *
 *  1. decompose every character, but only as far as the font has glyphs for the
 *     pieces (a "shortest" decomposition; a mark without a glyph blocks it);
 *  2. reorder combining marks by HarfBuzz's *modified* combining class, which
 *     permutes the fixed-position classes into the order the Hebrew/Arabic/
 *     Thai/Lao/Tibetan positioning rules expect;
 *  3. recompose starter+mark pairs when the font has the composed glyph.
 *
 * Composition follows UnicodeData.txt and ignores CompositionExclusions.txt,
 * like HarfBuzz: U+05E9 U+05C1 becomes U+FB2A (shin with shin dot).
 */
import { CCC_RANGES, COMPOSE, DECOMP } from './unicode_norm.ts';

const HANGUL_S_BASE = 0xac00;
const HANGUL_L_BASE = 0x1100;
const HANGUL_V_BASE = 0x1161;
const HANGUL_T_BASE = 0x11a7;
const HANGUL_L_COUNT = 19;
const HANGUL_V_COUNT = 21;
const HANGUL_T_COUNT = 28;
const HANGUL_N_COUNT = HANGUL_V_COUNT * HANGUL_T_COUNT;
const HANGUL_S_COUNT = HANGUL_L_COUNT * HANGUL_N_COUNT;

/** Canonical combining class, 0 for starters. */
export function combiningClass(cp: number): number {
  let lo = 0;
  let hi = CCC_RANGES.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = CCC_RANGES[mid * 3];
    const end = CCC_RANGES[mid * 3 + 1];
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return CCC_RANGES[mid * 3 + 2];
  }
  return 0;
}

/**
 * HarfBuzz's modified combining class (hb-unicode.cc _hb_modified_combining_class):
 * the Hebrew classes 10-26 are permuted per the SBL Hebrew manual, Arabic 27-36,
 * Telugu 84/91, Thai 103/107, Lao 118/122 and Tibetan 129-132 get new values.
 */
const MODIFIED_CCC = ((): Uint8Array => {
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  const hebrew = [22, 15, 16, 17, 23, 18, 19, 20, 21, 14, 24, 12, 25, 13, 10, 11, 26];
  hebrew.forEach((value, index) => { table[10 + index] = value; });
  const arabic = [28, 29, 30, 31, 32, 33, 27, 34, 35, 36];
  arabic.forEach((value, index) => { table[27 + index] = value; });
  table[84] = 4;
  table[91] = 5;
  table[103] = 3;
  table[129] = 129;
  table[130] = 132;
  table[132] = 131;
  return table;
})();

/** HarfBuzz's modified combining class for a code point. */
export function modifiedCombiningClass(cp: number): number {
  const klass = combiningClass(cp);
  return klass < 256 ? MODIFIED_CCC[klass] : klass;
}

const MARK = /^\p{M}$/u;

/** Unicode general category is a mark (Mn, Mc or Me), like _hb_glyph_info_is_unicode_mark. */
export function isUnicodeMark(cp: number): boolean {
  return MARK.test(String.fromCodePoint(cp));
}

/** Single-step canonical decomposition (Hangul syllables included). */
function decomposeOnce(cp: number, out: number[]): boolean {
  if (cp >= HANGUL_S_BASE && cp < HANGUL_S_BASE + HANGUL_S_COUNT) {
    // Unicode's Hangul decomposition is two steps: LVT -> LV + T, LV -> L + V.
    const index = cp - HANGUL_S_BASE;
    const t = index % HANGUL_T_COUNT;
    if (t !== 0) {
      out.push(cp - t);
      out.push(HANGUL_T_BASE + t);
    } else {
      out.push(HANGUL_L_BASE + Math.floor(index / HANGUL_N_COUNT));
      out.push(HANGUL_V_BASE + Math.floor((index % HANGUL_N_COUNT) / HANGUL_T_COUNT));
    }
    return true;
  }
  let lo = 0;
  let hi = DECOMP.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = mid * 3;
    if (cp < DECOMP[row]) hi = mid - 1;
    else if (cp > DECOMP[row]) lo = mid + 1;
    else {
      out.push(DECOMP[row + 1]);
      if (DECOMP[row + 2] !== 0) out.push(DECOMP[row + 2]);
      return true;
    }
  }
  return false;
}

/** Canonical composition of two code points, CompositionExclusions included. */
export function composePair(a: number, b: number): number | null {
  // Hangul: L + V -> LV, LV + T -> LVT.
  if (a >= HANGUL_L_BASE && a < HANGUL_L_BASE + HANGUL_L_COUNT &&
      b >= HANGUL_V_BASE && b < HANGUL_V_BASE + HANGUL_V_COUNT) {
    return HANGUL_S_BASE + ((a - HANGUL_L_BASE) * HANGUL_V_COUNT + (b - HANGUL_V_BASE)) * HANGUL_T_COUNT;
  }
  if (a >= HANGUL_S_BASE && a < HANGUL_S_BASE + HANGUL_S_COUNT && (a - HANGUL_S_BASE) % HANGUL_T_COUNT === 0 &&
      b > HANGUL_T_BASE && b < HANGUL_T_BASE + HANGUL_T_COUNT) {
    return a + (b - HANGUL_T_BASE);
  }
  let lo = 0;
  let hi = COMPOSE.length / 3 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = mid * 3;
    const first = COMPOSE[row];
    if (a < first) hi = mid - 1;
    else if (a > first) lo = mid + 1;
    else if (b < COMPOSE[row + 1]) hi = mid - 1;
    else if (b > COMPOSE[row + 1]) lo = mid + 1;
    else return COMPOSE[row + 2];
  }
  return null;
}

/** One code point of the normalized text, mapped back to an input range. */
export interface NormChar {
  cp: number;
  /** First input index this character covers. */
  start: number;
  /** Last input index this character covers (inclusive). */
  end: number;
}

/**
 * HarfBuzz's decompose() (hb-ot-shape-normalize.cc): recursively split `cp`,
 * stopping early when the font has a glyph for the first part. Returns 0 when
 * the character cannot be decomposed usefully (for example a mark the font
 * lacks), so the caller keeps it whole.
 */
function decompose(cp: number, shortest: boolean, hasGlyph: (cp: number) => boolean, out: number[]): number {
  const parts: number[] = [];
  if (!decomposeOnce(cp, parts)) return 0;
  const [a, b] = parts;
  if (b !== undefined && !hasGlyph(b)) return 0;
  const hasA = hasGlyph(a);
  if (shortest && hasA) {
    out.push(a);
    if (b !== undefined) { out.push(b); return 2; }
    return 1;
  }
  const nested: number[] = [];
  const ret = decompose(a, shortest, hasGlyph, nested);
  if (ret) {
    out.push(...nested);
    if (b !== undefined) { out.push(b); return ret + 1; }
    return ret;
  }
  if (hasA) {
    out.push(a);
    if (b !== undefined) { out.push(b); return 2; }
    return 1;
  }
  return 0;
}

/**
 * Normalize `cps` for shaping with a font that has `hasGlyph`.
 *
 * The returned characters carry the input index range they came from, so
 * callers can rebuild Pango cluster values after composition merged several
 * code points into one glyph.
 */
/** Hangul jamo ranges (hb-ot-shaper-hangul.cc isL/isV/isT). */
const isL = (cp: number): boolean => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c);
const isV = (cp: number): boolean => (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6);
const isT = (cp: number): boolean => (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb);
const isCombiningL = (cp: number): boolean => cp >= 0x1100 && cp < 0x1100 + HANGUL_L_COUNT;
const isCombiningV = (cp: number): boolean => cp >= 0x1161 && cp < 0x1161 + HANGUL_V_COUNT;
const isCombiningT = (cp: number): boolean => cp > 0x11a7 && cp < 0x11a7 + HANGUL_T_COUNT;

/**
 * HarfBuzz's Hangul shaper (hb-ot-shaper-hangul.cc preprocess_text_hangul):
 * compose <L,V> and <LV,T> when the font has the syllable, and decompose a
 * precomposed syllable the font lacks into jamo.
 */
function shapeHangul(cps: number[], hasGlyph: (cp: number) => boolean): NormChar[] {
  const out: NormChar[] = [];
  let i = 0;
  while (i < cps.length) {
    const u = cps[i];
    if (isL(u) && i + 1 < cps.length && isV(cps[i + 1])) {
      const v = cps[i + 1];
      const t = i + 2 < cps.length && isT(cps[i + 2]) ? cps[i + 2] : 0;
      if (isCombiningL(u) && isCombiningV(v) && (t === 0 || isCombiningT(t))) {
        const s = HANGUL_S_BASE + (u - HANGUL_L_BASE) * HANGUL_N_COUNT +
          (v - HANGUL_V_BASE) * HANGUL_T_COUNT + (t ? t - HANGUL_T_BASE : 0);
        if (hasGlyph(s)) {
          out.push({ cp: s, start: i, end: i + (t ? 2 : 1) });
          i += t ? 3 : 2;
          continue;
        }
      }
    } else if (u >= HANGUL_S_BASE && u < HANGUL_S_BASE + HANGUL_S_COUNT) {
      const index = u - HANGUL_S_BASE;
      const lindex = Math.floor(index / HANGUL_N_COUNT);
      const nindex = index % HANGUL_N_COUNT;
      const vindex = Math.floor(nindex / HANGUL_T_COUNT);
      const tindex = nindex % HANGUL_T_COUNT;
      if (tindex === 0 && i + 1 < cps.length && isCombiningT(cps[i + 1])) {
        const composed = u + (cps[i + 1] - HANGUL_T_BASE);
        if (hasGlyph(composed)) {
          out.push({ cp: composed, start: i, end: i + 1 });
          i += 2;
          continue;
        }
      }
      const has = hasGlyph(u);
      const followedByT = i + 1 < cps.length && isT(cps[i + 1]);
      if (!has || (tindex === 0 && followedByT)) {
        const l = HANGUL_L_BASE + lindex;
        const v = HANGUL_V_BASE + vindex;
        const t = HANGUL_T_BASE + tindex;
        if (hasGlyph(l) && hasGlyph(v) && (tindex === 0 || hasGlyph(t))) {
          out.push({ cp: l, start: i, end: i });
          out.push({ cp: v, start: i, end: i });
          if (tindex !== 0) out.push({ cp: t, start: i, end: i });
          // A precomposed LV followed by a non-combining T keeps that T in the cluster.
          if (has && tindex === 0 && followedByT) {
            out.push({ cp: cps[i + 1], start: i + 1, end: i + 1 });
            i += 2;
            continue;
          }
          i++;
          continue;
        }
      }
    }
    out.push({ cp: u, start: i, end: i });
    i++;
  }
  return out;
}

/**
 * HarfBuzz's Thai/Lao preprocessor (hb-ot-shaper-thai.cc): SARA AM decomposes
 * into NIKHAHIT + SARA AA, and the NIKHAHIT moves in front of the above-base
 * marks that preceded it.
 */
function shapeThai(input: NormChar[]): NormChar[] {
  const aboveBase = (cp: number): boolean => {
    const u = cp & ~0x80;
    return (u >= 0x0e34 && u <= 0x0e37) || (u >= 0x0e47 && u <= 0x0e4e) || u === 0x0e31 || u === 0x0e3b;
  };
  const out: NormChar[] = [];
  for (const item of input) {
    if ((item.cp & ~0x80) !== 0x0e33) {
      out.push(item);
      continue;
    }
    const nikhahit: NormChar = {
      cp: item.cp - 0x0e33 + 0x0e4d,
      start: item.start,
      end: item.start,
    };
    const saraAa: NormChar = { cp: item.cp - 1, start: item.start, end: item.end };
    // Move the NIKHAHIT before the above-base marks it follows.
    let start = out.length;
    while (start > 0 && aboveBase(out[start - 1].cp)) start--;
    if (start < out.length) nikhahit.start = out[start].start;
    out.splice(start, 0, nikhahit, saraAa);
  }
  return out;
}

export function normalizeForShaping(cps: number[], hasGlyph: (cp: number) => boolean): NormChar[] {
  const seq: NormChar[] = [];
  // The script shapers run before the normalizer; a character the font can draw
  // stays as it is (decompose_current_character's shortest path).
  for (const item of shapeThai(shapeHangul(cps, hasGlyph))) {
    if (hasGlyph(item.cp)) {
      seq.push(item);
      continue;
    }
    const parts: number[] = [];
    if (decompose(item.cp, true, hasGlyph, parts)) {
      for (const cp of parts) seq.push({ cp, start: item.start, end: item.end });
    } else {
      seq.push(item);
    }
  }

  // Reorder combining marks by modified combining class, stably, inside each
  // run of marks (HarfBuzz's compare_combining_class sort).
  for (let i = 0; i < seq.length; i++) {
    if (modifiedCombiningClass(seq[i].cp) === 0) continue;
    let end = i + 1;
    while (end < seq.length && modifiedCombiningClass(seq[end].cp) !== 0) end++;
    // Stable insertion sort, like hb_buffer_t::sort for short runs.
    for (let k = i + 1; k < end; k++) {
      const item = seq[k];
      const klass = modifiedCombiningClass(item.cp);
      let j = k - 1;
      while (j >= i && modifiedCombiningClass(seq[j].cp) > klass) { seq[j + 1] = seq[j]; j--; }
      seq[j + 1] = item;
    }
    i = end;
  }

  // Recompose (hb-ot-shape-normalize.cc, third round): only Unicode marks join
  // their starter, and only when no earlier mark in the cluster blocks them.
  if (seq.length) {
    const out: NormChar[] = [seq[0]];
    let starter = 0;
    for (let i = 1; i < seq.length; i++) {
      const cur = seq[i];
      if (isUnicodeMark(cur.cp)) {
        const prev = out[out.length - 1];
        const unblocked = out.length - 1 === starter || modifiedCombiningClass(prev.cp) < modifiedCombiningClass(cur.cp);
        const composed = unblocked ? composePair(out[starter].cp, cur.cp) : null;
        if (composed !== null && hasGlyph(composed)) {
          out[starter].cp = composed;
          out[starter].end = Math.max(out[starter].end, cur.end);
          continue;
        }
      }
      out.push(cur);
      if (modifiedCombiningClass(prevCp(out)) === 0) starter = out.length - 1;
    }
    return out;
  }
  return seq;
}

function prevCp(out: NormChar[]): number {
  return out[out.length - 1].cp;
}
