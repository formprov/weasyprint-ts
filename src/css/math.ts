// SPDX-License-Identifier: BSD-3-Clause

/**
 * CSS math functions: calc(), min(), max(), clamp(), round(), mod(), rem(), trigonometric,
 * exponential and sign functions (mirrors weasyprint/css/functions.py check_math and the
 * resolve_math helpers of weasyprint/css/__init__.py).
 */
import { FunctionToken, removeWhitespace } from './tokens.ts';
import { toPixels, toRadians, ANGLE_UNITS, LENGTH_UNITS, RELATIVE_UNITS } from './units.ts';
import type { Token } from './parser.ts';

/** Raised when percentages are mixed with other values and no refer_to size is available. */
export class PercentageInMath extends Error {}
/** Raised when a relative length needs a computed style and none is available. */
export class RelativeLengthInMath extends Error {}

const E = Math.E;
const PI = Math.PI;
const INF = Infinity;
const NAN = NaN;

type Tok = any;

/** Python: check_math(token). Accepts a token or a tuple (array) of tokens. */
export function checkMath(token: Tok | Tok[] | null | undefined): boolean {
  if (Array.isArray(token)) return token.some((item) => checkMath(item));
  if (!token || token.type !== 'function') return false;
  const fn = new FunctionToken(token);
  const name = fn.name;
  const args = fn.splitComma(false) ?? [];
  if (name === 'calc') return args.length === 1;
  if (name === 'min' || name === 'max') return args.length >= 1;
  if (name === 'clamp') return args.length === 3;
  if (name === 'round') return args.length >= 1 && args.length <= 3;
  if (name === 'mod' || name === 'rem') return args.length === 2;
  if (name === 'sin' || name === 'cos' || name === 'tan') return args.length === 1;
  if (name === 'asin' || name === 'acos' || name === 'atan') return args.length === 1;
  if (name === 'atan2' || name === 'pow') return args.length === 2;
  if (name === 'sqrt' || name === 'exp' || name === 'abs' || name === 'sign') return args.length === 1;
  if (name === 'hypot') return args.length >= 1;
  if (name === 'log') return args.length === 1 || args.length === 2;
  return (args as Tok[][]).some((argument) => checkMath(argument as unknown as Tok[]));
}

/** Python: tokenize(item, function=None, unit=None). Builds a number, percentage or dimension token. */
export function tokenize(item: Tok | number, fn: ((x: number) => number) | null = null, unit: string | null = null): Tok {
  if (typeof item !== 'number' && (item.type === 'dimension' || item.type === 'percentage')) {
    const value = fn ? fn(item.value) : item.value;
    if (item.type === 'dimension') {
      return { type: 'dimension', value, isInteger: false, unit: item.unit.toLowerCase(), lowerUnit: item.unit.toLowerCase(), repr: String(value) };
    }
    return { type: 'percentage', value, isInteger: false, repr: String(value) };
  }
  const value0 = typeof item === 'number' ? item : item.value;
  const value = fn ? fn(value0) : value0;
  const isInteger = Number.isInteger(value);
  const repr = String(isInteger ? Math.round(value) : value);
  if (unit === null) return { type: 'number', value, isInteger, repr };
  if (unit === '%') return { type: 'percentage', value, isInteger: false, repr };
  return { type: 'dimension', value, isInteger: false, unit, lowerUnit: unit.toLowerCase(), repr };
}

/** Python: args[i] lists produced by split_comma(single_tokens=False). */
function splitCommaFor(token: Tok): Tok[][] {
  const fn = new FunctionToken(token);
  return ((fn.splitComma(false) ?? []) as unknown) as Tok[][];
}

/**
 * Return token with resolved math functions. Returns null when the function can't be resolved.
 * Raises PercentageInMath, or RelativeLengthInMath when no computed style is available.
 */
export function resolveMath(token: Tok, computed: any = null, propertyName: string | null = null,
  referTo: number | null = null): Tok | null {
  if (!checkMath(token)) return null;

  const fn = new FunctionToken(token);
  const name = fn.name as string;
  const args: Tok[][] = [];
  for (const part of splitCommaFor(token)) {
    args.push([]);
    for (const arg of part) {
      let resolved: Tok | null = arg;
      if (checkMath(arg)) {
        resolved = resolveMath(arg, computed, propertyName, referTo);
        if (resolved === null) return null;
      }
      args[args.length - 1].push(resolved);
    }
  }

  if (name === 'calc') {
    const result = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (result === null) return null;
    return tokenize(result);
  }

  if (name === 'min' || name === 'max') {
    let targetValue: Tok | null = null;
    let targetToken: Tok | null = null;
    let unit: string | null = null;
    let value: Tok | null = null;
    for (const tokens of args) {
      let token1 = resolveCalcSum(computed, tokens, propertyName, referTo);
      if (token1 === null) return null;
      if (token1.type === 'percentage') {
        if (referTo === null) {
          if (unit === 'px' || unit === '') throw new PercentageInMath();
          unit = '%';
          value = token1;
        } else {
          unit = 'px';
          token1 = value = tokenize(token1.value / 100 * referTo, null, 'px');
        }
      } else if (token1.type === 'number') {
        if (unit === '%') throw new PercentageInMath();
        else if (unit === 'px') return null;
        unit = '';
        value = tokenize(token1.value, null, 'px');
      } else {
        if (unit === '%') throw new PercentageInMath();
        else if (unit === '') return null;
        unit = 'px';
        value = tokenize(toPixels(token1 as any, computed, propertyName), null, 'px');
      }
      const updateCondition = targetValue === null
        || (name === 'min' && value!.value < targetValue.value)
        || (name === 'max' && value!.value > targetValue.value);
      if (updateCondition) {
        targetValue = value;
        targetToken = token1;
      }
    }
    return tokenize(targetToken!);
  }

  if (name === 'round') {
    let strategy = 'nearest';
    let multiple = 1;
    let numberToken: Tok | null = null;
    if (args.length === 1) {
      numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    } else if (args.length === 2) {
      const strategies = ['nearest', 'up', 'down', 'to-zero'];
      if (args[0].length === 1 && strategies.includes(args[0][0].value as string)) {
        strategy = args[0][0].value as string;
        numberToken = resolveCalcSum(computed, args[1], propertyName, referTo);
        if (numberToken === null) return null;
      } else {
        numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
        const multipleToken = resolveCalcSum(computed, args[1], propertyName, referTo);
        if (numberToken === null || multipleToken === null) return null;
        if (numberToken.type !== multipleToken.type) return null;
        multiple = multipleToken.value;
      }
    } else if (args.length === 3) {
      strategy = args[0][0].value as string;
      numberToken = resolveCalcSum(computed, args[1], propertyName, referTo);
      const multipleToken = resolveCalcSum(computed, args[2], propertyName, referTo);
      if (numberToken === null || multipleToken === null) return null;
      if (numberToken.type !== multipleToken.type) return null;
      multiple = multipleToken.value;
    }
    if (numberToken === null) return null;
    let roundFn: (x: number) => number;
    if (strategy === 'nearest') {
      // TODO: always round x.5 to +inf, see https://drafts.csswg.org/css-values-4/#combine-integers.
      roundFn = (x) => roundHalfEven(x);
    } else if (strategy === 'up') roundFn = Math.ceil;
    else if (strategy === 'down') roundFn = Math.floor;
    else if (strategy === 'to-zero') roundFn = numberToken.value > 0 ? Math.floor : Math.ceil;
    else return null;
    return tokenize(numberToken, (x) => roundFn(x / multiple) * multiple);
  }

  if (name === 'mod' || name === 'rem') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    const parameterToken = resolveCalcSum(computed, args[1], propertyName, referTo);
    if (numberToken === null || parameterToken === null) return null;
    if (numberToken.type !== parameterToken.type) return null;
    const number = numberToken.value;
    const parameter = parameterToken.value;
    let value = pyMod(number, parameter);
    if (name === 'rem' && number * parameter < 0) value += Math.abs(parameter);
    return tokenize(numberToken, () => value);
  }

  if (name === 'sin' || name === 'cos' || name === 'tan') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null) return null;
    let angle: number;
    if (numberToken.type === 'number') angle = numberToken.value;
    else if (numberToken.type === 'dimension' && ANGLE_UNITS.has(numberToken.lowerUnit)) angle = toRadians(numberToken as any);
    else return null;
    const value = name === 'sin' ? Math.sin(angle) : name === 'cos' ? Math.cos(angle) : Math.tan(angle);
    return tokenize(value);
  }

  if (name === 'asin' || name === 'acos' || name === 'atan') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null || numberToken.type !== 'number') return null;
    const x = numberToken.value;
    let value: number;
    if (name === 'asin') {
      if (x < -1 || x > 1) return null;
      value = Math.asin(x);
    } else if (name === 'acos') {
      if (x < -1 || x > 1) return null;
      value = Math.acos(x);
    } else value = Math.atan(x);
    return tokenize(value, null, 'rad');
  }

  if (name === 'atan2') {
    const [yToken, xToken] = args.map((arg) => resolveCalcSum(computed, arg, propertyName, referTo));
    if (yToken === null || xToken === null) return null;
    if (yToken.type !== 'number' || xToken.type !== 'number') return null;
    return tokenize(Math.atan2(yToken.value, xToken.value), null, 'rad');
  }

  if (name === 'clamp') {
    const pixelsList: Tok[] = [];
    let unit: string | null = null;
    for (const tokens of args) {
      let token1 = resolveCalcSum(computed, tokens, propertyName, referTo);
      if (token1 === null) return null;
      let value: Tok;
      if (token1.type === 'percentage') {
        if (referTo === null) {
          if (unit === 'px') throw new PercentageInMath();
          unit = '%';
          value = token1;
        } else {
          unit = 'px';
          token1 = tokenize(token1.value / 100 * referTo, null, 'px');
          value = token1;
        }
      } else {
        if (unit === '%') throw new PercentageInMath();
        unit = 'px';
        const pixels = toPixels(token1 as any, computed, propertyName);
        value = tokenize(pixels, null, 'px');
      }
      pixelsList.push(value);
    }
    const [minToken, middle, maxToken] = pixelsList;
    let token1 = middle;
    if (token1.value < minToken.value) token1 = minToken;
    if (token1.value > maxToken.value) token1 = maxToken;
    return tokenize(token1);
  }

  if (name === 'pow') {
    const [numberToken, powerToken] = args.map((arg) => resolveCalcSum(computed, arg, propertyName, referTo));
    if (numberToken === null || powerToken === null) return null;
    if (numberToken.type !== 'number' || powerToken.type !== 'number') return null;
    return tokenize(numberToken, (x) => x ** powerToken.value);
  }

  if (name === 'sqrt') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null || numberToken.type !== 'number') return null;
    return tokenize(numberToken, (x) => x ** 0.5);
  }

  if (name === 'hypot') {
    const resolved = args.map((tokens) => resolveCalcSum(computed, tokens, propertyName, referTo));
    if (resolved.some((t) => t === null)) return null;
    const value = Math.hypot(...resolved.map((t) => t!.value));
    return tokenize(resolved[0]!, () => value);
  }

  if (name === 'log') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null || numberToken.type !== 'number') return null;
    let base = E;
    if (args.length === 2) {
      const baseToken = resolveCalcSum(computed, args[1], propertyName, referTo);
      if (baseToken === null || baseToken.type !== 'number') return null;
      base = baseToken.value;
    }
    return tokenize(numberToken, (x) => Math.log(x) / Math.log(base));
  }

  if (name === 'exp') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null || numberToken.type !== 'number') return null;
    return tokenize(numberToken, Math.exp);
  }

  if (name === 'abs') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null) return null;
    return tokenize(numberToken, Math.abs);
  }

  if (name === 'sign') {
    const numberToken = resolveCalcSum(computed, args[0], propertyName, referTo);
    if (numberToken === null) return null;
    return tokenize(numberToken.value, (x) => (x === 0 ? 0 : x > 0 ? 1 : -1));
  }

  // Unknown function: resolve nested math arguments, then retry on the rebuilt function.
  const newArguments: Tok[] = [];
  for (const argument of token.type === 'function' ? token.arguments : []) {
    if (argument.type === 'function') {
      const result = resolveMath(argument, computed, propertyName, referTo);
      if (result === null) return null;
      newArguments.push(result);
    } else newArguments.push(argument);
  }
  const rebuilt: Tok = token.type === 'function'
    ? { ...token, arguments: newArguments } : token;
  return resolveMath(rebuilt, computed, propertyName, referTo) ?? rebuilt;
}

/** Python's % operator: result takes the sign of the divisor. */
function pyMod(a: number, b: number): number {
  const r = a % b;
  return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

/** Python's round(): ties to even. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** Python: _resolve_calc_sum. */
function resolveCalcSum(computed: any, tokens: Tok[], propertyName: string | null, referTo: number | null): Tok | null {
  // groups alternates between operand lists and '+'/'-' operators, like the reference
  const groups: Array<Tok[] | string> = [[]];
  for (const token of tokens) {
    if (token.type === 'literal' && (token.value === '+' || token.value === '-')) {
      groups.push(token.value);
      groups.push([]);
    } else if (token.type === '()') {
      const content = removeWhitespace(token.content);
      const result = resolveCalcSum(computed, content, propertyName, referTo);
      if (result === null) return null;
      (groups[groups.length - 1] as Tok[]).push(result);
    } else {
      (groups[groups.length - 1] as Tok[]).push(token);
    }
  }

  let value = 0;
  let sign: string | null = '+';
  let unit: string | null = null;
  let exception: Error | null = null;
  const queue = [...groups];
  while (queue.length) {
    if (sign === null) {
      sign = queue.shift() as string;
    } else {
      const group = queue.shift() as Tok[];
      let product: Tok | null;
      try {
        product = resolveCalcProduct(computed, group, propertyName, referTo);
      } catch (error) {
        if (!(error instanceof RelativeLengthInMath)) throw error;
        // Assume pixels and keep looking for a PercentageInMath first.
        if (unit === '%') throw new PercentageInMath();
        exception = error;
        unit = 'px';
        sign = null;
        continue;
      }
      if (product === null) return null;
      if (product.type === 'dimension') {
        if (unit === null) unit = product.unit.toLowerCase();
        else if (unit === '%') throw new PercentageInMath();
        else if (unit !== product.unit.toLowerCase()) return null;
      } else if (product.type === 'percentage') {
        if (referTo !== null) {
          product = { ...product, value: (product.value / 100) * referTo };
          unit = 'px';
        } else if (unit === null || unit === '%') unit = '%';
        else throw new PercentageInMath();
      }
      if (sign === '+') value += product.value;
      else value -= product.value;
      sign = null;
    }
  }

  // Raise RelativeLengthInMath, only if we didn’t raise PercentageInMath before.
  if (exception) throw exception;

  return tokenize(value, null, unit);
}

/** Python: _resolve_calc_product. */
function resolveCalcProduct(computed: any, tokens: Tok[], propertyName: string | null, referTo: number | null): Tok | null {
  const groups: Array<Tok[] | string> = [[]];
  for (const token of tokens) {
    if (token.type === 'literal' && (token.value === '*' || token.value === '/')) {
      groups.push(token.value);
      groups.push([]);
    } else if (token.type === 'number') {
      (groups[groups.length - 1] as Tok[]).push(token);
    } else if (token.type === 'dimension' && LENGTH_UNITS.has(token.lowerUnit)) {
      if (computed === null && RELATIVE_UNITS.has(token.lowerUnit)) throw new RelativeLengthInMath();
      const pixels = toPixels(token as any, computed, propertyName);
      (groups[groups.length - 1] as Tok[]).push(tokenize(pixels, null, 'px'));
    } else if (token.type === 'dimension' && ANGLE_UNITS.has(token.lowerUnit)) {
      (groups[groups.length - 1] as Tok[]).push(tokenize(toRadians(token as any), null, 'rad'));
    } else if (token.type === 'percentage') {
      (groups[groups.length - 1] as Tok[]).push(tokenize(token.value, null, '%'));
    } else if (token.type === 'ident') {
      (groups[groups.length - 1] as Tok[]).push(token);
    } else {
      return null;
    }
  }

  let value = 1;
  let sign: string | null = '*';
  let unit: string | null = null;
  const queue = [...groups];
  while (queue.length) {
    if (sign === null) {
      sign = queue.shift() as string;
    } else {
      const group = queue.shift() as Tok[];
      const calc = resolveCalcValue(computed, group);
      if (calc === null) return null;
      if (calc.type === 'dimension') {
        if (unit === null || unit === '%') unit = calc.unit.toLowerCase();
        else return null;
      } else if (calc.type === 'percentage') {
        if (unit === null) unit = '%';
      }
      if (sign === '*') value *= calc.value;
      else if (calc.value === 0) {
        // Division by zero resolves to ±infinity or NaN (IEEE-754), as CSS Values 4 requires.
        value = value === 0 ? NAN : (value > 0 ? INF : -INF);
      } else value /= calc.value;
      sign = null;
    }
  }

  return tokenize(value, null, unit);
}

/** Python: _resolve_calc_value. */
function resolveCalcValue(computed: any, tokens: Tok[]): Tok | null {
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.type === 'number' || token.type === 'dimension' || token.type === 'percentage') return token;
    if (token.type === 'ident') {
      if (token.lowerValue === 'e') return tokenize(E);
      if (token.lowerValue === 'pi') return tokenize(PI);
      if (token.lowerValue === 'infinity') return tokenize(INF);
      if (token.lowerValue === '-infinity') return tokenize(-INF);
      if (token.lowerValue === 'nan') return tokenize(NAN);
    }
    return null;
  }
  return null;
}
