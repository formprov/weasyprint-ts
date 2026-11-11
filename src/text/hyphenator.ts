// SPDX-License-Identifier: BSD-3-Clause

/**
 * Hyphenation: Liang's pattern algorithm over hyph_*.dic pattern files,
 * matching the reference implementation's semantics (a flat pattern pool —
 * the special keys LEFTHYPHENMIN, RIGHTHYPHENMIN, COMPOUND-variants and
 * NEXTLEVEL are skipped, so the NEXTLEVEL section's patterns join the pool;
 * nonstandard alternatives 'pattern/alternative' rewrite the word at the
 * break point).
 *
 * No dictionaries are bundled: they are discovered like fonts, from
 * DICTIONARIES_DIR, or a `dictionaries/` subdirectory of the font
 * directories, or a sibling of the fonts directory. Missing dictionaries
 * mean `hyphens: auto` degrades to `manual` (soft hyphens only), like
 * missing fonts degrade to notdef rectangles.
 */

const IGNORED_PREFIXES = ['%', '#', 'LEFTHYPHENMIN', 'RIGHTHYPHENMIN', 'COMPOUNDLEFTHYPHENMIN', 'COMPOUNDRIGHTHYPHENMIN'];

/** Parsed-dictionary cache keyed by the dictionary text. */
const textCache = new Map<string, HyphDict>();

interface PatternValue {
  value: number;
  data?: [change: string, index: number, cut: number];
}

export interface HyphenationPoint {
  /** Break position within the word (byte prefix before the break). */
  position: number;
  /** Nonstandard 'hy'/'hy ' pattern alternative. */
  data?: [change: string, index: number, cut: number];
}

interface ParsedPattern {
  letters: string;
  start: number;
  values: PatternValue[];
}

/** Parse one pattern line into (letters, [digit values with optional data]). */
function parsePattern(pattern: string): ParsedPattern | null {
  // Replace ^^hh hex escapes with the real character.
  pattern = pattern.replace(/\^\^([0-9a-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  // Nonstandard hyphen alternatives: 'pattern/alternative' where the
  // alternative = 'change,index,cut'.
  let change: string | null = null;
  let changeIndex = -1;
  let cut = 0;
  if (pattern.includes('/') && pattern.includes('=')) {
    const [p, alternative] = pattern.split('/', 2);
    const parts = alternative.split(',');
    change = parts[0];
    changeIndex = Number(parts[1]);
    cut = Number(parts[2]);
    if (p.startsWith('.')) changeIndex++;
    pattern = p;
  }

  // Read (digit?)(letter?) pairs exactly like the reference's findall:
  // one slot per pair; the digit binds to the slot of its (possibly empty)
  // letter pair; the scan yields a trailing empty pair at the end.
  const letters: string[] = [];
  const values: PatternValue[] = [];
  const re = /(\d?)(\D?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pattern)) !== null) {
    if (m.index === re.lastIndex) re.lastIndex++; // zero-length match: force advance
    // Each pair carries its OWN digit — the score does NOT carry over to
    // letterless pairs (mirrors the reference's per-pair findall zip).
    const v = Number(m[1] || 0);
    const key: PatternValue = { value: v, data: v % 2 && change !== null ? [change as string, changeIndex, cut] : undefined };
    letters.push(m[2]);
    values.push(key);
  }
  if (values.every((v) => v.value === 0)) return null; // only zeros: skip

  // Chop zeros from the beginning and end, and store the start offset.
  let start = 0;
  let end = values.length;
  while (start < end && values[start].value === 0) start++;
  while (end > start && values[end - 1].value === 0) end--;
  return { letters: letters.join(''), start, values: values.slice(start, end) };
}

export class HyphDict {
  patterns = new Map<string, ParsedPattern>();
  private maxlen = 0;
  private cache = new Map<string, HyphenationPoint[]>();

  constructor(text: string) {
    const lines = text.split('\n');
    // The first line = the encoding name.
    for (const raw of lines.slice(1)) {
      const pattern = raw.trim();
      if (!pattern || IGNORED_PREFIXES.some((p) => pattern.startsWith(p))) continue;
      const parsed = parsePattern(pattern);
      if (!parsed) continue;
      this.patterns.set(parsed.letters, parsed);
    }
    for (const key of this.patterns.keys()) this.maxlen = Math.max(this.maxlen, key.length);
  }

  /** Break-point positions (0-based character indexes) in the LOWERCASED word. */
  positions(word: string): HyphenationPoint[] {
    word = word.toLowerCase();
    const cached = this.cache.get(word);
    if (cached) return cached;

    const pointed = `.${word}.`;
    const references: PatternValue[] = Array.from({ length: pointed.length + 1 }, () => ({ value: 0 }));

    for (let i = 0; i < pointed.length - 1; i++) {
      const stop = Math.min(i + this.maxlen, pointed.length) + 1;
      for (let j = i + 1; j < stop; j++) {
        const pattern = this.patterns.get(pointed.slice(i, j));
        if (!pattern) continue;
        for (let k = 0; k < pattern.values.length; k++) {
          const idx = i + pattern.start + k;
          const candidate = pattern.values[k];
          if (candidate.value > references[idx].value) references[idx] = candidate;
        }
      }
    }

    const points: HyphenationPoint[] = [];
    for (let i = 0; i < references.length; i++) {
      const reference = references[i];
      if (reference.value % 2) {
        points.push({ position: i - 1, data: reference.data });
      }
    }
    this.cache.set(word, points);
    return points;
  }
}

const languageCache = new Map<string, string | null>();

/** Register a hyphenation dictionary's TEXT for a language (the Node adapter
 * calls this after discovering and reading hyph_*.dic files). */
export function setHyphenationDictionary(lang: string, text: string): void {
  languageCache.set(lang, text);
}

/** The registered languages ('fr', 'fr-fr' lowercased codes). */
export function registeredDictionaryLanguages(): string[] {
  return [...languageCache.keys()];
}

/**
 * Python: pyphen.language_fallback. Case-insensitive, '-' and '_' are equivalent; the tag is
 * truncated until a dictionary is found. A primary tag ('en') maps to the first dictionary
 * in sorted filename order that starts with it (pyphen registers short names that way).
 */
function dictionaryText(lang: string): string | null {
  const byLower = new Map<string, string>();
  for (const key of languageCache.keys()) byLower.set(key.toLowerCase().replace(/-/g, '_'), key);
  const parts = lang.replace(/-/g, '_').toLowerCase().split('_');
  while (parts.length) {
    const candidate = parts.join('_');
    const key = byLower.get(candidate);
    if (key !== undefined) return languageCache.get(key) ?? null;
    if (parts.length === 1) {
      const regional = [...byLower.keys()].filter((k) => k.startsWith(`${candidate}_`)).sort();
      if (regional.length) return languageCache.get(byLower.get(regional[0])!) ?? null;
    }
    parts.pop();
  }
  return null;
}

export class Hyphenator {
  private hd: HyphDict | null = null;
  left: number;
  right: number;

  constructor(lang: string | null, left = 2, right = 2) {
    this.left = left;
    this.right = right;
    if (lang) {
      const text = dictionaryText(lang);
      if (text !== null) {
        this.hd = textCache.get(text) ?? new HyphDict(text);
        textCache.set(text, this.hd);
      }
    }
  }

  /** Whether a dictionary was found for this language. */
  get available(): boolean {
    return this.hd !== null;
  }

  /** Positions filtered by the left/right minima. */
  positions(word: string): number[] {
    if (!this.hd) return [];
    const right = word.length - this.right;
    return this.hd.positions(word).filter((p) => this.left <= p.position && p.position <= right).map((p) => p.position);
  }

  /** All hyphenation possibilities of ``word``, longest first. Each part pair
   * accounts for nonstandard hyphenation (the change substitutions). */
  iterate(word: string): Array<[string, string]> {
    if (!this.hd) return [];
    const result: Array<[string, string]> = [];
    const points = this.hd.positions(word).filter((p) => this.left <= p.position && p.position <= word.length - this.right);
    for (const point of points.reverse()) {
      if (point.data) {
        const [change, index, cut] = point.data;
        const idx = point.position + index;
        const c1 = change.split('=')[0];
        const c2 = change.split('=')[1] ?? '';
        const up = word === word.toUpperCase() ? c1.toUpperCase() : c1;
        result.push([word.slice(0, idx) + up, c2 + word.slice(idx + cut)]);
      } else {
        result.push([word.slice(0, point.position), word.slice(point.position)]);
      }
    }
    return result;
  }
}
