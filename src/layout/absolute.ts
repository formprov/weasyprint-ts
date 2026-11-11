// SPDX-License-Identifier: BSD-3-Clause

/** Absolutely positioned boxes management (mirrors layout/absolute.py). */
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

const OWN = new Set(['_box', '_layoutDone', 'setLaidOutBox', 'translate', 'copy', 'constructor', 'toString']);

/** Left where an absolutely-positioned box was taken out of the flow; behaves like the box itself. */
export class AbsolutePlaceholder {
  _box: AnyBox;
  _layoutDone = false;
  [key: string]: any;

  constructor(box: AnyBox) {
    if (box instanceof AbsolutePlaceholder) throw new Error('nested placeholder');
    this._box = box;
    // Pretend to be the box itself (Python: __getattr__ / __setattr__).
    return new Proxy(this, {
      get(target, name, receiver) {
        if (typeof name === 'string' && OWN.has(name)) return Reflect.get(target, name, receiver === undefined ? target : target);
        const value = (target._box as any)[name];
        return typeof value === 'function' ? value.bind(target._box) : value;
      },
      set(target, name, value) {
        if (name === '_box' || name === '_layoutDone') {
          (target as any)[name] = value;
          return true;
        }
        (target._box as any)[name] = value;
        return true;
      },
    });
  }

  setLaidOutBox(newBox: AnyBox): void {
    this._box = newBox;
    this._layoutDone = true;
  }

  translate(dx = 0, dy = 0, ignoreFloats = false): void {
    if (dx === 0 && dy === 0) return;
    if (this._layoutDone) this._box.translate(dx, dy, ignoreFloats);
    else {
      // Descendants do not have a position yet.
      this._box.positionX += dx;
      this._box.positionY += dy;
    }
  }

  copy(): AbsolutePlaceholder {
    const newPlaceholder = new AbsolutePlaceholder(this._box.copy());
    newPlaceholder._layoutDone = this._layoutDone;
    return newPlaceholder;
  }

  toString(): string {
    return `<Placeholder ${this._box}>`;
  }
}

const isLtr = (box: AnyBox): boolean => box.style.parentStyle === null || box.style.parentStyle.get('direction') === 'ltr';

export const absoluteWidth = handleMinMaxWidth((box: AnyBox, context: any, cbX: number, _cbY: number, cbWidth: number, _cbHeight: number): [boolean, number] => {
  // https://www.w3.org/TR/CSS2/visudet.html#abs-replaced-width
  const ltr = isLtr(box);
  const paddingsBorders = box.paddingLeft + box.paddingRight + box.borderLeftWidth + box.borderRightWidth;
  let translateX = 0;
  let translateBoxWidth = false;
  const defaultTranslateX = cbX - box.positionX;

  if (box.left === 'auto' && box.right === 'auto' && box.width === 'auto') {
    if (box.marginLeft === 'auto') box.marginLeft = 0;
    if (box.marginRight === 'auto') box.marginRight = 0;
    const availableWidth = cbWidth - (paddingsBorders + box.marginLeft + box.marginRight);
    box.width = shrinkToFit(context, box, availableWidth);
    if (box.isOutsideMarker) translateBoxWidth = ltr;
    else if (!ltr) {
      translateBoxWidth = true;
      translateX = defaultTranslateX + availableWidth;
    }
  } else if (box.left !== 'auto' && box.right !== 'auto' && box.width !== 'auto') {
    const widthForMargins = cbWidth - (box.right + box.left + box.width + paddingsBorders);
    if (box.marginLeft === 'auto' && box.marginRight === 'auto') {
      if (box.width + paddingsBorders + box.right + box.left <= cbWidth) {
        box.marginLeft = box.marginRight = widthForMargins / 2;
      } else {
        box.marginLeft = ltr ? 0 : widthForMargins;
        box.marginRight = ltr ? widthForMargins : 0;
      }
    } else if (box.marginLeft === 'auto') box.marginLeft = widthForMargins;
    else if (box.marginRight === 'auto') box.marginRight = widthForMargins;
    else if (ltr) box.marginRight = widthForMargins;
    else box.marginLeft = widthForMargins;
    translateX = box.left + defaultTranslateX;
  } else {
    if (box.marginLeft === 'auto') box.marginLeft = 0;
    if (box.marginRight === 'auto') box.marginRight = 0;
    const spacing = paddingsBorders + box.marginLeft + box.marginRight;
    if (box.left === 'auto' && box.width === 'auto') {
      box.width = shrinkToFit(context, box, cbWidth - spacing - box.right);
      translateX = cbWidth - box.right - spacing + defaultTranslateX;
      translateBoxWidth = true;
    } else if (box.left === 'auto' && box.right === 'auto') {
      if (!ltr) {
        const availableWidth = cbWidth - (paddingsBorders + box.marginLeft + box.marginRight);
        translateBoxWidth = true;
        translateX = defaultTranslateX + availableWidth;
      }
    } else if (box.width === 'auto' && box.right === 'auto') {
      box.width = shrinkToFit(context, box, cbWidth - spacing - box.left);
      translateX = box.left + defaultTranslateX;
    } else if (box.left === 'auto') {
      translateX = cbWidth + defaultTranslateX - (box.right + spacing + box.width);
    } else if (box.width === 'auto') {
      box.width = cbWidth - box.right - box.left - spacing;
      translateX = box.left + defaultTranslateX;
    } else if (box.right === 'auto') {
      translateX = box.left + defaultTranslateX;
    }
  }
  return [translateBoxWidth, translateX];
});

export function absoluteHeight(box: AnyBox, _context: any, _cbX: number, cbY: number, _cbWidth: number, cbHeight: number): [boolean, number] {
  // https://www.w3.org/TR/CSS2/visudet.html#abs-non-replaced-height
  const paddingsBorders = box.paddingTop + box.paddingBottom + box.borderTopWidth + box.borderBottomWidth;
  let translateY = 0;
  let translateBoxHeight = false;
  const defaultTranslateY = cbY - box.positionY;

  if (box.top === 'auto' && box.bottom === 'auto' && box.height === 'auto') {
    // Keep the static position.
    if (box.marginTop === 'auto') box.marginTop = 0;
    if (box.marginBottom === 'auto') box.marginBottom = 0;
  } else if (![box.top, box.bottom, box.height].includes('auto')) {
    const heightForMargins = cbHeight - (box.top + box.bottom + box.height + paddingsBorders);
    if (box.marginTop === 'auto' && box.marginBottom === 'auto') box.marginTop = box.marginBottom = heightForMargins / 2;
    else if (box.marginTop === 'auto') box.marginTop = heightForMargins;
    else if (box.marginBottom === 'auto') box.marginBottom = heightForMargins;
    else box.marginBottom = heightForMargins;
    translateY = box.top + defaultTranslateY;
  } else {
    if (box.marginTop === 'auto') box.marginTop = 0;
    if (box.marginBottom === 'auto') box.marginBottom = 0;
    const spacing = paddingsBorders + box.marginTop + box.marginBottom;
    if (box.top === 'auto' && box.height === 'auto') {
      translateY = cbHeight - box.bottom - spacing + defaultTranslateY;
      translateBoxHeight = true;
    } else if (box.top === 'auto' && box.bottom === 'auto') {
      // Keep the static position.
    } else if (box.height === 'auto' && box.bottom === 'auto') {
      translateY = box.top + defaultTranslateY;
    } else if (box.top === 'auto') {
      translateY = cbHeight + defaultTranslateY - (box.bottom + spacing + box.height);
    } else if (box.height === 'auto') {
      box.height = cbHeight - box.bottom - box.top - spacing;
      translateY = box.top + defaultTranslateY;
    } else if (box.bottom === 'auto') {
      translateY = box.top + defaultTranslateY;
    }
  }
  return [translateBoxHeight, translateY];
}

export function absoluteBlock(
  context: any, box: AnyBox, containingBlock: AnyBox, fixedBoxes: AnyBox[], bottomSpaceIn: number, skipStack: any,
  cbX: number, cbY: number, cbWidth: number, cbHeight: number,
): [AnyBox, any] {
  let bottomSpace = bottomSpaceIn;
  let [translateBoxWidth, translateX] = absoluteWidth(box, context, cbX, cbY, cbWidth, cbHeight);
  let translateBoxHeight: boolean;
  let translateY: number;
  if (skipStack) [translateBoxHeight, translateY] = [false, 0];
  else [translateBoxHeight, translateY] = absoluteHeight(box, context, cbX, cbY, cbWidth, cbHeight);

  bottomSpace += translateBoxHeight ? -box.positionY : translateY;

  // This box is the containing block for absolute descendants.
  const absoluteBoxes: AnyBox[] = [];

  if (box.isTableWrapper) tableWrapperWidth(context, box, [cbWidth, cbHeight]);

  let newBox: AnyBox;
  let resumeAt: any;
  if (box instanceof boxes.BlockBox) {
    [newBox, resumeAt] = blockContainerLayout(
      context, box, bottomSpace, skipStack, true, absoluteBoxes, fixedBoxes, null, null, null, false, null);
  } else if (box instanceof boxes.FlexContainerBox) {
    [newBox, resumeAt] = flexLayout(context, box, bottomSpace, skipStack, containingBlock, true, absoluteBoxes, fixedBoxes, false);
  } else if (box instanceof boxes.GridContainerBox) {
    [newBox, resumeAt] = gridLayout(context, box, bottomSpace, skipStack, containingBlock, true, absoluteBoxes, fixedBoxes);
  } else throw new Error(`unexpected absolute box ${box.constructor.name}`);

  for (const childPlaceholder of absoluteBoxes) {
    absoluteLayout(context, childPlaceholder, newBox, fixedBoxes, bottomSpace, null);
  }

  if (translateBoxWidth) translateX -= newBox.width;
  if (translateBoxHeight) translateY -= newBox.height;
  newBox.translate(translateX, translateY);
  return [newBox, resumeAt];
}

/** Set the width of absolute positioned ``box``. */
export function absoluteLayout(
  context: any, placeholder: AnyBox, containingBlock: AnyBox, fixedBoxes: AnyBox[], bottomSpace: number, skipStack: any,
): void {
  if (placeholder._layoutDone) throw new Error('placeholder already laid out');
  const box = placeholder._box;
  const [newBox, resumeAt] = absoluteBoxLayout(context, box, containingBlock, fixedBoxes, bottomSpace, skipStack);
  placeholder.setLaidOutBox(newBox);
  if (resumeAt) context.addBrokenOutOfFlow(placeholder, box, containingBlock, resumeAt);
}

export function absoluteBoxLayout(
  context: any, box: AnyBox, containingBlock: AnyBox, fixedBoxes: AnyBox[], bottomSpace: number, skipStack: any,
): [AnyBox, any] {
  // TODO: handle inline boxes (point 10.1.4.1)
  // https://www.w3.org/TR/CSS2/visudet.html#containing-block-details
  let cbX: number;
  let cbY: number;
  let cbWidth: number;
  let cbHeight: number;
  if (containingBlock instanceof boxes.PageBox) {
    cbX = containingBlock.contentBoxX();
    cbY = containingBlock.contentBoxY();
    cbWidth = containingBlock.width;
    cbHeight = containingBlock.height;
  } else {
    cbX = containingBlock.paddingBoxX();
    cbY = containingBlock.paddingBoxY();
    cbWidth = containingBlock.paddingWidth();
    cbHeight = containingBlock.paddingHeight();
  }

  resolvePercentages(box, [cbWidth, cbHeight]);
  resolvePositionPercentages(box, [cbWidth, cbHeight]);

  if (box instanceof boxes.BlockReplacedBox) {
    return [absoluteReplaced(context, box, cbX, cbY, cbWidth, cbHeight), null];
  }
  // Absolute tables are wrapped into block boxes.
  return absoluteBlock(context, box, containingBlock, fixedBoxes, bottomSpace, skipStack, cbX, cbY, cbWidth, cbHeight);
}

export function absoluteReplaced(context: any, box: AnyBox, cbX: number, cbY: number, cbWidth: number, cbHeight: number): AnyBox {
  void context;
  inlineReplacedBoxWidthHeight(box, [cbX, cbY, cbWidth, cbHeight]);
  const ltr = isLtr(box);

  // https://www.w3.org/TR/CSS21/visudet.html#abs-replaced-width
  if (box.left === 'auto' && box.right === 'auto') {
    // static position:
    if (ltr) box.left = box.positionX - cbX;
    else box.right = cbX + cbWidth - box.positionX;
  }
  if (box.left === 'auto' || box.right === 'auto') {
    if (box.marginLeft === 'auto') box.marginLeft = 0;
    if (box.marginRight === 'auto') box.marginRight = 0;
    const remaining = cbWidth - box.marginWidth();
    if (box.left === 'auto') box.left = remaining - box.right;
    if (box.right === 'auto') box.right = remaining - box.left;
  } else if (box.marginLeft === 'auto' || box.marginRight === 'auto') {
    const remaining = cbWidth - (box.borderWidth() + box.left + box.right);
    if (box.marginLeft === 'auto' && box.marginRight === 'auto') {
      if (remaining >= 0) box.marginLeft = box.marginRight = Math.floor(remaining / 2);
      else {
        box.marginLeft = ltr ? 0 : remaining;
        box.marginRight = ltr ? remaining : 0;
      }
    } else if (box.marginLeft === 'auto') box.marginLeft = remaining;
    else box.marginRight = remaining;
  } else if (ltr) {
    // Over-constrained.
    box.right = cbWidth - (box.marginWidth() + box.left);
  } else box.left = cbWidth - (box.marginWidth() + box.right);

  // https://www.w3.org/TR/CSS21/visudet.html#abs-replaced-height
  if (box.top === 'auto' && box.bottom === 'auto') box.top = box.positionY - cbY;
  if (box.top === 'auto' || box.bottom === 'auto') {
    if (box.marginTop === 'auto') box.marginTop = 0;
    if (box.marginBottom === 'auto') box.marginBottom = 0;
    const remaining = cbHeight - box.marginHeight();
    if (box.top === 'auto') box.top = remaining - box.bottom;
    if (box.bottom === 'auto') box.bottom = remaining - box.top;
  } else if (box.marginTop === 'auto' || box.marginBottom === 'auto') {
    const remaining = cbHeight - (box.borderHeight() + box.top + box.bottom);
    if (box.marginTop === 'auto' && box.marginBottom === 'auto') box.marginTop = box.marginBottom = Math.floor(remaining / 2);
    else if (box.marginTop === 'auto') box.marginTop = remaining;
    else box.marginBottom = remaining;
  } else {
    // Over-constrained.
    box.bottom = cbHeight - (box.marginHeight() + box.top);
  }

  // No children for replaced boxes, no need to .translate().
  box.positionX = cbX + box.left;
  box.positionY = cbY + box.top;
  return box;
}