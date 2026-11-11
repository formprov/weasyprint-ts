// SPDX-License-Identifier: BSD-3-Clause

/** Draw borders (mirrors weasyprint/draw/border.py). */
import * as boxes from '../formatting_structure/boxes.ts';
import { defaultImageSizing } from '../layout/replaced.ts';
import { percentage } from '../layout/percent.ts';
import { Matrix } from '../matrix.ts';
import type { PdfStream } from '../pdf/stream.ts';
import { pyRound } from '../utils.ts';
import { getColor, styledColor } from './color.ts';

type AnyBox = any;
type Radii = any[];

export const SIDES = ['top', 'right', 'bottom', 'left'] as const;
const {PI: pi, cos, sin, tan, sqrt, ceil, floor} = Math;

/** Set `box` mask border as alpha state on `stream`. */
export function setMaskBorder(stream: PdfStream, box: AnyBox): void {
  if (box.style.get('mask_border_source')[0] === 'none' || box.maskBorderImage === null || box.maskBorderImage === undefined) return;
  const [x, y, w, h] = box.roundedBorderBox();
  const maskStream = stream.setAlphaState(x, y, w, h, box.style.get('mask_border_mode'));
  void Matrix;
  drawBorderImage(box, maskStream, box.maskBorderImage, box.style.get('mask_border_slice'),
    box.style.get('mask_border_repeat'), box.style.get('mask_border_outset'), box.style.get('mask_border_width'));
}

/** Draw the column rules to a stream. */
export function drawColumnRules(stream: PdfStream, box: AnyBox): void {
  const borderWidths = [0, 0, 0, box.style.get('column_rule_width')];
  let skipNext = true;
  for (const child of box.children) {
    if (child.style.get('column_span') === 'all') {
      skipNext = true;
      continue;
    } else if (skipNext) {
      skipNext = false;
      continue;
    }
    stream.stacked(() => {
      const ruleWidth = box.style.get('column_rule_width');
      const ruleStyle = box.style.get('column_rule_style');
      const gap = box.style.get('column_gap') === 'normal'
        ? box.style.get('font_size') // normal equals 1em
        : percentage(box.style.get('column_gap'), box.style, box.width);
      const positionX = child.positionX - (box.style.get('column_rule_width') + gap) / 2;
      const borderBox: [number, number, number, number] = [positionX, child.positionY, ruleWidth, child.height];
      clipBorderSegment(stream, ruleStyle, ruleWidth, 'left', borderBox, borderWidths);
      const color = styledColor(ruleStyle, getColor(box.style, 'column_rule_color'), 'left');
      drawRectBorder(stream, borderBox, borderWidths, ruleStyle, color);
    });
  }
}

/** Draw the box borders and column rules to a stream. */
export function drawBorder(stream: PdfStream, box: AnyBox): void {
  // The box is hidden, easy.
  if (box.style.get('visibility') !== 'visible') return;

  // Draw column rules.
  const columns = box instanceof boxes.BlockContainerBox && (
    box.style.get('column_width') !== 'auto' || box.style.get('column_count') !== 'auto');
  if (columns && box.style.get('column_rule_width')) stream.artifact(() => drawColumnRules(stream, box));

  // If there's a border image, that takes precedence.
  if (box.style.get('border_image_source')[0] !== 'none' && box.borderImage !== null && box.borderImage !== undefined) {
    stream.artifact(() => drawBorderImage(box, stream, box.borderImage, box.style.get('border_image_slice'),
      box.style.get('border_image_repeat'), box.style.get('border_image_outset'), box.style.get('border_image_width')));
    return;
  }

  const widths: number[] = SIDES.map((side) => box[`border${side[0].toUpperCase()}${side.slice(1)}Width`]);
  if (new Set(widths).size === 1 && widths[0] === 0) return; // No border, return early.

  const colors = SIDES.map((side) => getColor(box.style, `border_${side}_color`));
  const styles = SIDES.map((side, i) => (colors[i].a ? box.style.get(`border_${side}_style`) : 0));

  const styleSet = new Set(styles);
  const simpleStyle = styleSet.size === 1 && (styleSet.has('solid') || styleSet.has('double')); // one style, simple lines
  const colorKeys = new Set(colors.map((c) => `${c.r},${c.g},${c.b},${c.a}`));
  const singleColor = colorKeys.size === 1; // one color
  const fourSides = !widths.includes(0); // no 0-width border, to avoid PDF artifacts
  if (simpleStyle && singleColor && fourSides) {
    // Simple case, we only draw rounded rectangles.
    stream.artifact(() => stream.stacked(() => drawRoundedBorder(stream, box, styles[0], colors[0])));
    return;
  }

  // Dotted/dashed fast path: uniform border with no rounded corners.
  const noRadii = box.roundedBorderBox().slice(4).every(([rx, ry]: number[]) => rx === 0 && ry === 0);
  const dottedDashed = styleSet.size === 1 && (styleSet.has('dotted') || styleSet.has('dashed'));
  const oneWidth = new Set(widths).size === 1;
  if (dottedDashed && singleColor && fourSides && oneWidth && noRadii) {
    stream.artifact(() => stream.stacked(() => drawDottedDashedBorder(stream, box, styles[0], widths[0], colors[0])));
    return;
  }

  // We're not smart enough to find a good way to draw the borders, we must draw them side by side.
  for (const index of [2, 3, 1, 0]) {
    const side = SIDES[index];
    const width = widths[index];
    const color = colors[index];
    const style = styles[index];
    if (width === 0 || !color) continue;
    stream.artifact(() => stream.stacked(() => {
      clipBorderSegment(stream, style, width, side, box.roundedBorderBox().slice(0, 4), widths, box.roundedBorderBox().slice(4));
      drawRoundedBorder(stream, box, style, styledColor(style, color, side));
    }));
  }
}

/** Draw `image` as a border image for `box` on `stream` as specified. */
export function drawBorderImage(box: AnyBox, stream: PdfStream, image: any, borderSlice: any[], borderRepeat: any[],
  borderOutset: any[], borderWidth: any[]): void {
  // Shared by border-image-* and mask-border-*.
  const [width0, height0, ratio] = image.getIntrinsicSize(box.style.get('image_resolution'), box.style.get('font_size'));
  const [intrinsicWidth, intrinsicHeight] = defaultImageSizing(
    width0, height0, ratio, null, null, box.borderWidth(), box.borderHeight());

  const imageSlice = borderSlice.slice(0, 4);
  const shouldFill = borderSlice[4];

  const computeSliceDimension = (dimension: any, intrinsic: number): number => {
    if (typeof dimension === 'number') return Math.min(dimension, intrinsic);
    return Math.min(100, dimension.value) / 100 * intrinsic;
  };

  const sliceTop = computeSliceDimension(imageSlice[0], intrinsicHeight);
  const sliceRight = computeSliceDimension(imageSlice[1], intrinsicWidth);
  const sliceBottom = computeSliceDimension(imageSlice[2], intrinsicHeight);
  const sliceLeft = computeSliceDimension(imageSlice[3], intrinsicWidth);

  const [repeatX, repeatY] = borderRepeat;

  let [x, y, w, h] = box.roundedBorderBox();
  const [px, py, pw, ph] = box.roundedPaddingBox();
  let borderLeft = px - x;
  let borderTop = py - y;
  let borderRight = w - pw - borderLeft;
  let borderBottom = h - ph - borderTop;

  const computeOutsetDimension = (dimension: any, fromBorder: number): number => (
    dimension.unit === null || dimension.unit === undefined ? dimension.value * fromBorder : dimension.value);

  const outsetTop = computeOutsetDimension(borderOutset[0], borderTop);
  const outsetRight = computeOutsetDimension(borderOutset[1], borderRight);
  const outsetBottom = computeOutsetDimension(borderOutset[2], borderBottom);
  const outsetLeft = computeOutsetDimension(borderOutset[3], borderLeft);

  x -= outsetLeft;
  y -= outsetTop;
  w += outsetLeft + outsetRight;
  h += outsetTop + outsetBottom;

  const computeWidthAdjustment = (dimension: any, original: number, intrinsic: number, areaDimension: number): number => {
    if (dimension === 'auto') return intrinsic;
    if (typeof dimension === 'number') return dimension * original;
    if (dimension.unit === '%') return dimension.value / 100 * areaDimension;
    return dimension.value;
  };

  // Adjustments after outsets: numerical outsets are relative to border-width, not border-image-width.
  borderTop = computeWidthAdjustment(borderWidth[0], borderTop, sliceTop, h);
  borderRight = computeWidthAdjustment(borderWidth[1], borderRight, sliceRight, w);
  borderBottom = computeWidthAdjustment(borderWidth[2], borderBottom, sliceBottom, h);
  borderLeft = computeWidthAdjustment(borderWidth[3], borderLeft, sliceLeft, w);

  const drawRegion = (rx: number, ry: number, width: number, height: number, sliceX: number, sliceY: number,
    sliceWidth: number, sliceHeight: number, repX = 'stretch', repY = 'stretch', scaleX0: number | null = null,
    scaleY0: number | null = null): [number, number] => {
    let scaleX: number = scaleX0 ?? 0;
    let scaleY: number = scaleY0 ?? 0;
    let nRepeatsX = 1;
    let nRepeatsY = 1;
    let extraDx = 0;
    let extraDy = 0;
    if (intrinsicWidth === 0 || width === 0 || sliceWidth === 0) scaleX = 0;
    else {
      if (!scaleX) scaleX = height && sliceHeight ? height / sliceHeight : 1;
      if (repX === 'repeat') nRepeatsX = ceil(width / sliceWidth / scaleX);
      else if (repX === 'space') {
        nRepeatsX = floor(width / sliceWidth / scaleX);
        // Space is before the first repeat and after the last, so there's one more space than repeat.
        extraDx = (width / scaleX - nRepeatsX * sliceWidth) / (nRepeatsX + 1);
      } else if (repX === 'round') {
        nRepeatsX = Math.max(1, pyRound(width / sliceWidth / scaleX));
        scaleX = width / (nRepeatsX * sliceWidth);
      } else {
        nRepeatsX = 1;
        scaleX = width / sliceWidth;
      }
    }
    if (intrinsicHeight === 0 || height === 0 || sliceHeight === 0) scaleY = 0;
    else {
      if (!scaleY) scaleY = width && sliceWidth ? width / sliceWidth : 1;
      if (repY === 'repeat') nRepeatsY = ceil(height / sliceHeight / scaleY);
      else if (repY === 'space') {
        nRepeatsY = floor(height / sliceHeight / scaleY);
        extraDy = (height / scaleY - nRepeatsY * sliceHeight) / (nRepeatsY + 1);
      } else if (repY === 'round') {
        nRepeatsY = Math.max(1, pyRound(height / sliceHeight / scaleY));
        scaleY = height / (nRepeatsY * sliceHeight);
      } else {
        nRepeatsY = 1;
        scaleY = height / sliceHeight;
      }
    }
    if (scaleX === 0 || scaleY === 0) return [scaleX, scaleY];

    const renderedWidth = intrinsicWidth * scaleX;
    const renderedHeight = intrinsicHeight * scaleY;
    const offsetX = renderedWidth * sliceX / intrinsicWidth;
    const offsetY = renderedHeight * sliceY / intrinsicHeight;

    stream.stacked(() => {
      stream.rectangle(rx, ry, width, height);
      stream.clip();
      stream.end();
      stream.transform(1, 0, 0, 1, rx - offsetX + extraDx, ry - offsetY + extraDy);
      stream.transform(scaleX, 0, 0, scaleY);
      for (let i = 0; i < nRepeatsX; i++) {
        for (let j = 0; j < nRepeatsY; j++) {
          stream.stacked(() => {
            stream.transform(1, 0, 0, 1, i * (sliceWidth + extraDx), j * (sliceHeight + extraDy));
            stream.rectangle(offsetX / scaleX, offsetY / scaleY, sliceWidth, sliceHeight);
            stream.clip();
            stream.end();
            image.draw(stream, intrinsicWidth, intrinsicHeight, box.style);
          });
        }
      }
    });
    return [scaleX, scaleY];
  };

  // Top left.
  const [scaleLeft, scaleTop] = drawRegion(x, y, borderLeft, borderTop, 0, 0, sliceLeft, sliceTop);
  // Top right.
  drawRegion(x + w - borderRight, y, borderRight, borderTop, intrinsicWidth - sliceRight, 0, sliceRight, sliceTop);
  // Bottom right.
  const [scaleRight, scaleBottom] = drawRegion(
    x + w - borderRight, y + h - borderBottom, borderRight, borderBottom,
    intrinsicWidth - sliceRight, intrinsicHeight - sliceBottom, sliceRight, sliceBottom);
  // Bottom left.
  drawRegion(x, y + h - borderBottom, borderLeft, borderBottom, 0, intrinsicHeight - sliceBottom, sliceLeft, sliceBottom);
  const xMiddle = sliceLeft + sliceRight < intrinsicWidth;
  if (xMiddle) {
    // Top middle.
    drawRegion(x + borderLeft, y, w - borderLeft - borderRight, borderTop, sliceLeft, 0,
      intrinsicWidth - sliceLeft - sliceRight, sliceTop, repeatX);
    // Bottom middle.
    drawRegion(x + borderLeft, y + h - borderBottom, w - borderLeft - borderRight, borderBottom,
      sliceLeft, intrinsicHeight - sliceBottom, intrinsicWidth - sliceLeft - sliceRight, sliceBottom, repeatX);
  }
  const yMiddle = sliceTop + sliceBottom < intrinsicHeight;
  if (yMiddle) {
    // Right middle.
    drawRegion(x + w - borderRight, y + borderTop, borderRight, h - borderTop - borderBottom,
      intrinsicWidth - sliceRight, sliceTop, sliceRight, intrinsicHeight - sliceTop - sliceBottom, 'stretch', repeatY);
    // Left middle.
    drawRegion(x, y + borderTop, borderLeft, h - borderTop - borderBottom, 0, sliceTop, sliceLeft,
      intrinsicHeight - sliceTop - sliceBottom, 'stretch', repeatY);
  }
  if (shouldFill && xMiddle && yMiddle) {
    // Fill middle.
    drawRegion(x + borderLeft, y + borderTop, w - borderLeft - borderRight, h - borderTop - borderBottom,
      sliceLeft, sliceTop, intrinsicWidth - sliceLeft - sliceRight, intrinsicHeight - sliceTop - sliceBottom,
      repeatX, repeatY, scaleLeft || scaleRight, scaleTop || scaleBottom);
  }
}

/**
 * Clip one segment of box border.
 * The strategy is to remove the zones not needed because of the style or the side before painting.
 */
export function clipBorderSegment(stream: PdfStream, style: string, width: number, side: string,
  borderBox: number[], borderWidths: number[] | null = null, radii: number[][] | null = null): void {
  const [bbx, bby, bbw, bbh] = borderBox;
  const [[tlh, tlv], [trh, trv], [brh, brv], [blh, blv]] = radii ?? [[0, 0], [0, 0], [0, 0], [0, 0]];
  const [bt, br, bb, bl] = borderWidths ?? [width, width, width, width];

  // Get the point use for border transition. The extra boolean returned is true if the point is in
  // the padding box (ie. the padding box is rounded).
  const transitionPoint = (x1: number, y1: number, x2: number, y2: number): [[number, number], boolean] => (
    Math.abs(x1) > Math.abs(x2) && Math.abs(y1) > Math.abs(y2) ? [[x1, y1], true] : [[x2, y2], false]);

  // Length of the half of one ellipsis corner (Ramanujan approximation).
  const cornerHalfLength = (a: number, b: number): number => {
    const x = (a - b) / (a + b);
    return pi / 8 * (a + b) * (1 + 3 * x ** 2 / (10 + sqrt(4 - 3 * x ** 2)));
  };

  // Draw a single dash or dot centered on cx, cy.
  const drawDash = (cx: number, cy: number, w = 0, h = 0, r = 0): void => {
    if (style === 'dotted') {
      const ratio = r / sqrt(pi);
      stream.moveTo(cx + r, cy);
      stream.curveTo(cx + r, cy + ratio, cx + ratio, cy + r, cx, cy + r);
      stream.curveTo(cx - ratio, cy + r, cx - r, cy + ratio, cx - r, cy);
      stream.curveTo(cx - r, cy - ratio, cx - ratio, cy - r, cx, cy - r);
      stream.curveTo(cx + ratio, cy - r, cx + r, cy - ratio, cx + r, cy);
      stream.close();
    } else if (style === 'dashed') stream.rectangle(cx - w / 2, cy - h / 2, w, h);
  };

  let px1 = 0, py1 = 0, px2 = 0, py2 = 0, rounded1 = false, rounded2 = false;
  let way = 1, angle = 1, mainOffset = 0;
  if (side === 'top') {
    [[px1, py1], rounded1] = transitionPoint(tlh, tlv, bl, bt);
    [[px2, py2], rounded2] = transitionPoint(-trh, trv, -br, bt);
    width = bt;
    way = 1;
    angle = 1;
    mainOffset = bby;
  } else if (side === 'right') {
    [[px1, py1], rounded1] = transitionPoint(-trh, trv, -br, bt);
    [[px2, py2], rounded2] = transitionPoint(-brh, -brv, -br, -bb);
    width = br;
    way = 1;
    angle = 2;
    mainOffset = bbx + bbw;
  } else if (side === 'bottom') {
    [[px1, py1], rounded1] = transitionPoint(blh, -blv, bl, -bb);
    [[px2, py2], rounded2] = transitionPoint(-brh, -brv, -br, -bb);
    width = bb;
    way = -1;
    angle = 3;
    mainOffset = bby + bbh;
  } else if (side === 'left') {
    [[px1, py1], rounded1] = transitionPoint(tlh, tlv, bl, bt);
    [[px2, py2], rounded2] = transitionPoint(blh, -blv, bl, -bb);
    width = bl;
    way = -1;
    angle = 4;
    mainOffset = bbx;
  }

  let a1 = 0, b1 = 0, a2 = 0, b2 = 0, lineLength = 0, length = 0;
  if (side === 'top' || side === 'bottom') {
    [a1, b1] = [px1 - bl / 2, way * py1 - width / 2];
    [a2, b2] = [-px2 - br / 2, way * py2 - width / 2];
    lineLength = bbw - px1 + px2;
    length = bbw;
    stream.moveTo(bbx + bbw, mainOffset);
    stream.lineTo(bbx, mainOffset);
    stream.lineTo(bbx + px1, mainOffset + py1);
    stream.lineTo(bbx + bbw + px2, mainOffset + py2);
  } else if (side === 'left' || side === 'right') {
    [a1, b1] = [-way * px1 - width / 2, py1 - bt / 2];
    [a2, b2] = [-way * px2 - width / 2, -py2 - bb / 2];
    lineLength = bbh - py1 + py2;
    length = bbh;
    stream.moveTo(mainOffset, bby + bbh);
    stream.lineTo(mainOffset, bby);
    stream.lineTo(mainOffset + px1, bby + py1);
    stream.lineTo(mainOffset + px2, bby + bbh + py2);
  }

  if (style === 'dotted' || style === 'dashed') {
    let dash = style === 'dotted' ? width : 3 * width;
    stream.clip(true);
    stream.end();
    if (rounded1 || rounded2) {
      // At least one of the two corners is rounded.
      const chl1 = cornerHalfLength(a1, b1);
      const chl2 = cornerHalfLength(a2, b2);
      length = lineLength + chl1 + chl2;
      const dashLength = pyRound(length / dash);
      if (rounded1 && rounded2) dash = length / (dashLength + dashLength % 2); // 2x dashes.
      else dash = length / (dashLength + dashLength % 2 - 0.5); // 2x - 1/2 dashes.
      const dashes1 = ceil((chl1 - dash / 2) / dash);
      const dashes2 = ceil((chl2 - dash / 2) / dash);
      let line = floor(lineLength / dash);

      const drawDashes = (dashes: number, line_: number, way_: number, x: number, y: number, px: number, py: number,
        chl: number): [number, number] => {
        if (style === 'dotted') {
          if (dashes === 0) return [line_ + 1, -1];
          if (dashes === 1) return [line_ + 1, -0.5];
          let i = 1;
          for (; i < dashes; i += 2) {
            const a = ((2 * angle - way_) + i * way_ * dash / chl) / 4 * pi;
            const cx = side === 'top' || side === 'bottom' ? x : mainOffset;
            const cy = side === 'left' || side === 'right' ? y : mainOffset;
            drawDash(cx + px - (Math.abs(px) - dash / 2) * cos(a), cy + py - (Math.abs(py) - dash / 2) * sin(a), 0, 0, dash / 2);
          }
          const nextA = ((2 * angle - way_) + (i + 2) * way_ * dash / chl) / 4 * pi;
          const offset = nextA / pi * 2 - angle;
          if (dashes % 2) line_ += 1;
          return [line_, offset];
        }
        if (dashes === 0) return [line_ + 1, -1 / 3];
        let offset: number;
        let broke = false;
        let angle2 = 0;
        let angle1 = 0;
        for (let i0 = 0; i0 < dashes; i0 += 2) {
          const i = i0 + 0.5; // half dash
          angle1 = ((2 * angle - way_) + i * way_ * dash / chl) / 4 * pi;
          angle2 = (way_ > 0 ? Math.min : Math.max)(((2 * angle - way_) + (i + 1) * way_ * dash / chl) / 4 * pi, angle * pi / 2);
          if (side === 'top' || side === 'bottom') {
            stream.moveTo(x + px, mainOffset + py);
            stream.lineTo(x + px - way_ * px * 1 / tan(angle2), mainOffset);
            stream.lineTo(x + px - way_ * px * 1 / tan(angle1), mainOffset);
          } else if (side === 'left' || side === 'right') {
            stream.moveTo(mainOffset + px, y + py);
            stream.lineTo(mainOffset, y + py + way_ * py * tan(angle2));
            stream.lineTo(mainOffset, y + py + way_ * py * tan(angle1));
          }
          if (angle2 === angle * pi / 2) {
            offset = (angle1 - angle2) / (((2 * angle - way_) + (i + 1) * way_ * dash / chl) / 4 * pi - angle1);
            line_ += 1;
            broke = true;
            break;
          }
        }
        if (!broke) offset = 1 - (angle * pi / 2 - angle2) / (angle2 - angle1);
        return [line_, offset!];
      };

      let offset: number;
      [line, offset] = drawDashes(dashes1, line, way, bbx, bby, px1, py1, chl1);
      line = drawDashes(dashes2, line, -way, bbx + bbw, bby + bbh, px2, py2, chl2)[0];

      if (lineLength > 1e-6) {
        for (let i0 = 0; i0 < line; i0 += 2) {
          const i = i0 + offset;
          let x1: number, x2: number, y1: number, y2: number;
          if (side === 'top' || side === 'bottom') {
            x1 = bbx + px1 + i * dash;
            x2 = bbx + px1 + (i + 1) * dash;
            y1 = mainOffset - (way < 0 ? width : 0);
            y2 = y1 + width;
          } else {
            y1 = bby + py1 + i * dash;
            y2 = bby + py1 + (i + 1) * dash;
            x1 = mainOffset - (way > 0 ? width : 0);
            x2 = x1 + width;
          }
          drawDash(x1 + (x2 - x1) / 2, y1 + (y2 - y1) / 2, x2 - x1, y2 - y1, width / 2);
        }
      }
    } else {
      // No rounded corner, dashes on corners and evenly spaced between.
      const numberOfSpaces = floor(length / dash / 2);
      const numberOfDashes = numberOfSpaces + 1;
      let space = 0;
      if (style === 'dotted') {
        dash = width;
        space = numberOfSpaces ? (length - numberOfDashes * dash) / numberOfSpaces : 0; // no space, unused
      } else if (style === 'dashed') space = dash = length / (numberOfSpaces + numberOfDashes) || 1;
      for (let i = 0; i < numberOfDashes + 1; i++) {
        const advance = i * (space + dash);
        let cx = 0, cy = 0, dashWidth = 0, dashHeight = 0;
        if (side === 'top') {
          [cx, cy] = [bbx + advance + dash / 2, bby + width / 2];
          [dashWidth, dashHeight] = [dash, width];
        } else if (side === 'right') {
          [cx, cy] = [bbx + bbw - width / 2, bby + advance + dash / 2];
          [dashWidth, dashHeight] = [width, dash];
        } else if (side === 'bottom') {
          [cx, cy] = [bbx + advance + dash / 2, bby + bbh - width / 2];
          [dashWidth, dashHeight] = [dash, width];
        } else if (side === 'left') {
          [cx, cy] = [bbx + width / 2, bby + advance + dash / 2];
          [dashWidth, dashHeight] = [width, dash];
        }
        drawDash(cx, cy, dashWidth, dashHeight, dash / 2);
      }
    }
  }
  stream.clip(true);
  stream.end();
}

export function drawRoundedBorder(stream: PdfStream, box: AnyBox, style: any, color: any): void {
  if (style === 'ridge' || style === 'groove') {
    stream.setColor(color[0]);
    roundedBox(stream, box.roundedPaddingBox());
    roundedBox(stream, box.roundedBoxRatio(1 / 2));
    stream.fill(true);
    stream.setColor(color[1]);
    roundedBox(stream, box.roundedBoxRatio(1 / 2));
    roundedBox(stream, box.roundedBorderBox());
    stream.fill(true);
    return;
  }
  stream.setColor(color);
  roundedBox(stream, box.roundedPaddingBox());
  if (style === 'double') {
    roundedBox(stream, box.roundedBoxRatio(1 / 3));
    roundedBox(stream, box.roundedBoxRatio(2 / 3));
  }
  roundedBox(stream, box.roundedBorderBox());
  stream.fill(true);
}

export function drawRectBorder(stream: PdfStream, box: number[], widths: number[], style: string, color: any): void {
  const [bbx, bby, bbw, bbh] = box;
  const [bt, br, bb, bl] = widths;
  if (style === 'ridge' || style === 'groove') {
    stream.setColor(color[0]);
    stream.rectangle(box[0], box[1], box[2], box[3]);
    stream.rectangle(bbx + bl / 2, bby + bt / 2, bbw - (bl + br) / 2, bbh - (bt + bb) / 2);
    stream.fill(true);
    stream.rectangle(bbx + bl / 2, bby + bt / 2, bbw - (bl + br) / 2, bbh - (bt + bb) / 2);
    stream.rectangle(bbx + bl, bby + bt, bbw - bl - br, bbh - bt - bb);
    stream.setColor(color[1]);
    stream.fill(true);
    return;
  }
  stream.setColor(color);
  stream.rectangle(box[0], box[1], box[2], box[3]);
  if (style === 'double') {
    stream.rectangle(bbx + bl / 3, bby + bt / 3, bbw - (bl + br) / 3, bbh - (bt + bb) / 3);
    stream.rectangle(bbx + bl * 2 / 3, bby + bt * 2 / 3, bbw - (bl + br) * 2 / 3, bbh - (bt + bb) * 2 / 3);
  }
  stream.rectangle(bbx + bl, bby + bt, bbw - bl - br, bbh - bt - bb);
  stream.fill(true);
}

/**
 * Fast path: uniform dotted or dashed border with no rounded corners. Dotted uses a round line cap with a
 * zero-length dash; dashed uses a butt cap with equal dash/gap. One stroked line per side.
 */
export function drawDottedDashedBorder(stream: PdfStream, box: AnyBox, style: string, width: number, color: any): void {
  const [bbx, bby, bbw, bbh] = box.roundedBorderBox();
  const half = width / 2;
  // Round caps extend the line by half on each end, so dotted endpoints must be inset.
  const inset = style === 'dotted' ? half : 0;

  const dash = (outerLength: number): number[] => {
    if (style === 'dotted') {
      // Dot at each corner with equal spacing in between.
      const count = Math.max(2, Math.trunc(floor(outerLength / (2 * width))) + 1);
      return [0, (outerLength - width) / (count - 1)];
    }
    // Target dash size = 3 * width; equal dash/gap so an integer count fits flush between the two corners.
    const count = Math.trunc(floor(outerLength / (6 * width))) + 1;
    const dashLength = outerLength / (2 * count - 1);
    return [dashLength, dashLength];
  };

  stream.setColor(color, true);
  stream.setLineWidth(width);
  stream.setLineCap(style === 'dotted' ? 1 : 0);
  const sides: Array<[number, number, number, number, number]> = [
    [bbx + inset, bby + half, bbx + bbw - inset, bby + half, bbw],
    [bbx + bbw - half, bby + inset, bbx + bbw - half, bby + bbh - inset, bbh],
    [bbx + inset, bby + bbh - half, bbx + bbw - inset, bby + bbh - half, bbw],
    [bbx + half, bby + inset, bbx + half, bby + bbh - inset, bbh],
  ];
  for (const [x1, y1, x2, y2, outerLength] of sides) {
    stream.setDash(dash(outerLength), 0);
    stream.moveTo(x1, y1);
    stream.lineTo(x2, y2);
    stream.stroke();
  }
}

export function drawLine(stream: PdfStream, x1: number, y1: number, x2: number, y2: number, thickness: number, style: string,
  color: any, offset = 0): void {
  stream.stacked(() => {
    if (style !== 'ridge' && style !== 'groove') stream.setColor(color, true);

    if (style === 'dashed') stream.setDash([5 * thickness], offset);
    else if (style === 'dotted') {
      stream.setLineCap(1);
      stream.setDash([0, 2 * thickness], offset);
    }

    if (style === 'double') {
      stream.setLineWidth(thickness / 3);
      if (x1 === x2) {
        stream.moveTo(x1 - thickness / 3, y1);
        stream.lineTo(x2 - thickness / 3, y2);
        stream.moveTo(x1 + thickness / 3, y1);
        stream.lineTo(x2 + thickness / 3, y2);
      } else if (y1 === y2) {
        stream.moveTo(x1, y1 - thickness / 3);
        stream.lineTo(x2, y2 - thickness / 3);
        stream.moveTo(x1, y1 + thickness / 3);
        stream.lineTo(x2, y2 + thickness / 3);
      }
    } else if (style === 'ridge' || style === 'groove') {
      stream.setLineWidth(thickness / 2);
      stream.setColor(color[0], true);
      if (x1 === x2) {
        stream.moveTo(x1 + thickness / 4, y1);
        stream.lineTo(x2 + thickness / 4, y2);
      } else if (y1 === y2) {
        stream.moveTo(x1, y1 + thickness / 4);
        stream.lineTo(x2, y2 + thickness / 4);
      }
      stream.stroke();
      stream.setColor(color[1], true);
      if (x1 === x2) {
        stream.moveTo(x1 - thickness / 4, y1);
        stream.lineTo(x2 - thickness / 4, y2);
      } else if (y1 === y2) {
        stream.moveTo(x1, y1 - thickness / 4);
        stream.lineTo(x2, y2 - thickness / 4);
      }
    } else if (style === 'wavy') {
      let up = 1;
      const radius = 0.75 * thickness;
      stream.rectangle(x1, y1 - 2 * radius, x2 - x1, 4 * radius);
      stream.clip();
      stream.end();
      let x = x1 - offset;
      stream.moveTo(x, y1);
      while (x < x2) {
        stream.setLineWidth(thickness);
        stream.curveTo(x + radius / 2, y1 + up * radius, x + 3 * radius / 2, y1 + up * radius, x + 2 * radius, y1);
        x += 2 * radius;
        up *= -1;
      }
    } else {
      stream.setLineWidth(thickness);
      stream.moveTo(x1, y1);
      stream.lineTo(x2, y2);
    }
    stream.stroke();
  });
}

export function drawOutline(stream: PdfStream, box: AnyBox): void {
  const width = box.style.get('outline_width');
  const offset = box.style.get('outline_offset');
  const color = getColor(box.style, 'outline_color');
  const style = box.style.get('outline_style');
  if (box.style.get('visibility') === 'visible' && width && color.a) {
    const outlineBox = [
      box.borderBoxX() - width - offset, box.borderBoxY() - width - offset,
      box.borderWidth() + 2 * width + 2 * offset, box.borderHeight() + 2 * width + 2 * offset];
    for (const side of SIDES) {
      stream.artifact(() => stream.stacked(() => {
        clipBorderSegment(stream, style, width, side, outlineBox);
        drawRectBorder(stream, outlineBox, [width, width, width, width], style, styledColor(style, color, side));
      }));
    }
  }
  for (const child of box.children ?? []) if (child instanceof boxes.Box) drawOutline(stream, child);
}

/** Draw the path of the border radius box. */
export function roundedBox(stream: PdfStream, radii: Radii): void {
  const [x, y, w, h, tl, tr, br, bl] = radii;
  if ([tl, tr, br, bl].every((corner) => corner.includes(0))) {
    // No radius, draw a rectangle
    stream.rectangle(x, y, w, h);
    return;
  }
  const r = 0.45;
  stream.moveTo(x + tl[0], y);
  stream.lineTo(x + w - tr[0], y);
  stream.curveTo(x + w - tr[0] * r, y, x + w, y + tr[1] * r, x + w, y + tr[1]);
  stream.lineTo(x + w, y + h - br[1]);
  stream.curveTo(x + w, y + h - br[1] * r, x + w - br[0] * r, y + h, x + w - br[0], y + h);
  stream.lineTo(x + bl[0], y + h);
  stream.curveTo(x + bl[0] * r, y + h, x, y + h - bl[1] * r, x, y + h - bl[1]);
  stream.lineTo(x, y + tl[1]);
  stream.curveTo(x, y + tl[1] * r, x + tl[0] * r, y, x + tl[0], y);
}