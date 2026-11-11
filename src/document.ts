// SPDX-License-Identifier: BSD-3-Clause

/** Document generation management (mirrors weasyprint/document.py). */
import { gatherAnchors, makePageBookmarkTree } from './anchors.ts';
import type { Bookmark, Link } from './anchors.ts';
import { CSS } from './css/index.ts';
import { TargetCollector } from './css/targets.ts';
import { drawPage } from './draw/index.ts';
import { buildFormattingStructure } from './formatting_structure/build.ts';
import { HTML, getAllComputedStyles } from './html_document.ts';
import { getHtmlMetadata } from './html.ts';
import type { HtmlMetadata } from './html.ts';
import { ImageLoader } from './images.ts';
import { LOGGER } from './logger.ts';
import { LayoutContext, layoutDocument } from './layout/index.ts';
import { Matrix } from './matrix.ts';
import { generatePdf } from './pdf/index.ts';
import { variantDefaults } from './pdf/variants.ts';
import type { PdfOptions } from './pdf/index.ts';
import type { FetchedAttachment, Attachment } from './pdf/attachments.ts';
import type { PdfFont } from './pdf/fonts.ts';
import type { PdfStream } from './pdf/stream.ts';
import { FontConfiguration } from './text/font_config.ts';

type AnyBox = any;

/** A single rendered page. */
export class Page {
  /** The page width, including margins, in CSS pixels. */
  width: number;
  /** The page height, including margins, in CSS pixels. */
  height: number;
  /** The page bleed widths in CSS pixels. */
  bleed: Record<string, number>;
  bookmarks: Bookmark[] = [];
  links: Link[] = [];
  anchors = new Map<string, [number, number, number, number]>();
  forms = new Map<AnyBox, Array<[AnyBox, number[]]>>([[null, []]]);
  pageBox: AnyBox;

  constructor(pageBox: AnyBox) {
    this.width = pageBox.marginWidth();
    this.height = pageBox.marginHeight();
    this.bleed = {};
    for (const side of ['top', 'right', 'bottom', 'left']) this.bleed[side] = pageBox.style.get(`bleed_${side}`).value;
    gatherAnchors(pageBox, this.anchors, this.links, this.bookmarks, this.forms);
    this.pageBox = pageBox;
  }

  /** Paint the page into the PDF file. */
  paint(stream: PdfStream, scale = 1): void {
    stream.stacked(() => {
      stream.transform(scale, 0, 0, scale);
      drawPage(this.pageBox, stream);
    });
  }
}

export class Document {
  pages: Page[];
  metadata: HtmlMetadata | Record<string, any>;
  fonts = new Map<string, PdfFont>();
  fontConfig: FontConfiguration;
  /** @color-profile ICC profiles by name (Python: Document.color_profiles). */
  colorProfiles = new Map<string, { name: string; content: Uint8Array; components: string[] | null; renderingIntent: string }>();
  /** Fetched attachment bodies by URL (Python: fetched when the PDF is written). */
  attachmentBodies = new Map<string, { body: Uint8Array; mimeType: string | null }>();

  constructor(pages: Page[], metadata: HtmlMetadata | Record<string, any>, fontConfig: FontConfiguration) {
    this.pages = pages;
    this.metadata = metadata;
    this.fontConfig = fontConfig;
  }

  /** Make a tree of all bookmarks in the document. */
  makeBookmarkTree(scale = 1, transformPages = false): any[] {
    const root: any[] = [];
    // At one point in the document, for each "output" depth, how much to add to get the source level.
    const skippedLevels: number[] = [];
    const lastByDepth: any[][] = [root];
    let previousLevel = 0;
    this.pages.forEach((page, pageNumber) => {
      const matrix = transformPages ? new Matrix(scale, 0, 0, -scale, 0, page.height * scale) : new Matrix(scale, 0, 0, scale);
      previousLevel = makePageBookmarkTree(page, skippedLevels, lastByDepth, previousLevel, pageNumber, matrix);
    });
    return root;
  }

  /** Paint the pages in a PDF file, with metadata. */
  writePdf(options: PdfOptions & { zoom?: number } = {}): Uint8Array {
    // Python: a PDF variant fills the options the caller left unset (document.py write_pdf).
    const defaults = options.pdfVariant ? variantDefaults(options.pdfVariant) : null;
    const resolved: PdfOptions & { zoom?: number } = {
      ...options,
      pdfVersion: options.pdfVersion ?? defaults?.pdf_version ?? null,
      pdfIdentifier: options.pdfIdentifier ?? (defaults?.pdf_identifier ? true : null),
      outputIntent: options.outputIntent ?? defaults?.output_intent ?? null,
      // A boolean the caller left off (false) takes the variant's value, as upstream's None check does.
      pdfTags: options.pdfTags || (defaults?.pdf_tags ?? false),
    };
    const pdf = generatePdf(this, resolved.zoom ?? 1, resolved);
    return pdf.write(resolved.pdfVersion ?? '1.7', !resolved.uncompressedPdf, resolved.pdfIdentifier ?? null);
  }

  /** Take a subset of pages (Python: Document.copy), e.g. `document.copy('all')`,
   *  `document.copy([pages[0], pages[2]])` or pages gathered from several
   *  documents to combine PDFs. Metadata stays the ORIGINAL document's, as upstream. */
  copy(pages: 'all' | Iterable<Page> = 'all'): Document {
    // Python passes self.pages itself for 'all' (the same list object).
    const list = pages === 'all' ? this.pages : [...pages];
    const copied = new Document(list, this.metadata, this.fontConfig);
    copied.colorProfiles = this.colorProfiles;
    copied.attachmentBodies = this.attachmentBodies;
    return copied;
  }
}

/** Default values of the write/render options (Python: DEFAULT_OPTIONS). Port uses the same keys in camelCase. */
export const DEFAULT_OPTIONS = {
  stylesheets: null,
  attachments: null,
  attachmentRelationships: null,
  pdfIdentifier: null,
  pdfVariant: null,
  pdfVersion: null,
  pdfForms: null,
  pdfTags: false,
  uncompressedPdf: false,
  xmpMetadata: null,
  customMetadata: false,
  presentationalHints: false,
  outputIntent: null,
  optimizeImages: false,
  jpegQuality: null,
  dpi: null,
  fullFonts: false,
  hinting: false,
  cache: null,
} as const;

/** Every valid option key of HTML.render/writePdf (defaults + render-only additions). */
export const ALLOWED_OPTIONS = new Set([
  ...Object.keys(DEFAULT_OPTIONS), 'fontConfig', 'fetch', 'zoom', 'userAgentCss', 'userAgentBaseUrl', 'encoding', 'writeFile',
]);

/** Warn on unknown option keys, exactly like upstream's render/write_pdf (weasyprint/__init__.py). */
export function checkUnknownOptions(options: object): void {
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) LOGGER.error(`Unknown rendering option: ${key}.`);
  }
}

export interface RenderOptions {
  /** Font configuration (@font-face handling + families). Defaults to an empty one. */
  fontConfig?: FontConfiguration;
  /** Attachments for the PDF (Python: write_pdf's attachments option). Attachment instances
   *  are fetched by HTML.writePdf; FetchedAttachment instances must already carry their bytes. */
  attachments?: Array<Attachment | FetchedAttachment>;
  /** JPEG quality for re-saved images (CLI --jpeg-quality). */
  jpegQuality?: number;
  /** Re-save JPEG images (CLI --optimize-images). */
  optimizeImages?: boolean;
  /** Maximum image resolution in the PDF (CLI --dpi). */
  dpi?: number;
  /** Include PDF forms (CLI --pdf-forms). */
  pdfForms?: boolean;
  stylesheets?: CSS[];
  /** Replace the built-in user-agent stylesheet (harness use: upstream's tests_ua.css). */
  userAgentCss?: string;
  userAgentBaseUrl?: string | null;
  presentationalHints?: boolean;
  /** Called to fetch images the synchronous layout asked for. */
  fetch?: (url: string) => Promise<{ body: Uint8Array; mimeType?: string | null } | null>;
}

/** Render an HTML document to pages (lays out repeatedly until every image has been fetched). */
export async function renderDocument(html: HTML, options: RenderOptions): Promise<Document> {
  // Fonts are optional: without a configuration the port renders with no
  // faces — mirroring upstream's no-fonts behavior (a warning + notdef
  // rectangles). Wire real fonts via weasyprint-ts/node's
  // createFontConfiguration(defaultFontDirs()).
  const fontConfig = options.fontConfig ?? new FontConfiguration();
  const styleFor = await getAllComputedStyles(html, { userStylesheets: options.stylesheets ?? [], userAgentCss: options.userAgentCss, userAgentBaseUrl: options.userAgentBaseUrl, presentationalHints: options.presentationalHints ?? false, pdfForms: options.pdfForms ?? false, fontConfig });
  const loader = new ImageLoader(options.jpegQuality ?? null, options.optimizeImages ?? false, options.dpi ?? null);
  // Python: get_image_from_uri reports a failed fetch through "Failed to load image at %r", so a fetch
  // error has to reach the loader instead of being turned into a silent null here.
  const fetchUrl = options.fetch ?? (async (url: string) => {
    try {
      return await html.fetcher.fetch(url);
    } catch (error) {
      // Python urls.fetch: url_fetcher.fail_on_errors turns a fetch failure
      // into a FatalURLFetchingError that aborts the rendering mid-flight;
      // without it the failure is logged and the resource is skipped.
      if ((html.fetcher as { fatalError?: Error | null }).fatalError) throw error;
      LOGGER.error(`Failed to load image at '${url}': ${(error as Error).message}`);
      return null;
    }
  });
  for (;;) {
    const targetCollector = styleFor.targetCollector;
    targetCollector.reset();
    const footnotes: any[] = [];
    const rootBox = buildFormattingStructure(
      html.root, (el, pseudo = null) => (styleFor.has(el, pseudo) ? styleFor.get(el, pseudo) : null), loader.getImageFromUri,
      html.baseUrl, targetCollector, html.counterStyle, footnotes);
    const context = new LayoutContext(styleFor, loader.getImageFromUri, fontConfig, html.counterStyle, targetCollector);
    context.footnotes = footnotes;
    const pageBoxes = layoutDocument(html, rootBox, context);
    if (!loader.missing.size) {
      const document = new Document(pageBoxes.map((box: AnyBox) => new Page(box)), getHtmlMetadata(html.root, html.baseUrl), options.fontConfig ?? new FontConfiguration());
      document.colorProfiles = styleFor.colorProfiles;
      document.attachmentBodies = styleFor.attachmentBodies;
      return document;
    }
    await Promise.all([...loader.missing].map(async (url) => {
      loader.sources.set(url, await fetchUrl(url));
    }));
    loader.missing.clear();
  }
}