# SPDX-License-Identifier: BSD-3-Clause

import json, sys
a = json.load(open(sys.argv[1])); b = json.load(open(sys.argv[2]))
tol = float(sys.argv[3]) if len(sys.argv) > 3 else 1e-6
print('pages', a['pages'], b['pages'], '| boxes', len(a['boxes']), len(b['boxes']))
def num(v): return v if isinstance(v, (int, float)) else None
bad = 0; first = None
for i, (x, y) in enumerate(zip(a['boxes'], b['boxes'])):
    diff = []
    if x['type'] != y['type'] or x['tag'] != y['tag'] or x['page'] != y['page']:
        diff.append(('type/tag/page', (x['type'], x['tag'], x['page']), (y['type'], y['tag'], y['page'])))
    else:
        for k in ('x', 'y', 'width', 'height'):
            xv, yv = x[k], y[k]
            if isinstance(xv, str) or isinstance(yv, str) or xv is None or yv is None:
                if xv != yv: diff.append((k, xv, yv))
            elif abs(xv - yv) > tol:
                diff.append((k, round(xv, 4), round(yv, 4)))
    if diff:
        bad += 1
        if first is None: first = (i, x['type'], x['tag'], diff)
print(f'{bad} of {min(len(a["boxes"]), len(b["boxes"]))} boxes differ')
if first: print('first difference at box', first)