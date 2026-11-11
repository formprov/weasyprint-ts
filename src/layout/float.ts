// SPDX-License-Identifier: BSD-3-Clause

/** Layout for floating boxes (mirrors layout/float.py). */
import * as boxes from '../formatting_structure/boxes.ts';
import { blockContainerLayout } from './block.ts';
import { flexLayout } from './flex.ts';
import { gridLayout } from './grid.ts';
import { handleMinMaxWidth } from './min_max.ts';
import { resolvePercentages, resolvePositionPercentages } from './percent.ts';
import { shrinkToFit } from './preferred.ts';
import { inlineReplacedBoxWidthHeight } from './replaced.ts';
import { tableWrapperWidth } from './table.ts';

type AnyBox = any;
const MAXSIZE = 9223372036854775807;

export const floatWidth = handleMinMaxWidth((box: AnyBox, context: any, containingBlock: AnyBox) => {
  // Check that box.width is auto even if the caller does it too, because the
  // handle_min_max_width decorator can change the value.
  if (box.width === 'auto') box.width = shrinkToFit(context, box, containingBlock.width);
});

/** Set the width and position of floating ``box``. */
export function floatLayout(
  context: any, boxIn: AnyBox, containingBlock: AnyBox, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
  bottomSpace: number, skipStack: any,
): [AnyBox, any] {
  let box = boxIn;
  const cbWidth = containingBlock.width;
  let cbHeight = containingBlock.height;
  resolvePercentages(box, [cbWidth, cbHeight]);

  // TODO: This is only handled later in blocks.block_container_layout
  // https://www.w3.org/TR/CSS21/visudet.html#normal-block
  if (cbHeight === 'auto') cbHeight = containingBlock.positionY - containingBlock.contentBoxY();

  resolvePositionPercentages(box, [cbWidth, cbHeight]);

  if (box.marginLeft === 'auto') box.marginLeft = 0;
  if (box.marginRight === 'auto') box.marginRight = 0;
  if (box.marginTop === 'auto') box.marginTop = 0;
  if (box.marginBottom === 'auto') box.marginBottom = 0;

  const clearance = getClearance(context, box, containingBlock.style.get('direction'));
  if (clearance !== null) box.positionY += clearance;

  if (box instanceof boxes.BlockReplacedBox) inlineReplacedBoxWidthHeight(box, containingBlock);
  else if (box.width === 'auto') floatWidth(box, context, containingBlock);

  if (box.isTableWrapper) tableWrapperWidth(context, box, [cbWidth, cbHeight]);

  let resumeAt: any;
  if (box.isBlockContainer) {
    [box, resumeAt] = blockContainerLayout(
      context, box, bottomSpace, skipStack, true, absoluteBoxes, fixedBoxes, null, null, null, false, null);
  } else if (box instanceof boxes.FlexContainerBox) {
    [box, resumeAt] = flexLayout(context, box, bottomSpace, skipStack, containingBlock, true, absoluteBoxes, fixedBoxes, false);
  } else if (box instanceof boxes.GridContainerBox) {
    [box, resumeAt] = gridLayout(context, box, bottomSpace, skipStack, containingBlock, true, absoluteBoxes, fixedBoxes);
  } else {
    if (!(box instanceof boxes.BlockReplacedBox)) throw new Error('unexpected float box');
    resumeAt = null;
  }

  box = findFloatPosition(context, box, containingBlock);
  context.excludedShapes.push(box);
  return [box, resumeAt];
}

/** Get the right position of the float ``box`` (https://www.w3.org/TR/CSS2/visuren.html#float-position). */
export function findFloatPosition(context: any, box: AnyBox, containingBlock: AnyBox): AnyBox {
  // Point 4 is already handled as box.position_y is set according to the containing
  // box top position, with collapsing margins handled.

  // Points 5 and 6, box.position_y is set to the highest position_y possible.
  if (context.excludedShapes.length) {
    const highestY = context.excludedShapes[context.excludedShapes.length - 1].positionY;
    if (box.positionY < highestY) box.translate(0, highestY - box.positionY);
  }

  // Points 1 and 2
  let [positionX, positionY, availableWidth] = avoidCollisions(context, box, containingBlock);

  // Point 9: position_y is set now, let's define position_x. For float: left, it's already done.
  const float = box.style.get('float');
  const direction = box.style.get('direction');
  const floatRight = float === 'right' || (direction === 'ltr' && float === 'inline-end') || (direction === 'rtl' && float === 'inline-start');
  if (floatRight) positionX += availableWidth - box.marginWidth();

  box.translate(positionX - box.positionX, positionY - box.positionY);
  return box;
}

/** Return null if there is no clearance, otherwise the clearance value. */
export function getClearance(context: any, box: AnyBox, direction: string, collapsedMargin = 0): number | null {
  const clear = (clearValueIn: string, floatValueIn: string): boolean => {
    let clearValue = clearValueIn;
    let floatValue = floatValueIn;
    if (clearValue === 'inline-start') clearValue = direction === 'ltr' ? 'left' : 'right';
    if (clearValue === 'inline-end') clearValue = direction === 'rtl' ? 'left' : 'right';
    if (floatValue === 'inline-start') floatValue = direction === 'ltr' ? 'left' : 'right';
    if (floatValue === 'inline-end') floatValue = direction === 'rtl' ? 'left' : 'right';
    return clearValue === floatValue || clearValue === 'both';
  };

  // Box should be after shape that's broken on this page.
  for (const brokenShape of context.brokenOutOfFlow.keys()) {
    if (brokenShape.isFloated() && clear(box.style.get('clear'), brokenShape.style.get('float'))) return MAXSIZE;
  }
  // Hypothetical position is the position of the top border edge.
  let clearance: number | null = null;
  const hypotheticalPosition = box.positionY + collapsedMargin;
  for (const excludedShape of context.excludedShapes) {
    if (clear(box.style.get('clear'), excludedShape.style.get('float'))) {
      const y = excludedShape.positionY;
      const h = excludedShape.marginHeight();
      if (hypotheticalPosition < y + h) clearance = Math.max(clearance || 0, y + h - hypotheticalPosition);
    }
  }
  return clearance;
}

export function avoidCollisions(context: any, box: AnyBox, containingBlock: AnyBox, outer = true): [number, number, number] {
  const excludedShapes: AnyBox[] = context.excludedShapes;
  let positionY = outer ? box.positionY : box.borderBoxY();

  const boxWidth = outer ? box.marginWidth() : box.borderWidth();
  const boxHeight = outer ? box.marginHeight() : box.borderHeight();

  if (box.borderHeight() === 0 && box.isFloated()) return [0, positionY, containingBlock.width];

  const leftKeywords = ['left'];
  const rightKeywords = ['right'];
  if (containingBlock.style.get('direction') === 'ltr') {
    leftKeywords.push('inline-start');
    rightKeywords.push('inline-end');
  } else {
    leftKeywords.push('inline-end');
    rightKeywords.push('inline-start');
  }

  let maxLeftBound: number;
  let maxRightBound: number;
  for (;;) {
    const collidingShapes: AnyBox[] = [];
    for (const shape of excludedShapes) {
      const shapePositionY = shape.positionY;
      const shapeMarginHeight = shape.marginHeight();
      if ((shapePositionY < positionY && positionY < shapePositionY + shapeMarginHeight) ||
        (shapePositionY < positionY + boxHeight && positionY + boxHeight < shapePositionY + shapeMarginHeight) ||
        (shapePositionY >= positionY && shapePositionY + shapeMarginHeight <= positionY + boxHeight)) {
        collidingShapes.push(shape);
      }
    }
    const leftBounds = collidingShapes.filter((s) => leftKeywords.includes(s.style.get('float'))).map((s) => s.positionX + s.marginWidth());
    const rightBounds = collidingShapes.filter((s) => rightKeywords.includes(s.style.get('float'))).map((s) => s.positionX);

    // Set the default maximum bounds.
    maxLeftBound = containingBlock.contentBoxX();
    maxRightBound = maxLeftBound + containingBlock.width;

    if (!outer) {
      maxLeftBound += box.marginLeft;
      maxRightBound -= box.marginRight;
    }

    // Set the real maximum bounds according to sibling float elements.
    if (leftBounds.length || rightBounds.length) {
      if (leftBounds.length) maxLeftBound = Math.max(Math.max(...leftBounds), maxLeftBound);
      if (rightBounds.length) maxRightBound = Math.min(Math.min(...rightBounds), maxRightBound);

      // Points 3, 7 and 8
      if (boxWidth > maxRightBound - maxLeftBound) {
        // The box does not fit here.
        const newPositionY = Math.min(...collidingShapes.map((s) => s.positionY + s.marginHeight()));
        if (newPositionY > positionY) {
          // We can find a solution with a higher position_y.
          positionY = newPositionY;
          continue;
        }
        // No solution, we must put the box here.
      }
    }
    break;
  }

  // See https://www.w3.org/TR/CSS21/visuren.html#floats. Boxes that can't collide with floats
  // are: floats, line boxes, table wrappers, block-level replaced box, formatting contexts.
  let positionX = maxLeftBound;
  if (box.style.get('float') === 'none') {
    if (containingBlock.style.get('direction') === 'rtl') {
      if (box instanceof boxes.LineBox) {
        // The position of the line is the position of the cursor, at the right bound.
        positionX = maxRightBound;
      } else if (box.isTableWrapper) {
        // The position of the right border of the table is at the right bound.
        positionX = maxRightBound - boxWidth;
      } else {
        // The position of the right border of the replaced box or formatting context is at the right bound.
        positionX = maxRightBound - boxWidth;
      }
    }
  }

  const availableWidth = maxRightBound - maxLeftBound;

  if (!outer) {
    positionX -= box.marginLeft;
    positionY -= box.marginTop;
  }
  return [positionX, positionY, availableWidth];
}