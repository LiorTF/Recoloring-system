'use strict';
/**
 * RSC7 resource container (GTA V legacy / FiveM .ytd .ydd .ydr .yft ...).
 *
 * Layout: 16 byte header + raw-deflate( systemPages || graphicsPages ).
 *   0x00 uint32 magic 'RSC7' (0x37435352)
 *   0x04 uint32 version        (ytd = 13, ydd = 165, ydr = 165, yft = 162)
 *   0x08 uint32 systemFlags    (page layout, encodes system segment size)
 *   0x0C uint32 graphicsFlags  (page layout, encodes graphics segment size)
 *
 * Inside the decompressed blob, pointers are virtual addresses:
 *   0x5xxxxxxx -> system segment (structures, names)
 *   0x6xxxxxxx -> graphics segment (pixel data, vertex/index data)
 *
 * We never rebuild the page layout. Recoloring keeps every texture the same
 * size/format, so we patch bytes in place and recompress with the original
 * flags. That is the safest possible write path (nothing can move).
 */
const zlib = require('zlib');

const RSC7_MAGIC = 0x37435352;
const SYSTEM_BASE = 0x50000000;
const GRAPHICS_BASE = 0x60000000;

function sizeFromFlags(flags) {
  const s0 = ((flags >>> 27) & 0x1) << 0;
  const s1 = ((flags >>> 26) & 0x1) << 1;
  const s2 = ((flags >>> 25) & 0x1) << 2;
  const s3 = ((flags >>> 24) & 0x1) << 3;
  const s4 = ((flags >>> 17) & 0x7f) << 4;
  const s5 = ((flags >>> 11) & 0x3f) << 5;
  const s6 = ((flags >>> 7) & 0xf) << 6;
  const s7 = ((flags >>> 5) & 0x3) << 7;
  const s8 = ((flags >>> 4) & 0x1) << 8;
  const ss = flags & 0xf;
  const baseSize = 0x200 * 2 ** ss;
  return baseSize * (s0 + s1 + s2 + s3 + s4 + s5 + s6 + s7 + s8);
}

function isRsc7(buf) {
  return buf && buf.length >= 16 && buf.readUInt32LE(0) === RSC7_MAGIC;
}

/**
 * @param {Buffer} buf raw file bytes
 * @returns {Resource}
 */
function readRsc7(buf) {
  if (!isRsc7(buf)) {
    const magic = buf && buf.length >= 4 ? buf.readUInt32LE(0).toString(16) : 'none';
    throw new Error(`Not an RSC7 resource (magic 0x${magic}). ` +
      'If this came out of an RPF it may be encrypted/unwrapped; export it with CodeWalker/OpenIV first.');
  }
  const version = buf.readUInt32LE(4);
  const systemFlags = buf.readUInt32LE(8);
  const graphicsFlags = buf.readUInt32LE(12);
  const systemSize = sizeFromFlags(systemFlags);
  const graphicsSize = sizeFromFlags(graphicsFlags);

  let data = zlib.inflateRawSync(buf.subarray(16));
  const expected = systemSize + graphicsSize;
  if (data.length < expected) {
    // Some tools write trailing pages lazily; pad so pointer math stays valid.
    const padded = Buffer.alloc(expected);
    data.copy(padded);
    data = padded;
  }
  return new Resource({ version, systemFlags, graphicsFlags, systemSize, graphicsSize, data, originalLength: data.length });
}

class Resource {
  constructor({ version, systemFlags, graphicsFlags, systemSize, graphicsSize, data, originalLength }) {
    this.version = version;
    this.systemFlags = systemFlags;
    this.graphicsFlags = graphicsFlags;
    this.systemSize = systemSize;
    this.graphicsSize = graphicsSize;
    this.data = data;
    this.originalLength = originalLength;
    this.system = data.subarray(0, systemSize);
    this.graphics = data.subarray(systemSize, systemSize + graphicsSize);
  }

  /** Resolve a virtual pointer to { buf, off }. Returns null for 0 / invalid. */
  resolve(ptr) {
    if (!ptr) return null;
    if (ptr >= GRAPHICS_BASE && ptr < GRAPHICS_BASE + 0x10000000) {
      const off = ptr - GRAPHICS_BASE;
      return off < this.graphics.length ? { buf: this.graphics, off } : null;
    }
    if (ptr >= SYSTEM_BASE && ptr < SYSTEM_BASE + 0x10000000) {
      const off = ptr - SYSTEM_BASE;
      return off < this.system.length ? { buf: this.system, off } : null;
    }
    return null;
  }

  u8(ptr) { const r = this.resolve(ptr); return r ? r.buf[r.off] : 0; }
  u16(ptr) { const r = this.resolve(ptr); return r ? r.buf.readUInt16LE(r.off) : 0; }
  u32(ptr) { const r = this.resolve(ptr); return r ? r.buf.readUInt32LE(r.off) : 0; }
  f32(ptr) { const r = this.resolve(ptr); return r ? r.buf.readFloatLE(r.off) : 0; }

  /** Read a 64-bit pointer field. Pointers fit in 32 bits; high dword must be 0. */
  ptr(ptr) {
    const r = this.resolve(ptr);
    if (!r) return 0;
    const lo = r.buf.readUInt32LE(r.off);
    const hi = r.buf.readUInt32LE(r.off + 4);
    return hi === 0 ? lo : 0;
  }

  cstring(ptr, max = 256) {
    const r = this.resolve(ptr);
    if (!r) return null;
    let end = r.off;
    const lim = Math.min(r.buf.length, r.off + max);
    while (end < lim && r.buf[end] !== 0) end++;
    return r.buf.toString('latin1', r.off, end);
  }

  /** Slice (view, not copy) of `len` bytes at a virtual pointer. */
  bytes(ptr, len) {
    const r = this.resolve(ptr);
    if (!r) return null;
    if (r.off + len > r.buf.length) return null;
    return r.buf.subarray(r.off, r.off + len);
  }

  writeU32(ptr, v) { const r = this.resolve(ptr); if (r) r.buf.writeUInt32LE(v >>> 0, r.off); }

  /** Serialise back to an RSC7 file using the ORIGINAL page flags. */
  toBuffer({ level = 9 } = {}) {
    const body = this.data.subarray(0, this.originalLength);
    const compressed = zlib.deflateRawSync(body, { level });
    const header = Buffer.alloc(16);
    header.writeUInt32LE(RSC7_MAGIC, 0);
    header.writeUInt32LE(this.version >>> 0, 4);
    header.writeUInt32LE(this.systemFlags >>> 0, 8);
    header.writeUInt32LE(this.graphicsFlags >>> 0, 12);
    return Buffer.concat([header, compressed]);
  }
}

module.exports = { RSC7_MAGIC, SYSTEM_BASE, GRAPHICS_BASE, sizeFromFlags, isRsc7, readRsc7, Resource };
