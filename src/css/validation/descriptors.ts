// SPDX-License-Identifier: BSD-3-Clause

/** Validate descriptors used for some at-rules (counter-style only so far; font-face TODO). */
import type { Declaration, Token } from '../parser.ts';
import { serialize } from '../parser.ts';
import { LOGGER } from '../../logger.ts';
import {
  InvalidValues, commaSeparatedList, getCustomIdent, getKeyword, getNumber, getSingleKeyword, getUrl,
  removeWhitespace, singleToken, splitOnComma,
} from '../tokens.ts';

type DescriptorFn = (tokens: Token[], baseUrl: string | null) => any;
export const DESCRIPTORS: Record<string, Record<string, DescriptorFn>> = {
  'font-face': {}, 'counter-style': {}, 'color-profile': {},
};
const NOT_PRINT_MEDIA = new Set(['font-display']);

export function preprocessDescriptors(
  rule: string, baseUrl: string | null, descriptors: Array<{ type: string }>,
): Array<[string, any]> {
  const out: Array<[string, any]> = [];
  for (const d of descriptors) {
    if (d.type !== 'declaration' || (d as Declaration).important) continue;
    const decl = d as Declaration;
    const tokens = removeWhitespace(decl.value);
    try {
      if (NOT_PRINT_MEDIA.has(decl.name)) continue;
      if (!(decl.name in DESCRIPTORS[rule])) throw new InvalidValues('descriptor not supported');
      const value = DESCRIPTORS[rule][decl.name](tokens, baseUrl);
      if (value === null || value === undefined) throw new InvalidValues();
      out.push([decl.name.replace(/-/g, '_'), value]);
    } catch (e) {
      if (e instanceof InvalidValues) {
        LOGGER.warning(`Ignored \`${decl.name}:${serialize(decl.value)}\`, ${e.message || 'invalid value'}.`);
        continue;
      }
      throw e;
    }
  }
  return out;
}

const cs = (name: string, fn: DescriptorFn): void => {
  DESCRIPTORS['counter-style'][name] = fn;
};

cs('system', (tokens) => {
  if (tokens.length > 2) return null;
  const keyword = getKeyword(tokens[0]);
  if (keyword === 'extends') {
    if (tokens.length === 2) {
      const second = getKeyword(tokens[1]);
      if (second) return [keyword, second, null];
    }
  } else if (keyword === 'fixed') {
    if (tokens.length === 1) return [null, 'fixed', 1];
    const n = getNumber(tokens[1], true, true);
    if (n) return [null, 'fixed', n.value];
  } else if (tokens.length === 1 && keyword && ['cyclic', 'numeric', 'alphabetic', 'symbolic', 'additive'].includes(keyword)) {
    return [null, keyword, null];
  }
  return null;
});

cs('negative', (tokens, baseUrl) => {
  if (tokens.length > 2) return null;
  const values: any[] = [];
  for (const token of tokens) {
    if (token.type === 'string' || token.type === 'ident') {
      values.push(['string', token.value]);
      continue;
    }
    const url = getUrl(token, baseUrl);
    if (url !== null) values.push(['url', url[1]]);
  }
  if (values.length === 1) values.push(['string', '']);
  return values.length === 2 ? values : null;
});

const prefixSuffix: DescriptorFn = (tokens, baseUrl) => {
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  if (token.type === 'string' || token.type === 'ident') return ['string', token.value];
  const url = getUrl(token, baseUrl);
  if (url !== null) return ['url', url[1]];
  return null;
};
cs('prefix', prefixSuffix);
cs('suffix', prefixSuffix);

cs('range', commaSeparatedList((tokens) => {
  if (tokens.length === 1) return getSingleKeyword(tokens) === 'auto' ? 'auto' : null;
  if (tokens.length === 2) {
    const values: number[] = [];
    tokens.forEach((token, i) => {
      if (token.type === 'ident' && token.value === 'infinite') values.push(i ? Infinity : -Infinity);
      else {
        const n = getNumber(token, true, true);
        if (n) values.push(n.value);
      }
    });
    if (values.length === 2 && values[0] <= values[1]) return values;
  }
  return null;
}));

const pad: DescriptorFn = (tokens, baseUrl) => {
  if (tokens.length !== 2) return null;
  const values: any[] = [null, null];
  for (const token of tokens) {
    const n = getNumber(token, false, true);
    if (n) {
      if (values[0] === null) values[0] = n.value;
    } else if (token.type === 'string' || token.type === 'ident') values[1] = ['string', token.value];
    const url = getUrl(token, baseUrl);
    if (url !== null) values[1] = ['url', url[1]];
  }
  return values.includes(null) ? null : values;
};
cs('pad', pad);

cs('fallback', (tokens) => {
  if (tokens.length !== 1) return null;
  const ident = getCustomIdent(tokens[0]);
  return ident !== 'none' ? ident : null;
});
void singleToken;

cs('symbols', (tokens, baseUrl) => {
  const values: any[] = [];
  for (const token of tokens) {
    if (token.type === 'string' || token.type === 'ident') {
      values.push(['string', token.value]);
      continue;
    }
    const url = getUrl(token, baseUrl);
    if (url !== null) {
      values.push(['url', url[1]]);
      continue;
    }
    return null;
  }
  return values;
});

cs('additive-symbols', (tokens, baseUrl) => {
  const results: any[] = [];
  for (const part of splitOnComma(tokens)) {
    const result = pad(removeWhitespace(part), baseUrl);
    if (!result) return null;
    if (results.length && results[results.length - 1][0] <= result[0]) return null;
    results.push(result);
  }
  return results;
});