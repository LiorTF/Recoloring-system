'use strict';
/**
 * .ydd / .ydr reader – only what the recolorer needs:
 *   - which shader every geometry uses (ped_default vs ped_alpha / glass / decal ...)
 *   - which DiffuseSampler texture that shader samples
 *   - the UV triangles of every geometry (to know WHICH texels are lens/visor/decal)
 *   - embedded textures (normal/spec live here for peds; some modders embed diffuse too)
 *
 * Offsets verified against CodeWalker (legacy / non-Gen9 layout).
 */
const { joaat } = require('../util/joaat');
const { readTextureDictionary, readTextureRef } = require('./texture');

const PARAM = {
  DiffuseSampler: joaat('diffusesampler'),
  BumpSampler: joaat('bumpsampler'),
  SpecSampler: joaat('specsampler'),
  DetailSampler: joaat('detailsampler'),
};
const PARAM_NAME = Object.fromEntries(Object.entries(PARAM).map(([k, v]) => [v, k]));

const SHADER_NAMES = [
  'ped', 'ped_alpha', 'ped_cloth', 'ped_cloth_enveff', 'ped_decal', 'ped_decal_decoration', 'ped_decal_expensive',
  'ped_decal_exp', 'ped_decal_nodiff', 'ped_default', 'ped_default_cloth', 'ped_default_cutout', 'ped_default_enveff',
  'ped_default_mp', 'ped_default_palette', 'ped_emissive', 'ped_enveff', 'ped_fur', 'ped_hair_cutout_alpha',
  'ped_hair_spiked', 'ped_nopeddamagedecals', 'ped_palette', 'ped_wrinkle', 'ped_wrinkle_cloth',
  'ped_wrinkle_cloth_enveff', 'ped_wrinkle_cs', 'ped_wrinkle_enveff',
  'glass', 'glass_breakable', 'glass_breakable_screendooralpha', 'glass_displacement', 'glass_emissive',
  'glass_emissive_alpha', 'glass_emissivenight', 'glass_emissivenight_alpha', 'glass_env', 'glass_normal_spec_reflect',
  'glass_pv', 'glass_pv_env', 'glass_reflect', 'glass_spec',
  'default', 'normal', 'normal_spec', 'spec', 'cutout', 'decal', 'emissive', 'alpha', 'normal_alpha', 'spec_alpha',
  'normal_spec_alpha', 'normal_spec_cutout', 'normal_cutout', 'emissive_alpha', 'emissivenight', 'decal_emissive_only',
  'normal_decal', 'normal_spec_decal', 'spec_decal', 'decal_dirt', 'default_noedge', 'mirror_default', 'reflect', 'normal_reflect',
  'normal_spec_reflect', 'spec_reflect', 'vehicle_vehglass', 'vehicle_vehglass_inner', 'cloth_default', 'cloth_normal_spec',
];
const SHADER_BY_HASH = new Map();
for (const s of SHADER_NAMES) { SHADER_BY_HASH.set(joaat(s), s); SHADER_BY_HASH.set(joaat(s + '.sps'), s); }

/**
 * Role of a shader for recoloring purposes.
 *   lens  – glass / see-through (glasses lenses, helmet visors): never recolor
 *   decal – printed overlays (logos, badges, tattoo decals): the "design", never recolor
 *   hair  – hair cards
 *   cloth – everything else
 */
function shaderRole(name) {
  if (!name) return 'unknown';
  if (name.includes('glass') || name === 'ped_alpha' || name.endsWith('_alpha') && !name.includes('hair') || name.includes('mirror') || name.includes('reflect')) return 'lens';
  if (name.includes('decal')) return 'decal';
  if (name.includes('hair') || name === 'ped_fur') return 'hair';
  if (name.includes('emissive')) return 'emissive';
  return 'cloth';
}

const COMPONENT_SIZE = [0, 4, 4, 8, 0, 8, 12, 16, 4, 4, 4, 0, 0, 0, 0, 0];
const SEM_TEXCOORD0 = 6;

function halfToFloat(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function readShaderGroup(res, sgPtr) {
  const out = { shaders: [], embeddedTextures: [] };
  if (!sgPtr) return out;
  const texDictPtr = res.ptr(sgPtr + 0x08);
  const shadersPtr = res.ptr(sgPtr + 0x10);
  const count = res.u16(sgPtr + 0x18);
  if (texDictPtr) {
    try { out.embeddedTextures = readTextureDictionary(res, texDictPtr); } catch (e) { out.embeddedTexturesError = e.message; }
  }
  for (let i = 0; i < count; i++) {
    const sp = res.ptr(shadersPtr + i * 8);
    if (!sp) { out.shaders.push(null); continue; }
    const paramsPtr = res.ptr(sp + 0x00);
    const nameHash = res.u32(sp + 0x08);
    const paramCount = res.u8(sp + 0x10);
    const fileHash = res.u32(sp + 0x18);
    const name = SHADER_BY_HASH.get(nameHash) || SHADER_BY_HASH.get(fileHash) || null;
    const params = [];
    if (paramsPtr && paramCount) {
      let dataBytes = 0;
      const heads = [];
      for (let p = 0; p < paramCount; p++) {
        const h = paramsPtr + p * 16;
        const type = res.u8(h);
        const dptr = res.ptr(h + 8);
        heads.push({ type, dptr });
        if (type !== 0) dataBytes += 16 * type;
      }
      const hashBase = paramsPtr + paramCount * 16 + dataBytes;
      for (let p = 0; p < paramCount; p++) {
        const hash = res.u32(hashBase + p * 4);
        const { type, dptr } = heads[p];
        const param = { hash, name: PARAM_NAME[hash] || null, type };
        if (type === 0 && dptr) param.texture = readTextureRef(res, dptr).name;
        params.push(param);
      }
    }
    const tex = (n) => { const p = params.find((q) => q.hash === PARAM[n]); return p ? p.texture || null : null; };
    out.shaders.push({
      index: i, nameHash, fileHash, name, role: shaderRole(name), params,
      diffuse: tex('DiffuseSampler'), bump: tex('BumpSampler'), spec: tex('SpecSampler'),
    });
  }
  return out;
}

function readGeometryUVs(res, gptr) {
  const vbPtr = res.ptr(gptr + 0x18);
  const ibPtr = res.ptr(gptr + 0x38);
  if (!vbPtr || !ibPtr) return null;
  const stride = res.u16(vbPtr + 0x08);
  // Some exporters leave DataPointer1 empty and only fill DataPointer2 / the geometry's own pointer.
  const vdata = res.ptr(vbPtr + 0x10) || res.ptr(vbPtr + 0x20) || res.ptr(gptr + 0x78);
  const vcount = res.u32(vbPtr + 0x18);
  const info = res.ptr(vbPtr + 0x30);
  const icount = res.u32(ibPtr + 0x08);
  const iptr = res.ptr(ibPtr + 0x10);
  if (!info || !vdata || !iptr || !stride || !vcount) return null;
  const flags = res.u32(info);
  const tlo = res.u32(info + 8), thi = res.u32(info + 12);
  const typeOf = (k) => (k < 8 ? (tlo >>> (4 * k)) : (thi >>> (4 * (k - 8)))) & 0xf;
  if (!((flags >>> SEM_TEXCOORD0) & 1)) return null;
  let off = 0;
  for (let k = 0; k < SEM_TEXCOORD0; k++) if ((flags >>> k) & 1) off += COMPONENT_SIZE[typeOf(k)];
  const uvType = typeOf(SEM_TEXCOORD0);
  // positions (semantic 0) for mesh-level reasoning (lens detection, previews)
  const posType = (flags & 1) ? typeOf(0) : 0;
  const vbytes = res.bytes(vdata, stride * vcount);
  const ibytes = res.bytes(iptr, icount * 2);
  if (!vbytes || !ibytes) return null;
  const dv = new DataView(vbytes.buffer, vbytes.byteOffset, vbytes.byteLength);
  const uv = new Float32Array(vcount * 2);
  for (let v = 0; v < vcount; v++) {
    const o = v * stride + off;
    if (uvType === 1) { uv[v * 2] = halfToFloat(dv.getUint16(o, true)); uv[v * 2 + 1] = halfToFloat(dv.getUint16(o + 2, true)); }
    else if (uvType === 5) { uv[v * 2] = dv.getFloat32(o, true); uv[v * 2 + 1] = dv.getFloat32(o + 4, true); }
    else return null;
  }
  let pos = null;
  if (posType === 6) { // Float3
    pos = new Float32Array(vcount * 3);
    for (let v = 0; v < vcount; v++) { const o = v * stride; pos[v * 3] = dv.getFloat32(o, true); pos[v * 3 + 1] = dv.getFloat32(o + 4, true); pos[v * 3 + 2] = dv.getFloat32(o + 8, true); }
  }
  const idv = new DataView(ibytes.buffer, ibytes.byteOffset, ibytes.byteLength);
  const indices = new Uint16Array(icount);
  for (let k = 0; k < icount; k++) indices[k] = idv.getUint16(k * 2, true);
  const tris = new Float32Array(Math.floor(icount / 3) * 6);
  for (let t = 0, k = 0; t + 2 < icount; t += 3) {
    for (let j = 0; j < 3; j++) {
      const vi = idv.getUint16((t + j) * 2, true);
      tris[k++] = vi < vcount ? uv[vi * 2] : NaN;
      tris[k++] = vi < vcount ? uv[vi * 2 + 1] : NaN;
    }
  }
  return { tris, uv, pos, indices, vertexCount: vcount, triangleCount: Math.floor(icount / 3) };
}

function readModels(res, listHeaderPtr) {
  if (!listHeaderPtr) return [];
  const arr = res.ptr(listHeaderPtr);
  const count = res.u16(listHeaderPtr + 8);
  const models = [];
  for (let m = 0; m < count; m++) {
    const mp = res.ptr(arr + m * 8);
    if (!mp) continue;
    const geomsPtr = res.ptr(mp + 0x08);
    const gcount = res.u16(mp + 0x10);
    const mapPtr = res.ptr(mp + 0x20);
    const geometries = [];
    for (let g = 0; g < gcount; g++) {
      const gp = res.ptr(geomsPtr + g * 8);
      if (!gp) continue;
      const shaderIndex = mapPtr ? res.u16(mapPtr + g * 2) : 0;
      let uv = null;
      try { uv = readGeometryUVs(res, gp); } catch (_) { uv = null; }
      geometries.push({ index: g, shaderIndex, uv });
    }
    models.push({ index: m, geometries });
  }
  return models;
}

function readDrawable(res, ptr) {
  const sg = readShaderGroup(res, res.ptr(ptr + 0x10));
  const high = readModels(res, res.ptr(ptr + 0x50));
  const geometries = [];
  for (const m of high) for (const g of m.geometries) {
    const shader = sg.shaders[g.shaderIndex] || null;
    geometries.push({ model: m.index, index: g.index, shaderIndex: g.shaderIndex, shader, uv: g.uv });
  }
  return { ptr, shaders: sg.shaders, embeddedTextures: sg.embeddedTextures, geometries };
}

/** .ydd (DrawableDictionary root) */
function readYdd(res) {
  const root = 0x50000000;
  const hashesPtr = res.ptr(root + 0x20);
  const hcount = res.u16(root + 0x28);
  const listPtr = res.ptr(root + 0x30);
  const count = res.u16(root + 0x38);
  const drawables = [];
  for (let i = 0; i < count; i++) {
    const dp = res.ptr(listPtr + i * 8);
    if (!dp) continue;
    const d = readDrawable(res, dp);
    d.nameHash = i < hcount ? res.u32(hashesPtr + i * 4) : 0;
    drawables.push(d);
  }
  return drawables;
}

/** .ydr (Drawable root) */
function readYdr(res) { return [readDrawable(res, 0x50000000)]; }

module.exports = { PARAM, SHADER_BY_HASH, shaderRole, readYdd, readYdr, readDrawable, halfToFloat };
