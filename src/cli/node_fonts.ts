// SPDX-License-Identifier: BSD-3-Clause

/** Node adapter: scan directories for font files and build a FontConfiguration. */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fontkit from 'fontkit';
import { FontConfiguration, asFontkitInput } from '../text/font_config.ts';
import { setHyphenationDictionary } from '../text/hyphenator.ts';
import type { FontProfile, FontSource } from '../text/font_config.ts';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path); // follows symlinks
    } catch {
      continue;
    }
    if (stat.isDirectory()) yield* walk(path);
    else if (/\.(ttf|otf|ttc|otc)$/i.test(name)) yield path;
  }
}

/** Metadata cached per font file so startup only parses new/changed files. */
interface CachedMeta {
  family: string;
  fullName: string;
  weight: number;
  width: number;
  italic: boolean;
  size: number;
  mtimeMs: number;
}

interface CachedFile {
  size: number;
  mtimeMs: number;
  faces: CachedMeta[];
}

function loadCache(dir: string): Record<string, CachedFile> {
  try {
    return JSON.parse(readFileSync(join(dir, '.weasyprint-ts-font-index.json'), 'utf8'));
  } catch {
    return {};
  }
}

function saveCache(dir: string, cache: Record<string, CachedFile>): void {
  try {
    writeFileSync(join(dir, '.weasyprint-ts-font-index.json'), JSON.stringify(cache));
  } catch {
    // Read-only directory: caching is best-effort.
  }
}

/** The system font directories fontconfig scans by default (per platform). */
function systemFontDirs(): string[] {
  const home = homedir();
  switch (process.platform) {
    case 'darwin':
      return ['/System/Library/Fonts', '/Library/Fonts', `${home}/Library/Fonts`];
    case 'win32':
      return [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')];
    default:
      return ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local/share/fonts'), join(home, '.fonts')];
  }
}

/** Default font directories, in priority order: FONT_DIR (colon-separated)
 * when set; then the system font directories, mirroring fontconfig's default
 * discovery. Nothing outside the package is scanned by convention. */
export function defaultFontDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.FONT_DIR) dirs.push(...process.env.FONT_DIR.split(':').filter(Boolean));
  dirs.push(...systemFontDirs());
  return dirs;
}

export function scanFontDirectories(dirs: string[]): FontSource[] {
  const sources: FontSource[] = [];
  for (const dir of dirs) {
    try {
      const cache = loadCache(dir);
      let dirty = false;
      const files = [...walk(dir)];
      const seenKeys = new Set<string>();
      const metas = new Map<string, CachedMeta>();
      for (const path of files) {
        const stat = statSync(path);
        const cacheKey = `${path}`;
        seenKeys.add(cacheKey);
        const cached = cache[cacheKey];
        if (cached && Array.isArray(cached.faces) && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
          cached.faces.forEach((meta, index) => metas.set(index === 0 ? path : `${path}#${index}`, meta));
          continue;
        }
        // Parse metadata now (the only read at startup), then cache it.
        try {
          const bytes = readFileSync(path);
          const fk: any = fontkit.create(asFontkitInput(bytes));
          const members: any[] = Array.isArray(fk.fonts) ? fk.fonts : [fk];
          const faces: CachedMeta[] = [];
          for (const member of members) {
            const os2 = member['OS/2'];
            if (!os2) continue;
            faces.push({
              family: member.getName('preferredFamily') ?? member.familyName,
              fullName: member.fullName ?? '',
              weight: os2.usWeightClass, width: os2.usWidthClass,
              italic: Boolean(os2.fsSelection.italic) || member.italicAngle !== 0,
              size: stat.size, mtimeMs: stat.mtimeMs,
            });
          }
          if (!faces.length) continue;
          faces.forEach((meta, index) => metas.set(index === 0 ? path : `${path}#${index}`, meta));
          cache[cacheKey] = { size: stat.size, mtimeMs: stat.mtimeMs, faces };
          dirty = true;
        } catch {
          continue;
        }
      }
      for (const key of Object.keys(cache)) if (!seenKeys.has(key)) { delete cache[key]; dirty = true; }
      if (dirty) saveCache(dir, cache);
      for (const [pathKey, meta] of metas) {
        const hash = pathKey.indexOf('#');
        const path = hash >= 0 ? pathKey.slice(0, hash) : pathKey;
        sources.push({
          id: pathKey, read: () => new Uint8Array(readFileSync(path)), cachedMeta: meta,
          collectionIndex: hash >= 0 ? Number(pathKey.slice(hash + 1)) : undefined,
        });
      }
    } catch {
      // Missing directory: ignore, like FontConfig.
    }
  }
  return sources;
}

export function createFontConfiguration(dirs: string[], profile: FontProfile): FontConfiguration {
  const fc = new FontConfiguration(profile);
  fc.addSources(scanFontDirectories(dirs));
  discoverHyphenationDictionaries(dirs);
  return fc;
}

/** Discover hyph_*.dic pattern files: a `dictionaries/` subdirectory of each
 * font dir, the font dir itself, and the DICTIONARIES_DIR environment
 * variable. Mirrors the font discovery philosophy: no dictionaries are
 * bundled; missing ones degrade `hyphens: auto` to soft-hyphen-only breaks. */
export function discoverHyphenationDictionaries(dirs: string[]): void {
  const candidates: string[] = [];
  for (const dir of dirs) {
    candidates.push(join(dir, 'dictionaries'), dir);
  }
  if (process.env.DICTIONARIES_DIR) candidates.push(process.env.DICTIONARIES_DIR);
  for (const dir of candidates) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/^hyph_[a-zA-Z_]+\.dic$/.test(entry)) continue;
      const lang = entry.slice(5, -4).replace(/_/g, '-').toLowerCase();
      try {
        setHyphenationDictionary(lang, readFileSync(join(dir, entry), 'utf8'));
      } catch {
        // unreadable dictionary: skip it
      }
    }
  }
}