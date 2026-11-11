# SPDX-License-Identifier: BSD-3-Clause

"""Lay out a document with WeasyPrint and dump every box (type, tag, page, geometry), like weasyprint-ts/tools/layout_dump.ts.

Images are made unavailable (url_fetcher raises) so that both sides lay out without them.
"""
import json, logging, sys
from weasyprint import HTML, CSS
from weasyprint.formatting_structure import boxes

logging.getLogger('weasyprint').setLevel(logging.CRITICAL)

from weasyprint.urls import URLFetcher
class NoFetch(URLFetcher):
    def fetch(self, url, headers=None):
        raise ValueError('no network')

file = sys.argv[1]
user = [CSS(filename=sys.argv[2])] if len(sys.argv) > 2 else []
doc = HTML(filename=file).render(stylesheets=user)
out = []
def walk(box, page):
    out.append(dict(type=type(box).__name__, tag=box.element_tag, page=page, x=box.position_x, y=box.position_y,
                    width=box.width, height=box.height))
    for child in getattr(box, 'children', ()):
        if hasattr(child, 'position_x'):
            walk(child, page)
for i, page in enumerate(doc.pages):
    walk(page._page_box, i)
print(json.dumps(dict(pages=len(doc.pages), boxes=out)))