// SPDX-License-Identifier: BSD-3-Clause

/** Find anchors, links, bookmarks and inputs in documents (mirrors weasyprint/anchors.py). */
import * as boxes from './formatting_structure/boxes.ts';
import { percentage } from './layout/percent.ts';
import { Matrix } from './matrix.ts';

type AnyBox = any;

/** Apply a transformation matrix to an axis-aligned rectangle; return its bounding box (x1, y1, x2, y2). */
export function rectangleAabb(matrix: Matrix | null | undefined, posX: number, posY: number, width: number, height: number):
  [number, number, number, number] {
  if (!matrix) return [posX, posY, posX + width, posY + height];
  const [x1, y1] = matrix.transformPoint(posX, posY);
  const [x2, y2] = matrix.transformPoint(posX + width, posY);
  const [x3, y3] = matrix.transformPoint(posX, posY + height);
  const [x4, y4] = matrix.transformPoint(posX + width, posY + height);
  return [Math.min(x1, x2, x3, x4), Math.min(y1, y2, y3, y4), Math.max(x1, x2, x3, x4), Math.max(y1, y2, y3, y4)];
}

export type Link = [string, string, [number, number, number, number], AnyBox];
export type Bookmark = [number, string, [number, number], string];

/** Gather anchors and other data related to specific positions in PDF: anchors, links, bookmarks and forms. */
export function gatherAnchors(box: AnyBox, anchors: Map<string, [number, number, number, number]>, links: Link[],
  bookmarks: Bookmark[], forms: Map<AnyBox, Array<[AnyBox, number[]]>>, parentMatrix: Matrix | null = null,
  parentForm: AnyBox = null, parentLink: any = null): void {
  // Get box transformation matrix.
  // "Transforms apply to block-level and atomic inline-level elements, but do not apply to
  //  elements which may be split into multiple inline-level boxes."
  let matrix: Matrix | null;
  const transform = box.style.get('transform');
  if (transform && transform.length && !(box instanceof boxes.InlineBox)) {
    const borderWidth = box.borderWidth();
    const borderHeight = box.borderHeight();
    let [originX, originY] = box.style.get('transform_origin');
    const offsetX = percentage(originX, box.style, borderWidth);
    const offsetY = percentage(originY, box.style, borderHeight);
    originX = box.borderBoxX() + offsetX;
    originY = box.borderBoxY() + offsetY;

    let m = new Matrix(1, 0, 0, 1, originX, originY);
    for (const [name, args] of transform) {
      let a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
      if (name === 'scale') [a, d] = args;
      else if (name === 'rotate') {
        a = d = Math.cos(args);
        b = Math.sin(args);
        c = -b;
      } else if (name === 'translate') {
        e = percentage(args[0], box.style, borderWidth);
        f = percentage(args[1], box.style, borderHeight);
      } else if (name === 'skew') {
        b = Math.tan(args[1]);
        c = Math.tan(args[0]);
      } else [a, b, c, d, e, f] = args;
      m = new Matrix(a, b, c, d, e, f).matmul(m);
    }
    box.transformationMatrix = new Matrix(1, 0, 0, 1, -originX, -originY).matmul(m);
    matrix = parentMatrix ? box.transformationMatrix.matmul(parentMatrix) : box.transformationMatrix;
  } else matrix = parentMatrix;

  const bookmarkLabel = box.bookmarkLabel;
  const bookmarkLevel = box.style.get('bookmark_level') === 'none' ? null : box.style.get('bookmark_level');
  const state = box.style.get('bookmark_state');
  const link = box.link || parentLink;
  const anchorName = box.style.get('anchor');
  const hasBookmark = bookmarkLabel && bookmarkLevel;
  // 'link' is inherited but redundant on text boxes
  const hasLink = link && !(box instanceof boxes.TextBox || box instanceof boxes.LineBox);
  // In case of duplicate IDs, only the first is an anchor.
  const hasAnchor = anchorName && !anchors.has(anchorName);
  const isInput = box.isInput();

  if (box.isForm()) {
    parentForm = box;
    if (!forms.has(parentForm)) forms.set(parentForm, []);
  }

  if (hasBookmark || hasLink || hasAnchor || isInput) {
    let posX: number, posY: number, width: number, height: number;
    if (isInput) {
      posX = box.contentBoxX();
      posY = box.contentBoxY();
      width = box.width;
      height = box.height;
    } else [posX, posY, width, height] = box.hitArea();
    let rectangle: [number, number, number, number] | undefined;
    if (hasLink || isInput) rectangle = rectangleAabb(matrix, posX, posY, width, height);
    if (hasLink) {
      const [, tokenLink] = link;
      let [linkType, target] = tokenLink;
      if (linkType === 'external' && box.isAttachment()) linkType = 'attachment';
      links.push([linkType, target, rectangle as [number, number, number, number], box]);
    }
    if (isInput) {
      if (!forms.has(parentForm)) forms.set(parentForm, []);
      forms.get(parentForm)!.push([box, rectangle as number[]]);
    }
    if (hasBookmark) {
      if (matrix) [posX, posY] = matrix.transformPoint(posX, posY);
      bookmarks.push([bookmarkLevel, bookmarkLabel, [posX, posY], state]);
    }
    if (hasAnchor) {
      let [x1, y1, x2, y2] = [posX, posY, posX + width, posY + height];
      if (matrix) {
        [x1, y1] = matrix.transformPoint(x1, y1);
        [x2, y2] = matrix.transformPoint(x2, y2);
      }
      anchors.set(anchorName, [x1, y1, x2, y2]);
    }
  }

  for (const child of box.allChildren()) gatherAnchors(child, anchors, links, bookmarks, forms, matrix, parentForm, link);
}

export interface BookmarkSubtree {
  0: string;
  1: [number, number, number];
  2: BookmarkSubtree[];
  3: string;
}

/** Make a tree of all bookmarks in a given page. */
export function makePageBookmarkTree(page: { bookmarks: Bookmark[] }, skippedLevels: number[], lastByDepth: any[][],
  previousLevel: number, pageNumber: number, matrix: Matrix): number {
  for (const [level, label, [pointX0, pointY0], state] of page.bookmarks) {
    if (level > previousLevel) {
      // Example: if the previous bookmark is a <h2>, the next depth "should" be for <h3>.
      // If now we get a <h6> we're skipping two levels: append 6 - 3 - 1 = 2
      skippedLevels.push(level - previousLevel - 1);
    } else {
      let temp = level;
      while (temp < previousLevel) temp += 1 + (skippedLevels.pop() as number);
      if (temp > previousLevel) skippedLevels.push(temp - previousLevel - 1); // too many "skips", add some back
    }
    previousLevel = level;
    const depth = level - skippedLevels.reduce((a, b) => a + b, 0);
    const children: any[] = [];
    const [pointX, pointY] = matrix.transformPoint(pointX0, pointY0);
    const subtree = [label, [pageNumber, pointX, pointY], children, state];
    lastByDepth[depth - 1].push(subtree);
    lastByDepth.length = depth;
    lastByDepth.push(children);
  }
  return previousLevel;
}