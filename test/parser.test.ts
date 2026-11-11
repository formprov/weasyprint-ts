// SPDX-License-Identifier: BSD-3-Clause

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStylesheet, parseDeclarationList } from '../src/css/parser.ts';

test('parses rules, at-rules and declarations', () => {
  const rules = parseStylesheet('a { color: red !important; margin: 0 auto } @page :first { margin-top: 0cm }');
  assert.equal(rules.length, 2);
  const r = rules[0];
  assert.equal(r.type, 'qualified-rule');
  if (r.type === 'qualified-rule') {
    const decls = parseDeclarationList(r.content);
    assert.equal(decls.length, 2);
    const d = decls[0];
    assert.ok(d.type === 'declaration' && d.important && d.name === 'color');
  }
  const at = rules[1];
  assert.ok(at.type === 'at-rule' && at.lowerAtKeyword === 'page');
});

test('invalid media text survives as prelude tokens', () => {
  const rules = parseStylesheet('@media only screen and (max-width: 600px) { a { b: c } }');
  assert.equal(rules.length, 1);
});