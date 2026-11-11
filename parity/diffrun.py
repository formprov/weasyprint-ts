# SPDX-License-Identifier: BSD-3-Clause

"""Differential runner: render a corpus with Python WeasyPrint and with this
TypeScript port, then compare page counts, layout box trees and pixels
(Ghostscript, threshold 0). Writes a markdown report with the first
divergence per failing document.

Prerequisites:
  - `weasyprint` on PATH (Python WeasyPrint 70 for parity with upstream),
    or --docker with the weasy-alpine-prod image (see docker/),
  - this port's CLI (`node src/cli/main.ts`, no build step needed),
  - Ghostscript, for the pixel comparison.

Usage:
  python3 parity/diffrun.py CORPUS_DIR [--stylesheet CSS] [--out REPORT.md]
      [--limit N] [--layout] [--docker] [--python-cmd CMD] [--workdir DIR]

Example:
  python3 parity/diffrun.py test/corpus --layout
"""

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
from pathlib import Path

from oracle import image_fonts

REPO = Path(__file__).resolve().parent.parent
TS_CLI = REPO / 'src' / 'cli' / 'main.ts'
IMAGE = 'weasy-alpine-prod:latest'

PIXEL_RE = re.compile(r'page (\d+): differing pixels (\d+)')


def detect_font_dir(corpus: Path) -> str | None:
    """If the corpus ships its own fonts (test/corpus -> test/fonts), pin both
    engines to them so the comparison is apples-to-apples with zero config."""
    for candidate in (corpus / 'fonts', corpus.parent / 'fonts'):
        if candidate.is_dir() and any(candidate.glob('*.ttf')):
            return str(candidate)
    return None


def image_font_pin() -> Path | None:
    """Both engines must see byte-identical font files: an unpinned fontconfig
    fallback (e.g. the host has no plain 'Noto Serif') silently changes glyph
    advances and fabricates pixel diffs. When the corpus ships no fonts, use
    the pinned image's font set and hyphenation dictionaries, extracted once
    into a per-machine cache (parity/oracle.py)."""
    try:
        return image_fonts()
    except (OSError, SystemExit):
        return None


def fontconf_env(font_dir: str, workdir: Path, docker: bool = False) -> dict:
    """A minimal fontconfig pointing Python WeasyPrint at the same font files
    the port uses (FONT_DIR), plus the port's FontProfile derived from THIS
    fontconfig (generic aliases, fc-match sort order per family). Both engines
    then resolve families the same way, including documents that use the
    initial font (margin boxes) without naming a family.

    Only used when the corpus ships its own fonts (test/corpus -> test/fonts):
    for corpora without fonts both engines use the pinned image's font set, and
    the oracle's default fontconfig already matches profiles/alpine_prod.json.
    """
    cache = workdir / 'fc-cache'
    cache.mkdir(parents=True, exist_ok=True)
    conf = cache / 'fonts.conf'
    conf.write_text(
        '<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
        f'<fontconfig><dir>{font_dir}</dir><cachedir>{cache}</cachedir></fontconfig>\n')
    env = {'FONTCONFIG_FILE': str(conf)}
    profile = pinned_profile(conf, workdir, docker, font_dir)
    if profile is not None:
        path = cache / 'profile.json'
        path.write_text(json.dumps(profile))
        env['FONT_PROFILE'] = str(path)
    return env


def _docker_fc(conf: str, font_dir: str, workdir: Path, argv: list[str]) -> list[str]:
    """docker command running fc-* against the pin: the font directory and the
    generated fontconfig are mounted at their host paths so <dir> resolves."""
    return ['docker', 'run', '--rm',
            '-v', f'{font_dir}:{font_dir}:ro', '-v', f'{workdir}:{workdir}',
            '-v', f'{conf}:/fc.conf:ro', '-e', 'FONTCONFIG_FILE=/fc.conf',
            IMAGE, *argv]


def _fc_family(conf: str, pattern: str, docker: bool, font_dir: str, workdir: Path) -> str | None:
    """fc-match's matched family for `pattern` under one fontconfig file."""
    if docker:
        out = run(_docker_fc(conf, font_dir, workdir, ['fc-match', pattern]))
    else:
        out = run(['fc-match', pattern], env={**os.environ, 'FONTCONFIG_FILE': conf})
    m = re.search(r': "([^"]+)"', out.stdout)
    return m.group(1) if m else None


def pinned_profile(conf: str, workdir: Path, docker: bool, font_dir: str) -> dict | None:
    """FontProfile derived from the pinned fontconfig itself. Only ran when a
    pin is active; returns None on any tool failure (older setups then keep
    their hand-written profile)."""
    try:
        aliases = {}
        for generic in ('serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'):
            family = _fc_family(conf, generic, docker, font_dir, workdir)
            if family and family.lower() != generic:
                aliases[generic] = family
        fallback = _fc_fallback(conf, docker, font_dir, workdir)
        order = _fc_order(conf, docker, font_dir, workdir)
        profile = {'aliases': aliases, 'fallback': fallback}
        if order:
            profile['order'] = order
        return profile
    except (OSError, ValueError):
        return None


def _fc_fallback(conf: str, docker: bool, font_dir: str, workdir: Path) -> list[str]:
    """Ordered unique families of fc-match --sort (the glyph fallback order)."""
    if docker:
        out = run(_docker_fc(conf, font_dir, workdir, ['fc-match', '--sort', 'serif']))
    else:
        out = run(['fc-match', '--sort', 'serif'], env={**os.environ, 'FONTCONFIG_FILE': conf})
    families = []
    for line in out.stdout.splitlines():
        m = re.search(r': "([^"]+)"', line)
        if m and m.group(1) not in families:
            families.append(m.group(1))
    return families


FC_ORDER_SCRIPT = r"""
import json, subprocess
def fc(args):
    return subprocess.run(args, capture_output=True, text=True).stdout
families = set()
for line in fc(['fc-list', ':', 'family']).splitlines():
    name = line.split(',')[0].strip()
    if name:
        families.add(name)
for generic in ('serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'):
    families.add(generic)
order = {}
for family in sorted(families):
    names = []
    for line in fc(['fc-match', '-s', '-f', '%{family[0]}\n', family]).splitlines():
        name = line.strip()
        if name and name not in names:
            names.append(name)
    order[family.lower()] = names
print(json.dumps(order))
"""


def _fc_order(conf: str, docker: bool, font_dir: str, workdir: Path) -> dict | None:
    """fc-match --sort order for every installed family, like FontConfig gives
    Pango: a missing glyph comes from the first family in *that* list, not from
    one global fallback list (serif -> Times New Roman before Arial)."""
    if docker:
        out = run(_docker_fc(conf, font_dir, workdir, ['/venv/bin/python', '-c', FC_ORDER_SCRIPT]))
    else:
        out = run([sys.executable, '-c', FC_ORDER_SCRIPT], env={**os.environ, 'FONTCONFIG_FILE': conf})
    try:
        return json.loads(out.stdout)
    except ValueError:
        return None


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def render_python(html: Path, out: Path, stylesheet: str | None, args, env: dict | None = None) -> subprocess.CompletedProcess:
    """Render with Python WeasyPrint. docker=True uses the weasy-alpine-prod
    image (the pinned production oracle); otherwise --python-cmd (default
    `weasyprint` on PATH) renders directly."""
    if args.docker:
        cmd = ['docker', 'run', '--rm', '-v', f'{REPO}:{REPO}:ro', '-v', f'{out.parent.resolve()}:/out']
        # Pin the oracle to the same font files as the port. Without this the
        # container keeps its own font set while the port reads FONT_DIR, and a
        # document using a face only one side has (Noto Sans Italic in
        # test/fonts) fabricates a diff.
        if env:
            font_dir = env.get('FONT_DIR')
            if font_dir:
                cmd += ['-v', f'{font_dir}:{font_dir}:ro']
            conf = env.get('FONTCONFIG_FILE')
            if conf:
                cmd += ['-v', f'{conf}:/fc.conf:ro', '-e', 'FONTCONFIG_FILE=/fc.conf']
        cmd += [IMAGE, '/venv/bin/python', '-m', 'weasyprint']
        if stylesheet:
            cmd += ['-s', f'/docs/{stylesheet}' if not stylesheet.startswith('/') else stylesheet]
        doc_abs = html.resolve()
        cmd += [str(doc_abs) if doc_abs.is_relative_to(REPO) else f'/docs/{html.name}', f'/out/{out.name}']
        return run(cmd)
    cmd = args.python_cmd.split()
    if cmd[0].endswith(('python', 'python3')):
        cmd += ['-m', 'weasyprint']
    if stylesheet:
        cmd += ['-s', stylesheet]
    return run(cmd + [str(html), str(out)], env=env)


def render_ts(html: Path, out: Path, stylesheet: str | None, env: dict | None = None):
    cmd = ['node', str(TS_CLI)]
    if stylesheet:
        cmd += ['-s', stylesheet]
    return run(cmd + [str(html), str(out)], env=env)


def page_count(pdf: Path) -> int | None:
    result = run(['qpdf', '--show-npages', str(pdf)])
    try:
        return int(result.stdout.strip())
    except ValueError:
        return None


def pixel_diff(py_pdf: Path, ts_pdf: Path) -> tuple[bool, str]:
    result = run([sys.executable, str(Path(__file__).parent / 'cmp_pdf.py'), str(py_pdf), str(ts_pdf)])
    if result.returncode != 0:
        return False, f'cmp_pdf error: {result.stderr.strip().splitlines()[-1] if result.stderr else "unknown"}'
    bad = [l for l in result.stdout.splitlines()
           if PIXEL_RE.search(l) and 'differing pixels 0 (0.000%)' not in l]
    return (not bad), '; '.join(bad) if bad else 'all pages identical'


def box_tree_diff(html: Path, stylesheet: str | None, workdir: Path, stem: str, docker: bool = False) -> str:
    """Layout comparison (dump_layout.py vs the port's layout_dump.ts)."""
    if docker:  # the oracle dumper needs weasyprint: run it in the pinned image, with the repo at the same path
        py_args = ['docker', 'run', '--rm', '-v', f'{REPO}:{REPO}:ro', 'weasy-alpine-prod:latest', '/venv/bin/python',
                   str(Path(__file__).resolve().parent / 'dump_layout.py'), str(html.resolve())]
    else:
        py_args = [sys.executable, str(Path(__file__).parent / 'dump_layout.py'), str(html)]
    if stylesheet:
        py_args.append(stylesheet)
    dump_py = run(py_args)
    dump_ts = run(['node', str(REPO / 'tools' / 'layout_dump.ts'), str(html)])
    if dump_py.returncode != 0 or dump_ts.returncode != 0:
        return 'dump error'
    py_json = workdir / f'{stem}_py.json'
    ts_json = workdir / f'{stem}_ts.json'
    py_json.write_text(dump_py.stdout)
    ts_json.write_text(dump_ts.stdout)
    proc = run([sys.executable, str(Path(__file__).parent / 'cmp_layout.py'), str(py_json), str(ts_json), '0.01'])
    lines = proc.stdout.strip().splitlines()
    if proc.returncode == 0 and 'DIFF' not in proc.stdout:
        return 'layout OK'
    return (lines[1] if len(lines) > 1 else (lines[0] if lines else 'layout differs'))[:160]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('corpus')
    ap.add_argument('--stylesheet', default=None)
    ap.add_argument('--out', default=None)
    ap.add_argument('--limit', type=int, default=None)
    ap.add_argument('--layout', action='store_true', help='also compare layout box trees')
    ap.add_argument('--docker', action='store_true',
                    help='render the Python side in the weasy-alpine-prod image (see parity/docker/)')
    ap.add_argument('--python-cmd', default='weasyprint',
                    help="how to run Python WeasyPrint (default: 'weasyprint' on PATH; "
                         "e.g. 'python3 -m weasyprint' or a venv python)")
    ap.add_argument('--workdir', default=None)
    ap.add_argument('--no-font-pin', action='store_true',
                    help='do not pin fonts (render with whatever fontconfig picks; diffs may be font artifacts)')
    args = ap.parse_args()

    corpus = Path(args.corpus).resolve()
    docs = sorted(corpus.glob('*.html'))
    if args.limit:
        docs = docs[:args.limit]
    workdir = Path(args.workdir or f'/tmp/diffrun-{corpus.name}').resolve()
    (workdir / 'py').mkdir(parents=True, exist_ok=True)
    (workdir / 'ts').mkdir(parents=True, exist_ok=True)

    # Pin both engines to byte-identical font files: the corpus's own fonts
    # when it ships any, else the oracle image's set (zero-config parity; an
    # unpinned fallback fabricates pixel diffs). --no-font-pin opts out.
    # A corpus that ships its own fonts needs a matching fontconfig for the
    # oracle (the image cannot see those files) plus a profile derived from it.
    # Otherwise both engines use the pinned image's font set: the oracle keeps
    # its default fontconfig, which is exactly what profiles/alpine_prod.json
    # describes, so the port must not be given a different profile.
    local_fonts = None if args.no_font_pin else detect_font_dir(corpus)
    font_dir = local_fonts if local_fonts else (None if args.no_font_pin else image_font_pin())
    if local_fonts:
        env = {**dict(os.environ), **fontconf_env(local_fonts, workdir, args.docker)}
    else:
        env = dict(os.environ)
    if font_dir:
        env['FONT_DIR'] = str(font_dir)
        print(f'pinning both engines to fonts: {font_dir}')

    rows = []
    failures = 0
    for doc in docs:
        py_pdf = workdir / 'py' / (doc.stem + '.pdf')
        ts_pdf = workdir / 'ts' / (doc.stem + '.pdf')
        pr = render_python(doc, py_pdf, args.stylesheet, args, env)
        tr = render_ts(doc, ts_pdf, args.stylesheet, env)
        entry = {'doc': doc.name, 'status': 'PASS', 'detail': []}
        if pr.returncode != 0:
            entry['status'] = 'FAIL'
            entry['detail'].append(f'python render failed: {pr.stderr.strip().splitlines()[-1] if pr.stderr else ""}'[:160])
        if tr.returncode != 0:
            entry['status'] = 'FAIL'
            entry['detail'].append(f'ts render failed: {tr.stderr.strip().splitlines()[-1] if tr.stderr else ""}'[:160])
        if entry['status'] == 'PASS':
            pages_py, pages_ts = page_count(py_pdf), page_count(ts_pdf)
            if pages_py != pages_ts:
                entry['status'] = 'FAIL'
                entry['detail'].append(f'page count py={pages_py} ts={pages_ts}')
            elif pages_py is None:
                entry['status'] = 'FAIL'
                entry['detail'].append('unreadable PDFs (is qpdf installed?)')
            else:
                ok, detail = pixel_diff(py_pdf, ts_pdf)
                if not ok:
                    entry['status'] = 'FAIL'
                    entry['detail'].append(detail)
                else:
                    entry['detail'].append(f'{pages_py} page(s) pixel-identical')
        if entry['status'] == 'PASS' and args.layout:
            detail = box_tree_diff(doc, args.stylesheet, workdir, doc.stem, args.docker)
            entry['detail'].append(detail)
            if 'layout OK' not in detail:
                entry['status'] = 'FAIL'
        if entry['status'] == 'FAIL':
            failures += 1
        rows.append(entry)
        print(f"{'FAIL' if entry['status'] == 'FAIL' else 'pass'} {doc.name}: {entry['detail'][-1]}")

    report = Path(args.out) if args.out else workdir / 'report.md'
    with open(report, 'w') as f:
        f.write(f'# Differential run: {corpus.name}\n\n')
        f.write(f'- Date: {datetime.datetime.now().isoformat(timespec="seconds")}\n')
        f.write(f'- Docs: {len(docs)}  Failures: {failures}\n')
        f.write(f'- Python: {args.python_cmd}{" (docker)" if args.docker else ""}  TS: node {TS_CLI.name}\n\n')
        f.write('| doc | status | detail |\n|---|---|---|\n')
        for e in rows:
            f.write(f"| {e['doc']} | {'❌' if e['status'] == 'FAIL' else '✅'} | {'; '.join(e['detail'])} |\n")
    print(f'\n{len(docs) - failures}/{len(docs)} passed; report -> {report}')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())