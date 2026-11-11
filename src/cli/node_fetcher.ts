import { decodeDataUrl } from '../urls.ts';
// SPDX-License-Identifier: BSD-3-Clause

/** Node adapter for the Fetcher interface: file: URLs via fs, http(s) via fetch. */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { FetchResult, Fetcher } from '../fetch.ts';

export interface NodeFetcherOptions {
  /** Seconds before HTTP requests are dropped (default 10, as upstream). */
  timeout?: number;
  /** Lower-case scheme allow-list; null = all. */
  allowedProtocols?: Set<string> | null;
  allowRedirects?: boolean;
  failOnErrors?: boolean;
}

export class NodeFetcher implements Fetcher {
  /** First fetch error seen when failOnErrors is set (upstream raises FatalURLFetchingError). */
  fatalError: Error | null = null;
  private readonly options: NodeFetcherOptions;
  constructor(options: NodeFetcherOptions = {}) { this.options = options; }

  async fetch(url: string): Promise<FetchResult> {
    try {
      return await this.fetchInner(url);
    } catch (error) {
      if (this.options.failOnErrors && !this.fatalError) this.fatalError = new Error(`Error fetching "${url}": ${(error as Error).message}`);
      throw error;
    }
  }

  private async fetchInner(url: string): Promise<FetchResult> {
    const allowed = this.options.allowedProtocols;
    if (allowed) {
      const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1].toLowerCase();
      if (!scheme || !allowed.has(scheme)) throw new Error(`URI uses disallowed protocol: ${url}`);
    }
    if (url.startsWith('data:')) {
      const decoded = decodeDataUrl(url);
      if (!decoded) throw new Error(`Invalid data URL: ${url.slice(0, 40)}`);
      return { body: decoded.body, mimeType: decoded.mimeType, encoding: decoded.charset, redirectedUrl: url };
    }
    if (url.startsWith('file:')) {
      const body = await readFile(fileURLToPath(url));
      return { body: new Uint8Array(body), redirectedUrl: url };
    }
    if (url.startsWith('http:') || url.startsWith('https:')) {
      const response = await fetch(url, {
        redirect: this.options.allowRedirects === false ? 'manual' : 'follow',
        headers: { 'User-Agent': 'WeasyPrint-TS' },
        signal: AbortSignal.timeout((this.options.timeout ?? 10) * 1000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      const body = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type');
      return {
        body, mimeType: contentType ? contentType.split(';')[0].trim() : null,
        encoding: /charset=([^;]+)/i.exec(contentType ?? '')?.[1] ?? null, redirectedUrl: response.url,
      };
    }
    throw new Error(`Unsupported URL scheme: ${url}`);
  }
}