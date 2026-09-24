'use strict';
/**
 * grcTexture (legacy PC / FiveM) structures and texture dictionaries.
 *
 * TextureBase (0x50 bytes)                       Texture : TextureBase (0x90 bytes)
 *   0x28 ptr   NamePointer                         0x50 u16 Width
 *   0x40 u32   UsageData (& 0x1F = usage)          0x52 u16 Height
 *                                                  0x54 u16 Depth
 *                                                  0x56 u16 Stride
 *                                                  0x58 u32 Format
 *                                                  0x5D u8  Levels
 *                                                  0x70 ptr DataPointer (graphics segment)
 *
 * TextureDictionary (0x40 bytes, resource root of a .ytd)
 *   0x20 SimpleList64<uint> TextureNameHashes  (ptr, u16 count, u16 capacity)
 *   0x30 PointerList64<Texture> Textures       (ptr, u16 count, u16 capacity)
 */
const { mipChain, FMT_NAME } = require('./texfmt');

const USAGE = { DIFFUSE: 20, DETAIL: 21, NORMAL: 22, SPECULAR: 23, EMISSIVE: 24, TINTPALETTE: 25 };

function readTextureRef(res, ptr) {
  const namePtr = res.ptr(ptr + 0x28);
  return { ptr, name: namePtr ? res.cstring(namePtr) : null };
}

function readTexture(res, ptr) {
  const base = readTextureRef(res, ptr);
  const usageData = res.u32(ptr + 0x40);
  const width = res.u16(ptr + 0x50);
  const height = res.u16(ptr + 0x52);
  const depth = res.u16(ptr + 0x54) || 1;
  const stride = res.u16(ptr + 0x56);
  const format = res.u32(ptr + 0x58);
  const levels = res.u8(ptr + 0x5d);
  const dataPtr = res.ptr(ptr + 0x70);
  const tex = {
    ...base, usage: usageData & 0x1f, width, height, depth, stride, format,
    formatName: FMT_NAME[format] || `0x${format.toString(16)}`, levels, dataPtr,
  };
  if (!width || !height || !levels || !dataPtr) { tex.valid = false; return tex; }
  const chain = mipChain(format, width, height, levels);
  tex.mips = chain.mips;
  tex.dataSize = chain.totalSize * depth;
  tex.data = res.bytes(dataPtr, tex.dataSize); // live view into the resource
  tex.valid = !!tex.data;
  return tex;
}

function readTextureDictionary(res, ptr) {
  const listPtr = res.ptr(ptr + 0x30);
  const count = res.u16(ptr + 0x38);
  const textures = [];
  for (let i = 0; i < count; i++) {
    const tptr = res.ptr(listPtr + i * 8);
    if (tptr) textures.push(readTexture(res, tptr));
  }
  return textures;
}

/** .ytd: the resource root is the TextureDictionary. */
function readYtd(res) {
  if (res.version !== 13) {
    if (res.version === 5) throw new Error('Gen9 (Enhanced) .ytd is not supported – FiveM uses legacy (version 13) resources');
  }
  return readTextureDictionary(res, 0x50000000);
}

module.exports = { USAGE, readTexture, readTextureRef, readTextureDictionary, readYtd };
