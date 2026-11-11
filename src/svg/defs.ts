// SPDX-License-Identifier: BSD-3-Clause

/**
 * Parse and draw definitions: gradients, patterns, masks, uses (mirrors weasyprint/svg/defs.py).
 *
 * Not yet ported: patterns (draw_pattern). Gradients live in gradients.ts.
 */
import { LOGGER } from '../logger.ts';
import type { SvgNode, SVG } from './index.ts';
import { boundingBox, isValidBoundingBox } from './bounding_box.ts';
import { parseUrl, size } from './utils.ts';


/** Python: get_use_tree(svg, node, font_size). Returns a copy of the referenced node, or null. */
export function getUseTree(svg: SVG, node: SvgNode, _fontSize: number): SvgNode | null {
  const parsedUrl = parseUrl(node.getHref(svg.url));
  let svgUrl = parseUrl(svg.url);
  if (svgUrl.scheme === 'data') svgUrl = parseUrl('');
  const sameOrigin = (parsedUrl.scheme === '' && parsedUrl.netloc === '' && parsedUrl.path === '')
    || (parsedUrl.scheme === svgUrl.scheme && parsedUrl.netloc === svgUrl.netloc && parsedUrl.path === svgUrl.path);
  if (parsedUrl.fragment && sameOrigin) {
    const cached = svg.useCache.get(parsedUrl.fragment);
    if (cached) return cached.copy();
    const child = svg.tree.getChild(parsedUrl.fragment);
    if (child === null) return null;
    const tree = child.copy();
    svg.useCache.set(parsedUrl.fragment, tree);
    return tree;
  }
  return null;
}

/** Python: use(svg, node, font_size): draw use tags. */
export function use(svg: SVG, node: SvgNode, fontSize: number): void {
  const tree = getUseTree(svg, node, fontSize);
  if (tree === null) return;

  if (tree.tag === 'svg' || tree.tag === 'symbol') {
    // Explicitely specified
    // https://www.w3.org/TR/SVG11/struct.html#UseElement
    if (node.has('width') && node.has('height')) {
      tree.attrib.set('width', node.attrib.get('width'));
      tree.attrib.set('height', node.attrib.get('height'));
    } else {
      tree.etree.tag = 'g';
      const box = boundingBox(svg, tree, fontSize, true);
      if (isValidBoundingBox(box)) {
        tree.attrib.set('width', box[0] + box[2]);
        tree.attrib.set('height', box[1] + box[3]);
      }
    }
    tree.etree.tag = 'svg';
  }

  tree.childrenCache = null; // Force cascade to go through children again
  node.cascade(tree);
  node.overrideIter([tree]);
  const [x, y] = svg.point(node.get('x'), node.get('y'), fontSize);
  svg.stream.transform(1, 0, 0, 1, x, y);
}

export { drawGradient } from './gradients.ts';

export { drawPattern } from './patterns.ts';

/** Python: apply_filters(svg, node, filter_node, font_size). Supports feOffset and feBlend only. */
export function applyFilters(svg: SVG, node: SvgNode, filterNode: SvgNode, fontSize: number): void {
  for (const child of filterNode.children()) {
    if (child.tag === 'feOffset') {
      let dx: number;
      let dy: number;
      if (filterNode.get('primitiveUnits') === 'objectBoundingBox') {
        const box = svg.calculateBoundingBox(node, fontSize);
        if (box !== null && isValidBoundingBox(box)) {
          const width = box[2];
          const height = box[3];
          dx = size(child.get('dx', 0), fontSize, 1) * width;
          dy = size(child.get('dy', 0), fontSize, 1) * height;
        } else {
          dx = 0;
          dy = 0;
        }
      } else {
        [dx, dy] = svg.point(child.get('dx', 0), child.get('dy', 0), fontSize);
      }
      svg.stream.transform(1, 0, 0, 1, dx, dy);
    } else if (child.tag === 'feBlend') {
      const mode = String(child.get('mode', 'normal')).replace(/-/g, ' ')
        .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .replace(/ /g, '');
      svg.stream.setBlendMode(mode);
    }
  }
}

/** Python: paint_mask(svg, node, mask, font_size). The caller passes opacity in the font_size slot, as upstream does. */
export function paintMask(svg: SVG, node: SvgNode, mask: SvgNode, fontSize: number): void {
  mask.etree.tag = 'g';

  let widthRef: number;
  let heightRef: number;
  if (mask.get('maskUnits') === 'userSpaceOnUse') {
    widthRef = svg.innerWidth;
    heightRef = svg.innerHeight;
  } else {
    [widthRef, heightRef] = svg.point(node.get('width'), node.get('height'), fontSize);
  }

  mask.attrib.set('x', size(mask.get('x', '-10%'), fontSize, widthRef));
  mask.attrib.set('y', size(mask.get('y', '-10%'), fontSize, heightRef));
  mask.attrib.set('height', size(mask.get('height', '120%'), fontSize, heightRef));
  mask.attrib.set('width', size(mask.get('width', '120%'), fontSize, widthRef));

  let x: number;
  let y: number;
  let width: number;
  let height: number;
  if (mask.get('maskUnits') === 'userSpaceOnUse') {
    x = mask.get('x');
    y = mask.get('y');
    width = mask.get('width');
    height = mask.get('height');
    mask.attrib.set('viewBox', `${x} ${y} ${width} ${height}`);
  } else {
    x = 0;
    y = 0;
    width = widthRef;
    height = heightRef;
  }

  const svgStream = svg.stream;
  svg.stream = svg.stream.setAlphaState(x, y, width, height);
  svg.drawNode(mask, fontSize);
  svg.stream = svgStream;
}
