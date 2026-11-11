// SPDX-License-Identifier: BSD-3-Clause

/** Layout for flex containers and flex-items (mirrors layout/flex.py). */
import { dim } from '../css/properties.ts';
import * as boxes from '../formatting_structure/boxes.ts';
import { AbsolutePlaceholder, absoluteLayout } from './absolute.ts';
import * as block from './block.ts';
import { skipItem } from './block.ts';
import * as percent from './percent.ts';
import { maxContentWidth, minContentWidth, minMax } from './preferred.ts';
import { findInFlowBaseline, tableWrapperWidth } from './table.ts';

type AnyBox = any;
type SkipStack = Record<number, any> | null;
const MAXSIZE = 9223372036854775807;

/** Flex container line. */
class FlexLine {
  items: Array<[number, AnyBox]> = [];
  crossSize = 0;
  lowerBaseline = 0;
  constructor(items: Array<[number, AnyBox]> = []) {
    this.items = items;
  }
  get length(): number {
    return this.items.length;
  }
  reverse(): void {
    this.items.reverse();
  }
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);
const hasAny = (values: string[], ...needles: string[]): boolean => needles.some((n) => values.includes(n));

export function flexLayout(
  context: any, box: AnyBoxT, bottomSpaceIn: number, skipStackIn: SkipStack, containingBlock: AnyBox, pageIsEmptyIn: boolean,
  absoluteBoxesIn: AnyBox[], fixedBoxes: AnyBox[], discardIn: boolean,
): any[] {
  let bottomSpace = bottomSpaceIn;
  let skipStack = skipStackIn;
  let pageIsEmpty = pageIsEmptyIn;
  let absoluteBoxes = absoluteBoxesIn;
  let discard = discardIn;
  let theBox: AnyBox = box;

  // TODO: merge this with block_container_layout.
  context.createFlexFormattingContext(theBox);
  let resumeAt: SkipStack = null;
  let nextPage: any = { break: 'any', page: null };

  const isStart = skipStack === null;
  theBox.removeDecoration(!isStart, false);

  discard ||= theBox.style.get('continue') === 'discard';
  const drawBottomDecoration = discard || theBox.style.get('box_decoration_break') === 'clone';

  let rowGap = theBox.style.get('row_gap');
  let columnGap = theBox.style.get('column_gap');

  if (drawBottomDecoration) bottomSpace += theBox.paddingBottom + theBox.borderBottomWidth + theBox.marginBottom;

  if (theBox.style.get('position') === 'relative') {
    // New containing block, use a new absolute list.
    absoluteBoxes = [];
  }

  // References are to: https://www.w3.org/TR/css-flexbox-1/#layout-algorithm.

  // 1 Initial setup, done in formatting_structure.build.

  // 2 Determine the available main and cross space for the flex items.
  let main: 'width' | 'height';
  let cross: 'width' | 'height';
  if (theBox.style.get('flex_direction').startsWith('row')) [main, cross] = ['width', 'height'];
  else [main, cross] = ['height', 'width'];

  const marginLeft = theBox.marginLeft === 'auto' ? 0 : theBox.marginLeft;
  const marginRight = theBox.marginRight === 'auto' ? 0 : theBox.marginRight;

  // Define available main space. TODO: min- and max-content not implemented.
  let availableMainSpace: number;
  if (theBox[main] !== 'auto') {
    // If that dimension of the flex container's content box is a definite size…
    availableMainSpace = theBox[main];
  } else if (main === 'width') {
    // Otherwise, subtract the flex container's margin, border, and padding…
    availableMainSpace = containingBlock.width - marginLeft - marginRight - theBox.paddingLeft - theBox.paddingRight -
      theBox.borderLeftWidth - theBox.borderRightWidth;
  } else availableMainSpace = Infinity;

  // Same as above for available cross space.
  let availableCrossSpace: number;
  if (theBox[cross] !== 'auto') availableCrossSpace = theBox[cross];
  else if (cross === 'width') {
    availableCrossSpace = containingBlock.width - marginLeft - marginRight - theBox.paddingLeft - theBox.paddingRight -
      theBox.borderLeftWidth - theBox.borderRightWidth;
  } else availableCrossSpace = Infinity;

  // 3 Determine the flex base size and hypothetical main size of each item.
  const parentBox = theBox.copy();
  percent.resolvePercentages(parentBox, containingBlock);
  parentBox.removeDecoration(!isStart, false);
  block.blockLevelWidth(parentBox, containingBlock);
  let children: AnyBox[] = [...theBox.children].sort((a, b) => a.style.get('order') - b.style.get('order'));
  let skip: number;
  if (skipStack !== null) {
    [skip, skipStack] = skipItem(skipStack);
    if (theBox.style.get('flex_direction').endsWith('-reverse')) children = children.slice(0, skip + 1);
    else children = children.slice(skip);
  } else [skip, skipStack] = [0, null];
  let childSkipStack: SkipStack = skipStack;

  if (rowGap === 'normal') rowGap = 0;
  else if (rowGap.unit === '%') rowGap = theBox.height === 'auto' ? 0 : (rowGap.value / 100) * theBox.height;
  else rowGap = rowGap.value;
  if (columnGap === 'normal') columnGap = 0;
  else if (columnGap.unit === '%') columnGap = theBox.width === 'auto' ? 0 : (columnGap.value / 100) * theBox.width;
  else columnGap = columnGap.value;
  let mainGap: number;
  let crossGap: number;
  if (main === 'width') [mainGap, crossGap] = [columnGap, rowGap];
  else [mainGap, crossGap] = [rowGap, columnGap];

  let positionX = parentBox.positionX + parentBox.borderLeftWidth + parentBox.paddingLeft;
  if (parentBox.marginLeft !== 'auto') positionX += parentBox.marginLeft;
  let positionY = parentBox.positionY + parentBox.borderTopWidth + parentBox.paddingTop;
  if (parentBox.marginTop !== 'auto') positionY += parentBox.marginTop;
  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (!child.isFlexItem) {
      // Absolute child layout: create placeholder.
      if (child.isAbsolutelyPositioned()) {
        child.positionX = positionX;
        child.positionY = positionY;
        const placeholder = new AbsolutePlaceholder(child);
        placeholder.index = index;
        children[index] = placeholder;
        if (child.style.get('position') === 'absolute') absoluteBoxes.push(placeholder);
        else fixedBoxes.push(placeholder);
      } else if (child.isRunning() || child.isNote()) context.addRunningElement(child);
      continue;
    }
    // See https://www.w3.org/TR/css-flexbox-1/#min-size-auto.
    const childContainingBlock: [number, any] = main === 'width' ? [availableMainSpace, parentBox.height] : [parentBox.width, availableMainSpace];
    percent.resolvePercentages(child, childContainingBlock);
    if (child.isTableWrapper) tableWrapperWidth(context, child, childContainingBlock as [number, number]);
    child.positionX = positionX;
    child.positionY = positionY;
    if (child.style.get('min_width') === 'auto') {
      const specifiedSize = child.width;
      let newChild = child.copy();
      newChild.style = child.style.copy();
      newChild.style.set('width', 'auto');
      newChild.style.set('min_width', dim(0, 'px'));
      newChild.style.set('max_width', dim(Infinity, 'px'));
      let contentSize = minContentWidth(context, newChild, false);
      let transferredSize: number | null = null;
      if (child instanceof boxes.ReplacedBox) {
        const image = child.replacement;
        const [, intrinsicHeight, intrinsicRatio] = image.getIntrinsicSize(child.style.get('image_resolution'), child.style.get('font_size'));
        if (intrinsicRatio && intrinsicHeight) {
          transferredSize = intrinsicHeight * intrinsicRatio;
          contentSize = Math.max(child.minWidth, Math.min(child.maxWidth, contentSize));
        }
      }
      if (specifiedSize !== 'auto') child.minWidth = Math.min(specifiedSize, contentSize);
      else if (transferredSize !== null) child.minWidth = Math.min(transferredSize, contentSize);
      else child.minWidth = contentSize;
      void newChild;
    }
    if (child.style.get('min_height') === 'auto') {
      // TODO: avoid calling block_level_layout, write min_content_height instead.
      const specifiedSize = child.height;
      let newChild = child.copy();
      newChild.style = child.style.copy();
      newChild.style.set('height', 'auto');
      newChild.style.set('min_height', dim(0, 'px'));
      newChild.style.set('max_height', dim(Infinity, 'px'));
      if (newChild.style.get('width') === 'auto') {
        const newChildWidth = maxContentWidth(context, newChild);
        newChild.style.set('width', dim(newChildWidth, 'px'));
      }
      newChild = block.blockLevelLayout(context, newChild, bottomSpace, childSkipStack, parentBox, pageIsEmpty)[0];
      let contentSize = newChild ? newChild.height : 0;
      let transferredSize: number | null = null;
      if (child instanceof boxes.ReplacedBox) {
        const image = child.replacement;
        const [intrinsicWidth, , intrinsicRatio] = image.getIntrinsicSize(child.style.get('image_resolution'), child.style.get('font_size'));
        if (intrinsicRatio && intrinsicWidth) {
          transferredSize = intrinsicWidth / intrinsicRatio;
          contentSize = Math.max(child.minHeight, Math.min(child.maxHeight, contentSize));
        } else if (!intrinsicWidth) {
          // TODO: wrongly set by block_level_layout, would be OK with min_content_height.
          contentSize = 0;
        }
      }
      if (specifiedSize !== 'auto') child.minHeight = Math.min(specifiedSize, contentSize);
      else if (transferredSize !== null) child.minHeight = Math.min(transferredSize, contentSize);
      else child.minHeight = contentSize;
      if (newChild) block.removePlaceholders(context, newChild.children, absoluteBoxes, fixedBoxes);
    }

    let flexBasis: any;
    if (child.style.get('flex_basis') === 'content') flexBasis = 'content';
    else {
      flexBasis = percent.percentage(child.style.get('flex_basis'), child.style, availableMainSpace);
      if (flexBasis === 'auto') {
        flexBasis = child[main];
        if (flexBasis === 'auto') flexBasis = 'content';
      }
    }

    // 3.A If the item has a definite used flex basis…
    if (flexBasis !== 'content') {
      child.flexBaseSize = flexBasis;
      if (main === 'width') {
        child.mainOuterExtra = child.borderLeftWidth + child.borderRightWidth + child.paddingLeft + child.paddingRight;
        if (child.marginLeft !== 'auto') child.mainOuterExtra += child.marginLeft;
        if (child.marginRight !== 'auto') child.mainOuterExtra += child.marginRight;
      } else {
        child.mainOuterExtra = child.borderTopWidth + child.borderBottomWidth + child.paddingTop + child.paddingBottom;
        if (child.marginTop !== 'auto') child.mainOuterExtra += child.marginTop;
        if (child.marginBottom !== 'auto') child.mainOuterExtra += child.marginBottom;
      }
    } else {
      // TODO: 3.B If the flex item has an intrinsic aspect ratio… 3.C / 3.D (not implemented).
      // 3.E Otherwise…
      const newChild = child.copy();
      newChild.style = child.style.copy();
      if (main === 'width') {
        // … the item's min and max main sizes are ignored.
        newChild.style.set('min_width', dim(0, 'px'));
        newChild.style.set('max_width', dim(Infinity, 'px'));
        child.flexBaseSize = maxContentWidth(context, newChild, false);
        child.mainOuterExtra = maxContentWidth(context, child) - child.flexBaseSize;
      } else {
        // … the item's min and max main sizes are ignored.
        newChild.style.set('min_height', dim(0, 'px'));
        newChild.style.set('max_height', dim(Infinity, 'px'));
        newChild.width = Infinity;
        const [laidOut, , , adjoiningMargins] = block.blockLevelLayout(
          context, newChild, bottomSpace, childSkipStack, parentBox, pageIsEmpty, absoluteBoxes, fixedBoxes) as any;
        if (laidOut) {
          // As flex items margins never collapse (with other flex items or with the flex container),
          // we can add the adjoining margins to the child height.
          laidOut.height += block.collapseMargin(adjoiningMargins);
          child.flexBaseSize = laidOut.height;
          child.mainOuterExtra = laidOut.marginHeight() - laidOut.height;
        } else child.flexBaseSize = child.mainOuterExtra = 0;
      }
    }

    if (main === 'width') positionX += child.flexBaseSize + child.mainOuterExtra;
    else positionY += child.flexBaseSize + child.mainOuterExtra;

    const minSize = child[`min${cap(main)}`];
    const maxSize = child[`max${cap(main)}`];
    child.hypotheticalMainSize = Math.max(minSize, Math.min(child.flexBaseSize, maxSize));

    // Skip stack is only for the first child.
    childSkipStack = null;
  }

  // 4 Determine the main size of the flex container using the rules of the formatting context in which it participates.
  const originalBoxHeight = theBox.height;
  if (main === 'width') block.blockLevelWidth(theBox, containingBlock);
  else {
    if (theBox.height === 'auto') {
      theBox.height = 0;
      children.filter((c) => c.isFlexItem).forEach((child, i) => {
        theBox.height += child.hypotheticalMainSize + child.mainOuterExtra;
        if (i) theBox.height += mainGap;
      });
    }
    theBox.height = Math.max(theBox.minHeight, Math.min(theBox.height, theBox.maxHeight));
  }

  // 5 If the flex container is single-line, collect all the flex items into a single flex line.
  let flexLines: FlexLine[] = [];
  let line: Array<[number, AnyBox]> = [];
  let lineSize = 0;
  const mainSize = theBox[main];
  for (let k = 0; k < children.length; k++) {
    const i = k + skip;
    const child = children[k];
    if (!child.isFlexItem) continue;
    lineSize += child.hypotheticalMainSize + child.mainOuterExtra;
    if (i > skip) lineSize += mainGap;
    if (theBox.style.get('flex_wrap') !== 'nowrap' && lineSize > mainSize) {
      if (line.length) {
        flexLines.push(new FlexLine(line));
        line = [[i, child]];
        lineSize = child.hypotheticalMainSize + child.mainOuterExtra;
      } else {
        line.push([i, child]);
        flexLines.push(new FlexLine(line));
        line = [];
        lineSize = 0;
      }
    } else line.push([i, child]);
  }
  if (line.length) flexLines.push(new FlexLine(line));

  // TODO: Handle *-reverse using the terminology from the specification.
  if (theBox.style.get('flex_wrap') === 'wrap-reverse') flexLines.reverse();
  if (theBox.style.get('flex_direction').endsWith('-reverse')) for (const l of flexLines) l.reverse();

  // 6 Resolve the flexible lengths of all the flex items to find their used main size.
  availableMainSpace = theBox[main];
  for (const flexLine of flexLines) {
    // 9.7.1 Determine the used flex factor.
    const hypotheticalMainSize = flexLine.items.reduce((s, [, c]) => s + c.hypotheticalMainSize + c.mainOuterExtra, 0);
    const flexFactorType = hypotheticalMainSize < availableMainSpace ? 'grow' : 'shrink';

    // 9.7.3 Size inflexible items.
    for (const [, child] of flexLine.items) {
      let flexCondition: boolean;
      if (flexFactorType === 'grow') {
        child.flexFactor = child.style.get('flex_grow');
        flexCondition = child.flexBaseSize > child.hypotheticalMainSize;
      } else {
        child.flexFactor = child.style.get('flex_shrink');
        flexCondition = child.flexBaseSize < child.hypotheticalMainSize;
      }
      if (child.flexFactor === 0 || flexCondition) {
        child.targetMainSize = child.hypotheticalMainSize;
        child.frozen = true;
      } else child.frozen = false;
    }

    // 9.7.4 Calculate initial free space.
    let initialFreeSpace = availableMainSpace;
    flexLine.items.forEach(([, child], i) => {
      if (child.frozen) initialFreeSpace -= child.targetMainSize + child.mainOuterExtra;
      else initialFreeSpace -= child.flexBaseSize + child.mainOuterExtra;
      if (i) initialFreeSpace -= mainGap;
    });

    // 9.7.5.a Check for flexible items.
    while (!flexLine.items.every(([, c]) => c.frozen)) {
      let unfrozenFactorSum = 0;
      let remainingFreeSpace = availableMainSpace;

      // 9.7.5.b Calculate the remaining free space.
      flexLine.items.forEach(([, child], i) => {
        if (child.frozen) remainingFreeSpace -= child.targetMainSize + child.mainOuterExtra;
        else {
          remainingFreeSpace -= child.flexBaseSize + child.mainOuterExtra;
          unfrozenFactorSum += child.flexFactor;
        }
        if (i) remainingFreeSpace -= mainGap;
      });

      if (unfrozenFactorSum < 1) initialFreeSpace *= unfrozenFactorSum;

      if (initialFreeSpace === Infinity) initialFreeSpace = MAXSIZE;
      if (remainingFreeSpace === Infinity) remainingFreeSpace = MAXSIZE;

      const initialMagnitude = initialFreeSpace > 0 ? Math.trunc(Math.log10(initialFreeSpace)) : -Infinity;
      const remainingMagnitude = remainingFreeSpace > 0 ? Math.trunc(Math.log10(remainingFreeSpace)) : -Infinity;
      if (initialMagnitude < remainingMagnitude) remainingFreeSpace = initialFreeSpace;

      // 9.7.5.c Distribute free space proportional to the flex factors.
      if (remainingFreeSpace === 0) {
        // If the remaining free space is zero: "Do nothing", but we at least set the flex_base_size as
        // target_main_size for next step.
        for (const [, child] of flexLine.items) if (!child.frozen) child.targetMainSize = child.flexBaseSize;
      } else {
        let scaledFlexShrinkFactorsSum = 0;
        let flexGrowFactorsSum = 0;
        for (const [, child] of flexLine.items) {
          if (!child.frozen) {
            child.scaledFlexShrinkFactor = child.flexBaseSize * child.style.get('flex_shrink');
            scaledFlexShrinkFactorsSum += child.scaledFlexShrinkFactor;
            flexGrowFactorsSum += child.style.get('flex_grow');
          }
        }
        for (const [, child] of flexLine.items) {
          if (!child.frozen) {
            // If using the flex grow factor…
            if (flexFactorType === 'grow') {
              const ratio = child.style.get('flex_grow') / flexGrowFactorsSum;
              child.targetMainSize = child.flexBaseSize + remainingFreeSpace * ratio;
            } else if (flexFactorType === 'shrink') {
              // If using the flex shrink factor…
              if (scaledFlexShrinkFactorsSum === 0) child.targetMainSize = child.flexBaseSize;
              else {
                const ratio = child.scaledFlexShrinkFactor / scaledFlexShrinkFactorsSum;
                child.targetMainSize = child.flexBaseSize + remainingFreeSpace * ratio;
              }
            }
            child.targetMainSize = minMax(child, child.targetMainSize);
          }
        }
      }

      // 9.7.5.d Fix min/max violations.
      for (const [, child] of flexLine.items) {
        child.adjustment = 0;
        if (!child.frozen) {
          let minSize = child[`min${cap(main)}`];
          const maxSize = child[`max${cap(main)}`];
          minSize = Math.max(minSize, Math.min(child.targetMainSize, maxSize));
          if (child.targetMainSize < minSize) {
            child.adjustment = minSize - child.targetMainSize;
            child.targetMainSize = minSize;
          }
        }
      }

      // 9.7.5.e Freeze over-flexed items.
      const adjustments = flexLine.items.reduce((s, [, c]) => s + c.adjustment, 0);
      for (const [, child] of flexLine.items) {
        if (adjustments === 0) child.frozen = true; // Zero: Freeze all items.
        else if (adjustments > 0 && child.adjustment > 0) child.frozen = true; // Positive: Freeze all the items with min violations.
        else if (adjustments < 0 && child.adjustment < 0) child.frozen = true; // Negative: Freeze all the items with max violations.
      }
    }

    // 9.7.6 Set each item's used main size to its target main size.
    for (const [, child] of flexLine.items) {
      if (main === 'width') child.width = child.targetMainSize;
      else child.height = child.targetMainSize;
    }
  }

  // 7 Determine the hypothetical cross size of each item. TODO: Handle breaks.
  const newFlexLines: FlexLine[] = [];
  childSkipStack = skipStack;
  for (const flexLine of flexLines) {
    const newFlexLine = new FlexLine();
    for (const [index, child] of flexLine.items) {
      // TODO: Fix this value, see test_flex_item_auto_margin_cross.
      if (child.marginTop === 'auto') child.marginTop = 0;
      if (child.marginBottom === 'auto') child.marginBottom = 0;
      // TODO: Find another way than calling block_level_layout_switch.
      let newChild = child.copy();
      let adjoiningMargins: number[];
      [newChild, , , adjoiningMargins] = block.blockLevelLayoutSwitch(
        context, newChild, -Infinity, childSkipStack, parentBox, pageIsEmpty, absoluteBoxes, fixedBoxes, [], null, null, discard, null) as any;
      child._baseline = findInFlowBaseline(newChild) || 0;
      if (cross === 'height') {
        child.height = newChild.height;
        // As flex items margins never collapse (with other flex items or with the flex container),
        // we can add the adjoining margins to the child height.
        child.height += block.collapseMargin(adjoiningMargins);
      } else if (child.width === 'auto') {
        const minWidth = minContentWidth(context, child, false);
        const maxWidth = maxContentWidth(context, child, false);
        child.width = Math.min(Math.max(minWidth, newChild.width), maxWidth);
      } else child.width = newChild.width;
      if (newChild) block.removePlaceholders(context, newChild.children, absoluteBoxes, fixedBoxes);

      newFlexLine.items.push([index, child]);

      // Skip stack is only for the first child.
      childSkipStack = null;
    }
    if (newFlexLine.items.length) newFlexLines.push(newFlexLine);
  }
  flexLines = newFlexLines;

  // 8 Calculate the cross size of each flex line.
  let crossSize = theBox[cross];
  if (flexLines.length === 1 && crossSize !== 'auto') {
    // If the flex container is single-line…
    flexLines[0].crossSize = crossSize;
  } else {
    // Otherwise, for each flex line…
    // 8.1 Collect all the flex items whose inline-axis is parallel to the main-axis…
    for (const flexLine of flexLines) {
      const collectedItems: AnyBox[] = [];
      const notCollectedItems: AnyBox[] = [];
      for (const [, child] of flexLine.items) {
        const alignSelf = child.style.get('align_self') as string[];
        const collect = theBox.style.get('flex_direction').startsWith('row') && alignSelf.includes('baseline') &&
          !hasAny([child.marginTop, child.marginBottom] as string[], 'auto');
        (collect ? collectedItems : notCollectedItems).push(child);
      }
      let crossStartDistance = 0;
      let crossEndDistance = 0;
      for (const child of collectedItems) {
        const baseline = child._baseline - child.positionY;
        crossStartDistance = Math.max(crossStartDistance, baseline);
        crossEndDistance = Math.max(crossEndDistance, child.marginHeight() - baseline);
      }
      const collectedCrossSize = crossStartDistance + crossEndDistance;
      let nonCollectedCrossSize = 0;
      // 8.2 Find the largest outer hypothetical cross size.
      if (notCollectedItems.length) {
        nonCollectedCrossSize = -Infinity;
        for (const child of notCollectedItems) {
          let childCrossSize: number;
          if (cross === 'height') {
            childCrossSize = child.borderHeight();
            if (child.marginTop !== 'auto') childCrossSize += child.marginTop;
            if (child.marginBottom !== 'auto') childCrossSize += child.marginBottom;
          } else {
            childCrossSize = child.borderWidth();
            if (child.marginLeft !== 'auto') childCrossSize += child.marginLeft;
            if (child.marginRight !== 'auto') childCrossSize += child.marginRight;
          }
          nonCollectedCrossSize = Math.max(childCrossSize, nonCollectedCrossSize);
        }
      }
      // 8.3 Set the used cross-size of the flex line.
      flexLine.crossSize = Math.max(collectedCrossSize, nonCollectedCrossSize);
    }
  }

  // 8.3 If the flex container is single-line…
  if (flexLines.length === 1) {
    const [flexLine] = flexLines;
    let minCrossSize = theBox[`min${cap(cross)}`];
    if (minCrossSize === 'auto') minCrossSize = -Infinity;
    let maxCrossSize = theBox[`max${cap(cross)}`];
    if (maxCrossSize === 'auto') maxCrossSize = Infinity;
    flexLine.crossSize = Math.max(minCrossSize, Math.min(flexLine.crossSize, maxCrossSize));
  }

  // 9 Handle 'align-content: stretch'.
  let alignContent = theBox.style.get('align_content') as string[];
  if (alignContent.includes('normal')) alignContent = ['stretch'];
  if (alignContent.includes('stretch')) {
    let definiteCrossSize: number | null = null;
    if (cross === 'height' && theBox.height !== 'auto') definiteCrossSize = theBox.height;
    else if (cross === 'width') {
      if (theBox instanceof boxes.FlexBox) {
        definiteCrossSize = theBox.width === 'auto' ? availableCrossSpace : theBox.width;
      }
    }
    if (definiteCrossSize !== null) {
      let extraCrossSize = definiteCrossSize;
      extraCrossSize -= flexLines.reduce((s, l) => s + l.crossSize, 0);
      extraCrossSize -= (flexLines.length - 1) * crossGap;
      if (extraCrossSize) for (const l of flexLines) l.crossSize += extraCrossSize / flexLines.length;
    }
  }

  // TODO: 10 Collapse 'visibility: collapse' items.

  // 11 Determine the used cross size of each flex item.
  let alignItems = theBox.style.get('align_items') as string[];
  if (alignItems.includes('normal')) alignItems = ['stretch'];
  for (const flexLine of flexLines) {
    for (const [, child] of flexLine.items) {
      let alignSelf = child.style.get('align_self') as string[];
      if (alignSelf.includes('normal')) alignSelf = ['stretch'];
      else if (alignSelf.includes('auto')) alignSelf = alignItems;
      if (alignSelf.includes('stretch') && child.style.get(cross) === 'auto') {
        const crossMargins = cross === 'height'
          ? [child.style.get('margin_top'), child.style.get('margin_bottom')]
          : [child.style.get('margin_left'), child.style.get('margin_right')];
        if (!crossMargins.includes('auto')) {
          let size = flexLine.crossSize;
          if (cross === 'height') {
            size -= child.marginTop + child.marginBottom + child.paddingTop + child.paddingBottom + child.borderTopWidth + child.borderBottomWidth;
          } else {
            size -= child.marginLeft + child.marginRight + child.paddingLeft + child.paddingRight + child.borderLeftWidth + child.borderRightWidth;
          }
          child[cross] = size;
        }
      }
      // else: Cross size has been set by step 7.
    }
  }

  // 12 Distribute any remaining free space.
  const originalPositionMain = main === 'width' ? theBox.contentBoxX() : theBox.contentBoxY();
  let justifyContent = theBox.style.get('justify_content') as string[];
  if (justifyContent.includes('normal')) justifyContent = ['flex-start'];
  if (theBox.style.get('flex_direction').endsWith('-reverse')) {
    if (justifyContent.includes('flex-start')) justifyContent = ['flex-end'];
    else if (justifyContent.includes('flex-end')) justifyContent = ['flex-start'];
    else if (justifyContent.includes('start')) justifyContent = ['end'];
    else if (justifyContent.includes('end')) justifyContent = ['start'];
  }

  for (const flexLine of flexLines) {
    let positionMain = originalPositionMain;
    let freeSpace: number;
    if (main === 'width') {
      freeSpace = theBox.width;
      for (const [, child] of flexLine.items) {
        freeSpace -= child.borderWidth();
        if (child.marginLeft !== 'auto') freeSpace -= child.marginLeft;
        if (child.marginRight !== 'auto') freeSpace -= child.marginRight;
      }
    } else {
      freeSpace = theBox.height;
      for (const [, child] of flexLine.items) {
        freeSpace -= child.borderHeight();
        if (child.marginTop !== 'auto') freeSpace -= child.marginTop;
        if (child.marginBottom !== 'auto') freeSpace -= child.marginBottom;
      }
    }
    freeSpace -= (flexLine.length - 1) * mainGap;

    // 12.1 If the remaining free space is positive…
    let margins = 0;
    for (const [, child] of flexLine.items) {
      if (main === 'width') {
        if (child.marginLeft === 'auto') margins += 1;
        if (child.marginRight === 'auto') margins += 1;
      } else {
        if (child.marginTop === 'auto') margins += 1;
        if (child.marginBottom === 'auto') margins += 1;
      }
    }
    if (margins) {
      freeSpace /= margins;
      for (const [, child] of flexLine.items) {
        if (main === 'width') {
          if (child.marginLeft === 'auto') child.marginLeft = freeSpace;
          if (child.marginRight === 'auto') child.marginRight = freeSpace;
        } else {
          if (child.marginTop === 'auto') child.marginTop = freeSpace;
          if (child.marginBottom === 'auto') child.marginBottom = freeSpace;
        }
      }
      freeSpace = 0;
    }

    if (theBox.style.get('direction') === 'rtl' && main === 'width') freeSpace *= -1;

    // 12.2 Align the items along the main-axis per justify-content.
    if (hasAny(justifyContent, 'end', 'flex-end', 'right')) positionMain += freeSpace;
    else if (justifyContent.includes('center')) positionMain += freeSpace / 2;
    else if (justifyContent.includes('space-around')) positionMain += freeSpace / flexLine.length / 2;
    else if (justifyContent.includes('space-evenly')) positionMain += freeSpace / (flexLine.length + 1);

    const growths = children.reduce((s, c) => s + c.style.get('flex_grow'), 0);
    if (theBox.style.get('direction') === 'rtl' && main === 'width') mainGap *= -1;
    flexLine.items.forEach(([, child], i) => {
      if (i) positionMain += mainGap;
      if (main === 'width') {
        child.positionX = positionMain;
        if (justifyContent.includes('stretch') && growths) child.width += (freeSpace * child.style.get('flex_grow')) / growths;
      } else child.positionY = positionMain;
      let marginMain = main === 'width' ? child.marginWidth() : child.marginHeight();
      if (theBox.style.get('direction') === 'rtl' && main === 'width') marginMain *= -1;
      positionMain += marginMain;
      if (justifyContent.includes('space-around')) positionMain += freeSpace / flexLine.length;
      else if (justifyContent.includes('space-between')) {
        if (flexLine.length > 1) positionMain += freeSpace / (flexLine.length - 1);
      } else if (justifyContent.includes('space-evenly')) positionMain += freeSpace / (flexLine.length + 1);
    });
  }

  // 13 Resolve cross-axis auto margins.
  if (cross === 'width') {
    // Make sure width/margins are no longer "auto", as we did not do it above in step 4.
    block.blockLevelWidth(theBox, containingBlock);
  }
  let positionCross = cross === 'height' ? theBox.contentBoxY() : theBox.contentBoxX();
  for (const flexLine of flexLines) {
    flexLine.lowerBaseline = -Infinity;
    // TODO: Don't duplicate this loop.
    for (const [, child] of flexLine.items) {
      let alignSelf = child.style.get('align_self') as string[];
      if (alignSelf.includes('auto')) alignSelf = alignItems;
      if (alignSelf.includes('baseline') && main === 'width') {
        // TODO: handle vertical text.
        child.baseline = child._baseline - positionCross;
        flexLine.lowerBaseline = Math.max(flexLine.lowerBaseline, child.baseline);
      }
    }
    if (flexLine.lowerBaseline === -Infinity) flexLine.lowerBaseline = flexLine.length ? flexLine.items[0][1]._baseline : 0;
    for (const [, child] of flexLine.items) {
      const crossMargins = cross === 'height'
        ? [child.style.get('margin_top'), child.style.get('margin_bottom')]
        : [child.style.get('margin_left'), child.style.get('margin_right')];
      const autoMargins = crossMargins.filter((m) => m === 'auto').length;
      // If a flex item has auto cross-axis margins…
      if (autoMargins) {
        let extraCross = flexLine.crossSize;
        if (cross === 'height') {
          extraCross -= child.borderHeight();
          if (child.marginTop !== 'auto') extraCross -= child.marginTop;
          if (child.marginBottom !== 'auto') extraCross -= child.marginBottom;
        } else {
          extraCross -= child.borderWidth();
          if (child.marginLeft !== 'auto') extraCross -= child.marginLeft;
          if (child.marginRight !== 'auto') extraCross -= child.marginRight;
        }
        if (extraCross > 0) {
          // If its outer cross size is less than the cross size…
          extraCross /= autoMargins;
          if (cross === 'height') {
            if (child.style.get('margin_top') === 'auto') child.marginTop = extraCross;
            if (child.style.get('margin_bottom') === 'auto') child.marginBottom = extraCross;
          } else {
            if (child.style.get('margin_left') === 'auto') child.marginLeft = extraCross;
            if (child.style.get('margin_right') === 'auto') child.marginRight = extraCross;
          }
        } else if (cross === 'height') {
          // Otherwise…
          if (child.marginTop === 'auto') child.marginTop = 0;
          child.marginBottom = extraCross;
        } else {
          if (child.marginLeft === 'auto') child.marginLeft = 0;
          child.marginRight = extraCross;
        }
      } else {
        // 14 Align all flex items along the cross-axis.
        let alignSelf = child.style.get('align_self') as string[];
        if (alignSelf.includes('normal')) alignSelf = ['stretch'];
        else if (alignSelf.includes('auto')) alignSelf = alignItems;
        const position = cross === 'height' ? 'positionY' : 'positionX';
        child[position] = positionCross;
        if (hasAny(alignSelf, 'end', 'self-end', 'flex-end')) {
          if (cross === 'height') child.positionY += flexLine.crossSize - child.marginHeight();
          else child.positionX += flexLine.crossSize - child.marginWidth();
        } else if (alignSelf.includes('center')) {
          if (cross === 'height') child.positionY += (flexLine.crossSize - child.marginHeight()) / 2;
          else child.positionX += (flexLine.crossSize - child.marginWidth()) / 2;
        } else if (alignSelf.includes('baseline')) {
          if (cross === 'height') child.positionY += flexLine.lowerBaseline - child.baseline;
          // else: TODO: Handle vertical text.
        } else if (alignSelf.includes('stretch')) {
          if (child.style.get(cross) === 'auto') {
            // (Python computes `margins` here but never uses it.)
          }
        }
      }
    }
    positionCross += flexLine.crossSize;
  }

  // 15 Determine the flex container's used cross size. TODO: Use the updated algorithm.
  if (theBox[cross] === 'auto') {
    // Otherwise, use the sum of the flex lines' cross sizes… TODO: Handle min-max. TODO: What about align-content here?
    crossSize = flexLines.reduce((s, l) => s + l.crossSize, 0);
    crossSize += (flexLines.length - 1) * crossGap;
    theBox[cross] = crossSize;
  }

  if (flexLines.length > 1) {
    // 15 If the cross size property is a definite size, use that…
    let extraCrossSize = theBox[cross];
    extraCrossSize -= flexLines.reduce((s, l) => s + l.crossSize, 0);
    extraCrossSize -= (flexLines.length - 1) * crossGap;
    // 16 Align all flex lines per align-content.
    let crossTranslate = 0;
    const direction = cross === 'height' ? 'positionY' : 'positionX';
    flexLines.forEach((flexLine, i) => {
      const flexItems = flexLine.items.map(([, c]) => c).filter((c) => c.isFlexItem);
      if (i) crossTranslate += crossGap;
      let currentValue = 0;
      for (const child of flexItems) {
        currentValue = child[direction] + crossTranslate;
        child[direction] = currentValue;
      }
      if (extraCrossSize === 0) return;
      for (const child of flexItems) {
        if (hasAny(alignContent, 'flex-end', 'end')) child[direction] = currentValue + extraCrossSize;
        else if (alignContent.includes('center')) child[direction] = currentValue + extraCrossSize / 2;
        else if (alignContent.includes('space-around')) child[direction] = currentValue + extraCrossSize / flexLines.length / 2;
        else if (alignContent.includes('space-evenly')) child[direction] = currentValue + extraCrossSize / (flexLines.length + 1);
      }
      if (alignContent.includes('space-between')) crossTranslate += extraCrossSize / (flexLines.length - 1);
      else if (alignContent.includes('space-around')) crossTranslate += extraCrossSize / flexLines.length;
      else if (alignContent.includes('space-evenly')) crossTranslate += extraCrossSize / (flexLines.length + 1);
    });
  }

  // Now we are no longer in the flex algorithm.
  theBox = theBox.copyWithChildren(children.filter((c) => c.isAbsolutelyPositioned()));
  childSkipStack = skipStack;
  let stopOuter = false;
  for (const flexLine of flexLines) {
    for (const [index, child] of flexLine.items) {
      if (child.isFlexItem) {
        // TODO: Don't use block_level_layout_switch.
        const [newChild, childResumeAt, np] = block.blockLevelLayoutSwitch(
          context, child, bottomSpace, childSkipStack, theBox, pageIsEmpty, absoluteBoxes, fixedBoxes, [], null, null, discard, null) as any;
        nextPage = np;
        if (newChild === null) {
          let resumeIndex: number;
          if (resumeAt) {
            [resumeIndex] = skipItem(resumeAt);
            resumeIndex -= 1;
          } else resumeIndex = 0;
          resumeAt = { [resumeIndex + index]: null };
        } else {
          pageIsEmpty = false;
          theBox.children.push(newChild);
          positionY = newChild.positionY + newChild.borderHeight();
          if (childResumeAt !== null) {
            let firstLevelSkip = 0;
            if (resumeAt) [firstLevelSkip] = skipItem(resumeAt);
            resumeAt = { [firstLevelSkip + index]: childResumeAt };
          }
        }
        if (resumeAt) break;
      }
      // Skip stack is only for the first child.
      childSkipStack = null;
    }
    if (resumeAt) {
      stopOuter = true;
      break;
    }
  }
  void stopOuter;

  if (originalBoxHeight !== 'auto') {
    // Don't resume if flex items overflow flex container bottom.
    const boxBottom = theBox.positionY + theBox.borderHeight();
    if (context.overflows(boxBottom, positionY)) resumeAt = null;
  }

  if (theBox.style.get('position') === 'relative') {
    // New containing block, resolve the layout of the absolute descendants.
    for (const absoluteBox of absoluteBoxes) absoluteLayout(context, absoluteBox, theBox, fixedBoxes, bottomSpace, null);
  }

  for (const child of theBox.children) block.relativePositioning(child, [theBox.width, theBox.height]);

  // TODO: Use real algorithm, see https://www.w3.org/TR/css-flexbox-1/#flex-baselines.
  if (theBox instanceof boxes.InlineFlexBox) {
    if (main === 'width') {
      // and main text direction is horizontal
      theBox.baseline = flexLines.length ? flexLines[0].lowerBaseline : 0;
    } else {
      theBox.baseline = 0;
      for (const child of theBox.children) {
        if (child.isInNormalFlow()) {
          theBox.baseline = findInFlowBaseline(child) || 0;
          break;
        }
      }
    }
  }

  theBox.removeDecoration(false, Boolean(resumeAt) && !discard);

  context.finishFlexFormattingContext(theBox);

  return [theBox, resumeAt, nextPage, [], false];
}

type AnyBoxT = any;