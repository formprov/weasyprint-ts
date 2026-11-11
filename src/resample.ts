// SPDX-License-Identifier: BSD-3-Clause

/**
 * Pillow's Image.thumbnail for 8-bit interleaved images (BICUBIC, reducing_gap=2.0), as used by
 * weasyprint's --dpi: size selection, box-average pre-reduce, then the two-pass fixed-point resample.
 * Mirrors Pillow's Resample.c / Reduce.c. RGBA/LA are resampled on straight channels (Pillow premultiplies;
 * differs by +-1 on semi-transparent edges). JPEG draft-mode DCT scaling is not reproduced.
 */

const PRECISION_BITS = 32 - 8 - 2;

function bicubic(x: number): number {
  const a = -0.5;
  x = Math.abs(x);
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

interface Coeffs { bounds: Int32Array; kernel: Int32Array; ksize: number }

function precomputeCoeffs(inSize: number, in0: number, in1: number, outSize: number): Coeffs {
  const scale = (in1 - in0) / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kernel = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  const ss = 1 / filterscale;
  for (let xx = 0; xx < outSize; xx++) {
    const center = in0 + (xx + 0.5) * scale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    k.fill(0);
    let ww = 0;
    for (let x = 0; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) {
      const w = ww !== 0 ? k[x] / ww : k[x];
      kernel[xx * ksize + x] = w < 0 ? Math.trunc(-0.5 + w * (1 << PRECISION_BITS)) : Math.trunc(0.5 + w * (1 << PRECISION_BITS));
    }
    bounds[xx * 2] = xmin;
    bounds[xx * 2 + 1] = xmax;
  }
  return { bounds, kernel, ksize };
}

const clip8 = (v: number): number => {
  const r = Math.floor(v / (1 << PRECISION_BITS));
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

function resampleHorizontal(src: Uint8Array, w: number, h: number, n: number, outW: number, c: Coeffs): Uint8Array {
  const out = new Uint8Array(outW * h * n);
  const half = 1 << (PRECISION_BITS - 1);
  for (let y = 0; y < h; y++) {
    for (let xx = 0; xx < outW; xx++) {
      const xmin = c.bounds[xx * 2], xmax = c.bounds[xx * 2 + 1];
      for (let ch = 0; ch < n; ch++) {
        let ss = half;
        for (let x = 0; x < xmax; x++) ss += src[(y * w + xmin + x) * n + ch] * c.kernel[xx * c.ksize + x];
        out[(y * outW + xx) * n + ch] = clip8(ss);
      }
    }
  }
  return out;
}

function resampleVertical(src: Uint8Array, w: number, n: number, outH: number, c: Coeffs): Uint8Array {
  const out = new Uint8Array(w * outH * n);
  const half = 1 << (PRECISION_BITS - 1);
  const row = w * n;
  for (let yy = 0; yy < outH; yy++) {
    const ymin = c.bounds[yy * 2], ymax = c.bounds[yy * 2 + 1];
    for (let i = 0; i < row; i++) {
      let ss = half;
      for (let y = 0; y < ymax; y++) ss += src[(ymin + y) * row + i] * c.kernel[yy * c.ksize + y];
      out[yy * row + i] = clip8(ss);
    }
  }
  return out;
}

/** Pillow's Image.reduce(factor): box average; edge blocks average only the pixels that exist. */
function reduce(src: Uint8Array, w: number, h: number, n: number, fx: number, fy: number): { data: Uint8Array; width: number; height: number } {
  const ow = Math.ceil(w / fx), oh = Math.ceil(h / fy);
  const out = new Uint8Array(ow * oh * n);
  for (let oy = 0; oy < oh; oy++) {
    const y0 = oy * fy, y1 = Math.min(h, y0 + fy);
    for (let ox = 0; ox < ow; ox++) {
      const x0 = ox * fx, x1 = Math.min(w, x0 + fx);
      const count = (y1 - y0) * (x1 - x0);
      const amend = Math.floor(count / 2);
      const multiplier = Math.floor((1 << 24) / count);
      for (let ch = 0; ch < n; ch++) {
        let sum = amend;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += src[(y * w + x) * n + ch];
        out[(oy * ow + ox) * n + ch] = Math.floor((sum * multiplier) / (1 << 24));
      }
    }
  }
  return { data: out, width: ow, height: oh };
}

function roundAspect(number: number, key: (n: number) => number): number {
  const lo = Math.floor(number), hi = Math.ceil(number);
  return Math.max(key(lo) <= key(hi) ? lo : hi, 1);
}

/** Size Pillow's thumbnail() would produce for a (width, height) request, or null when nothing changes. */
export function thumbnailSize(width: number, height: number, x: number, y: number): [number, number] | null {
  if (x >= width && y >= height) return null;
  const aspect = width / height;
  if (x / y >= aspect) x = roundAspect(y * aspect, (n) => Math.abs(aspect - n / y));
  else y = roundAspect(x / aspect, (n) => (n === 0 ? 0 : Math.abs(aspect - x / n)));
  return [x, y];
}

export function thumbnail(data: Uint8Array, width: number, height: number, channels: number, x: number, y: number):
  { data: Uint8Array; width: number; height: number } {
  const size = thumbnailSize(width, height, x, y);
  if (!size || (size[0] === width && size[1] === height)) return { data, width, height };
  const [ow, oh] = size;
  let src = data, w = width, h = height;
  let box: [number, number, number, number] = [0, 0, width, height];
  const gap = 2;
  const fx = Math.trunc(width / ow / gap) || 1;
  const fy = Math.trunc(height / oh / gap) || 1;
  if (fx > 1 || fy > 1) {
    // _get_safe_box with the full image as box.
    const supX = 1.5 * (width / ow), supY = 1.5 * (height / oh);
    const rb = [Math.max(0, Math.trunc(0 - supX)), Math.max(0, Math.trunc(0 - supY)),
      Math.min(width, Math.ceil(width + supX)), Math.min(height, Math.ceil(height + supY))];
    // The safe box covers the whole image here, so reduce it all.
    void rb;
    const r = reduce(src, w, h, channels, fx, fy);
    src = r.data; w = r.width; h = r.height;
    box = [0, 0, width / fx, height / fy];
  }
  const needH = ow !== w || box[0] !== 0 || box[2] !== w;
  const needV = oh !== h || box[1] !== 0 || box[3] !== h;
  let cur = src, curW = w, curH = h;
  if (needH) { cur = resampleHorizontal(cur, curW, curH, channels, ow, precomputeCoeffs(curW, box[0], box[2], ow)); curW = ow; }
  if (needV) { cur = resampleVertical(cur, curW, channels, oh, precomputeCoeffs(curH, box[1], box[3], oh)); curH = oh; }
  return { data: cur, width: curW, height: curH };
}
