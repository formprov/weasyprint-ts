// SPDX-License-Identifier: BSD-3-Clause

/** Property expanders (shorthands), mirrors weasyprint/css/validation/expanders.py. */
import type { Token } from '../parser.ts';
import { parseColor } from '../color.ts';
import { INITIAL_VALUES } from '../properties.ts';
import { InvalidValues, getKeyword, getSingleKeyword, isVar, splitOnComma } from '../tokens.ts';
import { validateNonShorthand as _vns } from './properties.ts';
void _vns;
import {
  PROPERTIES, validateNonShorthand,
} from './properties.ts';

export type Expander = (tokens: Token[], name: string, baseUrl: string | null) => Array<[string, any]>;
export const EXPANDERS = new Map<string, Expander>();

const ident = (value: string): Token => ({ type: 'ident', value, lowerValue: value.toLowerCase() });
const number = (value: number): Token => ({ type: 'number', value, isInteger: Number.isInteger(value), repr: String(value) });

type Gen = (tokens: Token[], name: string, baseUrl: string | null) => Iterable<[string, Token[]]>;

/** Wrap an expander so it need not handle inherit/initial and suffix naming. */
function generic(expandedNames: string[], wrapped: Gen): Expander {
  return (tokens, name, baseUrl) => {
    const results = new Map<string, any>();
    let skipValidation = false;
    const keyword = getSingleKeyword(tokens);
    if (keyword === 'inherit' || keyword === 'initial') {
      for (const n of expandedNames) results.set(n, keyword);
      skipValidation = true;
    } else if (tokens.some(isVar)) {
      throw new InvalidValues('CSS variables in shorthands are not supported yet');
    }
    if (!skipValidation) {
      for (const [newName, newTokens] of wrapped(tokens, name, baseUrl)) {
        if (!expandedNames.includes(newName)) throw new Error(`unexpected expanded name ${newName}`);
        if (results.has(newName)) {
          throw new InvalidValues(`got multiple ${newName.replace(/^-|-$/g, '')} values in a ${name} shorthand`);
        }
        results.set(newName, newTokens);
      }
    }
    const out: Array<[string, any]> = [];
    for (const newName of expandedNames) {
      const actual = newName.startsWith('-') ? `${name}${newName}` : newName;
      let value: any;
      if (results.has(newName)) {
        value = results.get(newName);
        if (!skipValidation) value = validateNonShorthand(value, actual, baseUrl, true)[0][1];
      } else value = 'initial';
      out.push([actual, value]);
    }
    return out;
  };
}

const expander = (names: string | string[], fn: Expander): void => {
  for (const n of Array.isArray(names) ? names : [names]) EXPANDERS.set(n, fn);
};

function validator(name: string, tokens: Token[], baseUrl: string | null = null): any {
  const entry = PROPERTIES.get(name);
  if (!entry) throw new Error(`no validator ${name}`);
  return entry.fn(tokens, baseUrl);
}

// --- Sides ------------------------------------------------------------------
function expandSides(tokens: Token[], name: string, baseUrl: string | null, sides: string[]): Array<[string, any]> {
  const expandedNames = sides.map((side) => {
    if (/-(color|style|width)$/.test(name)) return `${name.slice(0, -6)}-${side}-${name.slice(-5)}`;
    if (name === 'inset' && !side.includes('-')) return side;
    return `${name}-${side}`;
  });
  if (tokens.some(isVar)) throw new InvalidValues('CSS variables in shorthands are not supported yet');
  let toks = tokens.slice();
  if (toks.length === 1) toks = Array(sides.length).fill(toks[0]);
  else if (sides.length === 4 && toks.length === 2) toks = [...toks, ...toks];
  else if (sides.length === 4 && toks.length === 3) toks = [...toks, toks[1]];
  else if (toks.length !== sides.length) throw new InvalidValues(`Expected 1 to ${sides.length} tokens, got ${toks.length}`);
  return expandedNames.map((n, i) => validateNonShorthand([toks[i]], n, baseUrl, true)[0]);
}

expander(['margin-block', 'margin-inline', 'padding-block', 'padding-inline', 'border-block-color', 'border-block-style',
  'border-block-width', 'border-inline-color', 'border-inline-style', 'border-inline-width', 'inset-block', 'inset-inline'],
(tokens, name, baseUrl) => expandSides(tokens, name, baseUrl, ['start', 'end']));

expander(['border-color', 'border-style', 'border-width', 'margin', 'padding', 'bleed', 'inset'], (tokens, name, baseUrl) => {
  let sides = ['top', 'right', 'bottom', 'left'];
  if (tokens.length && getKeyword(tokens[0]) === 'logical') {
    sides = ['block-start', 'inline-start', 'block-end', 'inline-end'];
    tokens = tokens.slice(1);
  }
  return expandSides(tokens, name, baseUrl, sides);
});

expander('border-radius', generic(
  ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
  function* (tokens, _name, baseUrl) {
    let horizontal: Token[] = [];
    let vertical: Token[] = [];
    let current = horizontal;
    for (const token of tokens) {
      if (token.type === 'literal' && token.value === '/') {
        if (current === horizontal) {
          if (token === tokens[tokens.length - 1]) throw new InvalidValues('Expected value after "/" separator');
          current = vertical;
        } else throw new InvalidValues('Expected only one "/" separator');
      } else current.push(token);
    }
    if (!vertical.length) vertical = horizontal.slice();
    const fill = (values: Token[]): Token[] => {
      if (values.length === 1) return [values[0], values[0], values[0], values[0]];
      if (values.length === 2) return [...values, ...values];
      if (values.length === 3) return [...values, values[1]];
      if (values.length !== 4) throw new InvalidValues(`Expected 1 to 4 token components got ${values.length}`);
      return values;
    };
    horizontal = fill(horizontal);
    vertical = fill(vertical);
    const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
    for (let i = 0; i < 4; i++) {
      const n = `border-${corners[i]}-radius`;
      const toks = [horizontal[i], vertical[i]];
      validateNonShorthand(toks, n, baseUrl, true);
      yield [n, toks];
    }
  }));

expander('list-style', generic(['-type', '-position', '-image'], function* (tokens, _n, baseUrl) {
  let typeSpecified = false;
  let imageSpecified = false;
  let noneCount = 0;
  let noneToken: Token | null = null;
  for (const token of tokens) {
    if (getKeyword(token) === 'none') {
      noneCount++;
      noneToken = token;
      continue;
    }
    let suffix: string;
    if (validator('list-style-image', [token], baseUrl) !== null) {
      suffix = '-image';
      imageSpecified = true;
    } else if (validator('list-style-position', [token]) !== null) suffix = '-position';
    else if (validator('list-style-type', [token]) !== null) {
      suffix = '-type';
      typeSpecified = true;
    } else throw new InvalidValues();
    yield [suffix, [token]];
  }
  if (!typeSpecified && noneCount) {
    yield ['-type', [noneToken!]];
    noneCount--;
  }
  if (!imageSpecified && noneCount) {
    yield ['-image', [noneToken!]];
    noneCount--;
  }
  if (noneCount) throw new InvalidValues();
}));

const expandBorderSide = generic(['-width', '-color', '-style'], function* (tokens) {
  for (const token of tokens) {
    let suffix: string;
    if (parseColor(token) !== null) suffix = '-color';
    else if (validator('border-top-width', [token]) !== null) suffix = '-width';
    else if (validator('border-top-style', [token]) !== null) suffix = '-style';
    else throw new InvalidValues();
    yield [suffix, [token]];
  }
});
expander(['border-top', 'border-right', 'border-bottom', 'border-left', 'border-block-start', 'border-block-end',
  'border-inline-start', 'border-inline-end', 'column-rule', 'outline'], expandBorderSide);
expander('border', (tokens, name, baseUrl) => {
  if (tokens.some(isVar)) throw new InvalidValues('CSS variables in shorthands are not supported yet');
  return ['top', 'right', 'bottom', 'left'].flatMap((s) => expandBorderSide(tokens, `${name}-${s}`, baseUrl));
});
expander(['border-block', 'border-inline'], (tokens, name, baseUrl) =>
  ['start', 'end'].flatMap((s) => expandBorderSide(tokens, `${name}-${s}`, baseUrl)));

// --- Background ---------------------------------------------------------------
const BG_NAMES = ['background-color', 'background-image', 'background-repeat', 'background-attachment',
  'background-position', 'background-size', 'background-clip', 'background-origin'];

expander('background', (tokens, _name, baseUrl) => {
  const keyword = getSingleKeyword(tokens);
  if (keyword === 'initial' || keyword === 'inherit') return BG_NAMES.map((n) => [n, keyword] as [string, any]);
  if (tokens.some(isVar)) throw new InvalidValues('CSS variables in shorthands are not supported yet');
  const single = (prop: string, toks: Token[], url: string | null = null): any => {
    const fn = (PROPERTIES.get(prop)!.fn as any).singleValue ?? PROPERTIES.get(prop)!.fn;
    return fn(toks, url);
  };
  const parseLayer = (input: Token[], finalLayer: boolean): [any, Record<string, any>] => {
    const results: Record<string, any> = {};
    const add = (n: string, value: any): boolean => {
      if (value === null || value === undefined) return false;
      const key = `background-${n}`;
      if (key in results) throw new InvalidValues();
      results[key] = value;
      return true;
    };
    const stack = input.slice().reverse();
    while (stack.length) {
      if (add('repeat', single('background-repeat', stack.slice(-2).reverse()))) {
        stack.splice(-2, 2);
        continue;
      }
      const token = stack.slice(-1);
      if (finalLayer && add('color', parseColor(token[0]) ? token[0] : null)) {
        stack.pop();
        continue;
      }
      if (add('image', single('background-image', token, baseUrl))) {
        stack.pop();
        continue;
      }
      if (add('repeat', single('background-repeat', token))) {
        stack.pop();
        continue;
      }
      if (add('attachment', single('background-attachment', token))) {
        stack.pop();
        continue;
      }
      let position: any = null;
      for (const n of [4, 3, 2, 1].slice(-stack.length)) {
        const nTokens = stack.slice(-n).reverse();
        position = single('background-position', nTokens);
        if (position !== null) {
          add('position', position);
          stack.splice(-n, n);
          const top = stack[stack.length - 1];
          if (top && top.type === 'literal' && top.value === '/') {
            for (const m of [3, 2].slice(-stack.length)) {
              const sTokens = stack.slice(-m, -1).reverse();
              const size = single('background-size', sTokens);
              if (size !== null) {
                add('size', size);
                stack.splice(-m, m);
              }
            }
          }
          break;
        }
      }
      if (position !== null) continue;
      if (add('origin', single('background-origin', token))) {
        stack.pop();
        const next = stack.slice(-1);
        if (add('clip', single('background-clip', next))) stack.pop();
        else add('clip', single('background-clip', token));
        continue;
      }
      throw new InvalidValues();
    }
    const color = results['background-color'] ?? 'transparent';
    delete results['background-color'];
    for (const n of BG_NAMES) {
      if (!(n in results) && n !== 'background-color') results[n] = INITIAL_VALUES[n.replace(/-/g, '_')][0];
    }
    return [color, results];
  };
  const layers = splitOnComma(tokens).reverse();
  const [color, last] = parseLayer(layers[0], true);
  const results: Record<string, any[]> = {};
  for (const [k, v] of Object.entries(last)) results[k] = [v];
  for (const layerTokens of layers.slice(1)) {
    const [, layer] = parseLayer(layerTokens, false);
    for (const [k, v] of Object.entries(layer)) results[k].push(v);
  }
  const out: Array<[string, any]> = [];
  for (const [k, v] of Object.entries(results)) out.push([k, v.reverse()]);
  out.push(['background-color', color]);
  return out;
});

expander('text-decoration', generic(['-line', '-color', '-style', '-thickness'], function* (tokens) {
  const line: Token[] = [];
  const color: Token[] = [];
  const style: Token[] = [];
  const thickness: Token[] = [];
  let noneInLine = false;
  for (const token of tokens) {
    const k = getKeyword(token);
    if (k && ['none', 'underline', 'overline', 'line-through', 'blink'].includes(k)) {
      line.push(token);
      if (noneInLine) throw new InvalidValues();
      if (k === 'none') noneInLine = true;
    } else if (k && ['solid', 'double', 'dotted', 'dashed', 'wavy'].includes(k)) {
      if (style.length) throw new InvalidValues();
      style.push(token);
    } else if (parseColor(token)) {
      if (color.length) throw new InvalidValues();
      color.push(token);
    } else if (validator('text-decoration-thickness', [token]) !== null) {
      if (thickness.length) throw new InvalidValues();
      thickness.push(token);
    } else throw new InvalidValues();
  }
  if (line.length) yield ['-line', line];
  if (color.length) yield ['-color', color];
  if (style.length) yield ['-style', style];
  if (thickness.length) yield ['-thickness', thickness];
}));

function pageBreak(name: string, newName: string): Gen {
  return function* (tokens) {
    const k = getSingleKeyword(tokens);
    if (k && ['auto', 'left', 'right', 'avoid'].includes(k)) yield [newName, tokens];
    else if (k === 'always') yield [newName, [ident('page')]];
    else throw new InvalidValues();
    void name;
  };
}
expander('page-break-after', generic(['break-after'], pageBreak('page-break-after', 'break-after')));
expander('page-break-before', generic(['break-before'], pageBreak('page-break-before', 'break-before')));
expander('page-break-inside', generic(['break-inside'], function* (tokens) {
  const k = getSingleKeyword(tokens);
  if (k === 'auto' || k === 'avoid') yield ['break-inside', tokens];
  else throw new InvalidValues();
}));

expander('columns', generic(['column-width', 'column-count'], function* (tokens) {
  let name: string | null = null;
  if (tokens.length === 2 && getKeyword(tokens[0]) === 'auto') tokens = tokens.slice().reverse();
  for (const token of tokens) {
    if (validator('column-width', [token]) !== null && name !== 'column-width') name = 'column-width';
    else if (validator('column-count', [token]) !== null) name = 'column-count';
    else throw new InvalidValues();
    yield [name, [token]];
  }
  if (tokens.length === 1) yield [name === 'column-count' ? 'column-width' : 'column-count', [ident('auto')]];
}));

expander('font-variant', generic(
  ['-alternates', '-caps', '-east-asian', '-ligatures', '-numeric', '-position'],
  function* (tokens) {
    const keyword = getSingleKeyword(tokens);
    if (keyword === 'normal' || keyword === 'none') {
      for (const suffix of ['-alternates', '-caps', '-east-asian', '-numeric', '-position']) yield [suffix, [ident('normal')]];
      yield ['-ligatures', [ident(keyword)]];
      return;
    }
    const features: Record<string, Token[]> = {
      alternates: [], caps: [], 'east-asian': [], ligatures: [], numeric: [], position: [],
    };
    for (const token of tokens) {
      if (getKeyword(token) === 'normal') throw new InvalidValues();
      let found = false;
      for (const feature of Object.keys(features)) {
        if (validator(`font-variant-${feature}`, [token])) {
          features[feature].push(token);
          found = true;
          break;
        }
      }
      if (!found) throw new InvalidValues();
    }
    for (const [feature, toks] of Object.entries(features)) if (toks.length) yield [`-${feature}`, toks];
  }));

expander('font', generic(
  ['-style', '-variant-caps', '-weight', '-stretch', '-size', 'line-height', '-family'],
  function* (tokens) {
    const kw = getSingleKeyword(tokens);
    if (kw && ['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar'].includes(kw)) {
      throw new InvalidValues('System fonts are not supported');
    }
    const stack = tokens.slice().reverse();
    let token: Token | undefined;
    let broke = false;
    for (let i = 0; i < 4; i++) {
      token = stack.pop()!;
      if (getKeyword(token) === 'normal') continue;
      let suffix: string;
      if (validator('font-style', [token]) !== null) suffix = '-style';
      else if (validator('font-variant-caps', [token]) !== null) suffix = '-variant-caps';
      else if (validator('font-weight', [token]) !== null) suffix = '-weight';
      else if (validator('font-stretch', [token]) !== null) suffix = '-stretch';
      else {
        broke = true;
        break;
      }
      yield [suffix, [token]];
      if (!stack.length) throw new InvalidValues();
    }
    if (!broke) {
      if (!stack.length) throw new InvalidValues();
      token = stack.pop()!;
    }
    if (validator('font-size', [token!]) === null) throw new InvalidValues();
    yield ['-size', [token!]];
    if (!stack.length) throw new InvalidValues();
    token = stack.pop()!;
    if (token.type === 'literal' && token.value === '/') {
      token = stack.pop()!;
      if (validator('line-height', [token]) === null) throw new InvalidValues();
      yield ['line-height', [token]];
    } else stack.push(token);
    stack.reverse();
    if (validator('font-family', stack) === null) throw new InvalidValues();
    yield ['-family', stack];
  }));

expander('word-wrap', generic(['overflow-wrap'], function* (tokens) {
  if (validator('overflow-wrap', tokens) === null) throw new InvalidValues();
  yield ['overflow-wrap', tokens];
}));

expander('flex', generic(['-grow', '-shrink', '-basis'], function* (tokens) {
  if (getSingleKeyword(tokens) === 'none') {
    yield ['-grow', [number(0)]];
    yield ['-shrink', [number(0)]];
    yield ['-basis', [ident('auto')]];
    return;
  }
  let grow = 1;
  let shrink = 1;
  let basis: Token | null = null;
  let growFound = false;
  let shrinkFound = false;
  let basisFound = false;
  for (const token of tokens) {
    const forced = token.type === 'number' && token.isInteger && token.value === 0 && !(growFound && shrinkFound);
    if (!basisFound && !forced) {
      if (validator('flex-basis', [token]) !== null) {
        basis = token;
        basisFound = true;
        continue;
      }
    }
    if (!growFound) {
      const n = validator('flex-grow', [token]);
      if (n === null) throw new InvalidValues();
      grow = n;
      growFound = true;
    } else if (!shrinkFound) {
      const n = validator('flex-shrink', [token]);
      if (n === null) throw new InvalidValues();
      shrink = n;
      shrinkFound = true;
    } else throw new InvalidValues();
  }
  if (!basisFound) basis = { type: 'dimension', value: 0, isInteger: true, unit: 'px', lowerUnit: 'px', repr: '0' };
  yield ['-grow', [number(grow)]];
  yield ['-shrink', [number(shrink)]];
  yield ['-basis', [basis!]];
}));

expander('flex-flow', generic(['flex-direction', 'flex-wrap'], function* (tokens) {
  if (tokens.length === 2) {
    for (const sorted of [tokens, tokens.slice().reverse()]) {
      if (validator('flex-direction', [sorted[0]]) !== null && validator('flex-wrap', [sorted[1]]) !== null) {
        yield ['flex-direction', [sorted[0]]];
        yield ['flex-wrap', [sorted[1]]];
        return;
      }
    }
    throw new InvalidValues();
  } else if (tokens.length === 1) {
    if (validator('flex-direction', [tokens[0]]) !== null) yield ['flex-direction', [tokens[0]]];
    else if (validator('flex-wrap', [tokens[0]]) !== null) yield ['flex-wrap', [tokens[0]]];
    else throw new InvalidValues();
  } else throw new InvalidValues();
}));

expander('text-align', generic(['-all', '-last'], function* (tokens) {
  if (tokens.length !== 1) throw new InvalidValues();
  const keyword = getSingleKeyword(tokens);
  if (keyword === null) throw new InvalidValues();
  const alignAll = keyword === 'justify-all' ? ident('justify') : tokens[0];
  yield ['-all', [alignAll]];
  yield ['-last', [keyword === 'justify' ? ident('start') : alignAll]];
}));

function* expandGap(tokens: Token[]): Generator<[string, Token[]]> {
  const gap = (t: Token[]): any => validator('column-gap', t);
  if (tokens.length === 1) {
    if (gap(tokens) === null) throw new InvalidValues();
    yield ['row-gap', tokens];
    yield ['column-gap', tokens];
  } else if (tokens.length === 2) {
    if (gap(tokens.slice(0, 1)) === null || gap(tokens.slice(1, 2)) === null) throw new InvalidValues();
    yield ['row-gap', tokens.slice(0, 1)];
    yield ['column-gap', tokens.slice(1, 2)];
  } else throw new InvalidValues();
}
expander(['grid-gap', 'gap'], generic(['column-gap', 'row-gap'], (tokens) => expandGap(tokens)));
expander('grid-column-gap', generic(['column-gap'], function* (tokens) {
  if (validator('column-gap', tokens) === null) throw new InvalidValues();
  yield ['column-gap', tokens];
}));
expander('grid-row-gap', generic(['row-gap'], function* (tokens) {
  if (validator('row-gap', tokens) === null) throw new InvalidValues();
  yield ['row-gap', tokens];
}));
expander('place-content', generic(['align-content', 'justify-content'], function* () { throw new InvalidValues(); }));
expander('place-items', generic(['align-items', 'justify-items'], function* () { throw new InvalidValues(); }));
expander('place-self', generic(['align-self', 'justify-self'], function* () { throw new InvalidValues(); }));
expander('line-clamp', generic(['max-lines', 'continue', 'block-ellipsis'], function* (tokens) {
  if (tokens.length === 1) {
    if (getSingleKeyword(tokens) === 'none') {
      yield ['max-lines', [ident('none')]];
      yield ['continue', [ident('auto')]];
      yield ['block-ellipsis', [ident('none')]];
    } else if (tokens[0].type === 'number' && tokens[0].isInteger) {
      yield ['max-lines', [tokens[0]]];
      yield ['continue', [ident('discard')]];
      yield ['block-ellipsis', [ident('auto')]];
    } else throw new InvalidValues();
  } else if (tokens.length === 2) {
    if (tokens[0].type === 'number') {
      const maxLines = tokens[0].isInteger ? tokens[0].value : null;
      const ellipsis = validator('block-ellipsis', [tokens[1]]);
      if (maxLines && ellipsis !== null) {
        yield ['max-lines', [tokens[0]]];
        yield ['continue', [ident('discard')]];
        yield ['block-ellipsis', [tokens[1]]];
      } else throw new InvalidValues();
    } else throw new InvalidValues();
  } else throw new InvalidValues();
}));
// --- Grid -------------------------------------------------------------------
// Ports the grid section of weasyprint/css/validation/expanders.py.

/** Python: _expand_grid_template. Returns [suffix, tokens] pairs or throws InvalidValues. */
function expandGridTemplate(tokens: Token[]): Array<[string, Token[]]> {
  const none = ident('none');
  if (tokens.length === 1 && getKeyword(tokens[0]) === 'none') {
    return [['-columns', [none]], ['-rows', [none]], ['-areas', [none]]];
  }
  const slashSeparated: Token[][] = [[]];
  for (const token of tokens) {
    if (token.type === 'literal' && token.value === '/') slashSeparated.push([]);
    else slashSeparated[slashSeparated.length - 1].push(token);
  }
  if (slashSeparated.length === 2) {
    const rows = validatorGridTemplate(slashSeparated[0]);
    const columns = validatorGridTemplate(slashSeparated[1]);
    if (columns !== null && columns.length) {
      if (rows !== null && rows.length) {
        return [['-columns', slashSeparated[1]], ['-rows', slashSeparated[0]], ['-areas', [none]]];
      }
    }
  }
  // TODO: Handle last syntax (same as the reference).
  throw new InvalidValues();
}

/** Python: grid_template validator (grid-template-rows). */
function validatorGridTemplate(tokens: Token[]): any {
  return validator('grid-template-rows', tokens);
}

expander('grid-template', generic(['-columns', '-rows', '-areas'], function* (tokens) {
  yield* expandGridTemplate(tokens);
}));

expander('grid', generic(
  ['-template-columns', '-template-rows', '-template-areas', '-auto-columns', '-auto-rows', '-auto-flow'],
  function* (tokens) {
    const auto = ident('auto');
    const none = ident('none');
    const row = ident('row');
    const column = ident('column');
    let template: Array<[string, Token[]]> | null = null;
    try {
      template = expandGridTemplate(tokens);
    } catch (error) {
      if (!(error instanceof InvalidValues)) throw error;
    }
    if (template !== null) {
      for (const [key, value] of template) yield [`-template-${key.split('-').pop()}`, value];
      yield ['-auto-columns', [auto]];
      yield ['-auto-rows', [auto]];
      yield ['-auto-flow', [row]];
      return;
    }
    const splitTokens: Token[][] = [[]];
    for (const token of tokens) {
      if (token.type === 'literal' && token.value === '/') {
        splitTokens.push([]);
        continue;
      }
      splitTokens[splitTokens.length - 1].push(token);
    }
    if (splitTokens.length !== 2) throw new InvalidValues();
    let autoTrack: string | null = null;
    let dense: Token | null = null;
    const templates: Record<string, Token[]> = { row: [], column: [] };
    const tracks = ['row', 'column'];
    for (let i = 0; i < 2; i++) {
      const toks = splitTokens[i];
      const track = tracks[i];
      let autoFlowToken = false;
      for (const token of toks) {
        if (getKeyword(token) === 'dense') {
          if (dense !== null || (autoTrack !== null && autoTrack !== track)) throw new InvalidValues();
          dense = token;
          autoTrack = track;
        } else if (getKeyword(token) === 'auto-flow') {
          if (autoFlowToken || (autoTrack !== null && autoTrack !== track)) throw new InvalidValues();
          autoFlowToken = true;
          autoTrack = track;
        } else if (token === toks[toks.length - 1]) {
          templates[track].push(token);
        } else throw new InvalidValues();
      }
    }
    if (!autoTrack) throw new InvalidValues();
    const nonAutoTrack = autoTrack === 'column' ? 'row' : 'column';
    const autoTrackToken = autoTrack === 'column' ? column : row;
    yield ['-auto-flow', dense !== null ? [autoTrackToken, dense] : [autoTrackToken]];
    yield [`-auto-${autoTrack}s`, templates[autoTrack]];
    yield [`-auto-${nonAutoTrack}s`, [auto]];
    yield [`-template-${autoTrack}s`, [none]];
    yield [`-template-${nonAutoTrack}s`, templates[nonAutoTrack]];
    yield ['-template-areas', [ident('none')]];
  },
));

/** Python: _expand_grid_column_row_area. Yields one token list per side (generator semantics kept). */
function expandGridColumnRowArea(tokens: Token[], maxNumber: number): Token[][] {
  const gridLines: Token[][] = [[]];
  for (const token of tokens) {
    if (token.type === 'literal' && token.value === '/') {
      gridLines.push([]);
      continue;
    }
    gridLines[gridLines.length - 1].push(token);
  }
  if (!(gridLines.length >= 1 && gridLines.length <= maxNumber)) throw new InvalidValues();
  const validations: any[] = [];
  const out: Token[][] = [];
  for (const lineTokens of gridLines) {
    const validation = validator('grid-row-start', lineTokens);
    if (!validation) throw new InvalidValues();
    validations.push(validation);
    out.push(lineTokens);
  }
  const auto = ident('auto');
  // Python: `custom_ident = set(validations[i][:2]) == {None}`. A keyword such as 'auto' is a string and
  // never qualifies (its characters are not None).
  const isCustomIdent = (v: any): boolean => Array.isArray(v) && v.slice(0, 2).every((x) => x === null);
  const lines = gridLines.length;
  if (lines <= 1) {
    const customIdent = isCustomIdent(validations[0]);
    const value = customIdent ? gridLines[0] : [auto];
    gridLines.push(gridLines[gridLines.length - 1]);
    validations.push(validations[0]);
    out.push(value);
  }
  if (lines <= 2 && 2 < maxNumber) {
    const customIdent = isCustomIdent(validations[0]);
    out.push(customIdent ? gridLines[0] : [auto]);
  }
  if (lines <= 3 && 3 < maxNumber) {
    const customIdent = isCustomIdent(validations[1]);
    out.push(customIdent ? gridLines[1] : [auto]);
  }
  return out;
}

expander(['grid-column', 'grid-row'], generic(['-start', '-end'], function* (tokens) {
  const list = expandGridColumnRowArea(tokens, 2);
  for (let i = 0; i < Math.min(list.length, 2); i++) yield [i === 0 ? '-start' : '-end', list[i]];
}));

expander('grid-area', generic(['grid-row-start', 'grid-row-end', 'grid-column-start', 'grid-column-end'],
  function* (tokens) {
    const list = expandGridColumnRowArea(tokens, 4);
    const sides = ['row-start', 'column-start', 'row-end', 'column-end'];
    for (let i = 0; i < Math.min(list.length, sides.length); i++) yield [`grid-${sides[i]}`, list[i]];
  }));
