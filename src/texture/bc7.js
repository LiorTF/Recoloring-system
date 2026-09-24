'use strict';
/**
 * BC7 decoder (all 8 modes, port of bcdec's reference logic) and a compact
 * encoder that tries:
 *   - mode 6 (1 subset, RGBA 7.7.7.7 + p-bit, 4-bit indices)  - smooth blocks
 *   - mode 5 (1 subset, RGB 7 + A 8, separate 2-bit colour/alpha indices) - alpha edges
 *   - mode 1 (2 subsets, RGB 6 + shared p-bit, 3-bit indices, 64 partitions) - hard colour edges
 * and keeps whichever has the lowest error.
 */
const { P2, P3, A2, A3 } = require('./bc7tables');

const W2 = [0, 21, 43, 64];
const W3 = [0, 9, 18, 27, 37, 46, 55, 64];
const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];
const interp = (a, b, w) => (a * (64 - w) + b * w + 32) >> 6;

// ---------------- decoder ----------------

class BitReader {
  constructor(src, off) { this.src = src; this.off = off; this.pos = 0; }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos++;
      v |= ((this.src[this.off + (p >> 3)] >> (p & 7)) & 1) << i;
    }
    return v;
  }
}

const BITS_RGB = [4, 6, 5, 7, 5, 7, 7, 5];
const BITS_A = [0, 0, 0, 0, 6, 8, 7, 5];
const HAS_PBITS = 0b11001011;

function decodeBlock(src, so, out) {
  const br = new BitReader(src, so);
  let mode = 0;
  while (mode < 8 && br.bits(1) === 0) mode++;
  if (mode >= 8) { out.fill(0, 0, 64); return; }

  let partition = 0, numPartitions = 1, rotation = 0, isb = 0;
  if (mode === 0 || mode === 1 || mode === 2 || mode === 3 || mode === 7) {
    numPartitions = (mode === 0 || mode === 2) ? 3 : 2;
    partition = br.bits(mode === 0 ? 4 : 6);
  }
  const numEp = numPartitions * 2;
  if (mode === 4 || mode === 5) {
    rotation = br.bits(2);
    if (mode === 4) isb = br.bits(1);
  }
  const ep = [];
  for (let j = 0; j < numEp; j++) ep.push([0, 0, 0, 0]);
  for (let c = 0; c < 3; c++) for (let j = 0; j < numEp; j++) ep[j][c] = br.bits(BITS_RGB[mode]);
  if (BITS_A[mode] > 0) for (let j = 0; j < numEp; j++) ep[j][3] = br.bits(BITS_A[mode]);

  if (mode === 0 || mode === 1 || mode === 3 || mode === 6 || mode === 7) {
    for (let j = 0; j < numEp; j++) for (let c = 0; c < 4; c++) ep[j][c] <<= 1;
    if (mode === 1) {
      const p0 = br.bits(1), p1 = br.bits(1);
      for (let c = 0; c < 3; c++) { ep[0][c] |= p0; ep[1][c] |= p0; ep[2][c] |= p1; ep[3][c] |= p1; }
    } else if (HAS_PBITS & (1 << mode)) {
      for (let j = 0; j < numEp; j++) { const p = br.bits(1); for (let c = 0; c < 4; c++) ep[j][c] |= p; }
    }
  }
  const pb = (HAS_PBITS >> mode) & 1;
  for (let j = 0; j < numEp; j++) {
    let n = BITS_RGB[mode] + pb;
    for (let c = 0; c < 3; c++) { let v = ep[j][c] << (8 - n); ep[j][c] = (v | (v >> n)) & 0xff; }
    n = BITS_A[mode] + pb;
    let v = ep[j][3] << (8 - n); ep[j][3] = (v | (v >> n)) & 0xff;
  }
  if (!BITS_A[mode]) for (let j = 0; j < numEp; j++) ep[j][3] = 255;

  const ib = (mode === 0 || mode === 1) ? 3 : (mode === 6 ? 4 : 2);
  const ib2 = mode === 4 ? 3 : (mode === 5 ? 2 : 0);
  const w1 = ib === 2 ? W2 : ib === 3 ? W3 : W4;
  const w2 = ib2 === 2 ? W2 : W3;

  const subsetOf = (i) => numPartitions === 1 ? 0 : (numPartitions === 2 ? P2[partition * 16 + i] : P3[partition * 16 + i]);
  const isAnchor = (i) => {
    if (i === 0) return true;
    if (numPartitions === 2) return A2[partition * 3 + 1] === i;
    if (numPartitions === 3) return A3[partition * 3 + 1] === i || A3[partition * 3 + 2] === i;
    return false;
  };
  const idx = new Uint8Array(16);
  for (let i = 0; i < 16; i++) idx[i] = br.bits(isAnchor(i) ? ib - 1 : ib);
  for (let i = 0; i < 16; i++) {
    const s = subsetOf(i) * 2;
    const e0 = ep[s], e1 = ep[s + 1];
    let r, g, b, a;
    if (!ib2) {
      const w = w1[idx[i]];
      r = interp(e0[0], e1[0], w); g = interp(e0[1], e1[1], w); b = interp(e0[2], e1[2], w); a = interp(e0[3], e1[3], w);
    } else {
      const i2 = br.bits(i === 0 ? ib2 - 1 : ib2);
      if (!isb) {
        const w = w1[idx[i]], wa = w2[i2];
        r = interp(e0[0], e1[0], w); g = interp(e0[1], e1[1], w); b = interp(e0[2], e1[2], w); a = interp(e0[3], e1[3], wa);
      } else {
        const w = w2[i2], wa = w1[idx[i]];
        r = interp(e0[0], e1[0], w); g = interp(e0[1], e1[1], w); b = interp(e0[2], e1[2], w); a = interp(e0[3], e1[3], wa);
      }
    }
    if (rotation === 1) { const t = a; a = r; r = t; }
    else if (rotation === 2) { const t = a; a = g; g = t; }
    else if (rotation === 3) { const t = a; a = b; b = t; }
    const o = i * 4;
    out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
  }
}

// ---------------- encoder ----------------

class BitWriter {
  constructor(dst, off) { this.dst = dst; this.off = off; this.pos = 0; dst.fill(0, off, off + 16); }
  bits(v, n) {
    for (let i = 0; i < n; i++) {
      const p = this.pos++;
      if ((v >> i) & 1) this.dst[this.off + (p >> 3)] |= 1 << (p & 7);
    }
  }
}

/** Principal-axis endpoints of a pixel subset (channels = 3 or 4). */
function fitLine(px, members, nch) {
  const n = members.length;
  const mean = [0, 0, 0, 0];
  for (const i of members) for (let c = 0; c < nch; c++) mean[c] += px[i * 4 + c];
  for (let c = 0; c < nch; c++) mean[c] /= n;
  const cov = new Float64Array(16);
  for (const i of members) {
    const d = [0, 0, 0, 0];
    for (let c = 0; c < nch; c++) d[c] = px[i * 4 + c] - mean[c];
    for (let a = 0; a < nch; a++) for (let b = 0; b < nch; b++) cov[a * 4 + b] += d[a] * d[b];
  }
  let v = [1, 1, 1, 1];
  for (let it = 0; it < 8; it++) {
    const nv = [0, 0, 0, 0];
    for (let a = 0; a < nch; a++) for (let b = 0; b < nch; b++) nv[a] += cov[a * 4 + b] * v[b];
    let m = 0; for (let a = 0; a < nch; a++) m = Math.max(m, Math.abs(nv[a]));
    if (m < 1e-9) { v = [0, 0, 0, 0]; break; }
    for (let a = 0; a < nch; a++) v[a] = nv[a] / m;
  }
  let len2 = 0; for (let a = 0; a < nch; a++) len2 += v[a] * v[a];
  let lo = 0, hi = 0;
  if (len2 > 0) {
    lo = Infinity; hi = -Infinity;
    for (const i of members) {
      let p = 0; for (let c = 0; c < nch; c++) p += (px[i * 4 + c] - mean[c]) * v[c];
      if (p < lo) lo = p; if (p > hi) hi = p;
    }
    lo /= len2; hi /= len2;
  }
  const e0 = [0, 0, 0, 255], e1 = [0, 0, 0, 255];
  for (let c = 0; c < nch; c++) { e0[c] = mean[c] + v[c] * lo; e1[c] = mean[c] + v[c] * hi; }
  return [e0, e1];
}

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

/** Quantize endpoint with per-endpoint p-bit; bits = colour bits WITHOUT p-bit. Returns {q:[..], p, val:[8bit..]} */
function quantPbit(e, bits, nch, sharedP) {
  let best = null;
  const ps = sharedP === undefined ? [0, 1] : [sharedP];
  const n = bits + 1;
  for (const p of ps) {
    const q = [0, 0, 0, 0], val = [0, 0, 0, 255];
    let err = 0;
    for (let c = 0; c < nch; c++) {
      const qq = clamp(Math.round(((e[c] / 255) * ((1 << n) - 1) - p) / 2), 0, (1 << bits) - 1);
      q[c] = qq;
      const x = (qq << 1) | p;
      const v8 = ((x << (8 - n)) | (x >> (2 * n - 8))) & 0xff;
      val[c] = v8; err += (v8 - e[c]) ** 2;
    }
    if (!best || err < best.err) best = { q, p, val, err };
  }
  return best;
}

function quantPlain(e, bits, nch) {
  const q = [0, 0, 0, 0], val = [0, 0, 0, 255];
  for (let c = 0; c < nch; c++) {
    const qq = clamp(Math.round(e[c] / 255 * ((1 << bits) - 1)), 0, (1 << bits) - 1);
    q[c] = qq;
    val[c] = bits >= 8 ? qq : (((qq << (8 - bits)) | (qq >> (2 * bits - 8))) & 0xff);
  }
  return { q, val };
}

function assign(px, members, v0, v1, W, chans, idxOut) {
  let err = 0;
  for (const i of members) {
    let best = 0, bd = Infinity;
    for (let k = 0; k < W.length; k++) {
      let d = 0;
      for (const c of chans) { const t = interp(v0[c], v1[c], W[k]) - px[i * 4 + c]; d += t * t; }
      if (d < bd) { bd = d; best = k; }
    }
    idxOut[i] = best; err += bd;
  }
  return err;
}

/** Least-squares endpoint refinement given indices (float endpoints). */
function lsq(px, members, idx, W, chans, e0, e1) {
  let aa = 0, bb = 0, ab = 0;
  const ax = [0, 0, 0, 0], bx = [0, 0, 0, 0];
  for (const i of members) {
    const t = W[idx[i]] / 64, a = 1 - t, b = t;
    aa += a * a; bb += b * b; ab += a * b;
    for (const c of chans) { ax[c] += a * px[i * 4 + c]; bx[c] += b * px[i * 4 + c]; }
  }
  const det = aa * bb - ab * ab;
  if (Math.abs(det) < 1e-8) return false;
  for (const c of chans) {
    e0[c] = clamp((ax[c] * bb - bx[c] * ab) / det, 0, 255);
    e1[c] = clamp((bx[c] * aa - ax[c] * ab) / det, 0, 255);
  }
  return true;
}

const ALL16 = Array.from({ length: 16 }, (_, i) => i);

function encodeMode6(px, dst, off) {
  let [e0, e1] = fitLine(px, ALL16, 4);
  const idx = new Uint8Array(16);
  let best = null;
  for (let it = 0; it < 3; it++) {
    const q0 = quantPbit(e0, 7, 4), q1 = quantPbit(e1, 7, 4);
    const err = assign(px, ALL16, q0.val, q1.val, W4, [0, 1, 2, 3], idx);
    if (!best || err < best.err) best = { err, q0, q1, idx: idx.slice() };
    if (err === 0 || !lsq(px, ALL16, idx, W4, [0, 1, 2, 3], e0 = e0.slice(), e1 = e1.slice())) break;
  }
  let { q0, q1 } = best; const bi = best.idx;
  if (bi[0] & 8) { const t = q0; q0 = q1; q1 = t; for (let i = 0; i < 16; i++) bi[i] = 15 - bi[i]; }
  const w = new BitWriter(dst, off);
  w.bits(1 << 6, 7);
  for (let c = 0; c < 4; c++) { w.bits(q0.q[c], 7); w.bits(q1.q[c], 7); }
  w.bits(q0.p, 1); w.bits(q1.p, 1);
  for (let i = 0; i < 16; i++) w.bits(bi[i], i === 0 ? 3 : 4);
  return best.err;
}

function encodeMode5(px, dst, off) {
  let [c0, c1] = fitLine(px, ALL16, 3);
  let amin = 255, amax = 0;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a < amin) amin = a; if (a > amax) amax = a; }
  const idxC = new Uint8Array(16), idxA = new Uint8Array(16);
  let best = null;
  for (let it = 0; it < 3; it++) {
    const q0 = quantPlain(c0, 7, 3), q1 = quantPlain(c1, 7, 3);
    const err = assign(px, ALL16, q0.val, q1.val, W2, [0, 1, 2], idxC);
    if (!best || err < best.err) best = { err, q0, q1, idx: idxC.slice() };
    if (err === 0 || !lsq(px, ALL16, idxC, W2, [0, 1, 2], c0 = c0.slice(), c1 = c1.slice())) break;
  }
  const av0 = [0, 0, 0, amin], av1 = [0, 0, 0, amax];
  const errA = assign(px, ALL16, av0, av1, W2, [3], idxA);
  let { q0, q1 } = best; const bi = best.idx;
  if (bi[0] & 2) { const t = q0; q0 = q1; q1 = t; for (let i = 0; i < 16; i++) bi[i] = 3 - bi[i]; }
  let a0 = amin, a1 = amax;
  if (idxA[0] & 2) { a0 = amax; a1 = amin; for (let i = 0; i < 16; i++) idxA[i] = 3 - idxA[i]; }
  const w = new BitWriter(dst, off);
  w.bits(1 << 5, 6);
  w.bits(0, 2); // rotation
  for (let c = 0; c < 3; c++) { w.bits(q0.q[c], 7); w.bits(q1.q[c], 7); }
  w.bits(a0, 8); w.bits(a1, 8);
  for (let i = 0; i < 16; i++) w.bits(bi[i], i === 0 ? 1 : 2);
  for (let i = 0; i < 16; i++) w.bits(idxA[i], i === 0 ? 1 : 2);
  return best.err + errA;
}

const SUBSETS2 = [];
for (let p = 0; p < 64; p++) {
  const s = [[], []];
  for (let i = 0; i < 16; i++) s[P2[p * 16 + i]].push(i);
  SUBSETS2.push(s);
}

function fitSubsetMode1(px, members) {
  let [e0, e1] = fitLine(px, members, 3);
  const idx = new Uint8Array(16);
  let best = null;
  for (let it = 0; it < 2; it++) {
    for (const sp of [0, 1]) {
      const q0 = quantPbit(e0, 6, 3, sp), q1 = quantPbit(e1, 6, 3, sp);
      const err = assign(px, members, q0.val, q1.val, W3, [0, 1, 2], idx);
      if (!best || err < best.err) best = { err, q0, q1, p: sp, idx: idx.slice() };
    }
    if (best.err === 0 || !lsq(px, members, best.idx, W3, [0, 1, 2], e0 = e0.slice(), e1 = e1.slice())) break;
  }
  return best;
}

/** Cheap partition ranking: sum of per-subset variance. */
function partitionScore(px, subsets) {
  let s = 0;
  for (const m of subsets) {
    const mean = [0, 0, 0];
    for (const i of m) for (let c = 0; c < 3; c++) mean[c] += px[i * 4 + c];
    for (let c = 0; c < 3; c++) mean[c] /= m.length;
    for (const i of m) for (let c = 0; c < 3; c++) s += (px[i * 4 + c] - mean[c]) ** 2;
  }
  return s;
}

function encodeMode1(px, dst, off, maxPartitions = 8) {
  const ranked = [];
  for (let p = 0; p < 64; p++) ranked.push([partitionScore(px, SUBSETS2[p]), p]);
  ranked.sort((a, b) => a[0] - b[0]);
  let best = null;
  for (let k = 0; k < maxPartitions; k++) {
    const p = ranked[k][1];
    const [m0, m1] = SUBSETS2[p];
    const f0 = fitSubsetMode1(px, m0), f1 = fitSubsetMode1(px, m1);
    const err = f0.err + f1.err;
    if (!best || err < best.err) best = { err, p, f: [f0, f1] };
  }
  const { p, f } = best;
  const idx = new Uint8Array(16);
  const eps = [];
  for (let s = 0; s < 2; s++) {
    let { q0, q1 } = f[s];
    const members = SUBSETS2[p][s];
    const anchor = A2[p * 3 + s];
    for (const i of members) idx[i] = f[s].idx[i];
    if (idx[anchor] & 4) { const t = q0; q0 = q1; q1 = t; for (const i of members) idx[i] = 7 - idx[i]; }
    eps.push(q0, q1);
  }
  const w = new BitWriter(dst, off);
  w.bits(1 << 1, 2);
  w.bits(p, 6);
  for (let c = 0; c < 3; c++) for (let j = 0; j < 4; j++) w.bits(eps[j].q[c], 6);
  w.bits(f[0].p, 1); w.bits(f[1].p, 1);
  const a1 = A2[p * 3 + 1];
  for (let i = 0; i < 16; i++) w.bits(idx[i], (i === 0 || i === a1) ? 2 : 3);
  return best.err;
}

const _tmp = new Uint8Array(16);
const _dec = new Uint8Array(64);

/** Encode 16 RGBA pixels (64 bytes) as a BC7 block at dst[off..off+16]. */
function encodeBlock(px, dst, off) {
  let opaque = true, constA = true;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a !== 255) opaque = false; if (a !== px[3]) constA = false; }
  let bestErr = encodeMode6(px, dst, off);
  if (bestErr < 16 * 4) return; // already excellent
  const tryMode = (fn) => {
    const err = fn(px, _tmp, 0);
    if (err < bestErr) { bestErr = err; dst.set(_tmp, off); }
  };
  if (!constA) tryMode(encodeMode5);
  if (opaque) tryMode(encodeMode1);
}

module.exports = { decodeBlock, encodeBlock, _internal: { encodeMode1, encodeMode5, encodeMode6, _dec } };
