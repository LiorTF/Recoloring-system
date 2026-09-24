'use strict';
/**
 * UV padding detection.
 *
 * Clothing textures usually have large empty areas between UV islands, often flat
 * black. Those texels are never seen in game, but if they are counted as "fabric"
 * they become the dominant material and the real garment gets mapped next to it
 * (a dark grey shirt ends up lighter than the target, prints blow out).
 *
 * Best source: the model. Texels not covered by any geometry's UVs = padding.
 * Fallback (image only): a perfectly flat, border-connected fill, accepted only when
 * the REST of the texture looks like shaded cloth. If the rest is flat graphics too
 * (a black tee with a flat white print), the flat fill is the garment itself.
 */
const M = require('./masks');

function localStd(L, w, h, r = 2) {
  const n = w * h;
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = L[i] * L[i];
  const m = M.boxBlur(L, w, h, r), m2 = M.boxBlur(sq, w, h, r);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = Math.sqrt(Math.max(0, m2[i] - m[i] * m[i]));
  return s;
}

function median(values) {
  if (!values.length) return 0;
  const a = Float32Array.from(values).sort();
  return a[a.length >> 1];
}

/** From the model: texels outside every UV island (dilated a little for bleed). */
function paddingFromUV(used, w, h) {
  if (!used) return null;
  let cov = 0; for (let i = 0; i < used.length; i++) cov += used[i];
  if (cov < used.length * 0.05) return null; // UVs clearly don't match this texture
  const grown = M.dilate(used, w, h, 3);
  const pad = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) pad[i] = grown[i] ? 0 : 1;
  return { mask: pad, source: 'model-uv' };
}

/**
 * @param {Uint8Array} rgba
 * @param {{L:Float32Array,A:Float32Array,B:Float32Array}} planes
 * @returns {{mask:Uint8Array, source:string, stats:object}|null}
 */
function paddingFromImage(rgba, planes, w, h, { tol = 0.02, minCoverage = 0.12, flatStd = 0.004, clothStd = 0.003 } = {}) {
  const n = w * h;
  const { L, A, B } = planes;
  // dominant border colour
  const counts = new Map();
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const key = (i) => `${Math.round(L[i] * 60)}|${Math.round(A[i] * 60)}|${Math.round(B[i] * 60)}|${rgba[i * 4 + 3] > 127 ? 1 : 0}`;
  for (const i of border) counts.set(key(i), (counts.get(key(i)) || 0) + 1);
  let bestKey = null, best = 0;
  for (const [k, c] of counts) if (c > best) { best = c; bestKey = k; }
  if (best < border.length * 0.4) return null;
  let rL = 0, rA = 0, rB = 0, rc = 0;
  for (const i of border) if (key(i) === bestKey) { rL += L[i]; rA += A[i]; rB += B[i]; rc++; }
  rL /= rc; rA /= rc; rB /= rc;

  // flood fill from the border through texels matching that colour
  const near = (i) => Math.hypot(L[i] - rL, A[i] - rA, B[i] - rB) < tol;
  const mask = new Uint8Array(n);
  const stack = [];
  for (const i of border) if (!mask[i] && near(i)) { mask[i] = 1; stack.push(i); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
    for (const q of nb) if (q >= 0 && !mask[q] && near(q)) { mask[q] = 1; stack.push(q); }
  }
  let cov = 0; for (let i = 0; i < n; i++) cov += mask[i];
  const stats = { coverage: cov / n };
  if (cov < n * minCoverage) return null;

  // flatness test on a subsample
  const std = localStd(L, w, h, 2);
  const inPad = [], rest = [];
  const inner = M.erode(mask, w, h, 3), outer = M.dilate(mask, w, h, 3);
  const step = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += step) {
    if (inner[i]) inPad.push(std[i]);
    else if (!outer[i] && rgba[i * 4 + 3] >= 16) rest.push(std[i]);
  }
  stats.padStd = median(inPad);
  stats.restStd = median(rest);
  if (stats.padStd > flatStd) return null;          // not a flat fill -> real fabric
  if (stats.restStd < clothStd) return null;        // rest is flat graphics -> the fill IS the garment
  return { mask, source: 'flat-border-fill', stats };
}

module.exports = { paddingFromUV, paddingFromImage, localStd };
