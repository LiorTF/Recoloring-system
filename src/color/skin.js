'use strict';
/**
 * Skin detection.
 *
 * Three sources of truth, strongest first:
 *   1. Race-variant diff  – GTA stores a garment that shows skin once per skin
 *      tone (_whi, _bla, _lat, ...). Cloth texels are identical across those
 *      variants; skin (and tattoos baked onto skin) differ. Near-perfect mask.
 *   2. Ped skin model     – a robust Gaussian in OKLab fitted to THIS ped's
 *      head_diff texture. Much tighter than a generic detector, so beige /
 *      tan / leather garments aren't mistaken for skin.
 *   3. Generic skin model – YCbCr + RGB rules (Chai & Ngan / Kovac), used only
 *      if no head texture is available.
 */
const { srgb8ToOklab, SRGB_TO_LIN, linToOklab } = require('./oklab');
const M = require('../core/masks');

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

/**
 * 0..1 generic skin likelihood from OKLab.
 * Human skin (every tone, incl. GTA's _whi/_bla/_lat... textures) sits in a narrow
 * hue band, OKLab h ~ 38..60 deg (orange-red). Khaki / olive / camel / brown fabric
 * sits at 70..100 deg, which the classic YCbCr rules cannot tell apart (they
 * score both 1.0). Measured values are in docs/KNOWLEDGE.md.
 */
function genericSkinScoreLab(L, a, b) {
  const C = Math.hypot(a, b);
  if (C < 0.015) return 0;
  const h = (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  const hue = smooth(22, 32, h) * (1 - smooth(60, 68, h));
  const chroma = smooth(0.018, 0.03, C) * (1 - smooth(0.14, 0.18, C));
  const light = smooth(0.18, 0.26, L) * (1 - smooth(0.92, 0.96, L));
  return hue * chroma * light;
}

const _lab = [0, 0, 0];
function genericSkinScore(r, g, b) {
  linToOklab(SRGB_TO_LIN[r], SRGB_TO_LIN[g], SRGB_TO_LIN[b], _lab, 0);
  return genericSkinScoreLab(_lab[0], _lab[1], _lab[2]);
}

/**
 * Fit a robust Gaussian skin model from head textures.
 * @param {Array<{rgba:Uint8Array,width:number,height:number}>} images
 */
function buildSkinModel(images, { extraSamples = [] } = {}) {
  const pts = [];
  const t = [0, 0, 0];
  for (const img of images) {
    const n = img.width * img.height;
    const step = Math.max(1, Math.floor(n / 60000));
    for (let i = 0; i < n; i += step) {
      const r = img.rgba[i * 4], g = img.rgba[i * 4 + 1], b = img.rgba[i * 4 + 2], a = img.rgba[i * 4 + 3];
      if (a < 128) continue;
      if (genericSkinScore(r, g, b) < 0.5) continue;
      linToOklab(SRGB_TO_LIN[r], SRGB_TO_LIN[g], SRGB_TO_LIN[b], t, 0);
      pts.push([t[0], t[1], t[2]]);
    }
  }
  for (const hex of extraSamples) {
    const v = parseInt(String(hex).replace('#', ''), 16);
    const lab = srgb8ToOklab((v >> 16) & 255, (v >> 8) & 255, v & 255);
    for (let k = 0; k < 200; k++) pts.push(lab);
  }
  if (pts.length < 300) return null;

  let keep = pts;
  let model = null;
  for (let iter = 0; iter < 4; iter++) {
    model = gaussian(keep);
    if (!model) return null;
    const next = keep.filter((p) => mahalanobis(model, p[0], p[1], p[2]) < 2.5);
    if (next.length < 200) break;
    keep = next;
  }
  // Skin inside garments sits under baked AO / cloth shadow: widen L variance.
  model = gaussian(keep, { lScale: 2.0, abScale: 1.35 });
  if (model) model.samples = keep.length;
  return model;
}

function gaussian(pts, { lScale = 1, abScale = 1 } = {}) {
  const n = pts.length;
  if (n < 10) return null;
  const mu = [0, 0, 0];
  for (const p of pts) { mu[0] += p[0]; mu[1] += p[1]; mu[2] += p[2]; }
  mu[0] /= n; mu[1] /= n; mu[2] /= n;
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of pts) {
    const d = [p[0] - mu[0], p[1] - mu[1], p[2] - mu[2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] += d[i] * d[j];
  }
  for (let i = 0; i < 9; i++) c[i] /= n;
  // regularise (compression noise / tiny heads)
  c[0] = c[0] * lScale * lScale + 1e-4; c[4] = c[4] * abScale * abScale + 2e-5; c[8] = c[8] * abScale * abScale + 2e-5;
  c[1] *= lScale * abScale; c[3] *= lScale * abScale; c[2] *= lScale * abScale; c[6] *= lScale * abScale;
  c[5] *= abScale * abScale; c[7] *= abScale * abScale;
  const inv = invert3(c);
  if (!inv) return null;
  return { mean: mu, cov: c, inv };
}

function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  const k = 1 / det;
  return [A * k, -(b * i - c * h) * k, (b * f - c * e) * k,
    B * k, (a * i - c * g) * k, -(a * f - c * d) * k,
    C * k, -(a * h - b * g) * k, (a * e - b * d) * k];
}

function mahalanobis(model, L, a, b) {
  const d0 = L - model.mean[0], d1 = a - model.mean[1], d2 = b - model.mean[2];
  const v = model.inv;
  const q = d0 * (v[0] * d0 + v[1] * d1 + v[2] * d2) + d1 * (v[3] * d0 + v[4] * d1 + v[5] * d2) + d2 * (v[6] * d0 + v[7] * d1 + v[8] * d2);
  return Math.sqrt(Math.max(0, q));
}

/**
 * Per-pixel skin score (0..1).
 * @param planes OKLab planes of the texture
 */
function skinScoreMap(rgba, planes, n, model, { strict = false } = {}) {
  const out = new Float32Array(n);
  const [dIn, dOut] = strict ? [1.8, 2.6] : [2.3, 3.3];
  for (let i = 0; i < n; i++) {
    const gen = genericSkinScoreLab(planes.L[i], planes.A[i], planes.B[i]);
    if (model) {
      const d = mahalanobis(model, planes.L[i], planes.A[i], planes.B[i]);
      // generic score is a sanity gate (skin is never blue/green), model is the decider
      out[i] = (1 - smooth(dIn, dOut, d)) * smooth(0.05, 0.3, gen);
    } else {
      out[i] = strict ? smooth(0.5, 0.9, gen) : gen;
    }
  }
  return out;
}

/**
 * Race-variant diff: pixels that differ between skin-tone variants of the same
 * garment are skin (or skin decoration). Returns a 0..1 Float32 mask.
 */
function raceDiffMask(images, w, h, { threshold = 10 } = {}) {
  const n = w * h;
  const out = new Float32Array(n);
  if (images.length < 2) return out;
  for (let i = 0; i < n; i++) {
    let maxd = 0;
    const base = images[0];
    for (let k = 1; k < images.length; k++) {
      const o = images[k];
      const d = Math.max(Math.abs(base[i * 4] - o[i * 4]), Math.abs(base[i * 4 + 1] - o[i * 4 + 1]), Math.abs(base[i * 4 + 2] - o[i * 4 + 2]));
      if (d > maxd) maxd = d;
    }
    out[i] = smooth(threshold * 0.5, threshold * 1.5, maxd);
  }
  // DXT: a block that mixes skin+cloth will differ on all 16 texels. Clean with open/close.
  let m = M.threshold(out, 0.5);
  m = M.open(m, w, h, 1);
  m = M.close(m, w, h, 2);
  m = M.fillHoles(m, w, h, Math.max(64, n * 0.02));
  return M.boxBlur(M.toFloat(M.dilate(m, w, h, 1)), w, h, 1);
}

/**
 * Turn a raw score map into a clean, feathered protection mask:
 * threshold -> open (remove speckle) -> drop tiny islands -> close -> fill
 * enclosed holes (tattoos / ink on skin) -> dilate -> feather.
 */
function cleanSkinMask(score, w, h, { strict = false, tattooHoleFrac = 0.03 } = {}) {
  const n = w * h;
  let m = M.threshold(score, strict ? 0.6 : 0.5);
  m = M.open(m, w, h, 1);
  const minArea = Math.max(strict ? 256 : 48, Math.round(n * (strict ? 0.004 : 0.0008)));
  m = M.removeSmall(m, w, h, minArea);
  m = M.close(m, w, h, 2);
  m = M.fillHoles(m, w, h, Math.max(64, Math.round(n * tattooHoleFrac)));
  m = M.dilate(m, w, h, 1);
  return M.boxBlur(M.toFloat(m), w, h, 1);
}

/**
 * Tattooed skin, island by island (model knowledge). A full-sleeve tattoo leaves too little
 * clean skin to "enclose" the ink, so the pixel skin mask misses most of it. But a leg / arm
 * is its own mesh piece with its own UV island: if the island shows a real share of THIS ped's
 * skin and almost everything else in it is darker than that skin (ink), the whole island is
 * tattooed skin. A shorts / sleeve panel has no skin in it and is left alone.
 * @param {Array<{island:Uint8Array, area:number}>} islands
 * @param {Float32Array} score  per-texel skin score
 */
function tattooedIslands(islands, score, planes, rgba, w, h, { minSkin = 0.08, maxFabric = 0.15, minArea = 0.001 } = {}) {
  const n = w * h;
  const out = new Uint8Array(n);
  const found = [];
  for (const isl of islands) {
    if (isl.area < n * minArea) continue;
    const skinL = [];
    let total = 0, skinCount = 0;
    for (let i = 0; i < n; i++) {
      if (!isl.island[i] || rgba[i * 4 + 3] < 16) continue;
      total++;
      if (score[i] >= 0.5) { skinCount++; if (skinL.length < 50000) skinL.push(planes.L[i]); }
    }
    if (!total || skinCount / total < minSkin) continue;
    skinL.sort((a, b) => a - b);
    const Ls = skinL[Math.floor(skinL.length * 0.25)]; // darker end of the visible skin
    // "fabric-like" = not skin, and as light as the skin or lighter (ink is darker)
    let fabric = 0;
    for (let i = 0; i < n; i++) {
      if (!isl.island[i] || rgba[i * 4 + 3] < 16 || score[i] >= 0.5) continue;
      if (planes.L[i] >= Ls - 0.02) fabric++;
    }
    const fabricFrac = fabric / total;
    if (fabricFrac > maxFabric) continue;
    for (let i = 0; i < n; i++) if (isl.island[i]) out[i] = 1;
    found.push({ area: isl.area, skin: +(skinCount / total).toFixed(3), fabric: +fabricFrac.toFixed(3) });
  }
  if (!found.length) return null;
  return { mask: M.boxBlur(M.toFloat(M.dilate(out, w, h, 2)), w, h, 1), islands: found };
}

/**
 * Pixel-level fallback when leg + shorts are ONE mesh piece: ink regions (darker than this
 * ped's skin) that are interleaved with skin – most of the region has skin within a few
 * texels, like a sleeve showing skin between its lines – are tattoos. A black shorts panel
 * only meets skin along its hem, so it fails the interleave test.
 */
function inkOnSkin(skinMask, score, planes, rgba, w, h, { reachFrac = 0.05, minDensity = 0.1 } = {}) {
  const n = w * h;
  // RAW skin detections (minus lone specks): the cleaned mask drops exactly the small skin
  // fragments a dense sleeve leaves between its lines
  const raw = new Uint8Array(n);
  for (let i = 0; i < n; i++) raw[i] = (score[i] >= 0.5 || skinMask[i] >= 0.5) && rgba[i * 4 + 3] >= 16 ? 1 : 0;
  const skinBin = M.removeSmall(raw, w, h, 6);
  const Ls = [];
  for (let i = 0; i < n; i += 3) if (skinBin[i] && score[i] >= 0.5) Ls.push(planes.L[i]);
  if (Ls.length < 200) return null;
  Ls.sort((a, b) => a - b);
  const L25 = Ls[Math.floor(Ls.length * 0.25)];
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (!skinBin[i] && rgba[i * 4 + 3] >= 16 && planes.L[i] < L25 - 0.03) ink[i] = 1;
  // measured on a dense sleeve: >= 4% of the texture bridges the skin gaps; closing never
  // spills past the hem at any radius. Capped so 2k textures stay fast.
  const r = Math.min(64, Math.max(3, Math.round(Math.max(w, h) * reachFrac)));
  // Per texel, not per region (sleeve ink often touches dark shorts at the hem and merges
  // with them). CLOSING the skin mask joins the skin showing between the lines into one body
  // area covering the sleeve – and, unlike a blur/density window, closing never grows past
  // the outermost skin, so it stops exactly at the hem. Big solid ink fills inside that
  // area are enclosed holes.
  let body = M.close(skinBin, w, h, r);
  body = M.fillHoles(body, w, h, Math.round(n * 0.03));
  // a real sleeve: the body area must be mostly skin + ink, not a skin-coloured speck field
  let bodyN = 0, bodySkin = 0;
  for (let i = 0; i < n; i++) if (body[i]) { bodyN++; if (skinBin[i]) bodySkin++; }
  if (!bodyN || bodySkin / bodyN < minDensity) return null;
  const out = new Uint8Array(n);
  let kept = 0;
  // inside the closed skin area every texel is skin or tattoo – including WHITE ink and
  // coloured (red/blue) ink that is not darker than the skin
  for (let i = 0; i < n; i++) if (body[i] && rgba[i * 4 + 3] >= 16 && !skinBin[i]) { out[i] = 1; kept++; }
  if (!kept) return null;
  // the skin showing between the kept ink belongs to the tattoo too
  const around = M.dilate(out, w, h, r);
  for (let i = 0; i < n; i++) if (skinBin[i] && around[i]) out[i] = 1;
  const closed = M.close(out, w, h, 2);
  return { mask: M.boxBlur(M.toFloat(M.dilate(closed, w, h, 1)), w, h, 1), kept };
}

module.exports = { inkOnSkin, tattooedIslands, genericSkinScore, genericSkinScoreLab, buildSkinModel, skinScoreMap, raceDiffMask, cleanSkinMask, mahalanobis };
