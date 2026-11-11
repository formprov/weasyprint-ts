// SPDX-License-Identifier: BSD-3-Clause

/** Preprocess declarations (mirrors weasyprint/css/validation/__init__.py, without CSS nesting). */
import type { AtRule, Declaration, ParseError, Token } from '../parser.ts';
import { serialize } from '../parser.ts';
import { LOGGER } from '../../logger.ts';
import { InvalidValues, isVar, removeWhitespace } from '../tokens.ts';
import { EXPANDERS } from './expanders.ts';
import { PREFIX, PROPRIETARY, UNSTABLE, Pending, validateNonShorthand } from './properties.ts';

// Not applicable to the print media.
export const NOT_PRINT_MEDIA = new Set([
  'azimuth',
  'cue',
  'cue-after',
  'cue-before',
  'elevation',
  'pause',
  'pause-after',
  'pause-before',
  'pitch-range',
  'pitch',
  'play-during',
  'richness',
  'speak-header',
  'speak-numeral',
  'speak-punctuation',
  'speak',
  'speech-rate',
  'stress',
  'voice-family',
  'volume',
  'animation',
  'animation-composition',
  'animation-delay',
  'animation-direction',
  'animation-duration',
  'animation-fill-mode',
  'animation-iteration-count',
  'animation-name',
  'animation-play-state',
  'animation-range',
  'animation-range-end',
  'animation-range-start',
  'animation-timeline',
  'animation-timing-function',
  'timeline-scope',
  'transition',
  'transition-delay',
  'transition-duration',
  'transition-property',
  'transition-timing-function',
  'view-timeline',
  'view-timeline-axis',
  'view-timeline-inset',
  'view-timeline-name',
  'view-transition-name',
  'will-change',
  'caret',
  'caret-color',
  'caret-shape',
  'cursor',
  'field-sizing',
  'pointer-events',
  'resize',
  'touch-action',
  'overscroll-behavior',
  'overscroll-behavior-block',
  'overscroll-behavior-inline',
  'overscroll-behavior-x',
  'overscroll-behavior-y',
  'scroll-behavior',
  'scroll-margin',
  'scroll-margin-block',
  'scroll-margin-block-end',
  'scroll-margin-block-start',
  'scroll-margin-bottom',
  'scroll-margin-inline',
  'scroll-margin-inline-end',
  'scroll-margin-inline-start',
  'scroll-margin-left',
  'scroll-margin-right',
  'scroll-margin-top',
  'scroll-padding',
  'scroll-padding-block',
  'scroll-padding-block-end',
  'scroll-padding-block-start',
  'scroll-padding-bottom',
  'scroll-padding-inline',
  'scroll-padding-inline-end',
  'scroll-padding-inline-start',
  'scroll-padding-left',
  'scroll-padding-right',
  'scroll-padding-top',
  'scroll-snap-align',
  'scroll-snap-stop',
  'scroll-snap-type',
  'scroll-timeline',
  'scroll-timeline-axis',
  'scroll-timeline-name',
  'scrollbar-color',
  'scrollbar-gutter',
  'scrollbar-width',
]);

export type ProcessedDeclaration = [name: string, value: any, important: boolean];

/** Validate+expand a single declaration's value (used to expand shorthand
 * Pending values after var() substitution at computed-value time). */
export function expandSingle(name: string, tokens: Token[], baseUrl: string | null): ProcessedDeclaration[] {
  const expander = EXPANDERS.get(name);
  const result = expander ? expander(tokens, name, baseUrl) : validateNonShorthand(tokens, name, baseUrl);
  return result.map(([longName, value]) => [name.startsWith('--') ? name : longName.replace(/-/g, '_'), value, false]);
}

export function preprocessDeclarations(
  baseUrl: string | null, declarations: Array<Declaration | AtRule | ParseError | { type: string }>,
): ProcessedDeclaration[] {
  const out: ProcessedDeclaration[] = [];
  for (const item of declarations) {
    if (item.type === 'error') {
      LOGGER.warning(`Error: ${(item as ParseError).message}.`);
      continue;
    }
    if (item.type !== 'declaration') continue;
    const declaration = item as Declaration;
    let name = declaration.name;
    if (!name.startsWith('--')) name = declaration.lowerName;
    const validationError = (level: 'debug' | 'warning', reason: string): void => {
      LOGGER.log(level, `Ignored \`${declaration.name}:${serialize(declaration.value)}\`, ${reason}.`);
    };
    if (NOT_PRINT_MEDIA.has(name)) {
      validationError('debug', 'the property does not apply for the print media');
      continue;
    }
    if (name.startsWith(PREFIX)) {
      const unprefixed = name.slice(PREFIX.length);
      if (PROPRIETARY.has(unprefixed)) name = unprefixed;
      else if (UNSTABLE.has(unprefixed)) {
        LOGGER.warning(`Deprecated \`${declaration.name}:${serialize(declaration.value)}\`, prefixes on unstable attributes are deprecated, use '${unprefixed}' instead.`);
        name = unprefixed;
      } else {
        LOGGER.warning(`Ignored \`${declaration.name}:${serialize(declaration.value)}\`, prefix on this attribute is not supported, use '${unprefixed}' instead.`);
        continue;
      }
    }
    if (name.startsWith('-') && !name.startsWith('--')) {
      validationError('debug', 'prefixed selectors are ignored');
      continue;
    }
    const tokens = removeWhitespace(declaration.value);
    let result: Array<[string, any]>;
    try {
      if (!tokens.length) throw new InvalidValues('no value');
      if (tokens.some(isVar)) {
        // Keep var()-containing values (shorthands included) as Pending:
        // substitution happens per element at computed-value time.
        result = [[name, new Pending(tokens, name)]];
      } else {
        const expander = EXPANDERS.get(name);
        result = expander ? expander(tokens, name, baseUrl) : validateNonShorthand(tokens, name, baseUrl);
      }
    } catch (exc) {
      if (exc instanceof InvalidValues) {
        validationError('warning', exc.message || 'invalid value');
        continue;
      }
      throw exc;
    }
    for (const [longName, value] of result) out.push([name.startsWith('--') ? name : longName.replace(/-/g, '_'), value, declaration.important]);
  }
  return out;
}