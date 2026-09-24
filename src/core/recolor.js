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

  const accent = accentMap(planes, n, materialHues, o, width, height);

  // 2. base lightness from material (non-accent) cloth texels
  const bw = new Float32Array(n);
  for (let i = 0; i < n; i++) bw[i] = w[i] * (1 - (o.keepAccents ? accent[i] : 0));
  let useW = bw;
  let stats = weightedMedian(L, bw, n);
  if (!stats) { useW = w; stats = weightedMedian(L, w, n); }
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
  for (let i = 0; i < n; i++) {
    const C = Math.hypot(A[i], B[i]);
    const cf = smooth(o.accentMinChroma, o.accentMinChroma * 1.8, C);
    if (cf <= 0) continue;
    let hd = 180;
    if (materialHues.length) {
      const hdeg = (Math.atan2(B[i], A[i]) * 180 / Math.PI + 360) % 360;
      hd = 360; for (const h of materialHues) hd = Math.min(hd, angDiff(h, hdeg));
    }
    acc[i] = cf * smooth(o.accentHueDistance * 0.75, o.accentHueDistance * 1.35, hd);
  }
  if (!width || !height) return acc;
  // Crisp regions: a logo is either kept or tinted, never half-blended (that reads as a stain).
  let m = M.threshold(acc, 0.5);
  m = M.open(m, width, height, 1);
  m = M.removeSmall(m, width, height, Math.max(6, Math.round(n * 0.00003)));
  return M.boxBlur(M.toFloat(m), width, height, 1);
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
  const accent = cache.accent || accentMap(planes, n, plan.materialHues, o, width, height);
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

module.exports = { DEFAULTS, analyze, apply, recolorRGBA, publicPlan, accentMap, lightnessModes, buildToneCurve };
