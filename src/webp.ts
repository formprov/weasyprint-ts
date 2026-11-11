// SPDX-License-Identifier: BSD-3-Clause

/**
 * WebP lossless (VP8L) decoding, from the WebP lossless bitstream specification. Pillow decodes WebP with libwebp
 * and upstream embeds the result as PNG, so the pixels returned here are the decoded ARGB image converted to RGB or
 * RGBA (the alpha flag of the header decides). Lossy VP8 images are not supported yet and raise.
 */
export interface WebpImage {
  width: number;
  height: number;
  mode: 'RGB' | 'RGBA';
  data: Uint8Array;
}

const CODE_TO_PLANE = [
  0x18, 0x07, 0x17, 0x19, 0x28, 0x06, 0x27, 0x29, 0x16, 0x1a, 0x26, 0x2a, 0x38, 0x05, 0x37, 0x39, 0x15, 0x1b, 0x36, 0x3a,
  0x25, 0x2b, 0x48, 0x04, 0x47, 0x49, 0x14, 0x1c, 0x35, 0x3b, 0x46, 0x4a, 0x24, 0x2c, 0x58, 0x45, 0x4b, 0x34, 0x3c, 0x03,
  0x57, 0x59, 0x13, 0x1d, 0x56, 0x5a, 0x23, 0x2d, 0x44, 0x4c, 0x55, 0x5b, 0x33, 0x3d, 0x68, 0x02, 0x67, 0x69, 0x12, 0x1e,
  0x66, 0x6a, 0x22, 0x2e, 0x54, 0x5c, 0x43, 0x4d, 0x65, 0x6b, 0x32, 0x3e, 0x78, 0x01, 0x77, 0x79, 0x53, 0x5d, 0x11, 0x1f,
  0x64, 0x6c, 0x42, 0x4e, 0x76, 0x7a, 0x21, 0x2f, 0x75, 0x7b, 0x31, 0x3f, 0x63, 0x6d, 0x52, 0x5e, 0x00, 0x74, 0x7c, 0x41,
  0x4f, 0x10, 0x20, 0x62, 0x6e, 0x30, 0x73, 0x7d, 0x51, 0x5f, 0x40, 0x72, 0x7e, 0x61, 0x6f, 0x50, 0x71, 0x7f, 0x60, 0x70,
];

const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

class BitReader {
  private pos = 0; // bit position
  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  bits(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3];
      if (byte === undefined) throw new Error('truncated WebP data');
      value |= ((byte >> (this.pos & 7)) & 1) << i;
      this.pos++;
    }
    return value;
  }

  bit(): number {
    return this.bits(1);
  }
}

/** A canonical prefix code, decoded bit by bit (the first bit read is the most significant bit of the code). */
class PrefixCode {
  private readonly table = new Map<number, number>();
  private readonly single: number | null;

  constructor(lengths: number[]) {
    const used = lengths.map((len, sym) => [len, sym]).filter(([len]) => len > 0);
    if (used.length === 1) {
      this.single = used[0][1];
      return;
    }
    this.single = null;
    const maxLen = Math.max(0, ...lengths);
    const count = new Array(16).fill(0);
    for (const len of lengths) if (len) count[len]++;
    const next = new Array(16).fill(0);
    let code = 0;
    for (let len = 1; len <= maxLen; len++) {
      code = (code + count[len - 1]) << 1;
      next[len] = code;
    }
    lengths.forEach((len, sym) => {
      if (!len) return;
      this.table.set((len << 16) | next[len], sym);
      next[len]++;
    });
  }

  read(reader: BitReader): number {
    if (this.single !== null) return this.single;
    let code = 0;
    for (let len = 1; len <= 15; len++) {
      code = (code << 1) | reader.bit();
      const symbol = this.table.get((len << 16) | code);
      if (symbol !== undefined) return symbol;
    }
    throw new Error('invalid WebP prefix code');
  }
}

/** Read a prefix code's lengths (the simple form or the code-length-coded form). */
function readPrefixCode(reader: BitReader, alphabetSize: number): PrefixCode {
  const lengths = new Array(alphabetSize).fill(0);
  if (reader.bit()) {
    // Simple code: one or two symbols.
    const numSymbols = reader.bit() + 1;
    const firstIs8Bits = reader.bit();
    const symbol0 = reader.bits(1 + 7 * firstIs8Bits);
    lengths[symbol0] = 1;
    if (numSymbols === 2) lengths[reader.bits(8)] = 1;
    return new PrefixCode(lengths);
  }
  const numCodes = reader.bits(4) + 4;
  const codeLengthLengths = new Array(19).fill(0);
  for (let i = 0; i < numCodes; i++) codeLengthLengths[CODE_LENGTH_ORDER[i]] = reader.bits(3);
  const lengthCode = new PrefixCode(codeLengthLengths);
  let maxSymbol = alphabetSize;
  if (reader.bit()) {
    const lengthBits = 2 + 2 * reader.bits(3);
    maxSymbol = 2 + reader.bits(lengthBits);
  }
  let previous = 8;
  let symbol = 0;
  while (symbol < alphabetSize) {
    if (maxSymbol-- === 0) break;
    const code = lengthCode.read(reader);
    if (code < 16) {
      lengths[symbol++] = code;
      if (code !== 0) previous = code;
    } else {
      let repeat: number;
      let value = 0;
      if (code === 16) {
        repeat = 3 + reader.bits(2);
        value = previous;
      } else if (code === 17) {
        repeat = 3 + reader.bits(3);
      } else {
        repeat = 11 + reader.bits(7);
      }
      for (let i = 0; i < repeat && symbol < alphabetSize; i++) lengths[symbol++] = value;
    }
  }
  return new PrefixCode(lengths);
}

interface Group {
  green: PrefixCode;
  red: PrefixCode;
  blue: PrefixCode;
  alpha: PrefixCode;
  distance: PrefixCode;
}

/** Decode one entropy-coded image (Python-free sketch of the spec's DecodeImageStream). */
function decodeImageStream(reader: BitReader, xsize: number, ysize: number, isLevel0: boolean): Uint32Array {
  let cacheBits = 0;
  if (reader.bit()) cacheBits = reader.bits(4);
  const cacheSize = cacheBits ? 1 << cacheBits : 0;
  let metaBits = 0;
  let metaImage: Uint32Array | null = null;
  let metaWidth = 0;
  let numGroups = 1;
  if (isLevel0 && reader.bit()) {
    metaBits = reader.bits(3) + 2;
    metaWidth = Math.ceil(xsize / (1 << metaBits));
    const metaHeight = Math.ceil(ysize / (1 << metaBits));
    metaImage = decodeImageStream(reader, metaWidth, metaHeight, false);
    let maxGroup = 0;
    for (let i = 0; i < metaImage.length; i++) maxGroup = Math.max(maxGroup, (metaImage[i] >>> 8) & 0xffff);
    numGroups = maxGroup + 1;
  }
  const groups: Group[] = [];
  for (let g = 0; g < numGroups; g++) {
    groups.push({
      green: readPrefixCode(reader, 256 + 24 + cacheSize),
      red: readPrefixCode(reader, 256),
      blue: readPrefixCode(reader, 256),
      alpha: readPrefixCode(reader, 256),
      distance: readPrefixCode(reader, 40),
    });
  }
  const total = xsize * ysize;
  const pixels = new Uint32Array(total);
  const cache = cacheBits ? new Uint32Array(cacheSize) : null;
  const insertCache = (argb: number): void => {
    if (cache) cache[Math.imul(0x1e35a7bd, argb) >>> (32 - cacheBits)] = argb;
  };
  let i = 0;
  while (i < total) {
    const x = i % xsize;
    const y = (i - x) / xsize;
    const group = metaImage ? groups[(metaImage[(y >> metaBits) * metaWidth + (x >> metaBits)] >>> 8) & 0xffff] : groups[0];
    const green = group.green.read(reader);
    if (green < 256) {
      const red = group.red.read(reader);
      const blue = group.blue.read(reader);
      const alpha = group.alpha.read(reader);
      const argb = ((alpha << 24) | (red << 16) | (green << 8) | blue) >>> 0;
      pixels[i++] = argb;
      insertCache(argb);
    } else if (green < 280) {
      const length = prefixValue(reader, green - 256);
      const distSymbol = group.distance.read(reader);
      let distance = prefixValue(reader, distSymbol);
      if (distance <= 120) {
        const v = CODE_TO_PLANE[distance - 1];
        const dy = v >> 4;
        const dx = 8 - (v & 0xf);
        distance = dy * xsize + dx;
        if (distance < 1) distance = 1;
      }
      if (distance > i) throw new Error('invalid WebP backward reference');
      for (let k = 0; k < length && i < total; k++) {
        const argb = pixels[i - distance];
        pixels[i++] = argb;
        insertCache(argb);
      }
    } else {
      if (!cache) throw new Error('WebP cache index without a cache');
      const argb = cache[green - 280];
      pixels[i++] = argb;
      insertCache(argb);
    }
  }
  return pixels;
}

/** The value of a length or distance prefix symbol (the spec's GetCopyDistance). */
function prefixValue(reader: BitReader, symbol: number): number {
  if (symbol < 4) return symbol + 1;
  const extraBits = (symbol - 2) >> 1;
  const offset = (2 + (symbol & 1)) << extraBits;
  return offset + reader.bits(extraBits) + 1;
}

/** Apply the predictor transform's inverse to `pixels` (width x height), in place. */
function predictorInverse(pixels: Uint32Array, width: number, height: number, bits: number, modes: Uint32Array, blockWidth: number): void {
  const add = (a: number, b: number): number => {
    const r = ((a >>> 16) + (b >>> 16)) & 0xff;
    const g = ((a >>> 8) + (b >>> 8)) & 0xff;
    const bl = (a + b) & 0xff;
    const al = ((a >>> 24) + (b >>> 24)) & 0xff;
    return ((al << 24) | (r << 16) | (g << 8) | bl) >>> 0;
  };
  const average2 = (a: number, b: number): number => {
    const ch = (s: number): number => (((a >>> s) & 0xff) + ((b >>> s) & 0xff)) >> 1;
    return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
  };
  const select = (l: number, t: number, tl: number): number => {
    const ch = (s: number): number => (((l >>> s) & 0xff) + ((t >>> s) & 0xff) - ((tl >>> s) & 0xff));
    const pl = [24, 16, 8, 0].reduce((sum, s) => sum + Math.abs(ch(s) - ((l >>> s) & 0xff)), 0);
    const pt = [24, 16, 8, 0].reduce((sum, s) => sum + Math.abs(ch(s) - ((t >>> s) & 0xff)), 0);
    // The spec: L when it is nearer the estimate than T.
    return pl < pt ? l : t;
  };
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
  const addSubtractFull = (a: number, b: number, c: number): number => {
    const ch = (s: number): number => clamp(((a >>> s) & 0xff) + ((b >>> s) & 0xff) - ((c >>> s) & 0xff));
    return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
  };
  const addSubtractHalf = (a: number, b: number): number => {
    const ch = (s: number): number => clamp(((a >>> s) & 0xff) + ((((a >>> s) & 0xff) - ((b >>> s) & 0xff)) >> 1));
    return ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let predicted: number;
      if (y === 0 && x === 0) predicted = 0xff000000;
      else if (y === 0) predicted = pixels[i - 1];
      else if (x === 0) predicted = pixels[i - width];
      else {
        const mode = (modes[(y >> bits) * blockWidth + (x >> bits)] >>> 8) & 0xf;
        const L = pixels[i - 1];
        const T = pixels[i - width];
        const TL = pixels[i - width - 1];
        // The rightmost column's top-right pixel is the leftmost pixel of the current row.
        const TR = x + 1 < width ? pixels[i - width + 1] : pixels[y * width];
        switch (mode) {
          case 0: predicted = 0xff000000; break;
          case 1: predicted = L; break;
          case 2: predicted = T; break;
          case 3: predicted = TR; break;
          case 4: predicted = TL; break;
          case 5: predicted = average2(average2(L, TR), T); break;
          case 6: predicted = average2(L, TL); break;
          case 7: predicted = average2(L, T); break;
          case 8: predicted = average2(TL, T); break;
          case 9: predicted = average2(T, TR); break;
          case 10: predicted = average2(average2(L, TL), average2(T, TR)); break;
          case 11: predicted = select(L, T, TL); break;
          case 12: predicted = addSubtractFull(L, T, TL); break;
          case 13: predicted = addSubtractHalf(average2(L, T), TL); break;
          default: predicted = 0xff000000;
        }
      }
      pixels[i] = add(pixels[i], predicted);
    }
  }
}

/** Decode a VP8L bitstream (after the 'VP8L' chunk header) to RGB(A). */
export function decodeWebpLossless(data: Uint8Array): WebpImage {
  if (data[0] !== 0x2f) throw new Error('bad VP8L signature');
  const reader = new BitReader(data.subarray(1));
  const width = reader.bits(14) + 1;
  const height = reader.bits(14) + 1;
  const alphaUsed = reader.bit();
  if (reader.bits(3) !== 0) throw new Error('unsupported VP8L version');

  // Transforms (read in order, undone in reverse order).
  const transforms: Array<{ type: number; bits: number; data: Uint32Array; width: number }> = [];
  let xsize = width;
  while (reader.bit()) {
    const type = reader.bits(2);
    if (type === 0 || type === 1) {
      const bits = reader.bits(3) + 2;
      const blockWidth = Math.ceil(xsize / (1 << bits));
      const blockHeight = Math.ceil(height / (1 << bits));
      const sub = decodeImageStream(reader, blockWidth, blockHeight, false);
      transforms.push({ type, bits, data: sub, width: blockWidth });
    } else if (type === 2) {
      transforms.push({ type, bits: 0, data: new Uint32Array(0), width: 0 });
    } else {
      const count = reader.bits(8) + 1;
      const palette = decodeImageStream(reader, count, 1, false);
      // Palette entries are delta coded per byte.
      for (let k = 1; k < count; k++) {
        const prev = palette[k - 1];
        const cur = palette[k];
        const ch = (s: number): number => (((prev >>> s) & 0xff) + ((cur >>> s) & 0xff)) & 0xff;
        palette[k] = ((ch(24) << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)) >>> 0;
      }
      const bitsPerIndex = count <= 2 ? 3 : count <= 4 ? 2 : count <= 16 ? 1 : 0;
      transforms.push({ type, bits: bitsPerIndex, data: palette, width: count });
      if (bitsPerIndex) xsize = Math.ceil(xsize / (1 << bitsPerIndex));
    }
  }
  let pixels = decodeImageStream(reader, xsize, height, true);

  for (let t = transforms.length - 1; t >= 0; t--) {
    const transform = transforms[t];
    if (transform.type === 0) {
      predictorInverse(pixels, xsize, height, transform.bits, transform.data, transform.width);
    } else if (transform.type === 1) {
      // Cross-color: per-block multipliers in the transform data.
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < xsize; x++) {
          const i = y * xsize + x;
          const ct = transform.data[(y >> transform.bits) * transform.width + (x >> transform.bits)];
          const greenToRed = ct & 0xff;
          const greenToBlue = (ct >>> 8) & 0xff;
          const redToBlue = (ct >>> 16) & 0xff;
          const argb = pixels[i];
          const green = (argb >>> 8) & 0xff;
          const delta = (t2: number, c: number): number => ((t2 << 24) >> 24) * ((c << 24) >> 24) >> 5;
          const red = (((argb >>> 16) & 0xff) + delta(greenToRed, green)) & 0xff;
          const blue = ((argb & 0xff) + delta(greenToBlue, green) + delta(redToBlue, red)) & 0xff;
          pixels[i] = ((argb & 0xff000000) | (red << 16) | (green << 8) | blue) >>> 0;
        }
      }
    } else if (transform.type === 2) {
      for (let i = 0; i < pixels.length; i++) {
        const argb = pixels[i];
        const green = (argb >>> 8) & 0xff;
        const red = (((argb >>> 16) & 0xff) + green) & 0xff;
        const blue = ((argb & 0xff) + green) & 0xff;
        pixels[i] = ((argb & 0xff000000) | (red << 16) | (green << 8) | blue) >>> 0;
      }
    } else {
      // Color indexing: the green byte of each (possibly packed) pixel holds the palette indices. `bits` is the
      // width shift: 1 << bits indices share a byte, each (8 >> bits) bits wide.
      const palette = transform.data;
      const widthBits = transform.bits;
      const indexBits = 8 >> widthBits;
      const indexMask = (1 << indexBits) - 1;
      const out = new Uint32Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const packed = (pixels[y * xsize + (x >> widthBits)] >>> 8) & 0xff;
          const index = (packed >> ((x & ((1 << widthBits) - 1)) * indexBits)) & indexMask;
          out[y * width + x] = index < palette.length ? palette[index] : 0;
        }
      }
      pixels = out;
      xsize = width;
    }
  }

  const hasAlpha = alphaUsed === 1;
  const channels = hasAlpha ? 4 : 3;
  const out = new Uint8Array(width * height * channels);
  for (let i = 0; i < width * height; i++) {
    const argb = pixels[i];
    out[i * channels] = (argb >>> 16) & 0xff;
    out[i * channels + 1] = (argb >>> 8) & 0xff;
    out[i * channels + 2] = argb & 0xff;
    if (hasAlpha) out[i * channels + 3] = argb >>> 24;
  }
  return { width, height, mode: hasAlpha ? 'RGBA' : 'RGB', data: out };
}
