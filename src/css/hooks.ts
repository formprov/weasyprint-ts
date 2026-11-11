// SPDX-License-Identifier: BSD-3-Clause

/**
 * Late-bound hooks into the text engine, so that the CSS layer (which needs
 * font metrics for ex/ch/lh units and vertical-align percentages) does not
 * import text code directly.
 */
export interface TextHooks {
  /** Height and baseline of one line of text with this style (Python: strut()). */
  strut(style: any): [number, number];
  /** Ratio of a font-relative unit (ex, ch, ...) to the font size. */
  characterRatio(style: any, unit: string): number;
}

export const hooks: TextHooks = {
  strut() {
    throw new Error('text engine not initialised: strut');
  },
  characterRatio() {
    throw new Error('text engine not initialised: characterRatio');
  },
};