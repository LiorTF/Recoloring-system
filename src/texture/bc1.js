'use strict';
/**
 * BC1 (DXT1) / BC2 (DXT3) / BC3 (DXT5) block codecs.
 *
 * Decoders follow the D3D10 spec. The colour encoder is a PCA endpoint fit
 * followed by least-squares refinement in 565 space (quality close to
 * squish "range fit + LS"), which matters because every recolored texture is
 * re-compressed once and we do not want visible block noise.
 *
 * Alpha blocks (DXT3 / DXT5) are NOT re-encoded: recoloring never changes
 * alpha, so the original 8 alpha bytes are copied verbatim (bit exact).
 */

// ---------- decoding ----------

function expand565(c, out, o) {
  const r = (c >> 11) & 31, g = (c >> 5) & 63, b = c & 31;
  out[o] = (r << 3) | (r >> 2);
  out[o + 1] = (g << 2) | (g >> 4);
  out[o + 2] = (b << 3) | (b >> 2);
}

const _pal = new Uint8Array(16);

/**
 * Decode an 8 byte BC1 colour block into 16 RGBA pixels (row major, 64 bytes).
 * @param {boolean} force4 BC2/BC3 colour blocks always use 4-colour mode.
 */
function decodeColorBlock(src, so, out, force4) {
  const c0 = src[so] | (src[so + 1] << 8);
  const c1 = src[so + 2] | (src[so + 3] << 8);
  expand565(c0, _pal, 0); _pal[3] = 255;
  expand565(c1, _pal, 4); _pal[7] = 255;
  if (force4 || c0 > c1) {
    for (let k = 0; k < 3; k++) {
      _pal[8 + k] = ((2 * _pal[k] + _pal[4 + k]) / 3) | 0;
      _pal[12 + k] = ((_pal[k] + 2 * _pal[4 + k]) / 3) | 0;
    }
    _pal[11] = 255; _pal[15] = 255;
  } else {
    for (let k = 0; k < 3; k++) {
      _pal[8 + k] = ((_pal[k] + _pal[4 + k]) / 2) | 0;
      _pal[12 + k] = 0;
    }
    _pal[11] = 255; _pal[15] = 0;
  }
  const idx = (src[so + 4] | (src[so + 5] << 8) | (src[so + 6] << 16) | (src[so + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++) {
    const p = ((idx >>> (2 * i)) & 3) * 4;
    const o = i * 4;
    out[o] = _pal[p]; out[o + 1] = _pal[p + 1]; out[o + 2] = _pal[p + 2]; out[o + 3] = _pal[p + 3];
  }
}

/** BC4-style interpolated alpha (DXT5 alpha half). Writes into out[i*4+3]. */
function decodeAlphaBC3(src, so, out) {
  const a0 = src[so], a1 = src[so + 1];
  const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) {
    for (let i = 1; i <= 6; i++) pal[1 + i] = (((7 - i) * a0 + i * a1) / 7) | 0;
  } else {
    for (let i = 1; i <= 4; i++) pal[1 + i] = (((5 - i) * a0 + i * a1) / 5) | 0;
    pal[6] = 0; pal[7] = 255;
  }
  // 48 bits of 3-bit indices
  let lo = (src[so + 2] | (src[so + 3] << 8) | (src[so + 4] << 16)) >>> 0;
  let hi = (src[so + 5] | (src[so + 6] << 8) | (src[so + 7] << 16)) >>> 0;
  for (let i = 0; i < 8; i++) { out[i * 4 + 3] = pal[(lo >>> (3 * i)) & 7]; }
  for (let i = 0; i < 8; i++) { out[(8 + i) * 4 + 3] = pal[(hi >>> (3 * i)) & 7]; }
}

function decodeAlphaBC2(src, so, out) {
  for (let i = 0; i < 8; i++) {
    const byte = src[so + i];
    out[(i * 2) * 4 + 3] = (byte & 15) * 17;
    out[(i * 2 + 1) * 4 + 3] = (byte >> 4) * 17;
  }
}

// ---------- encoding ----------

function to565(r, g, b) {
  const R = Math.max(0, Math.min(31, Math.round(r * 31 / 255)));
  const G = Math.max(0, Math.min(63, Math.round(g * 63 / 255)));
  const B = Math.max(0, Math.min(31, Math.round(b * 31 / 255)));
  return (R << 11) | (G << 5) | B;
}

const _e0 = new Uint8Array(4), _e1 = new Uint8Array(4);
const _cand = new Uint8Array(16);
const _idx = new Uint8Array(16);
const _bestIdx = new Uint8Array(16);

/**
 * Build palette from two 565 colours; returns squared error and fills idxOut.
 * mode4: 4-colour mode; else 3-colour + transparent (index 3) for pixels with mask[i]=0.
 */
function evalEndpoints(px, opaque, c0, c1, mode4, idxOut) {
  expand565(c0, _e0, 0); expand565(c1, _e1, 0);
  const pr = _cand;
  pr[0] = _e0[0]; pr[1] = _e0[1]; pr[2] = _e0[2];
  pr[4] = _e1[0]; pr[5] = _e1[1]; pr[6] = _e1[2];
  let n;
  if (mode4) {
    for (let k = 0; k < 3; k++) {
      pr[8 + k] = ((2 * _e0[k] + _e1[k]) / 3) | 0;
      pr[12 + k] = ((_e0[k] + 2 * _e1[k]) / 3) | 0;
    }
    n = 4;
  } else {
    for (let k = 0; k < 3; k++) pr[8 + k] = ((_e0[k] + _e1[k]) / 2) | 0;
    n = 3;
  }
  let err = 0;
  for (let i = 0; i < 16; i++) {
    if (!opaque[i]) { idxOut[i] = 3; continue; }
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    let best = 0, bestD = Infinity;
    for (let j = 0; j < n; j++) {
      const dr = r - pr[j * 4], dg = g - pr[j * 4 + 1], db = b - pr[j * 4 + 2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) { bestD = d; best = j; }
    }
    idxOut[i] = best; err += bestD;
  }
  return err;
}

const W4 = [[1, 0], [0, 1], [2 / 3, 1 / 3], [1 / 3, 2 / 3]];
const W3 = [[1, 0], [0, 1], [0.5, 0.5]];

/** Least squares endpoints given index assignment. Returns [r0,g0,b0,r1,g1,b1] or null. */
function lsqEndpoints(px, opaque, idx, W) {
  let aa = 0, bb = 0, ab = 0;
  const ax = [0, 0, 0], bx = [0, 0, 0];
  for (let i = 0; i < 16; i++) {
    if (!opaque[i]) continue;
    const w = W[idx[i]]; if (!w) continue;
    const a = w[0], b = w[1];
    aa += a * a; bb += b * b; ab += a * b;
    for (let k = 0; k < 3; k++) { ax[k] += a * px[i * 4 + k]; bx[k] += b * px[i * 4 + k]; }
  }
  const det = aa * bb - ab * ab;
  if (Math.abs(det) < 1e-8) return null;
  const inv = 1 / det;
  const e = new Array(6);
  for (let k = 0; k < 3; k++) {
    e[k] = (ax[k] * bb - bx[k] * ab) * inv;
    e[3 + k] = (bx[k] * aa - ax[k] * ab) * inv;
  }
  return e;
}

/**
 * Encode 16 RGBA pixels into an 8-byte BC1 colour block.
 * @param {Uint8Array} px 64 bytes RGBA
 * @param {Uint8Array} dst
 * @param {number} dofs
 * @param {'bc1'|'bc3'} kind  bc1 may use punch-through alpha, bc3 colour is always 4-colour
 */
function encodeColorBlock(px, dst, dofs, kind) {
  const opaque = new Uint8Array(16);
  let anyTransparent = false, nOpaque = 0;
  for (let i = 0; i < 16; i++) {
    const o = kind === 'bc1' ? px[i * 4 + 3] >= 128 : 1;
    opaque[i] = o ? 1 : 0;
    if (o) nOpaque++; else anyTransparent = true;
  }
  const mode4 = !anyTransparent;

  if (nOpaque === 0) {
    // fully transparent block: c0 <= c1, all indices 3
    dst[dofs] = 0; dst[dofs + 1] = 0; dst[dofs + 2] = 0; dst[dofs + 3] = 0;
    dst[dofs + 4] = 0xff; dst[dofs + 5] = 0xff; dst[dofs + 6] = 0xff; dst[dofs + 7] = 0xff;
    return;
  }

  // mean + covariance
  let mr = 0, mg = 0, mb = 0;
  for (let i = 0; i < 16; i++) if (opaque[i]) { mr += px[i * 4]; mg += px[i * 4 + 1]; mb += px[i * 4 + 2]; }
  mr /= nOpaque; mg /= nOpaque; mb /= nOpaque;
  let crr = 0, cgg = 0, cbb = 0, crg = 0, crb = 0, cgb = 0;
  for (let i = 0; i < 16; i++) {
    if (!opaque[i]) continue;
    const r = px[i * 4] - mr, g = px[i * 4 + 1] - mg, b = px[i * 4 + 2] - mb;
    crr += r * r; cgg += g * g; cbb += b * b; crg += r * g; crb += r * b; cgb += g * b;
  }
  // power iteration for principal axis
  let vr = 1, vg = 1, vb = 1;
  if (crr >= cgg && crr >= cbb) { vr = 1; vg = 0.5; vb = 0.5; } else if (cgg >= cbb) { vr = 0.5; vg = 1; vb = 0.5; } else { vr = 0.5; vg = 0.5; vb = 1; }
  for (let it = 0; it < 8; it++) {
    const nr = crr * vr + crg * vg + crb * vb;
    const ng = crg * vr + cgg * vg + cgb * vb;
    const nb = crb * vr + cgb * vg + cbb * vb;
    const m = Math.max(Math.abs(nr), Math.abs(ng), Math.abs(nb));
    if (m < 1e-9) break;
    vr = nr / m; vg = ng / m; vb = nb / m;
  }
  let minP = Infinity, maxP = -Infinity;
  for (let i = 0; i < 16; i++) {
    if (!opaque[i]) continue;
    const p = (px[i * 4] - mr) * vr + (px[i * 4 + 1] - mg) * vg + (px[i * 4 + 2] - mb) * vb;
    if (p < minP) minP = p; if (p > maxP) maxP = p;
  }
  const len2 = vr * vr + vg * vg + vb * vb || 1;
  let e = [
    mr + vr * maxP / len2, mg + vg * maxP / len2, mb + vb * maxP / len2,
    mr + vr * minP / len2, mg + vg * minP / len2, mb + vb * minP / len2,
  ];

  let bestErr = Infinity, bestC0 = 0, bestC1 = 0;
  const W = mode4 ? W4 : W3;
  const tryPair = (c0, c1) => {
    const err = evalEndpoints(px, opaque, c0, c1, mode4, _idx);
    if (err < bestErr) { bestErr = err; bestC0 = c0; bestC1 = c1; _bestIdx.set(_idx); }
    return err;
  };

  for (let iter = 0; iter < 3; iter++) {
    const c0 = to565(e[0], e[1], e[2]);
    const c1 = to565(e[3], e[4], e[5]);
    tryPair(c0, c1);
    if (bestErr === 0) break;
    const ne = lsqEndpoints(px, opaque, _idx, W);
    if (!ne) break;
    e = ne;
  }
  // single-colour / degenerate refinement: nudge endpoints by one step
  if (bestErr > 0) {
    const base0 = bestC0, base1 = bestC1;
    const steps = [0x0800, 0x0020, 0x0001];
    for (const s of steps) {
      for (const sign of [-1, 1]) {
        const a = base0 + sign * s, b = base1 - sign * s;
        if (a >= 0 && a <= 0xffff) tryPair(a, base1);
        if (b >= 0 && b <= 0xffff) tryPair(base0, b);
      }
    }
  }

  let c0 = bestC0, c1 = bestC1;
  const idx = _bestIdx;
  if (mode4) {
    if (c0 < c1) {
      const t = c0; c0 = c1; c1 = t;
      for (let i = 0; i < 16; i++) idx[i] = [1, 0, 3, 2][idx[i]];
    } else if (c0 === c1) {
      for (let i = 0; i < 16; i++) idx[i] = 0; // 3-colour mode would kick in; only index 0 is safe
    }
  } else {
    if (c0 > c1) {
      const t = c0; c0 = c1; c1 = t;
      for (let i = 0; i < 16; i++) if (idx[i] < 2) idx[i] ^= 1;
    }
  }
  dst[dofs] = c0 & 0xff; dst[dofs + 1] = c0 >> 8;
  dst[dofs + 2] = c1 & 0xff; dst[dofs + 3] = c1 >> 8;
  let bits = 0;
  for (let i = 15; i >= 0; i--) bits = (bits * 4) + idx[i];
  dst[dofs + 4] = bits & 0xff; dst[dofs + 5] = (bits >>> 8) & 0xff;
  dst[dofs + 6] = (bits >>> 16) & 0xff; dst[dofs + 7] = (bits >>> 24) & 0xff;
}

/** Encode the DXT5 (BC4-style) alpha half of a block. Tries both 8-value and 6-value(+0/255) modes. */
function encodeAlphaBC3(px, dst, dofs) {
  let mn = 255, mx = 0, mn6 = 255, mx6 = 0;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3];
    if (a < mn) mn = a; if (a > mx) mx = a;
    if (a !== 0 && a !== 255) { if (a < mn6) mn6 = a; if (a > mx6) mx6 = a; }
  }
  const build = (a0, a1) => {
    const pal = [a0, a1, 0, 0, 0, 0, 0, 0];
    if (a0 > a1) for (let i = 1; i <= 6; i++) pal[1 + i] = (((7 - i) * a0 + i * a1) / 7) | 0;
    else { for (let i = 1; i <= 4; i++) pal[1 + i] = (((5 - i) * a0 + i * a1) / 5) | 0; pal[6] = 0; pal[7] = 255; }
    const idx = new Uint8Array(16); let err = 0;
    for (let i = 0; i < 16; i++) {
      const a = px[i * 4 + 3]; let b = 0, bd = Infinity;
      for (let k = 0; k < 8; k++) { const d = Math.abs(pal[k] - a); if (d < bd) { bd = d; b = k; } }
      idx[i] = b; err += bd * bd;
    }
    return { a0, a1, idx, err };
  };
  let best = mx === mn ? build(mx, mn) : build(mx, mn);
  if (mx6 >= mn6) { const c = build(mn6, mx6); if (c.err < best.err) best = c; }
  dst[dofs] = best.a0; dst[dofs + 1] = best.a1;
  let lo = 0, hi = 0;
  for (let i = 0; i < 8; i++) lo |= best.idx[i] << (3 * i);
  for (let i = 0; i < 8; i++) hi |= best.idx[8 + i] << (3 * i);
  dst[dofs + 2] = lo & 255; dst[dofs + 3] = (lo >> 8) & 255; dst[dofs + 4] = (lo >> 16) & 255;
  dst[dofs + 5] = hi & 255; dst[dofs + 6] = (hi >> 8) & 255; dst[dofs + 7] = (hi >> 16) & 255;
}

function encodeAlphaBC2(px, dst, dofs) {
  for (let i = 0; i < 8; i++) {
    const a0 = Math.round(px[(i * 2) * 4 + 3] / 17), a1 = Math.round(px[(i * 2 + 1) * 4 + 3] / 17);
    dst[dofs + i] = a0 | (a1 << 4);
  }
}

module.exports = { encodeAlphaBC3, encodeAlphaBC2, decodeColorBlock, decodeAlphaBC3, decodeAlphaBC2, encodeColorBlock, expand565, to565 };
