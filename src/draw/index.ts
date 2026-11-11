// SPDX-License-Identifier: BSD-3-Clause

/** Take an "after layout" box tree and draw it onto a pydyf stream (mirrors weasyprint/draw/__init__.py). */
import * as boxes from '../formatting_structure/boxes.ts';
import { LinearGradient, RadialGradient } from '../gradients.ts';
import * as replaced from '../layout/replaced.ts';
import { LOGGER } from '../logger.ts';
import { Matrix } from '../matrix.ts';
import type { PdfStream } from '../pdf/stream.ts';
import { StackingContext } from '../stacking.ts';
import { SvgImage } from '../svg/image.ts';
import { drawBorder, drawLine, drawOutline, roundedBox, setMaskBorder } from './border.ts';
import { styledColor } from './color.ts';
import { drawText } from './text.ts';

type AnyBox = any;
const pi = Math.PI;

/** Draw the given PageBox. */
export function drawPage(page: AnyBox, stream: PdfStream): void {
  const marks = page.style.get('marks');
  const stackingContext = StackingContext.fromPage(page);
  drawBackground(stream, stackingContext.box.background, false, page.bleed, marks);
  setMaskBorder(stream, page);
  drawBackground(stream, page.canvasBackground, false);
  drawBorder(stream, page);
  drawStackingContext(stream, stackingContext);
}

/** Draw a stacking context on stream. */
export function drawStackingContext(stream: PdfStream, stackingContext: StackingContext): void {
  // See https://www.w3.org/TR/CSS2/zindex.html.
  const original = stream;
  stream.pushState();
  try {
    const box = stackingContext.box;

    // Apply the viewport_overflow to the html box, see #35.
    if (box.isForRootElement && stackingContext.page.style.get('overflow') !== 'visible') {
      roundedBox(stream, stackingContext.page.roundedPaddingBox());
      stream.clip();
      stream.end();
    }

    // Python truthiness: an empty clip list ([] = `clip: auto`) is falsy. An empty
    // JS array is truthy, so require a non-empty list explicitly.
    const clipList = box.isAbsolutelyPositioned() ? box.style.get('clip') : [];
    if (Array.isArray(clipList) && clipList.length) {
      let [top, right, bottom, left] = clipList;
      if (top === 'auto') top = 0;
      if (right === 'auto') right = 0;
      if (bottom === 'auto') bottom = box.borderHeight();
      if (left === 'auto') left = box.borderWidth();
      stream.rectangle(box.borderBoxX() + right, box.borderBoxY() + top, left - right, bottom - top);
      stream.clip();
      stream.end();
    }

    if (box.style.get('opacity') < 1) stream = stream.addGroup(...stream.pageRectangle);

    if (box.transformationMatrix) {
      if (box.transformationMatrix.determinant) stream.transform(...box.transformationMatrix.values);
      else return;
    }

    // Point 1 is done in drawPage.

    // Point 2.
    if (box instanceof boxes.BlockBox || box instanceof boxes.MarginBox || box instanceof boxes.InlineBlockBox ||
      box instanceof boxes.TableCellBox || box instanceof boxes.FlexContainerBox || box instanceof boxes.GridContainerBox ||
      box instanceof boxes.ReplacedBox) {
      setMaskBorder(stream, box);
      // The canvas background was removed by layoutBackgrounds.
      drawBackground(stream, box.background);
      drawBorder(stream, box);
    }

    const s = stream;
    s.stacked(() => {
      // Dont clip the page box, see #35.
      const clip = box.style.get('overflow') !== 'visible' && !(box instanceof boxes.PageBox);
      if (clip) {
        // Only clip the content and the children: the background is already clipped, the border must *not* be clipped.
        roundedBox(s, box.roundedPaddingBox());
        s.clip();
        s.end();
      }

      // Point 3.
      for (const child of stackingContext.negativeZContexts) drawStackingContext(s, child);

      // Point 4.
      for (const block of stackingContext.blockLevelBoxes) {
        setMaskBorder(s, block);
        if (block instanceof boxes.TableBox) drawTable(s, block);
        else {
          drawBackground(s, block.background);
          drawBorder(s, block);
        }
      }

      // Point 5.
      for (const child of stackingContext.floatContexts) drawStackingContext(s, child);

      // Point 6.
      if (box instanceof boxes.InlineBox) drawInlineLevel(s, stackingContext.page, box);

      // Point 7.
      drawBlockLevel(stackingContext.page, s, new Map([[box, stackingContext.blocksAndCells]]));

      // Point 8.
      for (const child of stackingContext.zeroZContexts) drawStackingContext(s, child);

      // Point 9.
      for (const child of stackingContext.positiveZContexts) drawStackingContext(s, child);
    });

    // Point 10.
    drawOutline(stream, box);

    if (box.style.get('opacity') < 1) {
      const groupId = (stream as PdfStream).id;
      stream = original;
      stream.stacked(() => {
        stream.setAlpha(box.style.get('opacity'), true, true);
        stream.drawXObject(groupId);
      });
    }
  } finally {
    original.popState();
  }
}

function spreadBox(box: any[], spread: number, tx: number, ty: number): any[] {
  if (!spread && !tx && !ty) return box;
  // Update coordinates.
  const x = box[0] + tx - spread;
  const y = box[1] + ty - spread;
  const width = Math.max(0, box[2] + 2 * spread);
  const height = Math.max(0, box[3] + 2 * spread);
  // Update radii.
  const radii = box.slice(4).map((r: number[]) => (
    r[0] >= -spread && r[1] >= -spread && r[0] && r[1] ? [r[0] + spread, r[1] + spread] : [0, 0]));
  return [x, y, width, height, ...radii];
}

function drawBoxShadow(stream: PdfStream, box: any[], style: any, tx: number, ty: number, blur: number, spread: number,
  color: any, inset: boolean): void {
  stream.setColor(color);

  // Original rounded box values.
  const shadowBox = spreadBox(box, spread, tx, ty);
  const innerBox = spreadBox(box, spread - blur, tx, ty);
  const outerBox = spreadBox(box, spread + blur, tx, ty);

  // Mask original box.
  if (!inset) roundedBox(stream, outerBox);
  roundedBox(stream, box);
  stream.clip(true);
  stream.end();

  // No blur: we render the rounded box with spread applied.
  if (!blur) {
    if (inset) roundedBox(stream, box);
    roundedBox(stream, shadowBox);
    stream.fill(true);
    return;
  }

  // Fill the outer rectangle if inset, the plain rectangle if outset.
  if (inset) {
    roundedBox(stream, box);
    roundedBox(stream, outerBox);
    stream.fill(true);
  } else {
    roundedBox(stream, innerBox);
    stream.fill();
  }

  // Variables for blur: linear gradient sides and corners.
  const transparent = { ...color, a: 0 };
  const repeat = false;
  const shape = 'ellipse';
  const [x, y, w, h] = innerBox;
  const [[tlcx, tlcy], [trcx, trcy], [brcx, brcy], [blcx, blcy]] = innerBox.slice(4);
  const sides: Array<[number, number, number, number, number]> = [
    [0, x + tlcx, y - 2 * blur, w - tlcx - trcx, 2 * blur],
    [pi / 2, x + w, y + trcy, 2 * blur, h - trcy - brcy],
    [pi, x + blcx, y + h, w - blcx - brcx, 2 * blur],
    [3 * pi / 2, x - 2 * blur, y + tlcy, 2 * blur, h - tlcy - blcy],
  ];
  const corners: Array<[number, number, number, number, number, number]> = [
    [100, 100, x - 2 * blur, y - 2 * blur, tlcx, tlcy],
    [0, 100, x + w - trcx, y - 2 * blur, trcx, trcy],
    [0, 0, x + w - brcx, y + h - brcy, brcx, brcy],
    [100, 0, x - 2 * blur, y + h - blcy, blcx, blcy],
  ];
  const [inColor, outColor] = inset ? [transparent, color] : [color, transparent];

  // Draw sides.
  let stops: Array<[any, any]> = [[inColor, null], [outColor, null]];
  let hints: any[] = [{ value: blur * 1.25, unit: 'px' }];
  for (const [angle, e, f, width, height] of sides) {
    const gradient = new LinearGradient(stops, ['angle', angle], repeat, hints);
    stream.stacked(() => {
      stream.transform(1, 0, 0, 1, e, f);
      gradient.draw(stream, width, height, style);
    });
  }

  // Draw corners.
  stream.stacked(() => {
    roundedBox(stream, innerBox);
    roundedBox(stream, outerBox);
    stream.clip(true);
    stream.end();
    for (const [left, top, e, f, cx, cy] of corners) {
      const width = 2 * blur + cx;
      const height = 2 * blur + cy;
      const size: [string, any] = ['explicit', [{ value: width, unit: 'px' }, { value: height, unit: 'px' }]];
      stops = [[inColor, { value: cx, unit: 'px' }], [outColor, null]];
      hints = [{ value: cx + blur * 1.25, unit: 'px' }];
      const center = ['left', { value: left, unit: '%' }, 'top', { value: top, unit: '%' }];
      const gradient = new RadialGradient(stops, shape, size, center, repeat, hints);
      stream.stacked(() => {
        stream.transform(1, 0, 0, 1, e, f);
        gradient.draw(stream, width, height, style);
      });
    }
  });
}

export function drawBoxShadows(stream: PdfStream, boxesList: any[][], style: any, inset: boolean): void {
  // Draw box shadows.
  const shadows = [...style.get('box_shadow')].reverse();
  for (const [x, y, blur0, spread0, color0, shadowInset] of shadows) {
    // Only draw inset or outset shadows.
    if (inset !== shadowInset) continue;
    const tx = x.value;
    const ty = y.value;
    const blur = blur0.value;
    const spread = inset ? -spread0.value : spread0.value;
    const color = color0 === 'currentcolor' ? style.get('color') : color0;
    for (const box of boxesList) {
      stream.artifact(() => stream.stacked(() => drawBoxShadow(stream, box, style, tx, ty, blur, spread, color, inset)));
    }
  }
}

/**
 * Draw the background color and image to a stream. If `clipBox` is false, the background is not clipped to the
 * border box of the background, but only to the painting area.
 */
export function drawBackground(stream: PdfStream, background: any, clipBox = true, bleed: any = null, marks: any = []): void {
  if (!background || !background.layers.length) return;

  let clippedBoxes = background.layers[background.layers.length - 1].clippedBoxes;
  const paintingArea = background.layers[background.layers.length - 1].paintingArea;

  drawBoxShadows(stream, clippedBoxes, background.style, false);

  stream.stacked(() => {
    if (clipBox) {
      for (const box of clippedBoxes) roundedBox(stream, box);
      stream.clip();
      stream.end();
    }

    // Draw background color.
    if (background.color.a > 0) {
      stream.artifact(() => stream.stacked(() => {
        stream.setColor(background.color);
        stream.rectangle(...(paintingArea as [number, number, number, number]));
        stream.clip();
        stream.end();
        stream.rectangle(...(paintingArea as [number, number, number, number]));
        stream.fill();
      }));
    }

    // Draw crop marks and crosses.
    if (bleed && marks && marks.length) {
      const [x, y, width, height] = paintingArea as [number, number, number, number];
      const halfBleed: Record<string, number> = {};
      for (const key of Object.keys(bleed)) halfBleed[key] = bleed[key] * 0.5;
      let svg = `
              <svg height="${height}" width="${width}"
                   fill="transparent" stroke="black" stroke-width="1"
                   xmlns="http://www.w3.org/2000/svg">
            `;
      if (marks.includes('crop')) {
        svg += `
                  <path d="M0,${bleed.top} h${halfBleed.left}" />
                  <path d="M0,${bleed.top} h${halfBleed.right}"
                        transform="translate(${width},0) scale(-1,1)" />
                  <path d="M0,${bleed.bottom} h${halfBleed.right}"
                        transform="translate(${width},${height}) scale(-1,-1)" />
                  <path d="M0,${bleed.bottom} h${halfBleed.left}"
                        transform="translate(0,${height}) scale(1,-1)" />
                  <path d="M${bleed.left},0 v${halfBleed.top}" />
                  <path d="M${bleed.right},0 v${halfBleed.bottom}"
                        transform="translate(${width},${height}) scale(-1,-1)" />
                  <path d="M${bleed.left},0 v${halfBleed.bottom}"
                        transform="translate(0,${height}) scale(1,-1)" />
                  <path d="M${bleed.right},0 v${halfBleed.top}"
                        transform="translate(${width},0) scale(-1,1)" />
                `;
      }
      if (marks.includes('cross')) {
        svg += `
                  <circle r="${halfBleed.top}" transform="scale(0.5)
                     translate(${width},${halfBleed.top}) scale(0.5)" />
                  <path transform="scale(0.5) translate(${width},0)" d="
                    M-${halfBleed.top},${halfBleed.top} h${bleed.top}
                    M0,0 v${bleed.top}" />
                  <circle r="${halfBleed.bottom}" transform="
                    translate(0,${height}) scale(0.5)
                    translate(${width},-${halfBleed.bottom}) scale(0.5)" />
                  <path d="M-${halfBleed.bottom},-${halfBleed.bottom}
                    h${bleed.bottom} M0,0 v-${bleed.bottom}" transform="
                    translate(0,${height}) scale(0.5) translate(${width},0)" />
                  <circle r="${halfBleed.left}" transform="scale(0.5)
                    translate(${halfBleed.left},${height}) scale(0.5)" />
                  <path d="M${halfBleed.left},-${halfBleed.left}
                    v${bleed.left} M0,0 h${bleed.left}"
                    transform="scale(0.5) translate(0,${height})" />
                  <circle r="${halfBleed.right}" transform="
                    translate(${width},0) scale(0.5)
                    translate(-${halfBleed.right},${height}) scale(0.5)" />
                  <path d="M-${halfBleed.right},-${halfBleed.right}
                    v${bleed.right} M0,0 h-${bleed.right}" transform="
                    translate(${width},0) scale(0.5) translate(0,${height})" />
                `;
      }
      svg += '</svg>';
      const image = new SvgImage('crop marks', new TextEncoder().encode(svg), null, null, null);
      // Painting area is the PDF media box
      const size = [width, height];
      const position = [x, y];
      const repeat = ['no-repeat', 'no-repeat'];
      const unbounded = true;
      const positioningArea = [0, 0, width, height];
      clippedBoxes = [];
      const layer = {
        image, size, position, repeat, unbounded, paintingArea: [x, y, width, height], positioningArea, clippedBoxes,
      };
      background.layers.unshift(layer);
    }
    // Paint in reversed order: first layer is "closest" to the viewer.
    for (const layer of [...background.layers].reverse()) drawBackgroundImage(stream, layer, background.style);
  });

  drawBoxShadows(stream, clippedBoxes, background.style, true);
}

export function drawBackgroundImage(stream: PdfStream, layer: any, style: any): void {
  if (layer.image === null || layer.image === undefined || layer.size.includes(0)) return;

  const [paintingX, paintingY, paintingWidth, paintingHeight] = layer.paintingArea;
  const [positioningX, positioningY, positioningWidth, positioningHeight] = layer.positioningArea;
  let [positionX, positionY] = layer.position;
  const [repeatX, repeatY] = layer.repeat;
  const [imageWidth, imageHeight] = layer.size;

  if (repeatX === 'no-repeat' && repeatY === 'no-repeat') {
    stream.artifact(() => {
      // We don't use a pattern when we don't need to because some viewers (e.g., Preview on Mac) introduce
      // unnecessary pixelation when vector images are used in patterns.
      if (!layer.unbounded) {
        stream.rectangle(paintingX, paintingY, paintingWidth, paintingHeight);
        stream.clip();
        stream.end();
      }
      // Put the image in a group so that masking outside the image and masking within the image don't conflict.
      const group = stream.addGroup(...stream.pageRectangle);
      group.transform(1, 0, 0, 1, positionX + positioningX, positionY + positioningY);
      layer.image.draw(group, imageWidth, imageHeight, style);
      stream.drawXObject(group.id);
    });
    return;
  }

  let repeatWidth: number;
  if (repeatX === 'no-repeat') {
    // We want at least the whole imageWidth drawn on sub_surface, but we want to be sure it will not be repeated
    // on the paintingWidth. We double the painting width to ensure viewers don't incorrectly bleed the edge of
    // the pattern into the painting area. (See #1539.)
    repeatWidth = Math.max(imageWidth, 2 * paintingWidth);
  } else if (repeatX === 'repeat' || repeatX === 'round') repeatWidth = imageWidth; // We repeat the image each imageWidth.
  else {
    const nRepeats = Math.floor(positioningWidth / imageWidth);
    if (nRepeats >= 2) {
      // The repeat width is the whole positioning width with one image removed, divided by (the number of repeated
      // images - 1). This way, we get the width of one image + one space. We ignore background-position for this dimension.
      repeatWidth = (positioningWidth - imageWidth) / (nRepeats - 1);
      positionX = 0;
    } else repeatWidth = positioningWidth; // We don't repeat the image.
  }

  // Comments above apply here too.
  let repeatHeight: number;
  if (repeatY === 'no-repeat') repeatHeight = Math.max(imageHeight, 2 * paintingHeight);
  else if (repeatY === 'repeat' || repeatY === 'round') repeatHeight = imageHeight;
  else {
    const nRepeats = Math.floor(positioningHeight / imageHeight);
    if (nRepeats >= 2) {
      repeatHeight = (positioningHeight - imageHeight) / (nRepeats - 1);
      positionY = 0;
    } else repeatHeight = positioningHeight;
  }

  let matrix = new Matrix(1, 0, 0, 1, positionX + positioningX, positionY + positioningY);
  matrix = matrix.matmul(stream.ctm);
  const pattern = stream.addPattern(0, 0, imageWidth, imageHeight, repeatWidth, repeatHeight, matrix);
  const group = pattern.addGroup(0, 0, repeatWidth, repeatHeight);

  stream.artifact(() => stream.stacked(() => {
    layer.image.draw(group, imageWidth, imageHeight, style);
    pattern.artifact(() => pattern.drawXObject(group.id));
    stream.setColorSpace('Pattern');
    stream.setColorSpecial(pattern.id, false);
    if (layer.unbounded) {
      const [x1, y1, x2, y2] = stream.pageRectangle;
      stream.rectangle(x1, y1, x2 - x1, y2 - y1);
    } else stream.rectangle(paintingX, paintingY, paintingWidth, paintingHeight);
    stream.fill();
  }));
}

export function drawTable(stream: PdfStream, table: AnyBox): void {
  // Draw backgrounds.
  drawBackground(stream, table.background);
  for (const columnGroup of table.columnGroups) {
    drawBackground(stream, columnGroup.background);
    for (const column of columnGroup.children) drawBackground(stream, column.background);
  }
  for (const rowGroup of table.children) {
    drawBackground(stream, rowGroup.background);
    for (const row of rowGroup.children) {
      drawBackground(stream, row.background);
      for (const cell of row.children) {
        const drawCellBackground = table.style.get('border_collapse') === 'collapse' ||
          cell.style.get('empty_cells') === 'show' || !cell.empty;
        if (drawCellBackground) drawBackground(stream, cell.background);
      }
    }
  }

  // Draw borders.
  if (table.style.get('border_collapse') === 'collapse') {
    drawCollapsedBorders(stream, table);
    return;
  }
  drawBorder(stream, table);
  for (const rowGroup of table.children) {
    for (const row of rowGroup.children) {
      for (const cell of row.children) {
        if (cell.style.get('empty_cells') === 'show' || !cell.empty) drawBorder(stream, cell);
      }
    }
  }
}

/** Draw borders of table cells when they collapse. */
export function drawCollapsedBorders(stream: PdfStream, table: AnyBox): void {
  const rowHeights: number[] = table.children.flatMap((rowGroup: AnyBox) => rowGroup.children.map((row: AnyBox) => row.height));
  const columnWidths: number[] = table.columnWidths;
  if (!(rowHeights.length && columnWidths.length)) return; // One of the list is empty: don't bother with empty tables.
  const rowPositions: number[] = table.children.flatMap((rowGroup: AnyBox) => rowGroup.children.map((row: AnyBox) => row.positionY));
  const columnPositions: number[] = [...table.columnPositions];
  const gridHeight = rowHeights.length;
  const gridWidth = columnWidths.length;
  const [verticalBorders, horizontalBorders] = table.collapsedBorderGrid;
  // Add the end of the last column.
  columnPositions.push(columnPositions[columnPositions.length - 1] + columnWidths[columnWidths.length - 1]);
  // Add the end of the last row.
  rowPositions.push(rowPositions[rowPositions.length - 1] + rowHeights[rowHeights.length - 1]);
  const headerRows = table.children[0].isHeader ? table.children[0].children.length : 0;
  const footerRows = table.children[table.children.length - 1].isFooter ? table.children[table.children.length - 1].children.length : 0;
  const skippedRows = table.skippedRows;
  const bodyRowsOffset = skippedRows ? skippedRows - headerRows : 0;
  const originalGridHeight = verticalBorders.length;
  const footerRowsOffset = originalGridHeight - gridHeight;

  const rowNumber = (y: number, horizontal: boolean): number => {
    // Examples in comments for 2 headers rows, 5 body rows, 3 footer rows.
    if (headerRows && y < headerRows + Number(horizontal)) return y; // Row in header: y < 2 for vertical, y < 3 for horizontal.
    if (footerRows && y >= gridHeight - footerRows) return y + footerRowsOffset; // Row in footer: y >= 7.
    return y + bodyRowsOffset; // Row in body.
  };

  // Score is (hidden, width, styleRank), compared lexicographically like the oracle's tuple.
  const segments: Array<[number[], string, number, any, string, number[]]> = [];

  const halfMaxWidth = (borderList: any[][], yxPairs: Array<[number, number]>, vertical = true): number => {
    let result = 0;
    for (const [y, x] of yxPairs) {
      const inside = vertical ? (y >= 0 && y < gridHeight && x >= 0 && x <= gridWidth) : (y >= 0 && y <= gridHeight && x >= 0 && x < gridWidth);
      if (inside) {
        const yy = rowNumber(y, !vertical);
        const [, [, width]] = borderList[yy][x];
        result = Math.max(result, width);
      }
    }
    return result / 2;
  };

  const addVertical = (x: number, y: number): void => {
    const yy = rowNumber(y, false);
    const [score, [style, width, color]] = verticalBorders[yy][x];
    if (width === 0 || color.a === 0) return;
    const posX = columnPositions[x];
    let posY1 = rowPositions[y];
    if (y !== 0 || !table.skipCellBorderTop) posY1 -= halfMaxWidth(horizontalBorders, [[y, x - 1], [y, x]], false);
    let posY2 = rowPositions[y + 1];
    if (y !== gridHeight - 1 || !table.skipCellBorderBottom) posY2 += halfMaxWidth(horizontalBorders, [[y + 1, x - 1], [y + 1, x]], false);
    segments.push([score, style, width, color, 'left', [posX, posY1, 0, posY2 - posY1]]);
  };

  const addHorizontal = (x: number, y: number): void => {
    if (y === 0 && table.skipCellBorderTop) return;
    if (y === gridHeight && table.skipCellBorderBottom) return;
    const yy = rowNumber(y, true);
    const [score, [style, width, color]] = horizontalBorders[yy][x];
    if (width === 0 || color.a === 0) return;
    const posY = rowPositions[y];
    const shiftBefore = halfMaxWidth(verticalBorders, [[y - 1, x], [y, x]]);
    const shiftAfter = halfMaxWidth(verticalBorders, [[y - 1, x + 1], [y, x + 1]]);
    const posX1 = columnPositions[x] - shiftBefore;
    const posX2 = columnPositions[x + 1] + shiftAfter;
    segments.push([score, style, width, color, 'top', [posX1, posY, posX2 - posX1, 0]]);
  };

  for (let x = 0; x < gridWidth; x++) addHorizontal(x, 0);
  for (let y = 0; y < gridHeight; y++) {
    addVertical(0, y);
    for (let x = 0; x < gridWidth; x++) {
      addVertical(x + 1, y);
      addHorizontal(x, y + 1);
    }
  }

  // Sort bigger scores last (painted later, on top).
  segments.sort((a, b) => a[0][0] - b[0][0] || a[0][1] - b[0][1] || a[0][2] - b[0][2]);

  for (const [, style, width, color0, side, borderBox] of segments) {
    const [bx, by, bw, bh] = borderBox;
    const color = styledColor(style, color0, side);
    stream.artifact(() => stream.stacked(() => drawLine(stream, bx, by, bx + bw, by + bh, width, style, color)));
  }
}

export function drawReplacedbox(stream: PdfStream, box: AnyBox): void {
  if (box.style.get('visibility') !== 'visible' || !box.width || !box.height) return;

  const [drawWidth, drawHeight, drawX, drawY] = replaced.replacedboxLayout(box);
  if (drawWidth <= 0 || drawHeight <= 0) return;

  stream.stacked(() => {
    stream.setAlpha(1);
    stream.transform(1, 0, 0, 1, drawX, drawY);
    stream.stacked(() => {
      // TODO: Use the real intrinsic size here, not affected by 'image-resolution'?
      box.replacement.draw(stream, drawWidth, drawHeight, box.style);
    });
  });
}

export function drawInlineLevel(stream: PdfStream, page: AnyBox, box: AnyBox, offsetX = 0, textOverflow = 'clip',
  blockEllipsis: any = 'none'): void {
  if (box instanceof StackingContext) {
    drawStackingContext(stream, box);
    return;
  }
  setMaskBorder(stream, box);
  drawBackground(stream, box.background);
  drawBorder(stream, box);
  if (box instanceof boxes.InlineBox || box instanceof boxes.LineBox) {
    if (box instanceof boxes.LineBox) {
      textOverflow = box.textOverflow;
      blockEllipsis = box.blockEllipsis;
    }
    let ellipsis: any = 'none';
    box.children.forEach((child: AnyBox, i: number) => {
      if (i === box.children.length - 1) ellipsis = blockEllipsis; // Last child
      const childOffsetX = child instanceof StackingContext ? offsetX : offsetX + child.positionX - box.positionX;
      if (child instanceof boxes.TextBox) {
        stream.marked(child, 'Span', () => drawText(stream, child, childOffsetX, textOverflow, ellipsis));
      } else drawInlineLevel(stream, page, child, childOffsetX, textOverflow, ellipsis);
    });
  } else if (box instanceof boxes.InlineReplacedBox) {
    stream.marked(box, 'Figure', () => drawReplacedbox(stream, box));
  } else {
    // Should only happen for list markers.
    drawText(stream, box, offsetX, textOverflow, 'none');
  }
}

export function drawBlockLevel(page: AnyBox, stream: PdfStream, blocksAndCells: Map<AnyBox, any>): void {
  for (const [block, inner] of blocksAndCells) {
    if (block instanceof boxes.ReplacedBox) stream.marked(block, 'Figure', () => drawReplacedbox(stream, block));
    else if (block.children && block.children.length) {
      if (block.children[block.children.length - 1] instanceof boxes.LineBox) {
        for (const child of block.children) drawInlineLevel(stream, page, child);
      }
    }
    drawBlockLevel(page, stream, inner);
  }
}