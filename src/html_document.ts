// SPDX-License-Identifier: BSD-3-Clause

/** HTML document loading and style computation (mirrors weasyprint.HTML + get_all_computed_styles). */
import { HTML5_UA_FORM_CSS } from './css/html5_ua_form_css.ts';
import { CSS, StyleFor, findStylesheets } from './css/index.ts';
import { CounterStyle } from './css/counters.ts';
import { LOGGER } from './logger.ts';
import { parseStylesheet, serialize } from './css/parser.ts';
import type { SheetEntry } from './css/index.ts';
import { HTML5_PH_CSS } from './css/html5_ph_css.ts';
import { HTML5_UA_CSS } from './css/html5_ua_css.ts';
import { parseHtml } from './dom.ts';
import type { Element } from './dom.ts';
import type { Fetcher } from './fetch.ts';
import { FontConfiguration, asFontkitInput } from './text/font_config.ts';
import { fontFeatures } from './text/layout.ts';
import { isWoff, woffToSfnt } from './text/woff.ts';
import * as fontkit from 'fontkit';
import { renderDocument, checkUnknownOptions } from './document.ts';
import type { RenderOptions, Document } from './document.ts';
import type { PdfOptions } from './pdf/index.ts';
import { Attachment } from './pdf/attachments.ts';
import type { FetchedAttachment } from './pdf/attachments.ts';
import { urljoin } from './urls.ts';
import { elementHasLinkType } from './formatting_structure/boxes.ts';
import { parseUrl } from './html.ts';

/** Python: html.UA_COUNTER_STYLE. Counter styles defined by the default UA sheet; every document starts with them. */
const UA_COUNTER_STYLE = new CounterStyle();
CSS.fromStringSync(HTML5_UA_CSS, { baseUrl: null, counterStyle: UA_COUNTER_STYLE } as any);

/** Decode HTML bytes: BOM, then <meta charset> sniffing, defaulting to windows-1252 like html5lib. */
export function decodeHtml(bytes: Uint8Array, override?: string | null): string {
  const bomEncoding = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  let encoding = override ?? bomEncoding;
  if (!encoding) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)/i.exec(head);
    encoding = m ? m[1].toLowerCase() : 'windows-1252';
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder('windows-1252');
  }
  const text = decoder.decode(bytes);
  // WHATWG maps the five bytes cp1252 leaves undefined (0x81 0x8D 0x8F 0x90 0x9D) to C1 controls; the oracle decodes
  // with Python's cp1252 codec and errors='replace', which gives U+FFFD for them.
  return decoder.encoding === 'windows-1252' ? text.replace(/[\u0081\u008d\u008f\u0090\u009d]/g, '\ufffd') : text;
}

export interface HTMLOptions {
  baseUrl?: string | null;
  fetcher: Fetcher;
  mediaType?: string;
  encoding?: string | null;
}

/** writePdf target: null returns the bytes, a { write(bytes) } sink consumes them, a path string needs a writeFile option. */
export type PdfTarget = { write(bytes: Uint8Array): void } | string | null | undefined;

export class HTML {
  root: Element;
  baseUrl: string | null;
  fetcher: Fetcher;
  mediaType: string;
  counterStyle = new CounterStyle();

  constructor(source: string, o: HTMLOptions) {
    this.root = parseHtml(source);
    this.fetcher = o.fetcher;
    this.mediaType = o.mediaType ?? 'print';
    this.baseUrl = findBaseUrl(this.root, o.baseUrl ?? null);
  }

  static async fromUrl(url: string, o: HTMLOptions): Promise<HTML> {
    const result = await o.fetcher.fetch(url);
    return new HTML(decodeHtml(result.body, o.encoding ?? result.encoding), {
      ...o, baseUrl: o.baseUrl ?? result.redirectedUrl ?? url,
    });
  }

  /**
   * Lay out and paginate the document, without writing a PDF yet
   * (Python: HTML.render). Shortcut for {@link renderDocument}: returns the
   * {@link Document} for page access, then `writePdf()`.
   */
  async render(options: RenderOptions = {}): Promise<Document> {
    checkUnknownOptions(options);
    return renderDocument(this, options);
  }

  /**
   * Render the document to a PDF file (Python: HTML.write_pdf): renders, then
   * {@link Document.writePdf}s.
   *
   * @param target `null` returns the bytes (default); a `{ write(bytes) }`
   *   sink writes into it and returns null; a path string needs
   *   `options.writeFile` (core is IO-free) and returns null.
   */
  async writePdf(target: PdfTarget = null, zoom = 1,
    options: RenderOptions & PdfOptions & { writeFile?: (path: string, bytes: Uint8Array) => void | Promise<void> } & Record<string, unknown> = {}):
    Promise<Uint8Array | null> {
    checkUnknownOptions(options);
    // Python fetches attachments while the PDF is written; this writer is
    // synchronous, so failed fetches are logged and the attachment is skipped
    // (upstream write_pdf_attachment).
    const attachments = [];
    for (const attachment of options.attachments ?? []) {
      if (attachment instanceof Attachment && !(await attachment.fetch())) continue;
      attachments.push(attachment instanceof Attachment ? attachment.fetched() as FetchedAttachment : attachment as FetchedAttachment);
    }
    const document = await renderDocument(this, { ...options, attachments });
    const bytes = document.writePdf({ ...options, attachments, zoom });
    if (target === null || target === undefined) return bytes;
    if (typeof target === 'string') {
      if (!options.writeFile) {
        throw new Error('writePdf target is a path but no writeFile option was provided — pass a { write(bytes) } sink, write the bytes yourself, or add a writeFile hook');
      }
      await options.writeFile(target, bytes);
      return null;
    }
    target.write(bytes);
    return null;
  }
}

function findBaseUrl(root: Element, fallback: string | null): string | null {
  for (const el of root.iterElements()) {
    if (el.tag === 'base') {
      const href = (el.get('href', '') ?? '').trim();
      if (href) return urljoin(fallback ?? '', href);
      break;
    }
  }
  return fallback;
}

export interface StyleOptions {
  userStylesheets?: CSS[];
  /** Replaces the built-in HTML5 user-agent stylesheet (parity harness: upstream's test UA sheet). */
  userAgentCss?: string;
  /** Base URL for resources the replacement UA sheet references (e.g. its @font-face src). */
  userAgentBaseUrl?: string | null;
  presentationalHints?: boolean;
  /** Include PDF forms (adds upstream's form UA stylesheet). */
  pdfForms?: boolean;
  fontConfig?: FontConfiguration | null;
}

/** Compute the styles of every element in `html` (Python: get_all_computed_styles). */
export async function getAllComputedStyles(html: HTML, o: StyleOptions = {}): Promise<StyleFor> {
  const fetcher = html.fetcher;
  const sheets: SheetEntry[] = [];
  // Python: css.get_all_computed_styles seeds counter styles from html._ua_counter_style()
  for (const [name, definition] of UA_COUNTER_STYLE) html.counterStyle.set(name, definition);
  // The default UA's counter styles are already seeded above; re-defining them would warn.
  const uaCounterStyle = o.userAgentCss ? html.counterStyle : new CounterStyle();
  sheets.push({ sheet: CSS.fromStringSync(o.userAgentCss ?? HTML5_UA_CSS, { baseUrl: o.userAgentBaseUrl ?? null, fetcher, mediaType: html.mediaType, counterStyle: uaCounterStyle }), origin: 'user agent', specificity: null });
  if (o.pdfForms) {
    sheets.push({ sheet: CSS.fromStringSync(HTML5_UA_FORM_CSS, { baseUrl: null, fetcher, mediaType: html.mediaType, counterStyle: uaCounterStyle }), origin: 'user agent', specificity: null });
  }
  if (o.presentationalHints) {
    sheets.push({ sheet: CSS.fromStringSync(HTML5_PH_CSS, { baseUrl: null, fetcher, mediaType: html.mediaType }), origin: 'author', specificity: [0, 0, 0] });
  }
  for (const sheet of await findStylesheets(html.root, html.mediaType, fetcher, html.baseUrl)) {
    sheets.push({ sheet, origin: 'author', specificity: null });
  }
  for (const sheet of o.userStylesheets ?? []) sheets.push({ sheet, origin: 'user', specificity: null });
  // @font-face rules: fetch the font files and register them on the font
  // configuration (mirroring upstream: webfonts join fontconfig's pool and
  // compete with system fonts under the same matching rules).
  // Python: svg/css.py find_stylesheets_rules registers @font-face rules of inline SVG <style> elements with
  // font_config.add_font_face while the SVG is parsed during box building, before any text is laid out; register
  // them here with the document's, as fetching is asynchronous in the port.
  const fontFaceLists = sheets.map(({ sheet }) => sheet.fontFaces);
  for (const element of html.root.iter()) {
    if (element.tag !== '{http://www.w3.org/2000/svg}style' || (element.get('type') ?? 'text/css') !== 'text/css' || !element.text) continue;
    const fontFaceRules = parseStylesheet(element.text, true, true)
      .filter((rule: any) => rule.type === 'at-rule' && rule.lowerAtKeyword === 'font-face');
    if (!fontFaceRules.length) continue;
    const text = fontFaceRules.map((rule: any) => `@font-face {${serialize(rule.content ?? [])}}`).join('\n');
    const css = CSS.fromStringSync(text, { baseUrl: html.baseUrl, fetcher, mediaType: html.mediaType, counterStyle: new CounterStyle() });
    fontFaceLists.push(css.fontFaces);
  }
  if (o.fontConfig) {
    for (const fontFaces of fontFaceLists) {
      for (const face of fontFaces) {
        for (const src of face.srcs) {
          const fetched = await fetcher.fetch(src).catch(() => null);
          if (!fetched) continue;
          // Python decodes WOFF with fontTools before registering the font (add_font_face).
          const result = isWoff(fetched.body) ? { ...fetched, body: woffToSfnt(fetched.body) ?? fetched.body } : fetched;
          // Width comes from the font FILE (fontconfig scans it, WeasyPrint only
          // assign-replaces weight/style descriptors) — this is why Barlow
          // Condensed's embedded names carry the 'Condensed' style word.
          let width = 5;
          try {
            const fk: any = fontkit.create(asFontkitInput(result.body));
            if (!Array.isArray(fk?.fonts)) width = fk['OS/2'].usWidthClass;
          } catch { /* keep normal width */ }
          // Python: add_font_face's fontconfig 'fontfeatures' edit, font_features(font_feature_settings=...,
          // **font-variant descriptors) with every other argument at its default (so 'kern 1' unless overridden).
          const variant = Object.fromEntries(face.variant.map(([name, value]) => [name.replace(/-/g, '_'), value]));
          const features = fontFeatures(
            'normal', variant.font_variant_ligatures ?? 'normal', variant.font_variant_position ?? 'normal',
            variant.font_variant_caps ?? 'normal', variant.font_variant_numeric ?? 'normal',
            variant.font_variant_alternates ?? 'normal', variant.font_variant_east_asian ?? 'normal', face.settings);
          o.fontConfig.addSources([{
            id: src, read: () => result.body, features, unicodeRanges: face.unicodeRanges,
            cachedMeta: { family: face.family, fullName: face.family, weight: face.weight, width, italic: face.italic, size: result.body.length },
          }]);
          break; // the first src that loads wins (like upstream's src list)
        }
      }
    }
  }
  const styleFor = new StyleFor(html.root, html.baseUrl, sheets, o.fontConfig ?? null, o.presentationalHints ?? false);
  // Python: attachments are fetched when the PDF is written; this port writes synchronously, so fetch them here.
  // Targets are resolved like the links they come from (parse_url with the document's base URL).
  const attachmentUrls = new Set<string>();
  for (const element of html.root.iter()) {
    if (element.tag === 'link' && elementHasLinkType(element, 'attachment')) {
      const url = parseUrl(element.get('href', null), html.baseUrl);
      if (url !== null) attachmentUrls.add(url);
    } else if (element.tag === 'a' && elementHasLinkType(element, 'attachment') && element.get('href', null) !== null) {
      const url = parseUrl(element.get('href', null), html.baseUrl);
      if (url !== null) attachmentUrls.add(url);
    }
  }
  for (const url of attachmentUrls) {
    const fetched = await fetcher.fetch(url).catch(() => null);
    if (!fetched) {
      LOGGER.error(`Failed to load attachment: could not fetch ${url}`);
      continue;
    }
    styleFor.attachmentBodies.set(url, { body: fetched.body, mimeType: fetched.mimeType ?? null });
  }
  // Python: @color-profile rules fetch their ICC file while the stylesheet is preprocessed; later rules win.
  for (const { sheet } of sheets) {
    for (const profile of sheet.colorProfiles) {
      const fetched = await fetcher.fetch(profile.src).catch(() => null);
      if (!fetched || fetched.body.length < 132 || String.fromCharCode(...fetched.body.subarray(36, 40)) !== 'acsp') {
        LOGGER.warning(`Invalid profile file for profile named '${profile.name}', the whole @color-profile rule was ignored.`);
        continue;
      }
      styleFor.colorProfiles.set(profile.name, {
        name: profile.name, content: fetched.body, components: profile.components, renderingIntent: profile.renderingIntent,
      });
    }
  }
  return styleFor;
}