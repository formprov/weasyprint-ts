// SPDX-License-Identifier: BSD-3-Clause

/**
 * Grid line and placement helpers (mirrors the first part of weasyprint/layout/grid.py).
 *
 * Conventions: a grid line is a [span, number, ident] array (span is 'span' or null, number and
 * ident may be null) or the keyword 'auto'. Placements are [coord, size] arrays, or null.
 * Python's None is null. Lines are arrays of names per track.
 */
import { LOGGER } from '../logger.ts';

export const isLength = (sizing: any): boolean =>
  sizing !== null && typeof sizing === 'object' && 'value' in sizing && String(sizing.unit).toLowerCase() !== 'fr';

export const isFr = (sizing: any): boolean =>
  sizing !== null && typeof sizing === 'object' && 'value' in sizing && String(sizing.unit).toLowerCase() === 'fr';

/** Python: _intersect. */
export function intersect(position1: number, size1: number, position2: number, size2: number): boolean {
  return position1 < position2 + size2 && position2 < position1 + size1;
}

/** Python: _intersect_with_children. */
export function intersectWithChildren(x: number, y: number, width: number, height: number,
  positions: Array<[number, number, number, number]>): boolean {
  for (const [fullX, fullY, fullWidth, fullHeight] of positions) {
    const xIntersect = intersect(x, width, fullX, fullWidth);
    const yIntersect = intersect(y, height, fullY, fullHeight);
    if (xIntersect && yIntersect) return true;
  }
  return false;
}

/** Python: _get_line. Returns [span, number, ident, coord]. */
export function getLine(line: any[], lines: string[][], side: string): [string | null, number | null, string | null, number | null] {
  const [span, numberIn, ident] = line;
  let number: number | null = numberIn;
  let coord: number | null = null;
  if (ident && span === null && number === null) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      coord = i;
      if (lines[i].includes(`${ident}-${side}`)) {
        found = true;
        break;
      }
    }
    if (!found) number = 1;
  }
  if (number !== null && span === null) {
    if (ident === null) {
      coord = number - 1;
    } else {
      const step = number > 0 ? 1 : -1;
      const ordered = step === 1 ? lines : [...lines].reverse();
      let broke = false;
      for (let i = 0; i < ordered.length; i++) {
        coord = i;
        if (ordered[i].includes(ident)) {
          number -= step;
          broke = true;
          break;
        }
        if (number === 0) {
          broke = true;
          break;
        }
      }
      if (!broke) coord = (coord ?? 0) + Math.abs(number);
      if (step === -1) coord = lines.length - 1 - (coord as number);
    }
  }
  if (span !== null) coord = null;
  return [span, number, ident, coord];
}

/** Python: _get_placement. Returns [coord, size] or null. */
export function getPlacement(start: any, end: any, lines: string[][]): [number, number] | null {
  // Input coordinates are 1-indexed, returned coordinates are 0-indexed.
  if (start === 'auto' || start[0] === 'span') {
    if (end === 'auto' || end[0] === 'span') return null;
  }
  let size = 1;
  let spanIdent: string | null = null;
  let coord: number | null = null;
  if (start !== 'auto') {
    const [span, number, ident, c] = getLine(start, lines, 'start');
    coord = c;
    if (span !== null) {
      size = number || 1;
      spanIdent = ident;
    }
  } else {
    size = 1;
    spanIdent = null;
    coord = null;
  }
  if (end !== 'auto') {
    const [span, number0, ident, coordEnd] = getLine(end, lines, 'end');
    let number: number | null = number0;
    if (span !== null) {
      let spanNumber = number || 1;
      size = spanNumber;
      spanIdent = ident;
      if (spanIdent !== null) {
        let found = false;
        for (let i = 0; i < lines.slice((coord as number) + 1).length; i++) {
          size = i + 1;
          if (lines[(coord as number) + 1 + i].includes(spanIdent)) spanNumber -= 1;
          if (spanNumber === 0) {
            found = true;
            break;
          }
        }
        if (!found) size += spanNumber;
      }
    } else if (coord !== null) {
      size = (coordEnd as number) - coord;
    }
    if (coord === null) {
      if (spanIdent === null) {
        coord = (coordEnd as number) - size;
      } else {
        number = number || 1;
        if ((coordEnd as number) > 0) {
          const reversed = lines.slice(0, coordEnd as number).reverse();
          let found = false;
          for (let i = 0; i < reversed.length; i++) {
            coord = i;
            if (reversed[i].includes(spanIdent)) number -= 1;
            if (number === 0) {
              coord = (coordEnd as number) - 1 - i;
              found = true;
              break;
            }
          }
          if (!found) coord = -(number as number);
        } else {
          coord = -(number as number);
        }
      }
      size = (coordEnd as number) - (coord as number);
    }
  } else {
    size = 1;
  }
  if (size < 0) {
    size = -size;
    coord = (coord as number) - size;
  }
  if (size === 0) size = 1;
  return [coord as number, size];
}

/** Python: _get_span. */
export function getSpan(place: any): number {
  // TODO: Handle lines.
  let span = 1;
  if (place[0] === 'span') span = place[1] || 1;
  return span;
}


/** Python: _get_second_placement. first_placement is [start, size]; children_positions values are [x, y, w, h]. */
export function getSecondPlacement(firstPlacement: [number, number], secondStart: any, secondEnd: any,
  secondTracks: string[][], childrenPositions: Array<[number, number, number, number]>,
  firstFlow: string, dense: boolean): [number, number] | null {
  const occupied = new Set<number>();
  for (const [x, y, width, height] of childrenPositions) {
    // Test whether cells overlap.
    if (firstFlow === 'row') {
      if (intersect(y, height, firstPlacement[0], firstPlacement[1])) {
        for (let xx = x; xx < x + width; xx++) occupied.add(xx);
      }
    } else if (intersect(x, width, firstPlacement[0], firstPlacement[1])) {
      for (let yy = y; yy < y + height; yy++) occupied.add(yy);
    }
  }
  if (dense) {
    for (let track = 0; ; track++) {
      if (occupied.has(track)) continue;
      let placement: [number, number] | null;
      if (secondStart === 'auto') {
        placement = getPlacement([null, track + 1, null], secondEnd, secondTracks);
      } else {
        // If the placement contains two spans, remove the one contributed by the end grid-placement property.
        const span = getSpan(secondStart);
        placement = getPlacement(secondStart, [null, track + 1 + span, null], secondTracks);
      }
      if (placement === null) continue;
      let clash = false;
      for (let t = placement[0]; t < placement[0] + placement[1]; t++) {
        if (occupied.has(t)) {
          clash = true;
          break;
        }
      }
      if (!clash) return placement;
    }
  }
  const track = (occupied.size ? Math.max(...occupied) : 0) + 1;
  if (secondStart === 'auto') {
    return getPlacement([null, track + 1, null], secondEnd, secondTracks);
  }
  // If the placement contains two spans, remove the one contributed by the end grid-placement property.
  for (let endTrack = track + 1; ; endTrack++) {
    const placement = getPlacement(secondStart, [null, endTrack + 1, null], secondTracks);
    if (placement !== null && placement[0] >= track) return placement;
  }
}

/** Python: _get_sizing_functions. Returns [min, max] sizing. */
export function getSizingFunctions(size: any): [any, any] {
  let minSizing = size;
  let maxSizing = size;
  if (size[0] === 'minmax()') [, minSizing, maxSizing] = size;
  if (minSizing[0] === 'fit-content()') minSizing = 'auto';
  else if (isFr(minSizing)) minSizing = 'auto';
  return [minSizing, maxSizing];
}

/** Python: _get_template_tracks. Returns the alternating line-name / track-size list (line names are arrays). */
export function getTemplateTracks(tracksIn: any): any[][] {
  let tracks = tracksIn;
  if (tracks === 'none') tracks = [[]];
  if (Array.isArray(tracks) && tracks.includes('subgrid')) {
    // TODO: Support subgrids.
    LOGGER.warning('Subgrids are unsupported');
    return [[]];
  }
  const tracksList: any[][] = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    if (i % 2) {
      // Track size.
      if (Array.isArray(track) && track[0] === 'repeat()') {
        let repeatNumber = track[1];
        const repeatTrackList: any[] = track[2];
        if (typeof repeatNumber !== 'number') {
          // TODO: Respect auto-fit and auto-fill.
          LOGGER.warning('"auto-fit" and "auto-fill" are unsupported in repeat()');
          repeatNumber = 1;
        }
        for (let r = 0; r < repeatNumber; r++) {
          for (let j = 0; j < repeatTrackList.length; j++) {
            const repeatTrack = repeatTrackList[j];
            if (j % 2) {
              // Track size in repeat.
              tracksList.push(repeatTrack);
            } else if (tracksList.length % 2) {
              // Line names in repeat.
              tracksList[tracksList.length - 1].push(...repeatTrack);
            } else tracksList.push([...repeatTrack]);
          }
        }
      } else {
        tracksList.push(track);
      }
    } else if (tracksList.length % 2) {
      // Line names.
      tracksList[tracksList.length - 1].push(...track);
    } else tracksList.push([...track]);
  }
  return tracksList;
}

// --- Track sizing (weasyprint/layout/grid.py _distribute_extra_space) --------------------------

import { blockLevelLayout } from './block.ts';
import { maxContentWidth, minContentWidth } from './preferred.ts';

/** Python: _distribute_extra_space. Mutates tracks_sizes ([base, growth] per track) in place. */
export function distributeExtraSpace(affectedSizes: 'min' | 'max', affectedTracksTypes: string,
  sizeContribution: string, tracksChildren: Array<Array<[any, any]>>, sizingFunctions: any[][],
  tracksSizes: number[][], span: number, direction: string, context: any): void {
  // 1. Maintain separately for each affected track a planned increase.
  const plannedIncreases: number[] = new Array(tracksSizes.length).fill(0);

  // 2. Distribute space.
  const affectedTracks: boolean[] = [];
  const affectedSizeIndex = affectedSizes === 'min' ? 0 : 1;
  let currentSpan = 0;
  for (let t = 0; t < tracksChildren.length; t++) {
    const children = tracksChildren[t];
    const functions = sizingFunctions[t];
    if (children.length) currentSpan = span;
    if (!currentSpan) {
      affectedTracks.push(false);
      continue;
    }
    currentSpan -= 1;
    const fn = functions[affectedSizeIndex];
    let affected = false;
    if (affectedTracksTypes === 'intrinsic') {
      affected = ['min-content', 'max-content', 'auto'].includes(fn) || (Array.isArray(fn) && fn[0] === 'fit-content()');
    } else if (affectedTracksTypes === 'content-based') {
      affected = ['min-content', 'max-content'].includes(fn);
    } else if (affectedTracksTypes === 'max-content') {
      affected = ['max-content', 'auto'].includes(fn);
    }
    affectedTracks.push(affected);
  }

  for (let i = 0; i < tracksChildren.length; i++) {
    const children = tracksChildren[i];
    if (!children.length) continue;
    for (const [itemIn, parent] of children) {
      // 2.1 Find the space distribution.
      let space: number;
      if (direction === 'x') {
        space = sizeContribution === 'minimum' || sizeContribution === 'min-content'
          ? minContentWidth(context, itemIn) : maxContentWidth(context, itemIn);
      } else {
        const item = itemIn.deepcopy();
        item.positionX = 0;
        item.positionY = 0;
        const result: any[] = blockLevelLayout(context, item, -Infinity, null, parent, true, [], [], []) as any;
        space = result[0].marginHeight();
      }
      for (let k = i; k < Math.min(i + span, tracksSizes.length); k++) space -= tracksSizes[k][affectedSizeIndex];
      space = Math.max(0, space);

      // 2.2 Distribute space up to limits.
      const tracksNumbers: Array<[number, boolean]> = [];
      for (let k = i; k < Math.min(i + span, affectedTracks.length); k++) tracksNumbers.push([k, affectedTracks[k]]);
      const itemIncurredIncreases: number[] = new Array(sizingFunctions.length).fill(0);
      const affectedTracksNumbers = tracksNumbers.filter(([, a]) => a).map(([j]) => j);
      let distributedSpace = space / (affectedTracksNumbers.length || 1);
      for (const trackNumber of affectedTracksNumbers) {
        const [, growthLimit] = tracksSizes[trackNumber];
        void growthLimit;
        let itemIncurredIncrease = distributedSpace;
        const affectedSize = tracksSizes[trackNumber][affectedSizeIndex];
        const limit = tracksSizes[trackNumber][1];
        if (affectedSize + itemIncurredIncrease >= limit) {
          const extra = itemIncurredIncrease + affectedSize - limit;
          itemIncurredIncrease -= extra;
        }
        space -= itemIncurredIncrease;
        itemIncurredIncreases[trackNumber] = itemIncurredIncrease;
      }

      // 2.3 Distribute space to non-affected tracks.
      if (space && affectedTracksNumbers.length) {
        const unaffectedTracksNumbers = tracksNumbers.filter(([, a]) => !a).map(([j]) => j);
        distributedSpace = space / (unaffectedTracksNumbers.length || 1);
        for (const trackNumber of unaffectedTracksNumbers) {
          let itemIncurredIncrease = distributedSpace;
          const affectedSize = tracksSizes[trackNumber][affectedSizeIndex];
          const limit = tracksSizes[trackNumber][1];
          if (affectedSize + itemIncurredIncrease >= limit) {
            const extra = itemIncurredIncrease + affectedSize - limit;
            itemIncurredIncrease -= extra;
          }
          space -= itemIncurredIncrease;
          itemIncurredIncreases[trackNumber] = itemIncurredIncrease;
        }
      }
      // 2.4 Distribute space beyond limits.
      // TODO: Distribute space beyond limits (as in the reference).

      // 2.5. Set the track's planned increase.
      for (let k = 0; k < itemIncurredIncreases.length; k++) {
        const extra = itemIncurredIncreases[k];
        if (extra > plannedIncreases[k]) plannedIncreases[k] = extra;
      }
    }
  }

  // 3. Update the tracks' affected size.
  for (let t = 0; t < affectedTracks.length; t++) {
    if (!affectedTracks[t]) continue;
    const trackSizes = tracksSizes[t];
    const increase = plannedIncreases[t];
    if (affectedSizes === 'max' && trackSizes[1] === Infinity) trackSizes[1] = trackSizes[0] + increase;
    else trackSizes[affectedSizeIndex] += increase;
  }
}
