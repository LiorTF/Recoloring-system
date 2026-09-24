'use strict';
/**
 * sRGB <-> OKLab (Björn Ottosson, 2020). OKLab is perceptually uniform enough
 * that "same lightness delta" looks like "same amount of detail" on dark and
 * light fabrics, which is exactly what we need to move a black hoodie to a
 * light beige without flattening the folds or blowing out the highlights.
 */

const SRGB_TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

const LIN_LUT_SIZE = 4096;
const LIN_TO_SRGB8 = new Uint8Array(LIN_LUT_SIZE + 1);
for (let i = 0; i <= LIN_LUT_SIZE; i++) {
  const l = i / LIN_LUT_SIZE;
  const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  LIN_TO_SRGB8[i] = Math.max(0, Math.min(255, Math.round(c * 255)));
}

function linToSrgb8(l) {
  if (l <= 0) return 0;
  if (l >= 1) return 255;
  // LUT is coarse near black; use exact formula there.
  if (l < 0.01) {
    const c = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
    return Math.round(c * 255);
  }
  return LIN_TO_SRGB8[(l * LIN_LUT_SIZE + 0.5) | 0];
}

/** linear RGB -> OKLab; writes into out[o..o+2] */
function linToOklab(r, g, b, out, o) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[o] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[o + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[o + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

/** OKLab -> linear RGB; writes into out[o..o+2] (may be out of gamut) */
function oklabToLin(L, a, b, out, o) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  out[o] = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  out[o + 1] = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  out[o + 2] = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
}

const _t = new Float64Array(3);

/**
 * OKLab -> sRGB8 with gamut mapping by chroma reduction (keeps L and hue,
 * which is what preserves the look of the shading).
 */
function oklabToSrgb8(L, a, b, out, o) {
  oklabToLin(L, a, b, _t, 0);
  if (_t[0] < -1e-4 || _t[0] > 1.0001 || _t[1] < -1e-4 || _t[1] > 1.0001 || _t[2] < -1e-4 || _t[2] > 1.0001) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const k = (lo + hi) / 2;
      oklabToLin(L, a * k, b * k, _t, 0);
      const ok = _t[0] >= 0 && _t[0] <= 1 && _t[1] >= 0 && _t[1] <= 1 && _t[2] >= 0 && _t[2] <= 1;
      if (ok) lo = k; else hi = k;
    }
    oklabToLin(L, a * lo, b * lo, _t, 0);
  }
  out[o] = linToSrgb8(_t[0]);
  out[o + 1] = linToSrgb8(_t[1]);
  out[o + 2] = linToSrgb8(_t[2]);
}

function parseHex(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) throw new Error(`Invalid colour "${hex}", expected #rrggbb`);
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function srgb8ToOklab(r, g, b) {
  const o = [0, 0, 0];
  linToOklab(SRGB_TO_LIN[r], SRGB_TO_LIN[g], SRGB_TO_LIN[b], o, 0);
  return o;
}

/** Convert an RGBA8 buffer into planar OKLab Float32Arrays. */
function rgbaToOklabPlanes(rgba, n) {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const t = [0, 0, 0];
  // cache: textures have lots of repeated colours after DXT
  const cache = new Map();
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let v = cache.get(key);
    if (v === undefined) {
      linToOklab(SRGB_TO_LIN[r], SRGB_TO_LIN[g], SRGB_TO_LIN[b], t, 0);
      v = [t[0], t[1], t[2]];
      if (cache.size < 200000) cache.set(key, v);
    }
    L[i] = v[0]; A[i] = v[1]; B[i] = v[2];
  }
  return { L, A, B };
}

module.exports = { SRGB_TO_LIN, linToSrgb8, linToOklab, oklabToLin, oklabToSrgb8, parseHex, srgb8ToOklab, rgbaToOklabPlanes };
