# Option / CLI parity with upstream WeasyPrint

Source of truth: `reference_code/WeasyPrint/weasyprint/__main__.py` and `DEFAULT_OPTIONS` in `__init__.py`.
`--help` output is byte-identical to upstream (generated from argparse, COLUMNS=80).

| Upstream option | Port status | Notes |
|---|---|---|
| `-h/--help`, `--version` | ok | |
| `-i/--info` | ok (structure mirrors upstream: uname block + versions; lists Node.js/fontkit where upstream lists Python/Pydyf/Pango) |
| `-s/--stylesheet` | ok | |
| `-a/--attachment` | ok | |
| `--attachment-relationship` | ok | per-attachment AFRelationship in PDF/A-3+; verified against oracle |
| `--pdf-identifier` | ok | |
| `--pdf-variant` | ok | |
| `--pdf-version` | ok | |
| `--pdf-forms` | ok (text, password, textarea, checkbox, radio, select, submit; widget dictionaries verified against the oracle in the PDF-structure bank) | |
| `--pdf-tags` | ok | |
| `--uncompressed-pdf` | ok | |
| `--xmp-metadata` | ok | files spliced into the XMP packet; like upstream, only has an effect with `--pdf-variant`. Packet verified byte-identical to oracle for pdf/a-1b,2b,3u,4e,4f, pdf/ua-1, pdf/x-1a,3,4 |
| `--custom-metadata` | ok | |
| `--output-intent` | ok | |
| `-p/--presentational-hints` | ok | |
| `--optimize-images` | ok | |
| `-j/--jpeg-quality` | ok | |
| `-D/--dpi` | ok (PNG/GIF/BMP/TIFF/WebP and RGBA/LA byte-exact vs oracle; JPEG sizes exact, pixels differ slightly because Pillow's draft-mode DCT-scaled decode is not reproduced — tracked in weasy-vej) | |
| `--full-fonts` | ok | |
| `--hinting` | accepted, no effect | |
| `-c/--cache-folder` | accepted, no effect | output-neutral |
| `-e/--encoding`, `-m/--media-type`, `-u/--base-url` | ok | |
| `-t/--timeout` | ok | HTTP only, default 10 s |
| `--allowed-protocols` | ok | |
| `--no-http-redirects` | ok | |
| `--fail-on-http-errors` | ok (fetch failures abort rendering mid-flight with a logged error + exit 1, like upstream's FatalURLFetchingError) |
| `-v/-d/-q` | ok | |

Port-only: `--zoom`, `--ua-stylesheet` (harness).

## Python API audit (ticket weasy-d25)

Compared `weasyprint/__init__.py` and `document.py` with `src/index.ts`, `src/document.ts`, `src/html_document.ts`.

| Upstream API | Port status |
|---|---|
| `HTML(...)`, `HTML.from_url` (`fromUrl`), `base_url`, `media_type`, custom `url_fetcher` | ok (`fetcher` option) |
| `CSS(...)` | ok |
| `Document.pages`, `Document.metadata`, `Document.make_bookmark_tree` (`makeBookmarkTree`) | ok |
| `Page.paint` | ok |
| `Document.write_pdf(zoom, **options)` | ok; returns `Uint8Array` (no `target` file/path argument, no `finisher` callback) |
| `HTML.render(...)` / `HTML.write_pdf(...)` shortcuts | ok (`HTML.render(options)`, `HTML.writePdf(target, zoom, options)`; `target` is bytes-returning `null`, a `{ write(bytes) }` sink, or a path + `writeFile` hook; no `finisher`) |
| `Document.copy(pages)` | ok (`'all'` passes the same list object through, as upstream; pages from other documents combine) |
| `Attachment` class | ok (`new Attachment({ guess|filename|url|fileObj|string, baseUrl, fetcher }, { name, description, created, modified, relationship })`; exactly one source as upstream; lazy `fetch()`, `md5`; written via `options.attachments`. Positional-args Python form becomes an object in TS) |
| `DEFAULT_OPTIONS` | ok (`DEFAULT_OPTIONS` export, same keys in camelCase; unknown options warn like upstream) |
| `render(counter_style, color_profiles)` arguments | not exposed |
| `PDF forms`, `dpi`, `xmp_metadata`, `attachment_relationships` write options | xmp/relationships: CLI only; dpi/forms: see tickets weasy-0yb, weasy-ao3 |

Suggested follow-up for the missing rows: one ticket "API shortcuts: HTML.render/writePdf, Document.copy, Attachment, DEFAULT_OPTIONS" — done 2026-11-09 (weasy-aa2).

`parity/api_cli_parity.md` was retired 2026-11-09 (ticket weasy-1lk): it duplicated — and had drifted from — this table, which is the single source of truth.
