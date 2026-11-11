// SPDX-License-Identifier: BSD-3-Clause

/**
 * SVG gradients (mirrors draw_gradient, spread_linear_gradient and spread_radial_gradient in
 * weasyprint/svg/defs.py). Gradients are painted as a pattern whose content is a shading with
 * stitching functions, like the reference.
 *
 * Python slices and indexes are reproduced by pyIndex/pyTail: a negative index counts from the
 * end, and x[-0:] is the whole list.
 */
import { PdfStream } from '../pdf/stream.ts';
import { gradientAverageColor, normalizeStopPositions } from '../gradients.ts';
import type { RGBA } from '../css/color.ts';
import { Matrix } from '../matrix.ts';
import { EMPTY_BOUNDING_BOX, isValidBoundingBox } from './bounding_box.ts';
import { alphaValue, color, matrix as matrixOf, size, transform } from './utils.ts';
import type { SvgNode, SVG } from './index.ts';

const hypot = Math.hypot;

/** Python: itertools.cycle over a list. */
class Cycle<T> {
  private items: T[];
  private i = 0;
  constructor(items: T[]) {
    this.items = items;
  }
  next(): T {
    const v = this.items[this.i % this.items.length];
    this.i += 1;
    return v;
  }
}

/** Python: x[k] with negative k counting from the end. */
function pyIndex<T>(arr: T[], k: number): T {
  return arr[k < 0 ? arr.length + k : k];
}

/** Python: x[-n:] (n >= 0). For n == 0 this is the whole list. */
function pyTail<T>(arr: T[], n: number): T[] {
  return n === 0 ? arr.slice() : arr.slice(arr.length - n);
}

/** Python: `spread_linear_gradient`. Returns the solid colour, or [positions, colors, coords]. */
export function spreadLinearGradient(spread: string, positionsIn: number[], colorsIn: RGBA[], x1: number, y1: number,
  x2: number, y2: number, boundingBox: number[], matrix: Matrix): { solid: RGBA } | [number[], RGBA[], number[]] {
  let [first, last, positions] = normalizeStopPositions(positionsIn) as [number, number, number[]];
  const colors = [...colorsIn];
  positions = [...positions];

  if (spread === 'repeat' || spread === 'reflect') {
    // Render as a solid color if the first and last positions are equal.
    if (first === last) return { solid: gradientAverageColor(colors, positions) };

    // Define defined gradient length and steps between positions
    const stopLength = last - first;
    const positionSteps: number[] = [];
    for (let i = 0; i < positions.length - 1; i++) positionSteps.push(positions[i + 1] - positions[i]);

    // Create cycles used to add colors
    let nextSteps: Cycle<number>;
    let nextColors: Cycle<RGBA>;
    let previousSteps: Cycle<number>;
    let previousColors: Cycle<RGBA>;
    if (spread === 'repeat') {
      nextSteps = new Cycle([0, ...positionSteps]);
      nextColors = new Cycle(colors);
      previousSteps = new Cycle([0, ...[...positionSteps].reverse()]);
      previousColors = new Cycle([...colors].reverse());
    } else {
      nextSteps = new Cycle([0, ...[...positionSteps].reverse(), 0, ...positionSteps]);
      nextColors = new Cycle([...[...colors].reverse(), ...colors]);
      previousSteps = new Cycle([0, ...positionSteps, 0, ...[...positionSteps].reverse()]);
      previousColors = new Cycle([...colors, ...[...colors].reverse()]);
    }

    // Normalize bounding box
    const [bx1, by1, bw, bh] = boundingBox;
    const [bxa, bxb] = bw > 0 ? [bx1, bx1 + bw] : [bx1 + bw, bx1];
    const [bya, byb] = bh > 0 ? [by1, by1 + bh] : [by1 + bh, by1];

    // Transform gradient vector coordinates
    const [tx1, ty1] = matrix.transformPoint(x1, y1);
    const [tx2, ty2] = matrix.transformPoint(x2, y2);

    // Find the extremities of the repeating vector, by projecting the bounding box corners on the gradient vector
    const xb = tx1;
    const yb = ty1;
    const xv = tx2 - tx1;
    const yv = ty2 - ty1;
    const [xa1, xa2] = tx1 < tx2 ? [bxa, bxb] : [bxb, bxa];
    const [ya1, ya2] = ty1 < ty2 ? [bya, byb] : [byb, bya];
    const minVector = ((xa1 - xb) * xv + (ya1 - yb) * yv) / hypot(xv, yv) ** 2;
    const maxVector = ((xa2 - xb) * xv + (ya2 - yb) * yv) / hypot(xv, yv) ** 2;

    // Add colors after last step
    while (last < maxVector) {
      const step = nextSteps.next();
      colors.push(nextColors.next());
      positions.push(positions[positions.length - 1] + step);
      last += step * stopLength;
    }

    // Add colors before first step
    while (first > minVector) {
      const step = previousSteps.next();
      colors.unshift(previousColors.next());
      positions.unshift(positions[0] - step);
      first -= step * stopLength;
    }
  }

  // Python evaluates both right-hand sides from the original coordinates.
  const newX1 = x1 + (x2 - x1) * first;
  const newX2 = x1 + (x2 - x1) * last;
  const newY1 = y1 + (y2 - y1) * first;
  const newY2 = y1 + (y2 - y1) * last;
  return [positions, colors, [newX1, newY1, newX2, newY2]];
}

/** Python: `spread_radial_gradient`. Returns [positions, colors, coords]. */
export function spreadRadialGradient(spread: string, positionsIn: number[], colorsIn: RGBA[], fx: number, fy: number,
  frIn: number, cx: number, cy: number, rIn: number, width: number, height: number, matrix: Matrix): [number[], RGBA[], number[]] {
  let [first, last, positions] = normalizeStopPositions(positionsIn) as [number, number, number[]];
  let colors = [...colorsIn];
  positions = [...positions];
  let fr = frIn + (rIn - frIn) * first;
  let r = frIn + (rIn - frIn) * last;

  if (spread === 'repeat' || spread === 'reflect') {
    // Keep original lists and values, they're useful
    const originalColors = [...colors];
    const originalPositions = [...positions];

    // Get the maximum distance between the center and the corners, to find how many times we have to repeat the colors outside
    const [tw, th] = matrix.invert.transformPoint(width, height);
    const maxDistance = hypot(Math.max(Math.abs(fx), Math.abs(tw - fx)), Math.max(Math.abs(fy), Math.abs(th - fy)));
    const gradientLength = r - fr;
    const repeatAfter = Math.ceil((maxDistance - r) / gradientLength);
    if (repeatAfter > 0) {
      // Repeat colors and extrapolate positions
      const repeat = 1 + repeatAfter;
      if (spread === 'repeat') {
        const repeated: RGBA[] = [];
        for (let i = 0; i < repeat; i++) repeated.push(...colors);
        colors = repeated;
      } else {
        const reflected: RGBA[] = [];
        for (let i = 0; i < repeat; i++) reflected.push(...(i % 2 ? [...originalColors].reverse() : originalColors));
        colors = reflected;
      }
      const newPositions: number[] = [];
      for (let i = 0; i < repeat; i++) for (const p of positions) newPositions.push(i + p);
      positions = newPositions;
      r += gradientLength * repeatAfter;
    }

    if (fr === 0) {
      // Inner circle has 0 radius, no need to repeat inside, return
      return [positions, colors, [fx, fy, fr, cx, cy, r]];
    }

    // Find how many times we have to repeat the colors inside (uses the length before the outer repeat)
    const repeatBefore = fr / gradientLength;

    // Set the inner circle size to 0
    fr = 0;

    // Find how many times the whole gradient can be repeated
    const fullRepeat = Math.trunc(repeatBefore);
    if (fullRepeat) {
      // Repeat colors and extrapolate positions
      if (spread === 'repeat') {
        for (let i = 0; i < fullRepeat; i++) colors.push(...originalColors);
      } else {
        for (let i = 0; i < fullRepeat; i++) {
          const reverse = (i + repeatAfter) % 2 !== 0;
          colors.push(...(reverse ? [...originalColors].reverse() : originalColors));
        }
      }
      const prefix: number[] = [];
      for (let i = 0; i < fullRepeat; i++) for (const p of originalPositions) prefix.push(i - fullRepeat + p);
      positions = [...prefix, ...positions];
    }

    // Find the ratio of gradient that must be added to reach the center
    const partialRepeat = repeatBefore - fullRepeat;
    if (partialRepeat === 0) {
      // No partial repeat, return
      return [positions, colors, [fx, fy, fr, cx, cy, r]];
    }

    // Iterate through positions in reverse order, from the outer circle to the original inner circle,
    // to find positions from the inner circle (including full repeats) to the center
    const reverse = [...originalPositions].reverse();
    const ratio = 1 - partialRepeat;
    let origColors = originalColors;
    if (spread === 'reflect') origColors = [...originalColors].reverse();
    for (let i = 1; i <= reverse.length; i++) {
      const position = reverse[i - 1];
      if (position === ratio) {
        // The center is a color of the gradient, truncate original colors and positions and prepend them
        colors = [...pyTail(origColors, i), ...colors];
        const newPositions = pyTail(originalPositions, i).map((p) => p - fullRepeat - 1);
        positions = [...newPositions, ...positions];
        break;
      }
      if (position < ratio) {
        // The center is between two colors of the gradient, define the center color as the average of these two
        const colorAt = pyIndex(origColors, -i);
        const nextColor = pyIndex(origColors, -(i - 1));
        const nextPosition = pyIndex(originalPositions, -(i - 1));
        const zeroColor = gradientAverageColor(
          [colorAt, colorAt, nextColor, nextColor], [position, ratio, ratio, nextPosition]);
        colors = [zeroColor, ...pyTail(origColors, i - 1), ...colors];
        const newPositions = pyTail(originalPositions, i - 1).map((p) => p - 1 - fullRepeat);
        positions = [ratio - 1 - fullRepeat, ...newPositions, ...positions];
        break;
      }
    }
  }

  return [positions, colors, [fx, fy, fr, cx, cy, r]];
}

/**
 * Python: `draw_gradient`. Returns whether a fill was set. `opacity` multiplies the stop alphas.
 */
export function drawGradient(svg: SVG, node: SvgNode, gradient: SvgNode, fontSize: number, opacity: number,
  stroke: boolean): boolean {
  let positions: number[] = [];
  let colors: RGBA[] = [];
  for (const child of gradient.children()) {
    const previous = positions.length ? positions[positions.length - 1] : 0;
    positions.push(Math.max(previous, size(child.get('offset'), fontSize, 1)));
    const stopOpacity = alphaValue(child.get('stop-opacity', 1)) * opacity;
    const stopColor = color(child.get('stop-color', 'black'));
    colors.push({ ...stopColor, a: stopColor.a * stopOpacity });
  }

  if (!colors.length) return false;
  if (colors.length === 1) {
    svg.stream.setColor(colors[0]);
    return true;
  }

  const bbox = svg.calculateBoundingBox(node, fontSize, stroke) ?? EMPTY_BOUNDING_BOX;
  if (!isValidBoundingBox(bbox)) return false;
  let bx1: number;
  let by1: number;
  let width: number;
  let height: number;
  let mat: Matrix;
  if (gradient.get('gradientUnits') === 'userSpaceOnUse') {
    [bx1, by1, width, height] = bbox;
    mat = new Matrix();
  } else {
    [bx1, by1, width, height] = [0, 0, 1, 1];
    const [e, f, a, d] = bbox;
    mat = matrixOf({ a, d, e, f });
  }

  const spread: string = gradient.get('spreadMethod', 'pad');
  if (spread === 'repeat' || spread === 'reflect') {
    if (positions[0] > 0) {
      positions = [0, ...positions];
      colors = [colors[0], ...colors];
    }
    if (positions[positions.length - 1] < 1) {
      positions = [...positions, 1];
      colors = [...colors, colors[colors.length - 1]];
    }
  } else {
    // Add explicit colors at boundaries if needed, because PDF doesn't extend color stops that are not displayed
    if (positions[0] === positions[1]) {
      if (gradient.tag === 'radialGradient') positions = [0, ...positions];
      else positions = [positions[0] - 1, ...positions];
      colors = [colors[0], ...colors];
    }
    if (positions[positions.length - 2] === positions[positions.length - 1]) {
      positions = [...positions, positions[positions.length - 1] + 1];
      colors = [...colors, colors[colors.length - 1]];
    }
  }

  let transformMatrix: Matrix | null = null;
  if (gradient.has('gradientTransform')) {
    transformMatrix = transform(gradient.get('gradientTransform'), '0 0', fontSize, svg.normalizedDiagonal);
    mat = transformMatrix.matmul(mat);
  }

  let shadingType: number;
  let coords: number[];
  if (gradient.tag === 'linearGradient') {
    shadingType = 2;
    const x1 = size(gradient.get('x1', 0), fontSize, width);
    const y1 = size(gradient.get('y1', 0), fontSize, height);
    const x2 = size(gradient.get('x2', '100%'), fontSize, width);
    const y2 = size(gradient.get('y2', 0), fontSize, height);
    const res = spreadLinearGradient(spread, positions, colors, x1, y1, x2, y2, bbox, mat);
    if ('solid' in res) {
      svg.stream.setColor(res.solid);
      return true;
    }
    [positions, colors, coords] = res;
  } else {
    shadingType = 3;
    const cxv = size(gradient.get('cx', '50%'), fontSize, width);
    const cyv = size(gradient.get('cy', '50%'), fontSize, height);
    const r = size(gradient.get('r', '50%'), fontSize, hypot(width, height));
    const fxv = size(gradient.get('fx', cxv), fontSize, width);
    const fyv = size(gradient.get('fy', cyv), fontSize, height);
    const fr = size(gradient.get('fr', 0), fontSize, hypot(width, height));
    [positions, colors, coords] = spreadRadialGradient(
      spread, positions, colors, fxv, fyv, fr, cxv, cyv, r, width, height, mat);
  }

  const alphas = colors.map((c) => c.a);
  const alphaCouples: Array<[number, number]> = [];
  for (let i = 0; i < alphas.length - 1; i++) alphaCouples.push([alphas[i], alphas[i + 1]]);
  const rgb = (c: RGBA): number[] => [c.r, c.g, c.b];
  const colorCouples: Array<[number[], number[], number]> = [];
  for (let i = 0; i < colors.length - 1; i++) colorCouples.push([rgb(colors[i]), rgb(colors[i + 1]), 1]);

  // Premultiply colors
  alphas.forEach((alpha, i) => {
    if (alpha === 0) {
      if (i > 0) colorCouples[i - 1][1] = colorCouples[i - 1][0];
      if (i < colors.length - 1) colorCouples[i][0] = colorCouples[i][1];
    }
  });
  alphaCouples.forEach(([a0, a1], i) => {
    if (a0 !== 0 && a1 !== 0 && !(a0 === 1 && a1 === 1)) colorCouples[i][2] = a0 / a1;
  });

  if (transformMatrix !== null) {
    let bx2 = bx1 + width;
    let by2 = by1 + height;
    [bx1, by1] = transformMatrix.invert.transformPoint(bx1, by1);
    [bx2, by2] = transformMatrix.invert.transformPoint(bx2, by2);
    width = bx2 - bx1;
    height = by2 - by1;
    // Ensure that width and height are positive to please some PDF readers
    if (bx1 > bx2) {
      width = -width;
      [bx1, bx2] = [bx2, bx1];
    }
    if (by1 > by2) {
      height = -height;
      [by1, by2] = [by2, by1];
    }
  }

  const pattern = svg.stream.addPattern(bx1, by1, width, height, width, height, mat.matmul(svg.stream.ctm));
  const group = pattern.addGroup(bx1, by1, width, height);

  const domain = [positions[0], positions[positions.length - 1]];
  const extend = spread !== 'repeat' && spread !== 'reflect';
  const encode: number[] = [];
  for (let i = 0; i < colors.length - 1; i++) encode.push(0, 1);
  const bounds = positions.slice(1, -1);
  const subFunctions = colorCouples.map(([c0, c1, n]) => PdfStream.createInterpolationFunction(domain, c0, c1, n));
  const fn = PdfStream.createStitchingFunction(domain, encode, bounds, subFunctions);
  const shading = group.addShading(shadingType, domain, coords, extend, fn);

  if (alphas.some((alpha) => alpha !== 1)) {
    const alphaStream = group.setAlphaState(bx1, by1, width, height);
    const alphaFns = alphaCouples.map(([c0, c1]) => PdfStream.createInterpolationFunction([0, 1], [c0], [c1], 1));
    const alphaFunction = PdfStream.createStitchingFunction(domain, encode, bounds, alphaFns);
    const alphaShading = alphaStream.addShading(shadingType, domain, coords, extend, alphaFunction, 'DeviceGray');
    alphaStream.stream = [`/${alphaShading.id} sh`];
  }

  group.paintShading(shading.id as string);
  pattern.setAlpha(1);
  pattern.drawXObject(group.id);
  svg.stream.setColorSpace('Pattern', stroke);
  svg.stream.setColorSpecial(pattern.id, stroke);
  return true;
}
