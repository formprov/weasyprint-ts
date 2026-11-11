// SPDX-License-Identifier: BSD-3-Clause

/**
 * Text normalization and fallback mark positioning, the two HarfBuzz behaviors
 * that the port reproduces by hand (hb-ot-shape-normalize.cc and
 * hb-ot-shape-fallback.cc). The expected values below were checked against
 * hb-shape with the pinned HarfBuzz 13.2.1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combiningClass, composePair, modifiedCombiningClass, normalizeForShaping } from '../src/text/normalize.ts';
import { positionFallbackMarks } from '../src/text/fallback_marks.ts';

const everything = (): boolean => true;
const none = (): boolean => false;

test('canonical composition ignores CompositionExclusions, like HarfBuzz', () => {
  // U+FB2A has a canonical decomposition but is excluded from NFC composition.
  assert.equal(composePair(0x5e9, 0x5c1), 0xfb2a); // shin + shin dot
  assert.equal(composePair(0x5d5, 0x5b9), 0xfb4b); // vav + holam
  assert.equal(composePair(0x61, 0x301), 0xe1); // a + acute
});

test('modified combining classes permute the Hebrew fixed-position classes', () => {
  assert.equal(combiningClass(0x5b8), 18); // qamats
  assert.equal(modifiedCombiningClass(0x5b8), 21);
  assert.equal(combiningClass(0x5c1), 24); // shin dot
  assert.equal(modifiedCombiningClass(0x5c1), 10);
});

test('normalization composes a base and its mark when the font has the glyph', () => {
  assert.deepEqual(normalizeForShaping([0x61, 0x301], everything), [{ cp: 0xe1, start: 0, end: 1 }]);
  assert.deepEqual(normalizeForShaping([0x61, 0x301], none), [
    { cp: 0x61, start: 0, end: 0 },
    { cp: 0x301, start: 1, end: 1 },
  ]);
});

test('normalization reorders marks before composing (Hebrew shin + qamats + shin dot)', () => {
  // HarfBuzz reorders shin-dot (modified class 10) before qamats (21), composes
  // shin+dot to U+FB2A, and leaves qamats as a mark of the merged cluster.
  assert.deepEqual(normalizeForShaping([0x5e9, 0x5b8, 0x5c1], everything), [
    { cp: 0xfb2a, start: 0, end: 2 },
    { cp: 0x5b8, start: 1, end: 1 },
  ]);
});

test('normalization composes the first pair and keeps the blocked mark', () => {
  const has = (cp: number): boolean => cp === 0x1ea1; // a with dot below
  assert.deepEqual(normalizeForShaping([0x61, 0x323, 0x301], has), [
    { cp: 0x1ea1, start: 0, end: 1 },
    { cp: 0x301, start: 2, end: 2 },
  ]);
});

test('a precomposed character is decomposed only when the font has both pieces', () => {
  const pieces = (cp: number): boolean => cp === 0x61 || cp === 0x301;
  assert.deepEqual(normalizeForShaping([0xe1], pieces), [
    { cp: 0x61, start: 0, end: 0 },
    { cp: 0x301, start: 0, end: 0 },
  ]);
  // HarfBuzz keeps the composed character when the mark has no glyph (the
  // decomposition would not help: it would still be .notdef).
  assert.deepEqual(normalizeForShaping([0xe1], none), [{ cp: 0xe1, start: 0, end: 0 }]);
});

/** Minimal fontkit-shaped font: one glyph per id with a fixed box. */
function fakeFont(glyphs: Record<number, { advance: number; bbox: number[] }>): any {
  return {
    unitsPerEm: 1000,
    GPOS: null,
    getGlyph(id: number) {
      const g = glyphs[id];
      return {
        advanceWidth: g.advance,
        bbox: { minX: g.bbox[0], minY: g.bbox[1], maxX: g.bbox[2], maxY: g.bbox[3] },
      };
    },
  };
}

test('fallback mark positioning matches HarfBuzz for an above mark (LTR)', () => {
  const font = fakeFont({
    1: { advance: 500, bbox: [0, 0, 500, 700] }, // base
    2: { advance: 0, bbox: [100, 0, 300, 100] }, // above mark
  });
  const glyphs = [{ id: 1, codePoints: [0x61] }, { id: 2, codePoints: [0x301] }];
  const positions = [
    { xAdvance: 500, yAdvance: 0, xOffset: 0, yOffset: 0 },
    { xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 },
  ];
  positionFallbackMarks(font, glyphs, positions, false, 1000, 1000);
  // Center over the base advance: (500 - 200) / 2 - 100 = 50, minus the base
  // advance (the mark's own pen sits after the base). Above: 700 + 62 - 0.
  assert.deepEqual(positions[1], { xAdvance: 0, yAdvance: 0, xOffset: -450, yOffset: 762 });
});

test('fallback mark positioning accumulates stacked marks', () => {
  const font = fakeFont({
    1: { advance: 500, bbox: [0, 0, 500, 700] },
    2: { advance: 0, bbox: [100, 0, 300, 100] }, // above
    3: { advance: 0, bbox: [150, 0, 250, 80] }, // second above mark
  });
  const glyphs = [
    { id: 1, codePoints: [0x61] },
    { id: 2, codePoints: [0x301] },
    { id: 3, codePoints: [0x300] },
  ];
  const positions = glyphs.map(() => ({ xAdvance: 0, yAdvance: 0, xOffset: 0, yOffset: 0 }));
  positions[0].xAdvance = 500;
  positionFallbackMarks(font, glyphs, positions, false, 1000, 1000);
  // The second mark stacks above the first: 762 + 62 + 100.
  assert.equal(positions[1].yOffset, 762);
  assert.equal(positions[2].yOffset, 924);
});
