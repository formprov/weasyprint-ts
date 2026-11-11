// SPDX-License-Identifier: BSD-3-Clause

/**
 * Preferred and minimum preferred width, also known as max-content and
 * min-content width (the shrink-to-fit algorithm). Mirrors layout/preferred.py;
 * terms are defined in David Baron's unofficial draft (https://dbaron.org/css/intrinsic/).
 */
import * as boxes from '../formatting_structure/boxes.ts';
import { getTextEngine } from '../text/engine.ts';
import { skipItem } from './block.ts';
import { defaultImageSizing } from './replaced.ts';
import { distributeExcessWidth } from './table.ts';
import { splitTextBox } from './inline.ts';
import { checkMath } from '../css/math.ts';

type AnyBox = any;
const MAXSIZE = 9223372036854775807;
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Shrink-to-fit width of ``box`` (both widths are for the *content area*, not margin area). */
export function shrinkToFit(context: any, box: AnyBox, availableContentWidth: number): number {
  return Math.min(Math.max(minContentWidth(context, box, false), availableContentWidth), maxContentWidth(context, box, false));
}

/** Min-content width: the width by breaking at every line-break opportunity. */
export function minContentWidth(context: any, box: AnyBox, outer = true): number {
  if (box.isTableWrapper) return tableAndColumnsPreferredWidths(context, box, outer)[0] as number;
  if (box instanceof boxes.TableCellBox) return tableCellMinContentWidth(context, box, outer);
  if (box.isBlockContainer || box instanceof boxes.TableColumnBox) return blockMinContentWidth(context, box, outer);
  if (box instanceof boxes.TableColumnGroupBox) return columnGroupContentWidth(context, box);
  if (box instanceof boxes.InlineBox || box instanceof boxes.LineBox) return inlineMinContentWidth(context, box, outer, null, false, true);
  if (box.isReplaced) return replacedMinContentWidth(box, outer);
  if (box instanceof boxes.FlexContainerBox) return flexMinContentWidth(context, box, outer);
  if (box instanceof boxes.GridContainerBox) return blockMinContentWidth(context, box, outer); // TODO: real grid size
  throw new TypeError(`min-content width for ${box.constructor.name} not handled yet`);
}

/** Max-content width: the width by only breaking at forced line breaks. */
export function maxContentWidth(context: any, box: AnyBox, outer = true): number {
  if (box.isTableWrapper) return tableAndColumnsPreferredWidths(context, box, outer)[1] as number;
  if (box instanceof boxes.TableCellBox) return tableCellMinMaxContentWidth(context, box, outer)[1];
  if (box.isBlockContainer || box instanceof boxes.TableColumnBox) return blockMaxContentWidth(context, box, outer);
  if (box instanceof boxes.TableColumnGroupBox) return columnGroupContentWidth(context, box);
  if (box instanceof boxes.InlineBox || box instanceof boxes.LineBox) return inlineMaxContentWidth(context, box, outer, true);
  if (box.isReplaced) return replacedMaxContentWidth(box, outer);
  if (box instanceof boxes.FlexContainerBox) return flexMaxContentWidth(context, box, outer);
  if (box instanceof boxes.GridContainerBox) return blockMaxContentWidth(context, box, outer); // TODO: real grid size
  throw new TypeError(`max-content width for ${box.constructor.name} not handled yet`);
}

/** Python's hasattr(box, 'border_*_width') for collapsed-border table cells. */
const hasResolvedBorder = (box: AnyBox, side: 'left' | 'right'): boolean => Boolean(box.collapsedBorderWidths?.has(`border_${side}_width`));

function blockContentWidth(context: any, box: AnyBox, fn: (c: any, b: AnyBox, o: boolean) => number, outer: boolean): number {
  let width = box.style.get('width');
  if (width === 'auto' || checkMath(width) || width.unit === '%') {
    // "percentages on the following properties are treated instead as though they were
    // the following: width: auto" (https://dbaron.org/css/intrinsic/#outer-intrinsic)
    const childrenWidths = box.children
      .filter((child: AnyBox) => !child.isAbsolutelyPositioned() && !child.isNote())
      .map((child: AnyBox) => fn(context, child, true));
    width = childrenWidths.length ? Math.max(...childrenWidths) : 0;
  } else if (box.style.get('box_sizing') === 'content-box') {
    width = width.value;
  } else {
    width = width.value;
    let percentages = 0;
    for (const value of ['padding_left', 'padding_right']) {
      const styleValue = box.style.get(value);
      if (styleValue !== 'auto' && !checkMath(styleValue)) {
        if (styleValue.unit.toLowerCase() === 'px') width -= styleValue.value;
        else percentages += styleValue.value;
      }
    }
    // Same as margin_width().
    const collapse = box.style.get('border_collapse') === 'collapse';
    width -= collapse && hasResolvedBorder(box, 'left') ? box.borderLeftWidth : box.style.get('border_left_width');
    width -= collapse && hasResolvedBorder(box, 'right') ? box.borderRightWidth : box.style.get('border_right_width');
    width = ((100 - Math.min(100, percentages)) * Math.max(0, width)) / 100;
  }
  return adjust(box, outer, width);
}

/** Get box width from given width and box min- and max-widths. */
export function minMax(box: AnyBox, width: number): number {
  let minWidth = box.style.get('min_width');
  let maxWidth = box.style.get('max_width');
  if (minWidth === 'auto' || checkMath(minWidth) || minWidth.unit === '%') minWidth = 0;
  else minWidth = minWidth.value;
  if (maxWidth === 'auto' || checkMath(maxWidth) || maxWidth.unit === '%') maxWidth = Infinity;
  else maxWidth = maxWidth.value;

  if (box.isReplaced) {
    const [, , ratio] = box.replacement.getIntrinsicSize(1, box.style.get('font_size'));
    if (ratio !== null) {
      const minHeight = box.style.get('min_height');
      const maxHeight = box.style.get('max_height');
      if (minHeight !== 'auto' && !checkMath(minHeight) && minHeight.unit !== '%') minWidth = Math.max(minWidth, minHeight.value * ratio);
      if (maxHeight !== 'auto' && !checkMath(maxHeight) && maxHeight.unit !== '%') maxWidth = Math.min(maxWidth, maxHeight.value * ratio);
    }
  }
  return Math.max(minWidth, Math.min(width, maxWidth));
}

/** Add box paddings, borders and margins to ``width``. */
export function marginWidth(box: AnyBox, widthIn: number, left = true, right = true): number {
  let width = widthIn;
  let percentages = 0;

  // See https://drafts.csswg.org/css-tables-3/#cell-intrinsic-offsets
  const names = [...(left ? ['margin_left', 'padding_left'] : []), ...(right ? ['margin_right', 'padding_right'] : [])];
  for (const value of names) {
    const styleValue = box.style.get(value);
    if (styleValue !== 'auto' && !checkMath(styleValue)) {
      if (styleValue.unit.toLowerCase() === 'px') width += styleValue.value;
      else percentages += styleValue.value;
    }
  }

  const collapse = box.style.get('border_collapse') === 'collapse';
  if (left) {
    // Collapsed-borders mode: the used border-width values of the cell (half the winning
    // border-width); separated-borders mode: the computed border of the table-cell.
    width += collapse && hasResolvedBorder(box, 'left') ? box.borderLeftWidth : box.style.get('border_left_width');
  }
  if (right) {
    width += collapse && hasResolvedBorder(box, 'right') ? box.borderRightWidth : box.style.get('border_right_width');
  }
  if (percentages < 100) return width / (1 - percentages / 100);
  // Pathological case, ignore.
  return 0;
}

/** Respect min/max and adjust width depending on ``outer``. */
export function adjust(box: AnyBox, outer: boolean, width: number, left = true, right = true): number {
  const fixed = minMax(box, width);
  return outer ? marginWidth(box, fixed, left, right) : fixed;
}

export function blockMinContentWidth(context: any, box: AnyBox, outer = true): number {
  return blockContentWidth(context, box, minContentWidth, outer);
}
export function blockMaxContentWidth(context: any, box: AnyBox, outer = true): number {
  return blockContentWidth(context, box, maxContentWidth, outer);
}

export function inlineMinContentWidth(
  context: any, box: AnyBox, outer = true, skipStack: any = null, firstLine = false, isLineStart = false,
): number {
  const widths = inlineLineWidths(context, box, outer, isLineStart, true, skipStack, firstLine);
  const width = firstLine ? widths.next().value as number : Math.max(...widths);
  return adjust(box, outer, width);
}

export function inlineMaxContentWidth(context: any, box: AnyBox, outer = true, isLineStart = false): number {
  const widths = [...inlineLineWidths(context, box, outer, isLineStart, false)];
  // Remove trailing space, as split_first_line keeps trailing spaces when max_width is not set.
  widths[widths.length - 1] -= trailingWhitespaceSize(context, box);
  return adjust(box, outer, Math.max(...widths));
}

export function columnGroupContentWidth(_context: any, box: AnyBox): number {
  let width = box.style.get('width');
  if (width === 'auto' || checkMath(width) || width.unit === '%') width = 0;
  else width = width.value;
  return adjust(box, false, width);
}

export function tableCellMinContentWidth(context: any, box: AnyBox, outer: boolean): number {
  // See https://www.w3.org/TR/css-tables-3/#outer-min-content: the outer min-content width of
  // a table-cell is max(min-width, min-content width) adjusted by the cell intrinsic offsets.
  const childrenWidths = box.children
    .filter((child: AnyBox) => !child.isAbsolutelyPositioned() && !child.isNote())
    .map((child: AnyBox) => minContentWidth(context, child));
  return adjust(box, outer, childrenWidths.length ? Math.max(...childrenWidths) : 0);
}

export function tableCellMinMaxContentWidth(context: any, box: AnyBox, outer = true): [number, number] {
  // This is much faster than calling min and max separately.
  const minWidth = tableCellMinContentWidth(context, box, outer);
  const maxWidth = Math.max(minWidth, blockMaxContentWidth(context, box, outer));
  return [minWidth, maxWidth];
}

const or0 = (x: number | null): number => x || 0;
const orNull = (x: number | null): number | null => x || null;

/** Yield line width for each line. */
export function* inlineLineWidths(
  context: any, box: AnyBox, outer: boolean, isLineStartIn: boolean, minimum: boolean, skipStackIn: any = null, firstLine = false,
): Generator<number> {
  let isLineStart = isLineStartIn;
  let skipStack = skipStackIn;

  // Set text indent.
  let textIndent = 0;
  if (box instanceof boxes.LineBox) {
    const indentToken = box.style.get('text_indent');
    if (indentToken.unit !== '%') textIndent = box.style.get('text_indent').value;
  }

  // Yield widths for each line.
  let currentLine = 0;
  let skip: number;
  if (skipStack === null) skip = 0;
  else [skip, skipStack] = skipItem(skipStack);
  for (const child of box.children.slice(skip)) {
    // Skip absolutely positioned elements.
    if (child.isAbsolutelyPositioned() || child.isNote()) continue;

    // null is used in "lines" to track line breaks, transformed to 0 when yielded.
    let lines: Array<number | null>;
    if (child instanceof boxes.InlineBox) {
      // Inline box, call function recursively.
      const gen = inlineLineWidths(context, child, outer, isLineStart, minimum, skipStack, firstLine);
      if (firstLine) lines = [orNull(gen.next().value as number)];
      else lines = [...gen].map((l) => orNull(l));
      if (lines.length === 1) lines[0] = adjust(child, outer, or0(lines[0]));
      else {
        lines[0] = orNull(adjust(child, outer, or0(lines[0]), true, false));
        lines[lines.length - 1] = orNull(adjust(child, outer, or0(lines[lines.length - 1]), false, true));
      }
    } else if (child instanceof boxes.TextBox) {
      // Text box, split into lines.
      const whiteSpace = child.style.get('white_space');
      const spaceCollapse = ['normal', 'nowrap', 'pre-line'].includes(whiteSpace);
      const textWrap = ['normal', 'pre-wrap', 'pre-line'].includes(whiteSpace);
      let childSkip: number;
      if (skipStack === null) childSkip = 0;
      else {
        [childSkip, skipStack] = skipItem(skipStack);
        if (skipStack !== null) throw new Error('unexpected nested skip stack');
      }
      let childText = enc.encode(child.text).subarray(childSkip || 0);
      if (isLineStart && spaceCollapse) {
        let i = 0;
        while (i < childText.length && childText[i] === 0x20) i++;
        childText = childText.subarray(i);
      }
      const maxWidth = minimum ? 0 : null;
      lines = [];
      let resumeIndex = 0;
      let newResumeIndex: number | null = 0;
      while (newResumeIndex !== null) {
        resumeIndex += newResumeIndex;
        let width: number;
        [, , newResumeIndex, width] = getTextEngine().firstLine(
          dec.decode(childText.subarray(resumeIndex)), child.style, context, maxWidth, child.justificationSpacing, isLineStart, true);
        lines.push(orNull(width));
        if (firstLine) break;
      }
      if (firstLine && newResumeIndex) {
        // We only need the first line, break early.
        currentLine += lines[0] || 0;
        break;
      }
      // TODO: use the real next character instead of 'a' to detect line breaks.
      const lastLetter = [...dec.decode(childText)].slice(-1).join('');
      const canBreak = getTextEngine().canBreakText(lastLetter + 'a', child.style.get('lang'));
      if (minimum && textWrap && canBreak) {
        // Add all possible line breaks for minimal width.
        lines.push(null);
      }
    } else {
      // Replaced elements, inline blocks…
      // https://www.w3.org/TR/css-text-3/#overflow-wrap: "The line breaking behavior of a replaced element
      // or other atomic inline is equivalent to that of the Object Replacement Character (U+FFFC)."
      if (minimum) {
        // We choose to always follow the parent's value here, other parts of the line-breaking algorithm do the same.
        if (['normal', 'pre-wrap', 'pre-line'].includes(box.style.get('white_space'))) {
          lines = [null, minContentWidth(context, child), null];
        } else lines = [minContentWidth(context, child)];
      } else lines = [maxContentWidth(context, child)];
    }
    // The first text line goes on the current line.
    currentLine += lines[0] || 0;
    if (lines.length > 1) {
      // Forced line break(s).
      yield currentLine + textIndent;
      textIndent = 0;
      if (lines.length > 2) for (const line of lines.slice(1, -1)) yield line || 0;
      currentLine = lines[lines.length - 1] || 0;
    }
    isLineStart = lines[lines.length - 1] === null;
    skipStack = null;
  }
  yield currentLine + textIndent;
}

/** Percentage contribution of a cell, column or column group (https://dbaron.org/css/intrinsic/#pct-contrib). */
function percentageContribution(box: AnyBox): number {
  let minWidth = box.style.get('min_width');
  minWidth = minWidth !== 'auto' && minWidth.unit === '%' ? minWidth.value : 0;
  let maxWidth = box.style.get('max_width');
  maxWidth = maxWidth !== 'auto' && maxWidth.unit === '%' ? maxWidth.value : Infinity;
  let width = box.style.get('width');
  width = width !== 'auto' && width.unit === '%' ? width.value : 0;
  return Math.max(minWidth, Math.min(width, maxWidth));
}

type TableResult = [number, number, number[], number[], number[], boolean[], number, any[][]] | [number, number, never[], never[], never[], never[], number, never[]];

/**
 * Content widths for the auto layout table and its columns. The tuple is
 * ``[tableMin, tableMax, columnMins, columnMaxs, columnIntrinsicPercentages,
 * constrainedness, totalHorizontalBorderSpacing, grid]`` (https://dbaron.org/css/intrinsic/).
 */
export function tableAndColumnsPreferredWidths(context: any, box: AnyBox, outer = true): any[] {
  const table = box.getWrappedTable();
  const cached = context.tables.get(table);
  if (cached) return cached[outer ? 'true' : 'false'];

  // Create the grid.
  let gridWidth = 0;
  let gridHeight = 0;
  let rowNumber = 0;
  for (const rowGroup of table.children) {
    for (const row of rowGroup.children) {
      for (const cell of row.children) {
        gridWidth = Math.max(cell.gridX + cell.colspan, gridWidth);
        gridHeight = Math.max(rowNumber + cell.rowspan, gridHeight);
      }
      rowNumber += 1;
    }
  }
  const grid: any[][] = Array.from({ length: gridHeight }, () => Array(gridWidth).fill(null));
  rowNumber = 0;
  for (const rowGroup of table.children) {
    for (const row of rowGroup.children) {
      for (const cell of row.children) grid[rowNumber][cell.gridX] = cell;
      rowNumber += 1;
    }
  }

  const zippedGrid: any[][] = Array.from({ length: gridWidth }, (_, x) => grid.map((row) => row[x]));

  // Define the total horizontal border spacing.
  let totalHorizontalBorderSpacing: number;
  if (table.style.get('border_collapse') === 'separate' && gridWidth > 0) {
    totalHorizontalBorderSpacing = table.style.get('border_spacing')[0] * (1 + zippedGrid.filter((column) => column.some(Boolean)).length);
  } else totalHorizontalBorderSpacing = 0;

  if (gridWidth === 0 || gridHeight === 0) {
    table.children = [];
    const minWidth = blockMinContentWidth(context, table, false);
    const maxWidth = blockMaxContentWidth(context, table, false);
    const outerMinWidth = adjust(box, true, blockMinContentWidth(context, table));
    const outerMaxWidth = adjust(box, true, blockMaxContentWidth(context, table));
    const rest = [[], [], [], [], totalHorizontalBorderSpacing, []];
    const result: Record<string, any[]> = { false: [minWidth, maxWidth, ...rest], true: [outerMinWidth, outerMaxWidth, ...rest] };
    context.tables.set(table, result);
    return result[outer ? 'true' : 'false'];
  }

  const columnGroups: any[] = Array(gridWidth).fill(null);
  const columns: any[] = Array(gridWidth).fill(null);
  let columnNumber = 0;
  outerLoop: for (const columnGroup of table.columnGroups) {
    for (const column of columnGroup.children) {
      columnGroups[columnNumber] = columnGroup;
      columns[columnNumber] = column;
      columnNumber += 1;
      if (columnNumber === gridWidth) break outerLoop;
    }
  }

  const colspanCells: any[] = [];
  const colspans = new Set<number>();

  // Define the intermediate content widths.
  const minContentWidths: number[] = Array(gridWidth).fill(0);
  const maxContentWidths: number[] = Array(gridWidth).fill(0);
  let intrinsicPercentages: number[] = Array(gridWidth).fill(0);

  // Intermediate content widths for span 1.
  for (let i = 0; i < gridWidth; i++) {
    for (const groups of [columnGroups, columns]) {
      const group = groups[i];
      if (group) {
        minContentWidths[i] = Math.max(minContentWidths[i], minContentWidth(context, group));
        maxContentWidths[i] = Math.max(maxContentWidths[i], maxContentWidth(context, group));
        intrinsicPercentages[i] = Math.max(intrinsicPercentages[i], percentageContribution(group));
      }
    }
    for (const cell of zippedGrid[i]) {
      if (!cell) continue;
      if (cell.colspan === 1) {
        const [minWidth, maxWidth] = tableCellMinMaxContentWidth(context, cell);
        minContentWidths[i] = Math.max(minContentWidths[i], minWidth);
        maxContentWidths[i] = Math.max(maxContentWidths[i], maxWidth);
        intrinsicPercentages[i] = Math.max(intrinsicPercentages[i], percentageContribution(cell));
      } else {
        colspanCells.push(cell);
        colspans.add(cell.colspan - 1);
      }
    }
  }

  // Intermediate content widths for span > 1 is wrong in the 4.1 section, as explained in its third
  // issue. Min- and max-content widths are handled by the excess width distribution method, and
  // percentages do not distribute widths to columns that have originating cells.

  // Intermediate intrinsic percentage widths for span > 1.
  const rowsOrigins: Array<Array<number | null>> = [];
  for (const row of grid) {
    let origin: number | null = null;
    const rowOrigins: Array<number | null> = [];
    rowsOrigins.push(rowOrigins);
    row.forEach((cell, x) => {
      if (cell) origin = x;
      rowOrigins.push(origin);
    });
  }

  const contributionCache = new Map<any, Map<string, number>>();
  const getPercentageContribution = (originCell: AnyBox, origin: number, maxContent: number): number => {
    // Cached for big colspan values, see #1155.
    let m = contributionCache.get(originCell);
    if (!m) contributionCache.set(originCell, (m = new Map()));
    const key = `${origin}|${maxContent}`;
    const hit = m.get(key);
    if (hit !== undefined) return hit;
    const baselinePercentage = intrinsicPercentages.slice(origin, origin + originCell.colspan).reduce((a, b) => a + b, 0);
    const cellPercentageContribution = percentageContribution(originCell);
    const diff = Math.max(0, cellPercentageContribution - baselinePercentage);
    const others: number[] = [];
    for (let j = origin; j < origin + originCell.colspan; j++) if (intrinsicPercentages[j] === 0) others.push(maxContentWidths[j]);
    const sum = others.reduce((a, b) => a + b, 0);
    const ratio = sum === 0 ? 1 / (others.length || 1) : maxContent / sum;
    const result = diff * ratio;
    m.set(key, result);
    return result;
  };

  for (const span of [...colspans].sort((a, b) => a - b)) {
    const percentageContributions: number[] = [];
    for (let i = 0; i < gridWidth; i++) {
      let pc = intrinsicPercentages[i];
      if (pc) {
        percentageContributions.push(pc);
        continue;
      }
      grid.forEach((row, r) => {
        const origin = rowsOrigins[r][i];
        if (origin === null) return;
        const originCell = row[origin];
        if (originCell.colspan - 1 !== span) return;
        const cellPc = getPercentageContribution(originCell, origin, maxContentWidths[i]);
        pc = Math.max(pc, cellPc);
      });
      percentageContributions.push(pc);
    }
    intrinsicPercentages = percentageContributions;
  }

  // Define constrainedness.
  const constrainedness: boolean[] = Array(gridWidth).fill(false);
  for (let i = 0; i < gridWidth; i++) {
    if (columnGroups[i]) {
      const width = columnGroups[i].style.get('width');
      if (width !== 'auto' && !checkMath(width) && width.unit !== '%') {
        constrainedness[i] = true;
        continue;
      }
    }
    if (columns[i]) {
      const width = columns[i].style.get('width');
      if (width !== 'auto' && !checkMath(width) && width.unit !== '%') {
        constrainedness[i] = true;
        continue;
      }
    }
    for (const cell of zippedGrid[i]) {
      if (cell && cell.colspan === 1) {
        const width = cell.style.get('width');
        if (width !== 'auto' && !checkMath(width) && width.unit !== '%') {
          constrainedness[i] = true;
          break;
        }
      }
    }
  }

  intrinsicPercentages = intrinsicPercentages.map((p, i) => Math.min(p, 100 - intrinsicPercentages.slice(0, i).reduce((a, b) => a + b, 0)));

  // Max- and min-content widths for span > 1.
  for (const cell of colspanCells) {
    const minContent = minContentWidth(context, cell);
    const maxContent = maxContentWidth(context, cell);
    const columnSlice: [number, number] = [cell.gridX, cell.gridX + cell.colspan];
    const columnsMinContent = minContentWidths.slice(...columnSlice).reduce((a, b) => a + b, 0);
    const columnsMaxContent = maxContentWidths.slice(...columnSlice).reduce((a, b) => a + b, 0);
    const spacing = table.style.get('border_collapse') === 'separate' ? (cell.colspan - 1) * table.style.get('border_spacing')[0] : 0;

    if (minContent > columnsMinContent + spacing) {
      const excessWidth = minContent - (columnsMinContent + spacing);
      distributeExcessWidth(context, zippedGrid, excessWidth, minContentWidths, constrainedness, intrinsicPercentages, maxContentWidths, columnSlice);
    }
    if (maxContent > columnsMaxContent + spacing) {
      const excessWidth = maxContent - (columnsMaxContent + spacing);
      distributeExcessWidth(context, zippedGrid, excessWidth, maxContentWidths, constrainedness, intrinsicPercentages, maxContentWidths, columnSlice);
    }
  }

  // Calculate the max- and min-content widths of table and columns.
  const smallPercentageContributions: number[] = [];
  for (let i = 0; i < gridWidth; i++) {
    if (intrinsicPercentages[i]) smallPercentageContributions.push(maxContentWidths[i] / (intrinsicPercentages[i] / 100));
  }
  let largeNumerator = 0;
  for (let i = 0; i < gridWidth; i++) if (intrinsicPercentages[i] === 0) largeNumerator += maxContentWidths[i];
  const largeDenominator = (100 - intrinsicPercentages.reduce((a, b) => a + b, 0)) / 100;
  let largePercentageContribution: number;
  if (largeDenominator === 0) {
    // "the large percentage contribution of the table [is] an infinitely large number if the
    // numerator is nonzero [and] the denominator of that ratio is 0." Note that "an infinitely
    // large number" is not "infinite": putting 'inf' here breaks some cases (see #305).
    largePercentageContribution = largeNumerator === 0 ? 0 : MAXSIZE;
  } else largePercentageContribution = largeNumerator / largeDenominator;

  let tableMinContentWidth = totalHorizontalBorderSpacing + minContentWidths.reduce((a, b) => a + b, 0);
  let tableMaxContentWidth = totalHorizontalBorderSpacing + Math.max(
    maxContentWidths.reduce((a, b) => a + b, 0), largePercentageContribution, ...smallPercentageContributions);

  const width = table.style.get('width');
  let tableMinWidth: number;
  let tableMaxWidth: number;
  if (width !== 'auto' && width.unit.toLowerCase() === 'px') {
    // "percentages on the following properties are treated instead as though they were the
    // following: width: auto" (https://dbaron.org/css/intrinsic/#outer-intrinsic)
    tableMinWidth = tableMaxWidth = width.value;
  } else {
    tableMinWidth = tableMinContentWidth;
    tableMaxWidth = tableMaxContentWidth;
  }

  tableMinContentWidth = Math.max(tableMinContentWidth, adjust(table, false, tableMinWidth));
  tableMaxContentWidth = Math.max(tableMaxContentWidth, adjust(table, false, tableMaxWidth));
  const tableOuterMinContentWidth = marginWidth(table, marginWidth(box, tableMinContentWidth));
  const tableOuterMaxContentWidth = marginWidth(table, marginWidth(box, tableMaxContentWidth));

  const rest = [minContentWidths, maxContentWidths, intrinsicPercentages, constrainedness, totalHorizontalBorderSpacing, zippedGrid];
  const result: Record<string, any[]> = {
    false: [tableMinContentWidth, tableMaxContentWidth, ...rest],
    true: [tableOuterMinContentWidth, tableOuterMaxContentWidth, ...rest],
  };
  context.tables.set(table, result);
  return result[outer ? 'true' : 'false'];
}

export function replacedMinContentWidth(box: AnyBox, outer = true): number {
  let width = box.style.get('width');
  if (width === 'auto') {
    let height = box.style.get('height');
    if (height === 'auto' || checkMath(height) || height.unit === '%') height = 'auto';
    else height = height.value;
    const maxW = box.style.get('max_width');
    const unknownMaxWidth = maxW !== 'auto' && maxW.unit === '%';
    if (unknownMaxWidth) {
      // See https://drafts.csswg.org/css-sizing/#intrinsic-contribution
      width = 0;
    } else {
      const image = box.replacement;
      const [iw, ih, ir] = image.getIntrinsicSize(box.style.get('image_resolution'), box.style.get('font_size'));
      [width] = defaultImageSizing(iw, ih, ir, 'auto', height, 0, 0);
    }
  } else if (box.style.get('width').unit === '%') {
    // See https://drafts.csswg.org/css-sizing/#intrinsic-contribution
    width = 0;
  } else width = width.value;
  return adjust(box, outer, width);
}

export function replacedMaxContentWidth(box: AnyBox, outer = true): number {
  let width = box.style.get('width');
  if (width === 'auto') {
    let height = box.style.get('height');
    if (height === 'auto' || checkMath(height) || height.unit === '%') height = 'auto';
    else height = height.value;
    const image = box.replacement;
    const [iw, ih, ir] = image.getIntrinsicSize(box.style.get('image_resolution'), box.style.get('font_size'));
    [width] = defaultImageSizing(iw, ih, ir, 'auto', height, 300, 150);
  } else if (box.style.get('width').unit === '%') {
    width = 0;
  } else width = width.value;
  return adjust(box, outer, width);
}

export function flexMinContentWidth(context: any, box: AnyBox, outer = true): number {
  // TODO: use real values, see https://www.w3.org/TR/css-flexbox-1/#intrinsic-sizes
  const minContents = box.children.filter((c: AnyBox) => c.isFlexItem).map((c: AnyBox) => minContentWidth(context, c));
  if (!minContents.length) return adjust(box, outer, 0);
  if (box.style.get('flex_direction').startsWith('row') && box.style.get('flex_wrap') === 'nowrap') {
    return adjust(box, outer, minContents.reduce((a: number, b: number) => a + b, 0));
  }
  return adjust(box, outer, Math.max(...minContents));
}

export function flexMaxContentWidth(context: any, box: AnyBox, outer = true): number {
  const maxContents = box.children.filter((c: AnyBox) => c.isFlexItem).map((c: AnyBox) => maxContentWidth(context, c));
  if (!maxContents.length) return adjust(box, outer, 0);
  if (box.style.get('flex_direction').startsWith('row')) return adjust(box, outer, maxContents.reduce((a: number, b: number) => a + b, 0));
  return adjust(box, outer, Math.max(...maxContents));
}

/** Size of the trailing whitespace of ``box``. */
export function trailingWhitespaceSize(context: any, boxIn: AnyBox): number {
  let box = boxIn;
  // Find last box child, keep last parent to remove nested trailing spaces.
  let lastParent: AnyBox = null;
  while (box instanceof boxes.InlineBox || box instanceof boxes.LineBox) {
    if (!box.children.length) return 0;
    lastParent = box;
    box = box.children[box.children.length - 1];
  }

  // Return early if possible.
  if (!(box instanceof boxes.TextBox) || !box.text) return 0; // There's no text in last child.
  if (!['normal', 'nowrap', 'pre-line'].includes(box.style.get('white_space'))) return 0; // Spaces don't collapse.
  if (box.style.get('font_size') === 0) return 0; // Trailing spaces take no space.
  if (!box.text.endsWith(' ')) return 0; // No trailing space.

  // Strip text.
  const strippedText = box.text.replace(/ +$/, '');
  if (strippedText) {
    // Stripped text is not empty, calculate width difference.
    let resume: number | null = 0;
    let oldResume = 0;
    let oldBox: AnyBox = null;
    while (resume !== null) {
      oldResume = resume;
      [oldBox, resume] = splitTextBox(context, box, null, resume);
    }
    if (!oldBox) throw new Error('no old box');
    const strippedBoxIn = box.copyWithText(strippedText);
    const [strippedBox, resume2] = splitTextBox(context, strippedBoxIn, null, oldResume);
    if (strippedBox === null) {
      // Old box is split just before the trailing spaces.
      return oldBox.width;
    }
    // Return difference between old width and stripped width.
    if (resume2 !== null) throw new Error('expected a complete box');
    return oldBox.width - strippedBox.width;
  }
  // Stripped text is empty, render spaces to get width.
  let [, , , width] = getTextEngine().firstLine(box.text, box.style, context, null, box.justificationSpacing);
  // Remove possible trailing spaces from previous child.
  if (lastParent && lastParent.children.length >= 2) width += trailingWhitespaceSize(context, lastParent.children[lastParent.children.length - 2]);
  return width;
}

export type { TableResult };