// SPDX-License-Identifier: BSD-3-Clause
/**
 * Baseline JPEG decoder that reproduces libjpeg(-turbo)'s default output:
 * integer inverse DCT (JDCT_ISLOW, jidctint.c), fancy 2x2 chroma upsampling
 * (jdsample.c h2v2_fancy_upsample) and fixed-point YCbCr->RGB (jdcolor.c).
 *
 * Scope: sequential Huffman, interleaved scans, 3-component YCbCr with 4:4:4 or
 * 4:2:0 sampling. Other layouts throw so callers can fall back.
 */
import { AC_CHROMA_BITS, AC_CHROMA_VALS, AC_LUMA_BITS, AC_LUMA_VALS, DC_CHROMA_BITS, DC_CHROMA_VALS, DC_LUMA_BITS, DC_LUMA_VALS } from './tables.ts';

const NATURAL_ORDER = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** Decoded pixels: RGB (3 channels), or the gray samples of a one-component JPEG (1 channel). */
export interface RgbResult { width: number; height: number; data: Uint8Array; channels?: 1 | 3 }

interface HuffTable { maxcode: Int32Array; valptr: Int32Array; mincode: Int32Array; vals: Uint8Array }

function buildHuff(bits: number[], vals: number[]): HuffTable {
  // ITU-T T.81 Annex F.2.2.3 decoder tables.
  const maxcode = new Int32Array(18).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    const n = bits[l - 1];
    if (n) { valptr[l] = k; mincode[l] = code; code += n; k += n; maxcode[l] = code - 1; }
    else maxcode[l] = -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, vals: Uint8Array.from(vals) };
}

/** Entropy-coded segment reader with JPEG 0xFF00 unstuffing and RSTn handling. */
class BitReader {
  private data: Uint8Array;
  pos: number;
  private buf = 0;
  private cnt = 0;
  constructor(data: Uint8Array, start: number) { this.data = data; this.pos = start; }

  private fill(): void {
    while (this.cnt <= 24) {
      let b = 0;
      if (this.pos < this.data.length) {
        const c = this.data[this.pos];
        if (c === 0xff) {
          if (this.data[this.pos + 1] === 0) { b = 0xff; this.pos += 2; }
          // Otherwise a marker: feed zero bits without advancing past it.
        } else { b = c; this.pos++; }
      }
      this.buf = ((this.buf << 8) | b) >>> 0;
      this.cnt += 8;
    }
  }
  bits(n: number): number {
    if (n === 0) return 0;
    if (this.cnt < n) this.fill();
    this.cnt -= n;
    return (this.buf >>> this.cnt) & ((1 << n) - 1);
  }
  decode(t: HuffTable): number {
    let code = this.bits(1);
    let l = 1;
    while (code > t.maxcode[l]) {
      code = (code << 1) | this.bits(1);
      if (++l > 16) throw new Error('bad Huffman code');
    }
    return t.vals[t.valptr[l] + code - t.mincode[l]];
  }
  /** Drop buffered bits and skip past the next RSTn marker. */
  restart(): void {
    this.buf = 0;
    this.cnt = 0;
    while (this.pos + 1 < this.data.length && !(this.data[this.pos] === 0xff && this.data[this.pos + 1] >= 0xd0 && this.data[this.pos + 1] <= 0xd7)) this.pos++;
    this.pos += 2;
  }
  /** Position of the first marker at or after the current read position. */
  markerPos(): number {
    let p = this.pos;
    while (p + 1 < this.data.length && !(this.data[p] === 0xff && this.data[p + 1] !== 0 && !(this.data[p + 1] >= 0xd0 && this.data[p + 1] <= 0xd7))) p++;
    return p;
  }
}

const extend = (v: number, n: number): number => (n === 0 ? 0 : v < (1 << (n - 1)) ? v - (1 << n) + 1 : v);

/** libjpeg jidctint.c, islow, 8-bit. `coef` is dequantized, natural order. Writes clamped samples. */
function idctIslow(coef: Int32Array, out: Uint8Array, outOff: number, stride: number, ws: Int32Array): void {
  const CONST_BITS = 13, PASS1_BITS = 2;
  const F_0_298631336 = 2446, F_0_390180644 = 3196, F_0_541196100 = 4433, F_0_765366865 = 6270;
  const F_0_899976223 = 7373, F_1_175875602 = 9633, F_1_501321110 = 12299, F_1_847759065 = 15137;
  const F_1_961570560 = 16069, F_2_053119869 = 16819, F_2_562915447 = 20995, F_3_072711026 = 25172;
  const descale = (x: number, n: number): number => (x + (1 << (n - 1))) >> n;
  // Pass 1: columns.
  for (let c = 0; c < 8; c++) {
    const z2 = coef[8 * 2 + c], z3 = coef[8 * 6 + c];
    let z1 = (z2 + z3) * F_0_541196100;
    let tmp2 = z1 + z3 * -F_1_847759065;
    let tmp3 = z1 + z2 * F_0_765366865;
    let tmp0 = (coef[c] + coef[8 * 4 + c]) << CONST_BITS;
    let tmp1 = (coef[c] - coef[8 * 4 + c]) << CONST_BITS;
    const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
    tmp0 = coef[8 * 7 + c]; tmp1 = coef[8 * 5 + c]; tmp2 = coef[8 * 3 + c]; tmp3 = coef[8 * 1 + c];
    z1 = tmp0 + tmp3; let z2b = tmp1 + tmp2; let z3b = tmp0 + tmp2; let z4 = tmp1 + tmp3;
    const z5 = (z3b + z4) * F_1_175875602;
    tmp0 = tmp0 * F_0_298631336; tmp1 = tmp1 * F_2_053119869; tmp2 = tmp2 * F_3_072711026; tmp3 = tmp3 * F_1_501321110;
    z1 = z1 * -F_0_899976223; z2b = z2b * -F_2_562915447; z3b = z3b * -F_1_961570560; z4 = z4 * -F_0_390180644;
    z3b += z5; z4 += z5;
    tmp0 += z1 + z3b; tmp1 += z2b + z4; tmp2 += z2b + z3b; tmp3 += z1 + z4;
    const sh = CONST_BITS - PASS1_BITS;
    ws[c] = descale(tmp10 + tmp3, sh);
    ws[56 + c] = descale(tmp10 - tmp3, sh);
    ws[8 + c] = descale(tmp11 + tmp2, sh);
    ws[48 + c] = descale(tmp11 - tmp2, sh);
    ws[16 + c] = descale(tmp12 + tmp1, sh);
    ws[40 + c] = descale(tmp12 - tmp1, sh);
    ws[24 + c] = descale(tmp13 + tmp0, sh);
    ws[32 + c] = descale(tmp13 - tmp0, sh);
  }
  // Pass 2: rows, then range-limit (+128, clamp to 0..255).
  const sh2 = CONST_BITS + PASS1_BITS + 3;
  for (let r = 0; r < 8; r++) {
    const b = r * 8;
    const z2 = ws[b + 2], z3 = ws[b + 6];
    let z1 = (z2 + z3) * F_0_541196100;
    let tmp2 = z1 + z3 * -F_1_847759065;
    let tmp3 = z1 + z2 * F_0_765366865;
    let tmp0 = (ws[b] + ws[b + 4]) << CONST_BITS;
    let tmp1 = (ws[b] - ws[b + 4]) << CONST_BITS;
    const tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
    tmp0 = ws[b + 7]; tmp1 = ws[b + 5]; tmp2 = ws[b + 3]; tmp3 = ws[b + 1];
    z1 = tmp0 + tmp3; let z2b = tmp1 + tmp2; let z3b = tmp0 + tmp2; let z4 = tmp1 + tmp3;
    const z5 = (z3b + z4) * F_1_175875602;
    tmp0 = tmp0 * F_0_298631336; tmp1 = tmp1 * F_2_053119869; tmp2 = tmp2 * F_3_072711026; tmp3 = tmp3 * F_1_501321110;
    z1 = z1 * -F_0_899976223; z2b = z2b * -F_2_562915447; z3b = z3b * -F_1_961570560; z4 = z4 * -F_0_390180644;
    z3b += z5; z4 += z5;
    tmp0 += z1 + z3b; tmp1 += z2b + z4; tmp2 += z2b + z3b; tmp3 += z1 + z4;
    const o = outOff + r * stride;
    const put = (x: number, i: number): void => {
      const v = descale(x, sh2) + 128;
      out[o + i] = v < 0 ? 0 : v > 255 ? 255 : v;
    };
    put(tmp10 + tmp3, 0); put(tmp10 - tmp3, 7);
    put(tmp11 + tmp2, 1); put(tmp11 - tmp2, 6);
    put(tmp12 + tmp1, 2); put(tmp12 - tmp1, 5);
    put(tmp13 + tmp0, 3); put(tmp13 - tmp0, 4);
  }
}

interface Component {
  id: number; h: number; v: number; tq: number;
  blocksW: number; blocksH: number; // MCU-padded block grid
  realW: number; realH: number;     // blocks covering the real image (non-interleaved scans)
  coef: Int16Array;
  dcPred: number;
  td: number; ta: number;
}

interface Scan {
  comps: Component[];
  Ss: number; Se: number; Ah: number; Al: number;
  start: number;
}

/** Decode a whole JPEG (baseline or progressive Huffman) to RGB, like libjpeg's defaults. */
export function decodeJpegLibjpeg(data: Uint8Array): RgbResult {
  const qtables: Int32Array[] = [];
  const huff: Record<string, HuffTable> = {};
  let width = 0, height = 0, hmax = 1, vmax = 1, restartInterval = 0, progressive = false;
  let comps: Component[] = [];
  let mcusX = 0, mcusY = 0;
  const scans: Scan[] = [];
  let pos = 2;
  let frameFound = false;

  while (pos < data.length) {
    if (data[pos] !== 0xff) { pos++; continue; }
    const m = data[pos + 1];
    if (m === 0xff) { pos++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { pos += 2; continue; }
    if (m === 0xd9) break;
    const len = (data[pos + 2] << 8) | data[pos + 3];
    const seg = pos + 4, end = pos + 2 + len;
    if (m === 0xdb) {
      let p = seg;
      while (p < end) {
        const pq = data[p] >> 4, tq = data[p] & 15; p++;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          const v = pq ? (data[p + 2 * i] << 8) | data[p + 2 * i + 1] : data[p + i];
          t[NATURAL_ORDER[i]] = v; // DQT is in zigzag order
        }
        p += pq ? 128 : 64;
        qtables[tq] = t;
      }
    } else if (m === 0xc4) {
      let p = seg;
      while (p < end) {
        const tc = data[p] >> 4, th = data[p] & 15; p++;
        const bits = Array.from(data.subarray(p, p + 16)); p += 16;
        const n = bits.reduce((a, b) => a + b, 0);
        const vals = Array.from(data.subarray(p, p + n)); p += n;
        huff[`${tc}${th}`] = buildHuff(bits, vals);
      }
    } else if (m === 0xc0 || m === 0xc1 || m === 0xc2) {
      if (data[seg] !== 8) throw new Error('only 8-bit JPEG supported');
      progressive = m === 0xc2;
      height = (data[seg + 1] << 8) | data[seg + 2];
      width = (data[seg + 3] << 8) | data[seg + 4];
      const nc = data[seg + 5];
      if (nc !== 3 && nc !== 1) throw new Error('only 1- and 3-component JPEG supported');
      comps = [];
      for (let i = 0; i < nc; i++) {
        const o = seg + 6 + i * 3;
        comps.push({ id: data[o], h: data[o + 1] >> 4, v: data[o + 1] & 15, tq: data[o + 2],
          blocksW: 0, blocksH: 0, realW: 0, realH: 0, coef: new Int16Array(0), dcPred: 0, td: 0, ta: 0 });
      }
      hmax = Math.max(...comps.map((c) => c.h));
      vmax = Math.max(...comps.map((c) => c.v));
      mcusX = Math.ceil(width / (8 * hmax));
      mcusY = Math.ceil(height / (8 * vmax));
      for (const c of comps) {
        c.blocksW = mcusX * c.h;
        c.blocksH = mcusY * c.v;
        c.realW = Math.ceil(Math.ceil(width * c.h / hmax) / 8);
        c.realH = Math.ceil(Math.ceil(height * c.v / vmax) / 8);
        c.coef = new Int16Array(c.blocksW * c.blocksH * 64);
      }
      frameFound = true;
    } else if (m === 0xc3 || (m >= 0xc5 && m <= 0xcf && m !== 0xc8 && m !== 0xcc)) {
      throw new Error(`unsupported JPEG process 0xC${(m & 15).toString(16).toUpperCase()}`);
    } else if (m === 0xdd) {
      restartInterval = (data[seg] << 8) | data[seg + 1];
    } else if (m === 0xda) {
      if (!frameFound) throw new Error('SOS before SOF');
      const ns = data[seg];
      const scomps: Component[] = [];
      for (let i = 0; i < ns; i++) {
        const cid = data[seg + 1 + i * 2], tables = data[seg + 2 + i * 2];
        const c = comps.find((cc) => cc.id === cid);
        if (!c) throw new Error('scan references unknown component');
        c.td = tables >> 4;
        c.ta = tables & 15;
        scomps.push(c);
      }
      const q = seg + 1 + ns * 2;
      const scan: Scan = { comps: scomps, Ss: data[q], Se: data[q + 1], Ah: data[q + 2] >> 4, Al: data[q + 2] & 15, start: end };
      scans.push(scan);
      const reader = new BitReader(data, end);
      decodeScan(reader, scan, progressive, restartInterval, huff, { width, height, mcusX, mcusY, hmax, vmax });
      pos = reader.markerPos();
      continue;
    }
    pos = end;
  }
  if (!frameFound || scans.length === 0) throw new Error('no supported frame/scan');

  // Dequantize + IDCT every block into full planes.
  const planes = comps.map((c) => {
    const pw = c.blocksW * 8, ph = c.blocksH * 8;
    const plane = new Uint8Array(pw * ph);
    const q = qtables[c.tq];
    const coef = new Int32Array(64);
    const ws = new Int32Array(64);
    for (let by = 0; by < c.blocksH; by++) {
      for (let bx = 0; bx < c.blocksW; bx++) {
        const base = (by * c.blocksW + bx) * 64;
        for (let i = 0; i < 64; i++) coef[i] = c.coef[base + i] * q[i];
        idctIslow(coef, plane, by * 8 * pw + bx * 8, pw, ws);
      }
    }
    return { plane, pw };
  });
  const compsOut = comps.map((c, i) => ({ ...c, plane: planes[i].plane, pw: planes[i].pw }));
  if (comps.length === 1) return { width, height, data: crop(compsOut[0], width, height), channels: 1 };

  // Full-size planes (width x height): fancy upsampling for 4:2:0 chroma (jdsample.c), crop otherwise.
  const full: Uint8Array[] = [];
  for (let ci = 0; ci < 3; ci++) {
    const c = compsOut[ci];
    if (c.h === hmax && c.v === vmax) full.push(crop(c, width, height));
    else if (c.h * 2 === hmax && c.v * 2 === vmax) full.push(fancyH2V2(c, width, height));
    else throw new Error('unsupported chroma sampling');
  }
  return { width, height, data: ycc2rgb(full, width, height) };
}

/** Decode one scan's entropy-coded data into the component coefficient buffers. */
function decodeScan(reader: BitReader, scan: Scan, progressive: boolean, restartInterval: number,
  huff: Record<string, HuffTable>, geo: { width: number; height: number; mcusX: number; mcusY: number; hmax: number; vmax: number }): void {
  const { comps, Ss, Se, Ah, Al } = scan;
  for (const c of comps) c.dcPred = 0;
  const dcTab = (c: Component): HuffTable => huff[`0${c.td}`];
  const acTab = (c: Component): HuffTable => huff[`1${c.ta}`];
  const p1 = 1 << Al, m1 = -1 << Al;
  let eobrun = 0;

  // Non-interleaved scans iterate the component's own block grid; interleaved scans iterate MCUs.
  const single = comps.length === 1;
  const c0 = comps[0];
  const totalUnits = single ? c0.realW * c0.realH : geo.mcusX * geo.mcusY;
  const unitsPerRow = single ? c0.realW : geo.mcusX;

  /** Decode one block of component c at block coordinates (bx, by). */
  const decodeBlock = (c: Component, bx: number, by: number): void => {
    const base = (by * c.blocksW + bx) * 64;
    const co = c.coef;
    if (!progressive) {
      const s = reader.decode(dcTab(c));
      c.dcPred += extend(reader.bits(s), s);
      co[base] = c.dcPred;
      const ac = acTab(c);
      for (let k = 1; k < 64; k++) {
        const rs = reader.decode(ac);
        const r = rs >> 4, sz = rs & 15;
        if (sz === 0) {
          if (r === 15) { k += 15; continue; }
          break;
        }
        k += r;
        if (k > 63) break;
        co[base + NATURAL_ORDER[k]] = extend(reader.bits(sz), sz);
      }
      return;
    }
    if (Ss === 0) {
      if (Ah === 0) {
        const s = reader.decode(dcTab(c));
        c.dcPred += extend(reader.bits(s), s);
        co[base] = c.dcPred * (1 << Al);
      } else if (reader.bits(1)) {
        co[base] |= p1;
      }
      return;
    }
    if (Ah === 0) {
      // AC first (jdphuff.c decode_mcu_AC_first).
      if (eobrun > 0) { eobrun--; return; }
      const ac = acTab(c);
      for (let k = Ss; k <= Se; k++) {
        const rs = reader.decode(ac);
        let r = rs >> 4;
        const s = rs & 15;
        if (s) {
          k += r;
          co[base + NATURAL_ORDER[k]] = extend(reader.bits(s), s) * (1 << Al);
        } else if (r === 15) {
          k += 15;
        } else {
          eobrun = (1 << r) + reader.bits(r) - 1;
          break;
        }
      }
      return;
    }
    // AC refinement (jdphuff.c decode_mcu_AC_refine).
    const ac = acTab(c);
    let k = Ss;
    if (eobrun === 0) {
      for (; k <= Se; k++) {
        const rs = reader.decode(ac);
        let r = rs >> 4;
        let s = rs & 15;
        if (s) {
          s = reader.bits(1) ? p1 : m1;
        } else if (r !== 15) {
          eobrun = (1 << r) + reader.bits(r);
          break;
        }
        do {
          const idx = base + NATURAL_ORDER[k];
          if (co[idx] !== 0) {
            if (reader.bits(1)) {
              if ((co[idx] & p1) === 0) co[idx] += co[idx] >= 0 ? p1 : m1;
            }
          } else {
            if (--r < 0) break;
          }
          k++;
        } while (k <= Se);
        if (s) co[base + NATURAL_ORDER[k]] = s;
      }
    }
    if (eobrun > 0) {
      for (; k <= Se; k++) {
        const idx = base + NATURAL_ORDER[k];
        if (co[idx] !== 0) {
          if (reader.bits(1)) {
            if ((co[idx] & p1) === 0) co[idx] += co[idx] >= 0 ? p1 : m1;
          }
        }
      }
      eobrun--;
    }
  };

  let restartsLeft = restartInterval;
  for (let unit = 0; unit < totalUnits; unit++) {
    if (restartInterval && restartsLeft === 0) {
      reader.restart();
      for (const c of comps) c.dcPred = 0;
      eobrun = 0;
      restartsLeft = restartInterval;
    }
    const ux = unit % unitsPerRow, uy = Math.floor(unit / unitsPerRow);
    if (single) {
      decodeBlock(c0, ux, uy);
    } else {
      for (const c of comps) {
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) decodeBlock(c, ux * c.h + bx, uy * c.v + by);
        }
      }
    }
    restartsLeft--;
  }
}

function ycc2rgb(full: Uint8Array[], width: number, height: number): Uint8Array {
  // jdcolor.c, fixed point SCALEBITS 16.
  const FIX = (x: number): number => Math.trunc(x * 65536 + 0.5);
  const ONE_HALF = 1 << 15;
  const crr = new Int32Array(256), cbb = new Int32Array(256), crg = new Int32Array(256), cbg = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = i - 128;
    crr[i] = (FIX(1.40200) * x + ONE_HALF) >> 16;
    cbb[i] = (FIX(1.77200) * x + ONE_HALF) >> 16;
    crg[i] = -FIX(0.71414) * x;
    cbg[i] = -FIX(0.34414) * x + ONE_HALF;
  }
  const clamp = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
  const out = new Uint8Array(width * height * 3);
  const [Y, Cb, Cr] = full;
  for (let i = 0; i < width * height; i++) {
    const yv = Y[i], cbv = Cb[i], crv = Cr[i];
    out[i * 3] = clamp(yv + crr[crv]);
    out[i * 3 + 1] = clamp(yv + ((cbg[cbv] + crg[crv]) >> 16));
    out[i * 3 + 2] = clamp(yv + cbb[cbv]);
  }
  return out;
}

function crop(c: { plane: Uint8Array; pw: number }, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(c.plane.subarray(y * c.pw, y * c.pw + width), y * width);
  return out;
}

/** h2v2 fancy upsampling (jdsample.c). Output plane is width x height (luma size). */
function fancyH2V2(c: { plane: Uint8Array; pw: number }, width: number, height: number): Uint8Array {
  const cw = Math.ceil(width / 2), ch = Math.ceil(height / 2);
  const out = new Uint8Array(width * height);
  const colsum = new Int32Array(cw);
  for (let y = 0; y < height; y++) {
    const ci = y >> 1;
    const far = (y & 1) === 0 ? Math.max(0, ci - 1) : Math.min(ch - 1, ci + 1);
    const near = ci;
    for (let i = 0; i < cw; i++) colsum[i] = c.plane[near * c.pw + i] * 3 + c.plane[far * c.pw + i];
    for (let i = 0; i < cw; i++) {
      const thiscs = colsum[i];
      const lastcs = colsum[Math.max(0, i - 1)];
      const nextcs = colsum[Math.min(cw - 1, i + 1)];
      const x0 = 2 * i;
      out[y * width + x0] = (thiscs * 3 + lastcs + 8) >> 4;
      if (x0 + 1 < width) out[y * width + x0 + 1] = (thiscs * 3 + nextcs + 7) >> 4;
    }
  }
  return out;
}
