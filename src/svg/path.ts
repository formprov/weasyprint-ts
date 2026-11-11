// SPDX-License-Identifier: BSD-3-Clause

/** Draw paths (mirrors weasyprint/svg/path.py). */
import { Matrix } from '../matrix.ts';
import { charAt0, normalize, point, pyFloat, pyInt, splitOnce } from './utils.ts';

export const PATH_LETTERS = 'achlmqstvzACHLMQSTVZ';

type Pt = [number, number];

/** Rotate (x, y) point of given angle around (0, 0). */
function rotate(x: number, y: number, angle: number): Pt {
  return [x * Math.cos(angle) - y * Math.sin(angle), y * Math.cos(angle) + x * Math.sin(angle)];
}

/** Python ``a in 'xyz'`` for a possibly-None value: None is never in a string. */
const inStr = (value: string | null | undefined, chars: string): boolean =>
  value !== null && value !== undefined && chars.includes(value);

export function path(svg: any, node: any, fontSize: number): void {
  let string: string = node.get('d') ?? '';

  for (const letter of PATH_LETTERS) string = string.split(letter).join(` ${letter} `);
  string = normalize(string);

  // TODO: get current point
  let currentPoint: Pt = [0, 0];
  svg.stream.moveTo(...currentPoint);
  let lastLetter: string | null = null;

  // Python's function-scoped names: some branches read values set by earlier iterations.
  let x = 0;
  let y = 0;
  let x2 = 0;
  let y2 = 0;
  let x3 = 0;
  let y3 = 0;
  let firstPathPoint: Pt | null = null;

  const re = new RegExp(`([${PATH_LETTERS}])([^${PATH_LETTERS}]*)`, 'g');
  const matches: Array<[string, string]> = [...string.trim().matchAll(re)].map((m) => [m[1], m[2]]);
  while (matches.length) {
    let letter: string;
    [letter, string] = matches.shift()!;
    string = string.trim();

    if ((lastLetter === null || lastLetter === 'z' || lastLetter === 'Z') && !'mM'.includes(letter)) {
      node.vertices.push(currentPoint);
      firstPathPoint = currentPoint;
    }

    if (inStr(lastLetter, 'mMzZ') || lastLetter === null) firstPathPoint = null;
    if (!inStr(letter, 'mMzZ') && firstPathPoint === null) firstPathPoint = currentPoint;

    if (letter === 'a' || letter === 'A') {
      // Elliptic curve. Drawn as an approximation using Bézier curves
      const [x1, y1] = currentPoint;
      let rx: number;
      let ry: number;
      [rx, ry, string] = point(svg, string, fontSize);
      let rotationText: string;
      [rotationText, string] = splitOnce(string);
      const rotation = (pyFloat(rotationText) * Math.PI) / 180;

      // The large and sweep values are not always separated from the following
      // values. These flags can only be 0 or 1, so reading a single digit suffices.
      let large = charAt0(string);
      string = string.slice(1).trim();
      let sweep = charAt0(string);
      string = string.slice(1).trim();

      // Retrieve end point and set remainder (before checking flags)
      [x3, y3, string] = point(svg, string, fontSize);
      if (letter === 'a') {
        x3 += x1;
        y3 += y1;
      }

      // Only allow 0 or 1 for flags
      const largeInt = pyInt(large);
      const sweepInt = pyInt(sweep);
      if (![0, 1].includes(largeInt) || ![0, 1].includes(sweepInt)) continue;
      const largeFlag = Boolean(largeInt);
      const sweepFlag = Boolean(sweepInt);

      // rx=0 or ry=0 means straight line
      if (!rx || !ry) {
        string = string.trim();
        if (string) {
          // As we replace the current operation by l, we must be sure that the
          // next letter is set to the real current letter (a or A) in case it’s
          // omitted
          matches.unshift([letter, string]);
        }
        matches.unshift(['l', `${x3} ${y3}`]);
        continue;
      }

      // Cancel the rotation of the second point
      let [xe, ye] = rotate(x3 - x1, y3 - y1, -rotation);
      const yScale = ry / rx;
      ye /= yScale;

      // Find the angle between the second point and the x axis
      const angle = Math.atan2(ye, xe);

      // Put the second point onto the x axis
      xe = (xe ** 2 + ye ** 2) ** 0.5;
      ye = 0;

      // Update the x radius if it is too small
      rx = Math.max(rx, xe / 2);

      // Find one circle centre
      const xc0 = xe / 2;
      let yc0 = (rx ** 2 - xc0 ** 2) ** 0.5;

      // Choose between the two circles according to flags
      if (largeFlag === sweepFlag) yc0 = -yc0;

      // Put the second point and the center back to their positions
      [xe, ye] = rotate(xe, ye, angle);
      const [xc, yc] = rotate(xc0, yc0, angle);

      // Find the drawing angles
      let angle1 = Math.atan2(-yc, -xc);
      let angle2 = Math.atan2(ye - yc, xe - xc);
      while (angle1 < 0 || angle2 < 0) {
        angle1 += 2 * Math.PI;
        angle2 += 2 * Math.PI;
      }

      // Store the tangent angles
      node.vertices.push([-angle1, -angle2]);

      // Fix angles to follow large arc flag
      if (isClose(Math.abs(angle2 - angle1), Math.PI)) {
        if (sweepFlag && angle2 < angle1) angle1 -= 2 * Math.PI;
        else if (!sweepFlag && angle2 > angle1) angle2 -= 2 * Math.PI;
      } else if (largeFlag === (Math.abs(angle2 - angle1) < Math.PI)) {
        if (angle1 > angle2) angle1 -= 2 * Math.PI;
        else angle2 -= 2 * Math.PI;
      }

      // Split arc into 3 Bézier curves when larger than pi
      let angles: Array<[number, number]>;
      if (largeFlag) {
        const step = (angle2 - angle1) / 3;
        angles = [
          [angle1, angle1 + step],
          [angle1 + step, angle1 + 2 * step],
          [angle1 + 2 * step, angle2],
        ];
      } else {
        angles = [[angle1, angle2]];
      }

      // Draw Bézier curves
      const matrix = new Matrix(
        Math.cos(rotation), Math.sin(rotation),
        -Math.sin(rotation) * yScale, Math.cos(rotation) * yScale,
        x1, y1);
      const h = (4 / 3) * Math.tan((angles[0][1] - angles[0][0]) / 4);
      for (const [a1, a2] of angles) {
        const point1 = matrix.transformPoint(
          xc + rx * Math.cos(a1) - h * rx * Math.sin(a1),
          yc + rx * Math.sin(a1) + h * rx * Math.cos(a1));
        const point2 = matrix.transformPoint(
          xc + rx * Math.cos(a2) + h * rx * Math.sin(a2),
          yc + rx * Math.sin(a2) - h * rx * Math.cos(a2));
        const point3 = matrix.transformPoint(
          xc + rx * Math.cos(a2),
          yc + rx * Math.sin(a2));
        svg.stream.curveTo(...point1, ...point2, ...point3);
      }

      currentPoint = [x3, y3];
    } else if (letter === 'c' || letter === 'C') {
      // Curve
      let x1: number;
      let y1: number;
      [x1, y1, string] = point(svg, string, fontSize);
      [x2, y2, string] = point(svg, string, fontSize);
      [x3, y3, string] = point(svg, string, fontSize);
      if (letter === 'c') {
        [x, y] = currentPoint;
        x1 += x;
        x2 += x;
        x3 += x;
        y1 += y;
        y2 += y;
        y3 += y;
      }
      node.vertices.push([Math.atan2(y1 - y2, x1 - x2), Math.atan2(y3 - y2, x3 - x2)]);
      svg.stream.curveTo(x1, y1, x2, y2, x3, y3);
      currentPoint = [x3, y3];
    } else if (letter === 'h' || letter === 'H') {
      // Horizontal line
      let xText: string;
      [xText, string] = splitOnce(`${string} `);
      const [oldX, oldY] = currentPoint;
      let xv: number;
      [xv] = svg.point(xText, 0, fontSize);
      if (letter === 'h') xv += oldX;
      x = xv;
      const angle = xv > oldX ? 0 : Math.PI;
      node.vertices.push([Math.PI - angle, angle]);
      svg.stream.lineTo(xv, oldY);
      currentPoint = [xv, oldY];
    } else if (letter === 'l' || letter === 'L') {
      // Straight line
      let lx: number;
      let ly: number;
      [lx, ly, string] = point(svg, string, fontSize);
      const [oldX, oldY] = currentPoint;
      if (letter === 'l') {
        lx += oldX;
        ly += oldY;
      }
      [x, y] = [lx, ly];
      const angle = Math.atan2(ly - oldY, lx - oldX);
      node.vertices.push([Math.PI - angle, angle]);
      svg.stream.lineTo(lx, ly);
      currentPoint = [lx, ly];
    } else if (letter === 'm' || letter === 'M') {
      // Current point move
      let mx: number;
      let my: number;
      [mx, my, string] = point(svg, string, fontSize);
      if (lastLetter && !'zZ'.includes(lastLetter)) node.vertices.push(null);
      if (letter === 'm') {
        mx += currentPoint[0];
        my += currentPoint[1];
      }
      [x, y] = [mx, my];
      svg.stream.moveTo(mx, my);
      currentPoint = [mx, my];
    } else if (letter === 'q' || letter === 'Q' || letter === 't' || letter === 'T') {
      // Quadratic curve
      const [x1, y1] = currentPoint;
      if (letter === 'q' || letter === 'Q') {
        [x2, y2, string] = point(svg, string, fontSize);
      } else {
        if (!inStr(lastLetter, 'QqTt')) {
          x2 = x;
          y2 = y;
          x3 = x;
          y3 = y;
        }
        x2 = x1 + x3 - x2;
        y2 = y1 + y3 - y2;
      }
      [x3, y3, string] = point(svg, string, fontSize);
      if (letter === 'q') {
        x2 += x1;
        y2 += y1;
      }
      if (letter === 'q' || letter === 't') {
        x3 += x1;
        y3 += y1;
      }
      const xq1 = (x2 * 2) / 3 + x1 / 3;
      const yq1 = (y2 * 2) / 3 + y1 / 3;
      const xq2 = (x2 * 2) / 3 + x3 / 3;
      const yq2 = (y2 * 2) / 3 + y3 / 3;
      svg.stream.curveTo(xq1, yq1, xq2, yq2, x3, y3);
      node.vertices.push([0, 0]);
      currentPoint = [x3, y3];
    } else if (letter === 's' || letter === 'S') {
      // Smooth curve
      [x, y] = currentPoint;
      const smooth = inStr(lastLetter, 'csCS');
      const x1 = smooth ? x3 + (x3 - x2) : x;
      const y1 = smooth ? y3 + (y3 - y2) : y;
      [x2, y2, string] = point(svg, string, fontSize);
      [x3, y3, string] = point(svg, string, fontSize);
      if (letter === 's') {
        x2 += x;
        x3 += x;
        y2 += y;
        y3 += y;
      }
      node.vertices.push([Math.atan2(y1 - y2, x1 - x2), Math.atan2(y3 - y2, x3 - x2)]);
      svg.stream.curveTo(x1, y1, x2, y2, x3, y3);
      currentPoint = [x3, y3];
    } else if (letter === 'v' || letter === 'V') {
      // Vertical line
      let yText: string;
      [yText, string] = splitOnce(`${string} `);
      const [oldX, oldY] = currentPoint;
      let yv = svg.point(0, yText, fontSize)[1];
      if (letter === 'v') yv += oldY;
      y = yv;
      const angle = yv > oldY ? Math.PI / 2 : -Math.PI / 2;
      node.vertices.push([Math.PI - angle, angle]);
      svg.stream.lineTo(oldX, yv);
      currentPoint = [oldX, yv];
    } else if ((letter === 'z' || letter === 'Z') && firstPathPoint) {
      // End of path
      node.vertices.push(null);
      svg.stream.close();
      currentPoint = firstPathPoint;
    }

    if (letter !== 'z' && letter !== 'Z') node.vertices.push(currentPoint);

    string = string.trim();
    if (string) {
      const nextLetter = letter === 'm' ? 'l' : letter === 'M' ? 'L' : letter;
      matches.unshift([nextLetter, string]);
    }
    lastLetter = letter;
  }
}

/** Python's math.isclose with default tolerances (rel 1e-9, abs 0). */
function isClose(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}
