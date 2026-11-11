# SPDX-License-Identifier: BSD-3-Clause

"""Render a document with Python WeasyPrint and with this TypeScript port and
compose an HTML file with the page renders side by side, plus a pixel-diff
badge per document. Works on a single HTML file or a directory of them.

Prerequisites: `weasyprint` on PATH (or --python-cmd), Ghostscript for the
rasterization, qpdf for page counts.

Usage:
  python3 parity/side_by_side.py DOC.html [-s style.css] [-o OUT_DIR] [--python-cmd CMD]
  python3 parity/side_by_side.py DOCS_DIR/ [-s style.css] [-o OUT_DIR]
  python3 parity/side_by_side.py DOC.html --pagedjs     # add the Paged.js contender column

--pagedjs renders the document a third time with harness/render_pagedjs.mjs (the
Paged.js polyfill in headless Chromium) and shows it beside the two WeasyPrint
engines. Its badge is informational: WeasyPrint parity is still decided by the
TS column. The runner needs harness/node_modules (pagedjs, playwright-core) and a
Playwright Chromium build (override with CHROMIUM_PATH); set CALIBRATE=<oracle
dump> for the oracle-calibrated variant described in the README score table.
"""

import argparse
import datetime
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TS_CLI = REPO / 'src' / 'cli' / 'main.ts'


def detect_font_dir(src: Path) -> str | None:
    """Pin both engines to the corpus's own fonts when present (zero-config parity)."""
    base = src.parent if src.is_file() else src
    candidates = (base / 'fonts', base.parent / 'fonts', REPO / 'test' / 'fonts')
    for candidate in candidates:
        if candidate.is_dir() and any(candidate.glob('*.ttf')):
            return str(candidate)
    return None


def fontconf_env(font_dir: str | None, workdir: Path) -> dict:
    if not font_dir:
        return {}
    cache = Path(tempfile.mkdtemp(prefix='weasyprint-ts-fc-'))
    conf = cache / 'fonts.conf'
    conf.write_text(
        '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
        f'<fontconfig><dir>{font_dir}</dir><cachedir>{cache}</cachedir></fontconfig>\n')
    return {'FONTCONFIG_FILE': str(conf), 'FONT_DIR': font_dir}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def render_python(doc: Path, out: Path, args, env) -> subprocess.CompletedProcess:
    cmd = args.python_cmd.split()
    if cmd[0].endswith(('python', 'python3')):
        cmd += ['-m', 'weasyprint']
    if args.stylesheet:
        cmd += ['-s', args.stylesheet]
    return run(cmd + [str(doc), str(out)], env=env)


def render_ts(doc: Path, out: Path, args, env) -> subprocess.CompletedProcess:
    cmd = ['node', str(TS_CLI)]
    if args.stylesheet:
        cmd += ['-s', args.stylesheet]
    return run(cmd + [str(doc), str(out)], env=env)


def render_pagedjs(doc: Path, out: Path, args, env) -> subprocess.CompletedProcess:
    """Third contender: the Paged.js polyfill in headless Chromium.

    Runs harness/render_pagedjs.mjs (see the module comment there: font pinning,
    the WeasyPrint-70 quirk shims and the optional CALIBRATE=oracle-dump loop).
    The runner needs harness/node_modules (pagedjs, playwright-core) and a
    Chromium build; a failure is reported but never fails the TS comparison.
    """
    runner = Path(args.pagedjs_runner).resolve()
    cmd = ['node', str(runner)]
    if args.stylesheet:
        cmd += ['-s', str(Path(args.stylesheet).resolve())]
    return run(cmd + [str(doc), str(out)], env=env, cwd=runner.parent)


def to_png(pdf: Path, png: str) -> None:
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r110',
                    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', f'-sOutputFile={png}', str(pdf)],
                   capture_output=True, check=False)


def page_diff(a: Path, b: Path) -> str:
    """Rasterize two PDFs and return a badge. Identical means equal page counts and
    zero differing pixels on every page."""
    r = run([sys.executable, str(Path(__file__).parent / 'cmp_pdf.py'), str(a), str(b)])
    lines = [line.strip() for line in r.stdout.splitlines() if line.strip()]
    pages = next((line for line in lines if line.startswith('pages ')), 'pages ? ?')
    counts = pages.split()[1:]
    diffs = [line for line in lines if 'differing pixels' in line]
    identical = (len(counts) == 2 and counts[0] == counts[1] and diffs and
                 len(diffs) == int(counts[0]) and
                 all('differing pixels 0 (0.000%)' in line for line in diffs))
    if identical:
        return '✅ pixel-identical'
    if len(counts) == 2 and counts[0] != counts[1]:
        return f'❌ page count {counts[0]} vs {counts[1]}'
    return '❌ ' + (diffs[0] if diffs else next(
        (line for line in lines if not line.startswith('pages ')), 'comparison failed'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='HTML file or a directory of HTML files')
    ap.add_argument('-s', '--stylesheet', default=None)
    ap.add_argument('-o', '--out', default=None)
    ap.add_argument('--python-cmd', default='weasyprint')
    ap.add_argument('--pagedjs', action='store_true',
                    help='add the Paged.js contender column (Chromium via harness/render_pagedjs.mjs)')
    ap.add_argument('--pagedjs-runner', default=str(REPO.parent / 'harness' / 'render_pagedjs.mjs'),
                    help='Paged.js runner script (default: harness/render_pagedjs.mjs)')
    args = ap.parse_args()

    src = Path(args.input).resolve()
    docs = [src] if src.is_file() else sorted(src.glob('*.html'))
    if not docs:
        print(f'no HTML documents found in {src}')
        return 2
    if args.out:
        out_dir = Path(args.out).resolve()
    elif src.is_file():
        out_dir = src.parent / f'sbs-{src.stem}'
    else:
        out_dir = src.parent / f'sbs-{src.name}'
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    env = {**dict(os.environ), **fontconf_env(detect_font_dir(src), out_dir)}

    sections = []
    failures = 0
    for doc in docs:
        d = out_dir / doc.stem
        d.mkdir(exist_ok=True)
        pr = render_python(doc, d / 'python.pdf', args, env)
        tr = render_ts(doc, d / 'typescript.pdf', args, env)
        if pr.returncode or tr.returncode:
            detail = ('python: ' + (pr.stderr.strip().splitlines()[-1] if pr.stderr else '?') + ' | ' if pr.returncode else '') + \
                     ('ts: ' + (tr.stderr.strip().splitlines()[-1] if tr.stderr else '?') if tr.returncode else '')
            sections.append((doc.name, '❌ ' + detail, None, [], d, []))
            failures += 1
            continue
        badge = page_diff(d / 'python.pdf', d / 'typescript.pdf')
        if '✅' not in badge:
            failures += 1
        to_png(d / 'python.pdf', str(d / 'python-%d.png'))
        to_png(d / 'typescript.pdf', str(d / 'typescript-%d.png'))

        # Optional third column: Paged.js in Chromium. Informational only — the TS badge above
        # is what decides pass/fail.
        pj_badge = None
        if args.pagedjs:
            pj = render_pagedjs(doc, d / 'pagedjs.pdf', args, env)
            if pj.returncode:
                pj_badge = '❌ Paged.js failed: ' + (pj.stderr.strip().splitlines()[-1] if pj.stderr else f'exit {pj.returncode}')
            else:
                pj_badge = page_diff(d / 'python.pdf', d / 'pagedjs.pdf')
                to_png(d / 'pagedjs.pdf', str(d / 'pagedjs-%d.png'))

        n_py = len(list(d.glob('python-*.png')))
        n_ts = len(list(d.glob('typescript-*.png')))
        n_pj = len(list(d.glob('pagedjs-*.png')))
        pages = [(f'page {i}', f'python-{i}.png', f'typescript-{i}.png',
                  f'pagedjs-{i}.png' if i <= n_pj else None)
                 for i in range(1, max(n_py, n_ts, n_pj) + 1)]
        sections.append((doc.name, badge, pj_badge, pages, d, []))
        print(f'{doc.name}: {badge}' + (f' | Paged.js: {pj_badge}' if pj_badge else ''))

    ts = datetime.datetime.now().isoformat(timespec='seconds')
    html = ['''<!doctype html><html><head><meta charset="utf-8"><title>WeasyPrint vs weasyprint-ts</title>
<style>
body { font-family: -apple-system, sans-serif; background: #1e1e1e; color: #ddd; margin: 20px; }
h1 { font-size: 20px; } h2 { font-size: 16px; margin: 30px 0 6px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
.ok { background: #1b3a1b; color: #7bd77b; } .bad { background: #4a1b1b; color: #ff9c9c; }
.pair { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
.pair > div { text-align: center; }
img { border: 1px solid #444; width: 45vw; max-width: 900px; height: auto; display: block; }
a { display: block; } a:hover img { border-color: #888; }
label { font-size: 12px; color: #aaa; display: block; margin-top: 3px; }
.hint { color: #777; font-size: 11px; margin-bottom: 20px; }
.pdf-links { display: flex; gap: 12px; font-size: 12px; margin: 4px 0 10px; }
.pdf-links a { display: inline; }
.sample { margin-bottom: 1in; }
.pair img { vertical-align: bottom; }
</style></head><body>
<h1>WeasyPrint (Python) vs weasyprint-ts</h1>
<p class="hint">Click any image for the full-resolution render, then use the browser zoom for detail.</p>''']
    if args.pagedjs:
        html[0] = html[0].replace('vs weasyprint-ts</h1>', 'vs weasyprint-ts vs Paged.js</h1>')
    for name, badge, pj_badge, pages, d, _ in sections:
        stem = d.name
        cls = 'ok' if badge.startswith('✅') else 'bad'
        html.append(f'<section class="sample"><h2>{name}</h2><span class="badge {cls}">{badge}</span>')
        if pj_badge:
            pj_cls = 'ok' if pj_badge.startswith('✅') else 'bad'
            html.append(f' <span class="badge {pj_cls}">Paged.js: {pj_badge}</span>')
        html.append(f'<nav class="pdf-links"><a href="{stem}/python.pdf" target="_blank" rel="noopener">Open WeasyPrint (Python, pinned image) PDF</a>'
                    f'<a href="{stem}/typescript.pdf" target="_blank" rel="noopener">Open weasyprint-ts PDF</a>')
        if pj_badge and (d / 'pagedjs.pdf').exists():
            html.append(f'<a href="{stem}/pagedjs.pdf" target="_blank" rel="noopener">Open Paged.js PDF</a>')
        html.append('</nav>')
        for page_label, py_img, ts_img, pj_img in pages:
            cells = [
                f'<div><a href="{stem}/{py_img}" target="_blank" rel="noopener"><img src="{stem}/{py_img}"></a><label>WeasyPrint — {page_label}</label></div>',
                f'<div><a href="{stem}/{ts_img}" target="_blank" rel="noopener"><img src="{stem}/{ts_img}"></a><label>weasyprint-ts — {page_label}</label></div>',
            ]
            if pj_img:
                cells.append(f'<div><a href="{stem}/{pj_img}" target="_blank" rel="noopener"><img src="{stem}/{pj_img}"></a><label>Paged.js — {page_label}</label></div>')
            html.append(f'<div class="pair">{"".join(cells)}</div>')
        html.append('</section>')
    html.append(f'<p class="hint">Generated {ts} by parity/side_by_side.py</p>')
    html.append('</body></html>')
    report = out_dir / 'side_by_side.html'
    report.write_text('\n'.join(html))
    print(f'\n{len(sections) - failures}/{len(sections)} identical; report -> {report}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())