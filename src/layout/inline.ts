// SPDX-License-Identifier: BSD-3-Clause

/** Layout for inline-level boxes (mirrors layout/inline.py). */
import { INHERITED } from '../css/properties.ts';
import * as boxes from '../formatting_structure/boxes.ts';
import { getFirstLetter } from '../formatting_structure/text.ts';
import { getTextEngine } from '../text/engine.ts';
import { strut } from '../text/line_break.ts';
import { checkMath } from '../css/math.ts';
import { AbsolutePlaceholder, absoluteLayout } from './absolute.ts';
import { blockContainerLayout, skipItem } from './block.ts';
import { flexLayout } from './flex.ts';
import { avoidCollisions, floatLayout } from './float.ts';
import { gridLayout } from './grid.ts';
import { handleLeader } from './leader.ts';
import { handleMinMaxWidth } from './min_max.ts';
import { percentage, resolveOnePercentage, resolvePercentages } from './percent.ts';
import { inlineMinContentWidth, shrinkToFit, trailingWhitespaceSize } from './preferred.ts';
import { inlineReplacedBoxLayout } from './replaced.ts';
import { findInFlowBaseline, tableWrapperWidth } from './table.ts';

type AnyBox = any;
type SkipStack = Record<number, any> | null | 'continue';
type FloatWidths = { left: number; right: number; [k: string]: number };
type LetterValue = string | boolean | null;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Iterator of ``[line, resumeAt]``: ``line`` is a laid-out LineBox with as much content as fits in the available width. */
export function* iterLineBoxes(
  context: any, box: AnyBox, positionYIn: number, bottomSpace: number, skipStackIn: SkipStack, containingBlock: AnyBox,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], firstLetterStyleIn: any, firstLineStyleIn: any,
): Generator<[AnyBox, SkipStack]> {
  let positionY = positionYIn;
  let skipStack = skipStackIn;
  let firstLetterStyle = firstLetterStyleIn;
  let firstLineStyle = firstLineStyleIn;
  resolvePercentages(box, containingBlock);
  if (skipStack === null) resolveOnePercentage(box, 'text_indent', containingBlock.width);
  else box.textIndent = 0;
  for (;;) {
    const [line, resumeAt] = getNextLinebox(
      context, box, positionY, bottomSpace, skipStack, containingBlock, absoluteBoxes, fixedBoxes, firstLetterStyle, firstLineStyle);
    firstLineStyle = null;
    if (line) {
      handleLeader(context, line, containingBlock);
      positionY = line.positionY + line.height;
    }
    if (line === null) return;
    yield [line, resumeAt];
    if (resumeAt === null) return;
    skipStack = resumeAt;
    box.textIndent = 0;
    firstLetterStyle = null;
  }
}

/**
 * Return next line from given linebox as ``[line, resumeAt]``, where ``line`` is a new linebox
 * copied from the original one, with replaced children. Takes care of excluded floating shapes.
 */
export function getNextLinebox(
  context: any, linebox: AnyBox, positionYIn: number, bottomSpace: number, skipStackIn: SkipStack, containingBlock: AnyBox,
  absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], firstLetterStyle: any, firstLineStyle: any,
): [AnyBox, SkipStack] {
  let positionY = positionYIn;
  let skipStack = skipFirstWhitespace(linebox, skipStackIn);
  if (skipStack === 'continue') return [null, null];

  skipStack = firstLetterToBox(linebox, skipStack, firstLetterStyle);

  linebox.positionY = positionY;

  if (context.excludedShapes.length) {
    // Width and height must be calculated to avoid floats.
    linebox.width = inlineMinContentWidth(context, linebox, true, skipStack, true);
    [linebox.height] = getTextEngine().metrics.strut(linebox.style);
  } else {
    // No float, width and height will be set by the lines.
    linebox.width = linebox.height = 0;
  }
  let positionX: number;
  let availableWidth: number;
  [positionX, positionY, availableWidth] = avoidCollisions(context, linebox, containingBlock, false);

  let candidateHeight = linebox.height;
  const excludedShapes = [...context.excludedShapes];

  let line: AnyBox;
  let resumeAt: SkipStack;
  const lineAbsolutes: AnyBox[] = [];
  const lineFixed: AnyBox[] = [];
  let linePlaceholders: AnyBox[] = [];
  let waitingFloats: AnyBox[] = [];
  for (;;) {
    const originalPositionX = (linebox.positionX = positionX);
    const originalPositionY = (linebox.positionY = positionY);
    const originalWidth = linebox.width;
    const maxX = positionX + availableWidth;
    positionX += linebox.textIndent;

    linePlaceholders = [];
    lineAbsolutes.length = 0;
    lineFixed.length = 0;
    waitingFloats = [];
    const lineChildren: Array<[number, AnyBox]> = [];

    let preservedLineBreak: boolean;
    [line, resumeAt, preservedLineBreak] = splitInlineBox(
      context, linebox, positionX, maxX, bottomSpace, skipStack, containingBlock, lineAbsolutes, lineFixed, linePlaceholders,
      waitingFloats, lineChildren, firstLetterStyle, firstLineStyle);
    linebox.width = line.width;
    linebox.height = line.height;

    if (isPhantomLinebox(line) && !preservedLineBreak) {
      line.height = 0;
      break;
    }

    removeLastWhitespace(context, line);

    const [, , newAvailableWidth] = avoidCollisions(context, linebox, containingBlock, false);
    let offsetX = textAlign(context, line, newAvailableWidth, resumeAt === null || preservedLineBreak);
    if (containingBlock.style.get('direction') === 'rtl') {
      offsetX *= -1;
      offsetX -= line.width;
    }

    const [bottom, top] = lineBoxVerticality(line);
    if (top === null || bottom === null) throw new Error('no vertical extents');
    line.baseline = -top;
    line.positionY = top;
    line.height = bottom - top;
    const offsetY = positionY - top;
    line.marginTop = 0;
    line.marginBottom = 0;

    line.translate(offsetX, offsetY);
    // Avoid floating point errors, as position_y - top + top != position_y.
    // Removing this line breaks the position == linebox.position test below (issue #583).
    line.positionY = positionY;

    if (line.height <= candidateHeight) break;
    candidateHeight = line.height;

    const newExcludedShapes = context.excludedShapes;
    context.excludedShapes = excludedShapes;
    [positionX, positionY, availableWidth] = avoidCollisions(context, line, containingBlock, false);

    if (firstLineStyle) {
      const firstLineBox = line.copyWithChildren(line.children);
      firstLineBox.elementTag += '::first-line';
      firstLineBox.style = firstLineBox.style.copy();
      for (const [key, value] of Object.entries(firstLineStyle)) firstLineBox.style.set(key, value);
      line.children = [firstLineBox];
      adjustLineHeight(firstLineBox);
    }

    let condition: boolean;
    if (containingBlock.style.get('direction') === 'ltr') {
      condition = positionX === originalPositionX && positionY === originalPositionY;
    } else {
      condition = positionX + line.width === originalPositionX + originalWidth && positionY === originalPositionY;
    }
    if (condition) {
      context.excludedShapes = newExcludedShapes;
      break;
    }
  }

  absoluteBoxes.push(...lineAbsolutes);
  fixedBoxes.push(...lineFixed);

  for (const placeholder of linePlaceholders) {
    // Python: placeholder.style.specified['display']. When `specified` is the style itself, upstream's
    // __missing__ computes the value on access; here that is get().
    const specifiedDisplay = placeholder.style.specified === placeholder.style
      ? placeholder.style.get('display') : placeholder.style.specified.display;
    if (specifiedDisplay.includes('inline')) {
      // Inline-level static position.
      placeholder.translate(0, positionY - placeholder.positionY);
    } else {
      // Block-level static position: at the start of the next line.
      placeholder.translate(line.positionX - placeholder.positionX, positionY + line.height - placeholder.positionY);
    }
  }

  const floatChildren: AnyBox[] = [];
  const waitingFloatsY = line.positionY + line.height;
  for (const waitingFloat of waitingFloats) {
    waitingFloat.positionY = waitingFloatsY;
    const [newWaitingFloat, waitingFloatResumeAt] = floatLayout(context, waitingFloat, containingBlock, absoluteBoxes, fixedBoxes, bottomSpace, null);
    floatChildren.push(newWaitingFloat);
    if (waitingFloatResumeAt) context.addBrokenOutOfFlow(newWaitingFloat, waitingFloat, containingBlock, waitingFloatResumeAt);
  }
  if (floatChildren.length) line.children = [...line.children, ...floatChildren];

  return [line, resumeAt!];
}

/** Return ``skipStack`` to start just after removable leading spaces (https://www.w3.org/TR/CSS21/text.html#white-space-model). */
export function skipFirstWhitespace(box: AnyBox, skipStack: SkipStack): SkipStack {
  let index: number;
  let nextSkipStack: SkipStack;
  if (skipStack === null) {
    index = 0;
    nextSkipStack = null;
  } else [index, nextSkipStack] = skipItem(skipStack as Record<number, any>);

  if (box instanceof boxes.TextBox) {
    if (nextSkipStack !== null) throw new Error('unexpected nested skip');
    const whiteSpace = box.style.get('white_space');
    let text = enc.encode(box.text);
    if (index === text.length) {
      // Starting at the end of the TextBox, no text to see: Continue.
      return 'continue';
    }
    if (['normal', 'nowrap', 'pre-line'].includes(whiteSpace)) {
      text = text.subarray(index);
      while (text.length && text[0] === 0x20) {
        index += 1;
        text = text.subarray(1);
      }
    }
    return index ? { [index]: null } : null;
  }

  if (box instanceof boxes.LineBox || box instanceof boxes.InlineBox) {
    if (index === 0 && !box.children.length) return null;
    let result = skipFirstWhitespace(box.children[index], nextSkipStack);
    if (result === 'continue') {
      index += 1;
      if (index >= box.children.length) return 'continue';
      result = skipFirstWhitespace(box.children[index], null);
    }
    return index || result ? { [index]: result } : null;
  }

  if (skipStack !== null) throw new Error(`unexpected skip inside ${box}`);
  return null;
}

/** Remove in place space characters at the end of a line; also reduces the width and position of the inline parents. */
export function removeLastWhitespace(context: any, line: AnyBox): void {
  const ancestors: AnyBox[] = [];
  let box = line;
  while (box instanceof boxes.LineBox || box instanceof boxes.InlineBox) {
    ancestors.push(box);
    if (!box.children.length) return;
    box = box.children[box.children.length - 1];
  }
  if (!(box instanceof boxes.TextBox && ['normal', 'nowrap', 'pre-line'].includes(box.style.get('white_space')))) return;
  const newText = box.text.replace(/ +$/, '');
  let spaceWidth: number;
  if (newText) {
    if (newText.length === box.text.length) return;
    box.text = newText;
    const [newBox, resume] = splitTextBox(context, box, null, 0);
    if (newBox === null) throw new Error('expected a box');
    if (resume !== null) throw new Error('expected no resume');
    spaceWidth = box.width - newBox.width;
    box.width = newBox.width;
  } else {
    spaceWidth = box.width;
    box.width = 0;
    box.text = '';
  }

  // RTL line, the trailing space is at the left of the box. We have to translate the
  // box to align the stripped text with the right edge of the box.
  if (box.pangoLayout.firstLineDirection % 2) {
    for (const child of line.children) child.translate(-spaceWidth, 0, true);
  }

  for (const ancestor of ancestors) ancestor.width -= spaceWidth;

  // TODO: All tabs (U+0009) are rendered as a horizontal shift that lines up the start edge of
  // the next glyph with the next tab stop. TODO: collapse trailing spaces/tabs with pre-wrap.
}

/** Create a box for the ::first-letter selector. */
export function firstLetterToBox(box: AnyBox, skipStackIn: SkipStack, firstLetterStyle: any): SkipStack {
  let skipStack = skipStackIn;
  if (firstLetterStyle && box.children.length) {
    // Some properties must be ignored in first-letter boxes.
    // https://drafts.csswg.org/selectors-3/#application-in-css. At least, position is ignored.
    firstLetterStyle.position = 'static';

    let firstLetter = '';
    const child = box.children[0];
    if (child instanceof boxes.TextBox) {
      const letterStyle = box.style.copy();
      for (const [key, value] of Object.entries(firstLetterStyle)) letterStyle.set(key, value);
      if (child.elementTag!.endsWith('::first-letter')) {
        const letterBox = new boxes.InlineBox(`${box.elementTag}::first-letter`, letterStyle, box.element, [child]);
        box.children = [letterBox, ...box.children.slice(1)];
      } else if (child.text) {
        let childSkipStack: any = null;
        if (skipStack) {
          [childSkipStack] = Object.values(skipStack);
          if (childSkipStack) {
            const [index] = Object.keys(childSkipStack).map(Number);
            child.text = [...child.text].slice(index).join('');
            skipStack = null;
          }
        }
        firstLetter = getFirstLetter(child.text);
        if (firstLetter) child.text = [...child.text].slice([...firstLetter].length).join('');
        if (firstLetter.replace(/^\n+/, '')) {
          // "This type of initial letter is similar to an inline-level element if its 'float'
          // property is 'none', otherwise it is similar to a floated element."
          const childrenStyle = letterStyle.anonymousStyle;
          let textBox: AnyBox;
          if (letterStyle.get('float') === 'none') {
            const letterBox = new boxes.InlineBox(`${box.elementTag}::first-letter`, letterStyle, box.element, []);
            textBox = new boxes.TextBox(`${box.elementTag}::first-letter`, childrenStyle, box.element, firstLetter);
            letterBox.children = [textBox];
            box.children = [letterBox, ...box.children];
          } else {
            const letterBox = new boxes.BlockBox(`${box.elementTag}::first-letter`, letterStyle, box.element, []);
            const lineBox = new boxes.LineBox(`${box.elementTag}::first-letter`, childrenStyle, box.element, []);
            letterBox.children = [lineBox];
            textBox = new boxes.TextBox(`${box.elementTag}::first-letter`, childrenStyle, box.element, firstLetter);
            lineBox.children = [textBox];
            box.children = [letterBox, ...box.children];
          }
          textBox.processTextTransform();
          if (skipStack && childSkipStack) {
            const [index] = Object.keys(skipStack).map(Number);
            const [childIndex, grandchildSkipStack] = skipItem(childSkipStack);
            skipStack = { [index]: { [childIndex + 1]: grandchildSkipStack } };
          }
        }
      }
    } else if (child.isParent) {
      let childSkipStack: any = null;
      if (skipStack) [childSkipStack] = Object.values(skipStack);
      childSkipStack = firstLetterToBox(child, childSkipStack, firstLetterStyle);
      if (skipStack) {
        const [index] = Object.keys(skipStack).map(Number);
        skipStack = { [index]: childSkipStack };
      }
    }
  }
  return skipStack;
}

/** Compute the width and the height of the atomic ``box``. */
export function atomicBox(
  context: any, boxIn: AnyBox, positionX: number, skipStack: SkipStack, containingBlock: AnyBox, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
): AnyBox {
  let box = boxIn;
  if (box instanceof boxes.ReplacedBox) {
    box = box.copy();
    inlineReplacedBoxLayout(box, containingBlock);
    box.baseline = box.marginHeight();
  } else if (box instanceof boxes.InlineBlockBox) {
    let width = 0;
    let minWidth = 0;
    let maxWidth = 0;
    if (box.isTableWrapper) {
      tableWrapperWidth(context, box, [containingBlock.width, containingBlock.height]);
      [width, minWidth, maxWidth] = [box.width, box.minWidth, box.maxWidth];
    }
    box = inlineBlockBoxLayout(context, box, positionX, skipStack, containingBlock, absoluteBoxes, fixedBoxes);
    if (box.isTableWrapper) [box.width, box.minWidth, box.maxWidth] = [width, minWidth, maxWidth];
  } else throw new TypeError(`Layout for ${box.constructor.name} not handled yet`);
  return box;
}

export function inlineBlockBoxLayout(
  context: any, boxIn: AnyBox, positionX: number, skipStack: SkipStack, containingBlock: AnyBox, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
): AnyBox {
  let box = boxIn;
  resolvePercentages(box, containingBlock);

  // https://www.w3.org/TR/CSS21/visudet.html#inlineblock-width
  if (box.marginLeft === 'auto') box.marginLeft = 0;
  if (box.marginRight === 'auto') box.marginRight = 0;
  // https://www.w3.org/TR/CSS21/visudet.html#block-root-margin
  if (box.marginTop === 'auto') box.marginTop = 0;
  if (box.marginBottom === 'auto') box.marginBottom = 0;

  inlineBlockWidth(box, context, containingBlock);

  box.positionX = positionX;
  box.positionY = 0;
  [box] = blockContainerLayout(context, box, -Infinity, skipStack as any, true, absoluteBoxes, fixedBoxes, null, null, null, false, null);
  box.baseline = inlineBlockBaseline(box);
  return box;
}

/** Y position of the baseline for an inline block, from the top of its margin box. */
export function inlineBlockBaseline(box: AnyBox): number {
  if (box.isTableWrapper) {
    // Inline table's baseline is its first row's baseline.
    for (const child of box.children) {
      if (child instanceof boxes.TableBox) {
        if (child.children.length && child.children[0].children.length) {
          return child.children[0].children[0].baseline;
        }
      }
    }
  } else if (box.style.get('overflow') === 'visible') {
    const result = findInFlowBaseline(box, true);
    if (result) return result;
  }
  return box.positionY + box.marginHeight();
}

export const inlineBlockWidth = handleMinMaxWidth((box: AnyBox, context: any, containingBlock: AnyBox) => {
  const availableContentWidth = containingBlock.width - (
    box.marginLeft + box.marginRight + box.borderLeftWidth + box.borderRightWidth + box.paddingLeft + box.paddingRight);
  if (box.width === 'auto') box.width = shrinkToFit(context, box, availableContentWidth);
});

/**
 * Fit as much content as possible from an inline-level box in a width.
 *
 * Return ``[newBox, resumeAt, preservedLineBreak, firstLetter, lastLetter, floatWidths]``.
 * ``resumeAt`` is ``null`` if all of the content fits; otherwise it can be passed as a
 * ``skipStack`` parameter to resume where we left off.
 */
export function splitInlineLevel(
  context: any, boxIn: AnyBox, positionX: number, maxX: number, bottomSpace: number, skipStackIn: SkipStack,
  containingBlock: AnyBox, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], linePlaceholders: AnyBox[],
  waitingFloats: AnyBox[], lineChildren: Array<[number, AnyBox]>, firstLetterStyle: any, firstLineStyle: any,
): [AnyBox, SkipStack, boolean, LetterValue, LetterValue, FloatWidths] {
  let box = boxIn;
  let skipStack = skipStackIn;
  if (firstLineStyle) {
    box = box.copy();
    box.style = box.style.copy();
    for (const [key, value] of Object.entries(firstLineStyle)) if (INHERITED.has(key)) box.style.set(key, value);
    box.processTextTransform();
  }
  resolvePercentages(box, containingBlock);
  let floatWidths: FloatWidths = { left: 0, right: 0 };
  let newBox: AnyBox;
  let resumeAt: SkipStack;
  let preservedLineBreak: boolean;
  let firstLetter: LetterValue;
  let lastLetter: LetterValue;
  if (box instanceof boxes.TextBox) {
    box.positionX = positionX;
    let skip: number;
    if (skipStack === null) skip = 0;
    else {
      [skip, skipStack] = skipItem(skipStack as Record<number, any>);
      skip = skip || 0;
      if (skipStack !== null) throw new Error('unexpected nested skip stack');
    }
    const isLineStart = lineChildren.length === 0;
    let skipNext: number | null;
    [newBox, skipNext, preservedLineBreak] = splitTextBox(context, box, maxX - positionX, skip, isLineStart);
    resumeAt = skipNext === null ? null : { [skipNext]: null };
    if (box.text) {
      firstLetter = [...box.text][0];
      if (skipNext === null) lastLetter = [...box.text].slice(-1)[0];
      else lastLetter = [...dec.decode(enc.encode(box.text).subarray(0, skipNext))].slice(-1)[0];
    } else firstLetter = lastLetter = null;
  } else if (box instanceof boxes.InlineBox) {
    if (box.marginLeft === 'auto') box.marginLeft = 0;
    if (box.marginRight === 'auto') box.marginRight = 0;
    [newBox, resumeAt, preservedLineBreak, firstLetter, lastLetter, floatWidths] = splitInlineBox(
      context, box, positionX, maxX, bottomSpace, skipStack, containingBlock, absoluteBoxes, fixedBoxes, linePlaceholders,
      waitingFloats, lineChildren, firstLetterStyle, firstLineStyle);
  } else if (box.isAtomicInline) {
    newBox = atomicBox(context, box, positionX, skipStack, containingBlock, absoluteBoxes, fixedBoxes);
    newBox.positionX = positionX;
    resumeAt = null;
    preservedLineBreak = false;
    // See https://www.w3.org/TR/css-text-3/#line-breaking: atomic inlines behave like ideographic characters.
    firstLetter = '⺀';
    lastLetter = '⺀';
  } else if (box instanceof boxes.InlineFlexBox) {
    box.positionX = positionX;
    box.positionY = 0;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (box[`margin${side}`] === 'auto') box[`margin${side}`] = 0;
    [newBox, resumeAt] = flexLayout(context, box, -Infinity, skipStack, containingBlock, false, absoluteBoxes, fixedBoxes, false);
    preservedLineBreak = false;
    firstLetter = '⺀';
    lastLetter = '⺀';
  } else if (box instanceof boxes.InlineGridBox) {
    box.positionX = positionX;
    box.positionY = 0;
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (box[`margin${side}`] === 'auto') box[`margin${side}`] = 0;
    [newBox, resumeAt] = gridLayout(context, box, -Infinity, skipStack, containingBlock, false, absoluteBoxes, fixedBoxes);
    preservedLineBreak = false;
    firstLetter = '⺀';
    lastLetter = '⺀';
  } else throw new TypeError(`Layout for ${box.constructor.name} not handled yet`);
  return [newBox, resumeAt, preservedLineBreak, firstLetter, lastLetter, floatWidths];
}

type Waiting = [number, AnyBox, AnyBox];

function outOfFlowLayout(
  context: any, box: AnyBox, containingBlock: AnyBox, index: number, childIn: AnyBox, children: Waiting[], lineChildren: Array<[number, AnyBox]>,
  waitingChildren: Waiting[], waitingFloats: AnyBox[], absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[], linePlaceholders: AnyBox[],
  floatWidths: FloatWidths, maxXIn: { v: number }, positionXIn: { v: number }, bottomSpace: number,
): void {
  // Python passes max_x and position_x by value: the `position_x += dx` / `max_x -= dx` below only change these
  // local copies and never reach split_inline_box (the caller subtracts the float width from max_x itself).
  const maxX = { v: maxXIn.v };
  const positionX = { v: positionXIn.v };
  let child = childIn;
  if (child.isAbsolutelyPositioned()) {
    child.positionX = positionX.v;
    const placeholder = new AbsolutePlaceholder(child);
    linePlaceholders.push(placeholder);
    waitingChildren.push([index, placeholder, child]);
    if (child.style.get('position') === 'absolute') absoluteBoxes.push(placeholder);
    else fixedBoxes.push(placeholder);
  } else if (child.isFloated()) {
    child.positionX = positionX.v;
    let floatWidth = shrinkToFit(context, child, containingBlock.width);

    // To retrieve the real available space for floats, we must remove the trailing whitespaces from the line.
    const nonFloatingChildren = [...children, ...waitingChildren].map(([, c]) => c).filter((c) => !c.isFloated());
    if (nonFloatingChildren.length) floatWidth -= trailingWhitespaceSize(context, nonFloatingChildren[nonFloatingChildren.length - 1]);

    if (floatWidth > maxX.v - positionX.v || waitingFloats.length) {
      // TODO: the absolute and fixed boxes in the floats must be added here, and not in iter_line_boxes.
      waitingFloats.push(child);
    } else {
      const [newChild, floatResumeAt] = floatLayout(context, child, containingBlock, absoluteBoxes, fixedBoxes, bottomSpace, null);
      if (floatResumeAt) context.addBrokenOutOfFlow(child, child, containingBlock, floatResumeAt);
      waitingChildren.push([index, newChild, child]);
      child = newChild;

      // Translate previous line children.
      const dx = Math.max(child.marginWidth(), 0);
      floatWidths[child.style.get('float')] = (floatWidths[child.style.get('float')] ?? 0) + dx;

      let floatLeft = child.style.get('float') === 'left';
      let floatRight = child.style.get('float') === 'right';
      if (box.style.get('direction') === 'ltr') {
        if (child.style.get('float') === 'inline-start') floatLeft = true;
        if (child.style.get('float') === 'inline-end') floatRight = true;
      } else {
        if (child.style.get('float') === 'inline-start') floatRight = true;
        if (child.style.get('float') === 'inline-end') floatLeft = true;
      }

      if (floatLeft) {
        // The parent is the line, update the current position for the next child. When the parent is
        // not the line (it is an inline block), the current position of the line is updated by the box
        // itself (see next split_inline_level call).
        if (box instanceof boxes.LineBox) positionX.v += dx;
      } else if (floatRight) {
        // Update the maximum x position for the next children.
        maxX.v -= dx;
      }
      for (const [, oldChild] of lineChildren) {
        if (!oldChild.isInNormalFlow()) continue;
        const floatAlign = (floatLeft && box.style.get('direction') === 'ltr') || (floatRight && box.style.get('direction') === 'rtl');
        if (floatAlign) oldChild.translate(dx, 0);
      }
    }
  } else if (child.isRunning() || child.isNote()) {
    context.addRunningElement(child);
  }
}

function breakWaitingChildren(
  context: any, box: AnyBox, _maxX: number, bottomSpace: number, initialSkipStack: any, absoluteBoxes: AnyBox[], fixedBoxes: AnyBox[],
  linePlaceholders: AnyBox[], waitingFloats: AnyBox[], lineChildren: Array<[number, AnyBox]>, children: Waiting[], waitingChildren: Waiting[],
  firstLetterStyle: any, firstLineStyle: any,
): SkipStack {
  if (waitingChildren.length) {
    // Too wide, try to cut inside waiting children, starting from the end.
    // TODO: we should take care of children added into absolute_boxes, fixed_boxes and other lists.
    const waitingChildrenCopy = [...waitingChildren];
    while (waitingChildrenCopy.length) {
      const [childIndex, child, originalChild] = waitingChildrenCopy.pop()!;
      if (!child.isInNormalFlow() || !canBreakInside(child)) continue;

      const childSkipStack = initialSkipStack && childIndex in initialSkipStack ? initialSkipStack[childIndex] : null;

      // Break the waiting child at its last possible breaking point.
      // TODO: The dirty solution chosen here is to decrease the actual size by 1 and render the
      // waiting child again with this constraint. We may find a better way.
      let maxX = child.positionX + child.marginWidth() - 1;
      let newChild: AnyBox = null;
      let childResumeAt: SkipStack = null;
      let found = false;
      while (maxX > child.positionX) {
        [newChild, childResumeAt] = splitInlineLevel(
          context, originalChild, child.positionX, maxX, bottomSpace, childSkipStack, box, absoluteBoxes, fixedBoxes,
          linePlaceholders, waitingFloats, lineChildren, firstLetterStyle, firstLineStyle);
        if (childResumeAt) {
          found = true;
          break;
        }
        maxX -= 1;
      }
      if (!found) continue; // No line break found

      children.push(...waitingChildrenCopy);
      if (newChild === null) {
        // May be null where we have an empty TextBox.
        if (!(child instanceof boxes.TextBox)) throw new Error('expected a TextBox');
      } else children.push([childIndex, newChild, child]);

      return { [childIndex]: childResumeAt };
    }
  }

  if (children.length) {
    // Too wide, can't break waiting children and the inline is non-empty: put child entirely on the next line.
    return { [children[children.length - 1][0] + 1]: null };
  }
  return null;
}

/** Set margins to the half leading to respect line height, compensating borders and padding (margin_height() == line_height). */
function adjustLineHeight(box: AnyBox): void {
  let lineHeight: number;
  [lineHeight, box.baseline] = getTextEngine().metrics.strut(box.style);
  box.height = box.style.get('font_size');
  const halfLeading = (lineHeight - box.height) / 2;
  box.marginTop = halfLeading - box.borderTopWidth - box.paddingTop;
  box.marginBottom = halfLeading - box.borderBottomWidth - box.paddingBottom;
}

/**
 * Fit as much content as possible from an inline box in a width. Returns
 * ``[newBox, resumeAt, preservedLineBreak, firstLetter, lastLetter, floatWidths]``.
 * This is the recursive step that loops over the children of the box; base steps of
 * recursion are handled by ``splitInlineLevel()``. Excluded floating shapes are ignored.
 */
export function splitInlineBox(
  context: any, box: AnyBox, positionXIn: number, maxXIn: number, bottomSpace: number, skipStackIn: SkipStack, containingBlock: AnyBox,
  absoluteBoxesIn: AnyBox[], fixedBoxes: AnyBox[], linePlaceholders: AnyBox[], waitingFloats: AnyBox[],
  lineChildren: Array<[number, AnyBox]>, firstLetterStyle: any, firstLineStyle: any,
): [AnyBox, SkipStack, boolean, LetterValue, LetterValue, FloatWidths] {
  let absoluteBoxes = absoluteBoxesIn;
  let skipStack = skipStackIn;
  // In some cases (shrink-to-fit result being the preferred width) max_x is coming from Pango
  // itself, but floating point errors have accumulated: width2 = (width + X) - X, in some cases
  // width2 < width. Increase the value a bit to compensate and not introduce an unexpected line
  // break. The 1e-9 value comes from PEP 485.
  const maxX = { v: maxXIn * (1 + 1e-9) };
  const positionX = { v: positionXIn };

  const isStart = skipStack === null;
  const initialPositionX = positionXIn;
  const initialSkipStack = skipStack;
  if (!(box instanceof boxes.LineBox || box instanceof boxes.InlineBox)) throw new Error('expected a line or inline box');
  const leftSpacing = box.paddingLeft + box.marginLeft + box.borderLeftWidth;
  const rightSpacing = box.paddingRight + box.marginRight + box.borderRightWidth;

  let children: Waiting[] = [];
  let waitingChildren: Waiting[] = [];
  let preservedLineBreak = false;
  let firstLetter: LetterValue = null;
  let lastLetter: LetterValue = null;
  const floatWidths: FloatWidths = { left: 0, right: 0 };
  let floatResumeIndex = 0;

  if (box.style.get('position') === 'relative') absoluteBoxes = [];

  let skip: number;
  if (isStart) skip = 0;
  else [skip, skipStack] = skipItem(skipStack as Record<number, any>);

  let resumeAt: SkipStack = null;
  let broke = false;
  const list = box.children.slice(skip);
  for (let i = 0; i < list.length; i++) {
    const child = list[i];
    const index = i + skip;
    child.positionY = box.positionY;

    if (!child.isInNormalFlow()) {
      outOfFlowLayout(
        context, box, containingBlock, index, child, children, lineChildren, waitingChildren, waitingFloats, absoluteBoxes,
        fixedBoxes, linePlaceholders, floatWidths, maxX, positionX, bottomSpace);
      if (child.isFloated()) {
        floatResumeIndex = index + 1;
        if (!waitingFloats.includes(child)) maxX.v -= child.marginWidth();
      }
      continue;
    }

    const isLastChild = index === box.children.length - 1;
    let availableWidth = maxX.v;
    const childWaitingFloats: AnyBox[] = [];
    let newChild: AnyBox;
    let preserved: boolean;
    let first: LetterValue;
    let last: LetterValue;
    let newFloatWidths: FloatWidths;
    [newChild, resumeAt, preserved, first, last, newFloatWidths] = splitInlineLevel(
      context, child, positionX.v, availableWidth, bottomSpace, skipStack, containingBlock, absoluteBoxes, fixedBoxes,
      linePlaceholders, childWaitingFloats, lineChildren, firstLetterStyle, firstLineStyle);
    let endSpacing: number;
    if (box.style.get('direction') === 'rtl') {
      endSpacing = leftSpacing;
      maxX.v -= newFloatWidths.left;
    } else {
      endSpacing = rightSpacing;
      maxX.v -= newFloatWidths.right;
    }
    if (isLastChild && endSpacing && resumeAt === null) {
      // TODO: we should take care of children added into absolute_boxes, fixed_boxes and other lists.
      availableWidth -= endSpacing;
      [newChild, resumeAt, preserved, first, last, newFloatWidths] = splitInlineLevel(
        context, child, positionX.v, availableWidth, bottomSpace, skipStack, containingBlock, absoluteBoxes, fixedBoxes,
        linePlaceholders, childWaitingFloats, lineChildren, firstLetterStyle, firstLineStyle);
    }

    floatWidths.left = Math.max(floatWidths.left, newFloatWidths.left);
    floatWidths.right = Math.max(floatWidths.right, newFloatWidths.right);

    skipStack = null;
    if (preserved) preservedLineBreak = true;

    let canBreak: boolean | null = null;
    if (lastLetter === true) lastLetter = ' ';
    else if (lastLetter === false) lastLetter = '\u00a0'; // no-break space
    else if (['pre', 'nowrap'].includes(box.style.get('white_space'))) canBreak = false;
    if (canBreak === null) {
      if (lastLetter === null || first === null) canBreak = false;
      else if (first === true || first === false) canBreak = first;
      else canBreak = getTextEngine().canBreakText((lastLetter as string) + first, child.style.get('lang'));
    }

    if (canBreak) {
      children.push(...waitingChildren);
      waitingChildren = [];
    }

    if (firstLetter === null) firstLetter = first;
    if (child.trailingCollapsibleSpace) lastLetter = true;
    else lastLetter = last;

    if (newChild === null) {
      // May be null where we have an empty TextBox.
      if (!(child instanceof boxes.TextBox)) throw new Error('expected a TextBox');
    } else {
      // Store lines to get previous break points.
      if (box instanceof boxes.LineBox) lineChildren.push([index, newChild]);

      // Check that text doesn't overflow.
      const newPositionX = newChild.positionX + newChild.marginWidth();
      if (newPositionX > maxX.v) {
        // Only calculate trailing space size if needed.
        const trailingSpace = trailingWhitespaceSize(context, newChild);
        if (newPositionX - trailingSpace > maxX.v) {
          // Text overflows, find previous break point.
          const previousResumeAt = breakWaitingChildren(
            context, containingBlock, maxX.v, bottomSpace, initialSkipStack, absoluteBoxes, fixedBoxes, linePlaceholders,
            waitingFloats, lineChildren, children, waitingChildren, firstLetterStyle, firstLineStyle);
          if (previousResumeAt) {
            resumeAt = previousResumeAt;
            broke = true;
            break;
          }
        }
      }
      positionX.v = newPositionX;
      waitingChildren.push([index, newChild, child]);
    }

    waitingFloats.push(...childWaitingFloats);
    if (resumeAt !== null) {
      children.push(...waitingChildren);
      resumeAt = { [index]: resumeAt };
      broke = true;
      break;
    }
  }
  if (!broke) {
    children.push(...waitingChildren);
    resumeAt = null;
  }

  // Reorder inline blocks when direction is right-to-left.
  if (box.style.get('direction') === 'rtl' && children.length > 1) {
    const inFlowChildren = children.map(([, c]) => c).filter((c) => c.isInNormalFlow());
    let px = inFlowChildren[0].positionX;
    for (const child of [...inFlowChildren].reverse()) {
      child.translate(px - child.positionX, 0, true);
      px += child.marginWidth();
    }
  }

  // Remove decoration.
  const isEnd = resumeAt === null;
  const newBox = box.copyWithChildren(children.map(([, c]) => c));
  newBox.removeDecoration(!isStart, !isEnd);

  // Translate boxes to respect box decoration and floats.
  if (!(box instanceof boxes.LineBox)) {
    newBox.positionX = initialPositionX;
    const leftDecoration = leftSpacing && (box.style.get('box_decoration_break') === 'clone' || (box.style.get('direction') === 'ltr' ? isStart : isEnd));
    if (leftDecoration) for (const child of newBox.children) child.translate(leftSpacing, 0);
    newBox.translate(floatWidths.left, 0, true);
  }

  // Reset line box width according to its new children.
  newBox.width = 0;
  let kids = newBox.children;
  if (newBox.style.get('direction') === 'ltr') kids = [...kids].reverse();
  for (const child of kids) {
    if (child.isInNormalFlow()) {
      newBox.width = child.positionX + child.marginWidth() - newBox.contentBoxX();
      break;
    }
  }

  adjustLineHeight(newBox);

  if (newBox.style.get('position') === 'relative') {
    for (const absoluteBox of absoluteBoxes) absoluteLayout(context, absoluteBox, newBox, fixedBoxes, bottomSpace, null);
  }

  if (resumeAt !== null) {
    const index = Number(Object.keys(resumeAt)[0]);
    if (index < floatResumeIndex) resumeAt = { [floatResumeIndex]: null };
  }

  if (box.isLeader) {
    firstLetter = true;
    lastLetter = false;
  }

  return [newBox, resumeAt, preservedLineBreak, firstLetter, lastLetter, floatWidths];
}

/**
 * Keep as much text as possible from a TextBox in a limited width. Try not to overflow but always
 * have some text in ``newBox``. Returns ``[newBox, skip, preservedLineBreak]``; ``skip`` is the number
 * of UTF-8 bytes to skip from the start of the TextBox for the next line, or null if all fits.
 */
export function splitTextBox(
  context: any, boxIn: AnyBox, availableWidth: number | null, skip: number, isLineStart = true,
): [AnyBox, number | null, boolean] {
  let box = boxIn;
  if (!(box instanceof boxes.TextBox)) throw new Error('expected a TextBox');
  const fontSize = box.style.get('font_size');
  const text = enc.encode(box.text).subarray(skip);
  if (fontSize === 0 || !text.length) return [null, null, false];
  let [layout, length, resumeIndex, width, height, baseline] = getTextEngine().firstLine(
    dec.decode(text), box.style, context, availableWidth, box.justificationSpacing, isLineStart);
  if (resumeIndex === 0) throw new Error('resume_index must not be 0');

  if (length > 0) {
    box = box.copyWithText(layout.text);
    box.width = width;
    box.pangoLayout = layout;
    // "The height of the content area should be based on the font, but this specification does
    // not specify how." We trust Pango and use the height of the LayoutLine.
    box.height = height;
    // "only the 'line-height' is used when calculating the height of the line box."
    // Set margins so that margin_height() == line_height.
    const [lineHeight] = getTextEngine().metrics.strut(box.style);
    const halfLeading = (lineHeight - height) / 2;
    box.marginTop = halfLeading;
    box.marginBottom = halfLeading;
    // from the top of the content box
    box.baseline = baseline;
    // from the top of the margin box
    box.baseline += box.marginTop;
  } else box = null;

  let preservedLineBreak: boolean;
  if (resumeIndex === null) preservedLineBreak = false;
  else {
    const between = dec.decode(text.subarray(length, resumeIndex));
    preservedLineBreak = length !== resumeIndex && Boolean(between.replace(/^ +| +$/g, ''));
    if (preservedLineBreak) {
      // See https://unicode.org/reports/tr14/ (\r is already handled by process_whitespace).
      const lineBreaks = ['\n', '\t', '\f', '\u0085', '\u2028', '\u2029'];
      if (!lineBreaks.includes(between)) throw new Error(`Got ${JSON.stringify(between)} between two lines. Expected nothing or a preserved line break`);
    }
    resumeIndex += skip;
  }
  return [box, resumeIndex, preservedLineBreak];
}

/**
 * Handle ``vertical-align`` within a LineBox: place all boxes vertically assuming that the
 * baseline of ``box`` is at ``y = 0``. Returns ``[maxY, minY]`` of margin boxes.
 */
export function lineBoxVerticality(box: AnyBox): [number | null, number | null] {
  const topBottomSubtrees: AnyBox[] = [];
  let [maxY, minY]: [number | null, number | null] = alignedSubtreeVerticality(box, topBottomSubtrees, 0);
  const subtreesWithMinMax: Array<[AnyBox, number | null, number | null]> = [];
  // Python iterates a list that grows while looping (list comprehension over top_bottom_subtrees).
  for (const subtree of topBottomSubtrees) {
    if (subtree.isFloated()) subtreesWithMinMax.push([subtree, null, null]);
    else {
      const [subMax, subMin] = alignedSubtreeVerticality(subtree, topBottomSubtrees, 0);
      subtreesWithMinMax.push([subtree, subMax, subMin]);
    }
  }

  if (subtreesWithMinMax.length) {
    const subPositions = subtreesWithMinMax.filter(([s]) => !s.isFloated()).map(([, a, b]) => (a as number) - (b as number));
    if (subPositions.length) {
      const highestSub = Math.max(...subPositions);
      maxY = Math.max(maxY as number, (minY as number) + highestSub);
    }
  }

  for (const [subtree, subMaxY, subMinY] of subtreesWithMinMax) {
    let dy: number;
    if (subtree.isFloated()) dy = (minY as number) - subtree.positionY;
    else if (subtree.style.get('vertical_align') === 'top') dy = (minY as number) - (subMinY as number);
    else dy = (maxY as number) - (subMaxY as number);
    translateSubtree(subtree, dy);
  }
  return [maxY, minY];
}

export function translateSubtree(box: AnyBox, dy: number): void {
  if (box instanceof boxes.InlineBox) {
    box.positionY += dy;
    if (['top', 'bottom'].includes(box.style.get('vertical_align'))) for (const child of box.children) translateSubtree(child, dy);
  } else box.translate(0, dy); // Text or atomic boxes
}

export function alignedSubtreeVerticality(box: AnyBox, topBottomSubtrees: AnyBox[], baselineY: number): [number, number] {
  let [maxY, minY] = inlineBoxVerticality(box, topBottomSubtrees, baselineY);
  // Account for the line box itself.
  const top = baselineY - box.baseline;
  const bottom = top + box.marginHeight();
  if (minY === null || top < minY) minY = top;
  if (maxY === null || bottom > maxY) maxY = bottom;
  return [maxY as number, minY as number];
}

/**
 * Handle ``vertical-align`` within an InlineBox: place all boxes vertically assuming that the
 * baseline of ``box`` is at ``y = baselineY``. Returns ``[maxY, minY]`` of margin boxes.
 */
export function inlineBoxVerticality(box: AnyBox, topBottomSubtrees: AnyBox[], baselineY: number): [number | null, number | null] {
  let maxY: number | null = null;
  let minY: number | null = null;
  if (!(box instanceof boxes.LineBox || box instanceof boxes.InlineBox)) return [maxY, minY];

  for (const child of box.children) {
    if (!child.isInNormalFlow()) {
      if (child.isFloated()) topBottomSubtrees.push(child);
      continue;
    }
    const verticalAlign = child.style.get('vertical_align');
    let childBaselineY: number;
    if (verticalAlign === 'baseline') childBaselineY = baselineY;
    else if (verticalAlign === 'middle') {
      const oneEx = box.style.get('font_size') * getTextEngine().metrics.characterRatio(box.style, 'ex');
      const top = baselineY - (oneEx + child.marginHeight()) / 2;
      childBaselineY = top + child.baseline;
    } else if (verticalAlign === 'text-top') {
      // align top with the top of the parent's content area
      const top = baselineY - box.baseline + box.marginTop + box.borderTopWidth + box.paddingTop;
      childBaselineY = top + child.baseline;
    } else if (verticalAlign === 'text-bottom') {
      // align bottom with the bottom of the parent's content area
      const bottom = baselineY - box.baseline + box.marginTop + box.borderTopWidth + box.paddingTop + box.height;
      childBaselineY = bottom - child.marginHeight() + child.baseline;
    } else if (verticalAlign === 'top' || verticalAlign === 'bottom') {
      // TODO: actually implement vertical-align: top and bottom. Later, we will assume for this
      // subtree that its baseline is at y=0.
      childBaselineY = 0;
    } else if (checkMath(verticalAlign)) {
      // Python: check_math(vertical_align) — percentages refer to the strut height.
      const [height] = strut(box.style);
      childBaselineY = baselineY - percentage(verticalAlign, box.style, height);
    } else {
      // Numeric value: the child's baseline is `vertical_align` above (lower y) the parent's baseline.
      childBaselineY = baselineY - verticalAlign;
    }

    // the child's `top` is `child.baseline` above (lower y) its baseline.
    const top = childBaselineY - child.baseline;
    if (child instanceof boxes.InlineBlockBox || child instanceof boxes.InlineFlexBox || child instanceof boxes.InlineGridBox) {
      // This also includes table wrappers for inline tables.
      child.translate(0, top - child.positionY);
    } else {
      child.positionY = top;
      // grand-children for inline boxes are handled below
    }

    if (verticalAlign === 'top' || verticalAlign === 'bottom') {
      // top or bottom are special, they need to be handled in a later pass.
      topBottomSubtrees.push(child);
      continue;
    }

    const bottom = top + child.marginHeight();
    if (minY === null || top < minY) minY = top;
    if (maxY === null || bottom > maxY) maxY = bottom;
    if (child instanceof boxes.InlineBox) {
      const [childrenMaxY, childrenMinY] = inlineBoxVerticality(child, topBottomSubtrees, childBaselineY);
      if (childrenMinY !== null && childrenMinY < (minY as number)) minY = childrenMinY;
      if (childrenMaxY !== null && childrenMaxY > (maxY as number)) maxY = childrenMaxY;
    }
  }
  return [maxY, minY];
}

/** Return the line horizontal offset according to ``text-align``. */
export function textAlign(context: any, line: AnyBox, availableWidth: number, last: boolean): number {
  // "When the total width of the inline-level boxes on a line is less than the width of the line
  // box containing them, their horizontal distribution within the line box is determined by the
  // 'text-align' property."
  if (line.width >= availableWidth) return 0;

  let align = line.style.get('text_align_all');
  if (last) {
    const alignLast = line.style.get('text_align_last');
    align = alignLast === 'auto' ? align : alignLast;
  }
  const spaceCollapse = ['normal', 'nowrap', 'pre-line'].includes(line.style.get('white_space'));
  if (align === 'left' || align === 'right') {
    if ((align === 'left') !== (line.style.get('direction') === 'rtl')) align = 'start';
    else align = 'end';
  }
  if (align === 'start') return 0;
  const offset = availableWidth - line.width;
  if (align === 'justify') {
    // Justification of texts where white space is not collapsing is forbidden by CSS 2,
    // and not required by CSS 3 Text.
    if (spaceCollapse) justifyLine(context, line, offset);
    return 0;
  }
  if (align === 'center') return offset / 2;
  if (align !== 'end') throw new Error(`unexpected text-align ${align}`);
  return offset;
}

export function justifyLine(context: any, line: AnyBox, extraWidth: number): void {
  // TODO: We should use a better algorithm here, see https://www.w3.org/TR/css-text-3/#justify-algos
  const nbSpaces = countExpandableSpaces(line);
  if (nbSpaces) addWordSpacing(context, line, extraWidth / nbSpaces, 0);
}

/** Count expandable spaces (space and nbsp) for justification. */
export function countExpandableSpaces(box: AnyBox): number {
  if (box instanceof boxes.TextBox) {
    // TODO: remove trailing spaces correctly
    return (box.text.match(/ /g) ?? []).length + (box.text.match(/\u00a0/g) ?? []).length;
  }
  if (box instanceof boxes.LineBox || box instanceof boxes.InlineBox) {
    return box.children.reduce((sum: number, child: AnyBox) => sum + countExpandableSpaces(child), 0);
  }
  return 0;
}

export function addWordSpacing(context: any, box: AnyBox, justificationSpacing: number, xAdvanceIn: number): number {
  let xAdvance = xAdvanceIn;
  if (box instanceof boxes.TextBox) {
    box.justificationSpacing = justificationSpacing;
    box.positionX += xAdvance;
    const nbSpaces = countExpandableSpaces(box);
    if (nbSpaces > 0) {
      const layout = getTextEngine().createLayout(box.text, box.style, context, null, box.justificationSpacing);
      layout.deactivate();
      const extraSpace = justificationSpacing * nbSpaces;
      xAdvance += extraSpace;
      box.width += extraSpace;
      box.pangoLayout = layout;
    }
  } else if (box instanceof boxes.LineBox || box instanceof boxes.InlineBox) {
    box.positionX += xAdvance;
    const previousXAdvance = xAdvance;
    let children = box.children;
    if (box.style.get('direction') === 'rtl') children = [...children].reverse();
    for (const child of children) {
      if (child.isInNormalFlow()) xAdvance = addWordSpacing(context, child, justificationSpacing, xAdvance);
    }
    box.width += xAdvance - previousXAdvance;
  } else {
    // Atomic inline-level box.
    box.translate(xAdvance, 0);
  }
  return xAdvance;
}

/** See https://www.w3.org/TR/CSS21/visuren.html#phantom-line-box */
export function isPhantomLinebox(linebox: AnyBox): boolean {
  for (const child of linebox.children) {
    if (child instanceof boxes.InlineBox) {
      if (!isPhantomLinebox(child)) return false;
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const margin = child.style.get(`margin_${side}`);
        if ((margin && margin.value) || child.style.get(`border_${side}_width`) || child.style.get(`padding_${side}`).value) return false;
      }
    } else if (child.isInNormalFlow()) return false;
  }
  return true;
}

export function canBreakInside(box: AnyBox): boolean {
  // See https://www.w3.org/TR/css-text-3/#white-space-property
  const textWrap = ['normal', 'pre-wrap', 'pre-line'].includes(box.style.get('white_space'));
  if (box.isAtomicInline) return false;
  if (textWrap && box instanceof boxes.TextBox) return getTextEngine().canBreakText(box.text, box.style.get('lang'));
  if (textWrap && box.isParent) return box.children.some((child: AnyBox) => canBreakInside(child));
  return false;
}