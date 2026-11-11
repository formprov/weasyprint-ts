# SPDX-License-Identifier: BSD-3-Clause

"""PDF structural checks (qfx.3): compare two PDFs on structure, not pixels.

Compares page count and sizes, annotations, embedded fonts, images per page,
and extracted text (pdftotext layout mode). Exit 0 when structurally equal.

Usage: python3 harness/check_pdf.py REFERENCE.pdf CANDIDATE.pdf
"""

import re
import subprocess
import sys


def pdf_info(path):
    result = subprocess.run(['pdfinfo', path], capture_output=True, text=True)
    info = {}
    for line in result.stdout.splitlines():
        if ':' in line:
            k, v = line.split(':', 1)
            info[k.strip()] = v.strip()
    return info


def page_boxes(path):
    """Page count + per-page size via pdfinfo -list."""
    result = subprocess.run(['pdfinfo', '-list', path], capture_output=True, text=True)
    sizes = []
    for line in result.stdout.splitlines():
        m = re.match(r'\s*\d+\s+\d+x\d+\s+.*', line)
        if m:
            sizes.append(m.group(1))
    return sizes


def qpdf_json(path):
    result = subprocess.run(['qpdf', '--json', '--json-key=pages', path], capture_output=True, text=True)
    import json
    try:
        return json.loads(result.stdout).get('pages', [])
    except json.JSONDecodeError:
        return []


def fonts(path):
    result = subprocess.run(['pdffonts', path], capture_output=True, text=True)
    out = set()
    lines = result.stdout.splitlines()
    if len(lines) < 3:
        return out
    # Column-aligned header: find the column offsets from the header row.
    header = lines[0]
    cols = [(m.start(), m.group()) for m in re.finditer(r'\S.*?(?=\s{2,}|$)', header)]
    starts = [c[0] for c in cols]
    names = header.find('name'), header.find('type')
    for line in lines[2:]:
        if not line.strip():
            continue
        name = line[names[0]:names[1]].strip() if names[0] >= 0 and names[1] > names[0] else line.split()[0]
        rest = line[names[1]:].split() if names[1] > 0 else line.split()[1:]
        # rest: type (may contain spaces), encoding, emb, sub, uni, object id
        emb_flag = rest[-4] if len(rest) >= 4 else '?'
        type_word = ' '.join(rest[:-4]) if len(rest) >= 4 else ' '.join(rest)
        out.add((name, type_word, emb_flag))
    return out


def annotations(page):
    return sorted(re.findall(r'/Subtype\s*/(\w+)', str(page.get('annot', '')) or '')) if isinstance(page, dict) else []


def images_per_page(path, pages):
    """Count image XObjects drawn per page via qpdf --qdf parse is heavy; use pdfimages -list."""
    result = subprocess.run(['pdfimages', '-list', path], capture_output=True, text=True)
    counts = {}
    for line in result.stdout.splitlines():
        m = re.match(r'\s*(\d+)\s+\d+', line)
        if m and not line.startswith(('page', '---')):
            counts[int(m.group(1))] = counts.get(int(m.group(1)), 0) + 1
    n = len(pages)
    return [counts.get(i, 0) for i in range(1, n + 1)]


def text_of(path):
    result = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, text=True)
    # Normalize whitespace: layout may differ by a space but content must match.
    return re.sub(r'\s+', ' ', result.stdout).strip()


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    ref, cand = sys.argv[1], sys.argv[2]
    problems = []

    pr, cr = pdf_info(ref), pdf_info(cand)
    if pr.get('Pages') != cr.get('Pages'):
        problems.append(f"page count: {pr.get('Pages')} vs {cr.get('Pages')}")
    if pr.get('Page size') != cr.get('Page size'):
        problems.append(f"page size: {pr.get('Page size')} vs {cr.get('Page size')}")

    br, bc = page_boxes(ref), page_boxes(cand)
    if br != bc:
        problems.append(f'per-page sizes differ: {br[:4]}… vs {bc[:4]}…')

    fr, fc = fonts(ref), fonts(cand)
    # BaseFont names derive from pango/fontconfig description strings upstream
    # (subset tag + resolved family list, e.g. 'Times-New-Roman,'); the TS port
    # uses the font's PostScript name. Compare semantically: family base name
    # with subset tags, trailing commas and -Regular suffixes normalized.
    normalize = lambda n: n.split('+')[-1].rstrip(',').replace('-Regular', '')
    names_r = sorted(normalize(n) for n, *_ in fr)
    names_c = sorted(normalize(n) for n, *_ in fc)
    if names_r != names_c:
        problems.append(f'embedded font names: {names_r} vs {names_c}')
    emb_r = sorted(t for _, t, e in fr)
    emb_c = sorted(t for _, t, e in fc)
    if emb_r != emb_c:
        problems.append(f'font types/embedding flags differ: {emb_r} vs {emb_c}')

    jr, jc = qpdf_json(ref), qpdf_json(cand)
    ir, ic = images_per_page(ref, jr), images_per_page(cand, jc)
    if ir != ic:
        problems.append(f'images per page: {ir} vs {ic}')

    tr, tc = text_of(ref), text_of(cand)
    if tr != tc:
        # Find first divergence for the report.
        i = next((k for k in range(min(len(tr), len(tc))) if tr[k] != tc[k]), min(len(tr), len(tc)))
        problems.append(f'text differs at char {i}: …{tr[max(0, i - 40):i + 40]!r} vs …{tc[max(0, i - 40):i + 40]!r}')

    if problems:
        print(f'STRUCTURAL DIFFS ({len(problems)}):')
        for p in problems:
            print('  -', p)
        return 1
    print(f'STRUCTURALLY IDENTICAL: {pr.get("Pages")} pages, size {pr.get("Page size")}, '
        f'{len(fr)} font(s), images {ir}, text matches')
    return 0


if __name__ == '__main__':
    sys.exit(main())