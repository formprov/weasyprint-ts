// SPDX-License-Identifier: BSD-3-Clause

/**
 * Embedded files (mirrors weasyprint/pdf/anchors.py write_pdf_attachment). The bytes are fetched before the PDF is
 * written (the writer is synchronous), so an attachment here is a URL plus its fetched body.
 */
import { LOGGER } from '../logger.ts';
import { md5Hex } from '../md5.ts';
import type { Fetcher } from '../fetch.ts';
import { urlIsAbsolute, urljoin, pathToFileUrl } from '../urls.ts';
import { Dictionary, PDF, PdfString, Stream } from './pydyf.ts';

export interface FetchedAttachment {
  url: string;
  body: Uint8Array;
  mimeType: string | null;
  /** Name to show (Python: Attachment.name, e.g. the link's download attribute). */
  name: string | null;
  description: string | null;
  /** AFRelationship for PDF/A-3+ (Python: Attachment.relationship, default 'Unspecified'). */
  relationship?: string;
  /** Python: Attachment.created / modified, written as Params/CreationDate + ModDate (default: fetch time). */
  created?: Date;
  modified?: Date;
}

const MIME_TYPES: Record<string, string> = {
  txt: 'text/plain', html: 'text/html', htm: 'text/html', css: 'text/css', csv: 'text/csv', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', xml: 'application/xml',
  json: 'application/json', zip: 'application/zip', odt: 'application/vnd.oasis.opendocument.text',
};

function basenameOf(url: string): string {
  // Upstream: the last path segment of a non-data URL, unquoted; data URLs and bare roots have no name.
  if (url.startsWith('data:')) return '';
  try {
    const path = new URL(url).pathname;
    const last = decodeURIComponent(path.split('/').pop() ?? '');
    return last;
  } catch {
    return '';
  }
}

function pdfDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** Write one embedded file; returns its file specification dictionary (upstream: pdf_attachment). */
export function writeAttachment(pdf: PDF, attachment: FetchedAttachment, compress: boolean): Dictionary {
  const stream = attachment.body;
  const checksum = md5Hex(stream);
  let filename: string;
  if (attachment.name) filename = attachment.name;
  else {
    const base = basenameOf(attachment.url);
    filename = base || 'attachment.bin';
  }
  let mimeType = attachment.mimeType;
  if (!mimeType) {
    const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
    mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';
  }
  const now = new Date();
  const fileExtra = new Dictionary({
    Type: '/EmbeddedFile',
    Subtype: `/${mimeType.replace(/\//g, '#2f')}`,
    Params: new Dictionary({
      CheckSum: `<${checksum}>`,
      Size: stream.length,
      CreationDate: new PdfString(pdfDate(attachment.created ?? now)),
      ModDate: new PdfString(pdfDate(attachment.modified ?? now)),
    }),
  });
  const fileStream = new Stream([stream], fileExtra, compress);
  pdf.addObject(fileStream);
  const spec = new Dictionary({
    Type: '/Filespec',
    F: new PdfString(filename),
    UF: new PdfString(filename),
    EF: new Dictionary({ F: fileStream.reference }),
    Desc: new PdfString(attachment.description ?? ''),
  });
  // The MIME subtype is kept on the specification for the PDF/A post-processing (upstream reads the stream's Subtype).
  (spec as Dictionary & { subtype?: string }).subtype = fileExtra.get('Subtype') as string;
  (spec as Dictionary & { checksum?: string; relationship?: string }).checksum = `<${checksum}>`;
  (spec as Dictionary & { relationship?: string }).relationship = attachment.relationship ?? 'Unspecified';
  pdf.addObject(spec);
  return spec;
}

/** Log a fetch failure the way upstream does (the attachment is skipped). */
export function attachmentFailed(url: string, reason: string): void {
  LOGGER.error(`Failed to load attachment: ${reason} (${url})`);
}

export interface AttachmentSource {
  /** Every field with a value is treated as the source (Python: select_source: exactly one). */
  guess?: string | Uint8Array;
  filename?: string;
  url?: string;
  fileObj?: Uint8Array;
  string?: Uint8Array | string;
  /** Resolves relative filenames/guesses (Python: base_url). */
  baseUrl?: string | null;
  /** Fetches URL sources (Python: url_fetcher; required for guessed URLs and url=/filename=). */
  fetcher?: Fetcher;
}

export interface AttachmentMeta {
  name?: string | null;
  description?: string | null;
  created?: Date;
  modified?: Date;
  /** AFRelationship for PDF/A-3+ (default 'Unspecified'). */
  relationship?: string;
}

/**
 * File attachment for a PDF document (mirrors weasyprint/__init__.py Attachment).
 *
 * The bytes load lazily: the core is IO-free behind {@link Fetcher}, so
 * `fileObj`/`string` sources resolve immediately while URL/filename sources
 * fetch on {@link fetch}. Both branches expose the same fields the PDF writer
 * needs ({@link FetchedAttachment}).
 */
export class Attachment {
  name: string | null;
  description: string | null;
  relationship: string;
  created: Date;
  modified: Date;
  /** Resolved source URL once fetched (data:, file:, http... — never null after fetch). */
  url: string | null = null;
  body: Uint8Array | null = null;
  mimeType: string | null = null;
  /** md5 of the body, set on fetch (Python: Attachment.md5). */
  md5: string | null = null;
  private fetcher: Fetcher | null;

  constructor(source: AttachmentSource, meta: AttachmentMeta = {}, fetcher: Fetcher | null = null) {
    const given = [source.guess, source.filename, source.url, source.fileObj, source.string]
      .filter((value) => value !== undefined && value !== null);
    if (given.length !== 1) {
      throw new TypeError(`Expected exactly one attachment source, got ${given.length}`);
    }
    this.name = meta.name ?? null;
    this.description = meta.description ?? null;
    this.relationship = meta.relationship ?? 'Unspecified';
    // Python falls back to the file's ctime/mtime; a URL source uses now().
    this.created = meta.created ?? new Date();
    this.modified = meta.modified ?? this.created;
    this.fetcher = fetcher ?? source.fetcher ?? null;
    this.resolve(source);
  }

  private resolve(source: AttachmentSource): void {
    const baseUrl = source.baseUrl ?? null;
    const guess = source.guess;
    if (guess instanceof Uint8Array) {
      this.apply('', guess, null);
      return;
    } else if (guess !== undefined && guess !== null) {
      // Python: an absolute URL wins over a filename; anything else is a path.
      if (urlIsAbsolute(guess)) {
        this.resolveUrl(guess);
        return;
      }
      this.resolveFilename(guess, baseUrl);
      return;
    }
    if (source.url) {
      this.resolveUrl(source.url, baseUrl ?? undefined);
      return;
    }
    if (source.filename) {
      this.resolveFilename(source.filename, baseUrl);
      return;
    }
    if (source.fileObj) {
      this.apply('', source.fileObj, null);
      return;
    }
    const literal = source.string!;
    this.apply('', typeof literal === 'string' ? new TextEncoder().encode(literal) : literal, null);
  }

  private resolveUrl(url: string, baseUrl: string | undefined = undefined): void {
    this.fetchUrl = urlIsAbsolute(url) ? url : urljoin(baseUrl, url);
  }

  private fetchUrl: string | null = null;

  private resolveFilename(filename: string, baseUrl: string | null): void {
    // A filename is a local path (upstream filename=): the fetcher must read
    // file: URLs for it. Core stays IO-free: absolute paths become file: URLs,
    // baseUrl-relative paths join; a bare relative path is left for the
    // caller's fetcher (the Node adapter resolves those against the cwd).
    if (baseUrl) {
      this.fetchUrl = urljoin(baseUrl, filename);
    } else if (filename.startsWith('/')) {
      this.fetchUrl = pathToFileUrl(filename);
    } else {
      this.fetchUrl = filename;
    }
  }

  private apply(url: string | null, body: Uint8Array, mimeType: string | null): void {
    this.url = url;
    this.body = body;
    this.mimeType = mimeType;
    this.md5 = md5Hex(body);
  }

  /** Load the bytes (Python: read the source in write_pdf_attachment). Returns false on any fetch error. */
  async fetch(fetcher: Fetcher | null = this.fetcher): Promise<boolean> {
    if (this.body !== null) return true;
    const url = this.fetchUrl;
    if (url === null) return false;
    if (!fetcher) {
      LOGGER.error(`Failed to load attachment: no fetcher provided (${url})`);
      return false;
    }
    try {
      const fetched = await fetcher.fetch(url);
      this.apply(url, fetched.body, fetched.mimeType ?? null);
      return true;
    } catch (error) {
      LOGGER.error(`Failed to load attachment: ${(error as Error).message} (${url})`);
      return false;
    }
  }

  /** The writer's input; only valid after a successful fetch. */
  fetched(): FetchedAttachment {
    if (this.body === null || this.url === null) {
      throw new Error('Attachment bytes were not fetched');
    }
    return {
      url: this.url, body: this.body, mimeType: this.mimeType,
      name: this.name, description: this.description, relationship: this.relationship,
      created: this.created, modified: this.modified,
    };
  }
}
