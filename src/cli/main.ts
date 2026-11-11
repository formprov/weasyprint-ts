#!/usr/bin/env node
// SPDX-License-Identifier: BSD-3-Clause

/**
 * Command-line interface (mirrors weasyprint/__main__.py).
 *
 * Drop-in usage: weasyprint-ts [options] <input> <output>
 *   weasyprint-ts -s style.css in.html out.pdf
 */
import { readFileSync, writeFileSync, statSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type, machine, version as osVersion, release as osRelease } from 'node:os';
import { CSS } from '../css/index.ts';
import { HTML, decodeHtml } from '../html_document.ts';
import { renderDocument } from '../document.ts';
import { setLogSink, LOGGER } from '../logger.ts';
import { NodeFetcher } from './node_fetcher.ts';
import { createFontConfiguration, defaultFontDirs } from './node_fonts.ts';
import type { FontConfiguration } from '../text/font_config.ts';
import type { FontProfile } from '../text/font_config.ts';
import '../text/line_break.ts';

/** fontkit's own version (read from its package.json; not exposed by the module's ESM exports). */
function fontkitVersion(): string {
  try {
    return JSON.parse(readFileSync(new URL('../../node_modules/fontkit/package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** `-i/--info`: mirrors upstream's structure (System/Machine/Version/Release, blank, versions).
 *  Upstream lists Python/Pydyf/Pango; this port lists Node.js/fontkit equivalents. */
export function infoText(): string {
  return [
    'System: ' + type(),
    'Machine: ' + machine(),
    'Version: ' + (osVersion?.() ?? ''),
    'Release: ' + osRelease(),
    '',
    'WeasyPrint version: 70.0',
    'Node.js version: ' + process.version,
    'fontkit version: ' + fontkitVersion(),
  ].join('\n') + '\n';
}

interface CliArgs {
  input: string;
  output: string;
  stylesheets: string[];
  /** Harness-only: replace the built-in user-agent stylesheet with this file. */
  uaStylesheet: string | null;
  presentationalHints: boolean;
  baseUrl: string | null;
  encoding: string | null;
  mediaType: string;
  verbose: boolean;
  debug: boolean;
  quiet: boolean;
  uncompressedPdf: boolean;
  pdfVersion: string | null;
  fullFonts: boolean;
  jpegQuality: number | null;
  attachments: string[];
  pdfIdentifier: string | null;
  customMetadata: boolean;
  pdfVariant: string | null;
  outputIntent: string | null;
  pdfTags: boolean;
  optimizeImages: boolean;
  xmpMetadata: string[];
  dpi: number | null;
  pdfForms: boolean;
  attachmentRelationships: string[];
  timeout: number | null;
  allowedProtocols: string | null;
  noHttpRedirects: boolean;
  failOnHttpErrors: boolean;
  /** Port-only (harness): write_pdf's zoom, which upstream exposes only as a Python argument. */
  zoom: number;
}

// Boolean flags and value flags (same names as the Python argument parser).
const BOOL_FLAGS = new Set([
  'p', 'presentational-hints', 'v', 'verbose', 'd', 'debug', 'q', 'quiet',
  'uncompressed-pdf', 'pdf-forms', 'pdf-tags', 'custom-metadata', 'optimize-images',
  'full-fonts', 'hinting', 'no-http-redirects', 'fail-on-http-errors',
]);

// Options the Python CLI accepts but this port does not act on; parsed and ignored with a warning.
const UNSUPPORTED_FLAGS = new Set<string>([
  
]);

// Generated from upstream's argparse (COLUMNS=80) so --help is byte-identical.
const HELP = "usage: weasyprint [-h] [-i] [--version] [-s STYLESHEETS] [-a ATTACHMENTS]\n                  [--attachment-relationship ATTACHMENT_RELATIONSHIPS]\n                  [--pdf-identifier PDF_IDENTIFIER]\n                  [--pdf-variant {pdf/a-1b,pdf/a-2b,pdf/a-3b,pdf/a-2u,pdf/a-3u,pdf/a-4u,pdf/a-1a,pdf/a-2a,pdf/a-3a,pdf/a-4e,pdf/a-4f,pdf/ua-1,pdf/ua-2,pdf/x-1a,pdf/x-3,pdf/x-4,pdf/x-5g,debug}]\n                  [--pdf-version PDF_VERSION] [--pdf-forms] [--pdf-tags]\n                  [--uncompressed-pdf] [--xmp-metadata XMP_METADATA]\n                  [--custom-metadata] [--output-intent OUTPUT_INTENT] [-p]\n                  [--optimize-images] [-j JPEG_QUALITY] [-D DPI]\n                  [--full-fonts] [--hinting] [-c CACHE] [-e ENCODING]\n                  [-m MEDIA_TYPE] [-u BASE_URL] [-t TIMEOUT]\n                  [--allowed-protocols ALLOWED_PROTOCOLS]\n                  [--no-http-redirects] [--fail-on-http-errors] [-v | -d | -q]\n                  input output\n\nRender web pages to PDF.\n\npositional arguments:\n  input                 URL or filename of the HTML input, or - for stdin\n  output                filename where output is written, or - for stdout\n\noptions:\n  -h, --help            show this help message and exit\n  -i, --info            print system information and exit\n  --version             print WeasyPrint’s version number and exit\n\nrendering options:\n  -s, --stylesheet STYLESHEETS\n                        URL or filename for a user CSS stylesheet\n  -a, --attachment ATTACHMENTS\n                        URL or filename of a file to attach to the PDF\n                        document\n  --attachment-relationship ATTACHMENT_RELATIONSHIPS\n                        Relationship of the attachment file to attach to the\n                        PDF\n  --pdf-identifier PDF_IDENTIFIER\n                        PDF file identifier\n  --pdf-variant {pdf/a-1b,pdf/a-2b,pdf/a-3b,pdf/a-2u,pdf/a-3u,pdf/a-4u,pdf/a-1a,pdf/a-2a,pdf/a-3a,pdf/a-4e,pdf/a-4f,pdf/ua-1,pdf/ua-2,pdf/x-1a,pdf/x-3,pdf/x-4,pdf/x-5g,debug}\n                        PDF variant to generate\n  --pdf-version PDF_VERSION\n                        PDF version number\n  --pdf-forms           include PDF forms\n  --pdf-tags            tag PDF for accessibility\n  --uncompressed-pdf    do not compress PDF content, mainly for debugging\n                        purpose\n  --xmp-metadata XMP_METADATA\n                        URL or filename of a file to include into the XMP\n                        metadata\n  --custom-metadata     include custom HTML meta tags in PDF metadata\n  --output-intent OUTPUT_INTENT\n                        srgb, device-cmyk, or CSS identifier of the output\n                        intent color space\n  -p, --presentational-hints\n                        follow HTML presentational hints\n  --optimize-images     optimize size of embedded images with no quality loss\n  -j, --jpeg-quality JPEG_QUALITY\n                        JPEG quality between 0 (worst) to 95 (best)\n  -D, --dpi DPI         set maximum resolution of images embedded in the PDF\n  --full-fonts          embed unmodified font files when possible\n  --hinting             keep hinting information in embedded fonts\n  -c, --cache-folder CACHE\n                        store cache on disk instead of memory, folder is\n                        created if needed and cleaned after the PDF is\n                        generated\n\nHTML options:\n  -e, --encoding ENCODING\n                        force the input character encoding\n  -m, --media-type MEDIA_TYPE\n                        media type to use for @media, defaults to print\n  -u, --base-url BASE_URL\n                        base for relative URLs in the HTML input, defaults to\n                        the input’s own filename or URL or the current\n                        directory for stdin\n\nURL fetcher options:\n  -t, --timeout TIMEOUT\n                        set timeout in seconds for HTTP requests\n  --allowed-protocols ALLOWED_PROTOCOLS\n                        only authorize comma-separated list of protocols for\n                        fetching URLs\n  --no-http-redirects   do not follow HTTP redirects\n  --fail-on-http-errors\n                        abort document rendering on any HTTP error\n\ncommand-line logging options:\n  -v, --verbose         show warnings and information messages\n  -d, --debug           show debugging messages\n  -q, --quiet           hide logging messages\n";
const USAGE = "usage: weasyprint [-h] [-i] [--version] [-s STYLESHEETS] [-a ATTACHMENTS]\n                  [--attachment-relationship ATTACHMENT_RELATIONSHIPS]\n                  [--pdf-identifier PDF_IDENTIFIER]\n                  [--pdf-variant {pdf/a-1b,pdf/a-2b,pdf/a-3b,pdf/a-2u,pdf/a-3u,pdf/a-4u,pdf/a-1a,pdf/a-2a,pdf/a-3a,pdf/a-4e,pdf/a-4f,pdf/ua-1,pdf/ua-2,pdf/x-1a,pdf/x-3,pdf/x-4,pdf/x-5g,debug}]\n                  [--pdf-version PDF_VERSION] [--pdf-forms] [--pdf-tags]\n                  [--uncompressed-pdf] [--xmp-metadata XMP_METADATA]\n                  [--custom-metadata] [--output-intent OUTPUT_INTENT] [-p]\n                  [--optimize-images] [-j JPEG_QUALITY] [-D DPI]\n                  [--full-fonts] [--hinting] [-c CACHE] [-e ENCODING]\n                  [-m MEDIA_TYPE] [-u BASE_URL] [-t TIMEOUT]\n                  [--allowed-protocols ALLOWED_PROTOCOLS]\n                  [--no-http-redirects] [--fail-on-http-errors] [-v | -d | -q]\n                  input output\n";

function fail(message: string, code: number): never {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    input: '', output: '', stylesheets: [], uaStylesheet: null, presentationalHints: false, baseUrl: null,
    encoding: null, mediaType: 'print', verbose: false, debug: false, quiet: false,
    uncompressedPdf: false, pdfVersion: null, fullFonts: false, jpegQuality: null, attachments: [], pdfIdentifier: null, customMetadata: false, pdfVariant: null, outputIntent: null, pdfTags: false, optimizeImages: false, xmpMetadata: [], dpi: null, pdfForms: false, attachmentRelationships: [], timeout: null, allowedProtocols: null, noHttpRedirects: false, failOnHttpErrors: false, zoom: 1,
  };
  const positional: string[] = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--') { i++; positional.push(...argv.slice(i)); break; }
    if (raw === '-h' || raw === '--help') { process.stdout.write(HELP); process.exit(0); }
    if (raw === '--version') { process.stdout.write('WeasyPrint version 70.0\n'); process.exit(0); }
    if (raw === '-') { positional.push(raw); continue; }
    let name: string | null = null;
    let value: string | null = null;
    let inlineValue = false;
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      name = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
      if (eq >= 0) { value = raw.slice(eq + 1); inlineValue = true; }
    } else if (raw.startsWith('-')) {
      if (raw.length === 1) { positional.push(raw); continue; }
      name = raw.slice(1);
      if (name.length > 1) { // -sfilename.png style
        value = name.slice(1);
        name = name[0];
        inlineValue = true;
      }
    } else {
      positional.push(raw);
      continue;
    }

    if (name === 'info' || name === 'i') {
      process.stdout.write(infoText());
      process.exit(0);
    }
    switch (name) {
      case 'p': case 'presentational-hints': args.presentationalHints = true; break;
      case 'v': case 'verbose': args.verbose = true; break;
      case 'd': case 'debug': args.debug = true; break;
      case 'q': case 'quiet': args.quiet = true; break;
      case 'uncompressed-pdf': args.uncompressedPdf = true; break;
      case 'full-fonts': args.fullFonts = true; break;
      case 'custom-metadata': args.customMetadata = true; break;
      case 'pdf-tags': args.pdfTags = true; break;
      case 'attachment-relationship':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.attachmentRelationships.push(value!);
        break;
      case 'D': case 'dpi':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        if (!/^-?\d+$/.test(value ?? '')) fail(`Argument -D/--dpi: invalid int value: '${value}'\n`, 2);
        args.dpi = Number(value);
        break;
      case 'xmp-metadata':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.xmpMetadata.push(value!);
        break;
      case 'pdf-forms': args.pdfForms = true; break;
      case 'no-http-redirects': args.noHttpRedirects = true; break;
      case 'fail-on-http-errors': args.failOnHttpErrors = true; break;
      case 'hinting': break; // no effect on this port's text rendering
      case 'c': case 'cache-folder':
      case 't': case 'timeout':
      case 'allowed-protocols':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        if (name === 't' || name === 'timeout') {
          if (!/^\d+$/.test(value ?? '')) fail(`Argument -t/--timeout: invalid int value: '${value}'\n`, 2);
          args.timeout = Number(value);
        } else if (name === 'allowed-protocols') args.allowedProtocols = value;
        break; // cache-folder: output-neutral, accepted silently
      case 'optimize-images': args.optimizeImages = true; break;
      case 'pdf-variant':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.pdfVariant = value;
        break;
      case 'output-intent':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.outputIntent = value;
        break;
      case 'pdf-identifier':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.pdfIdentifier = value;
        break;
      case 'a': case 'attachment':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.attachments.push(value!);
        break;
      case 'j': case 'jpeg-quality':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        if (!/^\d+$/.test(value ?? '') || Number(value) > 100) fail(`Argument --${name}: invalid quality value: '${value}'\n`, 2);
        args.jpegQuality = Number(value);
        break;
      case 'ua-stylesheet':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.uaStylesheet = value!;
        break;
      case 'zoom':
        // Port-only: upstream exposes write_pdf(zoom=...) to Python callers but has no CLI flag.
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        if (!/^[0-9]*\.?[0-9]+$/.test(value ?? '') || Number(value) <= 0) fail(`Argument --${name}: invalid zoom value: '${value}'\n`, 2);
        args.zoom = Number(value);
        break;
      case 's': case 'stylesheet':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument -${name}: expected one argument\n`, 2);
        }
        args.stylesheets.push(value!);
        break;
      case 'u': case 'base-url':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --${name}: expected one argument\n`, 2);
        }
        args.baseUrl = value;
        break;
      case 'e':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument -e: expected one argument\n`, 2);
        }
        args.encoding = value;
        break;
      case 'm': case 'media-type':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument -m: expected one argument\n`, 2);
        }
        args.mediaType = value!;
        break;
      case 'pdf-version':
        if (value === null && !inlineValue) {
          value = argv[++i];
          if (value === undefined) fail(`Argument --pdf-version: expected one argument\n`, 2);
        }
        args.pdfVersion = value;
        break;
      default:
        if (UNSUPPORTED_FLAGS.has(name)) {
          if (!BOOL_FLAGS.has(name) && !inlineValue) {
            // consume the ignored value argument if it looks separate
            if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i++;
          }
          LOGGER.warning(`Ignored command-line option '${raw}': not supported by this port yet`);
        } else {
          fail(`unrecognized arguments: ${raw}\n`, 2);
        }
    }
  }
  if (positional.length !== 2) fail(`${USAGE}\n`, 2);
  [args.input, args.output] = positional;
  return args;
}

function resolveBaseUrl(baseUrl: string, cwd: string): string | null {
  if (baseUrl === '' || baseUrl === 'none') return null; // no base URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(baseUrl)) return baseUrl;
  return pathToFileURL(resolve(cwd, baseUrl)).href;
}

function inputUrlOf(input: string, baseUrlArg: string | null): string {
  if (input === '-') return 'stdin://-';
  if (/^[a-z][a-z0-9+.-]*:/i.test(input)) return input;
  return pathToFileURL(resolve(input)).href;
}

export async function main(argv: string[] = process.argv.slice(2),
  fontConfig?: FontConfiguration): Promise<number> {
  const args = parseArgs(argv);

  // Logging flags mirror Python: -v INFO, -d DEBUG, -q quiet.
  if (args.quiet) setLogSink(() => {});
  else {
    setLogSink((level, message) => {
      if (level === 'debug') { if (args.debug) process.stderr.write(`DEBUG: ${message}\n`); return; }
      if (level === 'info') { if (args.verbose || args.debug) process.stderr.write(`INFO: ${message}\n`); return; }
      process.stderr.write(`${level.toUpperCase()}: ${message}\n`);
    });
  }

  if (fontConfig === undefined) {
    fontConfig = defaultFontConfig();
  }
  const fetcher = new NodeFetcher({
    timeout: args.timeout ?? undefined,
    allowedProtocols: args.allowedProtocols === null ? null : new Set(args.allowedProtocols.split(',').map((p) => p.trim().toLowerCase())),
    allowRedirects: !args.noHttpRedirects,
    failOnErrors: args.failOnHttpErrors,
  });
  const isStdin = args.input === '-';
  const inputUrl = inputUrlOf(args.input, args.baseUrl);
  // Python: base_url defaults to the input's own filename/URL; '-' defaults to '.'; '' disables it.
  const baseUrl = isStdin
    ? resolveBaseUrl(args.baseUrl ?? '.', process.cwd())
    : (args.baseUrl === null ? inputUrl : resolveBaseUrl(args.baseUrl, process.cwd()));

  let html: HTML;
  try {
    if (isStdin) {
      const stdinBytes = await readStdin();
      html = new HTML(decodeHtml(stdinBytes, args.encoding), { baseUrl, fetcher, mediaType: args.mediaType });
    } else if (inputUrl.startsWith('file:')) {
      const path = fileURLToPath(inputUrl);
      const bytes = readFileSync(path);
      html = new HTML(decodeHtml(bytes, args.encoding), { baseUrl, fetcher, mediaType: args.mediaType });
    } else {
      html = await HTML.fromUrl(inputUrl, { baseUrl, fetcher, mediaType: args.mediaType, encoding: args.encoding });
    }
  } catch (error) {
    LOGGER.error(`Failed to load "${args.input}": ${(error as Error).message}`);
    return 1;
  }

  const stylesheets: CSS[] = [];
  for (const s of args.stylesheets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      stylesheets.push(await CSS.fromUrl(s, { fetcher, mediaType: args.mediaType }));
      continue;
    }
    try {
      const path = resolve(s);
      stylesheets.push(await CSS.fromString(readFileSync(path, 'utf8'),
        { baseUrl: pathToFileURL(path).href, fetcher, mediaType: args.mediaType }));
    } catch (error) {
      LOGGER.error(`Failed to load stylesheet at ${s}: ${(error as Error).message}`);
      return 1;
    }
  }

  let document;
  try {
    document = await renderDocument(html, {
      fontConfig, stylesheets, presentationalHints: args.presentationalHints,
      userAgentCss: args.uaStylesheet ? readFileSync(args.uaStylesheet, 'utf8') : undefined,
      userAgentBaseUrl: args.uaStylesheet ? pathToFileURL(resolve(args.uaStylesheet)).href : undefined,
      jpegQuality: args.jpegQuality ?? undefined,
      optimizeImages: args.optimizeImages,
      dpi: args.dpi ?? undefined,
      pdfForms: args.pdfForms,
    });
  } catch (error) {
    LOGGER.error(`Rendering failed: ${(error as Error).stack ?? (error as Error).message}`);
    return 1;
  }

  if (fetcher.fatalError) {
    LOGGER.error(fetcher.fatalError.message);
    return 1;
  }

  // Attachments are fetched here: the PDF writer is synchronous. A path becomes a file: URL (upstream Attachment).
  const fetchedAttachments = [];
  for (const source of args.attachments) {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source) ? source : pathToFileURL(resolve(source)).href;
    try {
      const fetched = await fetcher.fetch(url);
      fetchedAttachments.push({ url, body: fetched.body, mimeType: fetched.mimeType ?? null, name: null, description: null, relationship: args.attachmentRelationships[fetchedAttachments.length] });
    } catch (error) {
      LOGGER.error(`Failed to load attachment: ${(error as Error).message}`);
    }
  }
  const xmpMetadata: string[] = [];
  for (const source of args.xmpMetadata) {
    const url = /^[a-z][a-z0-9+.-]*:/i.test(source) && !/^[a-z]:[\\/]/i.test(source) ? source : pathToFileURL(resolve(source)).href;
    try {
      xmpMetadata.push(new TextDecoder().decode((await fetcher.fetch(url)).body));
    } catch (error) {
      LOGGER.error(`Failed to load XMP metadata: ${(error as Error).message}`);
      return 1;
    }
  }
  const pdfBytes = document.writePdf({
    xmpMetadata,
    uncompressedPdf: args.uncompressedPdf, pdfVersion: args.pdfVersion, fullFonts: args.fullFonts, attachments: fetchedAttachments,
    pdfIdentifier: args.pdfIdentifier, customMetadata: args.customMetadata, pdfVariant: args.pdfVariant,
    outputIntent: args.outputIntent, pdfTags: args.pdfTags, zoom: args.zoom,
  });
  if (args.output === '-') {
    process.stdout.write(pdfBytes);
  } else {
    try {
      writeFileSync(resolve(args.output), pdfBytes);
    } catch (error) {
      LOGGER.error(`Failed to write ${args.output}: ${(error as Error).message}`);
      return 1;
    }
    if (args.verbose || args.debug) {
      LOGGER.log('info', `${document.pages.length} page(s) written to ${args.output}`);
    }
  }
  return 0;
}

function defaultFontConfig(): FontConfiguration {
  // FONT_PROFILE: a FontProfile JSON for a font set that differs from the
  // production image (e.g. parity/diffrun.py derives one from the pinned
  // env's own fc-match so generic families resolve identically in both
  // engines). Unset: the generated profile of the pinned production env.
  const profilePath = process.env.FONT_PROFILE;
  const profile = JSON.parse(readFileSync(
    profilePath ?? new URL('../../profiles/alpine_prod.json', import.meta.url), 'utf8')) as FontProfile;
  const fontDir = process.env.FONT_DIR;
  const dirs = fontDir ? fontDir.split(':').filter(Boolean) : defaultFontDirs();
  return createFontConfiguration(dirs, profile);
}

function readStdin(): Promise<Uint8Array> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    process.stdin.on('data', (c: Buffer) => { chunks.push(new Uint8Array(c)); total += c.length; });
    process.stdin.on('end', () => {
      const all = new Uint8Array(total);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      resolvePromise(all);
    });
    process.stdin.on('error', reject);
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === realpathSafe(process.argv[1]).href;

function realpathSafe(path: string): URL {
  try {
    return pathToFileURL(realpathSync(path));
  } catch {
    return pathToFileURL(path);
  }
}
if (invokedDirectly) {
  main().then(
    (code) => process.exitCode = code,
    (error) => {
      process.stderr.write(`${(error as Error).stack ?? error}\n`);
      process.exit(1);
    },
  );
}