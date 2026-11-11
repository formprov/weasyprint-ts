// SPDX-License-Identifier: BSD-3-Clause

/**
 * Classes for all types of boxes in the CSS formatting structure / box model
 * (mirrors weasyprint/formatting_structure/boxes.py).
 *
 * Python uses multiple inheritance for the "outside" and "inside" display
 * behaviours (BlockLevelBox, InlineLevelBox, BlockContainerBox, ...). TypeScript
 * has single inheritance, so those are modelled as boolean traits
 * (`isBlockLevel`, `isInlineLevel`, ...) which replace `isinstance` checks.
 */
import type { Element } from '../dom.ts';
import type { Style } from '../css/style.ts';
import { LINE_FEED_RE, SPACE_RE, TAB_RE, getFirstLetter, transform } from './text.ts';

export function elementHasLinkType(element: Element, linkType: string): boolean {
  const tokens = (element.get('rel', '') ?? '').match(/[^ \t\n\f\r]+/g) ?? [];
  return tokens.some((t) => t.toLowerCase() === linkType);
}

export function parseInteger(s: string | null): number | null {
  // https://html.spec.whatwg.org/multipage/common-microsyntaxes.html#rules-for-parsing-integers
  if (s === null) return null;
  const m = /^[ \t\n\f\r]*([+-]?)(\d+)/.exec(s);
  if (!m) return null;
  const n = parseInt(m[2], 10);
  return m[1] === '-' ? -n : n;
}

export class Box {
  // Traits (replace isinstance checks on mixin classes).
  isParent = false;
  isBlockLevel = false;
  isInlineLevel = false;
  isBlockContainer = false;
  isAtomicInline = false;
  isReplaced = false;

  // Definitions for the rules generating anonymous table boxes.
  properTableChild = false;
  internalTableOrCaption = false;
  tabularContainer = false;

  // Keep track of removed collapsing spaces for wrap opportunities.
  leadingCollapsibleSpace = false;
  trailingCollapsibleSpace = false;

  // Default, may be overridden on instances.
  isTableWrapper = false;
  isFlexItem = false;
  isGridItem = false;
  isForRootElement = false;
  isColumn = false;
  isLeader = false;
  isOutsideMarker = false;

  transformationMatrix: any = null;
  bookmarkLabel: any = null;
  stringSet: any = null;
  footnote: any = null;
  note: any = null;
  noteCall: any = null;
  noteCallback: any = null;
  cachedCounterValues: any = null;
  link: any = null;
  missingLink: any = null;
  linkAnnotation: any = null;
  widgetAnnotation: any = null;
  forceFragmentation = false;
  colspan = 1;
  rowspan = 1;

  elementTag: string | null;
  element: Element | null;
  style: Style;
  removeDecorationSides = new Set<string>();
  children: any[] = [];
  firstLetterStyle: Style | null = null;
  firstLineStyle: Style | null = null;

  // Geometry, assigned during layout.
  positionX = 0;
  positionY = 0;
  width: any = 0;
  height: any = 0;
  marginTop: any = 0;
  marginRight: any = 0;
  marginBottom: any = 0;
  marginLeft: any = 0;
  paddingTop: any = 0;
  paddingRight: any = 0;
  paddingBottom: any = 0;
  paddingLeft: any = 0;
  borderTopWidth: any = 0;
  borderRightWidth: any = 0;
  borderBottomWidth: any = 0;
  borderLeftWidth: any = 0;
  [key: string]: any;

  constructor(elementTag: string | null, style: Style, element: Element | null) {
    this.elementTag = elementTag;
    this.element = element;
    this.style = style;
  }

  toString(): string {
    return `<${this.constructor.name} ${this.elementTag}>`;
  }

  /** Return an anonymous box that inherits from ``parent``. */
  static anonymousFrom<T extends Box>(this: new (...args: any[]) => T, parent: Box, ...args: any[]): T {
    return new this(parent.elementTag, parent.style.anonymousStyle, parent.element, ...args);
  }

  allChildren(): any[] {
    return this.children;
  }

  /** A flat generator for a box, its children and descendants. */
  *descendants(placeholders = false): Generator<any> {
    yield this;
    for (const child of this.children) {
      if (placeholders || child instanceof Box) yield* (child as Box).descendants(placeholders);
      else yield child;
    }
  }

  /** Shallow copy of the box. */
  copy(): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this);
    return c;
  }

  deepcopy(): this {
    return this.copy();
  }

  /** Change the box's position, also updating the children's positions. */
  translate(dx = 0, dy = 0, ignoreFloats = false): void {
    if (dx === 0 && dy === 0) return;
    this.positionX += dx;
    this.positionY += dy;
    for (const child of this.allChildren()) {
      if (!(ignoreFloats && child.isFloated())) child.translate(dx, dy, ignoreFloats);
    }
  }

  // Heights and widths
  paddingWidth(): number { return this.width + this.paddingLeft + this.paddingRight; }
  paddingHeight(): number { return this.height + this.paddingTop + this.paddingBottom; }
  borderWidth(): number { return this.paddingWidth() + this.borderLeftWidth + this.borderRightWidth; }
  borderHeight(): number { return this.paddingHeight() + this.borderTopWidth + this.borderBottomWidth; }
  marginWidth(): number { return this.borderWidth() + this.marginLeft + this.marginRight; }
  marginHeight(): number { return this.borderHeight() + this.marginTop + this.marginBottom; }

  // Corners positions
  contentBoxX(): number { return this.positionX + this.marginLeft + this.paddingLeft + this.borderLeftWidth; }
  contentBoxY(): number { return this.positionY + this.marginTop + this.paddingTop + this.borderTopWidth; }
  paddingBoxX(): number { return this.positionX + this.marginLeft + this.borderLeftWidth; }
  paddingBoxY(): number { return this.positionY + this.marginTop + this.borderTopWidth; }
  borderBoxX(): number { return this.positionX + this.marginLeft; }
  borderBoxY(): number { return this.positionY + this.marginTop; }

  /** The (x, y, w, h) rectangle where the box is clickable. */
  hitArea(): [number, number, number, number] {
    return [this.borderBoxX(), this.borderBoxY(), this.borderWidth(), this.borderHeight()];
  }

  /** Position, size and radii of a box inside the outer border box. */
  roundedBox(bt: number, br: number, bb: number, bl: number): any[] {
    const [tlrx0, tlry0] = this.borderTopLeftRadius;
    const [trrx0, trry0] = this.borderTopRightRadius;
    const [brrx0, brry0] = this.borderBottomRightRadius;
    const [blrx0, blry0] = this.borderBottomLeftRadius;
    const m = Number.MAX_SAFE_INTEGER;
    const tlrx = Math.min(Math.max(0, tlrx0 - bl), m);
    const tlry = Math.min(Math.max(0, tlry0 - bt), m);
    const trrx = Math.min(Math.max(0, trrx0 - br), m);
    const trry = Math.min(Math.max(0, trry0 - bt), m);
    const brrx = Math.min(Math.max(0, brrx0 - br), m);
    const brry = Math.min(Math.max(0, brry0 - bb), m);
    const blrx = Math.min(Math.max(0, blrx0 - bl), m);
    const blry = Math.min(Math.max(0, blry0 - bb), m);
    const x = this.borderBoxX() + bl;
    const y = this.borderBoxY() + bt;
    const width = this.borderWidth() - bl - br;
    const height = this.borderHeight() - bt - bb;
    const ratio = Math.min(1, ...([
      [width, tlrx + trrx], [width, blrx + brrx], [height, tlry + blry], [height, trry + brry],
    ] as Array<[number, number]>).filter(([, sum]) => sum > 0).map(([extent, sum]) => extent / sum));
    return [x, y, width, height, [tlrx * ratio, tlry * ratio], [trrx * ratio, trry * ratio],
      [brrx * ratio, brry * ratio], [blrx * ratio, blry * ratio]];
  }
  roundedBoxRatio(ratio: number): any[] {
    return this.roundedBox(this.borderTopWidth * ratio, this.borderRightWidth * ratio,
      this.borderBottomWidth * ratio, this.borderLeftWidth * ratio);
  }
  roundedPaddingBox(): any[] {
    return this.roundedBox(this.borderTopWidth, this.borderRightWidth, this.borderBottomWidth, this.borderLeftWidth);
  }
  roundedBorderBox(): any[] { return this.roundedBox(0, 0, 0, 0); }
  roundedContentBox(): any[] {
    return this.roundedBox(this.borderTopWidth + this.paddingTop, this.borderRightWidth + this.paddingRight,
      this.borderBottomWidth + this.paddingBottom, this.borderLeftWidth + this.paddingLeft);
  }

  // Positioning schemes
  isFloated(): boolean { return ['left', 'right', 'inline-start', 'inline-end'].includes(this.style.get('float')); }
  isFootnote(): boolean { return this.style.get('float') === 'footnote'; }
  isNote(): boolean { return this.style.get('position')[0] === 'note()'; }
  isAbsolutelyPositioned(): boolean { return ['absolute', 'fixed'].includes(this.style.get('position')); }
  isRunning(): boolean { return this.style.get('position')[0] === 'running()'; }
  isInNormalFlow(): boolean {
    return !(this.isFloated() || this.isAbsolutelyPositioned() || this.isRunning() || this.isFootnote() || this.isNote());
  }
  isMonolithic(): boolean {
    return this.isAtomicInline || this.isReplaced || ['auto', 'scroll'].includes(this.style.get('overflow')) ||
      (this.style.get('overflow') === 'hidden' && this.style.get('height') !== 'auto');
  }
  establishesFormattingContext(): boolean {
    return this.isFloated() || this.isAbsolutelyPositioned() || this.isColumn ||
      (this.isBlockContainer && !(this instanceof BlockBox)) ||
      (this instanceof BlockBox && this.style.get('overflow') !== 'visible') ||
      (this.style.get('display') as string[]).includes('flow-root');
  }

  /** Start and end page values for named pages. */
  pageValues(): [any, any] {
    return [this.style.get('page'), this.style.get('page')];
  }

  isAttachment(): boolean {
    if (this.element !== null && this.element.tag === 'a') return elementHasLinkType(this.element, 'attachment');
    return false;
  }
  isInput(): boolean {
    if (this.style.get('appearance') === 'auto' && this.element !== null) {
      if (['button', 'input', 'select', 'textarea'].includes(this.element.tag)) {
        return !(this instanceof LineBox || this instanceof TextBox);
      }
    }
    return false;
  }
  isForm(): boolean {
    return this.element !== null && this.element.tag === 'form';
  }

  get contentText(): string {
    return '';
  }

  /** First part of "The 'white-space' processing model". */
  processWhitespace(followingCollapsibleSpace = false): boolean {
    for (const child of this.children) {
      const childCollapsible = child.processWhitespace(followingCollapsibleSpace);
      if (child instanceof TextBox || child instanceof InlineBox) followingCollapsibleSpace = childCollapsible;
      else if (child.isInNormalFlow()) followingCollapsibleSpace = false;
    }
    return followingCollapsibleSpace;
  }

  processTextTransform(): void {
    if (!(this.isRunning() || this.isFootnote() || this.isNote())) {
      for (const child of this.children) child.processTextTransform();
    }
  }

  isWhitespace(): boolean {
    return false;
  }

  extractText(textPart: string): string {
    if (textPart === 'text' || textPart === 'content') return this.contentText;
    if (textPart === 'before' || textPart === 'after') {
      let out = '';
      for (const child of this.descendants()) {
        if (child.elementTag?.endsWith(`::${textPart}`) && !child.isParent) out += child.contentText;
      }
      return out;
    }
    if (textPart === 'first-letter') return getFirstLetter(this.contentText);
    return '';
  }
}

export class ParentBox extends Box {
  override isParent = true;

  constructor(elementTag: string | null, style: Style, element: Element | null, children: Iterable<any> = []) {
    super(elementTag, style, element);
    this.children = [...children];
  }

  resetSpacing(side: string): void {
    this.removeDecorationSides.add(side);
    this[`margin${cap(side)}`] = 0;
    this[`padding${cap(side)}`] = 0;
    this[`border${cap(side)}Width`] = 0;
  }

  removeDecoration(start: boolean, end: boolean): void {
    if (this.style.get('box_decoration_break') === 'clone') return;
    if (start) this.resetSpacing('top');
    if (end) this.resetSpacing('bottom');
  }

  copyWithChildren(newChildren: any[]): this {
    const newBox = this.copy();
    newBox.children = newChildren;
    // Clear and reset removed decorations: the previous data must not be kept,
    // for example when a box is split between two pages.
    this.removeDecorationSides = new Set();
    return newBox;
  }

  override deepcopy(): this {
    const r = this.copy();
    r.children = this.children.map((c) => c.deepcopy());
    return r;
  }

  getWrappedTable(): TableBox | undefined {
    if (!this.isTableWrapper) throw new Error('not a table wrapper');
    return this.children.find((c) => c instanceof TableBox);
  }

  override pageValues(): [any, any] {
    let [startValue, endValue] = super.pageValues();
    const children = this.children.filter((c) => c.isInNormalFlow() || c.isFloated());
    if (children.length) {
      if (children.length === 1) {
        const pv = children[0].pageValues();
        startValue = pv[0] || startValue;
        endValue = pv[1] || endValue;
      } else {
        startValue = children[0].pageValues()[0] || startValue;
        endValue = children[children.length - 1].pageValues()[1] || endValue;
      }
    }
    return [startValue, endValue];
  }

  topMarginCollapses(): boolean {
    return !(this.borderTopWidth || this.paddingTop || this.isFlexItem || this.isGridItem ||
      this.establishesFormattingContext() || this.isTableWrapper || this.isForRootElement);
  }

  bottomMarginCollapses(): boolean {
    return !(this.borderBottomWidth || this.paddingBottom || this.isFlexItem || this.isGridItem ||
      this.establishesFormattingContext() || this.isTableWrapper || this.isForRootElement);
  }

  override get contentText(): string {
    const box = this.deepcopy();
    box.processWhitespace();
    let out = '';
    for (const child of box.descendants()) {
      if (child instanceof TextBox && !child.elementTag?.endsWith('::before') &&
        !child.elementTag?.endsWith('::after') && !child.elementTag?.endsWith('::marker')) out += child.text;
    }
    return out.trim();
  }
}

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1);

export class BlockContainerBox extends ParentBox {
  override isBlockContainer = true;
}

export class BlockBox extends BlockContainerBox {
  override isBlockLevel = true;
  clearance: any = null;
}

export class LineBox extends ParentBox {
  textOverflow = 'clip';
  blockEllipsis = 'none';

  static override anonymousFrom<T extends Box>(this: new (...args: any[]) => T, parent: Box, ...args: any[]): T {
    const box = Box.anonymousFrom.call(this as any, parent, ...args) as any;
    if (parent.style.get('overflow') !== 'visible') box.textOverflow = parent.style.get('text_overflow');
    return box;
  }
}

/** InlineLevelBox.remove_decoration, shared by InlineBox and InlineBlockBox. */
function inlineRemoveDecoration(this: ParentBox, start: boolean, end: boolean): void {
  if (this.style.get('box_decoration_break') === 'clone') return;
  const ltr = this.style.get('direction') === 'ltr';
  if (start) this.resetSpacing(ltr ? 'left' : 'right');
  if (end) this.resetSpacing(ltr ? 'right' : 'left');
}

export class InlineBox extends ParentBox {
  override isInlineLevel = true;
  override removeDecoration(start: boolean, end: boolean): void {
    inlineRemoveDecoration.call(this, start, end);
  }
  override hitArea(): [number, number, number, number] {
    return [this.borderBoxX(), this.positionY, this.borderWidth(), this.marginHeight()];
  }
}

export class TextBox extends Box {
  override isInlineLevel = true;
  justificationSpacing = 0;
  text: string;

  constructor(elementTag: string | null, style: Style, element: Element | null, text: string) {
    if (!text) throw new Error('TextBox needs text');
    super(elementTag, style, element);
    this.text = text;
  }

  copyWithText(text: string): this {
    if (!text) throw new Error('TextBox needs text');
    const b = this.copy();
    b.text = text;
    return b;
  }

  override processWhitespace(followingCollapsibleSpace = false): boolean {
    let text = this.text;
    if (!text) return followingCollapsibleSpace;
    text = text.replace(LINE_FEED_RE, '\n');
    const ws = this.style.get('white_space');
    const newLineCollapse = ws === 'normal' || ws === 'nowrap';
    const spaceCollapse = ws === 'normal' || ws === 'nowrap' || ws === 'pre-line';
    if (spaceCollapse) text = text.replace(TAB_RE, '\n');
    if (newLineCollapse) text = text.replace(/\n/g, ' ');
    if (spaceCollapse) {
      const previousText = (text = text.replace(SPACE_RE, ' '));
      if (followingCollapsibleSpace && text.startsWith(' ')) {
        text = text.slice(1);
        this.leadingCollapsibleSpace = true;
      }
      followingCollapsibleSpace = previousText.endsWith(' ');
    } else followingCollapsibleSpace = false;
    this.text = text;
    return followingCollapsibleSpace;
  }

  override isWhitespace(): boolean {
    return !/\S/.test(this.text);
  }

  override processTextTransform(): void {
    const textTransform = this.style.get('text_transform');
    const langCode = ((this.style.get('lang') as string | null) ?? '').split('-')[0].toLowerCase();
    if (textTransform !== 'none') this.text = transform(textTransform, this.text, langCode);
    if (this.style.get('hyphens') === 'none') this.text = this.text.replace(/­/g, '');
  }

  override get contentText(): string {
    const box = this.deepcopy();
    box.processWhitespace();
    return box.text.trim();
  }
}

export class InlineBlockBox extends BlockContainerBox {
  override isInlineLevel = true;
  override isAtomicInline = true;
  override removeDecoration(start: boolean, end: boolean): void {
    inlineRemoveDecoration.call(this, start, end);
  }
}

export class ReplacedBox extends Box {
  override isReplaced = true;
  replacement: any;
  constructor(elementTag: string | null, style: Style, element: Element | null, replacement: any) {
    super(elementTag, style, element);
    this.replacement = replacement;
  }
}

export class BlockReplacedBox extends ReplacedBox {
  override isBlockLevel = true;
  clearance: any = null;
}

export class InlineReplacedBox extends ReplacedBox {
  override isInlineLevel = true;
  override isAtomicInline = true;
}

export class TableBox extends ParentBox {
  override isBlockLevel = true;
  override tabularContainer = true;
  clearance: any = null;
  columnGroups: any[] = [];
  columnPositions: number[] = [];

  override allChildren(): any[] {
    return [...this.children, ...this.columnGroups];
  }

  override translate(dx = 0, dy = 0, ignoreFloats = false): void {
    this.columnPositions = this.columnPositions.map((p) => p + dx);
    super.translate(dx, dy, ignoreFloats);
  }

  override pageValues(): [any, any] {
    return [this.style.get('page'), this.style.get('page')];
  }
}

export class InlineTableBox extends TableBox {}

export class TableRowGroupBox extends ParentBox {
  override properTableChild = true;
  override internalTableOrCaption = true;
  override tabularContainer = true;
  properParents: any[] = [];
  isHeader = false;
  isFooter = false;
}

export class TableRowBox extends ParentBox {
  override properTableChild = true;
  override internalTableOrCaption = true;
  override tabularContainer = true;
}

export class TableColumnGroupBox extends ParentBox {
  override properTableChild = true;
  override internalTableOrCaption = true;
  override marginTop = 0;
  override marginBottom = 0;
  override marginLeft = 0;
  override marginRight = 0;
  override paddingTop = 0;
  override paddingBottom = 0;
  override paddingLeft = 0;
  override paddingRight = 0;

  getCells(): any[] {
    return this.children.flatMap((column) => column.getCells());
  }

  get span(): number {
    if (this.children.length) return this.children.length;
    const span = parseInteger(this.element!.get('span'));
    return span !== null ? Math.max(span, 1) : 1;
  }
}

export class TableColumnBox extends ParentBox {
  override properTableChild = true;
  override internalTableOrCaption = true;
  override marginTop = 0;
  override marginBottom = 0;
  override marginLeft = 0;
  override marginRight = 0;
  override paddingTop = 0;
  override paddingBottom = 0;
  override paddingLeft = 0;
  override paddingRight = 0;

  getCells(): any[] {
    throw new Error('getCells is set on instances');
  }

  get span(): number {
    const span = parseInteger(this.element!.get('span'));
    return span !== null ? Math.max(span, 1) : 1;
  }
}

export class TableCellBox extends BlockContainerBox {
  override internalTableOrCaption = true;

  constructor(elementTag: string | null, style: Style, element: Element | null, children: Iterable<any> = []) {
    super(elementTag, style, element, children);
    // HTML 4.01 gave special meaning to colspan=0, HTML 5 removed it; rowspan=0 remains.
    const colspan = parseInteger(element!.get('colspan'));
    this.colspan = colspan !== null ? Math.max(colspan, 1) : 1;
    const rowspan = parseInteger(element!.get('rowspan'));
    this.rowspan = rowspan !== null ? Math.max(rowspan, 0) : 1;
  }
}

export class TableCaptionBox extends BlockBox {
  override properTableChild = true;
  override internalTableOrCaption = true;
}

export class PageBox extends ParentBox {
  pageType: any;
  constructor(pageType: any, style: Style) {
    super(null, style, null, []);
    this.pageType = pageType;
  }
  override toString(): string {
    return `<PageBox ${JSON.stringify(this.pageType)}>`;
  }
  get bleed(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const side of ['top', 'right', 'bottom', 'left']) out[side] = this.style.get(`bleed_${side}`).value;
    return out;
  }
  get bleedArea(): [number, number, number, number] {
    const b = this.bleed;
    return [-b.left, -b.top, this.marginWidth() + b.left + b.right, this.marginHeight() + b.top + b.bottom];
  }
}

export class MarginBox extends BlockContainerBox {
  atKeyword: string;
  constructor(atKeyword: string, style: Style) {
    super(null, style, null, []);
    this.atKeyword = atKeyword;
  }
}

export class FootnoteAreaBox extends BlockBox {
  page: any;
  constructor(page: any, style: Style) {
    super(null, style, null, []);
    this.page = page;
  }
}

export class FlexContainerBox extends ParentBox {}
export class FlexBox extends FlexContainerBox {
  override isBlockLevel = true;
  clearance: any = null;
}
export class InlineFlexBox extends FlexContainerBox {
  override isInlineLevel = true;
}

export class GridContainerBox extends ParentBox {
  /** Shared by every copy of the box, like the Python dict (copy() is shallow): grid fragments resume from it. */
  advancements: Map<string, number> = new Map();
}
export class GridBox extends GridContainerBox {
  override isBlockLevel = true;
  clearance: any = null;
}
export class InlineGridBox extends GridContainerBox {
  override isInlineLevel = true;
}