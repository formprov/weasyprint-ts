// SPDX-License-Identifier: BSD-3-Clause

/** Layout for images and other replaced elements (mirrors layout/replaced.py). */
import { blockLevelWidth } from './block.ts';
import { avoidCollisions } from './float.ts';
import { handleMinMaxHeight, handleMinMaxWidth } from './min_max.ts';
import { percentage } from './percent.ts';

type AnyBox = any;
type Size = [number, number];

/** Default sizing algorithm for the concrete object size (https://drafts.csswg.org/css-images-3/#default-sizing). */
export function defaultImageSizing(
  intrinsicWidth: number | null, intrinsicHeight: number | null, intrinsicRatio: number | null,
  specifiedWidthIn: any, specifiedHeightIn: any, defaultWidth: number, defaultHeight: number,
): Size {
  const specifiedWidth = specifiedWidthIn === 'auto' ? null : specifiedWidthIn;
  const specifiedHeight = specifiedHeightIn === 'auto' ? null : specifiedHeightIn;

  if (specifiedWidth !== null && specifiedHeight !== null) return [specifiedWidth, specifiedHeight];
  if (specifiedWidth !== null) {
    return [specifiedWidth, intrinsicRatio !== null ? specifiedWidth / intrinsicRatio : intrinsicHeight !== null ? intrinsicHeight : defaultHeight];
  }
  if (specifiedHeight !== null) {
    return [intrinsicRatio !== null ? specifiedHeight * intrinsicRatio : intrinsicWidth !== null ? intrinsicWidth : defaultWidth, specifiedHeight];
  }
  if (intrinsicWidth !== null || intrinsicHeight !== null) {
    return defaultImageSizing(intrinsicWidth, intrinsicHeight, intrinsicRatio, intrinsicWidth, intrinsicHeight, defaultWidth, defaultHeight);
  }
  return containConstraintImageSizing(defaultWidth, defaultHeight, intrinsicRatio);
}

export function containConstraintImageSizing(w: number, h: number, ratio: number | null): Size {
  return constraintImageSizing(w, h, ratio, false);
}
export function coverConstraintImageSizing(w: number, h: number, ratio: number | null): Size {
  return constraintImageSizing(w, h, ratio, true);
}
function constraintImageSizing(w: number, h: number, ratio: number | null, cover: boolean): Size {
  if (ratio === null) return [w, h];
  if (cover !== (w > h * ratio)) return [h * ratio, h];
  return [w, w / ratio];
}

export function replacedboxLayout(box: AnyBox): [number, number, number, number] {
  // TODO: respect box-sizing ?
  const objectFit = box.style.get('object_fit');
  const position = box.style.get('object_position');

  const image = box.replacement;
  let [intrinsicWidth, intrinsicHeight, intrinsicRatio] = image.getIntrinsicSize(box.style.get('image_resolution'), box.style.get('font_size'));
  if (intrinsicWidth === null || intrinsicHeight === null) {
    [intrinsicWidth, intrinsicHeight] = containConstraintImageSizing(box.width, box.height, intrinsicRatio);
  }

  let drawWidth: number;
  let drawHeight: number;
  if (objectFit === 'fill') [drawWidth, drawHeight] = [box.width, box.height];
  else {
    if (objectFit === 'contain' || objectFit === 'scale-down') [drawWidth, drawHeight] = containConstraintImageSizing(box.width, box.height, intrinsicRatio);
    else if (objectFit === 'cover') [drawWidth, drawHeight] = coverConstraintImageSizing(box.width, box.height, intrinsicRatio);
    else [drawWidth, drawHeight] = [intrinsicWidth, intrinsicHeight];
    if (objectFit === 'scale-down') {
      drawWidth = Math.min(drawWidth, intrinsicWidth);
      drawHeight = Math.min(drawHeight, intrinsicHeight);
    }
  }

  const [originX, , originY] = position[0];
  let [, positionX, , positionY] = position[0];
  const refX = box.width - drawWidth;
  const refY = box.height - drawHeight;

  positionX = percentage(positionX, box.style, refX);
  positionY = percentage(positionY, box.style, refY);
  if (originX === 'right') positionX = refX - positionX;
  if (originY === 'bottom') positionY = refY - positionY;

  positionX += box.contentBoxX();
  positionY += box.contentBoxY();
  return [drawWidth, drawHeight, positionX, positionY];
}

/** Set the used width for replaced boxes. */
export const replacedBoxWidth = handleMinMaxWidth((box: AnyBox, containingBlock: AnyBox) => {
  const [width, height, ratio] = box.replacement.getIntrinsicSize(box.style.get('image_resolution'), box.style.get('font_size'));

  // This algorithm simply follows the different points of the specification:
  // https://www.w3.org/TR/CSS21/visudet.html#inline-replaced-width
  if (box.height === 'auto' && box.width === 'auto') {
    if (width !== null) {
      // Point #1
      box.width = width;
    } else if (ratio !== null) {
      if (height !== null) {
        // Point #2 first part
        box.width = height * ratio;
      } else {
        // Point #3
        blockLevelWidth(box, containingBlock);
      }
    }
  }

  if (box.width === 'auto') {
    if (ratio !== null) {
      // Point #2 second part
      box.width = box.height * ratio;
    } else if (width !== null) {
      // Point #4
      box.width = width;
    } else {
      // Point #5: it's pretty useless to rely on device size to set width.
      box.width = 300;
    }
  }
});

/** Compute and set the used height for replaced boxes. */
export const replacedBoxHeight = handleMinMaxHeight((box: AnyBox) => {
  // https://www.w3.org/TR/CSS21/visudet.html#inline-replaced-height
  const [, height, ratio] = box.replacement.getIntrinsicSize(box.style.get('image_resolution'), box.style.get('font_size'));

  // Test 'auto' on the computed width, not the used width.
  if (box.height === 'auto' && box.width === 'auto') box.height = height;
  else if (box.height === 'auto' && ratio) box.height = box.width / ratio;

  if (box.height === 'auto' && box.width === 'auto' && height !== null) box.height = height;
  else if (ratio !== null && box.height === 'auto') box.height = box.width / ratio;
  else if (box.height === 'auto' && height !== null) box.height = height;
  else if (box.height === 'auto') {
    // It's pretty useless to rely on device size to set width.
    box.height = 150;
  }
});

/** Lay out an inline ReplacedBox ``box``. */
export function inlineReplacedBoxLayout(box: AnyBox, containingBlock: AnyBox): void {
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    if (box[`margin${side}`] === 'auto') box[`margin${side}`] = 0;
  }
  inlineReplacedBoxWidthHeight(box, containingBlock);
}

export function inlineReplacedBoxWidthHeight(box: AnyBox, containingBlock: AnyBox): void {
  if (box.style.get('width') === 'auto' && box.style.get('height') === 'auto') {
    replacedBoxWidth.withoutMinMax(box, containingBlock);
    replacedBoxHeight.withoutMinMax(box);
    minMaxAutoReplaced(box);
  } else {
    replacedBoxWidth(box, containingBlock);
    replacedBoxHeight(box);
  }
}

/** Resolve min/max constraints on replaced elements with 'auto' sizes. */
export function minMaxAutoReplaced(box: AnyBox): void {
  let width = box.width;
  let height = box.height;
  const minWidth = box.minWidth;
  const minHeight = box.minHeight;
  const maxWidth = Math.max(minWidth, box.maxWidth);
  const maxHeight = Math.max(minHeight, box.maxHeight);

  const vw = width < minWidth ? 'min' : width > maxWidth ? 'max' : '';
  const vh = height < minHeight ? 'min' : height > maxHeight ? 'max' : '';

  // Work around divisions by zero. These are pathological cases anyway.
  if (width === 0) width = 1e-6;
  if (height === 0) height = 1e-6;

  const key = `${vw}|${vh}`;
  if (key === 'max|') {
    box.width = maxWidth;
    box.height = Math.max((maxWidth * height) / width, minHeight);
  } else if (key === 'min|') {
    box.width = minWidth;
    box.height = Math.min((minWidth * height) / width, maxHeight);
  } else if (key === '|max') {
    box.width = Math.max((maxHeight * width) / height, minWidth);
    box.height = maxHeight;
  } else if (key === '|min') {
    box.width = Math.min((minHeight * width) / height, maxWidth);
    box.height = minHeight;
  } else if (key === 'max|max') {
    if (maxWidth / width <= maxHeight / height) {
      box.width = maxWidth;
      box.height = Math.max(minHeight, (maxWidth * height) / width);
    } else {
      box.width = Math.max(minWidth, (maxHeight * width) / height);
      box.height = maxHeight;
    }
  } else if (key === 'min|min') {
    if (minWidth / width <= minHeight / height) {
      box.width = Math.min(maxWidth, (minHeight * width) / height);
      box.height = minHeight;
    } else {
      box.width = minWidth;
      box.height = Math.min(maxHeight, (minWidth * height) / width);
    }
  } else if (key === 'min|max') {
    box.width = minWidth;
    box.height = maxHeight;
  } else if (key === 'max|min') {
    box.width = maxWidth;
    box.height = minHeight;
  }
}

/** Lay out the block ReplacedBox ``box``. */
export function blockReplacedBoxLayout(context: any, boxIn: AnyBox, containingBlock: AnyBox): any[] {
  const box = boxIn.copy();
  if (box.style.get('width') === 'auto' && box.style.get('height') === 'auto') {
    const computedMargins = [box.marginLeft, box.marginRight];
    blockReplacedWidth.withoutMinMax(box, containingBlock);
    replacedBoxHeight.withoutMinMax(box);
    minMaxAutoReplaced(box);
    [box.marginLeft, box.marginRight] = computedMargins;
    blockLevelWidth.withoutMinMax(box, containingBlock);
  } else {
    blockReplacedWidth(box, containingBlock);
    replacedBoxHeight(box);
  }

  // TODO: flex items shouldn't be block boxes, this condition would then be useless.
  if (!box.isFlexItem) {
    // Don't collide with floats (https://www.w3.org/TR/CSS21/visuren.html#floats).
    [box.positionX, box.positionY] = avoidCollisions(context, box, containingBlock, false);
  }
  return [box, null, { break: 'any', page: null }, [], false];
}

export const blockReplacedWidth = handleMinMaxWidth((box: AnyBox, containingBlock: AnyBox) => {
  // https://www.w3.org/TR/CSS21/visudet.html#block-replaced-width
  replacedBoxWidth.withoutMinMax(box, containingBlock);
  blockLevelWidth.withoutMinMax(box, containingBlock);
});