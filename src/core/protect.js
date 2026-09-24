'use strict';
/**
 * Builds the "never recolor" mask for one texture from every signal we have:
 * skin (race diff / ped model / generic), tattoos (holes in skin), lenses &
 * visors (alpha + lens-shader UVs), decals (decal-shader UVs), hair cards,
 * and user-supplied rectangles.
 */
const M = require('./masks');
const skin = require('../color/skin');
const { rgbaToOklabPlanes } = require('../color/oklab');

/** Large semi-transparent regions = tinted lenses / visors. */
function alphaLensMask(rgba, w, h, { minAlpha = 6, maxAlpha = 250, minAreaFrac = 0.002 } = {}) {
  const n = w * h;
  const m = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) { const a = rgba[i * 4 + 3]; if (a >= minAlpha && a <= maxAlpha) { m[i] = 1; any = true; } }
  if (!any) return null;
  let k = M.open(m, w, h, 1);
  k = M.removeSmall(k, w, h, Math.max(64, Math.round(n * minAreaFrac)));
  k = M.close(k, w, h, 2);
  k = M.dilate(k, w, h, 1);
  const f = M.boxBlur(M.toFloat(k), w, h, 1);
  return M.coverage(f) > 0 ? f : null;
}

/**
 * Rasterise drawable geometry UVs per shader role for this texture.
 * @param {Array<{role:string, diffuseStem:string|null, tris:Float32Array}>} geoms
 */
function uvRoleMasks(geoms, texStem, w, h) {
  if (!geoms || !geoms.length) return null;
  const roles = {};
  for (const g of geoms) {
    if (!g.tris) continue;
    if (g.diffuseStem && texStem && g.diffuseStem !== texStem) continue;
    const r = g.role === 'unknown' ? 'cloth' : g.role;
    roles[r] = M.rasterizeUVTriangles(g.tris, w, h, roles[r] || new Uint8Array(w * h));
  }
  const out = {};
  const cloth = roles.cloth || roles.emissive || null;
  for (const r of ['lens', 'decal', 'hair']) {
    if (!roles[r]) continue;
    let m = roles[r];
    let own = m;
    if (cloth) {
      own = new Uint8Array(w * h);
      let a = 0, b = 0;
      for (let i = 0; i < w * h; i++) { if (m[i]) { a++; if (!cloth[i]) { own[i] = 1; b++; } } }
      if (b < a * 0.3) own = m; // mostly shared texels -> keep the full lens area
    }
    out[r] = M.dilate(own, w, h, 2);
  }
  out.used = new Uint8Array(w * h);
  for (const r of Object.keys(roles)) { const m = roles[r]; for (let i = 0; i < w * h; i++) if (m[i]) out.used[i] = 1; }
  // Whole prop drawn with an alpha shader (cut-out straps etc.) -> UV lens info is useless
  if (out.lens) {
    const lensCov = M.coverage(out.lens), usedCov = M.coverage(out.used);
    if (usedCov > 0 && lensCov > usedCov * 0.7) { out.lensWholeDrawable = true; delete out.lens; }
  }
  return out;
}

function rectMask(rects, w, h) {
  const m = new Float32Array(w * h);
  for (const r of rects || []) {
    // rects in UV space 0..1: {x,y,w,h}
    const x0 = Math.max(0, Math.floor(r.x * w)), y0 = Math.max(0, Math.floor(r.y * h));
    const x1 = Math.min(w, Math.ceil((r.x + r.w) * w)), y1 = Math.min(h, Math.ceil((r.y + r.h) * h));
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  }
  return m;
}

/**
 * @param {object} p
 * @param {Uint8Array} p.rgba            mip0 pixels of this texture
 * @param {number} p.width
 * @param {number} p.height
 * @param {'normal'|'strict'|'off'} p.skinMode
 * @param {object|null} p.skinModel      from skin.buildSkinModel
 * @param {Float32Array|null} p.raceSkin race-diff mask (shared by variants)
 * @param {boolean} p.lensMode           look for lenses/visors
 * @param {object|null} p.uv             from uvRoleMasks
 * @param {boolean} p.protectHair
 * @param {Array} p.protectRects
 */
function buildProtectMask(p) {
  const { rgba, width: w, height: h } = p;
  const n = w * h;
  const parts = {};
  const protect = new Float32Array(n);
  const planes = p.planes || rgbaToOklabPlanes(rgba, n);

  if (p.skinMode && p.skinMode !== 'off') {
    if (p.raceSkin) {
      parts.skin = p.raceSkin;
      parts.skinSource = 'race-diff';
    } else {
      const strict = p.skinMode === 'strict';
      const score = skin.skinScoreMap(rgba, planes, n, p.skinModel, { strict });
      let mask = skin.cleanSkinMask(score, w, h, { strict });
      parts.skinSource = p.skinModel ? 'ped-model' : 'generic';
      // Without this ped's own skin model, a "skin" region covering most of the visible
      // garment is almost always a skin-coloured fabric (tan / camel / leather), not skin.
      if (!p.skinModel) {
        let vis = 0, cov = 0;
        for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] >= 16) { vis++; cov += mask[i]; }
        const limit = strict ? 0.25 : 0.55;
        if (vis && cov / vis > limit) { mask = new Float32Array(n); parts.skinSource = `generic (rejected: ${(100 * cov / vis).toFixed(0)}% of garment looked skin-coloured)`; }
      }
      parts.skin = mask;
    }
    M.maxInto(protect, parts.skin);
  }

  if (p.lensMode) {
    const a = alphaLensMask(rgba, w, h);
    if (a) { parts.lensAlpha = a; M.maxInto(protect, a); }
  }
  if (p.uv) {
    if (p.uv.lens) { parts.lensUV = M.boxBlur(M.toFloat(p.uv.lens), w, h, 1); M.maxInto(protect, parts.lensUV); }
    if (p.uv.decal) { parts.decalUV = M.boxBlur(M.toFloat(p.uv.decal), w, h, 1); M.maxInto(protect, parts.decalUV); }
    if (p.uv.hair && p.protectHair) { parts.hairUV = M.toFloat(p.uv.hair); M.maxInto(protect, parts.hairUV); }
  }
  if (p.protectRects && p.protectRects.length) { parts.user = rectMask(p.protectRects, w, h); M.maxInto(protect, parts.user); }

  const coverage = {};
  for (const [k, v] of Object.entries(parts)) if (v instanceof Float32Array) coverage[k] = +M.coverage(v).toFixed(4);
  coverage.total = +M.coverage(protect).toFixed(4);
  return { protect, parts, coverage, planes };
}

module.exports = { alphaLensMask, uvRoleMasks, buildProtectMask, rectMask };
