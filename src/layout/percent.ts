// SPDX-License-Identifier: BSD-3-Clause

/** Resolve percentages into fixed values (mirrors weasyprint/layout/percent.py). */
import { Box, PageBox } from '../formatting_structure/boxes.ts';
import type { Style } from '../css/style.ts';
import { checkMath, resolveMath } from '../css/math.ts';

/** Return the percentage of the reference value, or the value unchanged; ``referTo`` is the length for 100%. */
export function percentage(value: any, _computed: Style | null, referTo: number): any {
  if (value === null || value === undefined || value === 'auto') return value;
  const unit = value.unit;
  if (unit === undefined) {
    // Python: resolve_math(value, computed, refer_to=refer_to), then the percentage again.
    const resolved = resolveMath(value, _computed, null, referTo);
    return percentage(resolved, _computed, referTo);
  }
  if (unit === '%') return (referTo * value.value) / 100;
  return value.value; // px (or unitless 0)
}

/** Set a used length value from a computed length value (box attributes are used values). */
export function resolveOnePercentage(box: any, propertyName: string, referTo: number): void {
  const percent = percentage(box.style.get(propertyName), box.style, referTo);
  const attr = camel(propertyName);
  box[attr] = percent;
  if (percent === 'auto' && (propertyName === 'min_width' || propertyName === 'min_height')) box[attr] = 0;
}

export const camel = (snake: string): string => snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

export function resolvePositionPercentages(box: any, containingBlock: [number, number]): void {
  const [cbWidth, cbHeight] = containingBlock;
  resolveOnePercentage(box, 'left', cbWidth);
  resolveOnePercentage(box, 'right', cbWidth);
  resolveOnePercentage(box, 'top', cbHeight);
  resolveOnePercentage(box, 'bottom', cbHeight);
}

/** Set used values as attributes of the box object. */
export function resolvePercentages(box: any, containingBlock: Box | [any, any]): void {
  let cbWidth: any;
  let cbHeight: any;
  if (containingBlock instanceof Box) {
    cbWidth = containingBlock.width;
    cbHeight = containingBlock.height;
  } else [cbWidth, cbHeight] = containingBlock;
  const maybeHeight = box instanceof PageBox ? cbHeight : cbWidth;
  resolveOnePercentage(box, 'margin_left', cbWidth);
  resolveOnePercentage(box, 'margin_right', cbWidth);
  resolveOnePercentage(box, 'margin_top', maybeHeight);
  resolveOnePercentage(box, 'margin_bottom', maybeHeight);
  resolveOnePercentage(box, 'padding_left', cbWidth);
  resolveOnePercentage(box, 'padding_right', cbWidth);
  resolveOnePercentage(box, 'padding_top', maybeHeight);
  resolveOnePercentage(box, 'padding_bottom', maybeHeight);
  resolveOnePercentage(box, 'width', cbWidth);
  resolveOnePercentage(box, 'min_width', cbWidth);
  resolveOnePercentage(box, 'max_width', cbWidth);

  if (cbHeight === 'auto') {
    // Special handling when the height of the containing block depends on its content.
    const height = box.style.get('height');
    if (height === 'auto' || checkMath(height) || height.unit === '%') box.height = 'auto';
    else box.height = height.value;
    resolveOnePercentage(box, 'min_height', 0);
    resolveOnePercentage(box, 'max_height', Infinity);
  } else {
    resolveOnePercentage(box, 'height', cbHeight);
    resolveOnePercentage(box, 'min_height', cbHeight);
    resolveOnePercentage(box, 'max_height', cbHeight);
  }

  const collapse = box.style.get('border_collapse') === 'collapse';
  // Used value == computed value.
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const prop = `border_${side}_width`;
    // border-{side}-width would have been resolved during border conflict resolution for collapsed borders.
    if (!(collapse && collapsedResolved(box, prop))) {
      box[camel(prop)] = box.style.get(prop);
    }
  }

  // Shrink *content* widths and heights according to box-sizing.
  adjustBoxSizing(box, 'width');
  adjustBoxSizing(box, 'height');
}

/** Python uses hasattr(): our boxes always have the attribute, so track collapsed resolution explicitly. */
function collapsedResolved(box: any, prop: string): boolean {
  return box.collapsedBorderWidths?.has?.(prop) ?? false;
}

export function resolveRadiiPercentages(box: any): void {
  for (const corner of ['top_left', 'top_right', 'bottom_right', 'bottom_left']) {
    const propertyName = `border_${corner}_radius`;
    const computed = box.style.get(propertyName);
    let [rx, ry] = computed;
    // Short track for common case.
    const isZero = (d: any): boolean => d.value === 0 && d.unit === 'px';
    if (isZero(rx) || isZero(ry)) {
      box[camel(propertyName)] = [0, 0];
      continue;
    }
    let removed = false;
    for (const side of corner.split('_')) {
      if (box.removeDecorationSides.has(side)) {
        box[camel(propertyName)] = [0, 0];
        removed = true;
        break;
      }
    }
    if (!removed) {
      rx = percentage(rx, box.style, box.borderWidth());
      ry = percentage(ry, box.style, box.borderHeight());
      box[camel(propertyName)] = [rx, ry];
    }
  }
}

export function adjustBoxSizing(box: any, axis: 'width' | 'height'): void {
  let delta: number;
  const sizing = box.style.get('box_sizing');
  if (sizing === 'border-box') {
    delta = axis === 'width'
      ? box.paddingLeft + box.paddingRight + box.borderLeftWidth + box.borderRightWidth
      : box.paddingTop + box.paddingBottom + box.borderTopWidth + box.borderBottomWidth;
  } else if (sizing === 'padding-box') {
    delta = axis === 'width' ? box.paddingLeft + box.paddingRight : box.paddingTop + box.paddingBottom;
  } else delta = 0;

  // Keep at least min_* >= 0 to prevent funny output if box.width or box.height become negative.
  if (delta > 0) {
    if (box[axis] !== 'auto') box[axis] = Math.max(0, box[axis] - delta);
    const max = axis === 'width' ? 'maxWidth' : 'maxHeight';
    const min = axis === 'width' ? 'minWidth' : 'minHeight';
    box[max] = Math.max(0, box[max] - delta);
    if (box[min] !== 'auto') box[min] = Math.max(0, box[min] - delta);
  }
}