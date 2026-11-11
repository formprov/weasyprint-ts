// SPDX-License-Identifier: BSD-3-Clause

/**
 * Minimal ElementTree-like DOM (text/tail model), built from parse5's tree.
 * WeasyPrint's box builder relies on `element.text` / `element.tail`.
 */
import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

type P5Node = DefaultTreeAdapterMap['node'];
type P5Element = DefaultTreeAdapterMap['element'];

const NS_PREFIX: Record<string, string> = {
  'http://www.w3.org/2000/svg': 'svg',
  'http://www.w3.org/1998/Math/MathML': 'math',
};

export class Element {
  /** HTML tag name, or '{namespace}name' for foreign elements; '#comment' for comments/PIs. */
  tag: string;
  attrs: Map<string, string>;
  children: Element[] = [];
  text: string | null = null;
  tail: string | null = null;
  parent: Element | null = null;
  /** Index among element siblings (set on append). */
  constructor(tag: string, attrs: Iterable<[string, string]> = []) {
    this.tag = tag;
    this.attrs = new Map(attrs);
  }

  get isComment(): boolean {
    return this.tag === '#comment';
  }

  get(name: string, fallback: string | null = null): string | null {
    return this.attrs.get(name) ?? fallback;
  }

  append(child: Element): void {
    child.parent = this;
    this.children.push(child);
  }

  /** Document-order iteration over this element and all descendants (comments included). */
  *iter(): Generator<Element> {
    yield this;
    for (const c of this.children) yield* c.iter();
  }

  /** Real elements only (no comments). */
  *iterElements(): Generator<Element> {
    if (!this.isComment) yield this;
    for (const c of this.children) yield* c.iterElements();
  }

  get elementChildren(): Element[] {
    return this.children.filter((c) => !c.isComment);
  }
}

function convert(node: P5Node, parent: Element | null, lastChild: { el: Element | null }): void {
  switch (node.nodeName) {
    case '#text': {
      const value = (node as { value: string }).value;
      if (!parent) return;
      if (lastChild.el) lastChild.el.tail = (lastChild.el.tail ?? '') + value;
      else parent.text = (parent.text ?? '') + value;
      return;
    }
    case '#comment': {
      if (!parent) return;
      const c = new Element('#comment');
      parent.append(c);
      lastChild.el = c;
      return;
    }
    case '#documentType':
      return;
    default: {
      const el = node as P5Element;
      const ns = NS_PREFIX[el.namespaceURI as string];
      const tag = ns ? `{${el.namespaceURI}}${el.tagName}` : el.tagName;
      const element = new Element(tag, el.attrs.map((a) => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value]));
      if (parent) {
        parent.append(element);
        lastChild.el = element;
      }
      const state = { el: null as Element | null };
      const kids = (el as unknown as { content?: { childNodes: P5Node[] } }).content?.childNodes
        ?? (el as { childNodes: P5Node[] }).childNodes;
      for (const child of kids) convert(child, element, state);
      if (!parent) rootHolder.root = element;
    }
  }
}
const rootHolder: { root: Element | null } = { root: null };

/** Parse an HTML document and return the root <html> element. */
export function parseHtml(source: string): Element {
  const document = parse(source);
  const html = document.childNodes.find((n) => n.nodeName === 'html');
  if (!html) throw new Error('No <html> element');
  rootHolder.root = null;
  convert(html, null, { el: null });
  return rootHolder.root!;
}