// SPDX-License-Identifier: BSD-3-Clause

/** Fonts integration in PDF (mirrors weasyprint/pdf/fonts.py). */
import { LOGGER } from '../logger.ts';
import { md5Hex } from '../md5.ts';
import type { FontFace } from '../text/font_config.ts';
import { PANGO_SCALE, fontExtents } from '../text/shaper.ts';
import { Dictionary, PDF, PdfArray, PdfString, Stream } from './pydyf.ts';
import { subsetTrueType } from './subset.ts';
import { collectionMemberToSfnt } from '../text/ttc.ts';
import { composeGlyph, isBitmapOnly, readBitmapGlyphs } from '../text/ebdt.ts';

const FROM_UNITS = 1 / PANGO_SCALE;

function stableHash(description: string): string {
  // Python: Font.hash = chr(65 + byte % 26) for each of the first 6 md5 bytes of
  // the description string (weasyprint/pdf/fonts.py). The same 6 letters name the
  // font in /BaseFont, the form /DR and the widget /DA — deriving it from the
  // description alone (never from the face's local path, whose spelling differs
  // per machine) is what makes the port's names byte-equal to the oracle's.
  const digest = md5Hex(new TextEncoder().encode(description));
  const bytes = [];
  for (let i = 0; i < 32; i += 2) bytes.push(parseInt(digest.slice(i, i + 2), 16));
  return bytes.slice(0, 6).map((b) => String.fromCharCode(65 + b % 26)).join('');
}

export class PdfFont {
  face: FontFace;
  fontSize: number;
  hash: string;
  name: string;
  family: string;
  italic: boolean;
  ascent: number;
  descent: number;
  upem: number;
  italicAngle = 0;
  stemv = 80;
  stemh = 80;
  flags: number;
  widths = new Map<number, number>();
  toUnicode = new Map<number, string>();
  missing = new Map<number, number>();
  bitmap = false;  png = false;
  svg = false;
  colr = false;
  usedInForms = false;
  fileContent: Uint8Array;
  type: 'otf' | 'ttf';

  constructor(face: FontFace, fontSize: number, description?: string | null) {
    this.face = face;
    this.fontSize = fontSize;
    this.family = face.family;
    this.italic = face.italic;
    const fk = face.fk;
    this.upem = fk.unitsPerEm;
    const descriptionName = description ?? `${face.family}${face.weight !== 400 ? ` ${face.weight}` : ''}${face.italic ? ' Italic' : ''}`;
    this.hash = stableHash(descriptionName);
    this.name = `/${this.hash}+${descriptionName.replace(/ /g, '-')}`;
    if (fontSize) {
      const { ascent, descent } = fontExtents(face, Math.round(fontSize * PANGO_SCALE));
      this.ascent = Math.round(ascent * FROM_UNITS / fontSize * 1000);
      this.descent = -Math.round(descent * FROM_UNITS / fontSize * 1000);
    } else this.ascent = this.descent = 0;
    this.flags = 2 ** (3 - 1); // Symbolic, custom character set
    if (this.italic) this.flags += 2 ** (7 - 1);
    if (/\bserif\b/i.test(face.family) && !/sans/i.test(face.family)) this.flags += 2 ** (2 - 1);
    // A font collection member is embedded on its own, as upstream's fontTools-loaded font is.
    this.fileContent = collectionMemberToSfnt(face.bytes, face.collectionIndex ?? 0);
    this.glyphCount = (() => {
      try { return face.fk['maxp'].numGlyphs as number; } catch { return 0; }
    })();
    this.bitmap = isBitmapOnly(this.fileContent);
    this.type = this.fileContent[0] === 0x4f && this.fileContent[1] === 0x54 ? 'otf' : 'ttf';
  }

  /** The glyph id for an unsupported code point: one past the real glyph ids, then fresh ones
   *  (Python get_unused_glyph_id); the /Encoding CMap redirects them to glyph 0 (`.notdef`). */
  declare private readonly glyphCount: number;
  getUnusedGlyphId(codepoint: number): number {
    const existing = this.missing.get(codepoint);
    if (existing !== undefined) return existing;
    const next = this.glyphCount + this.missing.size;
    if (next > 2 ** 16 - 1) {
      LOGGER.warning(`Too many glyphs missing from "${this.family}", expect text selection problems`);
      return 2 ** 16 - 1;
    }
    this.missing.set(codepoint, next);
    return next;
  }

  /** Remove unused glyphs and tables from the font. */
  clean(glyphIds: Iterable<number>): void {
    if (this.type === 'ttf') {
      try {
        // hb's NOTDEF_OUTLINE flag: glyph 0 keeps its outline only when the
        // font has missing glyphs, like upstream's `notdef_outline`.
        this.fileContent = subsetTrueType(this.fileContent, glyphIds, this.missing.size > 0);
      } catch (error) {
        LOGGER.warning(`Unable to subset "${this.family}": ${(error as Error).message}`);
      }
    }
  }
}

export function buildFontsDictionary(pdf: PDF, fonts: Map<string, PdfFont>, compress: boolean, subset: boolean,
  pdfVersion: string | null = null): Dictionary {
  const pdfFonts = new Dictionary();
  const byFile = new Map<string, PdfFont[]>();
  for (const font of fonts.values()) {
    if (!byFile.has(font.hash)) byFile.set(font.hash, []);
    byFile.get(font.hash)!.push(font);
  }
  const referenceByFile = new Map<string, string>();
  for (const [fileHash, fileFonts] of byFile) {
    const font = fileFonts[0];
    if (font.bitmap) continue;
    // Clean font, optimize.
    if (subset && !font.usedInForms) {
      const gids = new Set<number>();
      for (const f of fileFonts) for (const gid of f.toUnicode.keys()) gids.add(gid);
      font.clean(gids);
    }
    const fontExtra = font.type === 'otf' ? new Dictionary({ Subtype: '/OpenType' }) : new Dictionary({ Length1: font.fileContent.length });
    const fontStream = new Stream([font.fileContent], fontExtra, compress);
    pdf.addObject(fontStream);
    referenceByFile.set(fileHash, fontStream.reference);
  }

  for (const font of fonts.values()) {
    let fontWidths: Map<number, number>;
    let toUnicode: Map<number, string>;
    if (subset && !font.usedInForms) {
      // Only store widths and map for used glyphs
      fontWidths = font.widths;
      toUnicode = font.toUnicode;
    } else {
      // Store width and Unicode map for all glyphs
      const fk = font.face.fk;
      fontWidths = new Map();
      toUnicode = new Map();
      for (let i = 0; i < fk.numGlyphs; i++) fontWidths.set(i, fk.getGlyph(i).advanceWidth * 1000 / font.upem);
      for (const cp of fk.characterSet as number[]) {
        const gid = fk.glyphForCodePoint(cp).id;
        if (!toUnicode.has(gid)) toUnicode.set(gid, String.fromCodePoint(cp));
      }
    }

    const toUnicodeObject = new Stream([
      '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CIDSystemInfo', '<< /Registry (Adobe)',
      '/Ordering (UCS)', '/Supplement 0', '>> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def',
      '1 begincodespacerange', '<0000> <ffff>', 'endcodespacerange'], {}, compress);
    const items = [...toUnicode.entries()];
    for (let i = 0; i < Math.ceil(items.length / 100); i++) {
      const batch = items.slice(i * 100, (i + 1) * 100);
      toUnicodeObject.stream.push(`${batch.length} beginbfchar`);
      for (const [glyph, text] of batch) {
        let hex = '';
        for (let k = 0; k < text.length; k++) hex += text.charCodeAt(k).toString(16).padStart(4, '0');
        toUnicodeObject.stream.push(`<${glyph.toString(16).padStart(4, '0')}> <${hex}>`);
      }
      toUnicodeObject.stream.push('endbfchar');
    }
    toUnicodeObject.stream.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end');
    pdf.addObject(toUnicodeObject);
    if (font.bitmap) {
      // Bitmap-only fonts are simple Type 3 fonts (upstream _build_bitmap_font_dictionary).
      const bitmapDictionary = new Dictionary({
        Type: '/Font', Subtype: '/Type3', BaseFont: font.name, ToUnicode: toUnicodeObject.reference,
      });
      buildBitmapFontDictionary(bitmapDictionary, pdf, font, fontWidths, compress, subset);
      pdf.addObject(bitmapDictionary);
      pdfFonts.set(font.hash, bitmapDictionary.reference);
      continue;
    }
    const fontDictionary = new Dictionary({
      Type: '/Font', Subtype: '/Type0', BaseFont: font.name, ToUnicode: toUnicodeObject.reference,
    });
    buildVectorFontDictionary(fontDictionary, pdf, font, fontWidths, compress, referenceByFile.get(font.hash) as string, pdfVersion);
    pdf.addObject(fontDictionary);
    pdfFonts.set(font.hash, fontDictionary.reference);
  }
  return pdfFonts;
}

function buildVectorFontDictionary(fontDictionary: Dictionary, pdf: PDF, font: PdfFont, widths: Map<number, number>,
  compress: boolean, reference: string, pdfVersion: string | null): void {
  const fontFile = `FontFile${font.type === 'otf' ? 3 : 2}`;
  const maxX = widths.size ? Math.max(...widths.values()) : 0;
  const bbox = [0, font.descent, maxX, font.ascent];
  let flags = font.flags;
  if (widths.size > 1 && new Set(font.widths.values()).size === 1) flags += 2 ** (1 - 1); // FixedPitch
  const fontDescriptor = new Dictionary({
    Type: '/FontDescriptor', FontName: font.name, FontFamily: new PdfString(font.family), Flags: flags,
    FontBBox: new PdfArray(bbox), ItalicAngle: font.italicAngle, Ascent: font.ascent, Descent: font.descent,
    CapHeight: bbox[3], StemV: font.stemv, StemH: font.stemh, [fontFile]: reference,
  });
  if (pdfVersion !== null && String(pdfVersion) <= '1.4') {
    const cids = [...font.widths.keys()].sort((a, b) => a - b);
    const padded = Math.ceil((cids[cids.length - 1] + 1) / 8);
    const bytes = new Uint8Array(padded);
    for (const cid of cids) bytes[cid >> 3] |= 0x80 >> (cid & 7);
    const stream = new Stream([bytes], {}, compress);
    pdf.addObject(stream);
    fontDescriptor.set('CIDSet', stream.reference);
  }
  pdf.addObject(fontDescriptor);

  const pdfWidths = new PdfArray();
  let current: PdfArray | null = null;
  for (const i of [...widths.keys()].sort((a, b) => a - b)) {
    if (!widths.has(i - 1)) {
      pdfWidths.push(i);
      current = new PdfArray();
      pdfWidths.push(current);
    }
    (current as PdfArray).push(widths.get(i));
  }
  const subfont = new Dictionary({
    Type: '/Font', Subtype: `/CIDFontType${font.type === 'otf' ? 0 : 2}`, BaseFont: font.name,
    CIDSystemInfo: new Dictionary({ Registry: new PdfString('Adobe'), Ordering: new PdfString('Identity'), Supplement: 0 }),
    CIDToGIDMap: '/Identity', W: pdfWidths, FontDescriptor: fontDescriptor.reference,
  });
  pdf.addObject(subfont);
  if (font.missing.size) {
    // Python: a custom /Encoding CMap that does NOT include the missing glyphs
    // (they map to glyph 0 = .notdef), so viewers draw the font's own notdef
    // outline instead of an out-of-range glyph id. IDs beyond the real glyph
    // ids were rejected by hb-subset, so glyph 0's outline is what remains.
    const cmapExtra = new Dictionary({
      Type: '/CMap', CMapName: '/WP-Encod-0',
      CIDSystemInfo: new Dictionary({ Registry: new PdfString('Adobe'), Ordering: new PdfString('Identity'), Supplement: 0 }),
    });
    const encoding = new Stream([
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo',
      '3 dict dup begin',
      '/Registry (Adobe) def',
      '/Ordering (Identity) def',
      '/Supplement 0 def',
      'end def',
      '/CMapName /WP-Encod-0 def',
      '/CMapType 1 def',
      '1 begincodespacerange',
      '<0000> <ffff>',
      'endcodespacerange',
    ], cmapExtra, compress);
    const available = [...font.toUnicode.keys()];
    const missingIds = new Set(font.missing.values());
    for (let i = 0; i < Math.ceil(available.length / 100); i++) {
      const batch = available.slice(i * 100, (i + 1) * 100);
      encoding.stream.push(`${batch.length} begincidchar`);
      for (const glyphId of batch) {
        const fontGlyphId = missingIds.has(glyphId) ? 0 : glyphId;
        encoding.stream.push(`<${glyphId.toString(16).padStart(4, '0')}> ${fontGlyphId}`);
      }
      encoding.stream.push('endcidchar');
    }
    encoding.stream.push(
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end',
    );
    pdf.addObject(encoding);
    fontDictionary.set('Encoding', encoding.reference);
  } else {
    fontDictionary.set('Encoding', '/Identity-H');
  }
  fontDictionary.set('DescendantFonts', new PdfArray([subfont.reference]));
}
/** Upstream _build_bitmap_font_dictionary: one Type 3 glyph (CharProcs) per bitmap glyph, widths in pixels. */
function buildBitmapFontDictionary(fontDictionary: Dictionary, pdf: PDF, font: PdfFont,
  fontWidths: Map<number, number>, compress: boolean, subset: boolean): void {
  fontDictionary.set('FontBBox', new PdfArray([0, 0, 1, 1]));
  fontDictionary.set('FontMatrix', new PdfArray([1, 0, 0, 1, 0, 0]));
  const chars: number[] = subset ? [...font.toUnicode.keys()].sort((a, b) => a - b) : Array.from({ length: 256 }, (_, i) => i);
  const first = chars[0];
  const last = chars[chars.length - 1];
  const differences: Array<number | string> = [];
  for (const glyph of [...fontWidths.keys()].sort((a, b) => a - b)) {
    if (!fontWidths.has(glyph - 1)) differences.push(glyph);
    differences.push(`/${glyph}`);
  }
  fontDictionary.set('FirstChar', first);
  fontDictionary.set('LastChar', last);
  fontDictionary.set('Encoding', new Dictionary({ Type: '/Encoding', Differences: new PdfArray(differences) }));
  const glyphs = readBitmapGlyphs(font.fileContent);
  const widths: number[] = new Array(last - first + 1).fill(0);
  const charProcs = new Dictionary({});
  for (const [glyphId, glyph] of glyphs) {
    if (!chars.includes(glyphId)) continue;
    widths[glyphId - first] = glyph.advance;
    const bitmap = glyph.bitmap ?? composeGlyph(glyph, glyphs) ?? new Uint8Array(glyph.height * glyph.stride);
    const bitmapStream = new Stream([
      '0 0 d0', `${glyph.width} 0 0 ${glyph.height} ${glyph.x} ${glyph.y} cm`, 'BI', '/IM true',
      '/W', glyph.width, '/H', glyph.height, '/BPC 1', '/D [1 0]', 'ID', bitmap, 'EI',
    ], {}, compress);
    pdf.addObject(bitmapStream);
    charProcs.set(String(glyphId), bitmapStream.reference);
  }
  pdf.addObject(charProcs);
  fontDictionary.set('Widths', new PdfArray(widths));
  fontDictionary.set('CharProcs', charProcs.reference);
}
