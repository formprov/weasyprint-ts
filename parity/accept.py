# SPDX-License-Identifier: BSD-3-Clause

"""Acceptance round: compare this port against PDFs from your real pipeline.

Point it at a directory containing your HTML documents and the PDFs your
current WeasyPrint setup generated for them, named alike (doc1.html +
doc1.pdf). It renders each HTML with this port the same way your pipeline
does (from the document's directory, with the same stylesheet), then
pixel-compares and structurally-compares against the reference PDFs and
writes a markdown report.

Usage: python3 parity/accept.py DOCS_DIR [--stylesheet style.css] [--out report.md]
"""

import argparse
import datetime
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dir', help='directory with matching *.html + production *.pdf pairs')
    ap.add_argument('--stylesheet', default='style.css',
                    help='stylesheet passed to -s (set to "" to omit; default style.css in DIR)')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    d = Path(args.dir).resolve()
    htmls = sorted(d.glob('*.html'))
    if not htmls:
        print(f'No .html files in {d}')
        return 2

    work = d / 'accept_out'
    work.mkdir(exist_ok=True)
    rows = []
    failures = 0
    env = dict(PATH='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
    for html in htmls:
        production = html.with_suffix('.pdf')
        if not production.exists():
            rows.append((html.name, 'SKIP', 'no production PDF to compare against'))
            continue
        out_pdf = work / f'{html.stem}.pdf'
        cmd = ['node', str(ROOT / 'weasyprint-ts/src/cli/main.ts')]
        if args.stylesheet:
            cmd += ['-s', args.stylesheet]
        cmd += [html.name, str(out_pdf)]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=d, env=env)
        if r.returncode != 0:
            rows.append((html.name, 'FAIL', 'render failed: ' + (r.stderr.strip().splitlines()[-1] if r.stderr else '')))
            failures += 1
            continue
        cmp = subprocess.run([sys.executable, str(ROOT / 'harness/cmp_pdf.py'), str(out_pdf), str(production)],
                             capture_output=True, text=True)
        chk = subprocess.run([sys.executable, str(ROOT / 'harness/check_pdf.py'), str(production), str(out_pdf)],
                             capture_output=True, text=True)
        pixel_ok = 'differing pixels 0' in cmp.stdout
        struct_ok = 'STRUCTURALLY IDENTICAL' in chk.stdout
        if pixel_ok and struct_ok:
            rows.append((html.name, 'PASS', 'pixel-identical + structurally identical'))
        else:
            failures += 1
            detail = []
            if not pixel_ok:
                detail.append(next((l.strip() for l in cmp.stdout.splitlines() if 'differing pixels' in l), 'pixel diff'))
            if not struct_ok:
                detail += [l.strip() for l in chk.stdout.splitlines() if l.strip().startswith('-')]
            rows.append((html.name, 'FAIL', '; '.join(detail)))

    report = Path(args.out) if args.out else d / 'accept_report.md'
    with open(report, 'w') as f:
        f.write(f'# Acceptance round: {d}\n\n{datetime.datetime.now().isoformat(timespec="seconds")}\n\n')
        f.write('| document | result | detail |\n|---|---|---|\n')
        for name, status, detail in rows:
            f.write(f'| {name} | {"❌ FAIL" if status == "FAIL" else "✅ PASS" if status == "PASS" else "—"} | {detail} |\n')
    for name, status, detail in rows:
        print(f'{status:4} {name}: {detail}')
    print(f'\n{len(rows) - failures}/{len(rows)} passed; report -> {report}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())