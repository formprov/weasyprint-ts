// SPDX-License-Identifier: BSD-3-Clause

/** Calculate bounding boxes of SVG tags (mirrors weasyprint/svg/bounding_box.py). */
import { PATH_LETTERS } from './path.ts';
import { getUseTree } from './defs.ts';
import { charAt0, normalize, point, pyFloat, pyInt, splitOnce } from './utils.ts';

export type Box = [number, number, number, number];

export const EMPTY_BOUNDING_BOX: Box = [Infinity, Infinity, 0, 0];

export function boundingBox(svg: any, node: any, fontSize: number, stroke: boolean): Box {
  if (!(node.tag in BOUNDING_BOX_METHODS)) return EMPTY_BOUNDING_BOX;
  const box: Box = BOUNDING_BOX_METHODS[node.tag](svg, node, fontSize);
  if (!isValidBoundingBox(box)) return EMPTY_BOUNDING_BOX;
  const [strokeSource, strokeColor] = node.getPaint('stroke');
  if (stroke && node.tag !== 'g' && (strokeSource || strokeColor)) {
    const strokeWidth = svg.length(node.get('stroke-width') ?? '1px', fontSize);
    return [
      box[0] - strokeWidth / 2, box[1] - strokeWidth / 2,
      box[2] + strokeWidth, box[3] + strokeWidth,
    ];
  }
  return box;
}

export function boundingBoxRect(svg: any, node: any, fontSize: number): Box {
  const [x, y] = svg.point(node.get('x'), node.get('y'), fontSize);
  const [width, height] = svg.point(node.get('width'), node.get('height'), fontSize);
  return [x, y, width, height];
}

export function boundingBoxCircle(svg: any, node: any, fontSize: number): Box {
  const [cx, cy] = svg.point(node.get('cx'), node.get('cy'), fontSize);
  const r = svg.length(node.get('r'), fontSize);
  return [cx - r, cy - r, 2 * r, 2 * r];
}

export function boundingBoxEllipse(svg: any, node: any, fontSize: number): Box {
  const [rx, ry] = svg.point(node.get('rx'), node.get('ry'), fontSize);
  const [cx, cy] = svg.point(node.get('cx'), node.get('cy'), fontSize);
  return [cx - rx, cy - ry, 2 * rx, 2 * ry];
}

export function boundingBoxLine(svg: any, node: any, fontSize: number): Box {
  const [x1, y1] = svg.point(node.get('x1'), node.get('y1'), fontSize);
  const [x2, y2] = svg.point(node.get('x2'), node.get('y2'), fontSize);
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return [x, y, Math.max(x1, x2) - x, Math.max(y1, y2) - y];
}

export function boundingBoxPolyline(svg: any, node: any, fontSize: number): Box {
  let box: Box = EMPTY_BOUNDING_BOX;
  const points: Array<[number, number]> = [];
  let normalized = normalize(node.get('points') ?? '');
  while (normalized) {
    const [x, y, rest] = point(svg, normalized, fontSize);
    points.push([x, y]);
    normalized = rest;
  }
  box = extendBoundingBox(box, points);
  return box;
}

export function boundingBoxPath(svg: any, node: any, fontSize: number): Box {
  let pathData: string = node.get('d') ?? '';

  // Normalize path data for correct parsing
  for (const letter of PATH_LETTERS) pathData = pathData.split(letter).join(` ${letter} `);
  pathData = normalize(pathData);

  let box: Box = EMPTY_BOUNDING_BOX;
  let previousX = 0;
  let previousY = 0;
  let letter = 'M'; // Move as default
  while (pathData) {
    pathData = pathData.trim();
    if (PATH_LETTERS.includes(pathData.split(' ', 1)[0])) {
      [letter, pathData] = splitOnce(`${pathData} `);
    }

    if (letter === 'a' || letter === 'A') {
      // Elliptical arc curve
      let rx: number;
      let ry: number;
      [rx, ry, pathData] = point(svg, pathData, fontSize);
      let rotationText: string;
      [rotationText, pathData] = splitOnce(pathData);
      const rotation = (pyFloat(rotationText) * Math.PI) / 180;

      // The large and sweep values are not always separated from the following
      // values, here is the crazy parser
      let large = charAt0(pathData);
      pathData = pathData.slice(1).trim();
      while (!/\d$/.test(large)) {
        large += charAt0(pathData);
        pathData = pathData.slice(1).trim();
      }
      let sweep = charAt0(pathData);
      pathData = pathData.slice(1).trim();
      while (!/\d$/.test(sweep)) {
        sweep += charAt0(pathData);
        pathData = pathData.slice(1).trim();
      }

      const largeFlag = Boolean(pyInt(large));
      const sweepFlag = Boolean(pyInt(sweep));

      let x: number;
      let y: number;
      [x, y, pathData] = point(svg, pathData, fontSize);

      // Relative coordinate, convert to absolute
      if (letter === 'a') {
        x += previousX;
        y += previousY;
      }

      // Extend bounding box with start and end coordinates
      const [x1, y1, width, height] = boundingBoxElliptical(
        previousX, previousY, rx, ry, rotation, largeFlag, sweepFlag, x, y);
      const x2 = x1 + width;
      const y2 = y1 + height;
      box = extendBoundingBox(box, [[x1, y1], [x2, y2]]);
      previousX = x;
      previousY = y;
    } else if (letter === 'c' || letter === 'C') {
      // Curve
      let x1: number;
      let y1: number;
      let x2: number;
      let y2: number;
      let x: number;
      let y: number;
      [x1, y1, pathData] = point(svg, pathData, fontSize);
      [x2, y2, pathData] = point(svg, pathData, fontSize);
      [x, y, pathData] = point(svg, pathData, fontSize);

      // Relative coordinates, convert to absolute
      if (letter === 'c') {
        x1 += previousX;
        y1 += previousY;
        x2 += previousX;
        y2 += previousY;
        x += previousX;
        y += previousY;
      }

      // Extend bounding box with all coordinates
      box = extendBoundingBox(box, [[x1, y1], [x2, y2], [x, y]]);
      previousX = x;
      previousY = y;
    } else if (letter === 'h' || letter === 'H') {
      // Horizontal line
      let xText: string;
      [xText, pathData] = splitOnce(`${pathData} `);
      let [x] = svg.point(xText, 0, fontSize);

      // Relative coordinate, convert to absolute
      if (letter === 'h') x += previousX;

      // Extend bounding box with coordinate
      box = extendBoundingBox(box, [[x, previousY]]);
      previousX = x;
    } else if ('lLmMtT'.includes(letter)) {
      // Line/Move/Smooth quadratic curve
      let x: number;
      let y: number;
      [x, y, pathData] = point(svg, pathData, fontSize);

      // Relative coordinate, convert to absolute
      if ('lmt'.includes(letter)) {
        x += previousX;
        y += previousY;
      }

      // Extend bounding box with coordinate
      box = extendBoundingBox(box, [[x, y]]);
      previousX = x;
      previousY = y;
    } else if ('qQsS'.includes(letter)) {
      // Quadratic curve/Smooth curve
      let x1: number;
      let y1: number;
      let x: number;
      let y: number;
      [x1, y1, pathData] = point(svg, pathData, fontSize);
      [x, y, pathData] = point(svg, pathData, fontSize);

      // Relative coordinates, convert to absolute
      if ('qs'.includes(letter)) {
        x1 += previousX;
        y1 += previousY;
        x += previousX;
        y += previousY;
      }

      // Extend bounding box with coordinates
      box = extendBoundingBox(box, [[x1, y1], [x, y]]);
      previousX = x;
      previousY = y;
    } else if (letter === 'v' || letter === 'V') {
      // Vertical line
      let yText: string;
      [yText, pathData] = splitOnce(`${pathData} `);
      let [, y] = svg.point(0, yText, fontSize);

      // Relative coordinate, convert to absolute
      if (letter === 'v') y += previousY;

      // Extend bounding box with coordinate
      box = extendBoundingBox(box, [[previousX, y]]);
      previousY = y;
    }

    pathData = pathData.trim();
  }

  return box;
}

export function boundingBoxText(_svg: any, node: any, _fontSize: number): Box {
  return node.textBoundingBox ?? EMPTY_BOUNDING_BOX;
}

export function boundingBoxG(svg: any, node: any, fontSize: number): Box {
  let box: Box = EMPTY_BOUNDING_BOX;
  for (const child of node) {
    const childBox: Box = svg.calculateBoundingBox(child, fontSize);
    if (isValidBoundingBox(childBox)) {
      const [minx, miny, width, height] = transformBoundingBox(svg, child, fontSize, childBox);
      const maxx = minx + width;
      const maxy = miny + height;
      box = extendBoundingBox(box, [[minx, miny], [maxx, maxy]]);
    }
  }
  return box;
}

export function boundingBoxUse(svg: any, node: any, fontSize: number): Box {
  // Python imports get_use_tree lazily to avoid a cycle; the ESM binding is only read at call time.
  const tree = getUseTree(svg, node, fontSize);
  if (tree === null || tree === undefined) return EMPTY_BOUNDING_BOX;
  const [x, y] = svg.point(node.get('x'), node.get('y'), fontSize);
  const inner = boundingBox(svg, tree, fontSize, true);
  const box: Box = [inner[0] + x, inner[1] + y, inner[2], inner[3]];
  return transformBoundingBox(svg, tree, fontSize, box);
}

/** Bounding box of an elliptical arc in path node. */
function boundingBoxElliptical(
  x1: number, y1: number, rxIn: number, ryIn: number, phi: number,
  large: boolean, sweep: boolean, x: number, y: number,
): Box {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    return [Math.min(x, x1), Math.min(y, y1), Math.abs(x - x1), Math.abs(y - y1)];
  }

  const x1prime = (Math.cos(phi) * (x1 - x)) / 2 + (Math.sin(phi) * (y1 - y)) / 2;
  const y1prime = (-Math.sin(phi) * (x1 - x)) / 2 + (Math.cos(phi) * (y1 - y)) / 2;

  let radicant = rx ** 2 * ry ** 2 - rx ** 2 * y1prime ** 2 - ry ** 2 * x1prime ** 2;
  radicant /= rx ** 2 * y1prime ** 2 + ry ** 2 * x1prime ** 2;
  let cxprime = 0;
  let cyprime = 0;

  if (radicant < 0) {
    const ratio = rx / ry;
    radicant = y1prime ** 2 + x1prime ** 2 / ratio ** 2;
    if (radicant < 0) {
      return [Math.min(x, x1), Math.min(y, y1), Math.abs(x - x1), Math.abs(y - y1)];
    }
    ry = Math.sqrt(radicant);
    rx = ratio * ry;
  } else {
    const factor = (large === sweep ? -1 : 1) * Math.sqrt(radicant);
    cxprime = (factor * rx * y1prime) / ry;
    cyprime = (-factor * ry * x1prime) / rx;
  }

  const cx = cxprime * Math.cos(phi) - cyprime * Math.sin(phi) + (x1 + x) / 2;
  const cy = cxprime * Math.sin(phi) + cyprime * Math.cos(phi) + (y1 + y) / 2;

  let minx: number;
  let tminx: number;
  let maxx: number;
  let tmaxx: number;
  let miny: number;
  let tminy: number;
  let maxy: number;
  let tmaxy: number;
  if (phi === 0 || phi === Math.PI) {
    minx = cx - rx;
    tminx = Math.atan2(0, -rx);
    maxx = cx + rx;
    tmaxx = Math.atan2(0, rx);
    miny = cy - ry;
    tminy = Math.atan2(-ry, 0);
    maxy = cy + ry;
    tmaxy = Math.atan2(ry, 0);
  } else if (phi === Math.PI / 2 || phi === (3 * Math.PI) / 2) {
    minx = cx - ry;
    tminx = Math.atan2(0, -ry);
    maxx = cx + ry;
    tmaxx = Math.atan2(0, ry);
    miny = cy - rx;
    tminy = Math.atan2(-rx, 0);
    maxy = cy + rx;
    tmaxy = Math.atan2(rx, 0);
  } else {
    tminx = -Math.atan((ry * Math.tan(phi)) / rx);
    tmaxx = Math.PI - Math.atan((ry * Math.tan(phi)) / rx);
    minx = cx + rx * Math.cos(tminx) * Math.cos(phi) - ry * Math.sin(tminx) * Math.sin(phi);
    maxx = cx + rx * Math.cos(tmaxx) * Math.cos(phi) - ry * Math.sin(tmaxx) * Math.sin(phi);
    if (minx > maxx) {
      [minx, maxx] = [maxx, minx];
      [tminx, tmaxx] = [tmaxx, tminx];
    }
    let tmpY = cy + rx * Math.cos(tminx) * Math.sin(phi) + ry * Math.sin(tminx) * Math.cos(phi);
    tminx = Math.atan2(minx - cx, tmpY - cy);
    tmpY = cy + rx * Math.cos(tmaxx) * Math.sin(phi) + ry * Math.sin(tmaxx) * Math.cos(phi);
    tmaxx = Math.atan2(maxx - cx, tmpY - cy);

    tminy = Math.atan((ry / (Math.tan(phi) * rx)));
    tmaxy = Math.atan((ry / (Math.tan(phi) * rx))) + Math.PI;
    miny = cy + rx * Math.cos(tminy) * Math.sin(phi) + ry * Math.sin(tminy) * Math.cos(phi);
    maxy = cy + rx * Math.cos(tmaxy) * Math.sin(phi) + ry * Math.sin(tmaxy) * Math.cos(phi);
    if (miny > maxy) {
      [miny, maxy] = [maxy, miny];
      [tminy, tmaxy] = [tmaxy, tminy];
    }
    let tmpX = cx + rx * Math.cos(tminy) * Math.cos(phi) - ry * Math.sin(tminy) * Math.sin(phi);
    tminy = Math.atan2(tmpX - cx, miny - cy);
    tmpX = cx + rx * Math.cos(tmaxy) * Math.cos(phi) - ry * Math.sin(tmaxy) * Math.sin(phi);
    tmaxy = Math.atan2(maxy - cy, tmpX - cx);
  }

  let angle1 = Math.atan2(y1 - cy, x1 - cx);
  let angle2 = Math.atan2(y - cy, x - cx);

  if (!sweep) [angle1, angle2] = [angle2, angle1];

  let otherArc = false;
  if (angle1 > angle2) {
    [angle1, angle2] = [angle2, angle1];
    otherArc = true;
  }

  const inside = (t: number) => angle1 > t || angle2 < t;
  if ((!otherArc && inside(tminx)) || (otherArc && !inside(tminx))) minx = Math.min(x, x1);
  if ((!otherArc && inside(tmaxx)) || (otherArc && !inside(tmaxx))) maxx = Math.max(x, x1);
  if ((!otherArc && inside(tminy)) || (otherArc && !inside(tminy))) miny = Math.min(y, y1);
  if ((!otherArc && inside(tmaxy)) || (otherArc && !inside(tmaxy))) maxy = Math.max(y, y1);

  return [minx, miny, maxx - minx, maxy - miny];
}

/** Extend a bounding box to include given points (Python raises when there are none). */
export function extendBoundingBox(box: Box | number[], points: Array<[number, number]> | Array<number[]>): Box {
  const [minxIn, minyIn, width, height] = box;
  // Python: -inf if isinf(minx) else minx + width
  let maxx = Math.abs(minxIn) === Infinity ? -Infinity : minxIn + width;
  let maxy = Math.abs(minyIn) === Infinity ? -Infinity : minyIn + height;
  if (points.length === 0) throw new Error('not enough values to unpack (expected 2, got 0)');
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minx = Math.min(minxIn, ...xs);
  const miny = Math.min(minyIn, ...ys);
  maxx = Math.max(maxx, ...xs);
  maxy = Math.max(maxy, ...ys);
  return [minx, miny, maxx - minx, maxy - miny];
}

export function transformBoundingBox(svg: any, node: any, fontSize: number, box: Box): Box {
  const matrix = svg.getNodeTransformMatrix(node, fontSize);
  if (!matrix) return box;
  const [minx, miny, width, height] = box;
  const maxx = minx + width;
  const maxy = miny + height;
  const points: Array<[number, number]> = [
    matrix.transformPoint(minx, miny),
    matrix.transformPoint(minx, maxy),
    matrix.transformPoint(maxx, miny),
    matrix.transformPoint(maxx, maxy),
  ];
  return extendBoundingBox(EMPTY_BOUNDING_BOX, points);
}

export function isValidBoundingBox(box: Box | null | undefined): boolean {
  return Boolean(box) && Number.isFinite(box![0] + box![1]);
}

const BOUNDING_BOX_METHODS: Record<string, (svg: any, node: any, fontSize: number) => Box> = {
  rect: boundingBoxRect,
  circle: boundingBoxCircle,
  ellipse: boundingBoxEllipse,
  line: boundingBoxLine,
  polyline: boundingBoxPolyline,
  polygon: boundingBoxPolyline,
  path: boundingBoxPath,
  g: boundingBoxG,
  use: boundingBoxUse,
  marker: boundingBoxG,
  text: boundingBoxText,
  tspan: boundingBoxText,
  textPath: boundingBoxText,
};
