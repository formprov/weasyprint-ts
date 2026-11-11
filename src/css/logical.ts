// SPDX-License-Identifier: BSD-3-Clause

/**
 * Physical -> logical property mapping (weasyprint/css/computed_values.py
 * PHYSICAL_FUNCTIONS). A physical longhand that the cascade does not set falls
 * back to the matching logical longhand, chosen from the element's direction
 * and writing mode: `border-left-style` is `border-inline-start-style` in
 * ltr, `border-inline-end-style` in rtl, and so on.
 */

type LogicalFunction = (block: string, inline: string) => string;

export const PHYSICAL_FUNCTIONS: Record<string, LogicalFunction> = {};

function registerLogical(
  names: string[], prefixes: string[], suffixes: string[],
  fn: (block: string, inline: string, name: string, prefix: string, suffix: string) => string,
): void {
  for (const name of names) {
    for (const prefix of prefixes) {
      for (const suffix of suffixes) {
        let property = name;
        if (prefix) property = `${prefix}_${property}`;
        if (suffix) property = `${property}_${suffix}`;
        PHYSICAL_FUNCTIONS[property] = (block, inline) => fn(block, inline, name, prefix, suffix);
      }
    }
  }
}

// width/height (and min-/max-) map to the inline/block size depending on the
// writing mode.
registerLogical(['width', 'height'], ['', 'max', 'min'], [''], (block, _inline, name, prefix) => {
  const verticalMainDirection = block === 'ttb' || block === 'btt';
  const verticalProperty = name.includes('height');
  const logical = verticalProperty === verticalMainDirection ? 'block' : 'inline';
  return prefix ? `${prefix}_${logical}_size` : `${logical}_size`;
});

function physicalInset(block: string, inline: string, name: string, prefix: string, suffix: string): string {
  let logical: string;
  let side: string;
  if (name === 'top') {
    logical = block === 'ttb' || block === 'btt' ? 'block' : 'inline';
    side = block === 'ttb' || inline === 'ttb' ? 'start' : 'end';
  } else if (name === 'bottom') {
    logical = block === 'ttb' || block === 'btt' ? 'block' : 'inline';
    side = block === 'btt' || inline === 'btt' ? 'start' : 'end';
  } else if (name === 'left') {
    logical = block === 'ltr' || block === 'rtl' ? 'block' : 'inline';
    side = block === 'ltr' || inline === 'ltr' ? 'start' : 'end';
  } else {
    logical = block === 'ltr' || block === 'rtl' ? 'block' : 'inline';
    side = block === 'rtl' || inline === 'rtl' ? 'start' : 'end';
  }
  const head = `${prefix || 'inset'}_`;
  const tail = suffix ? `_${suffix}` : '';
  return `${head}${logical}_${side}${tail}`;
}

registerLogical(['top', 'left', 'bottom', 'right'], ['', 'padding', 'margin'], [''], physicalInset);
registerLogical(['top', 'left', 'bottom', 'right'], ['border'], ['width', 'style', 'color'], physicalInset);
