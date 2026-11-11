// SPDX-License-Identifier: BSD-3-Clause

/**
 * Draw text (mirrors weasyprint/svg/text.py).
 *
 * Emoji drawing (draw_emojis) is not ported yet; emoji glyphs in SVG text are skipped.
 */
import { INITIAL_VALUES } from '../css/properties.ts';
import { Matrix } from '../matrix.ts';
import { drawFirstLine } from '../draw/text.ts';
import { getTextEngine } from '../text/engine.ts';
import type { SvgNode, SVG } from './index.ts';
import { extendBoundingBox, EMPTY_BOUNDING_BOX } from './bounding_box.ts';
import { normalize, size } from './utils.ts';

/** Python: Style(dict) with the initial values, as the text layer reads them. */
class SvgTextStyle {
  private values: Map<string, any>;
  constructor(values: Record<string, any>) {
    this.values = new Map(Object.entries(values));
  }
  get(key: string): any {
    return this.values.get(key);
  }
  set(key: string, value: any): void {
    this.values.set(key, value);
  }
}

/** Python: draw_first_line expects a TextBox with a pango layout and style. */
interface SvgTextBox {
  text: string;
  style: SvgTextStyle;
  pangoLayout: any;
  baseline: number;
}

export function text(svg: SVG, node: SvgNode, fontSize: number): void {
  // TODO: use real computed values
  const values: Record<string, any> = { ...INITIAL_VALUES };
  const style = new SvgTextStyle(values);
  (style as any).fontConfig = svg.fontConfig; // the text layer reads the font configuration from the style
  style.set('font_family', String(node.get('font-family', 'sans-serif'))
    .split(',').map((font) => font.trim().replace(/^["']+|["']+$/g, '')));
  style.set('font_style', node.get('font-style', 'normal'));
  let fontWeight: any = node.get('font-weight', 400);
  style.set('font_size', fontSize);
  if (node.get('direction') === 'ltr' || node.get('direction') === 'rtl') {
    style.set('direction', node.get('direction'));
  }
  if (fontWeight === 'normal') fontWeight = 400;
  else if (fontWeight === 'bold') fontWeight = 700;
  else {
    const parsed = Number.parseInt(String(fontWeight), 10);
    fontWeight = Number.isNaN(parsed) || !/^\s*[+-]?\d+\s*$/.test(String(fontWeight)) ? 400 : parsed;
  }
  style.set('font_weight', fontWeight);

  const engine = getTextEngine();
  const [layout, , , width0, height0] = engine.firstLine(node.text ?? '', style as any, svg.context, Infinity, 0);
  let width = width0;
  const height = height0;

  // Get rotations and translations
  let x: Array<number | null> = [];
  let y: Array<number | null> = [];
  let dx: Array<number | null> = [];
  let dy: Array<number | null> = [];
  let rotate: number[] = [0];
  if (node.has('x')) x = normalize(node.attrib.get('x')).trim().split(' ').map((i) => size(i, fontSize, svg.innerWidth));
  if (node.has('y')) y = normalize(node.attrib.get('y')).trim().split(' ').map((i) => size(i, fontSize, svg.innerHeight));
  if (node.has('dx')) dx = normalize(node.attrib.get('dx')).trim().split(' ').map((i) => size(i, fontSize, svg.innerWidth));
  if (node.has('dy')) dy = normalize(node.attrib.get('dy')).trim().split(' ').map((i) => size(i, fontSize, svg.innerHeight));
  if (node.has('rotate')) {
    rotate = normalize(node.attrib.get('rotate')).trim().split(' ')
      .map((i) => (i ? (Number(i) * Math.PI) / 180 : 0));
  }
  const lastR = rotate[rotate.length - 1];
  const text0 = node.text ?? '';
  const lettersPositions: Array<[[number | null, number | null, number | null, number | null, number | null], string]> = [];
  for (const char of [...text0]) {
    // Python: each list is popped from its front, giving None when exhausted.
    const pick = (list: Array<number | null>) => (list.length ? list.shift()! : null);
    const pos: [number | null, number | null, number | null, number | null, number | null] = [
      pick(x), pick(y), pick(dx), pick(dy), rotate.length ? rotate.shift()! : null,
    ];
    lettersPositions.push([pos, char]);
  }

  let letterSpacing = svg.length(node.get('letter-spacing'), fontSize);
  const textLength = svg.length(node.get('textLength'), fontSize);
  let scaleX = 1;
  if (textLength && node.text) {
    // calculate the number of spaces to be considered for the text
    const spacesCount = [...node.text].length - 1;
    if (normalize(node.attrib.get('lengthAdjust')) === 'spacingAndGlyphs') {
      // scale letter_spacing up/down to textLength
      const widthWithSpacing = width + spacesCount * letterSpacing;
      letterSpacing *= textLength / widthWithSpacing;
      // calculate the glyphs scaling factor by deducting the scaled letter_spacing from textLength
      const spacelessTextLength = textLength - spacesCount * letterSpacing;
      scaleX = spacelessTextLength / width;
    } else if (spacesCount) {
      // adjust letter spacing to fit textLength
      letterSpacing = (textLength - width) / spacesCount;
    }
    width = textLength;
  }

  // TODO: use real values
  const ascent = fontSize * 0.8;
  const descent = fontSize * 0.2;

  // Align text box vertically
  // TODO: This is a hack. Other baseline alignment tags are not supported.
  let yAlign = 0;
  const displayAnchor = node.get('display-anchor');
  const alignmentBaseline = node.get('dominant-baseline', node.get('alignment-baseline'));
  if (displayAnchor === 'middle') yAlign = -height / 2;
  else if (displayAnchor === 'top') yAlign = 0;
  else if (displayAnchor === 'bottom') yAlign = -height;
  else if (alignmentBaseline === 'central' || alignmentBaseline === 'middle') {
    // TODO: This is wrong, we use font top-to-bottom
    yAlign = (ascent + descent) / 2 - descent;
  } else if (['text-before-edge', 'before_edge', 'top', 'hanging', 'text-top'].includes(alignmentBaseline)) {
    yAlign = ascent;
  } else if (['text-after-edge', 'after_edge', 'bottom', 'text-bottom'].includes(alignmentBaseline)) {
    yAlign = -descent;
  }

  // Return early when there’s no text
  if (!node.text) {
    const xs = x.length ? (x[0] as number) : svg.cursorPosition[0];
    const ys = y.length ? (y[0] as number) : svg.cursorPosition[1];
    const dxs = dx.length ? (dx[0] as number) : 0;
    const dys = dy.length ? (dy[0] as number) : 0;
    svg.cursorPosition = [xs + dxs, ys + dys];
    return;
  }

  // Layout letters.
  const layouts: Array<[any, number, number, number, number, number | null, number]> = [];
  for (let i = 0; i < lettersPositions.length; i++) {
    const [[px, py, pdx, pdy, pr], letter] = lettersPositions[i];
    if (px) svg.cursorDPosition[0] = 0;
    if (py) svg.cursorDPosition[1] = 0;
    svg.cursorDPosition[0] += pdx ?? 0;
    svg.cursorDPosition[1] += pdy ?? 0;
    const [letterLayout, , , letterWidth, letterHeight, baseline] = engine.firstLine(letter, style as any, svg.context, Infinity, 0);
    let xv = px === null ? svg.cursorPosition[0] : px;
    let yv = py === null ? svg.cursorPosition[1] : py;
    const scaledWidth = letterWidth * scaleX;
    if (i) xv += letterSpacing;
    svg.cursorPosition = [xv + scaledWidth, yv];

    const xPosition = xv + svg.cursorDPosition[0];
    const yPosition = yv + svg.cursorDPosition[1] + yAlign;
    const angle = pr === null ? lastR : pr;
    const points: Array<[number, number]> = [
      [xPosition, yPosition - baseline],
      [xPosition + scaledWidth, yPosition - baseline + letterHeight],
    ];
    // TODO: Use ink extents instead of logical from line_break.line_size().
    node.textBoundingBox = extendBoundingBox(node.textBoundingBox ?? EMPTY_BOUNDING_BOX, points);
    layouts.push([letterLayout, xPosition, yPosition, xv, yv, angle, baseline]);
  }

  // Set state after we have bounding box for gradients and patterns, before drawing.
  svg.stream.pushState();
  const [fill, stroke] = svg.setGraphicalState(node, fontSize);
  svg.stream.beginText();

  // Draw letters.
  for (const [letterLayout, xPosition, yPosition, , , angle, baseline] of layouts) {
    letterLayout.reactivate(style as any);
    svg.fillStroke(fill, stroke, false, true);
    let matrix = new Matrix(scaleX, 0, 0, -1, xPosition, yPosition);
    if (angle) {
      const a = Math.cos(angle);
      const c = Math.sin(angle);
      matrix = new Matrix(a, -c, c, a).matmul(matrix);
    }
    const textBox: SvgTextBox = { text: letterLayout.text, style, pangoLayout: letterLayout, baseline: baseline as number };
    drawFirstLine(svg.stream, textBox as any, 'none', 'none', matrix);
  }

  svg.stream.endText();
  svg.stream.popState();
}
