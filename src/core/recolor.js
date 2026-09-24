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
  minDetail: 0.35,            // never compress in-material detail below this slope
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
function extendWithInk(accent, planes, w, h, baseL, o) {
  if (!w || !h) return accent;
  const n = w * h;
  const { L, A, B } = planes;
  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (accent[i] >= 0.5) continue;
    if (Math.hypot(A[i], B[i]) > o.inkMaxChroma) continue;
    // ink is dark (or near-white) – mid/light greys next to a logo are fabric highlights
    if ((L[i] <= baseL - o.inkMinContrast && L[i] < 0.32) || L[i] >= 0.92) ink[i] = 1;
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
    if (l < 0 || !touch[l]) continue;
    for (const q of [i - 1, i + 1, i - w, i + w]) {
      if (labels[q] === l || accent[q] >= 0.5) continue;
      // step over 2 px outward (DXT blocks soften a 1 px edge)
      const q2 = q + (q - i);
      const far = q2 >= 0 && q2 < n ? L[q2] : L[q];
      if (steps[l].length < 4000) steps[l].push(Math.abs(far - L[i]));
    }
  }
  for (let l = 0; l < count; l++) {
    if (!touch[l]) continue;
    const st = steps[l];
    if (!st.length) continue; // fully enclosed by the accent: ink inside the print
    st.sort((a, b) => a - b);
    if (st[st.length >> 1] < o.inkMinEdge) touch[l] = 0;
  }
  const out = new Float32Array(n);
  let added = 0;
  for (let i = 0; i < n; i++) {
    if (accent[i] >= 0.5) { out[i] = 1; continue; }
    const l = labels[i];
    if (l >= 0 && touch[l] && sizes[l] <= n * o.inkBlobMaxShare) { out[i] = 1; added++; }
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
  for (let i = 0; i < n; i++) if (filled[i] && !seed[i] && out[i] < 1) { out[i] = 1; added++; }
  if (!added) return accent;
  return M.boxBlur(out, w, h, 1);
}

/** Full kept-design mask for any mip level: coloured accents + their neutral ink. */
function designMask(planes, n, plan, width, height) {
  const o = plan.options;
  const acc = accentMap(planes, n, plan.materialHues, o, width, height);
  return o.keepAccents && o.keepPrintInk ? extendWithInk(acc, planes, width, height, plan.baseL, o) : acc;
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
function buildToneCurve(modes, Lt, o) {
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
  const accent = cache.accent || designMask(planes, n, plan, width, height);
  const tint = makeTinter(plan, target);
  const lab = [0, 0, 0], rgb = new Uint8Array(3);
  const memo = new Map();
  for (let i = 0; i < n; i++) {
    const p = protect ? protect[i] : 0;
    const keep = Math.max(p, o.keepAccents ? accent[i] : 0);
    const mix = (1 - keep) * o.strength;
    if (mix <= 0.002) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = (r << 16) | (g << 8) | b;
    let t = memo.get(key);
    if (t === undefined) {
      tint(planes.L[i], planes.A[i], planes.B[i], lab);
      oklabToSrgb8(lab[0], lab[1], lab[2], rgb, 0);
      t = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
      if (memo.size < 300000) memo.set(key, t);
    }
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
  const pixels = apply(rgba, width, height, protect, plan, color, { planes: plan._planes, accent: plan._accent });
  return { pixels, plan: publicPlan(plan) };
}

function publicPlan(plan) {
  if (plan.empty) return { empty: true };
  const { baseL, p05, p95, baseC, materialHues, modes, chromaticShare, clothShare } = plan;
  return { baseL, p05, p95, baseC, materialHues, modes, chromaticShare, clothShare };
}

module.exports = { DEFAULTS, analyze, apply, recolorRGBA, publicPlan, accentMap, designMask, extendWithInk, lightnessModes, buildToneCurve };
