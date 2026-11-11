# Contributing

Thanks for helping! This port has one unusual prime directive, and everything
else follows from it.

## The prime directive: parity is the spec

The goal is to render **exactly** what WeasyPrint 70 renders — including its
bugs. When a document renders differently, the question is never "what does
the CSS spec say" but "what does WeasyPrint 70 do, and why". We replicate
upstream behavior deliberately: WeasyPrint 70 ignores `@page :not(:first)`,
drops `filter:` with a warning, formats floats like pydyf does, and shapes
text with Pango/HarfBuzz semantics. If upstream changes behavior in a newer
version, that's a versioned change of this port, not a bug to fix early.

Every module mirrors an upstream Python file one-to-one (each docstring
names its upstream counterpart — see `UPSTREAM.md`). Keep that mapping:
reviewable diffs against upstream are how this port stays correct as both
codebases evolve.

## Ground rules

- **Runtime-agnostic core**: no `node:*` imports (or Node globals) outside
  `src/cli/` — all IO goes through the `Fetcher`/`FontSource`/log-sink
  interfaces. `npm test` enforces this; CI runs it.
- **Sync core, async edges**: like upstream, layout is synchronous. Fetch
  HTML/images/fonts up front (see `renderDocument`'s fetch loop), never
  inside layout.
- **Naming**: style keys snake_case (`style.get('margin_top')`), box
  attributes camelCase (`box.marginTop`) — matching upstream so diffs read
  naturally.
- **No fonts in the repo** (licensing — see `NOTICE.md`). The one exception
  is `test/fonts/`: OFL-licensed Noto Sans, shipped with its license for the
  parity corpus.

## Setup

```sh
npm install
npx tsc --noEmit     # must be clean
npm test             # includes the parity corpus (skips gracefully without ghostscript)
```

Requires Node 26+ (the source runs directly via type stripping).

## The parity corpus

`test/corpus/` contains small documents; `test/expected/` their reference
PDFs rendered by Python WeasyPrint 70 in the pinned environment. The parity
test renders each document with this port, rasterizes both PDFs with
Ghostscript, and requires **zero differing pixels**.

If your change alters rendering:

1. Run the corpus. If everything still passes and you intended a rendering
   change, that's a red flag — parity changed, so it needs an upstream
   justification in the commit message.
2. If you're *fixing* a gap (e.g. complex-script shaping), add a corpus
   document that demonstrates the fix and regenerate its expected PDF with
   the reference environment (documented in the comparison-tool workspace).

## Pull requests

- One behavior change per PR, with a corpus document or unit test.
- Describe the upstream behavior you're matching (file + line in the
  WeasyPrint checkout is ideal).
- Keep the module-mirroring docstrings updated when renaming/moving.

## Reporting rendering differences

Documents that render differently are the most valuable contributions. Open
an issue with the (self-contained, non-confidential) HTML + CSS, the expected
output, and the actual output — screenshots or PDFs both help.
