// SPDX-License-Identifier: BSD-3-Clause

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pangoDescriptionOf } from '../src/pdf/stream.ts';
import type { Style } from '../src/css/style.ts';
import { FontFace } from '../src/text/font_config.ts';

// Expected strings are pango_font_description_to_string() output from the
// pinned oracle image (parity/experiments/probe*.py).

function face(family: string, weight: number, width: number, italic = false): FontFace {
  const id = `${family}|${weight}|${width}|${italic}`;
  return new FontFace({ id, read: () => new Uint8Array() }, { family, fullName: family, weight, width, italic });
}

function style(weight: number, fontStyle = 'normal', stretch = 'normal'): Style {
  const values: Record<string, unknown> = { font_weight: weight, font_style: fontStyle, font_stretch: stretch };
  return { get: (key: string) => values[key] } as unknown as Style;
}

test('family ending in a size-like number gets a separator when no words follow', () => {
  assert.equal(pangoDescriptionOf(face('Noto Sans Symbols 2', 400, 5), style(400)), 'Noto Sans Symbols 2,');
});

test('family ending in a size-like number has no separator before style words', () => {
  assert.equal(pangoDescriptionOf(face('Noto Sans Symbols 2', 400, 5), style(700)), 'Noto Sans Symbols 2 Bold');
  assert.equal(pangoDescriptionOf(face('Noto Sans Symbols 2', 400, 3), style(400)), 'Noto Sans Symbols 2 Condensed');
});

test('family ending in a keyword gets a separator, with or without words', () => {
  assert.equal(pangoDescriptionOf(face('Foo Bold', 400, 5), style(400)), 'Foo Bold,');
  assert.equal(pangoDescriptionOf(face('Foo Bold', 700, 5), style(700)), 'Foo Bold, Bold');
  assert.equal(pangoDescriptionOf(face('Barlow Condensed', 300, 3), style(300)),
    'Barlow Condensed, Light Condensed');
  assert.equal(pangoDescriptionOf(face('Barlow Condensed', 700, 3), style(700)),
    'Barlow Condensed, Bold Condensed');
});

test('family whose last token is not a keyword or size gets no separator', () => {
  assert.equal(pangoDescriptionOf(face('Noto Sans', 400, 5), style(400)), 'Noto Sans');
  assert.equal(pangoDescriptionOf(face('Foo Bold Bar', 400, 5), style(400)), 'Foo Bold Bar');
  assert.equal(pangoDescriptionOf(face('Pacifico', 400, 5), style(700)), 'Pacifico Bold');
});

test('words are ordered weight, style, stretch', () => {
  assert.equal(pangoDescriptionOf(face('Foo Bar', 700, 3, true), style(700)), 'Foo Bar Bold Italic Condensed');
});
