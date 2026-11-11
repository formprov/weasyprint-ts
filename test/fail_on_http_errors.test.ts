// SPDX-License-Identifier: BSD-3-Clause

/** --fail-on-http-errors: upstream aborts rendering mid-flight (FatalURLFetchingError); otherwise the
 *  failed resource is logged and skipped. Plus -i/--info structure. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HTML } from '../src/html_document.ts';
import { renderDocument } from '../src/document.ts';
import { setLogSink, resetLogSink, LOGGER } from '../src/logger.ts';
import type { Fetcher } from '../src/fetch.ts';
import { infoText } from '../src/cli/main.ts';

class FakeFetcher implements Fetcher {
  failOnErrors: boolean;
  fatalError: Error | null = null;
  constructor(failOnErrors: boolean) { this.failOnErrors = failOnErrors; }

  async fetch(url: string): Promise<{ body: Uint8Array; mimeType?: string | null }> {
    if (url === 'https://evil.example/img.png') {
      const cause = new Error(`HTTP 404 for ${url}`);
      if (this.failOnErrors) this.fatalError = new Error(`Error fetching "${url}": ${cause.message}`);
      throw cause;
    }
    return { body: new Uint8Array() };
  }
}

const DOC = `<img src="https://evil.example/img.png"><p>text</p>`;

function captureLog(): string[] {
  const out: string[] = [];
  setLogSink((level, message) => { if (level === 'error') out.push(message); });
  return out;
}

test('with failOnErrors the render aborts mid-flight (upstream FatalURLFetchingError)', async () => {
  const html = new HTML(DOC, { baseUrl: null, fetcher: new FakeFetcher(true) });
  await assert.rejects(() => renderDocument(html, {}), /HTTP 404/);
});

test('without failOnErrors the failed image is logged and skipped', async () => {
  resetLogSink();
  const errors = captureLog();
  try {
    const html = new HTML(DOC, { baseUrl: null, fetcher: new FakeFetcher(false) });
    const document = await renderDocument(html, {});
    assert.equal(document.pages.length, 1);
    const failed = errors.filter((l) => l.includes("Failed to load image at 'https://evil.example/img.png'"));
    assert.equal(failed.length, 1, JSON.stringify(errors));
  } finally {
    resetLogSink();
  }
});

test('-i/--info mirrors the upstream structure', () => {
  const text = infoText();
  for (const line of ['System: ', 'Machine: ', 'Version: ', 'Release: ', '',
    'WeasyPrint version: 70.0', 'Node.js version: v', 'fontkit version: ']) {
    assert.ok(text.includes(line), JSON.stringify(text));
  }
  // Blank line between the OS block and the versions, as upstream prints.
  assert.match(text, /Release: \S*\n\nWeasyPrint version: /);
});
