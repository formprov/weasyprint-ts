// SPDX-License-Identifier: BSD-3-Clause

/** Apply CSS to SVG documents (mirrors weasyprint/svg/css.py). */
import type { Element } from '../dom.ts';
import { LOGGER } from '../logger.ts';
import { matchSelectorFull, parseSelectorList, SelectorError } from '../css/selectors.ts';
import type { Selector, Specificity } from '../css/selectors.ts';
import { parseDeclarationList, parseStylesheet, serialize } from '../css/parser.ts';
import type { Declaration, Rule } from '../css/parser.ts';

export type Declarations = Array<[string, string]>;

const SVG_NS_STYLE = '{http://www.w3.org/2000/svg}style';

/** Stand-in for cssselect2.Matcher: rules are matched with their specificity and source order. */
export class RuleMatcher {
  private rules: Array<{ selector: Selector; order: number; declarations: Declarations }> = [];

  addSelector(selector: Selector, declarations: Declarations): void {
    this.rules.push({ selector, order: this.rules.length, declarations });
  }

  /** Declarations of every matching rule, in cascade order (lowest specificity and earliest first). */
  match(element: Element): Declarations[] {
    const matched = this.rules.filter((rule) => matchSelectorFull(rule.selector, element));
    matched.sort((a, b) => compareSpecificity(a.selector.specificity, b.selector.specificity) || a.order - b.order);
    return matched.map((rule) => rule.declarations);
  }
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** Find rules among stylesheet rules and imports. */
function* findStylesheetsRules(stylesheetRules: Rule[]): Generator<Rule & { type: 'qualified-rule' }> {
  for (const rule of stylesheetRules) {
    if (rule.type === 'at-rule') {
      // TODO: support @import, @font-face and media types in SVG stylesheets.
      continue;
    }
    if (rule.type === 'qualified-rule') yield rule as Rule & { type: 'qualified-rule' };
    // TODO: warn on error
  }
}

/** Parse declarations in a given rule content: [normal, important]. */
export function parseDeclarations(input: any[] | string): [Declarations, Declarations] {
  const normal: Declarations = [];
  const important: Declarations = [];
  for (const declaration of parseDeclarationList(input) as Array<Declaration | { type: string }>) {
    // TODO: warn on error
    if (declaration.type === 'declaration' && !(declaration as Declaration).name.startsWith('-')) {
      // Serializing perfectly good tokens just to re-parse them later :(
      const value = serialize((declaration as Declaration).value).trim();
      (declaration as Declaration).important ? important.push([(declaration as Declaration).lowerName, value])
        : normal.push([(declaration as Declaration).lowerName, value]);
    }
  }
  return [normal, important];
}

/** Find stylesheets and return rule matchers in given tree. */
export function parseStylesheets(root: Element, _url: string, _fontConfig: unknown,
  _urlFetcher: unknown): [RuleMatcher, RuleMatcher] {
  const normalMatcher = new RuleMatcher();
  const importantMatcher = new RuleMatcher();

  // Find stylesheets
  // TODO: support contentStyleType on <svg>
  const stylesheets: Rule[][] = [];
  for (const element of root.iter()) {
    // https://www.w3.org/TR/SVG/styling.html#StyleElement
    if (element.tag === SVG_NS_STYLE && (element.get('type') ?? 'text/css') === 'text/css' && element.text) {
      // TODO: pass href for relative URLs; support media types and <style> children
      stylesheets.push(parseStylesheet(element.text, true, true));
    }
  }

  // Parse rules and fill matchers
  for (const stylesheet of stylesheets) {
    for (const rule of findStylesheetsRules(stylesheet)) {
      const [normalDeclarations, importantDeclarations] = parseDeclarations(rule.content);
      let selectors: Selector[];
      try {
        selectors = parseSelectorList(rule.prelude);
      } catch (exception) {
        if (!(exception instanceof SelectorError)) throw exception;
        LOGGER.warning(`Failed to apply CSS rule in SVG rule: ${exception.message}`);
        break;
      }
      for (const selector of selectors) {
        if (selector.pseudoElement === null) {
          if (normalDeclarations.length) normalMatcher.addSelector(selector, normalDeclarations);
          if (importantDeclarations.length) importantMatcher.addSelector(selector, importantDeclarations);
        }
      }
    }
  }

  return [normalMatcher, importantMatcher];
}
