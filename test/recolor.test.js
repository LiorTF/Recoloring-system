'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { image, fabric, makeYtd, FMT, rng } = require('./helpers');
const { recolorFiles, recolorRGBA, formats } = require('../src');
const { readRsc7, readYtd, decodeMip, encodeMip } = formats;
const { srgb8ToOklab } = require('../src/color/oklab');
const { mipByteSize } = require('../src/formats/texfmt');
const { buildToneCurve, DEFAULTS } = require('../src/core/recolor');

const TARGET = '#d3ac92';
const T_LAB = srgb8ToOklab(0xd3, 0xac, 0x92);
const SKIN = [224, 168, 138];
const TATTOO = [38, 62, 74];
const labAt = (px, i) => srgb8ToOklab(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
const dE = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
function median(arr) { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; }

function decodeFirst(buf, name) {
  const t = readYtd(readRsc7(buf)).find((x) => !name || x.name === name);
  const m = t.mips[0];
  return { t, px: decodeMip(t.format, t.data.subarray(0, m.size), m.width, m.height) };
}

test('BC1 / BC3 / BC7 re-encode keeps detail (PSNR)', () => {
  const r = rng(7);
  const w = 64, h = 64;
  const src = image(w, h, (x, y) => [x * 4, y * 4, ((x ^ y) & 8) ? 200 : 60 + r() * 20, 255]);
  for (const fmt of [FMT.DXT1, FMT.DXT5, FMT.BC7]) {
    const buf = new Uint8Array(mipByteSize(fmt, w, h));
    encodeMip(fmt, src, w, h, buf, null);
    const back = decodeMip(fmt, buf, w, h);
    let se = 0; for (let i = 0; i < src.length; i += 4) for (let c = 0; c < 3; c++) se += (src[i + c] - back[i + c]) ** 2;
    const psnr = 10 * Math.log10(65025 / (se / (w * h * 3)));
    assert.ok(psnr > (fmt === FMT.BC7 ? 36 : 30), `format ${fmt} psnr ${psnr.toFixed(1)}`);
  }
});

test('tone curve is monotonic and lands the dominant material on the target', () => {
  const modes = [{ Lb: 0.12, down: 0.04, up: 0.06, share: 0.6 }, { Lb: 0.55, down: 0.05, up: 0.05, share: 0.15 }, { Lb: 0.93, down: 0.12, up: 0.04, share: 0.25 }];
  const lut = buildToneCurve(modes, T_LAB[0], DEFAULTS);
  for (let i = 1; i < lut.length; i++) assert.ok(lut[i] >= lut[i - 1]);
  assert.ok(Math.abs(lut[Math.round(0.12 * 2048)] - T_LAB[0]) < 0.005);
  // materials keep their order and stay distinguishable
  assert.ok(lut[Math.round(0.55 * 2048)] - lut[Math.round(0.12 * 2048)] > 0.03);
  assert.ok(lut[Math.round(0.93 * 2048)] - lut[Math.round(0.55 * 2048)] > 0.03);
});

test('black hoodie -> target: base hits the colour, folds and white print survive', () => {
  const w = 128, h = 128;
  const noise = fabric([30, 30, 32], 18, 3);
  const src = image(w, h, (x, y) => {
    if ((x - 64) ** 2 + (y - 64) ** 2 < 20 ** 2) return [235, 235, 235];
    const fold = Math.sin(x / 6) * 10;
    return noise().map((v) => Math.max(0, v + fold));
  });
  const { pixels } = recolorRGBA(src, w, h, TARGET);
  const clothL = [], printL = [], srcClothL = [];
  const clothDE = [];
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i / w) | 0;
    const inPrint = (x - 64) ** 2 + (y - 64) ** 2 < 17 ** 2;
    const out = labAt(pixels, i);
    if (inPrint) printL.push(out[0]);
    else if ((x - 64) ** 2 + (y - 64) ** 2 > 24 ** 2) { clothL.push(out[0]); srcClothL.push(labAt(src, i)[0]); clothDE.push(dE(out, T_LAB)); }
  }
  assert.ok(median(clothDE) < 0.03, `cloth median dE ${median(clothDE)}`);
  assert.ok(median(printL) > median(clothL) + 0.08, 'white print must stay lighter than the fabric');
  // detail: output lightness spread comparable to source spread
  const spread = (a) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length * 0.9)] - s[Math.floor(s.length * 0.1)]; };
  assert.ok(spread(clothL) > spread(srcClothL) * 0.6, `detail lost: ${spread(clothL)} vs ${spread(srcClothL)}`);
});

function makePed() {
  const r = rng(11);
  const skinPx = () => SKIN.map((v) => v + Math.round((r() - 0.5) * 14));
  // head: skin with brows + eyes (non-skin details the model must ignore)
  const head = image(128, 128, (x, y) => (y > 30 && y < 36 && x > 30 && x < 98 ? [40, 30, 25] : (y > 44 && y < 52 && (x % 40) < 12 ? [240, 240, 240] : skinPx())));
  // top (_whi): black fabric left, khaki pocket strip, skin arm right with a tattoo inside the skin
  const cloth = fabric([28, 28, 30], 16, 5);
  const top = image(128, 128, (x, y) => {
    if (x >= 72) {
      if ((x - 100) ** 2 + (y - 64) ** 2 < 10 ** 2) return TATTOO;
      return skinPx();
    }
    if (y >= 90 && y < 110 && x < 64) return [150, 130, 80];
    return cloth();
  });
  // glasses: black frame + semi-transparent lens
  const glasses = image(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 < 18 ** 2 ? [60, 70, 80, 110] : [20, 20, 20, 255]));
  return { head, top, glasses };
}

test('ped pipeline: recolors cloth, keeps skin + tattoo + lens, output re-parses', async () => {
  const p = makePed();
  const files = [
    { path: 'testped^head_diff_000_a_whi.ytd', buffer: makeYtd([{ name: 'head_diff_000_a_whi', width: 128, height: 128, format: FMT.DXT1, rgba: p.head }]) },
    { path: 'testped^uppr_diff_000_a_whi.ytd', buffer: makeYtd([{ name: 'uppr_diff_000_a_whi', width: 128, height: 128, format: FMT.DXT1, rgba: p.top, levels: 4 }]) },
    { path: 'testped^p_eyes_diff_000_a.ytd', buffer: makeYtd([{ name: 'p_eyes_diff_000_a', width: 64, height: 64, format: FMT.DXT5, rgba: p.glasses }]) },
    { path: 'testped^uppr_normal_000.ytd', buffer: makeYtd([{ name: 'uppr_normal_000', width: 64, height: 64, format: FMT.DXT1, rgba: image(64, 64, () => [128, 128, 255]) }]) },
  ];
  const { files: out, report } = await recolorFiles(files, { color: TARGET });
  const get = (n) => out.find((f) => f.path.includes(n));

  assert.strictEqual(get('head_diff').changed, false, 'head must never change');
  assert.strictEqual(get('uppr_normal').changed, false, 'normal maps must never change');
  assert.strictEqual(get('uppr_diff').changed, true);

  const before = decodeFirst(files[1].buffer).px;
  const { px: after, t } = decodeFirst(get('uppr_diff').buffer);
  assert.strictEqual(t.levels, 4, 'mip chain preserved');
  const diff = (i) => Math.max(...[0, 1, 2].map((c) => Math.abs(before[i * 4 + c] - after[i * 4 + c])));
  const skinD = [], tatD = [], clothDE = [], khakiDE = [];
  for (let y = 4; y < 124; y++) for (let x = 0; x < 128; x++) {
    const i = y * 128 + x;
    if (x >= 80 && (x - 100) ** 2 + (y - 64) ** 2 > 13 ** 2) skinD.push(diff(i));
    if ((x - 100) ** 2 + (y - 64) ** 2 < 7 ** 2) tatD.push(diff(i));
    if (x < 60 && (y < 86 || y > 114)) clothDE.push(dE(labAt(after, i), T_LAB));
    if (x < 60 && y >= 94 && y < 106) khakiDE.push(dE(labAt(after, i), labAt(before, i)));
  }
  assert.ok(median(skinD) <= 2, `skin changed: ${median(skinD)}`);
  assert.ok(median(tatD) <= 2, `tattoo changed: ${median(tatD)}`);
  assert.ok(median(clothDE) < 0.04, `cloth not at target: ${median(clothDE)}`);
  assert.ok(median(khakiDE) > 0.05, 'khaki fabric must be recolored, not mistaken for skin');

  const g0 = decodeFirst(files[2].buffer).px, g1 = decodeFirst(get('p_eyes').buffer).px;
  const lensD = [], frameDE = [];
  for (let i = 0; i < 64 * 64; i++) {
    const x = i % 64, y = (i / 64) | 0, d2 = (x - 32) ** 2 + (y - 32) ** 2;
    if (d2 < 14 ** 2) lensD.push(Math.abs(g0[i * 4] - g1[i * 4]) + Math.abs(g0[i * 4 + 3] - g1[i * 4 + 3]));
    if (d2 > 22 ** 2) frameDE.push(dE(labAt(g1, i), labAt(g0, i)));
  }
  assert.ok(median(lensD) <= 2, 'lens must stay untouched');
  assert.ok(median(frameDE) > 0.2, 'frame must be recolored');
  assert.ok(report.textures.some((x) => x.status === 'recolored'));
});

test('race variants: skin found by diffing _whi vs _bla, cloth identical across variants', async () => {
  const r = rng(5);
  const cloth = fabric([40, 60, 110], 14, 9); // blue cloth
  const clothPx = image(128, 128, () => cloth());
  const make = (skinTone) => { const rr = rng(2); return image(128, 128, (x, y, i = y * 128 + x) => (y < 48 ? skinTone.map((v) => v + Math.round((rr() - 0.5) * 10)) : [...clothPx.subarray(i * 4, i * 4 + 3)])); };
  const whi = make([226, 176, 150]), bla = make([96, 60, 44]);
  void r;
  const files = [
    { path: 'p2^uppr_diff_001_a_whi.ytd', buffer: makeYtd([{ name: 'uppr_diff_001_a_whi', width: 128, height: 128, format: FMT.DXT1, rgba: whi }]) },
    { path: 'p2^uppr_diff_001_a_bla.ytd', buffer: makeYtd([{ name: 'uppr_diff_001_a_bla', width: 128, height: 128, format: FMT.DXT1, rgba: bla }]) },
  ];
  const { files: out, report } = await recolorFiles(files, { color: TARGET });
  const rep = report.textures.find((x) => x.texture === 'uppr_diff_001_a_bla');
  assert.strictEqual(rep.skinSource, 'race-diff');
  for (const k of [0, 1]) {
    const b = decodeFirst(files[k].buffer).px, a = decodeFirst(out[k].buffer).px;
    let sk = 0, n = 0; for (let i = 0; i < 128 * 40; i++) { sk += Math.abs(a[i * 4] - b[i * 4]); n++; }
    assert.ok(sk / n < 2, 'skin rows untouched');
  }
  const a0 = decodeFirst(out[0].buffer).px, a1 = decodeFirst(out[1].buffer).px;
  let d = 0; for (let i = 128 * 60; i < 128 * 128; i++) d += Math.abs(a0[i * 4] - a1[i * 4]);
  assert.ok(d / (128 * 68) < 1.5, 'the same cloth must come out identical for every skin tone');
});

test('UV padding is ignored, but a flat black garment with a flat print is still the garment', () => {
  const w = 128, h = 128;
  const r = rng(21);
  // shaded dark-grey shirt island on flat black padding
  const padded = image(w, h, (x, y) => (x > 20 && x < 108 && y > 20 && y < 108 ? [50 + Math.sin(x / 5) * 12 + (r() - 0.5) * 10, 50 + Math.sin(x / 5) * 12, 52, 255].map(Math.round) : [0, 0, 0, 255]));
  const a = recolorRGBA(padded, w, h, TARGET).pixels;
  const island = [];
  for (let y = 30; y < 98; y++) for (let x = 30; x < 98; x++) island.push(dE(labAt(a, y * w + x), T_LAB));
  assert.ok(median(island) < 0.04, `shirt island should sit on the target, dE ${median(island)}`);

  // flat black tee with a flat white print: the black IS the fabric
  const tee = image(w, h, (x, y) => ((x - 64) ** 2 + (y - 64) ** 2 < 20 ** 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const b = recolorRGBA(tee, w, h, TARGET).pixels;
  assert.ok(dE(labAt(b, 5), T_LAB) < 0.03, 'black fabric -> target');
  assert.ok(labAt(b, 64 * w + 64)[0] > labAt(b, 5)[0] + 0.1, 'white print stays lighter');
});

test('coloured print keeps its black ink; smooth shading next to it is still recolored', () => {
  const w = 512, h = 512; // realistic letter-to-texture proportions
  const r = rng(33);
  const src = image(w, h, (x, y) => {
    // pink-outlined black letter block
    const inBlock = x >= 50 && x < 110 && y >= 40 && y < 120;
    const inInner = x >= 56 && x < 104 && y >= 46 && y < 114;
    if (inInner) return [12, 12, 12];
    if (inBlock) return [232, 110, 170];
    // grey fabric with a smooth dark shadow gradient on the left
    const shade = x < 30 ? 60 + x * 3 : 150;
    return [shade + (r() - 0.5) * 6, shade, shade + 2].map(Math.round);
  });
  const { pixels } = recolorRGBA(src, w, h, TARGET);
  const at = (x, y) => labAt(pixels, y * w + x);
  const orig = (x, y) => labAt(src, y * w + x);
  assert.ok(dE(at(80, 80), orig(80, 80)) < 0.03, 'black ink inside the print is kept');
  assert.ok(dE(at(52, 80), orig(52, 80)) < 0.03, 'pink outline is kept');
  assert.ok(dE(at(400, 400), T_LAB) < 0.04, 'fabric goes to the target');
  assert.ok(dE(at(10, 400), orig(10, 400)) > 0.05, 'shadow shading is recolored, not kept as ink');
});

test('mesh lens detection: flat hole-free pane in a different colour than the frame', () => {
  const { lensFromMesh } = require('../src/core/lensMesh');
  const { rgbaToOklabPlanes } = require('../src/color/oklab');
  // texture: white frame area (top) + black lens area (bottom-left)
  const W = 128;
  const tex = image(W, W, (x, y) => (y > 64 && x < 64 ? [5, 5, 5] : [245, 245, 245]));
  const planes = rgbaToOklabPlanes(tex, W * W);
  const quad = (pos, uv) => ({ pos: Float32Array.from(pos), uv: Float32Array.from(uv), indices: Uint16Array.from([0, 1, 2, 0, 2, 3]), vertexCount: 4 });
  // lens: flat quad mapped into the black area
  const lens = quad([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0.05, 0.55, 0.45, 0.55, 0.45, 0.95, 0.05, 0.95]);
  // frame ring: 4 thin quads around a hole (bent, so normals disagree) mapped into white
  const ring = { pos: [], uv: [], indices: [] };
  const addQuad = (p, u) => { const b = ring.pos.length / 3; ring.pos.push(...p); ring.uv.push(...u); ring.indices.push(b, b + 1, b + 2, b, b + 2, b + 3); };
  addQuad([0, 0, 0, 1, 0, 0, 1, 0.1, 0.3, 0, 0.1, 0.3], [0.1, 0.05, 0.9, 0.05, 0.9, 0.1, 0.1, 0.1]);
  addQuad([0, 0, 0, 0.1, 0, 0.3, 0.1, 1, 0.3, 0, 1, 0], [0.1, 0.05, 0.15, 0.05, 0.15, 0.45, 0.1, 0.45]);
  const frame = { pos: Float32Array.from(ring.pos), uv: Float32Array.from(ring.uv), indices: Uint16Array.from(ring.indices), vertexCount: ring.pos.length / 3 };
  const res = lensFromMesh([{ mesh: lens }, { mesh: frame }], planes, W, W);
  assert.ok(res, 'lens found');
  assert.ok(res.mask[90 * W + 30] > 0.9, 'lens texels protected');
  assert.ok(res.mask[10 * W + 60] < 0.1, 'frame texels not protected');
});

test('head props: forward-facing dark visor is a lens even on a black shell; a downward panel is not', () => {
  const { lensFromMesh } = require('../src/core/lensMesh');
  const { rgbaToOklabPlanes } = require('../src/color/oklab');
  const W = 128;
  // black shell everywhere, a pure-black visor patch at bottom-left, grey liner patch at top-right
  const tex = image(W, W, (x, y) => (y > 96 && x < 32 ? [0, 0, 0] : (y < 32 && x > 96 ? [110, 110, 110] : [22, 22, 24])));
  const planes = rgbaToOklabPlanes(tex, W * W);
  const quad = (pos, uv) => ({ pos: Float32Array.from(pos), uv: Float32Array.from(uv), indices: Uint16Array.from([0, 1, 2, 0, 2, 3]), vertexCount: 4 });
  // head-bone space: +X up, +Y forward. Visor faces +Y (lies in the XZ plane)
  const visor = quad([0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1], [0.02, 0.78, 0.22, 0.78, 0.22, 0.98, 0.02, 0.98]);
  // neck liner faces -X (lies in the YZ plane)
  const liner = quad([0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1], [0.78, 0.02, 0.98, 0.02, 0.98, 0.22, 0.78, 0.22]);
  // shell: a dome top facing +X and a side facing +Z (a real shell faces up/sideways)
  const top = quad([1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1], [0.3, 0.3, 0.5, 0.3, 0.5, 0.5, 0.3, 0.5]);
  const side = quad([0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], [0.5, 0.5, 0.7, 0.5, 0.7, 0.7, 0.5, 0.7]);
  const res = lensFromMesh([{ mesh: visor }, { mesh: liner }, { mesh: top }, { mesh: side }], planes, W, W, { forwardAxis: [0, 1, 0] });
  assert.ok(res, 'visor found');
  assert.ok(res.mask[110 * W + 10] > 0.9, 'visor texels protected');
  assert.ok(res.mask[10 * W + 110] < 0.1, 'neck liner is not a lens');
});

test('full-sleeve tattoos: a mesh piece that is skin + ink is kept whole; the shorts piece is recolored', () => {
  const { buildProtectMask } = require('../src/core/protect');
  const { buildSkinModel } = require('../src/color/skin');
  const W = 256;
  const r = rng(77);
  const skinPx = () => [196 + (r() - 0.5) * 16, 140 + (r() - 0.5) * 12, 108 + (r() - 0.5) * 10].map(Math.round);
  const head = { rgba: image(128, 128, () => skinPx()), width: 128, height: 128 };
  const model = buildSkinModel([head]);
  // left half = leg island: ~75% ink (black swirls + red lettering), skin only in gaps
  // right half = shorts island: grey fabric
  const tex = image(W, W, (x, y) => {
    if (x < 128) {
      const v = Math.sin(x / 5) * Math.cos(y / 7) + Math.sin((x + y) / 9);
      if (y > 40 && y < 70 && x > 20 && x < 100) return [150, 20, 25]; // red ink text
      if (v > -0.9) return [28 + r() * 20, 22 + r() * 16, 20 + r() * 14].map(Math.round); // black/brown ink
      return skinPx();
    }
    return [140 + (r() - 0.5) * 10, 140, 142].map(Math.round);
  });
  const quad = (u0, u1) => ({ mesh: { pos: Float32Array.from([u0, 0, 0, u1, 0, 0, u1, 1, 0, u0, 1, 0]), uv: Float32Array.from([u0, 0, u1, 0, u1, 1, u0, 1]), indices: Uint16Array.from([0, 1, 2, 0, 2, 3]), vertexCount: 4 } });
  const pm = buildProtectMask({ rgba: tex, width: W, height: W, skinMode: 'strict', skinModel: model, meshes: [quad(0, 0.49), quad(0.51, 1)] });
  let inkKept = 0, inkN = 0, shorts = 0, sN = 0;
  for (let y = 10; y < W - 10; y++) for (let x = 10; x < W - 10; x++) {
    const i = y * W + x;
    if (x < 118) { inkN++; if (pm.protect[i] > 0.9) inkKept++; }
    if (x > 138) { sN++; if (pm.protect[i] > 0.1) shorts++; }
  }
  assert.ok(inkKept / inkN > 0.97, `tattooed leg kept: ${(inkKept / inkN).toFixed(3)}`);
  assert.ok(shorts / sN < 0.02, `shorts not protected: ${(shorts / sN).toFixed(3)}`);
});

test('full-sleeve tattoos without separate mesh pieces: interleaved ink kept, black shorts recolored', () => {
  const { buildProtectMask } = require('../src/core/protect');
  const { buildSkinModel } = require('../src/color/skin');
  const W = 256;
  const r = rng(78);
  const skinPx = () => [196 + (r() - 0.5) * 16, 140 + (r() - 0.5) * 12, 108 + (r() - 0.5) * 10].map(Math.round);
  const model = buildSkinModel([{ rgba: image(128, 128, () => skinPx()), width: 128, height: 128 }]);
  // top = black shorts (fabric texture), bottom = leg with a dense sleeve (ink lines, skin between)
  const tex = image(W, W, (x, y) => {
    if (y < 110) return [30 + (r() - 0.5) * 12, 30, 34].map(Math.round);
    const v = Math.sin(x / 4) * Math.cos(y / 5) + 0.6 * Math.sin((x - y) / 6);
    if (y > 200 && y < 215 && x > 30 && x < 120) return [150, 20, 25]; // red ink lettering
    if ((x - 190) ** 2 + (y - 190) ** 2 < 15 ** 2) return [235, 232, 228]; // white-ink flower
    return v > -0.5 ? [35 + r() * 20, 26 + r() * 14, 22 + r() * 12].map(Math.round) : skinPx();
  });
  const pm = buildProtectMask({ rgba: tex, width: W, height: W, skinMode: 'strict', skinModel: model, meshes: null });
  let leg = 0, legN = 0, shorts = 0, sN = 0;
  for (let y = 5; y < W - 5; y++) for (let x = 5; x < W - 5; x++) {
    const i = y * W + x;
    if (y > 125) { legN++; if (pm.protect[i] > 0.9) leg++; }
    if (y < 90) { sN++; if (pm.protect[i] > 0.1) shorts++; }
  }
  assert.ok(leg / legN > 0.95, `sleeve kept: ${(leg / legN).toFixed(3)}`);
  assert.ok(shorts / sN < 0.03, `shorts not protected: ${(shorts / sN).toFixed(3)}`);
});
