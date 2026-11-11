// SPDX-License-Identifier: BSD-3-Clause

/** Text constants (subset of weasyprint/text/constants.py). */
import { LANG_QUOTES } from './lang_quotes.ts';

const quotesMap = new Map(LANG_QUOTES);

export function getLangQuotes(lang: string | null): [string[], string[]] {
  if (quotesMap.has(lang)) return quotesMap.get(lang)!;
  // Revert to find long names before short ones.
  for (const [key, value] of [...LANG_QUOTES].reverse()) {
    if (key && lang && lang.startsWith(key)) return value;
  }
  return quotesMap.get(null)!;
}