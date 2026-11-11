// SPDX-License-Identifier: BSD-3-Clause

/**
 * Specific handling for some HTML elements, especially replaced elements
 * (mirrors weasyprint/html.py). Replaced elements are rendered externally and
 * behave as an atomic opaque box in CSS.
 */
import type { Element } from './dom.ts';
import { BlockReplacedBox, InlineReplacedBox, TableColumnBox, TableColumnGroupBox, TextBox, elementHasLinkType } from './formatting_structure/boxes.ts';
import type { Box } from './formatting_structure/boxes.ts';
import { LOGGER } from './logger.ts';
import { urlJoin } from './urls.ts';
import { parseColor } from './css/color.ts';
import { SvgImage } from './svg/image.ts';

import { WHITESPACE, parseUrl } from './css/legacy.ts';
export { WHITESPACE, parseUrl, parseInteger, parseNonNegativeInteger, parseDimensionValue, parseLegacyColor, mapToPixelLength,
  mapToDimensionProperty, mapToDimensionPropertyIgnoringZero } from './css/legacy.ts';

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export type GetImage = (o: { url: string; orientation?: any; forcedMimeType?: string }) => any | null;
type Handler = (element: Element, box: any, getImage: GetImage, baseUrl: string | null) => any[];
export const HTML_HANDLERS = new Map<string, Handler>();

export function handleElement(element: Element, box: any, getImage: GetImage, baseUrl: string | null): any[] {
  const handler = HTML_HANDLERS.get(box.elementTag);
  return handler ? handler(element, box, getImage, baseUrl) : [box];
}

/** Wrap an image in a replaced box, block-level or inline-level depending on the element. */
export function makeReplacedBox(element: Element, box: any, image: any): any {
  const Type = (box.style.get('display') as string[]).includes('block') ? BlockReplacedBox : InlineReplacedBox;
  const newBox = new Type(element.tag, box.style, element, image);
  newBox.stringSet = box.stringSet;
  newBox.bookmarkLabel = box.bookmarkLabel;
  return newBox;
}

HTML_HANDLERS.set('img', (element, box, getImage, baseUrl) => {
  const src = parseUrl(element.get('src'), baseUrl);
  if (src) {
    const image = getImage({ url: src, orientation: box.style.get('image_orientation') });
    if (image) return [makeReplacedBox(element, box, image)];
  }
  const alt = element.get('alt');
  if (alt) {
    box.children = [TextBox.anonymousFrom(box, alt)];
    return [box];
  }
  return [];
});

HTML_HANDLERS.set('a', (element, box, _getImage, baseUrl) => {
  const href = parseUrl(element.get('href'), baseUrl, true);
  if (href) box.link = getLink(href, baseUrl);
  return [box];
});

/** Mirrors urls.get_link. */
export function getLink(url: string, baseUrl: string | null): ['url', ['internal' | 'external', string]] | null {
  if (url.startsWith('#') && url.length > 1) return ['url', ['internal', decodeURIComponent(url.slice(1))]];
  const uri = urlJoin(baseUrl ?? '', url, true, url);
  if (uri) {
    if (baseUrl) {
      try {
        const parsed = new URL(uri);
        const base = new URL(baseUrl);
        if (parsed.hash && parsed.href.split('#')[0] === base.href.split('#')[0]) {
          return ['url', ['internal', decodeURIComponent(parsed.hash.slice(1))]];
        }
      } catch {
        LOGGER.warning(`Malformed URL: ${uri}`);
      }
    }
    return ['url', ['external', uri]];
  }
  return null;
}

HTML_HANDLERS.set('embed', (element, box, getImage, baseUrl) => {
  const src = parseUrl(element.get('src'), baseUrl);
  if (src) {
    const image = getImage({
      url: src, forcedMimeType: (element.get('type', '') ?? '').trim(), orientation: box.style.get('image_orientation'),
    });
    if (image) return [makeReplacedBox(element, box, image)];
  }
  return [];
});

HTML_HANDLERS.set('object', (element, box, getImage, baseUrl) => {
  const data = parseUrl(element.get('data'), baseUrl);
  if (data) {
    const image = getImage({
      url: data, forcedMimeType: (element.get('type', '') ?? '').trim(), orientation: box.style.get('image_orientation'),
    });
    if (image) return [makeReplacedBox(element, box, image)];
  }
  return [box];
});

HTML_HANDLERS.set('colgroup', (element, box) => {
  if (box instanceof TableColumnGroupBox) {
    if (!element.children.some((c) => c.tag === 'col')) {
      box.children = Array.from({ length: box.span }, () => TableColumnBox.anonymousFrom(box, []));
    }
  }
  return [box];
});

HTML_HANDLERS.set('col', (_element, box) => {
  if (box instanceof TableColumnBox && box.span > 1) {
    return Array.from({ length: box.span }, () => (box as Box).copy());
  }
  return [box];
});

// Python: html.handle_svg. Inline <svg> is an image; its fallback content is not used.
HTML_HANDLERS.set('{http://www.w3.org/2000/svg}svg', (element, box, _getImage, baseUrl) => {
  // The element's computed style carries the document's font configuration; the SVG's base URL is the
  // document's (Python: SVGImage(element, base_url, ...)).
  const image = new SvgImage('inline svg', element, box.style.fontConfig, null, baseUrl ?? null);
  return [makeReplacedBox(element, box, image)];
});

/** Text of an element and its descendants (mirrors css.get_child_text). */
export function getChildText(element: Element): string {
  let content = element.text ?? '';
  for (const child of element.children) {
    if (child.isComment) content += child.tail ?? '';
    else content += getChildText(child) + (child.tail ?? '');
  }
  return content;
}

export interface HtmlMetadata {
  title: string | null;
  description: string | null;
  generator: string | null;
  keywords: string[];
  authors: string[];
  created: string | null;
  modified: string | null;
  lang: string | null;
  custom: Record<string, string>;
  attachments: Array<{ url: string; description: string | null }>;
  /** Extra XMP fragments (CLI --xmp-metadata), spliced into the packet of PDF variants. */
  xmpMetadata?: string[];
}

/** Get metadata dictionary out of an HTML root element. */
export function getHtmlMetadata(root: Element, baseUrl: string | null): HtmlMetadata {
  const meta: HtmlMetadata = {
    title: null, description: null, generator: null, keywords: [], authors: [], created: null, modified: null,
    lang: root.get('lang', null), custom: {}, attachments: [],
  };
  for (const element of root.iterElements()) {
    if (element.tag === 'title' && meta.title === null) meta.title = getChildText(element);
    else if (element.tag === 'meta') {
      const name = asciiLower(element.get('name', '') ?? '');
      const content = element.get('content', '') ?? '';
      if (name === 'keywords') {
        for (const part of content.split(',')) {
          const keyword = part.replace(new RegExp(`^[${WHITESPACE}]+|[${WHITESPACE}]+$`, 'g'), '');
          if (!meta.keywords.includes(keyword)) meta.keywords.push(keyword);
        }
      } else if (name === 'author') meta.authors.push(content);
      else if (name === 'description') meta.description ??= content;
      else if (name === 'generator') meta.generator ??= content;
      else if (name === 'dcterms.created') meta.created ??= content;
      else if (name === 'dcterms.modified') meta.modified ??= content;
      else if (name && !(name in meta.custom)) meta.custom[name] = content;
    } else if (element.tag === 'link' && elementHasLinkType(element, 'attachment')) {
      const url = parseUrl(element.get('href'), baseUrl);
      if (url !== null) meta.attachments.push({ url, description: element.get('title', null) });
    }
  }
  return meta;
}