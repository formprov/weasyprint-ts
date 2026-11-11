// SPDX-License-Identifier: BSD-3-Clause

/** Public API shortcuts (Python parity: HTML.render/write_pdf, Document.copy, Attachment, DEFAULT_OPTIONS). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HTML, DEFAULT_OPTIONS, checkUnknownOptions } from '../src/index.ts';
import { renderDocument, Document } from '../src/document.ts';
import { Attachment } from '../src/pdf/attachments.ts';
import { setLogSink, resetLogSink } from '../src/logger.ts';
import type { Level } from '../src/logger.ts';

const DOC = '<h1>API shortcuts</h1><p>Body.</p>';

function makeHtml(): HTML {
  return new HTML(DOC, { baseUrl: null, fetcher: { fetch: async () => ({ body: new Uint8Array() }) } });
}

function pdfPageCount(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  const matches = [...text.matchAll(/\/Type \/Page[^s]/g)];
  return matches.length;
}

test('HTML.render returns pages like renderDocument', async () => {
  const document = await makeHtml().render();
  assert.ok(document instanceof Document);
  assert.equal(document.pages.length, 1);
  const direct = await renderDocument(makeHtml(), {});
  assert.equal(document.pages.length, direct.pages.length);
});

test('HTML.writePdf without a target returns the PDF bytes; unknown options warn', async () => {
  const logs: Array<{ level: Level; message: string }> = [];
  setLogSink((level, message) => logs.push({ level, message }));
  try {
    const bytes = await makeHtml().writePdf(null, 1, { uncompressedPdf: true, nonsenseOption: 'x' });
    assert.ok(bytes!.length > 1000);
    assert.ok(pdfPageCount(bytes!) === 1);
    const unknown = logs.filter((l) => l.level === 'error' && l.message.includes('Unknown rendering option: nonsenseOption.'));
    assert.equal(unknown.length, 1, JSON.stringify(logs));
  } finally {
    resetLogSink();
  }
});

test('unknown options are reported by checkUnknownOptions for all routes', () => {
  const warned: string[] = [];
  setLogSink((_level, message) => warned.push(message));
  try {
    checkUnknownOptions({ pdfTags: true, bogus: 1 });
    assert.deepEqual(warned.filter((w) => w.includes('Unknown rendering option')), ['Unknown rendering option: bogus.']);
  } finally {
    resetLogSink();
  }
});

test('writePdf target accepts a write() sink', async () => {
  const chunks: Uint8Array[] = [];
  const result = await makeHtml().writePdf({ write: (bytes) => chunks.push(bytes) }, 1, { uncompressedPdf: true });
  assert.equal(result, null);
  assert.equal(chunks.length, 1);
  assert.ok(pdfPageCount(chunks[0]) === 1);
});

test('writePdf target path without a writeFile hook raises', async () => {
  await assert.rejects(() => makeHtml().writePdf('out.pdf'), /no writeFile option/);
});

test('writePdf target path with a writeFile hook writes and returns null', async () => {
  const written = new Map<string, Uint8Array>();
  const result = await makeHtml().writePdf('out/path.pdf', 1, { uncompressedPdf: true,
    writeFile: (path, bytes) => void written.set(path, bytes),
  });
  assert.equal(result, null);
  assert.ok(written.has('out/path.pdf'));
  assert.ok(pdfPageCount(written.get('out/path.pdf')!) === 1);
});

test('Document.copy takes a page subset and combines documents', async () => {
  const docA = await new HTML('<h1>A</h1>', { baseUrl: null, fetcher: { fetch: async () => ({ body: new Uint8Array() }) } }).render();
  const docB = await new HTML('<h1>B</h1>', { baseUrl: null, fetcher: { fetch: async () => ({ body: new Uint8Array() }) } }).render();
  assert.equal(docA.copy('all').pages, docA.pages); // same array object, like upstream's pages list
  const odd = docA.copy([docA.pages[0]]);
  assert.equal(odd.pages.length, 1);
  assert.equal(odd.pages[0], docA.pages[0]);
  assert.equal(odd.metadata, docA.metadata);
  const combined = docA.copy([docA.pages[0], docB.pages[0]]);
  assert.equal(combined.pages.length, 2);
  const bytes = combined.writePdf({ uncompressedPdf: true });
  assert.equal(pdfPageCount(bytes), 2);
});

test('Attachment sources: basic source types use one-of validation', () => {
  assert.throws(() => new Attachment({}, {}, null), /exactly one attachment source/);
  assert.throws(() => new Attachment({ string: 'a', url: 'data:,' }, {}, null), /exactly one attachment source/);
});

test('Attachment from literal bytes: name/description land in the PDF', async () => {
  const body = new TextEncoder().encode('attached text');
  const created = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
  const attachment = new Attachment({ string: 'attached text' }, {
    name: 'notes.txt', description: 'doc notes', created, relationship: 'Source',
  });
  await attachment.fetch();
  assert.match(attachment.md5!, /^[0-9a-f]{32}$/);
  const bytes = await makeHtml().writePdf(null, 1, { uncompressedPdf: true, attachments: [attachment] as any });
  const text = new TextDecoder('latin1').decode(bytes!);
  assert.ok(text.includes('/Type /EmbeddedFile'), 'embedded file stream');
  assert.ok(text.includes('/UF (notes.txt)'), 'filename from name');
  assert.ok(text.includes('(doc notes)'), 'description');
  assert.ok(text.includes('D:20200102030405Z'), 'created date written as Params/CreationDate');
  assert.ok(text.includes('attached text'), 'literal bytes embedded');
  assert.equal(pdfPageCount(bytes!), 1);
});

test('Attachment guessing: an absolute URL fetches through the fetcher', async () => {
  const fetcher = {
    fetch: async (url: string) => {
      assert.equal(url, 'data:text/plain;base64,SGVsbG8=');
      return { body: new TextEncoder().encode('Hello'), mimeType: 'text/plain' };
    },
  };
  const attachment = new Attachment({ guess: 'data:text/plain;base64,SGVsbG8=' }, {}, fetcher);
  const ok = await attachment.fetch();
  assert.ok(ok);
  assert.deepEqual(attachment.body, new TextEncoder().encode('Hello'));
  assert.equal(attachment.mimeType, 'text/plain');
  assert.match(attachment.md5!, /^[0-9a-f]{32}$/);
  const bytes = await makeHtml().writePdf(null, 1, { uncompressedPdf: true, attachments: [attachment] as any });
  assert.ok(pdfPageCount(bytes!) === 1);
});

test('a failed Attachment fetch is logged and skipped, like upstream', async () => {
  const logs: Array<{ level: Level; message: string }> = [];
  setLogSink((level, message) => logs.push({ level, message }));
  try {
    const attachment = new Attachment({ url: 'https://invalid.example/x.pdf' }, {}, {
      fetch: async () => { throw new Error('boom'); },
    });
    const bytes = await makeHtml().writePdf(null, 1, { uncompressedPdf: true, attachments: [attachment] as any });
    assert.ok(pdfPageCount(bytes!) === 1);
    assert.ok(logs.some((l) => l.level === 'error' && l.message.includes('Failed to load attachment: boom')), JSON.stringify(logs));
  } finally {
    resetLogSink();
  }
});

test('DEFAULT_OPTIONS mirrors upstream keys and values', () => {
  assert.equal(DEFAULT_OPTIONS.pdfTags, false);
  assert.equal(DEFAULT_OPTIONS.uncompressedPdf, false);
  assert.equal(DEFAULT_OPTIONS.optimizeImages, false);
  assert.equal(DEFAULT_OPTIONS.pdfForms, null);
  assert.equal(DEFAULT_OPTIONS.customMetadata, false);
  assert.equal(DEFAULT_OPTIONS.hinting, false);
});
