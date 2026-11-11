// SPDX-License-Identifier: BSD-3-Clause

/** Style dictionaries (mirrors Style/InitialStyle/AnonymousStyle/ComputedStyle in css/__init__.py). */
import { LOGGER } from '../logger.ts';
import { COMPUTER_FUNCTIONS } from './computed_values.ts';
import { INHERITED, INITIAL_NOT_COMPUTED, INITIAL_VALUES } from './properties.ts';
import { InvalidValues, isMath, removeWhitespace, splitOnComma } from './tokens.ts';
import { Pending, validateNonShorthand } from './validation/properties.ts';
import { expandSingle } from './validation/index.ts';
import { PercentageInMath, resolveMath } from './math.ts';
import type { Token } from './parser.ts';
import type { Dimension } from './properties.ts';

export type Weight = [precedence: number, layerOrder: number, specificity: [number, number, number]];

export const weightCmp = (a: Weight, b: Weight): number => {
  if (a[0] !== b[0]) return a[0] - b[0];
  const la = a[1];
  const lb = b[1];
  if (la !== lb) return la === lb ? 0 : la < lb ? -1 : 1;
  for (let i = 0; i < 3; i++) if (a[2][i] !== b[2][i]) return a[2][i] - b[2][i];
  return 0;
};
export type Cascaded = Map<string, [value: any, weight: Weight]>;

export interface InitialPageSizes {
  box: [number, number] | null;
  area: [number, number] | null;
}

export abstract class Style {
  values = new Map<string, any>();
  parentStyle: Style | null = null;
  rootStyle: Style | null = null;
  isRootElement = false;
  pseudoType: string | null = null;
  specified: Record<string, any> = {};
  cache: Map<string, any> = new Map();
  initialPageSizes: InitialPageSizes = { box: null, area: null };
  fontConfig: unknown = null;
  baseUrl: string | null = null;
  private _anonymous: AnonymousStyle | null = null;

  get anonymousStyle(): AnonymousStyle {
    return (this._anonymous ??= new AnonymousStyle(this));
  }

  abstract get(key: string): any;

  has(key: string): boolean {
    return this.values.has(key);
  }

  set(key: string, value: any): void {
    this.values.set(key, value);
  }

  abstract copy(): Style;
}

export class InitialStyle extends Style {
  constructor(fontConfig: unknown = null) {
    super();
    this.specified = this as any;
    this.fontConfig = fontConfig;
    this.rootStyle = this;
  }

  get(key: string): any {
    if (this.values.has(key)) return this.values.get(key);
    const value = INITIAL_VALUES[key];
    if (value === undefined && !(key in INITIAL_VALUES)) throw new Error(`Unknown property ${key}`);
    this.values.set(key, value);
    return value;
  }

  copy(): Style {
    const c = new InitialStyle(this.fontConfig);
    c.values = new Map(this.values);
    return c;
  }
}

function textDecoration(key: string, value: any, parentValue: any, cascaded: boolean): any {
  const textProperties = ['text_decoration_color', 'text_decoration_style', 'text_decoration_thickness'];
  if (textProperties.includes(key)) {
    if (!cascaded) value = parentValue;
  } else if (key === 'text_decoration_line') {
    if (parentValue !== 'none') {
      if (value === 'none') value = parentValue;
      else value = new Set([...value, ...(parentValue as Set<string>)]);
    }
  }
  return value;
}

export class AnonymousStyle extends Style {
  constructor(parentStyle: Style) {
    super();
    for (const k of ['border_top_width', 'border_bottom_width', 'border_left_width', 'border_right_width', 'outline_width']) {
      this.values.set(k, 0);
    }
    this.parentStyle = parentStyle;
    this.rootStyle = parentStyle.rootStyle;
    this.specified = this as any;
    this.cache = parentStyle.cache;
    this.fontConfig = parentStyle.fontConfig;
    this.initialPageSizes = parentStyle.initialPageSizes;
  }

  get(key: string): any {
    if (this.values.has(key)) return this.values.get(key);
    let value: any;
    if (INHERITED.has(key) || key.startsWith('__')) {
      value = this.parentStyle!.get(key);
      this.values.set(key, value);
    } else if (key === 'page') {
      value = this.parentStyle!.get(key);
      this.values.set(key, value);
    } else if (key.startsWith('text_decoration_')) {
      value = textDecoration(key, INITIAL_VALUES[key], this.parentStyle!.get(key), false);
      this.values.set(key, value);
    } else {
      value = INITIAL_VALUES[key];
      if (INITIAL_NOT_COMPUTED.has(key)) value = COMPUTER_FUNCTIONS[key](this, key, value);
      this.values.set(key, value);
    }
    return value;
  }

  copy(): Style {
    const c = new AnonymousStyle(this.parentStyle!);
    c.values = new Map(this.values);
    return c;
  }
}

export class ComputedStyle extends Style {
  cascaded: Cascaded;
  /** Resolved custom properties cache: name -> token list (null = unresolvable). */
  private customPropsCache = new Map<string, Token[] | null>();
  /** Expanded Pending shorthands cache: shorthand name -> longhand values (null = failed). */
  private pendingShorthands = new Map<string, Map<string, any> | null>();

  constructor(
    parentStyle: Style | null, cascaded: Cascaded, pseudoType: string | null, rootStyle: Style,
    baseUrl: string | null, fontConfig: unknown, initialPageSizes: InitialPageSizes,
  ) {
    super();
    this.specified = {};
    this.parentStyle = parentStyle;
    this.cascaded = cascaded;
    this.isRootElement = parentStyle === null;
    this.pseudoType = pseudoType;
    this.rootStyle = rootStyle;
    this.baseUrl = baseUrl;
    this.fontConfig = fontConfig;
    this.initialPageSizes = initialPageSizes;
    this.cache = parentStyle ? parentStyle.cache : new Map();
  }

  copy(): Style {
    const c = new ComputedStyle(
      this.parentStyle, this.cascaded, this.pseudoType, this.rootStyle!, this.baseUrl, this.fontConfig,
      this.initialPageSizes);
    c.values = new Map(this.values);
    c.specified = { ...this.specified };
    return c;
  }

  get(key: string): any {
    if (this.values.has(key)) return this.values.get(key);
    return this.compute(key);
  }

  /** Token value of a custom property, looking through parent styles. */
  customProperty(name: string): Token[] | null {
    let s: Style | null = this;
    while (s) {
      if (s instanceof ComputedStyle) return s.customPropertyTokens(name);
      s = s.parentStyle;
    }
    return null;
  }

  /** Own (cascaded, var-substituted) or inherited custom property tokens. */
  customPropertyTokens(name: string, seen: Set<string> = new Set()): Token[] | null {
    if (this.customPropsCache.has(name)) return this.customPropsCache.get(name)!;
    this.customPropsCache.set(name, null); // cycle guard
    let result: Token[] | null = null;
    const c = this.cascaded.get(name);
    if (c) {
      let [value] = c;
      if (value instanceof Pending) value = this.substituteVars(value.tokens, seen);
      if (value !== null && value !== undefined && Array.isArray(value)) result = value as Token[];
    } else if (this.parentStyle instanceof ComputedStyle) {
      result = this.parentStyle.customPropertyTokens(name, seen);
    }
    this.customPropsCache.set(name, result);
    return result;
  }

  /** Substitute var() references in a token list. Returns null when a
   * reference is unresolvable and carries no fallback. */
  private substituteVars(tokens: Token[], seen: Set<string>): Token[] | null {
    const out: Token[] = [];
    for (const t of tokens) {
      if (t.type === 'function' && t.name === 'var') {
        const parts = splitOnComma(t.arguments);
        const nameTokens = removeWhitespace(parts[0] ?? []);
        const name = nameTokens.length === 1 && nameTokens[0].type === 'ident' ? nameTokens[0].value : null;
        let resolved: Token[] | null = null;
        // Cycle detection is per branch: sibling var() references may name the same property.
        let branchSeen = seen;
        if (name !== null && !seen.has(name)) {
          branchSeen = new Set(seen).add(name);
          resolved = this.customPropertyTokens(name, branchSeen);
        }
        if (resolved === null && parts.length > 1) {
          resolved = removeWhitespace(parts.slice(1).flat());
        }
        if (resolved === null) return null;
        const substituted = this.substituteVars(resolved, branchSeen);
        if (substituted === null) return null;
        out.push(...substituted);
      } else if (t.type === 'function') {
        const args = this.substituteVars(t.arguments, seen);
        if (args === null) return null;
        out.push({ ...t, arguments: args });
      } else {
        out.push(t);
      }
    }
    return out;
  }

  /** A var()-containing shorthand cascaded under its own name (e.g.
   * `background: url(x) var(--orange)`) — substitute and expand it now that
   * custom properties resolve, and take ``key``'s longhand if it has one.
   * Returns the winning entry [value, weight] or undefined. */
  private expandPendingShorthand(key: string): [any, Weight] | undefined {
    let best: [any, Weight] | undefined;
    for (const [name, entry] of this.cascaded) {
      if (name === key || !entry) continue;
      const [v, w] = entry;
      if (!(v instanceof Pending)) continue;
      if (best && weightCmp(w, best[1]) <= 0) continue;
      let expanded = this.pendingShorthands.get(name);
      if (expanded === undefined) {
        expanded = null;
        const substituted = this.substituteVars(v.tokens, new Set());
        if (substituted !== null) {
          try {
            // cascaded keys are underscored ('border_color'); expanders want dashes
            const dashed = name.replace(/_/g, '-');
            expanded = new Map(expandSingle(dashed, substituted, this.baseUrl).map(([n, val]) => [n, val]));
          } catch (e) {
            if (!(e instanceof InvalidValues)) throw e;
          }
        }
        this.pendingShorthands.set(name, expanded);
      }
      if (expanded && expanded.has(key)) best = [expanded.get(key), w];
    }
    return best;
  }

  private compute(key: string): any {
    if (key.startsWith('--')) return this.customPropertyTokens(key);
    if (key === 'float') this.get('position');
    else if (key === 'display') this.get('float');
    const parentStyle = this.parentStyle;

    let value: any;
    let weight: Weight;
    let pending = false;
    let c = this.cascaded.get(key);
    // A var()-containing shorthand cascaded under its own name competes with
    // any directly-cascaded longhand BY WEIGHT (e.g. the UA sheet's
    // `border-color: currentcolor` longhands vs the author's
    // `background-color: var(--x)`). On an exact weight tie the direct entry
    // wins: the shorthand was declared earlier (the reference expands lazy
    // shorthands only when they strictly outrank the longhand).
    const fromShorthand = this.expandPendingShorthand(key);
    if (fromShorthand && (!c || weightCmp(c[1], fromShorthand[1]) < 0)) c = fromShorthand;
    if (c) {
      [value, weight] = c;
      pending = value instanceof Pending;
    } else {
      value = INHERITED.has(key) || key.startsWith('__') ? 'inherit' : 'initial';
      weight = [0, 0, [0, 0, 0]];
      pending = false;
    }
    void weight;

    if (value === 'inherit' && parentStyle === null) value = 'initial';

    if (pending) {
      const tokens = (value as Pending).tokens;
      const substituted = this.substituteVars(tokens, new Set());
      let resolved: any = null;
      if (substituted !== null) {
        try {
          resolved = validateNonShorthand(substituted, key.replace(/_/g, '-'), this.baseUrl)[0][1];
        } catch (e) {
          if (!(e instanceof InvalidValues)) throw e;
        }
      }
      if (resolved === null) {
        // Unresolved variable or invalid at computed-value time: treat as
        // unset (inherit for inherited properties, initial otherwise).
        LOGGER.warning(`Invalid or unresolved var() for ${key}, using ${INHERITED.has(key) && parentStyle ? 'inherited' : 'initial'} value`);
        resolved = INHERITED.has(key) && parentStyle ? parentStyle.get(key) : INITIAL_VALUES[key];
      } else {
        pending = false;
      }
      value = resolved;
    }

    if (value === 'initial') {
      value = key.startsWith('__') ? [] : INITIAL_VALUES[key];
      if (!INITIAL_NOT_COMPUTED.has(key)) this.values.set(key, value);
    } else if (value === 'inherit') {
      value = parentStyle!.get(key);
      this.values.set(key, value);
    }

    if (key.startsWith('text_decoration_') && parentStyle !== null) {
      if (key in COMPUTER_FUNCTIONS) value = COMPUTER_FUNCTIONS[key](this, key, value);
      this.values.set(key, textDecoration(key, value, parentStyle.get(key), this.cascaded.has(key)));
    } else if (key === 'page' && value === 'auto') {
      value = parentStyle === null ? '' : parentStyle.get('page');
      this.values.delete(key);
    } else if (key === 'position' || key === 'float' || key === 'display') {
      this.specified[key] = value;
    }

    if (Array.isArray(value) ? value.some((v) => v && typeof v === 'object' && 'type' in v && isMath(v)) : (value && typeof value === 'object' && 'type' in value && isMath(value))) {
      // Python: resolve math functions with this style, then validate the solved tokens again.
      const items: any[] = Array.isArray(value) ? value : [value];
      const solved: any[] = [];
      let invalid = false;
      for (const item of items) {
        if (item && typeof item === 'object' && 'type' in item && isMath(item)) {
          let token: any = null;
          try {
            token = resolveMath(item, this, key);
          } catch (error) {
            if (!(error instanceof PercentageInMath)) throw error;
            token = item;
          }
          if (token === null) {
            invalid = true;
            break;
          }
          solved.push(token);
        } else solved.push(item);
      }
      if (!invalid) {
        try {
          value = validateNonShorthand(solved, key.replace(/_/g, '-'), this.baseUrl)[0][1];
        } catch (error) {
          if (!(error instanceof InvalidValues)) throw error;
          invalid = true;
        }
      }
      if (invalid) {
        LOGGER.warning(`Invalid math function for ${key}`);
        value = INHERITED.has(key) && parentStyle ? parentStyle.get(key) : INITIAL_VALUES[key];
      }
    }

    if (this.values.has(key)) return this.values.get(key);
    if (key in COMPUTER_FUNCTIONS) value = COMPUTER_FUNCTIONS[key](this, key, value);
    this.values.set(key, value);
    return value;
  }
}

export type { Dimension };