// SPDX-License-Identifier: BSD-3-Clause

/** Stacking contexts management (mirrors weasyprint/stacking.py). */
import * as boxes from './formatting_structure/boxes.ts';
import { AbsolutePlaceholder } from './layout/absolute.ts';

type AnyBox = any;

/**
 * Stacking contexts define the paint order of all pieces of a document.
 * https://www.w3.org/TR/CSS21/visuren.html#x43
 */
export class StackingContext {
  box: AnyBox;
  page: AnyBox;
  blockLevelBoxes: AnyBox[];
  floatContexts: StackingContext[];
  negativeZContexts: StackingContext[] = [];
  zeroZContexts: StackingContext[] = [];
  positiveZContexts: StackingContext[] = [];
  blocksAndCells: Map<AnyBox, any>;
  zIndex: number;

  constructor(box: AnyBox, childContexts: StackingContext[], blocks: AnyBox[], floats: StackingContext[],
    blocksAndCells: Map<AnyBox, any>, page: AnyBox) {
    this.box = box;
    this.page = page;
    this.blockLevelBoxes = blocks; // 4: In flow, non positioned
    this.floatContexts = floats; // 5: Non positioned
    this.blocksAndCells = blocksAndCells; // 7: Non positioned
    for (const context of childContexts) {
      if (context.zIndex < 0) this.negativeZContexts.push(context);
      else if (context.zIndex === 0) this.zeroZContexts.push(context);
      else this.positiveZContexts.push(context);
    }
    // Array.prototype.sort is stable, so lists are sorted by z-index, then tree order.
    this.negativeZContexts.sort((a, b) => a.zIndex - b.zIndex);
    this.positiveZContexts.sort((a, b) => a.zIndex - b.zIndex);
    const z = box.style.get('z_index');
    this.zIndex = z === 'auto' ? 0 : z;
  }

  static fromPage(page: AnyBox): StackingContext {
    // Page children (the box for the root element and margin boxes) as well as
    // the page box itself are unconditionally stacking contexts.
    const childContexts = page.children.map((child: AnyBox) => StackingContext.fromBox(child, page));
    // Children are sub-contexts, remove them from the "normal" tree.
    const bare = page.copyWithChildren([]);
    return new StackingContext(bare, childContexts, [], [], new Map(), bare);
  }

  static fromBox(box: AnyBox, page: AnyBox, childContexts: StackingContext[] | null = null): StackingContext {
    const children: StackingContext[] = []; // What will be passed to this box
    const contexts = childContexts ?? children;
    // contexts: where to put sub-contexts that we find here. May not be the same as children.
    const blocks: AnyBox[] = [];
    const floats: StackingContext[] = [];
    const blocksAndCells = new Map<AnyBox, any>();
    const newBox = dispatchChildren(box, page, contexts, blocks, floats, blocksAndCells);
    return new StackingContext(newBox, children, blocks, floats, blocksAndCells, page);
  }
}

function dispatch(box: AnyBox, page: AnyBox, childContexts: StackingContext[], blocks: AnyBox[], floats: StackingContext[],
  blocksAndCells: Map<AnyBox, any>): AnyBox | StackingContext | undefined {
  if (box instanceof AbsolutePlaceholder) box = box._box;
  const style = box.style;

  // Remove boxes defining a new stacking context from the children list.
  const transform = style.get('transform');
  const definesStackingContext = (
    (style.get('position') !== 'static' && style.get('z_index') !== 'auto') ||
    (box.isGridItem && style.get('z_index') !== 'auto') ||
    style.get('opacity') < 1 ||
    (transform && transform.length) || // 'transform: none' gives a "falsy" empty list
    style.get('overflow') !== 'visible');
  if (definesStackingContext) {
    childContexts.push(StackingContext.fromBox(box, page));
    return undefined;
  }

  if (style.get('position') !== 'static') {
    // "Fake" context: sub-contexts will go in this `childContexts` list.
    // Insert at the position before creating the sub-context.
    const index = childContexts.length;
    const stackingContext = StackingContext.fromBox(box, page, childContexts);
    childContexts.splice(index, 0, stackingContext);
    return undefined;
  } else if (box.isFloated()) {
    floats.push(StackingContext.fromBox(box, page, childContexts));
    return undefined;
  } else if (box instanceof boxes.InlineBlockBox || box instanceof boxes.InlineFlexBox || box instanceof boxes.InlineGridBox) {
    // Have this fake stacking context be part of the "normal" box tree,
    // because we need its position in the middle of a tree of inline boxes.
    return StackingContext.fromBox(box, page, childContexts);
  } else if (box.isBlockLevel) {
    const blocksIndex = blocks.length;
    const boxBlocksAndCells = new Map<AnyBox, any>();
    box = dispatchChildren(box, page, childContexts, blocks, floats, boxBlocksAndCells);
    blocks.splice(blocksIndex, 0, box);
    blocksAndCells.set(box, boxBlocksAndCells);
    return box;
  } else if (box instanceof boxes.TableCellBox) {
    const boxBlocksAndCells = new Map<AnyBox, any>();
    box = dispatchChildren(box, page, childContexts, blocks, floats, boxBlocksAndCells);
    blocksAndCells.set(box, boxBlocksAndCells);
    return box;
  }
  return dispatchChildren(box, page, childContexts, blocks, floats, blocksAndCells);
}

function dispatchChildren(box: AnyBox, page: AnyBox, childContexts: StackingContext[], blocks: AnyBox[],
  floats: StackingContext[], blocksAndCells: Map<AnyBox, any>): AnyBox {
  if (!box.isParent) return box;
  const newChildren: any[] = [];
  for (const child of box.children) {
    const result = dispatch(child, page, childContexts, blocks, floats, blocksAndCells);
    if (result !== undefined) newChildren.push(result);
  }
  return box.copyWithChildren(newChildren);
}