'use strict';
/**
 * Core recolor: RGBA8 in, RGBA8 out.
 *
 * Why naive approaches fail on GTA clothing:
 *   - hue shift: black / white / grey fabric has no hue -> nothing happens.
 *   - multiply / overlay tint: dark fabric stays dark, light prints get muddy.
 *   - "replace colour": kills wrinkles, seams, AO and prints (flat blob).
 *
 * What we do instead (all in OKLab, perceptually uniform):
 *   1. Find the garment's base lightness (median L of cloth texels, ignoring
 *      protected texels and saturated accents).
 *   2. Remap lightness so base -> target L while every texel keeps its OWN
 *      delta from the base (folds, seams, stitching, AO, fabric weave, prints).
 *      Deltas that would clip are compressed with a soft knee, never clamped.
 *   3. Replace chroma with the target's hue/chroma, scaled down in shadows and
 *      highlights like a real dyed material.
 *   4. "Design" accents (logos / stripes / stitching whose hue differs from
 *      the main material and cover a small area) are kept in their original
 *      colour (configurable).
 *   5. Protected texels (skin, tattoos, lenses, decals) are blended back to
 *      the original with a feathered mask. Alpha is never touched.
 */
const { rgbaToOklabPlanes, oklabToSrgb8, parseHex, srgb8ToOklab } = require('../color/oklab');
const M = require('./masks');

const DEFAULTS = Object.freeze({
  keepAccents: true,          // keep small differently-coloured design elements
  accentMaxShare: 0.08,       // a hue family covering more than this share of cloth is a material, not an accent
  accentMinChroma: 0.045,     // OKLab chroma below this = neutral (grey/black/white): always tinted
  accentHueDistance: 32,      // degrees away from every material hue to count as an accent
  accentWeakChroma: 0.02,
  keepPrintInk: true,         // keep the neutral ink (black/white) of a kept coloured print
  inkMaxChroma: 0.05,
  inkMinContrast: 0.18,       // ink must differ this much (OKLab L) from the fabric base
  inkMaxShare: 0.03,          // bigger neutral regions are fabric panels, not ink
  inkMinEdge: 0.12,
  inkMinShift: 0.1,
  inkTouchShareMin: 0.1,      // keep ink of a tone only if >= this share of its sharp printed ink touches the coloured print
                              // (measured: skeleton + red crosshair 1-2 %, grunge logo black ink 24 %)
  enclosedFabricTol: 0.08,
  distressSpeckMax: 0.00005,  // fabric-tone specks inside a print up to this share (~200 px at 2k) are print distress    // enclosed texels this close to the fabric base tone are fabric, not ink           // keep neutral ink only if the recolor would move its lightness this much
  inkReach: 0.06,
  enclosedMaxShare: 0.03,     // regions fully enclosed by the coloured print (letter interiors) up to this share
  inkBlobMaxShare: 0.002,     // whole sharp-edged ink blobs touching the print are kept up to this share            // geodesic reach of ink from the coloured print (fraction of texture size)           // median OKLab L step across the ink border (print = sharp, shading = soft)     // accents grow from confident seeds into connected same-hue texels down to this chroma
  contrast: 1.0,              // scales every texel's lightness delta from the base
  chromaFalloff: 0.85,        // how fast target chroma fades in shadows/highlights
  keepChromaVariation: 0.25,  // keep some of the source's relative saturation variation (heather, dirt)
  strength: 1.0,              // 0..1 final blend
  minL: 0.03, maxL: 0.985,    // lightness headroom for the soft knee
  knee: 0.6,                  // fraction of headroom mapped linearly before compression
  materialSeparation: 1.0,    // 1 = keep tonal separation between materials (white shirt vs black suit), 0 = all -> target
  materialMinShare: 0.1,      // a lightness mode needs this share of cloth to be its own material
  materialMinGap: 0.14,       // ... and to be this far (OKLab L) from its neighbour
  minDetail: 0.35,
  flipCrowded: true,          // move a print to the other side of the fabric when it would vanish (white on white)
  minMaterialSep: 0.1,        // OKLab L separation below which a material counts as crowded
  flipOffset: 0.35,           // how far the flipped print sits from the fabric            // never compress in-material detail below this slope
});

const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function weightedMedian(values, weights, n) {
  // histogram based (L in [0,1]) – fast and robust
  const bins = 1024, h = new Float64Array(bins);
  let tot = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i]; if (w <= 0) continue;
    const b = Math.min(bins - 1, Math.max(0, (values[i] * bins) | 0));
    h[b] += w; tot += w;
  }
  if (tot <= 0) return null;
  const pct = (p) => { let acc = 0; for (let b = 0; b < bins; b++) { acc += h[b]; if (acc >= tot * p) return (b + 0.5) / bins; } return 1; };
  return { median: pct(0.5), p05: pct(0.05), p95: pct(0.95), total: tot };
}

/**
 * Analyse a texture and derive the recolor plan (shared across mips and race variants).
 * @param {Uint8Array} rgba
 * @param {Float32Array|null} protect 0..1 per texel (1 = never recolor)
 */
function analyze(rgba, width, height, protect, options = {}, { ignore = null } = {}) {
  const o = { ...DEFAULTS, ...options };
  const n = width * height;
  const planes = rgbaToOklabPlanes(rgba, n);
  const { L, A, B } = planes;

  // 1. hue histogram of chromatic cloth texels
  const bins = 72;
  const hist = new Float64Array(bins);
  let cloth = 0, chromatic = 0;
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = protect ? protect[i] : 0;
    // `ignore` = UV padding: still recolored, but never allowed to define the fabric
    if (p >= 0.5 || rgba[i * 4 + 3] < 16 || (ignore && ignore[i])) continue;
    w[i] = 1; cloth++;
    const C = Math.hypot(A[i], B[i]);
    if (C >= o.accentMinChroma) {
      const hdeg = (Math.atan2(B[i], A[i]) * 180 / Math.PI + 360) % 360;
      hist[Math.min(bins - 1, (hdeg / 5) | 0)] += 1;
      chromatic++;
    }
  }
  if (cloth === 0) return { empty: true, options: o };

  const sm = new Float64Array(bins);
  const k = [1, 2, 3, 2, 1];
  for (let b = 0; b < bins; b++) for (let j = -2; j <= 2; j++) sm[b] += hist[(b + j + bins) % bins] * k[j + 2];
  const peaks = [];
  for (let b = 0; b < bins; b++) {
    const l = sm[(b - 1 + bins) % bins], r = sm[(b + 1) % bins];
    if (sm[b] > 0 && sm[b] >= l && sm[b] > r) {
      let mass = 0; for (let j = -5; j <= 5; j++) mass += hist[(b + j + bins) % bins];
      peaks.push({ hue: b * 5 + 2.5, share: mass / cloth });
    }
  }
  peaks.sort((a, b) => b.share - a.share);
  const materialHues = [];
  for (const p of peaks) {
    if (p.share < o.accentMaxShare) continue;
    if (materialHues.every((h) => angDiff(h, p.hue) > 25)) materialHues.push(p.hue);
  }

  let accent = accentMap(planes, n, materialHues, o, width, height);

  // 2. base lightness from material (non-accent) cloth texels
  const bw = new Float32Array(n);
  const weigh = () => { for (let i = 0; i < n; i++) bw[i] = w[i] * (1 - (o.keepAccents ? accent[i] : 0)); };
  weigh();
  let stats = weightedMedian(L, bw, n) || weightedMedian(L, w, n);
  // 3. the print's neutral ink (black outlines/fill of a coloured logo) belongs to the design
  if (o.keepAccents && o.keepPrintInk) {
    accent = extendWithInk(accent, planes, width, height, stats.median, o);
    weigh();
    stats = weightedMedian(L, bw, n) || stats;
  }
  let useW = bw;
  if (!weightedMedian(L, bw, n)) useW = w;
  const modes = lightnessModes(L, useW, n, o);

  // base chroma (for relative chroma variation)
  let cs = 0, cw = 0;
  for (let i = 0; i < n; i++) if (bw[i] > 0) { cs += Math.hypot(A[i], B[i]) * bw[i]; cw += bw[i]; }

  return {
    empty: false,
    options: o,
    baseL: stats.median,
    p05: stats.p05,
    p95: stats.p95,
    baseC: cw ? cs / cw : 0,
    materialHues,
    modes,
    chromaticShare: chromatic / cloth,
    clothShare: cloth / n,
    _planes: planes,
    _accent: accent,
  };
}

function accentMap(planes, n, materialHues, o, width, height) {
  const { A, B } = planes;
  const acc = new Float32Array(n);
  if (!o.keepAccents) return acc;
  // hue factor: how far this texel's hue is from every material hue
  const hueFactor = (i) => {
    if (!materialHues.length) return 1;
    const hdeg = (Math.atan2(B[i], A[i]) * 180 / Math.PI + 360) % 360;
    let hd = 360; for (const h of materialHues) hd = Math.min(hd, angDiff(h, hdeg));
    return smooth(o.accentHueDistance * 0.75, o.accentHueDistance * 1.35, hd);
  };
  // Hysteresis (like Canny): confident accent texels seed, then the accent grows into
  // connected texels of the same hue family down to a much lower chroma. Distressed /
  // grunge prints are mostly faint, speckled colour (measured: most of a pink print sits
  // at OKLab C 0.02-0.08), which a single threshold + morphological open used to eat.
  const strong = new Uint8Array(n), weak = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const C = Math.hypot(A[i], B[i]);
    if (C < o.accentWeakChroma) continue;
    const hf = hueFactor(i);
    if (hf < 0.5) continue;
    weak[i] = 1;
    if (smooth(o.accentMinChroma, o.accentMinChroma * 1.8, C) * hf >= 0.5) strong[i] = 1;
  }
  if (!width || !height) { for (let i = 0; i < n; i++) acc[i] = strong[i]; return acc; }
  const m = new Uint8Array(n);
  const stack = [];
  for (let i = 0; i < n; i++) if (strong[i]) { m[i] = 1; stack.push(i); }
  while (stack.length) {
    const p = stack.pop(), x = p % width, y = (p / width) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const q = ny * width + nx;
      if (!m[q] && weak[q]) { m[q] = 1; stack.push(q); }
    }
  }
  // Crisp regions (a logo is kept or tinted, never half-blended); only drop lone specks.
  const clean = M.removeSmall(m, width, height, Math.max(3, Math.round(n * 0.000004)));
  return M.boxBlur(M.toFloat(clean), width, height, 1);
}

/**
 * Grow the kept design from its coloured parts into the NEUTRAL ink printed with it
 * (black outlines / fills of a pink logo). Ink = achromatic texels whose tone clearly
 * differs from the fabric base; a whole ink region is taken when it touches a kept
 * accent and is print-sized. On a black garment black is not "different from the
 * fabric", so a logo there never drags the fabric along.
 */
function extendWithInk(accent, planes, w, h, baseL, o, lut = null, modes = null) {
  if (!w || !h) return accent;
  const n = w * h;
  const { L, A, B } = planes;
  const shift = (v) => { if (!lut) return 1; const sz = lut.length - 1; return Math.abs(lut[Math.min(sz, Math.max(0, Math.round(v * sz)))] - v); };
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (accent[i] >= 0.5) continue;
    if (Math.hypot(A[i], B[i]) > o.inkMaxChroma) continue;
    // ink is dark (or near-white) – mid/light greys next to a logo are fabric highlights
    // white ink only counts when the FABRIC is not white itself: on a white hoodie the white
    // around a red crosshair is fabric (keeping it left a white patch next to the print)
    if (!((L[i] <= baseL - o.inkMinContrast && L[i] < 0.32) || (L[i] >= 0.92 && L[i] >= baseL + o.inkMinContrast))) continue;
    if (shift(L[i]) < o.inkMinShift) continue; // recolor keeps it looking the same anyway
    ink[i] = 1;
  }
  const { labels, sizes, count } = M.label(ink, w, h, 1);
  const touch = new Uint8Array(count);
  const near = M.dilate(M.threshold(accent, 0.5), w, h, 2);
  for (let i = 0; i < n; i++) { const l = labels[i]; if (l >= 0 && near[i]) touch[l] = 1; }
  // Printed ink has SHARP edges; a shadow fold that happens to touch a logo fades out
  // gradually. Median lightness step across each region's non-accent border.
  const steps = Array.from({ length: count }, () => []);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = labels[i];
    if (l < 0) continue;
    for (const q of [i - 1, i + 1, i - w, i + w]) {
      if (labels[q] === l || accent[q] >= 0.5) continue;
      // step over 2 px outward (DXT blocks soften a 1 px edge)
      const q2 = q + (q - i);
      const far = q2 >= 0 && q2 < n ? L[q2] : L[q];
      if (steps[l].length < 4000) steps[l].push(Math.abs(far - L[i]));
    }
  }
  const sharp = new Uint8Array(count);
  for (let l = 0; l < count; l++) {
    const st = steps[l];
    if (!st.length) { sharp[l] = 1; continue; } // fully enclosed by the accent: ink inside the print
    st.sort((a, b) => a - b);
    sharp[l] = st[st.length >> 1] >= o.inkMinEdge ? 1 : 0;
    if (!sharp[l]) touch[l] = 0;
  }
  // Per ink tone (dark / white): if most SHARP-edged printed ink of that tone does NOT touch
  // the coloured print, that tone is a design style of its own (a white skeleton that a small
  // red crosshair is drawn over) – the tone curve renders all of it uniformly, and keeping
  // only the bits touching the accent made a mismatched patch. Black ink that exists only
  // inside/around pink logos is kept.
  const firstPx = new Int32Array(count).fill(-1);
  for (let i = 0; i < n; i++) { const l = labels[i]; if (l >= 0 && firstPx[l] < 0) firstPx[l] = i; }
  const tot = [0, 0], tch = [0, 0];
  for (let l = 0; l < count; l++) {
    if (!sharp[l]) continue;
    const c = L[firstPx[l]] >= 0.5 ? 1 : 0;
    tot[c] += sizes[l]; if (touch[l]) tch[c] += sizes[l];
  }
  const toneOwn = [tot[0] > 0 && tch[0] / tot[0] < o.inkTouchShareMin, tot[1] > 0 && tch[1] / tot[1] < o.inkTouchShareMin];
  const ownEl = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (ink[i] && toneOwn[L[i] >= 0.5 ? 1 : 0]) ownEl[i] = 1;
  const out = new Float32Array(n);
  let added = 0;
  for (let i = 0; i < n; i++) {
    if (accent[i] >= 0.5) { out[i] = 1; continue; }
    const l = labels[i];
    if (l >= 0 && touch[l] && sizes[l] <= n * o.inkBlobMaxShare && !ownEl[i]) { out[i] = 1; added++; }
  }
  // Ink is often connected to the fabric's dark shadow folds, so whole regions fail the
  // test above. Pixel level: ink reachable from the coloured print THROUGH ink within a
  // short geodesic distance is part of the print; beyond that it fades out smoothly, so
  // a shadow fold brushing a logo keeps only a soft fade, not the whole fold.
  const D = Math.max(6, Math.round(Math.max(w, h) * o.inkReach));
  const dist = new Int32Array(n).fill(-1);
  let queue = new Int32Array(n), qh = 0, qt = 0;
  const seed = M.threshold(accent, 0.5);
  for (let i = 0; i < n; i++) if (seed[i]) { dist[i] = 0; queue[qt++] = i; }
  while (qh < qt) {
    const p = queue[qh++], d = dist[p];
    if (d >= D) continue;
    const x = p % w, y = (p / w) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const q = ny * w + nx;
      if (dist[q] !== -1 || !ink[q]) continue;
      dist[q] = d + 1; queue[qt++] = q;
    }
  }
  queue = null;
  // ...and only where there is print-like edge activity nearby: flames / strokes are thin
  // (every texel is close to a sharp edge), a shadow fold is wide and smooth
  const { localStd } = require('./padding');
  const ls = localStd(L, w, h, Math.max(3, Math.round(Math.max(w, h) / 250)));
  for (let i = 0; i < n; i++) {
    const d = dist[i];
    if (d <= 0) continue;
    if (ownEl[i]) continue;
    // edge-active (thin strokes, flames) OR near-pure black (solid printed ink); a shadow
    // fold is dark GREY and smooth, so it passes neither
    const inkness = Math.max(smooth(0.025, 0.06, ls[i]), 1 - smooth(0.08, 0.15, L[i]));
    const wgt = (1 - smooth(D * 0.55, D, d)) * inkness;
    if (wgt > out[i]) { out[i] = wgt; added++; }
  }
  // Anything the coloured print fully ENCLOSES (letters inside a pink outline) is print,
  // after bridging the small gaps a distressed / grunge outline has.
  const bridged = M.close(seed, w, h, Math.max(2, Math.round(Math.max(w, h) / 700)));
  // only the COLOURED print can close these loops, so fabric is rarely enclosed
  const filled = M.fillHoles(bridged, w, h, Math.round(n * o.enclosedMaxShare));
  // ...but only texels that are NOT the fabric itself: a red crosshair ring on a black hoodie
  // encloses black FABRIC, which must be recolored with the rest (it left a black blob)
  // Enclosed texels at the fabric's own tone are either FABRIC (the black hoodie inside a red
  // crosshair ring – one solid area, must be recolored) or DISTRESS specks (fabric showing
  // through grunge ink – tiny, part of the print). Tone can't tell them apart; size can.
  const fabricTone = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (filled[i] && !seed[i] && Math.abs(L[i] - baseL) < o.enclosedFabricTol && Math.hypot(A[i], B[i]) <= o.inkMaxChroma) fabricTone[i] = 1;
  }
  const speckMax = Math.max(12, Math.round(n * o.distressSpeckMax));
  const ft = M.label(fabricTone, w, h, 1);
  // ...and a distress speck sits in NEUTRAL INK; the compartments of a crosshair are walled by
  // the coloured lines themselves (keeping those left a black dot inside the crosshair)
  const inkWall = new Int32Array(ft.count), colWall = new Int32Array(ft.count);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = ft.labels[i];
    if (l < 0 || ft.sizes[l] > speckMax) continue;
    for (const q of [i - 1, i + 1, i - w, i + w]) {
      if (fabricTone[q]) continue;
      if (seed[q]) colWall[l]++;
      // walls of ink that is its own design (a skeleton a crosshair is drawn over) don't make a
      // fabric speck part of the coloured print (it left a white fabric speck in the crosshair)
      else if (ink[q] && !ownEl[q]) inkWall[l]++;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!filled[i] || seed[i] || out[i] >= 1 || ownEl[i]) continue;
    if (fabricTone[i]) { const l = ft.labels[i]; if (ft.sizes[l] > speckMax || inkWall[l] <= colWall[l]) continue; } // enclosed fabric
    if (!fabricTone[i] && Math.hypot(A[i], B[i]) <= o.inkMaxChroma && shift(L[i]) < o.inkMinShift) continue;
    out[i] = 1; added++;
  }
  if (!added) return accent;
  return M.boxBlur(out, w, h, 1);
}

/** Full kept-design mask for any mip level: coloured accents + their neutral ink. */
function designMask(planes, n, plan, width, height, color) {
  const o = plan.options;
  const acc = accentMap(planes, n, plan.materialHues, o, width, height);
  if (!(o.keepAccents && o.keepPrintInk)) return acc;
  // with the target known: only ink the tone curve would visibly CHANGE needs keeping.
  // Black ink turning brown on a grey hoodie – yes; white ribs that come out near-white
  // anyway – no (keeping them pure white next to cream-tinted ribs made a visible patch)
  let lut = null;
  if (color) {
    const target = Array.isArray(color) && color.length === 3 && color[0] <= 1.5 ? color : srgb8ToOklab(...parseHex(color));
    lut = buildToneCurve(plan.modes && plan.modes.length ? plan.modes : [{ Lb: plan.baseL, down: 0.05, up: 0.05, share: 1 }], target[0], o);
  }
  const full = extendWithInk(acc, planes, width, height, plan.baseL, o, lut, plan.modes);
  const res = full === acc ? Float32Array.from(acc) : full;
  res.colorPart = acc; // the coloured print alone (for edge unmixing in apply)
  return res;
}

/**
 * Lightness "materials": modes of the cloth lightness histogram (e.g. black suit,
 * white shirt, grey tie). Each mode gets its own anchor in the tone curve so its
 * internal detail survives even when another material dominates the texture.
 */
function lightnessModes(L, weights, n, o) {
  const bins = 256;
  const h = new Float64Array(bins);
  let tot = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i]; if (w <= 0) continue;
    h[Math.min(bins - 1, Math.max(0, (L[i] * bins) | 0))] += w; tot += w;
  }
  if (tot <= 0) return [];
  const sm = new Float64Array(bins);
  const R = 6, sig = 3;
  for (let b = 0; b < bins; b++) {
    let acc = 0, ws = 0;
    for (let k = -R; k <= R; k++) { const j = b + k; if (j < 0 || j >= bins) continue; const g = Math.exp(-(k * k) / (2 * sig * sig)); acc += h[j] * g; ws += g; }
    sm[b] = acc / ws;
  }
  // basins between local minima
  let cuts = [0];
  for (let b = 1; b < bins - 1; b++) if (sm[b] < sm[b - 1] && sm[b] <= sm[b + 1]) cuts.push(b);
  cuts.push(bins);
  let basins = [];
  for (let i = 0; i + 1 < cuts.length; i++) basins.push({ a: cuts[i], b: cuts[i + 1] });
  const stat = (bs) => {
    let mass = 0; for (let b = bs.a; b < bs.b; b++) mass += h[b];
    const q = (p) => { let acc = 0; for (let b = bs.a; b < bs.b; b++) { acc += h[b]; if (acc >= mass * p) return (b + 0.5) / bins; } return (bs.b - 0.5) / bins; };
    return { ...bs, share: mass / tot, Lb: q(0.5), lo: q(0.1), hi: q(0.9) };
  };
  basins = basins.map(stat).filter((x) => x.share > 0);
  // merge weak / too-close basins into their closest neighbour
  for (;;) {
    let worst = -1, worstScore = Infinity;
    for (let i = 0; i < basins.length; i++) {
      const x = basins[i];
      const gapL = i > 0 ? x.Lb - basins[i - 1].Lb : Infinity;
      const gapR = i + 1 < basins.length ? basins[i + 1].Lb - x.Lb : Infinity;
      const bad = x.share < o.materialMinShare || Math.min(gapL, gapR) < o.materialMinGap;
      if (bad && basins.length > 1 && x.share < worstScore) { worst = i; worstScore = x.share; }
    }
    if (worst < 0) break;
    const x = basins[worst];
    const left = worst > 0 ? basins[worst - 1] : null, right = worst + 1 < basins.length ? basins[worst + 1] : null;
    const into = !left ? worst + 1 : !right ? worst - 1 : (x.Lb - left.Lb <= right.Lb - x.Lb ? worst - 1 : worst + 1);
    const lo = Math.min(worst, into), hi = Math.max(worst, into);
    basins.splice(lo, 2, stat({ a: basins[lo].a, b: basins[hi].b }));
  }
  return basins.map(({ Lb, lo, hi, share }) => ({ Lb, down: Math.min(0.25, Math.max(0.01, Lb - lo)), up: Math.min(0.25, Math.max(0.01, hi - Lb)), share }));
}

/**
 * Build a monotonic tone curve (LUT over L 0..1) mapping every lightness material to
 * the target: the dominant material's median lands exactly on the target lightness,
 * other materials keep their tonal order and separation (compressed only as much as
 * the available headroom requires), and inside each material the detail slope stays
 * as close to 1 as possible. Monotonic by construction -> shading never inverts.
 */
function buildToneCurveCore(modes, Lt, o) {
  const size = 2048;
  const lut = new Float32Array(size + 1);
  if (!modes.length) { for (let i = 0; i <= size; i++) lut[i] = Lt; return lut; }
  const m = modes.length;
  let dom = 0; for (let k = 1; k < m; k++) if (modes[k].share > modes[dom].share) dom = k;
  const gap = 0.015;
  const minL = o.minL, maxL = o.maxL;
  const con = o.contrast;
  // per-side detail compression c so all materials fit in the headroom
  const fit = (avail, spreads, gaps) => spreads <= 1e-6 ? 1 : Math.max(o.minDetail, Math.min(1, (avail - gaps) / spreads));
  let spUp = modes[dom].up * con, gUp = 0;
  for (let k = dom + 1; k < m; k++) { spUp += (modes[k].down + modes[k].up) * con; gUp += gap; }
  let spDn = modes[dom].down * con, gDn = 0;
  for (let k = dom - 1; k >= 0; k--) { spDn += (modes[k].down + modes[k].up) * con; gDn += gap; }
  const cUp = fit(maxL - Lt, spUp, gUp) * con, cDn = fit(Lt - minL, spDn, gDn) * con;

  const T = new Array(m);
  T[dom] = Lt;
  const sep = o.materialSeparation;
  for (let k = dom + 1; k < m; k++) {
    const want = Lt + softKnee((modes[k].Lb - modes[dom].Lb) * sep, maxL - Lt, o.knee);
    let lowB = T[k - 1] + (k - 1 === dom ? cUp : cUp) * modes[k - 1].up + cUp * modes[k].down + gap;
    let rest = 0; for (let j = k + 1; j < m; j++) rest += gap + cUp * (modes[j].down + modes[j].up);
    const highB = maxL - cUp * modes[k].up - rest;
    T[k] = Math.max(lowB, Math.min(want, highB));
  }
  for (let k = dom - 1; k >= 0; k--) {
    const want = Lt - softKnee((modes[dom].Lb - modes[k].Lb) * sep, Lt - minL, o.knee);
    const highB = T[k + 1] - cDn * modes[k + 1].down - cDn * modes[k].up - gap;
    let rest = 0; for (let j = k - 1; j >= 0; j--) rest += gap + cDn * (modes[j].down + modes[j].up);
    const lowB = minL + cDn * modes[k].down + rest;
    T[k] = Math.min(highB, Math.max(want, lowB));
  }
  // control points
  const pts = [];
  for (let k = 0; k < m; k++) {
    const cd = k <= dom ? cDn : cUp, cu = k >= dom ? cUp : cDn;
    pts.push([modes[k].Lb - modes[k].down, T[k] - cd * modes[k].down]);
    pts.push([modes[k].Lb, T[k]]);
    pts.push([modes[k].Lb + modes[k].up, T[k] + cu * modes[k].up]);
  }
  // enforce strictly increasing x and non-decreasing y
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= pts[i - 1][0]) pts[i][0] = pts[i - 1][0] + 1e-4;
    if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
  }
  const [x0, y0] = pts[0], [x1, y1] = pts[pts.length - 1];
  let seg = 0;
  for (let i = 0; i <= size; i++) {
    const x = i / size;
    let y;
    if (x <= x0) y = y0 - softKnee(cDn * (x0 - x), Math.max(0, y0 - minL), o.knee);
    else if (x >= x1) y = y1 + softKnee(cUp * (x - x1), Math.max(0, maxL - y1), o.knee);
    else {
      while (seg + 1 < pts.length && pts[seg + 1][0] < x) seg++;
      const [ax, ay] = pts[seg], [bx, by] = pts[Math.min(seg + 1, pts.length - 1)];
      y = bx > ax ? ay + (by - ay) * (x - ax) / (bx - ax) : ay;
    }
    lut[i] = Math.max(minL, Math.min(maxL, y));
  }
  for (let i = 1; i <= size; i++) if (lut[i] < lut[i - 1]) lut[i] = lut[i - 1];
  return lut;
}

function softKnee(x, headroom, knee) {
  if (headroom <= 1e-4) return 0;
  const k = headroom * knee;
  if (x <= k) return x;
  const r = headroom - k;
  return k + r * (1 - Math.exp(-(x - k) / r));
}

/**
 * Tone curve with "crowded material" flipping: when a print sits on the side of the fabric
 * that has no headroom left (white skeleton on a hoodie being dyed WHITE, black print on one
 * dyed BLACK), keeping the tonal order squeezes it onto the fabric and the design vanishes.
 * Such an outermost material is moved to the other side instead (white print -> grey on a white
 * hoodie). Shading inside fabric and inside print keeps its direction; only the jump between
 * them reverses, which only affects the few anti-aliased edge texels.
 */
function buildToneCurve(modes, Lt, o) {
  const base = buildToneCurveCore(modes, Lt, o);
  if (!o.flipCrowded || modes.length < 2) return base;
  const size = base.length - 1;
  const at = (lut, x) => lut[Math.min(size, Math.max(0, Math.round(x * size)))];
  let dom = 0; for (let k = 1; k < modes.length; k++) if (modes[k].share > modes[dom].share) dom = k;
  const flips = [];
  for (const k of [0, modes.length - 1]) {
    if (k === dom) continue;
    const up = modes[k].Lb > modes[dom].Lb;
    const sep = Math.abs(at(base, modes[k].Lb) - at(base, modes[dom].Lb));
    const otherRoom = up ? Lt - o.minL : o.maxL - Lt;
    if (sep < o.minMaterialSep && otherRoom > o.flipOffset + 0.05) flips.push({ k, up });
  }
  if (!flips.length) return base;
  const keep = modes.filter((_, k) => !flips.some((f) => f.k === k));
  const lut = buildToneCurveCore(keep, Lt, o);
  for (const { k, up } of flips) {
    const m = modes[k];
    const Tf = up ? Lt - o.flipOffset : Lt + o.flipOffset;
    const slope = 0.8;
    // neighbour band edge (last texel of the nearest kept material on the fabric side)
    const nb = up ? Math.max(...keep.filter((q) => q.Lb < m.Lb).map((q) => q.Lb + q.up))
      : Math.min(...keep.filter((q) => q.Lb > m.Lb).map((q) => q.Lb - q.down));
    const bandStart = up ? m.Lb - m.down : m.Lb + m.up;
    for (let i = 0; i <= size; i++) {
      const x = i / size;
      if (up ? x >= bandStart : x <= bandStart) lut[i] = Math.max(o.minL, Math.min(o.maxL, Tf + slope * (x - m.Lb)));
      else if (up ? x > nb : x < nb) {
        const t = (x - nb) / (bandStart - nb);
        const a = at(lut, nb), b = Tf + slope * (bandStart - m.Lb);
        lut[i] = a + (b - a) * Math.max(0, Math.min(1, t));
      }
    }
  }
  return lut;
}

/** Map one OKLab texel through the plan -> tinted OKLab. */
function makeTinter(plan, target) {
  const o = plan.options;
  const [Lt, at, bt] = target;
  const Ct = Math.hypot(at, bt);
  const lut = buildToneCurve(plan.modes && plan.modes.length ? plan.modes : [{ Lb: plan.baseL, down: 0.05, up: 0.05, share: 1 }], Lt, o);
  const size = lut.length - 1;
  return (L, a, b, out) => {
    const x = Math.max(0, Math.min(1, L)) * size;
    const i0 = Math.floor(x), f = x - i0;
    const Ln = i0 >= size ? lut[size] : lut[i0] + (lut[i0 + 1] - lut[i0]) * f;
    let g = Ln <= Lt ? Math.pow(Math.max(0, Ln) / Lt, o.chromaFalloff) : Math.pow(Math.max(0, 1 - Ln) / (1 - Lt), o.chromaFalloff);
    // only meaningful when the source material is clearly coloured; on grey/black
    // fabric the source chroma is just compression noise and must not be amplified
    if (o.keepChromaVariation && plan.baseC > 0.04 && Ct > 1e-4) {
      const rel = Math.hypot(a, b) / plan.baseC; // 1 = as saturated as the base material
      g *= 1 + o.keepChromaVariation * (Math.min(2, rel) - 1);
    }
    out[0] = Ln; out[1] = at * Math.max(0, g); out[2] = bt * Math.max(0, g);
  };
}

/**
 * Apply a plan to RGBA8 pixels (any mip level).
 * @param {Uint8Array} rgba
 * @param {Float32Array|null} protect   same size as this level
 * @param {object} plan  from analyze()
 * @param {string|number[]} color  '#d3ac92' or OKLab triple
 * @param {{planes?:object, accent?:Float32Array}} cache
 */
function apply(rgba, width, height, protect, plan, color, cache = {}) {
  const n = width * height;
  const out = Uint8Array.from(rgba);
  if (plan.empty) return out;
  const o = plan.options;
  const target = Array.isArray(color) && color.length === 3 && color[0] <= 1.5 ? color : srgb8ToOklab(...parseHex(color));
  const planes = cache.planes || rgbaToOklabPlanes(rgba, n);
  const accent = cache.accent || designMask(planes, n, plan, width, height, target);
  const tint = makeTinter(plan, target);
  const lab = [0, 0, 0], rgb = new Uint8Array(3);
  const memo = new Map();
  const tinted = (i) => {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let t = memo.get(key);
    if (t === undefined) {
      tint(planes.L[i], planes.A[i], planes.B[i], lab);
      oklabToSrgb8(lab[0], lab[1], lab[2], rgb, 0);
      t = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      if (memo.size < 300000) memo.set(key, t);
    }
    return t;
  };
  // Edge UNMIXING for kept coloured prints: an anti-aliased edge texel is part print colour,
  // part fabric. Keeping it as-is left a pale fringe (red crosshair drawn on WHITE fabric, hoodie
  // dyed red). Its print share alpha = its chroma relative to the print's core colour next to it;
  // result = alpha * core + (1 - alpha) * recoloured fabric.
  const colorPart = o.keepAccents && accent && accent.colorPart ? accent.colorPart : null;
  const C = (i) => Math.hypot(planes.A[i], planes.B[i]);
  const unmixed = new Map();
  if (colorPart) {
    for (let i = 0; i < n; i++) {
      const cp = colorPart[i];
      if (cp <= 0.02 || (protect && protect[i] >= 0.5)) continue;
      if (accent[i] > cp + 0.05) continue; // also kept as ink (black letters): leave original
      const x = i % width, y = (i / width) | 0;
      let core = -1, cC = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx;
        if (colorPart[q] < 0.5) continue;
        const c = C(q); if (c > cC) { cC = c; core = q; }
      }
      if (core < 0 || cC < o.accentMinChroma) continue;
      const alpha = Math.max(0, Math.min(1, (C(i) / cC - 0.15) / 0.75));
      if (alpha >= 0.98) continue; // core texel: keep as is
      unmixed.set(i, { alpha, core });
    }
  }
  // The same for the soft border of every other kept print (black ink, white print): the
  // softened accent mask reaches past the ink onto pure fabric texels, which were then only
  // partly dyed (pale pink specks on white fabric beside a black line on a red hoodie). Each
  // border texel is projected onto the line fabric -> ink between its nearest undyed fabric
  // texel and its strongest kept texel: fabric gets fully dyed, a real AA texel keeps its ink share.
  if (o.keepAccents && accent) {
    const { L, A, B } = planes;
    for (let i = 0; i < n; i++) {
      const a = accent[i];
      if (a <= 0.02 || a >= 0.95 || unmixed.has(i) || (protect && protect[i] >= 0.5)) continue;
      const x = i % width, y = (i / width) | 0;
      // fabric = least-kept texel around (inside a dense print pocket it is still partly kept)
      let core = -1, ca = 0, fab = -1, fa = 0.3, fd = Infinity;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const q = yy * width + xx;
        if (accent[q] > ca) { ca = accent[q]; core = q; }
        const d = dx * dx + dy * dy;
        if (accent[q] < fa - 0.02 || (accent[q] <= fa + 0.02 && d < fd)) { fa = accent[q]; fd = d; fab = q; }
      }
      if (core < 0 || fab < 0 || ca < 0.8) continue;
      const vx = L[core] - L[fab], vy = A[core] - A[fab], vz = B[core] - B[fab];
      const len2 = vx * vx + vy * vy + vz * vz;
      if (len2 < 0.01) continue; // ink ~ fabric colour: nothing to separate
      const alpha = Math.max(0, Math.min(1, ((L[i] - L[fab]) * vx + (A[i] - A[fab]) * vy + (B[i] - B[fab]) * vz) / len2));
      unmixed.set(i, { alpha: Math.min(alpha, a), core });
    }
  }
  for (let i = 0; i < n; i++) {
    const um = unmixed.get(i);
    if (um) {
      const t = tinted(i);
      const tr = (t >> 16) & 255, tg = (t >> 8) & 255, tb = t & 255;
      const c = um.core, a = um.alpha;
      const mixS = o.strength;
      const nr = a * rgba[c * 4] + (1 - a) * tr, ng = a * rgba[c * 4 + 1] + (1 - a) * tg, nb = a * rgba[c * 4 + 2] + (1 - a) * tb;
      out[i * 4] = Math.round(rgba[i * 4] + (nr - rgba[i * 4]) * mixS);
      out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] + (ng - rgba[i * 4 + 1]) * mixS);
      out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] + (nb - rgba[i * 4 + 2]) * mixS);
      continue;
    }
    const p = protect ? protect[i] : 0;
    const keep = Math.max(p, o.keepAccents ? accent[i] : 0);
    const mix = (1 - keep) * o.strength;
    if (mix <= 0.002) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const t = tinted(i);
    const tr = (t >> 16) & 255, tg = (t >> 8) & 255, tb = t & 255;
    out[i * 4] = Math.round(r + (tr - r) * mix);
    out[i * 4 + 1] = Math.round(g + (tg - g) * mix);
    out[i * 4 + 2] = Math.round(b + (tb - b) * mix);
  }
  return out;
}

/** One-shot convenience: analyse + apply at a single resolution. */
function recolorRGBA(rgba, width, height, color, { protect = null, ignore = undefined, ...options } = {}) {
  if (ignore === undefined) {
    const { paddingFromImage } = require('./padding');
    const pad = paddingFromImage(rgba, rgbaToOklabPlanes(rgba, width * height), width, height);
    ignore = pad ? pad.mask : null;
  }
  const plan = analyze(rgba, width, height, protect, options, { ignore });
  const pixels = apply(rgba, width, height, protect, plan, color, { planes: plan._planes });
  return { pixels, plan: publicPlan(plan) };
}

function publicPlan(plan) {
  if (plan.empty) return { empty: true };
  const { baseL, p05, p95, baseC, materialHues, modes, chromaticShare, clothShare } = plan;
  return { baseL, p05, p95, baseC, materialHues, modes, chromaticShare, clothShare };
}

module.exports = { DEFAULTS, analyze, apply, recolorRGBA, publicPlan, accentMap, designMask, extendWithInk, lightnessModes, buildToneCurve };
