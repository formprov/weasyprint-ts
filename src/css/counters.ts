// SPDX-License-Identifier: BSD-3-Clause

/** Counter styles (mirrors weasyprint/css/counters.py; CSS Counter Styles Level 3). */
import type { Token } from './parser.ts';
import { removeWhitespace } from './tokens.ts';

export function symbol(stringOrUrl: [string, any]): string {
  const [type, value] = stringOrUrl;
  return type === 'string' ? value : '';
}

export type CounterDefinition = Record<string, any>;

export class CounterStyle extends Map<string, CounterDefinition> {
  static parseName(tokensIn: Token[], counterStyle: CounterStyle): string | null {
    const tokens = removeWhitespace(tokensIn);
    if (tokens.length === 1) {
      const token = tokens[0];
      if (token.type === 'ident') {
        if (token.lowerValue === 'decimal' || token.lowerValue === 'disc') {
          if (!counterStyle.has(token.lowerValue)) return token.value;
        } else if (token.lowerValue !== 'none') return token.value;
      }
    }
    return null;
  }

  resolveCounter(counterName: any, previousTypes: any[] | null = null): CounterDefinition | null {
    if (Array.isArray(counterName) && (counterName[0] === 'symbols()' || counterName[0] === 'string')) {
      const [counterType, args] = counterName;
      let system: any;
      let symbols: any;
      let suffix: any;
      if (counterType === 'string') {
        system = [null, 'cyclic', null];
        symbols = [['string', args]];
        suffix = ['string', ''];
      } else {
        system = [null, args[0], args[0] === 'fixed' ? 1 : null];
        symbols = args.slice(1).map((a: string) => ['string', a]);
        suffix = ['string', ' '];
      }
      return {
        system, negative: [['string', '-'], ['string', '']], prefix: ['string', ''], suffix, range: 'auto',
        pad: [0, ''], fallback: 'decimal', symbols, additive_symbols: [],
      };
    }
    if (this.has(counterName)) {
      if (previousTypes === null) previousTypes = [];
      else if (previousTypes.includes(counterName)) return null;
      previousTypes.push(counterName);
      const counter = { ...this.get(counterName)! };
      let extendsName: string | null;
      let system: string;
      if (counter.system) [extendsName, system] = counter.system;
      else [extendsName, system] = [null, 'symbolic'];
      while (extendsName) {
        if (this.has(system)) {
          const extended = this.get(system)!;
          counter.system = extended.system;
          previousTypes.push(system);
          if (counter.system) [extendsName, system] = counter.system;
          else [extendsName, system] = [null, 'symbolic'];
          if (extendsName && previousTypes.includes(system)) {
            [extendsName, system] = ['extends', 'decimal'];
            continue;
          }
          for (const [name, value] of Object.entries(extended)) {
            if ((counter[name] === null || counter[name] === undefined) && value !== null && value !== undefined) counter[name] = value;
          }
        } else return counter;
      }
      return counter;
    }
    return null;
  }

  /** Generate the counter representation (https://www.w3.org/TR/css-counter-styles-3/#generate-a-counter). */
  renderValue(counterValueIn: number, counterName: any = null, counterIn: CounterDefinition | null = null, previousTypesIn: any[] | null = null): string {
    let counterValue = counterValueIn;
    let counter = counterIn ?? this.resolveCounter(counterName, previousTypesIn);
    if (counter === null) {
      if (this.has('decimal')) return this.renderValue(counterValue, 'decimal');
      return '';
    }
    let extendsName: string | null;
    let system: string;
    let fixedNumber: number | null;
    if (counter.system) [extendsName, system, fixedNumber] = counter.system;
    else [extendsName, system, fixedNumber] = [null, 'symbolic', null];

    let previousTypes = previousTypesIn;
    if (previousTypes === null) previousTypes = [];
    else if (previousTypes.includes(system)) return this.renderValue(counterValue, 'decimal');
    previousTypes.push(counterName);

    counter = { ...counter };
    while (extendsName) {
      if (this.has(system)) {
        const extended = this.get(system)!;
        counter.system = extended.system;
        if (counter.system) [extendsName, system, fixedNumber] = counter.system;
        else [extendsName, system, fixedNumber] = [null, 'symbolic', null];
        if (previousTypes.includes(system)) return this.renderValue(counterValue, 'decimal');
        previousTypes.push(system);
        for (const [name, value] of Object.entries(extended)) {
          if ((counter[name] === null || counter[name] === undefined) && value !== null && value !== undefined) counter[name] = value;
        }
      } else return this.renderValue(counterValue, 'decimal');
    }

    // Step 2
    let ranges: Array<[number, number]>;
    if (counter.range === 'auto' || counter.range === null || counter.range === undefined) {
      let min = -Infinity;
      const max = Infinity;
      if (system === 'alphabetic' || system === 'symbolic') min = 1;
      else if (system === 'additive') min = 0;
      ranges = [[min, max]];
    } else ranges = counter.range;
    if (!ranges.some(([mn, mx]) => mn <= counterValue && counterValue <= mx)) {
      return this.renderValue(counterValue, counter.fallback || 'decimal', null, previousTypes);
    }

    // Step 3
    let initial: string | null = null;
    const isNegative = counterValue < 0;
    let negativePrefix = '';
    let negativeSuffix = '';
    let useNegative = false;
    if (isNegative) {
      const neg = counter.negative ?? [['string', '-'], ['string', '']];
      negativePrefix = symbol(neg[0]);
      negativeSuffix = symbol(neg[1]);
      useNegative = ['symbolic', 'alphabetic', 'numeric', 'additive'].includes(system);
      if (useNegative) counterValue = Math.abs(counterValue);
    }

    const symbols: any[] = counter.symbols ?? [];
    if (system === 'cyclic') {
      if (symbols.length < 1) return this.renderValue(counterValue, 'decimal');
      initial = symbol(symbols[mod(counterValue - 1, symbols.length)]);
    } else if (system === 'fixed') {
      if (symbols.length < 1) return this.renderValue(counterValue, 'decimal');
      const index = counterValue - fixedNumber!;
      if (index >= 0 && index < symbols.length) initial = symbol(symbols[index]);
      else return this.renderValue(counterValue, counter.fallback || 'decimal', null, previousTypes);
    } else if (system === 'symbolic') {
      if (symbols.length < 1) return this.renderValue(counterValue, 'decimal');
      const index = mod(counterValue - 1, symbols.length);
      const repeat = Math.floor((counterValue - 1) / symbols.length) + 1;
      initial = symbol(symbols[index]).repeat(Math.max(repeat, 0));
    } else if (system === 'alphabetic') {
      if (symbols.length < 2) return this.renderValue(counterValue, 'decimal');
      const parts: string[] = [];
      while (counterValue !== 0) {
        counterValue -= 1;
        parts.push(symbol(symbols[mod(counterValue, symbols.length)]));
        counterValue = Math.floor(counterValue / symbols.length);
      }
      initial = parts.reverse().join('');
    } else if (system === 'numeric') {
      if (counterValue === 0) initial = symbol(symbols[0]);
      else {
        if (symbols.length < 2) return this.renderValue(counterValue, 'decimal');
        const parts: string[] = [];
        counterValue = Math.abs(counterValue);
        while (counterValue !== 0) {
          parts.push(symbol(symbols[counterValue % symbols.length]));
          counterValue = Math.floor(counterValue / symbols.length);
        }
        initial = parts.reverse().join('');
      }
    } else if (system === 'additive') {
      const additive: Array<[number, any]> = counter.additive_symbols ?? [];
      if (counterValue === 0) {
        for (const [weight, sym] of additive) if (weight === 0) initial = symbol(sym);
      } else {
        const parts: string[] = [];
        if (additive.length < 1) return this.renderValue(counterValue, 'decimal');
        for (const [weight, sym] of additive) {
          const repetitions = Math.floor(counterValue / weight);
          for (let i = 0; i < repetitions; i++) parts.push(symbol(sym));
          counterValue -= weight * repetitions;
          if (counterValue === 0) {
            initial = parts.join('');
            break;
          }
        }
      }
      if (initial === null) return this.renderValue(counterValue, counter.fallback || 'decimal', null, previousTypes);
    }
    if (initial === null) throw new Error('counter style produced no value');

    // Step 4
    const pad = counter.pad ?? [0, ''];
    let padDifference = pad[0] - [...initial].length;
    if (isNegative && useNegative) padDifference -= negativePrefix.length + negativeSuffix.length;
    if (padDifference > 0) initial = symbol(pad[1] as any).repeat(padDifference) + initial;

    // Step 5
    if (isNegative && useNegative) initial = negativePrefix + initial + negativeSuffix;
    return initial;
  }

  /** Generate the content of a ::marker pseudo-element. */
  renderMarker(counterName: any, counterValue: number): string {
    const counter = this.resolveCounter(counterName);
    if (counter === null) {
      if (this.has('decimal')) return this.renderMarker('decimal', counterValue);
      return '';
    }
    const prefix = symbol(counter.prefix ?? ['string', '']);
    const suffix = symbol(counter.suffix ?? ['string', '. ']);
    return prefix + this.renderValue(counterValue, counterName) + suffix;
  }

  copy(): CounterStyle {
    return new CounterStyle(this);
  }
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;