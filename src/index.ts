// SPDX-License-Identifier: BSD-3-Clause

/**
 * Public API of weasyprint-ts.
 *
 * Render HTML + CSS to PDF, replicating WeasyPrint 70's layout arithmetic:
 *
 *   import { HTML, renderDocument } from 'weasyprint-ts';
 *   const html = new HTML('<h1>Hello</h1>', { baseUrl: null, fetcher });
 *   const doc = await renderDocument(html, { fontConfig });
 *   writeFileSync('out.pdf', doc.writePdf());
 *
 * IO is provided by the caller: `fetcher` supplies HTML/image bytes up front
 * (the core is synchronous, like upstream), and `fontConfig` supplies fonts
 * — see src/cli/node_fetcher.ts / node_fonts.ts for ready-made Node adapters.
 */
export { HTML, decodeHtml } from './html_document.ts';
export type { HTMLOptions, PdfTarget } from './html_document.ts';
export { CSS } from './css/index.ts';
export { renderDocument, Document, Page, DEFAULT_OPTIONS, checkUnknownOptions } from './document.ts';
export { Attachment } from './pdf/attachments.ts';
export type { AttachmentSource, AttachmentMeta, FetchedAttachment } from './pdf/attachments.ts';

export type { RenderOptions } from './document.ts';
export { VERSION } from './pdf/index.ts';
export type { PdfOptions } from './pdf/index.ts';

// The pluggable text-engine seam (font matching, shaping, line breaking, metrics).
export { getTextEngine, setTextEngine } from './text/engine.ts';
export type { TextEngine } from './text/engine.ts';

// Logging (warning/error default to stderr; inject a sink to capture).
export { setLogSink, LOGGER } from './logger.ts';
export type { Level } from './logger.ts';
