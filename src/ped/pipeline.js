'use strict';
/**
 * Folder-level pipeline: takes a FiveM `stream` folder (or any folder of
 * .ytd/.ydd/.ydr/.dds/.png), recolors every clothing diffuse texture to one
 * colour, and writes a complete, drop-in output folder + a JSON report.
 */
const fs = require('fs');
const path = require('path');
const { readRsc7 } = require('../formats/rsc7');
const { readYtd, USAGE } = require('../formats/texture');
const { readYdd, readYdr } = require('../formats/drawable');
const { readDDS } = require('../formats/dds');
const { FMT, FMT_NAME } = require('../formats/texfmt');
const { decodeMip } = require('../texture/codec');
const { parseName, policyFor, SKIN_RACES, drawableNameFromHash } = require('./naming');
const { recolorGroup } = require('../core/textureJob');
const { uvRoleMasks } = require('../core/protect');
const skin = require('../color/skin');
const { encodePNG, decodePNG, maskToPNG } = require('../util/png');
const { recolorRGBA } = require('../core/recolor');
const { buildProtectMask } = require('../core/protect');

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p));
  }
  return out;
}

function looksLikeNormalMap(rgba) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < rgba.length; i += 4 * 7) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
  r /= n; g /= n; b /= n;
  return b > 190 && Math.abs(r - 128) < 45 && Math.abs(g - 128) < 45;
}

/** Decide what a texture is: diffuse / normal / spec / palette / other. */
function classifyTexture(tex, info, samplerRoles) {
  if (tex.usage === USAGE.TINTPALETTE || /palette/.test(tex.name || '')) return 'palette';
  if (info.textureType) return info.textureType;
  // Model knowledge: which shader sampler actually reads this texture
  const role = samplerRoles && samplerRoles.get((tex.name || '').toLowerCase());
  if (role) return role;
  if (tex.usage === USAGE.NORMAL) return 'normal';
  if (tex.usage === USAGE.SPECULAR) return 'spec';
  const n = (tex.name || '').toLowerCase();
  if (/(^|_)(n|nm|nrm|normal|bump)(_|$)/.test(n) || /_n$/.test(n)) return 'normal';
  if (/(^|_)(s|sp|spec|specular)(_|$)/.test(n) || /_s$/.test(n)) return 'spec';
  // free-form names (SpecMap, NormalMap, ShoeBump, ...)
  if (/normal|bump|nrm/.test(n)) return 'normal';
  if (/spec|gloss|rough/.test(n)) return 'spec';
  if (/(^|_)(e|emissive|em)(_|$)/.test(n)) return 'emissive';
  return 'diffuse';
}

/**
 * @param {object} opts
 * @param {string} opts.input          stream folder
 * @param {string} [opts.output]       output folder (default: <input>_recolored)
 * @param {string} [opts.color]        '#d3ac92'
 * @param {string} [opts.previewDir]   write before/after/mask PNGs here
 * @param {'auto'|'always'|'off'} [opts.skin]  skin detection policy
 * @param {boolean} [opts.recolorHair]
 * @param {object} [opts.components]   policy overrides, e.g. { berd: 'recolor', p_eyes: 'skip' }
 * @param {string[]} [opts.skinTones]  extra '#rrggbb' samples of the ped's skin
 * @param {object} [opts.protectRects] { textureName: [{x,y,w,h} in 0..1 UV] }
 * @param {string[]} [opts.skipTextures]  texture names (or regex strings) never to touch
 * @param {object} [opts.recolor]      options forwarded to core recolor (keepAccents, contrast, ...)
 * @param {(msg:string)=>void} [opts.log]
 */
async function recolorStream(opts) {
  const input = path.resolve(opts.input);
  const output = path.resolve(opts.output || `${input}_recolored`);
  const rels = walk(input);
  const result = await recolorFiles(rels.map((rel) => ({ path: rel, buffer: fs.readFileSync(path.join(input, rel)) })), opts);
  for (const f of result.files) {
    const dst = path.join(output, f.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.buffer);
  }
  result.report.input = input;
  result.report.output = output;
  fs.writeFileSync(path.join(output, 'recolor-report.json'), JSON.stringify(result.report, null, 2));
  return result.report;
}

/**
 * In-memory version (for web apps / Electron): same options as recolorStream.
 * @param {Array<{path:string, buffer:Buffer}>} inputFiles  paths relative to the stream folder
 * @returns {Promise<{files: Array<{path:string, buffer:Buffer, changed:boolean}>, report:object}>}
 */
async function recolorFiles(inputFiles, opts = {}) {
  const color = opts.color || '#d3ac92';
  const log = opts.log || (() => {});
  const skinPolicy = opts.skin || 'auto';
  const overrides = opts.components || {};
  const skipRx = (opts.skipTextures || []).map((s) => new RegExp(s, 'i'));
  const t0 = Date.now();

  const files = inputFiles.map(({ path: rel, buffer }) => {
    rel = String(rel).replace(/\\/g, '/');
    const ext = path.extname(rel).toLowerCase();
    const info = parseName(rel);
    const dir = path.posix.dirname(rel);
    const dirPed = dir !== '.' ? path.posix.basename(dir).toLowerCase() : null;
    // ped identity: "ped^file" prefix, else a single-file ped (ig_jayjay.ytd / .ydd / .yft / .ymt),
    // else the containing folder, else "default"
    const singleFilePed = info.kind === 'unknown' && ['.ytd', '.ydd', '.ydr', '.yft', '.ymt'].includes(ext) ? info.name : null;
    return { rel, buffer, ext, info, ped: info.ped || singleFilePed || (dirPed && dirPed !== 'stream' ? dirPed : null) || 'default' };
  });

  // ---- load resources ----
  for (const f of files) {
    try {
      if (f.ext === '.ytd') { f.res = readRsc7(f.buffer); f.textures = readYtd(f.res); }
      else if (f.ext === '.ydd' || f.ext === '.ydr') {
        f.res = readRsc7(f.buffer);
        f.drawables = f.ext === '.ydd' ? readYdd(f.res) : readYdr(f.res);
      }
    } catch (e) { f.error = e.message; log(`! ${f.rel}: ${e.message}`); }
  }

  // ---- model knowledge: shaders + UVs per drawable, indexed by stem and by diffuse name ----
  const geomsByStem = new Map();
  const geomsByTex = new Map();
  for (const f of files) {
    if (!f.drawables) continue;
    for (const d of f.drawables) {
      // single-file peds (ped.ydd) hold every drawable, keyed by joaat("uppr_000_r") etc.
      const dname = d.nameHash ? drawableNameFromHash(d.nameHash) : null;
      const dnInfo = dname ? parseName(dname) : null;
      for (const g of d.geometries) {
        if (!g.uv) continue;
        const diffuse = g.shader && g.shader.diffuse ? g.shader.diffuse.toLowerCase() : null;
        const dinfo = diffuse ? parseName(diffuse) : null;
        // A hair shader outside hair/beard slots is just a cut-out material (e.g. shoe foam).
        let role = g.shader ? g.shader.role : 'unknown';
        const comp = (f.info.kind === 'drawable' && f.info.component) || (dnInfo && dnInfo.component) || (dinfo && dinfo.component);
        if (role === 'hair' && !['hair', 'berd', 'head'].includes(comp)) role = 'cloth';
        const rec = { role, shader: g.shader ? g.shader.name : null, diffuse, diffuseStem: dinfo && dinfo.stem ? dinfo.stem : null, tris: g.uv.tris, file: f.rel,
          mesh: g.uv.pos ? { pos: g.uv.pos, uv: g.uv.uv, indices: g.uv.indices, vertexCount: g.uv.vertexCount } : null };
        // file name wins (renamed files keep a stale internal name, e.g. p_eyes_003.ydd
        // holding a drawable hashed "p_eyes_001"); internal name only for single-file peds
        const stem = (f.info.kind === 'drawable' && f.info.stem) || (dnInfo && dnInfo.stem) || (dinfo && dinfo.stem) || null;
        if (stem) { const k = `${f.ped}|${stem}`; if (!geomsByStem.has(k)) geomsByStem.set(k, []); geomsByStem.get(k).push(rec); }
        if (diffuse) { const k = `${f.ped}|${diffuse}`; if (!geomsByTex.has(k)) geomsByTex.set(k, []); geomsByTex.get(k).push(rec); }
      }
    }
  }

  // which sampler reads which texture name (BumpSampler -> normal, SpecSampler -> spec)
  const samplerRoles = new Map();
  for (const f of files) for (const d of f.drawables || []) for (const sh of d.shaders) {
    if (!sh) continue;
    if (sh.bump) samplerRoles.set(sh.bump.toLowerCase(), 'normal');
    if (sh.spec) samplerRoles.set(sh.spec.toLowerCase(), 'spec');
  }

  // ---- collect textures ----
  const texs = [];
  for (const f of files) {
    const list = [];
    if (f.textures) for (const t of f.textures) list.push({ t, owner: f, embedded: false });
    if (f.drawables) for (const d of f.drawables) for (const t of d.embeddedTextures || []) list.push({ t, owner: f, embedded: true });
    for (const { t, owner, embedded } of list) {
      if (!t.valid) continue;
      // GTA resolves ped textures by FILE name; the name stored inside a .ytd is often
      // stale (e.g. jbib_diff_008_a_uni.ytd containing "jbib_diff_001_a_uni").
      const fromTex = parseName(t.name || '');
      let info = fromTex;
      if (!embedded && f.info.kind === 'texture' && f.textures.length === 1) info = f.info;
      else if (!embedded && !fromTex.component && f.textures.length === 1) info = { ...f.info, textureType: f.info.textureType || fromTex.textureType };
      t.info = info;
      texs.push({ t, file: owner, embedded, info, ped: info.ped || owner.ped, kind: classifyTexture(t, info, samplerRoles) });
    }
  }

  // ---- ped skin models from head textures ----
  const skinModels = new Map();
  const headsByPed = new Map();
  for (const x of texs) {
    if (x.info.component !== 'head' || x.kind !== 'diffuse') continue;
    if (!headsByPed.has(x.ped)) headsByPed.set(x.ped, []);
    try {
      const m0 = x.t.mips[0];
      headsByPed.get(x.ped).push({ race: x.info.race || 'uni', rgba: decodeMip(x.t.format, x.t.data.subarray(m0.offset, m0.offset + m0.size), m0.width, m0.height), width: m0.width, height: m0.height });
    } catch (_) { /* unsupported format */ }
  }
  for (const [ped, heads] of headsByPed) {
    const all = skin.buildSkinModel(heads, { extraSamples: opts.skinTones || [] });
    skinModels.set(`${ped}|*`, all);
    for (const race of new Set(heads.map((h) => h.race))) skinModels.set(`${ped}|${race}`, skin.buildSkinModel(heads.filter((h) => h.race === race), { extraSamples: opts.skinTones || [] }));
    log(`skin model for ${ped}: ${all ? `${all.samples} samples, L=${all.mean[0].toFixed(3)}` : 'not enough skin texels'}`);
  }
  const skinModelFor = (ped, race) => skinModels.get(`${ped}|${race}`) || skinModels.get(`${ped}|*`) || (opts.skinTones && opts.skinTones.length ? skin.buildSkinModel([], { extraSamples: opts.skinTones }) : null);

  // ---- decide per texture ----
  const report = { color, textures: [], files: [], warnings: [] };
  const groups = new Map();
  for (const x of texs) {
    const name = x.t.name || x.file.rel;
    const comp = x.info.component || null;
    const policy = comp ? policyFor(comp, x.ped, overrides) : (overrides['*'] || 'recolor');
    let reason = null;
    if (x.kind !== 'diffuse') reason = `${x.kind} map`;
    else if (policy === 'skip') reason = `component "${comp}" is protected by policy`;
    else if (comp === 'hair' && !opts.recolorHair) reason = 'hair';
    else if (/lens|glass|visor|shield/i.test(name)) reason = 'lens/glass texture';
    else if (skipRx.some((r) => r.test(name))) reason = 'user skip list';
    else if (x.kind === 'diffuse' && !x.info.component && x.t.format !== FMT.ATI2) {
      try { const m0 = x.t.mips[0]; if (looksLikeNormalMap(decodeMip(x.t.format, x.t.data.subarray(m0.offset, m0.offset + m0.size), m0.width, m0.height))) reason = 'looks like a normal map'; } catch (_) { /* ignore */ }
    }
    if (reason) { report.textures.push({ texture: name, file: x.file.rel, status: 'skipped', reason }); continue; }

    const race = x.info.race;
    const hasSkinVariants = race ? SKIN_RACES.has(race) : x.info.drawableFlag === 'r';
    let skinMode = 'off';
    if (skinPolicy === 'always') skinMode = 'normal';
    else if (skinPolicy === 'auto' && policy !== 'lens' && !x.info.prop) skinMode = hasSkinVariants ? 'normal' : 'strict';

    const lower = (x.t.name || '').toLowerCase();
    // Model knowledge: the drawable with the same component + index (ped variation system
    // swaps the diffuse of EVERY shader in that drawable), else a drawable that names this texture.
    const geoms = (x.info.stem ? geomsByStem.get(`${x.ped}|${x.info.stem}`) : null) || geomsByTex.get(`${x.ped}|${lower}`) || null;
    const uv = geoms ? uvRoleMasks(geoms, null, x.t.mips[0].width, x.t.mips[0].height) : null;
    const hasLensShader = !!(geoms && geoms.some((g) => g.role === 'lens'));

    x.t.settings = {
      skinMode,
      skinModel: skinMode !== 'off' ? skinModelFor(x.ped, race || 'uni') : null,
      lensMode: policy === 'lens' || hasLensShader,
      uv,
      protectHair: !opts.recolorHair,
      lensMeshes: (policy === 'lens' && geoms) ? geoms.filter((g) => g.mesh) : null,
      keepMetal: opts.keepMetal,
      protectRects: (opts.protectRects && (opts.protectRects[name] || opts.protectRects[lower])) || [],
    };
    x.t.formatName = FMT_NAME[x.t.format];
    x.t.previewName = x.file.info.name && x.file.textures && x.file.textures.length === 1 ? x.file.info.base : `${x.file.info.base}__${name}`;
    const gkey = x.info.stem && x.info.variant ? `${x.ped}|${x.info.stem}|${x.info.variant}|${x.embedded ? 'e' : 'x'}` : `${x.ped}|${x.file.rel}|${name}`;
    if (!groups.has(gkey)) groups.set(gkey, []);
    groups.get(gkey).push(x);
  }

  // ---- run ----
  const preview = opts.previewDir ? makePreviewWriter(opts.previewDir) : null;
  let gi = 0;
  for (const [key, members] of groups) {
    gi++;
    log(`[${gi}/${groups.size}] ${members.map((m) => m.t.name).join(', ')}`);
    try {
      const reps = recolorGroup(members.map((m) => m.t), { color, options: opts.recolor || {}, preview });
      for (const r of reps) {
        const m = members.find((mm) => mm.t.name === r.texture);
        r.file = m ? m.file.rel : null;
        if (m && r.status === 'recolored') m.file.dirty = true;
        const s = m && m.t.settings;
        if (s) r.settings = { skinMode: s.skinMode, skinModel: !!s.skinModel, lensMode: s.lensMode, uvGeometries: s.uv ? Object.keys(s.uv).filter((k) => k !== 'used') : [] };
        report.textures.push(r);
      }
    } catch (e) {
      report.warnings.push(`${key}: ${e.message}`);
      log(`! ${key}: ${e.stack}`);
    }
  }

  // ---- loose images (.dds / .png) ----
  for (const f of files) {
    if (f.ext !== '.dds' && f.ext !== '.png') continue;
    try { processLooseImage(f, { color, opts, report, skinModelFor, preview }); } catch (e) { report.warnings.push(`${f.rel}: ${e.message}`); }
  }

  // ---- output buffers ----
  const outFiles = [];
  for (const f of files) {
    if (f.dirty && f.res) {
      const buf = f.res.toBuffer();
      // sanity: re-read what we are about to ship
      const check = readRsc7(buf);
      if (f.ext === '.ytd') readYtd(check); else if (f.ext === '.ydr') readYdr(check); else readYdd(check);
      outFiles.push({ path: f.rel, buffer: buf, changed: true });
      report.files.push({ file: f.rel, status: 'recolored', bytes: buf.length });
    } else if (f.dirtyBuffer) {
      outFiles.push({ path: f.rel, buffer: f.dirtyBuffer, changed: true });
      report.files.push({ file: f.rel, status: 'recolored', bytes: f.dirtyBuffer.length });
    } else {
      outFiles.push({ path: f.rel, buffer: f.buffer, changed: false });
      report.files.push({ file: f.rel, status: f.error ? 'unchanged (unreadable)' : 'unchanged', error: f.error });
    }
  }
  report.seconds = +((Date.now() - t0) / 1000).toFixed(2);
  return { files: outFiles, report };
}

function processLooseImage(f, { color, opts, report, skinModelFor, preview }) {
  const buf = f.buffer;
  const info = f.info;
  const policy = info.component ? policyFor(info.component, f.ped, opts.components || {}) : 'recolor';
  const kind = info.textureType || classifyTexture({ name: info.name }, info);
  if (kind !== 'diffuse' || policy === 'skip') { report.textures.push({ texture: f.rel, status: 'skipped', reason: kind !== 'diffuse' ? `${kind} map` : 'policy' }); return; }
  const settings = {
    skinMode: opts.skin === 'off' ? 'off' : (policy === 'lens' || info.prop ? 'off' : (SKIN_RACES.has(info.race) ? 'normal' : 'strict')),
    lensMode: policy === 'lens',
  };
  settings.skinModel = settings.skinMode !== 'off' ? skinModelFor(f.ped, info.race || 'uni') : null;
  if (f.ext === '.png') {
    const img = decodePNG(buf);
    const pm = buildProtectMask({ rgba: img.rgba, width: img.width, height: img.height, keepMetal: opts.keepMetal, ...settings });
    const { pixels, plan } = recolorRGBA(img.rgba, img.width, img.height, color, { protect: pm.protect, ignore: pm.padding ? pm.padding.mask : null, ...(opts.recolor || {}) });
    f.dirtyBuffer = encodePNG(pixels, img.width, img.height);
    if (preview) { preview(f.rel, 'before', img.rgba, img.width, img.height); preview(f.rel, 'after', pixels, img.width, img.height); preview(f.rel, 'protect', pm.protect, img.width, img.height); }
    report.textures.push({ texture: f.rel, status: 'recolored', protect: pm.coverage, padding: pm.padding ? pm.padding.source : null, plan });
    return;
  }
  const dds = readDDS(buf);
  const copy = Buffer.from(buf);
  const t = { name: f.rel, format: dds.format, formatName: FMT_NAME[dds.format], width: dds.width, height: dds.height, mips: dds.mips, data: copy.subarray(dds.dataOffset, dds.dataOffset + dds.data.length), info, settings };
  const reps = recolorGroup([t], { color, options: opts.recolor || {}, preview });
  for (const r of reps) report.textures.push({ ...r, file: f.rel });
  if (reps.some((r) => r.status === 'recolored')) f.dirtyBuffer = copy;
}

function makePreviewWriter(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return (name, kind, data, w, h) => {
    const safe = String(name).replace(/[^a-z0-9_.-]+/gi, '_');
    const file = path.join(dir, `${safe}.${kind}.png`);
    fs.writeFileSync(file, data instanceof Float32Array ? maskToPNG(data, w, h) : encodePNG(data, w, h));
  };
}

module.exports = { recolorStream, recolorFiles, classifyTexture, looksLikeNormalMap };
