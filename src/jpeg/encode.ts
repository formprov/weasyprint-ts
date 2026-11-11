// SPDX-License-Identifier: BSD-3-Clause
/**
 * Baseline JPEG encoder that reproduces libjpeg(-turbo)'s output byte for byte
 * for the settings Pillow uses by default: quality 75, 4:2:0 chroma, integer
 * forward DCT (JDCT_ISLOW), standard Huffman tables, no optimization.
 *
 * Algorithms follow libjpeg-turbo: jccolor.c (fixed-point RGB->YCbCr),
 * jcsample.c (h2v2 downsampling with alternating rounding bias), jfdctint.c
 * (islow forward DCT), jcdctmgr.c (quantization with round-half-away),
 * jchuff.c (baseline entropy coding) and jcmarker.c (headers).
 */
import {
  AC_CHROMA_BITS, AC_CHROMA_VALS, AC_LUMA_BITS, AC_LUMA_VALS,
  DC_CHROMA_BITS, DC_CHROMA_VALS, DC_LUMA_BITS, DC_LUMA_VALS,
} from './tables.ts';

/** Zigzag scan position -> natural (row-major) index (libjpeg jpeg_natural_order). */
const NATURAL_ORDER = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Standard luminance / chroma quantization tables, natural order (Annex K). */
const STD_LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA_QUANT = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/** libjpeg jcparam.c: scale the base table by quality (1..100). */
function scaledQuant(base: number[], quality: number): number[] {
  const q = Math.min(100, Math.max(1, Math.trunc(quality)));
  const scale = q < 50 ? Math.trunc(5000 / q) : 200 - q * 2;
  return base.map((b) => Math.min(255, Math.max(1, Math.trunc((b * scale + 50) / 100))));
}

/** Canonical Huffman code assignment (ITU-T T.81 Annex C). */
function buildCodes(bits: number[], vals: number[]): { code: Uint16Array; size: Uint8Array } {
  const code = new Uint16Array(256);
  const size = new Uint8Array(256);
  let c = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      const sym = vals[k++];
      code[sym] = c;
      size[sym] = len;
      c++;
    }
    c <<= 1;
  }
  return { code, size };
}

/** Bit writer with JPEG byte stuffing (0xFF -> 0xFF 0x00). */
class BitWriter {
  out: number[] = [];
  private acc = 0;
  private nbits = 0;

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      this.nbits++;
      if (this.nbits === 8) {
        this.out.push(this.acc);
        if (this.acc === 0xff) this.out.push(0);
        this.acc = 0;
        this.nbits = 0;
      }
    }
  }

  /** Pad the final byte with 1-bits, as libjpeg does. */
  flush(): void {
    if (this.nbits > 0) this.put((1 << (8 - this.nbits)) - 1, 8 - this.nbits);
  }
}

/** Number of bits needed to represent |v| (libjpeg's JPEG magnitude category). */
function magnitude(v: number): number {
  let a = Math.abs(v);
  let n = 0;
  while (a) { n++; a >>= 1; }
  return n;
}

/**
 * Forward DCT, islow (jfdctint.c). `data` is 64 samples (level-shifted),
 * natural order, transformed in place.
 */
function fdctIslow(data: Float64Array | Int32Array): void {
  const CONST_BITS = 13;
  const PASS1_BITS = 2;
  const F_0_298631336 = 2446, F_0_390180644 = 3196, F_0_541196100 = 4433, F_0_765366865 = 6270;
  const F_0_899976223 = 7373, F_1_175875602 = 9633, F_1_501321110 = 12299, F_1_847759065 = 15137;
  const F_1_961570560 = 16069, F_2_053119869 = 16819, F_2_562915447 = 20995, F_3_072711026 = 25172;
  const descale = (x: number, n: number): number => (x + (1 << (n - 1))) >> n;

  for (let pass = 0; pass < 2; pass++) {
    // pass 0: rows (stride 1 within a row, rows every 8); pass 1: columns.
    for (let ctr = 0; ctr < 8; ctr++) {
      const at = (i: number): number => (pass === 0 ? ctr * 8 + i : i * 8 + ctr);
      const d0 = data[at(0)], d1 = data[at(1)], d2 = data[at(2)], d3 = data[at(3)];
      const d4 = data[at(4)], d5 = data[at(5)], d6 = data[at(6)], d7 = data[at(7)];
      const tmp0 = d0 + d7, tmp7 = d0 - d7;
      const tmp1 = d1 + d6, tmp6 = d1 - d6;
      const tmp2 = d2 + d5, tmp5 = d2 - d5;
      const tmp3 = d3 + d4, tmp4 = d3 - d4;
      const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3;
      const tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
      const shift1 = pass === 0 ? CONST_BITS - PASS1_BITS : CONST_BITS + PASS1_BITS;
      const shift0 = pass === 0 ? PASS1_BITS : PASS1_BITS;
      if (pass === 0) {
        data[at(0)] = (tmp10 + tmp11) << PASS1_BITS;
        data[at(4)] = (tmp10 - tmp11) << PASS1_BITS;
      } else {
        data[at(0)] = descale(tmp10 + tmp11, shift0);
        data[at(4)] = descale(tmp10 - tmp11, shift0);
      }
      let z1 = (tmp12 + tmp13) * F_0_541196100;
      data[at(2)] = descale(z1 + tmp13 * F_0_765366865, shift1);
      data[at(6)] = descale(z1 + tmp12 * -F_1_847759065, shift1);
      z1 = tmp4 + tmp7;
      let z2 = tmp5 + tmp6;
      let z3 = tmp4 + tmp6;
      let z4 = tmp5 + tmp7;
      const z5 = (z3 + z4) * F_1_175875602;
      let t4 = tmp4 * F_0_298631336;
      let t5 = tmp5 * F_2_053119869;
      let t6 = tmp6 * F_3_072711026;
      let t7 = tmp7 * F_1_501321110;
      z1 = z1 * -F_0_899976223;
      z2 = z2 * -F_2_562915447;
      z3 = z3 * -F_1_961570560;
      z4 = z4 * -F_0_390180644;
      z3 += z5;
      z4 += z5;
      data[at(7)] = descale(t4 + z1 + z3, shift1);
      data[at(5)] = descale(t5 + z2 + z4, shift1);
      data[at(3)] = descale(t6 + z2 + z3, shift1);
      data[at(1)] = descale(t7 + z1 + z4, shift1);
    }
  }
}

interface Plane { w: number; h: number; data: Uint8Array }
interface Codes { code: Uint16Array; size: Uint8Array }

export function encodeJpegLibjpeg(rgb: Uint8Array, width: number, height: number, quality = 75): Uint8Array {
  const qLuma = scaledQuant(STD_LUMA_QUANT, quality);
  const qChroma = scaledQuant(STD_CHROMA_QUANT, quality);

  // MCU is 16x16 for 4:2:0; pad by replicating the last real column/row.
  const mcuW = Math.ceil(width / 16), mcuH = Math.ceil(height / 16);
  const pw = mcuW * 16, ph = mcuH * 16;

  // RGB -> YCbCr, fixed point with SCALEBITS 16 (jccolor.c).
  const FIX = (x: number): number => Math.round(x * 65536 + 0.0000001) | 0;
  const ONE_HALF = 1 << 15;
  const CBCR = 128 << 16;
  const yPlane = new Plane_(pw, ph), cbPlane = new Plane_(pw, ph), crPlane = new Plane_(pw, ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(y, height - 1);
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(x, width - 1);
      const p = (sy * width + sx) * 3;
      const r = rgb[p], g = rgb[p + 1], b = rgb[p + 2];
      const o = y * pw + x;
      yPlane.data[o] = (FIX(0.29900) * r + FIX(0.58700) * g + FIX(0.11400) * b + ONE_HALF) >> 16;
      cbPlane.data[o] = (-FIX(0.16874) * r - FIX(0.33126) * g + FIX(0.50000) * b + CBCR + ONE_HALF - 1) >> 16;
      crPlane.data[o] = (FIX(0.50000) * r - FIX(0.41869) * g - FIX(0.08131) * b + CBCR + ONE_HALF - 1) >> 16;
    }
  }

  // h2v2 downsampling with alternating bias (jcsample.c). Rows past the real
  // downsampled height repeat its last real row (jcprepct.c: "the downsampler's
  // last output row is then replicated"); columns come from replicated input.
  const realChromaRows = Math.ceil(height / 2);
  const downsample = (src: Plane_): Plane_ => {
    const dst = new Plane_(pw / 2, ph / 2);
    for (let r = 0; r < ph / 2; r++) {
      const sr = Math.min(r, realChromaRows - 1);
      let bias = 1;
      for (let c = 0; c < pw / 2; c++) {
        const i0 = 2 * sr * pw + 2 * c;
        const i1 = i0 + pw;
        dst.data[r * (pw / 2) + c] = (src.data[i0] + src.data[i0 + 1] + src.data[i1] + src.data[i1 + 1] + bias) >> 2;
        bias ^= 3;
      }
    }
    return dst;
  };
  const cb = downsample(cbPlane), cr = downsample(crPlane);

  const lumaDc = buildCodes(DC_LUMA_BITS, DC_LUMA_VALS);
  const lumaAc = buildCodes(AC_LUMA_BITS, AC_LUMA_VALS);
  const chromaDc = buildCodes(DC_CHROMA_BITS, DC_CHROMA_VALS);
  const chromaAc = buildCodes(AC_CHROMA_BITS, AC_CHROMA_VALS);

  const bw = new BitWriter();
  const lastDc = [0, 0, 0];

  /** Forward DCT + quantization of one real 8x8 block; returns natural-order coefficients. */
  const quantizeBlock = (samples: (r: number, c: number) => number, qtab: number[]): Int32Array => {
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) block[r * 8 + c] = samples(r, c) - 128;
    fdctIslow(block);
    const out = new Int32Array(64);
    for (let i = 0; i < 64; i++) {
      const v = block[i];
      const d = qtab[i] << 3;
      // Round half away from zero: floor((|v| + d/2) / d), then restore sign.
      const q = Math.floor((Math.abs(v) + (d >> 1)) / d);
      out[i] = v < 0 ? -q : q;
    }
    return out;
  };
  const block = new Float64Array(64);

  /** Entropy-code one block's coefficients (jchuff.c): DC difference, then AC run-lengths. */
  const encodeCoefs = (coef: Int32Array, comp: number, dc: Codes, ac: Codes): void => {
    const dcv = coef[0];
    const diff = dcv - lastDc[comp];
    lastDc[comp] = dcv;
    const dn = magnitude(diff);
    bw.put(dc.code[dn], dc.size[dn]);
    if (dn) bw.put(diff < 0 ? diff - 1 : diff, dn);
    let run = 0;
    for (let k = 1; k < 64; k++) {
      const v = coef[NATURAL_ORDER[k]];
      if (v === 0) { run++; continue; }
      while (run > 15) { bw.put(ac.code[0xf0], ac.size[0xf0]); run -= 16; }
      const n = magnitude(v);
      const sym = (run << 4) | n;
      bw.put(ac.code[sym], ac.size[sym]);
      bw.put(v < 0 ? v - 1 : v, n);
      run = 0;
    }
    if (run > 0) bw.put(ac.code[0], ac.size[0]);
  };

  // Real block grid sizes (jcdctmgr/jccoefct): blocks cover ceil(size/8) per dimension.
  const yBlockRows = Math.ceil(height / 8), yBlockCols = Math.ceil(width / 8);

  for (let my = 0; my < mcuH; my++) {
    for (let mx = 0; mx < mcuW; mx++) {
      // Y: 2x2 blocks per MCU, buffer index = yi*2 + xi. Blocks outside the image
      // are "dummy" (jccoefct.c): zero AC, DC copied from a neighbour, so they cost
      // almost no bits. Processing order matches libjpeg (row-major within the MCU).
      const yq: Int32Array[] = [];
      for (let yi = 0; yi < 2; yi++) {
        for (let xi = 0; xi < 2; xi++) {
          const idx = yi * 2 + xi;
          const row = my * 2 + yi, col = mx * 2 + xi;
          if (row < yBlockRows && col < yBlockCols) {
            const y0 = row * 8, x0 = col * 8;
            yq[idx] = quantizeBlock((r, c) => yPlane.data[(y0 + r) * pw + x0 + c], qLuma);
          } else {
            const dummy = new Int32Array(64);
            // Right-edge dummy: DC of the block to its left. Bottom-row dummy: DC of buffer[1].
            dummy[0] = row < yBlockRows ? yq[idx - 1][0] : yq[1][0];
            yq[idx] = dummy;
          }
        }
      }
      for (const q of yq) encodeCoefs(q, 0, lumaDc, lumaAc);
      const cy0 = my * 8, cx0 = mx * 8, cw = pw / 2;
      encodeCoefs(quantizeBlock((r, c) => cb.data[(cy0 + r) * cw + cx0 + c], qChroma), 1, chromaDc, chromaAc);
      encodeCoefs(quantizeBlock((r, c) => cr.data[(cy0 + r) * cw + cx0 + c], qChroma), 2, chromaDc, chromaAc);
    }
  }
  bw.flush();

  // Headers (jcmarker.c): SOI, JFIF APP0, DQT x2, SOF0, DHT x4, SOS.
  const bytes: number[] = [0xff, 0xd8];
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  const zig = (q: number[]): number[] => NATURAL_ORDER.map((n) => q[n]);
  for (const [id, q] of [[0, qLuma], [1, qChroma]] as const) {
    bytes.push(0xff, 0xdb, 0x00, 0x43, id, ...zig(q));
  }
  bytes.push(0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01);
  const dht = (cls: number, id: number, bits: number[], vals: number[]): void => {
    bytes.push(0xff, 0xc4, 0x00, 2 + 1 + 16 + vals.length, (cls << 4) | id, ...bits, ...vals);
  };
  dht(0, 0, DC_LUMA_BITS, DC_LUMA_VALS);
  dht(1, 0, AC_LUMA_BITS, AC_LUMA_VALS);
  dht(0, 1, DC_CHROMA_BITS, DC_CHROMA_VALS);
  dht(1, 1, AC_CHROMA_BITS, AC_CHROMA_VALS);
  bytes.push(0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00);
  for (const b of bw.out) bytes.push(b);
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}

class Plane_ implements Plane {
  w: number;
  h: number;
  data: Uint8Array;
  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.data = new Uint8Array(w * h);
  }
}

/**
 * One-component (grayscale) JPEG, as libjpeg writes a gray image at the given quality: one 8x8 block per MCU, the
 * luma tables, and edge blocks filled by replicating the last real samples.
 */
export function encodeJpegGrayscale(gray: Uint8Array, width: number, height: number, quality = 75): Uint8Array {
  const qLuma = scaledQuant(STD_LUMA_QUANT, quality);
  const bw = new BitWriter();
  const lumaDc = buildCodes(DC_LUMA_BITS, DC_LUMA_VALS);
  const lumaAc = buildCodes(AC_LUMA_BITS, AC_LUMA_VALS);
  const blocksW = Math.ceil(width / 8), blocksH = Math.ceil(height / 8);
  const pw = blocksW * 8, ph = blocksH * 8;
  const plane = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(y, height - 1);
    for (let x = 0; x < pw; x++) plane[y * pw + x] = gray[sy * width + Math.min(x, width - 1)];
  }
  const block = new Float64Array(64);
  let lastDc = 0;
  for (let by = 0; by < blocksH; by++) {
    for (let bx = 0; bx < blocksW; bx++) {
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) block[r * 8 + c] = plane[(by * 8 + r) * pw + bx * 8 + c] - 128;
      fdctIslow(block);
      const coef = new Int32Array(64);
      for (let i = 0; i < 64; i++) {
        const v = block[i];
        const d = qLuma[i] << 3;
        const q = Math.floor((Math.abs(v) + (d >> 1)) / d);
        coef[i] = v < 0 ? -q : q;
      }
      // DC difference, then AC run-lengths (jchuff.c).
      const diff = coef[0] - lastDc;
      lastDc = coef[0];
      const dn = magnitude(diff);
      bw.put(lumaDc.code[dn], lumaDc.size[dn]);
      if (dn) bw.put(diff < 0 ? diff - 1 : diff, dn);
      let run = 0;
      for (let k = 1; k < 64; k++) {
        const v = coef[NATURAL_ORDER[k]];
        if (v === 0) { run++; continue; }
        while (run > 15) { bw.put(lumaAc.code[0xf0], lumaAc.size[0xf0]); run -= 16; }
        const n = magnitude(v);
        const sym = (run << 4) | n;
        bw.put(lumaAc.code[sym], lumaAc.size[sym]);
        bw.put(v < 0 ? v - 1 : v, n);
        run = 0;
      }
      if (run > 0) bw.put(lumaAc.code[0], lumaAc.size[0]);
    }
  }
  bw.flush();

  const bytes: number[] = [0xff, 0xd8];
  bytes.push(0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00);
  bytes.push(0xff, 0xdb, 0x00, 0x43, 0x00, ...NATURAL_ORDER.map((n) => qLuma[n]));
  bytes.push(0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00);
  const dht = (cls: number, id: number, bits: number[], vals: number[]): void => {
    bytes.push(0xff, 0xc4, 0x00, 2 + 1 + 16 + vals.length, (cls << 4) | id, ...bits, ...vals);
  };
  dht(0, 0, DC_LUMA_BITS, DC_LUMA_VALS);
  dht(1, 0, AC_LUMA_BITS, AC_LUMA_VALS);
  bytes.push(0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00);
  for (const b of bw.out) bytes.push(b);
  bytes.push(0xff, 0xd9);
  return Uint8Array.from(bytes);
}
