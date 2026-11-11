// SPDX-License-Identifier: BSD-3-Clause

/** Layout for pages and CSS3 margin boxes (mirrors layout/page.py). */
import type { PageType } from '../css/index.ts';
import * as boxes from '../formatting_structure/boxes.ts';
import * as build from '../formatting_structure/build.ts';
import { LOGGER } from '../logger.ts';
import { absoluteBoxLayout, absoluteLayout } from './absolute.ts';
import { blockContainerLayout, blockLevelLayout, skipItem } from './block.ts';
import { floatLayout } from './float.ts';
import { handleMinMaxHeight, handleMinMaxWidth } from './min_max.ts';
import { resolvePercentages } from './percent.ts';
import { maxContentWidth, minContentWidth } from './preferred.ts';

type AnyBox = any;
type SkipStack = Record<number, any> | null;

abstract class OrientedBox {
  context: any;
  box: AnyBox;
  inner: any;
  marginA: any;
  marginB: any;
  paddingPlusBorder = 0;
  abstract get minContentSize(): number;
  abstract get maxContentSize(): number;
  abstract restoreBoxAttributes(): void;

  constructor(context: any, box: AnyBox) {
    this.context = context;
    this.box = box;
  }

  get sugar(): number {
    return this.paddingPlusBorder + this.marginA + this.marginB;
  }
  get outer(): number {
    return this.sugar + this.inner;
  }
  set outer(newOuterWidth: number) {
    this.inner = Math.min(Math.max(this.minContentSize, newOuterWidth - this.sugar), this.maxContentSize);
  }
  get outerMinContentSize(): number {
    return this.sugar + (this.inner === 'auto' ? this.minContentSize : this.inner);
  }
  get outerMaxContentSize(): number {
    return this.sugar + (this.inner === 'auto' ? this.maxContentSize : this.inner);
  }
}

class VerticalBox extends OrientedBox {
  constructor(context: any, box: AnyBox) {
    super(context, box);
    // Inner dimension: that of the content area, as opposed to the outer dimension: that of the margin area.
    this.inner = box.height;
    this.marginA = box.marginTop;
    this.marginB = box.marginBottom;
    this.paddingPlusBorder = box.paddingTop + box.paddingBottom + box.borderTopWidth + box.borderBottomWidth;
  }
  restoreBoxAttributes(): void {
    this.box.height = this.inner;
    this.box.marginTop = this.marginA;
    this.box.marginBottom = this.marginB;
  }
  // TODO: Define what are the min-content and max-content heights
  get minContentSize(): number {
    return 0;
  }
  get maxContentSize(): number {
    return 1e6;
  }
}

class HorizontalBox extends OrientedBox {
  private _min: number | null = null;
  private _max: number | null = null;
  constructor(context: any, box: AnyBox) {
    super(context, box);
    this.inner = box.width;
    this.marginA = box.marginLeft;
    this.marginB = box.marginRight;
    this.paddingPlusBorder = box.paddingLeft + box.paddingRight + box.borderLeftWidth + box.borderRightWidth;
  }
  restoreBoxAttributes(): void {
    this.box.width = this.inner;
    this.box.marginLeft = this.marginA;
    this.box.marginRight = this.marginB;
  }
  get minContentSize(): number {
    if (this._min === null) this._min = minContentWidth(this.context, this.box, false);
    return this._min;
  }
  get maxContentSize(): number {
    if (this._max === null) this._max = maxContentWidth(this.context, this.box, false);
    return this._max;
  }
}

/**
 * Compute and set a margin box fixed dimension on ``box`` (https://drafts.csswg.org/css-page-3/#margin-constraints).
 * ``vertical`` sets height/margin-top/margin-bottom; otherwise width/margin-left/margin-right.
 * ``topOrLeft`` determines which margin should be 'auto' if the values are over-constrained (rule 3).
 */
export function computeFixedDimension(context: any, boxIn: AnyBox, outer: number, vertical: boolean, topOrLeft: boolean): void {
  const box = vertical ? new VerticalBox(context, boxIn) : new HorizontalBox(context, boxIn);

  // Rule 2
  const total = box.paddingPlusBorder + [box.marginA, box.marginB, box.inner].filter((v) => v !== 'auto').reduce((a: number, b: number) => a + b, 0);
  if (total > outer) {
    if (box.marginA === 'auto') box.marginA = 0;
    if (box.marginB === 'auto') box.marginB = 0;
    if (box.inner === 'auto') {
      // XXX this is not in the spec, but without it box.inner would end up with a negative value.
      // Instead, this will trigger rule 3 below.
      box.inner = 0;
    }
  }
  // Rule 3
  if (![box.marginA, box.marginB, box.inner].includes('auto')) {
    // Over-constrained
    if (topOrLeft) box.marginA = 'auto';
    else box.marginB = 'auto';
  }
  // Rule 4
  if ([box.marginA, box.marginB, box.inner].filter((v) => v === 'auto').length === 1) {
    if (box.inner === 'auto') box.inner = outer - box.paddingPlusBorder - box.marginA - box.marginB;
    else if (box.marginA === 'auto') box.marginA = outer - box.paddingPlusBorder - box.marginB - box.inner;
    else if (box.marginB === 'auto') box.marginB = outer - box.paddingPlusBorder - box.marginA - box.inner;
  }
  // Rule 5
  if (box.inner === 'auto') {
    if (box.marginA === 'auto') box.marginA = 0;
    if (box.marginB === 'auto') box.marginB = 0;
    box.inner = outer - box.paddingPlusBorder - box.marginA - box.marginB;
  }
  // Rule 6
  if (box.marginA === 'auto' && box.marginB === 'auto') {
    box.marginA = box.marginB = (outer - box.paddingPlusBorder - box.inner) / 2;
  }
  box.restoreBoxAttributes();
}

/**
 * Compute and set a margin box variable dimension (https://drafts.csswg.org/css-page-3/#margin-dimension).
 * ``sideBoxes`` are three boxes on a same side (left/top, center/middle, right/bottom).
 */
export function computeVariableDimension(context: any, sideBoxesIn: AnyBox[], vertical: boolean, availableSize: number): void {
  const Cls = vertical ? VerticalBox : HorizontalBox;
  const sideBoxes = sideBoxesIn.map((b) => new Cls(context, b));
  const [boxA, boxB, boxC] = sideBoxes;

  for (const box of sideBoxes) {
    if (box.marginA === 'auto') box.marginA = 0;
    if (box.marginB === 'auto') box.marginB = 0;
  }

  if (!boxB.box.isGenerated) {
    // Non-generated boxes get zero for every box-model property.
    if (boxB.inner !== 0) throw new Error('expected zero inner');
    if (boxA.inner === 'auto' && boxC.inner === 'auto') {
      // A and C both have 'width: auto'
      if (availableSize > boxA.outerMaxContentSize + boxC.outerMaxContentSize) {
        // sum of the outer max-content widths is less than the available width
        const flexSpace = availableSize - boxA.outerMaxContentSize - boxC.outerMaxContentSize;
        const flexFactorA = boxA.outerMaxContentSize;
        const flexFactorC = boxC.outerMaxContentSize;
        let flexFactorSum = flexFactorA + flexFactorC;
        if (flexFactorSum === 0) flexFactorSum = 1;
        boxA.outer = boxA.maxContentSize + (flexSpace * flexFactorA) / flexFactorSum;
        boxC.outer = boxC.maxContentSize + (flexSpace * flexFactorC) / flexFactorSum;
      } else if (availableSize > boxA.outerMinContentSize + boxC.outerMinContentSize) {
        // sum of the outer min-content widths is less than the available width
        const flexSpace = availableSize - boxA.outerMinContentSize - boxC.outerMinContentSize;
        const flexFactorA = boxA.maxContentSize - boxA.minContentSize;
        const flexFactorC = boxC.maxContentSize - boxC.minContentSize;
        let flexFactorSum = flexFactorA + flexFactorC;
        if (flexFactorSum === 0) flexFactorSum = 1;
        boxA.outer = boxA.minContentSize + (flexSpace * flexFactorA) / flexFactorSum;
        boxC.outer = boxC.minContentSize + (flexSpace * flexFactorC) / flexFactorSum;
      } else {
        // otherwise
        const flexSpace = availableSize - boxA.outerMinContentSize - boxC.outerMinContentSize;
        const flexFactorA = boxA.minContentSize;
        const flexFactorC = boxC.minContentSize;
        let flexFactorSum = flexFactorA + flexFactorC;
        if (flexFactorSum === 0) flexFactorSum = 1;
        boxA.outer = boxA.minContentSize + (flexSpace * flexFactorA) / flexFactorSum;
        boxC.outer = boxC.minContentSize + (flexSpace * flexFactorC) / flexFactorSum;
      }
    } else if (boxA.inner === 'auto') {
      // only one box has 'width: auto'
      boxA.outer = availableSize - boxC.outer;
    } else if (boxC.inner === 'auto') {
      boxC.outer = availableSize - boxA.outer;
    }
  } else {
    if (boxB.inner === 'auto') {
      // resolve any auto width of the middle box (B)
      const acMaxContentSize = 2 * Math.max(boxA.outerMaxContentSize, boxC.outerMaxContentSize);
      if (availableSize > boxB.outerMaxContentSize + acMaxContentSize) {
        const flexSpace = availableSize - boxB.outerMaxContentSize - acMaxContentSize;
        const flexFactorB = boxB.outerMaxContentSize;
        const flexFactorAc = acMaxContentSize;
        let flexFactorSum = flexFactorB + flexFactorAc;
        if (flexFactorSum === 0) flexFactorSum = 1;
        boxB.outer = boxB.maxContentSize + (flexSpace * flexFactorB) / flexFactorSum;
      } else {
        const acMinContentSize = 2 * Math.max(boxA.outerMinContentSize, boxC.outerMinContentSize);
        if (availableSize > boxB.outerMinContentSize + acMinContentSize) {
          const flexSpace = availableSize - boxB.outerMinContentSize - acMinContentSize;
          const flexFactorB = boxB.maxContentSize - boxB.minContentSize;
          const flexFactorAc = acMaxContentSize - acMinContentSize;
          let flexFactorSum = flexFactorB + flexFactorAc;
          if (flexFactorSum === 0) flexFactorSum = 1;
          boxB.outer = boxB.minContentSize + (flexSpace * flexFactorB) / flexFactorSum;
        } else {
          const flexSpace = availableSize - boxB.outerMinContentSize - acMinContentSize;
          const flexFactorB = boxB.minContentSize;
          const flexFactorAc = acMinContentSize;
          let flexFactorSum = flexFactorB + flexFactorAc;
          if (flexFactorSum === 0) flexFactorSum = 1;
          boxB.outer = boxB.minContentSize + (flexSpace * flexFactorB) / flexFactorSum;
        }
      }
    }
    if (boxA.inner === 'auto') boxA.outer = (availableSize - boxB.outer) / 2;
    if (boxC.inner === 'auto') boxC.outer = (availableSize - boxB.outer) / 2;
  }

  // And, we're done! Set the actual attributes back.
  if (sideBoxes.some((b) => b.inner === 'auto')) throw new Error('auto remaining');
  for (const box of sideBoxes) box.restoreBoxAttributes();
}

/** Drop 'pages' counter from style in @page and @margin context; ensure `counter-increment: page` for @page. */
export function standardizePageBasedCounters(style: any, pseudoType: string | null): void {
  let pageCounterTouched = false;
  for (const propname of ['counter_set', 'counter_reset', 'counter_increment']) {
    if (style.get(propname) === 'auto') {
      style.set(propname, []);
      continue;
    }
    const justified: Array<[string, number]> = [];
    for (const [name, value] of style.get(propname) as Array<[string, number]>) {
      if (name === 'page') pageCounterTouched = true;
      if (name !== 'pages') justified.push([name, value]);
    }
    style.set(propname, justified);
  }
  if (pseudoType === null && !pageCounterTouched) style.set('counter_increment', [['page', 1], ...style.get('counter_increment')]);
}

/** Yield laid-out margin boxes for this page; ``state`` is the up-to-date page-state from page_maker. */
export function* makeMarginBoxes(context: any, page: AnyBox, state: build.BuildState): Generator<AnyBox> {
  /** Return a margin box with resolved percentages (it may still have 'auto' values). */
  const makeBox = (atKeyword: string, containingBlock: [number, number]): AnyBox => {
    let style = context.styleFor.has(page.pageType, atKeyword) ? context.styleFor.get(page.pageType, atKeyword) : null;
    if (style === null) {
      // doesn't affect counters
      style = page.style.anonymousStyle;
    }
    standardizePageBasedCounters(style, atKeyword);
    let box: AnyBox = new boxes.MarginBox(atKeyword, style);
    // Empty boxes should not be generated, but they may be needed for the layout of their neighbors.
    // TODO: should be the computed value.
    box.isGenerated = !['normal', 'inhibit', 'none'].includes(style.get('content'));
    // TODO: get actual counter values at the time of the last page break
    if (box.isGenerated) {
      // @margins mustn't manipulate page-context counters.
      const marginState: build.BuildState = structuredClone(state);
      const { quoteDepth, counterValues, counterScopes } = marginState;
      // TODO: check this, probably useless
      counterScopes.push(new Set());
      build.updateCounters(marginState, box.style);
      box.children = build.contentToBoxes(
        box.style, box, quoteDepth, counterValues, context.getImageFromUri, context.targetCollector, context.counterStyle, context, page);
      box.processWhitespace();
      box.processTextTransform();
      box = build.createAnonymousBoxes(box);
    }
    resolvePercentages(box, containingBlock);
    if (!box.isGenerated) {
      box.width = box.height = 0;
      for (const side of ['top', 'right', 'bottom', 'left']) box.resetSpacing(side);
    }
    return box;
  };

  const marginTop = page.marginTop;
  const marginBottom = page.marginBottom;
  const marginLeft = page.marginLeft;
  const marginRight = page.marginRight;
  const maxBoxWidth = page.borderWidth();
  const maxBoxHeight = page.borderHeight();

  // bottom right corner of the border box
  const pageEndX = marginLeft + maxBoxWidth;
  const pageEndY = marginTop + maxBoxHeight;

  // Margin box dimensions, described in https://drafts.csswg.org/css-page-3/#margin-box-dimensions
  const generatedBoxes: AnyBox[] = [];

  const sides: Array<[string, boolean, [number, number], number, number]> = [
    ['top', false, [maxBoxWidth, marginTop], marginLeft, 0],
    ['bottom', false, [maxBoxWidth, marginBottom], marginLeft, pageEndY],
    ['left', true, [marginLeft, maxBoxHeight], 0, marginTop],
    ['right', true, [marginRight, maxBoxHeight], pageEndX, marginTop],
  ];
  for (const [prefix, vertical, containingBlock, positionX, positionY] of sides) {
    let suffixes: string[];
    let fixedOuter: number;
    let variableOuter: number;
    if (vertical) {
      suffixes = ['top', 'middle', 'bottom'];
      [fixedOuter, variableOuter] = containingBlock;
    } else {
      suffixes = ['left', 'center', 'right'];
      [variableOuter, fixedOuter] = containingBlock;
    }
    const sideBoxes = suffixes.map((suffix) => makeBox(`@${prefix}-${suffix}`, containingBlock));
    if (!sideBoxes.some((b) => b.isGenerated)) continue;
    // We need the three boxes together for the variable dimension.
    computeVariableDimension(context, sideBoxes, vertical, variableOuter);
    [0, 0.5, 1].forEach((offset, k) => {
      const box = sideBoxes[k];
      if (!box.isGenerated) return;
      box.positionX = positionX;
      box.positionY = positionY;
      if (vertical) box.positionY += offset * (variableOuter - box.marginHeight());
      else box.positionX += offset * (variableOuter - box.marginWidth());
      computeFixedDimension(context, box, fixedOuter, !vertical, prefix === 'top' || prefix === 'left');
      generatedBoxes.push(box);
    });
  }

  // Corner boxes
  const corners: Array<[string, number, number, number, number]> = [
    ['@top-left-corner', marginLeft, marginTop, 0, 0],
    ['@top-right-corner', marginRight, marginTop, pageEndX, 0],
    ['@bottom-left-corner', marginLeft, marginBottom, 0, pageEndY],
    ['@bottom-right-corner', marginRight, marginBottom, pageEndX, pageEndY],
  ];
  for (const [atKeyword, cbWidth, cbHeight, positionX, positionY] of corners) {
    const box = makeBox(atKeyword, [cbWidth, cbHeight]);
    if (!box.isGenerated) continue;
    box.positionX = positionX;
    box.positionY = positionY;
    computeFixedDimension(context, box, cbHeight, true, atKeyword.includes('top'));
    computeFixedDimension(context, box, cbWidth, false, atKeyword.includes('left'));
    generatedBoxes.push(box);
  }

  for (const box of generatedBoxes) yield marginBoxContentLayout(context, page, box);
}

/** Layout a margin box's content once the box has dimensions. */
export function marginBoxContentLayout(context: any, _page: AnyBox, boxIn: AnyBox): AnyBox {
  const positionedBoxes: AnyBox[] = [];
  const [box, resumeAt] = blockContainerLayout(
    context, boxIn, -Infinity, null, true, positionedBoxes, positionedBoxes, null, null, null, false, null);
  if (resumeAt !== null) throw new Error('margin box must not be fragmented');
  for (const absoluteBox of positionedBoxes) absoluteLayout(context, absoluteBox, box, positionedBoxes, 0, null);

  const verticalAlign = box.style.get('vertical_align');
  // Every other value is read as 'top', ie. no change.
  if ((verticalAlign === 'middle' || verticalAlign === 'bottom') && box.children.length) {
    const firstChild = box.children[0];
    const lastChild = box.children[box.children.length - 1];
    const top = firstChild.positionY;
    const bottom = lastChild.positionY + lastChild.marginHeight();
    const contentHeight = bottom - top;
    let offset = box.height - contentHeight;
    if (verticalAlign === 'middle') offset /= 2;
    for (const child of box.children) child.translate(0, offset);
  }
  return box;
}

/**
 * Take a OrientedBox and set either width, margin-left and margin-right; or height, margin-top and
 * margin-bottom (https://drafts.csswg.org/css-page-3/#page-box-page-rule).
 */
export function pageWidthOrHeight(box: OrientedBox, containingBlockSize: number): void {
  const remaining = containingBlockSize - box.paddingPlusBorder;
  if (box.inner === 'auto') {
    if (box.marginA === 'auto') box.marginA = 0;
    if (box.marginB === 'auto') box.marginB = 0;
    box.inner = remaining - box.marginA - box.marginB;
  } else if (box.marginA === 'auto' && box.marginB === 'auto') {
    box.marginA = box.marginB = (remaining - box.inner) / 2;
  } else if (box.marginA === 'auto') box.marginA = remaining - box.inner - box.marginB;
  else if (box.marginB === 'auto') box.marginB = remaining - box.inner - box.marginA;
  box.restoreBoxAttributes();
}

export const pageWidth = handleMinMaxWidth((box: AnyBox, context: any, containingBlockWidth: number) => {
  pageWidthOrHeight(new HorizontalBox(context, box), containingBlockWidth);
});

export const pageHeight = handleMinMaxHeight((box: AnyBox, context: any, containingBlockHeight: number) => {
  pageWidthOrHeight(new VerticalBox(context, box), containingBlockHeight);
});

const deepEqual = (a: any, b: any): boolean => {
  if (a === b) return true;
  if (a instanceof Map && b instanceof Map) {
    return a.size === b.size && [...a].every(([k, v]) => b.has(k) && deepEqual(v, b.get(k)));
  }
  if (a instanceof Set && b instanceof Set) return a.size === b.size && [...a].every((v) => b.has(v));
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
};

/**
 * Take just enough content from the beginning to fill one page. Returns ``[page, resumeAt, nextPage]``:
 * ``page`` is a laid out PageBox, ``resumeAt`` indicates where in the document to start the next page,
 * or is null if this was the last page.
 */
export function makePage(
  context: any, rootBoxIn: AnyBox, pageType: PageType, resumeAtIn: SkipStack, pageNumber: number, pageState: build.BuildState,
): [AnyBox, SkipStack, any] {
  let rootBox = rootBoxIn;
  let resumeAt = resumeAtIn;
  const style = context.styleFor.get(pageType);

  // Propagated from the root or <body>.
  style.set('overflow', rootBox.viewportOverflow);
  const page = new boxes.PageBox(pageType, style);

  const deviceSize: [number, number] = page.style.get('size');

  resolvePercentages(page, deviceSize);

  page.positionX = 0;
  page.positionY = 0;
  const [cbWidth, cbHeight] = deviceSize;
  pageWidth(page, context, cbWidth);
  pageHeight(page, context, cbHeight);

  if (pageNumber === 1) {
    context.styleFor.initialPageSizes.box = deviceSize;
    context.styleFor.initialPageSizes.area = [page.width, page.height];
  }

  context.pageBottom = page.contentBoxY() + page.height;
  const initialContainingBlock = page;

  let footnoteAreaStyle = context.styleFor.has(pageType, '@footnote') ? context.styleFor.get(pageType, '@footnote') : null;
  if (footnoteAreaStyle === null) footnoteAreaStyle = style.anonymousStyle;
  let footnoteArea: AnyBox = new boxes.FootnoteAreaBox(page, footnoteAreaStyle);
  resolvePercentages(footnoteArea, page);
  footnoteArea.positionX = page.contentBoxX();
  footnoteArea.positionY = context.pageBottom;

  let previousResumeAt: SkipStack = null;
  if (pageType.blank) {
    previousResumeAt = resumeAt;
    rootBox = rootBox.copyWithChildren([]);
  }

  // https://www.w3.org/TR/css-display-4/#root
  if (!rootBox.isBlockLevel) throw new Error('root box must be block-level');
  context.createBlockFormattingContext();
  context.currentPage = pageNumber;
  context.currentPageFootnotes = [];
  context.currentFootnoteArea = footnoteArea;

  const reportedFootnotes: AnyBox[] = context.reportedFootnotes;
  context.reportedFootnotes = [];
  for (let i = 0; i < reportedFootnotes.length; i++) {
    const reportedFootnote = reportedFootnotes[i];
    context.footnotes.push(reportedFootnote);
    const overflow = context.layoutFootnote(reportedFootnote);
    if (overflow && i !== 0) {
      context.reportFootnote(reportedFootnote);
      context.reportedFootnotes = reportedFootnotes.slice(i);
      break;
    }
  }

  let pageIsEmpty = true;
  let adjoiningMargins: number[] = [];
  let positionedBoxes: AnyBox[] = []; // Mixed absolute and fixed
  let noteAreaStyle = context.styleFor.has(pageType, '@note-area') ? context.styleFor.get(pageType, '@note-area') : null;
  if (noteAreaStyle === null) noteAreaStyle = style.anonymousStyle;
  let noteArea: AnyBox = build.blockify(build.makeBox('@note-area', noteAreaStyle, [], null));
  noteArea.positionX = page.contentBoxX();
  noteArea.positionY = page.contentBoxY();
  const { quoteDepth, counterValues } = pageState;
  if (noteArea.style.get('content') !== 'normal') {
    noteArea.children = build.contentToBoxes(
      noteArea.style, noteArea, quoteDepth, counterValues, context.getImageFromUri, context.targetCollector, context.counterStyle, context, page);
    noteArea = build.createAnonymousBoxes(noteArea);
  }

  rootBox.positionX = page.contentBoxX();
  rootBox.positionY = page.contentBoxY();
  if (noteArea.isInNormalFlow()) {
    [noteArea] = blockLevelLayout(context, noteArea, 0, null, initialContainingBlock, pageIsEmpty, positionedBoxes, positionedBoxes, adjoiningMargins);
    if (noteArea.children.length) rootBox.positionY = noteArea.positionY + noteArea.marginHeight();
  } else if (noteArea.isFloated()) {
    [noteArea] = floatLayout(context, noteArea, initialContainingBlock, positionedBoxes, positionedBoxes, 0, null);
    if (noteArea.children.length) context.excludedShapesByRoot.set(rootBox, noteArea);
  } else {
    [noteArea] = absoluteBoxLayout(context, noteArea, page, positionedBoxes, 0, null);
  }

  // Display out-of-flow boxes broken on the previous page.
  // TODO: we shouldn't separate broken in-flow and out-of-flow layout.
  pageIsEmpty = true;
  adjoiningMargins = [];
  positionedBoxes = []; // Mixed absolute and fixed
  const outOfFlowBoxes: AnyBox[] = [];
  const excludedShapes = new Map<any, AnyBox[]>();
  const brokenOutOfFlow = new Map<any, any>();
  const contextOutOfFlow: Array<[AnyBox, AnyBox, AnyBox, SkipStack]> = [...context.brokenOutOfFlow.values()];
  context.brokenOutOfFlow = brokenOutOfFlow;
  for (const [box, containingBlock, contextBox, skipStack] of contextOutOfFlow) {
    if (contextBox) context.createBlockFormattingContext(contextBox);
    box.positionY = rootBox.contentBoxY();
    let outOfFlowBox: AnyBox;
    let outOfFlowResumeAt: SkipStack;
    if (box.isFloated()) {
      [outOfFlowBox, outOfFlowResumeAt] = floatLayout(context, box, containingBlock, positionedBoxes, positionedBoxes, 0, skipStack);
      if (!excludedShapes.has(contextBox)) excludedShapes.set(contextBox, []);
      excludedShapes.get(contextBox)!.push(outOfFlowBox);
    } else {
      if (!box.isAbsolutelyPositioned()) throw new Error('expected an absolutely positioned box');
      [outOfFlowBox, outOfFlowResumeAt] = absoluteBoxLayout(context, box, containingBlock, positionedBoxes, 0, skipStack);
    }
    outOfFlowBoxes.push(outOfFlowBox);
    pageIsEmpty = false;
    if (outOfFlowResumeAt) context.addBrokenOutOfFlow(outOfFlowBox, box, containingBlock, outOfFlowResumeAt);
    if (contextBox) context.finishBlockFormattingContext();
  }

  // Set excluded shapes from broken out-of-flow for in-flow content.
  for (const [contextBox, shapes] of excludedShapes) context.excludedShapesByRoot.set(contextBox, shapes);

  // Display in-flow content.
  let initialRootBox = rootBox;
  const initialResumeAt = resumeAt;
  const previousRunningElements = new Map<string, AnyBox[] | undefined>();
  for (const [name, byPage] of context.runningElements) previousRunningElements.set(name, byPage.get(pageNumber));
  for (const byPage of context.runningElements.values()) byPage.delete(pageNumber);
  const notes: AnyBox[] = [];
  for (const elements of previousRunningElements.values()) for (const element of elements ?? []) if (element.isNote()) notes.push(element);
  context.renderedNotes.push(...notes);
  let nextPage: any;
  [rootBox, resumeAt, nextPage] = blockLevelLayout(
    context, rootBox, 0, resumeAt, initialContainingBlock, pageIsEmpty, positionedBoxes, positionedBoxes, adjoiningMargins) as any;
  if (!rootBox) {
    // In-flow page rendering didn't progress, only out-of-flow did. Render empty box at skip_stack and
    // force fragmentation to make the root box and its descendants cover the whole page height.
    if (pageIsEmpty) throw new Error('expected a non-empty page');
    let box: AnyBox;
    let parent: AnyBox;
    box = parent = initialRootBox = initialRootBox.deepcopy();
    let skipStack: SkipStack = initialResumeAt;
    while (skipStack && Object.keys(skipStack).length === 1) {
      let skip: number;
      [skip, skipStack] = skipItem(skipStack);
      // Python's box.children[skip] raises IndexError when the index is out of range (the oracle fails here).
      if (!box || !box.children || skip >= box.children.length) throw new Error('list index out of range');
      [box, parent] = [box.children[skip], box];
    }
    parent.children = [];
    parent.forceFragmentation = true;
    [rootBox] = blockLevelLayout(
      context, initialRootBox, 0, initialResumeAt, initialContainingBlock, true, positionedBoxes, positionedBoxes, adjoiningMargins) as any;
    resumeAt = initialResumeAt;
  }
  rootBox.children = [...outOfFlowBoxes, ...rootBox.children];
  const runningElements = new Map<string, AnyBox[] | undefined>();
  for (const [name, byPage] of context.runningElements) runningElements.set(name, byPage.get(pageNumber));
  if (!deepEqual(previousRunningElements, runningElements)) {
    for (const [name, previousRunnings] of previousRunningElements) {
      const runnings = runningElements.get(name);
      if (runnings && runnings.length) {
        if (previousRunnings === undefined || previousRunnings.length > runnings.length) {
          const remakeState = context.pageMaker[pageNumber - 1][4];
          remakeState.contentChanged = true;
        }
      }
    }
  }

  footnoteArea = build.createAnonymousBoxes(footnoteArea.deepcopy());
  [footnoteArea] = blockLevelLayout(
    context, footnoteArea, -Infinity, null, footnoteArea.page, true, positionedBoxes, positionedBoxes) as any;
  footnoteArea.translate(0, -footnoteArea.marginHeight());

  page.fixedBoxes = positionedBoxes.map((p) => p._box).filter((b) => b.style.get('position') === 'fixed');
  for (const absoluteBox of positionedBoxes) absoluteLayout(context, absoluteBox, page, positionedBoxes, 0, null);

  context.finishBlockFormattingContext();

  page.children = [rootBox, footnoteArea, noteArea];

  // Update page counter values
  standardizePageBasedCounters(style, null);
  build.updateCounters(pageState, style);
  const pageCounterValues = pageState.counterValues;
  // page_counter_values will be cached in the page_maker

  const targetCollector = context.targetCollector;
  const pageMaker = context.pageMaker;

  // remake_state tells the make_all_pages-loop in layout_document() whether and what to re-make.
  const remakeState = pageMaker[pageNumber - 1][4];

  // Evaluate and cache page values only once (for the first LineBox) otherwise we suffer endless
  // loops when the target/pseudo-element spans across multiple pages.
  const cachedAnchors: string[] = [];
  const cachedLookups: any[] = [];
  for (const entry of pageMaker.slice(0, pageNumber - 1)) {
    const xRemake = entry[4];
    cachedAnchors.push(...(xRemake.anchors ?? []));
    cachedLookups.push(...(xRemake.contentLookups ?? []));
  }

  for (const child of page.descendants(true)) {
    // Cache target's page counters.
    const anchor = child.style.get('anchor');
    if (anchor && !cachedAnchors.includes(anchor)) {
      remakeState.anchors.push(anchor);
      cachedAnchors.push(anchor);
      // Re-make of affected targeting boxes is inclusive.
      targetCollector.cacheTargetPageCounters(anchor, Object.fromEntries(pageCounterValues), pageNumber - 1, pageMaker);
    }

    // string-set and bookmark-labels don't create boxes, only `content` requires another call to
    // make_page. There is maximum one 'content' item per box.
    let counterLookup: any = null;
    if (child.missingLink) counterLookup = targetCollector.counterLookupItems.get(child.missingLink)?.get('content') ?? null;

    // Resolve missing (page based) counters.
    if (counterLookup !== null) {
      let callParseAgain = false;

      // Prevent endless loops.
      const refreshMissingCounters = !cachedLookups.includes(counterLookup);
      if (refreshMissingCounters) {
        remakeState.contentLookups.push(counterLookup);
        cachedLookups.push(counterLookup);
        counterLookup.pageMakerIndex = pageNumber - 1;
      }

      // Step 1: page based back-references. Marked as pending by target_collector.cache_target_page_counters.
      const pcv = Object.fromEntries(pageCounterValues);
      if (counterLookup.pending) {
        if (!deepEqual(pcv, counterLookup.cachedPageCounterValues)) counterLookup.cachedPageCounterValues = structuredClone(pcv);
        counterLookup.pending = false;
        callParseAgain = true;
      }

      // Step 2: local counters. If the box mixed-in page counters changed, update the content and cache the new values.
      const missingCounters: string[] = counterLookup.missingCounters;
      if (missingCounters.length) {
        if (missingCounters.includes('pages')) remakeState.pagesWanted = true;
        if (refreshMissingCounters && !deepEqual(pcv, counterLookup.cachedPageCounterValues)) {
          counterLookup.cachedPageCounterValues = structuredClone(pcv);
          for (const counterName of missingCounters) {
            if (pcv[counterName] !== undefined) {
              callParseAgain = true;
              break; // no need to loop them all
            }
          }
        }
      }

      // Step 3: targeted counters.
      for (const [anchorName, missedCounters] of Object.entries(counterLookup.missingTargetCounters as Record<string, string[]>)) {
        if (!missedCounters.includes('pages')) continue;
        // Adjust 'pages_wanted'.
        const item = targetCollector.targetLookupItems.get(anchorName);
        const pageMakerIndex = item.pageMakerIndex;
        if (pageMakerIndex >= 0 && cachedAnchors.includes(anchorName)) pageMaker[pageMakerIndex][4].pagesWanted = true;
        // 'content_changed' is triggered in targets.cache_target_page_counters()
      }

      if (callParseAgain) {
        remakeState.contentChanged = true;
        counterLookup.parseAgain(new Map(Object.entries(pcv)));
      }
    }
  }

  if (pageType.blank) {
    resumeAt = previousResumeAt;
    nextPage = pageMaker[pageNumber - 1][1];
  }
  return [page, resumeAt, nextPage];
}

/** Set style for page types and pseudo-types matching ``pageType``. */
export function setPageTypeComputedStyles(pageType: PageType, html: any, styleFor: any): void {
  styleFor.addPageDeclarations(pageType);

  // Apply style for page. @page inherits from the root element:
  // https://lists.w3.org/Archives/Public/www-style/2012Jan/1164.html
  styleFor.setComputedStyles(pageType, html.root, null);

  // Apply style for page pseudo-elements (margin boxes).
  for (const [element, pseudoType] of styleFor.cascadedKeys()) {
    if (pseudoType && element === pageType) {
      // The pseudo-element inherits from the element.
      styleFor.setComputedStyles(element, element, pseudoType);
    }
  }
}

function includesResumeAt(resumeAt: SkipStack, pageGroupResumeAt: SkipStack): boolean {
  if (!pageGroupResumeAt || !Object.keys(pageGroupResumeAt).length) return true;
  const [pageChildIndex, pageChildResumeAt] = skipItem(pageGroupResumeAt);
  if (resumeAt === null || !(pageChildIndex in resumeAt)) return false;
  if (pageChildResumeAt === null) return true;
  return includesResumeAt(resumeAt[pageChildIndex], pageChildResumeAt);
}

function updatePageGroups(pageGroups: any[][], resumeAt: SkipStack, nextPage: any, rootBox: AnyBox, blank: boolean): any {
  // https://www.w3.org/TR/css-gcpm-3/#document-sequence-selectors

  // Remove or increment page groups.
  const original = [...pageGroups];
  const removed: any[] = [];
  original.forEach((pageGroup) => {
    if (includesResumeAt(resumeAt, pageGroup[2])) pageGroup[1] += 1;
    else removed.push(pageGroup);
  });
  for (const r of removed) pageGroups.splice(pageGroups.indexOf(r), 1);

  // Add page groups.
  if (!blank) {
    if ((resumeAt && nextPage.break === 'any') || !nextPage.page) {
      // We don't have a forced page break or a named page.
      return nextPage.page;
    }
    if (pageGroups.length && pageGroups[pageGroups.length - 1][0] === nextPage.page) {
      // We're already in an element whose page name is the next page name.
      return nextPage.page;
    }
  }

  // Find the box that has the named page. It is a first in-flow child of the element corresponding to resume_at.

  // Find element corresponding to resume_at.
  const pageGroupResumeAt: Record<number, any> = structuredClone(resumeAt) ?? { 0: null };
  let currentResumeAt = pageGroupResumeAt;
  let currentElement = rootBox;
  let parentElement = rootBox;
  let childIndex: number;
  for (;;) {
    const entries = Object.entries(currentResumeAt);
    const [k, childResumeAt] = entries[entries.length - 1];
    childIndex = Number(k);
    parentElement = currentElement;
    currentElement = currentElement.children[childIndex];
    if (childResumeAt === null) break;
    currentResumeAt = childResumeAt;
  }

  if (blank) {
    // Page is blank, don't create a new page group and return parent's page name.
    return parentElement.style.get('page');
  }

  // Find the descendant with named page.
  for (;;) {
    if (currentElement.style.get('page') === nextPage.page) {
      pageGroups.push([nextPage.page, 0, pageGroupResumeAt]);
      return nextPage.page;
    }
    if (!(currentElement instanceof boxes.ParentBox)) return nextPage.page; // Shouldn't happen.
    let found = false;
    for (let i = 0; i < currentElement.children.length; i++) {
      const child = currentElement.children[i];
      if (!child.isInNormalFlow()) continue;
      currentResumeAt[childIndex] = { [i]: null };
      currentResumeAt = currentResumeAt[childIndex];
      childIndex = i;
      currentElement = child;
      found = true;
      break;
    }
    if (!found) return nextPage.page; // Shouldn't happen.
  }
}

/**
 * Return one laid out page without margin boxes, starting with the initial values from
 * ``context.pageMaker[index]``. The resulting values for the next page are stored in the page maker.
 */
export function remakePage(index: number, context: any, rootBox: AnyBox, html: any): [AnyBox, SkipStack] {
  const pageMaker = context.pageMaker;
  let [resumeAt, nextPage, rightPage, pageState] = pageMaker[index];

  // PageType for current page, values for page_maker[index + 1]. Don't modify actual page_maker[index] values!
  pageState = structuredClone(pageState);
  let nextPageSide: string | null;
  if (nextPage.break === 'left' || nextPage.break === 'right') nextPageSide = nextPage.break;
  else if (nextPage.break === 'recto' || nextPage.break === 'verso') {
    const directionLtr = rootBox.style.get('direction') === 'ltr';
    const breakVerso = nextPage.break === 'verso';
    nextPageSide = directionLtr !== breakVerso ? 'right' : 'left';
  } else nextPageSide = null;
  const blank = Boolean(
    (nextPageSide === 'left' && rightPage) || (nextPageSide === 'right' && !rightPage) ||
    (context.reportedFootnotes.length && resumeAt === null));
  const side = rightPage ? 'right' : 'left';
  const pageGroups = pageState.pageGroups;
  const name = updatePageGroups(pageGroups, resumeAt, nextPage, rootBox, blank);
  const groups: Array<[string, number]> = pageGroups.map(([n, i]: any[]) => [n, i]);
  const pageType: PageType = { side, blank, name, index, groups };
  setPageTypeComputedStyles(pageType, html, context.styleFor);

  context.forcedBreak = nextPage.break !== 'any' || Boolean(nextPage.page);

  // make_page wants a page_number of index + 1
  const pageNumber = index + 1;
  let page: AnyBox;
  [page, resumeAt, nextPage] = makePage(context, rootBox, pageType, resumeAt, pageNumber, pageState);
  if (!nextPage) throw new Error('missing next page');
  rightPage = !rightPage;

  // Check whether we need to append or update the next page_maker item.
  let pageMakerNextChanged: boolean;
  if (index + 1 >= pageMaker.length) {
    // New page
    pageMakerNextChanged = true;
  } else {
    // Check whether something changed.
    const [nextResumeAt, nextNextPage, nextRightPage, nextPageState] = pageMaker[index + 1];
    pageMakerNextChanged = !deepEqual(nextResumeAt, resumeAt) || !deepEqual(nextNextPage, nextPage) ||
      nextRightPage !== rightPage || !deepEqual(nextPageState, pageState);
  }

  if (pageMakerNextChanged) {
    // Reset remake_state.
    const remakeState: any = { contentChanged: false, pagesWanted: false, anchors: [], contentLookups: [] };
    // Setting content_changed to True ensures remake. If resume_at is None (last page) it must be False
    // to prevent endless loops and list index out of range (see #794).
    remakeState.contentChanged = resumeAt !== null;
    const item = [resumeAt, nextPage, rightPage, pageState, remakeState];
    if (index + 1 >= pageMaker.length) pageMaker.push(item);
    else pageMaker[index + 1] = item;
  }
  return [page, resumeAt];
}

/** Return a list of laid out pages without margin boxes, re-making pages only if necessary. */
export function* makeAllPages(context: any, rootBox: AnyBox, html: any, pages: AnyBox[]): Generator<AnyBox> {
  let i = 0;
  let reportedFootnotes: AnyBox[] | null = null;
  context.renderedNotes = [];
  for (;;) {
    const remakeState = context.pageMaker[i][4];
    let resumeAt: SkipStack;
    if (pages.length === 0 || remakeState.contentChanged || remakeState.pagesWanted) {
      LOGGER.debug(`Step 5 - Creating layout - Page ${i + 1}`);
      // Reset remake_state.
      remakeState.contentChanged = false;
      remakeState.pagesWanted = false;
      remakeState.anchors = [];
      remakeState.contentLookups = [];
      let page: AnyBox;
      [page, resumeAt] = remakePage(i, context, rootBox, html);
      reportedFootnotes = context.reportedFootnotes;
      yield page;
    } else {
      resumeAt = context.pageMaker[i + 1][0];
      reportedFootnotes = null;
      yield pages[i];
    }

    i += 1;
    if (resumeAt === null && !(reportedFootnotes && reportedFootnotes.length)) {
      // Throw away obsolete pages and content.
      context.pageMaker = context.pageMaker.slice(0, i + 1);
      context.brokenOutOfFlow.clear();
      context.reportedFootnotes.length = 0;
      return;
    }
  }
}