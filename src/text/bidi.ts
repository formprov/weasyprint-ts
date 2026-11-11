// SPDX-License-Identifier: BSD-3-Clause

/**
 * Unicode Bidirectional Algorithm (UAX #9) paragraph embedding levels, as Pango obtains them from
 * fribidi_get_par_embedding_levels_ex (pango_log2vis_get_embedding_levels), with fribidi's own character data
 * (bidi_data.ts). Rules X1-X10, W1-W7, N0-N2, I1-I2 and the paragraph part of L1; line reordering (L2) is done by
 * the caller on items.
 *
 * Differential test against the oracle's fribidi (test/bidi.test.ts): 39 892 of 39 896 random strings over every
 * bidi class agree. The 4 that differ combine an RLE embedding with a bracket pair holding only an LRM, or a bracket
 * after an unmatched nested isolate; fribidi's N0 there depends on its internal run-list merging.
 */
import { BIDI_BRACKETS, BIDI_CLASSES, BIDI_MIRRORS, BIDI_RANGES } from './bidi_data.ts';

/** Bidi class codes, in BIDI_CLASSES order. */
export const B = Object.fromEntries(BIDI_CLASSES.map((name, i) => [name, i])) as { [K in (typeof BIDI_CLASSES)[number]]: number };
export type B = number;

let rangeStarts: Uint32Array | null = null;
let rangeEnds: Uint32Array;
let rangeClasses: Uint8Array;
const mirrors = new Map<number, number>();
const brackets = new Map<number, [number, boolean]>();

function load(): void {
  const rows = BIDI_RANGES.split(';');
  rangeStarts = new Uint32Array(rows.length);
  rangeEnds = new Uint32Array(rows.length);
  rangeClasses = new Uint8Array(rows.length);
  rows.forEach((row, i) => {
    const [s, n, c] = row.split(',').map((v) => parseInt(v, 16));
    rangeStarts![i] = s;
    rangeEnds![i] = s + n - 1;
    rangeClasses[i] = c;
  });
  for (const row of BIDI_MIRRORS.split(';')) {
    const [a, b] = row.split(',').map((v) => parseInt(v, 16));
    mirrors.set(a, b);
  }
  for (const row of BIDI_BRACKETS.split(';')) {
    const [a, b, open] = row.split(',');
    brackets.set(parseInt(a, 16), [parseInt(b, 16), open === '1']);
  }
}

/** Bidi class of a code point (fribidi_get_bidi_type). */
export function bidiClass(cp: number): B {
  if (rangeStarts === null) load();
  let lo = 0;
  let hi = rangeStarts!.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < rangeStarts![mid]) hi = mid - 1;
    else if (cp > rangeEnds[mid]) lo = mid + 1;
    else return rangeClasses[mid] as B;
  }
  return B.L;
}

/** Bidi_Mirroring_Glyph (fribidi_get_mirror_char), or null. */
export function mirrorChar(cp: number): number | null {
  if (rangeStarts === null) load();
  return mirrors.get(cp) ?? null;
}

/** True when any code point is strong R/AL, an Arabic number, or an RTL embedding/override/isolate. */
export function hasRtl(cps: ArrayLike<number>): boolean {
  for (let i = 0; i < cps.length; i++) {
    const c = bidiClass(cps[i]);
    if (c === B.R || c === B.AL || c === B.AN || c === B.RLE || c === B.RLO || c === B.RLI || c === B.FSI) return true;
  }
  return false;
}

const MAX_DEPTH = 125;

const isStrongOrNumber = (c: B): boolean => c === B.L || c === B.R || c === B.AL || c === B.EN || c === B.AN;
const isRemovedByX9 = (c: B): boolean =>
  c === B.LRE || c === B.RLE || c === B.LRO || c === B.RLO || c === B.PDF || c === B.BN;
const isIsolateInitiator = (c: B): boolean => c === B.LRI || c === B.RLI || c === B.FSI;
const isNI = (c: B): boolean =>
  c === B.B || c === B.S || c === B.WS || c === B.ON || c === B.LRI || c === B.RLI || c === B.FSI || c === B.PDI;

/** P2/P3 on types[from, to): first strong char, skipping isolates. Returns 0, 1, or null when none. */
function firstStrong(types: B[], from: number, to: number): 0 | 1 | null {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = types[i];
    if (isIsolateInitiator(t)) depth++;
    else if (t === B.PDI) {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      if (t === B.L) return 0;
      if (t === B.R || t === B.AL) return 1;
    } else if (t === B.B) break;
  }
  return null;
}

/**
 * fribidi's FSI direction scan: it does not stop at the matching PDI but runs to the end of the paragraph, counting
 * isolate initiators up and PDIs down, and takes the first strong character seen at depth 0.
 */
function fsiFirstStrong(types: B[], from: number, to: number): 0 | 1 | null {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const t = types[i];
    if (isIsolateInitiator(t)) depth++;
    else if (t === B.PDI) depth--;
    else if (depth === 0) {
      if (t === B.L) return 0;
      if (t === B.R || t === B.AL) return 1;
    }
  }
  return null;
}

/** Embedding levels of one paragraph (no paragraph separators inside, except possibly the last char). */
export function embeddingLevels(cps: ArrayLike<number>, paragraphLevel: 0 | 1): Uint8Array {
  const n = cps.length;
  const initial: B[] = new Array(n);
  for (let i = 0; i < n; i++) initial[i] = bidiClass(cps[i]);
  const types = initial.slice();
  const levels = new Uint8Array(n);
  if (!n) return levels;

  // Matching PDI / isolate initiator (BD9).
  const matchingPDI = new Int32Array(n).fill(-1);
  const matchingInitiator = new Int32Array(n).fill(-1);
  {
    const stack: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = types[i];
      if (isIsolateInitiator(t)) stack.push(i);
      else if (t === B.PDI && stack.length) {
        const open = stack.pop()!;
        matchingPDI[open] = i;
        matchingInitiator[i] = open;
      } else if (t === B.B) stack.length = 0;
    }
  }

  // X1-X8.
  {
    const levelStack: number[] = [paragraphLevel];
    const overrideStack: number[] = [-1]; // -1 neutral, else B.L / B.R
    const isolateStack: boolean[] = [false];
    let overflowIsolates = 0;
    let overflowEmbeddings = 0;
    let validIsolates = 0;
    for (let i = 0; i < n; i++) {
      const t = types[i];
      const top = levelStack.length - 1;
      switch (t) {
        case B.RLE: case B.LRE: case B.RLO: case B.LRO: case B.RLI: case B.LRI: case B.FSI: {
          const isolate = isIsolateInitiator(t);
          let rtl = t === B.RLE || t === B.RLO || t === B.RLI;
          if (t === B.FSI) rtl = fsiFirstStrong(types, i + 1, n) === 1;
          if (isolate) {
            levels[i] = levelStack[top];
            if (overrideStack[top] !== -1) types[i] = overrideStack[top];
          }
          const newLevel = rtl ? (levelStack[top] + 1) | 1 : (levelStack[top] + 2) & ~1;
          if (newLevel <= MAX_DEPTH && overflowIsolates === 0 && overflowEmbeddings === 0) {
            if (isolate) validIsolates++;
            levelStack.push(newLevel);
            overrideStack.push(t === B.LRO ? B.L : t === B.RLO ? B.R : -1);
            isolateStack.push(isolate);
          } else if (isolate) overflowIsolates++;
          else if (overflowIsolates === 0) overflowEmbeddings++;
          if (!isolate) levels[i] = levelStack[levelStack.length - 1];
          break;
        }
        case B.PDI: {
          if (overflowIsolates > 0) overflowIsolates--;
          else if (validIsolates === 0) { /* no match */ } else {
            overflowEmbeddings = 0;
            while (!isolateStack[isolateStack.length - 1]) {
              levelStack.pop();
              overrideStack.pop();
              isolateStack.pop();
            }
            levelStack.pop();
            overrideStack.pop();
            isolateStack.pop();
            validIsolates--;
          }
          const t2 = levelStack.length - 1;
          levels[i] = levelStack[t2];
          if (overrideStack[t2] !== -1) types[i] = overrideStack[t2];
          break;
        }
        case B.PDF: {
          if (overflowIsolates > 0) { /* nothing */ } else if (overflowEmbeddings > 0) overflowEmbeddings--;
          else if (!isolateStack[top] && levelStack.length >= 2) {
            levelStack.pop();
            overrideStack.pop();
            isolateStack.pop();
          }
          levels[i] = levelStack[levelStack.length - 1];
          break;
        }
        case B.B:
          levels[i] = paragraphLevel;
          break;
        default:
          levels[i] = levelStack[top];
          if (overrideStack[top] !== -1 && t !== B.BN) types[i] = overrideStack[top];
      }
    }
  }

  // X9: removed characters are treated as BN from here on.
  for (let i = 0; i < n; i++) if (isRemovedByX9(initial[i])) types[i] = B.BN;

  // X10: level runs, then isolating run sequences.
  const runs: Array<[number, number]> = []; // [start, end) over non-removed chars, by level
  {
    let start = -1;
    let level = -1;
    let last = -1;
    for (let i = 0; i < n; i++) {
      if (types[i] === B.BN) continue;
      if (start === -1) {
        start = i;
        level = levels[i];
      } else if (levels[i] !== level) {
        runs.push([start, last + 1]);
        start = i;
        level = levels[i];
      }
      last = i;
    }
    if (start !== -1) runs.push([start, last + 1]);
  }
  const runOf = new Int32Array(n).fill(-1);
  runs.forEach(([s, e], k) => {
    for (let i = s; i < e; i++) runOf[i] = k;
  });
  const lastNonRemoved = (s: number, e: number): number => {
    for (let i = e - 1; i >= s; i--) if (types[i] !== B.BN) return i;
    return -1;
  };
  const sequences: number[][] = []; // lists of char indices (non-removed)
  for (let k = 0; k < runs.length; k++) {
    const [s] = runs[k];
    if (initial[s] === B.PDI && matchingInitiator[s] !== -1) continue; // continues an earlier sequence
    const seq: number[] = [];
    let cur = k;
    for (;;) {
      const [rs, re] = runs[cur];
      for (let i = rs; i < re; i++) if (types[i] !== B.BN) seq.push(i);
      const last = lastNonRemoved(rs, re);
      if (last !== -1 && isIsolateInitiator(initial[last]) && matchingPDI[last] !== -1) {
        cur = runOf[matchingPDI[last]];
        if (cur === -1) break;
      } else break;
    }
    sequences.push(seq);
  }

  const embedding = levels.slice(); // X1-X8 levels: sos/eos must not see I1-I2 results of earlier sequences
  for (const seq of sequences) resolveSequence(seq, types, initial, levels, embedding, cps, paragraphLevel, n, matchingPDI);

  // Characters removed by X9 take the level of the preceding character (paragraph level at the start), before L1.
  for (let i = 0; i < n; i++) if (isRemovedByX9(initial[i])) levels[i] = i === 0 ? paragraphLevel : levels[i - 1];

  // I1-I2 were applied in resolveSequence. L1 (paragraph part): segment/paragraph separators and the whitespace
  // (including isolate formatting and X9-removed characters) before them or at the end of the paragraph.
  {
    let trailing = true;
    for (let i = n - 1; i >= 0; i--) {
      const t = initial[i];
      if (t === B.S || t === B.B) {
        levels[i] = paragraphLevel;
        trailing = true;
      } else if (trailing && (t === B.WS || isIsolateInitiator(t) || t === B.PDI || isRemovedByX9(t))) {
        levels[i] = paragraphLevel;
      } else trailing = false;
    }
  }

  return levels;
}

function resolveSequence(
  seq: number[], types: B[], initial: B[], levels: Uint8Array, embedding: Uint8Array, cps: ArrayLike<number>, paragraphLevel: number,
  n: number, matchingPDI: Int32Array,
): void {
  if (!seq.length) return;
  const level = embedding[seq[0]];
  // sos / eos (X10).
  const first = seq[0];
  let prevLevel = paragraphLevel;
  for (let i = first - 1; i >= 0; i--) {
    if (types[i] !== B.BN) {
      prevLevel = embedding[i];
      break;
    }
  }
  const last = seq[seq.length - 1];
  let nextLevel = paragraphLevel;
  if (!(isIsolateInitiator(initial[last]) && matchingPDI[last] === -1) && !isIsolateInitiator(initial[last])) {
    for (let i = last + 1; i < n; i++) {
      if (types[i] !== B.BN) {
        nextLevel = embedding[i];
        break;
      }
    }
  }
  const sos: B = Math.max(prevLevel, level) % 2 ? B.R : B.L;
  const eos: B = Math.max(nextLevel, level) % 2 ? B.R : B.L;
  const t = seq.map((i) => types[i]);
  const m = t.length;

  // W1: NSM.
  for (let k = 0; k < m; k++) {
    if (t[k] === B.NSM) {
      if (k === 0) t[k] = sos;
      else {
        const p = t[k - 1];
        t[k] = isIsolateInitiator(p) || p === B.PDI ? B.ON : p;
      }
    }
  }
  // W2: EN after AL -> AN.
  {
    let lastStrong: B = sos;
    for (let k = 0; k < m; k++) {
      const c = t[k];
      if (c === B.L || c === B.R || c === B.AL) lastStrong = c;
      else if (c === B.EN && lastStrong === B.AL) t[k] = B.AN;
    }
  }
  // W3: AL -> R.
  for (let k = 0; k < m; k++) if (t[k] === B.AL) t[k] = B.R;
  // W4: single separators between numbers.
  for (let k = 1; k < m - 1; k++) {
    if (t[k] === B.ES && t[k - 1] === B.EN && t[k + 1] === B.EN) t[k] = B.EN;
    else if (t[k] === B.CS && t[k - 1] === B.EN && t[k + 1] === B.EN) t[k] = B.EN;
    else if (t[k] === B.CS && t[k - 1] === B.AN && t[k + 1] === B.AN) t[k] = B.AN;
  }
  // W5: ET adjacent to EN.
  for (let k = 0; k < m; k++) {
    if (t[k] !== B.ET) continue;
    let e = k;
    while (e < m && t[e] === B.ET) e++;
    const touchesEN = (k > 0 && t[k - 1] === B.EN) || (e < m && t[e] === B.EN);
    if (touchesEN) for (let j = k; j < e; j++) t[j] = B.EN;
    k = e - 1;
  }
  // W6: remaining separators and terminators -> ON.
  for (let k = 0; k < m; k++) if (t[k] === B.ES || t[k] === B.ET || t[k] === B.CS) t[k] = B.ON;
  // W7: EN after L (or sos L) -> L.
  {
    let lastStrong: B = sos;
    for (let k = 0; k < m; k++) {
      const c = t[k];
      if (c === B.L || c === B.R) lastStrong = c;
      else if (c === B.EN && lastStrong === B.L) t[k] = B.L;
    }
  }

  // N0: paired brackets (BD16), with canonical equivalents of U+2329/U+232A and U+3008/U+3009.
  {
    const canon = (cp: number): number => (cp === 0x2329 ? 0x3008 : cp === 0x232a ? 0x3009 : cp);
    const pairs: Array<[number, number]> = [];
    const stack: Array<[number, number]> = []; // [opening bracket id, position]
    for (let k = 0; k < m; k++) {
      if (t[k] !== B.ON) continue;
      const info = bracketOf(canon(cps[seq[k]]));
      if (!info) continue;
      const [id, open] = info;
      if (open) {
        if (stack.length === 63) break;
        stack.push([canon(id), k]);
      } else {
        for (let s = stack.length - 1; s >= 0; s--) {
          if (stack[s][0] === canon(id)) {
            pairs.push([stack[s][1], k]);
            stack.length = s;
            break;
          }
        }
      }
    }
    pairs.sort((a, b) => a[0] - b[0]);
    const embeddingDir: B = level % 2 ? B.R : B.L;
    const strongOf = (c: B): B | null => (c === B.L ? B.L : c === B.R || c === B.EN || c === B.AN ? B.R : null);
    for (const [o, c] of pairs) {
      let foundEmbedding = false;
      let foundOpposite = false;
      for (let k = o + 1; k < c; k++) {
        const s = strongOf(t[k]);
        if (s === null) continue;
        if (s === embeddingDir) {
          foundEmbedding = true;
          break;
        }
        foundOpposite = true;
      }
      let dir: B | null = null;
      if (foundEmbedding) dir = embeddingDir;
      else if (foundOpposite) {
        // fribidi looks for the preceding strong type beyond the start of the isolating run sequence, through the
        // already resolved text before it, and only then falls back to sos.
        let before: B | null = null;
        for (let k = o - 1; k >= 0 && before === null; k--) before = strongOf(t[k]);
        if (before === null) before = sos;
        dir = before !== embeddingDir ? before : embeddingDir;
      }
      if (dir !== null) {
        t[o] = dir;
        t[c] = dir;
        // NSMs following a bracket that changed type take its type (original NSMs became ON via W1).
        for (const p of [o, c]) {
          for (let k = p + 1; k < m && initial[seq[k]] === B.NSM; k++) t[k] = dir;
        }
      }
    }
  }

  // N1-N2: sequences of neutrals.
  for (let k = 0; k < m; k++) {
    if (!isNI(t[k])) continue;
    let e = k;
    while (e < m && isNI(t[e])) e++;
    const before: B = k === 0 ? sos : t[k - 1] === B.L ? B.L : B.R; // EN/AN count as R
    const after: B = e === m ? eos : t[e] === B.L ? B.L : B.R;
    const dir: B = before === after ? before : level % 2 ? B.R : B.L;
    for (let j = k; j < e; j++) t[j] = dir;
    k = e - 1;
  }

  for (let k = 0; k < m; k++) types[seq[k]] = t[k];

  // I1-I2.
  for (let k = 0; k < m; k++) {
    const c = t[k];
    const i = seq[k];
    if (level % 2 === 0) {
      if (c === B.R) levels[i] = level + 1;
      else if (c === B.AN || c === B.EN) levels[i] = level + 2;
      else levels[i] = level;
    } else if (c === B.L || c === B.EN || c === B.AN) levels[i] = level + 1;
    else levels[i] = level;
  }
  void isStrongOrNumber;
}

function bracketOf(cp: number): [number, boolean] | null {
  if (rangeStarts === null) load();
  return brackets.get(cp) ?? null;
}
