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

/** Frame one pkt-line: 4 hex digits of total length + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
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
 * Split a buffer into pkt-line packets. Returns the packets plus any
 * trailing bytes that are not pkt-framed (a packfile after a flush, in
 * receive-pack requests).
 */
export function parsePackets(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
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
    if (offset + 4 <= buffer.length && !/^[0-9a-f]{4}$/.test(buffer.toString('ascii', offset, offset + 4))) break;
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
    const header = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-f]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
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

/** Build a complete packfile (version 2, sha1 trailer) from full objects. */
export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Find how many bytes the deflate stream starting at `offset` occupies:
 * inflateSync ignores trailing bytes, so the shortest prefix that inflates
 * is exactly the stream. Binary search keeps this cheap on small objects.
 */
function inflatedLength(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  let lo = 1;
  let hi = buffer.length - offset;
  let best = -1;
  let bestData: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(buffer.subarray(offset, offset + mid));
      best = mid;
      bestData = data;
      hi = mid - 1;
    } catch {
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
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
    }
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
      const { data, consumed } = inflatedLength(pack, offset);
      offset += consumed;
      entry = { type: 'ofs-delta', data, baseOffset: entryOffset - baseBack, entryOffset };
    } else if (typeCode === 7) {
      const baseSha = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, consumed } = inflatedLength(pack, offset);
      offset += consumed;
      entry = { type: 'ref-delta', data, baseSha, entryOffset };
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const { data, consumed } = inflatedLength(pack, offset);
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
