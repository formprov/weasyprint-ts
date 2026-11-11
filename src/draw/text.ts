// SPDX-License-Identifier: BSD-3-Clause

/** Draw text (mirrors weasyprint/draw/text.py). */
import { LOGGER } from '../logger.ts';
import { percentage } from '../layout/percent.ts';
import { Matrix } from '../matrix.ts';
import type { PdfStream } from '../pdf/stream.ts';
import { PANGO_GLYPH_EMPTY, PANGO_SCALE, scale } from '../text/shaper.ts';
import { TO_UNITS } from '../text/layout.ts';
import { getLastWordEnd } from '../text/line_break.ts';
import { pyRound } from '../utils.ts';
import { drawLine } from './border.ts';
import { getColor } from './color.ts';
import { formatNumber } from '../pdf/pydyf.ts';

type AnyBox = any;
const FROM_UNITS = 1 / PANGO_SCALE;
const PANGO_GLYPH_UNKNOWN_FLAG = 0x10000000;

const num = (n: number): string => formatNumber(n);

/** Draw a textbox to a pydyf stream. */
export function drawText(stream: PdfStream, textbox: AnyBox, offsetX: number, textOverflow: string, blockEllipsis: any): void {
  // Pango crashes with font-size: 0.
  if (!textbox.style.get('font_size')) throw new Error('font-size: 0');

  // Don't draw invisible textboxes.
  if (textbox.style.get('visibility') !== 'visible') return;

  // Draw underline and overline.
  const textDecorationValues = textbox.style.get('text_decoration_line');
  const textDecorationColor = getColor(textbox.style, 'text_decoration_color');
  let thickness = 0;
  const has = (v: string): boolean => textDecorationValues !== 'none' && textDecorationValues.has(v);
  if (has('underline') || has('overline')) {
    const t = textbox.style.get('text_decoration_thickness');
    thickness = t === 'auto' || t === 'from-font'
      ? textbox.pangoLayout.underlineThickness
      : percentage(t, textbox.style, textbox.style.get('font_size'));
  }
  if (has('overline')) {
    const offsetY = textbox.baseline - textbox.pangoLayout.ascent + thickness / 2;
    drawTextDecoration(stream, textbox, offsetX, offsetY, thickness, textDecorationColor);
  }
  if (has('underline')) {
    const underlineOffset = textbox.style.get('text_underline_offset') === 'auto'
      ? -textbox.pangoLayout.underlinePosition
      : percentage(textbox.style.get('text_underline_offset'), textbox.style, textbox.style.get('font_size'));
    const offsetY = textbox.baseline + underlineOffset + thickness / 2;
    drawTextDecoration(stream, textbox, offsetX, offsetY, thickness, textDecorationColor);
  }

  // Draw text.
  const x = textbox.positionX;
  const y = textbox.positionY + textbox.baseline;
  stream.setColor(textbox.style.get('color'));
  textbox.pangoLayout.reactivate(textbox.style);
  stream.beginText();
  drawFirstLine(stream, textbox, textOverflow, blockEllipsis, new Matrix(1, 0, 0, -1, x, y));
  stream.endText();

  // Draw line through.
  if (has('line-through')) {
    const t = textbox.pangoLayout.strikethroughThickness;
    const offsetY = textbox.baseline - textbox.pangoLayout.strikethroughPosition;
    drawTextDecoration(stream, textbox, offsetX, offsetY, t, textDecorationColor);
  }
  textbox.pangoLayout.deactivate();
}

/** Draw the given `textbox` line to the document `stream`. */
export function drawFirstLine(stream: PdfStream, textbox: AnyBox, textOverflow: string, blockEllipsis: any, matrix: Matrix): void {
  // Don't draw lines with only invisible characters.
  if (!textbox.text.trim()) return;
  if (textbox.style.get('font_size') < 1e-6) return; // default float precision used by pydyf

  const layout = textbox.pangoLayout;
  layout.setSingleParagraphMode(true);

  let ellipsis = '';
  if (textOverflow === 'ellipsis' || blockEllipsis !== 'none') {
    if (layout.maxWidth === null) throw new Error('assert textbox.pango_layout.max_width is not None');
    const maxWidth = layout.maxWidth;
    layout.setWidth(Math.trunc(maxWidth * TO_UNITS));
    if (textOverflow === 'ellipsis') {
      layout.setEllipsize(true); // PANGO_ELLIPSIZE_END
    } else {
      if (blockEllipsis === 'auto') ellipsis = '\u2026';
      else ellipsis = blockEllipsis[1];

      // Remove last word if hyphenated.
      let newText: string = layout.text;
      const hyphenate = textbox.style.get('hyphenate_character');
      if (newText.endsWith(hyphenate)) {
        const lastWordEnd = getLastWordEnd(newText.slice(0, -hyphenate.length), textbox.style.get('lang'));
        if (lastWordEnd) newText = newText.slice(0, lastWordEnd);
      }

      layout.setText(newText + ellipsis);
    }
  }

  let [firstLine, index] = layout.getFirstLine();

  if (blockEllipsis !== 'none') {
    while (index) {
      const lastWordEnd = getLastWordEnd(layout.text.slice(0, -ellipsis.length), textbox.style.get('lang'));
      if (lastWordEnd === null) break;
      const newText = layout.text.slice(0, lastWordEnd);
      layout.setText(newText + ellipsis);
      [firstLine, index] = layout.getFirstLine();
    }
  }

  stream.setTextMatrix(...matrix.values);
  let previousFace: any = null;
  let previousSize = 0;
  let string = '';
  let font: any = null;
  let fontSize = 0;
  for (const run of firstLine.runs) {
    fontSize = run.size * FROM_UNITS;
    if (run.face !== previousFace || run.size !== previousSize) {
      // Add font file content and get font size. A synthetic-caps run keeps the
      // same face but a smaller size, so the size alone also forces a new Tf.
      previousFace = run.face;
      previousSize = run.size;
      font = stream.addFont(run.face, fontSize, layout.style);
      // Go through the run glyphs.
      if (string) stream.showText(string);
      string = '';
      stream.setFontSize(font.hash, font.bitmap ? 1 : fontSize);
    }
    string += '<';
    const rtl = run.level % 2 === 1;
    for (const [i, glyph] of run.glyphs.entries()) {
      let glyphId = glyph.gid;
      const width = glyph.advance;

      // Display zero-width empty glyph.
      if (glyphId === PANGO_GLYPH_EMPTY) {
        string += `>${num(-width / fontSize)}<`;
        continue;
      }

      // Display .notdef and log warning for missing glyphs.
      if (glyphId & PANGO_GLYPH_UNKNOWN_FLAG) {
        const codepoint = glyphId - PANGO_GLYPH_UNKNOWN_FLAG;
        LOGGER.warning(`.notdef glyph rendered for Unicode string unsupported by fonts: "${String.fromCodePoint(codepoint)}" (U+${codepoint.toString(16).toUpperCase().padStart(4, '0')})`);
        glyphId = font.getUnusedGlyphId(codepoint);
        font.widths.set(glyphId, pyRound(width * 1000 * FROM_UNITS / fontSize));
        if (!font.widths.has(0)) font.widths.set(0, font.widths.get(glyphId));
      }

      // Create mapping between glyphs and Unicode codepoints: from the glyph's cluster to the next glyph's in
      // logical order (the previous one in a right-to-left run), or to the end of the run.
      if (!font.toUnicode.has(glyphId)) {
        const t1 = glyph.cluster;
        const last = run.glyphs.length - 1;
        const t2 = rtl ? (i === 0 ? run.end : run.glyphs[i - 1].cluster) : (i === last ? run.end : run.glyphs[i + 1].cluster);
        font.toUnicode.set(glyphId, layout.clusterText(t1, t2 - t1));
      }

      // Set horizontal and vertical offsets.
      const offset = glyph.xOffset / fontSize;
      const rise = glyph.yOffset / 1000;
      if (rise) {
        if (string[string.length - 1] === '<') string = string.slice(0, -1);
        else string += '>';
        if (string) stream.showText(string);
        stream.setTextRise(-rise);
        string = '';
        if (offset) string = num(-offset);
        string += `<${glyphId.toString(16).padStart(font.bitmap ? 2 : 4, '0')}>`;
        stream.showText(string);
        stream.setTextRise(0);
        string = '<';
      } else {
        if (offset) string += `>${num(-offset)}<`;
        string += glyphId.toString(16).padStart(font.bitmap ? 2 : 4, '0');
      }

      // Get glyph logical widths.
      let logicalWidth: number;
      if (font.widths.has(glyphId)) logicalWidth = font.widths.get(glyphId);
      else {
        const fk = run.face.fk;
        const advance = scale(fk.getGlyph(glyphId).advanceWidth, run.size, fk.unitsPerEm);
        logicalWidth = pyRound(advance * 1000 * FROM_UNITS / fontSize);
        font.widths.set(glyphId, logicalWidth);
      }

      // Set kerning, word spacing, letter spacing.
      const kerning = logicalWidth + offset - width * 1000 * FROM_UNITS / fontSize;
      if (kerning) string += `>${Math.trunc(kerning)}<`;
    }
    // Close the last glyphs list, remove if empty.
    if (string[string.length - 1] === '<') string = string.slice(0, -1);
    else string += '>';
  }
  // Draw text.
  stream.showText(string);
}

/** Draw text-decoration of `textbox` to a stream. */
export function drawTextDecoration(stream: PdfStream, textbox: AnyBox, offsetX: number, offsetY: number, thickness: number, color: any): void {
  drawLine(stream, textbox.positionX, textbox.positionY + offsetY, textbox.positionX + textbox.width,
    textbox.positionY + offsetY, thickness, textbox.style.get('text_decoration_style'), color, offsetX);
}