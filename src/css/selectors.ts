// SPDX-License-Identifier: BSD-3-Clause

/**
 * CSS selector parsing and matching (subset of cssselect2 semantics).
 * Supports type/universal/class/id/attribute selectors, combinators, structural
 * pseudo-classes, :not/:is/:where, and pseudo-elements.
 */
import type { Token } from './parser.ts';
import { serialize } from './parser.ts';
import type { Element } from '../dom.ts';

export class SelectorError extends Error {}

export type Specificity = [number, number, number];

type Simple =
  | { kind: 'type'; name: string }
  | { kind: 'universal' }
  | { kind: 'class'; name: string }
  | { kind: 'id'; name: string }
  | { kind: 'attr'; name: string; op: string | null; value: string; ci: boolean }
  | { kind: 'nth'; a: number; b: number; last: boolean; ofType: boolean }
  | { kind: 'pseudo'; name: string }
  | { kind: 'not'; list: Selector[] }
  | { kind: 'is'; list: Selector[] }
  | { kind: 'has'; list: Selector[] };

interface Compound {
  simples: Simple[];
}
/** parts[0] is the leftmost compound; combinators[i] joins parts[i] and parts[i+1]. */
export interface Selector {
  parts: Compound[];
  combinators: string[];
  pseudoElement: string | null;
  specificity: Specificity;
}

const ws = (t: Token): boolean => t.type === 'whitespace' || t.type === 'comment';

export function parseNth(tokens: Token[]): [number, number] | null {
  const s = serialize(tokens.filter((t) => !ws(t))).replace(/\s+/g, '').toLowerCase();
  if (s === 'even') return [2, 0];
  if (s === 'odd') return [2, 1];
  let m = /^([+-]?\d+)$/.exec(s);
  if (m) return [0, parseInt(m[1], 10)];
  m = /^([+-]?)(\d*)n(?:([+-])(\d+))?$/.exec(s);
  if (m) {
    const a = (m[2] === '' ? 1 : parseInt(m[2], 10)) * (m[1] === '-' ? -1 : 1);
    const b = m[3] ? parseInt(m[4], 10) * (m[3] === '-' ? -1 : 1) : 0;
    return [a, b];
  }
  return null;
}

function maxSpec(list: Selector[]): Specificity {
  let best: Specificity = [0, 0, 0];
  for (const s of list) {
    const x = s.specificity;
    if (x[0] > best[0] || (x[0] === best[0] && (x[1] > best[1] || (x[1] === best[1] && x[2] > best[2])))) best = x;
  }
  return best;
}

export function parseSelectorList(prelude: Token[]): Selector[] {
  const groups: Token[][] = [[]];
  for (const t of prelude) {
    if (t.type === 'literal' && t.value === ',') groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  return groups.map(parseSelector);
}

function parseSelector(tokens: Token[]): Selector {
  let i = 0;
  const peek = (): Token | undefined => tokens[i];
  const skipWs = (): boolean => {
    let any = false;
    while (i < tokens.length && ws(tokens[i])) {
      i++;
      any = true;
    }
    return any;
  };
  skipWs();
  if (i >= tokens.length) throw new SelectorError('empty selector');
  const parts: Compound[] = [];
  const combinators: string[] = [];
  let pseudoElement: string | null = null;
  const spec: Specificity = [0, 0, 0];

  for (;;) {
    const simples: Simple[] = [];
    let sawAny = false;
    for (;;) {
      const t = peek();
      if (!t) break;
      if (ws(t) || (t.type === 'literal' && ['>', '+', '~'].includes(t.value))) break;
      if (pseudoElement !== null) throw new SelectorError('pseudo-element must be last');
      i++;
      sawAny = true;
      if (t.type === 'ident') {
        if (simples.length) throw new SelectorError('unexpected type selector');
        simples.push({ kind: 'type', name: t.lowerValue });
        spec[2]++;
      } else if (t.type === 'literal' && t.value === '*') {
        if (simples.length) throw new SelectorError('unexpected *');
        simples.push({ kind: 'universal' });
      } else if (t.type === 'hash') {
        simples.push({ kind: 'id', name: t.value });
        spec[0]++;
      } else if (t.type === 'literal' && t.value === '.') {
        const n = tokens[i++];
        if (!n || n.type !== 'ident') throw new SelectorError('expected class name');
        simples.push({ kind: 'class', name: n.value });
        spec[1]++;
      } else if (t.type === '[]') {
        simples.push(parseAttr(t.content));
        spec[1]++;
      } else if (t.type === 'literal' && t.value === ':') {
        let n = tokens[i++];
        let isElement = false;
        if (n && n.type === 'literal' && n.value === ':') {
          isElement = true;
          n = tokens[i++];
        }
        if (!n) throw new SelectorError('expected pseudo name');
        if (n.type === 'ident') {
          const name = n.lowerValue;
          if (isElement || ['before', 'after', 'first-line', 'first-letter'].includes(name)) {
            pseudoElement = name;
            spec[2]++;
          } else {
            simples.push(pseudoClass(name));
            spec[1]++;
          }
        } else if (n.type === 'function') {
          if (isElement) {
            pseudoElement = n.lowerName;
            spec[2]++;
            continue;
          }
          const name = n.lowerName;
          if (['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'].includes(name)) {
            const nth = parseNth(n.arguments);
            if (!nth) throw new SelectorError(`invalid :${name}() argument`);
            simples.push({ kind: 'nth', a: nth[0], b: nth[1], last: name.includes('last'), ofType: name.endsWith('of-type') });
            spec[1]++;
          } else if (name === 'has') {
            const list = parseSelectorList(n.arguments);
            simples.push({ kind: 'has', list });
            const m = maxSpec(list);
            spec[0] += m[0];
            spec[1] += m[1];
            spec[2] += m[2];
          } else if (name === 'not' || name === 'is' || name === 'where' || name === 'matches') {
            const list = parseSelectorList(n.arguments);
            simples.push({ kind: name === 'not' ? 'not' : 'is', list });
            if (name !== 'where') {
              const m = maxSpec(list);
              spec[0] += m[0];
              spec[1] += m[1];
              spec[2] += m[2];
            }
          } else throw new SelectorError(`unsupported pseudo-class :${name}()`);
        } else throw new SelectorError('bad pseudo');
      } else throw new SelectorError(`unexpected token ${t.type}`);
    }
    if (!sawAny) throw new SelectorError('empty compound selector');
    parts.push({ simples });
    // Combinator.
    const hadWs = skipWs();
    const t = peek();
    if (!t) break;
    if (t.type === 'literal' && ['>', '+', '~'].includes(t.value)) {
      i++;
      combinators.push(t.value);
      skipWs();
      if (i >= tokens.length) throw new SelectorError('dangling combinator');
    } else if (hadWs) combinators.push(' ');
    else throw new SelectorError('unexpected token');
  }
  return { parts, combinators, pseudoElement, specificity: spec };
}

function parseAttr(content: Token[]): Simple {
  const toks = content.filter((t) => !ws(t));
  const name = toks[0];
  if (!name || name.type !== 'ident') throw new SelectorError('bad attribute selector');
  if (toks.length === 1) return { kind: 'attr', name: name.value, op: null, value: '', ci: false };
  let op = '';
  let k = 1;
  if (toks[k].type === 'literal' && toks[k].type === 'literal') {
    const first = (toks[k] as { value: string }).value;
    if (first === '=') {
      op = '=';
      k++;
    } else if (['~', '|', '^', '$', '*'].includes(first) && toks[k + 1]?.type === 'literal' && (toks[k + 1] as { value: string }).value === '=') {
      op = first + '=';
      k += 2;
    } else throw new SelectorError('bad attribute operator');
  }
  const v = toks[k++];
  if (!v || (v.type !== 'ident' && v.type !== 'string')) throw new SelectorError('bad attribute value');
  let ci = false;
  const flag = toks[k];
  if (flag && flag.type === 'ident' && flag.lowerValue === 'i') ci = true;
  return { kind: 'attr', name: name.value, op, value: v.value, ci };
}

function pseudoClass(name: string): Simple {
  const known = ['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type',
    'empty', 'root', 'link', 'any-link', 'checked', 'disabled', 'enabled', 'visited', 'hover', 'active', 'focus', 'target'];
  if (!known.includes(name)) throw new SelectorError(`unsupported pseudo-class :${name}`);
  return { kind: 'pseudo', name };
}

// --- Matching -----------------------------------------------------------------
const siblings = (el: Element): Element[] => (el.parent ? el.parent.elementChildren : [el]);

function matchSimple(s: Simple, el: Element): boolean {
  switch (s.kind) {
    // A type selector matches the local name, whatever the element's namespace (no default namespace is declared).
    case 'type': return el.tag.replace(/^\{[^}]*\}/, '').toLowerCase() === s.name;
    case 'universal': return true;
    case 'class': return (el.get('class') ?? '').split(/[ \t\n\f\r]+/).includes(s.name);
    case 'id': return el.get('id') === s.name;
    case 'attr': {
      let v = el.get(s.name);
      if (v === null) return false;
      let want = s.value;
      if (s.ci) {
        v = v.toLowerCase();
        want = want.toLowerCase();
      }
      switch (s.op) {
        case null: return true;
        case '=': return v === want;
        case '~=': return want !== '' && v.split(/[ \t\n\f\r]+/).includes(want);
        case '|=': return v === want || v.startsWith(want + '-');
        case '^=': return want !== '' && v.startsWith(want);
        case '$=': return want !== '' && v.endsWith(want);
        case '*=': return want !== '' && v.includes(want);
        default: return false;
      }
    }
    case 'nth': {
      let sibs = siblings(el);
      if (s.ofType) sibs = sibs.filter((x) => x.tag === el.tag);
      const idx = s.last ? sibs.length - sibs.indexOf(el) : sibs.indexOf(el) + 1;
      if (s.a === 0) return idx === s.b;
      const n = (idx - s.b) / s.a;
      return Number.isInteger(n) && n >= 0;
    }
    case 'pseudo': {
      const sibs = siblings(el);
      const same = sibs.filter((x) => x.tag === el.tag);
      switch (s.name) {
        case 'first-child': return sibs[0] === el;
        case 'last-child': return sibs[sibs.length - 1] === el;
        case 'only-child': return sibs.length === 1;
        case 'first-of-type': return same[0] === el;
        case 'last-of-type': return same[same.length - 1] === el;
        case 'only-of-type': return same.length === 1;
        case 'empty': return el.elementChildren.length === 0 && !el.text;
        case 'root': return el.parent === null;
        case 'link': case 'any-link': return ['a', 'area', 'link'].includes(el.tag) && el.attrs.has('href');
        default: return false;
      }
    }
    case 'has': {
      for (const d of el.iterElements()) {
        if (d !== el && s.list.some((sel) => matchSelectorFull(sel, d))) return true;
      }
      return false;
    }
    case 'not': return !s.list.some((sel) => matchSelectorFull(sel, el));
    case 'is': return s.list.some((sel) => matchSelectorFull(sel, el));
  }
}

const matchCompound = (c: Compound, el: Element): boolean => c.simples.every((s) => matchSimple(s, el));

function matchFrom(sel: Selector, idx: number, el: Element): boolean {
  if (!matchCompound(sel.parts[idx], el)) return false;
  if (idx === 0) return true;
  const comb = sel.combinators[idx - 1];
  if (comb === '>') return el.parent !== null && matchFrom(sel, idx - 1, el.parent);
  if (comb === ' ') {
    for (let p = el.parent; p; p = p.parent) if (matchFrom(sel, idx - 1, p)) return true;
    return false;
  }
  const sibs = siblings(el);
  const pos = sibs.indexOf(el);
  if (comb === '+') return pos > 0 && matchFrom(sel, idx - 1, sibs[pos - 1]);
  if (comb === '~') {
    for (let k = pos - 1; k >= 0; k--) if (matchFrom(sel, idx - 1, sibs[k])) return true;
    return false;
  }
  return false;
}

export function matchSelectorFull(sel: Selector, el: Element): boolean {
  return matchFrom(sel, sel.parts.length - 1, el);
}