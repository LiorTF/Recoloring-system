'use strict';
/**
 * Small image-mask toolkit (binary Uint8Array masks and soft Float32Array masks).
 */

function boxBlur(src, w, h, r) {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[row + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc * inv;
      acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc * inv;
      acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Binary dilate (op='max') or erode (op='min') with a square of radius r. */
function morph(mask, w, h, r, op) {
  if (r <= 0) return Uint8Array.from(mask);
  const isMax = op === 'max';
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        const m = mask[y * w + xx];
        if (isMax ? m : !m) { v = isMax ? 1 : 0; break; }
      }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = isMax ? 0 : 1;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        const m = tmp[yy * w + x];
        if (isMax ? m : !m) { v = isMax ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
const dilate = (m, w, h, r) => morph(m, w, h, r, 'max');
const erode = (m, w, h, r) => morph(m, w, h, r, 'min');
const open = (m, w, h, r) => dilate(erode(m, w, h, r), w, h, r);
const close = (m, w, h, r) => erode(dilate(m, w, h, r), w, h, r);

/**
 * 4-connected component labelling of pixels where mask[i] === value.
 * @returns {{labels:Int32Array, sizes:number[], touchesBorder:boolean[], count:number}}
 */
function label(mask, w, h, value = 1) {
  const labels = new Int32Array(w * h).fill(-1);
  const sizes = [], touchesBorder = [];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let i = 0; i < w * h; i++) {
    if (labels[i] !== -1 || (mask[i] ? 1 : 0) !== value) continue;
    let sp = 0, size = 0, border = false;
    stack[sp++] = i; labels[i] = count;
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0) { const q = p - 1; if (labels[q] === -1 && (mask[q] ? 1 : 0) === value) { labels[q] = count; stack[sp++] = q; } }
      if (x < w - 1) { const q = p + 1; if (labels[q] === -1 && (mask[q] ? 1 : 0) === value) { labels[q] = count; stack[sp++] = q; } }
      if (y > 0) { const q = p - w; if (labels[q] === -1 && (mask[q] ? 1 : 0) === value) { labels[q] = count; stack[sp++] = q; } }
      if (y < h - 1) { const q = p + w; if (labels[q] === -1 && (mask[q] ? 1 : 0) === value) { labels[q] = count; stack[sp++] = q; } }
    }
    sizes.push(size); touchesBorder.push(border); count++;
  }
  return { labels, sizes, touchesBorder, count };
}

function removeSmall(mask, w, h, minArea) {
  const { labels, sizes } = label(mask, w, h, 1);
  const out = Uint8Array.from(mask);
  for (let i = 0; i < w * h; i++) if (out[i] && sizes[labels[i]] < minArea) out[i] = 0;
  return out;
}

/**
 * Fill enclosed holes (0-regions not touching the image border) up to maxArea.
 * Used to keep tattoos / moles / ink that sit fully inside detected skin.
 */
function fillHoles(mask, w, h, maxArea) {
  const { labels, sizes, touchesBorder } = label(mask, w, h, 0);
  const out = Uint8Array.from(mask);
  for (let i = 0; i < w * h; i++) {
    if (out[i]) continue;
    const l = labels[i];
    if (!touchesBorder[l] && sizes[l] <= maxArea) out[i] = 1;
  }
  return out;
}

function toFloat(mask) { const f = new Float32Array(mask.length); for (let i = 0; i < mask.length; i++) f[i] = mask[i] ? 1 : 0; return f; }
function threshold(f, t) { const m = new Uint8Array(f.length); for (let i = 0; i < f.length; i++) m[i] = f[i] >= t ? 1 : 0; return m; }
function maxInto(dst, src) { for (let i = 0; i < dst.length; i++) if (src[i] > dst[i]) dst[i] = src[i]; return dst; }
function coverage(f) { let s = 0; for (let i = 0; i < f.length; i++) s += f[i]; return f.length ? s / f.length : 0; }

/** Area-average downsample of a soft mask (for mip levels). */
function resizeMask(f, w, h, nw, nh) {
  if (nw === w && nh === h) return f;
  const out = new Float32Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let s = 0, n = 0;
      for (let yy = y0; yy < Math.min(h, y1); yy++) for (let xx = x0; xx < Math.min(w, x1); xx++) { s += f[yy * w + xx]; n++; }
      out[y * nw + x] = n ? s / n : 0;
    }
  }
  return out;
}

/**
 * Rasterise UV triangles into a binary mask. uvs: Float32Array [u0,v0,u1,v1,u2,v2,...].
 * UVs use D3D convention (v down), same as texture rows. Tiling UVs are wrapped
 * per triangle so a triangle spanning 1.0-1.2 lands at 0.0-0.2.
 */
function rasterizeUVTriangles(uvs, w, h, mask = new Uint8Array(w * h)) {
  for (let t = 0; t + 5 < uvs.length; t += 6) {
    let u0 = uvs[t], v0 = uvs[t + 1], u1 = uvs[t + 2], v1 = uvs[t + 3], u2 = uvs[t + 4], v2 = uvs[t + 5];
    if (!(isFinite(u0) && isFinite(v0) && isFinite(u1) && isFinite(v1) && isFinite(u2) && isFinite(v2))) continue;
    const ou = Math.floor(Math.min(u0, u1, u2)), ov = Math.floor(Math.min(v0, v1, v2));
    u0 -= ou; u1 -= ou; u2 -= ou; v0 -= ov; v1 -= ov; v2 -= ov;
    const x0 = u0 * w, y0 = v0 * h, x1 = u1 * w, y1 = v1 * h, x2 = u2 * w, y2 = v2 * h;
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(w * 2, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(h * 2, Math.ceil(Math.max(y0, y1, y2)));
    if (Math.abs(area) < 1e-9) {
      // degenerate: mark vertices
      for (const [x, y] of [[x0, y0], [x1, y1], [x2, y2]]) {
        const xi = ((Math.floor(x) % w) + w) % w, yi = ((Math.floor(y) % h) + h) % h;
        mask[yi * w + xi] = 1;
      }
      continue;
    }
    const s = area > 0 ? 1 : -1;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const e0 = s * ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0));
        const e1 = s * ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1));
        const e2 = s * ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2));
        if (e0 >= -0.5 * Math.hypot(x1 - x0, y1 - y0) && e1 >= -0.5 * Math.hypot(x2 - x1, y2 - y1) && e2 >= -0.5 * Math.hypot(x0 - x2, y0 - y2)) {
          mask[(y % h) * w + (x % w)] = 1;
        }
      }
    }
  }
  return mask;
}

module.exports = { boxBlur, dilate, erode, open, close, label, removeSmall, fillHoles, toFloat, threshold, maxInto, coverage, resizeMask, rasterizeUVTriangles };
