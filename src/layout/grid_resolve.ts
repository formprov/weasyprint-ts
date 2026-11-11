// SPDX-License-Identifier: BSD-3-Clause

/**
 * Track size resolution (mirrors weasyprint/layout/grid.py _resolve_tracks_sizes).
 *
 * The reference contains two typos that this port keeps on purpose, because they decide the
 * output: the 'max_content' and 'fit_content()' comparisons in the y and span branches never
 * match. They are marked TYPO below.
 */
import { BlockContainerBox } from '../formatting_structure/boxes.ts';
import { percentage, resolvePercentages } from './percent.ts';
import { blockLevelLayout } from './block.ts';
import { maxContentWidth, minContentWidth } from './preferred.ts';
import { distributeExtraSpace, isFr, isLength } from './grid_placement.ts';

const INF = Infinity;

/** Python's ``x[0]`` on a sizing value: strings index characters, tuples index items, Dimensions index their value. */
function first(x: any): any {
  if (Array.isArray(x)) return x[0];
  if (typeof x === 'string') return x[0];
  if (x !== null && typeof x === 'object' && 'value' in x) return x.value;
  return undefined;
}

/** Python: `set(value)`: a string is a set of characters, a tuple a set of items. */
const pySet = (value: any): Set<any> => new Set(typeof value === 'string' ? [...value] : value);

/**
 * Python: _resolve_tracks_sizes. Returns [base, growth] per track.
 * `childrenPositions` maps child box -> [x, y, width, height] (Python dict order is insertion order).
 */
export function resolveTracksSizes(sizingFunctions: any[][], boxSize: any, childrenPositions: Map<any, number[]>,
  implicitStart: number, direction: string, gap: number, context: any, containingBlock: any,
  orthogonalSizes: number[] | null = null): number[][] {
  const tracksSizes: Array<[number | null, number | null]> = [];
  // TODO: Check that auto box size is 0 for percentages.
  const percentBoxSize = boxSize === 'auto' ? 0 : boxSize;

  // 1.1 Initialize track sizes.
  for (const [minFunction, maxFunction] of sizingFunctions) {
    let baseSize: number | null = null;
    if (isLength(minFunction)) {
      baseSize = percentage(minFunction, containingBlock.style, percentBoxSize);
    } else if (['min-content', 'max-content', 'auto'].includes(minFunction) || first(minFunction) === 'fit-content()') {
      baseSize = 0;
    }
    let growthLimit: number | null = null;
    if (isLength(maxFunction)) {
      growthLimit = percentage(maxFunction, containingBlock.style, percentBoxSize);
    } else if (['min-content', 'max-content', 'auto'].includes(maxFunction) || first(maxFunction) === 'fit-content()'
      || isFr(maxFunction)) {
      growthLimit = INF;
    }
    if (baseSize !== null && growthLimit !== null) growthLimit = Math.max(baseSize, growthLimit);
    tracksSizes.push([baseSize, growthLimit]);
  }

  // 1.2 Resolve intrinsic track sizes.
  // 1.2.1 Shim baseline-aligned items.
  // TODO: Shim items.
  // 1.2.2 Size tracks to fit non-spanning items.
  let tracksChildren: any[][] = tracksSizes.map(() => []);
  for (const [child, [x, y, width, height]] of childrenPositions) {
    const [coord, size] = direction === 'x' ? [x, width] : [y, height];
    if (size !== 1) continue;
    tracksChildren[coord - implicitStart].push(child);
  }
  for (let t = 0; t < tracksSizes.length; t++) {
    const children = tracksChildren[t];
    const [minFunction, maxFunction] = sizingFunctions[t];
    const sizes = tracksSizes[t];
    if (!children.length) continue;
    if (direction === 'y') {
      // TODO: Find a better way to get height.
      let height = 0;
      for (let child of children) {
        const [x, , width0] = childrenPositions.get(child)!;
        const width = orthogonalSizes!.slice(x, x + width0).reduce((a, b) => a + b, 0);
        child = child.deepcopy();
        child.positionX = 0;
        child.positionY = 0;
        const parent = BlockContainerBox.anonymousFrom(containingBlock, []);
        resolvePercentages(parent, containingBlock);
        parent.positionX = child.positionX;
        parent.positionY = child.positionY;
        parent.width = width;
        parent.height = height;
        const result: any[] = blockLevelLayout(context, child, -INF, null, parent, true, [], [], []) as any;
        child = result[0];
        height = Math.max(height, child.marginHeight());
      }
      // TYPO: the reference compares with 'max_content' (underscore), so only 'min-content' and 'auto' match.
      if (['min-content', 'auto'].includes(minFunction)) sizes[0] = height;
      if (['min-content'].includes(maxFunction)) sizes[1] = height;
      if (sizes[0] !== null && sizes[1] !== null) sizes[1] = Math.max(sizes[0], sizes[1]);
      continue;
    }
    if (minFunction === 'min-content') {
      sizes[0] = Math.max(0, ...children.map((child) => minContentWidth(context, child)));
    } else if (minFunction === 'max-content') {
      sizes[0] = Math.max(0, ...children.map((child) => maxContentWidth(context, child)));
    } else if (minFunction === 'auto') {
      // TODO: Handle min-/max-content constrained parents.
      // TODO: Use real "minimum contributions".
      sizes[0] = Math.max(0, ...children.map((child) => minContentWidth(context, child)));
    }
    if (maxFunction === 'min-content') {
      sizes[1] = Math.max(...children.map((child) => minContentWidth(context, child)));
    } else if (['auto', 'max-content'].includes(maxFunction) || first(maxFunction) === 'fit_content()') {
      // TYPO: the reference checks 'fit_content()' (underscore) for the fit-content case.
      sizes[1] = Math.max(...children.map((child) => maxContentWidth(context, child)));
    }
    if (sizes[0] !== null && sizes[1] !== null) sizes[1] = Math.max(sizes[0], sizes[1]);
  }

  // 1.2.3 Increase sizes to accommodate items spanning content-sized tracks.
  const spanValues = new Set<number>();
  for (const [, [, , width, height]] of childrenPositions) {
    const v = direction === 'x' ? width : height;
    if (v >= 2) spanValues.add(v);
  }
  const spans = [...spanValues].sort((a, b) => a - b);
  for (const span of spans) {
    tracksChildren = sizingFunctions.map(() => []);
    let i = -1;
    for (const [child, [x, y, width, height]] of childrenPositions) {
      i += 1;
      const [coord, size] = direction === 'x' ? [x, width] : [y, height];
      if (size !== span) continue;
      let spanHasFr = false;
      for (let k = i; k < Math.min(i + span + 1, sizingFunctions.length); k++) {
        if (isFr(sizingFunctions[k][1])) {
          spanHasFr = true;
          break;
        }
      }
      if (!spanHasFr) {
        const parent = BlockContainerBox.anonymousFrom(containingBlock, []);
        resolvePercentages(parent, containingBlock);
        if (direction === 'y') parent.width = orthogonalSizes!.slice(x, x + width).reduce((a, b) => a + b, 0);
        tracksChildren[coord - implicitStart].push([child, parent]);
      }
    }
    // 1.2.3.1 For intrinsic minimums.
    // TODO: Respect min-/max-content constraint.
    distributeExtraSpace('min', 'intrinsic', 'minimum', tracksChildren, sizingFunctions, tracksSizes as any,
      span, direction, context);
    // 1.2.3.2 For content-based minimums.
    distributeExtraSpace('min', 'content-based', 'min-content', tracksChildren, sizingFunctions, tracksSizes as any,
      span, direction, context);
    // 1.2.3.3 For max-content minimums.
    // TODO: Respect max-content constraint.
    distributeExtraSpace('min', 'max-content', 'max-content', tracksChildren, sizingFunctions, tracksSizes as any,
      span, direction, context);
    // 1.2.3.4 Increase growth limit.
    // TODO: Increase growth limit.
    // 1.2.3.5 For intrinsic maximums.
    distributeExtraSpace('max', 'intrinsic', 'min-content', tracksChildren, sizingFunctions, tracksSizes as any,
      span, direction, context);
    // 1.2.3.6 For max-content maximums.
    distributeExtraSpace('max', 'max-content', 'max-content', tracksChildren, sizingFunctions, tracksSizes as any,
      span, direction, context);
  }

  // 1.2.4 Increase sizes to accommodate items spanning flexible tracks.
  // TODO: Support spans for flexible tracks.
  // 1.2.5 Fix infinite growth limits.
  for (const sizes of tracksSizes) {
    if (sizes[1] === INF) sizes[1] = sizes[0];
  }

  // 1.3 Maximize tracks.
  const sizes0 = tracksSizes as number[][];
  let freeSpace: number | null;
  if (boxSize === 'auto') {
    freeSpace = null;
  } else {
    freeSpace = boxSize - sizes0.reduce((acc, s) => acc + s[0], 0) - (sizes0.length - 1) * gap;
  }
  if (freeSpace !== null && freeSpace > 0) {
    const distributedFreeSpace = freeSpace / sizes0.length;
    for (const sizes of sizes0) {
      const [baseSize, growthLimit] = sizes;
      if (baseSize + distributedFreeSpace > growthLimit) {
        sizes[0] = growthLimit;
        freeSpace -= growthLimit - baseSize;
      } else {
        sizes[0] += distributedFreeSpace;
        freeSpace -= distributedFreeSpace;
      }
    }
  }
  // TODO: Respect max-width/-height.

  // 1.4 Expand flexible tracks.
  const inflexibleTracks = new Set<number>();
  let flexFraction: number;
  let hypotheticalFrSize = 0;
  if (freeSpace !== null && freeSpace <= 0) {
    // TODO: Respect min-content constraint.
    flexFraction = 0;
  } else if (freeSpace !== null) {
    let stop = false;
    while (!stop) {
      let leftoverSpace = freeSpace;
      let flexFactorSum = 0;
      for (let i = 0; i < sizes0.length; i++) {
        const maxFunction = sizingFunctions[i][1];
        if (isFr(maxFunction)) {
          leftoverSpace += sizes0[i][0];
          if (!inflexibleTracks.has(i)) flexFactorSum += maxFunction.value;
        }
      }
      flexFactorSum = Math.max(1, flexFactorSum);
      hypotheticalFrSize = leftoverSpace / flexFactorSum;
      stop = true;
      for (let i = 0; i < sizes0.length; i++) {
        const maxFunction = sizingFunctions[i][1];
        if (!inflexibleTracks.has(i) && isFr(maxFunction)) {
          if (hypotheticalFrSize * maxFunction.value < sizes0[i][0]) {
            inflexibleTracks.add(i);
            freeSpace -= sizes0[i][0];
            stop = freeSpace > 0;
          }
        }
      }
    }
    flexFraction = hypotheticalFrSize;
  } else {
    flexFraction = 0;
    for (let i = 0; i < sizes0.length; i++) {
      const maxFunction = sizingFunctions[i][1];
      if (isFr(maxFunction)) {
        if (maxFunction.value > 1) flexFraction = Math.max(flexFraction, maxFunction.value * sizes0[i][0]);
        else flexFraction = Math.max(flexFraction, sizes0[i][0]);
      }
    }
    // TODO: Respect grid items max-content contribution.
    // TODO: Respect min-* constraint.
  }
  for (let i = 0; i < sizes0.length; i++) {
    const maxFunction = sizingFunctions[i][1];
    if (isFr(maxFunction) && !inflexibleTracks.has(i)) {
      if (flexFraction * maxFunction.value > sizes0[i][0]) {
        if (freeSpace !== null) freeSpace -= flexFraction * maxFunction.value;
        sizes0[i][0] = flexFraction * maxFunction.value;
      }
    }
  }

  // 1.5 Expand stretched auto tracks.
  const justifyContent = pySet(containingBlock.style.get('justify_content'));
  const alignContent = pySet(containingBlock.style.get('align_content'));
  const xStretch = direction === 'x' && ['normal', 'stretch'].some((k) => justifyContent.has(k));
  const yStretch = direction === 'y' && ['normal', 'stretch'].some((k) => alignContent.has(k));
  if ((xStretch || yStretch) && freeSpace !== null && freeSpace > 0) {
    const autoTracksSizes = sizes0.filter((_, i) => sizingFunctions[i][0] === 'auto');
    if (autoTracksSizes.length) {
      const distributedFreeSpace = freeSpace / autoTracksSizes.length;
      for (const sizes of autoTracksSizes) sizes[0] += distributedFreeSpace;
    }
  }

  return sizes0;
}
