// The git wire primitives: pkt-line framing and packfiles. A pack here is
// always written with full (undeltified) objects — larger than a deltified
// pack but valid everywhere — and read with full delta support, because a
// pushing client may deltify against objects the forge already holds.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type GitObjectType } from './store.ts';

export const ZERO_SHA = '0000000000000000000000000000000000000000';

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const HEX_DIGITS = '0123456789abcdef';

/** Write a pkt-line length as 4 lowercase hex digits at `offset`. */
export function writePktLength(out: Buffer, offset: number, length: number): void {
  out[offset] = HEX_DIGITS.charCodeAt((length >>> 12) & 0xf);
  out[offset + 1] = HEX_DIGITS.charCodeAt((length >>> 8) & 0xf);
  out[offset + 2] = HEX_DIGITS.charCodeAt((length >>> 4) & 0xf);
  out[offset + 3] = HEX_DIGITS.charCodeAt(length & 0xf);
}

/** Frame one pkt-line: 4 hex digits of total length + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  if (typeof payload === 'string') {
    const length = Buffer.byteLength(payload, 'utf8') + 4;
    const out = Buffer.allocUnsafe(length);
    writePktLength(out, 0, length);
    out.write(payload, 4, 'utf8');
    return out;
  }
  const length = payload.length + 4;
  const out = Buffer.allocUnsafe(length);
  writePktLength(out, 0, length);
  payload.copy(out, 4);
  return out;
}

/** The flush packet (0000). */
export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

/** The delimiter packet (0001), protocol v2's section separator. */
export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/**
 * The pkt-line length named by the 4 bytes at `offset`, or -1 when they
 * are not exactly 4 lowercase hex digits (the framing the parser accepts).
 * Reads char codes directly: a request body carries a packet per line, and
 * a regex over a fresh string per packet was measurable on every POST.
 */
function pktLengthAt(buffer: Buffer, offset: number): number {
  let value = 0;
  for (let i = 0; i < 4; i += 1) {
    const code = buffer[offset + i] as number;
    let digit: number;
    if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
    else if (code >= 0x61 && code <= 0x66) digit = code - 0x57;
    else return -1;
    value = (value << 4) | digit;
  }
  return value;
}

/**
 * Split a buffer into pkt-line packets. Returns the packets plus any
 * trailing bytes that are not pkt-framed (a packfile after a flush, in
 * receive-pack requests).
 */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = pktLengthAt(buffer, offset);
    if (length < 0) break;
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      // A response-end packet in v2; treat as a flush for our purposes.
      packets.push({ kind: 'flush' });
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
    // A data packet may be the last one; keep scanning for framing.
    if (offset + 4 <= buffer.length && pktLengthAt(buffer, offset) < 0) break;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/**
 * Split a buffer that is entirely pkt-line framed (a v0 fetch request: two
 * sections, each flush-terminated, with no trailing pack) into packets.
 */
export function parseAllPackets(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = pktLengthAt(buffer, offset);
    if (length < 0) break;
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Encode an object header for a pack entry: variable-length type + size. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/**
 * Deflated pack entries memoize by object identity: a stored object is
 * immutable, so its entry (header + deflated bytes) is a pure function of
 * the object, and successive fetches of one repository overlap heavily —
 * a subset fetch reuses the entries the full fetch already paid to deflate
 * instead of deflating every object again. The bytes are unchanged.
 */
const packEntryCache = new WeakMap<GitObject, Buffer>();

/** One object's pack entry: its header followed by its deflated data. */
function packEntry(object: GitObject): Buffer {
  const cached = packEntryCache.get(object);
  if (cached !== undefined) return cached;
  const header = packObjectHeader(object.type, object.data.length);
  const deflated = deflateSync(object.data);
  const entry = Buffer.allocUnsafe(header.length + deflated.length);
  header.copy(entry, 0);
  deflated.copy(entry, header.length);
  packEntryCache.set(object, entry);
  return entry;
}

/** Build a complete packfile (version 2, sha1 trailer) from full objects. */
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packEntry(object));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * The largest byte count a zlib stream holding `size` inflated bytes can
 * occupy when an encoder is free to fall back to stored blocks: the 2-byte
 * wrapper, one stored block per 65,535 payload bytes (5 bytes of block
 * framing each) and the 4-byte adler32. Real encoders (zlib, git) never
 * emit more for a single object; a hand-crafted stream could, so callers
 * treat this as a fast-path bound, never as an assumption.
 */
function storedBound(size: number): number {
  return size + 5 * Math.max(1, Math.ceil(size / 65535)) + 6;
}

/** One probe: inflate the prefix of `length` bytes; null when it does not inflate. */
function tryInflate(buffer: Buffer, offset: number, length: number): Buffer | null {
  try {
    return inflateSync(buffer.subarray(offset, offset + length));
  } catch {
    return null;
  }
}

/** The adler32 checksum a zlib stream ends with, over its inflated bytes. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + (data[i] as number)) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * The exact byte length of the stream at `offset` when it is stored-format
 * (BTYPE=00 blocks only — what an encoder emits for incompressible data),
 * or null when it is anything else. A stored stream's layout is fully
 * determined by its block headers: the 2-byte zlib wrapper, then per block
 * a header byte, a 2-byte length and its complement, and the raw payload,
 * then the 4-byte adler32 — so its length is read, not searched for. The
 * payload lengths must sum to `size`; any inconsistency means the stream
 * is not what it claims and null sends the caller back to probing.
 */
function storedStreamLength(buffer: Buffer, offset: number, size: number): number | null {
  let pos = offset + 2; // the zlib wrapper
  let produced = 0;
  for (;;) {
    if (pos + 5 > buffer.length) return null;
    const header = buffer[pos] as number;
    const bfinal = header & 0x01;
    const btype = (header >> 1) & 0x03;
    if (btype !== 0x00) return null;
    const length = buffer.readUInt16LE(pos + 1);
    const complement = buffer.readUInt16LE(pos + 3);
    if (length !== (~complement & 0xffff)) return null;
    produced += length;
    if (produced > size) return null;
    pos += 5 + length;
    if (bfinal === 1) break;
  }
  if (produced !== size) return null;
  return pos + 4 - offset; // the adler32
}

/**
 * Find how many bytes the deflate stream starting at `offset` occupies and
 * inflate it: inflateSync ignores trailing bytes, so the shortest prefix
 * that inflates is exactly the stream.
 *
 * The search starts at the stored bound (see storedBound): for the common
 * case of incompressible data the stream ends exactly there, which two
 * probes settle — one at the bound (whose result is the object's data) and
 * one a byte shorter (which must fail). A shorter stream's end is named by
 * its own adler32 trailer: one scan for those 4 bytes plus one verifying
 * inflate settles it, with the re-deflate reproduction and then a binary
 * search under the bound as fallbacks; anything longer than the bound (a
 * stream no real encoder writes) falls back to a binary search of the
 * whole remainder. `size` is
 * the object's inflated length from its pack header; `endHint`, when the
 * caller knows where the stream must end (the last object in a pack ends
 * 20 bytes before the buffer does, at the pack trailer), is tried first.
 */
function inflatedLength(buffer: Buffer, offset: number, size: number, endHint?: number): { data: Buffer; consumed: number } {
  const remaining = buffer.length - offset;
  if (endHint !== undefined && endHint > 0 && endHint <= remaining) {
    const hinted = tryInflate(buffer, offset, endHint);
    if (hinted !== null && hinted.length === size) return { data: hinted, consumed: endHint };
  }
  const bound = Math.min(remaining, storedBound(size));
  // Stored-format streams (incompressible data) name their own length:
  // one inflate of exactly that slice settles both data and length.
  const storedLength = storedStreamLength(buffer, offset, size);
  if (storedLength !== null && storedLength <= remaining) {
    const stored = tryInflate(buffer, offset, storedLength);
    if (stored !== null && stored.length === size) return { data: stored, consumed: storedLength };
  }
  let data = tryInflate(buffer, offset, bound);
  if (data !== null) {
    // The data is known now; only its stream's exact length is not. The
    // stream ends with the adler32 of its own data, big-endian: scan for
    // that 4-byte needle (a memmem, not a probe) and verify each candidate
    // end by inflating exactly that prefix. The first candidate is the end
    // for any stream a real encoder wrote — an adler collision inside one
    // object's span is rare, and a false candidate simply fails its verify
    // and the scan moves on. This settles the length with one extra
    // inflate where the re-deflate reproduction below needs a full deflate
    // — and where a different encoder level made that reproduction miss
    // entirely, it avoids the long binary search of probes.
    if (data.length === size) {
      const sum = adler32(data);
      const needle = Buffer.from([(sum >>> 24) & 0xff, (sum >>> 16) & 0xff, (sum >>> 8) & 0xff, sum & 0xff]);
      const lastStart = offset + bound - 4;
      // The scan starts right after the 2-byte wrapper — the earliest a
      // trailer can sit — so the true end is always among the candidates:
      // a shorter candidate's verify inflate throws (the stream is
      // incomplete there), and the true end verifies first.
      let searchFrom = offset + 2;
      while (searchFrom <= lastStart) {
        const at = buffer.indexOf(needle, searchFrom);
        if (at === -1 || at > lastStart) break;
        const consumed = at + 4 - offset;
        const check = tryInflate(buffer, offset, consumed);
        if (check !== null && check.length === size && check.equals(data)) return { data, consumed };
        searchFrom = at + 1;
      }
    }
    // One re-deflate at the default level reproduces the stream byte for
    // byte for the encoders git clients use — when it matches the pack's
    // bytes, its length is the answer, with no further probes. A mismatch
    // (some other level or strategy) just falls through to the probes below.
    if (data.length === size && bound > 8) {
      const redeflated = deflateSync(data);
      if (redeflated.length < bound && buffer.subarray(offset, offset + redeflated.length).equals(redeflated)) {
        return { data, consumed: redeflated.length };
      }
    }
    if (bound > 1) {
      if (tryInflate(buffer, offset, bound - 1) === null) return { data, consumed: bound };
      // Shorter than the bound: binary-search below it for the exact end.
      let lo = 1;
      let hi = bound - 1;
      let best = bound;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const attempt = tryInflate(buffer, offset, mid);
        if (attempt !== null) {
          best = mid;
          data = attempt;
          hi = mid - 1;
        } else {
          lo = mid + 1;
        }
      }
      return { data, consumed: best };
    }
    return { data, consumed: bound };
  }
  // Past the stored bound: not a stream a real encoder writes, but parse
  // it anyway with the original whole-remainder binary search.
  let lo = bound + 1;
  let hi = remaining;
  let best = -1;
  let bestData: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const attempt = tryInflate(buffer, offset, mid);
    if (attempt !== null) {
      best = mid;
      bestData = attempt;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best === -1 || bestData === null) throw new Error('corrupt deflate stream in pack');
  return { data: bestData, consumed: best };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const resultSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++] as number;
      if (op & 0x02) copyOffset |= (delta[offset++] as number) << 8;
      if (op & 0x04) copyOffset |= (delta[offset++] as number) << 16;
      if (op & 0x08) copyOffset |= (delta[offset++] as number) << 24;
      if (op & 0x10) copySize = delta[offset++] as number;
      if (op & 0x20) copySize |= (delta[offset++] as number) << 8;
      if (op & 0x40) copySize |= (delta[offset++] as number) << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize) throw new Error('delta result size mismatch');
  return result;
}

interface RawEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseSha?: string;
  baseOffset?: number;
  entryOffset: number;
}

/**
 * Parse a packfile into full objects. `resolveBase` supplies objects the
 * pack deltifies against but does not carry (thin packs); objects in the
 * pack itself are found first. Returns sha -> object.
 */
export function parsePack(pack: Buffer, resolveBase: (sha: string) => GitObject | null): Map<string, GitObject> {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    // The last entry's stream ends where the 20-byte pack trailer begins.
    const endHint = i === count - 1 ? pack.length - 20 - offset : undefined;
    let entry: RawEntry;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset varint to the base entry.
      let back = pack[offset] as number;
      offset += 1;
      let baseBack = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset] as number;
        offset += 1;
        baseBack = ((baseBack + 1) << 7) | (back & 0x7f);
      }
      const { data, consumed } = inflatedLength(pack, offset, size, endHint === undefined ? undefined : pack.length - 20 - offset);
      offset += consumed;
      entry = { type: 'ofs-delta', data, baseOffset: entryOffset - baseBack, entryOffset };
    } else if (typeCode === 7) {
      const baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, consumed } = inflatedLength(pack, offset, size, endHint === undefined ? undefined : pack.length - 20 - offset);
      offset += consumed;
      entry = { type: 'ref-delta', data, baseSha, entryOffset };
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflatedLength(pack, offset, size, endHint);
      offset += consumed;
      entry = { type, data, entryOffset };
    }
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<number, GitObject>();
  const resolveEntry = (entry: RawEntry): GitObject => {
    const cached = resolved.get(entry.entryOffset);
    if (cached !== undefined) return cached;
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
      const base = resolveEntry(baseEntry);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base = resolvedBySha(entry.baseSha as string);
      if (base === null) base = resolveBase(entry.baseSha as string);
      if (base === null) throw new Error('ref-delta base not available');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    resolved.set(entry.entryOffset, object);
    return object;
  };
  const bySha = new Map<string, GitObject>();
  const resolvedBySha = (sha: string): GitObject | null => bySha.get(sha) ?? null;
  // Resolve in passes: a ref-delta may name a base later in the pack.
  for (let pass = 0; pass < entries.length + 1; pass += 1) {
    let pending = false;
    for (const entry of entries) {
      if (resolved.has(entry.entryOffset)) continue;
      try {
        const object = resolveEntry(entry);
        bySha.set(hashObject(object.type, object.data), object);
      } catch {
        pending = true;
      }
    }
    if (!pending) break;
  }
  if (bySha.size !== entries.length) throw new Error('could not resolve every pack object');
  return bySha;
}
