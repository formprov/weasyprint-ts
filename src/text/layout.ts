// SPDX-License-Identifier: BSD-3-Clause

/**
 * A Pango-like text layout (the part of PangoLayout that WeasyPrint uses),
 * implemented with fontkit and UAX #14 line breaking. Replaces text/ffi.py's
 * Pango/HarfBuzz/FontConfig bindings; behaviours replicated here were found by
 * differential testing (see memory: weasyprint-pango-semantics).
 */
import { LineBreaker } from 'linebreak';
import type { Style } from '../css/style.ts';
import { FontConfiguration, FontFace } from './font_config.ts';
import { LOGGER } from '../logger.ts';
import { PANGO_GLYPH_EMPTY, PANGO_GLYPH_UNKNOWN_FLAG, PANGO_SCALE, fontExtents, scale, shapeRun } from './shaper.ts';
import { sampleStringFor, utf8Strwidth } from './language_samples.ts';
import { NOTDEF_TTF_BASE64 } from './notdef.ts';
import { embeddingLevels } from './bidi.ts';
import { pyRound } from '../utils.ts';

/** Characters Pango's itemizer assigns no font (controls, formats, surrogates, line/paragraph/space separators). */
const NO_FONT = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]$/u;
const LOWERCASE = /^\p{Ll}$/u;
const SPACEISH = /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Zs}]$/u;
/** Pango itemize.c consider_as_space + g_unichar_islower: the lowercase segment of a caps run. */
const isLowerOrSpace = (cp: number): boolean => {
  const ch = String.fromCodePoint(cp);
  return LOWERCASE.test(ch) || (cp !== 0x1680 && SPACEISH.test(ch));
};
/** Pango's text-transform: uppercase, keeping one code point (the corpus never needs multi-char maps). */
const upperCodePoint = (cp: number): number => {
  const upper = String.fromCodePoint(cp).toUpperCase();
  return upper.codePointAt(0) ?? cp;
};
const ARABIC = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Thaana}]/u;
const HEBREW = /\p{Script=Hebrew}/u;

/**
 * OpenType script tag for shaping an item, as Pango's script iterator and
 * HarfBuzz's hb_ot_tags_from_script would report it. Scripts without an entry
 * keep 'latn' (the bank's Greek/Cyrillic/CJK cases were verified with it).
 */
const SCRIPT_TAGS: Array<[RegExp, string]> = [
  [ARABIC, 'arab'],
  [HEBREW, 'hebr'],
  [/\p{Script=Devanagari}/u, 'deva'],
  [/\p{Script=Bengali}/u, 'beng'],
  [/\p{Script=Gurmukhi}/u, 'guru'],
  [/\p{Script=Gujarati}/u, 'gujr'],
  [/\p{Script=Oriya}/u, 'orya'],
  [/\p{Script=Tamil}/u, 'taml'],
  [/\p{Script=Telugu}/u, 'telu'],
  [/\p{Script=Kannada}/u, 'knda'],
  [/\p{Script=Malayalam}/u, 'mlym'],
  [/\p{Script=Sinhala}/u, 'sinh'],
  [/\p{Script=Tibetan}/u, 'tibt'],
  [/\p{Script=Hangul}/u, 'hang'],
  [/\p{Script=Thai}/u, 'thai'],
  [/\p{Script=Lao}/u, 'lao'],
];

function scriptTag(cps: number[]): string {
  const text = String.fromCodePoint(...cps);
  for (const [pattern, tag] of SCRIPT_TAGS) if (pattern.test(text)) return tag;
  return 'latn';
}

let notdefFaceInstance: FontFace | null = null;
let noFontsWarned = false;

/** The synthetic face rendered when no fonts are available: every code point
 * draws the box glyph (upstream's "letters turn into rectangles"). */
function notdefFace(): FontFace {
  if (notdefFaceInstance === null) {
    const bytes = Uint8Array.from(atob(NOTDEF_TTF_BASE64), (c) => c.charCodeAt(0));
    notdefFaceInstance = new FontFace(
      { id: 'notdef', read: () => bytes },
      { family: '', fullName: '', weight: 400, width: 5, italic: false });
  }
  return notdefFaceInstance;
}
import type { ShapedGlyph } from './shaper.ts';

export const TO_UNITS = PANGO_SCALE;
export const FROM_UNITS = 1 / PANGO_SCALE;

export interface LogAttr {
  isLineBreak: boolean;
  isMandatoryBreak: boolean;
  isWordBoundary: boolean;
  isWordStart: boolean;
  isWordEnd: boolean;
  isCharBreak: boolean;
  isCursorPosition: boolean;
  isWhite: boolean;
}

// --- Break attributes -----------------------------------------------------------
/** UAX #14 opportunities, as code point indices -> required flag. */
function lineBreakOpportunities(cps: number[]): Map<number, boolean> {
  const text = String.fromCodePoint(...cps);
  const cpIndexOfUnit: number[] = new Array(text.length + 1);
  let u = 0;
  cps.forEach((c, i) => {
    cpIndexOfUnit[u] = i;
    if (c > 0xffff) cpIndexOfUnit[u + 1] = i;
    u += c > 0xffff ? 2 : 1;
  });
  cpIndexOfUnit[text.length] = cps.length;
  const out = new Map<number, boolean>();
  const lb = new LineBreaker(text);
  for (let b = lb.nextBreak(); b; b = lb.nextBreak()) {
    const idx = cpIndexOfUnit[b.position];
    if (idx !== undefined && idx < cps.length) out.set(idx, Boolean(b.required));
  }
  // Unicode 15.1 LB15a/b: break after quote + spaces before opening punctuation
  // (the `linebreak` library still implements the older LB15).
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i];
    if (c === 0x22 || c === 0x27 || c === 0x2018 || c === 0x2019 || c === 0x201c || c === 0x201d) {
      let j = i + 1;
      while (j < cps.length && cps[j] === 0x20) j++;
      if (j > i + 1 && j < cps.length && [0x28, 0x5b, 0x7b].includes(cps[j]) && !out.has(j)) out.set(j, false);
    }
  }
  // Pango (oracle) allows a break between a solidus and a following digit unless the solidus follows a
  // digit: "a/1" breaks after "/", "1/2" does not. The `linebreak` library applies LB25 (no break before NU).
  for (let i = 0; i + 1 < cps.length; i++) {
    if (cps[i] !== 0x2f || !/\p{Nd}/u.test(String.fromCodePoint(cps[i + 1]))) continue;
    if (i > 0 && /\p{Nd}/u.test(String.fromCodePoint(cps[i - 1]))) continue;
    out.set(i + 1, false);
  }
  return out;
}

/**
 * Characters that join words in UAX #29 but not in Pango: MidLetter / MidNumLet
 * (apostrophes, full stop, colon, middle dot…) and ExtendNumLet (underscore and
 * friends, U+202F). Verified against the oracle's get_next_word_boundaries.
 */
const PANGO_WORD_SEPARATORS = new Set<number>([
  0x27, 0x2e, 0x3a, 0xb7, 0x387, 0x5f4, 0x2018, 0x2019, 0x2024, 0x2027, 0xfe13, 0xfe52, 0xfe55, 0xff07, 0xff0e, 0xff1a,
  0x5f, 0x202f, 0x203f, 0x2040, 0x2054, 0xfe33, 0xfe34, 0xfe4d, 0xfe4e, 0xfe4f, 0xff3f,
]);

const segmenterWord = new Intl.Segmenter('en', { granularity: 'word' });
const segmenterGrapheme = new Intl.Segmenter('en', { granularity: 'grapheme' });

export function getLogAttrsForText(text: string): LogAttr[] {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  const n = cps.length;
  const attrs: LogAttr[] = Array.from({ length: n + 1 }, () => ({
    isLineBreak: false, isMandatoryBreak: false, isWordBoundary: false, isWordStart: false, isWordEnd: false,
    isCharBreak: false, isCursorPosition: false, isWhite: false,
  }));
  const opportunities = lineBreakOpportunities(cps);
  for (const [i, required] of opportunities) {
    attrs[i].isLineBreak = true;
    attrs[i].isMandatoryBreak = required;
  }
  // Positions are code point indices; build UTF-16 -> code point map for segmenters.
  const unitToCp: number[] = [];
  cps.forEach((c, i) => {
    unitToCp.push(i);
    if (c > 0xffff) unitToCp.push(i);
  });
  unitToCp.push(n);
  for (const seg of segmenterGrapheme.segment(text)) {
    attrs[unitToCp[seg.index]].isCursorPosition = true;
    attrs[unitToCp[seg.index]].isCharBreak = true;
  }
  attrs[n].isCursorPosition = true;
  attrs[n].isCharBreak = true;
  for (const seg of segmenterWord.segment(text)) {
    const start = unitToCp[seg.index];
    const end = unitToCp[seg.index + seg.segment.length];
    attrs[start].isWordBoundary = true;
    attrs[end].isWordBoundary = true;
    // Pango doesn't apply UAX #29's MidLetter/MidNumLet/ExtendNumLet joining rules
    // (WB6/7, WB13a/b), so those characters end a word where ICU would join across them.
    let pieceStart = start;
    for (let i = start; i < end; i++) {
      if (!PANGO_WORD_SEPARATORS.has(cps[i])) continue;
      if (i > pieceStart && seg.isWordLike) {
        attrs[pieceStart].isWordStart = true;
        attrs[i].isWordEnd = true;
      }
      attrs[i].isWordBoundary = true;
      attrs[i + 1].isWordBoundary = true;
      pieceStart = i + 1;
    }
    if (seg.isWordLike && end > pieceStart) {
      attrs[pieceStart].isWordStart = true;
      attrs[end].isWordEnd = true;
    }
  }
  cps.forEach((c, i) => {
    attrs[i].isWhite = c === 0x20 || c === 0x09 || c === 0x0a;
  });
  return attrs;
}

// --- Layout -----------------------------------------------------------------------
export interface Run {
  face: FontFace;
  /** Font size in Pango units. */
  size: number;
  glyphs: ShapedGlyph[];
  /** Code point range in the layout text. */
  start: number;
  end: number;
  /** UTF-8 byte offset and length of the run in the layout text. */
  byteOffset: number;
  byteLength: number;
  level: number;
}

export interface Line {
  /** Length in UTF-8 bytes (not counting a paragraph delimiter). */
  length: number;
  /** UTF-8 byte index where the line starts. */
  startIndex: number;
  runs: Run[];
  /** Logical extents, in Pango units. */
  width: number;
  height: number;
  ascent: number;
  resolvedDir: number;
}

export const PANGO_WRAP = { WORD: 0, CHAR: 1, WORD_CHAR: 2 } as const;
type WrapMode = (typeof PANGO_WRAP)[keyof typeof PANGO_WRAP];

const utf8Len = (cp: number): number => (cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);

function fontFeaturesOf(style: Style): Record<string, number> {
  return fontFeatures(
    style.get('font_kerning'), style.get('font_variant_ligatures'), style.get('font_variant_position'),
    style.get('font_variant_caps'), style.get('font_variant_numeric'), style.get('font_variant_alternates'),
    style.get('font_variant_east_asian'), style.get('font_feature_settings'));
}

const LIGATURE_KEYS: Record<string, string[]> = {
  'common-ligatures': ['liga', 'clig'], 'historical-ligatures': ['hlig'], 'discretionary-ligatures': ['dlig'], contextual: ['calt'],
};
const CAPS_KEYS: Record<string, string[]> = {
  'small-caps': ['smcp'], 'all-small-caps': ['c2sc', 'smcp'], 'petite-caps': ['pcap'], 'all-petite-caps': ['c2pc', 'pcap'],
  unicase: ['unic'], 'titling-caps': ['titl'],
};
const NUMERIC_KEYS: Record<string, string> = {
  'lining-nums': 'lnum', 'oldstyle-nums': 'onum', 'proportional-nums': 'pnum', 'tabular-nums': 'tnum',
  'diagonal-fractions': 'frac', 'stacked-fractions': 'afrc', ordinal: 'ordn', 'slashed-zero': 'zero',
};
const EAST_ASIAN_KEYS: Record<string, string> = {
  jis78: 'jp78', jis83: 'jp83', jis90: 'jp90', jis04: 'jp04', simplified: 'smpl', traditional: 'trad',
  'full-width': 'fwid', 'proportional-width': 'pwid', ruby: 'ruby',
};

/** Font features from the font-* properties (mirrors text/fonts.py font_features). */
export function fontFeatures(
  fontKerning = 'normal', ligatures: any = 'normal', position = 'normal', caps = 'normal', numeric: any = 'normal',
  alternates = 'normal', eastAsian: any = 'normal', settings: any = 'normal',
): Record<string, number> {
  const features: Record<string, number> = {};
  if (fontKerning !== 'auto') features.kern = Number(fontKerning === 'normal');
  if (ligatures === 'none') {
    for (const keys of Object.values(LIGATURE_KEYS)) for (const k of keys) features[k] = 0;
  } else if (ligatures !== 'normal') {
    for (let t of ligatures as string[]) {
      let value = 1;
      if (t.startsWith('no-')) {
        value = 0;
        t = t.slice(3);
      }
      for (const k of LIGATURE_KEYS[t]) features[k] = value;
    }
  }
  if (position === 'sub') features.subs = 1;
  else if (position === 'super') features.sups = 1;
  if (caps !== 'normal') for (const k of CAPS_KEYS[caps]) features[k] = 1;
  if (numeric !== 'normal') for (const k of numeric as string[]) features[NUMERIC_KEYS[k]] = 1;
  if (alternates === 'historical-forms') features.hist = 1;
  if (eastAsian !== 'normal') for (const k of eastAsian as string[]) features[EAST_ASIAN_KEYS[k]] = 1;
  if (settings !== 'normal') for (const [k, v] of settings as Array<[string, number]>) features[k] = v;
  return features;
}

/**
 * UAX #9 L2 (pango_layout_line_reorder), in place on logically ordered runs: from the highest level down to the
 * lowest odd one, reverse every maximal sequence of runs at that level or higher.
 */
function reorderRuns(lineRuns: Run[]): void {
  if (!lineRuns.some((r) => r.level)) return;
  const maxLevel = Math.max(...lineRuns.map((r) => r.level));
  const minOdd = Math.min(...lineRuns.map((r) => (r.level % 2 ? r.level : r.level + 1)));
  for (let level = maxLevel; level >= minOdd; level--) {
    for (let k = 0; k < lineRuns.length; k++) {
      if (lineRuns[k].level < level) continue;
      let e = k;
      while (e < lineRuns.length && lineRuns[e].level >= level) e++;
      const reversed = lineRuns.slice(k, e).reverse();
      lineRuns.splice(k, e - k, ...reversed);
      k = e;
    }
  }
}

export class Layout {
  style: Style;
  justificationSpacing: number;
  maxWidth: number | null;
  fontConfig: FontConfiguration;
  firstLineDirection = 0;
  text = '';

  // Metrics for text decoration (set when the style has text-decoration).
  ascent: number | null = null;
  underlinePosition: number | null = null;
  underlineThickness: number | null = null;
  strikethroughPosition: number | null = null;
  strikethroughThickness: number | null = null;

  private widthUnits = -1;
  private wrap: WrapMode = PANGO_WRAP.WORD;
  private faces: FontFace[] = [];
  private size = 0;
  private capsVariant = 'normal';
  private features: Record<string, number> = {};
  private cps: number[] = [];
  private attrs: LogAttr[] = [];
  /** Language of the layout (PangoLayout language; drives the sample-string metrics). */
  private language: string | null = null;
  private letterSpacing = 0;
  private wordSpacing = 0;
  private spaceSpacingAtEnds = false;
  /** Shaped glyphs for each paragraph, one list per run. */
  private paragraphs: Array<{ start: number; end: number; runs: Run[]; byteStart: number }> = [];
  private byteOffsets: number[] = [];
  private singleParagraphMode = false;
  private ellipsize = false;
  private levels: Uint8Array | null = null;
  /** Distance between tab stops in Pango units (Python: set_tabs), 0 when the text has no tab. */
  private tabWidth = 0;
  private levelsText: string | null = null;
  private approxWidthCache = new Map<string, number>();

  constructor(style: Style, justificationSpacing = 0, maxWidth: number | null = null) {
    this.justificationSpacing = justificationSpacing;
    this.maxWidth = maxWidth;
    this.style = style;
    this.fontConfig = style.fontConfig as FontConfiguration;
    this.setup(style);
  }

  setup(style: Style): void {
    this.style = style;
    this.firstLineDirection = 0;
    this.fontConfig = style.fontConfig as FontConfiguration;
    // Python: the language comes from style['font_language_override'] or style['lang'], else the default.
    const override = style.get('font_language_override');
    this.language = (typeof override === 'string' && override !== 'normal'
      ? override : (style.get('lang') as string | null) ?? null) || null;
    const families = style.get('font_family') as string[];
    this.faces = this.fontConfig.match(families, style.get('font_weight'), style.get('font_style'), style.get('font_stretch'));
    if (!this.faces.length) {
      // Mirror upstream's no-fonts behavior: warn once and render rectangles.
      if (!noFontsWarned) {
        noFontsWarned = true;
        LOGGER.warning('No fonts configured in FontConfig. Expect ugly output.');
      }
      this.faces = [notdefFace()];
    }
    this.size = Math.trunc(style.get('font_size') * TO_UNITS);
    this.capsVariant = style.get('font_variant_caps') as string;
    this.features = fontFeaturesOf(style);
    if (style.get('text_decoration_line') !== 'none') {
      const face = this.faces[0];
      const { ascent } = fontExtents(face, this.size);
      const f = face.fk;
      const upem = f.unitsPerEm;
      this.ascent = ascent * FROM_UNITS;
      this.underlinePosition = scale(f.underlinePosition, this.size, upem) * FROM_UNITS;
      this.underlineThickness = scale(f.underlineThickness, this.size, upem) * FROM_UNITS;
      const os2 = f['OS/2'];
      this.strikethroughPosition = scale(os2.yStrikeoutPosition ?? Math.round(f.ascent / 3), this.size, upem) * FROM_UNITS;
      this.strikethroughThickness = scale(os2.yStrikeoutSize ?? f.underlineThickness, this.size, upem) * FROM_UNITS;
    } else {
      this.ascent = this.underlinePosition = this.strikethroughPosition = null;
    }
  }

  setWidth(units: number): void {
    this.widthUnits = units;
  }
  setWrap(mode: WrapMode): void {
    this.wrap = mode;
  }
  setSingleParagraphMode(on: boolean): void {
    this.singleParagraphMode = on;
    this.reshape();
  }
  setEllipsize(on: boolean): void {
    this.ellipsize = on;
  }

  /** Set the text; mirrors Layout.set_text in text/line_break.py (spacing attributes are applied here). */
  setText(textIn: string, justify = false): void {
    let text = textIn;
    const index = text.indexOf('\n');
    if (index !== -1) text = text.slice(0, index + 2); // keep only the first line plus one character
    this.text = text;

    let wordSpacing = this.style.get('word_spacing') as number;
    if (justify) wordSpacing += this.justificationSpacing;
    let letterSpacing = this.style.get('letter_spacing');
    if (letterSpacing === 'normal') letterSpacing = 0;
    this.letterSpacing = Math.trunc(letterSpacing * TO_UNITS);
    this.wordSpacing = wordSpacing;
    if (text === ' ' && wordSpacing) {
      // Word spacing needs more than one space: Space + zero-width space.
      this.text = ' ​';
    }
    this.cps = [...this.text].map((c) => c.codePointAt(0)!);
    this.byteOffsets = [0];
    for (const c of this.cps) this.byteOffsets.push(this.byteOffsets[this.byteOffsets.length - 1] + utf8Len(c));
    this.attrs = getLogAttrsForText(this.text);
    // Python: `if b'\t' in bytestring: self.set_tabs()`.
    this.tabWidth = this.text.includes('\t') ? this.computeTabWidth() : 0;
    this.reshape();
  }

  /** Itemize into font runs and shape each paragraph. */
  private reshape(): void {
    this.paragraphs = [];
    const n = this.cps.length;
    let start = 0;
    while (start <= n) {
      let end = start;
      while (end < n && this.cps[end] !== 0x0a && this.cps[end] !== 0x2029) end++;
      const paragraphEnd = end;
      this.paragraphs.push({
        start, end: paragraphEnd, runs: this.tabbed(this.shapeRange(start, paragraphEnd)), byteStart: this.byteOffsets[start],
      });
      if (end >= n) break;
      start = end + 1;
      if (start === n && this.singleParagraphMode) break;
      if (start === n) {
        this.paragraphs.push({ start: n, end: n, runs: [], byteStart: this.byteOffsets[n] });
        break;
      }
    }
  }

  private faceFor(cp: number, current: FontFace | null): FontFace {
    // Itemize like Pango: walk the ordered face list (requested families
    // first, then the config's fallbacks) and take the first face covering
    // the code point. No sticky fallback — a character covered by an
    // earlier face returns to it even after a fallback glyph (the oracle
    // renders '♥ Thank you!' as [math ♥][Pacifico ' Thank you!']).
    for (const face of this.faces) if (face.hasGlyph(cp)) return face;
    return current ?? this.faces[0];
  }

  /**
   * Python: Layout.set_tabs. tab-size as a number of spaces is the width of that many spaces laid out in this style
   * (line_size, so letter-spacing is added once), rounded to pixels; a length is truncated to pixels. One left tab at
   * that position, in pixels; Pango repeats it.
   */
  private computeTabWidth(): number {
    const tabSize = this.style.get('tab_size');
    let width: number;
    if (typeof tabSize === 'number') {
      const layout = new Layout(this.style, this.justificationSpacing);
      layout.setText(' '.repeat(tabSize));
      const [line] = layout.getFirstLine();
      width = line.width * FROM_UNITS;
      if (this.style.get('letter_spacing') !== 'normal') width += this.style.get('letter_spacing');
      width = pyRound(width);
    } else width = Math.trunc(tabSize.value);
    return (width || 1) * TO_UNITS; // 0 is not handled correctly by Pango
  }

  /**
   * Pango shape_tab: a tab is an empty glyph reaching the first tab stop at least one unit after the current
   * position (user tab arrays are respected to the pixel). Positions are relative to the start of `runs`.
   */
  private resolveTabs(runs: Run[]): void {
    if (!this.tabWidth) return;
    let x = 0;
    for (const run of runs) {
      for (const g of run.glyphs) {
        if (this.cps[g.cluster] === 0x09 && g.gid === PANGO_GLYPH_EMPTY) {
          const stop = Math.ceil((x + 1) / this.tabWidth) * this.tabWidth;
          g.advance = Math.max(stop - x, 0);
        }
        x += g.advance;
      }
    }
  }

  private tabbed(runs: Run[]): Run[] {
    this.resolveTabs(runs);
    return runs;
  }

  /** Embedding levels of the paragraph containing code points [start, end) (fribidi via Pango's itemizer). */
  private levelsFor(start: number, end: number): Uint8Array {
    if (!this.levels || this.levelsText !== this.text) {
      this.levels = new Uint8Array(this.cps.length);
      this.levelsText = this.text;
      const base = this.style.get('direction') === 'rtl' ? 1 : 0;
      for (const para of this.paragraphRanges()) {
        const lv = embeddingLevels(this.cps.slice(para[0], para[1]), base);
        this.levels.set(lv, para[0]);
      }
      // Paragraph separators themselves sit at the base level.
      for (let i = 0; i < this.cps.length; i++) if (this.cps[i] === 0x0a || this.cps[i] === 0x2029) this.levels[i] = base;
    }
    return this.levels.subarray(start, end);
  }

  private paragraphRanges(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let start = 0;
    for (let i = 0; i <= this.cps.length; i++) {
      if (i === this.cps.length || this.cps[i] === 0x0a || this.cps[i] === 0x2029) {
        out.push([start, i]);
        start = i + 1;
      }
    }
    return out;
  }

  private shapeRange(start: number, end: number): Run[] {
    const runs: Run[] = [];
    if (start === end) return runs;
    const levels = this.levelsFor(start, end);
    // Pango gives each word-spaced character its own letter-spacing attribute, which
    // splits shaping runs there: kerning and ligatures never span such a space.
    const textLen = this.cps.length;
    const spacingKey = (i: number): number => {
      if (!this.wordSpacing) return 0;
      const cp = this.cps[i];
      if (cp !== 0x20 && cp !== 0xa0) return 0;
      return 1 + Number(i === 0 || i === textLen - 1);
    };
    const position = (face: FontFace): number => {
      const k = this.faces.indexOf(face);
      return k === -1 ? this.faces.length : k;
    };
    // Items: [start, end, face], split on level and attribute (spacing) changes, then by font as Pango's
    // itemize_state_process_run: space-like characters get no font of their own and join the current item; an
    // item starting with them takes the font of its first fonted character; and trailing spaces move to the next
    // item when its font comes earlier in the fontset (pango#249).
    const items: Array<{ start: number; end: number; face: FontFace | null; level: number }> = [];
    let segStart = start;
    while (segStart < end) {
      const level = levels[segStart - start];
      const key = spacingKey(segStart);
      let segEnd = segStart + 1;
      // Pango forces item breaks before and after a tab (itemize_state_process_run: is_forced_break).
      const isTab = (i: number): boolean => this.cps[i] === 0x09;
      if (!isTab(segStart)) {
        while (segEnd < end && levels[segEnd - start] === level && spacingKey(segEnd) === key && !isTab(segEnd)) segEnd++;
      }
      let item: { start: number; end: number; face: FontFace | null; level: number } | null = null;
      let firstSpace = -1;
      for (let i = segStart; i < segEnd; i++) {
        const cp = this.cps[i];
        const isSpace = NO_FONT.test(String.fromCodePoint(cp)) && cp !== 0x1680;
        let face: FontFace | null = isSpace || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)
          ? null : this.faceFor(cp, null);
        if (item) {
          if (!item.face && face) item.face = face;
          else if (item.face && !face) face = item.face;
          if (item.face === face) {
            item.end = i + 1;
            firstSpace = isSpace ? (firstSpace === -1 ? i : firstSpace) : -1;
            continue;
          }
          let newStart = i;
          if (firstSpace > item.start && face && item.face && position(face) < position(item.face)) newStart = firstSpace;
          item.end = newStart;
          items.push(item);
          item = { start: newStart, end: i + 1, face, level };
        } else item = { start: i, end: i + 1, face, level };
        firstSpace = isSpace ? (firstSpace === -1 ? i : firstSpace) : -1;
      }
      if (item) items.push(item);
      segStart = segEnd;
    }
    // Items without a font (only space-like characters) take the font of the next item that has one
    // (itemize_state_fill_font); trailing ones get the base font, the first face of the fontset.
    for (let k = items.length - 1, next: FontFace | null = null; k >= 0; k--) {
      if (items[k].face) next = items[k].face;
      else items[k].face = next;
    }
    const approxCharWidth = (face: FontFace): number => {
      // Python: pango's approximate_char_width — the LOGICAL width of the language's sample
      // string divided by its UTF-8 string width (pangofc-font.c) — used as the advance of
      // unknown glyphs (U+2028/U+2029 are always unknown, this.toUnicode keeps the code point).
      const sample = sampleStringFor(this.language);
      const key = `${face.id}|${this.size}|${sample.slice(0, 24)}|${this.language ?? ''}`;
      let px = this.approxWidthCache.get(key);
      if (px === undefined) {
        const glyphs = shapeRun(face, [...sample].map((c) => c.codePointAt(0)!), this.size, {}, false, false, 'latn');
        // Pango: approximate_char_width = extents.width / sample_str_width with C integer
        // division (pango 1.57 pangofc-font.c: an int, so 356503/44 = 8102, never 8102.34).
        px = Math.floor(glyphs.reduce((sum, g) => sum + g.advance, 0) / utf8Strwidth(sample));
        this.approxWidthCache.set(key, px);
      }
      return px;
    };
    for (const it of items) {
      const face = it.face ?? this.faces[0];
      const cps = this.cps.slice(it.start, it.end);
      const rtl = it.level % 2 === 1;
      // Pango shapes with the font's own features (fontconfig) first, then the style's, which win.
      const features = Object.keys(face.features).length ? { ...face.features, ...this.features } : this.features;
      const shapeSegment = (segCps: number[], size: number, segStart: number, segEnd: number): void => {
        const glyphs = segCps.length === 1 && segCps[0] === 0x09
          ? [{ gid: PANGO_GLYPH_EMPTY, advance: 0, xOffset: 0, yOffset: 0, cluster: 0, clusterLength: 1 }] // see resolveTabs
          : shapeRun(face, segCps, size, features, false, rtl, scriptTag(segCps));
        // Pango itemizes U+2028 and U+2029 as zero-width: they never shape through the font's
        // cmap; they always render as unknown glyphs at the approximate char width (verified
        // against the oracle with fonts whose cmap DOES contain uni2028).
        for (const g of glyphs) {
          const cp = segCps[g.cluster];
          if (cp === 0x2028 || cp === 0x2029) {
            g.gid = PANGO_GLYPH_UNKNOWN_FLAG | cp;
            g.advance = approxCharWidth(face);
          }
        }
        const spaced = this.applySpacing(glyphs, segStart, segEnd);
        const positioned = spaced.map((g) => ({ ...g, cluster: g.cluster + segStart }));
        if (rtl) positioned.reverse(); // visual order, as HarfBuzz returns right-to-left glyph strings
        runs.push({
          face, size, glyphs: positioned, start: segStart, end: segEnd, byteOffset: this.byteOffsets[segStart],
          byteLength: this.byteOffsets[segEnd] - this.byteOffsets[segStart], level: it.level,
        });
      };

      const caps = this.capsSynthesis(face);
      if (caps) {
        // Split into lowercase/uppercase runs and uppercase+scale the lowercase ones,
        // exactly like Pango's split_item_for_variant.
        let pos = 0;
        while (pos < cps.length) {
          const lower = isLowerOrSpace(cps[pos]);
          let end = pos + 1;
          while (end < cps.length && isLowerOrSpace(cps[end]) === lower) end++;
          const segCps = cps.slice(pos, end);
          let size = this.size;
          if (lower) {
            if (caps.lowerTransform) for (let k = 0; k < segCps.length; k++) segCps[k] = upperCodePoint(segCps[k]);
            if (caps.lowerScale) size = Math.round(size * caps.scale);
          } else if (caps.upperScale) size = Math.round(size * caps.scale);
          shapeSegment(segCps, size, it.start + pos, it.start + end);
          pos = end;
        }
        continue;
      }
      shapeSegment(cps, this.size, it.start, it.end);
    }
    return runs;
  }

  /**
   * Pango's synthetic caps (itemize.c split_item_for_variant): when the face
   * lacks the OpenType features for the variant, lowercase runs are
   * uppercased and scaled by x-height/cap-height (and uppercase runs are
   * scaled for all-* and unicase), like Pango's PANGO_FONT_SCALE_SMALL_CAPS.
   */
  private capsSynthesis(face: FontFace): {
    lowerTransform: boolean; lowerScale: boolean; upperScale: boolean; scale: number;
  } | null {
    const variant = this.capsVariant;
    if (variant === 'normal' || variant === 'titling-caps') return null;
    const tags = CAPS_KEYS[variant];
    if (!tags) return null;
    const list = (face.fk as any).GSUB?.featureList;
    if (list) {
      const have = new Set(list.map((f: any) => f.tag));
      if (tags.every((tag: string) => have.has(tag))) return null;
    }
    const os2 = (face.fk as any)['OS/2'];
    const scale = os2?.xHeight && os2?.capHeight ? os2.xHeight / os2.capHeight : 0.8;
    const lowerTransform = variant === 'small-caps' || variant === 'petite-caps' ||
      variant === 'all-small-caps' || variant === 'all-petite-caps';
    return {
      lowerTransform, lowerScale: lowerTransform,
      upperScale: variant === 'all-small-caps' || variant === 'all-petite-caps' || variant === 'unicase',
      scale,
    };
  }

  /** Letter spacing and word spacing as Pango applies them (half before, half after each glyph). */
  private applySpacing(glyphs: ShapedGlyph[], runStart: number, runEnd: number): ShapedGlyph[] {
    if (!this.letterSpacing && !this.wordSpacing) return glyphs;
    const out = glyphs.map((g) => ({ ...g }));
    for (const g of out) {
      const cp = this.cps[runStart + g.cluster];
      let spacing = this.letterSpacing;
      if (cp === 0x20 || cp === 0xa0) {
        const textLen = this.cps.length;
        const globalIndex = runStart + g.cluster;
        const factor = 1 + Number(globalIndex === 0 || globalIndex === textLen - 1);
        spacing = Math.trunc(this.wordSpacing * TO_UNITS + this.letterSpacing) * factor;
      }
      if (!spacing) continue;
      // pango_glyph_item_letter_space: when the spacing is a whole number of pixels the
      // left half is rounded to a pixel ("hinting"), moving all of an odd pixel before the glyph.
      let left = Math.trunc(spacing / 2);
      if ((spacing & (TO_UNITS - 1)) === 0) left = (left + (TO_UNITS >> 1)) & ~(TO_UNITS - 1);
      const right = spacing - left;
      const first = runStart + g.cluster === 0;
      const last = runStart + g.cluster + g.clusterLength >= this.cps.length;
      const l = first ? 0 : left;
      const r = last ? 0 : right;
      g.xOffset += l;
      g.advance += l + r;
    }
    void runEnd;
    return out;
  }

  /** Width in Pango units of code points [start, pos) in a paragraph, ignoring trailing spaces. */
  private measure(runs: Run[], from: number, to: number, trimTrailingSpaces: boolean): number {
    let end = to;
    if (trimTrailingSpaces) while (end > from && this.cps[end - 1] === 0x20) end--;
    let width = 0;
    for (const run of runs) {
      for (const g of run.glyphs) {
        if (g.cluster >= from && g.cluster < end) width += g.advance;
      }
    }
    return width;
  }

  private paragraphOf(index: number): number {
    for (let i = 0; i < this.paragraphs.length; i++) {
      const p = this.paragraphs[i];
      if (index >= p.start && index <= p.end) return i;
    }
    return this.paragraphs.length - 1;
  }

  /** Candidate break positions (code point indices) inside a paragraph, after `from`. */
  private breakCandidates(para: { start: number; end: number }, from: number): number[] {
    const out: number[] = [];
    const isCluster = (pos: number): boolean => pos >= para.end || this.attrs[pos].isCursorPosition;
    for (let pos = from + 1; pos < para.end; pos++) {
      const a = this.attrs[pos];
      const ok = this.wrap === PANGO_WRAP.CHAR ? a.isCharBreak : a.isLineBreak && !a.isMandatoryBreak;
      if (ok && isCluster(pos)) out.push(pos);
    }
    return out;
  }

  /**
   * Return `[firstLine, resumeIndex]` where resumeIndex is the UTF-8 start index of
   * the second line, or null when there is none (Python: Layout.get_first_line).
   */
  getFirstLine(): [Line, number | null] {
    const [line, next] = this.lineAt(0, 0);
    this.firstLineDirection = line.resolvedDir;
    return [line, next];
  }

  /** Advance of the hyphen Pango draws when it breaks at a soft hyphen (U+2010, else the CSS character). */
  private hyphenAdvanceCache: number | null = null;
  private hyphenAdvance(): number {
    if (this.hyphenAdvanceCache !== null) return this.hyphenAdvanceCache;
    const styleChar = [...String(this.style.get('hyphenate_character'))].map((c) => c.codePointAt(0)!)[0];
    for (const cp of [0x2010, styleChar, 0x2d]) {
      const face = this.faces.find((f) => f.hasGlyph(cp));
      if (face) {
        this.hyphenAdvanceCache = shapeRun(face, [cp], this.size, this.features)
          .reduce((sum, g) => sum + g.advance, 0);
        return this.hyphenAdvanceCache;
      }
    }
    this.hyphenAdvanceCache = 0;
    return 0;
  }

  /** Line starting at code point `from` in paragraph `pi`, and the start byte of the following line. */
  private lineAt(pi: number, from: number): [Line, number | null] {
    const para = this.paragraphs[pi];
    let lineEnd = para.end; // exclusive, code points
    let wrapped = false;
    // Pango: a mandatory break (U+2028/U+2029; \n becomes a paragraph split) ends the line at
    // the break attribute — the break code point itself stays on the first line and is drawn,
    // whatever the layout width is (test: line_break_before_trailing_space).
    for (let pos = from + 1; pos < para.end; pos++) {
      const a = this.attrs[pos];
      if (a.isMandatoryBreak && a.isLineBreak && this.attrs[pos].isCursorPosition) {
        lineEnd = pos;
        wrapped = true;
        break;
      }
    }
    if (!wrapped && this.widthUnits >= 0 && para.end > from && !this.ellipsize) { // an ellipsized paragraph is not wrapped
      const max = this.widthUnits;
      const candidates = this.breakCandidates(para, from);
      let chosen = -1;
      for (const pos of candidates) {
        // Pango breaks after a soft hyphen only when the hyphen itself fits: the
        // SHY shapes to a zero-width empty glyph, so add the hyphen's advance.
        const extra = pos > from && this.cps[pos - 1] === 0xad ? this.hyphenAdvance() : 0;
        if (this.measure(para.runs, from, pos, false) + extra <= max) chosen = pos;
        else break;
      }
      if (this.measure(para.runs, from, para.end, false) <= max) chosen = -2; // all fits (trailing spaces count, as in Pango)
      if (chosen === -2) {
        lineEnd = para.end;
      } else {
        if (chosen === -1) chosen = candidates[0] ?? para.end; // overflow: first opportunity
        lineEnd = chosen;
        wrapped = lineEnd < para.end;
      }
    }
    let line = this.buildLine(para, from, lineEnd, wrapped);
    if (this.ellipsize && this.widthUnits >= 0 && line.width > this.widthUnits) line = this.ellipsizeEnd(line, from, lineEnd);
    let next: number | null = null;
    if (lineEnd < para.end) next = this.byteOffsets[lineEnd];
    else if (pi + 1 < this.paragraphs.length) next = this.paragraphs[pi + 1].byteStart;
    return [line, next];
  }

  /**
   * PANGO_ELLIPSIZE_END (pango ellipsize.c): remove grapheme clusters from the end until the kept glyphs plus the
   * ellipsis fit the layout width, replace them with one ellipsis run covering the removed text, and widen its last
   * glyph so the line is exactly the layout width (fixup_ellipsis_run). Kept glyphs keep their original shaping.
   */
  private ellipsizeEnd(line: Line, from: number, to: number): Line {
    const goal = this.widthUnits;
    // Logical runs (buildLine reorders right-to-left runs; ellipsizing works on logical order).
    const runs = [...line.runs].sort((a, b) => a.start - b.start);
    const widthOf = (start: number, end: number): number => {
      let w = 0;
      for (const run of runs) for (const g of run.glyphs) if (g.cluster >= start && g.cluster < end) w += g.advance;
      return w;
    };
    const total = widthOf(from, to);
    // The ellipsis takes the font of the first face covering U+2026, else "..." in the base font.
    const shapeEllipsis = (): { face: FontFace; glyphs: ShapedGlyph[] } => {
      const face = this.faces.find((f) => f.hasGlyph(0x2026));
      if (face) return { face, glyphs: shapeRun(face, [0x2026], this.size, this.features) };
      return { face: this.faces[0], glyphs: shapeRun(this.faces[0], [0x2e, 0x2e, 0x2e], this.size, this.features) };
    };
    const ellipsis = shapeEllipsis();
    const ellipsisWidth = ellipsis.glyphs.reduce((w, g) => w + g.advance, 0);
    // Grow the gap leftwards one grapheme cluster at a time, starting with the last cluster.
    let gapStart = to;
    do {
      gapStart--;
      while (gapStart > from && !this.attrs[gapStart].isCursorPosition) gapStart--;
    } while (gapStart > from && total - widthOf(gapStart, to) + ellipsisWidth > goal);
    const kept: Run[] = [];
    for (const run of runs) {
      if (run.start >= gapStart) continue;
      const glyphs = run.glyphs.filter((g) => g.cluster < gapStart);
      const end = Math.min(run.end, gapStart);
      kept.push({ ...run, glyphs, end, byteLength: this.byteOffsets[end] - this.byteOffsets[run.start] });
    }
    const keptWidth = total - widthOf(gapStart, to);
    const extra = Math.max(goal - (keptWidth + ellipsisWidth), 0);
    const glyphs = ellipsis.glyphs.map((g) => ({ ...g, cluster: gapStart, clusterLength: to - gapStart }));
    glyphs[glyphs.length - 1].advance += extra;
    const level = this.levelsFor(gapStart, gapStart + 1)[0] ?? 0;
    kept.push({
      face: ellipsis.face, size: this.size, glyphs, start: gapStart, end: to, byteOffset: this.byteOffsets[gapStart],
      byteLength: this.byteOffsets[to] - this.byteOffsets[gapStart], level,
    });
    reorderRuns(kept);
    return { ...line, runs: kept, width: keptWidth + ellipsisWidth + extra };
  }

  private buildLine(para: { start: number; end: number; runs: Run[] }, from: number, to: number, wrapped: boolean): Line {
    // Re-shape the line on its own (Pango re-shapes broken runs), then zero a final wrapped space.
    const runs = from === para.start && to === para.end ? para.runs : this.shapeRange(from, to);
    const lineRuns = runs.map((r) => ({ ...r, glyphs: r.glyphs.map((g) => ({ ...g })) }));
    this.resolveTabs(lineRuns); // tab stops are relative to the line start
    if (wrapped && lineRuns.length) {
      // Zero the trailing spaces of the logically last run (its glyphs are reversed when right-to-left).
      const run = lineRuns[lineRuns.length - 1];
      const logical = run.level % 2 ? [...run.glyphs].reverse() : run.glyphs;
      for (let j = logical.length - 1; j >= 0; j--) {
        if (this.cps[logical[j].cluster] === 0x20) logical[j].advance = 0;
        else break;
      }
    }
    reorderRuns(lineRuns);
    let width = 0;
    let ascent = 0;
    let descent = 0;
    for (const run of lineRuns) {
      for (const g of run.glyphs) width += g.advance;
      const e = fontExtents(run.face, run.size);
      ascent = Math.max(ascent, e.ascent);
      descent = Math.max(descent, e.descent);
    }
    // Pango (pango-layout): the line's width ignores code points U+2028/U+2029 at the
    // very end of the line — their advance reappears in the PDF /W but not in the
    // structure (their ink spills beyond the line, like a hyphen's).
    {
      let subtract = 0;
      for (let k = lineRuns.length - 1; k >= 0; k--) {
        const run = lineRuns[k];
        const glyphList = run.level % 2 ? [...run.glyphs].reverse() : run.glyphs;
        let ranOut = false;
        for (let j = glyphList.length - 1; j >= 0; j--) {
          const g = glyphList[j];
          const cp = this.cps[g.cluster];
          if (cp === 0x2028 || cp === 0x2029) {
            subtract += g.advance;
            continue;
          }
          ranOut = true;
          break;
        }
        if (ranOut) break;
      }
      width -= subtract;
    }
    if (!lineRuns.length) {
      const e = fontExtents(this.faces[0], this.size);
      ascent = e.ascent;
      descent = e.descent;
    }
    return {
      length: this.byteOffsets[to] - this.byteOffsets[from], startIndex: this.byteOffsets[from], runs: lineRuns,
      // Upstream disables auto_dir (line_break.py setup), so Pango resolves every line to the context base
      // direction: PANGO_DIRECTION_RTL (1) for direction: rtl, PANGO_DIRECTION_LTR (0) otherwise.
      width, height: ascent + descent, ascent, resolvedDir: this.style.get('direction') === 'rtl' ? 1 : 0,
    };
  }

  /** The text of a glyph cluster (code points `start` to `start + length` of the layout text). */
  clusterText(start: number, length: number): string {
    return String.fromCodePoint(...this.cps.slice(start, start + length));
  }

  /** Python frees the native layout here; nothing to release in TypeScript. */
  deactivate(): void {}

  reactivate(style: Style): void {
    this.setup(style);
    this.setText(this.text, true);
  }

  /** Baseline of the first line, in Pango units (pango_layout_get_baseline). */
  get baseline(): number {
    return this.getFirstLine()[0].ascent;
  }

  /** Log attributes of the layout text (pango_layout_get_log_attrs_readonly). */
  get logAttrs(): LogAttr[] {
    return this.attrs;
  }
}

export { PANGO_GLYPH_EMPTY };