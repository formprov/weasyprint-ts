// SPDX-License-Identifier: BSD-3-Clause

/** PDF stream with extra features (mirrors weasyprint/pdf/stream.py). */
import type { RGBA } from '../css/color.ts';
import { LOGGER } from '../logger.ts';
import { Matrix } from '../matrix.ts';
import type { FontFace } from '../text/font_config.ts';
import { STRETCH_CLASS } from '../text/font_config.ts';
import type { Style } from '../css/style.ts';
import { PdfFont } from './fonts.ts';
import { Dictionary, PdfArray, Stream, toBytes } from './pydyf.ts';
import type { PdfValue } from './pydyf.ts';

/** Words pango_font_description_from_string() recognises, lower-cased. Probed
 * against the pinned libpango 1.57; see docs/font-naming-parity.md. */
const PANGO_KEYWORDS = new Set([
  'thin', 'ultra-light', 'extra-light', 'light', 'semi-light', 'book', 'regular', 'normal',
  'roman', 'medium', 'semi-bold', 'demi-bold', 'bold', 'ultra-bold', 'extra-bold', 'heavy',
  'black', 'ultra-heavy', 'ultra-black', 'oblique', 'italic', 'small-caps',
  'ultra-condensed', 'extra-condensed', 'condensed', 'semi-condensed',
  'semi-expanded', 'expanded', 'extra-expanded', 'ultra-expanded',
]);
/** A trailing size token pango would read back as a size (no words after it). */
const PANGO_SIZE_TOKEN = /^(?:\d+\.?\d*|\.\d+)(?:e\d+)?(?:px)?$/;

/** pango_font_description_to_string() puts ',' right after the family when the
 * family's last token would otherwise be re-parsed as a style/weight/stretch
 * word, or as a size when no words follow it. E.g. 'Noto Sans Symbols 2,'
 * (size-like '2'), 'Barlow Condensed, Light Condensed' (keyword 'Condensed'),
 * but 'Noto Sans Symbols 2 Bold' and 'Pacifico Bold' (no separator). */
function pangoFamilySeparator(family: string, hasWords: boolean): string {
  const last = family.split(/\s+/).pop() ?? '';
  const ambiguous = PANGO_KEYWORDS.has(last.toLowerCase()) || (!hasWords && PANGO_SIZE_TOKEN.test(last));
  return ambiguous ? ',' : '';
}

const PANGO_WEIGHT_WORDS: Record<number, string> = {
  100: 'Thin', 200: 'Ultra-Light', 300: 'Light', 350: 'Semi-Light', 400: '',
  500: 'Medium', 600: 'Semi-Bold', 700: 'Bold', 800: 'Ultra-Bold', 900: 'Heavy',
};
const PANGO_STRETCH_WORDS: Record<number, string> = {
  1: 'Ultra-Condensed', 2: 'Extra-Condensed', 3: 'Condensed', 4: 'Semi-Condensed', 5: '',
  6: 'Semi-Expanded', 7: 'Expanded', 8: 'Extra-Expanded', 9: 'Ultra-Expanded',
};

/** pango_font_description_to_string() equivalent: the REQUESTED family followed
 * by weight/style/stretch words (Regular omitted), separated per
 * pangoFamilySeparator. This is what upstream uses for the embedded font's
 * BaseFont name — including for synthetic bold, where the requested 'Bold'
 * names the regular face ('Pacifico-Bold'). Fontconfig's charset order is a
 * separate mechanism. */
export function pangoDescriptionOf(face: FontFace, style: Style): string {
  const family = face.family;
  const requestedWeight = Math.round(style.get('font_weight') as number);
  // Pango synthesizes only bold (synthetic oblique/italic requests are NOT
  // re-synthesized into the description). When it synthesizes, the
  // description is the REQUEST pattern (requested weight word, requested
  // stretch); otherwise the description carries the matched face's own OS/2
  // attributes — a 100-weight request on a 400/900 face is described plainer
  // ('Archivo Black', never '-Thin').
  const synthetic = requestedWeight >= 700 && face.weight < 700;
  // pango_font_describe_with_absolute_size() describes the RESOLVED font, so
  // the style word is the matched face's own: a 700-italic request without an
  // italic face descends to the plain bold name ('Noto Sans Bold', sharing
  // the same PDF font as the surrounding bold text — text-basic case), never
  // a fabricated 'Noto Sans Bold Italic'.
  const italic = face.italic;
  const weightWord = synthetic ? (PANGO_WEIGHT_WORDS[requestedWeight] ?? '')
    : (PANGO_WEIGHT_WORDS[face.weight] ?? '');
  const stretchWord = synthetic ? (PANGO_STRETCH_WORDS[STRETCH_CLASS[style.get('font_stretch')] ?? 5] ?? '')
    : (PANGO_STRETCH_WORDS[face.width] ?? '');
  // Pango's word order is weight, style, stretch.
  const words = [weightWord, italic ? 'Italic' : '', stretchWord].filter(Boolean);
  return [family + pangoFamilySeparator(family, words.length > 0), ...words].join(' ');
}

export interface ImageEntry {
  image: any;
  interpolate: boolean;
  dpiRatios: Set<number>;
  xObject: any;
}

/** Python's str(float): integral values keep a '.0'. */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

export class PdfStream extends Stream {
  pageRectangle: [number, number, number, number];
  fonts: Map<string, PdfFont>;
  resources: Dictionary;
  images: Map<string, ImageEntry>;
  tags: Map<any, { tag: string; mcid: number }> | null;
  colorProfiles: Record<string, any>;
  outputIntent: string | null;
  id = '';
  private currentColor: string | null = null;
  private currentColorStroke: string | null = null;
  private currentAlpha: string | null = null;
  private currentAlphaStroke: string | null = null;
  private currentFont: string | null = null;
  private oldFont: string | null = null;
  private ctmStack: Matrix[] = [new Matrix()];

  constructor(fonts: Map<string, PdfFont>, pageRectangle: [number, number, number, number], resources: Dictionary,
    images: Map<string, ImageEntry>, tags: Map<any, any> | null, colorProfiles: Record<string, any>,
    outputIntent: string | null, stream: any[] = [], extra: Dictionary | Record<string, PdfValue> = {}, compress = false) {
    super(stream, extra, compress);
    this.fonts = fonts;
    this.pageRectangle = pageRectangle;
    this.resources = resources;
    this.images = images;
    this.tags = tags;
    this.colorProfiles = colorProfiles;
    this.outputIntent = outputIntent;
  }

  clone(overrides: { resources?: Dictionary; extra?: Dictionary } = {}): PdfStream {
    return new PdfStream(this.fonts, this.pageRectangle, overrides.resources ?? this.resources, this.images, this.tags,
      this.colorProfiles, this.outputIntent, [], overrides.extra ?? {}, this.compress);
  }

  /** Resource sub-dictionary (ExtGState, XObject, Pattern, Shading). */
  res(kind: string): Dictionary {
    return this.resources.get(kind) as Dictionary;
  }

  get ctm(): Matrix {
    return this.ctmStack[this.ctmStack.length - 1];
  }

  override pushState(): void {
    super.pushState();
    this.ctmStack.push(this.ctm);
  }

  override popState(): void {
    if (this.stream.length && this.stream[this.stream.length - 1] === 'q') this.stream.pop();
    else super.popState();
    this.currentColor = this.currentColorStroke = null;
    this.currentAlpha = this.currentAlphaStroke = null;
    this.currentFont = null;
    this.ctmStack.pop();
  }

  transform(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0): void {
    super.setMatrix(a, b, c, d, e, f);
    this.ctmStack[this.ctmStack.length - 1] = new Matrix(a, b, c, d, e, f).matmul(this.ctm);
  }

  override beginText(): void {
    if (this.stream.length && this.stream[this.stream.length - 1] === 'ET') {
      this.currentFont = this.oldFont;
      this.stream.pop();
    } else super.beginText();
  }

  override endText(): void {
    this.oldFont = this.currentFont;
    this.currentFont = null;
    super.endText();
  }

  setColor(color: RGBA, stroke = false): void {
    this.setAlpha(color.a, stroke);
    let channels: number[] = color.coordinates ? [...color.coordinates] : [color.r, color.g, color.b];
    const key = `${color.space},${channels.join(',')}`;
    if (stroke) {
      if (key === this.currentColorStroke) return;
      this.currentColorStroke = key;
    } else {
      if (key === this.currentColor) return;
      this.currentColor = key;
    }
    if (color.space === 'srgb') this.setColorRgb(color.r, color.g, color.b, stroke);
    else if (color.space === 'device-cmyk') {
      this.setColorSpace('DeviceCMYK', stroke);
      this.setColorSpecial(null, stroke, ...channels);
    } else if (color.space.startsWith('--') && this.colorProfiles[color.space]) {
      this.setColorSpace(color.space, stroke);
      this.setColorSpecial(null, stroke, ...channels);
    } else {
      LOGGER.warning(`Unsupported color space ${color.space}, use sRGB instead`);
      if (channels.length > 3) channels = channels.slice(0, 3);
      while (channels.length < 3) channels.push(0);
      this.setColorRgb(channels[0], channels[1], channels[2], stroke);
    }
  }

  override setFontSize(font: string, size: number): void {
    const key = `${font} ${size}`;
    if (key === this.currentFont) return;
    this.currentFont = key;
    super.setFontSize(font, size);
  }

  /** Register a graphic state dictionary and select it. */
  setStateDict(state: Dictionary): void {
    const states = this.res('ExtGState');
    const key = `s${states.size}`;
    states.set(key, state);
    super.setState(key);
  }

  setAlpha(alpha: number, stroke = false, fill: boolean | null = null): void {
    const doFill = fill === null ? !stroke : fill;
    const states = this.res('ExtGState');
    if (stroke) {
      const key = `A${pyFloat(alpha)}`;
      if (key !== this.currentAlphaStroke) {
        this.currentAlphaStroke = key;
        if (!states.has(key)) states.set(key, new Dictionary({ CA: alpha }));
        super.setState(key);
      }
    }
    if (doFill) {
      const key = `a${pyFloat(alpha)}`;
      if (key !== this.currentAlpha) {
        this.currentAlpha = key;
        if (!states.has(key)) states.set(key, new Dictionary({ ca: alpha }));
        super.setState(key);
      }
    }
  }

  setAlphaState(x: number, y: number, width: number, height: number, mode = 'luminosity'): PdfStream {
    const alphaStream = this.addGroup(x, y, width, height);
    const alphaState = new Dictionary({
      Type: '/ExtGState',
      SMask: new Dictionary({
        Type: '/Mask', S: `/${mode.charAt(0).toUpperCase()}${mode.slice(1)}`, G: alphaStream,
      }),
      ca: 1,
      AIS: 'false',
    });
    this.setStateDict(alphaState);
    return alphaStream;
  }

  setBlendMode(mode: string): void {
    this.setStateDict(new Dictionary({ Type: '/ExtGState', BM: `/${mode}` }));
  }

  /** Register the font of a run (Python: add_font(pango_font)). */
  addFont(face: FontFace, fontSize: number, style?: Style): PdfFont {
    // Upstream keys fonts by the Pango font DESCRIPTION (the requested
    // family + weight/style/stretch words), so one face used under two
    // different requests produces two PDF fonts (e.g. Pacifico and the
    // synthetic 'Pacifico-Bold').
    const description = style ? pangoDescriptionOf(face, style) : null;
    const key = description ?? face.id; // upstream: pango_font_description_hash (size/gravity unset)
    let font = this.fonts.get(key);
    if (!font) {
      font = new PdfFont(face, fontSize, description);
      this.fonts.set(key, font);
    }
    return font;
  }

  private newResources(): Dictionary {
    return new Dictionary({
      ExtGState: new Dictionary(),
      XObject: new Dictionary(),
      Pattern: new Dictionary(),
      Shading: new Dictionary(),
      ColorSpace: this.resources.get('ColorSpace'),
      Font: null, // Will be set by _use_references
    });
  }

  addGroup(x: number, y: number, width: number, height: number): PdfStream {
    const resources = this.newResources();
    const extra = new Dictionary({
      Type: '/XObject',
      Subtype: '/Form',
      BBox: new PdfArray([x, y, x + width, y + height]),
      Resources: resources,
      Group: new Dictionary({ Type: '/Group', S: '/Transparency', I: 'true', CS: this.defaultColorSpace }),
    });
    const group = this.clone({ resources, extra });
    group.id = `x${this.res('XObject').size}`;
    this.res('XObject').set(group.id, group);
    return group;
  }

  addImage(image: any, interpolate: boolean, ratio: number): string {
    const imageName = `i${image.id}${Number(interpolate)}`;
    this.res('XObject').set(imageName, null); // Set by write_pdf
    const existing = this.images.get(imageName);
    if (existing) {
      // Reuse image already stored in document
      existing.dpiRatios.add(ratio);
      return imageName;
    }
    this.images.set(imageName, { image, interpolate, dpiRatios: new Set([ratio]), xObject: null });
    return imageName;
  }

  addPattern(x: number, y: number, width: number, height: number, repeatWidth: number, repeatHeight: number,
    matrix: Matrix): PdfStream {
    const resources = this.newResources();
    const extra = new Dictionary({
      Type: '/Pattern', PatternType: 1,
      BBox: new PdfArray([x, y, x + width, y + height]),
      XStep: repeatWidth, YStep: repeatHeight, TilingType: 1, PaintType: 1,
      Matrix: new PdfArray(matrix.values), Resources: resources,
    });
    const pattern = this.clone({ resources, extra });
    pattern.id = `p${this.res('Pattern').size}`;
    this.res('Pattern').set(pattern.id, pattern);
    return pattern;
  }

  addShading(shadingType: number, domain: number[], coords: number[], extend: boolean, fn: PdfValue,
    colorSpace: string | null = null): Dictionary & { id?: string } {
    const shading: Dictionary & { id?: string } = new Dictionary({
      ShadingType: shadingType,
      ColorSpace: colorSpace ? `/${colorSpace}` : this.defaultColorSpace,
      Domain: new PdfArray(domain),
      Coords: new PdfArray(coords),
      Function: fn,
    });
    if (extend) shading.set('Extend', new PdfArray(['true', 'true']));
    shading.id = `s${this.res('Shading').size}`;
    this.res('Shading').set(shading.id, shading);
    return shading;
  }

  /** Save and restore stream context around `fn` (Python: `with stream.stacked()`). */
  stacked<T>(fn: () => T): T {
    this.pushState();
    try {
      return fn();
    } finally {
      this.popState();
    }
  }

  marked<T>(box: any, tag: string, fn: () => T): T {
    if (this.tags !== null) {
      const mcid = this.tags.size;
      this.tags.set(box, { tag, mcid });
      super.beginMarkedContent(tag, new Dictionary({ MCID: mcid }));
    }
    try {
      return fn();
    } finally {
      if (this.tags !== null) super.endMarkedContent();
    }
  }

  artifact<T>(fn: () => T): T {
    if (this.tags !== null) super.beginMarkedContent('Artifact');
    try {
      return fn();
    } finally {
      if (this.tags !== null) super.endMarkedContent();
    }
  }

  static createInterpolationFunction(domain: number[], c0: number[], c1: number[], n: number): Dictionary {
    return new Dictionary({
      FunctionType: 2, Domain: new PdfArray(domain), C0: new PdfArray(c0), C1: new PdfArray(c1), N: n,
    });
  }

  static createStitchingFunction(domain: number[], encode: number[], bounds: number[], subFunctions: PdfValue[]): Dictionary {
    return new Dictionary({
      FunctionType: 3, Domain: new PdfArray(domain), Encode: new PdfArray(encode), Bounds: new PdfArray(bounds),
      Functions: new PdfArray(subFunctions),
    });
  }

  get defaultColorSpace(): string {
    if (this.outputIntent && this.outputIntent in this.colorProfiles) {
      return `[/ICCBased ${this.colorProfiles[this.outputIntent].pdfReference}]`;
    }
    if (this.outputIntent === 'device-cmyk' || 'device-cmyk' in this.colorProfiles) return '/DeviceCMYK';
    const profiles = Object.values(this.colorProfiles);
    if (profiles.length) return `[/ICCBased ${profiles[0].pdfReference}]`;
    return '/DeviceRGB';
  }
}

export { toBytes, LOGGER };