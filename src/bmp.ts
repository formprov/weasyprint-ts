// SPDX-License-Identifier: BSD-3-Clause

/**
 * Uncompressed BMP decoding (Pillow's BmpImagePlugin for BI_RGB): 1, 4, 8, 24 and 32 bits per pixel. Pillow's
 * images are palette, bilevel or RGB, and images.py converts them to RGB, so the result is RGB.
 */
export interface BmpImage {
  width: number;
  height: number;
  mode: 'RGB';
  data: Uint8Array;
}

export function decodeBmp(data: Uint8Array): BmpImage {
  if (data[0] !== 0x42 || data[1] !== 0x4d) throw new Error('not a BMP');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pixelOffset = v.getUint32(10, true);
  const headerSize = v.getUint32(14, true);
  if (headerSize < 12) throw new Error('unsupported BMP header');
  let width: number;
  let height: number;
  let bpp: number;
  let compression = 0;
  let colorsUsed = 0;
  let paletteEntry = 4;
  if (headerSize === 12) {
    // OS/2 BITMAPCOREHEADER: 16-bit dimensions, 3-byte palette entries.
    width = v.getUint16(18, true);
    height = v.getUint16(20, true);
    bpp = v.getUint16(24, true);
    paletteEntry = 3;
  } else {
    width = v.getInt32(18, true);
    height = v.getInt32(22, true);
    bpp = v.getUint16(28, true);
    compression = v.getUint32(30, true);
    colorsUsed = v.getUint32(46, true);
  }
  if (compression !== 0 && compression !== 1 && compression !== 2 && compression !== 3) throw new Error(`unsupported BMP compression ${compression}`);
  const topDown = height < 0;
  const absHeight = Math.abs(height);
  const absWidth = Math.abs(width);
  if (![1, 4, 8, 16, 24, 32].includes(bpp)) throw new Error(`unsupported BMP depth ${bpp}`);
  if (compression === 3 && bpp !== 16 && bpp !== 32) throw new Error('unsupported BMP bitfields depth');

  // Palette (for depths up to 8 bits), right after the header.
  const paletteStart = 14 + headerSize;
  const paletteCount = bpp <= 8 ? (colorsUsed || 2 ** bpp) : 0;
  const palette = new Uint8Array(paletteCount * 3);
  for (let i = 0; i < paletteCount; i++) {
    const at = paletteStart + i * paletteEntry;
    palette[i * 3] = data[at + 2];
    palette[i * 3 + 1] = data[at + 1];
    palette[i * 3 + 2] = data[at];
  }

  if (compression === 1 || compression === 2) {
    // RLE8 (1) or RLE4 (2): palette indices, decoded to a bottom-up 8-bit index grid first.
    const indices = decodeRle(data, pixelOffset, absWidth, absHeight, compression === 2 ? 4 : 8);
    const outRle = new Uint8Array(absWidth * absHeight * 3);
    for (let y = 0; y < absHeight; y++) {
      const row = topDown ? y : absHeight - 1 - y;
      for (let x = 0; x < absWidth; x++) {
        const index = indices[row * absWidth + x];
        outRle[(y * absWidth + x) * 3] = palette[index * 3];
        outRle[(y * absWidth + x) * 3 + 1] = palette[index * 3 + 1];
        outRle[(y * absWidth + x) * 3 + 2] = palette[index * 3 + 2];
      }
    }
    return { width: absWidth, height: absHeight, mode: 'RGB', data: outRle };
  }
  if (compression === 3) {
    // The masks are the three DWORDs at offset 54: after a 40-byte header, or inside a V4/V5 header.
    const maskAt = 54;
    const masks = [v.getUint32(maskAt, true), v.getUint32(maskAt + 4, true), v.getUint32(maskAt + 8, true)];
    const shift = (mask: number): number => {
      let n = 0;
      while (mask && !(mask & 1)) { mask >>>= 1; n++; }
      return n;
    };
    const width2 = (mask: number): number => {
      let n = 0;
      for (let m = mask >>> shift(mask); m & 1; m >>>= 1) n++;
      return n;
    };
    const rowBytes = Math.floor((bpp * absWidth + 31) / 32) * 4;
    const pixelBytes = bpp / 8;
    const outMasked = new Uint8Array(absWidth * absHeight * 3);
    for (let y = 0; y < absHeight; y++) {
      const src = pixelOffset + (topDown ? y : absHeight - 1 - y) * rowBytes;
      for (let x = 0; x < absWidth; x++) {
        const at = src + x * pixelBytes;
        const value = pixelBytes === 2 ? v.getUint16(at, true) : v.getUint32(at, true);
        for (let c = 0; c < 3; c++) {
          const bitsCount = width2(masks[c]);
          const raw = (value & masks[c]) >>> shift(masks[c]);
          // Pillow widens each channel to 8 bits: floor(raw * 255 / (2^bits - 1)).
          const scaled = bitsCount === 0 ? 0 : Math.floor((raw * 255) / ((1 << bitsCount) - 1));
          outMasked[(y * absWidth + x) * 3 + c] = scaled;
        }
      }
    }
    return { width: absWidth, height: absHeight, mode: 'RGB', data: outMasked };
  }
  const rowSize = Math.floor((bpp * absWidth + 31) / 32) * 4;
  const out = new Uint8Array(absWidth * absHeight * 3);
  for (let y = 0; y < absHeight; y++) {
    const src = pixelOffset + (topDown ? y : absHeight - 1 - y) * rowSize;
    const dst = y * absWidth * 3;
    for (let x = 0; x < absWidth; x++) {
      const o = dst + x * 3;
      if (bpp === 24) {
        const s = src + x * 3;
        out[o] = data[s + 2];
        out[o + 1] = data[s + 1];
        out[o + 2] = data[s];
      } else if (bpp === 32) {
        const s = src + x * 4;
        out[o] = data[s + 2];
        out[o + 1] = data[s + 1];
        out[o + 2] = data[s];
      } else {
        const bit = x * bpp;
        const byte = data[src + (bit >> 3)];
        const index = (byte >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1);
        out[o] = palette[index * 3];
        out[o + 1] = palette[index * 3 + 1];
        out[o + 2] = palette[index * 3 + 2];
      }
    }
  }
  return { width: absWidth, height: absHeight, mode: 'RGB', data: out };
}

/**
 * Run-length decoding (BI_RLE8 and BI_RLE4). The result is indices in bottom-up row order, with the pixels not
 * addressed by the stream (after a delta) left at index 0.
 */
function decodeRle(data: Uint8Array, start: number, width: number, height: number, bits: 4 | 8): Uint8Array {
  const out = new Uint8Array(width * height);
  let x = 0;
  let y = 0;
  let pos = start;
  const put = (index: number): void => {
    if (x < width && y < height) out[y * width + x] = index;
    x++;
  };
  while (pos + 1 < data.length) {
    const count = data[pos];
    const value = data[pos + 1];
    pos += 2;
    if (count > 0) {
      // Encoded run: `count` pixels of the value (two alternating nibbles for RLE4).
      for (let i = 0; i < count; i++) {
        put(bits === 8 ? value : i % 2 === 0 ? value >> 4 : value & 15);
      }
      continue;
    }
    if (value === 0) {
      // End of line.
      x = 0;
      y++;
    } else if (value === 1) {
      break; // end of bitmap
    } else if (value === 2) {
      // Delta: move the position right and up by the next two bytes.
      x += data[pos];
      y += data[pos + 1];
      pos += 2;
    } else {
      // Absolute run of `value` pixels, padded to a word boundary.
      const bytes = bits === 8 ? value : Math.ceil(value / 2);
      for (let i = 0; i < value; i++) {
        const byte = data[pos + (bits === 8 ? i : i >> 1)];
        put(bits === 8 ? byte : i % 2 === 0 ? byte >> 4 : byte & 15);
      }
      pos += bytes + (bytes % 2);
    }
  }
  return out;
}
