// SPDX-License-Identifier: BSD-3-Clause

/**
 * Turn an element tree with style into a "before layout" box tree
 * (mirrors weasyprint/formatting_structure/build.py).
 *
 * This includes creating anonymous boxes and processing whitespace as necessary.
 */
import type { CounterStyle } from '../css/counters.ts';
import type { StyleFor } from '../css/index.ts';
import { INITIAL_VALUES, TABLE_WRAPPER_BOX_PROPERTIES } from '../css/properties.ts';
import type { Style } from '../css/style.ts';
import { anchorNameFromToken } from '../css/targets.ts';
import type { TargetCollector } from '../css/targets.ts';
import type { Element } from '../dom.ts';
import { handleElement } from '../html.ts';
import type { GetImage } from '../html.ts';
import { LOGGER } from '../logger.ts';
import { getLangQuotes } from '../text/constants.ts';
import * as boxes from './boxes.ts';
import type { Box } from './boxes.ts';

type AnyBox = any;

/** Late-bound hook for collapse_table_borders (layout/table.py), set by the layout module. */
export const layoutHooks = {
  collapseTableBorders: (_table: AnyBox, _gridWidth: number, _gridHeight: number): any => {
    throw new Error('layout/table not loaded');
  },
};

const BOX_TYPE_FROM_DISPLAY: Record<string, new (...args: any[]) => AnyBox> = {
  'block flow': boxes.BlockBox,
  'inline flow': boxes.InlineBox,
  'block flow-root': boxes.BlockBox,
  'inline flow-root': boxes.InlineBlockBox,
  'block table': boxes.TableBox,
  'inline table': boxes.InlineTableBox,
  'block flex': boxes.FlexBox,
  'inline flex': boxes.InlineFlexBox,
  'block grid': boxes.GridBox,
  'inline grid': boxes.InlineGridBox,
  'table-row': boxes.TableRowBox,
  'table-row-group': boxes.TableRowGroupBox,
  'table-header-group': boxes.TableRowGroupBox,
  'table-footer-group': boxes.TableRowGroupBox,
  'table-column': boxes.TableColumnBox,
  'table-column-group': boxes.TableColumnGroupBox,
  'table-cell': boxes.TableCellBox,
  'table-caption': boxes.TableCaptionBox,
};

export type StyleForFn = (element: any, pseudoType?: string | null) => Style | null;

/** Shared mutable state while building: quote depth, counters, counter scopes, page groups. */
export interface BuildState {
  quoteDepth: number[];
  counterValues: Map<string, number[]>;
  counterScopes: Array<Set<string>>;
  pageGroups: any[];
}

export function createAnonymousBoxes(box: AnyBox): AnyBox {
  box = anonymousTableBoxes(box);
  box = flexBoxes(box);
  box = gridBoxes(box);
  box = inlineInBlock(box);
  box = blockInInline(box);
  return box;
}

export function buildFormattingStructure(
  elementTree: Element, styleFor: StyleForFn, getImageFromUri: GetImage, baseUrl: string | null,
  targetCollector: TargetCollector, counterStyle: CounterStyle, footnotes: AnyBox[],
): AnyBox {
  let boxList = elementToBox(elementTree, styleFor, getImageFromUri, baseUrl, targetCollector, counterStyle, footnotes);
  let box: AnyBox;
  if (boxList.length) [box] = boxList;
  else {
    // No root element.
    const rootStyleFor: StyleForFn = (element, pseudoType = null) => {
      const style = styleFor(element, pseudoType);
      if (style !== null) {
        if (element === elementTree) style.set('display', ['block', 'flow']);
        else style.set('display', ['none']);
      }
      return style;
    };
    boxList = elementToBox(elementTree, rootStyleFor, getImageFromUri, baseUrl, targetCollector, counterStyle, footnotes);
    [box] = boxList;
  }
  targetCollector.checkPendingTargets();
  box.processWhitespace();
  box.processTextTransform();
  box.isForRootElement = true;
  box = createAnonymousBoxes(box);
  box = setViewportOverflow(box);
  return box;
}

export function makeBox(elementTag: string, style: Style, content: AnyBox[], element: Element | null): AnyBox {
  const key = (style.get('display') as string[]).slice(0, 2).join(' ');
  const Type = BOX_TYPE_FROM_DISPLAY[key];
  if (!Type) throw new Error(`No box type for display ${key}`);
  return new Type(elementTag, style, element, content);
}

const displayIsNone = (style: Style): boolean => {
  const d = style.get('display') as string[];
  return d.length === 1 && d[0] === 'none';
};

/**
 * Convert an element and its children into a box with children. Returns a list
 * of boxes: most of the time one item, but may have zero or more than one.
 */
export function elementToBox(
  element: Element, styleFor: StyleForFn, getImageFromUri: GetImage, baseUrl: string | null,
  targetCollector: TargetCollector, counterStyle: CounterStyle, footnotes: AnyBox[], state: BuildState | null = null,
): AnyBox[] {
  if (element.isComment) return [];
  const style = styleFor(element)!;
  if (displayIsNone(style)) return [];

  if (style.get('float') === 'footnote') {
    if (style.get('footnote_display') === 'block') style.set('display', ['block', 'flow']);
    else style.set('display', ['inline', 'flow']);
  }

  const box = makeBox(element.tag, style, [], element);
  box.firstLetterStyle = styleFor(element, 'first-letter');
  box.firstLineStyle = styleFor(element, 'first-line');

  if (state === null) {
    state = {
      quoteDepth: [0],
      counterValues: new Map([['footnote', [0]], ['note', [0]]]),
      counterScopes: [new Set(['footnote', 'note'])],
      pageGroups: [],
    };
  }
  const { quoteDepth, counterValues, counterScopes } = state;

  updateCounters(state, style);

  const children: AnyBox[] = [];

  // If this element's direct children create new scopes, the counter names will be in this new set.
  counterScopes.push(new Set());

  let markerBoxes: AnyBox[] = [];
  if ((style.get('display') as string[]).includes('list-item')) {
    markerBoxes = markerToBox(element, state, style, styleFor, getImageFromUri, targetCollector, counterStyle);
    children.push(...markerBoxes);
  }

  children.push(...beforeAfterToBox(element, 'before', state, styleFor, getImageFromUri, targetCollector, counterStyle));

  // Collect the anchor's counter values, maybe it's a target.
  if (style.get('anchor')) targetCollector.storeTarget(style.get('anchor'), counterValues, box);

  const text = element.text;
  if (text) children.push(boxes.TextBox.anonymousFrom(box, text));

  for (const childElement of element.children) {
    let childBoxes = elementToBox(childElement, styleFor, getImageFromUri, baseUrl, targetCollector, counterStyle, footnotes, state);

    if (childBoxes.length && childBoxes[0].style.get('float') === 'footnote') {
      const footnote = childBoxes[0];
      footnote.style = footnote.style.copy();
      footnote.style.set('float', 'none');
      footnotes.push(footnote);
      const callStyle = styleFor(footnote.element, 'footnote-call')!;
      const footnoteCall = makeBox(`${footnote.element.tag}::footnote-call`, callStyle, [], footnote.element);
      footnoteCall.children = contentToBoxes(callStyle, footnoteCall, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle);
      footnoteCall.footnote = footnote;
      childBoxes = [footnoteCall];
    }
    if (childBoxes.length && childBoxes[0].isNote()) {
      const note = childBoxes[0];
      note.style = note.style.copy();
      const callStyle = styleFor(note.element, 'note-call')!;
      const noteCall = makeBox(`${note.element.tag}::note-call`, callStyle, [], note.element);
      noteCall.children = contentToBoxes(callStyle, noteCall, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle);
      note.noteCall = noteCall;
      noteCall.note = note;
      childBoxes = [noteCall, note];
    }

    children.push(...childBoxes);
    const tail = childElement.tail;
    if (tail) {
      const textBox = boxes.TextBox.anonymousFrom(box, tail);
      const last = children[children.length - 1];
      if (children.length && last instanceof boxes.TextBox) last.text += textBox.text;
      else children.push(textBox);
    }
  }

  children.push(...beforeAfterToBox(element, 'after', state, styleFor, getImageFromUri, targetCollector, counterStyle));

  // Scopes created by this element's children stop here.
  for (const name of counterScopes.pop()!) {
    const values = counterValues.get(name)!;
    values.pop();
    if (!values.length) counterValues.delete(name);
  }

  box.children = children;
  setContentLists(element, box, style, counterValues, targetCollector, counterStyle);

  if (markerBoxes.length && box.children.length === 1) {
    // See https://www.w3.org/TR/css-lists-3/#list-style-position-outside: add a
    // zero-width space to have a minimum height.
    if (style.get('list_style_position') === 'outside') box.children.push(boxes.TextBox.anonymousFrom(box, '​'));
  }

  if (style.get('float') === 'footnote') {
    counterValues.get('footnote')![counterValues.get('footnote')!.length - 1] += 1;
    const markerStyle = styleFor(element, 'footnote-marker')!;
    const marker = makeBox(`${element.tag}::footnote-marker`, markerStyle, [], element);
    marker.children = contentToBoxes(markerStyle, marker, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle);
    box.children.unshift(marker);
  } else if ((style.get('position') as any)[0] === 'note()') {
    counterValues.get('note')![counterValues.get('note')!.length - 1] += 1;
    const markerStyle = styleFor(element, 'note-marker')!;
    const marker = makeBox(`${element.tag}::note-marker`, markerStyle, [], element);
    marker.children = contentToBoxes(markerStyle, marker, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle);
    box.children.unshift(marker);
    const callbackStyle = styleFor(element, 'note-callback')!;
    const callback = makeBox(`${element.tag}::note-callback`, callbackStyle, [], element);
    callback.children = contentToBoxes(callbackStyle, callback, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle);
    box.children.push(callback);
    box.noteCallback = callback;
  }

  // Specific handling for the element (e.g. replaced elements).
  return handleElement(element, box, getImageFromUri, baseUrl);
}

/** Return the boxes for ::before or ::after pseudo-element. */
export function beforeAfterToBox(
  element: Element, pseudoType: string, state: BuildState, styleFor: StyleForFn, getImageFromUri: GetImage,
  targetCollector: TargetCollector, counterStyle: CounterStyle,
): AnyBox[] {
  const style = styleFor(element, pseudoType);
  // Pseudo-elements with no style at all do not get a style dict: their content computes to 'none'.
  if (pseudoType && style === null) return [];
  const display = style!.get('display') as string[];
  if (display.length === 1 && display[0] === 'none') return [];
  const content = style!.get('content');
  if (content === 'normal' || content === 'inhibit' || content === 'none') return [];
  const box = makeBox(`${element.tag}::${pseudoType}`, style!, [], element);

  const { quoteDepth, counterValues } = state;
  updateCounters(state, style!);

  const children: AnyBox[] = [];
  if (display.includes('list-item')) {
    children.push(...markerToBox(element, state, style!, styleFor, getImageFromUri, targetCollector, counterStyle));
  }
  children.push(...contentToBoxes(style!, box, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle));
  box.children = children;

  // Calculate the bookmark-label.
  if (style!.get('bookmark_level') !== 'none') {
    computeBookmarkLabel(element, box, style!.get('bookmark_label'), counterValues, targetCollector, counterStyle);
  }
  return [box];
}

/** Return the box for ::marker pseudo-element if there is one (https://drafts.csswg.org/css-lists-3/#marker-pseudo). */
export function markerToBox(
  element: Element, state: BuildState, parentStyle: Style, styleFor: StyleForFn, getImageFromUri: GetImage,
  targetCollector: TargetCollector, counterStyle: CounterStyle,
): AnyBox[] {
  let style = styleFor(element, 'marker');
  if (style === null) style = parentStyle.anonymousStyle;

  const children: AnyBox[] = [];
  const { quoteDepth, counterValues } = state;
  let box = makeBox(`${element.tag}::marker`, style, children, element);

  if (displayIsNone(style)) return [];

  const [imageType, imageUrl] = style.get('list_style_image');
  const content = style.get('content');
  if (content !== 'normal' && content !== 'inhibit') {
    children.push(...contentToBoxes(style, box, quoteDepth, counterValues, getImageFromUri, targetCollector, counterStyle));
  } else {
    if (imageType === 'url') {
      // image may be null here too, in case the image is not available.
      const image = getImageFromUri({ url: imageUrl, orientation: style.get('image_orientation') });
      if (image !== null) {
        box = boxes.InlineReplacedBox.anonymousFrom(box, image);
        children.push(box);
      }
    }
    if (!children.length && style.get('list_style_type') !== 'none') {
      const counterValue = (counterValues.get('list-item') ?? [0]).slice(-1)[0];
      const counterType = style.get('list_style_type');
      const markerText = counterStyle.renderMarker(counterType, counterValue);
      if (markerText) {
        box = boxes.TextBox.anonymousFrom(box, markerText);
        box.style.set('white_space', 'pre-wrap');
        children.push(box);
      }
    }
  }
  if (!children.length) return [];

  let markerBox: AnyBox;
  if (parentStyle.get('list_style_position') === 'outside') {
    markerBox = boxes.BlockBox.anonymousFrom(box, children);
    // We can safely edit everything that can't be changed by user style.
    markerBox.style.set('position', 'absolute');
    markerBox.isOutsideMarker = true;
  } else markerBox = boxes.InlineBox.anonymousFrom(box, children);
  return [markerBox];
}

/** Compute and return the boxes corresponding to the ``contentList``. */
export function computeContentList(
  contentList: any[], parentBox: AnyBox, counterValues: Map<string, number[]>, cssToken: string,
  parseAgain: (mixin?: any) => void, targetCollector: TargetCollector, counterStyle: CounterStyle,
  getImageFromUri: GetImage | null = null, quoteDepth: number[] | null = null, quoteStyle: any = null,
  lang: string | null = null, context: any = null, page: any = null, _element: Element | null = null,
): AnyBox[] | null {
  const contentBoxes: AnyBox[] = [];
  let hasText = false;

  const addText = (text: string): void => {
    hasText = true;
    if (text) {
      const last = contentBoxes[contentBoxes.length - 1];
      if (contentBoxes.length && last instanceof boxes.TextBox) last.text += text;
      else contentBoxes.push(boxes.TextBox.anonymousFrom(parentBox, text));
    }
  };

  let missingCounters: string[] = [];
  const missingTargetCounters: Record<string, string[]> = {};
  const inPageContext = context !== null && page !== null;
  const needCollectMissing = targetCollector.collecting && !inPageContext;

  if (parentBox.cachedCounterValues === null) {
    parentBox.cachedCounterValues = new Map([...counterValues].map(([k, v]) => [k, v.slice()]));
  }
  outer: for (const [type, value] of contentList) {
    switch (type) {
      case 'string':
        addText(value);
        break;
      case 'url': {
        if (getImageFromUri === null) break;
        const [origin, uri] = value;
        // Embedding internal references is impossible.
        if (origin !== 'external') break;
        const image = getImageFromUri({ url: uri, orientation: parentBox.style.get('image_orientation') });
        if (image !== null) contentBoxes.push(boxes.InlineReplacedBox.anonymousFrom(parentBox, image));
        break;
      }
      case 'attr()': {
        const [attrName, attrType] = value;
        if (attrType === 'string') addText(parentBox.element.get(attrName, ''));
        else LOGGER.warning(`Only strings are allowed for content attr() functions, not ${attrType}`);
        break;
      }
      case 'content()':
        addText(parentBox.extractText(value));
        break;
      case 'string()':
        if (!inPageContext) {
          LOGGER.warning(`"string(${value.join(' ')})" is only allowed in page margins`);
          break;
        }
        addText(context.getStringSetFor(page, ...value).join(''));
        break;
      case 'counter()':
      case 'counters()': {
        const counterName = value[0];
        const counterType = value[value.length - 1];
        if (counterType === 'none') break;
        if (needCollectMissing && !counterValues.has(counterName) && !missingCounters.includes(counterName)) {
          missingCounters.push(counterName);
        }
        let text: string;
        if (type === 'counter()') {
          const cv = (counterValues.get(counterName) ?? [0]).slice(-1)[0];
          text = counterStyle.renderValue(cv, counterType);
        } else {
          const separator = value[1];
          text = (counterValues.get(counterName) ?? [0]).map((cv) => counterStyle.renderValue(cv, counterType)).join(separator);
        }
        addText(text);
        break;
      }
      case 'target-counter()':
      case 'target-counters()': {
        const [anchorToken, counterName] = value;
        const counterType = value[value.length - 1];
        if (counterType === 'none') break;
        const lookup = targetCollector.lookupTarget(anchorToken, parentBox, cssToken, parseAgain);
        if (lookup.state !== 'up-to-date') break outer;
        const targetValues = lookup.targetBox.cachedCounterValues as Map<string, number[]>;
        if (needCollectMissing && !targetValues.has(counterName)) {
          const anchorName = anchorNameFromToken(anchorToken) as string;
          missingCounters = missingTargetCounters[anchorName] ??= [];
          if (!missingCounters.includes(counterName)) missingCounters.push(counterName);
        }
        const local = new Map<string, number[]>(Object.entries(lookup.cachedPageCounterValues));
        for (const [k, v] of targetValues) local.set(k, v);
        let text: string;
        if (type === 'target-counter()') {
          const cv = (local.get(counterName) ?? [0]).slice(-1)[0];
          text = counterStyle.renderValue(cv, counterType);
        } else {
          const separator = value[2];
          if (separator[0] !== 'string') break outer;
          text = (local.get(counterName) ?? [0]).map((cv) => counterStyle.renderValue(cv, counterType)).join(separator[1]);
        }
        addText(text);
        break;
      }
      case 'target-text()': {
        const [anchorToken, textStyle] = value;
        const lookup = targetCollector.lookupTarget(anchorToken, parentBox, cssToken, parseAgain);
        if (lookup.state === 'up-to-date') addText(lookup.targetBox.extractText(textStyle));
        else break outer;
        break;
      }
      case 'quote': {
        if (quoteDepth === null || quoteStyle === null) break;
        const isOpen = value.includes('open');
        const insert = !value.startsWith('no-') && quoteStyle !== 'none';
        if (!isOpen) quoteDepth[0] = Math.max(0, quoteDepth[0] - 1);
        if (insert) {
          let openQuotes: string[];
          let closeQuotes: string[];
          if (quoteStyle === 'auto') [openQuotes, closeQuotes] = getLangQuotes(lang);
          else [openQuotes, closeQuotes] = quoteStyle;
          const quotes = isOpen ? openQuotes : closeQuotes;
          addText(quotes[Math.min(quoteDepth[0], quotes.length - 1)]);
        }
        if (isOpen) quoteDepth[0] += 1;
        break;
      }
      case 'element()': {
        if (!inPageContext) {
          LOGGER.warning(`"element(${value.join(' ')})" is only allowed in page margins`);
          break;
        }
        for (let newBox of context.getRunningElementFor(page, ...value)) {
          newBox = newBox.deepcopy();
          newBox.style = newBox.style.copy();
          newBox.style.set('position', 'relative');
          if (value[1] !== 'all-once') {
            for (const child of newBox.descendants()) {
              const c = child.style.get('content');
              if (c === 'normal' || c === 'none') continue;
              child.children = contentToBoxes(child.style, child, quoteDepth!, counterValues, getImageFromUri!, targetCollector, counterStyle, context, page);
            }
          }
          contentBoxes.push(newBox);
        }
        break;
      }
      case 'leader()': {
        if (!value[1]) break;
        const textBox = boxes.TextBox.anonymousFrom(parentBox, value[1]);
        const leaderBox = boxes.InlineBox.anonymousFrom(parentBox, [textBox]);
        // Avoid breaks inside the leader box.
        leaderBox.style.set('white_space', 'pre');
        // Prevent whitespaces from being removed from the text box.
        textBox.style.set('white_space', 'pre');
        leaderBox.isLeader = true;
        contentBoxes.push(leaderBox);
        break;
      }
      default:
        break;
    }
  }
  if (hasText || contentBoxes.length) {
    // Only add a CounterLookupItem if the content list actually produced text.
    targetCollector.collectMissingCounters(parentBox, cssToken, parseAgain, missingCounters, missingTargetCounters);
    return contentBoxes;
  }
  return null;
}

/** Take the value of a ``content`` property and return boxes. */
export function contentToBoxes(
  style: Style, parentBox: AnyBox, quoteDepth: number[], counterValues: Map<string, number[]>,
  getImageFromUri: GetImage, targetCollector: TargetCollector, counterStyle: CounterStyle,
  context: any = null, page: any = null,
): AnyBox[] {
  const origQuoteDepth = quoteDepth.slice();
  const parseAgain = (mixinPagebasedCounters: Map<string, number[]> | null = null): void => {
    const local = new Map<string, number[]>(mixinPagebasedCounters ?? []);
    for (const [k, v] of parentBox.cachedCounterValues) local.set(k, v);
    const localChildren = contentToBoxes(style, parentBox, origQuoteDepth, local, getImageFromUri, targetCollector, counterStyle);
    if (parentBox.children.length === 1 && parentBox.children[0] instanceof boxes.LineBox) {
      parentBox.children[0].children = localChildren;
    } else parentBox.children = localChildren;
  };
  if (style.get('content') === 'inhibit') return [];
  const boxList = computeContentList(
    style.get('content'), parentBox, counterValues, 'content', parseAgain, targetCollector, counterStyle,
    getImageFromUri, quoteDepth, style.get('quotes'), style.get('lang'), context, page);
  return boxList ?? [];
}

/** Parse the content-list value of ``stringName`` for ``string-set``. */
export function computeStringSet(
  element: Element, box: AnyBox, stringName: string, contentList: any[], counterValues: Map<string, number[]>,
  targetCollector: TargetCollector, counterStyle: CounterStyle,
): void {
  const parseAgain = (mixin: Map<string, number[]> | null = null): void => {
    const local = new Map<string, number[]>(mixin ?? []);
    for (const [k, v] of box.cachedCounterValues) local.set(k, v);
    computeStringSet(element, box, stringName, contentList, local, targetCollector, counterStyle);
  };
  const boxList = computeContentList(
    contentList, box, counterValues, `string-set::${stringName}`, parseAgain, targetCollector, counterStyle,
    null, null, null, null, null, null, element);
  if (boxList !== null) {
    const str = boxList.filter((b) => b instanceof boxes.TextBox).map((b) => b.text).join('');
    // Avoid duplicates, care for parse_again and missing counters, don't change the pointer.
    for (const tuple of box.stringSet) {
      if (tuple[0] === stringName) {
        box.stringSet.splice(box.stringSet.indexOf(tuple), 1);
        break;
      }
    }
    box.stringSet.push([stringName, str]);
  }
}

export function computeBookmarkLabel(
  element: Element, box: AnyBox, contentList: any[], counterValues: Map<string, number[]>,
  targetCollector: TargetCollector, counterStyle: CounterStyle,
): void {
  const parseAgain = (mixin: Map<string, number[]> | null = null): void => {
    const local = new Map<string, number[]>(mixin ?? []);
    for (const [k, v] of box.cachedCounterValues) local.set(k, v);
    computeBookmarkLabel(element, box, contentList, local, targetCollector, counterStyle);
  };
  const boxList = computeContentList(
    contentList, box, counterValues, 'bookmark-label', parseAgain, targetCollector, counterStyle,
    null, null, null, null, null, null, element);
  if (boxList && boxList.length) box.bookmarkLabel = boxList.map((b) => b.contentText).join('');
}

/** Set the content-lists values used in GCPM properties like ``string-set`` and ``bookmark-label``. */
export function setContentLists(
  element: Element, box: AnyBox, style: Style, counterValues: Map<string, number[]>,
  targetCollector: TargetCollector, counterStyle: CounterStyle,
): void {
  box.stringSet = [];
  if (style.get('string_set') !== 'none') {
    for (const [stringName, stringValues] of style.get('string_set')) {
      computeStringSet(element, box, stringName, stringValues, counterValues, targetCollector, counterStyle);
    }
  }
  if (style.get('bookmark_level') !== 'none') {
    computeBookmarkLabel(element, box, style.get('bookmark_label'), counterValues, targetCollector, counterStyle);
  }
}

/** Handle the ``counter-*`` properties. */
export function updateCounters(state: BuildState, style: Style): void {
  const { counterValues, counterScopes } = state;
  const siblingScopes = counterScopes[counterScopes.length - 1];

  for (const [name, value] of style.get('counter_reset') as Array<[string, number]>) {
    if (siblingScopes.has(name)) counterValues.get(name)!.pop();
    else siblingScopes.add(name);
    if (!counterValues.has(name)) counterValues.set(name, []);
    counterValues.get(name)!.push(value);
  }

  for (const [name, value] of style.get('counter_set') as Array<[string, number]>) {
    if (!counterValues.has(name)) counterValues.set(name, []);
    const values = counterValues.get(name)!;
    if (!values.length) {
      siblingScopes.add(name);
      values.push(0);
    }
    values[values.length - 1] = value;
  }

  let counterIncrement = style.get('counter_increment');
  if (counterIncrement === 'auto') {
    // 'auto' is the initial value but is not valid in a stylesheet: there was no
    // counter-increment declaration for this element.
    counterIncrement = (style.get('display') as string[]).includes('list-item') ? [['list-item', 1]] : [];
  }
  for (const [name, value] of counterIncrement as Array<[string, number]>) {
    if (!counterValues.has(name)) counterValues.set(name, []);
    const values = counterValues.get(name)!;
    if (!values.length) {
      siblingScopes.add(name);
      values.push(0);
    }
    values[values.length - 1] += value;
  }
}

type Ctor = new (...args: any[]) => AnyBox;

/** Wrap consecutive children that do not pass ``test`` in a ``wrapperType`` box. */
export function wrapImproper(box: AnyBox, children: AnyBox[], wrapperType: Ctor, test: ((c: AnyBox) => boolean) | null = null): AnyBox[] {
  const isProper = test ?? ((child: AnyBox) => child instanceof wrapperType);
  const out: AnyBox[] = [];
  let improper: AnyBox[] = [];
  for (const child of children) {
    if (isProper(child)) {
      if (improper.length) {
        const wrapper = (wrapperType as any).anonymousFrom(box, []);
        // Apply the rules again on the new wrapper.
        out.push(tableBoxesChildren(wrapper, improper));
        improper = [];
      }
      out.push(child);
    } else improper.push(child);
  }
  if (improper.length) {
    const wrapper = (wrapperType as any).anonymousFrom(box, []);
    out.push(tableBoxesChildren(wrapper, improper));
  }
  return out;
}

/** Remove and add boxes according to the table model (https://www.w3.org/TR/CSS21/tables.html#anonymous-boxes). */
export function anonymousTableBoxes(box: AnyBox): AnyBox {
  if (!box.isParent || box.isRunning()) return box;
  const children = box.children.map((c: AnyBox) => anonymousTableBoxes(c));
  return tableBoxesChildren(box, children);
}

const properParents = (child: AnyBox): Ctor[] => {
  if (child instanceof boxes.TableRowGroupBox) return [boxes.TableBox, boxes.InlineTableBox];
  if (child instanceof boxes.TableRowBox) return [boxes.TableBox, boxes.InlineTableBox, boxes.TableRowGroupBox];
  if (child instanceof boxes.TableColumnGroupBox) return [boxes.TableBox, boxes.InlineTableBox];
  if (child instanceof boxes.TableColumnBox) return [boxes.TableBox, boxes.InlineTableBox, boxes.TableColumnGroupBox];
  if (child instanceof boxes.TableCaptionBox) return [boxes.TableBox, boxes.InlineTableBox];
  return [];
};

export function tableBoxesChildren(box: AnyBox, childrenIn: AnyBox[]): AnyBox {
  let children = childrenIn;
  if (box instanceof boxes.TableColumnBox) {
    // rule 1.1: remove all children.
    children = [];
  } else if (box instanceof boxes.TableColumnGroupBox) {
    // rule 1.2: remove children other than table-column.
    children = children.filter((c) => c instanceof boxes.TableColumnBox);
    // Rule XXX (not in the spec): column groups have at least one column child.
    if (!children.length) {
      const span = box.span === null || box.span < 1 ? 1 : box.span;
      children = Array.from({ length: span }, () => boxes.TableColumnBox.anonymousFrom(box, []));
    }
  }

  // rule 1.3
  if (box.tabularContainer && children.length >= 2) {
    const [internal, text] = children.slice(-2);
    if (internal.internalTableOrCaption && text.isWhitespace()) children.pop();
    if (children.length >= 2) {
      const [text2, internal2] = children.slice(0, 2);
      if (internal2.internalTableOrCaption && text2.isWhitespace()) children.shift();
    }
  }

  // rule 1.4: ignore some whitespace.
  children = children.filter((child, i) => {
    const prev = children[i - 1];
    const next = children[i + 1];
    return !(prev && prev.internalTableOrCaption && next && next.internalTableOrCaption && child.isWhitespace());
  });

  if (box instanceof boxes.TableBox) {
    // Rule 2.1
    children = wrapImproper(box, children, boxes.TableRowBox, (c) => c.properTableChild);
  } else if (box instanceof boxes.TableRowGroupBox) {
    // Rule 2.2
    children = wrapImproper(box, children, boxes.TableRowBox);
  }

  if (box instanceof boxes.TableRowBox) {
    // Rule 2.3
    children = wrapImproper(box, children, boxes.TableCellBox);
  } else {
    // Rule 3.1
    children = wrapImproper(box, children, boxes.TableRowBox, (c) => !(c instanceof boxes.TableCellBox));
  }

  // Rule 3.2
  if (box instanceof boxes.InlineBox) {
    children = wrapImproper(box, children, boxes.InlineTableBox, (c) => !c.properTableChild);
  } else {
    const parentType = box.constructor as Ctor;
    children = wrapImproper(box, children, boxes.TableBox, (c) => !c.properTableChild || properParents(c).includes(parentType));
  }

  if (box instanceof boxes.TableBox) return wrapTable(box, children);
  box.children = [...children];
  return box;
}

/**
 * Take a table box and return it in its table wrapper box. Also re-order
 * children and assign grid positions to each column and cell.
 */
export function wrapTable(box: AnyBox, children: AnyBox[]): AnyBox {
  const columns: AnyBox[] = [];
  const rows: AnyBox[] = [];
  const allCaptions: AnyBox[] = [];
  for (const child of children) {
    const ctor = child.constructor;
    if (ctor === boxes.TableColumnBox || ctor === boxes.TableColumnGroupBox) columns.push(child);
    else if (ctor === boxes.TableRowBox || ctor === boxes.TableRowGroupBox) rows.push(child);
    else if (ctor === boxes.TableCaptionBox) allCaptions.push(child);
    else throw new Error(`Unexpected table child ${ctor.name}`);
  }

  const captions: Record<string, AnyBox[]> = { top: [], bottom: [] };
  for (const caption of allCaptions) captions[caption.style.get('caption_side')].push(caption);

  // Assign X positions on the grid to column boxes.
  const columnGroups = wrapImproper(box, columns, boxes.TableColumnGroupBox);
  let gridX = 0;
  for (const group of columnGroups) {
    group.gridX = gridX;
    if (group.children.length) {
      for (const column of group.children) {
        // No need to take care of the group's span: "span=x" already generates x TableColumnBox children.
        column.gridX = gridX;
        gridX += 1;
      }
    } else gridX += group.span;
  }
  let gridWidth = gridX;

  let rowGroups = wrapImproper(box, rows, boxes.TableRowGroupBox);
  // Extract the optional header and footer groups.
  const bodyRowGroups: AnyBox[] = [];
  let header: AnyBox = null;
  let footer: AnyBox = null;
  for (const group of rowGroups) {
    const display = group.style.get('display') as string[];
    if (display.length === 1 && display[0] === 'table-header-group' && header === null) {
      group.isHeader = true;
      header = group;
    } else if (display.length === 1 && display[0] === 'table-footer-group' && footer === null) {
      group.isFooter = true;
      footer = group;
    } else bodyRowGroups.push(group);
  }
  rowGroups = [...(header !== null ? [header] : []), ...bodyRowGroups, ...(footer !== null ? [footer] : [])];

  // Assign an (x, y) position in the grid to each cell. rowspan can not extend
  // beyond a row group, so each row group is independent.
  let gridHeight = 0;
  for (const group of rowGroups) {
    // Indexes: row number in the group. Values: cells already occupied by row-spanning cells.
    const occupiedCellsByRow: Array<Set<number>> = group.children.map(() => new Set<number>());
    for (const row of group.children) {
      const occupiedInThisRow = occupiedCellsByRow.shift()!;
      gridX = 0;
      for (const cell of row.children) {
        while (occupiedInThisRow.has(gridX)) gridX += 1;
        cell.gridX = gridX;
        const newGridX = gridX + cell.colspan;
        if (cell.rowspan !== 1) {
          const maxRowspan = occupiedCellsByRow.length + 1;
          let spannedRows: Array<Set<number>>;
          if (cell.rowspan === 0) {
            // All rows until the end of the group.
            spannedRows = occupiedCellsByRow;
            cell.rowspan = maxRowspan;
          } else {
            cell.rowspan = Math.min(cell.rowspan, maxRowspan);
            spannedRows = occupiedCellsByRow.slice(0, cell.rowspan - 1);
          }
          for (const occupied of spannedRows) for (let x = gridX; x < newGridX; x++) occupied.add(x);
        }
        gridX = newGridX;
        gridWidth = Math.max(gridWidth, gridX);
      }
    }
    gridHeight += group.children.length;
  }

  const table = box.copyWithChildren(rowGroups);
  table.style = table.style.copy();
  table.columnGroups = [...columnGroups];
  if (table.style.get('border_collapse') === 'collapse') {
    table.collapsedBorderGrid = layoutHooks.collapseTableBorders(table, gridWidth, gridHeight);
  }

  const WrapperType = box instanceof boxes.InlineTableBox ? boxes.InlineBlockBox : boxes.BlockBox;
  const wrapper = (WrapperType as any).anonymousFrom(box, [...captions.top, table, ...captions.bottom]);
  wrapper.style = wrapper.style.copy();
  wrapper.isTableWrapper = true;
  // Non-inherited properties of the table element apply to one of the wrapper
  // and the table. The other gets the initial value.
  for (const name of TABLE_WRAPPER_BOX_PROPERTIES) {
    wrapper.style.set(name, table.style.get(name));
    table.style.set(name, INITIAL_VALUES[name]);
  }
  return wrapper;
}

/** Turn an inline box into a block box (https://drafts.csswg.org/css-display-4/#blockify). */
export function blockify(box: AnyBox, layout: string | null = null): AnyBox {
  let anonymous: AnyBox;
  if (box instanceof boxes.InlineBlockBox) {
    anonymous = boxes.BlockBox.anonymousFrom(box, box.children);
    if (box.isTableWrapper) anonymous.isTableWrapper = true;
  } else if (box instanceof boxes.InlineReplacedBox) {
    anonymous = boxes.BlockReplacedBox.anonymousFrom(box, box.replacement);
  } else if (box instanceof boxes.TextBox) {
    anonymous = boxes.BlockBox.anonymousFrom(box, [box]);
    if (layout) box[`is${cap(layout)}Item`] = false;
  } else if (box instanceof boxes.InlineFlexBox) {
    anonymous = boxes.FlexBox.anonymousFrom(box, box.children);
  } else if (box instanceof boxes.InlineGridBox) {
    anonymous = boxes.GridBox.anonymousFrom(box, box.children);
  } else if (box.isInlineLevel) {
    anonymous = boxes.BlockBox.anonymousFrom(box, box.children);
  } else return box;
  anonymous.style = box.style;
  if (layout) anonymous[`is${cap(layout)}Item`] = true;
  return anonymous;
}
const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

/** Remove and add boxes according to the flex model (https://www.w3.org/TR/css-flexbox-1/#flex-items). */
export function flexBoxes(box: AnyBox): AnyBox {
  if (!box.isParent || box.isRunning()) return box;
  const children = box.children.map((c: AnyBox) => flexBoxes(c));
  box.children = flexChildren(box, children);
  return box;
}

function flexChildren(box: AnyBox, children: AnyBox[]): AnyBox[] {
  if (box instanceof boxes.FlexContainerBox) {
    const out: AnyBox[] = [];
    for (const child of children) {
      child.isFloated = () => false;
      if (child.isInNormalFlow()) child.isFlexItem = true;
      if (child instanceof boxes.TextBox && !child.text.replace(/^ +| +$/g, '')) continue;
      out.push(blockify(child, 'flex'));
    }
    return out;
  }
  return children;
}

/** Remove and add boxes according to the grid model (https://drafts.csswg.org/css-grid-2/#grid-item). */
export function gridBoxes(box: AnyBox): AnyBox {
  if (!box.isParent || box.isRunning()) return box;
  const children = box.children.map((c: AnyBox) => gridBoxes(c));
  box.children = gridChildren(box, children);
  return box;
}

function gridChildren(box: AnyBox, children: AnyBox[]): AnyBox[] {
  if (box instanceof boxes.GridContainerBox) {
    const out: AnyBox[] = [];
    for (const child of children) {
      if (child.isInNormalFlow()) child.isGridItem = true;
      if (child instanceof boxes.TextBox && !child.text.replace(/^ +| +$/g, '')) continue;
      out.push(blockify(child, 'grid'));
    }
    return out;
  }
  return children;
}

/**
 * Build the structure of lines inside blocks and return a new box tree.
 *
 * Consecutive inline-level boxes in a block container box are wrapped into a
 * line box, itself wrapped into an anonymous block box. This line box will be
 * broken into multiple lines later.
 */
export function inlineInBlock(box: AnyBox): AnyBox {
  if (!box.children || !box.children.length || box.isRunning() || box.isNote()) return box;

  const boxChildren = [...box.children];

  if (boxChildren.length && box.leadingCollapsibleSpace === false) {
    box.leadingCollapsibleSpace = boxChildren[0].leadingCollapsibleSpace;
  }

  const children: AnyBox[] = [];
  let trailingCollapsibleSpace = false;
  for (const child of boxChildren) {
    // Keep track of removed collapsing spaces for wrap opportunities, and remove
    // empty text boxes (they may have been emptied by process_whitespace()).
    if (trailingCollapsibleSpace) child.leadingCollapsibleSpace = true;
    if (child instanceof boxes.TextBox && !child.text) {
      trailingCollapsibleSpace = child.leadingCollapsibleSpace;
    } else {
      trailingCollapsibleSpace = false;
      children.push(inlineInBlock(child));
    }
  }
  if (box.trailingCollapsibleSpace === false) box.trailingCollapsibleSpace = trailingCollapsibleSpace;

  if (!box.isBlockContainer) {
    box.children = children;
    return box;
  }

  let newLineChildren: AnyBox[] = [];
  const newChildren: AnyBox[] = [];

  for (const childBox of children) {
    if (newLineChildren.length && childBox.isAbsolutelyPositioned()) {
      newLineChildren.push(childBox);
    } else if (childBox.isInlineLevel || (newLineChildren.length && !childBox.isInNormalFlow())) {
      // Do not append white space at the start of a line: it would be removed during layout.
      if (newLineChildren.length || !(
        childBox instanceof boxes.TextBox &&
        // Sequence of white-space was collapsed to a single space by process_whitespace().
        childBox.text === ' ' && ['normal', 'nowrap', 'pre-line'].includes(childBox.style.get('white_space')))) {
        newLineChildren.push(childBox);
      }
    } else {
      if (newLineChildren.length) {
        // Inlines are consecutive no more: add this line box and create a new one.
        const lineBox = boxes.LineBox.anonymousFrom(box, newLineChildren);
        newChildren.push(boxes.BlockBox.anonymousFrom(box, [lineBox]));
        newLineChildren = [];
      }
      newChildren.push(childBox);
    }
  }
  if (newLineChildren.length) {
    // There were inlines at the end.
    const lineBox = boxes.LineBox.anonymousFrom(box, newLineChildren);
    if (newChildren.length) newChildren.push(boxes.BlockBox.anonymousFrom(box, [lineBox]));
    else newChildren.push(lineBox); // Only inline-level children: one line box.
  }

  box.children = newChildren;
  return box;
}

/**
 * Build the structure of blocks inside lines.
 *
 * Inline boxes containing block-level boxes will be broken in two boxes on each
 * side of consecutive block-level boxes, each side wrapped in an anonymous
 * block-level box (https://www.w3.org/TR/CSS21/visuren.html#anonymous-block-level).
 */
export function blockInInline(box: AnyBox): AnyBox {
  if (!box.children || !box.children.length || box.isRunning() || box.isNote()) return box;

  const newChildren: AnyBox[] = [];
  let changed = false;

  for (const child of box.children) {
    let newChild: AnyBox;
    if (child instanceof boxes.LineBox) {
      if (box.children.length !== 1) throw new Error('Line boxes should have no siblings at this stage');
      let stack: Record<number, any> | null = null;
      let newLine: AnyBox;
      for (;;) {
        let block: AnyBox;
        [newLine, block, stack] = innerBlockInInline(child, stack);
        if (block === null) break;
        const anon = boxes.BlockBox.anonymousFrom(box, [newLine]);
        newChildren.push(anon);
        newChildren.push(blockInInline(block));
        // Loop with the same child and the new stack.
      }
      if (newChildren.length) {
        // Some children were already added, this became a block context.
        newChild = boxes.BlockBox.anonymousFrom(box, [newLine!]);
      } else {
        // Keep the single line box as-is, without anonymous blocks.
        newChild = newLine!;
      }
    } else {
      // Not in an inline formatting context.
      newChild = blockInInline(child);
    }
    if (newChild !== child) changed = true;
    newChildren.push(newChild);
  }
  if (changed) box.children = newChildren;
  return box;
}

/**
 * Find a block-level box in an inline formatting context.
 *
 * If one is found, return ``[newBox, blockLevelBox, resumeAt]``; ``newBox``
 * contains all of ``box`` content before the block-level box. ``resumeAt`` can
 * be passed as ``skipStack`` in a new call to resume the search just after the
 * block-level box. If none is found, return ``[newBox, null, null]``.
 */
export function innerBlockInInline(box: AnyBox, skipStackIn: Record<number, any> | null = null): [AnyBox, AnyBox | null, Record<number, any> | null] {
  const newChildren: AnyBox[] = [];
  let blockLevelBox: AnyBox = null;
  let resumeAt: Record<number, any> | null = null;
  let changed = false;
  let skipStack = skipStackIn;

  let skip = 0;
  if (skipStack !== null) {
    const [[k, v]] = Object.entries(skipStack);
    skip = Number(k);
    skipStack = v;
  }

  let completed = true;
  const list = box.children.slice(skip);
  for (let i = 0; i < list.length; i++) {
    const child = list[i];
    let index = i + skip;
    if (child.isBlockLevel && child.isInNormalFlow()) {
      blockLevelBox = child;
      index += 1; // Resume *after* the block.
    } else {
      let newChild: AnyBox;
      if (child instanceof boxes.InlineBox) {
        const recursion = innerBlockInInline(child, skipStack);
        skipStack = null;
        [newChild, blockLevelBox, resumeAt] = recursion;
      } else {
        newChild = blockInInline(child);
        // block_level_box is still null.
      }
      if (newChild !== child) changed = true;
      newChildren.push(newChild);
    }
    if (blockLevelBox !== null) {
      resumeAt = { [index]: resumeAt };
      box = box.copyWithChildren(newChildren);
      completed = false;
      break;
    }
  }
  if (completed && (changed || skip)) box = box.copyWithChildren(newChildren);
  return [box, blockLevelBox, resumeAt];
}

/**
 * Set a ``viewportOverflow`` attribute on the box for the root element. Like
 * backgrounds, ``overflow`` on the root element must be propagated to the viewport.
 */
export function setViewportOverflow(rootBox: AnyBox): AnyBox {
  // renderDocument builds again after fetching images, with the same computed styles: read the overflow each
  // style had before an earlier pass reset it to 'visible'.
  const overflowOf = (style: any): string => VIEWPORT_OVERFLOW_ORIGINAL.get(style) ?? style.get('overflow');
  let chosen: AnyBox = rootBox;
  if (rootBox.elementTag.toLowerCase() === 'html' && overflowOf(rootBox.style) === 'visible') {
    for (const child of rootBox.children) {
      if (child.elementTag.toLowerCase() === 'body') {
        chosen = child;
        break;
      }
    }
  }
  rootBox.viewportOverflow = overflowOf(chosen.style);
  if (!VIEWPORT_OVERFLOW_ORIGINAL.has(chosen.style)) VIEWPORT_OVERFLOW_ORIGINAL.set(chosen.style, chosen.style.get('overflow'));
  chosen.style.set('overflow', 'visible');
  return rootBox;
}

const VIEWPORT_OVERFLOW_ORIGINAL = new WeakMap<object, string>();

export type { Box };