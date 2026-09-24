'use strict';
/**
 * Minimal DDS reader/patcher (DX9 + DX10 headers) mapping onto GTA texture formats,
 * so users who already extract .dds (CodeWalker / OpenIV / Texture Toolkit) can use
 * the same recolor pipeline.
 */
const { FMT, mipChain } = require('./texfmt');

const fourcc = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);

function readDDS(buf) {
  if (buf.length < 128 || buf.readUInt32LE(0) !== fourcc('DDS ')) throw new Error('Not a DDS file');
  const height = buf.readUInt32LE(12);
  const width = buf.readUInt32LE(16);
  const levels = Math.max(1, buf.readUInt32LE(28));
  const pfFlags = buf.readUInt32LE(80);
  const fcc = buf.readUInt32LE(84);
  const bitCount = buf.readUInt32LE(88);
  const rMask = buf.readUInt32LE(92);
  let dataOffset = 128;
  let format = 0;
  if (pfFlags & 0x4) { // DDPF_FOURCC
    if (fcc === fourcc('DX10')) {
      const dxgi = buf.readUInt32LE(128);
      dataOffset = 148;
      format = ({ 71: FMT.DXT1, 72: FMT.DXT1, 74: FMT.DXT3, 75: FMT.DXT3, 77: FMT.DXT5, 78: FMT.DXT5,
        80: FMT.ATI1, 83: FMT.ATI2, 98: FMT.BC7, 99: FMT.BC7, 87: FMT.A8R8G8B8, 88: FMT.X8R8G8B8, 28: FMT.A8B8G8R8, 29: FMT.A8B8G8R8 })[dxgi] || 0;
    } else if (fcc === fourcc('DXT1')) format = FMT.DXT1;
    else if (fcc === fourcc('DXT3')) format = FMT.DXT3;
    else if (fcc === fourcc('DXT5')) format = FMT.DXT5;
    else if (fcc === fourcc('ATI1') || fcc === fourcc('BC4U')) format = FMT.ATI1;
    else if (fcc === fourcc('ATI2') || fcc === fourcc('BC5U')) format = FMT.ATI2;
  } else if (bitCount === 32) {
    format = rMask === 0x00ff0000 ? FMT.A8R8G8B8 : FMT.A8B8G8R8;
  }
  if (!format) throw new Error('Unsupported DDS pixel format');
  const chain = mipChain(format, width, height, levels);
  // Some writers emit fewer mips than declared data; clamp to what's present.
  const avail = buf.length - dataOffset;
  const mips = chain.mips.filter((m) => m.offset + m.size <= avail);
  return { width, height, format, levels: mips.length, dataOffset, mips, data: buf.subarray(dataOffset, dataOffset + chain.totalSize) };
}

module.exports = { readDDS };
