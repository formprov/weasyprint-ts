// SPDX-License-Identifier: BSD-3-Clause

/** Layout for columns (mirrors layout/column.py). */
import * as boxes from '../formatting_structure/boxes.ts';
import { LOGGER } from '../logger.ts';
import { absoluteLayout } from './absolute.ts';
import { blockBoxLayout, blockLevelLayout, blockLevelWidth, collapseMargin, removePlaceholders } from './block.ts';
import { percentage, resolvePercentages } from './percent.ts';

type AnyBox = any;

function reportFootnotes(context: any, footnotesHeight: number): void {
  if (!context.currentPageFootnotes.length) return;
  let reported = 0;
  while (context.currentFootnoteArea.marginHeight() > footnotesHeight) {
    context.reportFootnote(context.currentPageFootnotes[context.currentPageFootnotes.length - 1]);
    reported++;
  }
  if (reported >= 2) {
    const extra = context.reportedFootnotes.slice(-reported).reverse();
    context.reportedFootnotes.splice(context.reportedFootnotes.length - reported, reported, ...extra);
  }
}

function createColumnBox(box: AnyBox, containingBlock: AnyBox, children: AnyBox[], width: number, positionY: number): AnyBox {
  const columnBox = boxes.BlockBox.anonymousFrom(box, children);
  resolvePercentages(columnBox, containingBlock);
  columnBox.isColumn = true;
  columnBox.width = width;
  columnBox.positionX = box.contentBoxX();
  columnBox.positionY = positionY;
  return columnBox;
}

export function columnsLayout(
  context: any, boxIn: AnyBox, bottomSpaceIn: number, skipStackIn: any, containingBlock: AnyBox, pageIsEmpty: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], adjoiningMarginsIn: number[], firstLetterStyle: any, firstLineStyle: any,
): any[] {
  /** Lay out a multi-column ``box``. */
  const style = boxIn.style;
  const widthStyle = style.get('column_width');
  const countStyle = style.get('column_count');
  const heightStyle = style.get('height');
  const originalBottomSpace = bottomSpaceIn;
  context.inColumn = true;

  let box = boxIn;
  let bottomSpace = bottomSpaceIn;
  let skipStack = skipStackIn;
  let adjoiningMargins = adjoiningMarginsIn;

  if (style.get('position') === 'relative') {
    // New containing block, use a new absolute list
    absoluteBoxes = [];
  }

  box = box.copyWithChildren(box.children);
  box.positionY += collapseMargin(adjoiningMargins);
  adjoiningMargins = [];

  // Set height if defined
  let heightDefined = false;
  if (heightStyle !== 'auto' && heightStyle.unit !== '%') {
    heightDefined = true;
    const emptySpace = context.pageBottom - box.contentBoxY() - heightStyle.value;
    bottomSpace = Math.max(bottomSpace, emptySpace);
  }

  blockLevelWidth(box, containingBlock);

  let gap: number;
  if (style.get('column_gap') === 'normal') {
    // 1em because in column context
    gap = style.get('font_size');
  } else {
    gap = percentage(style.get('column_gap'), box.style, box.width);
  }

  // Define the number of columns and their widths
  let count: number;
  let width: number;
  if (widthStyle === 'auto' && countStyle !== 'auto') {
    count = countStyle;
    width = Math.max(0, box.width - (count - 1) * gap) / count;
  } else if (widthStyle !== 'auto' && countStyle === 'auto') {
    width = widthStyle;
    count = Math.max(1, Math.floor((box.width + gap) / (width + gap)));
    width = (box.width + gap) / count - gap;
  } else { // overconstrained, with width != 'auto' and count != 'auto'
    width = widthStyle;
    count = Math.max(1, Math.min(countStyle, Math.floor((box.width + gap) / (width + gap))));
    width = (box.width + gap) / count - gap;
  }

  // Handle column-span property with the following structure:
  // columns_and_blocks = [
  //     [column_child_1, column_child_2],
  //     spanning_block,
  //     …
  // ]
  const columnsAndBlocks: Array<[number, AnyBox | AnyBox[]]> = [];
  let columnChildren: AnyBox[] = [];
  const skip = skipStack ? Number(Object.keys(skipStack)[0]) : 0;
  let i = skip;
  for (const child of box.children.slice(skip)) {
    if (child.style.get('column_span') === 'all') {
      if (columnChildren.length) {
        columnsAndBlocks.push([i - columnChildren.length, columnChildren]);
      }
      columnsAndBlocks.push([i, child.copy()]);
      columnChildren = [];
    } else {
      columnChildren.push(child.copy());
    }
    i++;
  }
  if (columnChildren.length) {
    columnsAndBlocks.push([i - columnChildren.length, columnChildren]);
  }

  if (skipStack) skipStack = { 0: skipStack[skip] };

  let nextPage: any = { break: 'any', page: null };
  if (!box.children.length) {
    nextPage = { break: 'any', page: null };
    skipStack = null;
  }

  // Find height and balance.
  //
  // The current algorithm starts from the total available height, to check
  // whether the whole content can fit. If it doesn’t fit, we keep the partial
  // rendering. If it fits, we try to balance the columns starting from the
  // ideal height (the total height divided by the number of columns). We then
  // iterate until the last column is not the highest one. At the end of each
  // loop, we add the minimal height needed to make one direct child at the
  // top of one column go to the end of the previous column.
  //
  // We rely on a real rendering for each loop, and with a stupid algorithm
  // like this it can last minutes…

  const currentBoxY = box.contentBoxY();
  let currentPositionY = currentBoxY;
  const newChildren: AnyBox[] = [];
  let columnSkipStack: any = null;
  let lastLoop = false;
  let breakPage = false;
  const footnoteAreaHeights = [
    context.currentFootnoteArea.height === 'auto' ? 0 : context.currentFootnoteArea.marginHeight(),
  ];
  let lastFootnotesHeight = 0;
  let index = 0;
  for (const [cbIndex, columnChildrenOrBlock] of columnsAndBlocks) {
    index = cbIndex;
    if (!Array.isArray(columnChildrenOrBlock)) {
      // We have a spanning block, we display it like other blocks
      const block = columnChildrenOrBlock;
      resolvePercentages(block, containingBlock);
      block.positionX = box.contentBoxX();
      block.positionY = currentPositionY;
      let newChild: AnyBox;
      let resumeAt: any;
      [newChild, resumeAt, nextPage, adjoiningMargins] = blockLevelLayout(
        context, block, originalBottomSpace, skipStack, containingBlock,
        pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins,
        firstLetterStyle, firstLineStyle).slice(0, 4);
      skipStack = null;
      if (newChild === null || newChild === undefined) {
        lastLoop = true;
        breakPage = true;
        break;
      }
      newChildren.push(newChild);
      currentPositionY = newChild.borderHeight() + newChild.borderBoxY();
      adjoiningMargins = [newChild.marginBottom];
      if (resumeAt) {
        lastLoop = true;
        breakPage = true;
        columnSkipStack = resumeAt;
        break;
      }
      pageIsEmpty = false;
      continue;
    }

    // We have a list of children that we have to balance between columns
    const balancingChildren = columnChildrenOrBlock;

    // Find the total height available for the first run
    currentPositionY += collapseMargin(adjoiningMargins);
    adjoiningMargins = [];
    const maxHeight = context.pageBottom - currentPositionY - originalBottomSpace;
    let height = maxHeight;
    const columnBox = createColumnBox(
      box, containingBlock, balancingChildren, width, currentPositionY);

    // Try to render columns until the content fits, increase the column
    // height step by step
    columnSkipStack = skipStack;
    let lostSpace = Infinity;
    const originalExcludedShapes = context.excludedShapes.slice();
    const originalPageIsEmpty = pageIsEmpty;
    pageIsEmpty = false;
    let stopRendering = false;
    let balancing = false;
    for (;;) {
      // Remove extra excluded shapes introduced during the previous loop
      while (context.excludedShapes.length > originalExcludedShapes.length) {
        context.excludedShapes.pop();
      }

      // Render the columns
      columnSkipStack = skipStack;
      const consumedHeights: number[] = [];
      const newBoxes: AnyBox[] = [];
      for (let ci = 0; ci < count; ci++) {
        // Render one column
        let newBox: AnyBox;
        let resumeAt: any;
        [newBox, resumeAt, nextPage] = blockBoxLayout(
          context, columnBox,
          context.pageBottom - currentPositionY - height,
          columnSkipStack, containingBlock,
          pageIsEmpty || !balancing, [], [], [], firstLetterStyle,
          firstLineStyle, false, null).slice(0, 3);
        if (newBox === null || newBox === undefined) {
          // We didn't render anything, retry
          columnSkipStack = { 0: null };
          break;
        }
        newBoxes.push(newBox);
        columnSkipStack = resumeAt;

        // Calculate consumed height, empty space and next box height
        const inFlowChildren = newBox.children.filter(
          (child: AnyBox) => child.isInNormalFlow());
        let consumedHeight = 0;
        let emptySpace = 0;
        let nextBoxHeight = 0;
        if (inFlowChildren.length) {
          // Get the empty space at the bottom of the column box
          consumedHeight = (
            inFlowChildren[inFlowChildren.length - 1].marginHeight() +
            inFlowChildren[inFlowChildren.length - 1].positionY - currentPositionY);
          emptySpace = height - consumedHeight;
          consumedHeight -= inFlowChildren[inFlowChildren.length - 1].marginBottom;

          // Get the minimum size needed to render the next box
          if (columnSkipStack) {
            const nextBox = blockBoxLayout(
              context, columnBox, Infinity, columnSkipStack,
              containingBlock, true, [], [], [], firstLetterStyle,
              firstLineStyle, false, null)[0];
            for (const child of nextBox.children) {
              if (child.isInNormalFlow()) {
                nextBoxHeight = child.marginHeight();
                break;
              }
            }
            removePlaceholders(context, [nextBox], [], []);
          }
        }

        consumedHeights.push(consumedHeight);

        // Append the size needed to render the next box in this
        // column.
        //
        // The next box size may be smaller than the empty space, for
        // example when the next box can't be separated from its own
        // next box. In this case we don't try to find the real value
        // and let the workaround below fix this for us.
        //
        // We also want to avoid very small values that may have been
        // introduced by rounding errors. As the workaround below at
        // least adds 1 pixel for each loop, we can ignore lost spaces
        // lower than 1px.
        if (nextBoxHeight - emptySpace > 1) {
          lostSpace = Math.min(lostSpace, nextBoxHeight - emptySpace);
        }

        // Stop if we already rendered the whole content
        if (resumeAt === null) break;
      }

      // Remove placeholders but keep the current footnote area height
      lastFootnotesHeight = (
        context.currentFootnoteArea.height === 'auto'
          ? 0
          : context.currentFootnoteArea.marginHeight());
      removePlaceholders(context, newBoxes, [], []);

      if (lastLoop) break;

      if (balancing) {
        if (columnSkipStack === null) {
          // We rendered the whole content, stop
          break;
        }

        // Increase the column heights and render them again
        const addHeight = lostSpace === Infinity ? 1 : lostSpace;
        height += addHeight;

        if (height > maxHeight) {
          // We reached max height, stop rendering
          height = maxHeight;
          stopRendering = true;
          break;
        }
      } else {
        if (!footnoteAreaHeights.includes(lastFootnotesHeight)) {
          // Footnotes have been rendered, try to re-render with the
          // new footnote area height
          height -= lastFootnotesHeight - footnoteAreaHeights[footnoteAreaHeights.length - 1];
          footnoteAreaHeights.push(lastFootnotesHeight);
          continue;
        }

        const everythingFits = (
          columnSkipStack === null &&
          Math.max(...consumedHeights) <= maxHeight);
        if (everythingFits) {
          // Everything fits, start expanding columns at the average
          // of the column heights
          if (style.get('column_fill') === 'balance' || index < columnsAndBlocks[columnsAndBlocks.length - 1][0]) {
            balancing = true;
            height = consumedHeights.reduce((a, b) => a + b, 0) / count;
          } else {
            break;
          }
        } else {
          // Content overflows even at maximum height, stop now and
          // let the columns continue on the next page
          stopRendering = true;
          break;
        }
      }
    }

    // TODO: check style['max']-height
    bottomSpace = Math.max(
      bottomSpace, context.pageBottom - currentPositionY - height);

    // Replace the current box children with real columns
    let i = 0;
    let maxColumnHeight = 0;
    let columns: AnyBox[] = [];
    for (;;) {
      const columnBox = createColumnBox(
        box, containingBlock, balancingChildren, width,
        currentPositionY);
      if (style.get('direction') === 'rtl') {
        columnBox.positionX += box.width - (i + 1) * width - i * gap;
      } else {
        columnBox.positionX += i * (width + gap);
      }
      let newChild: AnyBox;
      [newChild, columnSkipStack, nextPage] = blockBoxLayout(
        context, columnBox, bottomSpace, skipStack, containingBlock,
        originalPageIsEmpty, absoluteBoxes, fixedBoxes, [],
        firstLetterStyle, firstLineStyle, false, null).slice(0, 3);
      if (newChild === null || newChild === undefined) {
        columns = [];
        breakPage = true;
        break;
      }
      skipStack = columnSkipStack;
      columns.push(newChild);
      maxColumnHeight = Math.max(maxColumnHeight, newChild.marginHeight());
      if (skipStack === null) {
        bottomSpace = originalBottomSpace;
        break;
      }
      i++;
      if (i === count && !heightDefined) {
        // [If] a declaration that constrains the column height
        // (e.g., using height or max-height). In this case,
        // additional column boxes are created in the inline
        // direction.
        break;
      }
    }

    // Update the current y position and set the columns’ height
    currentPositionY += Math.min(maxHeight, maxColumnHeight);
    for (const column of columns) {
      column.height = maxColumnHeight;
      newChildren.push(column);
    }

    skipStack = null;
    pageIsEmpty = false;

    if (stopRendering) break;
  }

  // Report footnotes above the defined footnotes height
  reportFootnotes(context, footnoteAreaHeights[footnoteAreaHeights.length - 1]);

  if (box.children.length && !newChildren.length) {
    // The box has children but none can be drawn, let's skip the whole box
    context.inColumn = false;
    return [null, { 0: null }, { break: 'any', page: null }, [], false, null];
  }

  // Set the height of the containing box
  box.children = newChildren;
  currentPositionY += collapseMargin(adjoiningMargins);
  const contentHeight = currentPositionY - box.contentBoxY();
  let heightDifference = 0;
  if (box.height === 'auto') {
    box.height = contentHeight;
  } else {
    heightDifference = box.height - contentHeight;
  }

  // Update the latest columns’ height to respect min-height
  if (box.minHeight !== 'auto' && box.minHeight > box.height) {
    heightDifference += box.minHeight - box.height;
    box.height = box.minHeight;
  }
  for (const child of newChildren.slice().reverse()) {
    if (child.isColumn) child.height += heightDifference;
    else break;
  }

  if (style.get('position') === 'relative') {
    // New containing block, resolve the layout of the absolute descendants
    for (const absoluteBox of absoluteBoxes) {
      absoluteLayout(context, absoluteBox, box, fixedBoxes, bottomSpace, null);
    }
  }

  // Calculate skip stack
  if (columnSkipStack) {
    const skip2 = Number(Object.keys(columnSkipStack)[0]);
    skipStack = { [index + skip2]: columnSkipStack[skip2] };
  } else if (breakPage) {
    skipStack = { [index]: null };
  } else skipStack = null;

  // Update page bottom according to the new footnotes
  if (context.currentFootnoteArea.height !== 'auto') {
    context.pageBottom += footnoteAreaHeights[0];
    context.pageBottom -= context.currentFootnoteArea.marginHeight();
  }

  context.inColumn = false;
  return [box, skipStack, nextPage, [], false, null];
}
