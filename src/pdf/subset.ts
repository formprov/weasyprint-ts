// SPDX-License-Identifier: BSD-3-Clause

/**
 * TrueType subsetting that replicates HarfBuzz-subset's embedded-font output
 * byte for byte for the pipeline WeasyPrint 70 uses: pass 1 subsets with
 * RETAIN_GIDS (glyph ids kept, numGlyphs truncated after the highest kept
 * gid), pass 2 re-subsets the result with NO_HINTING (hints removed and
 * fpgm/prep/cvt dropped). Only the pass-2 rules are implemented here, since
 * glyph ids never change and the first pass is byte-transparent otherwise.
 *
 * Reference algorithms: hb 9.0.0 (verified byte-for-byte against fonts
 * embedded in the oracle PDFs of the parity harness):
 * src/OT/glyf/{glyf,Glyph,SimpleGlyph,SubsetGlyph}.hh (trim, hint strip,
 * even padding, short loca), hb-ot-maxp-table.hh (drop_hint_fields),
 * OT/OS2/os2.hh + hb-ot-os2-unicode-ranges.hh, OT/name/name.hh,
 * OT/Layout/GDEF/GDEF.hh, OT/Layout/Common/{Coverage,CoverageFormat1,
 * CoverageFormat2,RangeRecord}.hh, hb-ot-layout-common.hh (ClassDef).
 *
 * hb builds nested offset tables via its serializer, which packs sub-objects
 * after the header in reverse pop order; a tiny serializer with the same
 * placement rules lives below for GDEF.
 */
import { concat } from './pydyf.ts';

interface Table {
  tag: string;
  offset: number;
  length: number;
}

function readTables(data: Uint8Array): Map<string, Table> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(4);
  const tables = new Map<string, Table>();
  for (let i = 0; i < count; i++) {
    const o = 12 + 16 * i;
    const tag = String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
    tables.set(tag, { tag, offset: v.getUint32(o + 8), length: v.getUint32(o + 12) });
  }
  return tables;
}

function checksum(bytes: Uint8Array): number {
  let sum = 0;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.length & ~3;
  for (let i = 0; i < whole; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  if (bytes.length > whole) {
    let last = 0;
    for (let i = whole; i < whole + 4; i++) last = (last << 8) | (i < bytes.length ? bytes[i] : 0);
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** Simple glyph flags. */
const X_SHORT = 0x02, Y_SHORT = 0x04, FLAG_REPEAT = 0x08, X_SAME = 0x10, Y_SAME = 0x20;
const WE_HAVE_INSTR = 0x100;

/**
 * Trim trailing padding of a simple glyph exactly like fontTools' `_g_l_y_f.py::trim`
 * (SimpleGlyph::trim_padding in HarfBuzz): walk the flag array counting coordinates
 * virtually, then cut bytes past the end of the coordinate region.
 * Returns null when the outline cannot be parsed — hb then drops the glyph bytes.
 */
function trimSimpleGlyph(glyph: Uint8Array): Uint8Array | null {
  if (glyph.length < 10) return glyph;
  const v = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength);
  const contours = v.getInt16(0);
  if (contours < 0) return glyph; // composites: no trimming (hb behavior)
  const instrOffset = 10 + 2 * contours;
  if (instrOffset + 2 > glyph.length) return null;

  // num_coordinates = last endPtsOfContours entry + 1 (includes phantom point)
  const numCoordinates = v.getUint16(instrOffset - 2) + 1;
  const numInstructions = v.getUint16(instrOffset);

  let p = instrOffset + 2 + numInstructions;
  if (p > glyph.length) return null;
  let coordBytes = 0, coordsWithFlags = 0;
  const glyphEnd = glyph.length;
  let endOfFlags = glyphEnd;
  while (p < glyphEnd) {
    const flag = glyph[p];
    p++;
    let repeat = 1;
    if (flag & FLAG_REPEAT) {
      if (p >= glyphEnd) return null;
      repeat = glyph[p] + 1;
      p++;
    }
    const xBytes = flag & X_SHORT ? 1 : (flag & X_SAME ? 0 : 2);
    const yBytes = flag & Y_SHORT ? 1 : (flag & Y_SAME ? 0 : 2);
    coordBytes += (xBytes + yBytes) * repeat;
    coordsWithFlags += repeat;
    if (coordsWithFlags >= numCoordinates) {
      endOfFlags = p;
      break;
    }
  }
  if (coordsWithFlags !== numCoordinates) return null;
  const keep = glyph.length + coordBytes - (glyphEnd - endOfFlags);
  if (keep < 0 || keep > glyph.length) return null;
  return glyph.subarray(0, keep);
}

/**
 * Drop hinting from a simple glyph: hb's SimpleGlyph::drop_hints_bytes
 * keeps header + points before the instructionLength field (dest_start) and
 * the flag/coord data after the instruction run (dest_end), effectively
 * excising the instructionLength field and the instruction run.
 */
function stripSimpleInstructions(trimmed: Uint8Array): Uint8Array {
  const v = new DataView(trimmed.buffer, trimmed.byteOffset, trimmed.byteLength);
  const contours = v.getInt16(0);
  const instrOffset = 10 + 2 * contours;
  if (instrOffset + 2 > trimmed.length) return trimmed;
  const instrLen = v.getUint16(instrOffset);
  if (instrOffset + 2 + instrLen > trimmed.length) return trimmed;
  const out = new Uint8Array(trimmed.length - instrLen);
  out.set(trimmed.subarray(0, instrOffset));
  out.set(trimmed.subarray(instrOffset + 2 + instrLen), instrOffset + 2);
  return out;
}

/**
 * Drop hinting from a composite glyph: chop the trailing instruction stream
 * (only when the last component record has the WE_HAVE_INSTRUCTIONS flag,
 * CompositeGlyph::instructions_length) and clear that flag on every record
 * (drop_instructions_flag). Component glyph ids are collected for closure.
 */
function stripCompositeInstructions(glyph: Uint8Array, components: number[]): Uint8Array {
  if (glyph.length < 10) return glyph;
  const v = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength);
  let o = 10;
  let lastStart = -1, lastSize = 0, lastHasInstructions = false;
  const flagsToClear: number[] = [];
  for (;;) {
    const start = o;
    if (o + 4 > glyph.length) return glyph; // broken table: keep as is
    const flags = v.getUint16(o);
    components.push(v.getUint16(o + 2));
    let size = 4 + (flags & 0x1 ? 4 : 2);
    if (flags & 0x8) size += 2;
    else if (flags & 0x40) size += 4;
    else if (flags & 0x80) size += 8;
    lastStart = start; lastSize = size;
    lastHasInstructions = (flags & WE_HAVE_INSTR) !== 0;
    if (flags & WE_HAVE_INSTR) flagsToClear.push(start);
    o += size;
    if (!(flags & 0x20)) break;
    if (o > glyph.length) return glyph;
  }
  const slice = lastHasInstructions ? glyph.subarray(0, lastStart + lastSize) : glyph;
  if (!flagsToClear.length) return slice;
  const out = slice.slice();
  const ov = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (const start of flagsToClear) ov.setUint16(start, ov.getUint16(start) & ~WE_HAVE_INSTR);
  return out;
}

/**
 * Subset one raw glyph like hb-subset's SubsetGlyph with the NO_HINTING
 * pass-2 rules. Glyph 0 keeps its outline only when NOTDEF_OUTLINE would be
 * set (the font has missing glyphs); otherwise hb emits an empty glyph 0.
 * Returns null for glyphs hb drops entirely (unparseable outline).
 */
function subsetGlyph(glyph: Uint8Array, notdefOutline: boolean, isNotdef: boolean): Uint8Array | null {
  if (isNotdef && !notdefOutline) return new Uint8Array(0);
  if (glyph.length < 10) return glyph;
  const v = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength);
  const contours = v.getInt16(0);
  if (contours >= 0) {
    // Simple glyph: trim trailing padding, then remove the instruction run.
    const trimmed = trimSimpleGlyph(glyph);
    if (!trimmed) return null;
    return stripSimpleInstructions(trimmed);
  }
  // Composite glyph: components collected by the caller via stripComposite.
  const components: number[] = [];
  const out = stripCompositeInstructions(glyph, components);
  void components;
  return out;
}

/** Composite component gid extraction matching stripCompositeInstructions. */
function compositeComponents(glyph: Uint8Array): number[] {
  const components: number[] = [];
  if (glyph.length < 10) return components;
  const v = new DataView(glyph.buffer, glyph.byteOffset, glyph.byteLength);
  if (v.getInt16(0) >= 0) return components;
  let o = 10;
  for (;;) {
    if (o + 4 > glyph.length) break;
    const flags = v.getUint16(o);
    components.push(v.getUint16(o + 2));
    let size = 4 + (flags & 0x1 ? 4 : 2);
    if (flags & 0x8) size += 2;
    else if (flags & 0x40) size += 4;
    else if (flags & 0x80) size += 8;
    o += size;
    if (!(flags & 0x20)) break;
    if (o > glyph.length) break;
  }
  return components;
}

/** Read codepoint→glyph mappings of one cmap subtable (formats 0, 4, 6, 10, 12, 13). */
function readCmapSubtable(dv: DataView, subtable: number): Map<number, number> {
  const out = new Map<number, number>();
  const format = dv.getUint16(subtable);
  const add = (cp: number, gid: number) => { if (gid !== 0) out.set(cp, gid); };
  if (format === 0) {
    for (let cp = 0; cp < 256; cp++) add(cp, dv.getUint8(subtable + 6 + cp));
  } else if (format === 4) {
    const segCount = dv.getUint16(subtable + 6) / 2;
    const endBase = subtable + 14;
    const startBase = endBase + segCount * 2 + 2;
    const deltaBase = startBase + segCount * 2;
    const rangeBase = deltaBase + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = dv.getUint16(endBase + s * 2);
      const start = dv.getUint16(startBase + s * 2);
      const delta = dv.getUint16(deltaBase + s * 2);
      const rangeOffset = dv.getUint16(rangeBase + s * 2);
      for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
        let gid: number;
        if (rangeOffset === 0) gid = (cp + delta) & 0xffff;
        else {
          gid = dv.getUint16(rangeBase + s * 2 + rangeOffset + (cp - start) * 2);
          if (gid !== 0) gid = (gid + delta) & 0xffff;
        }
        add(cp, gid);
      }
    }
  } else if (format === 6) {
    const first = dv.getUint16(subtable + 6);
    const count = dv.getUint16(subtable + 8);
    for (let i = 0; i < count; i++) add(first + i, dv.getUint16(subtable + 10 + 2 * i));
  } else if (format === 10) {
    const first = dv.getUint32(subtable + 12);
    const count = dv.getUint32(subtable + 16);
    for (let i = 0; i < count; i++) add(first + i, dv.getUint16(subtable + 20 + 2 * i));
  } else if (format === 12 || format === 13) {
    const nGroups = dv.getUint32(subtable + 12);
    for (let g = 0; g < nGroups; g++) {
      const base = subtable + 16 + g * 12;
      const startCp = dv.getUint32(base);
      const endCp = dv.getUint32(base + 4);
      const startGid = dv.getUint32(base + 8);
      for (let cp = startCp; cp <= endCp; cp++) add(cp, format === 12 ? startGid + (cp - startCp) : startGid);
    }
  }
  return out;
}

/** Serialize a format-4 subtable like HarfBuzz's `CmapSubtableFormat4::serialize`. */
function serializeCmap4(pairs: Array<[number, number]>): Uint8Array | null {
  const it = pairs.filter(([cp]) => cp <= 0xffff);
  if (!it.length) return null;
  const segments: Array<{ start: number; end: number; delta: number }> = [];
  const write = (start: number, end: number, delta: number) => {
    segments.push({ start, end, delta: ((delta << 16) >> 16) });
  };
  const commit = (start: number, prevRunStart: number, runStart: number, end: number,
    runDelta: number, prevRunDelta: number, splitCost: number) => {
    let shouldSplit = false;
    if (start < runStart && runStart < end) {
      if ((end - runStart + 1) * 2 >= splitCost) shouldSplit = true;
    }
    if (shouldSplit) {
      write(start, runStart - 1, start === prevRunStart ? prevRunDelta : 0);
      write(runStart, end, runDelta);
      return;
    }
    if (start === runStart) { write(start, end, runDelta); return; }
    write(start, end, 0);
  };
  let i = 0;
  let endCp = 0;
  while (i < it.length) {
    let startCp = it[i][0];
    let prevRunStartCp = startCp;
    let runStartCp = startCp;
    endCp = startCp;
    let lastGid = it[i][1];
    let runLength = 1;
    let prevDelta = 0;
    let delta = lastGid - startCp;
    let first = true;
    i++;
    while (i < it.length) {
      const [nextCp, nextGid] = it[i];
      if (nextCp !== endCp + 1) break;
      if (nextGid === lastGid + 1) {
        endCp = nextCp; runLength++; lastGid = nextGid; i++;
        continue;
      }
      const splitCost = first ? 8 : 16;
      if (runLength * 2 >= splitCost) {
        commit(startCp, prevRunStartCp, runStartCp, endCp, delta, prevDelta, splitCost);
        startCp = nextCp;
      }
      first = false;
      prevRunStartCp = runStartCp;
      runStartCp = nextCp;
      endCp = nextCp;
      prevDelta = delta;
      delta = nextGid - runStartCp;
      runLength = 1;
      lastGid = nextGid;
      i++;
    }
    commit(startCp, prevRunStartCp, runStartCp, endCp, delta, prevDelta, 8);
  }
  if (endCp !== 0xffff) write(0xffff, 0xffff, 1);

  const gidOf = new Map(it);
  const segCount = segments.length;
  const glyphArray: number[] = [];
  const rangeOffsets: number[] = [];
  segments.forEach((s, k) => {
    if (s.delta !== 0) { rangeOffsets.push(0); return; }
    rangeOffsets.push(2 * (segCount - k + glyphArray.length));
    for (let cp = s.start; cp <= s.end; cp++) glyphArray.push(gidOf.get(cp) ?? 0);
  });
  const length = 16 + segCount * 8 + glyphArray.length * 2;
  const out = new Uint8Array(length);
  const dv = new DataView(out.buffer);
  let bits = 0;
  while (segCount >> bits) bits++;
  const entrySelector = Math.max(1, bits) - 1;
  const searchRange = 2 * (1 << entrySelector);
  dv.setUint16(0, 4);
  dv.setUint16(2, length);
  dv.setUint16(6, segCount * 2);
  dv.setUint16(8, searchRange);
  dv.setUint16(10, entrySelector);
  dv.setUint16(12, segCount * 2 > searchRange ? 2 * segCount - searchRange : 0);
  segments.forEach((s, k) => {
    dv.setUint16(14 + 2 * k, s.end);
    dv.setUint16(16 + 2 * segCount + 2 * k, s.start);
    dv.setInt16(16 + 4 * segCount + 2 * k, s.delta);
    dv.setUint16(16 + 6 * segCount + 2 * k, rangeOffsets[k]);
  });
  glyphArray.forEach((g, k) => dv.setUint16(16 + 8 * segCount + 2 * k, g));
  return out;
}

/** Serialize a format-12 subtable like HarfBuzz's `CmapSubtableFormat12::serialize`. */
function serializeCmap12(pairs: Array<[number, number]>): Uint8Array | null {
  if (!pairs.length) return null;
  const groups: Array<[number, number, number]> = [];
  let [start, , gid] = [pairs[0][0], pairs[0][0], pairs[0][1]];
  let end = start;
  for (let k = 1; k < pairs.length; k++) {
    const [cp, g] = pairs[k];
    if (cp - 1 === end && g === gid + (cp - start)) end = cp;
    else { groups.push([start, end, gid]); start = cp; end = cp; gid = g; }
  }
  groups.push([start, end, gid]);
  const out = new Uint8Array(16 + 12 * groups.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 12);
  dv.setUint32(4, out.length);
  dv.setUint32(12, groups.length);
  groups.forEach(([s, e, g], k) => {
    dv.setUint32(16 + 12 * k, s);
    dv.setUint32(20 + 12 * k, e);
    dv.setUint32(24 + 12 * k, g);
  });
  return out;
}

/**
 * Rebuild the `cmap` table the way hb-subset does (with retained glyph ids):
 * keep only the Unicode records, restrict each to the codepoints of used
 * glyphs, share identical subtables per format and drop a format-12 table
 * that its BMP sibling duplicates. Ghostscript's auto-hinter reads this cmap,
 * so its exact content changes the rasterization. Returns the table plus the
 * retained codepoints (used for OS/2's range pruning).
 */
function subsetCmap(data: Uint8Array, cmapOffset: number, glyphs: Set<number>)
  : { bytes: Uint8Array; unicodes: number[] } | null {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numTables = dv.getUint16(cmapOffset + 2);
  type Rec = { platform: number; encoding: number; offset: number; format: number };
  const records: Rec[] = [];
  for (let i = 0; i < numTables; i++) {
    const platform = dv.getUint16(cmapOffset + 4 + i * 8);
    const encoding = dv.getUint16(cmapOffset + 6 + i * 8);
    const offset = cmapOffset + dv.getUint32(cmapOffset + 8 + i * 8);
    const format = dv.getUint16(offset);
    records.push({ platform, encoding, offset, format });
  }
  const kept = records.filter((r) =>
    (r.platform === 0 && (r.encoding === 3 || r.encoding === 4)) ||
    (r.platform === 3 && (r.encoding === 1 || r.encoding === 10)));
  if (!kept.length) return null;
  const hasFormat12 = kept.some((r) => r.format === 12);
  if (!hasFormat12 && !kept.some((r) => (r.platform === 0 && r.encoding === 3) || (r.platform === 3 && r.encoding === 1))) return null;
  if (hasFormat12 && !kept.some((r) => (r.platform === 0 && r.encoding === 4) || (r.platform === 3 && r.encoding === 10))) return null;

  // Unicode → glyph from the best subtable (find_best_subtable order).
  const order: Array<[number, number]> = [[3, 0], [3, 10], [0, 6], [0, 4], [3, 1], [0, 3], [0, 2], [0, 1], [0, 0], [1, 0]];
  let best: Rec | undefined;
  for (const [p, e] of order) {
    best = records.find((r) => r.platform === p && r.encoding === e);
    if (best) break;
  }
  if (!best) return null;
  const pairs: Array<[number, number]> = [...readCmapSubtable(dv, best.offset)]
    .filter(([, gid]) => glyphs.has(gid)).sort((a, b) => a[0] - b[0]);
  const retained = pairs.map(([cp]) => cp);
  const sets = new Map<Rec, Set<number>>();
  for (const r of kept) sets.set(r, new Set(readCmapSubtable(dv, r.offset).keys()));
  const filtered = (r: Rec) => pairs.filter(([cp]) => sets.get(r)!.has(cp));

  const canDrop = (r12: Rec): boolean => {
    const s12 = sets.get(r12)!;
    if (retained.some((cp) => s12.has(cp) && cp >= 0x10000)) return false;
    let tp: number; let te: number;
    if (r12.platform === 0 && r12.encoding === 4) { tp = 0; te = 3; }
    else if (r12.platform === 3 && r12.encoding === 10) { tp = 3; te = 1; }
    else return false;
    for (const r of kept) {
      if (r.platform !== tp || r.encoding !== te) continue;
      const a = retained.filter((cp) => s12.has(cp));
      const b = retained.filter((cp) => sets.get(r)!.has(cp));
      return a.length === b.length && a.every((cp, k) => cp === b[k]);
    }
    return false;
  };

  const shared = new Map<number, number>(); // format → index in `subtables`
  const subtables: Uint8Array[] = [];
  const out: Array<{ platform: number; encoding: number; index: number }> = [];
  for (const r of kept) {
    if (r.format !== 4 && r.format !== 12) continue;
    if (r.format === 12 && canDrop(r)) continue;
    let index = shared.get(r.format);
    if (index === undefined) {
      const bytes = (r.format === 4 ? serializeCmap4 : serializeCmap12)(filtered(r));
      if (!bytes) continue;
      index = subtables.push(bytes) - 1;
      shared.set(r.format, index);
    }
    out.push({ platform: r.platform, encoding: r.encoding, index });
  }
  if (!out.length) return null;
  let position = 4 + 8 * out.length;
  const starts = subtables.map((t) => { const p = position; position += t.length; return p; });
  const result = new Uint8Array(position);
  const rv = new DataView(result.buffer);
  rv.setUint16(2, out.length);
  out.forEach((o, k) => {
    rv.setUint16(4 + 8 * k, o.platform);
    rv.setUint16(6 + 8 * k, o.encoding);
    rv.setUint32(8 + 8 * k, starts[o.index]);
  });
  subtables.forEach((t, k) => result.set(t, starts[k]));
  return { bytes: result, unicodes: retained };
}

// OS/2 ulUnicodeRange lookup table (hb-ot-os2-unicode-ranges.hh, generated).
const OS2_RANGES: Array<[number, number, number]> = [
  [0x0000, 0x007F, 0], [0x0080, 0x00FF, 1], [0x0100, 0x017F, 2], [0x0180, 0x024F, 3],
  [0x0250, 0x02AF, 4], [0x02B0, 0x02FF, 5], [0x0300, 0x036F, 6], [0x0370, 0x03FF, 7],
  [0x0400, 0x04FF, 9], [0x0500, 0x052F, 9], [0x0530, 0x058F, 10], [0x0590, 0x05FF, 11],
  [0x0600, 0x06FF, 13], [0x0700, 0x074F, 71], [0x0750, 0x077F, 13], [0x0780, 0x07BF, 72],
  [0x07C0, 0x07FF, 14], [0x0900, 0x097F, 15], [0x0980, 0x09FF, 16], [0x0A00, 0x0A7F, 17],
  [0x0A80, 0x0AFF, 18], [0x0B00, 0x0B7F, 19], [0x0B80, 0x0BFF, 20], [0x0C00, 0x0C7F, 21],
  [0x0C80, 0x0CFF, 22], [0x0D00, 0x0D7F, 23], [0x0D80, 0x0DFF, 73], [0x0E00, 0x0E7F, 24],
  [0x0E80, 0x0EFF, 25], [0x0F00, 0x0FFF, 70], [0x1000, 0x109F, 74], [0x10A0, 0x10FF, 26],
  [0x1100, 0x11FF, 28], [0x1200, 0x137F, 75], [0x1380, 0x139F, 75], [0x13A0, 0x13FF, 76],
  [0x1400, 0x167F, 77], [0x1680, 0x169F, 78], [0x16A0, 0x16FF, 79], [0x1700, 0x171F, 84],
  [0x1720, 0x173F, 84], [0x1740, 0x175F, 84], [0x1760, 0x177F, 84], [0x1780, 0x17FF, 80],
  [0x1800, 0x18AF, 81], [0x1900, 0x194F, 93], [0x1950, 0x197F, 94], [0x1980, 0x19DF, 95],
  [0x19E0, 0x19FF, 80], [0x1A00, 0x1A1F, 96], [0x1B00, 0x1B7F, 27], [0x1B80, 0x1BBF, 112],
  [0x1C00, 0x1C4F, 113], [0x1C50, 0x1C7F, 114], [0x1D00, 0x1D7F, 4], [0x1D80, 0x1DBF, 4],
  [0x1DC0, 0x1DFF, 6], [0x1E00, 0x1EFF, 29], [0x1F00, 0x1FFF, 30], [0x2000, 0x206F, 31],
  [0x2070, 0x209F, 32], [0x20A0, 0x20CF, 33], [0x20D0, 0x20FF, 34], [0x2100, 0x214F, 35],
  [0x2150, 0x218F, 36], [0x2190, 0x21FF, 37], [0x2200, 0x22FF, 38], [0x2300, 0x23FF, 39],
  [0x2400, 0x243F, 40], [0x2440, 0x245F, 41], [0x2460, 0x24FF, 42], [0x2500, 0x257F, 43],
  [0x2580, 0x259F, 44], [0x25A0, 0x25FF, 45], [0x2600, 0x26FF, 46], [0x2700, 0x27BF, 47],
  [0x27C0, 0x27EF, 38], [0x27F0, 0x27FF, 37], [0x2800, 0x28FF, 82], [0x2900, 0x297F, 37],
  [0x2980, 0x29FF, 38], [0x2A00, 0x2AFF, 38], [0x2B00, 0x2BFF, 37], [0x2C00, 0x2C5F, 97],
  [0x2C60, 0x2C7F, 29], [0x2C80, 0x2CFF, 8], [0x2D00, 0x2D2F, 26], [0x2D30, 0x2D7F, 98],
  [0x2D80, 0x2DDF, 75], [0x2DE0, 0x2DFF, 9], [0x2E00, 0x2E7F, 31], [0x2E80, 0x2EFF, 59],
  [0x2F00, 0x2FDF, 59], [0x2FF0, 0x2FFF, 59], [0x3000, 0x303F, 48], [0x3040, 0x309F, 49],
  [0x30A0, 0x30FF, 50], [0x3100, 0x312F, 51], [0x3130, 0x318F, 52], [0x3190, 0x319F, 59],
  [0x31A0, 0x31BF, 51], [0x31C0, 0x31EF, 61], [0x31F0, 0x31FF, 50], [0x3200, 0x32FF, 54],
  [0x3300, 0x33FF, 55], [0x3400, 0x4DBF, 59], [0x4DC0, 0x4DFF, 99], [0x4E00, 0x9FFF, 59],
  [0xA000, 0xA48F, 83], [0xA490, 0xA4CF, 83], [0xA500, 0xA63F, 12], [0xA640, 0xA69F, 9],
  [0xA700, 0xA71F, 5], [0xA720, 0xA7FF, 29], [0xA800, 0xA82F, 100], [0xA840, 0xA87F, 53],
  [0xA880, 0xA8DF, 115], [0xA900, 0xA92F, 116], [0xA930, 0xA95F, 117], [0xAA00, 0xAA5F, 118],
  [0xAC00, 0xD7AF, 56], [0xD800, 0xDFFF, 57], [0xE000, 0xF8FF, 60], [0xF900, 0xFAFF, 61],
  [0xFB00, 0xFB4F, 62], [0xFB50, 0xFDFF, 63], [0xFE00, 0xFE0F, 91], [0xFE10, 0xFE1F, 65],
  [0xFE20, 0xFE2F, 64], [0xFE30, 0xFE4F, 65], [0xFE50, 0xFE6F, 66], [0xFE70, 0xFEFF, 67],
  [0xFF00, 0xFFEF, 68], [0xFFF0, 0xFFFF, 69], [0x10000, 0x1007F, 101], [0x10080, 0x100FF, 101],
  [0x10100, 0x1013F, 101], [0x10140, 0x1018F, 102], [0x10190, 0x101CF, 119], [0x101D0, 0x101FF, 120],
  [0x10280, 0x1029F, 121], [0x102A0, 0x102DF, 121], [0x10300, 0x1032F, 85], [0x10330, 0x1034F, 86],
  [0x10380, 0x1039F, 103], [0x103A0, 0x103DF, 104], [0x10400, 0x1044F, 87], [0x10450, 0x1047F, 105],
  [0x10480, 0x104AF, 106], [0x10800, 0x1083F, 107], [0x10900, 0x1091F, 58], [0x10920, 0x1093F, 121],
  [0x10A00, 0x10A5F, 108], [0x12000, 0x123FF, 110], [0x12400, 0x1247F, 110], [0x1D000, 0x1D0FF, 88],
  [0x1D100, 0x1D1FF, 88], [0x1D200, 0x1D24F, 88], [0x1D300, 0x1D35F, 109], [0x1D360, 0x1D37F, 111],
  [0x1D400, 0x1D7FF, 89], [0x1F000, 0x1F02F, 122], [0x1F030, 0x1F09F, 122], [0x20000, 0x2A6DF, 59],
  [0x2F800, 0x2FA1F, 61], [0xE0000, 0xE007F, 92], [0xE0100, 0xE01EF, 91], [0xF0000, 0xFFFFD, 90],
  [0x100000, 0x10FFFD, 90],
];
function os2RangeBit(cp: number): number {
  let lo = 0, hi = OS2_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = OS2_RANGES[mid]!;
    if (cp < r[0]) hi = mid - 1;
    else if (cp > r[1]) lo = mid + 1;
    else return r[2];
  }
  return -1;
}

/** Subset the OS/2 table: first/last char index + pruned unicode ranges
 * (OS2::subset + _update_unicode_ranges). `unicodes` must be sorted. */
function subsetOs2(data: Uint8Array, t: Table, unicodes: number[]): Uint8Array {
  const bytes = data.slice(t.offset, t.offset + t.length);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!unicodes.length) {
    dv.setUint16(64, 0xffff);
    dv.setUint16(66, 0xffff);
  } else {
    dv.setUint16(64, Math.min(0xffff, unicodes[0]!));
    dv.setUint16(66, Math.min(0xffff, unicodes[unicodes.length - 1]!));
  }
  // newBits[bit] |= 1 << (bit & 31), then only keep source bits that remain set
  const newBits = [0, 0, 0, 0];
  for (const cp of unicodes) {
    const bit = os2RangeBit(cp);
    if (bit >= 0) newBits[bit >>> 5] |= 1 << (bit & 31);
    if (cp >= 0x10000 && cp <= 0x110000) newBits[1] |= 1 << 25;
  }
  for (let i = 0; i < 4; i++) dv.setUint32(42 + 4 * i, (dv.getUint32(42 + 4 * i) & newBits[i]!) >>> 0);
  return bytes;
}

/**
 * Read the sorted glyph→class pairs of retained glyphs from a ClassDef
 * (ClassDef::subset with klass_map=nullptr, keep_empty=false). Returns null
 * for a classdef with no retained classified glyph.
 */
function subsetClassDefFromSource(data: Uint8Array, tableOffset: number, glyphs: Set<number>): Uint8Array | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = v.getUint16(tableOffset);
  const glyphPairs: Array<[number, number]> = [];
  if (format === 1) {
    const start = v.getUint16(tableOffset + 2);
    const len = v.getUint16(tableOffset + 4);
    for (let i = 0; i < len; i++) {
      const gid = start + i;
      if (!glyphs.has(gid)) continue;
      const klass = v.getUint16(tableOffset + 6 + 2 * i);
      if (klass) glyphPairs.push([gid, klass]);
    }
  } else if (format === 2) {
    const n = v.getUint16(tableOffset + 2);
    for (let i = 0; i < n; i++) {
      const base = tableOffset + 4 + 6 * i;
      const first = v.getUint16(base);
      const last = v.getUint16(base + 2);
      const klass = v.getUint16(base + 4);
      if (!klass) continue;
      for (let g = first; g <= last; g++) {
        if (glyphs.has(g)) glyphPairs.push([g, klass]);
      }
    }
    glyphPairs.sort((a, b) => a[0] - b[0]);
  } else return null;
  return serializeClassDef(glyphPairs);
}

/** Serialize a ClassDef from sorted (gid, klass>0) pairs exactly like
 * ClassDef::serialize (format by size rule, runs share one range). */
function serializeClassDef(glyphsKlass: Array<[number, number]>): Uint8Array | null {
  if (!glyphsKlass.length) return null;
  let numRanges = 1;
  for (let i = 1; i < glyphsKlass.length; i++) {
    const [gid, klass] = glyphsKlass[i]!;
    const [prevGid, prevKlass] = glyphsKlass[i - 1]!;
    if (gid !== prevGid + 1 || klass !== prevKlass) numRanges++;
  }
  const min = glyphsKlass[0]![0];
  const max = glyphsKlass[glyphsKlass.length - 1]![0];
  const format = 1 + (max - min + 1) <= numRanges * 3 ? 1 : 2;
  if (format === 1) {
    const count = max - min + 1;
    const out = new Uint8Array(6 + 2 * count);
    const ov = new DataView(out.buffer);
    ov.setUint16(0, 1); ov.setUint16(2, min); ov.setUint16(4, count);
    for (const [gid, klass] of glyphsKlass) ov.setUint16(6 + 2 * (gid - min), klass);
    return out;
  }
  const ranges: Array<[number, number, number]> = [];
  let start = min, end = min, klass = glyphsKlass[0]![1];
  for (let i = 1; i < glyphsKlass.length; i++) {
    const [g, k] = glyphsKlass[i]!;
    if (g !== end + 1 || k !== klass) {
      ranges.push([start, end, klass]);
      start = g; klass = k;
    }
    end = g;
  }
  ranges.push([start, end, klass]);
  const out = new Uint8Array(4 + 6 * ranges.length);
  const ov = new DataView(out.buffer);
  ov.setUint16(0, 2); ov.setUint16(2, ranges.length);
  ranges.forEach(([s, e, k], i) => {
    ov.setUint16(4 + 6 * i, s);
    ov.setUint16(4 + 6 * i + 2, e);
    ov.setUint16(4 + 6 * i + 4, k);
  });
  return out;
}

/** Serialize a Coverage from sorted retained gids exactly like
 * Coverage::serialize (format 1 when not larger than format 2). */
function serializeCoverage(glyphs: number[]): Uint8Array | null {
  if (!glyphs.length) return null;
  let numRanges = 0;
  let last = -2;
  for (const g of glyphs) {
    if (last + 1 !== g) numRanges++;
    last = g;
  }
  const count = glyphs.length;
  const format = count <= numRanges * 3 ? 1 : 2;
  if (format === 1) {
    const out = new Uint8Array(4 + 2 * count);
    const ov = new DataView(out.buffer);
    ov.setUint16(0, 1); ov.setUint16(2, count);
    glyphs.forEach((g, i) => ov.setUint16(4 + 2 * i, g));
    return out;
  }
  const out = new Uint8Array(4 + 6 * numRanges);
  const ov = new DataView(out.buffer);
  ov.setUint16(0, 2); ov.setUint16(2, numRanges);
  let range = -1;
  last = -2;
  let index = 0;
  for (const g of glyphs) {
    if (last + 1 !== g) {
      range++;
      ov.setUint16(4 + 6 * range, g);        // first
      ov.setUint16(4 + 6 * range + 4, index); // value = coverage index
    }
    ov.setUint16(4 + 6 * range + 2, g);      // last
    last = g;
    index++;
  }
  return out;
}

/** Coverage.subset of a source coverage table restricted to retained glyphs. */
function subsetCoverageFromSource(data: Uint8Array, offset: number, glyphs: Set<number>): Uint8Array | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = v.getUint16(offset);
  const kept: number[] = [];
  if (format === 1) {
    const n = v.getUint16(offset + 2);
    for (let i = 0; i < n; i++) {
      const g = v.getUint16(offset + 4 + 2 * i);
      if (glyphs.has(g)) kept.push(g);
    }
  } else if (format === 2) {
    const n = v.getUint16(offset + 2);
    for (let i = 0; i < n; i++) {
      const base = offset + 4 + 6 * i;
      const first = v.getUint16(base), last = v.getUint16(base + 2);
      for (let g = first; g <= last; g++) if (glyphs.has(g)) kept.push(g);
    }
  } else return null;
  kept.sort((a, b) => a - b);
  return serializeCoverage(kept);
}

/**
 * Rebuild the `name` table like hb-subset: keep Unicode-platform records with
 * name ids 0..6 and language 0x0409, sorted by (platform, encoding, language,
 * name id, length); strings are packed into the pool in reverse record order
 * (the hb serializer's tail placement).
 */
function subsetName(data: Uint8Array, t: Table): Uint8Array | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(t.offset + 2);
  const stringOffset = v.getUint16(t.offset + 4);
  const stringBase = t.offset + stringOffset;
  type Rec = { pid: number; eid: number; lid: number; nid: number; str: Uint8Array; offset: number };
  const records: Rec[] = [];
  for (let i = 0; i < count; i++) {
    const base = t.offset + 6 + 12 * i;
    const pid = v.getUint16(base), eid = v.getUint16(base + 2), lid = v.getUint16(base + 4);
    const nid = v.getUint16(base + 6), len = v.getUint16(base + 8);
    const off = v.getUint16(base + 10);
    if (nid > 6) continue; // name ids 0..6 (hb default)
    if (lid !== 0x0409) continue; // en-US (hb default name_languages)
    // isUnicode: platform 0, or platform 3 with encoding 0/1/10
    if (!(pid === 0 || (pid === 3 && (eid === 0 || eid === 1 || eid === 10)))) continue;
    const strOff = stringBase + off;
    if (strOff + len > t.offset + t.length) continue;
    records.push({ pid, eid, lid, nid, str: data.subarray(strOff, strOff + len), offset: 0 });
  }
  if (!records.length) return null;
  records.sort((a, b) =>
    a.pid - b.pid || a.eid - b.eid || a.lid - b.lid || a.nid - b.nid || a.str.length - b.str.length);
  // Strings appended in reverse record order; offsets assigned ascending.
  let poolSize = 0;
  for (const r of records) poolSize += r.str.length;
  const pool = new Uint8Array(poolSize);
  let at = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    pool.set(records[i]!.str, at);
    records[i]!.offset = at;
    at += records[i]!.str.length;
  }
  const head = new Uint8Array(6 + 12 * records.length);
  const hv = new DataView(head.buffer);
  hv.setUint16(0, 0);
  hv.setUint16(2, records.length);
  hv.setUint16(4, 6 + 12 * records.length);
  records.forEach((r, i) => {
    const base = 6 + 12 * i;
    hv.setUint16(base, r.pid); hv.setUint16(base + 2, r.eid); hv.setUint16(base + 4, r.lid);
    hv.setUint16(base + 6, r.nid); hv.setUint16(base + 8, r.str.length);
    hv.setUint16(base + 10, r.offset);
  });
  return concat([head, pool]);
}

// --- GDEF subsetting -------------------------------------------------------

/** Assemble a LigCaretList region exactly like hb's serializer: children are
 * popped in order [lig0 carets…, lig0 obj, lig1 carets…, lig1 obj, …,
 * coverage], each placed at a descending position; the root header is popped
 * last and sits first. Returns the bytes, laid out ascending as
 * [header][coverage][ligGlyph n-1 … careful placements guarded][ligGlyph 0 …
 * carets reversed], with all offsets resolved. */
function buildLigCaretList(
  keptGids: number[],
  ligCarets: Uint8Array[][], // per kept lig glyph: subsetted caret values
  coverage: Uint8Array,
): Uint8Array | null {
  const inlineSize = 4 + 2 * keptGids.length;
  // hb pops (and thus places, descending) [lig0 carets…, lig0 obj, lig1 carets…,
  // lig1 obj, …, coverage]; the root header is last. Regions therefore lay out
  // ascending as [header][coverage][lig n-1 …][lig 0 … carets reversed].
  type Item = { kind: 'caret' | 'lig' | 'cov'; lig?: number; caret?: number; size: number };
  const popOrder: Item[] = [];
  for (let lig = 0; lig < ligCarets.length; lig++) {
    for (let c = 0; c < ligCarets[lig]!.length; c++) {
      popOrder.push({ kind: 'caret', lig, caret: c, size: ligCarets[lig]![c]!.length });
    }
    popOrder.push({ kind: 'lig', lig, size: 2 + 2 * ligCarets[lig]!.length });
  }
  popOrder.push({ kind: 'cov', size: coverage.length });

  let total = inlineSize;
  for (const item of popOrder) total += item.size;
  const at = new Map<string, number>();
  let position = total;
  for (const item of popOrder) {
    position -= item.size;
    at.set(item.kind + (item.kind === 'cov' ? '' : `:${item.lig}`) + (item.kind === 'caret' ? `:${item.caret}` : ''), position);
  }
  const region = new Uint8Array(total);
  for (const item of popOrder) {
    const key = item.kind + (item.kind === 'cov' ? '' : `:${item.lig}`) + (item.kind === 'caret' ? `:${item.caret}` : '');
    const pos = at.get(key)!;
    if (item.kind === 'cov') region.set(coverage, pos);
    else if (item.kind === 'caret') region.set(ligCarets[item.lig!]![item.caret!]!, pos);
    else {
      // LigGlyph object: caret count + caret offsets (children are higher).
      const bytes = new Uint8Array(item.size);
      const bv = new DataView(bytes.buffer);
      bv.setUint16(0, ligCarets[item.lig!]!.length);
      for (let c = 0; c < ligCarets[item.lig!]!.length; c++) {
        bv.setUint16(2 + 2 * c, at.get(`caret:${item.lig}:${c}`)! - pos);
      }
      region.set(bytes, pos);
    }
  }
  if (total === inlineSize) return null;
  const hv = new DataView(region.buffer);
  hv.setUint16(0, at.get('cov')!);
  hv.setUint16(2, keptGids.length);
  for (let lig = 0; lig < keptGids.length; lig++) {
    hv.setUint16(4 + 2 * lig, at.get(`lig:${lig}`)!);
  }
  return region;
}

/**
 * Subset the GDEF table (GDEF::subset): version-1 header; glyphClassDef and
 * markAttachClassDef subsetted to retained glyphs; LigCaretList restricted to
 * retained glyphs with their caret values. The version downgrades to 1.0 when
 * the v1.2+/v1.3 substructures (markGlyphSets, varStore) do not survive — the
 * parity corpus only contains v1.0 tables, which this fully reproduces.
 * Returns null (drop the table) when no subtable survives.
 */
function subsetGdef(data: Uint8Array, t: Table, glyphs: Set<number>): Uint8Array | null {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = v.getUint32(t.offset);
  if (version >>> 16 !== 1) return null; // GDEF 2 (beyond-64k) is not in the corpus
  const minor = version & 0xffff;
  const off16 = (bytePos: number): number => v.getUint16(t.offset + bytePos);
  const classDefOffset = off16(4);
  const attachListOffset = off16(6);
  const ligCaretListOffset = off16(8);
  const markAttachOffset = off16(10);
  const markGlyphSetsOffset = minor >= 2 ? off16(12) : 0;
  const varStoreOffset = minor >= 3 ? v.getUint32(t.offset + 14) : 0;
  void attachListOffset; void markGlyphSetsOffset; void varStoreOffset; // pruned (corpus has none)

  // Children in pop order: glyphClassDef, attachList, markAttachClassDef,
  // ligCaretList. Layout (reverse) = [ligCaret][markAttach][attach][classDef].
  const classDef = classDefOffset ? subsetClassDefFromSource(data, t.offset + classDefOffset, glyphs) : null;
  const markAttach = markAttachOffset ? subsetClassDefFromSource(data, t.offset + markAttachOffset, glyphs) : null;

  let ligCaret: Uint8Array | null = null;
  if (ligCaretListOffset) {
    const lc = t.offset + ligCaretListOffset;
    const covOffset = off16(ligCaretListOffset);
    const coverageSource = lc + covOffset;
    const covPairs = coverageGids(data, coverageSource, glyphs);
    const keptGids: number[] = [];
    const ligCarets: Uint8Array[][] = [];
    for (const { gid, srcIndex } of covPairs) {
      // LigGlyph offsets are indexed by the source coverage index.
      const lgOffset = v.getUint16(lc + 4 + 2 * srcIndex);
      const count = v.getUint16(lc + lgOffset);
      const carets: Uint8Array[] = [];
      for (let k = 0; k < count; k++) {
        const cvPos = v.getUint16(lc + lgOffset + 2 + 2 * k);
        const format = v.getUint16(lc + lgOffset + cvPos);
        // CaretValue formats 1/2 are inline 4 bytes. Format 3 carries a
        // device table offset (needs device subsetting): dropped.
        if (format === 3) continue;
        carets.push(data.slice(lc + lgOffset + cvPos, lc + lgOffset + cvPos + 4));
      }
      if (carets.length) {
        keptGids.push(gid);
        ligCarets.push(carets);
      }
    }
    if (keptGids.length) {
      const coverage = subsetCoverageFromSource(data, coverageSource, glyphs)!;
      ligCaret = buildLigCaretList(keptGids, ligCarets, coverage);
    }
  }

  if (!classDef && !markAttach && !ligCaret) return null;

  // Assemble: header (version downgraded to 1.0) + children in layout order
  // (reverse of hb's pop order): ligCaret lowest, then markAttach, classDef.
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, 0x00010000);
  let pos = 12;
  const bodies: Uint8Array[] = [];
  if (ligCaret) { hv.setUint16(8, pos); bodies.push(ligCaret); pos += ligCaret.length; }
  if (markAttach) { hv.setUint16(10, pos); bodies.push(markAttach); pos += markAttach.length; }
  if (classDef) { hv.setUint16(4, pos); bodies.push(classDef); pos += classDef.length; }
  return concat([header, ...bodies]);
}

/**
 * Subset the GDEF table (GDEF::subset): version 1.x header; glyphClassDef and
 * markAttachClassDef subsetted to retained glyphs; LigCaretList restricted to
 * retained glyphs with their caret values. The version downgrades to 1.0 when
 * nothing of the v1.2+ structures survives (varStores and markGlyphSets are
 * beyond the parity corpus; they are pruned here). Returns null if nothing
 * survives so the table can be dropped entirely.
 */
/** Sorted retained gids covered by a source coverage table, with their
 * source-coverage indices (Coverage::subset keeps the index mapping). */
function coverageGids(data: Uint8Array, offset: number, glyphs: Set<number>): Array<{ gid: number; srcIndex: number }> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const format = v.getUint16(offset);
  const pairs: Array<{ gid: number; srcIndex: number }> = [];
  if (format === 1) {
    const n = v.getUint16(offset + 2);
    for (let i = 0; i < n; i++) {
      const g = v.getUint16(offset + 4 + 2 * i);
      if (glyphs.has(g)) pairs.push({ gid: g, srcIndex: i });
    }
  } else if (format === 2) {
    const n = v.getUint16(offset + 2);
    for (let i = 0; i < n; i++) {
      const base = offset + 4 + 6 * i;
      const first = v.getUint16(base), last = v.getUint16(base + 2), value = v.getUint16(base + 4);
      for (let g = first; g <= last; g++) {
        if (glyphs.has(g)) pairs.push({ gid: g, srcIndex: value + (g - first) });
      }
    }
    pairs.sort((a, b) => a.gid - b.gid);
  }
  return pairs;
}

/**
 * Build a TrueType font containing only the given glyph ids (others empty),
 * glyph ids unchanged — the byte-level equivalent of hb-subset's pass-2
 * output that WeasyPrint embeds in the PDF.
 */
export function subsetTrueType(data: Uint8Array, gids: Iterable<number>, notdefOutline = true): Uint8Array {
  const tables = readTables(data);
  const need = (tag: string): Table => {
    const t = tables.get(tag);
    if (!t) throw new Error(`Missing ${tag} table`);
    return t;
  };
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const head = need('head');
  const maxp = need('maxp');
  const hhea = need('hhea');
  const loca = need('loca');
  const glyf = need('glyf');
  const hmtx = need('hmtx');
  const longLoca = v.getInt16(head.offset + 50) === 1;
  const numGlyphs = v.getUint16(maxp.offset + 4);
  const glyphRange = (gid: number): [number, number] => {
    if (gid >= numGlyphs) return [0, 0];
    return longLoca
      ? [v.getUint32(loca.offset + 4 * gid), v.getUint32(loca.offset + 4 * gid + 4)]
      : [v.getUint16(loca.offset + 2 * gid) * 2, v.getUint16(loca.offset + 2 * gid + 2) * 2];
  };

  // Close the glyph set over composite components. Gids past the real glyph
  // count (Python's get_unused_glyph_id results) were dropped by hb-subset's
  // first pass; keeping them would defeat the truncation below.
  const gidList = [...gids].filter((gid) => gid < numGlyphs);
  const wanted = new Set<number>([0, ...gidList]);
  const glyphBytes = new Map<number, Uint8Array>();
  const queue = [...wanted];
  while (queue.length) {
    const gid = queue.pop() as number;
    const [start, end] = glyphRange(gid);
    const raw = end > start ? data.subarray(glyf.offset + start, glyf.offset + end) : new Uint8Array(0);
    const cleaned = subsetGlyph(raw, notdefOutline, gid === 0);
    glyphBytes.set(gid, cleaned ?? new Uint8Array(0));
    if (end > start) {
      for (const comp of compositeComponents(raw)) {
        if (!wanted.has(comp)) {
          wanted.add(comp);
          queue.push(comp);
        }
      }
    }
  }
  const newCount = Math.min(numGlyphs, Math.max(...wanted) + 1);

  // glyf + loca: even padding only with short loca (SubsetGlyph::serialize:
  // pad to 2 so short loca offsets stay even; no padding with long loca).
  let totalPadded = 0;
  for (let gid = 0; gid < newCount; gid++) {
    const g = glyphBytes.get(gid) ?? new Uint8Array(0);
    totalPadded += g.length + (g.length % 2);
  }
  const useShortLoca = totalPadded < 0x1ffff;
  const glyfParts: Uint8Array[] = [];
  const locaOffsets: number[] = [];
  let position = 0;
  for (let gid = 0; gid <= newCount; gid++) {
    locaOffsets[gid] = position;
    if (gid === newCount) break;
    const g = glyphBytes.get(gid) ?? new Uint8Array(0);
    if (!g.length) continue;
    glyfParts.push(g);
    position += g.length;
    if (useShortLoca && g.length % 2) {
      glyfParts.push(new Uint8Array(1));
      position += 1;
    }
  }
  let glyfBytes = concat(glyfParts);
  if (glyfBytes.length === 0) glyfBytes = new Uint8Array([0]); // hb's empty-byte special case
  const locaBytes = new Uint8Array(useShortLoca ? 2 * (newCount + 1) : 4 * (newCount + 1));
  const locaView = new DataView(locaBytes.buffer);
  locaOffsets.forEach((o, i) => useShortLoca ? locaView.setUint16(2 * i, o / 2) : locaView.setUint32(4 * i, o));

  // hmtx / hhea: hb allocates a zeroed table and writes one metric entry per
  // retained glyph; num_long_metrics shrinks trailing same-advance entries
  // (hmtx::subset + serialize).
  const numHMetricsSrc = v.getUint16(hhea.offset + 34);
  // hb's advance map sees retained gids only: dropped slots count as 0 in the
  // trailing-run shrink (get_new_gid_advance_unscaled returns 0 unmapped).
  const effAdvance = (gid: number): number =>
    wanted.has(gid) ? (gid < numHMetricsSrc ? v.getUint16(hmtx.offset + 4 * gid) : v.getUint16(hmtx.offset + 4 * (numHMetricsSrc - 1))) : 0;
  const srcLsb = (gid: number): number =>
    gid < numHMetricsSrc
      ? v.getInt16(hmtx.offset + 4 * gid + 2)
      : v.getInt16(hmtx.offset + 4 * numHMetricsSrc + 2 * (gid - numHMetricsSrc));
  let newHMetrics = Math.min(newCount, 0xffff);
  const lastAdvance = effAdvance(newHMetrics - 1);
  while (newHMetrics > 1 && lastAdvance === effAdvance(newHMetrics - 2)) newHMetrics--;

  const hmtxBytes = new Uint8Array(4 * newHMetrics + 2 * (newCount - newHMetrics));
  const hmtxView = new DataView(hmtxBytes.buffer);
  for (const gid of [...wanted].sort((a, b) => a - b)) {
    const adv = effAdvance(gid);
    if (gid < newHMetrics) hmtxView.setUint16(4 * gid, adv);
    // else: advances past num_long_metrics are implicit (last long metric)
    if (gid < newHMetrics) hmtxView.setInt16(4 * gid + 2, srcLsb(gid));
    else hmtxView.setInt16(4 * newHMetrics + 2 * (gid - newHMetrics), srcLsb(gid));
  }
  const hheaBytes = data.slice(hhea.offset, hhea.offset + hhea.length);
  new DataView(hheaBytes.buffer).setUint16(34, newHMetrics);

  // maxp: numGlyphs = kept count; with NO_HINTING the hint fields are zeroed
  // (maxp::drop_hint_fields).
  const maxpBytes = data.slice(maxp.offset, maxp.offset + maxp.length);
  const maxpView = new DataView(maxpBytes.buffer);
  maxpView.setUint16(4, newCount);
  if (maxpView.getUint32(0) >>> 16 === 1 && maxpBytes.length >= 32) {
    maxpView.setUint16(14, 1); // maxZones = 1
    for (const o of [16, 18, 20, 22, 24, 26]) maxpView.setUint16(o, 0);
  }

  // head: emit the loca format actually used.
  const headBytes = data.slice(head.offset, head.offset + head.length);
  const headView = new DataView(headBytes.buffer);
  headView.setUint32(8, 0); // checkSumAdjustment, recomputed below
  headView.setInt16(50, useShortLoca ? 0 : 1);

  const out: Array<[string, Uint8Array]> = [
    ['glyf', glyfBytes], ['head', headBytes], ['hhea', hheaBytes], ['hmtx', hmtxBytes],
    ['loca', locaBytes], ['maxp', maxpBytes],
  ];
  // cmap: rebuilt with hb's exact rules; also yields the retained codepoints
  // for OS/2's range pruning.
  const cmapTable = tables.get('cmap');
  let unicodes: number[] = [];
  if (cmapTable) {
    const rebuilt = subsetCmap(data, cmapTable.offset, new Set(gidList));
    if (rebuilt) {
      out.push(['cmap', rebuilt.bytes]);
      unicodes = rebuilt.unicodes;
    }
  }
  const nameTable = tables.get('name');
  if (nameTable) {
    const rebuilt = subsetName(data, nameTable);
    if (rebuilt) out.push(['name', rebuilt]);
  }
  const os2 = tables.get('OS/2');
  if (os2) out.push(['OS/2', subsetOs2(data, os2, unicodes)]);
  const gasp = tables.get('gasp');
  if (gasp) out.push(['gasp', data.slice(gasp.offset, gasp.offset + gasp.length)]);
  // GDEF: pass the closure'd glyph set (input + gid 0 + components).
  const gdef = tables.get('GDEF');
  if (gdef) {
    const trimmed = subsetGdef(data, gdef, wanted);
    if (trimmed) out.push(['GDEF', trimmed]);
  }
  const post = tables.get('post');
  if (post && post.length >= 32) {
    const bytes = data.slice(post.offset, post.offset + 32);
    new DataView(bytes.buffer).setUint32(0, 0x00030000); // no glyph names
    out.push(['post', bytes]);
  }
  // hb keeps every other table (PASSTHROUGH_UNRECOGNIZED) except the ones
  // WeasyPrint drops (BASE, DSIG, EBDT, EBLC, EBSC, GPOS, GSUB, JSTF, LTSH,
  // PCLT, SVG) and the hinting programs dropped by the NO_HINTING pass.
  const dropSet = new Set(['BASE', 'DSIG', 'EBDT', 'EBLC', 'EBSC', 'GPOS', 'GSUB', 'JSTF',
    'LTSH', 'PCLT', 'SVG', 'fpgm', 'prep', 'cvt ', 'glyf', 'head', 'hhea', 'hmtx',
    'loca', 'maxp', 'cmap', 'name', 'OS/2', 'GDEF', 'post']);
  for (const t of tables.values()) {
    if (dropSet.has(t.tag)) continue;
    out.push([t.tag, data.slice(t.offset, t.offset + t.length)]);
  }

  // Directory entries sorted by tag; table bodies laid out in ascending size
  // order with 4-byte alignment — matches hb_face_builder's output ordering.
  out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headerSize = 12 + 16 * out.length;
  const entries = new Uint8Array(headerSize);
  const ev = new DataView(entries.buffer);
  ev.setUint32(0, 0x00010000);
  ev.setUint16(4, out.length);
  const entrySelector = Math.floor(Math.log2(out.length));
  ev.setUint16(6, 16 * 2 ** entrySelector);
  ev.setUint16(8, entrySelector);
  ev.setUint16(10, 16 * out.length - 16 * 2 ** entrySelector);

  const order = out.map(([, bytes], i) => ({ index: i, bytes, size: bytes.length }));
  order.sort((a, b) => a.size - b.size || a.index - b.index);
  const offsets: number[] = [];
  const bodies: Uint8Array[] = [];
  let offset = headerSize;
  for (const { index, bytes } of order) {
    offsets[index] = offset;
    const padded = new Uint8Array((bytes.length + 3) & ~3);
    padded.set(bytes);
    bodies.push(padded);
    offset += padded.length;
  }
  out.forEach(([tag, bytes], i) => {
    const o = 12 + 16 * i;
    for (let k = 0; k < 4; k++) entries[o + k] = tag.charCodeAt(k);
    ev.setUint32(o + 4, checksum(bytes));
    ev.setUint32(o + 8, offsets[i]!);
    ev.setUint32(o + 12, bytes.length);
  });
  const font = concat([entries, ...bodies]);
  // head.checkSumAdjustment
  const adjustment = (0xb1b0afba - checksum(font)) >>> 0;
  const headIndex = out.findIndex(([tag]) => tag === 'head');
  const headOffsetInFile = new DataView(font.buffer).getUint32(12 + 16 * headIndex + 8);
  new DataView(font.buffer).setUint32(headOffsetInFile + 8, adjustment);
  return font;
}
