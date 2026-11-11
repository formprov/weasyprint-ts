# SPDX-License-Identifier: BSD-3-Clause

"""One-page acceptance report: the official WeasyPrint samples *and* this
repo's own corpus, rendered by Python WeasyPrint and by this port side by side.

The point of the page is the human acceptance round: every document gets its
pages rasterized at the same dpi and a badge that says whether the port is
pixel-identical. Both engines see byte-identical fonts:

  * official samples: the pinned image renders them and its exact font files
    are extracted for the port (parity/run_samples.py's machinery);
  * repo corpus: test/fonts for both engines, with a fontconfig derived from
    that directory (parity/diffrun.py's pin).

Usage:
  python3 parity/acceptance.py [-o OUT_DIR] [--samples a b ...] [--no-pagedjs]

The report is written to parity/acceptance-out/index.html (gitignored); the
generator, the corpus and the samples are all part of the repo, so anyone can
reproduce the page. Requires Docker for the oracle, Ghostscript and qpdf.
"""
import argparse
import html
import os
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / 'parity'))

from run_samples import IMAGE, SAMPLES, ensure_image, ensure_samples, extract_image_fonts  # noqa: E402
import diffrun  # noqa: E402
from side_by_side import fontconf_env, page_diff, to_png  # noqa: E402


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def render_sample_python(clone: Path, out: Path, args: list, name: str) -> subprocess.CompletedProcess:
    return run(['docker', 'run', '--rm', '-v', f'{clone}:{clone}:ro', '-v', f'{out.resolve()}:/out',
                IMAGE, '/venv/bin/python', '-m', 'weasyprint'] +
               [a if a.startswith('-') else (a if a.startswith('/') else f'{clone}/{a}') for a in args] +
               [f'/out/{name}_py.pdf'])


def render_sample_ts(clone: Path, out: Path, args: list, name: str, env: dict) -> subprocess.CompletedProcess:
    return run(['node', str(REPO / 'src' / 'cli' / 'main.ts')] + args + [str(out / f'{name}_ts.pdf')],
               cwd=clone, env=env)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--samples', nargs='+', default=list(SAMPLES),
                    help='official samples to include (default: all)')
    ap.add_argument('-o', '--out', default=str(REPO / 'parity' / 'acceptance-out'))
    args = ap.parse_args()

    out = Path(args.out).resolve()
    work = out / 'work'
    work.mkdir(parents=True, exist_ok=True)

    ensure_image()
    clone = work / 'weasyprint-samples'
    ensure_samples(clone, args.samples)
    sample_fonts = extract_image_fonts(work)
    sample_env = {**os.environ, 'FONT_DIR': str(sample_fonts),
                  'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}

    # (group, name, python pdf, ts pdf, pagedjs pdf)
    docs = []

    # --- official samples -------------------------------------------------
    for name in args.samples:
        py_pdf, ts_pdf = out / f'sample-{name}_py.pdf', out / f'sample-{name}_ts.pdf'
        pr = render_sample_python(clone, out, SAMPLES[name], f'sample-{name}')
        tr = render_sample_ts(clone, out, SAMPLES[name], f'sample-{name}', sample_env)
        docs.append(('Official WeasyPrint samples', name, py_pdf, ts_pdf, pr, tr))

    # --- repo corpus ------------------------------------------------------
    corpus = REPO / 'test' / 'corpus'
    corpus_out = out / 'corpus'
    corpus_out.mkdir(exist_ok=True)
    env = {**os.environ, **fontconf_env(str(REPO / 'test' / 'fonts'), work)}
    env['FONT_DIR'] = str(REPO / 'test' / 'fonts')
    class Args:  # diffrun's render_python/render_ts expect this shape
        docker = False
        stylesheet = None
        python_cmd = 'weasyprint'
    for doc in sorted(corpus.glob('*.html')):
        py_pdf, ts_pdf = corpus_out / f'{doc.stem}-py.pdf', corpus_out / f'{doc.stem}-ts.pdf'
        pr = diffrun.render_python(doc, py_pdf, None, Args, env)
        tr = diffrun.render_ts(doc, ts_pdf, None, env)
        docs.append(('weasyprint-ts corpus', doc.stem, py_pdf, ts_pdf, pr, tr))

    # --- compare + rasterize ---------------------------------------------
    sections = []
    failures = 0
    for group, name, py_pdf, ts_pdf, pr, tr in docs:
        if pr.returncode or tr.returncode:
            detail = ('python: ' + (pr.stderr.strip().splitlines()[-1] if pr.stderr else '?') + ' | ' if pr.returncode else '') + \
                     ('ts: ' + (tr.stderr.strip().splitlines()[-1] if tr.stderr else '?') if tr.returncode else '')
            sections.append((group, name, '❌ ' + detail, [], py_pdf, ts_pdf))
            failures += 1
            continue
        badge = page_diff(py_pdf, ts_pdf)
        if '✅' not in badge:
            failures += 1
        py_prefix = py_pdf.with_suffix('')
        ts_prefix = ts_pdf.with_suffix('')
        to_png(py_pdf, str(py_prefix) + '-%d.png')
        to_png(ts_pdf, str(ts_prefix) + '-%d.png')
        pages = []
        for i in range(1, 400):
            py_img, ts_img = Path(f'{py_prefix}-{i}.png'), Path(f'{ts_prefix}-{i}.png')
            if not py_img.exists() or not ts_img.exists():
                break
            pages.append((i, py_img, ts_img))
        sections.append((group, name, badge, pages, py_pdf, ts_pdf))
        print(f'{name}: {badge}')

    # --- report -----------------------------------------------------------
    page = ['''<!doctype html><html><head><meta charset="utf-8"><title>weasyprint-ts acceptance</title>
<style>
 body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 24px; color: #222 }
 h1 { margin: 0 0 4px } h2 { margin: 32px 0 8px; border-bottom: 2px solid #ddd; padding-bottom: 4px }
 section.doc { margin: 18px 0 28px } section.doc h3 { margin: 0 0 6px }
 .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-weight: 600; font-size: 12px }
 .ok { background: #d9f7d9; color: #14521a } .bad { background: #ffd9d9; color: #6b1111 }
 .pair { display: flex; gap: 10px; overflow-x: auto; padding: 4px 0 10px }
 .pair > div { flex: 0 0 auto } .pair img { display: block; width: 340px; border: 1px solid #ccc }
 .pair label { display: block; font-size: 11px; color: #666; margin-top: 2px }
 .links a { margin-right: 12px }
</style></head><body>
<h1>weasyprint-ts — acceptance</h1>
<p>Python WeasyPrint 70 (pinned <code>weasy-alpine-prod</code> image, or the local
install for the repo corpus) vs this TypeScript port. Every document is rasterized
at 96 dpi; the badge is pixel parity across all pages.</p>''']

    current = None
    for group, name, badge, pages, py_pdf, ts_pdf in sections:
        if group != current:
            if current is not None:
                page.append('</section>')
            page.append(f'<h2>{html.escape(group)}</h2><section class="docs">')
            current = group
        cls = 'ok' if badge.startswith('✅') else 'bad'
        page.append(f'<section class="doc" id="{html.escape(name)}"><h3>{html.escape(name)} '
                    f'<span class="badge {cls}">{html.escape(badge)}</span></h3>')
        page.append(f'<p class="links"><a href="{py_pdf.relative_to(out)}" target="_blank">Python PDF</a>'
                    f'<a href="{ts_pdf.relative_to(out)}" target="_blank">TypeScript PDF</a></p>')
        page.append('<div class="pair">')
        for i, py_img, ts_img in pages:
            page.append(f'<div><a href="{py_img.relative_to(out)}" target="_blank"><img src="{py_img.relative_to(out)}"></a>'
                        f'<label>WeasyPrint — page {i}</label></div>'
                        f'<div><a href="{ts_img.relative_to(out)}" target="_blank"><img src="{ts_img.relative_to(out)}"></a>'
                        f'<label>weasyprint-ts — page {i}</label></div>')
        page.append('</div></section>')
    if current is not None:
        page.append('</section>')
    page.append('</body></html>')

    index = out / 'index.html'
    index.write_text('\n'.join(page))
    print(f'\n{len(sections) - failures}/{len(sections)} pixel-identical; report -> {index}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
