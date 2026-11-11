"""Reproducible runner for the official WeasyPrint samples.

Uses the pinned Docker image (parity/docker/alpine-prod-Dockerfile) as the
reference oracle and extracts the image's exact font files so this port sees
byte-identical fonts. Anyone with Docker reproduces the same comparison.

Downloads the official samples (github.com/CourtBouillon/weasyprint-samples)
to a cache directory on first run.

Usage:
  python3 parity/run_samples.py [--samples sample1 sample2 ...] [--workdir DIR]
      [--serve] [--port PORT]

Samples: report, invoice, ticket, letter, poster, flyer, book, book-classical
(default: all eight).
"""

import argparse
import json
import subprocess
import re
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SAMPLES_REPO = 'https://github.com/CourtBouillon/weasyprint-samples.git'
IMAGE = 'weasy-alpine-prod:latest'

# (name, render args relative to the samples repo, top-level doc)
SAMPLES = {
    'report': ['report/report.html'],
    'invoice': ['invoice/invoice.html'],
    'ticket': ['ticket/ticket.html'],
    'letter': ['letter/letter.html'],
    'poster': ['-s', 'poster/poster.css', 'poster/poster.html'],
    'flyer': ['-s', 'poster/flyer.css', 'poster/poster.html'],
    'book': ['-s', 'book/book.css', 'book/book.html'],
    'book-classical': ['-s', 'book/book-classical.css', 'book/book.html'],
}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


# ---------------------------------------------------------------- grading

ORDER = 'ABCDEF'  # A best .. F worst


def worst(a, b):
    return a if ORDER.index(a) >= ORDER.index(b) else b


def g_pixels(pct, strong_pct):
    # 'strong' (>=64/255) = visible difference; a weak-only wash (AA noise or
    # the JPEG re-encode residue, weasy-9g3) caps the grade at B.
    if strong_pct == 0:
        return 'A' if pct == 0 else 'B'
    if pct == 0:
        return 'A'
    if pct <= 0.1:
        return 'B'
    if pct <= 1:
        return 'C'
    if pct <= 5:
        return 'D'
    if pct <= 15:
        return 'E'
    return 'F'


def grade_sample(rep):
    """Grade one sample from a diagnose.py JSON report.

    pages:    A = same count and media, F otherwise
    fonts:    A = identical face names; B = same families (style naming,
                  page-shift artifacts, or pages visually clean); F = families
                  missing
    palette:  A = no fill-op diffs; C/D/F by missing-op count
    images:   A = identical (incl. dedup naming); B = naming-only; F = real
    text:     A = glyph ops agree; B = op-count diffs on pixel-clean or
                  weakly-differing pages (leader dots / knockouts); F = real
                  divergence on strong-diff pages (>1% strong)
    links:    A = link annotations and URI targets match; F otherwise
    pixels:   by differing %, but a weak-only wash (no strong diffs = nothing
                  visible) caps at B
    overall:  worst category
    """
    n = min(rep['pages_a'], rep['pages_b'])
    pages = rep['pages'][:n]
    g_pages = 'A' if not rep['page_count_diff'] else 'F'
    if any(e['media_diff'] for e in pages):
        g_pages = 'F'

    # fonts: F = a family is missing (a real resolution problem); A = the
    # embedded names match exactly after the subset-prefix strip; B = the same
    # families with different style serialization (naming-only).
    fams_missing = any(e['font_families_only_a'] or e['font_families_only_b'] for e in pages)
    names_equal = all(e['font_names_equal'] for e in pages)
    if fams_missing:
        g_fonts = 'F'
    elif names_equal:
        g_fonts = 'A'
    else:
        g_fonts = 'B'

    ops = sum(len(e['palette_missing_a']) + len(e['palette_missing_b']) for e in pages)
    if ops == 0:
        g_palette = 'A'
    elif ops <= 2:
        g_palette = 'C'
    elif ops <= 8:
        g_palette = 'D'
    else:
        g_palette = 'F'

    # links: URI targets and per-page annotation counts must match (clicks and
    # copy-paste behavior are invisible to pixels).
    uri_a = sorted((x['target'] for e in pages for x in e.get('annots_a', []) if x['kind'] == 'uri'))
    uri_b = sorted((x['target'] for e in pages for x in e.get('annots_b', []) if x['kind'] == 'uri'))
    count_a = sum(len(e.get('annots_a') or []) for e in pages)
    count_b = sum(len(e.get('annots_b') or []) for e in pages)
    g_links = 'A' if (uri_a == uri_b and count_a == count_b) else 'F'

    imgs = [e['image_diffs'] for e in pages]
    real_img = any(i['mismatch'] or len(i['missing_a']) != len(i['missing_b']) for i in imgs)
    any_img = any(i['missing_a'] or i['missing_b'] or i['mismatch'] for i in imgs)
    g_images = 'F' if real_img else ('B' if any_img else 'A')

    # 'text': glyph histograms are noisy proxies (leader dots, knockout
    # re-draws) — only penalize when the page's pixels actually differ too.
    text_f = any(e['glyph_family_diffs'] and not e['naming_only']
                 and (e.get('pixels') or {}).get('pct', 0) > 0 for e in pages)
    text_b = any(e['glyph_family_diffs'] for e in pages)
    g_text = 'F' if text_f else ('B' if text_b else 'A')

    tot = sum((e['pixels']['total'] for e in pages
               if e.get('pixels') and 'total' in e['pixels']), 0)
    diff = sum((e['pixels']['diff_px'] for e in pages
                if e.get('pixels') and 'diff_px' in e['pixels']), 0)
    pct = 100 * diff / tot if tot else 100.0
    g_pix = g_pixels(pct, 100 * sum((e['pixels']['strong_px'] for e in pages
                                     if e.get('pixels') and 'strong_px' in e['pixels']), 0) / tot if tot else 0.0)

    overall = worst(worst(worst(worst(g_pages, g_fonts), worst(g_palette, g_images)), worst(g_links, g_text)),
                    g_pix)
    return {'pages': g_pages, 'fonts': g_fonts, 'palette': g_palette,
            'images': g_images, 'text': g_text, 'links': g_links, 'pixels': g_pix,
            'overall': overall}, pct


def rasterize(pdf: str, out_prefix: str, dpi: str = '96') -> None:
    """Render each page of ``pdf`` to PNG (the same Ghostscript raster the
    grader uses), named out_prefix-<page>.png with stride padding."""
    subprocess.run(['gs', '-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=png16m', f'-r{dpi}',
                    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4',
                    f'-sOutputFile={out_prefix}-%04d.png', pdf], check=True)


def badge_line(rep, grades):
    n = min(rep['pages_a'], rep['pages_b'])
    tot = sum((e['pixels']['total'] for e in rep['pages'][:n]
               if e.get('pixels') and 'total' in e['pixels']), 0)
    diff = sum((e['pixels']['diff_px'] for e in rep['pages'][:n]
                if e.get('pixels') and 'diff_px' in e['pixels']), 0)
    pct = 100 * diff / tot if tot else 100.0
    mark = '✅' if grades['overall'] == 'A' else '❌'
    pc = f" · pages {rep['pages_a']} vs {rep['pages_b']}" if rep['page_count_diff'] else ''
    return f"{mark} {grades['overall']} · {pct:.2f}% differing ({n} pages){pc}"


def causes_from_report(rep):
    """Compact deterministic cause lines for the viewer's <pre>."""
    out = []
    if rep['page_count_diff']:
        out.append(f"pages {rep['pages_a']} vs {rep['pages_b']}  <-- PAGE COUNT DIFFERS")
    for e in rep['pages']:
        px = e.get('pixels') or {}
        flags = []
        if e['media_diff']:
            flags.append('media size')
        if e.get('font_families_only_a') or e.get('font_families_only_b'):
            flags.append('FONTS MISSING FAMILIES')
        elif e.get('font_faces_only_a') or e.get('font_faces_only_b'):
            flags.append('fonts (naming only)')
        if e['glyph_family_diffs'] and not e['naming_only']:
            flags.append('glyph geometry/shaping')
        po, pb = e['palette_missing_a'], e['palette_missing_b']
        if po or pb:
            flags.append(f"palette {sum(po.values()) + sum(pb.values())} fill ops")
        idf = e['image_diffs']
        if idf['mismatch'] or len(idf['missing_a']) != len(idf['missing_b']):
            flags.append('images')
        elif idf['missing_a']:
            flags.append('image naming')
        pl = f"p{e['page']}: {px.get('pct', float('nan')):.2f}% differing, {px.get('strong_pct', float('nan')):.2f}% strong"
        if flags:
            out.append(f"{pl}  <-- {', '.join(flags)}")
        elif px:
            out.append(f"{pl}")
        for c in (px.get('clusters') or [])[:3]:
            names = c['names_a'] or c['names_b']
            w = c['bbox_css'][2] - c['bbox_css'][0]
            h = c['bbox_css'][3] - c['bbox_css'][1]
            nm = f" <- {', '.join(dict.fromkeys(names))}" if names else ''
            out.append(f"   cluster {w}x{h} @ {c['bbox_css']}{nm}")
    return out[:12]


def ensure_samples(clone_dir: Path, wanted: list) -> None:
    if not (clone_dir / '.git').exists():
        print(f'cloning samples -> {clone_dir}')
        run(['git', 'clone', '--depth', '1', SAMPLES_REPO, str(clone_dir)])
    for name in wanted:
        args = SAMPLES[name]
        for arg in args:
            if arg.endswith(('.html', '.css')) and not (clone_dir / arg).exists():
                sys.exit(f'sample file missing in the cloned repo: {arg}')


def ensure_image() -> None:
    if run(['docker', 'image', 'inspect', IMAGE]).returncode != 0:
        print(f'building {IMAGE} (once — takes a few minutes)...')
        dockerfile = REPO / 'parity' / 'docker' / 'alpine-prod-Dockerfile'
        r = run(['docker', 'build', '-t', IMAGE, '-f', str(dockerfile), str(dockerfile.parent)])
        if r.returncode != 0:
            sys.exit(f'image build failed: {r.stderr[-400:]}')


def extract_image_fonts(workdir: Path) -> Path:
    """Copy the oracle image's font files so the port sees byte-identical fonts."""
    fonts_dir = workdir / 'oracle-fonts'
    if not fonts_dir.exists():
        fonts_dir.mkdir(parents=True)
        r = subprocess.run(['docker', 'run', '--rm', IMAGE, '/bin/sh', '-c', 'tar -C /usr/share/fonts -c .'],
                           capture_output=True)
        if r.returncode != 0:
            sys.exit('font extraction failed')
        import tarfile
        import io
        with tarfile.open(fileobj=io.BytesIO(r.stdout)) as tar:
            # skip symlinks: fontconfig alias-farm links (e.g. msttcorefonts) can loop;
            # the real font files are all present.
            members = [m for m in tar.getmembers() if not m.issym() and not m.islnk()]
            tar.extractall(fonts_dir, members=members)
        # Also extract the oracle's hyphenation dictionaries so the port's
        # hyphens:auto resolves with byte-identical pattern data.
        rd = subprocess.run(['docker', 'run', '--rm', IMAGE, '/bin/sh', '-c',
                             'cd /venv/lib/python*/site-packages/pyphen/dictionaries 2>/dev/null && tar -c .'],
                            capture_output=True)
        if rd.returncode == 0 and rd.stdout:
            dictionaries_dir = fonts_dir / 'dictionaries'
            dictionaries_dir.mkdir(exist_ok=True)
            with tarfile.open(fileobj=io.BytesIO(rd.stdout)) as tar:
                dmembers = [m for m in tar.getmembers() if not m.issym() and not m.islnk()]
                tar.extractall(dictionaries_dir, members=dmembers)
            print(f"oracle dictionaries extracted -> {dictionaries_dir}")
        staging = workdir / 'oracle-fonts-staging'
        if staging.exists():
            staging.replace(fonts_dir)
    return fonts_dir


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--samples', nargs='+',
                    default=['report', 'invoice', 'ticket', 'letter', 'poster', 'flyer', 'book', 'book-classical'],
                    help='subset of: ' + ', '.join(SAMPLES))
    ap.add_argument('--workdir', default=None)
    ap.add_argument('--html-only', action='store_true',
                    help='rebuild the viewer from existing PDFs and raster images without rendering samples')
    args = ap.parse_args()

    for name in args.samples:
        if name not in SAMPLES:
            sys.exit(f'unknown sample {name}; choose from: {", ".join(SAMPLES)}')

    workdir = Path(args.workdir or (REPO / 'parity' / 'samples-out')).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    clone = workdir / 'weasyprint-samples'
    out = workdir / 'out'
    out.mkdir(exist_ok=True)

    if not args.html_only:
        ensure_samples(clone, args.samples)
        ensure_image()
        fonts_dir = extract_image_fonts(workdir)
        env_base = {'FONT_DIR': str(fonts_dir), 'PATH': '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
                    'HOME': str(Path.home())}

    results = []
    for name in args.samples:
        render_args = SAMPLES[name]
        py_pdf = out / f'{name}_py.pdf'
        ts_pdf = out / f'{name}_ts.pdf'
        if args.html_only:
            if not py_pdf.exists() or not ts_pdf.exists():
                sys.exit(f'cached PDFs missing for {name}; run without --html-only first')
            rp = rt = None
        else:
            # The clone is mounted at its host path (not /docs) so the oracle's
            # file URLs match the port's: WeasyPrint names raster XObjects by
            # md5(absolute image URL), so a different mount point shows up as a
            # naming-only "images B" grade with byte-identical images.
            rp = run(['docker', 'run', '--rm', '-v', f'{clone}:{clone}:ro', '-v', f'{out.resolve()}:/out',
                      IMAGE, '/venv/bin/python', '-m', 'weasyprint'] +
                     [a if a.startswith('-') else (a if a.startswith('/') else f'{clone}/{a}') for a in render_args]
                     + [f'/out/{py_pdf.name}'])
            rt = run(['node', str(REPO / 'src' / 'cli' / 'main.ts')] + render_args + [str(ts_pdf)],
                     cwd=clone, env=env_base)
            if rp.returncode or rt.returncode:
                results.append((name, None, '❌ render failed',
                                [f'python rc={rp.returncode} ts rc={rt.returncode}'],
                                (rp.stderr if rp.returncode else rt.stderr or '')[-200:]))
                continue
        if not args.html_only:
            rasterize(str(ts_pdf), str(out / f'{name}-ts'))
            rasterize(str(py_pdf), str(out / f'{name}-py'))
        diag = run([sys.executable, str(REPO / 'parity' / 'diagnose.py'),
                    str(ts_pdf), str(py_pdf), '--json'])
        rep = json.loads(diag.stdout)
        grades, _pct = grade_sample(rep)
        line = badge_line(rep, grades)
        causes = causes_from_report(rep)
        # per-page images for the synchronized-scroll viewer
        import glob as _g
        ts_pages = sorted(_g.glob(str(out / f'{name}-ts-[0-9]*.png')))
        py_pages = sorted(_g.glob(str(out / f'{name}-py-[0-9]*.png')))
        results.append((name, grades, line, causes, json.dumps(rep), ts_pages, py_pages))

    # ---- corpus grade table -------------------------------------------
    CATS = ['pages', 'fonts', 'palette', 'images', 'text', 'links', 'pixels', 'overall']
    head = ''.join(f'<th>{c}</th>' for c in CATS)
    rows = []
    for name, grades, line, causes, _, ts_pages, py_pages in results:
        if grades is None:
            rows.append(f'<tr><td>{name}</td><td colspan="{len(CATS)}" class="gF">render failed</td></tr>')
            continue
        cells = ''.join(f'<td class="g{g}">{g}</td>' for k, g in grades.items() if k != 'overall')
        rows.append(f'<tr><td><a href="#{name}">{name}</a></td>{cells}'
                    f'<td class="g{grades["overall"]}">{grades["overall"]}</td></tr>')
    table = (f'<table><thead><tr><th>sample</th>{head}</tr></thead><tbody>'
             + ''.join(rows) + '</tbody></table>')

    # ---- per-sample sections ------------------------------------------
    sections = []
    for name, grades, line, causes, _, ts_pages, py_pages in results:
        why = '<pre class="why">' + '\n'.join(causes) + '</pre>' if causes else ''
        chips = ''
        if grades:
            chips = ' '.join(f'<span class="chip g{g}">{k} {g}</span>'
                             for k, g in grades.items() if k != 'overall')
        # Synchronized-scroll pixel panes: each page rendered by the SAME
        # Ghostscript raster the grader uses, stacked top-to-bottom, scroll
        # linked proportionally between the two columns.
        px_cols = ''
        if ts_pages and py_pages:
            def col(pages, label, label_text, pdf_name):
                imgs = ''.join(
                    f'<div class="pg" data-i="{i}"><a href="{p.split("/")[-1]}" target="_blank" rel="noopener"><img src="{p.split("/")[-1]}" alt="p"></a><span class="pnum">{i}</span></div>'
                    for i, p in enumerate(pages, 1))

                return (f'<div class="pane" id="pane-{name}-{label}">'
                        f'<div class="plabel"><span>{label_text}</span><a href="{pdf_name}" target="_blank" rel="noopener">open PDF</a></div>'
                        f'{imgs}'
                        f'</div>')
            n_pages = max(len(ts_pages), len(py_pages))
            pager = (f'<div class="pager" data-n="{n_pages}" data-cur="1">'
                     f'<button data-d="-1">&larr; Previous</button>'
                     f'<span class="pinfo"></span>'
                     f'<button data-d="1">Next &rarr;</button></div>') if n_pages > 1 else ''
            px_cols = (pager + f'<div class="syncpair">'
                       f'{col(py_pages, "py", "WeasyPrint (Python, pinned image)", f"{name}_py.pdf")}'
                       f'{col(ts_pages, "ts", "weasyprint-ts", f"{name}_ts.pdf")}'
                       f'</div>')

        sections.append(f'<section id="{name}"><h2>{name}</h2>'
                        f'<span class="badge">{line}</span>{chips}{why}'
                        f'{px_cols}</section>')
    html = f'''<!doctype html><html><head><meta charset="utf-8"><title>WeasyPrint samples: python vs weasyprint-ts — graded</title>
<style>
body {{ font-family: -apple-system, sans-serif; background: #1e1e1e; color: #ddd;
        margin: 28px 56px 80px; max-width: 1700px; }}
h1 {{ font-size: 20px; }} h2 {{ font-size: 16px; margin: 30px 0 6px; }}
table {{ border-collapse: collapse; margin: 10px 0 20px; }}
th, td {{ padding: 3px 10px; text-align: center; font-size: 13px; border-bottom: 1px solid #333; }}
th {{ color: #999; font-weight: 500; }} td:first-child {{ text-align: left; }}
 a {{ color: #8cf; }}
.badge {{ font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #333; }}
.chip {{ font-size: 11px; padding: 1px 7px; border-radius: 8px; margin-left: 4px; }}
.gA {{ background: #1b3a1b; color: #7bd77b; }} .gB {{ background: #243a1b; color: #a5d77b; }}
.gC {{ background: #3a3a1b; color: #d7d77b; }} .gD {{ background: #3a2a1b; color: #d7a57b; }}
.gE {{ background: #3a1f1b; color: #ff9c7b; }} .gF {{ background: #4a1b1b; color: #ff9c9c; }}
.why {{ font-size: 11px; color: #9cd; text-align: left; white-space: pre-wrap; background: #262626;
        padding: 6px 10px; border-radius: 6px; max-width: 60vw; }}
.modes {{ margin: 4px 0; }}
.modes label {{ display: inline-block; margin-right: 14px; }}
.pair {{ display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }}
.pair > div {{ flex: 1; text-align: center; }}
iframe {{ width: 48vw; height: 88vh; border: 1px solid #444; background: #666; }}
.syncpair {{ display: flex; gap: 16px; margin-bottom: 28px; padding: 0 8px; }}
.syncpair .pane {{ flex: 1; overflow: auto; height: 86vh; position: relative; border: 1px solid #444; background: #333;
                   margin-bottom: 22px; scrollbar-gutter: stable both-edges; }}
.plabel {{ position: sticky; top: 0; z-index: 2; background: #101010; color: #9cd;
            font-size: 11px; padding: 4px 8px; text-align: center; border-bottom: 1px solid #333; }}
.plabel a {{ margin-left: 8px; }}
.pg {{ position: relative; margin-bottom: 14px; }}
.pane img {{ width: 100%; display: block; }}
.pnum {{ position: absolute; left: 4px; top: 4px; font-size: 10px; color: #eee;
         background: #000a; padding: 0 5px; border-radius: 6px; }}
.pdforpx .pane {{ display: none; }}
.pdflinks {{ display: inline-block; margin-left: 12px; font-size: 12px; }}
 .pdflinks {{ display: inline-flex; gap: 12px; margin-left: 12px; font-size: 12px; }}
.pdflinks a {{ color: #9cf; }}
label {{ font-size: 12px; color: #aaa; display: block; margin-top: 3px; }}
.hint {{ color: #777; font-size: 11px; margin-bottom: 20px; }}
.pager {{ display: flex; justify-content: center; align-items: center; gap: 18px; margin: 10px 0 14px; }}
.pager button {{ background: #2a2a2a; color: #ddd; border: 1px solid #555; border-radius: 6px;
                 padding: 5px 14px; font-size: 13px; cursor: pointer; }}
.pager button:hover:not(:disabled) {{ background: #3a3a3a; }}
.pager button:disabled {{ opacity: 0.35; cursor: default; }}
.pager .pinfo {{ font-size: 13px; color: #bbb; min-width: 110px; text-align: center; }}
</style>
<script>
let syncing = false;
function fitPanes() {{
  document.querySelectorAll('.syncpair').forEach(pair => {{
    const panes = [...pair.querySelectorAll('.pane')];
    const maxH = window.innerHeight * 0.86;
    let target = maxH;
    panes.forEach(pane => {{
      const content = pane.querySelector('.plabel').offsetHeight +
        [...pane.querySelectorAll('.pg')].reduce((sum, page) =>
          sum + page.offsetHeight + parseFloat(getComputedStyle(page).marginBottom), 0);
      if (content < maxH) target = Math.min(target, content + 48);
    }});
    panes.forEach(pane => {{ pane.style.height = Math.floor(target) + 'px'; }});
  }});
}}
// Pager label + button state for page i (no scrolling).
function setLabel(sec, i) {{
  const pager = sec.querySelector('.pager');
  if (!pager) return;
  const n = +pager.dataset.n;
  i = Math.max(1, Math.min(n, i));
  pager.dataset.cur = i;
  pager.querySelector('.pinfo').textContent = 'Page ' + i + ' of ' + n;
  pager.querySelector('[data-d="-1"]').disabled = i <= 1;
  pager.querySelector('[data-d="1"]').disabled = i >= n;
}}
// Page whose top is at (or last above) the pane's scroll position.
function pageAtScroll(pane) {{
  const top = pane.scrollTop + pane.querySelector('.plabel').offsetHeight + 4;
  let idx = 1;
  pane.querySelectorAll('.pg').forEach(pg => {{ if (pg.offsetTop <= top) idx = +pg.dataset.i; }});
  return idx;
}}
// Pager: scroll every pane of the section so its page i sits at the top.
function showPage(sec, i) {{
  const pager = sec.querySelector('.pager');
  if (!pager) return;
  i = Math.max(1, Math.min(+pager.dataset.n, i));
  setLabel(sec, i);
  syncing = true;
  sec.querySelectorAll('.pane').forEach(pane => {{
    const pg = pane.querySelector('.pg[data-i="' + i + '"]');
    if (pg) pane.scrollTo({{ top: pg.offsetTop - pane.querySelector('.plabel').offsetHeight, behavior: 'auto' }});
  }});
  window.requestAnimationFrame(() => {{ syncing = false; }});
}}
document.addEventListener('click', e => {{
  const b = e.target.closest('.pager button');
  if (!b || b.disabled) return;
  const sec = b.closest('section');
  showPage(sec, +sec.querySelector('.pager').dataset.cur + +b.dataset.d);
}});
window.addEventListener('load', fitPanes);
window.addEventListener('resize', fitPanes);
window.addEventListener('DOMContentLoaded', () => {{
  fitPanes();
  setTimeout(fitPanes, 400);
  document.querySelectorAll('.syncpair img').forEach(img => {{
    if (!img.complete) img.addEventListener('load', fitPanes);
  }});
  document.querySelectorAll('.syncpair').forEach(pair => {{
    pair.querySelectorAll('.pane').forEach(pane => {{
      pane.addEventListener('scroll', () => {{
        // Manual scrolling updates the page indicator for this section.
        if (!syncing) setLabel(pair.closest('section'), pageAtScroll(pane));
        if (syncing) return;
        syncing = true;
        const baseH = pane.scrollHeight - pane.clientHeight;
        const ratio = baseH > 0 ? pane.scrollTop / baseH : 0;
        pair.querySelectorAll('.pane').forEach(other => {{
          if (other === pane) return;
          other.scrollTop = ratio * (other.scrollHeight - other.clientHeight);
        }});
        window.requestAnimationFrame(() => {{ syncing = false; }});
      }});
    }});
  }});
  document.querySelectorAll('section').forEach(sec => showPage(sec, 1));
}});
</script>
</head><body>
<h1>Official WeasyPrint samples — Python oracle vs weasyprint-ts, graded</h1>
<p class="hint">Grades from parity/diagnose.py structural diff: A = exact; B = naming-only or visually-absent (no strong diffs);
C/D = small counts; E/F = real divergence. Links compare annotation counts and URI targets.
Pixels grade by differing %: A 0 · B ≤0.1 · C ≤1 · D ≤5 · E ≤15 · F else — but a weak-only
wash (zero visible diffs) caps at B. Oracle: pinned Docker image. Port: the image's exact font files.
Pane scroll is linked proportionally; page numbers are on each rendered page.</p>
{table}
{chr(10).join(sections)}
</body></html>'''
    report = out / 'side_by_side.html'
    report.write_text(html)
    print(f'\nreport -> {report}')
    for name, grades, line, causes, _, ts_pages, py_pages in results:
        print(f"  {name:16} {line}")
    return 1 if any(g and g['overall'] != 'A' for _, g, _, _, _, _x, _y in results) else 0


if __name__ == '__main__':
    sys.exit(main())
