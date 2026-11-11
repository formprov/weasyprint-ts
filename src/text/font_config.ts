// SPDX-License-Identifier: BSD-3-Clause

/**
 * Font matching, replacing FontConfig for a pinned set of fonts.
 *
 * Fonts are registered from a `FontSource` list (the Node adapter scans
 * directories). Family aliases (what FontConfig's conf.d files do: Helvetica ->
 * Arial, sans-serif -> Noto Sans, ...) come from a `FontProfile` generated from
 * the reference environment (see tools/fc_profile.*).
 */
import * as fontkit from 'fontkit';

/**
 * fontkit.create accepts any Uint8Array at runtime (verified), but its type
 * declaration asks for the Node byte-string type. Keep the core free of Node
 * globals by casting at the single fontkit boundary.
 */
export function asFontkitInput(bytes: Uint8Array): any {
  return bytes;
}

export interface FontSource {
  /** Stable identifier (a path). */
  id: string;
  read(): Uint8Array;
  /** Pre-parsed metadata (from the Node adapter's font-index cache): skips startup parsing. */
  cachedMeta?: { family: string; fullName: string; weight: number; width: number; italic: boolean; size: number };
  /** For font collections (.ttc): the member index within the file. */
  collectionIndex?: number;
  /** @font-face: OpenType features fontconfig attaches to the font (FC_FONT_FEATURES, Pango applies them first). */
  features?: Record<string, number>;
  /** @font-face unicode-range: replaces the font's charset (fontconfig 'charset' assign_replace). */
  unicodeRanges?: Array<[number, number]> | null;
}

export interface FontProfile {
  /** Lower-cased requested family -> installed family name. */
  aliases: Record<string, string>;
  /** Installed families tried, in order, when the requested ones do not exist or lack a glyph. */
  fallback: string[];
}

export class FontFace {
  id: string;
  family: string;
  fullName: string;
  weight: number;
  width: number;
  italic: boolean;
  private source: FontSource;
  private font: any = null;
  private cmapCache = new Map<number, boolean>();

  constructor(source: FontSource, meta: { family: string; fullName: string; weight: number; width: number; italic: boolean }) {
    this.source = source;
    this.id = source.id;
    this.family = meta.family;
    this.fullName = meta.fullName;
    this.weight = meta.weight;
    this.width = meta.width;
    this.italic = meta.italic;
    this.collectionIndex = source.collectionIndex;
    this.features = source.features ?? {};
    this.unicodeRanges = source.unicodeRanges ?? null;
  }

  /** OpenType features attached to this face by its @font-face rule. */
  features: Record<string, number>;
  private unicodeRanges: Array<[number, number]> | null;

  /** For font collections (.ttc): the member index within the file. */
  collectionIndex?: number;

  get fk(): any {
    if (this.font === null) {
      const created: any = fontkit.create(asFontkitInput(this.source.read()));
      // Font collections: index into the member fonts.
      this.font = Array.isArray(created?.fonts) ? created.fonts[this.collectionIndex ?? 0] : created;
    }
    return this.font;
  }

  get bytes(): Uint8Array {
    return this.source.read();
  }

  hasGlyph(codePoint: number): boolean {
    let r = this.cmapCache.get(codePoint);
    if (r === undefined) {
      // A unicode-range replaces the coverage fontconfig reports (even for code points the font lacks).
      r = this.unicodeRanges
        ? this.unicodeRanges.some(([start, end]) => codePoint >= start && codePoint <= end)
        : Boolean(this.fk.hasGlyphForCodePoint(codePoint));
      this.cmapCache.set(codePoint, r);
    }
    return r;
  }
}

function cssWeight(desired: number, available: number[]): number {
  if (available.includes(desired)) return desired;
  const below = available.filter((w) => w < desired).sort((a, b) => b - a);
  const above = available.filter((w) => w > desired).sort((a, b) => a - b);
  if (desired >= 400 && desired <= 500) {
    const mid = available.filter((w) => w > desired && w <= 500).sort((a, b) => a - b);
    return mid[0] ?? below[0] ?? above[0];
  }
  return desired < 400 ? (below[0] ?? above[0]) : (above[0] ?? below[0]);
}

export const STRETCH_CLASS: Record<string, number> = {
  'ultra-condensed': 1, 'extra-condensed': 2, condensed: 3, 'semi-condensed': 4, normal: 5,
  'semi-expanded': 6, expanded: 7, 'extra-expanded': 8, 'ultra-expanded': 9,
};

export class FontConfiguration {
  faces: FontFace[] = [];
  private byFamily = new Map<string, FontFace[]>();
  profile: FontProfile;
  /** Caches keyed by style (strut layouts, font features, ...). */
  strutLayouts = new Map<string, [number, number]>();
  private matchCache = new Map<string, FontFace[]>();

  constructor(profile: FontProfile = { aliases: {}, fallback: [] }) {
    this.profile = profile;
  }

  addSources(sources: Iterable<FontSource>): void {
    const seen = new Set<string>();
    for (const source of sources) {
      let meta;
      try {
        if (source.cachedMeta) {
          meta = source.cachedMeta;
        } else {
          const bytes = source.read();
          const fk: any = fontkit.create(asFontkitInput(bytes));
          if (Array.isArray(fk.fonts)) continue; // collections not supported yet
          const os2 = fk['OS/2'];
          meta = {
            family: fk.getName('preferredFamily') ?? fk.familyName,
            fullName: fk.fullName ?? '',
            weight: os2.usWeightClass, width: os2.usWidthClass,
            italic: Boolean(os2.fsSelection.italic) || fk.italicAngle !== 0,
          };
        }
        const key = `${meta.family}|${meta.weight}|${meta.width}|${meta.italic}|${meta.size}`;
        if (seen.has(key)) continue; // msttcorefonts installs duplicate files
        seen.add(key);
      } catch {
        continue;
      }
      const face = new FontFace(source, meta);
      this.faces.push(face);
      const k = face.family.toLowerCase();
      if (!this.byFamily.has(k)) this.byFamily.set(k, []);
      this.byFamily.get(k)!.push(face);
    }
    this.matchCache.clear();
  }

  private pickFace(family: string, weight: number, italic: boolean, stretch: number): FontFace | null {
    let faces = this.byFamily.get(family.toLowerCase());
    if (!faces) return null;
    const bestWidth = Math.min(...faces.map((f) => Math.abs(f.width - stretch)));
    faces = faces.filter((f) => Math.abs(f.width - stretch) === bestWidth);
    const styled = faces.filter((f) => f.italic === italic);
    if (styled.length) faces = styled;
    const w = cssWeight(weight, [...new Set(faces.map((f) => f.weight))]);
    return faces.find((f) => f.weight === w) ?? null;
  }

  /** Ordered list of faces to use for a style: requested families first, then fallbacks. */
  match(families: string[], weight: number, fontStyle: string, fontStretch: string): FontFace[] {
    const key = `${families.join(',')}|${weight}|${fontStyle}|${fontStretch}`;
    const cached = this.matchCache.get(key);
    if (cached) return cached;
    const italic = fontStyle !== 'normal';
    const stretch = STRETCH_CLASS[fontStretch] ?? 5;
    const out: FontFace[] = [];
    const add = (f: FontFace | null): void => {
      if (f && !out.includes(f)) out.push(f);
    };
    for (const raw of [...families, ...this.profile.fallback]) {
      const name = this.profile.aliases[raw.toLowerCase()] ?? raw;
      add(this.pickFace(name, weight, italic, stretch));
    }
    if (!out.length) add(this.faces[0] ?? null);
    this.matchCache.set(key, out);
    return out;
  }
}