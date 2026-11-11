// SPDX-License-Identifier: BSD-3-Clause

/** PDF generation management (mirrors weasyprint/pdf/__init__.py; variants, tags, forms and attachments are not ported yet). */
import { addForms } from './forms.ts';
import { LOGGER } from '../logger.ts';
import { Matrix } from '../matrix.ts';
import { addLinks, addOutlines, resolveLinks } from './anchors.ts';
import { buildFontsDictionary } from './fonts.ts';
import type { PdfFont } from './fonts.ts';
import { Dictionary, PDF, PdfArray, PdfString, Stream } from './pydyf.ts';
import { writeAttachment } from './attachments.ts';
import { SRGB2014_ICC } from './srgb_profile.ts';
import { PDFA_VARIANTS, PDFUA_VARIANTS, PDFX_VARIANTS, applyPdfA, applyPdfUa, applyPdfX } from './variants.ts';
import { addTags } from './tags.ts';
import type { FetchedAttachment } from './attachments.ts';
import { PdfStream } from './stream.ts';
import type { ImageEntry } from './stream.ts';

export interface PdfOptions {
  uncompressedPdf?: boolean;
  fullFonts?: boolean;
  pdfVersion?: string | null;
  pdfTags?: boolean;
  producer?: string;
  /** Trailer /ID (Python: pdf_identifier; True generates it from the data). */
  pdfIdentifier?: string | true | null;
  /** PDF variant, e.g. 'pdf/a-2b' (Python: pdf_variant). */
  pdfVariant?: string | null;
  /** Output intent: 'srgb', 'device-cmyk' or the name of a @color-profile (Python: output_intent). */
  outputIntent?: string | null;
  /** Python: custom_metadata, the <meta name=... content=...> pairs in the Info dictionary. */
  customMetadata?: boolean;
  /** Contents of --xmp-metadata files (fetched by the caller); only used by PDF variants, as upstream. */
  xmpMetadata?: string[];
  /** Attachments given to write_pdf (Python: options['attachments']), fetched by the caller. */
  attachments?: FetchedAttachment[];
}

export const VERSION = '70.0';

const W3C_DATE_RE = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:Z|([+-]\d{2}):(\d{2}))?)?)?)?$/;

/** Transform W3C date to PDF format. */
export function w3cDateToPdf(string: string | null, attrName: string): string | null {
  if (string === null) return null;
  const m = W3C_DATE_RE.exec(string.trim());
  if (!m) {
    LOGGER.warning(`Invalid ${attrName} date: ${JSON.stringify(string)}`);
    return null;
  }
  const [, year, month, day, hour, minute, second, tzHour, tzMinute] = m;
  let out = `${year}${month ?? '01'}${day ?? '01'}`;
  if (hour) {
    out += `${hour}${minute}${second ?? '00'}`;
    if (tzHour) out += `${tzHour}'${tzMinute}`;
    else out += 'Z';
  }
  return `D:${out}`;
}

function referenceResources(pdf: PDF, resources: Dictionary, images: Map<string, ImageEntry>, fonts: PdfValueRef): string {
  if (resources.has('Font')) resources.set('Font', fonts);
  useReferences(pdf, resources, images);
  pdf.addObject(resources);
  return resources.reference;
}
type PdfValueRef = any;

function useReferences(pdf: PDF, resources: Dictionary, images: Map<string, ImageEntry>): void {
  const xObjects = resources.get('XObject') as Dictionary | undefined;
  // XObjects
  if (xObjects) {
    for (const [key, value] of [...xObjects.entries()]) {
      let xObject: any = value;
      // Images
      if (xObject === null || xObject === undefined) {
        const imageData = images.get(key) as ImageEntry;
        xObject = imageData.xObject;
        if (xObject !== null) {
          // Image already added to PDF
          xObjects.set(key, xObject.reference);
          continue;
        }
        const image = imageData.image;
        const dpiRatio = Math.max(...imageData.dpiRatios);
        xObject = image.getXObject(imageData.interpolate, dpiRatio);
        imageData.xObject = xObject;
      }

      pdf.addObject(xObject);
      xObjects.set(key, xObject.reference);

      // Masks
      if (xObject.extra.has('SMask')) {
        pdf.addObject(xObject.extra.get('SMask'));
        xObject.extra.set('SMask', xObject.extra.get('SMask').reference);
      }

      // Resources
      if (xObject.extra.has('Resources')) {
        xObject.extra.set('Resources', referenceResources(pdf, xObject.extra.get('Resources'), images, resources.get('Font')));
      }
    }
  }

  // Patterns
  const patterns = resources.get('Pattern') as Dictionary | undefined;
  if (patterns) {
    for (const [key, pattern] of [...patterns.entries()] as Array<[string, any]>) {
      pdf.addObject(pattern);
      patterns.set(key, pattern.reference);
      if (pattern.extra.has('Resources')) {
        pattern.extra.set('Resources', referenceResources(pdf, pattern.extra.get('Resources'), images, resources.get('Font')));
      }
    }
  }

  // Shadings
  const shadings = resources.get('Shading') as Dictionary | undefined;
  if (shadings) {
    for (const [key, shading] of [...shadings.entries()] as Array<[string, any]>) {
      pdf.addObject(shading);
      shadings.set(key, shading.reference);
    }
  }

  // Alpha states
  const states = resources.get('ExtGState') as Dictionary | undefined;
  if (states) {
    for (const [, alpha] of states.entries() as IterableIterator<[string, any]>) {
      const smask = alpha.get('SMask');
      if (smask && smask.has('G')) smask.set('G', smask.get('G').reference);
    }
  }
}

export interface PdfDocumentLike {
  pages: Array<{
    width: number; height: number; bleed: Record<string, number>; links: any[]; anchors: Map<string, number[]>; forms?: Map<any, any>;
    paint(stream: PdfStream, scale: number): void;
  }>;
  fonts: Map<string, PdfFont>;
  metadata: Record<string, any>;
  makeBookmarkTree(scale: number, transformPages: boolean): any[];
  colorProfiles?: Map<string, { name: string; content: Uint8Array; components: string[] | null }>;
  attachmentBodies?: Map<string, { body: Uint8Array; mimeType: string | null }>;
}

export function generatePdf(document: PdfDocumentLike, zoom: number, options: PdfOptions = {}): PDF {
  // 0.75 = 72 PDF point per inch / 96 CSS pixel per inch
  const scale = zoom * 0.75;
  const compress = !options.uncompressedPdf;
  const pdfTags = options.pdfTags ?? false;

  const pdf = new PDF();
  const images = new Map<string, ImageEntry>();
  const colorSpace = new Dictionary({
    'lab-d50': new PdfArray(['/Lab', new Dictionary({
      WhitePoint: new PdfArray([0.9642956764295677, 1, 0.8251046025104602]), Range: new PdfArray([-125, 125, -125, 125]),
    })]),
    'lab-d65': new PdfArray(['/Lab', new Dictionary({
      WhitePoint: new PdfArray([0.9504559270516716, 1, 1.0890577507598784]), Range: new PdfArray([-125, 125, -125, 125]),
    })]),
  });
  // Custom color profiles. Output intent 'srgb' adds upstream's sRGB2014 profile.
  const profiles = new Map(document.colorProfiles ?? []);
  if (options.outputIntent === 'srgb') {
    profiles.set('srgb', { name: '', content: SRGB2014_ICC, components: ['r', 'g', 'b'] } as any);
  }
  const colorProfiles: Record<string, { name: string; pdfReference: string }> = {};
  for (const [key, profile] of profiles) {
    const components = profile.components?.length ?? ICC_COMPONENTS[iccColorSpace(profile.content)] ?? 3;
    const stream = new Stream([profile.content], new Dictionary({ N: components }), compress);
    pdf.addObject(stream);
    colorProfiles[key] = { name: iccName(profile.content), pdfReference: stream.reference };
    colorSpace.set(key, new PdfArray(['/ICCBased', stream.reference]));
  }
  pdf.addObject(colorSpace);
  const resources = new Dictionary({
    ExtGState: new Dictionary(), XObject: new Dictionary(), Pattern: new Dictionary(), Shading: new Dictionary(),
    ColorSpace: colorSpace.reference,
  });
  pdf.addObject(resources);
  const pdfNames: Array<[string, PdfArray]> = [];
  // Attachments: <link rel=attachment> of the metadata and the attachment links (one file per URL, as upstream's
  // annot_files), written before the pages so the link annotations can refer to them.
  const attachmentFiles = new Map<string, Dictionary | null>();
  const embeddedFiles: Array<[PdfString, Dictionary]> = [];
  for (const attachment of (document.metadata as any).attachments ?? []) {
    const fetched = document.attachmentBodies?.get(attachment.url);
    if (!fetched) continue;
    const spec = writeAttachment(pdf, {
      url: attachment.url, body: fetched.body, mimeType: fetched.mimeType, name: null, description: attachment.description ?? null,
    }, compress);
    embeddedFiles.push([spec.get('F') as PdfString, spec]);
  }
  for (const attachment of options.attachments ?? []) {
    const spec = writeAttachment(pdf, attachment, compress);
    embeddedFiles.push([spec.get('F') as PdfString, spec]);
  }

  // Links and anchors
  const pageLinksAndAnchors = resolveLinks(document.pages);

  const pdfPages: Dictionary[] = [];
  const pageStreams: PdfStream[] = [];
  document.pages.forEach((page, pageNumber) => {
    const linksAndAnchors = pageLinksAndAnchors[pageNumber];
    const tags = pdfTags ? new Map() : null;

    // Draw from the top-left corner
    const matrix = new Matrix(scale, 0, 0, -scale, 0, page.height * scale);

    const pageWidth = scale * (page.width + page.bleed.left + page.bleed.right);
    const pageHeight = scale * (page.height + page.bleed.top + page.bleed.bottom);
    const left = -scale * page.bleed.left;
    const top = -scale * page.bleed.top;
    const right = left + pageWidth;
    const bottom = top + pageHeight;

    const pageRectangle: [number, number, number, number] = [left / scale, top / scale, (right - left) / scale, (bottom - top) / scale];
    const stream = new PdfStream(document.fonts, pageRectangle, resources, images, tags, colorProfiles, null, [], {}, compress);
    stream.transform(1, 0, 0, -1, 0, page.height * scale);
    pdf.addObject(stream);
    pageStreams.push(stream);

    const pdfPage = new Dictionary({
      Type: '/Page', Parent: pdf.pages.reference, MediaBox: new PdfArray([left, top, right, bottom]),
      Contents: stream.reference, Resources: resources.reference,
    });
    if (pdfTags) {
      pdfPage.set('Tabs', '/S');
      pdfPage.set('StructParents', pageNumber);
    }
    pdf.addPage(pdfPage);
    pdfPages.push(pdfPage);

    addLinks(linksAndAnchors, matrix, pdf, pdfPage, pdfNames, tags, { bodies: document.attachmentBodies ?? new Map(), files: attachmentFiles, compress });
    addForms(page.forms as any, matrix, pdf, pdfPage, resources, stream);
    page.paint(stream, scale);

    // Bleed
    const bleed: Record<string, number> = {};
    for (const [key, value] of Object.entries(page.bleed)) bleed[key] = value * 0.75;

    const trimLeft = left + bleed.left;
    const trimTop = top + bleed.top;
    const trimRight = right - bleed.right;
    const trimBottom = bottom - bleed.bottom;

    // Arbitrarly set PDF BleedBox between CSS bleed box (MediaBox) and CSS page box (TrimBox) at most 10 points from the TrimBox.
    const bleedLeft = trimLeft - Math.min(10, bleed.left);
    const bleedTop = trimTop - Math.min(10, bleed.top);
    const bleedRight = trimRight + Math.min(10, bleed.right);
    const bleedBottom = trimBottom + Math.min(10, bleed.bottom);

    pdfPage.set('TrimBox', new PdfArray([trimLeft, trimTop, trimRight, trimBottom]));
    pdfPage.set('BleedBox', new PdfArray([bleedLeft, bleedTop, bleedRight, bleedBottom]));
  });

  // Outlines
  addOutlines(pdf, document.makeBookmarkTree(scale, true));

  // PDF information
  pdf.info.set('Producer', new PdfString(options.producer ?? `WeasyPrint ${VERSION}`));
  // Python: custom_metadata writes the <meta name=... content=...> pairs, keys reduced to ASCII letters and digits.
  if (options.xmpMetadata?.length) (document.metadata as any).xmpMetadata = options.xmpMetadata;
  if (options.customMetadata) {
    for (const [key, value] of Object.entries((document.metadata as any).custom ?? {})) {
      const cleaned = key.replace(/[^A-Za-z0-9]/g, '');
      if (cleaned) pdf.info.set(cleaned, new PdfString(String(value)));
    }
  }
  const metadata = document.metadata;
  if (metadata.title) pdf.info.set('Title', new PdfString(metadata.title));
  if (metadata.authors?.length) pdf.info.set('Author', new PdfString(metadata.authors.join(', ')));
  if (metadata.description) pdf.info.set('Subject', new PdfString(metadata.description));
  if (metadata.keywords?.length) pdf.info.set('Keywords', new PdfString(metadata.keywords.join(', ')));
  if (metadata.generator) pdf.info.set('Creator', new PdfString(metadata.generator));
  if (metadata.created) {
    const date = w3cDateToPdf(metadata.created, 'created');
    if (date) pdf.info.set('CreationDate', new PdfString(date));
  }
  if (metadata.modified) {
    const date = w3cDateToPdf(metadata.modified, 'modified');
    if (date) pdf.info.set('ModDate', new PdfString(date));
  }
  // Output intents: the requested profile, else device-cmyk, else the first one (upstream pdf/__init__.py).
  const outputIntent = options.outputIntent ?? null;
  const intentProfile = (outputIntent !== null && colorProfiles[outputIntent]) || colorProfiles['device-cmyk']
    || Object.values(colorProfiles)[0];
  if (intentProfile) {
    const subtype = options.pdfVariant && options.pdfVariant.includes('pdf/a') ? '/GTS_PDFA1' : '/GTS_PDFX';
    pdf.catalog.set('OutputIntents', new PdfArray([new Dictionary({
      Type: '/OutputIntent', S: subtype, OutputConditionIdentifier: new PdfString(intentProfile.name),
      Info: new PdfString(intentProfile.name), DestOutputProfile: intentProfile.pdfReference,
    })]));
  }
  if (metadata.lang) pdf.catalog.set('Lang', new PdfString(metadata.lang));

  // Embedded fonts
  const subset = !options.fullFonts;
  const pdfFonts = buildFontsDictionary(pdf, document.fonts, compress, subset, options.pdfVersion ?? null);
  pdf.addObject(pdfFonts);
  resources.set('Font', pdfFonts.reference);
  useReferences(pdf, resources, images);

  // Anchors
  if (embeddedFiles.length) {
    const names = new PdfArray([]);
    for (const [filename, spec] of embeddedFiles) {
      names.push(filename);
      names.push(spec.reference);
    }
    const embedded = new Dictionary({ Names: names });
    pdf.addObject(embedded);
    if (!pdf.catalog.has('Names')) pdf.catalog.set('Names', new Dictionary());
    (pdf.catalog.get('Names') as Dictionary).set('EmbeddedFiles', embedded.reference);
  }
  if (pdfNames.length) {
    // Anchors are name trees that have to be sorted
    const nameArray = new PdfArray();
    for (const [anchorName, destination] of [...pdfNames].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      nameArray.push(new PdfString(anchorName), destination);
    }
    const dests = new Dictionary({ Names: nameArray });
    if (!pdf.catalog.has('Names')) pdf.catalog.set('Names', new Dictionary());
    (pdf.catalog.get('Names') as Dictionary).set('Dests', dests);
  }

  // Tags (upstream: add_tags, before the output intents).
  if (pdfTags) addTags(pdf, document.pages as any, options.pdfVersion ?? null, pageStreams as any);

  // PDF variant post-processing (upstream: variant_function, applied after the output intents).
  if (options.pdfVariant && options.pdfVariant in PDFA_VARIANTS) {
    const specs: Array<{ spec: Dictionary; subtype: string }> = [];
    const seen = new Set<Dictionary>();
    const collect = (spec: Dictionary): void => {
      if (seen.has(spec)) return;
      seen.add(spec);
      specs.push({ spec, subtype: (spec as Dictionary & { subtype?: string }).subtype ?? '/application#2fpdf' });
    };
    for (const [, spec] of embeddedFiles) collect(spec);
    for (const spec of attachmentFiles.values()) if (spec) collect(spec);
    applyPdfA({ pdf, meta: document.metadata as any, compress, specs }, options.pdfVariant);
  } else if (options.pdfVariant && options.pdfVariant in PDFUA_VARIANTS) {
    applyPdfUa({ pdf, meta: document.metadata as any, compress, specs: [] }, options.pdfVariant);
  } else if (options.pdfVariant && options.pdfVariant in PDFX_VARIANTS) {
    applyPdfX({ pdf, meta: document.metadata as any, compress, specs: [] }, options.pdfVariant);
  } else if (options.pdfVariant) {
    LOGGER.warning(`PDF variant '${options.pdfVariant}' is not supported yet, the PDF is written without it`);
  }
  return pdf;
}
const ICC_COMPONENTS: Record<string, number> = { 'GRAY': 1, 'RGB ': 3, 'CMYK': 4, 'Lab ': 3 };

/** ICC header data colour space signature (bytes 16-20). */
function iccColorSpace(icc: Uint8Array): string {
  return String.fromCharCode(...icc.subarray(16, 20));
}

/** Python: ColorProfile.name, the profile's model ('dmdd') or else its description ('desc'), as LittleCMS reads them. */
function iccName(icc: Uint8Array): string {
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const text = (signature: string): string => {
    const count = view.getUint32(128);
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      if (String.fromCharCode(...icc.subarray(entry, entry + 4)) !== signature) continue;
      const offset = view.getUint32(entry + 4);
      const type = String.fromCharCode(...icc.subarray(offset, offset + 4));
      if (type === 'desc') {
        const length = view.getUint32(offset + 8);
        return String.fromCharCode(...icc.subarray(offset + 12, offset + 12 + length)).replace(/\0+$/, '');
      }
      if (type === 'mluc' || type === 'mlu ') {
        const records = view.getUint32(offset + 8);
        if (!records) return '';
        const length = view.getUint32(offset + 20);
        const start = offset + view.getUint32(offset + 24);
        let out = '';
        for (let k = 0; k + 1 < length; k += 2) out += String.fromCharCode(view.getUint16(start + k));
        return out.replace(/\0+$/, '');
      }
    }
    return '';
  };
  try {
    return text('dmdd') || text('desc');
  } catch {
    return '';
  }
}
