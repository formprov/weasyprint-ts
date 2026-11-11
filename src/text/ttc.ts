// SPDX-License-Identifier: BSD-3-Clause

/**
 * Font collections (.ttc): extract one member as a standalone sfnt. Upstream loads the member with
 * fontTools (TTFont(file, fontNumber=index)) and embeds the subset of that font only; the port's subsetter reads a
 * single sfnt, so the member is cut out of the collection first.
 */

/** True for a TrueType collection ('ttcf' signature). */
export function isCollection(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66;
}

/** Build a standalone sfnt for member `index` of a collection, or return the input when it is not a collection. */
export function collectionMemberToSfnt(bytes: Uint8Array, index: number): Uint8Array {
  if (!isCollection(bytes)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numFonts = view.getUint32(8);
  const member = Math.min(Math.max(index, 0), Math.max(numFonts - 1, 0));
  const dirOffset = view.getUint32(12 + member * 4);
  const flavor = view.getUint32(dirOffset);
  const numTables = view.getUint16(dirOffset + 4);
  const tables: Array<{ tag: number; checksum: number; data: Uint8Array }> = [];
  for (let i = 0; i < numTables; i++) {
    const record = dirOffset + 12 + i * 16;
    const tag = view.getUint32(record);
    const checksum = view.getUint32(record + 4);
    const offset = view.getUint32(record + 8);
    const length = view.getUint32(record + 12);
    tables.push({ tag, checksum, data: bytes.subarray(offset, offset + length) });
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
}
