// SPDX-License-Identifier: BSD-3-Clause

/** Insert anchors, links, bookmarks and inputs in PDFs (mirrors weasyprint/pdf/anchors.py). */
import { LOGGER } from '../logger.ts';
import type { Matrix } from '../matrix.ts';
import { Dictionary, PDF, PdfArray, PdfString, Stream } from './pydyf.ts';
import { writeAttachment } from './attachments.ts';

type AnyBox = any;

/** Include hyperlinks in given PDF page. */
/** Attachment state of a document: fetched bodies by URL, and the file specification written for each URL. */
export interface AttachmentState {
  bodies: Map<string, { body: Uint8Array; mimeType: string | null }>;
  files: Map<string, Dictionary | null>;
  compress: boolean;
}

export function addLinks(linksAndAnchors: [any[], Array<[string, number, number]>], matrix: Matrix, pdf: PDF, page: Dictionary,
  names: Array<[string, PdfArray]>, tags: Map<any, any> | null, attachments: AttachmentState | null = null): void {
  const [links, anchors] = linksAndAnchors;

  for (const [linkType, linkTarget, rectangle, box] of links) {
    const [x1, y1] = matrix.transformPoint(rectangle[0], rectangle[1]);
    const [x2, y2] = matrix.transformPoint(rectangle[2], rectangle[3]);
    if (linkType === 'attachment') {
      // Python: add_annotations. A FileAttachment annotation over the link; the file is embedded once per URL.
      if (attachments === null) continue;
      if (!attachments.files.has(linkTarget)) {
        const fetched = attachments.bodies.get(linkTarget);
        if (!fetched) {
          LOGGER.error(`Failed to load attachment: no content for ${linkTarget}`);
          attachments.files.set(linkTarget, null);
        } else {
          const download = box?.element?.get?.('download', null) ?? null;
          attachments.files.set(linkTarget, writeAttachment(pdf, {
            url: linkTarget, body: fetched.body, mimeType: fetched.mimeType, name: download, description: null,
          }, attachments.compress));
        }
      }
      const spec = attachments.files.get(linkTarget);
      if (!spec) continue;
      const rect = new PdfArray([x1, y1, x2, y2]);
      const stream = new Stream([], new Dictionary({
        Type: '/XObject', Subtype: '/Form', BBox: new PdfArray([x1, y1, x2, y2]),
      }), attachments.compress);
      pdf.addObject(stream);
      const annotation = new Dictionary({
        Type: '/Annot', Rect: rect, Subtype: '/FileAttachment', T: new PdfString(''), FS: spec.reference,
        AP: new Dictionary({ N: stream.reference }), AS: '/N',
      });
      pdf.addObject(annotation);
      if (!page.has('Annots')) page.set('Annots', new PdfArray());
      (page.get('Annots') as PdfArray).push(annotation.reference);
      continue;
    }
    if (linkType === 'internal' || linkType === 'external') {
      const annotation = new Dictionary({
        Type: '/Annot', Subtype: '/Link', Rect: new PdfArray([x1, y1, x2, y2]), BS: new Dictionary({ W: 0 }),
      });
      box.linkAnnotation = annotation;
      if (tags !== null) annotation.set('Contents', new PdfString(linkTarget));
      if (linkType === 'internal') annotation.set('Dest', new PdfString(linkTarget));
      else {
        annotation.set('A', new Dictionary({ Type: '/Action', S: '/URI', URI: new PdfString(linkTarget) }));
      }
      pdf.addObject(annotation);
      if (!page.has('Annots')) page.set('Annots', new PdfArray());
      (page.get('Annots') as PdfArray).push(annotation.reference);
    }
  }

  for (const [anchorName, x0, y0] of anchors) {
    const [x, y] = matrix.transformPoint(x0, y0);
    names.push([anchorName, new PdfArray([page.reference, '/XYZ', x, y, 0])]);
  }
}

/** Include bookmark outlines in PDF. */
export function addOutlines(pdf: PDF, bookmarks: any[], parent: Dictionary | null = null): [Dictionary[], number] {
  let count = bookmarks.length;
  const outlines: Dictionary[] = [];
  for (const [title, [page, x, y], children, state] of bookmarks) {
    const destination = new PdfArray([pdf.pageReferences[page], '/XYZ', x, y, 0]);
    const outline = new Dictionary({ Title: new PdfString(title), Dest: destination });
    pdf.addObject(outline);
    const [childrenOutlines, childrenCount] = addOutlines(pdf, children, outline);
    outline.set('Count', childrenCount);
    if (state === 'closed') outline.set('Count', (outline.get('Count') as number) * -1);
    else count += childrenCount;
    if (outlines.length) {
      outline.set('Prev', outlines[outlines.length - 1].reference);
      outlines[outlines.length - 1].set('Next', outline.reference);
    }
    if (childrenOutlines.length) {
      outline.set('First', childrenOutlines[0].reference);
      outline.set('Last', childrenOutlines[childrenOutlines.length - 1].reference);
    }
    if (parent !== null) outline.set('Parent', parent.reference);
    outlines.push(outline);
  }

  if (parent === null && outlines.length) {
    const outlinesDictionary = new Dictionary({
      Count: count, First: outlines[0].reference, Last: outlines[outlines.length - 1].reference,
    });
    pdf.addObject(outlinesDictionary);
    for (const outline of outlines) outline.set('Parent', outlinesDictionary.reference);
    pdf.catalog.set('Outlines', outlinesDictionary.reference);
  }
  return [outlines, count];
}

/**
 * Resolve internal hyperlinks. Links to a missing anchor are removed with a warning. If multiple anchors have the
 * same name, the first one is used.
 */
export function resolveLinks(pages: Array<{ anchors: Map<string, number[]>; links: any[] }>):
  Array<[any[], Array<[string, number, number]>]> {
  const anchors = new Set<string>();
  const pagedAnchors: Array<Array<[string, number, number]>> = [];
  for (const page of pages) {
    pagedAnchors.push([]);
    for (const [anchorName, [pointX, pointY]] of page.anchors) {
      if (!anchors.has(anchorName)) {
        pagedAnchors[pagedAnchors.length - 1].push([anchorName, pointX, pointY]);
        anchors.add(anchorName);
      }
    }
  }
  const result: Array<[any[], Array<[string, number, number]>]> = [];
  for (const page of pages) {
    const pageLinks: any[] = [];
    for (const link of page.links) {
      const [linkType, anchorName] = link;
      if (linkType === 'internal') {
        if (!anchors.has(anchorName)) LOGGER.error(`No anchor #${anchorName} for internal URI reference`);
        else pageLinks.push(link);
      } else pageLinks.push(link); // External link
    }
    result.push([pageLinks, pagedAnchors.shift() as Array<[string, number, number]>]);
  }
  return result;
}

export type { AnyBox };