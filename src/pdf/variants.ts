// SPDX-License-Identifier: BSD-3-Clause

/**
 * PDF variants (mirrors weasyprint/pdf/pdfa.py and pdfx.py): the options a variant implies and the post-processing
 * it applies to the finished PDF. PDF/A variants whose conformance needs tagged content (PDF/A-1a, 2a, 3a and
 * PDF/UA) are not supported: this port has no tagging.
 */
import type { HtmlMetadata } from '../html.ts';
import { Dictionary, PDF, PdfArray, PdfString } from './pydyf.ts';
import { includeMetadataInPdf } from './metadata.ts';

export interface VariantDefaults {
  pdf_version: string;
  pdf_identifier?: boolean;
  output_intent?: string;
  pdf_tags?: boolean;
}

export interface VariantContext {
  pdf: PDF;
  meta: HtmlMetadata;
  compress: boolean;
  /** Every file specification written (metadata, options and link attachments), with its MIME subtype. */
  specs: Array<{ spec: Dictionary; subtype: string }>;
}

interface PdfAVariant {
  version: 1 | 2 | 3 | 4;
  variant: 'A' | 'B' | 'U' | 'E' | 'F';
  defaults: VariantDefaults;
}

const PDFA_1_4 = { pdf_version: '1.4', pdf_identifier: true, output_intent: 'srgb' };
const PDFA_1_7 = { pdf_version: '1.7', pdf_identifier: true, output_intent: 'srgb' };
const PDFA_2_0 = { pdf_version: '2.0', pdf_identifier: true, output_intent: 'srgb' };

/** Variants this port implements (name as the CLI and API spell it). */
export const PDFA_VARIANTS: Record<string, PdfAVariant> = {
  'pdf/a-1b': { version: 1, variant: 'B', defaults: PDFA_1_4 },
  'pdf/a-2b': { version: 2, variant: 'B', defaults: PDFA_1_7 },
  'pdf/a-3b': { version: 3, variant: 'B', defaults: PDFA_1_7 },
  'pdf/a-2u': { version: 2, variant: 'U', defaults: PDFA_1_7 },
  'pdf/a-3u': { version: 3, variant: 'U', defaults: PDFA_1_7 },
  'pdf/a-4u': { version: 4, variant: 'U', defaults: PDFA_2_0 },
  'pdf/a-4e': { version: 4, variant: 'E', defaults: PDFA_2_0 },
  'pdf/a-4f': { version: 4, variant: 'F', defaults: PDFA_2_0 },
  // The tagged variants (pdf_tags on): the structure tree is written by tags.ts.
  'pdf/a-1a': { version: 1, variant: 'A', defaults: { ...PDFA_1_4, pdf_tags: true } },
  'pdf/a-2a': { version: 2, variant: 'A', defaults: { ...PDFA_1_7, pdf_tags: true } },
  'pdf/a-3a': { version: 3, variant: 'A', defaults: { ...PDFA_1_7, pdf_tags: true } },
};

interface PdfUaVariant {
  version: 1 | 2;
  defaults: VariantDefaults;
}

export const PDFUA_VARIANTS: Record<string, PdfUaVariant> = {
  'pdf/ua-1': { version: 1, defaults: { pdf_version: '1.7', pdf_tags: true } },
  'pdf/ua-2': { version: 2, defaults: { pdf_version: '2.0', pdf_tags: true } },
};

/** Python: pdfua(pdf, document, page_streams, attachments, compress, version). */
export function applyPdfUa(ctx: VariantContext, name: string): void {
  const { version } = PDFUA_VARIANTS[name];
  // The conformance is named from PDF/UA-2 on; PDF/UA-1 declares only its part.
  const conformance = version >= 2 ? `PDF/UA-${version}` : null;
  includeMetadataInPdf(ctx.pdf, ctx.meta, 'ua', version, conformance, ctx.compress);
}

interface PdfXVariant {
  version: 1 | 3 | 4 | 5;
  /** The conformance suffix, e.g. 'a:2003' for PDF/X-1a:2003 (upstream pdfx.VARIANTS). */
  variant: string;
  defaults: VariantDefaults;
}

const PDFX_DEFAULTS = { pdf_identifier: true, output_intent: 'device-cmyk' };

export const PDFX_VARIANTS: Record<string, PdfXVariant> = {
  'pdf/x-1a': { version: 1, variant: 'a:2003', defaults: { pdf_version: '1.4', ...PDFX_DEFAULTS } },
  'pdf/x-3': { version: 3, variant: ':2003', defaults: { pdf_version: '1.4', ...PDFX_DEFAULTS } },
  'pdf/x-4': { version: 4, variant: '', defaults: { pdf_version: '1.6', ...PDFX_DEFAULTS } },
  'pdf/x-5g': { version: 5, variant: 'g', defaults: { pdf_version: '1.6', ...PDFX_DEFAULTS } },
};

/** The variants with options to apply, by name. */
export function variantDefaults(name: string): VariantDefaults | null {
  return PDFA_VARIANTS[name]?.defaults ?? PDFX_VARIANTS[name]?.defaults ?? PDFUA_VARIANTS[name]?.defaults ?? null;
}

/** Python: pdfx.localtime-based ISO and PDF dates (the local time zone, as upstream). */
function localDates(): { iso: string; pdf: string } {
  const now = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const offset = -now.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hh = p(Math.trunc(Math.abs(offset) / 60));
  const mm = p(Math.abs(offset) % 60);
  const iso = `${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}${sign}${hh}:${mm}`;
  const pdf = `D:${p(now.getFullYear(), 4)}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${sign}${hh}'${mm}'`;
  return { iso, pdf };
}

/** Python: pdfx(pdf, document, page_streams, attachments, compress, version, variant). */
export function applyPdfX(ctx: VariantContext, name: string): void {
  const { version, variant } = PDFX_VARIANTS[name];
  const { pdf, meta } = ctx;
  const conformance = `PDF/X-${version}${variant}`;

  // Add conformance metadata (the info entries are for PDF/X below version 4).
  if (version < 4) {
    pdf.info.set('GTS_PDFXVersion', new PdfString(conformance));
    pdf.info.set('GTS_PDFXConformance', new PdfString(conformance));
  }
  pdf.info.set('Trapped', '/False');
  const now = localDates();
  if (!meta.modified) {
    meta.modified = now.iso;
    pdf.info.set('ModDate', new PdfString(now.pdf));
  }
  if (!meta.created) {
    meta.created = now.iso;
    pdf.info.set('CreationDate', new PdfString(now.pdf));
  }

  // Common PDF metadata stream.
  const compress = version >= 4 ? false : ctx.compress;
  includeMetadataInPdf(pdf, meta, 'x', version, conformance, compress);
}

/** The object a reference value ('N G R') points to, or the value itself. */
function resolve(pdf: PDF, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = /^(\d+) \d+ R$/.exec(value);
  if (!match) return value;
  return pdf.objects.find((object) => object.reference === value) ?? undefined;
}

/** Python: pdfa(pdf, document, page_streams, attachments, compress, version, variant). */
export function applyPdfA(ctx: VariantContext, name: string): void {
  const { version, variant } = PDFA_VARIANTS[name];
  const { pdf } = ctx;
  let compress = ctx.compress;

  // Attachments.
  if (version === 1) {
    // Remove the embedded files dictionary.
    const names = pdf.catalog.get('Names') as Dictionary | undefined;
    if (names && names.has('EmbeddedFiles')) names.delete('EmbeddedFiles');
  }
  if (version <= 2) {
    // Remove all attachments for version 1, the non-PDF ones for version 2.
    for (const { spec, subtype } of ctx.specs) {
      if (version === 1 || subtype !== '/application#2fpdf') spec.delete('EF');
    }
  }
  if (version >= 3) {
    // Add AF for attachments: the embedded files of the name tree, then every file specification.
    const attachments: unknown[] = [];
    const names = pdf.catalog.get('Names') as Dictionary | undefined;
    const embedded = resolve(pdf, names?.get('EmbeddedFiles')) as Dictionary | undefined;
    const tree = embedded?.get('Names') as PdfArray | undefined;
    if (tree) for (let i = 1; i < tree.items.length; i += 2) attachments.push(tree.items[i]);
    // Upstream looks the relationship up by checksum, so identical files share the last one given.
    const relationships = new Map<string, string>();
    for (const { spec } of ctx.specs) {
      const s = spec as Dictionary & { checksum?: string; relationship?: string };
      if (s.checksum) relationships.set(s.checksum, s.relationship ?? 'Unspecified');
    }
    for (const { spec } of ctx.specs) {
      const s = spec as Dictionary & { checksum?: string };
      spec.set('AFRelationship', `/${(s.checksum && relationships.get(s.checksum)) || 'Unspecified'}`);
      attachments.push(spec.reference);
    }
    if (attachments.length) {
      if (!pdf.catalog.has('AF')) pdf.catalog.set('AF', new PdfArray([]));
      for (const item of attachments) (pdf.catalog.get('AF') as PdfArray).push(item as any);
    }
  }

  // Print annotations.
  for (const object of pdf.objects) {
    if (object instanceof Dictionary && object.get('Type') === '/Annot') object.set('F', 2 ** (3 - 1));
  }

  // Common PDF metadata stream: metadata compression is forbidden for version 1.
  if (version === 1) compress = false;
  includeMetadataInPdf(pdf, ctx.meta, 'a', version, variant, compress);

  // Remove document information.
  if (version >= 4) pdf.info.values.clear();
}
