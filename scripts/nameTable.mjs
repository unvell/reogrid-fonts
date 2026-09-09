// Rewrite an sfnt's `name` table so an instanced font reports the weight it
// actually draws at.
//
// Why this exists: harfbuzz does not touch `name` when it instances a variable
// font. Pin `wght` to 700 and you get a font whose outlines are Bold, whose
// `OS/2.usWeightClass` is 700, and which still calls itself "NotoSansJP Thin".
// That name is not cosmetic — pdf-creator copies the PostScript name into the
// PDF's `/BaseFont`, so a correct document reads
//
//     /BaseFont /ABCDEF+NotoSansJP-Thin
//
// which is exactly the symptom of the bug we are fixing (unvell/reogrid-web#34).
// Shipping three weights makes it worse: all three would name themselves Thin,
// and a reader comparing them has nothing to go on.
//
// Deliberately dependency-free, like `verify.mjs`: the whole point is to not
// take the subsetter's word for the bytes.

/** Read the sfnt table directory. */
function readTables(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const sfntVersion = view.getUint32(0);
  const numTables = view.getUint16(4);
  const entries = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + i * 16;
    entries.push({
      tag: String.fromCharCode(buf[at], buf[at + 1], buf[at + 2], buf[at + 3]),
      offset: view.getUint32(at + 8),
      length: view.getUint32(at + 12),
    });
  }
  return { sfntVersion, entries };
}

/**
 * Sum of the table's data as big-endian uint32, zero-padded to a multiple of
 * four — the checksum every sfnt table directory entry carries.
 */
function checksum(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum;
}

/** UTF-16BE, the encoding every Windows-platform name record uses. */
function encodeUtf16be(text) {
  const out = Buffer.alloc(text.length * 2);
  for (let i = 0; i < text.length; i += 1) out.writeUInt16BE(text.charCodeAt(i), i * 2);
  return out;
}

/**
 * Build a replacement `name` table.
 *
 * Records are kept as they are, in order, except that any record whose nameID
 * appears in `replacements` gets new string data. Only platform 3 (Windows,
 * UTF-16BE) and platform 1 (Macintosh, single-byte — our names are ASCII) are
 * re-encoded; a record on any other platform is passed through untouched
 * rather than guessing at its encoding.
 */
function buildNameTable(table, replacements) {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const format = view.getUint16(0);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);

  const records = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 12;
    const platformID = view.getUint16(at);
    const encodingID = view.getUint16(at + 2);
    const languageID = view.getUint16(at + 4);
    const nameID = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const offset = view.getUint16(at + 10);

    let data = Buffer.from(table.subarray(storage + offset, storage + offset + length));
    const replacement = replacements[nameID];
    if (replacement !== undefined) {
      if (platformID === 3) data = encodeUtf16be(replacement);
      else if (platformID === 1) data = Buffer.from(replacement, 'latin1');
    }
    records.push({ platformID, encodingID, languageID, nameID, data });
  }

  // Format 1 carries language-tag records between the name records and the
  // string pool. We do not emit them (Noto's `name` is format 0), but refusing
  // loudly beats silently dropping them.
  if (format !== 0) {
    throw new Error(`name table format ${format} is not supported (expected 0)`);
  }

  const headerSize = 6 + records.length * 12;
  const pool = [];
  let poolLength = 0;
  const offsets = [];
  // Identical strings are shared, which is what the upstream tables do and what
  // keeps the pool from tripling when three name IDs carry the same family.
  const seen = new Map();
  for (const record of records) {
    const key = record.data.toString('binary');
    let offset = seen.get(key);
    if (offset === undefined) {
      offset = poolLength;
      seen.set(key, offset);
      pool.push(record.data);
      poolLength += record.data.length;
    }
    offsets.push(offset);
  }

  const out = Buffer.alloc(headerSize + poolLength);
  out.writeUInt16BE(0, 0); // format
  out.writeUInt16BE(records.length, 2);
  out.writeUInt16BE(headerSize, 4);
  records.forEach((record, i) => {
    const at = 6 + i * 12;
    out.writeUInt16BE(record.platformID, at);
    out.writeUInt16BE(record.encodingID, at + 2);
    out.writeUInt16BE(record.languageID, at + 4);
    out.writeUInt16BE(record.nameID, at + 6);
    out.writeUInt16BE(record.data.length, at + 8);
    out.writeUInt16BE(offsets[i], at + 10);
  });
  let at = headerSize;
  for (const data of pool) {
    data.copy(out, at);
    at += data.length;
  }
  return out;
}

/**
 * Re-emit an sfnt with one table replaced.
 *
 * The new `name` is a different length, so every table after it moves: the
 * directory has to be rebuilt from scratch rather than patched. Tables are
 * written in tag order, each aligned to four bytes, and `head`'s
 * `checkSumAdjustment` is recomputed last (it is a checksum over the finished
 * file, so it cannot be known before the file exists).
 */
function rebuildSfnt(sfntVersion, tables) {
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const numTables = sorted.length;
  const directorySize = 12 + numTables * 16;

  const padded = sorted.map((t) => {
    const pad = (4 - (t.data.length % 4)) % 4;
    return { ...t, padded: pad ? Buffer.concat([t.data, Buffer.alloc(pad)]) : t.data };
  });

  const total = padded.reduce((n, t) => n + t.padded.length, directorySize);
  const out = Buffer.alloc(total);

  // Binary-search hint fields. Wrong values do not stop a parser that scans the
  // directory linearly, but validators check them.
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) entrySelector += 1;
  const searchRange = (1 << entrySelector) * 16;

  out.writeUInt32BE(sfntVersion, 0);
  out.writeUInt16BE(numTables, 4);
  out.writeUInt16BE(searchRange, 6);
  out.writeUInt16BE(entrySelector, 8);
  out.writeUInt16BE(numTables * 16 - searchRange, 10);

  let offset = directorySize;
  let headOffset = -1;
  padded.forEach((t, i) => {
    const at = 12 + i * 16;
    out.write(t.tag, at, 4, 'latin1');
    out.writeUInt32BE(checksum(t.padded), at + 4);
    out.writeUInt32BE(offset, at + 8);
    out.writeUInt32BE(t.data.length, at + 12); // the *unpadded* length
    t.padded.copy(out, offset);
    if (t.tag === 'head') headOffset = offset;
    offset += t.padded.length;
  });

  if (headOffset >= 0) {
    // The adjustment is defined as 0xB1B0AFBA minus the checksum of the whole
    // file computed with this field zeroed.
    out.writeUInt32BE(0, headOffset + 8);
    const adjustment = (0xb1b0afba - checksum(out)) >>> 0;
    out.writeUInt32BE(adjustment, headOffset + 8);
  }

  return out;
}

/**
 * Return `buf` with its `name` table rewritten to describe `family` at `style`.
 *
 * The name IDs are the ones a PDF consumer and a font manager actually read:
 * 1 family, 2 subfamily, 3 unique id, 4 full name, 6 PostScript name. ID 16/17
 * (typographic family/subfamily) are dropped by the harfbuzz subsetter, so a
 * three-weight family reads as three standalone faces — which is what we want
 * here, since nothing composes them into a family.
 */
export function renameFont(buf, { family, style }) {
  const postScript = `${family.replace(/\s+/g, '')}-${style.replace(/\s+/g, '')}`;
  const full = `${family} ${style}`;
  const replacements = {
    1: family,
    2: style,
    3: `${full}; ReoGrid subset`,
    4: full,
    6: postScript,
  };

  const { sfntVersion, entries } = readTables(buf);
  const tables = entries.map((entry) => ({
    tag: entry.tag,
    data: Buffer.from(buf.subarray(entry.offset, entry.offset + entry.length)),
  }));

  const name = tables.find((t) => t.tag === 'name');
  if (!name) throw new Error('missing `name` table');
  name.data = buildNameTable(name.data, replacements);

  return rebuildSfnt(sfntVersion, tables);
}

/** Read back name ID `id` (Windows platform) — used by `verify.mjs`. */
export function readName(buf, id) {
  const { entries } = readTables(buf);
  const entry = entries.find((t) => t.tag === 'name');
  if (!entry) return undefined;
  const table = buf.subarray(entry.offset, entry.offset + entry.length);
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const count = view.getUint16(2);
  const storage = view.getUint16(4);
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 12;
    if (view.getUint16(at) !== 3 || view.getUint16(at + 6) !== id) continue;
    const length = view.getUint16(at + 8);
    const offset = view.getUint16(at + 10);
    let text = '';
    for (let j = 0; j < length; j += 2) text += String.fromCharCode(view.getUint16(storage + offset + j));
    return text;
  }
  return undefined;
}
