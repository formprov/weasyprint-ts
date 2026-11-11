// SPDX-License-Identifier: BSD-3-Clause

/** Page breaking and layout for block-level and block-container boxes (mirrors layout/block.py). */
import * as boxes from '../formatting_structure/boxes.ts';
import { AbsolutePlaceholder, absoluteLayout } from './absolute.ts';
import { columnsLayout } from './column.ts';
import { flexLayout } from './flex.ts';
import { avoidCollisions, floatLayout, getClearance } from './float.ts';
import { gridLayout } from './grid.ts';
import { iterLineBoxes } from './inline.ts';
import { percentage, resolvePercentages, resolvePositionPercentages } from './percent.ts';
import { blockReplacedBoxLayout } from './replaced.ts';
import { tableLayout, tableWrapperWidth } from './table.ts';

type AnyBox = any;
type SkipStack = Record<number, any> | null;

/** The single ``[index, rest]`` pair of a skip stack (Python: ``(skip, skip_stack), = skip_stack.items()``). */
export function skipItem(stack: Record<number, any>): [number, SkipStack] {
  const [[k, v]] = Object.entries(stack);
  return [Number(k), v];
}

/** Lay out the block-level ``box``. */
export function blockLevelLayout(
  context: any, box: AnyBox, bottomSpace: number, skipStack: SkipStack, containingBlock: AnyBox,
  pageIsEmpty = true, absoluteBoxes: AnyBox[] | null = null, fixedBoxes: AnyBox[] | null = null,
  adjoiningMargins: number[] | null = null, firstLetterStyle: any = null, firstLineStyle: any = null,
  discard = false, maxLines: number | null = null,
): any[] {
  absoluteBoxes ??= [];
  fixedBoxes ??= [];
  adjoiningMargins ??= [];

  if (!(box instanceof boxes.TableBox)) {
    resolvePercentages(box, containingBlock);

    if (box.marginTop === 'auto') box.marginTop = 0;
    if (box.marginBottom === 'auto') box.marginBottom = 0;

    if (context.currentPage > 1 && pageIsEmpty) {
      // When an unforced break occurs before or after a block-level box, any margins
      // adjoining the break are truncated to zero.
      // TODO: this condition is wrong, it only works for blocks whose parent breaks
      // collapsing margins. See test_margin_break_clearance.
      const collapseWithPage = containingBlock.isForRootElement || adjoiningMargins.length;
      if (collapseWithPage) {
        if (box.style.get('margin_break') === 'discard') box.marginTop = 0;
        else if (box.style.get('margin_break') === 'auto') {
          if (!context.forcedBreak) box.marginTop = 0;
        }
      }
    }

    const collapsedMargin = collapseMargin([...adjoiningMargins, box.marginTop]);
    const direction = containingBlock.style.get('direction');
    box.clearance = getClearance(context, box, direction, collapsedMargin);
    if (box.clearance !== null) {
      const topBorderEdge = box.positionY + collapsedMargin + box.clearance;
      box.positionY = topBorderEdge - box.marginTop;
      adjoiningMargins = [];
    }
  }

  return blockLevelLayoutSwitch(
    context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins,
    firstLetterStyle, firstLineStyle, discard, maxLines);
}

/** Call the layout function corresponding to the ``box`` type. */
export function blockLevelLayoutSwitch(
  context: any, box: AnyBox, bottomSpace: number, skipStack: SkipStack, containingBlock: AnyBox, pageIsEmpty: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], adjoiningMargins: number[], firstLetterStyle: any, firstLineStyle: any,
  discard: boolean, maxLines: number | null,
): any[] {
  let result: any[];
  if (box instanceof boxes.TableBox) {
    result = tableLayout(context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes);
  } else if (box instanceof boxes.BlockBox) {
    return blockBoxLayout(
      context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins,
      firstLetterStyle, firstLineStyle, discard, maxLines);
  } else if (box instanceof boxes.BlockReplacedBox) {
    result = blockReplacedBoxLayout(context, box, containingBlock);
  } else if (box instanceof boxes.FlexBox) {
    result = flexLayout(context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes, discard);
  } else if (box instanceof boxes.GridBox) {
    result = gridLayout(context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes);
  } else throw new TypeError(`Layout for ${box.constructor.name} not handled yet`);
  return [...result, null];
}

/** Lay out the block ``box``. */
export function blockBoxLayout(
  context: any, box: AnyBox, bottomSpaceIn: number, skipStack: SkipStack, containingBlock: AnyBox, pageIsEmpty: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], adjoiningMargins: number[], firstLetterStyle: any, firstLineStyle: any,
  discard: boolean, maxLines: number | null,
): any[] {
  let bottomSpace = bottomSpaceIn;
  if (box.style.get('column_width') !== 'auto' || box.style.get('column_count') !== 'auto') {
    let result = columnsLayout(
      context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins,
      firstLetterStyle, firstLineStyle);
    const resumeAt = result[1];
    // TODO: this condition and the whole relayout are probably wrong.
    if (resumeAt === null) {
      const newBox = result[0];
      const columnsBottomSpace = newBox.marginBottom + newBox.paddingBottom + newBox.borderBottomWidth;
      if (columnsBottomSpace) {
        removePlaceholders(context, [newBox], absoluteBoxes, fixedBoxes);
        bottomSpace += columnsBottomSpace;
        result = columnsLayout(
          context, box, bottomSpace, skipStack, containingBlock, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins,
          firstLetterStyle, firstLineStyle);
      }
    }
    return [...result, null];
  } else if (box.isTableWrapper) {
    tableWrapperWidth(context, box, [containingBlock.width, containingBlock.height]);
  }
  blockLevelWidth(box, containingBlock);

  const result = blockContainerLayout(
    context, box, bottomSpace, skipStack, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins, firstLetterStyle,
    firstLineStyle, discard, maxLines);
  const newBox = result[0];
  // TODO: columns and flex items shouldn't be block boxes, this condition would then be useless.
  if (!newBox || newBox.isColumn || newBox.isFlexItem) return result;
  if (newBox.isTableWrapper || newBox.establishesFormattingContext()) {
    // Don't collide with floats (https://www.w3.org/TR/CSS21/visuren.html#floats).
    const [positionX, positionY] = avoidCollisions(context, newBox, containingBlock, false);
    newBox.translate(positionX - newBox.positionX, positionY - newBox.positionY);
  }
  return result;
}

/** Set the ``box`` width. */
export function blockLevelWidth(box: AnyBox, containingBlock: AnyBox, withMinMax = true): void {
  // 'cb' stands for 'containing block'
  let cbWidth: number;
  let direction: string;
  if (containingBlock instanceof boxes.Box) {
    cbWidth = containingBlock.width;
    direction = containingBlock.style.get('direction');
  } else {
    cbWidth = containingBlock[0];
    // TODO: what is the real text direction?
    direction = 'ltr';
  }

  const paddingPlusBorder = box.paddingLeft + box.paddingRight + box.borderLeftWidth + box.borderRightWidth;

  // See https://www.w3.org/TR/CSS21/visudet.html#blockwidth.
  // Set width. Only margin-left, margin-right and width can be 'auto'.
  if (box.width === 'auto') {
    box.width = cbWidth - paddingPlusBorder;
    if (box.marginLeft !== 'auto') box.width -= box.marginLeft;
    if (box.marginRight !== 'auto') box.width -= box.marginRight;
  }
  if (withMinMax) box.width = Math.max(box.minWidth, Math.min(box.maxWidth, box.width));

  // Set auto margins to 0 for boxes larger than containing block.
  let marginWidth = paddingPlusBorder + box.width;
  if (box.marginLeft !== 'auto') marginWidth += box.marginLeft;
  if (box.marginRight !== 'auto') marginWidth += box.marginRight;
  if (marginWidth > cbWidth) {
    if (box.marginLeft === 'auto') box.marginLeft = 0;
    if (box.marginRight === 'auto') box.marginRight = 0;
  }

  // Right-align right-to-left boxes.
  if (direction === 'rtl' && !box.isColumn) {
    box.positionX += cbWidth - paddingPlusBorder - box.width;
    if (box.marginLeft !== 'auto') box.positionX -= box.marginLeft;
    if (box.marginRight !== 'auto') box.positionX -= box.marginRight;
  }

  // Set margins according to width.
  const marginSum = cbWidth - paddingPlusBorder - box.width;
  if (box.marginLeft === 'auto' && box.marginRight === 'auto') {
    box.marginLeft = marginSum / 2;
    box.marginRight = marginSum / 2;
  } else if (box.marginLeft === 'auto' && box.marginRight !== 'auto') {
    box.marginLeft = marginSum - box.marginRight;
  } else if (box.marginLeft !== 'auto' && box.marginRight === 'auto') {
    box.marginRight = marginSum - box.marginLeft;
  }
}
blockLevelWidth.withoutMinMax = (box: AnyBox, containingBlock: AnyBox): void => blockLevelWidth(box, containingBlock, false);

/** Translate the ``box`` if it is relatively positioned. */
export function relativePositioning(box: AnyBox, containingBlock: [number, number]): void {
  if (box.style.get('position') === 'relative') {
    resolvePositionPercentages(box, containingBlock);
    let translateX: number;
    let translateY: number;
    if (box.left !== 'auto' && box.right !== 'auto') {
      translateX = box.style.get('direction') === 'ltr' ? box.left : -box.right;
    } else if (box.left !== 'auto') translateX = box.left;
    else if (box.right !== 'auto') translateX = -box.right;
    else translateX = 0;

    if (box.top !== 'auto') translateY = box.top;
    else if (box.bottom !== 'auto') translateY = -box.bottom;
    else translateY = 0;

    box.translate(translateX, translateY);
  }
  if (box instanceof boxes.InlineBox || box instanceof boxes.LineBox) {
    for (const child of box.children) relativePositioning(child, containingBlock);
  }
}

function outOfFlowLayout(
  context: any, box: AnyBox, index: number, child: AnyBox, newChildren: AnyBox[], pageIsEmpty: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], adjoiningMargins: number[], bottomSpace: number,
): [boolean, SkipStack, AnyBox, SkipStack] {
  let stop = false; // whether we should stop parent rendering after this layout
  let resumeAt: SkipStack = null; // where to resume in-flow rendering
  let newChild: AnyBox = null; // child rendered by this layout
  let outOfFlowResumeAt: SkipStack = null; // where to resume out-of-flow rendering

  // Add the parent's collapsing margins to shift the child's position. Don't include
  // the out-of-flow child's top margin because it doesn't collapse with its parent.
  child.positionY += collapseMargin(adjoiningMargins);

  if (child.isAbsolutelyPositioned()) {
    // Absolute child layout: create placeholder.
    const placeholder = new AbsolutePlaceholder(child);
    newChild = placeholder;
    placeholder.index = index;
    newChildren.push(placeholder);
    if (child.style.get('position') === 'absolute') absoluteBoxes.push(placeholder);
    else fixedBoxes.push(placeholder);
  } else if (child.isFloated()) {
    // Float child layout.
    [newChild, outOfFlowResumeAt] = floatLayout(context, child, box, absoluteBoxes, fixedBoxes, bottomSpace, null);

    // Check that child doesn't overflow page.
    const pageOverflow = context.overflowsPage(bottomSpace, newChild.positionY + newChild.height);
    const addChild = (pageIsEmpty && !newChildren.length) || !pageOverflow || box.isMonolithic();
    if (addChild) {
      // Child fits or has to fit, add it.
      newChild.index = index;
      newChildren.push(newChild);
    } else {
      // Child doesn't fit and we can break, find where to break and stop parent rendering.
      const lastChild = findLastClassABreakPointChild(newChildren);
      const pageBreak = blockLevelPageBreak(lastChild, child);
      resumeAt = { [index]: null };
      outOfFlowResumeAt = null;
      stop = true;
      removePlaceholders(context, [newChild], absoluteBoxes, fixedBoxes);
      if (newChildren.length && avoidPageBreak(pageBreak, context)) {
        // Can't break inside float, find an earlier page break.
        const result = findEarlierPageBreak(context, newChildren, absoluteBoxes, fixedBoxes);
        if (result) {
          // Earlier page break found, drop whole child rendering.
          newChildren.splice(0, newChildren.length, ...result[0]);
          resumeAt = result[1];
          newChild = null;
        }
      }
    }
  } else if (child.isRunning() || child.isNote()) {
    // Running element layout.
    context.addRunningElement(child);
  }
  return [stop, resumeAt, newChild, outOfFlowResumeAt];
}

/** Break line where allowed by orphans and widows. Return ``[abort, stop, resumeAt]``. */
function breakLine(
  context: any, box: AnyBox, line: AnyBox, newChildren: AnyBox[], needed: number, pageIsEmpty: boolean, index: number,
  skipStack: SkipStack, resumeAt: SkipStack, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
): [boolean, boolean, SkipStack] {
  const overOrphans = newChildren.length - box.style.get('orphans');
  if (overOrphans < 0 && !pageIsEmpty) {
    // Reached the bottom of the page before we had enough lines for orphans, cancel the whole box.
    removePlaceholders(context, line.children, absoluteBoxes, fixedBoxes);
    return [true, false, resumeAt];
  }
  // How many lines we need on the next page to satisfy widows (-1 for the current line).
  if (needed > overOrphans && !pageIsEmpty) {
    // Total number of lines < orphans + widows.
    removePlaceholders(context, line.children, absoluteBoxes, fixedBoxes);
    return [true, false, resumeAt];
  }
  if (needed && needed <= overOrphans) {
    // Remove lines to keep them for the next page.
    for (const child of newChildren.slice(-needed)) removePlaceholders(context, child.children, absoluteBoxes, fixedBoxes);
    newChildren.splice(newChildren.length - needed, needed);
  }
  // Page break here, resume before this line.
  removePlaceholders(context, line.children, absoluteBoxes, fixedBoxes);
  void skipStack;
  return [false, true, { [index]: skipStack }];
}

function lineboxLayout(
  context: any, box: AnyBox, index: number, child: AnyBox, newChildren: AnyBox[], pageIsEmpty: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], adjoiningMargins: number[], bottomSpace: number, positionYIn: number,
  skipStackIn: SkipStack, firstLetterStyle: any, firstLineStyle: any, drawBottomDecorationIn: boolean, maxLinesIn: number | null,
): [boolean, boolean, SkipStack, number, AnyBox[], number | null] {
  let abort = false;
  let stop = false;
  let resumeAt: SkipStack = null;
  const newFootnotes: AnyBox[] = [];
  let positionY = positionYIn;
  let skipStack = skipStackIn;
  let drawBottomDecoration = drawBottomDecorationIn;
  let maxLines = maxLinesIn;

  if (box.children.length !== 1) throw new Error('line box with siblings before layout');

  if (adjoiningMargins.length) positionY += collapseMargin(adjoiningMargins);
  const newContainingBlock = box;
  const linesIterator = iterLineBoxes(
    context, child, positionY, bottomSpace, skipStack, newContainingBlock, absoluteBoxes, fixedBoxes, firstLetterStyle,
    firstLineStyle);
  for (let step = linesIterator.next(); !step.done; step = linesIterator.next()) {
    const [line, lineResumeAt] = step.value;
    resumeAt = lineResumeAt;
    // Break box if we reached max-lines.
    if (maxLines !== null) {
      if (maxLines === 0) {
        newChildren[newChildren.length - 1].blockEllipsis = box.style.get('block_ellipsis');
        break;
      }
      maxLines -= 1;
    }

    // Update line resume_at and position_y.
    line.resumeAt = resumeAt;
    let newPositionY = line.positionY + line.height;

    // Add bottom padding and border to the bottom position of the box if needed.
    drawBottomDecoration ||= resumeAt === null;
    const offsetY = drawBottomDecoration ? box.borderBottomWidth + box.paddingBottom : 0;

    // Allow overflow if the first line of the page is higher than the page itself so that
    // we put *something* on this page and can advance in the context.
    const overflow = (newChildren.length || !pageIsEmpty) && context.overflowsPage(bottomSpace, newPositionY + offsetY);
    if (overflow) {
      // If we couldn't break the line before but can break now, first try to report
      // footnotes and see if we don't overflow.
      let couldBreakBefore = true;
      let canBreakNow = true;
      let needed = box.style.get('widows') - 1;
      for (let next = linesIterator.next(); !next.done; next = linesIterator.next()) {
        needed -= 1;
        removePlaceholders(context, next.value[0].children, absoluteBoxes, fixedBoxes);
        // Don't iterate over all lines as it can be long.
        if (needed === -1) break;
      }
      if (newChildren.length + 1 < box.style.get('orphans')) canBreakNow = false;
      else if (needed >= 0) canBreakNow = false;
      if (newChildren.length < box.style.get('orphans')) couldBreakBefore = false;
      else if (needed > 0) couldBreakBefore = false;
      needed = Math.max(0, needed);
      const report = !context.inColumn && canBreakNow && !couldBreakBefore;
      let reportedFootnotes = 0;
      let reportDone = false;
      while (report && context.currentPageFootnotes.length) {
        context.reportFootnote(context.currentPageFootnotes[context.currentPageFootnotes.length - 1]);
        reportedFootnotes += 1;
        if (!context.overflowsPage(bottomSpace, newPositionY + offsetY)) {
          newChildren.push(line);
          stop = true;
          reportDone = true;
          break;
        }
      }
      if (!reportDone) {
        [abort, stop, resumeAt] = breakLine(
          context, box, line, newChildren, needed, pageIsEmpty, index, skipStack, resumeAt, absoluteBoxes, fixedBoxes);
      }
      // Revert reported footnotes, as they've been reported starting from the last one.
      if (reportedFootnotes >= 2) {
        const rf = context.reportedFootnotes;
        const extra = rf.slice(-reportedFootnotes).reverse();
        rf.splice(rf.length - reportedFootnotes, reportedFootnotes, ...extra);
      }
      break;
    } else if (pageIsEmpty && context.overflowsPage(bottomSpace, newPositionY)) {
      // TODO: this is incomplete. See https://drafts.csswg.org/css-page-3/#allowed-pg-brk
      // Remove the top border when a page is empty and the box is too high to be drawn in one page.
      newPositionY -= box.marginTop;
      line.translate(0, -box.marginTop);
      box.marginTop = 0;
    }

    if (context.footnotes.length) {
      let breakLinebox = false;
      const footnotes = [...line.descendants()].filter((d: AnyBox) => context.footnotes.includes(d.footnote)).map((d: AnyBox) => d.footnote);
      for (const footnote of footnotes) {
        let ov = context.layoutFootnote(footnote);
        newFootnotes.push(footnote);
        ov = ov || context.reportedFootnotes.length || context.overflowsPage(bottomSpace, newPositionY + offsetY);
        if (ov) {
          context.reportFootnote(footnote);
          // If we've put other content on this page, then we may want to push this line or
          // block to the next page. Otherwise we can't (and would loop forever).
          if (newChildren.length || !pageIsEmpty) {
            if (footnote.style.get('footnote_policy') === 'line') {
              let needed = box.style.get('widows') - 1;
              if (needed) {
                for (let n = linesIterator.next(); !n.done; n = linesIterator.next()) {
                  needed -= 1;
                  if (needed === 0) break;
                }
              }
              [abort, stop, resumeAt] = breakLine(
                context, box, line, newChildren, needed, pageIsEmpty, index, skipStack, resumeAt, absoluteBoxes, fixedBoxes);
              breakLinebox = true;
              break;
            } else if (footnote.style.get('footnote_policy') === 'block') {
              abort = breakLinebox = true;
              break;
            }
          }
        }
      }
      if (breakLinebox) break;
    }

    newChildren.push(line);
    positionY = newPositionY;
    skipStack = resumeAt;
  }

  if (newChildren.length) resumeAt = { [index]: newChildren[newChildren.length - 1].resumeAt };
  return [abort, stop, resumeAt, positionY, newFootnotes, maxLines];
}

function inFlowLayout(
  context: any, box: AnyBox, index: number, child: AnyBox, newChildrenIn: AnyBox[], pageIsEmpty: boolean,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], adjoiningMarginsIn: number[], bottomSpaceIn: number,
  positionYIn: number, skipStack: SkipStack, firstLetterStyle: any, firstLineStyle: any, discard: boolean,
  nextPageIn: any, maxLinesIn: number | null,
): [boolean, boolean, SkipStack, number, number[], any, AnyBox[], number | null] {
  let abort = false;
  let stop = false;
  let resumeAt: SkipStack = null;
  let newChildren = newChildrenIn;
  let adjoiningMargins = adjoiningMarginsIn;
  let bottomSpace = bottomSpaceIn;
  let positionY = positionYIn;
  let nextPage = nextPageIn;
  let maxLines = maxLinesIn;

  // Resolve percentages and collapsing top margins.
  if (!box.isTableWrapper) {
    resolvePercentages(child, box);
    const lastInFlowChild = findLastInFlowChild(newChildren);
    if (lastInFlowChild === null && box.topMarginCollapses()) {
      // TODO: add the adjoining descendants' margin top to [child.margin_top].
      const oldCollapsedMargin = collapseMargin(adjoiningMargins);
      // TODO: the margin-top value is set afterwards in block_level_layout, we shouldn't duplicate this code.
      let childMarginTop = child.marginTop;
      if (childMarginTop === 'auto') childMarginTop = 0;
      else if (context.currentPage > 1 && pageIsEmpty) {
        if (box.style.get('margin_break') === 'discard') childMarginTop = 0;
        else if (box.style.get('margin_break') === 'auto') {
          if (!context.forcedBreak) childMarginTop = 0;
        }
      }
      const newCollapsedMargin = collapseMargin([...adjoiningMargins, childMarginTop]);
      const collapsedMarginDifference = newCollapsedMargin - oldCollapsedMargin;
      for (const previousNewChild of newChildren) previousNewChild.translate(0, collapsedMarginDifference);
      const direction = box.style.get('direction');
      const clearance = getClearance(context, child, direction, newCollapsedMargin);
      if (clearance !== null) {
        for (const previousNewChild of newChildren) previousNewChild.translate(0, -collapsedMarginDifference);
        const collapsedMargin = collapseMargin(adjoiningMargins);
        box.positionY += collapsedMargin - box.marginTop;
        // Count box.margin_top as we emptied adjoining_margins.
        adjoiningMargins = [];
        positionY = box.contentBoxY();
      }
    }
  }

  // TODO: Merge this with block_container_layout, block_level_layout, _in_flow_layout, and check code above.
  if (adjoiningMargins.length) {
    if (box.isTableWrapper) {
      // should not be a special case
      child.positionY += collapseMargin(adjoiningMargins);
      adjoiningMargins = [];
    } else if (!(child instanceof boxes.BlockBox)) {
      // blocks handle that themselves
      const marginTop = child.style.get('margin_top') === 'auto' ? 0 : percentage(child.style.get('margin_top'), child.style, box.width);
      adjoiningMargins.push(marginTop);
      const offsetY = collapseMargin(adjoiningMargins) - marginTop;
      child.positionY += offsetY;
      adjoiningMargins = [];
    }
  }

  const pageIsEmptyWithNoChildren = pageIsEmpty && !newChildren.some((c) => c && !(c instanceof AbsolutePlaceholder));

  const childPosition: [number, number] = [child.positionX, child.positionY];
  let newChild: AnyBox;
  let nextAdjoiningMargins: number[];
  let collapsingThrough: boolean;
  [newChild, resumeAt, nextPage, nextAdjoiningMargins, collapsingThrough, maxLines] = blockLevelLayout(
    context, child, bottomSpace, skipStack, box, pageIsEmptyWithNoChildren, absoluteBoxes, fixedBoxes, adjoiningMargins,
    firstLetterStyle, firstLineStyle, discard, maxLines) as any;

  // Check that child doesn't overflow and set next position_y.
  if (newChild !== null) {
    if (!collapsingThrough) {
      // Find content position and check that it doesn't overflow.
      const newContentPositionY = newChild.contentBoxY() + newChild.height;
      const contentPageOverflow = context.overflowsPage(bottomSpace, newContentPositionY);

      // Update bottom space to include new child bottom spacing and check that it doesn't overflow.
      bottomSpace += newChild.paddingBottom + newChild.borderBottomWidth;
      if (!box.bottomMarginCollapses()) bottomSpace += newChild.marginBottom;
      const newPositionY = newChild.borderBoxY() + newChild.borderHeight();
      const borderPageOverflow = context.overflowsPage(bottomSpace, newPositionY);

      const canBreak = !(pageIsEmptyWithNoChildren || box.isMonolithic());
      if (canBreak && contentPageOverflow) {
        // Child content overflows the page area, display it on the next page.
        removePlaceholders(context, [newChild], absoluteBoxes, fixedBoxes);
        newChild = null;
      } else if (canBreak && borderPageOverflow) {
        // Child border/padding/margin overflows the page area, do the layout again with a
        // bottom_space value that includes them.
        removePlaceholders(context, [newChild], absoluteBoxes, fixedBoxes);
        [child.positionX, child.positionY] = childPosition;
        [newChild, resumeAt, nextPage, nextAdjoiningMargins, collapsingThrough, maxLines] = blockLevelLayout(
          context, child, bottomSpace, skipStack, box, pageIsEmptyWithNoChildren, absoluteBoxes, fixedBoxes, adjoiningMargins,
          firstLetterStyle, firstLineStyle, discard, maxLines) as any;
        if (newChild) positionY = newChild.borderBoxY() + newChild.borderHeight();
      } else positionY = newPositionY;
    }

    // Use the new child adjoining margins.
    adjoiningMargins = nextAdjoiningMargins;
    if (newChild) adjoiningMargins.push(newChild.marginBottom);

    // Handle clearance.
    if (newChild && newChild.clearance) positionY = newChild.borderBoxY() + newChild.borderHeight();
  }

  if (newChild === null) {
    // Nothing fits in the remaining space of this page: break.
    let pageBreak = 'auto';
    const lastChild = findLastClassABreakPointChild(newChildren);
    if (lastChild !== null) pageBreak = blockLevelPageBreak(lastChild, child);
    if (avoidPageBreak(pageBreak, context)) {
      // TODO: fill the blank space at the bottom of the page.
      const result = findEarlierPageBreak(context, newChildren, absoluteBoxes, fixedBoxes);
      if (result) {
        [newChildren, resumeAt] = result;
        stop = true;
        return [abort, stop, resumeAt, positionY, adjoiningMargins, nextPage, newChildren, maxLines];
      }
      // We did not find any page break opportunity.
      if (!pageIsEmpty) {
        // The page has content *before* this block: cancel the block and try to find a break in the parent.
        abort = true;
        return [abort, stop, resumeAt, positionY, adjoiningMargins, nextPage, newChildren, maxLines];
      }
      // else: ignore this 'avoid' and break anyway.
    }

    if (newChildren.every((c) => c.isAbsolutelyPositioned())) {
      // This box has only rendered absolute children, keep them for the next page
      // (useful for list markers).
      removePlaceholders(context, newChildren, absoluteBoxes, fixedBoxes);
      newChildren = [];
    }

    if (newChildren.length) {
      // We already have children, keep them and stop the box rendering.
      resumeAt = { [index]: null };
      stop = true;
    } else {
      // This was the first child of this box, cancel the box completely.
      abort = true;
    }
    return [abort, stop, resumeAt, positionY, adjoiningMargins, nextPage, newChildren, maxLines];
  }

  // Index in its non-laid-out parent, not in future new parent. May be used in find_earlier_page_break().
  newChild.index = index;

  newChildren.push(newChild);
  if (resumeAt !== null) {
    resumeAt = { [index]: resumeAt };
    stop = true;
  }
  return [abort, stop, resumeAt, positionY, adjoiningMargins, nextPage, newChildren, maxLines];
}

/** Set the ``box`` height. */
export function blockContainerLayout(
  context: any, box: AnyBox, bottomSpaceIn: number, skipStackIn: SkipStack, pageIsEmpty: boolean,
  absoluteBoxesIn: AnyBox[], fixedBoxes: AnyBox[], adjoiningMarginsIn: number[] | null, firstLetterStyleIn: any,
  firstLineStyleIn: any, discardIn: boolean, maxLinesIn: number | null,
): any[] {
  if (!box.isBlockContainer) throw new Error('expected a BlockContainerBox');
  let bottomSpace = bottomSpaceIn;
  let skipStack = skipStackIn;
  let absoluteBoxes = absoluteBoxesIn;
  let adjoiningMargins = adjoiningMarginsIn;
  let firstLetterStyle = firstLetterStyleIn;
  let firstLineStyle = firstLineStyleIn;
  let discard = discardIn;
  let maxLines = maxLinesIn;

  if (box.establishesFormattingContext()) context.createBlockFormattingContext(box);

  // TODO: merge this with _in_flow_layout, flex_layout…
  const isStart = skipStack === null;
  box.removeDecoration(!isStart, false);

  discard ||= box.style.get('continue') === 'discard';
  let drawBottomDecoration = discard || box.style.get('box_decoration_break') === 'clone';

  if (adjoiningMargins === null) adjoiningMargins = [];

  if (drawBottomDecoration) bottomSpace += box.paddingBottom + box.borderBottomWidth + box.marginBottom;

  adjoiningMargins.push(box.marginTop);
  const thisBoxAdjoiningMargins = adjoiningMargins;

  let positionY: number;
  if (box.topMarginCollapses()) {
    // Not counting margins in adjoining_margins, if any (there are no padding or borders).
    positionY = box.positionY;
  } else {
    box.positionY += collapseMargin(adjoiningMargins) - box.marginTop;
    adjoiningMargins = [];
    positionY = box.contentBoxY();
  }

  const positionX = box.contentBoxX();

  if (box.style.get('position') === 'relative') {
    // New containing block, use a new absolute list.
    absoluteBoxes = [];
  }

  let newChildren: AnyBox[] = [];
  let nextPage: any = { break: 'any', page: null };

  if (box.style.get('max_lines') !== 'none') maxLines = Math.min(box.style.get('max_lines'), maxLines ?? Infinity);

  if (box.firstLineStyle !== null) {
    const boxFirstLineStyle = cascadedValues(box.firstLineStyle);
    firstLineStyle = firstLineStyle === null ? boxFirstLineStyle : { ...firstLineStyle, ...boxFirstLineStyle };
  }
  if (box.firstLetterStyle !== null) {
    const boxFirstLetterStyle = cascadedValues(box.firstLetterStyle);
    firstLetterStyle = firstLetterStyle === null ? boxFirstLetterStyle : { ...firstLetterStyle, ...boxFirstLetterStyle };
  }

  // Layout box children.
  let skip: number;
  if (isStart) skip = 0;
  else [skip, skipStack] = skipItem(skipStack!);
  let resumeAt: SkipStack = null;
  let loopCompleted = true;
  for (let index = skip || 0; index < box.children.length; index++) {
    const child = box.children[index];
    child.positionX = positionX;
    child.positionY = positionY; // doesn't count adjoining_margins
    let abort = false;
    let stop = false;
    let newFootnotes: AnyBox[] = [];

    if (child.isInNormalFlow() || child.isFloated()) {
      // Find possible page break between siblings.
      const lastChild = findLastClassABreakPointChild(newChildren);
      if (lastChild !== null) {
        const pageBreak = blockLevelPageBreak(lastChild, child);
        const pageName = blockLevelPageName(lastChild, child);
        if (pageName || forcePageBreak(pageBreak, context)) {
          nextPage = { break: pageBreak, page: pageName };
          resumeAt = { [index]: null };
          stop = true;
        }
      }
    }

    if (!stop && !child.isInNormalFlow()) {
      // Layout out-of-flow child.
      let newChild: AnyBox;
      let outOfFlowResumeAt: SkipStack;
      [stop, resumeAt, newChild, outOfFlowResumeAt] = outOfFlowLayout(
        context, box, index, child, newChildren, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins, bottomSpace);
      if (outOfFlowResumeAt) context.addBrokenOutOfFlow(newChild, child, box, outOfFlowResumeAt);
      if (child.isOutsideMarker) {
        newChild.positionX = box.borderBoxX();
        if (child.style.get('direction') === 'rtl') newChild.positionX += box.width + box.paddingRight;
      }
    } else if (!stop && child instanceof boxes.LineBox) {
      // Layout line child.
      [abort, stop, resumeAt, positionY, newFootnotes, maxLines] = lineboxLayout(
        context, box, index, child, newChildren, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins, bottomSpace,
        positionY, skipStack, firstLetterStyle, firstLineStyle, drawBottomDecoration, maxLines);
      drawBottomDecoration ||= resumeAt === null;
      adjoiningMargins = [];
      firstLetterStyle = firstLineStyle = null;
    } else if (!stop) {
      // Layout in-flow child.
      let newMaxLines: number | null;
      [abort, stop, resumeAt, positionY, adjoiningMargins, nextPage, newChildren, newMaxLines] = inFlowLayout(
        context, box, index, child, newChildren, pageIsEmpty, absoluteBoxes, fixedBoxes, adjoiningMargins, bottomSpace,
        positionY, skipStack, firstLetterStyle, firstLineStyle, discard, nextPage, maxLines);
      skipStack = null;
      firstLetterStyle = firstLineStyle = null;

      // Handle max-lines.
      if (newMaxLines !== null && maxLines !== null) {
        maxLines = newMaxLines;
        if (maxLines <= 0) {
          // Maximum number of lines reached, stop box rendering.
          stop = true;
          const lastChild = child === box.children[box.children.length - 1];
          if (!lastChild) {
            // This is not the last line, recursively find the last line to set ellipsis on it.
            let children = newChildren;
            while (children.length) {
              const lc = children[children.length - 1];
              if (lc instanceof boxes.LineBox) lc.blockEllipsis = box.style.get('block_ellipsis');
              else if (lc.isParent) {
                children = lc.children;
                continue;
              }
              break;
            }
          }
        }
      }
    }

    if (abort) {
      // Abort the rendering of box.
      const page = child.pageValues()[0];
      removePlaceholders(context, box.children.slice(skip), absoluteBoxes, fixedBoxes);
      for (const footnote of newFootnotes) context.unlayoutFootnote(footnote);
      if (box.establishesFormattingContext()) context.finishBlockFormattingContext();
      return [null, null, { break: 'any', page }, [], false, maxLines];
    } else if (stop) {
      // Stop after the rendering of child.
      if (box.height !== 'auto') {
        const boxBottom = box.positionY + box.borderHeight();
        const bottomMargin = collapseMargin(adjoiningMargins);
        if (context.overflows(boxBottom, positionY - bottomMargin)) {
          // Box height is fixed and it overflows the page, forget overflowing children.
          resumeAt = null;
        }
      }
      adjoiningMargins = [];
      loopCompleted = false;
      break;
    }
  }
  if (loopCompleted) resumeAt = null;

  const boxIsFragmented = resumeAt !== null || box.forceFragmentation;
  if (box.style.get('continue') === 'discard') resumeAt = null;

  if (boxIsFragmented && avoidPageBreak(box.style.get('break_inside'), context) && !pageIsEmpty) {
    removePlaceholders(context, [...newChildren, ...box.children.slice(skip)], absoluteBoxes, fixedBoxes);
    if (box.establishesFormattingContext()) context.finishBlockFormattingContext();
    return [null, null, { break: 'any', page: null }, [], false, maxLines];
  }

  if (box.topMarginCollapses()) box.positionY += collapseMargin(thisBoxAdjoiningMargins) - box.marginTop;

  // Detect collapsing-through situation and collapse margins accordingly.
  const lastInFlowChild = findLastInFlowChild(newChildren);
  let collapsingThrough = false;
  if (lastInFlowChild === null) {
    // No in-flow child in box, collapse its top and bottom margins.
    const collapsedMargin = collapseMargin(adjoiningMargins);
    const direction = box.style.get('direction'); // TODO: should be parent's one instead
    if ((box.height === 'auto' || box.height === 0) && getClearance(context, box, direction, collapsedMargin) === null &&
      [box.minHeight, box.borderTopWidth, box.paddingTop, box.borderBottomWidth, box.paddingBottom].every((v) => v === 0)) {
      // Collapse through the box.
      collapsingThrough = true;
    } else {
      // Don't collapse through the box, update position and reset margins.
      positionY += collapsedMargin;
      adjoiningMargins = [];
    }
  } else if (box.height !== 'auto') {
    // In-flow children, collapse last child bottom margin and box bottom margin.
    // Not adjoining, reset margins.
    adjoiningMargins = [];
  }

  if (!box.bottomMarginCollapses()) {
    positionY += collapseMargin(adjoiningMargins);
    adjoiningMargins = [];
  }

  // Add block ellipsis.
  if (boxIsFragmented && newChildren.length) {
    const lc = newChildren[newChildren.length - 1];
    if (lc instanceof boxes.LineBox) lc.blockEllipsis = box.style.get('block_ellipsis');
  }

  const newBox = box.copyWithChildren(newChildren);
  newBox.removeDecoration(!isStart, boxIsFragmented && !discard);

  if (newBox.height === 'auto') newBox.height = Math.max(0, positionY - newBox.contentBoxY());

  if (newBox.style.get('position') === 'relative') {
    // New containing block, resolve the layout of the absolute descendants.
    for (const absoluteBox of absoluteBoxes) absoluteLayout(context, absoluteBox, newBox, fixedBoxes, bottomSpace, null);
  }

  for (const child of newBox.children) relativePositioning(child, [newBox.width, newBox.height]);

  if (box.establishesFormattingContext()) context.finishBlockFormattingContext(newBox);

  if (discard || !boxIsFragmented) {
    // After finish_block_formatting_context which may increment new_box.height.
    newBox.height = Math.max(Math.min(newBox.height, newBox.maxHeight), newBox.minHeight);
  } else if (bottomSpace > -Infinity && !newBox.isColumn) {
    // Make the box fill the blank space at the bottom of the page
    // https://www.w3.org/TR/css-break-3/#box-splitting
    const newBoxHeight = context.pageBottom - bottomSpace - newBox.positionY - (newBox.marginHeight() - newBox.height);
    if (newBoxHeight > newBox.height) {
      newBox.height = newBoxHeight;
      if (drawBottomDecoration) newBox.height += box.paddingBottom + box.borderBottomWidth + box.marginBottom;
    }
  }

  if (nextPage.page === null) nextPage.page = newBox.pageValues()[1];

  return [newBox, resumeAt, nextPage, adjoiningMargins, collapsingThrough, maxLines];
}

function cascadedValues(style: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of style.cascaded.keys()) out[key] = style.get(key);
  return out;
}

/** Get the amount of collapsed margin for a list of adjoining margins. */
export function collapseMargin(adjoiningMargins: number[]): number {
  const margins = [0, ...adjoiningMargins]; // add 0 to make sure that max/min don't get an empty list
  return Math.max(...margins.filter((m) => m >= 0)) + Math.min(...margins.filter((m) => m <= 0));
}

function addBreakValues(boxIn: AnyBox, side: 'before' | 'after'): string[] {
  const values: string[] = [];
  // Upstream guards with isinstance(box, block_parallel_box_types), which is
  // null-safe (None is never an instance); keep the duck-type check null-safe too.
  let box = boxIn;
  while (box !== null && box !== undefined &&
      (box.isBlockLevel || box instanceof boxes.TableRowGroupBox || box instanceof boxes.TableRowBox) &&
    (box.isInNormalFlow() || box.isFloated())) {
    values.push(box.style.get(`break_${side}`));
    if (!box.children.length) break;
    box = box.children[side === 'after' ? box.children.length - 1 : 0];
  }
  if (side === 'after') values.reverse();
  return values;
}

/**
 * Get the correct page break value between siblings: the value of ``page-break-before``
 * or ``page-break-after`` that "wins" for boxes that meet at the margin.
 */
export function blockLevelPageBreak(siblingBefore: AnyBox, siblingAfter: AnyBox): string {
  let result = 'auto';
  const values = [...addBreakValues(siblingBefore, 'after'), ...addBreakValues(siblingAfter, 'before')];
  const winning = new Set([
    'page|auto', 'page|avoid', 'page|avoid-page', 'page|avoid-column', 'column|auto', 'column|avoid',
    'column|avoid-page', 'column|avoid-column', 'avoid|auto', 'avoid-page|auto', 'avoid-column|auto',
  ]);
  for (const value of values) {
    if (['left', 'right', 'recto', 'verso'].includes(value) || winning.has(`${value}|${result}`)) result = value;
  }
  return result;
}

/** Return the next page name when siblings don't have the same names. */
export function blockLevelPageName(siblingBefore: AnyBox, siblingAfter: AnyBox): any {
  const beforePage = siblingBefore.pageValues()[1];
  const afterPage = siblingAfter.pageValues()[0];
  if (beforePage !== afterPage) return afterPage;
  return null;
}

/**
 * Find the last possible page break in ``children`` (because of a ``page-break-before:
 * avoid`` or a ``page-break-after: avoid`` we need an earlier page break opportunity).
 * Returns ``[newChildren, resumeAt]`` or null.
 */
export function findEarlierPageBreak(context: any, children: AnyBox[], absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[]): [AnyBox[], SkipStack] | null {
  if (children.length && children[0] instanceof boxes.LineBox) {
    // Normally `orphans` and `widows` apply to the block container, but line boxes inherit them.
    const orphans = children[0].style.get('orphans');
    const widows = children[0].style.get('widows');
    const index = children.length - widows; // how many lines we keep
    if (index < orphans) return null;
    const newChildren = children.slice(0, index);
    const resumeAt = { 0: newChildren[newChildren.length - 1].resumeAt };
    removePlaceholders(context, children.slice(index), absoluteBoxes, fixedBoxes);
    return [newChildren, resumeAt];
  }

  let previousInFlow: AnyBox = null;
  let found: [AnyBox[], SkipStack, number] | null = null;
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index];
    if (child instanceof boxes.TableRowGroupBox && (child.isHeader || child.isFooter)) {
      // We don't want to break pages before table headers or footers.
      continue;
    } else if (child.isColumn) {
      // We don't want to break pages between columns.
      continue;
    }

    if (child.isInNormalFlow()) {
      const pageBreak = blockLevelPageBreak(child, previousInFlow);
      if (previousInFlow !== null && !avoidPageBreak(pageBreak, context)) {
        const i = index + 1; // break after child
        found = [children.slice(0, i), { [children[i].index]: null }, i];
        break;
      }
      previousInFlow = child;
    }

    if (child.isInNormalFlow() && !avoidPageBreak(child.style.get('break_inside'), context)) {
      if (child instanceof boxes.BlockBox || child instanceof boxes.TableBox || child instanceof boxes.TableRowGroupBox) {
        const result = findEarlierPageBreak(context, child.children, absoluteBoxes, fixedBoxes);
        if (result) {
          const [newGrandChildren, resumeAtInner] = result;
          const newChild = child.copyWithChildren(newGrandChildren);
          const newChildren = [...children.slice(0, index), newChild];
          // Re-add footer at the end of split table.
          // TODO: fix table height and footer position.
          if (child instanceof boxes.TableRowGroupBox) {
            for (const nextChild of children.slice(index)) if (nextChild.isFooter) newChildren.push(nextChild);
          }
          // Index in the original parent.
          found = [newChildren, { [newChild.index]: resumeAtInner }, index + 1]; // remove placeholders after child
          break;
        }
      }
    }
  }
  if (found === null) return null;
  // TODO: don't remove absolute and fixed placeholders found in table footers.
  removePlaceholders(context, children.slice(found[2]), absoluteBoxes, fixedBoxes);
  return [found[0], found[1]];
}

/** Return the last in-flow child of given ``children``. */
export function findLastInFlowChild(children: AnyBox[]): AnyBox {
  for (let i = children.length - 1; i >= 0; i--) if (children[i].isInNormalFlow()) return children[i];
  return null;
}

/** Return the last child of given ``children`` for Class-A break points (https://www.w3.org/TR/css-break-4/#btw-blocks). */
export function findLastClassABreakPointChild(children: AnyBox[]): AnyBox {
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i].isInNormalFlow() || children[i].isFloated()) return children[i];
  }
  return null;
}

/** Remove placeholders from absolute and fixed lists (also footnotes, floats and running notes). */
export function removePlaceholders(context: any, boxList: AnyBox[], absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[]): void {
  for (const box of boxList) {
    if (box.children && box.children.length) removePlaceholders(context, box.children, absoluteBoxes, fixedBoxes);
    if (box.style.get('position') === 'absolute' && absoluteBoxes.includes(box)) {
      absoluteBoxes.splice(absoluteBoxes.indexOf(box), 1);
    } else if (box.style.get('position') === 'fixed' && fixedBoxes.includes(box)) {
      fixedBoxes.splice(fixedBoxes.indexOf(box), 1);
    }
    if (box.footnote) context.unlayoutFootnote(box.footnote);
    if (context.brokenOutOfFlow.has(box)) context.brokenOutOfFlow.delete(box);
    const shapes = context.excludedShapes;
    if (shapes.includes(box)) shapes.splice(shapes.indexOf(box), 1);
    if (box.note) context.removeRunningElement(box.note);
  }
}

/** Test whether we should avoid breaks. */
export function avoidPageBreak(pageBreak: string, context: any): boolean {
  if (context.inColumn) return ['avoid', 'avoid-page', 'avoid-column'].includes(pageBreak);
  return ['avoid', 'avoid-page'].includes(pageBreak);
}

/** Test whether we should force breaks. */
export function forcePageBreak(pageBreak: string, context: any): boolean {
  if (context.inColumn) return ['page', 'left', 'right', 'recto', 'verso', 'column'].includes(pageBreak);
  return ['page', 'left', 'right', 'recto', 'verso'].includes(pageBreak);
}