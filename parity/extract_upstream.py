"""Extract the static HTML inputs of upstream WeasyPrint's pixel/layout tests.

Writes one self-contained HTML file per test case (plus the test resources the
cases reference) so parity/diffrun.py can render each with both engines.

Usage: python3 parity/extract_upstream.py REFERENCE_TESTS_DIR OUT_DIR
"""
import ast
import re
import shutil
import sys
from pathlib import Path

tests_dir, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
res = tests_dir / 'resources'
out.mkdir(parents=True, exist_ok=True)
for f in res.iterdir():
    if f.is_file():
        shutil.copy(f, out / f.name)

FUNCS = {'assert_pixels', 'assert_pixels_equal', 'render_pages'}
written = 0
for src in sorted(tests_dir.glob('**/test_*.py')):
    rel = src.relative_to(tests_dir)
    area = rel.parts[0] if len(rel.parts) > 1 else 'top'
    stem = '_'.join(rel.with_suffix('').parts)
    tree = ast.parse(src.read_text())
    for node in ast.walk(tree):
        if not (isinstance(node, ast.FunctionDef) and node.name.startswith('test_')):
            continue
        n = 0
        for call in ast.walk(node):
            if not isinstance(call, ast.Call):
                continue
            name = call.func.id if isinstance(call.func, ast.Name) else getattr(call.func, 'attr', '')
            if name not in FUNCS:
                continue
            htmls = [a.value for a in call.args
                     if isinstance(a, ast.Constant) and isinstance(a.value, str) and '<' in a.value]
            for html in htmls:
                n += 1
                # Upstream's FakeHTML wraps bare fragments in nothing and replaces the UA sheet
                # (upstream_diff.py passes tests_ua.css as the UA sheet on both engines).
                body = html if re.search(r'<html|<!doctype', html, re.I) else f'<html><body>{html}</body></html>'
                (out / f'{area}__{stem}__{node.name}__{n}.html').write_text(body)
                written += 1
print(f'wrote {written} cases to {out}')
