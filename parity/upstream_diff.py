"""Differential run over the cases extracted by extract_upstream.py.

Oracle: one container call renders every case in-process. Port: the CLI, run in
parallel. Pages are rasterized at 96 dpi and compared pixel for pixel.

Usage: python3 parity/upstream_diff.py CASES_DIR [options]

  --pattern REGEX     only cases whose name matches (e.g. 'layout_test_grid', 'svg_test_paths')
  --area draw         only one area prefix (css|draw|layout|top)
  --limit N           first N matching cases
  --list              print every failing case with its verdict
  --baseline FILE     fail (exit 1) if a case listed as passing there now fails (regression guard)
  --update-baseline   rewrite the baseline from this run's passing cases (only after a FULL run)

Failing pixel cases leave a side-by-side image (oracle | port | diff) in
upstream-out/diff/NAME.png for visual inspection.
"""
import argparse
import json
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageChops

REPO = Path(__file__).resolve().parent.parent
IMAGE = 'weasy-alpine-prod:latest'
UPSTREAM_TESTS_PARENT = Path('/Users/andy/PROJ/weasy/reference_code/WeasyPrint').resolve()  # provides the `tests` package
ap = argparse.ArgumentParser()
ap.add_argument('cases')
ap.add_argument('--area', default=None)
ap.add_argument('--limit', type=int, default=None)
ap.add_argument('--workers', type=int, default=8)
ap.add_argument('--pattern', default=None)
ap.add_argument('--list', action='store_true')
ap.add_argument('--baseline', default=None)
ap.add_argument('--update-baseline', action='store_true')
args = ap.parse_args()

cases_dir = Path(args.cases).resolve()
out = cases_dir.parent / 'upstream-out'
out.mkdir(exist_ok=True)
files = sorted(p for p in cases_dir.glob('*__*.html') if not args.area or p.name.startswith(args.area + '__'))
if args.pattern:
    files = [p for p in files if re.search(args.pattern, p.stem)]
if args.limit:
    files = files[:args.limit]
excluded = json.loads((Path(__file__).parent / 'upstream-excluded.json').read_text()) \
    if (Path(__file__).parent / 'upstream-excluded.json').exists() else {}
skipped = [p.stem for p in files if p.stem in excluded]
files = [p for p in files if p.stem not in excluded]
names = [p.stem for p in files]
if skipped:
    print(f'excluded {len(skipped)} cases the oracle cannot render (parity/upstream-excluded.json)')

# --- oracle: one container call, in-process rendering ---------------------------------
script = '''
import json, sys
sys.path.insert(0, "/upstream")
from pathlib import Path
from tests.testing_utils import FakeHTML      # upstream's own helper: test UA sheet, uncompressed PDF
res = {}
import os
from weasyprint import CSS
for name in sys.argv[1:]:
    try:
        opts_path = f"/cases/{name}.opts.json"
        opts = json.load(open(opts_path)) if os.path.exists(opts_path) else {}
        # Upstream's HTML.write_pdf passes every option through to render (images and hints are decided there).
        kw = {k: v for k, v in opts.items() if k not in ('media_type', 'base_url', 'zoom', 'encoding')}
        if 'stylesheets' in kw:
            kw['stylesheets'] = [CSS(filename=f"/cases/{f}") for f in kw['stylesheets']]
        # Cases hold documents upstream renders from Python strings: read them as UTF-8 text (never let
        # either engine sniff an encoding) and default the base URL to the case file, as FakeHTML does.
        # A case may override the base URL (tests use base_url=BASE_URL, a file in tests/resources);
        # '.' means that directory, i.e. this one.
        base_url = opts.get('base_url')
        if base_url is None:
            base_url = f"file:///cases/{name}.html"
        elif base_url == '.':
            base_url = "file:///cases/"
        FakeHTML(
            string=open(f"/cases/{name}.html", encoding="utf-8").read(), base_url=base_url,
            media_type=opts.get('media_type', 'print')).write_pdf(
            f"/out/{name}_py.pdf", zoom=opts.get('zoom', 1), **kw)
        res[name] = "ok"
    except Exception as e:
        res[name] = "ERR " + type(e).__name__ + ": " + str(e)[:120]
json.dump(res, open("/out/_oracle.json", "w"))
'''
(out / '_oracle_run.py').write_text(script)
subprocess.run(['docker', 'run', '--rm', '-v', f'{cases_dir}:/cases:ro', '-v', f'{out}:/out',
                '-v', f'{UPSTREAM_TESTS_PARENT}:/upstream:ro', '-v', f'{out}/_oracle_run.py:/run.py:ro', IMAGE,
                '/venv/bin/python', '/run.py', *names], capture_output=True, text=True)
oracle = json.loads((out / '_oracle.json').read_text())

# --- port: CLI in parallel -------------------------------------------------------------
fonts = REPO / 'parity' / 'samples-out' / 'oracle-fonts'
env = {'FONT_DIR': str(fonts), 'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': str(Path.home())}


# Per-case options (CASE.opts.json, see weasy-qfx.8.3). Each option maps to a port CLI flag; an option with no
# flag is reported as a port error rather than silently ignored.
OPTION_FLAGS = {
    'presentational_hints': ['-p'], 'media_type': ['-m'], 'jpeg_quality': ['--jpeg-quality'], 'optimize_images': ['--optimize-images'],
    'pdf_variant': ['--pdf-variant'], 'full_fonts': ['--full-fonts'], 'pdf_identifier': ['--pdf-identifier'],
    'custom_metadata': ['--custom-metadata'], 'pdf_tags': ['--pdf-tags'], 'output_intent': ['--output-intent'],
    'uncompressed_pdf': ['--uncompressed-pdf'], 'pdf_version': ['--pdf-version'], 'stylesheets': ['-s'],
    'dpi': ['-D'], 'pdf_forms': ['--pdf-forms'], 'attachments': ['-a'], 'xmp_metadata': ['--xmp-metadata'],
}


def port_option_args(name):
    path = cases_dir / f'{name}.opts.json'
    if not path.exists():
        return [], None
    args, missing = [], None
    for key, value in json.loads(path.read_text()).items():
        if key == 'base_url':
            # '.' means the cases directory. Upstream's BASE_URL is a FILE inside tests/resources, so
            # relative URLs resolve against that directory; name a file in the cases dir for the same.
            args += ['-u', f'{name}.html' if value == '.' else value]
            continue
        if key == 'encoding':
            # Captured documents came from Python strings, already decoded (the oracle gets the decoded text).
            args += ['-e', value]
            continue
        if key == 'zoom':
            args += [f'--zoom={value}']
            continue
        if key not in OPTION_FLAGS:
            missing = missing or key
            continue
        if key == 'stylesheets':
            for sheet in value:
                args += ['-s', str(cases_dir / sheet)]
        elif key in ('attachments', 'xmp_metadata'):
            # Files captured next to the case: the CLI resolves them against its cwd (the cases dir).
            for entry in value:
                args += [OPTION_FLAGS[key][0], str(cases_dir / entry)]
        elif key == 'attachment_relationships':
            for rel in value:
                args += ['--attachment-relationship', rel]
        elif key == 'media_type':
            args += ['-m', value]
        elif key in ('jpeg_quality', 'pdf_version', 'pdf_identifier', 'pdf_variant', 'output_intent'):
            args += [f'{OPTION_FLAGS[key][0]}={value}'.replace('-j=', '--jpeg-quality=')]
        elif key == 'dpi':
            args += ['-D', str(value)]
        elif value is True:
            args += OPTION_FLAGS[key]
    return args, missing


def run_port(name):
    extra, missing = port_option_args(name)
    # The oracle side reads every case with open(encoding='utf-8') (Python-string bytes),
    # so the port must decode as UTF-8 too; without an <meta charset> its HTML sniffing
    # defaults to windows-1252 and mangles non-ASCII text.
    extra += ['-e', 'utf-8']
    if missing:
        return name, f'ERR option not supported by the port: {missing}'
    try:
        r = subprocess.run(['node', str(REPO / 'src/cli/main.ts'), '--ua-stylesheet', 'tests_ua.css', *extra, f'{name}.html', str(out / f'{name}_ts.pdf')],
                           cwd=cases_dir, env=env, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return name, 'ERR timeout (>60 s: port hangs)'
    return name, ('ok' if r.returncode == 0 else 'ERR ' + (r.stderr.strip().splitlines() or ['?'])[-1][:120])


with ThreadPoolExecutor(args.workers) as ex:
    port = dict(ex.map(run_port, names))


def raster(pdf, prefix):
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', '-r96', '-dTextAlphaBits=4',
                    '-dGraphicsAlphaBits=4', f'-sOutputFile={prefix}-%03d.png', str(pdf)], capture_output=True)
    return sorted(prefix.parent.glob(prefix.name + '-*.png'))


def compare(name):
    po, pt = oracle.get(name, 'missing'), port.get(name, 'missing')
    if po != 'ok' and pt != 'ok':
        return name, 'both-error', f'{po} | {pt}'
    if po != 'ok':
        return name, 'oracle-error', po
    if pt != 'ok':
        return name, 'port-error', pt
    a = raster(out / f'{name}_py.pdf', out / f'{name}_py')
    b = raster(out / f'{name}_ts.pdf', out / f'{name}_ts')
    if len(a) != len(b):
        verdict = ('page-count', f'{len(a)} vs {len(b)}')
    else:
        verdict = ('match', '')
        for x, y in zip(a, b):
            ix, iy = Image.open(x).convert('RGB'), Image.open(y).convert('RGB')
            if ix.size != iy.size:
                verdict = ('page-size', f'{ix.size} vs {iy.size}')
                break
            diff = ImageChops.difference(ix, iy)
            h = diff.convert('L').histogram()
            n = sum(h[1:])
            if n:
                verdict = ('pixels', f'{n} px differ (max {max(i for i, c in enumerate(h) if c)})')
                scale = max(1, 300 // max(ix.size))
                tiles = [im.resize((im.width * scale, im.height * scale), Image.NEAREST)
                         for im in (ix, iy, diff.point(lambda v: 255 if v else 0))]
                sheet = Image.new('RGB', (sum(t.width for t in tiles) + 16, tiles[0].height), (128, 0, 128))
                x0 = 0
                for t in tiles:
                    sheet.paste(t, (x0, 0))
                    x0 += t.width + 8
                (out / 'diff').mkdir(exist_ok=True)
                sheet.save(out / 'diff' / f'{name}.png')
                break
    for f in a + b:
        f.unlink()
    return name, verdict[0], verdict[1]


with ThreadPoolExecutor(args.workers) as ex:
    results = list(ex.map(compare, names))
if not args.pattern and not args.limit and not args.area:
    (out / 'results.json').write_text(json.dumps(results, indent=1))

from collections import Counter, defaultdict
by_area = defaultdict(Counter)
for name, verdict, _ in results:
    by_area[name.split('__')[0]][verdict] += 1
verdicts = ['match', 'pixels', 'page-count', 'page-size', 'port-error', 'oracle-error', 'both-error']
print(f'{"area":8}' + ''.join(f'{v:>13}' for v in verdicts))
for area, c in sorted(by_area.items()):
    print(f'{area:8}' + ''.join(f'{c[v]:>13}' for v in verdicts))
tot = Counter(v for _, v, _ in results)
print(f'{"TOTAL":8}' + ''.join(f'{tot[v]:>13}' for v in verdicts))

# Option summary: how many cases set each option, and which the port cannot honour yet.
option_uses = Counter()
unsupported = Counter()
for name in names:
    path = cases_dir / f'{name}.opts.json'
    if not path.exists():
        continue
    for key in json.loads(path.read_text()):
        option_uses[key] += 1
    _, missing = port_option_args(name)
    if missing:
        unsupported[missing] += 1
if option_uses:
    print('options:', ', '.join(f'{k}={n}' for k, n in sorted(option_uses.items())))
    for key, n in sorted(unsupported.items()):
        print(f'  unsupported by the port: {key} ({n} case{"s" if n > 1 else ""})')

if args.list:
    print()
    for name, verdict, detail in results:
        if verdict != 'match':
            print(f'{verdict:12} {name}  {detail}')

baseline_path = Path(args.baseline) if args.baseline else None
passing = {n for n, v, _ in results if v == 'match'}
if args.update_baseline and baseline_path:
    baseline_path.write_text(json.dumps(sorted(passing), indent=0))
    print(f'baseline updated: {len(passing)} passing cases -> {baseline_path}')
elif baseline_path and baseline_path.exists():
    expected = set(json.loads(baseline_path.read_text()))
    ran = set(names)
    regressions = sorted((expected & ran) - passing)
    gained = sorted((passing & ran) - expected)
    print(f'\nbaseline: {len(regressions)} regressions, {len(gained)} newly passing')
    for n in regressions:
        print('  REGRESSION', n)
    if regressions:
        sys.exit(1)
