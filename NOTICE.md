# NOTICE

## weasyprint-ts

This project is a TypeScript port of WeasyPrint, the Python HTML/CSS rendering
engine by Kozea and contributors.

* Upstream project: https://github.com/Kozea/WeasyPrint
* Upstream version ported: 70.0 (see `UPSTREAM.md`)
* Upstream license: BSD-3-Clause. This port is distributed under the same
  BSD-3-Clause license (see `LICENSE`); the natural choice for a file-by-file
  derivative work, and the one upstream's own terms permit with the fewest
  conditions. Files generated from upstream data (for example the user-agent
  stylesheet in `src/css/html5_ua_css.ts`) carry their BSD-3-Clause
  provenance notes.
* Module docstrings reference the corresponding upstream file (e.g.
  "mirrors weasyprint/layout/block.py") to make review and upstream tracking
  easy.

## Pango (LGPL): not translated

WeasyPrint depends on Pango (LGPL) and HarfBuzz for text layout. Pango C code
has deliberately NOT been translated into this codebase. The TypeScript text
stack (`src/text/`, shaping-related code in `src/layout/`) is a clean-room
reimplementation from observed behavior, public CSS/OpenType specifications,
and documented Pango semantics; it is covered by this repository's BSD-3-Clause
license only. Any future backend that links an LGPL library (for example a HarfBuzz
WASM build) must be wired through the pluggable `TextEngine` interface
(`src/text/engine.ts`) as a separately licensed, optional package.

## Fonts

The published package ships no fonts. The only fonts in the repository are two OFL-licensed Noto Sans faces in `test/fonts/`, used by the test corpus and redistributed under the SIL Open Font License 1.1 (see `test/fonts/OFL.txt`), which expressly permits it.

The fonts used by the parity oracle (the pinned Docker image's font set, including Microsoft core fonts) are NOT part of this project, are NOT covered by its license, and must never be committed to or redistributed with this repository. They are extracted from the image on demand to a local cache (see `parity/README.md`).
