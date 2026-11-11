// SPDX-License-Identifier: BSD-3-Clause

/** SVG images (mirrors weasyprint/images.py SVGImage). */
import { parseHtml } from '../dom.ts';
import { LOGGER } from '../logger.ts';
import type { Element } from '../dom.ts';
import type { PdfStream } from '../pdf/stream.ts';
import { SVG } from './index.ts';

export class SvgImage {
  id: string;
  svg: SVG;

  /** `source` is an image file's bytes, or an inline `<svg>` element. */
  /** `url` is the base URL of the SVG (Python: SVGImage(tree, base_url, ...)); `id` only names it in logs. */
  constructor(id: string, source: Uint8Array | Element, fontConfig: unknown = null, urlFetcher: unknown = null,
    url: string | null = null) {
    this.id = id;
    let root: Element;
    if (source instanceof Uint8Array) {
      // Python: ElementTree.fromstring(bytestring), which raises for anything that is not XML. Bytes
      // without an <svg> root must fail here too: get_image_from_uri uses this call as its last-chance
      // fallback, so silently accepting a PNG/AVIF/JPEG2000 payload would drop the image and suppress
      // the raster decoder's error instead of reporting it.
      const text = new TextDecoder('utf-8').decode(source);
      const doc = parseHtml(text.includes('<html') ? text : `<html><body>${text}</body></html>`);
      const svgRoot = findSvgRoot(doc);
      if (!svgRoot) throw new Error('Invalid SVG image: no <svg> root element');
      root = svgRoot;
    } else {
      root = source;
    }
    this.svg = new SVG(root, url ?? '', fontConfig, urlFetcher);
  }

  /** Python: get_intrinsic_size(image_resolution, font_size). */
  getIntrinsicSize(_resolution: number, fontSize: number): [number | null, number | null, number | null] {
    let [width, height] = this.svg.getIntrinsicSize(fontSize);
    let ratio: number | null;
    if (width === null || height === null) {
      const viewbox = this.svg.getViewbox();
      if (viewbox && viewbox[2] && viewbox[3]) {
        ratio = viewbox[2] / viewbox[3];
        if (width) height = width / ratio;
        else if (height) width = height * ratio;
      } else {
        ratio = null;
      }
    } else if (width && height) {
      ratio = width / height;
    } else {
      ratio = 1;
    }
    return [width, height, ratio];
  }

  draw(stream: PdfStream, concreteWidth: number, concreteHeight: number, _style: unknown): void {
    try {
      this.svg.draw(stream, concreteWidth, concreteHeight, this.id, null);
    } catch (error) {
      // Python logs and keeps going: a broken SVG must not abort the document.
      LOGGER.error(`Failed to render SVG image ${this.id}`);
      LOGGER.debug(`Error while rendering SVG image: ${String(error)}`);
    }
  }
}

function findSvgRoot(root: Element): Element | null {
  for (const el of root.iter()) {
    if (el.tag.replace(/^\{[^}]*\}/, '') === 'svg') return el;
  }
  return null;
}
