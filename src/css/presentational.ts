// SPDX-License-Identifier: BSD-3-Clause

/**
 * Rules from "style" attributes and HTML presentational hints
 * (mirrors weasyprint/css/__init__.py: find_style_attributes).
 *
 * Rules from the "style" attribute have specificity (1, 0, 0); presentational
 * hints have specificity (0, 0, 0) and are only yielded when
 * `presentationalHints` is true.
 */
import type { Element } from '../dom.ts';
import { parseComponentValueList, parseDeclarationList, stripWhitespace } from './parser.ts';
import type { AtRule, Declaration } from './parser.ts';
import type { Specificity } from './selectors.ts';
import { getLength } from './tokens.ts';
import {
  mapToDimensionProperty, mapToDimensionPropertyIgnoringZero, mapToPixelLength, parseInteger,
  parseLegacyColor, parseNonNegativeInteger, parseUrl, pyFloat, WHITESPACE,
} from './legacy.ts';

export type StyleAttributeDeclarations = Array<Declaration | AtRule | { type: string }>;
export type StyleAttributeRule = [Specificity, Element, StyleAttributeDeclarations, string | null];

/** Python: css.string_to_css. Transform a string to a CSS-escaped string, including quotes. */
export function stringToCss(string: string): string {
  string = string
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\A')
    .replace(/\r/g, '\\D')
    .replace(/\f/g, '\\C');
  return `"${string}"`;
}

/** Python: css.url_to_css. Transform a URL to a url() string. */
export const urlToCss = (string: string): string => `url(${stringToCss(string)})`;

const FONT_SIZES: Record<number, string> = {
  1: 'x-small',
  2: 'small',
  3: 'medium',
  4: 'large',
  5: 'x-large',
  6: 'xx-large',
  7: '48px', // 1.5 * xx-large
};

const ALIGN_KEYWORDS = ['center', 'left', 'right', 'justify'];

/** Yield (specificity, element, declarations, base_url) rules, like find_style_attributes. */
export function* findStyleAttributes(
  tree: Element, presentationalHints = false, baseUrl: string | null = null,
): Generator<StyleAttributeRule> {
  for (const element of tree.iterElements()) {
    // Apply style attribute.
    const style = element.get('style');
    if (style) {
      yield [[1, 0, 0], element, parseDeclarationList(style), baseUrl];
    }

    const specificity: Specificity = [0, 0, 0];
    const parseDeclaration = (styleAttribute: string, el: Element = element): StyleAttributeRule =>
      [specificity, el, parseDeclarationList(styleAttribute), baseUrl];

    // Upstream interpolates the raw attribute value inside the quotes (no escaping), so a quote in
    // the value produces an invalid declaration rather than a different string.
    const lang = element.get('lang');
    if (lang) yield parseDeclaration(`-weasy-lang:"${lang}"`);

    const id = element.get('id');
    if (id) yield parseDeclaration(`-weasy-anchor:"${id}"`);

    if (element.tag === 'a') {
      const name = element.get('name');
      if (name) yield parseDeclaration(`-weasy-anchor:"${name}"`);
    }

    if (element.tag === '{http://www.w3.org/2000/svg}svg') {
      // Handle presentation attributes. Only do that for height and width at top
      // level now, so that intrinsic size is defined by CSS, not SVG.
      // See: https://www.w3.org/TR/SVG2/styling.html#PresentationAttributes.
      for (const attribute of ['width', 'height']) {
        const length = element.get(attribute);
        if (length) {
          const token = stripWhitespace(parseComponentValueList(length))[0];
          if (token && getLength(token, true, true)) {
            yield parseDeclaration(`${attribute}:${length}`);
          }
        }
      }
    }

    // Apply presentational hints.
    if (!presentationalHints) continue;

    const tag = element.tag;
    if (tag === 'body') {
      // TODO: we should check the container frame element.
      for (const attribute of ['marginheight', 'topmargin']) {
        const value = mapToPixelLength(element.get(attribute));
        if (value !== null) {
          yield parseDeclaration(`margin-top:${value}`);
          yield parseDeclaration(`margin-bottom:${value}`);
          break;
        }
      }
      for (const attribute of ['marginwidth', 'leftmargin']) {
        const value = mapToPixelLength(element.get(attribute));
        if (value !== null) {
          yield parseDeclaration(`margin-left:${value}`);
          yield parseDeclaration(`margin-right:${value}`);
          break;
        }
      }
      const background = parseUrl(element.get('background'), baseUrl);
      if (background) yield parseDeclaration(`background-image:${urlToCss(background)}`);
      const bgcolor = element.get('bgcolor');
      if (bgcolor) yield parseDeclaration(`background-color:${parseLegacyColor(bgcolor)}`);
      const text = element.get('text');
      if (text) yield parseDeclaration(`color:${parseLegacyColor(text)}`);
      // TODO: we should support link, vlink, alink.
    } else if (tag === 'center') {
      yield parseDeclaration('text-align:center');
    } else if (tag === 'div') {
      const align = (element.get('align', '') ?? '').toLowerCase();
      if (align === 'middle') yield parseDeclaration('text-align:center');
      else if (ALIGN_KEYWORDS.includes(align)) yield parseDeclaration(`text-align:${align}`);
    } else if (tag === 'font') {
      const color = element.get('color');
      if (color) yield parseDeclaration(`color:${parseLegacyColor(color)}`);
      const face = element.get('face');
      if (face) yield parseDeclaration(`font-family:${stringToCss(face)}`);
      const rawSize = element.get('size');
      if (rawSize) {
        let size = rawSize.replace(new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, 'g'), '');
        const relativePlus = size.startsWith('+');
        const relativeMinus = size.startsWith('-');
        if (relativePlus || relativeMinus) size = size.slice(1);
        let value = parseInteger(size);
        if (value !== null) {
          if (relativePlus) value += 3;
          else if (relativeMinus) value -= 3;
          value = Math.max(1, Math.min(7, value));
          yield parseDeclaration(`font-size:${FONT_SIZES[value]}`);
        }
      }
    } else if (tag === 'table') {
      const cellspacing = element.get('cellspacing');
      if (cellspacing) {
        const value = mapToPixelLength(cellspacing);
        if (value !== null) yield parseDeclaration(`border-spacing:${value}`);
      }
      const cellpadding = element.get('cellpadding');
      if (cellpadding) {
        const value = mapToPixelLength(cellpadding);
        if (value !== null) {
          // TODO: don't match subtables cells.
          for (const subelement of element.iterElements()) {
            if (subelement.tag === 'td' || subelement.tag === 'th') {
              yield parseDeclaration(`padding:${value}`, subelement);
            }
          }
        }
      }
      const width = element.get('width');
      if (width) {
        const value = mapToDimensionPropertyIgnoringZero(width);
        if (value !== null) yield parseDeclaration(`width:${value}`);
      }
      const height = element.get('height');
      if (height) {
        const value = mapToDimensionProperty(height);
        if (value !== null) yield parseDeclaration(`height:${value}`);
      }
      const background = parseUrl(element.get('background'), baseUrl);
      if (background) yield parseDeclaration(`background-image:${urlToCss(background)}`);
      const bgcolor = element.get('bgcolor');
      if (bgcolor) yield parseDeclaration(`background-color:${parseLegacyColor(bgcolor)}`);
      const bordercolor = element.get('bordercolor');
      if (bordercolor) yield parseDeclaration(`border-color:${parseLegacyColor(bordercolor)}`);
      const border = element.get('border');
      if (border) {
        const value = mapToPixelLength(border);
        if (value !== null) yield parseDeclaration(`border-width:${value}`);
      }
    } else if (['tr', 'td', 'th', 'thead', 'tbody', 'tfoot'].includes(tag)) {
      const align = (element.get('align', '') ?? '').toLowerCase();
      // TODO: we should align descendants too.
      if (align === 'middle') yield parseDeclaration('text-align:center');
      else if (ALIGN_KEYWORDS.includes(align)) yield parseDeclaration(`text-align:${align}`);
      const background = parseUrl(element.get('background'), baseUrl);
      if (background) yield parseDeclaration(`background-image:${urlToCss(background)}`);
      const bgcolor = element.get('bgcolor');
      if (bgcolor) yield parseDeclaration(`background-color:${parseLegacyColor(bgcolor)}`);
      if (tag === 'td' || tag === 'th') {
        const height = element.get('height');
        if (height) {
          const value = mapToDimensionPropertyIgnoringZero(height);
          if (value !== null) yield parseDeclaration(`height:${value}`);
        }
        const width = element.get('width');
        if (width) {
          const value = mapToDimensionPropertyIgnoringZero(width);
          if (value !== null) yield parseDeclaration(`width:${value}`);
        }
      } else if (tag === 'tr') {
        const height = element.get('height');
        if (height) {
          const value = mapToDimensionProperty(height);
          if (value !== null) yield parseDeclaration(`height:${value}`);
        }
      }
    } else if (tag === 'caption') {
      const align = (element.get('align', '') ?? '').toLowerCase();
      // TODO: we should align descendants too.
      if (align === 'middle') yield parseDeclaration('text-align:center');
      else if (ALIGN_KEYWORDS.includes(align)) yield parseDeclaration(`text-align:${align}`);
    } else if (tag === 'col') {
      const width = element.get('width');
      if (width) {
        const value = mapToDimensionProperty(width);
        if (value !== null) yield parseDeclaration(`width:${value}`);
      }
    } else if (tag === 'hr') {
      const size = parseNonNegativeInteger(element.get('size')) ?? 0;
      const hasColor = element.get('color') !== null || element.get('noshade') !== null;
      if (hasColor) {
        if (size >= 1) yield parseDeclaration(`border-width:${pyFloat(size / 2)}px`);
      } else if (size === 1) {
        yield parseDeclaration('border-bottom-width:0');
      } else if (size > 1) {
        yield parseDeclaration(`height:${size - 2}px`);
      }
      const width = element.get('width');
      if (width) {
        const value = mapToDimensionProperty(width);
        if (value !== null) yield parseDeclaration(`width:${value}`);
      }
      const color = element.get('color');
      if (color) yield parseDeclaration(`color:${parseLegacyColor(color)}`);
    } else if (['iframe', 'applet', 'embed', 'img', 'input', 'object'].includes(tag)) {
      if (tag !== 'input' || (element.get('type', '') ?? '').toLowerCase() === 'image') {
        const align = (element.get('align', '') ?? '').toLowerCase();
        if (align === 'middle' || align === 'center') {
          // TODO: middle and center values are wrong.
          yield parseDeclaration('vertical-align:middle');
        }
        const hspace = element.get('hspace');
        if (hspace) {
          const value = mapToDimensionProperty(hspace);
          if (value !== null) {
            yield parseDeclaration(`margin-left:${value}`);
            yield parseDeclaration(`margin-right:${value}`);
          }
        }
        const vspace = element.get('vspace');
        if (vspace) {
          const value = mapToDimensionProperty(vspace);
          if (value !== null) {
            yield parseDeclaration(`margin-top:${value}`);
            yield parseDeclaration(`margin-bottom:${value}`);
          }
        }
        // TODO: img seems to be excluded for width and height, but a
        // lot of W3C tests rely on this attribute being applied to img.
        const width = element.get('width');
        if (width) {
          const value = mapToDimensionProperty(width);
          if (value !== null) yield parseDeclaration(`width:${value}`);
        }
        const height = element.get('height');
        if (height) {
          const value = mapToDimensionProperty(height);
          if (value !== null) yield parseDeclaration(`height:${value}`);
        }
        if (['img', 'object', 'input'].includes(tag)) {
          const border = element.get('border');
          if (border) {
            const value = mapToPixelLength(border);
            if (value !== null) {
              yield parseDeclaration(`border-width:${value}`);
              yield parseDeclaration('border-style:solid');
            }
          }
        }
      }
    } else if (tag === 'ol') {
      // From https://www.w3.org/TR/css-lists-3/#ua-stylesheet.
      const start = element.get('start');
      if (start) {
        const value = parseInteger(start);
        if (value !== null) {
          yield parseDeclaration(`counter-reset:list-item ${value}`);
          yield parseDeclaration('counter-increment:list-item -1');
        }
      }
    } else if (tag === 'li') {
      // From https://www.w3.org/TR/css-lists-3/#ua-stylesheet.
      const raw = element.get('value');
      if (raw) {
        const value = parseInteger(raw);
        if (value !== null) {
          yield parseDeclaration(`counter-reset:list-item ${value}`);
          yield parseDeclaration('counter-increment:none');
        }
      }
    }
  }
}
