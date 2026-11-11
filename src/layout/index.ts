// SPDX-License-Identifier: BSD-3-Clause

/**
 * Transform a "before layout" box tree into an "after layout" tree: break boxes across lines and
 * pages, and determine the size and dimension of each box fragment (mirrors layout/__init__.py).
 *
 * Boxes in the new tree have *used values* in their positionX, positionY, width and height attributes.
 */
import type { CounterStyle } from '../css/counters.ts';
import type { StyleFor } from '../css/index.ts';
import * as boxes from '../formatting_structure/boxes.ts';
import * as build from '../formatting_structure/build.ts';
import { getLink } from '../html.ts';
import { LOGGER } from '../logger.ts';
import { absoluteBoxLayout, absoluteLayout } from './absolute.ts';
import { layoutBackgrounds } from './background.ts';
import { blockLevelLayout } from './block.ts';
import { makeAllPages, makeMarginBoxes } from './page.ts';

type AnyBox = any;

/** Collect the pagination's states required for page based counters. */
export function initializePageMaker(context: LayoutContext, rootBox: AnyBox): void {
  context.pageMaker = [];

  // Special case the root box.
  const pageBreak = rootBox.style.get('break_before');

  // TODO: take care of text direction and writing mode https://www.w3.org/TR/css-page-3/#progression
  let rightPage: boolean;
  if (pageBreak === 'right') rightPage = true;
  else if (pageBreak === 'left') rightPage = false;
  else if (pageBreak === 'recto') rightPage = rootBox.style.get('direction') === 'ltr';
  else if (pageBreak === 'verso') rightPage = rootBox.style.get('direction') === 'rtl';
  else rightPage = rootBox.style.get('direction') === 'ltr';
  const resumeAt = null;
  const nextPage = { break: 'any', page: rootBox.pageValues()[0] };

  // page_state is prerequisite for filling in missing page based counters although neither a variable
  // quote_depth nor counter_scopes are needed in page-boxes -- reusing `updateCounters()` needs a full state.
  // The value of **pages**, of course, is unknown until we return and might change when
  // 'content_changed' triggers re-pagination... So we start with an empty state.
  const pageState: build.BuildState = {
    quoteDepth: [0],
    counterValues: new Map([['pages', [0]]]),
    counterScopes: [new Set(['pages'])],
    pageGroups: [],
  };

  // Initial values.
  const remakeState = {
    contentChanged: false,
    pagesWanted: false,
    anchors: [] as string[], // first occurrence of anchor
    contentLookups: [] as any[], // first occurrence of content-CounterLookupItem
  };
  context.pageMaker.push([resumeAt, nextPage, rightPage, pageState, remakeState]);
}

/** Lay out and yield fixed boxes of ``pages`` on ``containingPage``. */
export function* layoutFixedBoxes(context: LayoutContext, pages: AnyBox[], containingPage: AnyBox): Generator<AnyBox> {
  for (const page of pages) {
    for (let box of page.fixedBoxes) {
      // As replaced boxes are never copied during layout, ensure that we have different boxes
      // (with a possibly different layout) for each pages.
      if (box instanceof boxes.ReplacedBox) box = box.copy();
      // Absolute boxes in fixed boxes are rendered as fixed boxes' children, even when they are fixed themselves.
      let absoluteBoxes: AnyBox[] = [];
      const [absoluteBox] = absoluteBoxLayout(context, box, containingPage, absoluteBoxes, -Infinity, null);
      yield absoluteBox;
      while (absoluteBoxes.length) {
        const newAbsoluteBoxes: AnyBox[] = [];
        for (const b of absoluteBoxes) absoluteLayout(context, b, containingPage, newAbsoluteBoxes, -Infinity, null);
        absoluteBoxes = newAbsoluteBoxes;
      }
    }
  }
}

/**
 * Lay out the whole document: line breaks, page breaks, absolute size and position for all boxes.
 * Page based counters might require multiple passes. Returns a list of laid out PageBox objects.
 */
export function layoutDocument(html: any, rootBox: AnyBox, context: LayoutContext, maxLoops = 8): AnyBox[] {
  initializePageMaker(context, rootBox);
  let pages: AnyBox[] = [];
  let originalFootnotes: AnyBox[] = [];
  let actualTotalPages = 0;

  for (let loop = 0; loop < maxLoops; loop++) {
    if (loop > 0) {
      LOGGER.debug(`Step 5 - Creating layout - Repagination #${loop}`);
      context.footnotes = [...originalFootnotes];
    }

    const initialTotalPages = actualTotalPages;
    if (loop === 0) originalFootnotes = [...context.footnotes];
    pages = [...makeAllPages(context, rootBox, html, pages)];
    actualTotalPages = pages.length;

    // Check whether another round is required.
    let reloopContent = false;
    let reloopPages = false;
    for (const pageData of context.pageMaker) {
      // Update pages.
      const pageState: build.BuildState = pageData[3];
      const remakeState = pageData[4];
      pageState.counterValues.set('pages', [actualTotalPages]);
      if (remakeState.contentChanged) reloopContent = true;
      if (remakeState.pagesWanted) reloopPages = initialTotalPages !== actualTotalPages;
    }

    // No need for another loop, stop here.
    if (!reloopContent && !reloopPages) break;
  }

  // Calculate string-sets and bookmark-labels containing page based counters when pagination is
  // finished. No need to do that (maybe multiple times) in make_page because they don't create boxes,
  // only appear in MarginBoxes and in the final PDF. Prevent repetition of bookmarks (see #1145).
  const watchElements: any[] = [];
  const watchElementsBefore: any[] = [];
  const watchElementsAfter: any[] = [];
  pages.forEach((page, i) => {
    // We need the updated page_counter_values.
    const pageState: build.BuildState = context.pageMaker[i + 1][3];
    const pageCounterValues = pageState.counterValues;

    for (const child of page.descendants()) {
      // Only one bookmark per original box.
      if (child.bookmarkLabel) {
        let checklist: any[];
        if (child.elementTag.endsWith('::before')) checklist = watchElementsBefore;
        else if (child.elementTag.endsWith('::after')) checklist = watchElementsAfter;
        else checklist = watchElements;
        if (checklist.includes(child.element)) child.bookmarkLabel = '';
        else checklist.push(child.element);
      }

      if (child.missingLink) {
        for (const [box, byToken] of context.targetCollector.counterLookupItems) {
          for (const [cssToken, item] of byToken) {
            if (child.missingLink === box && cssToken !== 'content') {
              if (cssToken === 'bookmark-label' && !child.bookmarkLabel) continue; // don't refill it!
              item.parseAgain(pageCounterValues);
              // string_set is a pointer, but the bookmark_label is just a string: copy it.
              if (cssToken === 'bookmark-label') child.bookmarkLabel = box.bookmarkLabel;
            }
          }
        }
      }
      // Collect the string_sets in the LayoutContext.
      const stringSets = child.stringSet;
      if (stringSets && stringSets !== 'none') {
        for (const [stringName, text] of stringSets) context.stringSetFor(stringName, i + 1).push(text);
      }
    }
  });

  // Add margin boxes.
  pages.forEach((page, i) => {
    const rootChildren: AnyBox[] = [];
    const [root, footnoteArea, noteArea] = page.children;
    rootChildren.push(...layoutFixedBoxes(context, pages.slice(0, i), page));
    rootChildren.push(...root.children);
    rootChildren.push(...layoutFixedBoxes(context, pages.slice(i + 1), page));
    root.children = rootChildren;
    context.currentPage = i + 1; // page number starts at 1

    // page_maker's page_state is ready for the MarginBoxes.
    const state: build.BuildState = context.pageMaker[context.currentPage][3];
    const children: AnyBox[] = [root];
    if (footnoteArea.children.length) children.push(footnoteArea);
    if (noteArea.children.length) children.push(noteArea);
    children.push(...makeMarginBoxes(context, page, state));
    page.children = children;
    layoutBackgrounds(page, context.getImageFromUri);
  });
  return pages;
}

/** List in which you can't append objects. */
class FakeList<T> extends Array<T> {
  override push(..._items: T[]): number {
    return this.length;
  }
}

export class LayoutContext {
  styleFor: StyleFor;
  getImageFromUri: (o: any) => any;
  fontConfig: unknown;
  counterStyle: CounterStyle;
  targetCollector: any;
  excludedShapesRootBoxes: any[] = [];
  /** Python: ``_excluded_shapes``. */
  excludedShapesByRoot = new Map<any, any>();
  footnotes: AnyBox[] = [];
  pageFootnotes = new Map<any, any>();
  currentPageFootnotes: AnyBox[] = [];
  reportedFootnotes: AnyBox[] = [];
  renderedNotes: AnyBox[] | null = null;
  currentFootnoteArea: AnyBox = null; // Not initialized yet
  pageBottom: number | null = null;
  private stringSetStore = new Map<string, Map<number, string[]>>();
  runningElements = new Map<string, Map<number, AnyBox[]>>();
  currentPage: number | null = null;
  forcedBreak = false;
  brokenOutOfFlow = new Map<AnyBox, [AnyBox, AnyBox, any, any]>();
  inColumn = false;
  pageMaker: any[] = [];

  // Cache
  tables = new Map<any, any>();
  dictionaries = new Map<string, any>();

  constructor(styleFor: StyleFor, getImageFromUri: (o: any) => any, fontConfig: unknown, counterStyle: CounterStyle, targetCollector: any) {
    this.styleFor = styleFor;
    this.getImageFromUri = (o) => getImageFromUri(o);
    this.fontConfig = fontConfig;
    this.counterStyle = counterStyle;
    this.targetCollector = targetCollector;
  }

  /** ``string_set[name][page]`` as a list that is created on demand. */
  stringSetFor(name: string, page: number): string[] {
    let byPage = this.stringSetStore.get(name);
    if (!byPage) this.stringSetStore.set(name, (byPage = new Map()));
    let list = byPage.get(page);
    if (!list) byPage.set(page, (list = []));
    return list;
  }

  overflowsPage(bottomSpace: number, positionY: number): boolean {
    return this.overflows((this.pageBottom as number) - bottomSpace, positionY);
  }

  overflows(bottom: number, positionY: number): boolean {
    // Use a small fudge factor to avoid floating numbers errors. The 1e-9 value comes from PEP 485.
    return positionY > bottom * (1 + 1e-9);
  }

  get excludedShapes(): AnyBox[] {
    return this.excludedShapesByRoot.get(this.excludedShapesRootBoxes[this.excludedShapesRootBoxes.length - 1]);
  }
  set excludedShapes(shapes: AnyBox[]) {
    this.excludedShapesByRoot.set(this.excludedShapesRootBoxes[this.excludedShapesRootBoxes.length - 1], shapes);
  }

  createBlockFormattingContext(rootBox: AnyBox = null, newList: AnyBox[] | null = null): void {
    if (this.excludedShapesRootBoxes.includes(rootBox)) throw new Error('formatting context already created');
    this.excludedShapesRootBoxes.push(rootBox);
    if (!this.excludedShapesByRoot.has(rootBox)) this.excludedShapesByRoot.set(rootBox, newList === null ? [] : newList);
  }

  finishBlockFormattingContext(rootBox: AnyBox = null): void {
    // See https://www.w3.org/TR/CSS2/visudet.html#root-height
    if (rootBox && rootBox.style.get('height') === 'auto' && this.excludedShapes.length) {
      const boxBottom = rootBox.contentBoxY() + rootBox.height;
      const maxShapeBottom = Math.max(boxBottom, ...this.excludedShapes.map((shape: AnyBox) => shape.positionY + shape.marginHeight()));
      rootBox.height += maxShapeBottom - boxBottom;
    }
    this.excludedShapesByRoot.delete(this.excludedShapesRootBoxes.pop());
  }

  createFlexFormattingContext(rootBox: AnyBox): void {
    this.createBlockFormattingContext(rootBox, new FakeList());
  }

  finishFlexFormattingContext(rootBox: AnyBox): void {
    this.finishBlockFormattingContext(rootBox);
  }

  addBrokenOutOfFlow(newBox: AnyBox, box: AnyBox, containingBlock: AnyBox, resumeAt: any): void {
    this.brokenOutOfFlow.set(newBox, [box, containingBlock, this.excludedShapesRootBoxes[this.excludedShapesRootBoxes.length - 1], resumeAt]);
  }

  getStringSetFor(page: AnyBox, name: string, keyword = 'first'): string[] {
    return this.getStringOrElementFor(this.stringSetStore as any, page, name, keyword) as string[];
  }

  getRunningElementFor(page: AnyBox, name: string, keyword = 'first'): AnyBox[] {
    return this.getStringOrElementFor(this.runningElements as any, page, name, keyword) as AnyBox[];
  }

  /**
   * Resolve value of string or element function: value depends on the current page
   * (https://drafts.csswg.org/css-gcpm/#funcdef-string).
   */
  getStringOrElementFor(store: Map<string, Map<number, any[]>>, page: AnyBox, name: string, keyword: string): any[] {
    // Python's store is a defaultdict: looking a name up registers it, which make_page's running-element
    // comparison relies on to notice a page's first note.
    let byPage = store.get(name);
    if (!byPage) store.set(name, (byPage = new Map<number, any[]>()));
    if (byPage.has(this.currentPage as number)) {
      // A value was assigned on this page.
      const current = byPage.get(this.currentPage as number)!;
      if (keyword === 'first') return [current[0]];
      if (keyword === 'start') {
        let element = page;
        while (element) {
          if (element.style.get('string_set') !== 'none') {
            for (const [stringName] of element.style.get('string_set')) if (stringName === name) return [current[0]];
          }
          if (element.children.length) {
            element = element.children[0];
            continue;
          }
          break;
        }
      } else if (keyword === 'last') return [current[current.length - 1]];
      else if (keyword === 'first-except') return [];
      else if (keyword === 'all-once') return [...current];
    }
    // Search backwards through previous pages.
    if (keyword !== 'all-once') {
      for (let previousPage = (this.currentPage as number) - 1; previousPage > 0; previousPage--) {
        if (byPage.has(previousPage)) {
          const list = byPage.get(previousPage)!;
          return [list[list.length - 1]];
        }
      }
    }
    return [];
  }

  /** Add a running element to the list of running elements. */
  addRunningElement(box: AnyBox): void {
    const runningName = box.style.get('position')[1];
    if (box.isNote() && box.style.get('anchor') === null) {
      let index = 0;
      for (const names of this.runningElements.values()) for (const list of names.values()) index += list.length;
      box.style.set('anchor', `note-${index}`);
      box.noteCall.style.set('anchor', `call-${index}`);
      box.noteCall.link = getLink(`#note-${index}`, box.style.baseUrl);
      box.noteCallback.link = getLink(`#call-${index}`, box.style.baseUrl);
    }
    if (!(this.renderedNotes as AnyBox[]).includes(box)) {
      let byPage = this.runningElements.get(runningName);
      if (!byPage) this.runningElements.set(runningName, (byPage = new Map()));
      let list = byPage.get(this.currentPage as number);
      if (!list) byPage.set(this.currentPage as number, (list = []));
      list.push(box);
    }
  }

  /** Remove a running element from the list of running elements. */
  removeRunningElement(box: AnyBox): void {
    const runningName = box.style.get('position')[1];
    const pages = this.runningElements.get(runningName);
    const list = pages?.get(this.currentPage as number);
    if (list && list.includes(box)) list.splice(list.indexOf(box), 1);
  }

  /** Add a footnote to the layout for this page. */
  layoutFootnote(footnote: AnyBox): boolean {
    this.footnotes.splice(this.footnotes.indexOf(footnote), 1);
    this.currentPageFootnotes.push(footnote);
    return this.updateFootnoteArea();
  }

  /** Remove a footnote from the layout and return it to the waitlist. */
  unlayoutFootnote(footnote: AnyBox): void {
    // TODO: Handle unlayouting a footnote that hasn't been laid out yet or has already been unlayouted.
    if (!this.footnotes.includes(footnote)) {
      this.footnotes.push(footnote);
      if (this.currentPageFootnotes.includes(footnote)) this.currentPageFootnotes.splice(this.currentPageFootnotes.indexOf(footnote), 1);
      else if (this.reportedFootnotes.includes(footnote)) this.reportedFootnotes.splice(this.reportedFootnotes.indexOf(footnote), 1);
      this.updateFootnoteArea();
    }
  }

  /** Mark a footnote as being moved to the next page. */
  reportFootnote(footnote: AnyBox): void {
    this.currentPageFootnotes.splice(this.currentPageFootnotes.indexOf(footnote), 1);
    this.reportedFootnotes.push(footnote);
    this.updateFootnoteArea();
  }

  /** Update the page bottom size and our footnote area height. */
  private updateFootnoteArea(): boolean {
    if (this.currentFootnoteArea.height !== 'auto' && !this.inColumn) {
      (this.pageBottom as number) += this.currentFootnoteArea.marginHeight();
    }
    this.currentFootnoteArea.children = this.currentPageFootnotes;
    if (this.currentFootnoteArea.children.length) {
      const footnoteAreaCopy = build.createAnonymousBoxes(this.currentFootnoteArea.deepcopy());
      const [footnoteArea] = blockLevelLayout(this, footnoteAreaCopy, -Infinity, null, this.currentFootnoteArea.page) as any;
      this.currentFootnoteArea.height = footnoteArea.height;
      if (!this.inColumn) (this.pageBottom as number) -= footnoteArea.marginHeight();
      const lastChild = footnoteArea.children[footnoteArea.children.length - 1];
      const lastChildBottom = lastChild.positionY + lastChild.marginHeight() - lastChild.marginBottom;
      const footnoteAreaBottom = footnoteArea.positionY + footnoteArea.marginHeight() - footnoteArea.marginBottom;
      return lastChildBottom > footnoteAreaBottom;
    }
    this.currentFootnoteArea.height = 0;
    if (!this.inColumn) (this.pageBottom as number) -= this.currentFootnoteArea.marginHeight();
    return false;
  }
}