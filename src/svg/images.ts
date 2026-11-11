// SPDX-License-Identifier: BSD-3-Clause

/** Draw image and svg tags (mirrors weasyprint/svg/images.py). */
import type { SvgNode, SVG } from './index.ts';
import { boundingBox, isValidBoundingBox } from './bounding_box.ts';
import { preserveRatio, size } from './utils.ts';

/** Python: svg(svg, node, font_size). Nested <svg> elements and the root. */
export function svg(svgDoc: SVG, node: SvgNode, fontSize: number): void {
  const [x, y] = svgDoc.point(node.get('x'), node.get('y'), fontSize);
  svgDoc.stream.transform(1, 0, 0, 1, x, y);
  let width: number;
  let height: number;
  if (svgDoc.tree === node) {
    width = svgDoc.concreteWidth;
    height = svgDoc.concreteHeight;
  } else {
    const rawWidth = node.get('width');
    const rawHeight = node.get('height');
    if (rawWidth === null || rawWidth === undefined || rawHeight === null || rawHeight === undefined) {
      node.etree.tag = 'g';
      const box = boundingBox(svgDoc, node, fontSize, true);
      if (isValidBoundingBox(box)) {
        width = box[0] + box[2];
        height = box[1] + box[3];
      } else {
        width = 0;
        height = 0;
      }
      node.etree.tag = 'svg';
    } else {
      [width, height] = svgDoc.point(rawWidth, rawHeight, fontSize);
    }
  }
  node.setSvgSize(svgDoc, width, height);
  const [scaleX, scaleY, translateX, translateY] = preserveRatio(svgDoc, node, fontSize, width, height);
  if (svgDoc.tree !== node && node.get('overflow', 'hidden') === 'hidden') {
    svgDoc.stream.rectangle(0, 0, width, height);
    svgDoc.stream.clip();
    svgDoc.stream.end();
  }
  svgDoc.stream.transform(scaleX, 0, 0, scaleY, translateX, translateY);
}

/** Python: image(svg, node, font_size). Raster or SVG images referenced by href. */
export function image(svgDoc: SVG, node: SvgNode, fontSize: number): void {
  const [x, y] = svgDoc.point(node.get('x'), node.get('y'), fontSize);
  svgDoc.stream.transform(1, 0, 0, 1, x, y);
  const baseUrl = node.get('{http://www.w3.org/XML/1998/namespace}base');
  const url = node.getHref(baseUrl || svgDoc.url);
  const getImage = svgDoc.context?.getImageFromUri;
  const img = url && getImage ? getImage({ url, forcedMimeType: 'image/*' }) : null;
  if (!img) return;

  let width: number;
  let height: number;
  [width, height] = svgDoc.point(node.get('width'), node.get('height'), fontSize);
  let [intrinsicWidth, intrinsicHeight, intrinsicRatio] = img.getIntrinsicSize(1, fontSize);
  if (intrinsicWidth === null && intrinsicHeight === null) {
    if (intrinsicRatio === null || (!width && !height)) {
      intrinsicWidth = 300;
      intrinsicHeight = 150;
    } else if (!width) {
      intrinsicWidth = intrinsicRatio * height;
      intrinsicHeight = height;
    } else {
      intrinsicWidth = width;
      intrinsicHeight = width / intrinsicRatio;
    }
  } else if (intrinsicWidth === null) {
    intrinsicWidth = intrinsicRatio! * intrinsicHeight!;
  } else if (intrinsicHeight === null) {
    intrinsicHeight = intrinsicWidth / intrinsicRatio!;
  }

  // Calculate final dimensions while preserving aspect ratio
  if (width && !height) {
    height = width / intrinsicRatio!;
  } else if (height && !width) {
    width = height * intrinsicRatio!;
  } else {
    width = width || intrinsicWidth;
    height = height || intrinsicHeight;
  }

  const [scaleX, scaleY, translateX, translateY] = preserveRatio(
    svgDoc, node, fontSize, width, height, [0, 0, intrinsicWidth, intrinsicHeight]);
  svgDoc.stream.rectangle(0, 0, width, height);
  svgDoc.stream.clip();
  svgDoc.stream.end();
  svgDoc.stream.pushState();
  svgDoc.stream.transform(scaleX, 0, 0, scaleY, translateX, translateY);
  // TODO: pass real style instead of dict.
  img.draw(svgDoc.stream, intrinsicWidth, intrinsicHeight, { image_rendering: node.attrib.get('image-rendering') ?? 'auto' });
  svgDoc.stream.popState();
}

