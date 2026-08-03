/**
 * Deterministic ZIP writer for the DOCX renderer (§15: same variant, same
 * bytes, twice).
 *
 * Off-the-shelf zip libraries stamp modification times and vary compression;
 * this one stores entries uncompressed, in the order given, with a fixed DOS
 * timestamp — so the archive is a pure function of its entries. A resume-sized
 * package does not need compression.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  readonly path: string;
  readonly data: Uint8Array;
}

/** DOS date/time for 1980-01-01 00:00:00 — the epoch of the format itself. */
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (1 << 5) | 1; // month 1, day 1, year offset 0

function push16(out: number[], value: number): void {
  out.push(value & 0xFF, (value >>> 8) & 0xFF);
}

function push32(out: number[], value: number): void {
  out.push(value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF);
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const out: number[] = [];
  const central: number[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.path);
    const checksum = crc32(entry.data);
    const offset = out.length;

    // Local file header.
    push32(out, 0x04034B50);
    push16(out, 20); // version needed
    push16(out, 0); // flags
    push16(out, 0); // method: store
    push16(out, FIXED_DOS_TIME);
    push16(out, FIXED_DOS_DATE);
    push32(out, checksum);
    push32(out, entry.data.length);
    push32(out, entry.data.length);
    push16(out, nameBytes.length);
    push16(out, 0); // extra length
    for (const b of nameBytes) out.push(b);
    for (const b of entry.data) out.push(b);

    // Central directory record.
    push32(central, 0x02014B50);
    push16(central, 20); // version made by
    push16(central, 20); // version needed
    push16(central, 0);
    push16(central, 0);
    push16(central, FIXED_DOS_TIME);
    push16(central, FIXED_DOS_DATE);
    push32(central, checksum);
    push32(central, entry.data.length);
    push32(central, entry.data.length);
    push16(central, nameBytes.length);
    push16(central, 0); // extra
    push16(central, 0); // comment
    push16(central, 0); // disk number
    push16(central, 0); // internal attrs
    push32(central, 0); // external attrs
    push32(central, offset);
    for (const b of nameBytes) central.push(b);
  }

  const centralOffset = out.length;
  for (const b of central) out.push(b);

  // End of central directory.
  push32(out, 0x06054B50);
  push16(out, 0);
  push16(out, 0);
  push16(out, entries.length);
  push16(out, entries.length);
  push32(out, central.length);
  push32(out, centralOffset);
  push16(out, 0); // comment length

  return new Uint8Array(out);
}
