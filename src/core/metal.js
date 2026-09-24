'use strict';
/**
 * Metal hardware detection (zippers, pulls, buckles, rivets, watch cases, chains).
 *
 * Chrome in a baked diffuse is: near-black next to bright highlights, with edges
 * running in every direction. Mapping its dark base onto a light target squeezes
 * the highlights into the remaining headroom and it turns into a washed-out blob,
 * so hardware is kept as-is (a dyed garment keeps its metal zipper).
 *
 * Found structurally from UV islands (see metalFromIslands) or, when the drawable
 * ships a real spec map, from its bright (shiny) areas.
 */
const M = require('./masks');

/**
 * Pixel statistics alone mistake prints/text for chrome (both are hard black/white),
 * so hardware is found STRUCTURALLY: zipper pulls, stoppers, buttons, buckles are laid
 * out as many small separate UV islands, while prints live inside the big panels.
 * An island is metal when it is small, neutral, and spans a very wide tonal range with
 * bright highlights AND plenty of mid-tones (specular shading, not a flat print or fabric).
 *
 * @param {Uint8Array} padding  1 = empty UV space (from padding.js / model UVs)
 * @returns {{mask:Float32Array, coverage:number, islands:number}|null}
 */
function metalFromIslands(planes, w, h, padding, { maxIsland = 0.08, minIsland = 0.00015, brightP = 0.6, spreadMin = 0.45, brightMin = 0.12, midMin = 0.3, chromaMax = 0.04 } = {}) {
  if (!padding) return null;
  const n = w * h;
  const { L, A, B } = planes;
  // Panels usually touch through dark outlines / AA halos, so for SEGMENTATION treat
  // anything within a small lightness margin of the padding colour as a gap, then
  // erode to split pieces that only touch at a pixel or two.
  let padL = 0, pc = 0;
  for (let i = 0; i < n; i++) if (padding[i]) { padL += L[i]; pc++; }
  padL = pc ? padL / pc : 0;
  let content = new Uint8Array(n);
  for (let i = 0; i < n; i++) content[i] = !padding[i] && L[i] > padL + 0.06 ? 1 : 0;
  content = M.erode(content, w, h, 1);
  const { labels, sizes, count } = M.label(content, w, h, 1);
  // Per island, its OWN texels: chrome pieces span a very wide tonal range (grey body up
  // to near-white speculars, measured p10 0.29 / p90 0.85 on a real zipper set) with lots
  // of mid-tones; fabric pieces are narrow (white panel 0.6-0.9, grey sock 0.3-0.6).
  const vals = Array.from({ length: count }, () => []);
  const csum = new Float64Array(count);
  for (let i = 0; i < n; i++) {
    const l = labels[i]; if (l < 0) continue;
    if (sizes[l] < n * minIsland || sizes[l] > n * maxIsland) continue;
    if (vals[l].length < 40000) vals[l].push(L[i]);
    csum[l] += Math.hypot(A[i], B[i]);
  }
  const isMetal = new Uint8Array(count);
  let found = 0;
  for (let l = 0; l < count; l++) {
    const v = vals[l]; if (v.length < 30) continue;
    v.sort((x, y) => x - y);
    const p10 = v[Math.floor(v.length * 0.1)], p90 = v[Math.floor(v.length * 0.9)];
    let bright = 0, mid = 0;
    for (const x of v) { if (x > brightP) bright++; else if (x > 0.15 && x < 0.55) mid++; }
    if (p90 - p10 >= spreadMin && bright / v.length >= brightMin && mid / v.length >= midMin && csum[l] / sizes[l] < chromaMax) { isMetal[l] = 1; found++; }
  }
  if (!found) return null;
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (labels[i] >= 0 && isMetal[labels[i]]) m[i] = 1;
  const f = M.boxBlur(M.toFloat(M.dilate(m, w, h, 2)), w, h, 1);
  return { mask: f, coverage: M.coverage(f), islands: found };
}

/** From the drawable's spec map (resized to the diffuse): bright spec = shiny/metal. */
function metalFromSpecMap(specRgba, sw, sh, w, h, { threshold = 0.62 } = {}) {
  const s = new Float32Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) s[i] = specRgba[i * 4] / 255; // R = specular intensity
  const up = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) up[y * w + x] = s[Math.min(sh - 1, Math.floor(y * sh / h)) * sw + Math.min(sw - 1, Math.floor(x * sw / w))];
  let m = M.threshold(up, threshold);
  m = M.removeSmall(M.open(m, w, h, 1), w, h, Math.max(40, Math.round(w * h * 0.0004)));
  const f = M.boxBlur(M.toFloat(M.dilate(m, w, h, 1)), w, h, 1);
  const coverage = M.coverage(f);
  // a garment that is shiny all over (latex, patent leather) is fabric, not hardware
  return coverage > 0 && coverage < 0.35 ? { mask: f, coverage } : null;
}

module.exports = { metalFromIslands, metalFromSpecMap };
