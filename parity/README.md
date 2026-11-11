# Parity tooling

Compare this port against Python WeasyPrint on your own documents, or on the
repo's corpus, down to the pixel.

## Prerequisites

- **Docker** (recommended): every script can run the Python side in the pinned
  `weasy-alpine-prod` image built from `docker/alpine-prod-Dockerfile`. That
  fixes Pango, HarfBuzz, fontconfig and the font set, which is what makes a
  pixel comparison meaningful.
- **Python WeasyPrint 70** (`pip install weasyprint==70.0`) if you would rather
  run the reference engine locally than in Docker.
- **Python 3.10+** to run the scripts in this directory.
- **Ghostscript**: rasterizes both PDFs for the pixel comparison.
- **qpdf**: page counts.
- **Node 22.18+**: runs this port directly from TypeScript.

## Quick start

```sh
# Build the oracle once (a few minutes). The scripts do this for you if the
# image is missing, but doing it now makes the first run quiet.
docker build -t weasy-alpine-prod -f parity/docker/alpine-prod-Dockerfile parity/docker

# One document: both engines, both PDFs kept, an HTML report with the pages
# side by side and a pixel-diff badge.
python3 parity/side_by_side.py examples/flyer.html --docker
open examples/sbs-flyer/side_by_side.html

# The repo corpus: page counts, pixels, and layout box trees.
python3 parity/diffrun.py test/corpus --docker --layout

# The acceptance page: 8 official samples + the repo corpus.
python3 parity/acceptance.py --docker
open parity/acceptance-out/index.html
```

`side_by_side.py` writes the raw renders next to the report, for example
`examples/sbs-flyer/flyer/python.pdf` and `typescript.pdf`. Those are the files
to open in a viewer, run `pdftotext` on, or compare with any PDF tool.

## The corpus

`../test/corpus/` holds small documents (text, tables, layout effects,
multipage) and `../test/expected/` their reference PDFs, rendered with
OFL-licensed fonts (`../test/fonts/`). The npm test suite runs this corpus
automatically; the tools below work on any documents you supply.

## Differential runs over a corpus

```sh
python3 parity/diffrun.py test/corpus --docker --layout
```

Renders every document with both engines and compares page counts, layout
box trees (`--layout`), and pixels (Ghostscript, threshold 0). Writes a
markdown report with the first divergence per failing document.

Both engines are pinned to byte-identical font files so glyphs never drift:
the corpus's own `fonts/` when it ships one, otherwise the pinned image's
font set (extracted on demand to `~/.cache/weasy-parity/oracle-fonts`, keyed
by the image id). An unpinned fallback (for example a host with no plain
"Noto Serif") fabricates pixel diffs entirely from font resolution. Opt out
with `--no-font-pin`.

For a corpus with its own fonts, diffrun mounts the font directory and a
bare `<dir>`-only fontconfig into the oracle container and derives the port's
font *profile* from that same fontconfig (`fc-match` for the generic families,
the per-family `fc-match --sort` order, and the fallback list) via
`FONT_PROFILE`. Without the profile the two engines disagree on generics and
on the family that serves a missing glyph (margin boxes that never name a
family, Hebrew falling back to Times New Roman vs Arial). Corpora without
local fonts use the image's own font set on both sides, so the port keeps
`profiles/alpine_prod.json` and the oracle keeps its default fontconfig.

Useful flags:

- `--stylesheet style.css`: user stylesheet passed to both engines
- `--docker`: render the Python side inside the pinned image (the default
  recommendation; the image is built on first use)
- `--python-cmd 'python3 -m weasyprint'`: how to invoke Python WeasyPrint
  locally (default: `weasyprint` on PATH)
- `--limit N`: first N documents only

## The acceptance page

```sh
python3 parity/acceptance.py --docker
```

Builds one `parity/acceptance-out/index.html` with two groups: the official
WeasyPrint samples and this repo's own corpus, each document showing the
Python WeasyPrint render next to the port's, page by page, with a
pixel-parity badge. The samples always use the pinned image; `--docker` also
runs the repo corpus there. Without it, the corpus uses a local
`weasyprint` install. This is the human acceptance round: open the page, read
the badges, and flip through the pages.

## Side-by-side renders for a single document

```sh
python3 parity/side_by_side.py mydoc.html --docker -s mystyle.css
```

Writes `sbs-mydoc/side_by_side.html` (the per-document PDFs and PNGs live
under `sbs-mydoc/mydoc/`): the two engines' page renders side by side, each
with a pixel-diff badge, full-resolution PNGs one click away. Works on a
directory of documents too. Without `--docker` the Python side is your local
`weasyprint`; with it, the pinned image and its fonts.

### Optional third column: Paged.js

```sh
cd parity/pagedjs && npm install && cd ../..
python3 parity/side_by_side.py examples/flyer.html --docker --pagedjs
```

The Paged.js column is informational. It renders the document in headless
Chromium through the Paged.js polyfill and shows the result beside both
WeasyPrint engines; the TS badge still decides pass/fail. The runner pins
fonts from `FONT_DIR`, applies the WeasyPrint 70 quirk shims described in the
README score table, and honours `CHROMIUM_PATH` (otherwise it uses the
Chromium that `npm install` downloaded) and `CALIBRATE=<oracle layout dump>`.

## The upstream banks

The static and dynamic banks under `upstream-cases*` are scored with:

```sh
python3 parity/upstream_diff.py parity/upstream-cases --baseline parity/upstream-baseline.json
python3 parity/pdf_struct_diff.py parity/upstream-cases-pdfstruct
```

Regenerating cases needs a checkout of upstream's own test suite, because the
oracle renders through upstream's `tests.testing_utils.FakeHTML`:

```sh
git clone --depth 1 --branch v70.0 https://github.com/Kozea/WeasyPrint ../reference_code/WeasyPrint
# or point UPSTREAM_DIR at an existing checkout:
export UPSTREAM_DIR=/path/to/WeasyPrint
python3 parity/extract_upstream.py "$UPSTREAM_DIR/tests" parity/upstream-cases
```

## A note on what "identical" requires

The Python side must run in the same environment you're comparing against.
Font differences (Pango/fontconfig resolving to different font files) and
engine version differences show up immediately as pixel diffs. For
reproducible parity, pin the environment: use `--docker`, or set
`FONTCONFIG_FILE` to a configuration pointing at the same font files the
port uses (`FONT_DIR`).
