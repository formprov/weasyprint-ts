"""Capture the HTML documents upstream's own test-suite renders, by RUNNING it.

`extract_upstream.py` only sees literal strings in `assert_pixels(...)` calls. Many tests build their
HTML with f-strings, helpers or parametrization, so they never appear. This script runs the upstream
pytest suite inside the oracle container with a recording plugin that wraps
`tests.testing_utils.FakeHTML` (`__init__`, `render`, `write_pdf`) and writes every document that
reaches `render`/`write_pdf` as a case:

    AREA__FILE__TEST__N.html        the HTML source
    AREA__FILE__TEST__N.opts.json   the options the test passed (stylesheets, base_url, ...)

N counts the documents captured inside one test (parametrized runs included). Existing cases are
never overwritten: a document whose HTML is byte-identical to an existing case is skipped, and a
name collision gets the next free N.

Usage: python3 parity/capture_upstream.py [OUT_DIR] [--pattern REGEX] [-k EXPR] [--dry-run]
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

from oracle import upstream_dir

REPO = Path(__file__).resolve().parent.parent
IMAGE = 'weasy-alpine-prod:latest'

ap = argparse.ArgumentParser()
ap.add_argument('out', nargs='?', default=str(REPO / 'parity' / 'upstream-cases-dynamic'))
ap.add_argument('--pattern', default=None, help='only capture documents from tests whose nodeid matches this regex')
ap.add_argument('-k', dest='expr', default=None, help='pytest -k expression (test selection)')
ap.add_argument('--dry-run', action='store_true', help='run pytest, print the capture report, write nothing')
ap.add_argument('--raw', default=None,
                help='scratch directory for captured documents (default: a temp directory)')
ap.add_argument('--from-raw', action='store_true', help='reuse the documents already captured in --raw')
args = ap.parse_args()

UPSTREAM = upstream_dir(required=True)
out = Path(args.out).resolve()
raw = Path(args.raw or (Path(tempfile.gettempdir()) / 'weasy-capture-raw')).resolve()
if not (args.from_raw and raw.exists()):
    if raw.exists():
        shutil.rmtree(raw)
    raw.mkdir(parents=True)

# --- the recording plugin -------------------------------------------------------------
PLUGIN = r'''
"""Record every document upstream's tests render (parity/capture_upstream.py)."""
import json, os, re, threading
from pathlib import Path
from urllib.parse import unquote, urlparse

import pytest

RAW = Path(os.environ['CAPTURE_DIR'])
PATTERN = re.compile(os.environ['CAPTURE_PATTERN']) if os.environ.get('CAPTURE_PATTERN') else None

_state = threading.local()
_lock = threading.Lock()


def _current():
    return getattr(_state, 'nodeid', '')


def pytest_runtest_setup(item):
    _state.nodeid = item.nodeid


def _install():
    from tests import testing_utils
    from weasyprint import CSS, HTML

    orig_init = testing_utils.FakeHTML.__init__
    orig_render = testing_utils.FakeHTML.render
    orig_write_pdf = testing_utils.FakeHTML.write_pdf

    def _record(self, doc):
        """Write one captured document (called just before rendering/writing)."""
        nodeid = _current()
        if PATTERN and not PATTERN.search(nodeid):
            return
        source = getattr(self, '_capture_source')
        if source is None or 'string' not in source:
            # Only string sources are self-contained; filename/url documents are resources the
            # static extractor (and the case dirs) already provide.
            return
        n = getattr(_state, 'counter', 0)
        _state.counter = n + 1
        payload = {
            'nodeid': nodeid,
            'source': source,
            'render_options': getattr(self, '_capture_render_options', {}),
            'pdf_options': getattr(self, '_capture_pdf_options', {}),
        }
        with _lock:
            target = RAW / f'{n:04d}.json'
            while target.exists():
                n += 1
                target = RAW / f'{n:04d}.json'
            target.write_text(json.dumps(payload))

    def init(self, *args, **kwargs):
        orig_init(self, *args, **kwargs)
        source = {}
        if args:
            first = args[0]
            if isinstance(first, str) and '<' in first:
                source['string'] = first
            else:
                source['guess'] = str(first)
        for key in ('string', 'filename', 'url'):
            if key in kwargs and kwargs[key] is not None:
                value = kwargs[key]
                source[key] = value if key == 'string' else str(value)
        if 'base_url' in kwargs and kwargs['base_url'] is not None:
            source['base_url'] = str(kwargs['base_url'])
        if 'media_type' in kwargs and kwargs['media_type'] != 'print':
            source['media_type'] = kwargs['media_type']
        self._capture_source = source

    def render(self, *args, **kwargs):
        self._capture_render_options = dict(kwargs)
        _record(self, 'render')
        return orig_render(self, *args, **kwargs)

    def write_pdf(self, target=None, zoom=1, finisher=None, **options):
        opts = dict(options)
        if zoom != 1:
            opts['zoom'] = zoom
        self._capture_pdf_options = opts
        _record(self, 'write_pdf')
        return orig_write_pdf(self, target, zoom, finisher, **options)

    testing_utils.FakeHTML.__init__ = init
    testing_utils.FakeHTML.render = render
    testing_utils.FakeHTML.write_pdf = write_pdf


def pytest_configure(config):
    _install()
'''

(raw / '_capture_plugin.py').write_text(PLUGIN)

# --- run the suite inside the oracle ---------------------------------------------------
pattern_env = args.pattern or ''
cmd = ['docker', 'run', '--rm',
       '-e', f'CAPTURE_DIR=/capture', '-e', f'CAPTURE_PATTERN={pattern_env}',
       '-e', 'PYTHONPATH=/upstream:/plugin', '-e', 'PYTHONDONTWRITEBYTECODE=1',
       '-v', f'{UPSTREAM}:/upstream:ro', '-v', f'{raw}:/capture', '-v', f'{raw}:/plugin:ro',
       IMAGE, '/bin/sh', '-c',
       '/venv/bin/pip install --quiet --no-cache-dir pytest >/dev/null 2>&1; '
       'cd /upstream && /venv/bin/python -m pytest tests -q -p no:cacheprovider -p _capture_plugin --tb=no '
       + (f'-k {args.expr!r} ' if args.expr else '') + '-q']
if args.from_raw and raw.exists() and any(raw.glob('[0-9][0-9][0-9][0-9].json')):
    print('reusing the documents captured in', raw)
else:
    print('running:', cmd[-1])
    # pytest exits non-zero (tests needing gs/network/fonts fail here); the capture is the side effect.
    subprocess.run(cmd, text=True)

captured = sorted(raw.glob('[0-9][0-9][0-9][0-9].json'))
print(f'captured {len(captured)} documents')

# --- turn them into cases ---------------------------------------------------------------
RESOURCE_BASE = str(UPSTREAM / 'tests' / 'resources')
# The suite runs in the container, where the checkout is mounted at /upstream.
RESOURCE_URL = 'file:///upstream/tests/resources'
name_re = re.compile(r'^tests/(?:(?P<sub>[^/]+)/)?(?P<file>test_[^/]+)\.py::(?P<test>[^\[\]]+)')


def case_key(html):
    """The document as the case file holds it (upstream's FakeHTML accepts bare fragments)."""
    return html if re.search(r'<html|<!doctype', html, re.I) else f'<html><body>{html}</body></html>'


existing = {}
for directory in sorted((REPO / 'parity').glob('upstream-cases*')):
    if directory.name == 'upstream-cases-dynamic':
        continue  # this script's own output; rewritten below
    for html in directory.glob('*__*.html'):
        try:
            existing[case_key(html.read_text())] = html.stem
        except OSError:
            pass

out.mkdir(parents=True, exist_ok=True)
used_names = set(p.stem for d in (REPO / 'parity').glob('upstream-cases*') for p in d.glob('*__*.html'))
report = []
written = skipped_dup = skipped_nostr = 0
for path in captured:
    data = json.loads(path.read_text())
    source = data['source']
    html = source.get('string')
    if html is None:
        skipped_nostr += 1
        continue
    m = name_re.match(data['nodeid'])
    if not m:
        skipped_nostr += 1
        continue
    area = m['sub'] or 'top'
    stem = f'{m["file"]}' if not m['sub'] else f'{m["sub"]}_{m["file"]}'
    base = f'{area}__{stem}__{m["test"]}'
    key = case_key(html)

    opts = {}
    for k, v in data['render_options'].items():
        if k in ('font_config',):
            continue
        if k == 'stylesheets':
            files = []
            for sheet in v if isinstance(v, list) else [v]:
                name = Path(getattr(sheet, 'filename', '') or '').name if hasattr(sheet, 'filename') else ''
                if name and (UPSTREAM / 'tests' / 'resources' / name).exists():
                    files.append(name)
                    target = out / name
                    if not target.exists():
                        shutil.copy(UPSTREAM / 'tests' / 'resources' / name, target)
            if files:
                opts['stylesheets'] = files
            continue
        if k in ('presentational_hints', 'media_type') and v not in (False, None, 'print'):
            opts[k] = v
    for k, v in data['pdf_options'].items():
        if k in ('uncompressed_pdf', 'pdf_variant', 'pdf_version', 'pdf_identifier', 'custom_metadata',
                 'optimize_images', 'jpeg_quality', 'dpi', 'zoom', 'hinting', 'full_fonts', 'pdf_tags',
                 'pdf_forms', 'srgb'):
            opts[k] = v
    # The document came from a Python str, so it is already decoded: tell the harness to read the case
    # file as UTF-8 instead of letting both engines sniff (windows-1252) their own encoding.
    opts['encoding'] = 'utf-8'

    base_url = source.get('base_url')
    if base_url:
        if base_url.startswith(RESOURCE_URL.replace('file://', '')):
            base_url = RESOURCE_URL + base_url[len(RESOURCE_URL.replace('file://', '')):]
        # The tests run inside the container, where the resources live at /upstream/tests/resources
        # (the same directory the case dir copies). '.' tells the harness to use the case dir.
        if base_url.startswith(RESOURCE_URL) or os.path.abspath(
                unquote(base_url.replace('file://', ''))).startswith(RESOURCE_BASE):
            opts['base_url'] = '.'
        else:
            opts['base_url'] = base_url

    if key in existing:
        skipped_dup += 1
        report.append(('dup', m['test'], existing[key]))
        continue
    n = 0
    while f'{base}__{n}' in used_names:
        n += 1
    name = f'{base}__{n}'
    if not args.dry_run:
        (out / f'{name}.html').write_text(key)
        if opts:
            (out / f'{name}.opts.json').write_text(json.dumps(opts))
    used_names.add(name)
    existing[key] = name
    written += 1

print(f'wrote {written} new cases to {out}')
print(f'skipped: {skipped_dup} already covered, {skipped_nostr} without a self-contained string')
if args.dry_run:
    for kind, test, other in report[:20]:
        print(' ', kind, test, '->', other)
