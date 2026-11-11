// SPDX-License-Identifier: BSD-3-Clause

/**
 * Layout for grid containers and grid-items (mirrors weasyprint/layout/grid.py grid_layout).
 *
 * Helpers live in grid_placement.ts (line lookup, placement, track sizing) and grid_items.ts
 * (item placement). Pagination follows the reference: skip stacks are objects keyed by row, and
 * per-row advancements live on the box (box.advancements, keyed "x,y").
 */
import { BlockContainerBox, GridBox, InlineGridBox } from '../formatting_structure/boxes.ts';
import { dim } from '../css/properties.ts';
import { LOGGER } from '../logger.ts';
import { percentage, resolvePercentages } from './percent.ts';
import { blockLevelLayout, blockLevelWidth, relativePositioning } from './block.ts';
import { absoluteLayout } from './absolute.ts';
import { maxContentWidth } from './preferred.ts';
import { findInFlowBaseline } from './table.ts';
import { getSpan, getTemplateTracks, getSizingFunctions } from './grid_placement.ts';
import { resolveTracksSizes } from './grid_resolve.ts';
import { Cycle, placeGridItems, type Pos } from './grid_items.ts';

type AnyBox = any;

const INF = Infinity;

/** Python: set(value): a string is a set of characters, a tuple a set of items. */
const pySet = (value: any): Set<any> => new Set(typeof value === 'string' ? [...value] : value);

/** Python: `set & {...}` is truthy when the intersection is non-empty. */
const anyOf = (set: Set<any>, names: string[]): boolean => names.some((n) => set.has(n));

/** Advancements are keyed by [x, y] tuples in Python; here by "x,y" strings. */
const advKey = (x: number, y: number): string => `${x},${y}`;

/** Python: _get_span on a row-start/end line. */
const rowSpan = (line: any): number => getSpan(line);

export function gridLayout(
  context: any, box: AnyBox, bottomSpace: number, skipStack: any, containingBlock: AnyBox, pageIsEmpty: boolean,
  absoluteBoxesIn: AnyBox[], fixedBoxes: AnyBox[],
): any[] {
  let absoluteBoxes = absoluteBoxesIn;
  context.createBlockFormattingContext(box);

  if (skipStack && box.style.get('box_decoration_break') !== 'clone') box.removeDecoration(true, false);

  if (box.style.get('position') === 'relative') {
    // New containing block, use a new absolute list
    absoluteBoxes = [];
  }
  if (!(box.advancements instanceof Map)) box.advancements = new Map<string, number>();
  const advancements: Map<string, number> = box.advancements;

  // Define explicit grid
  let gridAreas: Array<Array<string | null>> = box.style.get('grid_template_areas') as any;
  const flow: string[] = box.style.get('grid_auto_flow');
  const autoRowsList: any[] = box.style.get('grid_auto_rows');
  const autoColumnsList: any[] = box.style.get('grid_auto_columns');
  const autoRows = new Cycle<any>(autoRowsList);
  const autoColumns = new Cycle<any>(autoColumnsList);
  const autoRowsBack = new Cycle<any>([...autoRowsList].reverse());
  const autoColumnsBack = new Cycle<any>([...autoColumnsList].reverse());
  let columnGap: any = box.style.get('column_gap');
  if (columnGap === 'normal') columnGap = 0;
  else {
    const referTo = box.width === 'auto' ? containingBlock.width : box.width;
    columnGap = percentage(columnGap, box.style, referTo);
  }
  let rowGap: any = box.style.get('row_gap');
  if (rowGap === 'normal') rowGap = 0;
  else {
    const referTo = box.height === 'auto' ? 0 : box.height;
    rowGap = percentage(rowGap, box.style, referTo);
  }

  if ((gridAreas as any) === 'none') gridAreas = [[null]];
  gridAreas = gridAreas.map((row) => [...row]);

  const rows: any[][] = getTemplateTracks(box.style.get('grid_template_rows'));
  const columns: any[][] = getTemplateTracks(box.style.get('grid_template_columns'));

  // Adjust rows number
  const gridAreasColumns = gridAreas.length ? gridAreas[0].length : 0;
  const rowsDiff = Math.trunc((rows.length - 1) / 2) - gridAreas.length;
  if (rowsDiff > 0) {
    for (let i = 0; i < rowsDiff; i++) gridAreas.push(new Array(gridAreasColumns).fill(null));
  } else if (rowsDiff < 0) {
    for (let i = 0; i < -rowsDiff; i++) {
      rows.push(autoRows.next());
      rows.push([]);
    }
  }

  // Adjust columns number
  const columnsDiff = Math.trunc((columns.length - 1) / 2) - gridAreasColumns;
  if (columnsDiff > 0) {
    for (const row of gridAreas) {
      for (let i = 0; i < columnsDiff; i++) row.push(null);
    }
  } else if (columnsDiff < 0) {
    for (let i = 0; i < -columnsDiff; i++) {
      columns.push(autoColumns.next());
      columns.push([]);
    }
  }

  // Add implicit line names
  for (let y = 0; y < gridAreas.length; y++) {
    const row = gridAreas[y];
    for (let x = 0; x < row.length; x++) {
      const areaName = row[x];
      if (areaName === null) continue;
      const startName = `${areaName}-start`;
      let names = rows.filter((_, i) => i % 2 === 0).flat();
      if (!names.includes(startName)) rows[2 * y].push(startName);
      names = columns.filter((_, i) => i % 2 === 0).flat();
      if (!names.includes(startName)) columns[2 * x].push(startName);
    }
  }
  const reversedAreas = [...gridAreas].reverse();
  for (let y = 0; y < reversedAreas.length; y++) {
    const row = [...reversedAreas[y]].reverse();
    for (let x = 0; x < row.length; x++) {
      const areaName = row[x];
      if (areaName === null) continue;
      const endName = `${areaName}-end`;
      let names = rows.filter((_, i) => i % 2 === 0).flat();
      if (!names.includes(endName)) rows[rows.length - 2 * y - 1].push(endName);
      names = columns.filter((_, i) => i % 2 === 0).flat();
      if (!names.includes(endName)) columns[columns.length - 2 * x - 1].push(endName);
    }
  }

  // 1. Run the grid placement algorithm.
  const children: AnyBox[] = [...box.children].sort((a, b) => (a.style.get('order') ?? 0) - (b.style.get('order') ?? 0));
  const placed = placeGridItems({
    children, gridAreas, flow, rows, columns, autoRows, autoColumns,
  });
  const childrenPositions: Map<AnyBox, Pos> = placed.childrenPositions;
  const { firstFlow, secondFlow, implicitFirst1, implicitFirst2, implicitSecond1, implicitSecond2 } = placed;

  // 1.3 / 1.4 The implicit grid: add tracks at the beginning and end (reference names kept).
  let implicitX1: number;
  let implicitX2: number;
  let implicitY1: number;
  let implicitY2: number;
  if (firstFlow === 'row') {
    implicitX1 = implicitSecond1;
    implicitX2 = implicitSecond2;
    implicitY1 = implicitFirst1;
    implicitY2 = implicitFirst2;
  } else {
    implicitX1 = implicitFirst1;
    implicitX2 = implicitFirst2;
    implicitY1 = implicitSecond1;
    implicitY2 = implicitSecond2;
  }
  for (let i = 0; i < -implicitX1; i++) {
    columns.unshift(autoColumnsBack.next());
    columns.unshift([]);
  }
  for (let i = gridAreas.length ? gridAreas[0].length : 0; i < implicitX2; i++) {
    columns.push(autoColumns.next());
    columns.push([]);
  }
  for (let i = 0; i < -implicitY1; i++) {
    rows.unshift(autoRowsBack.next());
    rows.unshift([]);
  }
  for (let i = gridAreas.length; i < implicitY2; i++) {
    rows.push(autoRows.next());
    rows.push([]);
  }

  // Page breaks by row (reference: defaultdict with 'auto' defaults).
  const pageBreaksByRow = new Map<number, { before: string; after: string; inside: string }>();
  const rowBreaks = (y: number) => {
    if (!pageBreaksByRow.has(y)) pageBreaksByRow.set(y, { before: 'auto', after: 'auto', inside: 'auto' });
    return pageBreaksByRow.get(y)!;
  };
  for (const [child, [, y]] of childrenPositions) {
    const rowPageBreak = rowBreaks(y);
    if (['avoid', 'avoid-page'].includes(child.style.get('break_inside'))) rowPageBreak.inside = 'avoid';
    for (const side of ['before', 'after']) {
      const value = child.style.get(`break_${side}`);
      if (['avoid', 'avoid-page'].includes(value)) {
        if ((rowPageBreak as any)[side] !== 'page') (rowPageBreak as any)[side] = 'avoid';
      } else if (['page', 'always'].includes(value)) {
        (rowPageBreak as any)[side] = 'page';
      } else if (['left', 'right', 'recto', 'verso'].includes(value)) {
        (rowPageBreak as any)[side] = value;
      }
    }
  }

  // 2. Find the size of the grid container.
  if (box instanceof GridBox) {
    blockLevelWidth(box, containingBlock);
  } else {
    // TODO: inline grids (inline_block_width) are not ported; the block width is used.
    LOGGER.warning('Inline grids are not supported');
    blockLevelWidth(box, containingBlock);
  }
  if (box.width === 'auto') {
    // TODO: Calculate max-width.
    box.width = containingBlock.width;
  }

  // 3. Run the grid sizing algorithm.
  // 3.0 List min/max sizing functions.
  const rowSizingFunctions = rows.filter((_, i) => i % 2 === 1).map((row) => getSizingFunctions(row));
  const columnSizingFunctions = columns.filter((_, i) => i % 2 === 1).map((column) => getSizingFunctions(column));

  // 3.1 Resolve the sizes of the grid columns.
  const columnsSizes = resolveTracksSizes(
    columnSizingFunctions, box.width, childrenPositions as any, implicitSecond1, 'x', columnGap, context, box);

  // 3.2 Resolve the sizes of the grid rows.
  const verticalSizes = columnsSizes.map((size) => size[0]);
  const rowsSizes = resolveTracksSizes(
    rowSizingFunctions, box.height, childrenPositions as any, implicitY1, 'y', rowGap, context, box, verticalSizes);

  // 3.3 / 3.4 Re-resolving with min-/max-content is not ported (reference TODO).

  // 3.5 Align the tracks within the grid container.
  // TODO: Support safe/unsafe.
  const justifyContent = pySet(box.style.get('justify_content'));
  let x = box.contentBoxX();
  const freeWidth = Math.max(0, box.width - columnsSizes.reduce((acc, s) => acc + s[0], 0));
  const columnsPositions: number[] = [];
  const columnsNumber = columnsSizes.length;
  if (anyOf(justifyContent, ['center'])) {
    x += freeWidth / 2;
    for (const [size] of columnsSizes) {
      columnsPositions.push(x);
      x += size + columnGap;
    }
  } else if (anyOf(justifyContent, ['right', 'end', 'flex-end'])) {
    x += freeWidth;
    for (const [size] of columnsSizes) {
      columnsPositions.push(x);
      x += size + columnGap;
    }
  } else if (anyOf(justifyContent, ['space-around'])) {
    x += freeWidth / 2 / columnsNumber;
    for (const [size] of columnsSizes) {
      columnsPositions.push(x);
      x += size + freeWidth / columnsNumber + columnGap;
    }
  } else if (anyOf(justifyContent, ['space-between'])) {
    for (const [size] of columnsSizes) {
      columnsPositions.push(x);
      if (columnsNumber >= 2) x += size + freeWidth / (columnsNumber - 1) + columnGap;
    }
  } else if (anyOf(justifyContent, ['space-evenly'])) {
    x += freeWidth / (columnsNumber + 1);
    for (const [size] of columnsSizes) {
      columnsPositions.push(x);
      x += size + freeWidth / (columnsNumber + 1) + columnGap;
    }
  } else {
    for (const [size] of columnsSizes) {
      columnsPositions.push(x);
      x += size + columnGap;
    }
  }

  const alignContent = pySet(box.style.get('align_content'));
  let y = box.contentBoxY();
  let freeHeight: number;
  if (box.height === 'auto') {
    freeHeight = 0;
  } else {
    freeHeight = box.height - rowsSizes.reduce((acc, s) => acc + s[0], 0) - (rowsSizes.length - 1) * rowGap;
    freeHeight = Math.max(0, freeHeight);
  }
  const rowsPositions: number[] = [];
  const rowsNumber = rowsSizes.length;
  if (anyOf(alignContent, ['center'])) {
    y += freeHeight / 2;
    for (const [size] of rowsSizes) {
      rowsPositions.push(y);
      y += size + rowGap;
    }
  } else if (anyOf(alignContent, ['right', 'end', 'flex-end'])) {
    y += freeHeight;
    for (const [size] of rowsSizes) {
      rowsPositions.push(y);
      y += size + rowGap;
    }
  } else if (anyOf(alignContent, ['space-around'])) {
    y += freeHeight / 2 / rowsNumber;
    for (const [size] of rowsSizes) {
      rowsPositions.push(y);
      y += size + freeHeight / rowsNumber + rowGap;
    }
  } else if (anyOf(alignContent, ['space-between'])) {
    for (const [size] of rowsSizes) {
      rowsPositions.push(y);
      if (rowsNumber >= 2) y += size + freeHeight / (rowsNumber - 1) + rowGap;
    }
  } else if (anyOf(alignContent, ['space-evenly'])) {
    y += freeHeight / (rowsNumber + 1);
    for (const [size] of rowsSizes) {
      rowsPositions.push(y);
      y += size + freeHeight / (rowsNumber + 1) + rowGap;
    }
  } else {
    if (anyOf(alignContent, ['baseline'])) {
      // TODO: Support baseline value.
      LOGGER.warning('Baseline alignment is not supported for grid layout');
    }
    for (const [size] of rowsSizes) {
      rowsPositions.push(y);
      y += size + rowGap;
    }
  }

  // 4. Lay out the grid items into their respective containing blocks.
  // Find resume_at row.
  const thisPageChildren: Array<[number, AnyBox]> = [];
  let resumeRow: number | null = null;
  let extraSkipHeight = 0;
  let firstSkipRow: number;
  let lastSkipRow: number;
  let skipHeight: number;
  const skipRows = skipStack ? Object.keys(skipStack).map(Number) : [];
  if (skipStack && skipRows.length) {
    firstSkipRow = Math.min(...skipRows);
    lastSkipRow = Math.max(...skipRows);
    skipHeight = rowsSizes.slice(0, lastSkipRow).reduce((acc, s) => acc + s[0], 0)
      + (rowsSizes.slice(0, lastSkipRow).length - 1) * rowGap;
    for (const [child, [cx, cy, cwidth, cheight]] of childrenPositions) {
      const advancement = advancements.get(advKey(cx, cy));
      if (advancement === undefined) continue;
      const span = rowSpan(child.style.get('grid_row_start'));
      const spanHeight = rowsSizes.slice(cy, cy + span).reduce((acc, s) => acc + s[0], 0) + (span - 1) * rowGap;
      const index = [...childrenPositions.keys()].indexOf(child);
      const width = verticalSizes.slice(cx, cx + cwidth).reduce((a, b) => a + b, 0);
      let clone = child.deepcopy();
      clone.positionX = 0;
      clone.positionY = 0;
      const childSkipStack = cy in (skipStack as any) ? (skipStack as any)[cy]?.[index] ?? null : null;
      const parent = BlockContainerBox.anonymousFrom(containingBlock, []);
      resolvePercentages(parent, containingBlock);
      parent.positionX = 0;
      parent.positionY = 0;
      parent.width = width;
      parent.height = 0;
      clone = (blockLevelLayout(context, clone, -INF, childSkipStack, parent) as any[])[0];
      const skipStackAdvancement = spanHeight - clone.marginHeight();
      if (skipStackAdvancement < advancement) {
        extraSkipHeight = Math.max(extraSkipHeight, advancement - skipStackAdvancement);
      }
    }
    let foundAdvancement = false;
    for (const [key, advancement] of advancements) {
      const [, ay] = key.split(',').map(Number);
      if (ay !== lastSkipRow) continue;
      skipHeight += advancement;
      foundAdvancement = true;
      break;
    }
    if (!foundAdvancement) extraSkipHeight = 0;
    skipHeight -= extraSkipHeight;
  } else {
    firstSkipRow = 0;
    lastSkipRow = 0;
    skipHeight = 0;
  }
  let resumeAt: any = null;
  const totalHeight = rowsSizes.slice(lastSkipRow).reduce((acc, s) => acc + s[0], 0)
    + (rowsSizes.slice(lastSkipRow).length - 1) * rowGap;

  const addPageChildren = (maxRow: number = INF) => {
    children.forEach((child, j) => {
      const [, cy] = childrenPositions.get(child)!;
      if (!(firstSkipRow <= cy && cy < maxRow)) return; // Item in previous or next rows.
      if (!skipStack) {
        // No skip stack, draw on this page.
        thisPageChildren.push([j, child]);
      } else if (cy > lastSkipRow) {
        // Row after the skip stack, draw on this page.
        thisPageChildren.push([j, child]);
      } else if (cy in skipStack) {
        const childSkipStack = skipStack[cy];
        if (childSkipStack === null || childSkipStack === undefined || j in childSkipStack) {
          // Child in skip stack, draw on this page.
          thisPageChildren.push([j, child]);
        }
      }
    });
  };

  let pageIsEmptyNow = pageIsEmpty;
  const rowLinesPositions = [...rowsPositions.slice(firstSkipRow + 1), box.contentBoxY() + totalHeight];
  let brokeOut = false;
  for (let i = firstSkipRow; i < firstSkipRow + rowLinesPositions.length; i++) {
    const rowY = rowLinesPositions[i - firstSkipRow];
    // TODO: handle break-before and break-after for rows.
    if (!context.overflowsPage(bottomSpace, rowY - skipHeight)) {
      // No need to force rendering, at least a whole row fits in page.
      pageIsEmptyNow = false;
      continue;
    }
    resumeRow = i;
    if (box.style.get('break_inside') === 'avoid' && !pageIsEmptyNow) {
      // Avoid breaks inside grid container, break before.
      context.finishBlockFormattingContext(box);
      return [null, null, { break: 'any', page: null }, [], false];
    }
    if (rowBreaks(i).inside === 'avoid' && !pageIsEmptyNow) {
      // Break before current row.
      if (resumeRow === 0) {
        // First row, break before grid container.
        context.finishBlockFormattingContext(box);
        return [null, null, { break: 'any', page: null }, [], false];
      }
      // Mark all children before and in current row as drawn on the page.
      addPageChildren(resumeRow);
      resumeAt = { [resumeRow]: null };
    } else {
      // Break inside current row. Mark all children before current row as drawn on the page.
      addPageChildren(resumeRow + 1);
    }
    brokeOut = true;
    break;
  }
  if (!brokeOut) {
    // Mark all children as drawn on the page.
    addPageChildren();
  }
  if (box.height === 'auto') {
    const cut = resumeRow ?? rowsSizes.length; // Python: rows_sizes[:None] is the whole list
    box.height = rowsSizes.slice(0, cut).reduce((acc, s) => acc + s[0], 0)
      + (rowsSizes.slice(0, cut).length - 1) * rowGap - skipHeight;
  }

  // Lay out grid items.
  const justifyItems = pySet(box.style.get('justify_items'));
  const alignItems = pySet(box.style.get('align_items'));
  const newChildren: AnyBox[] = [];
  const newChildrenByRows = new Map<number, Array<[number, AnyBox]>>();
  let baseline: number | null = null;
  // The reference reads child_content_height after the loop: the value of the last laid-out child.
  let lastChildContentHeight = 0;
  const nextPage = { break: 'any', page: null };
  for (const [i, child0] of thisPageChildren) {
    const [cx, cy, cwidth, cheight] = childrenPositions.get(child0)!;
    const index = children.indexOf(child0);
    let childSkipStack: any = null;
    if (skipStack && skipStack[cy]) {
      if (index in skipStack[cy]) childSkipStack = skipStack[cy][index];
      else childSkipStack = { [child0.children.length]: null };
    }
    let child = child0.deepcopy();
    child.positionX = columnsPositions[cx];
    child.positionY = rowsPositions[cy] - skipHeight;
    resolvePercentages(child, box);
    let width = columnsSizes.slice(cx, cx + cwidth).reduce((acc, s) => acc + s[0], 0) + (cwidth - 1) * columnGap;
    let height = rowsSizes.slice(cy, cy + cheight).reduce((acc, s) => acc + s[0], 0) + (cheight - 1) * rowGap;
    if (skipStack && advancements.has(advKey(cx, cy))) {
      const adv = advancements.get(advKey(cx, cy))!;
      child.positionY += adv - extraSkipHeight;
      height -= adv - extraSkipHeight;
    }

    // TODO: Apply auto margin.
    if (child.marginTop === 'auto') child.marginTop = 0;
    if (child.marginRight === 'auto') child.marginRight = 0;
    if (child.marginBottom === 'auto') child.marginBottom = 0;
    if (child.marginLeft === 'auto') child.marginLeft = 0;

    const childBorderWidth = width - (child.marginLeft + child.marginRight);
    const childContentWidth = childBorderWidth - (
      child.borderLeftWidth + child.paddingLeft + child.borderRightWidth + child.paddingRight);
    let childBorderHeight = height - child.marginBottom;
    let childContentHeight = childBorderHeight - (child.borderBottomWidth + child.paddingBottom);
    if (!childSkipStack || child.style.get('box_decoration_break') === 'clone') {
      childBorderHeight -= child.marginTop;
      childContentHeight -= child.marginTop + child.borderTopWidth + child.paddingTop;
    }
    lastChildContentHeight = childContentHeight;

    let justifySelf = pySet(child.style.get('justify_self'));
    if (anyOf(justifySelf, ['auto'])) justifySelf = justifyItems;
    if (anyOf(justifySelf, ['normal', 'stretch'])) {
      if (child.style.get('width') === 'auto') {
        child.style = child.style.copy();
        const childWidth = child.style.get('box_sizing') === 'content-box' ? childContentWidth : childBorderWidth;
        child.style.set('width', dim(childWidth, 'px'));
      }
    }
    let alignSelf = pySet(child.style.get('align_self'));
    if (anyOf(alignSelf, ['auto'])) alignSelf = alignItems;
    if (anyOf(alignSelf, ['normal', 'stretch'])) {
      if (child.style.get('height') === 'auto') {
        child.style = child.style.copy();
        const childHeight = child.style.get('box_sizing') === 'content-box' ? childContentHeight : childBorderHeight;
        child.style.set('height', dim(childHeight, 'px'));
      }
    }

    // TODO: Find a better solution for the layout.
    const parent = BlockContainerBox.anonymousFrom(box, []);
    resolvePercentages(parent, containingBlock);
    parent.positionX = child.positionX;
    parent.positionY = child.positionY;
    parent.width = width;
    parent.height = height;
    const laid: any[] = blockLevelLayout(context, child, bottomSpace, childSkipStack, parent,
      pageIsEmptyNow, absoluteBoxes, fixedBoxes) as any;
    const newChild = laid[0];
    const childResumeAt = laid[1];
    const childNextPage = laid[2];
    void childNextPage;
    if (newChild) {
      let brokenChild = false;
      const span = rowSpan(child.style.get('grid_row_start'));
      if (childResumeAt) brokenChild = true;
      else if (resumeRow !== null && cy + span >= resumeRow + 1) brokenChild = true;
      if (brokenChild) {
        // Child is broken, add row to resume_at.
        if (resumeAt === null) resumeAt = {};
        if (!(cy in resumeAt)) resumeAt[cy] = {};
      }
      if (childResumeAt) {
        // There is some content left for next page, save the cell's resume_at.
        resumeAt[cy][i] = childResumeAt;
      } else if (brokenChild) {
        // Everything fits but the cell overflows. Only display the bottom of an empty cell on next page.
        const previousSkipChild = childSkipStack ? Math.max(...Object.keys(childSkipStack).map(Number)) : 0;
        if (!pageIsEmptyNow) {
          resumeAt[cy][i] = { [previousSkipChild + newChild.children.length]: null };
        }
      }
      pageIsEmptyNow = false;
    } else {
      if (resumeAt === null) resumeAt = {};
      if (!(cy in resumeAt)) resumeAt[cy] = {};
      resumeAt[cy][i] = null;
      continue;
    }

    let newChildRef = newChild;
    if (anyOf(justifySelf, ['normal', 'stretch'])) {
      newChildRef.width = Math.max(childContentWidth, newChildRef.width);
    } else {
      if (newChildRef.style.get('width') === 'auto') {
        newChildRef.width = maxContentWidth(context, newChildRef, false);
      }
      const diff = childContentWidth - newChildRef.width;
      if (anyOf(justifySelf, ['center'])) newChildRef.translate(diff / 2, 0);
      else if (anyOf(justifySelf, ['right', 'end', 'flex-end', 'self-end'])) newChildRef.translate(diff, 0);
    }

    // TODO: Apply auto margins.
    if (anyOf(alignSelf, ['normal', 'stretch'])) {
      newChildRef.height = Math.max(childContentHeight, newChildRef.height);
    } else {
      const diff = childContentHeight - newChildRef.height;
      if (anyOf(alignSelf, ['center'])) newChildRef.translate(0, diff / 2);
      else if (anyOf(alignSelf, ['end', 'flex-end', 'self-end'])) newChildRef.translate(0, diff);
    }

    newChildRef = newChild;
    newChildren.push(newChildRef);
    if (!newChildrenByRows.has(cy)) newChildrenByRows.set(cy, []);
    newChildrenByRows.get(cy)!.push([cx, newChildRef]);
    if (baseline === null && cy === implicitY1) baseline = findInFlowBaseline(newChildRef);
  }

  // Abort whole grid rendering if no child fits.
  if (thisPageChildren.length && !newChildren.length) {
    context.finishBlockFormattingContext(box);
    return [null, null, { break: 'any', page: null }, [], false];
  }

  const oldAdvancements = new Map(advancements);
  advancements.clear();
  box = box.copyWithChildren(newChildren);
  if (box instanceof InlineGridBox) {
    // TODO: Synthetize a real baseline value.
    LOGGER.warning('Inline grids are not supported');
    box.baseline = baseline ?? 0;
  }

  if (box.style.get('position') === 'relative') {
    // New containing block, resolve the layout of the absolute descendants
    for (const absoluteBox of absoluteBoxes) {
      absoluteLayout(context, absoluteBox, box, fixedBoxes, bottomSpace, null);
    }
  }

  for (const child of box.children) relativePositioning(child, [box.width, box.height]);

  // Resume early when there's no resume_at.
  if (!resumeAt || !Object.keys(resumeAt).length) {
    context.finishBlockFormattingContext(box);
    return [box, resumeAt, nextPage, [], false];
  }

  // Set broken rows' bottom at the bottom of the page.
  const rowKeys = [...newChildrenByRows.keys()];
  const lastPageRow = Math.max(...rowKeys);
  const resumeKeys = Object.keys(resumeAt).map(Number);
  const nextPageFirstRow = Math.min(...resumeKeys);
  const nextPageLastRow = Math.max(...resumeKeys);
  let extraAdvancement = 0;
  for (let rowY = lastPageRow; rowY >= nextPageFirstRow; rowY--) {
    for (const [cx, child] of newChildrenByRows.get(rowY) ?? []) {
      const span = rowSpan(child.style.get('grid_row_start'));
      if (rowY + span < lastPageRow + 1) continue; // Child finishing before the last row, do nothing.
      const brokenChild = rowY + span >= nextPageLastRow + 1;
      if (brokenChild && child.style.get('box_decoration_break') !== 'clone') child.removeDecoration(false, true);
      child.height = Math.max(0, (
        context.pageBottom - bottomSpace - child.positionY
        - child.marginTop - child.borderTopWidth - child.paddingTop
        - child.marginBottom - child.borderBottomWidth - child.paddingBottom));
      if (brokenChild) {
        // Child not fully drawn, keep advancement.
        advancements.set(advKey(cx, rowY), child.marginHeight());
        const old = oldAdvancements.get(advKey(cx, rowY));
        if (old !== undefined) advancements.set(advKey(cx, rowY), advancements.get(advKey(cx, rowY))! + old - extraSkipHeight);
      } else {
        // Child fully drawn, save the extra height added to reach the bottom of the page.
        extraAdvancement = Math.max(extraAdvancement, child.height - lastChildContentHeight);
      }
    }
  }

  // Substract the extra height added to reach the bottom of the page from all the advancements.
  if (extraAdvancement) {
    for (const key of [...advancements.keys()]) advancements.set(key, advancements.get(key)! - extraAdvancement);
  }

  // Set box height and remove bottom decoration.
  box.height = context.pageBottom - bottomSpace - box.positionY - box.marginTop - box.borderTopWidth - box.paddingTop;
  if (box.style.get('box_decoration_break') !== 'clone') {
    box.removeDecoration(false, true);
    box.height -= box.marginBottom + box.borderBottomWidth + box.paddingBottom;
  }

  context.finishBlockFormattingContext(box);
  return [box, resumeAt, nextPage, [], false];
}

