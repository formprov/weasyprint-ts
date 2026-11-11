// SPDX-License-Identifier: BSD-3-Clause

/**
 * IO abstraction mirroring WeasyPrint's url_fetcher (weasyprint/urls.py).
 * The core never touches the filesystem or network directly (see issue weasy-hdv.8).
 */
export interface FetchResult {
  body: Uint8Array;
  mimeType?: string | null;
  encoding?: string | null;
  redirectedUrl?: string | null;
}

export interface Fetcher {
  fetch(url: string): Promise<FetchResult>;
}