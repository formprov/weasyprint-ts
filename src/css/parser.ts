// SPDX-License-Identifier: BSD-3-Clause

/**
 * CSS tokenizer and parser following CSS Syntax Level 3, mirroring the
 * behaviour of tinycss2 (which WeasyPrint uses). Ported from the spec; error
 * recovery matters because WeasyPrint's observable behaviour includes which
 * rules get dropped.
 */

export type Token =
  | { type: 'whitespace'; value: string }
  | { type: 'comment'; value: string }
  | { type: 'ident'; value: string; lowerValue: string }
  | { type: 'at-keyword'; value: string; lowerValue: string }
  | { type: 'hash'; value: string; isIdentifier: boolean }
  | { type: 'string'; value: string }
  | { type: 'url'; value: string }
  | { type: 'number'; value: number; isInteger: boolean; repr: string }
  | { type: 'percentage'; value: number; isInteger: boolean; repr: string }
  | { type: 'dimension'; value: number; isInteger: boolean; unit: string; lowerUnit: string; repr: string }
  | { type: 'unicode-range'; start: number; end: number }
  | { type: 'literal'; value: string }
  | { type: 'function'; name: string; lowerName: string; arguments: Token[] }
  | { type: '()' | '[]' | '{}'; content: Token[] }
  | { type: 'error'; kind: 'bad-string' | 'bad-url' | 'unmatched'; value: string };

export interface Declaration {
  type: 'declaration';
  name: string;
  lowerName: string;
  value: Token[];
  important: boolean;
}
export interface QualifiedRule {
  type: 'qualified-rule';
  prelude: Token[];
  content: Token[];
}
export interface AtRule {
  type: 'at-rule';
  atKeyword: string;
  lowerAtKeyword: string;
  prelude: Token[];
  content: Token[] | null;
}
export interface ParseError {
  type: 'error';
  kind: string;
  message: string;
}
export type Rule = QualifiedRule | AtRule | ParseError;

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isHex = (c: string): boolean => /^[0-9a-fA-F]$/.test(c);
const isNameStart = (c: string): boolean =>
  c !== '' && (/[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80);
const isName = (c: string): boolean => isNameStart(c) || isDigit(c) || c === '-';
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n';
const isNonPrintable = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n <= 8 || n === 0x0b || (n >= 0x0e && n <= 0x1f) || n === 0x7f;
};

function preprocess(input: string): string {
  return input
    .replace(/\r\n?|\f/g, '\n')
    .replace(/\u0000/g, '�');
}

class Tokenizer {
  private i = 0;
  private s: string;
  private skipComments: boolean;
  constructor(s: string, skipComments: boolean) {
    this.s = s;
    this.skipComments = skipComments;
  }

  private peek(n = 0): string {
    return this.s[this.i + n] ?? '';
  }

  private startsEscape(at = 0): boolean {
    return this.peek(at) === '\\' && this.peek(at + 1) !== '\n' && this.peek(at + 1) !== '';
  }

  private startsIdent(at = 0): boolean {
    const c = this.peek(at);
    if (c === '-') {
      const d = this.peek(at + 1);
      return isNameStart(d) || d === '-' || (d === '\\' && this.startsEscape(at + 1));
    }
    return isNameStart(c) || (c === '\\' && this.startsEscape(at));
  }

  private startsNumber(): boolean {
    const c = this.peek();
    const d = this.peek(1);
    if (c === '+' || c === '-') return isDigit(d) || (d === '.' && isDigit(this.peek(2)));
    if (c === '.') return isDigit(d);
    return isDigit(c);
  }

  private consumeEscape(): string {
    this.i++; // backslash
    const c = this.peek();
    if (c === '') return '�';
    if (isHex(c)) {
      let hex = '';
      while (hex.length < 6 && isHex(this.peek())) hex += this.s[this.i++];
      if (isWs(this.peek())) this.i++;
      const n = parseInt(hex, 16);
      if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�';
      return String.fromCodePoint(n);
    }
    this.i++;
    return c;
  }

  private consumeName(): string {
    let out = '';
    for (;;) {
      const c = this.peek();
      if (isName(c)) {
        out += c;
        this.i++;
      } else if (this.startsEscape()) {
        out += this.consumeEscape();
      } else return out;
    }
  }

  private consumeNumber(): { value: number; isInteger: boolean; repr: string } {
    let repr = '';
    let isInteger = true;
    if (this.peek() === '+' || this.peek() === '-') repr += this.s[this.i++];
    while (isDigit(this.peek())) repr += this.s[this.i++];
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      repr += this.s[this.i++];
      while (isDigit(this.peek())) repr += this.s[this.i++];
      isInteger = false;
    }
    const e = this.peek();
    if ((e === 'e' || e === 'E') &&
      (isDigit(this.peek(1)) || ((this.peek(1) === '+' || this.peek(1) === '-') && isDigit(this.peek(2))))) {
      repr += this.s[this.i++];
      if (this.peek() === '+' || this.peek() === '-') repr += this.s[this.i++];
      while (isDigit(this.peek())) repr += this.s[this.i++];
      isInteger = false;
    }
    return { value: parseFloat(repr), isInteger, repr };
  }

  private consumeString(quote: string): Token {
    this.i++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === '') return { type: 'string', value: out };
      if (c === quote) {
        this.i++;
        return { type: 'string', value: out };
      }
      if (c === '\n') return { type: 'error', kind: 'bad-string', value: out };
      if (c === '\\') {
        if (this.peek(1) === '') {
          this.i++;
        } else if (this.peek(1) === '\n') {
          this.i += 2;
        } else out += this.consumeEscape();
      } else {
        out += c;
        this.i++;
      }
    }
  }

  private consumeUrl(): Token {
    while (isWs(this.peek())) this.i++;
    let out = '';
    for (;;) {
      const c = this.peek();
      if (c === ')') {
        this.i++;
        return { type: 'url', value: out };
      }
      if (c === '') return { type: 'url', value: out };
      if (isWs(c)) {
        while (isWs(this.peek())) this.i++;
        if (this.peek() === ')') {
          this.i++;
          return { type: 'url', value: out };
        }
        if (this.peek() === '') return { type: 'url', value: out };
        return this.badUrl();
      }
      if (c === '"' || c === "'" || c === '(' || isNonPrintable(c)) return this.badUrl();
      if (c === '\\') {
        if (this.startsEscape()) out += this.consumeEscape();
        else return this.badUrl();
      } else {
        out += c;
        this.i++;
      }
    }
  }

  private badUrl(): Token {
    for (;;) {
      const c = this.peek();
      if (c === ')' || c === '') {
        if (c === ')') this.i++;
        return { type: 'error', kind: 'bad-url', value: '' };
      }
      if (this.startsEscape()) this.consumeEscape();
      else this.i++;
    }
  }

  private consumeNumeric(): Token {
    const n = this.consumeNumber();
    if (this.startsIdent()) {
      const unit = this.consumeName();
      return { type: 'dimension', ...n, unit, lowerUnit: unit.toLowerCase() };
    }
    if (this.peek() === '%') {
      this.i++;
      return { type: 'percentage', ...n };
    }
    return { type: 'number', ...n };
  }

  private consumeIdentLike(): Token {
    const name = this.consumeName();
    if (this.peek() === '(') {
      this.i++;
      if (name.toLowerCase() === 'url') {
        let j = 0;
        while (isWs(this.peek(j))) j++;
        const q = this.peek(j);
        if (q !== '"' && q !== "'") return this.consumeUrl();
      }
      return { type: 'function', name, lowerName: name.toLowerCase(), arguments: [] };
    }
    return { type: 'ident', value: name, lowerValue: name.toLowerCase() };
  }

  /** Returns a flat token or a function-start marker (arguments filled by the block parser). */
  next(): Token | null {
    for (;;) {
      const c = this.peek();
      if (c === '') return null;
      if (c === '/' && this.peek(1) === '*') {
        const end = this.s.indexOf('*/', this.i + 2);
        const text = end === -1 ? this.s.slice(this.i + 2) : this.s.slice(this.i + 2, end);
        this.i = end === -1 ? this.s.length : end + 2;
        if (this.skipComments) continue;
        return { type: 'comment', value: text };
      }
      break;
    }
    const c = this.peek();
    if (isWs(c)) {
      let v = '';
      while (isWs(this.peek())) v += this.s[this.i++];
      return { type: 'whitespace', value: v };
    }
    if (c === '"' || c === "'") return this.consumeString(c);
    if (c === '#') {
      if (isName(this.peek(1)) || this.startsEscape(1)) {
        this.i++;
        const isId = this.startsIdent();
        return { type: 'hash', value: this.consumeName(), isIdentifier: isId };
      }
      this.i++;
      return { type: 'literal', value: '#' };
    }
    if (c === '+' || c === '.') {
      if (this.startsNumber()) return this.consumeNumeric();
      this.i++;
      return { type: 'literal', value: c };
    }
    if (c === '-') {
      if (this.startsNumber()) return this.consumeNumeric();
      if (this.peek(1) === '-' && this.peek(2) === '>') {
        this.i += 3;
        return { type: 'literal', value: '-->' };
      }
      if (this.startsIdent()) return this.consumeIdentLike();
      this.i++;
      return { type: 'literal', value: '-' };
    }
    if (c === '<') {
      if (this.s.startsWith('<!--', this.i)) {
        this.i += 4;
        return { type: 'literal', value: '<!--' };
      }
      this.i++;
      return { type: 'literal', value: '<' };
    }
    if (c === '@') {
      if (this.startsIdent(1)) {
        this.i++;
        const name = this.consumeName();
        return { type: 'at-keyword', value: name, lowerValue: name.toLowerCase() };
      }
      this.i++;
      return { type: 'literal', value: '@' };
    }
    if (isDigit(c)) return this.consumeNumeric();
    if ((c === 'u' || c === 'U') && this.peek(1) === '+' && (isHex(this.peek(2)) || this.peek(2) === '?')) {
      return this.consumeUnicodeRange();
    }
    if (isNameStart(c) || (c === '\\' && this.startsEscape())) return this.consumeIdentLike();
    this.i++;
    if (c === '(') return { type: '()', content: [] };
    if (c === '[') return { type: '[]', content: [] };
    if (c === '{') return { type: '{}', content: [] };
    if (c === ')' || c === ']' || c === '}') return { type: 'error', kind: 'unmatched', value: c };
    return { type: 'literal', value: c };
  }

  private consumeUnicodeRange(): Token {
    this.i += 2;
    let hex = '';
    while (hex.length < 6 && isHex(this.peek())) hex += this.s[this.i++];
    let q = 0;
    while (hex.length + q < 6 && this.peek() === '?') {
      q++;
      this.i++;
    }
    if (q) {
      return {
        type: 'unicode-range', start: parseInt(hex + '0'.repeat(q), 16),
        end: parseInt(hex + 'F'.repeat(q), 16),
      };
    }
    const start = parseInt(hex, 16);
    if (this.peek() === '-' && isHex(this.peek(1))) {
      this.i++;
      let h2 = '';
      while (h2.length < 6 && isHex(this.peek())) h2 += this.s[this.i++];
      return { type: 'unicode-range', start, end: parseInt(h2, 16) };
    }
    return { type: 'unicode-range', start, end: start };
  }
}

const closer = (c: string): string => (c === '(' ? ')' : c === '[' ? ']' : '}');

/** Parse a component-value list (tokens with nested blocks/functions). */
export function parseComponentValueList(css: string, skipComments = false): Token[] {
  const t = new Tokenizer(preprocess(css), skipComments);
  const stack: Token[][] = [[]];
  const openers: Array<Token | null> = [null];
  const closers: string[] = [];
  for (let tok = t.next(); tok; tok = t.next()) {
    const top = stack[stack.length - 1];
    if (tok.type === 'error' && tok.kind === 'unmatched') {
      if (closers.length && tok.value === closers[closers.length - 1]) {
        const finished = stack.pop()!;
        const opener = openers.pop()!;
        closers.pop();
        if (opener.type === 'function') opener.arguments = finished;
        else (opener as { content: Token[] }).content = finished;
        stack[stack.length - 1].push(opener);
      } else top.push(tok);
      continue;
    }
    if (tok.type === 'function') {
      stack.push([]);
      openers.push(tok);
      closers.push(')');
    } else if (tok.type === '()' || tok.type === '[]' || tok.type === '{}') {
      stack.push([]);
      openers.push(tok);
      closers.push(closer(tok.type[0]));
    } else top.push(tok);
  }
  while (stack.length > 1) {
    const finished = stack.pop()!;
    const opener = openers.pop()!;
    closers.pop();
    if (opener!.type === 'function') (opener as { arguments: Token[] }).arguments = finished;
    else (opener as { content: Token[] }).content = finished;
    stack[stack.length - 1].push(opener!);
  }
  return stack[0];
}

export function stripWhitespace(tokens: Token[]): Token[] {
  let a = 0;
  let b = tokens.length;
  while (a < b && (tokens[a].type === 'whitespace' || tokens[a].type === 'comment')) a++;
  while (b > a && (tokens[b - 1].type === 'whitespace' || tokens[b - 1].type === 'comment')) b--;
  return tokens.slice(a, b);
}

class TokenStream {
  i = 0;
  tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  get done(): boolean {
    return this.i >= this.tokens.length;
  }
  peek(): Token | undefined {
    return this.tokens[this.i];
  }
  next(): Token | undefined {
    return this.tokens[this.i++];
  }
}

function consumeDeclarationValue(stream: TokenStream): Token[] {
  const out: Token[] = [];
  while (!stream.done) {
    const t = stream.peek()!;
    if (t.type === 'literal' && t.value === ';') break;
    out.push(stream.next()!);
  }
  return out;
}

function parseDeclarationFrom(name: string, rest: Token[]): Declaration | ParseError {
  // rest: tokens after the ':'
  let value = rest.slice();
  let important = false;
  const stripped = stripWhitespace(value);
  const n = stripped.length;
  if (n >= 2) {
    const last = stripped[n - 1];
    let k = n - 2;
    while (k >= 0 && (stripped[k].type === 'whitespace' || stripped[k].type === 'comment')) k--;
    const bang = stripped[k];
    if (last.type === 'ident' && last.lowerValue === 'important' && bang?.type === 'literal' && bang.value === '!') {
      important = true;
      value = stripped.slice(0, k);
    }
  }
  return {
    type: 'declaration', name, lowerName: name.toLowerCase(),
    value: stripWhitespace(value), important,
  };
}

/** parse_declaration_list: declarations only (at-rules and others become errors/at-rules).
 * With allowNestedRules, nested qualified rules (CSS Nesting) are returned as
 * {type: 'qualified-rule'} entries interleaved with the declarations. */
export function parseDeclarationList(
  input: string | Token[], skipComments = true, skipWhitespace = true, allowNestedRules = false,
): Array<Declaration | AtRule | ParseError | QualifiedRule> {
  const tokens = typeof input === 'string' ? parseComponentValueList(input, skipComments) : input;
  const stream = new TokenStream(tokens);
  const out: Array<Declaration | AtRule | ParseError | QualifiedRule> = [];
  while (!stream.done) {
    const t = stream.peek()!;
    if (t.type === 'whitespace' || (t.type === 'literal' && t.value === ';')) {
      stream.next();
      continue;
    }
    if (t.type === 'comment') {
      stream.next();
      continue;
    }
    if (t.type === 'at-keyword') {
      stream.next();
      const prelude: Token[] = [];
      let content: Token[] | null = null;
      while (!stream.done) {
        const u = stream.peek()!;
        if (u.type === 'literal' && u.value === ';') {
          stream.next();
          break;
        }
        if (u.type === '{}') {
          stream.next();
          content = u.content;
          break;
        }
        prelude.push(stream.next()!);
      }
      out.push({
        type: 'at-rule', atKeyword: t.value, lowerAtKeyword: t.lowerValue, prelude, content,
      });
      continue;
    }
    // Nested rule (CSS Nesting): a {} block reached before any ';' — the
    // tokens in between are the (possibly & -prefixed) selector prelude.
    if (allowNestedRules) {
      let k = stream.i;
      let block: Token | null = null;
      while (k < tokens.length) {
        const u = tokens[k];
        if (u.type === 'whitespace' || u.type === 'comment') {
          k++;
          continue;
        }
        if (u.type === '{}') {
          block = u;
          break;
        }
        if (u.type === 'literal' && u.value === ';') break;
        k++;
      }
      if (block) {
        const prelude = trimTokenList(tokens.slice(stream.i, k));
        stream.i = k + 1;
        if (block.content !== null && prelude.length) {
          out.push({ type: 'qualified-rule', prelude, content: block.content });
          continue;
        }
        out.push({ type: 'error', kind: 'invalid', message: 'Empty nested rule' });
        continue;
      }
    }
    // Declaration: ident ws* ':' value
    const start = stream.i;
    const value = consumeDeclarationValue(stream);
    if (t.type !== 'ident') {
      out.push({ type: 'error', kind: 'invalid', message: 'Expected a property name, got ' + describe(t) });
      continue;
    }
    let k = 1;
    while (value[k] && (value[k].type === 'whitespace' || value[k].type === 'comment')) k++;
    const colon = value[k];
    if (!colon || colon.type !== 'literal' || colon.value !== ':') {
      out.push({ type: 'error', kind: 'invalid', message: 'Expected \':\' after property name' });
      continue;
    }
    void start;
    out.push(parseDeclarationFrom(t.value, value.slice(k + 1)));
  }
  void skipWhitespace;
  return out;
}

function trimTokenList(tokens: Token[]): Token[] {
  let a = 0, b = tokens.length;
  while (a < b && (tokens[a].type === 'whitespace' || tokens[a].type === 'comment')) a++;
  while (b > a && (tokens[b - 1].type === 'whitespace' || tokens[b - 1].type === 'comment')) b--;
  return tokens.slice(a, b);
}

export function describe(t: Token): string {
  switch (t.type) {
    case 'ident': case 'at-keyword': return t.value;
    case 'literal': return t.value;
    default: return t.type;
  }
}

/** parse_stylesheet: top-level rules, with CDO/CDC skipped. */
export function parseStylesheet(css: string, skipComments = true, skipWhitespace = true): Rule[] {
  const tokens = parseComponentValueList(css, skipComments);
  return parseRuleList(tokens, true, skipWhitespace);
}

export function parseRuleList(tokens: Token[], topLevel: boolean, skipWhitespace = true): Rule[] {
  const stream = new TokenStream(tokens);
  const rules: Rule[] = [];
  while (!stream.done) {
    const t = stream.peek()!;
    if (t.type === 'whitespace' || t.type === 'comment') {
      stream.next();
      continue;
    }
    if (topLevel && t.type === 'literal' && (t.value === '<!--' || t.value === '-->')) {
      stream.next();
      continue;
    }
    if (t.type === 'at-keyword') {
      stream.next();
      const prelude: Token[] = [];
      let content: Token[] | null = null;
      while (!stream.done) {
        const u = stream.peek()!;
        if (u.type === 'literal' && u.value === ';') {
          stream.next();
          break;
        }
        if (u.type === '{}') {
          stream.next();
          content = u.content;
          break;
        }
        prelude.push(stream.next()!);
      }
      rules.push({
        type: 'at-rule', atKeyword: t.value, lowerAtKeyword: t.lowerValue, prelude, content,
      });
      continue;
    }
    // Qualified rule: prelude until a {} block.
    const prelude: Token[] = [];
    let content: Token[] | null = null;
    while (!stream.done) {
      const u = stream.next()!;
      if (u.type === '{}') {
        content = u.content;
        break;
      }
      prelude.push(u);
    }
    if (content === null) {
      rules.push({ type: 'error', kind: 'invalid', message: 'EOF reached before {} block for a qualified rule.' });
    } else rules.push({ type: 'qualified-rule', prelude, content });
  }
  void skipWhitespace;
  return rules;
}

export function serialize(tokens: Token[]): string {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'whitespace': out += ' '; break;
      case 'comment': break;
      case 'ident': case 'literal': out += t.value; break;
      case 'at-keyword': out += '@' + t.value; break;
      case 'hash': out += '#' + t.value; break;
      case 'string': out += JSON.stringify(t.value); break;
      case 'url': out += `url(${t.value})`; break;
      case 'number': out += t.repr; break;
      case 'percentage': out += t.repr + '%'; break;
      case 'dimension': out += t.repr + t.unit; break;
      case 'function': out += t.name + '(' + serialize(t.arguments) + ')'; break;
      case '()': out += '(' + serialize(t.content) + ')'; break;
      case '[]': out += '[' + serialize(t.content) + ']'; break;
      case '{}': out += '{' + serialize(t.content) + '}'; break;
      default: break;
    }
  }
  return out;
}