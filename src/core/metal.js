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

/**
 * Zipper teeth / chains / small bright hardware INSIDE fabric panels (not separate UV islands):
 * bright + colourless + strongly textured with edges in every direction (low structure-tensor
 * coherence). Printed stripes and skeleton ribs have one edge direction (coherence ~0.99),
 * flat white print interiors have no texture, and dark leather tabs are not bright.
 */
function metalFromTexture(planes, w, h, baseL, { minL = 0.45, overBase = 0.25, maxChroma = 0.035, minStd = 0.07, maxCoherence = 0.75, maxThickFrac = 0.02, minElong = 8, minDensity = 0.62, ignore = null } = {}) {
  const n = w * h;
  const { L, A, B } = planes;
  const r = Math.max(2, Math.round(Math.max(w, h) / 512));
  const std = require('./padding').localStd(L, w, h, r);
  const gx = new Float32Array(n), gy = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; gx[i] = L[i + 1] - L[i - 1]; gy[i] = L[i + w] - L[i - w]; }
  const xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
  for (let i = 0; i < n; i++) { xx[i] = gx[i] * gx[i]; yy[i] = gy[i] * gy[i]; xy[i] = gx[i] * gy[i]; }
  const R = r * 2;
  const bxx = M.boxBlur(xx, w, h, R), byy = M.boxBlur(yy, w, h, R), bxy = M.boxBlur(xy, w, h, R);
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (ignore && ignore[i]) continue;
    if (L[i] < minL || L[i] < baseL + overBase || Math.hypot(A[i], B[i]) > maxChroma || std[i] < minStd) continue;
    const tr = bxx[i] + byy[i]; if (tr < 1e-6) continue;
    const coh = Math.sqrt((bxx[i] - byy[i]) ** 2 + 4 * bxy[i] ** 2) / tr;
    if (coh > maxCoherence) continue;
    raw[i] = 1;
  }
  // teeth are separated by dark gaps: close them into one zipper band, drop specks
  let m = M.close(raw, w, h, r * 2);
  m = M.removeSmall(m, w, h, Math.max(24, Math.round(n * 0.00004)));
  // per region: silver is mid/light GREY with highlights (printed white is flat pure white:
  // skeleton ribs, text), and zipper teeth / chains are thin BANDS (a noisy cloud print is a blob)
  const { labels, sizes, count } = M.label(m, w, h, 1);
  const white = new Float64Array(count), grey = new Float64Array(count), perim = new Float64Array(count);
  const rawc = new Float64Array(count); const x0 = new Int32Array(count).fill(w), x1 = new Int32Array(count), y0 = new Int32Array(count).fill(h), y1 = new Int32Array(count);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, l = labels[i]; if (l < 0) continue;
    rawc[l] += raw[i]; if (x < x0[l]) x0[l] = x; if (x > x1[l]) x1[l] = x; if (y < y0[l]) y0[l] = y; if (y > y1[l]) y1[l] = y;
    if (L[i] > 0.95) white[l]++; else if (L[i] >= 0.4 && L[i] <= 0.93) grey[l]++;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || labels[i - 1] !== l || labels[i + 1] !== l || labels[i - w] !== l || labels[i + w] !== l) perim[l]++;
  }
  const maxThick = Math.max(10, Math.max(w, h) * maxThickFrac);
  const keep = new Uint8Array(count);
  for (let l = 0; l < count; l++) {
    const thick = (2 * sizes[l]) / Math.max(1, perim[l]);
    // a zipper runs along a seam: long and thin (a curved pocket zip still spans far more than its width)
    const span = Math.max(x1[l] - x0[l], y1[l] - y0[l]) + 1;
    keep[l] = white[l] / sizes[l] < 0.3 && grey[l] / sizes[l] >= 0.4 && thick <= maxThick && span >= minElong * thick
      // most of a real zipper passes the per-texel test on its own; a grey print only in patches
      && rawc[l] / sizes[l] >= minDensity ? 1 : 0;
  }
  for (let i = 0; i < n; i++) if (m[i] && !keep[labels[i]]) m[i] = 0;
  const f = M.boxBlur(M.toFloat(m), w, h, 1);
  const coverage = M.coverage(f);
  return coverage > 0 ? { mask: f, coverage } : null;
}

module.exports.metalFromTexture = metalFromTexture;

/**
 * From the MODEL: buckles, clasps, rings and zipper pulls are modelled as their own small
 * mesh pieces (welded connected components). A piece is metal when it is small, colourless and
 * clearly lighter than the garment (grey/silver chrome). A dark leather tab is also its own small
 * piece but is not light, so it is dyed with the rest - UV-island statistics alone can't tell
 * them apart when they share one island column in the texture.
 *
 * @param {Array<{island:Uint8Array, area:number}>} islands  from lensMesh.meshIslands
 */
function metalFromMesh(islands, planes, w, h, baseL, { maxArea = 0.03, minL = 0.45, overBase = 0.25, maxChroma = 0.04, minTexels = 30 } = {}) {
  if (!islands || !islands.length) return null;
  const n = w * h;
  const { L, A, B } = planes;
  const m = new Uint8Array(n);
  let found = 0;
  for (const is of islands) {
    if (is.area > n * maxArea || is.area < minTexels) continue;
    const v = [];
    let c = 0;
    for (let i = 0; i < n; i++) if (is.island[i]) { v.push(L[i]); c += Math.hypot(A[i], B[i]); }
    if (v.length < minTexels || c / v.length > maxChroma) continue;
    v.sort((x, y) => x - y);
    const med = v[v.length >> 1];
    if (med < Math.max(minL, baseL + overBase)) continue;
    for (let i = 0; i < n; i++) if (is.island[i]) m[i] = 1;
    found++;
  }
  if (!found) return null;
  const f = M.boxBlur(M.toFloat(M.dilate(m, w, h, 1)), w, h, 1);
  return { mask: f, coverage: M.coverage(f), pieces: found };
}

module.exports.metalFromMesh = metalFromMesh;
