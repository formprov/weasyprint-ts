# SPDX-License-Identifier: BSD-3-Clause

"""Shared oracle plumbing for the parity scripts.

"The oracle" is always the same thing: Python WeasyPrint 70 running in the
pinned Alpine image built from `parity/docker/alpine-prod-Dockerfile`, with its
fonts and hyphenation dictionaries. This module builds that image on first use,
extracts its font set into a cache both engines can read, and locates the
upstream checkout the bank generators need.
"""

import io
import os
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
IMAGE = 'weasy-alpine-prod:latest'
CACHE = Path(os.environ.get('WEASY_PARITY_CACHE', Path.home() / '.cache' / 'weasy-parity'))


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ensure_image() -> None:
    """Build the pinned oracle image if it is not in the local Docker store."""
    if run(['docker', 'image', 'inspect', IMAGE]).returncode == 0:
        return
    print(f'building {IMAGE} (once, takes a few minutes)...')
    dockerfile = REPO / 'parity' / 'docker' / 'alpine-prod-Dockerfile'
    result = run(['docker', 'build', '-t', IMAGE, '-f', str(dockerfile), str(dockerfile.parent)])
    if result.returncode != 0:
        sys.exit('image build failed: ' + result.stderr.strip()[-400:])


def image_fonts() -> Path:
    """Extract the image's fonts and pyphen dictionaries, once per image id.

    Both engines must see byte-identical files: a host fontconfig fallback can
    silently change advances, and pyphen's pattern data decides where
    `hyphens: auto` breaks. The returned directory works as `FONT_DIR`; the
    port discovers `dictionaries/` inside it.
    """
    ensure_image()
    image_id = run(['docker', 'image', 'inspect', '-f', '{{.Id}}', IMAGE]).stdout.strip()
    fonts = CACHE / 'image-fonts'
    marker = fonts / '.image-id'
    if (marker.is_file() and marker.read_text().strip() == image_id
            and any(fonts.glob('**/*.ttf'))):
        return fonts

    staging = CACHE / 'image-fonts-staging'
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)

    tar = subprocess.run(
        ['docker', 'run', '--rm', IMAGE, '/bin/sh', '-c', 'tar -C /usr/share/fonts -c .'],
        capture_output=True)
    if tar.returncode != 0:
        sys.exit('font extraction failed: ' + tar.stderr.decode(errors='replace')[-400:])
    _extract(tar.stdout, staging)

    dictionaries = subprocess.run(
        ['docker', 'run', '--rm', IMAGE, '/bin/sh', '-c',
         'cd /venv/lib/python*/site-packages/pyphen/dictionaries 2>/dev/null && tar -c .'],
        capture_output=True)
    if dictionaries.returncode == 0 and dictionaries.stdout:
        _extract(dictionaries.stdout, staging / 'dictionaries')

    shutil.rmtree(fonts, ignore_errors=True)
    staging.replace(fonts)
    marker.write_text(image_id)
    return fonts


def _extract(archive: bytes, target: Path) -> None:
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        # Skip symlinks: fontconfig's alias farm (msttcorefonts) can loop. The
        # real files are all present.
        members = [m for m in tar.getmembers() if not m.issym() and not m.islnk()]
        try:
            tar.extractall(target, members=members, filter='data')
        except TypeError:  # Python < 3.12
            tar.extractall(target, members=members)


def upstream_dir(required: bool = False) -> Path | None:
    """The WeasyPrint checkout used to regenerate the banks (env: UPSTREAM_DIR).

    Defaults to `../reference_code/WeasyPrint`, the layout the workspace uses,
    but the scripts never assume it: a plain clone anywhere works.
    """
    configured = os.environ.get('UPSTREAM_DIR')
    path = Path(configured).expanduser() if configured else REPO.parent / 'reference_code' / 'WeasyPrint'
    path = path.resolve()
    if (path / 'tests' / 'testing_utils.py').is_file():
        return path
    if required:
        sys.exit(
            f'upstream WeasyPrint checkout not found at {path}\n'
            'clone it with:\n'
            f'  git clone --depth 1 --branch v70.0 https://github.com/Kozea/WeasyPrint {path}\n'
            'or set UPSTREAM_DIR to an existing checkout')
    return None
