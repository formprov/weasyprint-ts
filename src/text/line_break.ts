// SPDX-License-Identifier: BSD-3-Clause

/** Decide where to break text lines (mirrors weasyprint/text/line_break.py). */
import type { Style } from '../css/style.ts';
import { hooks } from '../css/hooks.ts';
import { percentage } from '../layout/percent.ts';
import { Hyphenator } from './hyphenator.ts';
import { FROM_UNITS, Layout, PANGO_WRAP, TO_UNITS, getLogAttrsForText } from './layout.ts';
import type { Line, LogAttr } from './layout.ts';
import { LOGGER } from '../logger.ts';

export { Layout } from './layout.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();
/** UTF-8 byte-indexed slice, like ``text.encode()[a:b].decode()``. */
export function utf8Slice(text: string, start: number, end?: number): string {
  return dec.decode(enc.encode(text).subarray(start, end));
}
export const utf8Length = (text: string): number => enc.encode(text).length;

/** Logical width and height (CSS px) of ``line``; ``style`` adds letter spacing if needed. */
export function lineSize(line: Line, style: Style): [number, number] {
  let width = line.width * FROM_UNITS;
  const height = line.height * FROM_UNITS;
  if (style.get('letter_spacing') !== 'normal') width += style.get('letter_spacing');
  return [width, height];
}

export type FirstLineResult = [Layout, number, number | null, number, number, number];

export function firstLineMetrics(
  firstLineIn: Line, text: string, layout: Layout, resumeAt: number | null, spaceCollapse: boolean, style: Style,
  hyphenated = false, hyphenationCharacter: string | null = null,
): FirstLineResult {
  let firstLine = firstLineIn;
  let length = firstLine.length;
  if (hyphenated) {
    length -= utf8Length(hyphenationCharacter!);
  } else if (resumeAt) {
    // Set an infinite width as we don't want to break lines when drawing: the
    // lines have already been split and the size may differ.
    layout.setWidth(-1);
    // Create layout with final text.
    let firstLineText = utf8Slice(text, 0, length);
    // Remove trailing spaces if spaces collapse.
    if (spaceCollapse) firstLineText = firstLineText.replace(/ +$/, '');
    layout.setText(firstLineText);
    [firstLine] = layout.getFirstLine();
    length = firstLine !== null ? firstLine.length : 0;
  }
  const [width, height] = lineSize(firstLine, style);
  const baseline = layout.baseline * FROM_UNITS;
  layout.deactivate();
  return [layout, length, resumeAt, width, height, baseline];
}

export function createLayout(
  text: string, style: Style, context: any, maxWidth: number | null, justificationSpacing: number,
): Layout {
  const layout = new Layout(style, justificationSpacing, maxWidth);
  // Make sure that max_width * Pango.SCALE fits in a signed integer. Treat bigger values as None.
  const textWrap = ['normal', 'pre-wrap', 'pre-line'].includes(style.get('white_space'));
  if (maxWidth !== null && textWrap && maxWidth < 2 ** 21) layout.setWidth(Math.trunc(Math.max(0, maxWidth) * TO_UNITS));
  layout.setText(text);
  void context;
  return layout;
}

/**
 * Fit as much as possible in the available width for one line of text.
 *
 * Returns ``[layout, length, resumeIndex, width, height, baseline]``: ``length``
 * is in UTF-8 bytes, ``resumeIndex`` is the number of UTF-8 bytes to skip for
 * the next line (null if the whole text fits in one line; may be greater than
 * ``length`` for preserved newlines).
 */
export function splitFirstLine(
  textIn: string, style: Style, context: any, maxWidthIn: number | null, justificationSpacing: number,
  isLineStart = true, minimum = false,
): FirstLineResult {
  let text = textIn;
  const textWrap = ['normal', 'pre-wrap', 'pre-line'].includes(style.get('white_space'));
  const spaceCollapse = ['normal', 'nowrap', 'pre-line'].includes(style.get('white_space'));

  const originalMaxWidth = maxWidthIn;
  let maxWidth = maxWidthIn;
  if (!textWrap) maxWidth = null;

  // Step #1: Get a draft layout with the first line.
  const ratio = 4; // number that almost always respects char_height / char_width > ratio
  let shortText = text;
  let layout: Layout;
  let firstLine: Line;
  let resumeIndex: number | null;
  if (maxWidth !== null && maxWidth !== Infinity && style.get('font_size')) {
    // Try to use a small amount of text to avoid the whole layout. We need at least
    // one line, and one possible line break point on the second line.
    if (style.get('font_size') * ratio > maxWidth) {
      // Trying to find minimum or very small size: naively split on spaces and keep
      // one word + one letter.
      const spaceIndex = text.indexOf(' ');
      if (spaceIndex !== -1) shortText = text.slice(0, spaceIndex + 2); // index + space + one letter
    } else {
      // Use the magic ratio and hope that we'll get the right amount of text.
      shortText = pySlice(text, 0, Math.trunc((maxWidth / style.get('font_size')) * ratio));
    }
    layout = createLayout(shortText, style, context, maxWidth, justificationSpacing);
    [firstLine, resumeIndex] = layout.getFirstLine();
    if (resumeIndex === null && shortText !== text) {
      // The small amount of text fits in one line, give up and use the whole text.
      shortText = text;
      layout.setText(text);
      [firstLine, resumeIndex] = layout.getFirstLine();
    } else {
      // If the second line of the short text can break, we have the next line break
      // point required for step #3 in it, drop the end of the text.
      const firstLineText = utf8Slice(shortText, 0, resumeIndex ?? undefined);
      if (firstLineText !== shortText) {
        const start = [...firstLineText].length + 1;
        const end = [...shortText].length;
        const textEndLogAttrs = layout.logAttrs.slice(start, end);
        if (getNextBreakPoint(textEndLogAttrs) !== null) text = shortText;
      }
    }
  } else {
    layout = createLayout(text, style, context, originalMaxWidth, justificationSpacing);
    [firstLine, resumeIndex] = layout.getFirstLine();
  }

  // Step #2: Don't split lines when it's not needed.
  if (maxWidth === null) {
    // The first line can take all the place needed.
    return firstLineMetrics(firstLine, text, layout, resumeIndex, spaceCollapse, style);
  }
  let [firstLineWidth] = lineSize(firstLine, style);
  if (resumeIndex === null && firstLineWidth <= maxWidth) {
    // The first line fits in the available width.
    return firstLineMetrics(firstLine, text, layout, resumeIndex, spaceCollapse, style);
  }

  // Step #3: Try to put the first word of the second line on the first line.
  let firstLineText: string;
  let secondLineText: string;
  if (firstLineWidth <= maxWidth) {
    // The first line fits but may have been cut too early by Pango.
    firstLineText = utf8Slice(text, 0, resumeIndex ?? undefined);
    secondLineText = utf8Slice(text, resumeIndex ?? 0);
  } else {
    // The line can't be split earlier, try to hyphenate the first word.
    firstLineText = '';
    secondLineText = text;
  }
  let breakPoint: number | null;
  if (firstLineText === shortText) {
    // There's no second line, don't try to find a next word.
    breakPoint = null;
  } else {
    // Find then second line's first break point.
    const logAttrs = layout.logAttrs;
    const start = [...firstLineText].length + 1;
    const end = [...shortText].length;
    breakPoint = getNextBreakPoint(logAttrs.slice(start, end));
  }
  const secondChars = [...secondLineText];
  const nextWord = secondChars.slice(0, breakPoint ?? undefined).join('').replace(/ +$/, '');
  if (nextWord) {
    if (spaceCollapse && secondChars[breakPoint ?? secondChars.length - 1] === ' ') {
      // Next word might fit without a space afterwards: only try when space collapsing is allowed.
      const newFirstLineText = firstLineText + nextWord;
      layout.setText(newFirstLineText);
      [firstLine, resumeIndex] = layout.getFirstLine();
      if (resumeIndex === null) {
        if (firstLineText) {
          // The next word fits in the first line, keep the layout.
          resumeIndex = utf8Length(newFirstLineText) + 1;
          return firstLineMetrics(firstLine, text, layout, resumeIndex, spaceCollapse, style);
        }
        // Second line is None.
        resumeIndex = firstLine.length + 1;
        if (resumeIndex >= utf8Length(text)) resumeIndex = null;
      }
    }
  } else if (firstLineText) {
    // We found something on the first line but we did not find a word on the next
    // line, no need to hyphenate, we can keep the current layout.
    return firstLineMetrics(firstLine, text, layout, resumeIndex, spaceCollapse, style);
  }

  // Step #4: Try to hyphenate.
  const hyphens = style.get('hyphens');
  const softHyphen = '­';
  let manualHyphenation = false;
  let autoHyphenation = false;
  let hyphenated = false;
  const lang = style.get('lang') as string | null;
  const [total, left, right] = style.get('hyphenate_limit_chars') as [number, number, number];
  let hyphenationWord = '';
  let nextTextIndex = 0;

  if (hyphens !== 'none') manualHyphenation = (firstLineText + secondLineText).includes(softHyphen);
  if (hyphens === 'auto' && lang) {
    // Get text until the next line break opportunity.
    let nextText = secondLineText;
    const nextBreakPoint = getNextBreakPointFromText(secondLineText, lang);
    if (nextBreakPoint !== null) nextText = nextText.slice(0, nextBreakPoint);

    // Try all words included in this text.
    while (nextText) {
      const wordBoundaries = getNextWordBoundaries(nextText, lang);
      if (wordBoundaries) {
        const [startWord, stopWord] = wordBoundaries;
        const nextWord = nextText.slice(startWord, stopWord);
        if (stopWord - startWord >= total) {
          // This word is long enough.
          const [firstLineWidth] = lineSize(firstLine, style);
          const space = maxWidth - firstLineWidth;
          const limitZone = percentage(style.get('hyphenate_limit_zone'), style, maxWidth);
          if (space > limitZone || space < 0) {
            // Available space is worth the try, or the line is even too long
            // to fit: try to hyphenate.
            autoHyphenation = true;
            nextTextIndex += startWord;
            hyphenationWord = nextWord;
            break;
          }
        }
        // This word doesn't work, try the next one.
        nextText = nextText.slice(stopWord);
        nextTextIndex += stopWord;
      } else break;
    }
  }

  // Automatic hyphenation opportunities within a word must be ignored if the word
  // contains a conditional hyphen, in favor of the conditional hyphen(s).
  let dictionaryIterations: string[] = [];
  if (manualHyphenation) {
    // Manual hyphenation: check that the line ends with a soft hyphen and add the missing hyphen.
    if (firstLineText.endsWith(softHyphen)) {
      // The first line has been split on a soft hyphen.
      [firstLineText, secondLineText] = ['', firstLineText];
    }
    const softHyphenIndexes: number[] = [];
    [...secondLineText].forEach((c, i) => {
      if (c === softHyphen) softHyphenIndexes.push(i);
    });
    softHyphenIndexes.reverse();
    const chars = [...secondLineText];
    dictionaryIterations = softHyphenIndexes.map((i) => chars.slice(0, i + 1).join(''));
  } else if (autoHyphenation) {
    const hyphenator = new Hyphenator(lang, left, right);
    const previousWords = secondLineText.slice(0, nextTextIndex);
    dictionaryIterations = hyphenator.iterate(hyphenationWord).map(([start]) => previousWords + start);
  }

  let newFirstLineText = '';
  let hyphenatedFirstLineText = '';
  if (dictionaryIterations.length) {
    for (const firstWordPart of dictionaryIterations) {
      newFirstLineText = firstLineText + firstWordPart;
      hyphenatedFirstLineText = newFirstLineText + style.get('hyphenate_character');
      const newLayout = createLayout(hyphenatedFirstLineText, style, context, maxWidth, justificationSpacing);
      const [newFirstLine, index] = newLayout.getFirstLine();
      const [newFirstLineWidth] = lineSize(newFirstLine, style);
      const newSpace = maxWidth - newFirstLineWidth;
      hyphenated = index === null && (newSpace >= 0 || firstWordPart === dictionaryIterations[dictionaryIterations.length - 1]);
      if (hyphenated) {
        layout = newLayout;
        firstLine = newFirstLine;
        resumeIndex = utf8Length(newFirstLineText);
        break;
      }
    }
    if (!hyphenated && !firstLineText) {
      // Recreate the layout with no max_width to be sure that we don't break before
      // or inside the hyphenate character.
      hyphenated = true;
      layout.setText(hyphenatedFirstLineText);
      layout.setWidth(-1);
      [firstLine] = layout.getFirstLine();
      resumeIndex = utf8Length(newFirstLineText);
      if ([...text][[...firstLineText].length] === softHyphen) resumeIndex += utf8Length(softHyphen);
    }
  }

  if (!hyphenated && firstLineText.endsWith(softHyphen)) {
    // Recreate the layout with no max_width to be sure that we don't break inside
    // the hyphenate-character string.
    hyphenated = true;
    hyphenatedFirstLineText = firstLineText + style.get('hyphenate_character');
    layout.setText(hyphenatedFirstLineText);
    layout.setWidth(-1);
    [firstLine] = layout.getFirstLine();
    resumeIndex = utf8Length(firstLineText);
  }

  // Step 5: Try to break word if it's too long for the line.
  const overflowWrap = style.get('overflow_wrap');
  [firstLineWidth] = lineSize(firstLine, style);
  const space = maxWidth - firstLineWidth;
  // If we can break words and the first line is too long.
  const canBreak = style.get('word_break') === 'break-all' ||
    (isLineStart && (overflowWrap === 'anywhere' || (overflowWrap === 'break-word' && !minimum)));
  if (space < 0 && canBreak) {
    // Is it really OK to remove hyphenation for word-break?
    hyphenated = false;
    // TODO: preserve W3C condition "Shaping characters are still shaped as if the
    // word were not broken" (new lines are processed one by one with no memory).
    layout.setText(text);
    layout.setWidth(Math.trunc(maxWidth * TO_UNITS));
    layout.setWrap(PANGO_WRAP.CHAR);
    let index: number | null;
    [firstLine, index] = layout.getFirstLine();
    resumeIndex = index || firstLine.length;
    if (resumeIndex >= utf8Length(text)) resumeIndex = null;
  }

  return firstLineMetrics(firstLine, text, layout, resumeIndex, spaceCollapse, style, hyphenated, style.get('hyphenate_character'));
}

/** Python-style slice by code points. */
function pySlice(text: string, a: number, b: number): string {
  return [...text].slice(a, b).join('');
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (!warned.has(msg)) {
    warned.add(msg);
    LOGGER.warning(msg);
  }
}

// --- Strut and character metrics -----------------------------------------------------
function fontStyleCacheKey(style: Style, includeSize = false): string {
  let key = String([
    style.get('font_family'), style.get('font_style'), style.get('font_stretch'), style.get('font_weight'),
    style.get('font_variant_ligatures'), style.get('font_variant_position'), style.get('font_variant_caps'),
    style.get('font_variant_numeric'), style.get('font_variant_alternates'), style.get('font_variant_east_asian'),
    style.get('font_feature_settings'), style.get('font_variation_settings'), style.get('font_language_override'),
    style.get('lang'),
  ]);
  if (includeSize) key += String(style.get('font_size')) + String(style.get('line_height'));
  return key;
}

/** Used value of ``line-height`` and the baseline (from the top edge of the line height). */
export function strut(style: Style): [number, number] {
  if (style.get('font_size') === 0) return [0, 0];
  const fontConfig = style.fontConfig as any;
  const key = fontStyleCacheKey(style, true);
  const cached = fontConfig.strutLayouts.get(key);
  if (cached) return cached;
  const layout = new Layout(style);
  layout.setText(' ');
  const [line] = layout.getFirstLine();
  const [, , , , textHeight, baseline] = firstLineMetrics(line, '', layout, null, false, style);
  if (style.get('line_height') === 'normal') {
    const result: [number, number] = [textHeight, baseline];
    fontConfig.strutLayouts.set(key, result);
    return result;
  }
  let lineHeight = style.get('line_height');
  if (typeof lineHeight === 'number') lineHeight *= style.get('font_size');
  else lineHeight = lineHeight.value;
  const result: [number, number] = [lineHeight, baseline + (lineHeight - textHeight) / 2];
  fontConfig.strutLayouts.set(key, result);
  return result;
}

/** Font size ratio used by the given unit (ex, cap, ic, ch). */
export function characterRatio(styleIn: Style, unit: string): number {
  const character = ({ ex: 'x', cap: 'O', ic: '水', ch: '0' } as Record<string, string>)[unit];
  if (!character) throw new Error(`unknown unit ${unit}`);
  const cacheMap = (styleIn.cache.get(unit) ?? styleIn.cache.set(unit, new Map()).get(unit)) as Map<string, number>;
  const cacheKey = fontStyleCacheKey(styleIn);
  if (cacheMap.has(cacheKey)) return cacheMap.get(cacheKey)!;

  // Avoid recursion for letter-spacing and word-spacing properties.
  const style = styleIn.copy();
  style.set('letter_spacing', 'normal');
  style.set('word_spacing', 0);
  style.set('font_size', 1000); // random big value

  const layout = new Layout(style);
  layout.setText(character);
  const [line] = layout.getFirstLine();
  let measure: number;
  if (unit === 'ex') {
    // Ink extents of the glyph: -ink.y is its top above the baseline.
    const run = line.runs[0];
    const f = run.face.fk;
    const glyph = f.glyphForCodePoint(character.codePointAt(0)!);
    measure = (glyph.bbox.maxY * run.size) / f.unitsPerEm / TO_UNITS;
  } else if (unit === 'cap') measure = line.height * FROM_UNITS;
  else measure = line.width * FROM_UNITS;
  // Zero means some kind of failure, fallback is 0.5. Round to keep exact values altered by Pango.
  const result = Math.round((measure / style.get('font_size')) * 1e5) / 1e5 || 0.5;
  cacheMap.set(cacheKey, result);
  return result;
}

hooks.strut = strut;
hooks.characterRatio = characterRatio;

// --- Break helpers ---------------------------------------------------------------------
export function getLogAttrs(text: string, _lang: string | null): LogAttr[] {
  // TODO: should be removed when bidi is supported.
  for (const c of ['‪', '‫', '‬', '‭', '‮']) text = text.split(c).join('​');
  return getLogAttrsForText(text);
}

export function getNextBreakPoint(logAttrs: LogAttr[]): number | null {
  for (let i = 0; i < logAttrs.length; i++) if (logAttrs[i].isLineBreak) return i;
  return null;
}

export function getNextBreakPointFromText(text: string, lang: string | null): number | null {
  if (!text || [...text].length < 2) return null;
  const logAttrs = getLogAttrs(text, lang);
  const length = [...text].length + 1;
  return getNextBreakPoint(logAttrs.slice(1, length - 1));
}

export function canBreakText(text: string, lang: string | null): boolean {
  return getNextBreakPointFromText(text, lang) !== null;
}

export function getNextWordBoundaries(text: string, lang: string | null): [number, number] | null {
  if (!text || [...text].length < 2) return null;
  const logAttrs = getLogAttrs(text, lang);
  let wordStart = 0;
  for (let i = 0; i < logAttrs.length; i++) {
    if (logAttrs[i].isWordEnd) return [wordStart, i];
    if (logAttrs[i].isWordBoundary) wordStart = i;
  }
  return null;
}

export function getLastWordEnd(text: string, lang: string | null): number | null {
  if (!text || [...text].length < 2) return null;
  const logAttrs = getLogAttrs(text, lang);
  const reversed = [...logAttrs].reverse();
  for (let i = 0; i < reversed.length; i++) {
    if (i && reversed[i].isWordEnd) return [...text].length - i;
  }
  return null;
}