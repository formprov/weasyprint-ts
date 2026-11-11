# NOTICE

## weasyprint-ts

This project is a TypeScript port of WeasyPrint, the Python HTML/CSS rendering
engine by Kozea and contributors.

* Upstream project: https://github.com/Kozea/WeasyPrint
* Upstream version ported: 70.0 (source kept in `../WeasyPrint/` in the
  comparison-tool workspace for reference)
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
and documented Pango semantics; it is covered by this repository's MIT license
only. Any future backend that links an LGPL library (for example a HarfBuzz
WASM build) must be wired through the pluggable `TextEngine` interface
(`src/text/engine.ts`) as a separately licensed, optional package.

## Fonts

This package SHIPS two OFL-licensed Noto Sans faces (`fonts/NotoSans-*.ttf`)
as the guaranteed rendering baseline; they are redistributed under the
SIL Open Font License 1.1 (see `fonts/OFL.txt`), which expressly permits it.

The Microsoft core fonts used by the parity corpus are NOT part of this
project, are NOT covered by its license, and must never be committed to or
redistributed with this repository. They are provided by the local
environment only; see `fonts/prod/SHA256SUMS` in the comparison-tool
workspace for the frozen environment manifest. `fonts/prod` is excluded
from version control by `.gitignore`.
