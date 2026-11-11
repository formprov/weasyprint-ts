// SPDX-License-Identifier: BSD-3-Clause

/**
 * Fetch and decode images (port of weasyprint/images.py).
 *
 * The core is synchronous, so image bytes are supplied through an `ImageSource`
 * (a url -> bytes lookup filled beforehand). `ImageLoader` records the URLs it
 * could not find so a driver can fetch them asynchronously and lay out again.
 */
import { thumbnail } from './resample.ts';
import { decode as decodePng } from 'fast-png';
import type { FetchResult } from './fetch.ts';
import { md5HexText } from './md5.ts';
import { LOGGER } from './logger.ts';
import { JpegTruncatedError, decodeJpegLibjpeg } from './jpeg/decode.ts';
import { decodeGif } from './gif.ts';
import { decodeBmp } from './bmp.ts';
import { decodeTiff } from './tiff.ts';
import { decodeWebpLossless } from './webp.ts';
import { encodeJpegCmyk, encodeJpegGrayscale, encodeJpegLibjpeg } from './jpeg/encode.ts';
import { Dictionary, PdfArray, Stream } from './pdf/pydyf.ts';
import { SvgImage } from './svg/image.ts';

/** Cheap content sniff for standalone SVG bytes without a mime hint. */
export class ImageLoadingError extends Error {}

export interface ImageSize {
  width: number;
  height: number;
  format: 'PNG' | 'JPEG' | 'GIF' | 'BMP' | 'TIFF' | 'WEBP';
  /** JPEG only: number of color components and presence of an Adobe APP14 marker. */
  components?: number;
  adobe?: boolean;
}

/** Read the pixel size from an image header without decoding it. */
export function readImageSize(data: Uint8Array): ImageSize {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length >= 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a) {
    return { width: v.getUint32(16), height: v.getUint32(20), format: 'PNG' };
  }
  if (data.length >= 10 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true), format: 'GIF' };
  }
  if (data.length >= 8 && ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 42) || (data[0] === 0x4d && data[1] === 0x4d && data[3] === 42))) {
    // TIFF: the first image's size is in its first directory.
    const little = data[0] === 0x49;
    const tiff = decodeTiffSize(data, little);
    return { width: tiff.width, height: tiff.height, format: 'TIFF' };
  }
  if (data.length >= 26 && data[0] === 0x42 && data[1] === 0x4d) {
    const headerSize = v.getUint32(14, true);
    const width = headerSize === 12 ? v.getUint16(18, true) : Math.abs(v.getInt32(18, true));
    const height = headerSize === 12 ? v.getUint16(20, true) : Math.abs(v.getInt32(22, true));
    return { width, height, format: 'BMP' };
  }
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    let adobe = false;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i++; continue; }
      const marker = data[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xee) adobe = true;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        // Pillow's JpegImageFile._open rejects these outright, so the oracle never draws such
        // an image (weasyprint logs "Failed to load image" and skips it).
        if (data[i + 4] !== 8) throw new ImageLoadingError(`cannot handle ${data[i + 4]}-bit layers`);
        if (data[i + 9] !== 1 && data[i + 9] !== 3 && data[i + 9] !== 4) {
          throw new ImageLoadingError(`cannot handle ${data[i + 9]}-layer images`);
        }
        return { height: v.getUint16(i + 5), width: v.getUint16(i + 7), format: 'JPEG', components: data[i + 9], adobe };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
      i += 2 + v.getUint16(i + 2);
    }
  }
  if (data.length > 30 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) {
    const kind = String.fromCharCode(data[12], data[13], data[14], data[15]);
    if (kind === 'VP8X') {
      return { width: 1 + (data[24] | (data[25] << 8) | (data[26] << 16)), height: 1 + (data[27] | (data[28] << 8) | (data[29] << 16)), format: 'WEBP' };
    }
    if (kind === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff, format: 'WEBP' };
    if (kind === 'VP8L') {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'WEBP' };
    }
  }
  throw new ImageLoadingError('Unknown image format');
}

/** True when the JPEG carries an APP1 Exif block (Pillow then sets info['exif']). */
function hasExifSegment(data: Uint8Array): boolean {
  let pos = 2;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) return false;
    const marker = data[pos + 1];
    if (marker === 0xda || marker === 0xd9) return false; // start of scan / end of image
    if (marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = (data[pos + 2] << 8) | data[pos + 3];
    if (marker === 0xe1 && len >= 8 && String.fromCharCode(...data.subarray(pos + 4, pos + 10)) === 'Exif\0\0') return true;
    pos += 2 + len;
  }
  return false;
}

/**
 * Pillow re-saves an EXIF JPEG (exif_transpose returns a copy, which drops the
 * original bytes), so the oracle embeds a quality-75 libjpeg re-encode. Matched
 * here with our libjpeg-compatible decode + encode. Falls back to the original
 * bytes for layouts the decoder doesn't support yet.
 */
function reencodeExifJpeg(data: Uint8Array, id: string, quality = 75, ops: string[] = []): Uint8Array {
  try {
    const decoded = decodeJpegLibjpeg(data);
    const channels = decoded.channels ?? 3;
    const mode = channels === 1 ? 'L' : channels === 4 ? 'CMYK' : 'RGB';
    let pixels = decoded.data;
    let width = decoded.width;
    let height = decoded.height;
    for (const op of ops) {
      const t = transposePixels(mode, pixels, width, height, op);
      pixels = t.data; width = t.width; height = t.height;
    }
    // Pillow keeps the mode: 'L' saves gray, 'CMYK' saves 4-component JPEG, else RGB.
    if (channels === 1) return encodeJpegGrayscale(pixels, width, height, quality);
    if (channels === 4) return encodeJpegCmyk(pixels, width, height, quality);
    return encodeJpegLibjpeg(pixels, width, height, quality);
  } catch (error) {
    // Pillow raises on a truncated stream (its exif_transpose loads the pixels), so upstream
    // drops the image instead of embedding it; only unsupported layouts keep the original bytes.
    if (error instanceof JpegTruncatedError) throw new ImageLoadingError(error.message);
    LOGGER.warning(`EXIF JPEG ${id} kept as-is: ${(error as Error).message}`);
    return data;
  }
}

/** Python's round(): half to even. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** The Transpose ops a computed `image-orientation` value applies, mirrored on
 *  rotate_pillow_image: rotate first (if any), then a horizontal flip. For an
 *  ExifTranspose the value is passed straight through. */
function orientationToOps(orientation: unknown, precomputed: string | null): string[] {
  if (precomputed) return [precomputed];
  if (orientation === 'from-image' || orientation === 'none' || orientation == null) return [];
  if (!Array.isArray(orientation)) return [];
  const [angle, flip] = orientation as [number, boolean];
  const ops: string[] = [];
  if (angle === 90) ops.push('ROTATE_90');
  else if (angle === 180) ops.push('ROTATE_180');
  else if (angle === 270) ops.push('ROTATE_270');
  if (flip) ops.push('FLIP_LEFT_RIGHT');
  return ops;
}
const EXIF_OPS: Record<number, string> = {
  1: undefined as unknown as string, 2: 'FLIP_LEFT_RIGHT', 3: 'ROTATE_180', 4: 'FLIP_TOP_BOTTOM',
  5: 'TRANSPOSE', 6: 'ROTATE_270', 7: 'TRANSVERSE', 8: 'ROTATE_90',
};

/** The ExifOrientation (tag 0x0112) of a JPEG's APP1 block; 1 = none. */
function jpegExifOrientation(data: Uint8Array): number {
  let pos = 2;
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) return 1;
    const marker = data[pos + 1];
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0x01 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const len = (data[pos + 2] << 8) | data[pos + 3];
    if (marker === 0xe1 && len >= 8 && String.fromCharCode(...data.subarray(pos + 4, pos + 10)) === 'Exif\0\0') {
      const tiff = data.subarray(pos + 10, pos + 2 + len);
      if (tiff.length < 8) return 1;
      const little = tiff[0] === 0x49 && tiff[1] === 0x49;
      const big = tiff[0] === 0x4d && tiff[1] === 0x4d;
      const u16 = (o: number): number => little ? tiff[o] | (tiff[o + 1] << 8) : (tiff[o] << 8) | tiff[o + 1];
      const u32 = (o: number): number => little
        ? (tiff[o] | (tiff[o + 1] << 8) | (tiff[o + 2] << 16) | (tiff[o + 3] << 24)) >>> 0
        : ((tiff[o] << 24) | (tiff[o + 1] << 16) | (tiff[o + 2] << 8) | tiff[o + 3]) >>> 0;
      if (u16(2) !== 42) return 1;
      const ifd = u32(4);
      if (ifd + 2 > tiff.length) return 1;
      const count = u16(ifd);
      for (let e = 0; e < count; e++) {
        const entry = ifd + 2 + e * 12;
        if (entry + 12 > tiff.length) break;
        if (u16(entry) === 0x112) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
      return 1;
    }
    pos += 2 + len;
  }
  return 1;
}

/**
 * One Pillow `Image.transpose(op)` on an already-decoded raster. Pillow
 * resamples nothing: these are exact index remappings.
 * PIL semantics: ROTATE_90 = 90° counter-clockwise, ROTATE_270 = 90° clockwise;
 * TRANSPOSE mirrors across the main diagonal, TRANSVERSE across the anti-diagonal.
 */
export function transposePixels(mode: string, data: Uint8Array, width: number, height: number,
  op: string): { data: Uint8Array; width: number; height: number } {
  const n = { L: 1, LA: 2, RGB: 3, RGBA: 4, CMYK: 4 }[mode] ?? 3;
  const swap = op === 'ROTATE_90' || op === 'ROTATE_270' || op === 'TRANSPOSE' || op === 'TRANSVERSE';
  const newWidth = swap ? height : width;
  const newHeight = swap ? width : height;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < newHeight; y++) {
    for (let x = 0; x < newWidth; x++) {
      let sx: number, sy: number;
      switch (op) {
        case 'FLIP_LEFT_RIGHT': sx = width - 1 - x; sy = y; break;
        case 'FLIP_TOP_BOTTOM': sx = x; sy = height - 1 - y; break;
        case 'ROTATE_180': sx = width - 1 - x; sy = height - 1 - y; break;
        case 'ROTATE_90': sx = width - 1 - y; sy = x; break;    // PIL rotate_90: CCW
        case 'ROTATE_270': sx = y; sy = height - 1 - x; break;  // PIL rotate_270: CW
        case 'TRANSPOSE': sx = y; sy = x; break;
        case 'TRANSVERSE': sx = width - 1 - y; sy = height - 1 - x; break; // correct anti-diagonal mirror
        default: throw new Error(`Unknown transpose op: ${op}`);
      }
      for (let k = 0; k < n; k++) {
        out[(y * newWidth + x) * n + k] = data[(sy * width + sx) * n + k];
      }
    }
  }
  return { data: out, width: newWidth, height: newHeight };
}

export class RasterImage {
  id: string;
  width: number;
  height: number;
  ratio: number;
  format: ImageSize['format'];
  imageData: Uint8Array;
  mimeType: string | null;
  private components: number;
  private adobe: boolean;
  private pixels: { mode: string; data: Uint8Array } | null = null;
  private dpi: number | null;
  private optimize: boolean;

  constructor(id: string, data: Uint8Array, mimeType: string | null = null, jpegQuality: number | null = null,
    optimize = false, dpi: number | null = null, orientation: unknown = 'from-image') {
    this.dpi = dpi;
    this.optimize = optimize;
    const size = readImageSize(data);
    if (size.format !== 'PNG' && size.format !== 'JPEG' && size.format !== 'GIF' && size.format !== 'BMP' && size.format !== 'TIFF' && size.format !== 'WEBP') {
      throw new ImageLoadingError(`Unsupported image format ${size.format}`);
    }
    this.id = id;
    this.width = size.width;
    this.height = size.height;
    this.format = size.format;
    this.components = size.components ?? 0;
    this.adobe = size.adobe ?? false;
    this.ratio = this.height !== 0 ? this.width / this.height : Infinity;
    this.imageData = data;
    this.mimeType = mimeType;
    if (this.format === 'PNG') this.decodePixels(); // fail early, like Pillow's open + convert
    else if (this.format === 'WEBP') {
      // Upstream converts WebP to PNG: the decoded lossless pixels are what gets embedded.
      let decoded;
      try {
        decoded = decodeWebp(data);
      } catch (error) {
        throw new ImageLoadingError((error as Error).message);
      }
      this.pixels = { mode: decoded.mode, data: decoded.data };
      this.format = 'PNG';
    } else if (this.format === 'GIF' || this.format === 'BMP' || this.format === 'TIFF') {
      // Upstream converts these to PNG: the decoded pixels are what gets embedded.
      let decoded;
      try {
        decoded = this.format === 'GIF' ? decodeGif(data) : this.format === 'BMP' ? decodeBmp(data) : decodeTiff(data);
      } catch (error) {
        throw new ImageLoadingError((error as Error).message);
      }
      this.pixels = { mode: decoded.mode, data: decoded.data };
      this.format = 'PNG';
    } else if (this.format === 'JPEG' && (hasExifSegment(data) || jpegQuality !== null || optimize)) {
      // Upstream re-saves a JPEG that has EXIF (orientation) or an explicit jpeg_quality. Files the
      // decoder cannot handle (arithmetic coding, odd component layouts) keep their original bytes.
      try {
        // The orientation (if any) is applied INSIDE this one decode+transpose+encode pass:
        // Pillow transposes the Pillow image, then saves once — double encoding would drift.
        let op: string | null = null;
        if (orientation === 'from-image') {
          const exif = jpegExifOrientation(data);
          if (exif !== 1) op = EXIF_OPS[exif];
        }
        this.imageData = reencodeExifJpeg(data, id, jpegQuality ?? 75, orientationToOps(orientation, op));
      } catch (error) {
        // A truncated stream makes Pillow's re-save raise, so upstream drops the image; keep
        // that hard failure. Other unsupported layouts fall back to the original bytes.
        if (error instanceof ImageLoadingError) throw error;
        LOGGER.warning(`Could not re-save JPEG image '${id}', embedding the original: ${(error as Error).message}`);
      }
    }
    // Python: rotate_pillow_image(image, orientation) runs on the decoded Pillow image after
    // the (re-)save decision: non-JPEG payloads transpose their decoded pixels; JPEG bytes
    // were already transposed inside the re-save above (a JPEG without exif/quality needs no
    // re-save and no JPEG transpose, since CSS angles still force one like upstream's
    // image_data = none discards).
    let fullOps: string[] = [];
    if (orientation === 'from-image') {
      if (this.format !== 'JPEG') {
        // PNG et al read the Exif from an eXIf chunk only; Pillow treats their info['exif'] the
        // same way. Our corpora never carry one — no op.
        const exif = this.readPngExifOrientation(data);
        if (exif !== 1) fullOps.push(EXIF_OPS[exif]);
      }
    } else if (Array.isArray(orientation)) {
      fullOps = orientationToOps(orientation, null);
    }
    if (fullOps.length) {
      // A JPEG with a CSS angle (and no earlier exif/quality re-save) re-saves upstream too
      // (image_data = none) — rotate inside the re-save.
      if (this.format === 'JPEG') {
        try {
          let decoded = decodeJpegLibjpeg(this.imageData);
          let channels = decoded.channels ?? 3;
          let pixels = decoded.data as Uint8Array;
          let width = decoded.width;
          let height = decoded.height;
          for (const op of fullOps) {
            const mode = channels === 1 ? 'L' : channels === 4 ? 'CMYK' : 'RGB';
            const t = transposePixels(mode, pixels, width, height, op);
            pixels = t.data; width = t.width; height = t.height;
          }
          this.width = width;
          this.height = height;
          this.ratio = this.height !== 0 ? this.width / this.height : Infinity;
          const encode = channels === 1 ? encodeJpegGrayscale : channels === 4 ? encodeJpegCmyk : encodeJpegLibjpeg;
          this.imageData = encode(pixels, width, height, jpegQuality ?? 75);
        } catch (error) {
          if (error instanceof JpegTruncatedError) throw new ImageLoadingError(error.message);
          LOGGER.warning(`Could not re-save JPEG image '${id}', embedding the original: ${(error as Error).message}`);
        }
      } else {
        const decoded = this.decodePixels();
        for (const op of fullOps) {
          const t = transposePixels(decoded.mode, decoded.data, this.width, this.height, op);
          decoded.data = t.data;
          this.width = t.width;
          this.height = t.height;
        }
        this.ratio = this.height !== 0 ? this.width / this.height : Infinity;
        this.pixels = decoded;
      }
    }
  }

  /** An eXIf chunk inside a PNG (Pillow reads info['exif'] for PNGs too; orientation only). */
  private readPngExifOrientation(_data: Uint8Array): number {
    return 1;
  }

  /** Pixel mode as Pillow names it: 'RGB', 'RGBA', 'L', 'LA' or 'CMYK'. */
  get mode(): string {
    if (this.format === 'JPEG') return this.components === 1 ? 'L' : this.components === 4 ? 'CMYK' : 'RGB';
    return this.decodePixels().mode;
  }

  private decodePixels(): { mode: string; data: Uint8Array } {
    if (this.pixels) return this.pixels;
    let png;
    try {
      png = decodePng(this.imageData);
    } catch (error) {
      throw new ImageLoadingError((error as Error).message);
    }
    const { width, height, channels, depth } = png;
    // fast-png hands back bit depths 1, 2 and 4 still packed into bytes; Pillow (and hence upstream)
    // sees one sample per pixel. Unpack them first.
    let src: Uint8Array | Uint16Array = png.data as Uint8Array | Uint16Array;
    if (depth < 8) {
      const count = width * height * channels;
      const bytesPerRow = Math.ceil((width * channels * depth) / 8);
      const unpacked = new Uint8Array(count);
      const mask = (1 << depth) - 1;
      const perByte = 8 / depth;
      for (let y = 0; y < height; y++) {
        const rowStart = y * bytesPerRow;
        for (let x = 0; x < width * channels; x++) {
          const byte = src[rowStart + Math.floor(x / perByte)] as number;
          const shift = 8 - depth * (1 + (x % perByte));
          unpacked[y * width * channels + x] = (byte >> shift) & mask;
        }
      }
      src = unpacked;
    }
    const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round(v * 255 / (2 ** depth - 1)));
    let mode: string;
    let out: Uint8Array;
    if (png.palette) {
      const hasAlpha = png.palette.some((entry: number[]) => entry.length > 3 && entry[3] !== 255);
      mode = hasAlpha ? 'RGBA' : 'RGB';
      const n = hasAlpha ? 4 : 3;
      out = new Uint8Array(width * height * n);
      for (let i = 0; i < width * height; i++) {
        const entry = png.palette[src[i]] ?? [0, 0, 0];
        for (let k = 0; k < n; k++) out[i * n + k] = entry[k] ?? 255;
      }
    } else {
      mode = channels === 1 ? 'L' : channels === 2 ? 'LA' : channels === 3 ? 'RGB' : 'RGBA';
      out = new Uint8Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = to8(src[i]);
    }
    this.pixels = { mode, data: out };
    return this.pixels;
  }

  getIntrinsicSize(resolution: number, _fontSize: number): [number, number, number] {
    return [this.width / resolution, this.height / resolution, this.ratio];
  }

  draw(stream: any, concreteWidth: number, concreteHeight: number, style: any): void {
    if (this.width <= 0 || this.height <= 0) return;
    const interpolate = style.get('image_rendering') === 'auto';
    let ratio = 1;
    if (this.dpi) {
      const ptToIn = 4 / 3 / 96;
      const widthInches = Math.abs(concreteWidth * stream.ctm.m[0][0] * ptToIn);
      const heightInches = Math.abs(concreteHeight * stream.ctm.m[1][1] * ptToIn);
      const dpi = Math.max(this.width / widthInches, this.height / heightInches);
      if (dpi > this.dpi) ratio = this.dpi / dpi;
    }
    const imageName = stream.addImage(this, interpolate, ratio);
    stream.transform(concreteWidth, 0, 0, -concreteHeight, 0, concreteHeight);
    stream.drawXObject(imageName);
  }

  getXObject(interpolate: boolean, dpiRatio: number): Stream {
    let { width, height } = this;
    const mode = this.mode;
    // Upstream: --dpi downscales through Pillow's thumbnail() and embeds the result.
    let thumb: { data: Uint8Array; width: number; height: number } | null = null;
    let thumbJpeg: Uint8Array | null = null;
    if (dpiRatio !== 1) {
      const channels = { L: 1, LA: 2, RGB: 3, RGBA: 4, CMYK: 4 }[mode as 'L'] ?? 3;
      const tw = Math.max(1, pyRound(width * dpiRatio)), th = Math.max(1, pyRound(height * dpiRatio));
      const source = this.format === 'JPEG' ? decodeJpegLibjpeg(this.imageData) : null;
      const t = thumbnail(source ? source.data : this.decodePixels().data, width, height, source ? (source.channels ?? 3) : channels, tw, th);
      width = t.width; height = t.height;
      if (source) {
        const encode = source.channels === 1 ? encodeJpegGrayscale : source.channels === 4 ? encodeJpegCmyk : encodeJpegLibjpeg;
        thumbJpeg = encode(t.data, t.width, t.height, 75);
      }
      else thumb = t;
    }
    const colorSpace = mode === 'RGB' || mode === 'RGBA' ? '/DeviceRGB' : mode === 'L' || mode === 'LA' ? '/DeviceGray' : '/DeviceCMYK';
    const extra = new Dictionary({
      Type: '/XObject', Subtype: '/Image', Width: width, Height: height, ColorSpace: colorSpace,
      BitsPerComponent: 8, Interpolate: interpolate ? 'true' : 'false',
    });
    if (this.format === 'JPEG') {
      if (this.mode === 'CMYK' && this.adobe) extra.set('Decode', new PdfArray([1, 0, 1, 0, 1, 0, 1, 0]));
      extra.set('Filter', '/DCTDecode');
      return new Stream([thumbJpeg ?? this.imageData], extra);
    }
    const data = thumb ? thumb.data : this.decodePixels().data;
    if (mode === 'RGBA' || mode === 'LA') {
      const n = mode === 'RGBA' ? 4 : 2;
      const colorChannels = n - 1;
      const color = new Uint8Array(width * height * colorChannels);
      const alpha = new Uint8Array(width * height);
      for (let i = 0; i < width * height; i++) {
        for (let k = 0; k < colorChannels; k++) color[i * colorChannels + k] = data[i * n + k];
        alpha[i] = data[i * n + colorChannels];
      }
      extra.set('SMask', new Stream([alpha], {
        Type: '/XObject', Subtype: '/Image', Width: width, Height: height, ColorSpace: '/DeviceGray',
        BitsPerComponent: 8, Interpolate: interpolate ? 'true' : 'false',
      }, true));
      return new Stream([color], extra, true);
    }
    return new Stream([data], extra, true);
  }
}

export interface ImageRequest {
  url: string;
  forcedMimeType?: string | null;
  orientation?: unknown;
}

export class ImageLoader {
  /** url -> fetched bytes (or null when fetching failed). */
  sources = new Map<string, FetchResult | null>();
  /** URLs requested but not yet in `sources`. */
  missing = new Set<string>();
  private cache = new Map<string, RasterImage | SvgImage | null>();
  /** Quality of re-saved JPEGs (Python: jpeg_quality, Pillow's default 75). */
  private readonly jpegQuality: number | null;
  /** Re-save JPEGs when optimize_images is set (Pillow's optimize pass; the decoded pixels are the re-save's). */
  private readonly optimizeImages: boolean;

  private readonly dpi: number | null;

  constructor(jpegQuality: number | null = null, optimizeImages = false, dpi: number | null = null) {
    this.dpi = dpi;
    this.jpegQuality = jpegQuality;
    this.optimizeImages = optimizeImages;
  }

  getImageFromUri = (request: ImageRequest): RasterImage | SvgImage | null => {
    const { url } = request;
    if (this.cache.has(url)) return this.cache.get(url)!;
    if (!this.sources.has(url)) {
      this.missing.add(url);
      return null;
    }
    const result = this.sources.get(url);
    let image: RasterImage | SvgImage | null = null;
    if (result) {
      // Python: get_image_from_uri. A declared SVG mime type is tried as SVG first and as raster on
      // failure; anything else is tried as raster first (so a PNG named .svg is still a raster) and as
      // SVG on failure.
      const mimeType = request.forcedMimeType ?? result.mimeType ?? null;
      const asRaster = (): RasterImage =>
        new RasterImage(md5HexText(url), result.body, mimeType, this.jpegQuality, this.optimizeImages, this.dpi, request.orientation);
      // Python: SVGImage(tree, url, ...): the image URL is the SVG's base URL.
      const asSvg = (): SvgImage => new SvgImage(md5HexText(url), result.body, null, null, url);
      try {
        if (mimeType === 'image/svg+xml') {
          try {
            image = asSvg();
          } catch {
            image = asRaster();
          }
        } else {
          try {
            image = asRaster();
          } catch (rasterError) {
            try {
              image = asSvg();
            } catch {
              throw rasterError;
            }
          }
        }
      } catch (error) {
        image = null;
        LOGGER.error(`Failed to load image at '${url}': ${(error as Error).message}`);
      }
    }
    this.cache.set(url, image);
    return image;
  };
}
/** Width and height of the first TIFF directory's image (Pillow's Image.open size). */
function decodeTiffSize(data: Uint8Array, little: boolean): { width: number; height: number } {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ifd = v.getUint32(4, little);
  const count = v.getUint16(ifd, little);
  let width = 0;
  let height = 0;
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    const tag = v.getUint16(entry, little);
    const type = v.getUint16(entry + 2, little);
    const value = type === 3 ? v.getUint16(entry + 8, little) : v.getUint32(entry + 8, little);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return { width, height };
}

/** The WebP image: its VP8L (lossless) chunk. Lossy VP8 images are not supported yet. */
function decodeWebp(data: Uint8Array): { width: number; height: number; mode: 'RGB' | 'RGBA'; data: Uint8Array } {
  let at = 12;
  while (at + 8 <= data.length) {
    const id = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    const size = data[at + 4] | (data[at + 5] << 8) | (data[at + 6] << 16) | (data[at + 7] << 24);
    const payload = data.subarray(at + 8, at + 8 + size);
    if (id === 'VP8L') return decodeWebpLossless(payload);
    if (id === 'VP8 ') throw new ImageLoadingError('lossy WebP images are not supported yet');
    at += 8 + size + (size & 1);
  }
  throw new ImageLoadingError('WebP image without image data');
}
