# SPDX-License-Identifier: BSD-3-Clause

"""Render a document with Python WeasyPrint and with this TypeScript port and
compose an HTML file with the page renders side by side, plus a pixel-diff
badge per document. Works on a single HTML file or a directory of them.

Prerequisites: `weasyprint` on PATH (or --python-cmd), Ghostscript for the
rasterization, qpdf for page counts.

Usage:
  python3 parity/side_by_side.py DOC.html [--docker] [-s style.css] [-o OUT_DIR]
  python3 parity/side_by_side.py DOCS_DIR/ [--docker] [-s style.css] [-o OUT_DIR]
  python3 parity/side_by_side.py DOC.html --pagedjs     # add the Paged.js contender column

--docker renders the Python side in the pinned weasy-alpine-prod image (built
on first use), so the comparison is against the exact Pango/HarfBuzz/font set
the project measures parity on, not a local pip install.

--pagedjs renders the document a third time with parity/pagedjs/render_pagedjs.mjs
(the Paged.js polyfill in headless Chromium) and shows it beside the two
WeasyPrint engines. Its badge is informational: WeasyPrint parity is still
decided by the TS column. Install its dependencies first (cd parity/pagedjs &&
npm install); set CHROMIUM_PATH to point at a Chromium build, and
CALIBRATE=<oracle dump> for the oracle-calibrated variant in the README table.
"""

import argparse
import datetime
import os
import re
import subprocess
import sys
from pathlib import Path

from diffrun import fontconf_env
from oracle import IMAGE, image_fonts

REPO = Path(__file__).resolve().parent.parent
TS_CLI = REPO / 'src' / 'cli' / 'main.ts'


def detect_font_dir(src: Path, docker: bool = False, image_dir: str | None = None) -> str | None:
    """Pin both engines to the same font files.

    A corpus that ships its own `fonts/` keeps them. Otherwise the docker
    oracle uses the image's font set (extracted once), and a local run falls
    back to the repo's test fonts, which is what the committed examples use.
    """
    base = src.parent if src.is_file() else src
    for candidate in (base / 'fonts', base.parent / 'fonts'):
        if candidate.is_dir() and any(candidate.glob('*.ttf')):
            return str(candidate)
    if docker:
        return image_dir or str(image_fonts())
    fallback = REPO / 'test' / 'fonts'
    return str(fallback) if fallback.is_dir() else None


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def _mount(cmd: list[str], path: Path, mount: str) -> str:
    """Host path inside the oracle container: repo paths are already mounted
    at their own location, anything else gets a read-only mount."""
    path = path.resolve()
    if path.is_relative_to(REPO):
        return str(path)
    cmd += ['-v', f'{path.parent}:{mount}:ro']
    return f'{mount}/{path.name}'


def render_python(doc: Path, out: Path, args, env) -> subprocess.CompletedProcess:
    if args.docker:
        out = out.resolve()
        cmd = ['docker', 'run', '--rm', '-v', f'{REPO}:{REPO}:ro', '-v', f'{out.parent}:/out']
        font_dir = env.get('FONT_DIR')
        if font_dir:
            cmd += ['-v', f'{font_dir}:{font_dir}:ro']
        conf = env.get('FONTCONFIG_FILE')
        if conf:
            cmd += ['-v', f'{conf}:/fc.conf:ro', '-e', 'FONTCONFIG_FILE=/fc.conf']
        options = []
        if args.stylesheet:
            options += ['-s', _mount(cmd, Path(args.stylesheet), '/css')]
        doc_path = _mount(cmd, doc, '/docs')
        cmd += [IMAGE, '/venv/bin/python', '-m', 'weasyprint', *options,
                doc_path, f'/out/{out.name}']
        return run(cmd)
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

    Runs parity/pagedjs/render_pagedjs.mjs (see the module comment there: font
    pinning, the WeasyPrint-70 quirk shims and the optional CALIBRATE=oracle-dump
    loop). The runner needs parity/pagedjs/node_modules (pagedjs,
    playwright-core) and a Chromium build; a failure is reported but never fails
    the TS comparison.
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
    ap.add_argument('--docker', action='store_true',
                    help='render the Python side in the pinned weasy-alpine-prod image')
    ap.add_argument('--pagedjs', action='store_true',
                    help='add the Paged.js contender column (Chromium via parity/pagedjs/)')
    ap.add_argument('--pagedjs-runner', default=str(REPO / 'parity' / 'pagedjs' / 'render_pagedjs.mjs'),
                    help='Paged.js runner script (default: parity/pagedjs/render_pagedjs.mjs)')
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
    image_dir = str(image_fonts()) if args.docker else None
    font_dir = detect_font_dir(src, args.docker, image_dir)
    env = {**dict(os.environ)}
    if font_dir:
        env['FONT_DIR'] = font_dir
        # A custom fontconfig is only needed when the fonts are not the
        # image's own set: the image's default config already defines the
        # generic families the port's alpine_prod profile expects.
        if font_dir != image_dir:
            env.update(fontconf_env(font_dir, out_dir, args.docker))

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