// SPDX-License-Identifier: BSD-3-Clause

/**
 * Runtime-agnostic core guard (weasy-hdv.8): the core src/ tree must not import
 * Node builtins directly. All IO goes through interfaces (Fetcher, FontSource,
 * log sink); Node adapters live in src/cli/ only. This is the dependency-free
 * equivalent of an ESLint `no-restricted-imports` rule for `node:*` modules.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = new URL('../src/', import.meta.url).pathname;

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTs(full);
    else if (entry.endsWith('.ts')) yield full;
  }
}

test('core src/ has no node: imports outside cli/', () => {
  const offenders: string[] = [];
  for (const file of walkTs(SRC_ROOT)) {
    // The cli/ directory is the Node adapter layer; node: imports are fine there.
    if (file.includes('/cli/')) continue;
    const text = readFileSync(file, 'utf8');
    if (/(?:from\s*|require\(\s*)['"]node:[^'"]+['"]/.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('core src/ has no direct Buffer/process usage outside cli/', () => {
  const offenders: string[] = [];
  for (const file of walkTs(SRC_ROOT)) {
    if (file.includes('/cli/')) continue;
    const text = readFileSync(file, 'utf8');
    if (/\bBuffer\b/.test(text) || /\bprocess\.(?:stdout|stderr|stdin|env|argv)\b/.test(text)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});