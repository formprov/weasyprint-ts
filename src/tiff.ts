// SPDX-License-Identifier: BSD-3-Clause

/**
 * TIFF decoding for images (the first page, as Pillow's Image.open does). Upstream converts the image to RGB, RGBA
 * or keeps grayscale, and embeds PNG; this decoder returns the same pixels. Supported: 1- and 8-bit grayscale,
 * 1- and 8-bit palette, 8-bit RGB and RGBA (ExtraSamples), chunky and planar RGB, strips, compression none (1),
 * LZW (5, with the horizontal predictor) and PackBits (32773). Other layouts raise.
 */
export interface TiffImage {
  width: number;
  height: number;
  mode: 'L' | 'RGB' | 'RGBA';
  data: Uint8Array;
}

interface Ifd {
  [tag: number]: number[];
}

function readIfd(v: DataView, offset: number, little: boolean): Ifd {
  const count = v.getUint16(offset, little);
  const ifd: Ifd = {};
  for (let i = 0; i < count; i++) {
    const entry = offset + 2 + i * 12;
    const tag = v.getUint16(entry, little);
    const type = v.getUint16(entry + 2, little);
    const n = v.getUint32(entry + 4, little);
    const size = type === 3 ? 2 : type === 4 ? 4 : type === 1 || type === 2 || type === 7 ? 1 : 4;
    const at = size * n > 4 ? v.getUint32(entry + 8, little) : entry + 8;
    const values: number[] = [];
    for (let k = 0; k < n; k++) {
      if (type === 3) values.push(v.getUint16(at + k * 2, little));
      else if (type === 4) values.push(v.getUint32(at + k * 4, little));
      else if (type === 5) values.push(v.getUint32(at + k * 8, little) / v.getUint32(at + k * 8 + 4, little));
      else values.push(v.getUint8(at + k));
    }
    ifd[tag] = values;
  }
  return ifd;
}

/** TIFF LZW (MSB first, early code-size change). */
function lzwDecode(data: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let written = 0;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const lengths = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = i;
    lengths[i] = 1;
    prefix[i] = -1;
  }
  let codeSize = 9;
  let next = 258;
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
    for (let k = len - 1; k >= 0 && written + k < expected; k--) {
      out[written + k] = suffix[c];
      c = prefix[c];
    }
    written += len;
  };
  while (written < expected) {
    while (bitCount < codeSize) {
      if (pos >= data.length) return out;
      bitBuffer = ((bitBuffer << 8) | data[pos++]) >>> 0;
      bitCount += 8;
    }
    const code = (bitBuffer >>> (bitCount - codeSize)) & ((1 << codeSize) - 1);
    bitCount -= codeSize;
    bitBuffer &= (1 << bitCount) - 1;
    if (code === 256) {
      codeSize = 9;
      next = 258;
      previous = -1;
      continue;
    }
    if (code === 257) break;
    if (previous === -1) {
      if (code >= 256) break;
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
    if (next + 1 >= (1 << codeSize) && codeSize < 12) codeSize++;
    previous = code;
  }
  return out;
}

function packBitsDecode(data: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let written = 0;
  let pos = 0;
  while (pos < data.length && written < expected) {
    const n = (data[pos++] << 24) >> 24;
    if (n >= 0) {
      for (let i = 0; i <= n && written < expected; i++) out[written++] = data[pos++];
    } else if (n !== -128) {
      const value = data[pos++];
      for (let i = 0; i < 1 - n && written < expected; i++) out[written++] = value;
    }
  }
  return out;
}

export function decodeTiff(data: Uint8Array): TiffImage {
  const little = data[0] === 0x49 && data[1] === 0x49;
  if (!little && !(data[0] === 0x4d && data[1] === 0x4d)) throw new Error('not a TIFF');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (v.getUint16(2, little) !== 42) throw new Error('bad TIFF magic');
  const ifd = readIfd(v, v.getUint32(4, little), little);
  const get = (tag: number, fallback: number): number => (ifd[tag]?.[0] ?? fallback);

  const width = get(256, 0);
  const height = get(257, 0);
  const bits = ifd[258] ?? [1];
  const compression = get(259, 1);
  const photometric = get(262, 1);
  const samples = get(277, 1);
  const planar = get(284, 1);
  const predictor = get(317, 1);
  const rowsPerStrip = get(278, height);
  const offsets = ifd[273] ?? [];
  const counts = ifd[279] ?? [];
  const extra = ifd[338] ?? [];
  const bitsPerSample = bits[0];
  if (![1, 8].includes(bitsPerSample)) throw new Error(`unsupported TIFF depth ${bitsPerSample}`);
  if (compression !== 1 && compression !== 5 && compression !== 32773) throw new Error(`unsupported TIFF compression ${compression}`);
  const hasAlpha = samples === 4 || samples === 2 && extra.length > 0;
  const colorChannels = photometric === 2 || photometric === 3 ? 3 : 1;
  const channels = colorChannels + (hasAlpha ? 1 : 0);
  // Bytes per row of one plane (planar) or of the whole chunky pixel row.
  const bytesPerPixelRow = Math.ceil((width * (planar === 2 ? 1 : samples) * bitsPerSample) / 8);

  // Decode strips into one buffer of planes (planar) or chunky rows.
  const stripsPerPlane = Math.ceil(height / rowsPerStrip);
  const planeSize = bytesPerPixelRow * height;
  const planeCount = planar === 2 ? samples : 1;
  const raw = new Uint8Array(planeSize * planeCount);
  for (let plane = 0; plane < planeCount; plane++) {
    const base = plane * planeSize;
    let row = 0;
    for (let strip = 0; strip < stripsPerPlane; strip++) {
      const index = plane * stripsPerPlane + strip;
      const stripRows = Math.min(rowsPerStrip, height - row);
      const expected = stripRows * bytesPerPixelRow * (planar === 2 ? 1 : 1);
      const start = offsets[index];
      const length = counts[index] ?? expected;
      const chunk = data.subarray(start, start + length);
      let decoded: Uint8Array;
      if (compression === 5) decoded = lzwDecode(chunk, expected);
      else if (compression === 32773) decoded = packBitsDecode(chunk, expected);
      else decoded = chunk.subarray(0, expected);
      if (predictor === 2 && bitsPerSample === 8) {
        const stride = planar === 2 ? 1 : samples;
        for (let r = 0; r < stripRows; r++) {
          const rowStart = r * bytesPerPixelRow;
          for (let i = stride; i < bytesPerPixelRow; i++) decoded[rowStart + i] = (decoded[rowStart + i] + decoded[rowStart + i - stride]) & 255;
        }
      }
      raw.set(decoded.subarray(0, stripRows * bytesPerPixelRow), base + row * bytesPerPixelRow);
      row += stripRows;
    }
  }

  // Convert to 8-bit channels (chunky order), applying the palette.
  const out = new Uint8Array(width * height * channels);
  const palette = ifd[320];
  const sampleAt = (plane: number, x: number, y: number, s: number): number => {
    const rowStart = plane * planeSize + y * bytesPerPixelRow;
    if (bitsPerSample === 8) return raw[rowStart + (planar === 2 ? x : x * samples + s)];
    const bitIndex = x * (planar === 2 ? 1 : samples) + s;
    return (raw[rowStart + (bitIndex >> 3)] >> (7 - (bitIndex & 7))) & 1;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * channels;
      if (photometric === 3 && palette) {
        const index = sampleAt(0, x, y, 0);
        const n = palette.length / 3;
        out[o] = (palette[index] ?? 0) >> 8;
        out[o + 1] = (palette[n + index] ?? 0) >> 8;
        out[o + 2] = (palette[2 * n + index] ?? 0) >> 8;
      } else if (photometric === 2) {
        for (let c = 0; c < 3; c++) {
          const plane = planar === 2 ? c : 0;
          out[o + c] = sampleAt(plane, x, y, c);
        }
      } else {
        const value = sampleAt(0, x, y, 0);
        const level = bitsPerSample === 1 ? (value ? 255 : 0) : value;
        out[o] = photometric === 0 ? 255 - level : level;
      }
      if (hasAlpha) out[o + colorChannels] = sampleAt(planar === 2 ? 3 : 0, x, y, colorChannels);
    }
  }
  const mode: TiffImage['mode'] = hasAlpha ? 'RGBA' : colorChannels === 3 ? 'RGB' : 'L';
  return { width, height, mode, data: out };
}
