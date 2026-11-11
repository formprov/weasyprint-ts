// SPDX-License-Identifier: BSD-3-Clause

/** Functions for CSS text transformations (mirrors formatting_structure/text.py). */

const ASCII_TO_WIDE = new Map<string, string>();
for (let i = 0x21; i < 0x7f; i++) ASCII_TO_WIDE.set(String.fromCharCode(i), String.fromCharCode(i + 0xfee0));
ASCII_TO_WIDE.set(' ', '　');
ASCII_TO_WIDE.set('-', '−');

export const LINE_FEED_RE = /\r\n?/g;
export const TAB_RE = /[\t ]*\n[\t ]*/g;
export const SPACE_RE = /[\t ]+/g;

export function transform(fn: string, text: string, langCode: string): string {
  switch (fn) {
    case 'uppercase': return uppercase(text, langCode);
    case 'lowercase': return lowercase(text, langCode);
    case 'capitalize': return capitalize(text, langCode);
    case 'full-width': return fullWidth(text);
    default: throw new Error(`unknown text-transform ${fn}`);
  }
}

export function uppercase(text: string, langCode: string): string {
  let mapper: Array<[string, string]> = [];
  if (langCode === 'el') {
    mapper = [['άι', 'ΑΪ'], ['άυ', 'ΑΫ'], ['όι', 'ΟΪ'], ['όυ', 'ΟΫ'], ['έυ', 'ΗΫ']];
  } else if (langCode === 'tr' || langCode === 'az') mapper = [['i', 'İ']];
  for (const [k, v] of mapper) text = text.split(k).join(v);
  if (langCode === 'el') {
    text = text.normalize('NFD');
    for (const c of '̓̔́̀̆͂̄ͅ') text = text.split(c).join('');
    text = text.normalize('NFC');
  }
  return text.toUpperCase();
}

export function lowercase(text: string, langCode: string): string {
  let mapper: Array<[string, string]> = [];
  if (langCode === 'tr' || langCode === 'az') mapper = [['I', 'ı'], ['İ', 'i']];
  else if (langCode === 'lt') mapper = [['Ì', 'i̇̀'], ['Í', 'i̇́'], ['Ĩ', 'i̇̃']];
  for (const [k, v] of mapper) text = text.split(k).join(v);
  return text.toLowerCase();
}

const category = (ch: string): string => {
  if (/\p{L}/u.test(ch)) return 'L';
  if (/\p{N}/u.test(ch)) return 'N';
  if (/\p{Z}/u.test(ch)) return 'Z';
  return 'O';
};

export function capitalize(text: string, langCode: string): string {
  let letterFound = false;
  let skipNext = false;
  let output = '';
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    let letter = chars[i];
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const cat = category(letter);
    if (!letterFound && (cat === 'L' || cat === 'N')) {
      letterFound = true;
      if (langCode === 'nl' && chars.slice(i, i + 2).join('') === 'ij') {
        skipNext = true;
        letter = 'IJ';
      } else if (langCode === 'tr' || langCode === 'az') letter = uppercase(letter, langCode);
      else letter = letter.toUpperCase();
    } else if (cat === 'Z') letterFound = false;
    output += letter;
  }
  return output;
}

export function fullWidth(text: string): string {
  return [...text].map((c) => ASCII_TO_WIDE.get(c) ?? c).join('');
}

export function getFirstLetter(text: string): string {
  let found = false;
  let first = '';
  for (const letter of text) {
    if (!/^[\p{Ps}\p{Pe}\p{Pi}\p{Pf}\p{Po}]$/u.test(letter)) {
      if (found) break;
      found = true;
    }
    first += letter;
  }
  return first;
}