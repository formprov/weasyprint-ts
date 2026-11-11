// SPDX-License-Identifier: BSD-3-Clause

/** CSS gradients (the Gradient classes of weasyprint/images.py). */
import { rgba } from './css/color.ts';
import type { RGBA } from './css/color.ts';
import { percentage } from './layout/percent.ts';
import { PdfStream } from './pdf/stream.ts';

type AnyStyle = any;
type Positions = Array<any>;

const PY_ROUND = (x: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};

/** Give color stops positions and hints on the gradient vector. Returns [positions in px, pdf hints]. */
export function processColorStops(vectorLength: number, positions0: Positions, hints0: any[], style: AnyStyle):
  [number[], number[]] {
  // Resolve percentages.
  const positions: Array<number | null> = positions0.map((p) => percentage(p, style, vectorLength) ?? null);
  const hints = hints0.map((h) => percentage(h, style, vectorLength) / vectorLength);

  // First and last default to 100%.
  if (positions[0] === null) positions[0] = 0;
  if (positions[positions.length - 1] === null) positions[positions.length - 1] = vectorLength;

  // Make sure positions are increasing.
  let previousPos = positions[0] as number;
  positions.forEach((position, i) => {
    if (position !== null) {
      if (position < previousPos) positions[i] = previousPos;
      else previousPos = position;
    }
  });

  // Assign missing values.
  let previousI = -1;
  positions.forEach((position, i) => {
    if (position !== null) {
      const base = positions[previousI] as number;
      const increment = (position - base) / (i - previousI);
      for (let j = previousI + 1; j < i; j++) positions[j] = base + j * increment;
      previousI = i;
    }
  });
  const result = positions as number[];

  // Calculate exponential value for PDF hints, avoid big numbers.
  const pdfHints = hints.map((hint0, i) => {
    let hint = hint0;
    if (hint <= 0) hint = 0;
    else if (hint >= 1) hint = 2 ** 32;
    else {
      const before = result[i] / vectorLength;
      const after = result[i + 1] / vectorLength;
      if (before === after || hint >= after || hint <= before) hint = 1;
      else hint = Math.min(2 ** 32, Math.log(0.5) / Math.log((hint - before) / (after - before)));
    }
    return hint;
  });
  return [result, pdfHints];
}

/** Normalize stop positions between 0 and 1. Returns [first, last, positions]. */
export function normalizeStopPositions(positions: number[]): [number, number, number[]] {
  const first = positions[0];
  const last = positions[positions.length - 1];
  const totalLength = last - first;
  const normalized = totalLength === 0 ? positions.map(() => 0) : positions.map((pos) => (pos - first) / totalLength);
  return [first, last, normalized];
}

/** https://drafts.csswg.org/css-images-3/#gradient-average-color */
export function gradientAverageColor(colors: RGBA[], positions0: number[]): RGBA {
  let positions = positions0;
  const nbStops = positions.length;
  let totalLength = positions[nbStops - 1] - positions[0];
  if (totalLength === 0) {
    positions = positions.map((_, i) => i);
    totalLength = nbStops - 1;
  }
  const premulR = colors.map((c) => c.r * c.a);
  const premulG = colors.map((c) => c.g * c.a);
  const premulB = colors.map((c) => c.b * c.a);
  const alpha = colors.map((c) => c.a);
  let resultR = 0, resultG = 0, resultB = 0, resultA = 0;
  const totalWeight = 2 * totalLength;
  for (let i = 1; i < positions.length; i++) {
    const weight = (positions[i] - positions[i - 1]) / totalWeight;
    for (const j of [i - 1, i]) {
      resultR += premulR[j] * weight;
      resultG += premulG[j] * weight;
      resultB += premulB[j] * weight;
      resultA += alpha[j] * weight;
    }
  }
  // Un-premultiply.
  if (resultA === 0) return rgba(0, 0, 0, 0);
  return rgba(resultR / resultA, resultG / resultA, resultB / resultA, resultA);
}

type Layout = [number, string, number[] | null, number[], RGBA[], number[]];

export abstract class Gradient {
  colors: RGBA[];
  stopPositions: Positions;
  colorHints: any[];
  repeating: boolean;

  constructor(colorStops: Array<[RGBA, any]>, repeating: boolean, colorHints: any[]) {
    if (!colorStops.length) throw new Error('no color stops');
    this.colors = colorStops.map(([color]) => color);
    this.stopPositions = colorStops.map(([, position]) => position);
    this.colorHints = colorHints;
    this.repeating = repeating;
  }

  getIntrinsicSize(_imageResolution: number, _fontSize: number): [null, null, null] {
    return [null, null, null];
  }

  draw(stream: PdfStream, concreteWidth: number, concreteHeight: number, style: AnyStyle): void {
    const [scaleY, type, points, positions, colors, colorHints] = this.layout(concreteWidth, concreteHeight, style);

    if (type === 'solid') {
      stream.rectangle(0, 0, concreteWidth, concreteHeight);
      stream.setColor(colors[0]);
      stream.fill();
      return;
    }

    const alphas = colors.map((c) => c.a);
    const alphaCouples = alphas.slice(0, -1).map((a, i) => [a, alphas[i + 1], colorHints[i]]);
    // TODO: handle other color spaces.
    const rgb = (c: RGBA): number[] => [c.r, c.g, c.b];
    const colorCouples = colors.slice(0, -1).map((c, i) => [rgb(c), rgb(colors[i + 1]), colorHints[i]] as [number[], number[], number]);

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

    const shadingType = type === 'linear' ? 2 : 3;
    const domain = [positions[0], positions[positions.length - 1]];
    const extend = !this.repeating;
    const encode: number[] = [];
    for (let i = 0; i < colors.length - 1; i++) encode.push(0, 1);
    const bounds = positions.slice(1, -1);
    const subFunctions = colorCouples.map(([c0, c1, hint]) => PdfStream.createInterpolationFunction([0, 1], c0, c1, hint));
    const fn = PdfStream.createStitchingFunction(domain, encode, bounds, subFunctions);
    const shading = stream.addShading(shadingType, domain, points as number[], extend, fn);
    stream.transform(1, 0, 0, scaleY);

    if (alphas.some((alpha) => alpha !== 1)) {
      const alphaStream = stream.setAlphaState(0, 0, concreteWidth, concreteHeight / scaleY);
      const alphaFns = alphaCouples.map(([c0, c1, hint]) => PdfStream.createInterpolationFunction([0, 1], [c0], [c1], hint));
      const alphaFunction = PdfStream.createStitchingFunction(domain, encode, bounds, alphaFns);
      const alphaShading = alphaStream.addShading(shadingType, domain, points as number[], extend, alphaFunction, 'DeviceGray');
      alphaStream.transform(1, 0, 0, scaleY);
      alphaStream.stream = [`/${alphaShading.id} sh`];
    }

    stream.paintShading(shading.id as string);
  }

  /**
   * Get layout information about the gradient: [scaleY, type, points, positions, colors, hints].
   * 'solid': points null; 'linear': [x0, y0, x1, y1]; 'radial': [cx0, cy0, r0, cx1, cy1, r1].
   */
  abstract layout(width: number, height: number, style: AnyStyle): Layout;
}

export class LinearGradient extends Gradient {
  directionType: string;
  direction: any;

  constructor(colorStops: Array<[RGBA, any]>, direction: [string, any], repeating: boolean, colorHints: any[]) {
    super(colorStops, repeating, colorHints);
    [this.directionType, this.direction] = direction;
  }

  layout(width: number, height: number, style: AnyStyle): Layout {
    // Only one color, render the gradient as a solid color
    if (this.colors.length === 1) return [1, 'solid', null, [], [this.colors[0]], []];

    // Define the (dx, dy) unit vector giving the direction of the gradient. Positive dx: right, positive dy: down.
    let dx: number, dy: number;
    if (this.directionType === 'corner') {
      const [y, x] = (this.direction as string).split('_');
      const factorX = x === 'left' ? -1 : 1;
      const factorY = y === 'top' ? -1 : 1;
      const diagonal = Math.hypot(width, height);
      // Note the direction swap: dx based on height, dy based on width. The gradient line is perpendicular to a diagonal.
      dx = factorX * height / diagonal;
      dy = factorY * width / diagonal;
    } else {
      const angle = this.direction as number; // 0 upwards, then clockwise
      dx = Math.sin(angle);
      dy = -Math.cos(angle);
    }

    // Round dx and dy to avoid floating points errors caused by trigonometry and angle units conversions
    dx = PY_ROUND(dx, 9);
    dy = PY_ROUND(dy, 9);

    // Normalize colors positions
    let colors = [...this.colors];
    const vectorLength = Math.abs(width * dx) + Math.abs(height * dy);
    let [positions, hints] = processColorStops(vectorLength, this.stopPositions, this.colorHints, style);
    if (!this.repeating) {
      // Add explicit colors at boundaries if needed, because PDF doesn't extend color stops that are not displayed
      if (positions[0] === positions[1]) {
        positions.unshift(positions[0] - 1);
        colors.unshift(colors[0]);
        hints.unshift(1);
      }
      if (positions[positions.length - 2] === positions[positions.length - 1]) {
        positions.push(positions[positions.length - 1] + 1);
        colors.push(colors[colors.length - 1]);
        hints.push(1);
      }
    }
    let first: number, last: number;
    [first, last, positions] = normalizeStopPositions(positions);

    if (this.repeating) {
      // Render as a solid color if the first and last positions are equal
      if (first === last) {
        const color = gradientAverageColor(colors, positions);
        return [1, 'solid', null, [], [color], []];
      }

      // Define defined gradient length and steps between positions
      const stopLength = last - first;
      const positionSteps = positions.slice(0, -1).map((p, i) => positions[i + 1] - p);

      // Create cycles used to add colors
      const cycle = <T>(items: T[]): (() => T) => {
        let i = 0;
        return () => items[i++ % items.length];
      };
      const nextSteps = cycle([0, ...positionSteps]);
      const nextColors = cycle(colors);
      const nextHints = cycle(hints);
      const previousSteps = cycle([0, ...[...positionSteps].reverse()]);
      const previousColors = cycle([...colors].reverse());
      const previousHints = cycle([...hints].reverse());
      const origColors = colors;
      void origColors;

      // Add colors after last step
      while (last < vectorLength) {
        const step = nextSteps();
        colors.push(nextColors());
        hints.push(nextHints());
        positions.push(positions[positions.length - 1] + step);
        last += step * stopLength;
      }

      // Add colors before first step
      while (first > 0) {
        const step = previousSteps();
        colors.unshift(previousColors());
        hints.unshift(previousHints());
        positions.unshift(positions[0] - step);
        first -= step * stopLength;
      }
    }

    // Define the coordinates of the starting and ending points
    const startX = (width - dx * vectorLength) / 2;
    const startY = (height - dy * vectorLength) / 2;
    const points = [startX + dx * first, startY + dy * first, startX + dx * last, startY + dy * last];
    colors = [...colors];
    return [1, 'linear', points, positions, colors, hints];
  }
}

export class RadialGradient extends Gradient {
  center: any[];
  shape: string;
  sizeType: string;
  size: any;

  constructor(colorStops: Array<[RGBA, any]>, shape: string, size: [string, any], center: any[], repeating: boolean,
    colorHints: any[]) {
    super(colorStops, repeating, colorHints);
    // Center of the ending shape. (origin_x, pos_x, origin_y, pos_y)
    this.center = center;
    this.shape = shape;
    [this.sizeType, this.size] = size;
  }

  layout(width: number, height: number, style: AnyStyle): Layout {
    // Only one color, render the gradient as a solid color
    if (this.colors.length === 1) return [1, 'solid', null, [], [this.colors[0]], []];

    // Define the center of the gradient
    const [originX, centerX0, originY, centerY0] = this.center;
    let centerX = percentage(centerX0, style, width);
    let centerY = percentage(centerY0, style, height);
    if (originX === 'right') centerX = width - centerX;
    if (originY === 'bottom') centerY = height - centerY;

    // Resolve sizes and vertical scale
    const [sizeX, sizeY] = this.handleDegenerate(...this.resolveSize(width, height, centerX, centerY, style));
    const scaleY = sizeY / sizeX;

    // Normalize colors positions
    let colors = [...this.colors];
    let [positions, hints] = processColorStops(sizeX, this.stopPositions, this.colorHints, style);
    if (!this.repeating) {
      // Add explicit colors at boundaries if needed, because PDF doesn't extend color stops that are not displayed
      if (positions[0] > 0 && positions[0] === positions[1]) {
        positions.unshift(0);
        colors.unshift(colors[0]);
        hints.unshift(1);
      }
      if (positions[positions.length - 2] === positions[positions.length - 1]) {
        positions.push(positions[positions.length - 1] + 1);
        colors.push(colors[colors.length - 1]);
        hints.push(1);
      }
    }
    if (positions[0] < 0) {
      // PDF doesn't like negative radiuses, shift into the positive realm
      if (this.repeating) {
        // Add vector lengths to first position until positive
        const vectorLength = positions[positions.length - 1] - positions[0];
        const offset = vectorLength * (1 + Math.floor(-positions[0] / vectorLength));
        positions = positions.map((position) => position + offset);
      } else {
        // Only keep colors with position >= 0, interpolate if needed
        if (positions[positions.length - 1] <= 0) {
          // All stops are negative, fill with the last color
          return [1, 'solid', null, [], [this.colors[this.colors.length - 1]], []];
        }
        for (let i = 0; i < positions.length; i++) {
          const position = positions[i];
          if (position === 0) {
            // Keep colors and positions from this rank
            colors = colors.slice(i);
            positions = positions.slice(i);
            break;
          }
          if (position > 0) {
            // Interpolate with previous rank to get color at 0
            const color = colors[i];
            const previousColor = colors[i - 1];
            const previousPosition = positions[i - 1];
            const intermediate = gradientAverageColor([previousColor, previousColor, color, color], [previousPosition, 0, 0, position]);
            colors = [intermediate, ...colors.slice(i)];
            positions = [0, ...positions.slice(i)];
            break;
          }
        }
      }
    }
    let first: number, last: number;
    [first, last, positions] = normalizeStopPositions(positions);

    // Render as a solid color if the first and last positions are the same
    if (first === last && this.repeating) {
      const color = gradientAverageColor(colors, positions);
      return [1, 'solid', null, [], [color], []];
    }

    // Define the coordinates of the gradient circles
    let points = [centerX, centerY / scaleY, first, centerX, centerY / scaleY, last];

    if (this.repeating) [points, positions, colors, hints] = this.repeat(width, height, scaleY, points, positions, colors, hints);

    return [scaleY, 'radial', points, positions, colors, hints];
  }

  private repeat(width: number, height: number, scaleY: number, points0: number[], positions0: number[], colors0: RGBA[],
    hints0: number[]): [number[], number[], RGBA[], number[]] {
    let points = points0;
    let positions = positions0;
    let colors = colors0;
    let hints = hints0;
    // Keep original lists and values, they're useful
    const originalColors = [...colors];
    const originalHints = [...hints];
    const originalPositions = [...positions];
    const gradientLength = points[5] - points[2];

    // Get the maximum distance between the center and the corners, to find how many times we have to repeat the colors outside
    const maxDistance = Math.max(
      Math.hypot(width - points[0], height / scaleY - points[1]),
      Math.hypot(width - points[0], -points[1] * scaleY),
      Math.hypot(-points[0], height / scaleY - points[1]),
      Math.hypot(-points[0], -points[1] * scaleY));
    const repeatAfter = Math.ceil((maxDistance - points[5]) / gradientLength);
    if (repeatAfter > 0) {
      // Repeat colors and extrapolate positions
      const repeat = 1 + repeatAfter;
      colors = Array.from({ length: repeat }, () => colors).flat();
      hints = Array.from({ length: repeat }, () => [...hints, 1]).flat().slice(0, -1);
      positions = Array.from({ length: repeat }, (_, i) => positions.map((position) => i + position)).flat();
      points = [...points.slice(0, 5), points[5] + gradientLength * repeatAfter];
    }

    if (points[2] === 0) return [points, positions, colors, hints]; // Inner circle has 0 radius, no need to repeat inside

    // Find how many times we have to repeat the colors inside
    const repeatBefore = points[2] / gradientLength;

    // Set the inner circle size to 0
    points = [...points.slice(0, 2), 0, ...points.slice(3)];

    // Find how many times the whole gradient can be repeated
    const fullRepeat = Math.trunc(repeatBefore);
    if (fullRepeat) {
      // Repeat colors and extrapolate positions
      for (let k = 0; k < fullRepeat; k++) colors = [...colors, ...originalColors];
      for (let k = 0; k < fullRepeat; k++) hints = [...hints, 1, ...originalHints];
      positions = [
        ...Array.from({ length: fullRepeat }, (_, i) => originalPositions.map((position) => i - fullRepeat + position)).flat(),
        ...positions];
    }

    // Find the ratio of gradient that must be added to reach the center
    const partialRepeat = repeatBefore - fullRepeat;
    if (partialRepeat === 0) return [points, positions, colors, hints]; // No partial repeat, return

    // Iterate through positions in reverse order, from the outer circle to the original inner circle
    const reverse = [...originalPositions].reverse();
    const ratio = 1 - partialRepeat;
    for (let i = 1; i <= reverse.length; i++) {
      const position = reverse[i - 1];
      if (position === ratio) {
        // The center is a color of the gradient, truncate original colors and positions and prepend them
        colors = [...originalColors.slice(-i), ...colors];
        hints = [...originalHints.slice(-i), 1, ...hints];
        positions = [...originalPositions.slice(-i).map((p) => p - fullRepeat - 1), ...positions];
        return [points, positions, colors, hints];
      }
      if (position < ratio) {
        // The center is between two colors of the gradient, define the center color as the average of these two
        const color = originalColors[originalColors.length - i];
        const nextColor = originalColors[originalColors.length - (i - 1)];
        const nextPosition = originalPositions[originalPositions.length - (i - 1)];
        const zeroColor = gradientAverageColor([color, color, nextColor, nextColor], [position, ratio, ratio, nextPosition]);
        const tail = i - 1 === 0 ? [] : originalColors.slice(-(i - 1));
        const tailHints = i - 1 === 0 ? [] : originalHints.slice(-(i - 1));
        const tailPositions = i - 1 === 0 ? [] : originalPositions.slice(-(i - 1));
        colors = [zeroColor, ...tail, ...colors];
        hints = [1, ...tailHints, 1, ...hints];
        positions = [ratio - 1 - fullRepeat, ...tailPositions.map((p) => p - 1 - fullRepeat), ...positions];
        return [points, positions, colors, hints];
      }
    }
    return [points, positions, colors, hints];
  }

  /** Resolve circle size of the radial gradient. */
  private resolveSize(width: number, height: number, centerX: number, centerY: number, style: AnyStyle): [number, number] {
    if (this.sizeType === 'explicit') {
      const [sizeX, sizeY] = this.size;
      return [percentage(sizeX, style, width), percentage(sizeY, style, height)];
    }
    const left = Math.abs(centerX);
    const right = Math.abs(width - centerX);
    const top = Math.abs(centerY);
    const bottom = Math.abs(height - centerY);
    const pick = (this.size as string).startsWith('closest') ? Math.min : Math.max;
    if ((this.size as string).endsWith('side')) {
      if (this.shape === 'circle') {
        const sizeXY = pick(left, right, top, bottom);
        return [sizeXY, sizeXY];
      }
      return [pick(left, right), pick(top, bottom)];
    }
    if (this.shape === 'circle') {
      const sizeXY = pick(Math.hypot(left, top), Math.hypot(left, bottom), Math.hypot(right, top), Math.hypot(right, bottom));
      return [sizeXY, sizeXY];
    }
    const corners: Array<[number, number]> = [[left, top], [left, bottom], [right, top], [right, bottom]];
    let best = corners[0];
    for (const c of corners.slice(1)) {
      const better = (this.size as string).startsWith('closest') ? Math.hypot(...c) < Math.hypot(...best) : Math.hypot(...c) > Math.hypot(...best);
      if (better) best = c;
    }
    return [best[0] * Math.sqrt(2), best[1] * Math.sqrt(2)];
  }

  /** https://drafts.csswg.org/css-images-3/#degenerate-radials */
  private handleDegenerate(sizeX: number, sizeY: number): [number, number] {
    if (sizeX === 0 && sizeY === 0) return [1e-7, 1e-7];
    if (sizeX === 0) return [1e-7, 1e7];
    if (sizeY === 0) return [1e7, 1e-7];
    return [sizeX, sizeY];
  }
}