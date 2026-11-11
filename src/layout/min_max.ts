// SPDX-License-Identifier: BSD-3-Clause

/** Decorators handling min- and max- widths and heights (mirrors layout/min_max.py). */

export type LayoutFn<R> = (box: any, ...args: any[]) => R;
export type WithMinMax<R> = LayoutFn<R> & { withoutMinMax: LayoutFn<R> };

export function handleMinMaxWidth<R>(fn: LayoutFn<R>): WithMinMax<R> {
  const wrapper = ((box: any, ...args: any[]): R => {
    let result = fn(box, ...args);
    if (box.width > box.maxWidth) {
      box.width = box.maxWidth;
      result = fn(box, ...args);
    }
    if (box.width < box.minWidth) {
      box.width = box.minWidth;
      result = fn(box, ...args);
    }
    return result;
  }) as WithMinMax<R>;
  wrapper.withoutMinMax = fn;
  return wrapper;
}

export function handleMinMaxHeight<R>(fn: LayoutFn<R>): WithMinMax<R> {
  const wrapper = ((box: any, ...args: any[]): R => {
    let result = fn(box, ...args);
    if (box.height > box.maxHeight) {
      box.height = box.maxHeight;
      result = fn(box, ...args);
    }
    if (box.height < box.minHeight) {
      box.height = box.minHeight;
      result = fn(box, ...args);
    }
    return result;
  }) as WithMinMax<R>;
  wrapper.withoutMinMax = fn;
  return wrapper;
}