// SPDX-License-Identifier: BSD-3-Clause

/** A low-level PDF generator (port of pydyf 0.13). */
import { zlibSync } from 'fflate';
import { md5Hex } from '../md5.ts';

const encoder = new TextEncoder();
const ascii = (s: string): Uint8Array => encoder.encode(s);

export type PdfValue = number | string | Uint8Array | PdfObject | null | undefined;

export function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function join(sep: Uint8Array, parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = [];
  parts.forEach((p, i) => {
    if (i) out.push(sep);
    out.push(p);
  });
  return concat(out);
}

const SPACE = ascii(' ');
const NEWLINE = ascii('\n');

export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // Python: f'{item:f}'.rstrip('0') -> six decimals, trailing zeros removed
  if (!Number.isFinite(n)) return String(n);
  let s = n.toFixed(6).replace(/0+$/, '');
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s === '-0' || s === '') s = '0';
  return s;
}

export function toBytes(item: PdfValue): Uint8Array {
  if (item instanceof Uint8Array) return item;
  if (typeof item === 'number') return ascii(formatNumber(item));
  if (item instanceof PdfObject) return item.data;
  if (typeof item === 'boolean') return ascii(item ? 'true' : 'false');
  return ascii(String(item));
}

/** Name object bytes (with leading solidus). */
export function name(s: string): string {
  let out = '/';
  for (const byte of encoder.encode(s)) {
    out += byte >= 33 && byte <= 126 && !'<>()[]/# '.includes(String.fromCharCode(byte))
      ? String.fromCharCode(byte) : `#${byte.toString(16).padStart(2, '0')}`;
  }
  return out;
}

export abstract class PdfObject {
  number: number | null = null;
  offset = 0;
  generation = 0;
  free = 'n';

  get indirect(): Uint8Array {
    return concat([ascii(`${this.number} ${this.generation} obj\n`), this.data, ascii('\nendobj')]);
  }

  get reference(): string {
    return `${this.number} ${this.generation} R`;
  }

  abstract get data(): Uint8Array;

  get compressible(): boolean {
    return !this.generation && !(this instanceof Stream);
  }
}

export class Dictionary extends PdfObject {
  values: Map<string, PdfValue>;

  constructor(values?: Record<string, PdfValue> | Map<string, PdfValue>) {
    super();
    this.values = values instanceof Map ? new Map(values) : new Map(Object.entries(values ?? {}));
  }

  get(key: string): PdfValue { return this.values.get(key); }
  set(key: string, value: PdfValue): this { this.values.set(key, value); return this; }
  has(key: string): boolean { return this.values.has(key); }
  delete(key: string): boolean { return this.values.delete(key); }
  get size(): number { return this.values.size; }
  entries(): IterableIterator<[string, PdfValue]> { return this.values.entries(); }
  copy(): Dictionary { return new Dictionary(this.values); }

  get data(): Uint8Array {
    const parts: Uint8Array[] = [ascii('<<')];
    for (const [key, value] of this.values) {
      parts.push(ascii('/'), ascii(key), SPACE, toBytes(value));
    }
    parts.push(ascii('>>'));
    return concat(parts);
  }
}

export class PdfArray extends PdfObject {
  items: PdfValue[];

  constructor(items: Iterable<PdfValue> = []) {
    super();
    this.items = [...items];
  }

  push(...values: PdfValue[]): void { this.items.push(...values); }
  get length(): number { return this.items.length; }

  get data(): Uint8Array {
    return concat([ascii('['), join(SPACE, this.items.map(toBytes)), ascii(']')]);
  }
}

export class PdfString extends PdfObject {
  string: string | Uint8Array;

  constructor(string: string | Uint8Array = '') {
    super();
    this.string = string;
  }

  get data(): Uint8Array {
    let bytes: Uint8Array | null;
    if (this.string instanceof Uint8Array) bytes = this.string;
    else {
      const s = this.string;
      bytes = /^[\x00-\x7f]*$/.test(s) ? ascii(s) : null; // Python encodes ascii, else UTF-16BE with BOM
      if (!bytes) {
        const u = new Uint8Array(2 + s.length * 2);
        u[0] = 0xfe; u[1] = 0xff;
        for (let i = 0; i < s.length; i++) {
          u[2 + 2 * i] = s.charCodeAt(i) >> 8;
          u[3 + 2 * i] = s.charCodeAt(i) & 0xff;
        }
        const hex = Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');
        return ascii(`<${hex}>`);
      }
    }
    const out: number[] = [0x28];
    for (const b of bytes) {
      if (b === 0x5c || b === 0x28 || b === 0x29) out.push(0x5c);
      out.push(b);
    }
    out.push(0x29);
    return Uint8Array.from(out);
  }
}

export type StreamItem = string | number | Uint8Array | PdfObject;

export class Stream extends PdfObject {
  stream: StreamItem[];
  extra: Dictionary;
  compress: boolean;

  constructor(stream: StreamItem[] = [], extra: Dictionary | Record<string, PdfValue> = {}, compress = false) {
    super();
    this.stream = stream;
    this.extra = extra instanceof Dictionary ? extra : new Dictionary(extra);
    this.compress = compress;
  }

  beginMarkedContent(tag: string, propertyList: PdfValue = null): void {
    this.stream.push(`/${tag}`);
    if (propertyList === null) this.stream.push('BMC');
    else {
      this.stream.push(propertyList as StreamItem);
      this.stream.push('BDC');
    }
  }
  beginText(): void { this.stream.push('BT'); }
  clip(evenOdd = false): void { this.stream.push(evenOdd ? 'W*' : 'W'); }
  close(): void { this.stream.push('h'); }
  private op(operands: PdfValue[], op: string): void {
    this.stream.push(concat([join(SPACE, operands.map(toBytes)), SPACE, ascii(op)]));
  }
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void { this.op([x1, y1, x2, y2, x3, y3], 'c'); }
  curveStartTo(x2: number, y2: number, x3: number, y3: number): void { this.op([x2, y2, x3, y3], 'v'); }
  curveEndTo(x1: number, y1: number, x3: number, y3: number): void { this.op([x1, y1, x3, y3], 'y'); }
  drawXObject(reference: string): void { this.stream.push(`/${reference} Do`); }
  end(): void { this.stream.push('n'); }
  endMarkedContent(): void { this.stream.push('EMC'); }
  endText(): void { this.stream.push('ET'); }
  fill(evenOdd = false): void { this.stream.push(evenOdd ? 'f*' : 'f'); }
  fillAndStroke(evenOdd = false): void { this.stream.push(evenOdd ? 'B*' : 'B'); }
  fillStrokeAndClose(evenOdd = false): void { this.stream.push(evenOdd ? 'b*' : 'b'); }
  lineTo(x: number, y: number): void { this.op([x, y], 'l'); }
  moveTo(x: number, y: number): void { this.op([x, y], 'm'); }
  moveTextTo(x: number, y: number): void { this.op([x, y], 'Td'); }
  paintShading(shadingName: string): void { this.stream.push(`/${shadingName} sh`); }
  popState(): void { this.stream.push('Q'); }
  pushState(): void { this.stream.push('q'); }
  rectangle(x: number, y: number, width: number, height: number): void { this.op([x, y, width, height], 're'); }
  setColorRgb(r: number, g: number, b: number, stroke = false): void { this.op([r, g, b], stroke ? 'RG' : 'rg'); }
  setColorSpace(space: string, stroke = false): void { this.stream.push(`/${space} ${stroke ? 'CS' : 'cs'}`); }
  setColorSpecial(patternName: string | null, stroke: boolean, ...operands: PdfValue[]): void {
    const ops = patternName ? [...operands, `/${patternName}`] : operands;
    this.stream.push(concat([join(SPACE, ops.map(toBytes)), ascii(stroke ? ' SCN' : ' scn')]));
  }
  setDash(dashArray: number[], dashPhase: number): void {
    this.stream.push(concat([new PdfArray(dashArray).data, SPACE, toBytes(dashPhase), ascii(' d')]));
  }
  setFontSize(font: string, size: number): void { this.stream.push(concat([ascii(`/${font} `), toBytes(size), ascii(' Tf')])); }
  setTextRendering(mode: number): void { this.stream.push(`${mode} Tr`); }
  setTextRise(height: number): void { this.op([height], 'Ts'); }
  setLineCap(cap: number): void { this.stream.push(`${cap} J`); }
  setLineJoin(join_: number): void { this.stream.push(`${join_} j`); }
  setLineWidth(width: number): void { this.op([width], 'w'); }
  setMatrix(a: number, b: number, c: number, d: number, e: number, f: number): void { this.op([a, b, c, d, e, f], 'cm'); }
  setMiterLimit(limit: number): void { this.op([limit], 'M'); }
  setState(stateName: string): void { this.stream.push(`/${stateName} gs`); }
  setTextMatrix(a: number, b: number, c: number, d: number, e: number, f: number): void { this.op([a, b, c, d, e, f], 'Tm'); }
  showText(text: Uint8Array | string): void { this.stream.push(concat([ascii('['), toBytes(text), ascii('] TJ')])); }
  showTextString(text: string): void { this.stream.push(concat([new PdfString(text).data, ascii(' Tj')])); }
  stroke(): void { this.stream.push('S'); }
  strokeAndClose(): void { this.stream.push('s'); }

  get data(): Uint8Array {
    let stream = join(NEWLINE, this.stream.map(toBytes));
    const extra = this.extra.copy();
    if (this.compress) {
      extra.set('Filter', '/FlateDecode');
      stream = zlibSync(stream, { level: 9 });
    }
    extra.set('Length', stream.length);
    return join(NEWLINE, [extra.data, ascii('stream'), stream, ascii('endstream')]);
  }
}

export class PDF {
  objects: PdfObject[] = [];
  pages: Dictionary;
  info: Dictionary;
  catalog: Dictionary;
  currentPosition = 0;
  xrefPosition: number | null = null;

  constructor() {
    const zero = new Dictionary();
    zero.generation = 65535;
    zero.free = 'f';
    this.addObject(zero);
    this.pages = new Dictionary({ Type: '/Pages', Kids: new PdfArray(), Count: 0 });
    this.addObject(this.pages);
    this.info = new Dictionary();
    this.catalog = new Dictionary({ Type: '/Catalog', Pages: this.pages.reference });
    this.addObject(this.catalog);
  }

  addPage(page: Dictionary): void {
    this.pages.set('Count', (this.pages.get('Count') as number) + 1);
    this.addObject(page);
    (this.pages.get('Kids') as PdfArray).push(page.number, 0, 'R');
  }

  addObject(object: PdfObject): void {
    object.number = this.objects.length;
    this.objects.push(object);
  }

  get pageReferences(): string[] {
    const kids = (this.pages.get('Kids') as PdfArray).items;
    return kids.filter((_, i) => i % 3 === 0).map((n) => `${n} 0 R`);
  }

  /** Serialize the document (classic xref table, or xref/object streams when `compress`). */
  /** Trailer /ID: the given identifier (True: the data hash) and the MD5 of every object (pydyf write). */
  private fileIdentifier(identifier: string | true): PdfArray {
    const dataHash = md5Hex(concat(this.objects.filter((o) => o.free !== 'f').map((o) => o.data)));
    const first = identifier === true ? dataHash : identifier;
    return new PdfArray([new PdfString(first), new PdfString(dataHash)]);
  }

  write(version = '1.7', compress = false, identifier: string | true | null = null): Uint8Array {
    const parts: Uint8Array[] = [];
    const writeLine = (content: Uint8Array | string): void => {
      const bytes = typeof content === 'string' ? ascii(content) : content;
      this.currentPosition += bytes.length + 1;
      parts.push(bytes, NEWLINE);
    };
    this.currentPosition = 0;
    if (this.info.size) this.addObject(this.info);
    writeLine(`%PDF-${version}`);
    writeLine(Uint8Array.from([0x25, 0xf0, 0x9f, 0x96, 0xa4]));
    if (version >= '1.5' && compress) {
      const compressed: PdfObject[] = [];
      for (const object of this.objects) {
        if (object.free === 'f') continue;
        if (object.compressible) compressed.push(object);
        else {
          object.offset = this.currentPosition;
          writeLine(object.indirect);
        }
      }
      const header: number[] = [];
      const bodies: Uint8Array[] = [];
      let position = 0;
      for (const object of compressed) {
        const data = object.data;
        bodies.push(data);
        header.push(object.number as number, position);
        position += data.length + 1;
      }
      const headerText = header.join(' ');
      const objStm = new Stream([headerText, ...bodies], { Type: '/ObjStm', N: compressed.length, First: headerText.length + 1 }, compress);
      objStm.offset = this.currentPosition;
      this.addObject(objStm);
      writeLine(objStm.indirect);

      const xref: [number, number, number][] = [];
      let dictIndex = 0;
      for (const object of this.objects) {
        if (object.compressible) xref.push([2, objStm.number as number, dictIndex++]);
        else xref.push([object.number ? 1 : 0, object.offset, object.generation]);
      }
      xref.push([1, this.currentPosition, 0]);
      const field2 = Math.ceil(Math.log(this.currentPosition + 1) / Math.log(256));
      const maxGen = Math.max(...this.objects.map((o) => o.generation));
      const field3 = Math.ceil(Math.log(Math.max(maxGen, compressed.length) + 1) / Math.log(256));
      const lengths = [1, field2, field3];
      const bytes: number[] = [];
      for (const line of xref) {
        line.forEach((value, i) => {
          for (let k = lengths[i] - 1; k >= 0; k--) bytes.push(Math.floor(value / 256 ** k) % 256);
        });
      }
      const extra: Record<string, PdfValue> = {
        Type: '/XRef', Index: new PdfArray([0, this.objects.length + 1]), W: new PdfArray(lengths),
        Size: this.objects.length + 1, Root: this.catalog.reference,
      };
      if (this.info.size) extra.Info = this.info.reference;
      if (identifier) extra.ID = this.fileIdentifier(identifier);
      const xrefStream = new Stream([Uint8Array.from(bytes)], extra, compress);
      this.xrefPosition = xrefStream.offset = this.currentPosition;
      this.addObject(xrefStream);
      writeLine(xrefStream.indirect);
    } else {
      for (const object of this.objects) {
        if (object.free === 'f') continue;
        object.offset = this.currentPosition;
        writeLine(object.indirect);
      }
      this.xrefPosition = this.currentPosition;
      writeLine('xref');
      writeLine(`0 ${this.objects.length}`);
      for (const object of this.objects) {
        writeLine(`${String(object.offset).padStart(10, '0')} ${String(object.generation).padStart(5, '0')} ${object.free} `);
      }
      writeLine('trailer');
      writeLine('<<');
      writeLine(`/Size ${this.objects.length}`);
      writeLine(`/Root ${this.catalog.reference}`);
      if (this.info.size) writeLine(`/Info ${this.info.reference}`);
      if (identifier) writeLine(concat([ascii('/ID '), toBytes(this.fileIdentifier(identifier)), NEWLINE]));
      writeLine('>>');
    }
    writeLine('startxref');
    writeLine(`${this.xrefPosition}`);
    writeLine('%%EOF');
    return concat(parts);
  }
}