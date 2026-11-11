// SPDX-License-Identifier: BSD-3-Clause

/**
 * Bitmap-only OpenType fonts (EBLC/EBDT strikes, no glyf). Upstream (pdf/fonts.py _build_bitmap_font_dictionary)
 * decodes every glyph of the first strike with fontTools and embeds each as a Type 3 glyph (CharProcs), so the text
 * is drawn with the font size 1 and the bitmaps keep their pixel metrics. This module reads the same data.
 */

export interface BitmapGlyph {
  width: number;
  height: number;
  x: number;
  y: number;
  advance: number;
  /** Bytes per row of `bitmap` (rows are byte-aligned). */
  stride: number;
  /** Decoded 1-bit image (rows padded to bytes); null for composite glyphs. */
  bitmap: Uint8Array | null;
  subglyphs: Array<{ id: number; x: number; y: number }> | null;
}

function tableOf(sfnt: Uint8Array, tag: string): { offset: number; length: number } | null {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const count = view.getUint16(4);
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const t = String.fromCharCode(...sfnt.subarray(record, record + 4));
    if (t === tag) return { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };
  }
  return null;
}

/** Upstream bitmap test: EBDT and EBLC present, and no outlines (glyf absent or empty). */
export function isBitmapOnly(sfnt: Uint8Array): boolean {
  if (!tableOf(sfnt, 'EBDT') || !tableOf(sfnt, 'EBLC')) return false;
  const glyf = tableOf(sfnt, 'glyf');
  return !glyf || glyf.length === 0;
}

/** Decode the glyphs of the first strike, keyed by glyph id (upstream: ttfont['EBDT'].strikeData[0]). */
export function readBitmapGlyphs(sfnt: Uint8Array): Map<number, BitmapGlyph> {
  const out = new Map<number, BitmapGlyph>();
  const eblcEntry = tableOf(sfnt, 'EBLC');
  const ebdtEntry = tableOf(sfnt, 'EBDT');
  if (!eblcEntry || !ebdtEntry) return out;
  const eblc = new DataView(sfnt.buffer, sfnt.byteOffset + eblcEntry.offset, eblcEntry.length);
  const ebdt = sfnt.subarray(ebdtEntry.offset, ebdtEntry.offset + ebdtEntry.length);
  const ebdtView = new DataView(ebdt.buffer, ebdt.byteOffset, ebdt.byteLength);
  // BitmapSize of strike 0 starts at offset 8 (48 bytes each).
  const subtableArrayOffset = eblc.getUint32(8);
  const numSubtables = eblc.getUint32(8 + 8);
  for (let i = 0; i < numSubtables; i++) {
    const entry = subtableArrayOffset + i * 8;
    const firstGlyph = eblc.getUint16(entry);
    const lastGlyph = eblc.getUint16(entry + 2);
    const sub = subtableArrayOffset + eblc.getUint32(entry + 4);
    const indexFormat = eblc.getUint16(sub);
    const imageFormat = eblc.getUint16(sub + 2);
    const imageDataOffset = eblc.getUint32(sub + 4);
    const imageSize = indexFormat === 2 || indexFormat === 5 ? eblc.getUint32(sub + 8) : 0;
    // Big metrics of index formats 2 and 5 (the metrics of every glyph of the subtable).
    const big = indexFormat === 2 || indexFormat === 5 ? readBigMetrics(eblc, sub + 12) : null;

    // Locate each glyph's data as [start, end) relative to imageDataOffset.
    const locations: Array<{ gid: number; start: number; end: number }> = [];
    if (indexFormat === 1 || indexFormat === 3) {
      const count = lastGlyph - firstGlyph + 2;
      const read = (k: number): number => (indexFormat === 1 ? eblc.getUint32(sub + 8 + k * 4) : eblc.getUint16(sub + 8 + k * 2));
      for (let k = 0; k < count - 1; k++) {
        locations.push({ gid: firstGlyph + k, start: read(k), end: read(k + 1) });
      }
    } else if (indexFormat === 2) {
      for (let k = 0; k < lastGlyph - firstGlyph + 1; k++) {
        locations.push({ gid: firstGlyph + k, start: k * imageSize, end: (k + 1) * imageSize });
      }
    } else if (indexFormat === 4) {
      const numGlyphs = eblc.getUint32(sub + 8);
      for (let k = 0; k < numGlyphs; k++) {
        const pair = sub + 12 + k * 4;
        const next = sub + 12 + (k + 1) * 4;
        locations.push({
          gid: eblc.getUint16(pair), start: eblc.getUint16(pair + 2), end: eblc.getUint16(next + 2),
        });
      }
    } else if (indexFormat === 5) {
      const numGlyphs = eblc.getUint32(sub + 20);
      for (let k = 0; k < numGlyphs; k++) {
        locations.push({ gid: eblc.getUint16(sub + 24 + k * 2), start: k * imageSize, end: (k + 1) * imageSize });
      }
    }

    for (const { gid, start, end } of locations) {
      const dataStart = imageDataOffset + start;
      if (end < start || dataStart > ebdt.length) continue;
      const raw = ebdt.subarray(dataStart, Math.min(dataStart + (end - start), ebdt.length));
      const glyph = decodeGlyph(imageFormat, raw, big, ebdtView, ebdt, dataStart);
      if (glyph) out.set(gid, glyph);
    }
  }
  return out;
}

interface Big { height: number; width: number; bearingX: number; bearingY: number; advance: number }

function readBigMetrics(view: DataView, at: number): Big {
  return {
    height: view.getUint8(at), width: view.getUint8(at + 1),
    bearingX: view.getInt8(at + 2), bearingY: view.getInt8(at + 3), advance: view.getUint8(at + 4),
  };
}

/** Decode one EBDT entry (upstream: the glyph loop body of _build_bitmap_font_dictionary). */
function decodeGlyph(
  imageFormat: number, raw: Uint8Array, big: Big | null, _ebdtView: DataView, _ebdt: Uint8Array, _at: number,
): BitmapGlyph | null {
  let height: number;
  let width: number;
  let x: number;
  let y: number;
  let advance: number;
  let data: Uint8Array;
  if (imageFormat === 5) {
    // Metrics come from the subtable (upstream: subtable.metrics), the entry is only the bitmap.
    if (!big) return null;
    height = big.height;
    width = big.width;
    x = big.bearingX;
    y = big.bearingY - height;
    advance = big.width;
    data = raw;
  } else {
    const dataStart = imageFormat === 1 || imageFormat === 2 || imageFormat === 8 ? 5 : 8;
    data = raw.subarray(dataStart);
    if (raw.length < 5) return null;
    height = raw[0];
    width = raw[1];
    x = (raw[2] << 24) >> 24;
    y = ((raw[3] << 24) >> 24) - height;
    advance = raw[4];
  }
  const stride = Math.ceil(width / 8);
  const glyph: BitmapGlyph = { width, height, x, y, advance, stride, bitmap: null, subglyphs: null };
  if (width === 0 || height === 0 || data.length === 0) {
    glyph.bitmap = new Uint8Array(0);
  } else if (imageFormat === 1 || imageFormat === 6) {
    glyph.bitmap = data;
  } else if (imageFormat === 2 || imageFormat === 5 || imageFormat === 7) {
    // Bit-aligned rows in the font, byte-aligned rows in the PDF image.
    const out = new Uint8Array(height * stride);
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const bit = row * width + col;
        const byte = data[bit >> 3];
        if (byte === undefined) continue;
        if ((byte >> (7 - (bit & 7))) & 1) out[row * stride + (col >> 3)] |= 0x80 >> (col & 7);
      }
    }
    glyph.bitmap = out;
  } else if (imageFormat === 8 || imageFormat === 9) {
    const i = imageFormat === 9 ? 0 : 1;
    const count = (data[i] << 8) | data[i + 1];
    const subglyphs: Array<{ id: number; x: number; y: number }> = [];
    for (let j = 0; j < count; j++) {
      const index = i + 2 + j * 4;
      subglyphs.push({
        id: (data[index] << 8) | data[index + 1],
        x: (data[index + 2] << 24) >> 24,
        y: (data[index + 3] << 24) >> 24,
      });
    }
    glyph.subglyphs = subglyphs;
  } else {
    glyph.bitmap = new Uint8Array(height * stride); // unsupported format: blank, as upstream
  }
  return glyph;
}

/**
 * Compose a composite glyph from its (non-composite) components, as upstream does with big integers: each component
 * row is aligned to the glyph's stride, shifted by its x offset, and OR-ed at its vertical position.
 */
export function composeGlyph(glyph: BitmapGlyph, glyphs: Map<number, BitmapGlyph>): Uint8Array | null {
  const { stride, height } = glyph;
  const total = BigInt(height * stride * 8);
  const mask = (1n << BigInt(stride * 8)) - 1n;
  let bitmap = 0n;
  for (const sub of glyph.subglyphs ?? []) {
    const component = glyphs.get(sub.id);
    if (!component || !component.bitmap) continue; // unknown or composite-of-composite: skipped, as upstream
    for (let rowY = 0; rowY < component.height; rowY++) {
      const row = component.bitmap.subarray(rowY * component.stride, (rowY + 1) * component.stride);
      let value = 0n;
      for (const byte of row) value = (value << 8n) | BigInt(byte);
      const strideDifference = stride - component.stride;
      if (strideDifference > 0) value <<= BigInt(strideDifference * 8);
      else if (strideDifference < 0) value >>= BigInt(-strideDifference * 8);
      if (sub.x > 0) value >>= BigInt(sub.x);
      else if (sub.x < 0) value <<= BigInt(-sub.x);
      value %= mask + 1n;
      const shift = BigInt(stride * 8 * (height - sub.y - rowY - 1));
      value <<= shift;
      bitmap |= value;
    }
  }
  if (bitmap >= 1n << total) return null;
  const out = new Uint8Array(height * stride);
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = Number(bitmap & 0xffn);
    bitmap >>= 8n;
  }
  return out;
}
