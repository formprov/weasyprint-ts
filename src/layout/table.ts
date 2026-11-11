// SPDX-License-Identifier: BSD-3-Clause

/** Layout for tables and internal table boxes (mirrors layout/table.py). */
import { rgba } from '../css/color.ts';
import { getColor } from '../draw/color.ts';
import * as boxes from '../formatting_structure/boxes.ts';
import { layoutHooks } from '../formatting_structure/build.ts';
import { LOGGER } from '../logger.ts';
import {
  avoidPageBreak, blockContainerLayout, blockLevelPageBreak, findEarlierPageBreak as blockFindEarlierPageBreak, forcePageBreak,
  removePlaceholders, skipItem,
} from './block.ts';
import { resolveOnePercentage, resolvePercentages } from './percent.ts';
import { tableAndColumnsPreferredWidths } from './preferred.ts';

type AnyBox = any;
type SkipStack = Record<number, any> | null;

/** Layout for a table box. */
export function tableLayout(
  context: any, tableIn: AnyBox, bottomSpace: number, skipStack: SkipStack, containingBlock: AnyBox, pageIsEmptyIn: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
): any[] {
  let table = tableIn;
  let pageIsEmpty = pageIsEmptyIn;
  // Remove top and bottom decorations for split tables.
  const hasHeader = table.children.length > 0 && table.children[0].isHeader;
  const hasFooter = table.children.length > 0 && table.children[table.children.length - 1].isFooter;
  const collapse = table.style.get('border_collapse') === 'collapse';
  const removeStartDecoration = skipStack !== null && !hasHeader;
  table.removeDecoration(removeStartDecoration, false);

  // Set border spacings.
  let borderSpacingX: number;
  let borderSpacingY: number;
  if (collapse) borderSpacingX = borderSpacingY = 0;
  else [borderSpacingX, borderSpacingY] = table.style.get('border_spacing');

  // Define column positions.
  const columnWidths: number[] = table.columnWidths;
  const columnPositions: number[] = (table.columnPositions = []);
  const rowsLeftX = table.contentBoxX() + borderSpacingX;
  let rowsWidth: number;
  {
    let positionX: number;
    if (table.style.get('direction') === 'ltr') {
      positionX = table.contentBoxX();
      const rowsX = positionX + borderSpacingX;
      for (const width of columnWidths) {
        positionX += borderSpacingX;
        columnPositions.push(positionX);
        positionX += width;
      }
      rowsWidth = positionX - rowsX;
    } else {
      positionX = table.contentBoxX() + table.width;
      const rowsX = positionX - borderSpacingX;
      for (const width of columnWidths) {
        positionX -= borderSpacingX;
        positionX -= width;
        columnPositions.push(positionX);
      }
      rowsWidth = rowsX - positionX;
    }
  }

  // Set border top width on tables with collapsed borders and split cells.
  let skippedRows = 0;
  if (collapse) {
    table.skipCellBorderTop = false;
    table.skipCellBorderBottom = false;
    let splitCells = false;
    if (skipStack) {
      const [skippedGroups, groupSkipStack] = skipItem(skipStack);
      if (groupSkipStack) {
        const [rows, cellsSkipStack] = skipItem(groupSkipStack);
        skippedRows = rows;
        if (cellsSkipStack) splitCells = true;
      } else skippedRows = 0;
      for (const group of table.children.slice(0, skippedGroups)) skippedRows += group.children.length;
    } else skippedRows = 0;
    if (!splitCells && !hasHeader) {
      const [, horizontalBorders] = table.collapsedBorderGrid;
      if (horizontalBorders.length) {
        table.borderTopWidth = Math.max(...horizontalBorders[skippedRows].map(([, [, width]]: any) => width)) / 2;
      }
    }
  }

  // Make this a sub-function so that many local variables like rows_x don't need to be passed as parameters.
  const groupLayout = (
    groupIn: AnyBox, positionYIn: number, bottomSpaceG: number, pageIsEmptyG: boolean, skipStackG: SkipStack,
  ): [AnyBox, SkipStack, any] => {
    let group = groupIn;
    let positionY = positionYIn;
    let pageIsEmptyL = pageIsEmptyG;
    let skipStackL = skipStackG;
    let resumeAt: SkipStack = null;
    const nextPage: any = { break: 'any', page: null };
    const originalPageIsEmpty = pageIsEmptyL;
    resolvePercentages(group, table);
    group.positionX = rowsLeftX;
    group.positionY = positionY;
    group.width = rowsWidth;
    let newGroupChildren: AnyBox[] = [];
    // For each row, cells for which this is the last row (with rowspan).
    const endingCellsByRow: AnyBox[][] = group.children.map(() => []);

    const isGroupStart = skipStackL === null;
    let skip: number;
    if (isGroupStart) skip = 0;
    else [skip, skipStackL] = skipItem(skipStackL as Record<number, any>);
    for (let indexRow = skip; indexRow < group.children.length; indexRow++) {
      let row = group.children[indexRow];
      row.index = indexRow;

      if (newGroupChildren.length) {
        const pageBreak = blockLevelPageBreak(newGroupChildren[newGroupChildren.length - 1], row);
        if (forcePageBreak(pageBreak, context)) {
          nextPage.break = pageBreak;
          resumeAt = { [indexRow]: null };
          break;
        }
      }

      resolvePercentages(row, table);
      row.positionX = rowsLeftX;
      row.positionY = positionY;
      row.width = rowsWidth;
      // Place cells at the top of the row and layout their content.
      const newRowChildren: AnyBox[] = [];
      for (let indexCell = 0; indexCell < row.children.length; indexCell++) {
        let cell = row.children[indexCell];
        const spannedWidths = columnWidths.slice(cell.gridX).slice(0, cell.colspan);
        // In the fixed layout the grid width is set by cells in the first row and column elements.
        // This may be less than the previous value of cell.colspan if that would bring the cell
        // beyond the grid width.
        cell.colspan = spannedWidths.length;
        if (cell.colspan === 0) {
          // The cell is entirely beyond the grid width, remove it entirely. Subsequent cells in
          // the same row have greater grid_x, so they are beyond too.
          const cellIndex = row.children.indexOf(cell);
          const ignoredCells = row.children.slice(cellIndex);
          LOGGER.warning(`This row has more columns than the table, ignored ${ignoredCells.length} cells`);
          break;
        }
        resolvePercentages(cell, table);
        if (table.style.get('direction') === 'ltr') cell.positionX = columnPositions[cell.gridX];
        else cell.positionX = columnPositions[cell.gridX + cell.colspan - 1];
        cell.positionY = row.positionY;
        cell.marginTop = 0;
        cell.marginLeft = 0;
        cell.width = 0;
        const bordersPlusPadding = cell.borderWidth(); // with width==0
        // TODO: we should remove the number of columns with no originating cells to cell.colspan,
        // see test_layout_table_auto_49.
        cell.width = spannedWidths.reduce((a: number, b: number) => a + b, 0) + borderSpacingX * (cell.colspan - 1) - bordersPlusPadding;
        let cellSkipStack: SkipStack;
        if (skipStackL) {
          if (indexCell in skipStackL) cellSkipStack = skipStackL[indexCell];
          else cellSkipStack = { [cell.children.length]: null };
        } else cellSkipStack = null;

        // Adapt cell and table collapsing borders when a row is split.
        if (cellSkipStack && collapse) {
          if (hasHeader) {
            // We have a header, we have to adapt the position of the split cell to match the header's bottom border.
            const headerRows = table.children[0].children;
            if (headerRows.length && headerRows[headerRows.length - 1].children.length) {
              cell.positionY += Math.max(...headerRows[headerRows.length - 1].children.map((h: AnyBox) => h.borderBottomWidth));
            }
          } else {
            // We don't have a header, we have to skip the decoration at the top of the table when it's drawn.
            table.skipCellBorderTop = true;
          }
        }

        // First try to render content as if there was already something on the page to avoid hitting
        // block_level_layout's TODO. Then force to render something if the page is actually empty, or
        // just draw an empty cell otherwise. See test_table_break_children_margin.
        // Pretend that height is not set, keeping computed height as a minimum.
        cell.computedHeight = cell.height;
        cell.height = 'auto';
        const originalStyle = cell.style;
        if (cell.style.get('height') !== 'auto') {
          const styleCopy = cell.style.copy();
          styleCopy.set('height', 'auto');
          cell.style = styleCopy;
        }
        let [newCell, cellResumeAt] = blockContainerLayout(
          context, cell, bottomSpaceG, cellSkipStack, pageIsEmptyL, absoluteBoxes, fixedBoxes, null, null, null, false, null);
        cell.style = originalStyle;
        if (newCell === null) {
          cell = cell.copyWithChildren([]);
          [cell] = blockContainerLayout(context, cell, bottomSpaceG, cellSkipStack, true, [], [], null, null, null, false, null);
          cellResumeAt = { 0: null };
        } else cell = newCell;

        cell.removeDecoration(cellSkipStack !== null, false);
        if (cellResumeAt) {
          if (resumeAt === null) resumeAt = { [indexRow]: {} };
          resumeAt[indexRow][indexCell] = cellResumeAt;
        }
        cell.empty = !cell.children.some((child: AnyBox) => child.isFloated() || child.isInNormalFlow());
        cell.contentHeight = cell.height;
        if (cell.computedHeight !== 'auto') cell.height = Math.max(cell.height, cell.computedHeight);
        newRowChildren.push(cell);
      }

      if (resumeAt && !pageIsEmptyL) {
        // Avoid break when "break-inside: avoid" is set on row or any on its cells.
        const avoidBreak = avoidPageBreak(row.style.get('break_inside'), context) ||
          row.children.some((c: AnyBox) => avoidPageBreak(c.style.get('break_inside'), context));
        if (avoidBreak) {
          removePlaceholders(context, newRowChildren, absoluteBoxes, fixedBoxes);
          [newGroupChildren, resumeAt] = findEarlierPageBreak(context, row, indexRow, newGroupChildren, originalPageIsEmpty, absoluteBoxes, fixedBoxes) as [AnyBox[], SkipStack];
          if (resumeAt === null) return [null, null, nextPage];
          break;
        }
      }

      if (resumeAt) {
        // Remove bottom decoration if row is split.
        for (const cell of newRowChildren) cell.removeDecoration(false, true);
      }

      row = row.copyWithChildren(newRowChildren);

      // Table height algorithm: https://www.w3.org/TR/CSS21/tables.html#height-layout

      // Set row baseline with cells with vertical-align: baseline.
      const baselineCells: AnyBox[] = [];
      for (const cell of row.children) {
        const verticalAlign = cell.style.get('vertical_align');
        if (['top', 'middle', 'bottom'].includes(verticalAlign)) cell.verticalAlign = verticalAlign;
        else {
          // Assume 'baseline' for any other value.
          cell.verticalAlign = 'baseline';
          cell.baseline = cellBaseline(cell);
          baselineCells.push(cell);
        }
      }
      if (baselineCells.length) {
        row.baseline = Math.max(...baselineCells.map((c) => c.baseline));
        for (const cell of baselineCells) {
          const extra = row.baseline - cell.baseline;
          if (cell.baseline !== row.baseline && extra) addTopPadding(cell, extra);
        }
      }

      // Set row height.
      for (const cell of row.children) endingCellsByRow[cell.rowspan - 1].push(cell);
      const endingCells = endingCellsByRow.shift()!;
      let rowBottomY: number;
      if (endingCells.length) {
        // in this row
        if (row.height === 'auto') {
          rowBottomY = Math.max(...endingCells.map((c) => c.positionY + c.borderHeight()));
          row.height = Math.max(rowBottomY - row.positionY, 0);
        } else {
          row.height = Math.max(row.height, Math.max(...endingCells.map((c) => c.borderHeight())));
          rowBottomY = row.positionY + row.height;
        }
      } else {
        rowBottomY = row.positionY;
        row.height = 0;
      }

      if (!baselineCells.length) row.baseline = rowBottomY;

      // Add extra padding to make the cells the same height as the row and honor vertical-align.
      for (const cell of endingCells) {
        const cellBottomY = cell.positionY + cell.borderHeight();
        let extra = rowBottomY - cellBottomY;
        if (extra) {
          if (cell.verticalAlign === 'bottom') addTopPadding(cell, extra);
          else if (cell.verticalAlign === 'middle') {
            extra /= 2;
            addTopPadding(cell, extra);
            cell.paddingBottom += extra;
          } else cell.paddingBottom += extra;
        }
        if (cell.computedHeight !== 'auto') {
          let verticalAlignShift = 0;
          if (cell.verticalAlign === 'middle') verticalAlignShift = (cell.computedHeight - cell.contentHeight) / 2;
          else if (cell.verticalAlign === 'bottom') verticalAlignShift = cell.computedHeight - cell.contentHeight;
          if (verticalAlignShift > 0) for (const child of cell.children) child.translate(0, verticalAlignShift);
        }
      }

      let nextPositionY = row.positionY + row.height;
      if (resumeAt === null) nextPositionY += borderSpacingY;

      // Break if one cell was broken.
      let breakCell = false;
      if (resumeAt) {
        if (row.children.every((child: AnyBox) => child.empty)) {
          // No cell was displayed, give up row.
          nextPositionY = Infinity;
          pageIsEmptyL = false;
          resumeAt = null;
        } else breakCell = true;
      }

      // Break if this row overflows the page, unless there is no other content on the page.
      const overflow = context.overflowsPage(bottomSpaceG, nextPositionY);
      if (!pageIsEmptyL && overflow) {
        removePlaceholders(context, row.children, absoluteBoxes, fixedBoxes);
        [newGroupChildren, resumeAt] = findEarlierPageBreak(context, row, indexRow, newGroupChildren, originalPageIsEmpty, absoluteBoxes, fixedBoxes) as [AnyBox[], SkipStack];
        if (resumeAt === null) return [null, null, nextPage];
        break;
      }

      newGroupChildren.push(row);
      positionY = nextPositionY;
      pageIsEmptyL = false;
      skipStackL = null;

      if (breakCell && collapse && !hasFooter) table.skipCellBorderBottom = true;

      if (breakCell || resumeAt) break;
    }

    // Do not keep the row group if we made a page break before any of its rows or with 'avoid'.
    const abort = resumeAt && !originalPageIsEmpty && (avoidPageBreak(group.style.get('break_inside'), context) || !newGroupChildren.length);
    if (abort) {
      removePlaceholders(context, newGroupChildren, absoluteBoxes, fixedBoxes);
      return [null, null, nextPage];
    }

    group = group.copyWithChildren(newGroupChildren);
    group.removeDecoration(!isGroupStart, resumeAt !== null);

    // Set missing baselines in a second loop because of rowspan.
    for (const row of group.children) {
      if (row.baseline === null || row.baseline === undefined) {
        if (row.children.length) {
          // Set baseline to lowest bottom content edge.
          row.baseline = Math.max(...row.children.map((c: AnyBox) => c.contentBoxY() + c.height)) - row.positionY;
        } else row.baseline = 0;
      }
    }
    group.height = positionY - group.positionY;
    if (group.children.length) {
      // The last border spacing is outside of the group.
      group.height -= borderSpacingY;
    }
    return [group, resumeAt, nextPage];
  };

  const bodyGroupsLayout = (
    skipStackB: SkipStack, positionYIn: number, bottomSpaceB: number, pageIsEmptyB: boolean,
  ): [AnyBox[] | null, SkipStack, any, number] => {
    let positionY = positionYIn;
    let pageIsEmptyL = pageIsEmptyB;
    let skipStackL = skipStackB;
    let skip: number;
    if (skipStackL === null) skip = 0;
    else [skip, skipStackL] = skipItem(skipStackL);
    let newTableChildren: AnyBox[] | null = [];
    let resumeAt: SkipStack = null;
    let nextPage: any = { break: 'any', page: null };

    const groups = table.children.slice(skip);
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      if (group.isHeader || group.isFooter) continue;

      // Index is useless for headers and footers, as we never want to break pages after the header or before the footer.
      const indexGroup = i + skip;
      group.index = indexGroup;

      if (newTableChildren!.length) {
        const pageBreak = blockLevelPageBreak(newTableChildren![newTableChildren!.length - 1], group);
        if (forcePageBreak(pageBreak, context)) {
          nextPage.break = pageBreak;
          resumeAt = { [indexGroup]: null };
          break;
        }
      }

      let newGroup: AnyBox;
      [newGroup, resumeAt, nextPage] = groupLayout(group, positionY, bottomSpaceB, pageIsEmptyL, skipStackL);
      skipStackL = null;

      if (newGroup === null) {
        [newTableChildren, resumeAt] = findEarlierPageBreak(context, group, indexGroup, newTableChildren!, pageIsEmptyL, absoluteBoxes, fixedBoxes);
        if (resumeAt === null) return [null, null, nextPage, positionY];
        break;
      }

      newTableChildren!.push(newGroup);
      positionY += newGroup.height + borderSpacingY;
      pageIsEmptyL = false;

      if (resumeAt) {
        resumeAt = { [indexGroup]: resumeAt };
        break;
      }
    }
    return [newTableChildren, resumeAt, nextPage, positionY];
  };

  // Layout row groups, rows and cells.
  let positionY = table.contentBoxY();
  if (skipStack === null) positionY += borderSpacingY;
  const initialPositionY = positionY;
  const tableRows = table.children.filter((child: AnyBox) => !child.isHeader && !child.isFooter);

  const allGroupsLayout = (): [AnyBox, AnyBox[] | null, AnyBox, number, SkipStack, any] => {
    // If the page is not empty, we try to render the header and the footer on it. If the table
    // does not fit on the page, we try to render it on the next page.
    // If the page is empty and the header and footer are too big, there are not rendered. If no row
    // can be rendered because of the header and the footer, the header and/or the footer are not rendered.
    const headerFooterBottomSpace = pageIsEmpty ? bottomSpace : -Infinity;

    let header: AnyBox = null;
    let headerHeight = 0;
    let footer: AnyBox = null;
    let footerHeight = 0;
    let resumeAt: SkipStack;
    let nextPage: any;
    if (hasHeader) {
      [header, resumeAt, nextPage] = groupLayout(table.children[0], positionY, headerFooterBottomSpace, false, null);
      if (header && !resumeAt) headerHeight = header.height + borderSpacingY;
      else header = null; // Header too big for the page.
    }
    if (hasFooter) {
      [footer, resumeAt, nextPage] = groupLayout(table.children[table.children.length - 1], positionY, headerFooterBottomSpace, false, null);
      if (footer && !resumeAt) footerHeight = footer.height + borderSpacingY;
      else footer = null; // Footer too big for the page.
    }

    // Don't remove headers and footers if breaks are avoided in line groups.
    let skip: number;
    if (skipStack) [skip] = skipItem(skipStack);
    else skip = 0;
    let avoidBreaks = false;
    for (const group of table.children.slice(skip)) {
      if (!group.isHeader && !group.isFooter) {
        avoidBreaks = avoidPageBreak(group.style.get('break_inside'), context);
        break;
      }
    }

    let newTableChildren: AnyBox[] | null;
    let endPositionY: number;
    if (header && footer) {
      // Try with both the header and footer.
      [newTableChildren, resumeAt, nextPage, endPositionY] = bodyGroupsLayout(skipStack, positionY + headerHeight, bottomSpace + footerHeight, avoidBreaks);
      if ((newTableChildren && newTableChildren.length) || !tableRows.length || !pageIsEmpty) {
        footer.translate(0, endPositionY - footer.positionY);
        endPositionY += footerHeight;
        return [header, newTableChildren, footer, endPositionY, resumeAt, nextPage];
      }
      // We could not fit any content, drop the footer.
      footer = null;
    }

    if (header && !footer) {
      // Try with just the header.
      [newTableChildren, resumeAt, nextPage, endPositionY] = bodyGroupsLayout(skipStack, positionY + headerHeight, bottomSpace, avoidBreaks);
      if ((newTableChildren && newTableChildren.length) || !tableRows.length || !pageIsEmpty) {
        return [header, newTableChildren, footer, endPositionY, resumeAt, nextPage];
      }
      // We could not fit any content, drop the header.
      header = null;
    }

    if (footer && !header) {
      // Try with just the footer.
      [newTableChildren, resumeAt, nextPage, endPositionY] = bodyGroupsLayout(skipStack, positionY, bottomSpace + footerHeight, avoidBreaks);
      if ((newTableChildren && newTableChildren.length) || !tableRows.length || !pageIsEmpty) {
        footer.translate(0, endPositionY - footer.positionY);
        endPositionY += footerHeight;
        return [header, newTableChildren, footer, endPositionY, resumeAt, nextPage];
      }
      // We could not fit any content, drop the footer.
      footer = null;
    }

    [newTableChildren, resumeAt, nextPage, endPositionY] = bodyGroupsLayout(skipStack, positionY, bottomSpace, pageIsEmpty);
    return [header, newTableChildren, footer, endPositionY, resumeAt, nextPage];
  };

  const getColumnCells = (tbl: AnyBox, column: AnyBox) => (): AnyBox[] => {
    const out: AnyBox[] = [];
    for (const rowGroup of tbl.children) for (const row of rowGroup.children) for (const cell of row.children) if (cell.gridX === column.gridX) out.push(cell);
    return out;
  };

  const [header, newTableChildren, footer, endY, resumeAt, nextPage] = allGroupsLayout();
  positionY = endY;

  if (newTableChildren === null) {
    return [null, resumeAt, nextPage, [], false];
  }

  table = table.copyWithChildren([...(header !== null ? [header] : []), ...newTableChildren, ...(footer !== null ? [footer] : [])]);
  table.columnGroups = table.columnGroups.map((g: AnyBox) => g.deepcopy());
  const removeEndDecoration = resumeAt !== null && !hasFooter;
  table.removeDecoration(removeStartDecoration, removeEndDecoration);
  if (collapse) table.skippedRows = skippedRows;

  // If the height property has a bigger value, just add blank space below the last row group.
  table.height = Math.max(table.height !== 'auto' ? table.height : 0, positionY - table.contentBoxY());

  // Layout column groups and columns.
  let columnsHeight = positionY - initialPositionY;
  if (table.children.length) {
    // The last border spacing is below the columns.
    columnsHeight -= borderSpacingY;
  }
  for (const group of table.columnGroups) {
    for (const column of group.children) {
      resolvePercentages(column, table);
      if (column.gridX < columnPositions.length) {
        column.positionX = columnPositions[column.gridX];
        column.positionY = initialPositionY;
        column.width = columnWidths[column.gridX];
        column.height = columnsHeight;
      } else {
        // Ignore extra empty columns.
        column.positionX = 0;
        column.positionY = 0;
        column.width = 0;
        column.height = 0;
      }
      resolvePercentages(group, table);
      column.getCells = getColumnCells(table, column);
    }
    const first = group.children[0];
    const last = group.children[group.children.length - 1];
    group.positionX = first.positionX;
    group.positionY = initialPositionY;
    group.width = last.positionX + last.width - first.positionX;
    group.height = columnsHeight;
  }

  // Invert columns for drawing.
  if (table.style.get('direction') === 'rtl') {
    columnWidths.reverse();
    columnPositions.reverse();
  }

  const avoidBreak = avoidPageBreak(table.style.get('break_inside'), context);
  let resume = resumeAt;
  if (resume && !pageIsEmpty && avoidBreak) {
    removePlaceholders(context, [table], absoluteBoxes, fixedBoxes);
    table = null;
    resume = null;
  }
  return [table, resume, nextPage, [], false];
}

/** Increase the top padding of a box (this also translates the children). */
export function addTopPadding(box: AnyBox, extraPadding: number): void {
  box.paddingTop += extraPadding;
  for (const child of box.children) child.translate(0, extraPadding);
}

/** Run the fixed table layout and set column widths (https://www.w3.org/TR/CSS21/tables.html#fixed-table-layout). */
export function fixedTableLayout(box: AnyBox): void {
  const table = box.getWrappedTable();
  if (table.width === 'auto') throw new Error('fixed layout needs a width');

  const allColumns: AnyBox[] = table.columnGroups.flatMap((g: AnyBox) => g.children);
  let firstRowCells: AnyBox[];
  if (table.children.length && table.children[0].children.length) {
    firstRowCells = table.children[0].children[0].children;
  } else firstRowCells = [];
  const numColumns = Math.max(allColumns.length, firstRowCells.reduce((s, c) => s + c.colspan, 0));
  // ``null`` means not know yet.
  let columnWidths: Array<number | null> = Array(numColumns).fill(null);

  // Set width on column boxes.
  allColumns.forEach((column, i) => {
    resolveOnePercentage(column, 'width', table.width);
    if (column.width !== 'auto') columnWidths[i] = column.width;
  });

  let borderSpacingX = 0;
  if (table.style.get('border_collapse') === 'separate') [borderSpacingX] = table.style.get('border_spacing');

  // Set width on cells of the first row.
  let i = 0;
  for (const cell of firstRowCells) {
    resolvePercentages(cell, table);
    if (cell.width !== 'auto') {
      let width = cell.borderWidth();
      width -= borderSpacingX * (cell.colspan - 1);
      // In the general case, this width affects several columns (through colspan) some of which
      // already have a width. Subtract these known widths and divide among remaining columns.
      const columnsWithoutWidth: number[] = [];
      for (let j = i; j < i + cell.colspan; j++) {
        if (columnWidths[j] === null) columnsWithoutWidth.push(j);
        else width -= columnWidths[j]!;
      }
      if (columnsWithoutWidth.length) {
        const widthPerColumn = width / columnsWithoutWidth.length;
        for (const j of columnsWithoutWidth) columnWidths[j] = widthPerColumn;
      }
    }
    i += cell.colspan;
  }

  // Distribute the remaining space equally on columns that do not have a width yet.
  const allBorderSpacing = borderSpacingX * (numColumns + 1);
  const minTableWidth = columnWidths.filter((w) => w !== null).reduce((a, w) => a + (w as number), 0) + allBorderSpacing;
  const columnsWithoutWidth = columnWidths.map((w, idx) => (w === null ? idx : -1)).filter((idx) => idx >= 0);
  if (columnsWithoutWidth.length && table.width >= minTableWidth) {
    const remainingWidth = table.width - minTableWidth;
    const widthPerColumn = remainingWidth / columnsWithoutWidth.length;
    for (const idx of columnsWithoutWidth) columnWidths[idx] = widthPerColumn;
  } else {
    // This is bad, but we were given a broken table.
    for (const idx of columnsWithoutWidth) columnWidths[idx] = 0;
  }

  // If the sum is less than the table width, distribute the remaining space equally.
  let widths = columnWidths as number[];
  const extraWidth = table.width - widths.reduce((a, b) => a + b, 0) - allBorderSpacing;
  if (extraWidth <= 0) {
    // Subtract a negative: widen the table.
    table.width -= extraWidth;
  } else if (numColumns) {
    const extraPerColumn = extraWidth / numColumns;
    widths = widths.map((w) => w + extraPerColumn);
  }
  // Now we have table.width == sum(column_widths) + all_border_spacing, with possible floating
  // point rounding errors (unless there is zero column).
  table.columnWidths = widths;
}

/** Run the auto table layout and set column widths (https://www.w3.org/TR/CSS21/tables.html#auto-table-layout). */
export function autoTableLayout(context: any, box: AnyBox, containingBlock: [number, number]): void {
  const table = box.getWrappedTable();
  const [
    tableMinContentWidth, tableMaxContentWidth, columnMinContentWidths, columnMaxContentWidths, columnIntrinsicPercentages,
    constrainedness, totalHorizontalBorderSpacing, grid,
  ] = tableAndColumnsPreferredWidths(context, box, false);

  let margins = 0;
  if (box.marginLeft !== 'auto') margins += box.marginLeft;
  if (box.marginRight !== 'auto') margins += box.marginRight;
  const paddings = table.paddingLeft + table.paddingRight;
  const borders = table.borderLeftWidth + table.borderRightWidth;

  const [cbWidth] = containingBlock;
  const availableWidth = cbWidth - margins - paddings - borders;

  if (table.width === 'auto') {
    if (availableWidth <= tableMinContentWidth) table.width = tableMinContentWidth;
    else if (availableWidth < tableMaxContentWidth) table.width = availableWidth;
    else table.width = tableMaxContentWidth;
  } else if (table.width < tableMinContentWidth) table.width = tableMinContentWidth;

  if (!grid.length) {
    table.columnWidths = [];
    return;
  }

  const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);
  const assignableWidth = table.width - totalHorizontalBorderSpacing;
  const minContentGuess: number[] = columnMinContentWidths.slice();
  const minContentPercentageGuess: number[] = columnMinContentWidths.slice();
  const minContentSpecifiedGuess: number[] = columnMinContentWidths.slice();
  const maxContentGuess: number[] = columnMaxContentWidths.slice();
  const guesses = [minContentGuess, minContentPercentageGuess, minContentSpecifiedGuess, maxContentGuess];
  // See https://www.w3.org/TR/css-tables-3/#width-distribution-algorithm.
  for (let i = 0; i < grid.length; i++) {
    if (columnIntrinsicPercentages[i]) {
      minContentPercentageGuess[i] = Math.max((columnIntrinsicPercentages[i] / 100) * assignableWidth, columnMinContentWidths[i]);
      minContentSpecifiedGuess[i] = minContentPercentageGuess[i];
      maxContentGuess[i] = minContentPercentageGuess[i];
    } else if (constrainedness[i]) {
      // Any other column that is constrained is assigned its max-content width.
      minContentSpecifiedGuess[i] = columnMaxContentWidths[i];
    }
  }

  // We have to work around floating point rounding errors here. The 1e-9 value comes from PEP 485.
  if (assignableWidth * (1 + 1e-9) < sum(maxContentGuess)) {
    let lowerGuess: number[] | undefined;
    let upperGuess: number[] | undefined;
    for (const guess of guesses) {
      if (sum(guess) <= assignableWidth * (1 + 1e-9)) lowerGuess = guess;
      else break;
    }
    for (const guess of [...guesses].reverse()) {
      if (sum(guess) >= assignableWidth * (1 - 1e-9)) upperGuess = guess;
      else break;
    }
    if (lowerGuess === undefined || upperGuess === undefined) throw new Error('no width guess');
    if (upperGuess === lowerGuess || upperGuess.every((v, i) => v === lowerGuess![i])) {
      table.columnWidths = upperGuess;
    } else {
      const addedWidths = grid.map((_: any, i: number) => (upperGuess as number[])[i] - (lowerGuess as number[])[i]);
      const availableRatio = (assignableWidth - sum(lowerGuess)) / sum(addedWidths);
      table.columnWidths = grid.map((_: any, i: number) => (lowerGuess as number[])[i] + addedWidths[i] * availableRatio);
    }
  } else {
    table.columnWidths = maxContentGuess;
    const excessWidth = assignableWidth - sum(maxContentGuess);
    distributeExcessWidth(context, grid, excessWidth, table.columnWidths, constrainedness, columnIntrinsicPercentages, columnMaxContentWidths);
  }
}

/** Find the width of each column and derive the wrapper width. */
export function tableWrapperWidth(context: any, wrapper: AnyBox, containingBlock: [number, number]): void {
  const table = wrapper.getWrappedTable();
  resolvePercentages(table, containingBlock);

  if (table.style.get('table_layout') === 'fixed' && table.width !== 'auto') fixedTableLayout(wrapper);
  else autoTableLayout(context, wrapper, containingBlock);

  wrapper.width = table.borderWidth();
}

/** The y position of a cell baseline from the top of its border box (https://www.w3.org/TR/CSS21/tables.html#height-layout). */
export function cellBaseline(cell: AnyBox): number {
  const result = findInFlowBaseline(cell, false, [boxes.LineBox, boxes.TableRowBox]);
  if (result !== null) return result - cell.positionY;
  // Default to the bottom of the content area.
  return cell.borderTopWidth + cell.paddingTop + cell.height;
}

/** The absolute y position for the first (or last) in-flow baseline, or null. */
export function findInFlowBaseline(box: AnyBox, last = false, baselineTypes: Array<new (...a: any[]) => any> = [boxes.LineBox]): number | null {
  // TODO: synthesize baseline when needed. See https://www.w3.org/TR/css-align-3/#synthesize-baseline.
  if (baselineTypes.some((t) => box instanceof t)) return box.positionY + box.baseline;
  if (box instanceof boxes.TableCaptionBox) return null;
  const children = last ? [...box.children].reverse() : box.children;
  for (const child of children) {
    if (child.isInNormalFlow()) {
      const result = findInFlowBaseline(child, last, baselineTypes);
      if (result !== null) return result;
    }
  }
  return null;
}

/** Distribute available width to columns (https://www.w3.org/TR/css-tables-3/#distributing-width-to-columns). */
export function distributeExcessWidth(
  _context: any, grid: any[][], excessWidth: number, columnWidths: number[], constrainedness: boolean[],
  columnIntrinsicPercentages: number[], columnMaxContentWidths: number[], columnSlice: [number, number] | null = null,
): void {
  const start = columnSlice ? columnSlice[0] : 0;
  const slice = grid.slice(columnSlice ? columnSlice[0] : 0, columnSlice ? columnSlice[1] : undefined);
  const indexes = slice.map((_, k) => start + k);

  // First group.
  let columns = indexes.filter((i) => !constrainedness[i] && columnIntrinsicPercentages[i] === 0 && columnMaxContentWidths[i] > 0);
  if (columns.length) {
    const sumMax = columns.reduce((a, i) => a + columnMaxContentWidths[i], 0);
    const ratio = excessWidth / sumMax;
    for (const i of columns) columnWidths[i] += columnMaxContentWidths[i] * ratio;
    return;
  }

  // Second group.
  columns = indexes.filter((i) => !constrainedness[i] && columnIntrinsicPercentages[i] === 0);
  if (columns.length) {
    for (const i of columns) columnWidths[i] += excessWidth / columns.length;
    return;
  }

  // Third group.
  columns = indexes.filter((i) => constrainedness[i] && columnIntrinsicPercentages[i] === 0 && columnMaxContentWidths[i] > 0);
  if (columns.length) {
    const sumMax = columns.reduce((a, i) => a + columnMaxContentWidths[i], 0);
    const ratio = excessWidth / sumMax;
    for (const i of columns) columnWidths[i] += columnMaxContentWidths[i] * ratio;
    return;
  }

  // Fourth group.
  columns = indexes.filter((i) => columnIntrinsicPercentages[i] > 0 && columnMaxContentWidths[i] > 0);
  if (columns.length) {
    const sumPct = columns.reduce((a, i) => a + columnIntrinsicPercentages[i], 0);
    const ratio = excessWidth / sumPct;
    for (const i of columns) columnWidths[i] += columnIntrinsicPercentages[i] * ratio;
    return;
  }

  // Fifth group.
  columns = indexes.filter((i) => grid[i].some(Boolean));
  if (columns.length) {
    for (const i of columns) columnWidths[i] += excessWidth / columns.length;
    return;
  }

  // Sixth group.
  for (const i of indexes) columnWidths[i] += excessWidth / indexes.length;
}

const TRANSPARENT = rgba(0, 0, 0, 0);

/**
 * Resolve border conflicts for a table in the collapsing border model. Sets appropriate border widths
 * on the table, column group, column, row group, row, and cell boxes; returns the resolved collapsed
 * border grid ``[verticalBorders, horizontalBorders]``.
 */
export function collapseTableBorders(table: AnyBox, gridWidth: number, gridHeight: number): [any[][], any[][]] {
  if (!(gridWidth && gridHeight)) {
    // Don't bother with empty tables.
    return [[], []];
  }

  const styles = ['hidden', 'double', 'solid', 'dashed', 'dotted', 'ridge', 'outset', 'groove', 'inset', 'none'].reverse();
  const styleScores: Record<string, number> = Object.fromEntries(styles.map((s, score) => [s, score]));
  const styleMap: Record<string, string> = { inset: 'ridge', outset: 'groove' };
  const weakNullBorder: any = [[0, 0, styleScores.none], ['none', 0, TRANSPARENT]];

  // Borders are always stored left to right, top to bottom.
  const verticalBorders: any[][] = Array.from({ length: gridHeight }, () => Array(gridWidth + 1).fill(weakNullBorder));
  const horizontalBorders: any[][] = Array.from({ length: gridHeight + 1 }, () => Array(gridWidth).fill(weakNullBorder));

  const cmpScore = (a: number[], b: number[]): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const at = <T>(arr: T[], idx: number): number => (idx < 0 ? arr.length + idx : idx);

  const setOneBorder = (borderGrid: any[][], boxStyle: any, side: string, gridX: number, gridY: number): void => {
    const style: string = boxStyle.get(`border_${side}_style`);
    const width: number = boxStyle.get(`border_${side}_width`);
    const color = getColor(boxStyle, `border_${side}_color`);

    // See https://www.w3.org/TR/CSS21/tables.html#border-conflict-resolution.
    const score = [style === 'hidden' ? 1 : 0, width, styleScores[style]];
    const mappedStyle = styleMap[style] ?? style;
    const row = borderGrid[gridY];
    const x = at(row, gridX);
    const [previousScore] = row[x];
    // Strict < so that the earlier call wins in case of a tie.
    if (cmpScore(previousScore, score) < 0) row[x] = [score, [mappedStyle, width, color]];
  };

  const setBorders = (box: AnyBox, x: number, y: number, w: number, h: number): void => {
    const style = box.style;
    // x and y are logical (possibly rtl), but borders are graphical (always ltr).
    if (table.style.get('direction') === 'ltr') {
      for (let yy = y; yy < y + h; yy++) {
        setOneBorder(verticalBorders, style, 'left', x, yy);
        setOneBorder(verticalBorders, style, 'right', x + w, yy);
      }
      for (let xx = x; xx < x + w; xx++) {
        setOneBorder(horizontalBorders, style, 'top', xx, y);
        setOneBorder(horizontalBorders, style, 'bottom', xx, y + h);
      }
    } else {
      for (let yy = y; yy < y + h; yy++) {
        setOneBorder(verticalBorders, style, 'left', -1 - w - x, yy);
        setOneBorder(verticalBorders, style, 'right', -1 - x, yy);
      }
      for (let xx = -1 - x; xx > -1 - x - w; xx--) {
        setOneBorder(horizontalBorders, style, 'top', xx, y);
        setOneBorder(horizontalBorders, style, 'bottom', xx, y + h);
      }
    }
  };

  // Set cell borders. The order is important here: "A style set on a cell wins over one on a row,
  // which wins over a row group, column, column group and, lastly, table".
  const strongNullBorder: any = [[1, 0, styleScores.hidden], ['hidden', 0, TRANSPARENT]];
  const range = (a: number, b: number, step = 1): number[] => {
    const out: number[] = [];
    if (step > 0) for (let v = a; v < b; v += step) out.push(v);
    else for (let v = a; v > b; v += step) out.push(v);
    return out;
  };
  let gridY = 0;
  for (const rowGroup of table.children) {
    for (const row of rowGroup.children) {
      for (const cell of row.children) {
        // Force null border inside of a cell with rowspan or colspan.
        const { gridX, colspan, rowspan } = cell;
        let verticalXRange: number[];
        let horizontalXRange: number[];
        if (table.style.get('direction') === 'ltr') {
          verticalXRange = range(gridX + 1, gridX + colspan);
          horizontalXRange = range(gridX, gridX + colspan);
        } else {
          verticalXRange = range(-2 - gridX, -1 - gridX - colspan, -1);
          horizontalXRange = range(-1 - gridX, -1 - gridX - colspan, -1);
        }
        for (const xx of verticalXRange) {
          for (let yy = gridY; yy < gridY + rowspan; yy++) verticalBorders[yy][at(verticalBorders[yy], xx)] = strongNullBorder;
        }
        for (const xx of horizontalXRange) {
          for (let yy = gridY + 1; yy < gridY + rowspan; yy++) horizontalBorders[yy][at(horizontalBorders[yy], xx)] = strongNullBorder;
        }
        // Set cell border.
        setBorders(cell, gridX, gridY, colspan, rowspan);
      }
      gridY += 1;
    }
  }

  // Set row borders.
  gridY = 0;
  for (const rowGroup of table.children) {
    for (const row of rowGroup.children) {
      setBorders(row, 0, gridY, gridWidth, 1);
      gridY += 1;
    }
  }

  // Set row group borders.
  gridY = 0;
  for (const rowGroup of table.children) {
    const rowspan = rowGroup.children.length;
    setBorders(rowGroup, 0, gridY, gridWidth, rowspan);
    gridY += rowspan;
  }

  // Set column borders.
  for (const columnGroup of table.columnGroups) {
    for (const column of columnGroup.children) setBorders(column, column.gridX, 0, 1, gridHeight);
  }

  // Set column group borders.
  for (const columnGroup of table.columnGroups) setBorders(columnGroup, columnGroup.gridX, 0, columnGroup.span, gridHeight);

  // Set table borders.
  setBorders(table, 0, 0, gridWidth, gridHeight);

  // Now that all conflicts are resolved, set transparent borders of the correct widths on each
  // box. The actual border grid will be painted separately.
  const setBorderUsedWidth = (box: AnyBox, side: string, twiceWidth: number): void => {
    const prop = `border_${side}_width`;
    box[`border${side[0].toUpperCase()}${side.slice(1)}Width`] = twiceWidth / 2;
    (box.collapsedBorderWidths ??= new Set()).add(prop);
  };
  const removeBorders = (box: AnyBox): void => {
    for (const side of ['top', 'right', 'bottom', 'left']) setBorderUsedWidth(box, side, 0);
  };
  const sliceNeg = <T>(arr: T[], a: number | null, b: number | null): T[] => {
    const start = a === null ? 0 : a < 0 ? arr.length + a : a;
    const end = b === null ? arr.length : b < 0 ? arr.length + b : b;
    return arr.slice(start, end);
  };
  const maxVerticalWidth = (x: number, y1: number, y2: number): number =>
    Math.max(...verticalBorders.slice(y1, y2).map((gridRow) => gridRow[at(gridRow, x)][1][1]));
  const maxHorizontalWidth = (x1: number, y: number, x2: number | null): number =>
    Math.max(...sliceNeg(horizontalBorders[y], x1, x2).map(([, [, width]]: any) => width));

  gridY = 0;
  for (const rowGroup of table.children) {
    removeBorders(rowGroup);
    for (const row of rowGroup.children) {
      removeBorders(row);
      for (const cell of row.children) {
        const x = cell.gridX;
        const y = gridY;
        const { colspan, rowspan } = cell;
        let top: number;
        let bottom: number;
        let left: number;
        let right: number;
        if (table.style.get('direction') === 'ltr') {
          top = maxHorizontalWidth(x, y, x + colspan);
          bottom = maxHorizontalWidth(x, y + rowspan, x + colspan);
          left = maxVerticalWidth(x, y, y + rowspan);
          right = maxVerticalWidth(x + colspan, y, y + rowspan);
        } else {
          top = maxHorizontalWidth(-colspan - x, y, -x || null);
          bottom = maxHorizontalWidth(-colspan - x, y + rowspan, -x || null);
          left = maxVerticalWidth(-1 - colspan - x, y, y + rowspan);
          right = maxVerticalWidth(-1 - x, y, y + rowspan);
        }
        setBorderUsedWidth(cell, 'top', top);
        setBorderUsedWidth(cell, 'bottom', bottom);
        setBorderUsedWidth(cell, 'left', left);
        setBorderUsedWidth(cell, 'right', right);
      }
      gridY += 1;
    }
  }

  for (const columnGroup of table.columnGroups) {
    removeBorders(columnGroup);
    for (const column of columnGroup.children) removeBorders(column);
  }

  setBorderUsedWidth(table, 'top', maxHorizontalWidth(0, 0, gridWidth));
  setBorderUsedWidth(table, 'bottom', maxHorizontalWidth(0, gridHeight, gridWidth));
  // "UAs must compute an initial left and right border width for the table by examining the first and
  // last cells in the first row of the table." https://www.w3.org/TR/CSS21/tables.html#collapsing-borders
  // ... so h=1, not grid_height:
  setBorderUsedWidth(table, 'left', maxVerticalWidth(0, 0, 1));
  setBorderUsedWidth(table, 'right', maxVerticalWidth(gridWidth, 0, 1));

  return [verticalBorders, horizontalBorders];
}

function findEarlierPageBreak(
  context: any, element: AnyBox, index: number, previousList: AnyBox[], pageIsEmpty: boolean, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
): [AnyBox[] | null, SkipStack] {
  if (previousList.length) {
    const pageBreak = blockLevelPageBreak(previousList[previousList.length - 1], element);
    if (avoidPageBreak(pageBreak, context)) {
      const earlierPageBreak = blockFindEarlierPageBreak(context, previousList, absoluteBoxes, fixedBoxes);
      if (earlierPageBreak) return earlierPageBreak;
    } else return [previousList, { [index]: null }];
  }
  return pageIsEmpty ? [previousList, { [index]: null }] : [null, null];
}

layoutHooks.collapseTableBorders = collapseTableBorders;