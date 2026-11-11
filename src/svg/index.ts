// SPDX-License-Identifier: BSD-3-Clause

/** Render SVG images (mirrors weasyprint/svg/__init__.py). */
import { Element } from '../dom.ts';
import type { PdfStream } from '../pdf/stream.ts';
import { PdfArray } from '../pdf/pydyf.ts';
import { Matrix } from '../matrix.ts';
import { urlJoin } from '../urls.ts';
import { parseDeclarations, parseStylesheets } from './css.ts';
import type { RuleMatcher } from './css.ts';
import { applyFilters, drawGradient, drawPattern, paintMask, use } from './defs.ts';
import { image, svg as svgTag } from './images.ts';
import { path } from './path.ts';
import { circle, ellipse, line, polygon, polyline, rect } from './shapes.ts';
import { text } from './text.ts';
import { alphaValue, color, normalize, parseUrl, preserveRatio, PointError, size, transform } from './utils.ts';
import { EMPTY_BOUNDING_BOX, boundingBox, extendBoundingBox, isValidBoundingBox } from './bounding_box.ts';
import type { Box } from './bounding_box.ts';

const XLINK_HREF = '{http://www.w3.org/1999/xlink}href';
const XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space';

/** Python TAGS: tag name -> drawing function. */
export const TAGS: Record<string, (svg: SVG, node: SvgNode, fontSize: number) => void> = {
  a: text,
  circle,
  ellipse,
  image,
  line,
  path,
  polyline,
  polygon,
  rect,
  svg: svgTag,
  text,
  textPath: text,
  tspan: text,
  use,
};

const NOT_INHERITED_ATTRIBUTES = new Set([
  'clip', 'clip-path', 'filter', 'height', 'id', 'mask', 'opacity', 'overflow', 'rotate', 'stop-color',
  'stop-opacity', 'style', 'transform', 'transform-origin', 'viewBox', 'width', 'x', 'y', 'dx', 'dy',
  XLINK_HREF, 'href',
]);

const COLOR_ATTRIBUTES = new Set(['fill', 'flood-color', 'lighting-color', 'stop-color', 'stroke']);

const DEF_TYPES = new Set(['clipPath', 'filter', 'gradient', 'image', 'marker', 'mask', 'path', 'pattern', 'symbol']);

/** Python's ``Node.process_whitespace``. */
export function processWhitespace(input: string | null | undefined, preserve: boolean): string {
  if (!input) return '';
  if (preserve) return input.replace(/[\n\r\t]/g, ' ');
  let string = input.replace(/[\n\r]/g, '');
  string = string.split('\t').join(' ');
  return string.replace(/ +/g, ' ');
}

/** An SVG document node (Python: svg.__init__.Node). */
export class SvgNode {
  /** The underlying DOM element; `tag` and `text` are mutated in place, like the reference's ElementTree node. */
  etree: Element;
  style: [RuleMatcher, RuleMatcher];
  attrib: Map<string, any>;
  vertices: any[] = [];
  boundingBox: Box | null = null;
  textBoundingBox: Box | null = null;
  childrenCache: SvgNode[] | null = null;
  private iterOverride: SvgNode[] | null = null;

  constructor(etree: Element, style: [RuleMatcher, RuleMatcher]) {
    this.etree = etree;
    this.style = style;
    this.attrib = new Map(etree.attrs);
  }

  copy(): SvgNode {
    return new SvgNode(this.etree, this.style);
  }

  get(key: string, defaultValue: any = null): any {
    return this.attrib.has(key) ? this.attrib.get(key) : defaultValue;
  }

  /** Python: `key in node`. */
  has(key: string): boolean {
    return this.attrib.has(key);
  }

  get tag(): string {
    const tag = this.etree.tag;
    const i = tag.lastIndexOf('}');
    return i === -1 ? tag : tag.slice(i + 1);
  }

  get text(): string | null {
    return this.etree.text;
  }

  get tail(): string | null {
    return this.etree.tail;
  }

  get display(): boolean {
    return this.get('display') !== 'none';
  }

  get visible(): boolean {
    return this.display && this.get('visibility') !== 'hidden';
  }

  /** Apply CSS cascade and other related operations to given child. */
  cascade(child: SvgNode): void {
    // Cascade
    for (const [key, value] of this.attrib) {
      if (!NOT_INHERITED_ATTRIBUTES.has(key) && !child.attrib.has(key)) child.attrib.set(key, value);
    }

    // Apply style attribute
    let normalAttr: Array<[string, string]> = [];
    let importantAttr: Array<[string, string]> = [];
    const styleAttr = child.get('style');
    if (styleAttr) [normalAttr, importantAttr] = parseDeclarations(styleAttr);

    const [normalMatcher, importantMatcher] = this.style;
    const normal = normalMatcher.match(child.etree);
    const important = importantMatcher.match(child.etree);
    for (const declarationsList of [normal, [normalAttr], important, [importantAttr]]) {
      for (const declarations of declarationsList) {
        for (const [name, value] of declarations) child.attrib.set(name, value.trim());
      }
    }

    // Expand
    // TODO: simplified expanders, use CSS expander code instead.
    const font = child.attrib.get('font');
    if (font !== undefined) {
      child.attrib.delete('font');
      const parts = String(font).trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        child.attrib.set('font-size', parts[0]);
        child.attrib.set('font-family', parts.slice(1).join(' '));
      }
    }

    // Replace 'currentColor' value
    for (const key of COLOR_ATTRIBUTES) {
      if (child.get(key) === 'currentColor') child.attrib.set(key, child.get('color', 'black'));
    }

    // Handle 'inherit' values
    for (const [key, value] of [...child.attrib]) {
      if (value === 'inherit') {
        const inherited = this.get(key);
        if (inherited === null || inherited === undefined) child.attrib.delete(key);
        else child.attrib.set(key, inherited);
      }
    }

    // Fix text in text tags
    if (['text', 'textPath', 'a'].includes(child.tag)) {
      const [textChildren] = child.textChildren(child, true, true);
      child.etree.children = textChildren.map((c) => c.etree);
    }
  }

  /** Children, cascaded on first access (Python: __iter__). */
  children(): SvgNode[] {
    if (this.iterOverride !== null) return this.iterOverride;
    if (this.childrenCache === null) {
      const children: SvgNode[] = [];
      for (const element of this.etree.children) {
        if (element.isComment) continue;
        const child = new SvgNode(element, this.style);
        this.cascade(child);
        children.push(child);
      }
      this.childrenCache = children;
    }
    return this.childrenCache;
  }

  [Symbol.iterator](): Iterator<SvgNode> {
    return this.children()[Symbol.iterator]();
  }

  getViewbox(): number[] | null {
    const viewbox = this.get('viewBox');
    if (viewbox) return normalize(viewbox).split(' ').filter(Boolean).map((n) => Number(n));
    return null;
  }

  /** Python: get_href(base_url). */
  getHref(baseUrl: string | null): string | null {
    for (const attrName of [XLINK_HREF, 'href']) {
      const url = parseUrlAllowRelative(this.get(attrName), baseUrl);
      if (url) return url;
    }
    return null;
  }

  delHref(): void {
    this.attrib.delete(XLINK_HREF);
    this.attrib.delete('href');
  }

  /** Python: get_child(id): the cascaded descendant with the given id. */
  getChild(id: string): SvgNode | null {
    if (!hasDescendantWithId(this.etree, id)) return null;
    for (const child of this.children()) {
      if (child.get('id') === id) return child;
      const grandchild = child.getChild(id);
      if (grandchild) return grandchild;
    }
    return null;
  }

  /** Python: text_children(element, trailing_space, text_root). Mutates text; returns the new child nodes. */
  textChildren(element: SvgNode, trailingSpaceIn: boolean, textRoot = false): [SvgNode[], boolean] {
    let trailingSpace = trailingSpaceIn;
    const children: SvgNode[] = [];
    const space = XML_SPACE;
    const preserve = this.get(space) === 'preserve';
    this.etree.text = processWhitespace(element.etree.text, preserve);
    if (trailingSpace && !preserve) this.etree.text = (this.text ?? '').replace(/^ +/, '');

    const originalRotate = normalize(this.get('rotate')).trim().split(' ').filter(Boolean).map(Number);
    const rotate = [...originalRotate];
    if (originalRotate.length) this.popRotation(originalRotate, rotate);
    if (this.text) trailingSpace = this.text.endsWith(' ');
    const elementChildren = element.etree.children.filter((c) => !c.isComment);
    elementChildren.forEach((childElement, index) => {
      let childEtree = childElement;
      if (childEtree.tag === '{http://www.w3.org/2000/svg}tref' || childEtree.tag === 'tref') {
        // Retrieve the referenced node and get its flattened text, and remove the node children.
        childEtree.tag = 'tspan';
        childEtree.text = flattenElement(childEtree);
      }
      const childNode = new SvgNode(childEtree, this.style);
      const childPreserve = childNode.get(space) === 'preserve';
      childNode.etree.text = processWhitespace(childEtree.text, childPreserve);
      [, trailingSpace] = childNode.textChildren(childNode, trailingSpace);
      trailingSpace = (childNode.text ?? '').endsWith(' ');
      // Python: `'rotate' not in child_node` is always true (Node has no __contains__, so `in` iterates children).
      if (originalRotate.length) childNode.popRotation(originalRotate, rotate);
      children.push(childNode);
      let tail = processWhitespace(childEtree.tail, preserve);
      if (textRoot && index === elementChildren.length - 1 && !preserve) tail = tail.replace(/ +$/, '');
      if (tail) {
        const anonymous = new SvgNode(new Element('{http://www.w3.org/2000/svg}tspan'), this.style);
        anonymous.etree.text = tail;
        if (originalRotate.length) anonymous.popRotation(originalRotate, rotate);
        if (trailingSpace && !preserve) anonymous.etree.text = (anonymous.text ?? '').replace(/^ +/, '');
        if (anonymous.text) trailingSpace = anonymous.text.endsWith(' ');
        children.push(anonymous);
      }
    });

    if (textRoot && !children.length && !preserve) {
      this.etree.text = (this.text ?? '').replace(/ +$/, '');
    }

    return [children, trailingSpace];
  }

  /** Python: flatten() — text of this node and descendants, removing the children. */
  popRotation(originalRotate: number[], rotate: number[]): void {
    const length = (this.text ?? '').length;
    const values: string[] = [];
    for (let i = 0; i < length; i++) {
      values.push(String(rotate.length ? rotate.shift() : originalRotate[originalRotate.length - 1]));
    }
    this.attrib.set('rotate', values.join(' '));
  }

  overrideIter(children: SvgNode[]): void {
    this.iterOverride = children;
  }

  setSvgSize(svg: SVG, concreteWidth: number, concreteHeight: number): void {
    svg.concreteWidth = concreteWidth;
    svg.concreteHeight = concreteHeight;
    svg.normalizedDiagonal = Math.hypot(concreteWidth, concreteHeight) / Math.sqrt(2);

    const viewbox = this.getViewbox();
    if (viewbox) {
      svg.innerWidth = viewbox[2];
      svg.innerHeight = viewbox[3];
    } else {
      svg.innerWidth = svg.concreteWidth;
      svg.innerHeight = svg.concreteHeight;
    }
    svg.innerDiagonal = Math.hypot(svg.innerWidth, svg.innerHeight) / Math.sqrt(2);
  }

  /** Python: get_paint(attribute, context). Returns [source, color]. */
  getPaint(attribute: 'fill' | 'stroke', context: SvgNode | null = null): [string | null, string | null] {
    const value = String(this.get(attribute, attribute === 'fill' ? 'black' : '')).trim();

    if (!value || value === 'none') return [null, null];

    if (value === 'context-fill' || value === 'context-stroke') {
      if (context === null) return [null, null];
      return context.getPaint(value.replace(/^context-/, '') as 'fill' | 'stroke');
    }

    const match = /(url\(.+\)) *(.*)/.exec(value);
    if (match) {
      const source = parseUrl(match[1]).fragment || null;
      const colorValue = match[2] || null;
      return [source, colorValue];
    }
    return [null, value || null];
  }

  /** Python: Node.__init__ `self.attrib` helper for text tags' `text_bounding_box`. */
  textBoundingBoxOrEmpty(): Box {
    return this.textBoundingBox ?? EMPTY_BOUNDING_BOX;
  }

  /** Python: flatten(), used by tref. */
  flatten(): string {
    return flattenElement(this.etree);
  }
}

function flattenElement(element: Element): string {
  const parts: string[] = [element.text ?? ''];
  for (const child of element.children) {
    parts.push(flattenElement(child));
    parts.push(child.tail ?? '');
  }
  element.children = [];
  return parts.join('');
}

function hasDescendantWithId(element: Element, id: string): boolean {
  for (const child of element.children) {
    if (child.get('id') === id) return true;
    if (hasDescendantWithId(child, id)) return true;
  }
  return false;
}

/** Python: parse_url(url, base_url, allow_relative=True) from html.py, returning the URL string or null. */
function parseUrlAllowRelative(url: string | null | undefined, baseUrl: string | null): string | null {
  // Python: html.parse_url(url, base_url, allow_relative=True) -> url_join(base_url or '', url.strip(), True, ...)
  if (!url) return null;
  const stripped = url.trim();
  if (!stripped) return null;
  try {
    return urlJoin(baseUrl || null, stripped, true, stripped) ?? stripped;
  } catch {
    return stripped;
  }
}

/** Lazily resolved <defs> by id (Python: LazyDefs). */
export class LazyDefs {
  private name: string;
  private svg: SVG;
  private data = new Map<string, SvgNode | null>();

  constructor(name: string, svg: SVG) {
    this.name = name;
    this.svg = svg;
  }

  get(name: string | null | undefined): SvgNode | null {
    if (!name) return null;
    if (this.data.has(name)) return this.data.get(name) ?? null;
    const node = this.svg.tree.getChild(name);
    if (node !== null && node.tag.toLowerCase().includes(this.name)) {
      this.data.set(name, node);
      if (this.name === 'gradient' || this.name === 'pattern') this.svg.inheritElement(node, this);
    } else {
      this.data.set(name, null);
    }
    return this.data.get(name) ?? null;
  }
}

export class SVG {
  tree: SvgNode;
  fontConfig: unknown;
  urlFetcher: unknown;
  url: string;
  context: any = null;
  baseUrl: string | null = null;
  stream!: PdfStream;

  filters: LazyDefs;
  gradients: LazyDefs;
  images: LazyDefs;
  markers: LazyDefs;
  masks: LazyDefs;
  patterns: LazyDefs;
  paths: LazyDefs;
  symbols: LazyDefs;

  useCache = new Map<string, SvgNode>();
  cursorPosition: [number, number] = [0, 0];
  cursorDPosition: [number, number] = [0, 0];
  textPathWidth = 0;

  concreteWidth = 0;
  concreteHeight = 0;
  normalizedDiagonal = 0;
  innerWidth = 0;
  innerHeight = 0;
  innerDiagonal = 0;

  constructor(tree: Element, url: string, fontConfig: unknown, urlFetcher: unknown = null) {
    const style = parseStylesheets(tree, url, fontConfig, urlFetcher);
    this.tree = new SvgNode(tree, style);
    this.fontConfig = fontConfig;
    this.urlFetcher = urlFetcher;
    this.url = url;

    this.filters = new LazyDefs('filter', this);
    this.gradients = new LazyDefs('gradient', this);
    this.images = new LazyDefs('image', this);
    this.markers = new LazyDefs('marker', this);
    this.masks = new LazyDefs('mask', this);
    this.patterns = new LazyDefs('pattern', this);
    this.paths = new LazyDefs('path', this);
    this.symbols = new LazyDefs('symbol', this);

    this.tree.cascade(this.tree);
  }

  /** Python: get_intrinsic_size(font_size). */
  getIntrinsicSize(fontSize: number): [number | null, number | null] {
    const rawWidth = this.tree.get('width', '100%');
    const intrinsicWidth = String(rawWidth).includes('%') ? null : size(rawWidth, fontSize);
    const rawHeight = this.tree.get('height', '100%');
    const intrinsicHeight = String(rawHeight).includes('%') ? null : size(rawHeight, fontSize);
    return [intrinsicWidth, intrinsicHeight];
  }

  getViewbox(): number[] | null {
    return this.tree.getViewbox();
  }

  /** Python: point(x, y, font_size). */
  point(x: any, y: any, fontSize: number): [number, number] {
    return [size(x, fontSize, this.innerWidth), size(y, fontSize, this.innerHeight)];
  }

  length(length: any, fontSize: number): number {
    return size(length, fontSize, this.innerDiagonal);
  }

  /** Python: draw(stream, concrete_width, concrete_height, base_url, context). */
  draw(stream: PdfStream, concreteWidth: number, concreteHeight: number, baseUrl: string | null, context: any): void {
    this.stream = stream;
    this.tree.setSvgSize(this, concreteWidth, concreteHeight);
    this.baseUrl = baseUrl;
    this.context = context;
    this.drawNode(this.tree, size('12pt'));
  }

  drawNode(node: SvgNode, fontSizeIn: number, fillStroke = true, context: SvgNode | null = null): void {
    if (node.tag === 'defs') return;

    // Update font size
    const fontSize = size(node.get('font-size', '1em'), fontSizeIn, fontSizeIn);

    const originalStreams: PdfStream[] = [];

    const callFillStroke = fillStroke && ['circle', 'ellipse', 'line', 'path', 'polyline', 'polygon', 'rect'].includes(node.tag);

    if (fillStroke) this.stream.pushState();

    // Apply filters
    const filter = this.filters.get(parseUrl(node.get('filter')).fragment);
    if (filter) applyFilters(this, node, filter, fontSize);

    // Apply transform attribute
    this.transformNode(node, fontSize);

    // Create substream for opacity
    const opacity = alphaValue(node.get('opacity', 1));
    let group: PdfStream | null = null;
    if (fillStroke && opacity >= 0 && opacity < 1) {
      originalStreams.push(this.stream);
      group = this.stream.addGroup(0, 0, 0, 0); // BBox set after drawing
      this.stream = group;
    }

    // Set graphical state
    let fill: any = null;
    let stroke: any = null;
    if (callFillStroke) [fill, stroke] = this.setGraphicalState(node, fontSize, context);

    // Clip
    const clipPath = parseUrl(node.get('clip-path')).fragment;
    if (clipPath && this.paths.get(clipPath)) {
      const oldCtm = this.stream.ctm;
      const clipNode = this.paths.get(clipPath)!;
      if (clipNode.get('clipPathUnits') === 'objectBoundingBox') {
        const [x, y] = this.point(node.get('x'), node.get('y'), fontSize);
        const [width, height] = this.point(node.get('width'), node.get('height'), fontSize);
        this.stream.transform(width, 0, 0, height, x, y);
      }
      const originalTag = clipNode.etree.tag;
      clipNode.etree.tag = 'g';
      this.drawNode(clipNode, fontSize, false);
      clipNode.etree.tag = originalTag;
      // At least set the clipping area to an empty path, so that it’s
      // totally clipped when the clipping path is empty.
      this.stream.rectangle(0, 0, 0, 0);
      this.stream.clip();
      this.stream.end();
      const newCtm = this.stream.ctm;
      if (newCtm.determinant) {
        const m = oldCtm.matmul(newCtm.invert).m;
        this.stream.transform(m[0][0], m[0][1], m[1][0], m[1][1], m[2][0], m[2][1]);
      }
    }

    // Handle text anchor and set text bounding box
    let textAnchorShift = false;
    let textAnchor = 'start';
    let textGroup: PdfStream | null = null;
    if (node.display && TAGS[node.tag] === text) {
      textAnchor = node.get('text-anchor', 'start');
      const direction = node.get('direction', 'ltr');
      textAnchorShift = !((textAnchor === 'start' && direction === 'ltr') || (textAnchor === 'end' && direction === 'rtl'));
      if (textAnchorShift) {
        textGroup = this.stream.addGroup(0, 0, 0, 0); // BBox set after drawing
        originalStreams.push(this.stream);
        this.stream = textGroup;
      }
      node.textBoundingBox = EMPTY_BOUNDING_BOX;
    }

    // Save concrete size of root svg tag
    let savedConcreteWidth = 0;
    let savedConcreteHeight = 0;
    if (node.tag === 'svg') {
      savedConcreteWidth = this.concreteWidth;
      savedConcreteHeight = this.concreteHeight;
    }

    // Draw node
    if (node.visible && node.tag in TAGS) {
      try {
        TAGS[node.tag](this, node, fontSize);
      } catch (error) {
        if (!(error instanceof PointError)) throw error;
      }
    }

    // Draw node children
    if (node.display && !DEF_TYPES.has(node.tag)) {
      for (const child of node.children()) {
        const newChunk = textAnchorShift && (child.tag === 'text' || child.has('x') || child.has('y'));
        let newStream: PdfStream | null = null;
        if (newChunk) {
          newStream = this.stream;
          this.stream = originalStreams[originalStreams.length - 1];
        }
        const childContext = node.tag === 'use' ? node : context;
        this.drawNode(child, fontSize, fillStroke, childContext);
        if (newChunk && newStream) this.stream = newStream;
        const visibleTextChild = TAGS[node.tag] === text && TAGS[child.tag] === text && child.visible;
        if (visibleTextChild) {
          if (!isValidBoundingBox(child.textBoundingBox)) continue;
          const [cx, cy, cw, ch] = child.textBoundingBox!;
          node.textBoundingBox = extendBoundingBox(
            node.textBoundingBox ?? EMPTY_BOUNDING_BOX, [[cx, cy], [cx + cw, cy + ch]]);
        }
      }
    }

    // Restore concrete and inner size of root svg tag
    if (node.tag === 'svg') this.tree.setSvgSize(this, savedConcreteWidth, savedConcreteHeight);

    // Handle text anchor
    if (textAnchorShift) {
      const groupId = this.stream.id;
      this.stream = originalStreams.pop()!;
      this.stream.pushState();
      if (isValidBoundingBox(node.textBoundingBox)) {
        const [x, y, width, height] = node.textBoundingBox!;
        // Add extra space to include ink extents
        textGroup!.extra.set('BBox', new PdfArray([x - fontSize, y - fontSize, x + width + fontSize, y + height + fontSize]));
        const xAlign = textAnchor === 'middle' ? width / 2 : width;
        if (node.tag === 'text' || node.has('x') || node.has('y')) this.stream.transform(1, 0, 0, 1, -xAlign, 0);
      }
      this.stream.drawXObject(groupId);
      this.stream.popState();
    }

    // Apply mask
    const mask = this.masks.get(parseUrl(node.get('mask')).fragment);
    if (mask) paintMask(this, node, mask, opacity); // Python passes opacity as font_size here

    // Fill and stroke
    if (callFillStroke) {
      const evenOdd = node.get('fill-rule') === 'evenodd';
      this.fillStroke(fill, stroke, evenOdd);
    }

    // Draw markers
    this.drawMarkers(node, fontSize, fillStroke);

    // Apply opacity stream and restore original stream
    if (fillStroke && opacity >= 0 && opacity < 1) {
      let box: Box = this.calculateBoundingBox(node, fontSize) ?? EMPTY_BOUNDING_BOX;
      if (!isValidBoundingBox(box)) box = [0, 0, this.innerWidth, this.innerHeight];
      const [x, y, width, height] = box;
      this.stream.extra.set('BBox', new PdfArray([x, y, x + width, y + height]));

      const groupId = this.stream.id;
      this.stream = originalStreams.pop()!;
      this.stream.setAlpha(opacity, true, true);
      this.stream.drawXObject(groupId);
    }

    // Clean text tag
    if (node.tag === 'text') {
      this.cursorPosition = [0, 0];
      this.cursorDPosition = [0, 0];
      this.textPathWidth = 0;
    }

    if (fillStroke) this.stream.popState();
  }

  drawMarkers(node: SvgNode, fontSize: number, fillStroke: boolean): void {
    if (!node.vertices.length) return;

    const markers: Record<string, string | null> = {};
    const commonMarker = parseUrl(node.get('marker')).fragment;
    for (const position of ['start', 'mid', 'end']) {
      const attribute = `marker-${position}`;
      if (node.has(attribute)) markers[position] = parseUrl(node.attrib.get(attribute)).fragment;
      else markers[position] = commonMarker;
    }

    let angle1: number | null = null;
    let angle2: number | null = null;
    let angle: number | null = null;
    let position = 'start';

    while (node.vertices.length) {
      // Calculate position and angle
      const pointValue = node.vertices.shift();
      const angles = node.vertices.length ? node.vertices.shift() : null;
      if (angles) {
        if (position === 'start') angle = Math.PI - angles[0];
        else angle = (angle2! + Math.PI - angles[0]) / 2;
        [angle1, angle2] = angles;
      } else {
        angle = angle2;
        position = 'end';
      }

      // Draw marker
      const markerNode = this.markers.get(markers[position]);
      if (!markerNode) {
        position = angles ? 'mid' : 'start';
        continue;
      }

      // Calculate position, scale and clipping
      const [translateX, translateY] = this.point(markerNode.get('refX'), markerNode.get('refY'), fontSize);
      const [markerWidth, markerHeight] = this.point(
        markerNode.get('markerWidth', 3), markerNode.get('markerHeight', 3), fontSize);
      let scaleX: number;
      let scaleY: number;
      let clipBox: [number, number, number, number];
      if (markerNode.has('viewBox')) {
        [scaleX, scaleY] = preserveRatio(this, markerNode, fontSize, markerWidth, markerHeight);

        let [clipX, clipY, viewboxWidth, viewboxHeight] = markerNode.getViewbox()!;

        const align = String(markerNode.get('preserveAspectRatio', 'xMidYMid')).split(' ')[0];
        let xPosition: string;
        let yPosition: string;
        if (align === 'none') {
          xPosition = 'min';
          yPosition = 'min';
        } else {
          xPosition = align.slice(1, 4).toLowerCase();
          yPosition = align.slice(5).toLowerCase();
        }

        if (xPosition === 'mid') clipX += (viewboxWidth - markerWidth / scaleX) / 2;
        else if (xPosition === 'max') clipX += viewboxWidth - markerWidth / scaleX;

        if (yPosition === 'mid') clipY += (viewboxHeight - markerHeight / scaleY) / 2;
        else if (yPosition === 'max') clipY += viewboxHeight - markerHeight / scaleY;

        clipBox = [clipX, clipY, markerWidth / scaleX, markerHeight / scaleY];
      } else {
        scaleX = 1;
        scaleY = 1;
        clipBox = [0, 0, markerWidth, markerHeight];
      }

      // Scale
      if (markerNode.get('markerUnits') !== 'userSpaceOnUse') {
        const scale = this.length(node.get('stroke-width', 1), fontSize);
        scaleX *= scale;
        scaleY *= scale;
      }

      // Override angle
      const nodeAngle = markerNode.get('orient', 0);
      if (nodeAngle !== 'auto' && nodeAngle !== 'auto-start-reverse') {
        angle = (Number(nodeAngle) * Math.PI) / 180;
      } else if (nodeAngle === 'auto-start-reverse' && position === 'start') {
        angle = (angle ?? 0) + Math.PI;
      }

      // Draw marker path
      for (const child of markerNode.children()) {
        this.stream.pushState();

        const a = scaleX * Math.cos(angle ?? 0);
        const b = scaleX * Math.sin(angle ?? 0);
        const c = -scaleY * Math.sin(angle ?? 0);
        const d = scaleY * Math.cos(angle ?? 0);
        const [px, py] = pointValue as [number, number];
        this.stream.transform(a, b, c, d, px, py);
        this.stream.transform(1, 0, 0, 1, -translateX, -translateY);

        const overflow = markerNode.get('overflow', 'hidden');
        if (overflow === 'hidden' || overflow === 'scroll') {
          this.stream.rectangle(...clipBox);
          this.stream.clip();
          this.stream.end();
        }

        this.drawNode(child, fontSize, fillStroke, node);
        this.stream.popState();
      }

      position = angles ? 'mid' : 'start';
    }
  }

  /** Set stroke and fill colors, gradients, patterns, and line options. */
  setGraphicalState(node: SvgNode, fontSize: number, context: SvgNode | null = null): [any, any] {
    // Get fill data
    let [source, fill]: [string | null, any] = node.getPaint('fill', context);
    const opacity = alphaValue(node.get('fill-opacity', 1));
    const gradient = this.gradients.get(source);
    const pattern = gradient ? null : this.patterns.get(source);
    if (gradient) {
      fill = drawGradient(this, node, gradient, fontSize, opacity, false);
    } else if (pattern) {
      fill = drawPattern(this, node, pattern, fontSize, opacity, false);
    } else if (fill) {
      const streamColor = color(fill);
      this.stream.setColor({ ...streamColor, a: streamColor.a * opacity } as any);
    }

    // Get stroke data
    let stroke: any = null;
    const strokeWidth = this.length(node.get('stroke-width', '1px'), fontSize);
    if (strokeWidth) {
      [source, stroke] = node.getPaint('stroke', context);
      const strokeOpacity = alphaValue(node.get('stroke-opacity', 1));
      const strokeGradient = this.gradients.get(source);
      const strokePattern = strokeGradient ? null : this.patterns.get(source);
      if (strokeGradient) {
        stroke = drawGradient(this, node, strokeGradient, fontSize, strokeOpacity, true);
      } else if (strokePattern) {
        stroke = drawPattern(this, node, strokePattern, fontSize, strokeOpacity, true);
      } else if (stroke) {
        const streamColor = color(stroke);
        this.stream.setColor({ ...streamColor, a: streamColor.a * strokeOpacity } as any, true);
        this.stream.setLineWidth(strokeWidth);
      }
    } else {
      stroke = null;
    }

    // Apply dash array
    const dashArray = normalize(node.get('stroke-dasharray'))
      .split(' ').filter((v) => v && v !== 'none').map((v) => this.length(v, fontSize));
    const dashCondition = dashArray.length > 0
      && !dashArray.every((v) => v === 0) && !dashArray.some((v) => v < 0);
    if (dashCondition) {
      let offset = this.length(node.get('stroke-dashoffset'), fontSize);
      if (offset < 0) {
        const sumDashes = dashArray.reduce((a, b) => a + b, 0);
        offset = sumDashes - (Math.abs(offset) % sumDashes);
      }
      this.stream.setDash(dashArray, offset);
    } else {
      this.stream.setDash([], 0);
    }

    // Apply line cap
    const lineCapValue = node.get('stroke-linecap', 'butt');
    this.stream.setLineCap(lineCapValue === 'round' ? 1 : lineCapValue === 'square' ? 2 : 0);

    // Apply line join
    const lineJoinValue = node.get('stroke-linejoin', 'miter');
    this.stream.setLineJoin(lineJoinValue === 'round' ? 1 : lineJoinValue === 'bevel' ? 2 : 0);

    // Apply miter limit
    let miterLimit = Number(node.get('stroke-miterlimit', 4));
    if (miterLimit < 0) miterLimit = 4;
    this.stream.setMiterLimit(miterLimit);

    return [fill, stroke];
  }

  /** Paint fill and stroke for a node. */
  fillStroke(fill: any, stroke: any, evenOdd = false, text = false): void {
    if (text) {
      let textRendering: number;
      if (fill && stroke) textRendering = 2;
      else if (stroke) textRendering = 1;
      else if (fill) textRendering = 0;
      else textRendering = 3;
      this.stream.setTextRendering(textRendering);
    } else if (fill && stroke) {
      this.stream.fillAndStroke(evenOdd);
    } else if (stroke) {
      this.stream.stroke();
    } else if (fill) {
      this.stream.fill(evenOdd);
    } else {
      this.stream.end();
    }
  }

  /** Get the transformation matrix of a node. */
  getNodeTransformMatrix(node: SvgNode, fontSize: number): Matrix | null {
    const transformString = node.get('transform');
    if (transformString) {
      const origin = node.get('transform-origin');
      const matrix = transform(transformString, origin, fontSize, this.innerDiagonal);
      if (matrix.determinant) return matrix;
    }
    return null;
  }

  /** Apply the transformation string of a node to the stream. */
  transformNode(node: SvgNode, fontSize: number): void {
    const matrix = this.getNodeTransformMatrix(node, fontSize);
    if (matrix) {
      const m = matrix.m;
      this.stream.transform(m[0][0], m[0][1], m[1][0], m[1][1], m[2][0], m[2][1]);
    }
  }

  /** Recursively handle inheritance of defined element. */
  inheritElement(element: SvgNode, defs: LazyDefs): void {
    const href = element.getHref(this.url);
    if (!href) return;
    element.delHref();
    const parent = defs.get(parseUrl(href).fragment);
    if (!parent) return;
    this.inheritElement(parent, defs);
    for (const [key, value] of parent.attrib) {
      if (!element.attrib.has(key)) element.attrib.set(key, value);
    }
    if (element.children().length === 0) element.overrideIter(parent.children());
  }

  calculateBoundingBox(node: SvgNode, fontSize: number, stroke = true): Box | null {
    if (stroke || node.boundingBox === null) {
      const box = boundingBox(this, node, fontSize, stroke);
      if (isValidBoundingBox(box) && !box.slice(2).includes(0)) {
        if (stroke) return box;
        node.boundingBox = box;
      }
    }
    return node.boundingBox;
  }
}

/** Python: Pattern(SVG) — an SVG node applied as a pattern. */
export class Pattern extends SVG {
  svg: SVG;

  constructor(tree: SvgNode, svg: SVG) {
    super(tree.etree, svg.url, svg.fontConfig, svg.urlFetcher);
    this.svg = svg;
    this.tree = tree;
  }

  override drawNode(node: SvgNode, fontSize: number, fillStroke = true, context: SvgNode | null = null): void {
    // Store the original tree in this.tree when calling draw(), so that we
    // can reach defs outside the pattern
    if (node === this.tree) this.tree = this.svg.tree;
    super.drawNode(node, fontSize, fillStroke, context);
  }
}

export type { Box };
