# SPDX-License-Identifier: BSD-3-Clause

"""Deterministic structural diagnosis of two PDF renders.

Instead of a single pixel-wash number, decompose the difference into named,
counted causes:

  pages      page count + per-page media sizes
  fonts      embedded font families per page (which faces each engine picked)
  images     image XObjects (pixel dims, colorspace, filter) per page
  colors     distinct fill colors per page (catches palette / var() gaps)
  text runs  glyph histograms per font family (shaping / layout divergence)
  pixels     per-page diff totals + connected clusters of STRONG diffs,
             optionally named with layout-dump boxes

Usage:
  python3 parity/diagnose.py a.pdf b.pdf [--dpi 96] [--page N]
      [--boxes-a dump.json] [--boxes-b dump.json]

Layout dumps: parity/dump_layout.py (python engine) and
tools/layout_dump.ts (this port). A cluster is named with the dump of the
SAME input (--boxes-a names a.pdf's clusters).
"""

import argparse
import collections
import json
import os
import re
import subprocess
import tempfile

OBJ_RE = re.compile(rb'(\d+) 0 obj\b')


class Qdf:
    """Minimal read-only view of a qpdf-QDF-ified PDF (streams decompressed)."""

    def __init__(self, path):
        out = tempfile.mktemp(suffix='.qdf.pdf')
        subprocess.run(['qpdf', '--qdf', '--object-streams=disable', path, out],
                       check=True, capture_output=True)
        with open(out, 'rb') as f:
            self.data = f.read()
        os.unlink(out)
        self.objects = {}
        marks = [(int(m.group(1)), m.start()) for m in OBJ_RE.finditer(self.data)]
        for i, (num, start) in enumerate(marks):
            end = marks[i + 1][1] if i + 1 < len(marks) else len(self.data)
            self.objects[num] = self.data[start:end]

    def resolve(self, ref):
        try:
            return self.objects[int(ref)]
        except (KeyError, ValueError, TypeError):
            return b''

    def stream_of(self, body):
        return b'\n'.join(m.group(1) for m in
                          re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', body, re.S))


def dict_refs(block):
    """(key, ref_num) pairs from a << /K 12 0 R ... >> dict body."""
    return [(m.group(1).decode(), int(m.group(2)))
            for m in re.finditer(rb'/(\w+)\s+(\d+)\s+0\s+R', block)]


def page_resources(q, page_body):
    """(fonts {tag: basefont}, xobjects {tag: info}) — direct or indirect dicts."""
    fonts, xobjs = {}, {}
    m = re.search(rb'/Resources\s+(\d+)\s+0\s+R', page_body)
    res_body = q.resolve(m.group(1)) if m else page_body

    def dict_block(name):
        ind = re.search(rb'/' + name.encode() + rb'\s+(\d+)\s+0\s+R', res_body)
        if ind:
            return q.resolve(ind.group(1))
        d = re.search(rb'/' + name.encode() + rb'\s*<<(.*?)>>', res_body, re.S)
        return d.group(1) if d else b''

    for tag, ref in dict_refs(dict_block('Font')):
        bf = re.search(rb'/BaseFont\s*/([^\s/]+)', q.resolve(ref))
        fonts[tag] = bf.group(1).decode() if bf else '?'
    def scan_xobjects(block, prefix=''):
        for tag, ref in dict_refs(block):
            ib = q.resolve(ref)
            if b'/Image' in ib:
                def num(key):
                    mm = re.search(rb'/' + key.encode() + rb'\s+([\d.]+)', ib)
                    return int(float(mm.group(1))) if mm else 0
                cs = re.search(rb'/ColorSpace\s*/?(\w+)', ib)
                fl = re.search(rb'/Filter\s*/?(\w+)', ib)
                xobjs[prefix + tag] = {'px': f"{num('Width')}x{num('Height')}",
                                       'cs': cs.group(1).decode() if cs else '?',
                                       'filter': fl.group(1).decode() if fl else 'raw'}
            elif b'/Form' in ib:
                # nested resources (e.g. SVG drawn as a form XObject)
                sub = re.search(rb'/Resources\s+(\d+)\s+0\s+R', ib)
                sub_body = q.resolve(sub.group(1)) if sub else ib
                sub_xo = re.search(rb'/XObject\s*<<(.*?)>>', sub_body, re.S)
                if sub_xo:
                    scan_xobjects(sub_xo.group(1), prefix=prefix + tag + '/')
                else:
                    xobjs[prefix + tag] = {'px': 'form', 'cs': '?', 'filter': '?'}
    xo_block = re.search(rb'/XObject\s*<<(.*?)>>', res_body, re.S)
    if xo_block:
        scan_xobjects(xo_block.group(1))
    return fonts, xobjs


def page_dict(q: Qdf, body: bytes):
    """Parsed page: media size, fonts, images, fill colors, glyph histograms,
    link annotations."""
    media = re.search(rb'/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)', body)
    size = None
    if media:
        size = (round((float(media.group(3)) - float(media.group(1))) * 72 / 96),
                round((float(media.group(4)) - float(media.group(2))) * 72 / 96))
    fonts, xobjs = page_resources(q, body)
    fills = collections.Counter()
    runs = collections.Counter()
    annots: list[dict] = []
    cont = re.search(rb'/Contents\s*\[(.*?)\]', body, re.S)
    if cont:
        refs = re.findall(rb'(\d+)\s+0\s+R', cont.group(1))
    else:
        m = re.search(rb'/Contents\s+(\d+)\s+0\s+R', body)
        refs = [m.group(1)] if m else []
    for ref in refs:
        parse_content(q.stream_of(q.resolve(ref)), fonts, fills, runs)
    # Link annotations: count + dest/URI class (copy-paste & click parity is
    # invisible to pixels).
    am = re.search(rb'/Annots\s+(\d+)\s+0\s+R', body)
    if am:
        annots_body = q.resolve(am.group(1))
        for ar in re.finditer(rb'(\d+)\s+0\s+R', annots_body):
            aobj = q.resolve(ar.group(1))
            if not aobj or b'/Subtype /Link' not in aobj and b'/Subtype/Link' not in aobj:
                continue
            dest = 'uri' if b'/URI' in aobj else ('dest' if b'/Dest' in aobj or b'/A' in aobj else '?')
            if b'/URI' in aobj:
                um = re.search(rb'/URI\s*\(([^)]{0,60})', aobj)
                target = um.group(1).decode('latin1', 'replace') if um else ''
            else:
                dm = re.search(rb'/Dest\s*[\[\(]?\s*(\d+)\s+0\s+R', aobj) or re.search(rb'/Dest\s*/(\w+)', aobj)
                target = (dm.group(1).decode('latin1', 'replace') if dm else '')
            annots.append({'kind': dest, 'target': target})
    return {'media': size, 'fonts': fonts, 'images': xobjs, 'fills': fills,
            'runs': runs, 'annots': annots}


def parse(pdf_path):
    """[page_dict] in DOCUMENT order (qpdf %% Page comments mark it)."""
    q = Qdf(pdf_path)
    pageObjs = [(num, body) for num, body in q.objects.items()
                if re.search(rb'/Type\s*/Page\b(?!s)', body)]
    # Document order: each %% Page N comment precedes its page object.
    ordered = []
    for m in re.finditer(rb'%% Page \d+\n', q.data):
        obj = OBJ_RE.search(q.data, m.end())
        if obj:
            ordered.append(int(obj.group(1)))
    if len(ordered) == len(pageObjs):
        byNum = dict(pageObjs)
        return [page_dict(q, byNum[n]) for n in ordered if n in byNum]
    return [page_dict(q, body) for num, body in pageObjs]


def parse_content(stream, fonts, fills, runs):
    """Accumulate fill colors and per-family glyph counts from a content stream.

    Tokenizer is operator-stream based (not line based) so it survives engines
    that pack several operators onto one line."""
    font = None
    toks = tokenize_stream(stream)
    # inline mini-stack: only need operand recall for Tf (font, size) and rg
    last_operands = []
    for tok, kind in toks:
        if kind == 'op':
            if tok == b'Tf' and len(last_operands) >= 2:
                key = last_operands[-2]
                key = key.decode('latin1') if isinstance(key, bytes) else key
                font = fonts.get(key, key)
            elif tok == b'rg' and len(last_operands) >= 3:
                try:
                    rgb = tuple(round(float(v) * 255) for v in last_operands[-3:])
                    fills['#%02x%02x%02x' % rgb] += 1
                except ValueError:
                    pass
            last_operands = []
        elif kind == 'str':
            if font:
                runs[font] += max(len(tok) // 2, 1)
        elif kind == 'hexstr':
            if font:
                runs[font] += max(len(tok) // 4, 1)
            last_operands.append(tok)
        else:
            last_operands.append(tok)
        if len(last_operands) > 8:
            last_operands = last_operands[-8:]


def tokenize_stream(stream):
    """Yield (token, kind) with kind in {'num', 'str', 'op', 'name', 'other'}.
    Handles PDF string escapes, hex strings, arrays."""
    i, n = 0, len(stream)
    while i < n:
        c = stream[i:i + 1]
        if c in b' \t\r\n\x0c\x00':
            i += 1
            continue
        if c == b'(':
            depth, j = 1, i + 1
            while j < n and depth:
                if stream[j:j + 1] == b'\\':
                    j += 2
                    continue
                if stream[j:j + 1] == b'(':
                    depth += 1
                elif stream[j:j + 1] == b')':
                    depth -= 1
                j += 1
            raw = stream[i + 1:j - 1]
            yield raw, 'str'
            i = j
            continue
        if c == b'<':
            j = stream.find(b'>', i)
            if j == -1:
                break
            hexs = re.sub(rb'\s', b'', stream[i + 1:j])
            # PDF CID hex: 4 hex digits per glyph
            yield hexs, 'hexstr'
            i = j + 1
            continue
        if c == b'/':
            m = re.match(rb'/[^\s/\[\]<>(){}]*', stream[i:])
            tok = m.group(0)[1:]
            yield tok, 'name'
            i += m.end()
            continue
        if c == b'[' or c == b']':
            i += 1
            continue
        m = re.match(rb'[^\s/\[\]<>(){}]+', stream[i:])
        tok = m.group(0)
        if re.match(rb'^-?[\d.]+$', tok):
            yield tok, 'num'
        else:
            yield tok, 'op'
        i += m.end()


# ---------------------------------------------------------------- pixel clusters

def raster(pdf, tag, tmp, dpi):
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', f'-r{dpi}',
                    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                    f'-sOutputFile={tmp}/{tag}-%d.png', pdf], check=True)
    import re as _re
    def natkey(name):
        return [int(t) if t.isdigit() else t for t in _re.split(r'(\d+)', name)]
    return sorted((f for f in os.listdir(tmp) if f.startswith(tag + '-')), key=natkey)


def page_diff(a_png, b_png, dpi, top=8, min_cells=3):
    """Per-page pixel totals + connected components of >=64 gray-level diff.

    Methodology matches cmp_pdf.py exactly (difference on RGB, then convert
    to L) so the totals agree with the existing tooling."""
    from PIL import Image, ImageChops
    ia = Image.open(a_png).convert('RGB')
    ib = Image.open(b_png).convert('RGB')
    if ia.size != ib.size:
        return {'size_mismatch': (ia.size, ib.size)}
    diff = ImageChops.difference(ia, ib).convert('L')
    hist = diff.histogram()
    total = ia.size[0] * ia.size[1]
    strong_px = sum(hist[64:])
    px = diff.load()
    cell = 4
    gw, gh = ia.size[0] // cell, ia.size[1] // cell
    grid = [[0] * gw for _ in range(gh)]
    for gy in range(gh):
        for gx in range(gw):
            for y in range(gy * cell, gy * cell + cell):
                for x in range(gx * cell, gx * cell + cell):
                    if px[x, y] >= 64:
                        grid[gy][gx] = 1
                        break
    seen = [[False] * gw for _ in range(gh)]
    out = []
    for gy in range(gh):
        for gx in range(gw):
            if grid[gy][gx] and not seen[gy][gx]:
                stack, comp = [(gx, gy)], []
                seen[gy][gx] = True
                while stack:
                    x, y = stack.pop()
                    comp.append((x, y))
                    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                        if 0 <= nx < gw and 0 <= ny < gh and grid[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            stack.append((nx, ny))
                if len(comp) < min_cells:
                    continue
                xs = [c[0] for c in comp]
                ys = [c[1] for c in comp]
                out.append({'cells': len(comp),
                            'bbox_css': (min(xs) * cell * 72 // dpi, min(ys) * cell * 72 // dpi,
                                         (max(xs) + 1) * cell * 72 // dpi,
                                         (max(ys) + 1) * cell * 72 // dpi)})
    out.sort(key=lambda c: -c['cells'])
    return {'diff_px': total - hist[0], 'total': total, 'strong_px': strong_px,
            'clusters': out[:top]}


def name_region(cl, boxes):
    x0, y0, x1, y1 = cl['bbox_css']
    hits = []
    for b in boxes:
        bx0, by0 = b.get('x', 0), b.get('y', 0)
        bx1, by1 = bx0 + b.get('width', 0), by0 + b.get('height', 0)
        ox = max(0, min(x1, bx1) - max(x0, bx0))
        oy = max(0, min(y1, by1) - max(y0, by0))
        area = max(1.0, (bx1 - bx0) * (by1 - by0))
        if ox > 0 and oy > 0 and ox * oy > 0.3 * area:
            hits.append(b.get('tag') or b.get('type', '?'))
    return f"  <- {', '.join(dict.fromkeys(hits[:4]))}" if hits else ''


# ---------------------------------------------------------------- report

SUBSET_PREFIX = re.compile(r'^[A-Z]{6}\+')
STYLE_TOKENS = {'Regular', 'Bold', 'Light', 'Italic', 'Black', 'Condensed',
                'Medium', 'Thin', 'SemiBold', 'ExtraBold', 'ExtraLight', 'Oblique'}


def family(face):
    """Normalize an embedded face name to its family: strip the qpdf subset
    prefix and trailing style tokens (incl. fontconfig's comma-joined ones)."""
    face = SUBSET_PREFIX.sub('', face)
    # fontconfig style decoration: 'Family,-Style:[+Style...]' or 'Family,'
    if ',' in face:
        face = face.split(',', 1)[0] or face
    toks = face.split('-')
    while len(toks) > 1 and (toks[-1] in STYLE_TOKENS or ',' in toks[-1]):
        toks.pop()
    return '-'.join(toks)


def naming_only(ga, gb):
    """True when both engines embed the same FAMILIES (names may differ in
    style suffixes). Glyph totals are NOT compared here: leader dots, knockout
    re-draws and TJ counting make totals noisy proxies (a pixel-identical page
    can legitimately show different glyph counts)."""
    fa = {family(f) for f in ga}
    fb = {family(f) for f in gb}
    return bool(fa) and fa == fb


def glyph_family_diffs(ga, gb):
    """Family-level glyph count differences beyond tolerance (real shaping/
    layout divergence, not naming)."""
    fa, fb = collections.Counter(), collections.Counter()
    for face, n in ga.items():
        fa[family(face)] += n
    for face, n in gb.items():
        fb[family(face)] += n
    return {f: {'a': fa.get(f, 0), 'b': fb.get(f, 0)}
            for f in set(fa) | set(fb)
            if abs(fa.get(f, 0) - fb.get(f, 0)) > max(4, 0.03 * max(fa.get(f, 0), fb.get(f, 0), 1))}


def build_report(a_pdf, b_pdf, dpi='96', page=None, boxes_a=None, boxes_b=None):
    A, B = parse(a_pdf), parse(b_pdf)
    tmp = tempfile.mkdtemp()
    ra = raster(a_pdf, 'a', tmp, str(dpi))
    rb = raster(b_pdf, 'b', tmp, str(dpi))
    report = {'a': a_pdf, 'b': b_pdf, 'pages_a': len(A), 'pages_b': len(B),
              'page_count_diff': len(A) != len(B), 'pages': []}
    boxes_a = json.load(open(boxes_a))['boxes'] if boxes_a else []
    boxes_b = json.load(open(boxes_b))['boxes'] if boxes_b else []
    for i, (pa, pb) in enumerate(zip(A, B), 1):
        if page and i != page:
            continue
        entry = {'page': i,
                 'media_a': pa['media'], 'media_b': pb['media'],
                 'media_diff': pa['media'] != pb['media'],
                 'fonts_a': sorted(set(pa['fonts'].values())),
                 'fonts_b': sorted(set(pb['fonts'].values())),
                 'images_a': pa['images'], 'images_b': pb['images'],
                 'palette_a': dict(pa['fills']), 'palette_b': dict(pb['fills']),
                 'glyphs_a': dict(pa['runs']), 'glyphs_b': dict(pb['runs']),
                 'annots_a': pa.get('annots', []), 'annots_b': pb.get('annots', [])}
        # Family-level comparison: a missing FAMILY is a real font problem;
        # name-level differences are style/subset serialization ('naming').
        entry['font_families_only_a'] = sorted({family(f) for f in entry['fonts_a']} -
                                              {family(f) for f in entry['fonts_b']})
        entry['font_families_only_b'] = sorted({family(f) for f in entry['fonts_b']} -
                                              {family(f) for f in entry['fonts_a']})
        entry['font_names_equal'] = (
            {SUBSET_PREFIX.sub('', f) for f in entry['fonts_a']} ==
            {SUBSET_PREFIX.sub('', f) for f in entry['fonts_b']})
        entry['naming_only'] = (not entry['font_families_only_a'] and not entry['font_families_only_b']) or \
                               naming_only(pa['runs'], pb['runs'])
        entry['glyph_family_diffs'] = glyph_family_diffs(pa['runs'], pb['runs'])
        po = {k: pa['fills'][k] for k in set(pa['fills']) - set(pb['fills'])}
        po_b = {k: pb['fills'][k] for k in set(pb['fills']) - set(pa['fills'])}
        entry['palette_missing_a'] = po
        entry['palette_missing_b'] = po_b
        io = {t: pa['images'][t] for t in set(pa['images']) - set(pb['images'])}
        io_b = {t: pb['images'][t] for t in set(pb['images']) - set(pa['images'])}
        io_d = {t: {'a': pa['images'][t], 'b': pb['images'][t]}
                for t in set(pa['images']) & set(pb['images'])
                if pa['images'][t] != pb['images'][t]}
        entry['image_diffs'] = {'missing_a': io, 'missing_b': io_b, 'mismatch': io_d}
        if i <= len(ra) and i <= len(rb):
            d = page_diff(f'{tmp}/a-{i}.png', f'{tmp}/b-{i}.png', int(dpi))
            if 'size_mismatch' in d:
                entry['pixels'] = {'size_mismatch': d['size_mismatch']}
            else:
                d['pct'] = 100 * d['diff_px'] / d['total']
                d['strong_pct'] = 100 * d['strong_px'] / d['total']
                for c in d['clusters']:
                    c['names_a'] = [b.get('tag') or b.get('type', '?')
                                    for b in [bx for bx in boxes_a
                                              if _overlap(c['bbox_css'], bx) > 0.3]][:4]
                    c['names_b'] = [b.get('tag') or b.get('type', '?')
                                    for b in [bx for bx in boxes_b
                                              if _overlap(c['bbox_css'], bx) > 0.3]][:4]
                entry['pixels'] = d
        report['pages'].append(entry)
    return report


def _overlap(bbox, box):
    x0, y0, x1, y1 = bbox
    bx0, by0 = box.get('x', 0), box.get('y', 0)
    bx1, by1 = bx0 + box.get('width', 0), by0 + box.get('height', 0)
    ox = max(0, min(x1, bx1) - max(x0, bx0))
    oy = max(0, min(y1, by1) - max(y0, by0))
    return ox * oy / max(1.0, (bx1 - bx0) * (by1 - by0))


def render_text(rep):
    print(f"A = {rep['a']}\nB = {rep['b']}")
    v = '  <-- PAGE COUNT DIFFERS' if rep['page_count_diff'] else ''
    print(f"pages: A {rep['pages_a']} | B {rep['pages_b']}{v}")
    for e in rep['pages']:
        print(f"--- page {e['page']}")
        if e['media_diff']:
            print(f"  media: {e['media_a']} vs {e['media_b']}  <-- DIFFERS")
        if e['font_families_only_a'] or e['font_families_only_b']:
            print(f"  fonts: families A-only {e['font_families_only_a']} | B-only {e['font_families_only_b']}"
                  '   <-- FONT RESOLUTION DIFFERS')
        elif e['font_names_equal'] is False:
            print(f"  fonts: same families, different names (naming only)")
        if e['glyph_family_diffs'] and not e['naming_only']:
            for f, d in sorted(e['glyph_family_diffs'].items()):
                print(f"  glyphs {f}: A {d['a']} | B {d['b']}   <-- RUN GEOMETRY/SHAPING DIFFERS")
        if e['palette_missing_a'] or e['palette_missing_b']:
            print(f"  fill colors A-only {e['palette_missing_a']} | B-only {e['palette_missing_b']}"
                  '   <-- PALETTE DIFFERS')
        idf = e['image_diffs']
        if idf['missing_a'] or idf['missing_b'] or idf['mismatch']:
            print(f"  images: A-only {sorted(idf['missing_a'])} | B-only {sorted(idf['missing_b'])}"
                  f" | mismatch {sorted(idf['mismatch'])}   <-- IMAGE DIFFERS")
        la = e.get('annots_a') or []
        lb = e.get('annots_b') or []
        ka = sorted((x['kind'], x['target'] if x['kind'] == 'uri' else '') for x in la)
        kb = sorted((x['kind'], x['target'] if x['kind'] == 'uri' else '') for x in lb)
        if ka != kb or len(la) != len(lb):
            print(f"  links: A {len(la)} | B {len(lb)}"
                  f" | uri-A {sorted(t for k, t in ka if k == 'uri')[:8]}"
                  f" | uri-B {sorted(t for k, t in kb if k == 'uri')[:8]}   <-- LINKS DIFFER")
        px = e.get('pixels')
        if not px:
            continue
        if 'size_mismatch' in px:
            print(f"  pixels: SIZE MISMATCH {px['size_mismatch']}")
            continue
        print(f"  pixels: differing {px['diff_px']} ({px['pct']:.3f}%), strong(>=64) {px['strong_px']} ({px['strong_pct']:.3f}%)")
        for c in px.get('clusters', []):
            w = c['bbox_css'][2] - c['bbox_css'][0]
            h = c['bbox_css'][3] - c['bbox_css'][1]
            names = c['names_a'] or c['names_b']
            print(f"    {w}x{h} @ {c['bbox_css']} cells={c['cells']}"
                  + (f"  <- {', '.join(dict.fromkeys(names))}" if names else ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a_pdf')
    ap.add_argument('b_pdf')
    ap.add_argument('--dpi', default='96')
    ap.add_argument('--page', type=int, default=None)
    ap.add_argument('--boxes-a', default=None, help='layout dump for a.pdf (names its clusters)')
    ap.add_argument('--boxes-b', default=None, help='layout dump for b.pdf')
    ap.add_argument('--json', action='store_true', help='emit the structured report as JSON')
    args = ap.parse_args()

    rep = build_report(args.a_pdf, args.b_pdf, args.dpi, args.page, args.boxes_a, args.boxes_b)
    if args.json:
        print(json.dumps(rep))
    else:
        render_text(rep)


if __name__ == '__main__':
    main()
