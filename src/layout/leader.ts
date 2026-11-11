// SPDX-License-Identifier: BSD-3-Clause

/** Leaders management (mirrors layout/leader.py). */
import * as boxes from '../formatting_structure/boxes.ts';

type AnyBox = any;
type LeaderIndex = [number, LeaderIndex | null] | null;

/** Get the index of the first leader box in ``box``. */
export function leaderIndex(box: AnyBox): [LeaderIndex, AnyBox] {
  for (let i = 0; i < box.children.length; i++) {
    const child = box.children[i];
    if (child.isLeader) return [[i, null], child];
    if (child instanceof boxes.ParentBox) {
      const [childLeaderIndex, childLeader] = leaderIndex(child);
      if (childLeaderIndex !== null) return [[i, childLeaderIndex], childLeader];
    }
  }
  return [null, null];
}

/** Find a leader box in ``line`` and handle its text and its position. */
export function handleLeader(context: any, line: AnyBox, containingBlock: AnyBox): void {
  let [index, leaderBox] = leaderIndex(line);
  let extraWidth = 0;
  if (index !== null && leaderBox.children.length) {
    let [textBox] = leaderBox.children;

    // Abort if the leader text has no width.
    if (textBox.width <= 0) return;

    // Extra width is the additional width taken by the leader box.
    extraWidth = containingBlock.width - line.children
      .filter((child: AnyBox) => child.isInNormalFlow())
      .reduce((sum: number, child: AnyBox) => sum + child.marginWidth(), 0);

    // Take care of excluded shapes.
    for (const shape of context.excludedShapes) {
      if (shape.positionY + shape.height > line.positionY) extraWidth -= shape.width;
    }

    // Available width is the width available for the leader box.
    const availableWidth = extraWidth + textBox.width;
    line.width = containingBlock.width;

    // Add text boxes into the leader box.
    const numberOfLeaders = Math.trunc(line.width / textBox.width);
    let positionX = line.positionX + line.width;
    const children: AnyBox[] = [];
    for (let i = 0; i < numberOfLeaders; i++) {
      positionX -= textBox.width;
      if (positionX < leaderBox.positionX) continue; // Don't add leaders behind the text on the left
      if (positionX + textBox.width > leaderBox.positionX + availableWidth) continue; // ... on the right
      textBox = textBox.copy();
      textBox.positionX = positionX;
      children.push(textBox);
    }
    leaderBox.children = children;

    if (line.style.get('direction') === 'rtl') leaderBox.translate(-extraWidth, 0);
  }

  // Widen leader parent boxes and translate following boxes.
  let box = line;
  while (index !== null) {
    for (const child of box.children.slice(index[0] + 1)) {
      if (child.isInNormalFlow()) {
        if (line.style.get('direction') === 'ltr') child.translate(extraWidth, 0);
        else child.translate(-extraWidth, 0);
      }
    }
    box = box.children[index[0]];
    box.width += extraWidth;
    index = index[1];
  }
}