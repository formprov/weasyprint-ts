#!/usr/bin/env python3
"""Compare the PDF structure (not the pixels) of the oracle and the port.

Pixels cannot see metadata, bookmarks, link annotations, page boxes, attachments or form fields, so this renders each
case with both engines and compares a normalized structure extracted with `qpdf --json`:
  - catalog keys (Outlines, Names, OutputIntents, AcroForm, Metadata, Lang, ...)
  - page count and per-page MediaBox / CropBox / TrimBox / BleedBox
  - per-page annotations: subtype, rect (2 decimals), border, action or destination (page index for GoTo)
  - the outline tree: titles, nesting, destination page index
  - Info dictionary keys (dates, Producer and Creator are not compared)
  - embedded file names and AcroForm field names / types / values

Usage: python3 parity/pdf_struct_diff.py CASES_DIR [--out REPORT.md] [--limit N]
The oracle runs in the pinned image (weasy-alpine-prod); the port runs from this checkout.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMAGE = 'weasy-alpine-prod:latest'
UPSTREAM = REPO.parent / 'reference_code' / 'WeasyPrint'
FONTS = REPO / 'parity' / 'samples-out' / 'oracle-fonts'
UA = 'tests_ua.css'
IGNORED_INFO = {'/CreationDate', '/ModDate', '/Producer', '/Creator'}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def render_oracle(cases: Path, names: list[str], out: Path) -> dict[str, str]:
    script = '''
import json, sys
sys.path.insert(0, "/upstream")
from tests.testing_utils import FakeHTML
import os
res = {}
for name in sys.argv[1:]:
    try:
        opts_path = f"/cases/{name}.opts.json"
        opts = json.load(open(opts_path)) if os.path.exists(opts_path) else {}
        FakeHTML(filename=f"/cases/{name}.html").write_pdf(f"/out/{name}_py.pdf", **opts)
        res[name] = "ok"
    except Exception as e:
        res[name] = "ERR " + type(e).__name__ + ": " + str(e)[:100]
json.dump(res, open("/out/_oracle_struct.json", "w"))
'''
    (out / '_oracle_struct_run.py').write_text(script)
    run(['docker', 'run', '--rm', '-v', f'{cases}:/cases:ro', '-v', f'{out}:/out', '-v', f'{UPSTREAM}:/upstream:ro',
         '-v', f'{out}/_oracle_struct_run.py:/run.py:ro', IMAGE, '/venv/bin/python', '/run.py', *names])
    return json.loads((out / '_oracle_struct.json').read_text())


OPTION_FLAGS = {
    'pdf_tags': '--pdf-tags', 'pdf_variant': '--pdf-variant', 'pdf_version': '--pdf-version', 'pdf_identifier': '--pdf-identifier',
    'output_intent': '--output-intent', 'full_fonts': '--full-fonts', 'uncompressed_pdf': '--uncompressed-pdf',
    'custom_metadata': '--custom-metadata', 'pdf_forms': '--pdf-forms',
}


def port_flags(cases: Path, name: str) -> list[str]:
    path = cases / f'{name}.opts.json'
    if not path.exists():
        return []
    flags = []
    for key, value in json.loads(path.read_text()).items():
        if key not in OPTION_FLAGS:
            raise SystemExit(f'{name}: option {key} has no port flag yet')
        if value is True:
            flags.append(OPTION_FLAGS[key])
        elif value not in (False, None):
            flags += [f'{OPTION_FLAGS[key]}={value}']
    return flags


def render_port(cases: Path, name: str, out: Path) -> str:
    env = {'FONT_DIR': str(FONTS), 'PATH': os.environ.get('PATH', ''), 'HOME': str(Path.home())}
    r = run(['node', str(REPO / 'src/cli/main.ts'), '--ua-stylesheet', UA, *port_flags(cases, name),
             f'{name}.html', str(out / f'{name}_ts.pdf')], cwd=cases, env=env)
    return 'ok' if r.returncode == 0 else 'ERR ' + (r.stderr.strip().splitlines() or ['?'])[-1][:100]


def qpdf_json(pdf: Path) -> dict:
    r = run(['qpdf', '--json=1', '--json-stream-data=none', str(pdf)])
    if r.returncode not in (0, 3):  # 3 = warnings only
        raise RuntimeError(r.stderr.strip()[:200])
    return json.loads(r.stdout)


class Doc:
    """Resolve references in a qpdf JSON document."""

    def __init__(self, data: dict):
        self.objects = data['objects']

    def resolve(self, value, depth=0):
        if isinstance(value, str) and re.fullmatch(r'\d+ \d+ R', value):
            if depth > 50:
                return None
            target = self.objects.get(value)
            if isinstance(target, dict) and set(target) == {'dict', 'stream'}:
                target = target['dict']  # a stream: its dictionary is what structure comparisons need
            return self.resolve(target, depth + 1)
        return value

    def obj(self, value):
        return self.resolve(value)


def normalize_uri(uri):
    """Local file URIs depend on where the case lives (/cases in the container, the checkout on the host): keep the name."""
    if isinstance(uri, str) and uri.startswith('file://'):
        return 'file://' + uri.rsplit('/', 1)[-1]
    return uri


def xmp_summary(pdf: Path, data: dict) -> list:
    """The XMP packet as a canonical list: every Description's attributes and simple children, by namespace URI.

    Namespace prefixes and attribute order are serializer details; the values and the element set are compared.
    """
    import xml.etree.ElementTree as ET
    root_entry = data['objects']['trailer']['/Root']
    catalog = data['objects'].get(root_entry, {})
    ref = catalog.get('/Metadata')
    if not ref:
        return []
    number = ref.split()[0]
    r = run(['qpdf', '--show-object=' + number, '--filtered-stream-data', str(pdf)])
    text = r.stdout
    start = text.find('<x:xmpmeta')
    end = text.find('</x:xmpmeta>')
    if start < 0 or end < 0:
        return ['unparsed']
    rdf_xml = text[start:end + len('</x:xmpmeta>')]
    tree = ET.fromstring(rdf_xml)
    rdf_ns = '{http://www.w3.org/1999/02/22-rdf-syntax-ns#}'
    out = []
    for desc in tree.iter(rdf_ns + 'Description'):
        for key, value in desc.attrib.items():
            if key in (rdf_ns + 'about',) or key.startswith('{http://www.w3.org/XML/1998/namespace}'):
                continue
            out.append(['attr', key, value])
        for child in desc:
            if child.tag.startswith(rdf_ns) and child.tag.endswith(('Alt', 'Seq', 'Bag')):
                out.append(['list', child.tag, [li.text for li in child]])
            elif child.tag.endswith(('CreateDate', 'ModifyDate', 'MetadataDate')):
                out.append(['elem', child.tag, '<date>'])  # local time zones differ between the two machines
            elif child.tag.endswith('DocumentID'):
                out.append(['elem', child.tag, '<uuid>'])  # random by design (upstream uuid4)
            else:
                out.append(['elem', child.tag, child.text or ''])
    return sorted(out, key=lambda x: json.dumps(x))


def num(v):
    return round(float(v), 2) if isinstance(v, (int, float)) else v


def normalize(data: dict, pdf_path: Path | None = None) -> dict:
    d = Doc(data)
    trailer = data['objects']['trailer']
    root = d.obj(trailer.get('/Root')) or {}
    info = d.obj(trailer.get('/Info')) or {}
    page_refs: list[str] = []

    def collect(node_ref, depth=0):
        node = d.obj(node_ref) or {}
        if node.get('/Type') == '/Page' or '/Kids' not in node:
            page_refs.append(node_ref)
            return
        for kid in d.obj(node.get('/Kids')) or []:
            if depth < 30:
                collect(kid, depth + 1)

    pages_root = root.get('/Pages')
    if pages_root:
        collect(pages_root)
    index_of = {ref: i for i, ref in enumerate(page_refs)}

    def page_index(dest):
        dest = d.obj(dest)
        if isinstance(dest, list) and dest:
            return index_of.get(dest[0], 'unknown')
        return dest if isinstance(dest, str) else None

    pages = []
    annots_out = []
    for i, ref in enumerate(page_refs):
        page = d.obj(ref) or {}
        boxes = {k: [num(x) for x in (d.obj(page.get(k)) or [])] for k in ('/MediaBox', '/CropBox', '/TrimBox', '/BleedBox')
                 if page.get(k) is not None}
        pages.append(boxes)
        for annot_ref in d.obj(page.get('/Annots')) or []:
            a = d.obj(annot_ref) or {}
            action = d.obj(a.get('/A')) or {}
            entry = {
                'page': i, 'subtype': a.get('/Subtype'),
                'rect': [num(x) for x in (d.obj(a.get('/Rect')) or [])],
                'border': [num(x) for x in (d.obj(a.get('/Border')) or [])] if a.get('/Border') is not None else None,
                'flags': a.get('/F'),
            }
            if action:
                entry['action'] = action.get('/S')
                if action.get('/S') == '/URI':
                    entry['uri'] = normalize_uri(d.obj(action.get('/URI')))
                elif action.get('/S') == '/GoTo':
                    entry['dest'] = page_index(action.get('/D'))
            elif a.get('/Dest') is not None:
                entry['dest'] = page_index(a.get('/Dest'))
            annots_out.append(entry)

    outlines = []

    def walk(item_ref, depth=0):
        out = []
        item = d.obj(item_ref)
        while isinstance(item, dict) and depth < 20:
            action = d.obj(item.get('/A')) or {}
            dest = page_index(action.get('/D') if action else item.get('/Dest'))
            out.append([d.obj(item.get('/Title')), dest, walk(item.get('/First'), depth + 1)])
            item = d.obj(item.get('/Next'))
        return out

    if root.get('/Outlines'):
        outlines = walk((d.obj(root['/Outlines']) or {}).get('/First'))

    names = d.obj(root.get('/Names')) or {}
    embedded = []
    ef = d.obj(names.get('/EmbeddedFiles')) or {}
    arr = d.obj(ef.get('/Names')) or []
    for k in range(0, len(arr), 2):
        embedded.append(d.obj(arr[k]))

    fields = []
    acro = d.obj(root.get('/AcroForm')) or {}

    def field_walk(refs, depth=0):
        for r in d.obj(refs) or []:
            f = d.obj(r) or {}
            if depth < 20 and f.get('/Kids') is not None:
                field_walk(f.get('/Kids'), depth + 1)
            if f.get('/FT') is not None or f.get('/T') is not None:
                field = {'name': d.obj(f.get('/T')), 'type': f.get('/FT'),
                         'value': d.obj(f.get('/V'))}
                # Widget appearance dictionaries: /AP /N and /D streams, keyed by their
                # XObject keys (the /DA default-appearance string is compared separately).
                ap = d.obj(f.get('/AP')) or {}
                appearances = {}
                for kind in ('/N', '/D'):
                    apd = d.obj(ap.get(kind))
                    if isinstance(apd, dict):
                        appearances[kind] = sorted(apd.keys())
                    elif apd is not None:
                        appearances[kind] = [apd]
                field['ap'] = appearances
                field['da'] = d.obj(f.get('/DA'))
                fields.append(field)
    field_walk(acro.get('/Fields'))
    acro_extra = {k: acro[k] for k in acro if k not in '/Fields'}
    dr = d.obj(acro.get('/DR'))
    if isinstance(dr, dict):
        dr = {k: sorted((d.obj(v) or {}).keys()) if k == '/Font' else d.obj(v) for k, v in dr.items()}

    def struct(value, depth=0):
        node = d.obj(value) if isinstance(value, str) else value
        if isinstance(node, int):
            return ['mcid', node]
        if isinstance(node, dict):
            if node.get('/Type') == '/OBJR':
                return ['objr']
            kids = d.obj(node.get('/K'))
            if kids is None:
                kids = []
            if not isinstance(kids, list):
                kids = [kids]
            children = [struct(k, depth + 1) for k in kids] if depth < 60 else []
            attributes = d.obj(node.get('/A'))
            extra = {}
            if isinstance(attributes, dict):
                extra['A'] = {k: (len(d.obj(v) or []) if k == '/Headers' else d.obj(v)) for k, v in attributes.items() if k != '/BBox'}
            if node.get('/Alt') is not None:
                extra['Alt'] = d.obj(node.get('/Alt'))
            return [node.get('/S'), children, extra]
        return ['?']

    tag_root = d.obj(root.get('/StructTreeRoot')) or {}
    top_kids = d.obj(tag_root.get('/K')) if tag_root else None
    structure = [struct(k) for k in top_kids] if isinstance(top_kids, list) else None
    intents = []
    for intent_ref in d.obj(root.get('/OutputIntents')) or []:
        intent = d.obj(intent_ref) or {}
        intents.append({'S': intent.get('/S'), 'id': d.obj(intent.get('/OutputConditionIdentifier'))})
    return {
        'catalog': sorted(k for k in root.keys()),
        'output_intents': intents,
        'xmp': xmp_summary(pdf_path, data),
        'struct': structure,
        'mark_info': d.obj(root.get('/MarkInfo')),
        'metadata': root.get('/Metadata') is not None,
        'af': len(d.obj(root.get('/AF')) or []),
        'pages': pages,
        'annotations': annots_out,
        'outlines': outlines,
        'info': sorted(k for k in info.keys() if k not in IGNORED_INFO),
        'embedded': embedded,
        'fields': fields,
        'acro': {k: v for k, v in (acro.items() if isinstance(acro, dict) else []) if k != '/Fields'} | ({'/DR': dr} if isinstance(dr, dict) else {}),
    }


def compare(a: dict, b: dict) -> list[str]:
    out = []
    for key in a:
        if a[key] != b[key]:
            out.append(key)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cases')
    ap.add_argument('--out', default=None)
    ap.add_argument('--limit', type=int, default=None)
    args = ap.parse_args()
    cases = Path(args.cases).resolve()
    work = cases.parent / 'pdfstruct-out'
    work.mkdir(exist_ok=True)
    names = sorted(p.stem for p in cases.glob('*.html'))
    if args.limit:
        names = names[:args.limit]
    oracle = render_oracle(cases, names, work)
    rows = []
    for name in names:
        if oracle.get(name) != 'ok':
            rows.append((name, 'oracle-error', oracle.get(name, 'missing')))
            continue
        port = render_port(cases, name, work)
        if port != 'ok':
            rows.append((name, 'port-error', port))
            continue
        try:
            a = normalize(qpdf_json(work / f'{name}_py.pdf'), work / f'{name}_py.pdf')
            b = normalize(qpdf_json(work / f'{name}_ts.pdf'), work / f'{name}_ts.pdf')
        except RuntimeError as e:
            rows.append((name, 'qpdf-error', str(e)))
            continue
        diffs = compare(a, b)
        rows.append((name, 'match' if not diffs else 'differs', ', '.join(diffs)))
    counts = {}
    for _, status, _ in rows:
        counts[status] = counts.get(status, 0) + 1
    lines = ['# PDF structure differential', '', f'Cases: {len(rows)}  ' + '  '.join(f'{k}: {v}' for k, v in sorted(counts.items())), '',
             '| case | status | differing sections |', '|---|---|---|']
    for name, status, detail in rows:
        lines.append(f'| {name} | {status} | {detail} |')
    report = '\n'.join(lines) + '\n'
    if args.out:
        Path(args.out).write_text(report)
    print(report.splitlines()[2])
    for name, status, detail in rows:
        if status != 'match':
            print(f'{status:13} {name}  {detail[:120]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
