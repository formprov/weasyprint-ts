// SPDX-License-Identifier: BSD-3-Clause

/**
 * PDF tagging (mirrors weasyprint/pdf/tags.py): the structure tree built from the box tree, mapping each marked
 * content identifier of the page streams to its structure element, and the link and widget annotations.
 */
import { LOGGER } from '../logger.ts';
import type { Element } from '../dom.ts';
import { MarginBox, PageBox, ParentBox, LineBox, ReplacedBox, TextBox } from '../formatting_structure/boxes.ts';
import { AbsolutePlaceholder } from '../layout/absolute.ts';
import { Dictionary, PDF, PdfArray, PdfString } from './pydyf.ts';

type AnyBox = any;

const SVG_NS = '{http://www.w3.org/2000/svg}';

/** Python: _get_pdf_tag, the structure type of an HTML element (null: the anonymous box). */
function pdfTagOf(tag: string | null): string {
  if (tag === null) return 'NonStruct';
  if (tag === 'div') return 'Div';
  if (tag.split(':')[0] === 'a') return 'Link'; // links and link pseudo elements create link annotations
  if (tag === 'span') return 'Span';
  if (tag === 'main') return 'Part';
  if (tag === 'article') return 'Art';
  if (tag === 'section') return 'Sect';
  if (tag === 'blockquote') return 'BlockQuote';
  if (tag === 'p') return 'P';
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) return tag.toUpperCase();
  if (['dl', 'ul', 'ol'].includes(tag)) return 'L';
  if (['li', 'dt', 'dd'].includes(tag)) return 'LI';
  if (tag === 'li::marker') return 'Lbl';
  if (tag === 'table') return 'Table';
  if (['tr', 'th', 'td'].includes(tag)) return tag.toUpperCase();
  if (['thead', 'tbody', 'tfoot'].includes(tag)) return tag.slice(0, 2).toUpperCase() + tag.slice(2);
  if (tag === 'img' || tag === `${SVG_NS}svg`) return 'Figure';
  if (tag === 'caption' || tag === 'figcaption') return 'Caption';
  return 'NonStruct';
}

interface TagBuild {
  pdf: PDF;
  /** Object references of the marked content identifiers of the page being built (Python: nums). */
  nums: Map<number, string>;
  annotations: Array<[string, Dictionary]>;
  pageReference: string;
  pageNumber: number;
}

const stElem = (parent: Dictionary, tag: string, pageReference: string, kids: unknown[] = []): Dictionary => new Dictionary({
  Type: '/StructElem', S: `/${tag}`, K: new PdfArray(kids as any), Pg: pageReference, P: parent.reference,
});

function structOf(element: Dictionary): PdfArray {
  return element.get('K') as PdfArray;
}

/** Python: _build_box_tree. Returns the structure elements that this box contributes to its parent. */
function buildBoxTree(box0: AnyBox, parent: Dictionary, ctx: TagBuild, tags: Map<AnyBox, { tag: string; mcid: number }>): Dictionary[] {
  let box = box0;
  // Special case for absolute elements.
  if (box instanceof AbsolutePlaceholder) box = (box as any)._box;

  const elementTag: string | null = box.element === null || box.element === undefined ? null : box.elementTag;
  let tag = pdfTagOf(elementTag);

  // Avoid generating page, html and body boxes as semantic nodes: yield their children.
  if (elementTag === 'html' || elementTag === 'body' || box instanceof PageBox) {
    if (box instanceof ParentBox && !(box instanceof LineBox)) {
      const out: Dictionary[] = [];
      for (const child of box.children) out.push(...buildBoxTree(child, parent, ctx, tags));
      return out;
    }
  } else if (box instanceof MarginBox) {
    // Margin boxes are built but not linked to the tree: their marked content is removed from the list.
    for (const child of box.children) buildBoxTree(child, parent, ctx, tags);
    return [];
  } else if (tag === 'TD' || tag === 'TH') {
    // Ignore anonymous blocks created for table cells.
    if (parent.get('S') === '/TD' || parent.get('S') === '/TH') tag = 'NonStruct';
  } else if (tag === 'LI') {
    // Ignore anonymous blocks created for lists and bullets.
    const anonymousListElement = parent.get('S') === '/LI';
    const anonymousLiChild = parent.get('S') === '/LBody';
    const dlItem = box.elementTag === 'dt' || box.elementTag === 'dd';
    const noBulletLi = box.elementTag === 'li' && (
      !String(box.style.get('display')).includes('list-item') || box.style.get('list_style_type') === 'none');
    if (anonymousListElement) tag = 'LBody'; // store as list item body
    else if (anonymousLiChild) tag = 'NonStruct'; // store as non-struct list item body child
    else if (dlItem || noBulletLi) {
      // Wrap in a list item.
      tag = 'LBody';
      const item = new Dictionary({
        Type: '/StructElem', S: '/LI', K: new PdfArray([]), Pg: ctx.pageReference, P: parent.reference,
      });
      ctx.pdf.addObject(item);
      for (const child of buildBoxTree(box, item, ctx, tags)) structOf(item).push(child.reference);
      return [item];
    }
  }

  // Create box element.
  let element = stElem(parent, tag, ctx.pageReference);
  ctx.pdf.addObject(element);

  // Special cases.
  if (tag === 'Figure') {
    // Extra data for images.
    const x1 = box.contentBoxX();
    const y1 = box.contentBoxY();
    const x2 = x1 + box.width;
    const y2 = y1 + box.height;
    element.set('A', new Dictionary({ O: '/Layout', BBox: new PdfArray([x1, y1, x2, y2]) }));
    // Alternate text: an SVG's <title>, else the alt attribute; images without one are logged.
    const source: Element | null = box.element;
    if (source && source.tag === `${SVG_NS}svg`) {
      const title = source.children.find((c: Element) => c.tag === `${SVG_NS}title`);
      if (title && title.text) element.set('Alt', new PdfString(title.text));
    } else if (source && source.get('alt', null)) {
      element.set('Alt', new PdfString(source.get('alt', null)!));
    } else {
      LOGGER.error(`Image "${source?.get('src', 'unknown') ?? 'unknown'}" has no required alt description`);
    }
  } else if (tag === 'Table') {
    // Use the wrapped table as the tagged box, and put the captions in it.
    if (box.isTableWrapper) {
      const wrapper = box;
      const table = wrapper.getWrappedTable();
      if (table) {
        box = table.copyWithChildren([]);
        for (const child of wrapper.children) {
          box.children.push(...(child === table ? child.children : [child]));
        }
      }
    }
  } else if (tag === 'TH' || tag === 'TD') {
    element.set('A', new Dictionary({ O: '/Table' }));
    const attributes = element.get('A') as Dictionary;
    if (box.colspan !== 1) attributes.set('ColSpan', box.colspan);
    if (box.rowspan !== 1) attributes.set('RowSpan', box.rowspan);
    // The table cell element, to map headers to cells later.
    box.mark = element;
  }

  // Include link annotations.
  if (box.linkAnnotation) {
    const annotation = box.linkAnnotation as Dictionary;
    const objectReference = new Dictionary({ Type: '/OBJR', Obj: annotation.reference, Pg: ctx.pageReference });
    ctx.pdf.addObject(objectReference);
    ctx.annotations.push([element.reference, annotation]);
    structOf(element).push(objectReference.reference);
  }

  // Include widget annotations (form fields).
  if (box.widgetAnnotation) {
    const annotation = box.widgetAnnotation as Dictionary;
    const objectReference = new Dictionary({ Type: '/OBJR', Obj: annotation.reference, Pg: ctx.pageReference });
    ctx.pdf.addObject(objectReference);
    const formElement = stElem(element, 'Form', ctx.pageReference, [objectReference.reference]);
    ctx.pdf.addObject(formElement);
    ctx.annotations.push([formElement.reference, annotation]);
    structOf(element).push(formElement.reference);
  }

  // Build the tree for the box children.
  for (const child0 of box.children) {
    const children = child0 instanceof LineBox ? child0.children : [child0];
    for (const child of children) {
      if (child instanceof TextBox) {
        // Add the marked content of the stream.
        const kid = tags.get(child);
        if (!kid) throw new Error('marked content of a text box is missing');
        tags.delete(child);
        if (ctx.nums.has(kid.mcid)) throw new Error('duplicate marked content identifier');
        if (tag === 'Link') {
          // Associate the MCID directly with the link.
          structOf(element).push(kid.mcid);
          ctx.nums.set(kid.mcid, element.reference);
        } else {
          const kidElement = new Dictionary({
            Type: '/StructElem', S: `/${kid.tag}`, K: new PdfArray([kid.mcid]), Pg: ctx.pageReference, P: element.reference,
          });
          ctx.pdf.addObject(kidElement);
          structOf(element).push(kidElement.reference);
          ctx.nums.set(kid.mcid, kidElement.reference);
        }
      } else {
        // Recursively build the tree for the child.
        // In PDFs nested lists belong to the parent list, but in HTML they belong to the parent's list item.
        const childParent = (child.elementTag === 'ul' || child.elementTag === 'ol') && element.get('S') === '/LI'
          ? parent : element;
        // Keep the current number of parent children, so the new children come before their own grandchildren.
        const childIndex = structOf(childParent).items.length;
        const childElements = buildBoxTree(child, childParent, ctx, tags);
        structOf(childParent).items.splice(childIndex, 0, ...childElements.map((e) => e.reference));
      }
    }
  }

  if (box instanceof ReplacedBox) {
    // The replaced box's marked content.
    const kid = tags.get(box);
    if (!kid) throw new Error('marked content of a replaced box is missing');
    tags.delete(box);
    structOf(element).push(kid.mcid);
    if (ctx.nums.has(kid.mcid)) throw new Error('duplicate marked content identifier');
    ctx.nums.set(kid.mcid, element.reference);
  }

  // Link table cells to their headers.
  if (tag === 'Table') linkTableHeaders(box, element, ctx);

  return [element];
}

/** Python: the table header and data cell association at the end of _build_box_tree. */
function linkTableHeaders(box: AnyBox, element: Dictionary, ctx: TagBuild): void {
  const getRows = (tableBox: AnyBox): AnyBox[] => {
    const rows: AnyBox[] = [];
    for (const child of tableBox.children ?? []) {
      if (child.elementTag === 'tr') rows.push(child);
      else rows.push(...getRows(child));
    }
    return rows;
  };
  const columnHeaders = new Map<number, string[]>();
  const rowHeaders = new Map<number, string[]>();
  const rows = getRows(box);
  const push = (map: Map<number, any[]>, key: number, value: any): void => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(value);
  };

  // Find the column and row headers.
  let colspans = new Map<number, number>();
  rows.forEach((row, i) => {
    let j = 0;
    for (const cell of row.children) {
      if (cell.element !== null && cell.elementTag === 'th') {
        const key = new PdfString(`${element.number}-${i}-${j}`);
        cell.mark.set('ID', key);
        if (cell.element.get('scope', null) === 'row') push(rowHeaders, i, key);
        else push(columnHeaders, j, key);
      }
      for (let k = 0; k < cell.colspan; k++) {
        colspans.set(j, cell.rowspan - 1);
        j++;
      }
      if (colspans.get(j)) {
        j++;
        colspans.set(j, (colspans.get(j) ?? 0) - 1);
      }
    }
  });

  // Map the headers to the cells.
  colspans = new Map<number, number>();
  rows.forEach((row, i) => {
    let j = 0;
    for (const cell of row.children) {
      if (cell.element !== null && cell.elementTag === 'td') {
        const headers: unknown[] = [];
        for (let span = 0; span < cell.rowspan; span++) headers.push(...(rowHeaders.get(i + span) ?? []));
        for (let span = 0; span < cell.colspan; span++) headers.push(...(columnHeaders.get(j + span) ?? []));
        (cell.mark.get('A') as Dictionary).set('Headers', new PdfArray(headers as any));
      }
      for (let k = 0; k < cell.colspan; k++) {
        colspans.set(j, cell.rowspan - 1);
        j++;
      }
      if (colspans.get(j)) {
        j++;
        colspans.set(j, (colspans.get(j) ?? 0) - 1);
      }
    }
  });
  void ctx;
}

/**
 * Python: add_tags. The structure tree of the document: a root, the content mapping (/ParentTree /Nums) of every page,
 * the annotations, and the MarkInfo and ViewerPreferences of the catalog.
 */
export function addTags(pdf: PDF, pages: Array<{ pageBox: AnyBox }>, pdfVersion: string | null,
  pageStreams: Array<{ tags: Map<AnyBox, { tag: string; mcid: number }> | null }>): void {
  // Add the root structure.
  const contentMapping = new Dictionary({});
  pdf.addObject(contentMapping);
  const structureRoot = new Dictionary({ Type: '/StructTreeRoot', ParentTree: contentMapping.reference });
  pdf.addObject(structureRoot);
  const structureDocument = new Dictionary({
    Type: '/StructElem', S: '/Document', K: new PdfArray([]), P: structureRoot.reference,
  });
  pdf.addObject(structureDocument);
  structureRoot.set('K', new PdfArray([structureDocument.reference]));
  pdf.catalog.set('StructTreeRoot', structureRoot.reference);

  // Namespace for PDF 2.0.
  if ((pdfVersion ?? '') >= '2.0') {
    const namespace = new Dictionary({ Type: '/Namespace', NS: new PdfString('http://iso.org/pdf2/ssn') });
    pdf.addObject(namespace);
    structureRoot.set('Namespaces', new PdfArray([namespace.reference]));
    structureDocument.set('NS', namespace.reference);
  }

  // Map the content.
  const nums = new PdfArray([]);
  contentMapping.set('Nums', nums);
  const annotations: Array<[string, Dictionary]> = [];
  pages.forEach((page, pageNumber) => {
    const tags = pageStreams[pageNumber].tags ?? new Map();
    const pageBox = page.pageBox;
    // Prepare the array for this page's MCID-to-StructElem mapping.
    nums.push(pageNumber);
    const pageNums = new PdfArray([]);
    nums.push(pageNums);
    const pageMap = new Map<number, string>();
    const pageReference = pdf.pageReferences[pageNumber];
    const ctx: TagBuild = { pdf, nums: pageMap, annotations, pageReference, pageNumber };
    // Map the page box content.
    const elements = buildBoxTree(pageBox, structureDocument, ctx, tags);
    for (const element of elements) structOf(structureDocument).push(element.reference);
    if (tags.size) throw new Error('marked content left without a structure element');
    // Flatten the page-local nums into the global mapping.
    for (const [, ref] of [...pageMap.entries()].sort((a, b) => a[0] - b[0])) pageNums.push(ref);
  });

  // Add the annotations for links and widgets.
  const start = pages.length;
  annotations.forEach(([reference, annotation], index) => {
    const i = start + index;
    nums.push(i);
    nums.push(reference);
    annotation.set('StructParent', i);
  });

  // Required metadata.
  pdf.catalog.set('ViewerPreferences', new Dictionary({ DisplayDocTitle: 'true' }));
  pdf.catalog.set('MarkInfo', new Dictionary({ Marked: 'true' }));
  if (!pdf.catalog.has('Lang')) {
    LOGGER.error('Missing required "lang" attribute at the root of the document');
    pdf.catalog.set('Lang', new PdfString(''));
  }
}
