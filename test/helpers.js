'use strict';
/** Test helpers: synthetic images and a minimal legacy .ytd writer. */
const zlib = require('zlib');
const { FMT, mipChain } = require('../src/formats/texfmt');
const { encodeMip } = require('../src/texture/codec');

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Fill an RGBA image with a function (x,y) -> [r,g,b,a]. */
function image(w, h, fn) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y); px.set([c[0], c[1], c[2], c[3] === undefined ? 255 : c[3]], (y * w + x) * 4); }
  return px;
}

/** Fabric-like noise so the recolor has "detail" to preserve. */
function fabric(base, amp, seed = 1) {
  const r = rng(seed);
  return () => { const n = (r() - 0.5) * amp; return base.map((v) => Math.max(0, Math.min(255, Math.round(v + n)))); };
}

function align(n, a) { return Math.ceil(n / a) * a; }

/**
 * Build a legacy (version 13) .ytd containing the given textures.
 * @param {Array<{name:string, width:number, height:number, format:number, rgba:Uint8Array, levels?:number}>} textures
 */
function makeYtd(textures) {
  const sys = Buffer.alloc(0x10000);
  const gfx = [];
  let gfxOff = 0;
  let sysOff = 0x40; // TextureDictionary at 0
  const texPtrs = [];
  const hashesOff = sysOff; sysOff = align(sysOff + textures.length * 4, 16);
  const listOff = sysOff; sysOff = align(sysOff + textures.length * 8, 16);
  for (const t of textures) {
    const levels = t.levels || 1;
    const chain = mipChain(t.format, t.width, t.height, levels);
    const data = Buffer.alloc(chain.totalSize);
    // mips: box-downsample the source
    let src = t.rgba, sw = t.width, sh = t.height;
    for (const m of chain.mips) {
      if (m.width !== sw || m.height !== sh) {
        const d = new Uint8Array(m.width * m.height * 4);
        for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) for (let c = 0; c < 4; c++) {
          let s = 0; for (let k = 0; k < 4; k++) s += src[(((y * 2 + (k >> 1)) * sw) + x * 2 + (k & 1)) * 4 + c]; d[(y * m.width + x) * 4 + c] = s >> 2;
        }
        src = d; sw = m.width; sh = m.height;
      }
      encodeMip(t.format, src, m.width, m.height, data.subarray(m.offset, m.offset + m.size), null);
    }
    const texOff = sysOff; sysOff = align(sysOff + 0x90, 16);
    const nameOff = sysOff; sys.write(t.name + '\0', nameOff, 'latin1'); sysOff = align(sysOff + t.name.length + 1, 16);
    sys.writeUInt32LE(0x50000000 + nameOff, texOff + 0x28);
    sys.writeUInt32LE(20, texOff + 0x40); // usage DIFFUSE
    sys.writeUInt16LE(t.width, texOff + 0x50);
    sys.writeUInt16LE(t.height, texOff + 0x52);
    sys.writeUInt16LE(1, texOff + 0x54);
    sys.writeUInt32LE(t.format, texOff + 0x58);
    sys[texOff + 0x5d] = levels;
    sys.writeUInt32LE(0x60000000 + gfxOff, texOff + 0x70);
    gfx.push(data); gfxOff += align(data.length, 16);
    if (data.length % 16) gfx.push(Buffer.alloc(align(data.length, 16) - data.length));
    texPtrs.push(texOff);
  }
  sys.writeUInt32LE(1, 0x18);
  sys.writeUInt32LE(0x50000000 + hashesOff, 0x20); sys.writeUInt16LE(textures.length, 0x28); sys.writeUInt16LE(textures.length, 0x2a);
  sys.writeUInt32LE(0x50000000 + listOff, 0x30); sys.writeUInt16LE(textures.length, 0x38); sys.writeUInt16LE(textures.length, 0x3a);
  texPtrs.forEach((p, i) => sys.writeUInt32LE(0x50000000 + p, listOff + i * 8));

  const sysSize = align(sysOff, 0x2000);
  const gfxBuf = Buffer.concat(gfx);
  const gfxSize = align(Math.max(gfxBuf.length, 1), 0x2000);
  const flags = (size) => ((size / 0x2000) << 17) >>> 0; // base 0x200 * 16 per unit (s4)
  if (sysSize / 0x2000 > 127 || gfxSize / 0x2000 > 127) throw new Error('test ytd too big');
  const body = Buffer.concat([sys.subarray(0, sysSize), gfxBuf, Buffer.alloc(gfxSize - gfxBuf.length)]);
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(0x37435352, 0); hdr.writeUInt32LE(13, 4);
  hdr.writeUInt32LE(flags(sysSize), 8); hdr.writeUInt32LE((flags(gfxSize) | (13 << 28)) >>> 0, 12);
  return Buffer.concat([hdr, zlib.deflateRawSync(body)]);
}

module.exports = { rng, image, fabric, makeYtd, FMT };
