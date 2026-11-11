// SPDX-License-Identifier: BSD-3-Clause

/**
 * WOFF 1.0 to sfnt (TrueType/OpenType) conversion. Upstream decodes @font-face WOFF files with fontTools before
 * registering them (text/fonts.py add_font_face: `TTFont(woff); flavor = None; save()`), so everything downstream,
 * including PDF embedding, sees a plain sfnt.
 */
import { unzlibSync } from 'fflate';

/** True for WOFF 1.0 data ('wOFF' signature). */
export function isWoff(bytes: Uint8Array): boolean {
  return bytes.length >= 44 && bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x46;
}

/** Rebuild the sfnt from a WOFF 1.0 file, or return null when the data is malformed. */
export function woffToSfnt(woff: Uint8Array): Uint8Array | null {
  try {
    const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    const flavor = view.getUint32(4);
    const numTables = view.getUint16(12);
    const tables: Array<{ tag: number; checksum: number; data: Uint8Array }> = [];
    for (let i = 0; i < numTables; i++) {
      const entry = 44 + i * 20;
      const tag = view.getUint32(entry);
      const offset = view.getUint32(entry + 4);
      const compLength = view.getUint32(entry + 8);
      const origLength = view.getUint32(entry + 12);
      const checksum = view.getUint32(entry + 16);
      const raw = woff.subarray(offset, offset + compLength);
      const data = compLength < origLength ? unzlibSync(raw) : raw;
      if (data.length !== origLength) return null;
      tables.push({ tag, checksum, data });
    }
    tables.sort((a, b) => a.tag - b.tag);
    let entrySelector = 0;
    while (1 << (entrySelector + 1) <= numTables) entrySelector++;
    const searchRange = (1 << entrySelector) * 16;
    let size = 12 + 16 * numTables;
    for (const t of tables) size += (t.data.length + 3) & ~3;
    const out = new Uint8Array(size);
    const o = new DataView(out.buffer);
    o.setUint32(0, flavor);
    o.setUint16(4, numTables);
    o.setUint16(6, searchRange);
    o.setUint16(8, entrySelector);
    o.setUint16(10, numTables * 16 - searchRange);
    let offset = 12 + 16 * numTables;
    tables.forEach((t, i) => {
      const record = 12 + i * 16;
      o.setUint32(record, t.tag);
      o.setUint32(record + 4, t.checksum);
      o.setUint32(record + 8, offset);
      o.setUint32(record + 12, t.data.length);
      out.set(t.data, offset);
      offset += (t.data.length + 3) & ~3;
    });
    return out;
  } catch {
    return null;
  }
}
