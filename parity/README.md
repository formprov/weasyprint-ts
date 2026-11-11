# Parity tooling

Compare this port against Python WeasyPrint on your own documents, or on the
repo's corpus — down to the pixel.

## Prerequisites

- **Python WeasyPrint 70** (`pip install weasyprint==70.0`) — the reference
  engine. For the *pinned production* environment, use the Docker images in
  `docker/` (they fix Pango/HarfBuzz/FontConfig and the font set).
- **Ghostscript** — rasterizes both PDFs for the pixel comparison.
- **qpdf** — page counts.
- Node 26+ — runs this port directly.

## The corpus

`../test/corpus/` holds small documents (text, tables, layout effects,
multipage) and `../test/expected/` their reference PDFs, rendered with
OFL-licensed fonts (`../test/fonts/`). The npm test suite runs this corpus
automatically; the tools below work on any documents you supply.

## Differential runs over a corpus

```sh
python3 parity/diffrun.py test/corpus --layout
```

Renders every document with both engines and compares page counts, layout
box trees (`--layout`), and pixels (Ghostscript, threshold 0). Writes a
markdown report with the first divergence per failing document.

Both engines are pinned to byte-identical font files so glyphs never drift:
the corpus's own `fonts/` when it ships one, otherwise the pinned image's
font set (extracted on demand to `~/.cache/weasy-parity/oracle-fonts`, keyed
by the image id). An unpinned fallback — e.g. a host with no plain
"Noto Serif" — fabricates pixel diffs entirely from font resolution. Opt out
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

- `--stylesheet style.css` — user stylesheet passed to both engines
- `--python-cmd 'python3 -m weasyprint'` — how to invoke Python WeasyPrint
  (default: `weasyprint` on PATH)
- `--docker` — render the Python side inside the pinned production image
  (build it first: `docker build -t weasy-alpine-prod -f parity/docker/alpine-prod-Dockerfile .`)
- `--limit N` — first N documents only

## The acceptance page

```sh
python3 parity/acceptance.py            # 8 official samples + test/corpus, side by side
```

Builds one `parity/acceptance-out/index.html` with two groups — the official
WeasyPrint samples and this repo's own corpus — each document showing the
Python WeasyPrint render next to the port's, page by page, with a
pixel-parity badge. The samples use the pinned image's fonts for both
engines; the corpus pins `test/fonts` for both. This is the human acceptance
round: open the page, read the badges, and flip through the pages.

## Side-by-side renders for a single document

```sh
python3 parity/side_by_side.py mydoc.html -s mystyle.css
```

Writes `sbs-mydoc/mydoc/side_by_side.html`: the two engines' page renders
side by side, each with a pixel-diff badge, full-resolution PNGs one click
away. Works on a directory of documents too.

### A note on what "identical" requires

The Python side must run in the same environment you're comparing against.
Font differences (Pango/fontconfig resolving to different font files) and
engine version differences show up immediately as pixel diffs. For
reproducible parity, pin the environment: use `--docker`, or set
`FONTCONFIG_FILE` to a configuration pointing at the same font files the
port uses (`FONT_DIR`).
