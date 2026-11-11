# SPDX-License-Identifier: BSD-3-Clause

"""Dump the oracle box tree exactly like the parity harness renders (upstream tests.testing_utils.FakeHTML: tests_ua.css
replaces the UA sheet). Run in the oracle container with the upstream checkout mounted at /upstream, from the cases dir:
  docker run --rm -v "$PWD:/w:ro" -v <upstream-checkout>:/upstream:ro -v <repo>/parity/dump_layout_fake.py:/d.py:ro \
    weasy-alpine-prod:latest sh -c "cd /w && /venv/bin/python /d.py /w/CASE.html" > oracle.json
Compare with tools/layout_dump_ua.ts (port) using parity/cmp_layout.py oracle.json port.json.
"""
import json, logging, sys
sys.path.insert(0, "/upstream")
from tests.testing_utils import FakeHTML
logging.getLogger('weasyprint').setLevel(logging.CRITICAL)
doc = FakeHTML(filename=sys.argv[1]).render()
out = []
def walk(box, page):
    out.append(dict(type=type(box).__name__, tag=box.element_tag, page=page, x=box.position_x, y=box.position_y,
                    width=box.width, height=box.height, text=getattr(box, 'text', None)))
    for child in getattr(box, 'children', ()):
        if hasattr(child, 'position_x'):
            walk(child, page)
for i, page in enumerate(doc.pages):
    walk(page._page_box, i)
print(json.dumps(dict(pages=len(doc.pages), boxes=out)))
