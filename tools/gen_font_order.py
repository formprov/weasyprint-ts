#!/usr/bin/env python3
"""Regenerate the per-family font order in profiles/alpine_prod.json.

Pango builds its fontset from FontConfig's FcFontSort, so a glyph the requested
family lacks comes from the first family in *that* family's sort order (serif ->
Times New Roman before Arial, sans-serif -> Arial before Times). The port needs
the same lists; they are generated from the pinned image so the two engines
resolve missing glyphs identically.

Run from weasyprint-ts/ with the pinned image built:

  python3 tools/gen_font_order.py
"""
import json
import subprocess
from pathlib import Path

IMAGE = 'weasy-alpine-prod:latest'
SCRIPT = r'''
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
'''


def main():
    result = subprocess.run(['docker', 'run', '--rm', IMAGE, '/venv/bin/python', '-c', SCRIPT],
                            capture_output=True, text=True, check=True)
    order = json.loads(result.stdout)
    path = Path('profiles/alpine_prod.json')
    profile = json.loads(path.read_text())
    profile['order'] = order
    path.write_text(json.dumps(profile, indent=1))
    print(f'{len(order)} families written to {path}')


if __name__ == '__main__':
    main()
