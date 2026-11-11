// SPDX-License-Identifier: BSD-3-Clause

/**
 * GIF decoding for images (Pillow's Image.open + first frame, as images.py uses it). Upstream converts a GIF to
 * RGB, or to RGBA when it has a transparency entry, and embeds it as PNG; this decoder returns those same pixels.
 */
export interface GifImage {
  width: number;
  height: number;
  mode: 'RGB' | 'RGBA';
  data: Uint8Array;
}

class Reader {
  pos = 0;
  readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  byte(): number {
    if (this.pos >= this.data.length) throw new Error('truncated GIF');
    return this.data[this.pos++];
  }

  u16(): number {
    return this.byte() | (this.byte() << 8);
  }

  /** Concatenated data sub-blocks. */
  subBlocks(): Uint8Array {
    const parts: Uint8Array[] = [];
    for (;;) {
      const size = this.byte();
      if (size === 0) break;
      if (this.pos + size > this.data.length) throw new Error('truncated GIF');
      parts.push(this.data.subarray(this.pos, this.pos + size));
      this.pos += size;
    }
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/** GIF LZW decompression into palette indices (at most `pixels` of them). */
function lzw(minCodeSize: number, data: Uint8Array, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels);
  let written = 0;
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    lengths[i] = 1;
  }
  let previous = -1;
  let bitBuffer = 0;
  let bitCount = 0;
  let pos = 0;
  const firstByte = (code: number): number => {
    let c = code;
    while (prefix[c] !== -1) c = prefix[c];
    return suffix[c];
  };
  const emit = (code: number): void => {
    const len = lengths[code];
    let c = code;
    for (let k = len - 1; k >= 0 && written + k < pixels; k--) {
      out[written + k] = suffix[c];
      c = prefix[c];
    }
    written += len;
  };
  while (written < pixels) {
    while (bitCount < codeSize) {
      if (pos >= data.length) return out;
      bitBuffer |= data[pos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << codeSize) - 1);
    bitBuffer >>>= codeSize;
    bitCount -= codeSize;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      previous = -1;
      continue;
    }
    if (code === end) break;
    if (previous === -1) {
      if (code >= clear) break;
      emit(code);
      previous = code;
      continue;
    }
    if (code < next) {
      emit(code);
      if (next < 4096) {
        prefix[next] = previous;
        suffix[next] = firstByte(code);
        lengths[next] = lengths[previous] + 1;
        next++;
      }
    } else if (code === next && next < 4096) {
      prefix[next] = previous;
      suffix[next] = firstByte(previous);
      lengths[next] = lengths[previous] + 1;
      emit(next);
      next++;
    } else {
      break;
    }
    if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    previous = code;
  }
  return out;
}

/** Decode the first frame of a GIF, on the logical screen size (Pillow's Image.open size). */
export function decodeGif(data: Uint8Array): GifImage {
  const r = new Reader(data);
  const signature = String.fromCharCode(...data.subarray(0, 6));
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('not a GIF');
  r.pos = 6;
  const screenWidth = r.u16();
  const screenHeight = r.u16();
  const screenFlags = r.byte();
  r.byte(); // background color index
  r.byte(); // pixel aspect ratio
  let globalPalette: Uint8Array | null = null;
  if (screenFlags & 0x80) {
    const size = 3 * 2 ** ((screenFlags & 7) + 1);
    globalPalette = data.subarray(r.pos, r.pos + size);
    r.pos += size;
  }
  let transparentIndex: number | null = null;
  for (;;) {
    const block = r.byte();
    if (block === 0x21) {
      const label = r.byte();
      if (label === 0xf9) {
        // Graphic control extension: the transparency flag is bit 0, the index follows the delay.
        const size = r.byte();
        const packed = r.byte();
        r.u16();
        const index = r.byte();
        if (size < 4) throw new Error('bad GIF control extension');
        if (packed & 1) transparentIndex = index;
        r.pos += size - 4;
        r.byte();
      } else {
        r.subBlocks();
      }
    } else if (block === 0x2c) {
      const left = r.u16();
      const top = r.u16();
      const width = r.u16();
      const height = r.u16();
      const flags = r.byte();
      let palette = globalPalette;
      if (flags & 0x80) {
        const size = 3 * 2 ** ((flags & 7) + 1);
        palette = data.subarray(r.pos, r.pos + size);
        r.pos += size;
      }
      const interlaced = (flags & 0x40) !== 0;
      const minCodeSize = r.byte();
      const compressed = r.subBlocks();
      let indices = lzw(minCodeSize, compressed, width * height);
      if (interlaced) indices = deinterlace(indices, width, height);
      if (!palette) throw new Error('GIF without a palette');
      // Compose the frame on the logical screen (unpainted pixels are the background, index 0 as Pillow).
      const hasAlpha = transparentIndex !== null;
      const channels = hasAlpha ? 4 : 3;
      const out = new Uint8Array(screenWidth * screenHeight * channels);
      const background = globalPalette ?? palette;
      for (let i = 0; i < screenWidth * screenHeight; i++) {
        out[i * channels] = background[0];
        out[i * channels + 1] = background[1];
        out[i * channels + 2] = background[2];
        if (hasAlpha) out[i * channels + 3] = 0;
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const cx = left + x;
          const cy = top + y;
          if (cx >= screenWidth || cy >= screenHeight) continue;
          const index = indices[y * width + x];
          const at = (cy * screenWidth + cx) * channels;
          if (hasAlpha && index === transparentIndex) continue;
          out[at] = palette[index * 3];
          out[at + 1] = palette[index * 3 + 1];
          out[at + 2] = palette[index * 3 + 2];
          if (hasAlpha) out[at + 3] = 255;
        }
      }
      return { width: screenWidth, height: screenHeight, mode: hasAlpha ? 'RGBA' : 'RGB', data: out };
    } else {
      throw new Error('GIF without image data');
    }
  }
}

/** Reorder interlaced rows (passes 0-8, 4-8, 2-4, 1-2 by 8, 8, 4, 2). */
function deinterlace(indices: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(indices.length);
  let row = 0;
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) {
    for (let y = start; y < height; y += step) {
      out.set(indices.subarray(row * width, (row + 1) * width), y * width);
      row++;
    }
  }
  return out;
}
