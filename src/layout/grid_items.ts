// SPDX-License-Identifier: BSD-3-Clause

/**
 * Grid item placement (mirrors the placement part of weasyprint/layout/grid.py grid_layout,
 * sections 1.1 to 1.4 and the implicit track setup).
 *
 * Python's `for ... else` and `continue`/`break` are reproduced with explicit flags. Child
 * positions are a Map child -> [x, y, width, height] (insertion-ordered, like the reference dict).
 */
import { getPlacement, getSecondPlacement, getSpan, intersectWithChildren } from './grid_placement.ts';

export type Pos = [number, number, number, number];

/** Python: itertools.cycle over a list, as used for auto track sizes. */
export class Cycle<T> {
  private items: T[];
  private index = 0;
  constructor(items: T[]) {
    this.items = items;
  }
  next(): T {
    if (!this.items.length) throw new Error('StopIteration');
    const value = this.items[this.index % this.items.length];
    this.index += 1;
    return value;
  }
}

export interface PlacementInput {
  children: any[];
  gridAreas: Array<Array<string | null>>;
  flow: string[];
  rows: any[][];
  columns: any[][];
  autoRows: Cycle<any>;
  autoColumns: Cycle<any>;
}

export interface PlacementResult {
  childrenPositions: Map<any, Pos>;
  implicitFirst1: number;
  implicitFirst2: number;
  implicitSecond1: number;
  implicitSecond2: number;
  firstFlow: string;
  secondFlow: string;
}

/** Positions of the given children, as Python's dict.values(). */
const values = (positions: Map<any, Pos>): Array<[number, number, number, number]> => [...positions.values()];

/** Python: `_get_placement` on the placement of a grid item along the given axis (names are every other track). */
const even = (tracks: any[][]): string[][] => tracks.filter((_, i) => i % 2 === 0) as string[][];

/** Python: `second_start[0] == 'span'` guarded by `!= 'auto'`. */
const isSpan = (line: any): boolean => line !== 'auto' && Array.isArray(line) && line[0] === 'span';

export function placeGridItems(input: PlacementInput): PlacementResult {
  const { gridAreas, flow, rows, columns, autoRows, autoColumns } = input;
  const firstFlow = flow.includes('column') ? 'column' : 'row'; // auto flow axis
  const secondFlow = flow.includes('column') ? 'row' : 'column'; // other axis
  const dense = flow.includes('dense');
  const firstTracks = firstFlow === 'row' ? rows : columns;
  const secondTracks = secondFlow === 'row' ? rows : columns;
  const childrenPositions = new Map<any, Pos>();
  const children = input.children;

  // 1.1 Position anything that's not auto-positioned.
  for (const child of children) {
    const columnStart = child.style.get('grid_column_start');
    const columnEnd = child.style.get('grid_column_end');
    const rowStart = child.style.get('grid_row_start');
    const rowEnd = child.style.get('grid_row_end');
    const columnPlacement = getPlacement(columnStart, columnEnd, even(columns));
    const rowPlacement = getPlacement(rowStart, rowEnd, even(rows));
    if (columnPlacement && rowPlacement) {
      const [x, width] = columnPlacement;
      const [y, height] = rowPlacement;
      childrenPositions.set(child, [x, y, width, height]);
    }
  }

  // 1.2 Process the items locked to a given row (resp. column).
  for (const child of children) {
    if (childrenPositions.has(child)) continue;
    const firstStart = child.style.get(`grid_${firstFlow}_start`);
    const firstEnd = child.style.get(`grid_${firstFlow}_end`);
    const firstPlacement = getPlacement(firstStart, firstEnd, even(firstTracks));
    if (!firstPlacement) continue;
    const secondStart = child.style.get(`grid_${secondFlow}_start`);
    const secondEnd = child.style.get(`grid_${secondFlow}_end`);
    const secondPlacement = getSecondPlacement(firstPlacement, secondStart, secondEnd, even(secondTracks),
      values(childrenPositions), firstFlow, dense);
    if (secondPlacement === null) continue;
    let x: number;
    let y: number;
    let width: number;
    let height: number;
    if (firstFlow === 'row') {
      [y, height] = firstPlacement;
      [x, width] = secondPlacement;
    } else {
      [x, width] = firstPlacement;
      [y, height] = secondPlacement;
    }
    childrenPositions.set(child, [x, y, width, height]);
  }

  // 1.3 Determine the columns (resp. rows) in the implicit grid.
  // 1.3.1 Start with the columns (resp. rows) from the explicit grid.
  let implicitSecond1 = 0;
  let implicitSecond2 = secondFlow === 'column'
    ? (gridAreas.length ? gridAreas[0].length : 0) : gridAreas.length;
  // 1.3.2 Add columns (resp. rows) to the beginning and end of the implicit grid.
  const remainingGridItems: any[] = [];
  for (const child of children) {
    let i: number;
    let size: number;
    if (childrenPositions.has(child)) {
      const p = childrenPositions.get(child)!;
      if (secondFlow === 'column') [i, , size] = p;
      else [, i, , size] = p;
    } else {
      const secondStart = child.style.get(`grid_${secondFlow}_start`);
      const secondEnd = child.style.get(`grid_${secondFlow}_end`);
      const secondPlacement = getPlacement(secondStart, secondEnd, even(secondTracks));
      remainingGridItems.push(child);
      if (secondPlacement) [i, size] = secondPlacement;
      else continue;
    }
    implicitSecond1 = Math.min(i, implicitSecond1);
    implicitSecond2 = Math.max(i + size, implicitSecond2);
  }
  // 1.3.3 Add columns (resp. rows) to accommodate max track span.
  for (const child of remainingGridItems) {
    const secondStart = child.style.get(`grid_${secondFlow}_start`);
    const secondEnd = child.style.get(`grid_${secondFlow}_end`);
    let span = 1;
    if (isSpan(secondStart)) span = secondStart[1];
    else if (secondEnd !== 'auto' && Array.isArray(secondEnd) && secondEnd[0] === 'span') span = secondEnd[1];
    implicitSecond2 = Math.max(implicitSecond1 + (span || 1), implicitSecond2);
  }

  // 1.4 Position the remaining grid items.
  let implicitFirst1 = 0;
  let implicitFirst2 = firstFlow === 'row'
    ? gridAreas.length : (gridAreas.length ? gridAreas[0].length : 0);
  for (const position of childrenPositions.values()) {
    let i: number;
    let size: number;
    if (firstFlow === 'row') [, i, , size] = position;
    else [i, , size] = position;
    implicitFirst1 = Math.min(i, implicitFirst1);
    implicitFirst2 = Math.max(i + size, implicitFirst2);
  }
  let cursorFirst = implicitFirst1;
  let cursorSecond = implicitSecond1;

  // Helper: the (x, y, width, height) of a placement with the given first and second axis coordinates.
  const toPos = (firstI: number, firstSize: number, secondI: number, secondSize: number): Pos =>
    (firstFlow === 'row'
      ? [secondI, firstI, secondSize, firstSize]
      : [firstI, secondI, firstSize, secondSize]);

  if (dense) {
    for (const child of remainingGridItems) {
      const firstStart = child.style.get(`grid_${firstFlow}_start`);
      const firstEnd = child.style.get(`grid_${firstFlow}_end`);
      const secondStart = child.style.get(`grid_${secondFlow}_start`);
      const secondEnd = child.style.get(`grid_${secondFlow}_end`);
      const secondPlacement = getPlacement(secondStart, secondEnd, even(secondTracks));
      if (secondPlacement) {
        // 1. Set the row (resp. column) position of the cursor.
        cursorFirst = implicitFirst1;
        const [secondI, secondSize] = secondPlacement;
        cursorSecond = secondI;
        // 2. Increment the cursor's row (resp. column) position.
        let firstI = 0;
        let firstSize = 0;
        let pos: Pos = [0, 0, 0, 0];
        for (let counter = cursorFirst; ; counter++) {
          if (firstStart === 'auto') {
            [firstI, firstSize] = getPlacement([null, counter + 1, null], firstEnd, even(firstTracks)) as [number, number];
          } else {
            const span = getSpan(firstStart);
            [firstI, firstSize] = getPlacement(firstStart, [null, counter + 1 + span, null],
              even(firstTracks)) as [number, number];
          }
          if (firstI < cursorFirst) continue;
          let intersected = false;
          for (let r = firstI; r < firstI + firstSize; r++) {
            pos = toPos(firstI, firstSize, secondI, secondSize);
            if (intersectWithChildren(...pos, values(childrenPositions))) {
              intersected = true;
              break;
            }
          }
          if (!intersected) break;
        }
        const firstDiff = firstI + firstSize - implicitFirst2;
        if (firstDiff > 0) implicitFirst2 += firstDiff;
        // 3. Set the item's row-start line.
        pos = toPos(firstI, firstSize, secondI, secondSize);
        childrenPositions.set(child, pos);
      } else {
        // 1. Set the cursor's row and column positions.
        cursorFirst = implicitFirst1;
        cursorSecond = implicitSecond1;
        placeSearch(child, cursorFirst, cursorSecond);
      }
    }
  } else {
    for (const child of remainingGridItems) {
      const firstStart = child.style.get(`grid_${firstFlow}_start`);
      const firstEnd = child.style.get(`grid_${firstFlow}_end`);
      const secondStart = child.style.get(`grid_${secondFlow}_start`);
      const secondEnd = child.style.get(`grid_${secondFlow}_end`);
      const secondPlacement = getPlacement(secondStart, secondEnd, even(secondTracks));
      if (secondPlacement) {
        // 1. Set the column (resp. row) position of the cursor.
        const [secondI, secondSize] = secondPlacement;
        if (secondI < cursorSecond) cursorFirst += 1;
        cursorSecond = secondI;
        // 2. Increment the cursor's row (resp. column) position.
        let firstI = 0;
        let firstSize = 0;
        let pos: Pos = [0, 0, 0, 0];
        for (let counter = cursorFirst; ; counter++) {
          cursorFirst = counter;
          if (firstStart === 'auto') {
            [firstI, firstSize] = getPlacement([null, cursorFirst + 1, null], firstEnd, even(firstTracks)) as [number, number];
          } else {
            // Python reuses the previous first_i here (a reference quirk kept as is).
            const span = getSpan(firstStart);
            [firstI, firstSize] = getPlacement(firstStart, [null, firstI + 1 + span, null],
              even(firstTracks)) as [number, number];
          }
          if (firstI < cursorFirst) continue;
          let intersected = false;
          for (let r = firstI; r < firstI + firstSize; r++) {
            pos = toPos(firstI, firstSize, secondI, secondSize);
            if (intersectWithChildren(...pos, values(childrenPositions))) {
              intersected = true;
              break;
            }
          }
          if (!intersected) break;
        }
        const firstDiff = firstI + firstSize - implicitFirst2;
        if (firstDiff > 0) implicitFirst2 += firstDiff;
        // 3. Set the item's row-start line.
        pos = toPos(firstI, firstSize, secondI, secondSize);
        childrenPositions.set(child, pos);
      } else {
        placeSearchSparse(child);
      }
    }
  }

  /** Python: the `while True` search of a free cell (dense branch, and the sparse branch without a second placement). */
  function placeSearch(child: any, startFirst: number, startSecond: number): void {
    const firstStart = child.style.get(`grid_${firstFlow}_start`);
    const firstEnd = child.style.get(`grid_${firstFlow}_end`);
    const secondStart = child.style.get(`grid_${secondFlow}_start`);
    const secondEnd = child.style.get(`grid_${secondFlow}_end`);
    cursorFirst = startFirst;
    cursorSecond = startSecond;
    for (;;) {
      // 2. Increment the column (resp. row) position of the cursor.
      let firstI = cursorFirst;
      let placed = false;
      for (let secondI0 = cursorSecond; secondI0 < implicitSecond2; secondI0++) {
        let secondI = secondI0;
        let firstSize: number;
        let secondSize: number;
        if (firstStart === 'auto') {
          [firstI, firstSize] = getPlacement([null, firstI + 1, null], firstEnd, even(firstTracks)) as [number, number];
        } else {
          const span = getSpan(firstStart);
          [firstI, firstSize] = getPlacement(firstStart, [null, firstI + 1 + span, null],
            even(firstTracks)) as [number, number];
        }
        if (secondStart === 'auto') {
          [secondI, secondSize] = getPlacement([null, secondI + 1, null], secondEnd,
            even(secondTracks)) as [number, number];
        } else {
          const span = getSpan(secondStart);
          [secondI, secondSize] = getPlacement(secondStart, [null, secondI + 1 + span, null],
            even(secondTracks)) as [number, number];
        }
        const pos = toPos(firstI, firstSize, secondI, secondSize);
        const intersect = intersectWithChildren(...pos, values(childrenPositions));
        const overflow = secondI + secondSize > implicitSecond2;
        if (intersect || overflow) continue;
        // Free place found: 2. Set the item's row-/column-start lines.
        childrenPositions.set(child, pos);
        // The dense search also grows the implicit grid to the placed item (reference quirk: uses the cursor).
        const firstDiff0 = cursorFirst + firstSize - 1 - implicitFirst2;
        if (firstDiff0 > 0) implicitFirst2 += firstDiff0;
        placed = true;
        break;
      }
      if (placed) return;
      // No room found: 2. Return to the previous step.
      cursorFirst += 1;
      const firstDiff = cursorFirst + 1 - implicitFirst2;
      if (firstDiff > 0) implicitFirst2 += firstDiff;
      cursorSecond = implicitSecond1;
    }
  }

  /** Python: the `while True` search of the non-dense branch (no first_diff update on success). */
  function placeSearchSparse(child: any): void {
    const firstStart = child.style.get(`grid_${firstFlow}_start`);
    const firstEnd = child.style.get(`grid_${firstFlow}_end`);
    const secondStart = child.style.get(`grid_${secondFlow}_start`);
    const secondEnd = child.style.get(`grid_${secondFlow}_end`);
    for (;;) {
      // 1. Increment the column position of the cursor.
      let firstI = cursorFirst;
      let placed = false;
      for (let secondI0 = cursorSecond; secondI0 < implicitSecond2; secondI0++) {
        let secondI = secondI0;
        let firstSize: number;
        let secondSize: number;
        if (firstStart === 'auto') {
          [firstI, firstSize] = getPlacement([null, firstI + 1, null], firstEnd, even(firstTracks)) as [number, number];
        } else {
          const span = getSpan(firstStart);
          [firstI, firstSize] = getPlacement(firstStart, [null, firstI + 1 + span, null],
            even(firstTracks)) as [number, number];
        }
        if (secondStart === 'auto') {
          [secondI, secondSize] = getPlacement([null, secondI + 1, null], secondEnd,
            even(secondTracks)) as [number, number];
        } else {
          const span = getSpan(secondStart);
          [secondI, secondSize] = getPlacement(secondStart, [null, secondI + 1 + span, null],
            even(secondTracks)) as [number, number];
        }
        const pos = toPos(firstI, firstSize, secondI, secondSize);
        const intersect = intersectWithChildren(...pos, values(childrenPositions));
        const overflow = secondI + secondSize > implicitSecond2;
        if (intersect || overflow) continue;
        // Free place found: 2. Set the item's row-/column-start lines.
        childrenPositions.set(child, pos);
        placed = true;
        break;
      }
      if (placed) return;
      // No room found: 2. Return to the previous step.
      cursorFirst += 1;
      const firstDiff = cursorFirst + 1 - implicitFirst2;
      if (firstDiff > 0) implicitFirst2 += firstDiff;
      cursorSecond = implicitSecond1;
    }
  }

  return { childrenPositions, implicitFirst1, implicitFirst2, implicitSecond1, implicitSecond2, firstFlow, secondFlow };
}
