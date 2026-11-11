// SPDX-License-Identifier: BSD-3-Clause

/** URL helpers (subset of weasyprint/urls.py). */
import { LOGGER } from './logger.ts';

export function urlIsAbsolute(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) && !/^[a-zA-Z]:[\\/]/.test(url);
}

/** Percent-encode characters that are not allowed in URIs (like IRI -> URI). */
const UTF8 = new TextEncoder();
export function iriToUri(url: string): string {
  return url.replace(/[^\x21-\x7e]|[ "<>\\^`{|}]/g, (c) => {
    if (c === '%') return c;
    return [...UTF8.encode(c)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  });
}

export function urljoin(base: string | undefined, url: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

export type UrlTuple = ['internal', string] | ['external', string];

export function getUrlTuple(url: string, baseUrl: string | null): UrlTuple | null {
  if (url.startsWith('#')) return ['internal', decodeURIComponent(url.slice(1))];
  if (urlIsAbsolute(url)) return ['external', iriToUri(url)];
  if (baseUrl) return ['external', iriToUri(urljoin(baseUrl, url))];
  return null;
}

export function urlJoin(baseUrl: string | null, url: string, allowRelative: boolean, context: string): string | null {
  if (urlIsAbsolute(url)) return iriToUri(url);
  if (baseUrl) return iriToUri(urljoin(baseUrl, url));
  if (allowRelative) return iriToUri(url);
  LOGGER.error(`Relative URI reference without a base URI: ${context}`);
  return null;
}

export function pathToFileUrl(path: string): string {
  return new URL('file://' + encodeURI(path).replace(/[?#]/g, encodeURIComponent)).href;
}

/**
 * Decode a data: URL like upstream's default fetcher (urls.py): `data:[<mime>][;charset=..][;base64],<data>`.
 * The mime type defaults to text/plain, the charset to US-ASCII; non-base64 data is percent-decoded.
 */
export function decodeDataUrl(url: string): { body: Uint8Array; mimeType: string; charset: string } | null {
  const match = /^data:([^,]*),([\s\S]*)$/i.exec(url);
  if (!match) return null;
  const parts = match[1].split(';').map((p) => p.trim());
  const isBase64 = parts.length > 1 && parts[parts.length - 1].toLowerCase() === 'base64';
  const params = isBase64 ? parts.slice(0, -1) : parts;
  let mimeType = (params[0] || '').toLowerCase() || 'text/plain';
  let charset = 'US-ASCII';
  for (const param of params.slice(1)) {
    const [key, value] = param.split('=');
    if (key && value && key.trim().toLowerCase() === 'charset') charset = value.trim();
  }
  if (params.length === 1 && !params[0].includes('/')) mimeType = 'text/plain';
  let body: Uint8Array;
  if (isBase64) {
    const binary = atob(match[2].replace(/\s+/g, ''));
    body = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } else {
    const raw = decodeURIComponent(match[2].replace(/%(?![0-9A-Fa-f]{2})/g, '%25').replace(/\+/g, '+'));
    body = new TextEncoder().encode(raw);
  }
  return { body, mimeType, charset };
}
