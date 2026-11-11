// SPDX-License-Identifier: BSD-3-Clause

/** SVG patterns (mirrors draw_pattern in weasyprint/svg/defs.py). */
import { Matrix } from '../matrix.ts';
import { boundingBox as _unused, isValidBoundingBox, EMPTY_BOUNDING_BOX } from './bounding_box.ts';
import { Pattern } from './index.ts';
import type { SvgNode, SVG } from './index.ts';
import { matrix as matrixOf, size, transform } from './utils.ts';

void _unused;

/** Python: draw_pattern(svg, node, pattern, font_size, opacity, stroke). */
export function drawPattern(svg: SVG, node: SvgNode, pattern: SvgNode, fontSize: number, opacity: number,
  stroke: boolean): boolean {
  pattern.etree.tag = 'svg';

  const bbox = svg.calculateBoundingBox(node, fontSize, stroke) ?? EMPTY_BOUNDING_BOX;
  if (!isValidBoundingBox(bbox)) return false;
  const x = bbox[0];
  const y = bbox[1];
  let mat: Matrix = matrixOf({ e: x, f: y });
  let patternWidth: number;
  let patternHeight: number;
  if (pattern.get('patternUnits') === 'userSpaceOnUse') {
    patternWidth = size(pattern.get('width', 0), fontSize, 1);
    patternHeight = size(pattern.get('height', 0), fontSize, 1);
  } else {
    const width = bbox[2];
    const height = bbox[3];
    // Python pops the attributes (they are removed from the node).
    const rawWidth = pattern.attrib.get('width') ?? '1';
    const rawHeight = pattern.attrib.get('height') ?? '1';
    pattern.attrib.delete('width');
    pattern.attrib.delete('height');
    patternWidth = size(rawWidth, fontSize, 1) * width;
    patternHeight = size(rawHeight, fontSize, 1) * height;
    if (!pattern.has('viewBox')) {
      pattern.attrib.set('width', patternWidth);
      pattern.attrib.set('height', patternHeight);
      if (pattern.get('patternContentUnits') === 'objectBoundingBox') {
        pattern.attrib.set('transform', `scale(${width}, ${height})`);
      }
    }
  }

  // Fail if pattern has an invalid size
  if (patternWidth === 0 || patternHeight === 0) return false;

  if (pattern.has('patternTransform')) {
    const transformMatrix = transform(pattern.get('patternTransform'), '0 0', fontSize, svg.innerDiagonal);
    mat = transformMatrix.matmul(mat);
  }

  mat = mat.matmul(svg.stream.ctm);
  const streamPattern = svg.stream.addPattern(0, 0, patternWidth, patternHeight, patternWidth, patternHeight, mat);
  streamPattern.setAlpha(opacity);

  const group = streamPattern.addGroup(0, 0, patternWidth, patternHeight);
  new Pattern(pattern, svg).draw(group, patternWidth, patternHeight, svg.baseUrl, svg.context);
  streamPattern.drawXObject(group.id);
  svg.stream.setColorSpace('Pattern', stroke);
  svg.stream.setColorSpecial(streamPattern.id, stroke);
  return true;
}
