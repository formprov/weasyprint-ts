// SPDX-License-Identifier: BSD-3-Clause

/**
 * HarfBuzz's fallback mark positioning (hb-ot-shape-fallback.cc).
 *
 * Fonts without a GPOS table get no mark attachment from OpenType, but
 * HarfBuzz still places combining marks above/below their base using the
 * glyph outlines, the modified combining class and a 1/16 em gap. Arial is
 * the font that matters here: its Hebrew niqqud and Arabic harakat are
 * positioned this way in Pango, so the port must reproduce it.
 */
import { isUnicodeMark, modifiedCombiningClass } from './normalize.ts';
import { scale } from './shaper.ts';

interface Extents { xBearing: number; yBearing: number; width: number; height: number }

// hb-unicode.h combining classes used by the fallback.
const ATTACHED_BELOW_LEFT = 200;
const ATTACHED_BELOW = 202;
const ATTACHED_ABOVE = 214;
const ATTACHED_ABOVE_RIGHT = 216;
const BELOW_LEFT = 218;
const BELOW = 220;
const BELOW_RIGHT = 222;
const ABOVE_LEFT = 228;
const ABOVE = 230;
const ABOVE_RIGHT = 232;
const DOUBLE_BELOW = 233;
const DOUBLE_ABOVE = 234;

/** HarfBuzz's recategorize_combining_class: map Unicode classes to positioning classes. */
function recategorize(cp: number, klass: number): number {
  if (klass >= 200) return klass;
  if ((cp & ~0xff) === 0x0e00) {
    if (klass === 0) {
      switch (cp) {
        case 0x0e31: case 0x0e34: case 0x0e35: case 0x0e36: case 0x0e37:
        case 0x0e47: case 0x0e4c: case 0x0e4d: case 0x0e4e:
          klass = ABOVE_RIGHT;
          break;
        case 0x0eb1: case 0x0eb4: case 0x0eb5: case 0x0eb6: case 0x0eb7:
        case 0x0ebb: case 0x0ecc: case 0x0ecd:
          klass = ABOVE;
          break;
        case 0x0ebc:
          klass = BELOW;
          break;
      }
    } else if (cp === 0x0e3a) {
      klass = BELOW_RIGHT;
    }
  }
  // The case labels are HarfBuzz's *modified* classes (hb-unicode.hh
  // HB_MODIFIED_COMBINING_CLASS_CCC*), not the raw UnicodeData values.
  switch (klass) {
    // Hebrew: sheva, hataf segol/patah/qamats, hiriq, tsere, segol, patah,
    // qamats, qubuts, meteg.
    case 22: case 15: case 16: case 17: case 23: case 18: case 19: case 20: case 21:
    case 24: case 25:
      return BELOW;
    case 13: // rafe
      return ATTACHED_ABOVE;
    case 10: // shin dot
      return ABOVE_RIGHT;
    case 11: // sin dot
    case 14: // holam
      return ABOVE_LEFT;
    case 26: // point varika
      return ABOVE;
    case 12: // dagesh
      break;
    // Arabic and Syriac: fathatan, dammatan, fatha, damma, shadda, sukun,
    // superscript alef/alaph.
    case 28: case 29: case 31: case 32: case 27: case 34: case 35: case 36:
      return ABOVE;
    case 30: // kasratan
    case 33: // kasra
      return BELOW;
    // Thai
    case 3: // sara u / sara uu
      return BELOW_RIGHT;
    case 107: // mai
      return ABOVE_RIGHT;
    // Lao
    case 118:
      return BELOW;
    case 122:
      return ABOVE;
    // Tibetan
    case 129:
      return BELOW;
    case 132:
      return ABOVE;
    case 131:
      return BELOW;
  }
  return klass;
}

/** Glyph extents in Pango units, or null when the glyph has no outline. */
function glyphExtents(font: any, gid: number, size: number, upem: number): Extents | null {
  const glyph = font.getGlyph(gid);
  const bbox = glyph?.bbox;
  // Bitmap-only fonts (OTB) have no outline extents; HarfBuzz reports failure
  // and the fallback then just zeroes the mark advances.
  if (!bbox || ![bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].every(Number.isFinite)) return null;
  // HarfBuzz works in integer font units; fontkit reports fractional CFF boxes.
  const int = (value: number): number => Math.trunc(value);
  return {
    xBearing: scale(int(bbox.minX), size, upem),
    yBearing: scale(int(bbox.maxY), size, upem),
    width: scale(int(bbox.maxX) - int(bbox.minX), size, upem),
    height: scale(int(bbox.minY) - int(bbox.maxY), size, upem),
  };
}

/** position_mark(): place one mark on the accumulated cluster extents. */
function positionMark(mark: Extents, base: Extents, klass: number, yGap: number, rtl: boolean): [number, number] {
  let xOffset = 0;
  let yOffset = 0;
  switch (klass) {
    case DOUBLE_BELOW:
    case DOUBLE_ABOVE:
      if (!rtl) {
        xOffset += base.xBearing + base.width - Math.trunc(mark.width / 2) - mark.xBearing;
        break;
      }
      xOffset += base.xBearing - Math.trunc(mark.width / 2) - mark.xBearing;
      break;
    case ATTACHED_BELOW:
    case ATTACHED_ABOVE:
    case BELOW:
    case ABOVE:
      xOffset += base.xBearing + Math.trunc((base.width - mark.width) / 2) - mark.xBearing;
      break;
    case ATTACHED_BELOW_LEFT:
    case BELOW_LEFT:
    case ABOVE_LEFT:
      xOffset += base.xBearing - mark.xBearing;
      break;
    case ATTACHED_ABOVE_RIGHT:
    case BELOW_RIGHT:
    case ABOVE_RIGHT:
      xOffset += base.xBearing + base.width - mark.width - mark.xBearing;
      break;
  }

  switch (klass) {
    case DOUBLE_BELOW:
    case BELOW_LEFT:
    case BELOW:
    case BELOW_RIGHT:
      base.height -= yGap;
    // fall through
    case ATTACHED_BELOW_LEFT:
    case ATTACHED_BELOW:
      yOffset = base.yBearing + base.height - mark.yBearing;
      if ((yGap > 0) === (yOffset > 0)) {
        base.height -= yOffset;
        yOffset = 0;
      }
      base.height += mark.height;
      break;
    case DOUBLE_ABOVE:
    case ABOVE_LEFT:
    case ABOVE:
    case ABOVE_RIGHT:
      base.yBearing += yGap;
      base.height -= yGap;
    // fall through
    case ATTACHED_ABOVE:
    case ATTACHED_ABOVE_RIGHT:
      yOffset = base.yBearing - (mark.yBearing + mark.height);
      if ((yGap > 0) !== (yOffset > 0)) {
        const correction = Math.trunc(-yOffset / 2);
        base.yBearing += correction;
        base.height -= correction;
        yOffset += correction;
      }
      base.yBearing -= mark.height;
      base.height += mark.height;
      break;
  }
  return [xOffset, yOffset];
}

/**
 * Apply fallback mark positioning in place to a fontkit run.
 *
 * `glyphs` and `positions` are fontkit's arrays in visual order (the buffer
 * order HarfBuzz positions in); `rtl` selects the backward bookkeeping.
 */
export function positionFallbackMarks(
  font: any, glyphs: any[], positions: any[], rtl: boolean, size: number, upem: number,
): Set<number> {
  // Offsets written here are already in Pango units (HarfBuzz computes in
  // scaled units); callers must not scale them a second time.
  const scaled = new Set<number>();
  const yGap = Math.trunc(size / 16);
  const isMarkGlyph = (index: number): boolean => {
    const cps: number[] = glyphs[index].codePoints ?? [];
    return cps.length > 0 && isUnicodeMark(cps[0]);
  };
  let i = 0;
  while (i < glyphs.length) {
    if (isMarkGlyph(i)) { i++; continue; }
    // The cluster: base at i, then consecutive mark glyphs.
    let end = i + 1;
    while (end < glyphs.length && isMarkGlyph(end)) end++;

    const baseExtents = glyphExtents(font, glyphs[i].id, size, upem);
    if (baseExtents === null) {
      for (let k = i + 1; k < end; k++) positions[k].xAdvance = positions[k].yAdvance = 0;
      i = end;
      continue;
    }
    baseExtents.yBearing += positions[i].yOffset;
    baseExtents.xBearing = 0;
    const advance = font.getGlyph(glyphs[i].id).advanceWidth;
    baseExtents.width = Number.isFinite(advance) ? scale(Math.trunc(advance), size, upem) : baseExtents.width;

    const numLigComponents = Math.max(1, (glyphs[i].codePoints ?? []).length);
    let xOffset = 0;
    let yOffset = 0;
    if (!rtl) {
      xOffset -= positions[i].xAdvance;
      yOffset -= positions[i].yAdvance;
    }
    let componentExtents = { ...baseExtents };
    let lastLigComponent = -1;
    let lastCombiningClass = 255;
    let clusterExtents = { ...baseExtents };
    for (let k = i + 1; k < end; k++) {
      const cp: number = (glyphs[k].codePoints ?? [])[0];
      const klass = recategorize(cp, modifiedCombiningClass(cp));
      if (klass === 0) {
        // A non-mark glyph inside the cluster (e.g. a ligature component).
        if (!rtl) {
          xOffset -= positions[k].xAdvance;
          yOffset -= positions[k].yAdvance;
        } else {
          xOffset += positions[k].xAdvance;
          yOffset += positions[k].yAdvance;
        }
        continue;
      }
      if (numLigComponents > 1) {
        const thisComponent = numLigComponents - 1;
        if (lastLigComponent !== thisComponent) {
          lastLigComponent = thisComponent;
          lastCombiningClass = 255;
          componentExtents = { ...baseExtents };
          if (!rtl) componentExtents.xBearing += Math.trunc((thisComponent * componentExtents.width) / numLigComponents);
          else componentExtents.xBearing += Math.trunc(((numLigComponents - 1 - thisComponent) * componentExtents.width) / numLigComponents);
          componentExtents.width = Math.trunc(componentExtents.width / numLigComponents);
        }
      }
      if (lastCombiningClass !== klass) {
        lastCombiningClass = klass;
        clusterExtents = { ...componentExtents };
      }
      const markExtents = glyphExtents(font, glyphs[k].id, size, upem);
      if (markExtents !== null) {
        const [mx, my] = positionMark(markExtents, clusterExtents, klass, yGap, rtl);
        positions[k].xOffset = mx + xOffset;
        positions[k].yOffset = my + yOffset;
        scaled.add(k);
      }
      positions[k].xAdvance = 0;
      positions[k].yAdvance = 0;
    }
    i = end;
  }
  return scaled;
}
