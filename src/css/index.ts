// SPDX-License-Identifier: BSD-3-Clause

/**
 * Find and apply CSS (mirrors weasyprint/css/__init__.py).
 *
 * Steps 3 and 4 of the "CSS 2.1 processing model": retrieve the stylesheets of
 * a document and annotate every element with a value for every property.
 */
import type { Element } from '../dom.ts';
import type { Fetcher } from '../fetch.ts';
import { LOGGER } from '../logger.ts';
import { parseUrl } from './legacy.ts';
import { findStyleAttributes } from './presentational.ts';
import { getKeyword, getUrl, removeWhitespace, splitOnComma } from './tokens.ts';
import { parseDeclarationList, parseRuleList, parseStylesheet, serialize } from './parser.ts';
import type { AtRule, Declaration, QualifiedRule, Rule, Token } from './parser.ts';
import { INITIAL_VALUES, ZERO_PIXELS } from './properties.ts';
import { matchSelectorFull, parseNth, parseSelectorList, SelectorError } from './selectors.ts';
import type { Selector, Specificity } from './selectors.ts';
import { ComputedStyle, InitialStyle, weightCmp as weightCmpExported } from './style.ts';
import type { Cascaded, InitialPageSizes, Style, Weight } from './style.ts';
import { preprocessDeclarations } from './validation/index.ts';
import { preprocessDescriptors } from './validation/descriptors.ts';
import { PROPERTIES, validateNonShorthand } from './validation/properties.ts';
import { CounterStyle } from './counters.ts';
import { TargetCollector } from './targets.ts';
import type { ProcessedDeclaration } from './validation/index.ts';

export const PSEUDO_ELEMENTS = new Set([
  null, 'before', 'after', 'marker', 'first-line', 'first-letter', 'footnote-call', 'footnote-marker',
  'note-call', 'note-marker', 'note-callback',
]);
export const PAGE_MARGIN_BOXES = new Set([
  'bottom-center', 'bottom-left', 'bottom-left-corner', 'bottom-right', 'bottom-right-corner', 'left-bottom',
  'left-middle', 'left-top', 'right-bottom', 'right-middle', 'right-top', 'top-center', 'top-left',
  'top-left-corner', 'top-right', 'top-right-corner', 'footnote', 'note-area',
]);

export interface PageSelectorType {
  side: string | null;
  blank: boolean | null;
  first: boolean | null;
  index: [number, number, string | null] | null;
  name: string | null;
}
export interface PageType {
  side: 'left' | 'right';
  blank: boolean;
  index: number;
  name: string;
  groups: Array<[string, number]>;
}
type PageRule = [rule: AtRule, selectors: Array<[Specificity, string | null, PageSelectorType]>, declarations: ProcessedDeclaration[]];

// --- Media queries (mirrors css/media_queries.py) -----------------------------
export function evaluateMediaQuery(queryList: string[], deviceMediaType: string): boolean {
  return queryList.includes('all') || queryList.includes(deviceMediaType);
}
export function parseMediaQuery(tokensIn: Token[]): string[] | null {
  let tokens = removeWhitespace(tokensIn);
  if (!tokens.length) return ['all'];
  const media: string[] = [];
  if (tokens[0].type === 'ident' && tokens[0].lowerValue === 'only') tokens = tokens.slice(1);
  for (const part of splitOnComma(tokens)) {
    if (part.length === 1 && part[0].type === 'ident') media.push(part[0].lowerValue);
    else {
      LOGGER.warning(`Expected a media type, got '${serialize(part)}'`);
      return null;
    }
  }
  return media;
}

// --- Matcher --------------------------------------------------------------------
interface MatcherEntry {
  selector: Selector;
  order: number;
  declarations: ProcessedDeclaration[];
  layer: string | null;
}
export class Matcher {
  entries: MatcherEntry[] = [];
  private counter = 0;
  add(selector: Selector, declarations: ProcessedDeclaration[], layer: string | null): void {
    this.entries.push({ selector, order: this.counter++, declarations, layer });
  }
  /** Matching entries sorted by (specificity, order), like cssselect2.Matcher.match. */
  match(el: Element): MatcherEntry[] {
    const hits = this.entries.filter((e) => matchSelectorFull(e.selector, el));
    hits.sort((a, b) => {
      const sa = a.selector.specificity;
      const sb = b.selector.specificity;
      return sa[0] - sb[0] || sa[1] - sb[1] || sa[2] - sb[2] || a.order - b.order;
    });
    return hits;
  }
}

// --- Page selectors ---------------------------------------------------------------
interface PageData extends PageSelectorType {
  specificity: Specificity;
}
export function parsePageSelectors(rule: AtRule): PageData[] | null {
  const tokens = removeWhitespace(rule.prelude);
  const pageData: PageData[] = [];
  if (!tokens.length) {
    pageData.push({ side: null, blank: null, first: null, index: null, name: null, specificity: [0, 0, 0] });
    return pageData;
  }
  while (tokens.length) {
    const types: PageData = { side: null, blank: null, first: null, index: null, name: null, specificity: [0, 0, 0] };
    if (tokens[0].type === 'ident') {
      const token = tokens.shift() as Extract<Token, { type: 'ident' }>;
      types.name = token.value;
      types.specificity[0] = 1;
    }
    if (tokens.length === 1) return null;
    if (!tokens.length) {
      pageData.push(types);
      return pageData;
    }
    while (tokens.length) {
      const literal = tokens.shift()!;
      if (literal.type !== 'literal') return null;
      if (literal.value === ':') {
        if (!tokens.length) return null;
        if (tokens[0].type === 'ident') {
          const pseudo = (tokens.shift() as Extract<Token, { type: 'ident' }>).lowerValue;
          if (pseudo === 'left' || pseudo === 'right') {
            if (types.side && types.side !== pseudo) return null;
            types.side = pseudo;
            types.specificity[2]++;
            continue;
          }
          if (pseudo === 'blank' || pseudo === 'first') {
            types[pseudo] = true;
            types.specificity[1]++;
            continue;
          }
        } else if (tokens[0].type === 'function') {
          const fn = tokens.shift() as Extract<Token, { type: 'function' }>;
          if (fn.name !== 'nth') return null;
          let nthTokens = fn.arguments;
          let group: string | null = null;
          const ofIndex = fn.arguments.findIndex((a) => a.type === 'ident' && a.value === 'of');
          if (ofIndex !== -1) {
            nthTokens = fn.arguments.slice(0, ofIndex - 1);
            const g = fn.arguments.slice(ofIndex + 1).filter((t) => t.type !== 'comment' && t.type !== 'whitespace');
            if (g.length !== 1 || g[0].type !== 'ident') return null;
            group = g[0].value;
          }
          const nth = parseNth(nthTokens);
          if (!nth) return null;
          types.index = [nth[0], nth[1], group];
          types.specificity[1]++;
          if (group) types.specificity[0]++;
          continue;
        }
        return null;
      } else if (literal.value === ',') {
        if (tokens.length && types.specificity.some((x) => x)) break;
        return null;
      }
    }
    pageData.push(types);
  }
  return pageData;
}

// --- nesting + @import expansion -----------------------------------------------------

function trimWsTokens(tokens: Token[]): Token[] {
  let a = 0, b = tokens.length;
  while (a < b && (tokens[a].type === 'whitespace' || tokens[a].type === 'comment')) a++;
  while (b > a && (tokens[b - 1].type === 'whitespace' || tokens[b - 1].type === 'comment')) b--;
  return tokens.slice(a, b);
}

/** Combine a parent selector with a nested one (CSS Nesting): each '&' is
 * replaced by the parent selector with NO combinator (compound concat, e.g.
 * '&:last-of-type'); without '&', the parent descends (`parent child`). */
function spliceNesting(parent: Token[], child: Token[]): Token[] {
  const p = trimWsTokens(parent);
  const c = trimWsTokens(child);
  if (!p.length) return c;
  // Each comma-separated selector in the parent and the child is combined
  // separately (cross product), so `th, td { &:last-of-type {} }` yields
  // `th:last-of-type, td:last-of-type` rather than `th, td:last-of-type`.
  const parentAlts = splitTopLevelCommas(p);
  const childAlts = splitTopLevelCommas(c);
  const COMMA = { type: 'literal', value: ',' } as Token;
  const SPACE = { type: 'whitespace', value: ' ' } as Token;
  const out: Token[] = [];
  let first = true;
  for (const pa of parentAlts) {
    for (const ca of childAlts) {
      if (!first) out.push(COMMA, SPACE);
      first = false;
      const hasAmp = ca.some((t) => t.type === 'literal' && t.value === '&');
      if (!hasAmp) out.push(...pa, SPACE, ...ca);
      else for (const t of ca) {
        if (t.type === 'literal' && t.value === '&') out.push(...pa);
        else out.push(t);
      }
    }
  }
  return out;
}

/** Split a token list on top-level commas (commas inside () or [] don't count). */
function splitTopLevelCommas(tokens: Token[]): Token[][] {
  const groups: Token[][] = [[]];
  let depth = 0;
  for (const t of tokens) {
    if (t.type === 'literal' && (t.value === '(' || t.value === '[')) depth++;
    else if (t.type === 'literal' && (t.value === ')' || t.value === ']')) depth--;
    if (depth === 0 && t.type === 'literal' && t.value === ',') groups.push([]);
    else groups[groups.length - 1].push(t);
  }
  return groups.map((g) => trimWsTokens(g));
}

/** Expand one style rule into the matcher, recursing through nested rules. */
function expandStyleRule(rule: QualifiedRule, baseUrl: string | null, matcher: Matcher, layer: string | null,
  parentPrelude: Token[] | null = null): void {
  const prelude = parentPrelude === null ? rule.prelude : spliceNesting(parentPrelude, rule.prelude);
  let selectors: Selector[];
  try {
    selectors = parseSelectorList(prelude);
    for (const s of selectors) {
      if (!PSEUDO_ELEMENTS.has(s.pseudoElement)) {
        const p = serialize(prelude);
        if (s.pseudoElement!.startsWith('-')) {
          throw new SelectorError(`'${p}', ignored prefixed pseudo-element: ${s.pseudoElement}`);
        }
        throw new SelectorError(`'${p}', unknown pseudo-element: ${s.pseudoElement}`);
      }
    }
  } catch (e) {
    if (e instanceof SelectorError) {
      LOGGER.warning(`Invalid or unsupported selector, ${e.message}`);
      return;
    }
    throw e;
  }
  const contents = parseDeclarationList(rule.content, true, true, true);
  const declarations = preprocessDeclarations(baseUrl, contents.filter((c) => c.type !== 'qualified-rule'));
  if (declarations.length) for (const s of selectors) matcher.add(s, declarations, layer);
  for (const nested of contents) {
    if (nested.type === 'qualified-rule') expandStyleRule(nested, baseUrl, matcher, layer, prelude);
  }
}

/** Resolve @import rules (recursively) into an inline rule list, each entry
 * carrying the baseUrl of the sheet it came from. */
async function expandImports(rules: Rule[], baseUrl: string | null, fetcher: Fetcher, depth = 0,
): Promise<Array<{ rule: Rule; baseUrl: string | null }>> {
  const out: Array<{ rule: Rule; baseUrl: string | null }> = [];
  for (const rule of rules) {
    if (rule.type === 'at-rule' && rule.lowerAtKeyword === 'import' && rule.content === null) {
      if (depth > 10) {
        LOGGER.warning('@import nesting deeper than 10, ignored');
        continue;
      }
      let target: string | null = null;
      for (const t of rule.prelude) {
        if (t.type === 'url' || t.type === 'string') {
          try {
            const parsed = getUrl(t, baseUrl);
            if (parsed) target = parsed[1][1];
          } catch { /* relative URL with no base */ }
          break;
        }
      }
      if (target === null) {
        LOGGER.warning(`@import with an unresolvable URL ignored: ${serialize(rule.prelude)}`);
        continue;
      }
      try {
        const result = await fetcher.fetch(target);
        const imported = parseStylesheet(decodeCss(result.body));
        out.push(...await expandImports(imported, result.redirectedUrl ?? target, fetcher, depth + 1));
      } catch (e) {
        LOGGER.warning(`@import failed for '${target}': ${(e as Error).message}`);
      }
      continue;
    }
    out.push({ rule, baseUrl });
  }
  return out;
}

// --- CSS object ---------------------------------------------------------------------
export interface CSSOptions {
  baseUrl?: string | null;
  fetcher: Fetcher;
  mediaType?: string;
  matcher?: Matcher;
  pageRules?: PageRule[];
  layers?: string[];
  layer?: string | null;
  counterStyle?: CounterStyle;
}

export class CSS {
  baseUrl: string | null;
  matcher: Matcher;
  pageRules: PageRule[];
  layers: string[];
  counterStyle: CounterStyle;
  /** @font-face rules collected at parse time: descriptors + resolved srcs. */
  fontFaces: Array<{
    family: string; weight: number; italic: boolean; srcs: string[];
    /** font-feature-settings and font-variant descriptor values, and unicode-range as [start, end] pairs. */
    settings: any; variant: Array<[string, any]>; unicodeRanges: Array<[number, number]> | null;
  }> = [];
  /** @color-profile rules (Python: css.ColorProfile, fetched by the document). */
  colorProfiles: Array<{ name: string; src: string; renderingIntent: string; components: string[] | null }> = [];

  private constructor(entries: Array<{ rule: Rule; baseUrl: string | null }>, o: CSSOptions) {
    this.baseUrl = o.baseUrl ?? null;
    this.matcher = o.matcher ?? new Matcher();
    this.pageRules = o.pageRules ?? [];
    this.layers = o.layers ?? [];
    this.counterStyle = o.counterStyle ?? new CounterStyle();
    preprocessStylesheet(o.mediaType ?? 'print', entries, o.fetcher, this.matcher, this.pageRules, this.layers,
      false, o.layer ?? null, this.counterStyle, this.fontFaces, this.colorProfiles);
  }

  /** Parse a stylesheet, resolving @import rules through the fetcher. */
  static async fromString(css: string, o: CSSOptions): Promise<CSS> {
    const rules = parseStylesheet(css);
    const entries = await expandImports(rules, o.baseUrl ?? null, o.fetcher);
    return new CSS(entries, o);
  }

  /** Same as fromString without @import resolution — for built-in sheets. */
  static fromStringSync(css: string, o: CSSOptions): CSS {
    return new CSS(parseStylesheet(css).map((rule) => ({ rule, baseUrl: o.baseUrl ?? null })), o);
  }

  /** Fetch a stylesheet by URL (async because fetchers may hit the network). */
  static async fromUrl(url: string, o: CSSOptions): Promise<CSS> {
    const result = await o.fetcher.fetch(url);
    const css = decodeCss(result.body);
    const entries = await expandImports(parseStylesheet(css), result.redirectedUrl ?? url, o.fetcher);
    return new CSS(entries, { ...o, baseUrl: result.redirectedUrl ?? url });
  }
}

function decodeCss(bytes: Uint8Array): string {
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function preprocessStylesheet(
  deviceMediaType: string, entries: Array<{ rule: Rule; baseUrl: string | null }>, fetcher: Fetcher, matcher: Matcher,
  pageRules: PageRule[], layers: string[], ignoreImportsIn: boolean, layer: string | null, counterStyle: CounterStyle,
  fontFaces: CSS['fontFaces'], colorProfiles: CSS['colorProfiles'] = [],
): void {
  let ignoreImports = ignoreImportsIn;
  for (const { rule, baseUrl } of entries) {
    if (rule.type === 'error') {
      LOGGER.warning(`Parse error: ${rule.message}`);
      continue;
    }
    if (rule.type === 'at-rule' && rule.content === null) {
      if (!['import', 'layer', 'charset'].includes(rule.lowerAtKeyword)) {
        LOGGER.warning(`Unknown empty rule @${rule.atKeyword}`);
      } else if (rule.lowerAtKeyword === 'import') {
        LOGGER.warning(`@import rules are not supported yet (ignored): ${serialize(rule.prelude)}`);
      }
      continue;
    }
    if (rule.type === 'qualified-rule') {
      expandStyleRule(rule, baseUrl, matcher, layer);
      ignoreImports = true;
    } else if (rule.type === 'at-rule' && rule.lowerAtKeyword === 'media') {
      const media = parseMediaQuery(rule.prelude);
      if (media === null) {
        LOGGER.warning(`Invalid media type '${serialize(rule.prelude)}' the whole @media rule was ignored.`);
        continue;
      }
      if (!evaluateMediaQuery(media, deviceMediaType)) continue;
      const contentRules = parseRuleList(rule.content!, false);
      preprocessStylesheet(deviceMediaType, contentRules.map((r) => ({ rule: r, baseUrl })), fetcher, matcher, pageRules,
        layers, true, layer, counterStyle, fontFaces, colorProfiles);
    } else if (rule.type === 'at-rule' && rule.lowerAtKeyword === 'page') {
      const data = parsePageSelectors(rule);
      if (data === null) {
        LOGGER.warning(`Unsupported @page selector '${serialize(rule.prelude)}', the whole @page rule was ignored.`);
        continue;
      }
      ignoreImports = true;
      for (const pageData of data) {
        const { specificity, ...selectorType } = pageData;
        const content = parseDeclarationList(rule.content!);
        const declarations = preprocessDeclarations(baseUrl, content);
        if (declarations.length) pageRules.push([rule, [[specificity, null, selectorType]], declarations]);
        for (const marginRule of content) {
          if (marginRule.type !== 'at-rule') continue;
          if (!PAGE_MARGIN_BOXES.has(marginRule.lowerAtKeyword)) {
            LOGGER.warning(`Unknown @page rule @${marginRule.atKeyword}`);
            continue;
          }
          if (marginRule.content === null) {
            LOGGER.warning(`Empty @page rule @${marginRule.atKeyword}`);
            continue;
          }
          if (removeWhitespace(marginRule.prelude).length) {
            LOGGER.warning(`Invalid prelude '${serialize(marginRule.prelude)}' for @page rule @${marginRule.atKeyword}`);
            continue;
          }
          const marginDeclarations = preprocessDeclarations(baseUrl, parseDeclarationList(marginRule.content));
          if (marginDeclarations.length) {
            pageRules.push([marginRule, [[specificity, `@${marginRule.lowerAtKeyword}`, selectorType]], marginDeclarations]);
          }
        }
      }
    } else if (rule.type === 'at-rule' && rule.lowerAtKeyword === 'color-profile') {
      ignoreImports = true;
      // Python: parse_color_profile_name and the color-profile descriptors.
      const prelude = removeWhitespace(rule.prelude);
      const nameToken: any = prelude.length === 1 ? prelude[0] : null;
      const name = nameToken?.type === 'ident' && (nameToken.value.startsWith('--') || nameToken.value === 'device-cmyk')
        ? nameToken.value as string : null;
      if (name === null) {
        LOGGER.warning(`Invalid color profile name '${serialize(rule.prelude)}', the whole @color-profile rule was ignored.`);
        continue;
      }
      const descriptors: { src: string | null; renderingIntent: string; components: string[] | null } = {
        src: null, renderingIntent: 'relative-colorimetric', components: null,
      };
      for (const decl of parseDeclarationList(rule.content ?? [])) {
        if (decl.type !== 'declaration') continue;
        const tokens = removeWhitespace(decl.value);
        if (decl.lowerName === 'src') {
          const url = tokens.length === 1 ? getUrl(tokens[0], baseUrl) : null;
          if (url && url[0] === 'url' && (url as any)[1][0] === 'external') descriptors.src = (url as any)[1][1];
          else LOGGER.warning(`Ignored '${decl.name}' descriptor in @color-profile: invalid value.`);
        } else if (decl.lowerName === 'rendering-intent') {
          const keyword = tokens.length === 1 ? getKeyword(tokens[0]) : null;
          if (keyword && ['relative-colorimetric', 'absolute-colorimetric', 'perceptual', 'saturation'].includes(keyword)) {
            descriptors.renderingIntent = keyword;
          }
        } else if (decl.lowerName === 'components') {
          const parts = splitOnComma(tokens).map((part) => part.map((t: any) => (t.type === 'ident' ? t.value : null)));
          if (parts.every((part) => part.length && part.every((v) => v !== null))) descriptors.components = parts.map((part) => part.join(' '));
        } else LOGGER.warning(`Unknown descriptor '${decl.name}' for profile named '${name}'.`);
      }
      if (descriptors.src === null) {
        LOGGER.warning(`No source for profile named '${name}', the whole @color-profile rule was ignored.`);
        continue;
      }
      colorProfiles.push({ name, src: descriptors.src, renderingIntent: descriptors.renderingIntent, components: descriptors.components });
    } else if (rule.type === 'at-rule' && rule.lowerAtKeyword === 'font-face') {
      ignoreImports = true;
      if (rule.content === null) {
        LOGGER.warning('Empty @font-face rule');
        continue;
      }
      const descriptors = new Map<string, any>();
      for (const decl of parseDeclarationList(rule.content)) {
        if (decl.type !== 'declaration') continue;
        try {
          if (decl.lowerName === 'font-family') {
            const family = serialize(decl.value).trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
            if (family) descriptors.set('family', family);
          } else if (decl.lowerName === 'src') {
            const srcs: string[] = [];
            for (const token of decl.value) {
              try {
                const parsed = getUrl(token, baseUrl);
                if (parsed && parsed[1][0] === 'external') srcs.push(parsed[1][1]);
              } catch { /* try the next src */ }
            }
            if (srcs.length) descriptors.set('srcs', srcs);
          } else if (decl.lowerName === 'font-weight') {
            const kw = getKeyword(decl.value[0] ?? ({} as Token));
            descriptors.set('weight', kw === 'bold' ? 700 : kw === 'normal' ? 400 : Number((decl.value[0] as any)?.value) || 400);
          } else if (decl.lowerName === 'font-style') {
            descriptors.set('italic', getKeyword(decl.value[0] ?? ({} as Token)) === 'italic');
          } else if (decl.lowerName === 'font-feature-settings') {
            // Python: descriptors.font_feature_settings, the property validator.
            const value = PROPERTIES.get('font-feature-settings')!.fn(removeWhitespace(decl.value), baseUrl);
            if (value === null || value === undefined) throw new Error('invalid value');
            descriptors.set('settings', value);
          } else if (decl.lowerName === 'font-variant') {
            const value = fontVariantDescriptor(removeWhitespace(decl.value));
            if (value === null) throw new Error('invalid value');
            descriptors.set('variant', value);
          } else if (decl.lowerName === 'unicode-range') {
            // Python: descriptors.unicode_range, a comma-separated list of single unicode-range tokens.
            const ranges: Array<[number, number]> = [];
            for (const part of splitOnComma(removeWhitespace(decl.value))) {
              if (part.length !== 1 || part[0].type !== 'unicode-range') throw new Error('invalid value');
              ranges.push([(part[0] as any).start, (part[0] as any).end]);
            }
            descriptors.set('unicodeRanges', ranges);
          }
        } catch (error) {
          LOGGER.warning(`Invalid descriptor '${decl.name}' in @font-face: ${(error as Error).message}`);
        }
      }
      if (descriptors.get('family') && descriptors.get('srcs')) {
        fontFaces.push({
          family: descriptors.get('family')!,
          weight: descriptors.get('weight') ?? 400,
          italic: descriptors.get('italic') ?? false,
          srcs: descriptors.get('srcs')!,
          settings: descriptors.get('settings') ?? 'normal',
          variant: descriptors.get('variant') ?? [],
          unicodeRanges: descriptors.get('unicodeRanges') ?? null,
        });
      } else LOGGER.warning('Invalid @font-face rule: missing family or src');
    } else if (rule.type === 'at-rule' && rule.lowerAtKeyword === 'counter-style') {
      const name = CounterStyle.parseName(rule.prelude, counterStyle);
      if (name === null) {
        LOGGER.warning(`Invalid counter style name '${serialize(rule.prelude)}', the whole @counter-style rule was ignored.`);
        continue;
      }
      ignoreImports = true;
      const content = parseDeclarationList(rule.content!);
      const counter: Record<string, any> = {
        system: null, negative: null, prefix: null, suffix: null, range: null, pad: null, fallback: null,
        symbols: null, additive_symbols: null,
      };
      for (const [dname, dvalue] of preprocessDescriptors('counter-style', baseUrl, content)) counter[dname] = dvalue;
      const system = counter.system ?? [null, 'symbolic', null];
      if (system[0] === null) {
        const nSymbols = (counter.symbols ?? []).length;
        if (['cyclic', 'fixed', 'symbolic'].includes(system[1]) && nSymbols < 1) {
          LOGGER.warning(`In counter style '${name}', counter style '${system[1]}' needs at least one symbol`);
          continue;
        }
        if (['alphabetic', 'numeric'].includes(system[1]) && nSymbols < 2) {
          LOGGER.warning(`In counter style '${name}', counter style '${system[1]}' needs at least two symbols`);
          continue;
        }
        if (system[1] === 'additive' && (counter.additive_symbols ?? []).length < 2) {
          LOGGER.warning(`In counter style '${name}', counter style "additive" needs at least two additive symbols`);
          continue;
        }
      }
      counterStyle.set(name, counter);
    } else if (rule.type === 'at-rule' && ['import', 'layer', 'charset', 'namespace'].includes(rule.lowerAtKeyword)) {
      LOGGER.warning(`@${rule.atKeyword} rules are not supported yet (ignored)`);
    } else if (rule.type === 'at-rule') {
      LOGGER.warning(`Unknown rule @${rule.atKeyword}`);
    }
  }
  void layers;
  void ignoreImports;
}

// --- Style attributes ---------------------------------------------------------------
export function declarationPrecedence(origin: 'user agent' | 'user' | 'author', importance: boolean): number {
  if (origin === 'user agent') return 1;
  if (origin === 'user' && !importance) return 2;
  if (origin === 'author' && !importance) return 3;
  if (origin === 'author') return 4;
  return 5;
}

// --- StyleFor ---------------------------------------------------------------------------
export type StyleKey = Element | PageType;

export interface SheetEntry {
  sheet: CSS;
  origin: 'user agent' | 'user' | 'author';
  specificity: Specificity | null;
}

const weightCmp = (a: Weight, b: Weight): number => weightCmpExported(a, b);

export class StyleFor {
  private cascaded = new Map<StyleKey, Map<string | null, Cascaded>>();
  private computed = new Map<StyleKey, Map<string | null, ComputedStyle>>();
  /** Anchor registry shared with the formatting-structure build (upstream:
   * one TargetCollector for the cascade AND the build). */
  targetCollector = new TargetCollector();
  /** Fetched attachments by URL: <link rel=attachment> and <a rel=attachment> targets (Python: fetched when written). */
  attachmentBodies = new Map<string, { body: Uint8Array; mimeType: string | null }>();
  /** Fetched @color-profile rules by name (Python: the document's color_profiles). */
  colorProfiles = new Map<string, { name: string; content: Uint8Array; components: string[] | null; renderingIntent: string }>();
  initialPageSizes: InitialPageSizes = { box: null, area: null };
  sheets: SheetEntry[];
  fontConfig: unknown;
  root: Element;
  baseUrl: string | null;

  constructor(root: Element, baseUrl: string | null, sheets: SheetEntry[], fontConfig: unknown = null,
    presentationalHints = false) {
    this.sheets = sheets;
    this.fontConfig = fontConfig;
    this.root = root;
    this.baseUrl = baseUrl;
    const layerOrder = Infinity;

    const cascadedFor = (key: StyleKey, pseudo: string | null): Cascaded => {
      let byPseudo = this.cascaded.get(key);
      if (!byPseudo) this.cascaded.set(key, (byPseudo = new Map()));
      let c = byPseudo.get(pseudo);
      if (!c) byPseudo.set(pseudo, (c = new Map()));
      return c;
    };
    const apply = (style: Cascaded, declarations: ProcessedDeclaration[], weightBase: [number, number, Specificity], origin: SheetEntry['origin']): void => {
      for (const [name, values, importance] of declarations) {
        const precedence = declarationPrecedence(origin, importance);
        const weight: Weight = [precedence, weightBase[1], weightBase[2]];
        const old = style.get(name);
        if (!old || weightCmp(old[1], weight) <= 0) style.set(name, [values, weight]);
      }
    };

    // Style attributes (author origin, specificity (1,0,0)) and presentational hints (0,0,0).
    for (const [specificity, element, declarations, base] of findStyleAttributes(root, presentationalHints, baseUrl)) {
      const style = cascadedFor(element, null);
      apply(style, preprocessDeclarations(base, declarations), [0, layerOrder, specificity], 'author');
    }

    // Then the stylesheets, element by element in tree order so that parents have
    // computed styles before their children.
    for (const element of root.iterElements()) {
      for (const { sheet, origin, specificity: sheetSpecificity } of sheets) {
        for (const entry of sheet.matcher.match(element)) {
          const pseudo = entry.selector.pseudoElement;
          const spec: Specificity = sheetSpecificity ?? entry.selector.specificity;
          const layerOrderValue = entry.layer === null ? Infinity : sheet.layers.indexOf(entry.layer);
          apply(cascadedFor(element, pseudo), entry.declarations, [0, layerOrderValue, spec], origin);
        }
      }
      this.setComputedStyles(element, element.parent, null);
    }

    // Pseudo-elements inherit from their element, so they come last.
    for (const [key, byPseudo] of this.cascaded) {
      for (const pseudo of byPseudo.keys()) {
        if (pseudo) this.setComputedStyles(key, key as Element, pseudo);
      }
    }
  }

  get(key: StyleKey, pseudo: string | null = null): ComputedStyle {
    const style = this.computed.get(key)?.get(pseudo);
    if (!style) throw new Error('No computed style for key');
    const displayForCollapse = style.get('display') as string[];
    // In collapsed-borders mode the TABLE's own padding is ignored — but only
    // for the table/inline-table elements themselves, NOT table-cells (an
    // upstream exact-match; a substring check here zeroed every cell's padding).
    if (displayForCollapse.some((d) => d === 'table' || d === 'inline-table')) {
      if (style.get('border_collapse') === 'collapse') {
        for (const side of ['top', 'bottom', 'left', 'right']) style.set(`padding_${side}`, ZERO_PIXELS);
      }
    }
    const display = style.get('display') as string[];
    if (display.length === 1 && display[0].startsWith('table-') && display[0] !== 'table-caption') {
      for (const side of ['top', 'bottom', 'left', 'right']) style.set(`margin_${side}`, ZERO_PIXELS);
    }
    return style;
  }

  has(key: StyleKey, pseudo: string | null = null): boolean {
    return this.computed.get(key)?.has(pseudo) ?? false;
  }

  /** Set the computed values of styles for ``element`` (or pseudo-element). */
  setComputedStyles(element: StyleKey, parent: StyleKey | null, pseudoType: string | null, isPage = false): void {
    let parentStyle: Style | null;
    let rootStyle: Style;
    if (element === this.root && pseudoType === null) {
      parentStyle = null;
      rootStyle = new InitialStyle(this.fontConfig);
      rootStyle.initialPageSizes = this.initialPageSizes;
    } else {
      parentStyle = this.computed.get(parent as StyleKey)!.get(null)!;
      rootStyle = this.computed.get(this.root)!.get(null)!;
    }
    void isPage;
    const cascaded = this.cascaded.get(element)?.get(pseudoType) ?? new Map();
    const style = new ComputedStyle(parentStyle, cascaded, pseudoType, rootStyle, this.baseUrl, this.fontConfig, this.initialPageSizes);
    let byPseudo = this.computed.get(element);
    if (!byPseudo) this.computed.set(element, (byPseudo = new Map()));
    byPseudo.set(pseudoType, style);
    // Mirror upstream css/__init__.py: anchors join the collector at
    // computed-style time, BEFORE the formatting structure is built.
    const anchor = style.get('anchor');
    if (anchor) this.targetCollector.collectAnchor(anchor);
  }

  /** Cascade @page declarations for a page type. */
  addPageDeclarations(pageType: PageType): void {
    for (const { sheet, origin, specificity: sheetSpecificity } of this.sheets) {
      for (const [, selectorList, declarations] of sheet.pageRules) {
        for (const [specificity, pseudo, selectorType] of selectorList) {
          if (pageTypeMatch(selectorType, pageType)) {
            const spec = sheetSpecificity ?? specificity;
            let byPseudo = this.cascaded.get(pageType);
            if (!byPseudo) this.cascaded.set(pageType, (byPseudo = new Map()));
            let style = byPseudo.get(pseudo);
            if (!style) byPseudo.set(pseudo, (style = new Map()));
            for (const [name, values, importance] of declarations) {
              const precedence = declarationPrecedence(origin, importance);
              const weight: Weight = [precedence, Infinity, spec];
              const old = style.get(name);
              if (!old || weightCmp(old[1], weight) <= 0) style.set(name, [values, weight]);
            }
          }
        }
      }
    }
  }

  cascadedKeys(): Array<[StyleKey, string | null]> {
    const out: Array<[StyleKey, string | null]> = [];
    for (const [key, byPseudo] of this.cascaded) for (const p of byPseudo.keys()) out.push([key, p]);
    return out;
  }
}

function pageTypeMatch(sel: PageSelectorType, page: PageType): boolean {
  if (sel.side !== null && sel.side !== page.side) return false;
  if (sel.blank !== null && sel.blank !== page.blank) return false;
  if (sel.first !== null && sel.first !== (page.index === 0)) return false;
  if (sel.name !== null && sel.name !== page.name) return false;
  if (sel.index !== null) {
    const [a, b, name] = sel.index;
    const matches = (index: number): boolean => {
      const offset = index + 1 - b;
      return a === 0 ? offset === 0 : offset / a >= 0 && offset % a === 0;
    };
    if (name === null) return matches(page.index);
    if (name !== page.name) return false;
    for (const [groupName, index] of page.groups) {
      if (name === groupName && matches(index)) return true;
    }
    return false;
  }
  return true;
}

/** Find the stylesheets (<style> and <link rel=stylesheet>) of a document, in source order. */
export async function findStylesheets(
  root: Element, deviceMediaType: string, fetcher: Fetcher, baseUrl: string | null,
): Promise<CSS[]> {
  const out: CSS[] = [];
  for (const element of root.iterElements()) {
    if (element.tag !== 'style' && element.tag !== 'link') continue;
    const mimeType = (element.get('type', 'text/css') ?? 'text/css').split(';', 1)[0].trim();
    if (mimeType !== 'text/css') continue;
    const mediaAttr = (element.get('media', '') ?? '').trim() || 'all';
    const media = mediaAttr.split(',').map((m) => m.trim());
    if (!evaluateMediaQuery(media, deviceMediaType)) continue;
    if (element.tag === 'style') {
      const content = [element.text ?? '', ...element.children.map((c) => c.tail ?? '')].join('');
      out.push(await CSS.fromString(content, { baseUrl, fetcher, mediaType: deviceMediaType }));
    } else if (element.get('href')) {
      const rels = (element.get('rel', '') ?? '').match(/[^ \t\n\f\r]+/g) ?? [];
      const lower = rels.map((r) => r.toLowerCase());
      if (!lower.includes('stylesheet') || lower.includes('alternate')) continue;
      const href = parseUrl(element.get('href'), baseUrl);
      if (href !== null) {
        try {
          out.push(await CSS.fromUrl(href, { fetcher, mediaType: deviceMediaType }));
        } catch (e) {
          LOGGER.error(`Failed to load stylesheet at ${href}: ${(e as Error).message}`);
        }
      }
    }
  }
  return out;
}

export { parseUrl };
export { getUrl, INITIAL_VALUES };
export type { QualifiedRule };
const FONT_VARIANT_FEATURES = ['alternates', 'caps', 'east-asian', 'ligatures', 'numeric', 'position'];

/**
 * Python: descriptors.font_variant (with expand_font_variant): the @font-face font-variant descriptor as
 * [[longhand, value], ...], [] for normal/none/inherit, or null when invalid.
 */
function fontVariantDescriptor(tokens: Token[]): Array<[string, any]> | null {
  if (tokens.length === 1 && ['normal', 'none', 'inherit'].includes(getKeyword(tokens[0]) ?? '')) return [];
  const features = new Map<string, Token[]>(FONT_VARIANT_FEATURES.map((f) => [f, []]));
  for (const token of tokens) {
    if (getKeyword(token) === 'normal') return null; // only the specific values are allowed
    let found = false;
    for (const feature of FONT_VARIANT_FEATURES) {
      const validator = PROPERTIES.get(`font-variant-${feature}`)!.fn;
      let ok: any = null;
      try {
        ok = validator([token], null);
      } catch { /* not this feature */ }
      if (ok !== null && ok !== undefined) {
        features.get(feature)!.push(token);
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  const values: Array<[string, any]> = [];
  for (const [feature, featureTokens] of features) {
    if (!featureTokens.length) continue;
    try {
      values.push(validateNonShorthand(featureTokens, `font-variant-${feature}`, null, true)[0]);
    } catch {
      return null;
    }
  }
  return values;
}
