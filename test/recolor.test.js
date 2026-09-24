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
