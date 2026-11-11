# Font-naming parity notes (PDF `BaseFont` / cache keying)

State as of 2026-11-07: ticket font names match the oracle (fonts A, overall A).
Write-up for whoever picks this up.

## What changed (uncommitted)

1. `src/pdf/stream.ts` — `addFont()` keys the document font cache by the Pango
   description string (`pangoDescriptionOf(face, style)`) instead of `face.id`,
   mirroring upstream `get_pango_font_key()` (description hashed with size/gravity
   unset). One face used under two requests yields two embedded subset fonts,
   like the oracle.
2. Same file — `pangoDescriptionOf()`:
   - description words come from the matched face's OS/2 attributes, except when
     Pango *synthesizes* bold/oblique, where the whole description is the request
     pattern;
   - **separator rule (new):** `,` after the family when Pango would emit one
     (see "Pango's comma rule" below), via `pangoFamilySeparator()`;
   - **word order (fixed):** weight, style, stretch (was weight, stretch, style).
3. `src/html_document.ts` — `@font-face` faces are registered with the font
   file's real `usWidthClass` (was hardcoded `width: 5`); fontconfig's scan of
   the file sets width, which is where ticket's `Barlow-Condensed,-Condensed`
   style word comes from.
4. `test/font_naming.test.ts` — new regression tests for the description rule.

## Pango's comma rule (resolved)

Evidence: `pango_font_description_to_string()` from the pinned image's libpango
1.57.1, called directly (ctypes) on descriptions built with `set_family` /
`set_weight` / `set_stretch` / `set_style`, and on the oracle's own `Font` objects
(monkeypatched `weasyprint.pdf.fonts.Font.__init__`, printing the description).

Pango emits `,` right after the family when either:

- the family's last whitespace-separated token is a Pango keyword
  (case-insensitive), with or without style words after it:
  `Foo Bold` → `Foo Bold,`; `Foo Bold` + Bold → `Foo Bold, Bold`;
  `Barlow Condensed` + Light Condensed → `Barlow Condensed, Light Condensed`.
  Keywords: Thin, Ultra-Light, Extra-Light, Light, Semi-Light, Book, Regular,
  Normal, Roman, Medium, Semi-Bold, Demi-Bold, Bold, Ultra-Bold, Extra-Bold,
  Heavy, Black, Ultra-Heavy, Ultra-Black, Oblique, Italic, Small-Caps,
  Ultra-Condensed, Extra-Condensed, Condensed, Semi-Condensed, Semi-Expanded,
  Expanded, Extra-Expanded, Ultra-Expanded.
- no words follow and the last token is a size Pango would read back:
  `2`, `2.`, `.5`, `1e3`, `12px`, `0` → comma; `2pt`, `2PX`, `2a`, `-2` → no comma.
  With words after it there is no comma: `Foo 2 Bold`, `Noto Sans Symbols 2 Bold`.

Otherwise no separator: `Noto Sans`, `Foo Bold Bar`, `Foo Bar2`, `Pacifico Bold`.

Ticket's case: `Noto Sans Symbols 2` (weight 400, normal stretch, normal style) →
`Noto Sans Symbols 2,`. Its fontconfig match is clean (`fc-match -v`: width 100,
weight 80, slant 0), and `set_family("Noto Sans Symbols 2")` alone reproduces the
comma, so the comma is not from fontconfig, an alias, or an empty family entry.
Its bold face (`Noto Sans Symbols 2 Bold`) has words, so no comma.

Previous hypotheses, now rejected: an empty second family in the fontconfig
pattern (the description holds one plain family); a fontconfig alias or conf.d
artifact (reproduced with a bare Pango description); a wordless non-normal stretch
(the face's stretch is 4 = NORMAL).

The rule is general: the same code path names any family whose last token is a
keyword or size, and it is not special-cased to `Noto Sans Symbols 2`.

PDF name derivation is unchanged: the oracle takes the description up to the first
` #` / ` @` (features/variations), replaces spaces with `-`, and keeps the comma.
`PdfFont` does the same (`descriptionName.replace(/ /g, '-')`).

## Naming rules derived earlier (still valid)

Container experiments (`exp.html`, `probe5.py`: dump `doc.fonts.items()` after
`write_pdf`; the page-draw step populates `doc.fonts`):

- `archivoblack-regular.ttf`: OS/2 weight **400**, width 5 (a *regular* family,
  despite the visual weight). The oracle names its single subset `ArchivoBlack`.
- Ticket's three Barlow files: weight 300/400/700, **width 3** each; described as
  `Barlow-Condensed,-Condensed`, `-Light-Condensed`, `-Bold-Condensed`.
- Synthetic bold keeps the **request's** description whole: `Pacifico` 700 over its
  400 face → `Pacifico-Bold`; the fallback `Noto-Sans-Symbols-2-Bold` behaves the
  same.
- No synthesis for weight requests below bold over a heavier face (500 over a 400
  face → plain name; 100 over a 400/900 face → plain name). Threshold in the port:
  request ≥ 700 over face < 700 (PANGO_WEIGHT_BOLD).
- `font-weight: lighter` (→100) never produces a `Thin` word.

Side effects of the prior state, all still in place:

- invoice: fonts A (per-style names match the oracle).
- report: phantom `Fira-Sans-Medium` gone.
- poster: phantom `ArchivoBlack-Thin` gone.

## Status

- ticket: font-name sets equal the oracle (`Barlow-Condensed,-Bold-Condensed`,
  `-Condensed`, `-Light-Condensed`, `Libre-Barcode`, `Noto-Sans-Symbols-2,`,
  `Noto-Sans-Symbols-2-Bold`); fonts A; overall A (0.00% pixels).
- Other samples: re-rendered the TS side into `/tmp` and compared per-page font-name
  sets with the cached oracle PDFs. Names are identical to the pre-change output for
  report, invoice, letter, poster, flyer, book and book-classical, so this change
  does not move their font grades.
- Viewer rebuilt with `run_samples.py --html-only`; `http://127.0.0.1:8735/side_by_side.html`
  serves the rebuilt file and shows ticket fonts A.

Board after this change (`run_samples.py --html-only`, cached PDFs): report D,
invoice C, ticket A, letter B, poster B, flyer B, book D, book-classical C.
Ticket moved from B to A. Other samples' grades are unchanged from the prior
board.

## Not covered

- `font-variant: small-caps` is not modeled (the port never sets a variant). Pango
  would append `Small-Caps` and the same keyword rule applies.
- The keyword and size lists are libpango 1.57 behavior. Other Pango versions may
  differ; re-probe if the pinned image changes.
- The size token regex is a model of Pango's behavior on the probed inputs, not
  a full `strtod` port.
- Nothing committed (authorization still pending).
