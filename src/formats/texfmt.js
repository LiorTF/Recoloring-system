'use strict';
/**
 * GTA V (legacy / FiveM) texture formats as stored in grcTexture.Format.
 * Values from CodeWalker's TextureFormat enum.
 */
const FMT = Object.freeze({
  A8R8G8B8: 21, // bytes in memory: B G R A
  X8R8G8B8: 22, // B G R X
  A1R5G5B5: 25,
  A8: 28,
  A8B8G8R8: 32, // R G B A
  L8: 50,
  DXT1: 0x31545844,
  DXT3: 0x33545844,
  DXT5: 0x35545844,
  ATI1: 0x31495441, // BC4
  ATI2: 0x32495441, // BC5 (normal maps)
  BC7: 0x20374342,
});

const FMT_NAME = Object.fromEntries(Object.entries(FMT).map(([k, v]) => [v, k]));

/** Formats we can decode + re-encode losslessly-in-size. */
const RECOLORABLE = new Set([FMT.A8R8G8B8, FMT.X8R8G8B8, FMT.A8B8G8R8, FMT.DXT1, FMT.DXT3, FMT.DXT5, FMT.BC7]);

function isBlockCompressed(fmt) {
  return fmt === FMT.DXT1 || fmt === FMT.DXT3 || fmt === FMT.DXT5 || fmt === FMT.ATI1 || fmt === FMT.ATI2 || fmt === FMT.BC7;
}

function blockBytes(fmt) {
  return (fmt === FMT.DXT1 || fmt === FMT.ATI1) ? 8 : 16;
}

function bitsPerPixel(fmt) {
  switch (fmt) {
    case FMT.A8R8G8B8: case FMT.X8R8G8B8: case FMT.A8B8G8R8: return 32;
    case FMT.A1R5G5B5: return 16;
    case FMT.A8: case FMT.L8: return 8;
    default: return 0;
  }
}

/** Byte size of one mip level (DirectXTex ComputePitch semantics). */
function mipByteSize(fmt, w, h) {
  if (isBlockCompressed(fmt)) {
    const bw = Math.max(1, Math.floor((w + 3) / 4));
    const bh = Math.max(1, Math.floor((h + 3) / 4));
    return bw * bh * blockBytes(fmt);
  }
  const bpp = bitsPerPixel(fmt);
  return Math.floor((w * bpp + 7) / 8) * h;
}

/** Offsets/sizes of each mip, matching CodeWalker's Texture.CalcDataSize (Width / 2^i, integer). */
function mipChain(fmt, width, height, levels) {
  const out = [];
  let off = 0;
  for (let i = 0; i < levels; i++) {
    const w = Math.floor(width / 2 ** i);
    const h = Math.floor(height / 2 ** i);
    const size = mipByteSize(fmt, w, h);
    out.push({ level: i, width: Math.max(1, w), height: Math.max(1, h), offset: off, size });
    off += size;
  }
  return { mips: out, totalSize: off };
}

module.exports = { FMT, FMT_NAME, RECOLORABLE, isBlockCompressed, blockBytes, bitsPerPixel, mipByteSize, mipChain };
