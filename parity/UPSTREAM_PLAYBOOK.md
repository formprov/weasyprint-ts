# Upstream parity playbook

Goal: the port's PDF output matches the **oracle** — Python WeasyPrint 70.0 in the pinned image
`weasy-alpine-prod:latest` — on every case we can extract from upstream's own tests, plus the official
samples and the repo corpus. "Match" means: same page count and page sizes, and **zero differing pixels**
when both PDFs are rasterized with Ghostscript at 96 dpi.

Every ticket under epic *Upstream oracle parity* points here. Read this file once, then work your ticket.

## Ground rules (non-negotiable)

1. **Match the oracle, not your idea of correct.** The oracle is the spec. If upstream behaves oddly, so do we.
2. **Port, don't invent.** Each TS file mirrors an upstream Python file (table in `UPSTREAM.md`; the upstream source
   is `weasyprint/` in a v70.0 checkout). Translate the Python function by function, keep names (snake_case ->
   camelCase), keep order of operations, keep every "TODO" comment. Behavior you can't explain is usually a detail
   you skipped.
3. **Never change a grader or loosen a threshold to make something pass.** Do not edit `parity/run_samples.py` grading,
   the `0 differing pixels` rule, or case HTML. Fix the port.
4. **`src/` is TypeScript/JavaScript only.** No WASM, no native modules, no Python at runtime. A new npm dependency
   needs the user's approval (write it in the ticket and stop).
5. **Do not commit or push** unless the user asks. Do not leave debug code behind (see "Instrumenting" below).
6. Use `br` for tickets (`br show ID`, `br comments add ID -m '...'`, `br close ID -r '...'`). After mutating run
   `br sync --flush-only`.

## Environment

All commands run from `weasyprint-ts/` unless stated. Prerequisites: Docker (image `weasy-alpine-prod:latest`, built
from `parity/docker/` on first use), Ghostscript (`gs`), qpdf, poppler (`pdftotext`, `pdffonts`), mupdf (`mutool`),
Node 22.18+, and Python with Pillow. `UPSTREAM_DIR` names the v70.0 checkout the bank generators read.

| What | Command |
|---|---|
| Render one file with the port | `FONT_DIR=~/.cache/weasy-parity/oracle-fonts node src/cli/main.ts in.html out.pdf` |
| Render one file with the oracle | `docker run --rm -v "$PWD/parity/upstream-cases:/w:ro" -v /tmp:/out weasy-alpine-prod:latest /venv/bin/python -m weasyprint /w/CASE.html /out/CASE_py.pdf` |
| Extract cases from upstream tests | `python3 parity/extract_upstream.py "$UPSTREAM_DIR/tests" parity/upstream-cases` |
| Run cases (summary) | `python3 parity/upstream_diff.py parity/upstream-cases --pattern 'REGEX'` |
| ... and list failures | add `--list` |
| Full run + regression guard | `python3 parity/upstream_diff.py parity/upstream-cases --baseline parity/upstream-baseline.json` (exit 1 on regression) |
| Refresh baseline (FULL run only, after your cases pass) | add `--update-baseline` |
| Official samples (must stay all **A**) | `python3 parity/run_samples.py` (writes the viewer at `parity/samples-out/out/side_by_side.html`) |
| Unit/parity tests | `npm test` (all pass) |
| Typecheck | `npx tsc --noEmit -p tsconfig.json` (clean; do not add errors) |

Case names look like `AREA__FILE__TEST__N` (e.g. `layout__layout_test_grid__test_grid_single_item__1`); `--pattern`
is a regex searched in that name. Failing pixel cases leave `parity/upstream-out/diff/NAME.png`
(oracle | port | diff, magnified) — **look at it first** (the Read tool shows images).

The cases are *inputs only*: upstream's own expected pixels are not used, the oracle is. Cases are run with
upstream's `tests_ua.css` linked as an author stylesheet and its `weasyprint.otf` square-glyph test font.

## The loop for one ticket

1. `br show ID`; run the ticket's pattern with `--list` to get the failing set; record counts in a comment.
2. Pick one failing case. Read its HTML (`parity/upstream-cases/CASE.html`) and the *upstream test* it came from
   (`tests/<area>/test_*.py` in the upstream checkout, find by test name) to learn what it is meant to exercise.
3. Reproduce, view the diff image, then localize: layout (box positions) vs draw (operators) vs shaping (glyphs).
4. Find the upstream Python code path; compare with the TS. Fix the *first* divergence, re-run the case. Repeat.
5. Run the whole ticket pattern, then the full run with `--baseline` (no regressions), then `run_samples.py`
   (all A) and `npm test` / `tsc` (no new failures).
6. `--update-baseline`, comment on the ticket with before/after counts, close it. Split off new tickets for
   leftovers instead of leaving a half-finished one open.

## Localizing a mismatch

* **Page count / sizes**: `qpdf --show-npages x.pdf`; `pdfinfo`.
* **Text**: `pdftotext -bbox -f P -l P x.pdf -` gives word boxes; `mutool trace x.pdf P` gives *per-glyph* positions
  and glyph ids (best tool for shaping/spacing/justification differences). Compare TS vs oracle with a small script.
* **Drawing operators**: `qpdf --qdf --object-streams=disable x.pdf out.qdf` then diff the content streams.
  Operator order matters for anti-aliased overlaps; equal-looking paths with different `c`/`v`/`y` operators are bugs.
* **Images**: `pdfimages -list`; extract with `pdfimages -png`; compare decoded pixels, not bytes.
* **Pixels**: compare at 96 dpi with Ghostscript exactly as `upstream_diff.py` does.

## Instrumenting the oracle (Python) without rebuilding anything

Write a small script that monkeypatches the module, then runs `weasyprint.__main__.main()`; mount it into the container:

```python
import weasyprint.layout.inline as li          # patch the name in the module that IMPORTS it
orig = li.split_first_line
def w(*a, **k):
    r = orig(*a, **k); print('SFL', a[0][:40], a[3], r[1:4], flush=True); return r
li.split_first_line = w
import sys; sys.argv = ['weasyprint', '/w/case.html', '/out/x.pdf']
from weasyprint.__main__ import main; main()
```

`docker run --rm -v CASEDIR:/w:ro -v /tmp:/out -v /path/trace.py:/t.py:ro weasy-alpine-prod:latest /venv/bin/python /t.py`

To print inside a function body, copy the upstream module out of the image
(`docker run --rm IMAGE cat /venv/lib/python3.14/site-packages/weasyprint/PATH.py > /tmp/mod.py`), edit the copy, and mount it
over the original with `-v /tmp/mod.py:/venv/lib/python3.14/site-packages/weasyprint/PATH.py:ro`.
Pango/fontconfig facts you can query directly: `weasyprint.text.line_break.get_log_attrs`, `get_next_word_boundaries`,
`pyphen.Pyphen(lang='fr').positions(word)`.

## Instrumenting the port (TypeScript) safely

Back the file up, add `if (process.env.DBG_LB) console.error(...)`, run, **restore**:

```sh
/bin/cp -f src/layout/flex.ts /tmp/flex.bak     # NOTE: plain `cp` is aliased to interactive mode here — use /bin/cp -f
... edit, run ...
/bin/cp -f /tmp/flex.bak src/layout/flex.ts && cmp src/layout/flex.ts /tmp/flex.bak
grep -rn "DBG" src                               # must print nothing before you finish
```

Edit files with a Python/`sed -i ''` (macOS syntax) script or your editor; run commands from `weasyprint-ts/`.

## Mismatch classes we have already met (look for the same shapes)

* **Stale state across layout passes**: the port re-lays-out when images load (`renderDocument` loops); anything cached
  across passes (target counters, anchors, ...) must be reset (`TargetCollector.reset()`).
* **Shared mutable boxes**: `copy()` is shallow; children arrays are shared.
* **Pango rules, not Unicode rules**: trailing spaces count when deciding if a word fits; each spaced character gets its
  own letter-spacing attribute which *splits shaping runs* (no kerning across a justified space); letter-spacing that is a
  whole number of pixels puts the whole spacing before the glyph; word boundaries stop at `'` `’` `.` `:` `·` `_` U+202F.
* **fontkit vs HarfBuzz**: fontkit registers `frac/numr/dnom` as local features and ignores user requests
  (patched in `src/text/shaper.ts`); verify any OpenType feature with `mutool trace` glyph ids.
* **Lookup by identity**: list lookups, sorts, and dict keys written with arrays/objects compare differently in JS
  (`a[0] - b[0]` on arrays is NaN). Port comparisons faithfully.
* **Defaults**: SVG initial fill is black; CSS initial values come from upstream's `properties.py`.
* **Rounding**: Pango units are integers (1/1024 px); truncation (`int()`) vs rounding matters at 1/1024 px and shows up
  as 1px shifts after justification.

* **Embedded font subset differences**: Ghostscript auto-hints from the font's `cmap`; hb-subset writes a reduced cmap (src/pdf/subset.ts `subsetCmap` mirrors it). If a text-only case differs by a few AA pixels and glyph positions (`mutool trace`) are identical, suspect a font table: extract both embedded fonts (`mutool extract`), swap ONE table (cmap, name, OS/2, post, head...) with fontTools, rebuild the PDF and rasterize; the table whose swap gives 0 px is the culprit. Do not trust a diff image for a layout diagnosis when the glyph positions agree.
* **Excluded cases**: parity/upstream-excluded.json lists cases where the ORACLE itself errors; never try to match those.

## Reporting

Comment on the ticket when you start (counts), when you hit a decision that needs the user (state options, stop), and
when you finish (before/after counts, files touched). Include the exact commands you ran.
