# Upstream tracking

This is a port of WeasyPrint (https://github.com/Kozea/WeasyPrint, BSD-3-Clause).
Each TypeScript file mirrors an upstream Python file so changes can be diffed
and re-applied. Ported from tag **v70.0**.

| TypeScript | Upstream (v70.0) | Status |
|---|---|---|
| src/css/parser.ts | tinycss2 (dependency) | CSS Syntax 3 tokenizer/parser, from the spec |
| src/css/color.ts, color_names.ts | tinycss2.color3/color5 | sRGB only (no lab/oklch/color()) |
| src/css/tokens.ts | weasyprint/css/tokens.py, functions.py | |
| src/css/units.ts | weasyprint/css/units.py | |
| src/css/properties.ts | weasyprint/css/properties.py | complete |
| src/css/validation/properties.ts | weasyprint/css/validation/properties.py | |
| src/css/validation/expanders.ts | weasyprint/css/validation/expanders.py | grid shorthands ported; border-image shorthand and mask-border not yet |
| src/css/validation/index.ts | weasyprint/css/validation/__init__.py | |
| src/css/computed_values.ts | weasyprint/css/computed_values.py | |
| src/css/style.ts | weasyprint/css/__init__.py (Style classes) | |
| src/css/index.ts | weasyprint/css/__init__.py | |
| src/css/selectors.ts | cssselect2 (dependency) | subset |
| src/html_document.ts | weasyprint/__init__.py (HTML) | |
| src/dom.ts | tinyhtml5 + ElementTree (parse5-based) | |

CSS UA stylesheets (src/css/html5_*_css.ts) are generated verbatim from upstream.
