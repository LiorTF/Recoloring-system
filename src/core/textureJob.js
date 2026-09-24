'use strict';
/**
 * Recolor a group of GPU textures that belong together (the race/skin-tone
 * variants of ONE garment variation) and write the result back into their
 * original byte slices, mip by mip, in their original format.
 */
const { decodeMip, encodeMip } = require('../texture/codec');
const { RECOLORABLE } = require('../formats/texfmt');
const { SKIN_RACES } = require('../ped/naming');
const { analyze, apply, publicPlan, designMask } = require('./recolor');
const { buildProtectMask } = require('./protect');
const skin = require('../color/skin');
const M = require('./masks');

/**
 * @typedef {object} TexHandle
 * @property {string} name
 * @property {number} format
 * @property {number} width
 * @property {number} height
 * @property {Array<{width:number,height:number,offset:number,size:number}>} mips
 * @property {Uint8Array} data   live bytes (patched in place)
 * @property {object} info        parsed name info
 * @property {object} settings    { skinMode, lensMode, uv, protectHair, protectRects, skinModel }
 */

/**
 * @param {TexHandle[]} members
 * @param {object} ctx { color, options, preview?: (name, kind, rgba|mask, w, h) => void }
 * @returns {object[]} per-texture report entries
 */
function recolorGroup(members, ctx) {
  const reports = [];
  const usable = [];
  for (const t of members) {
    if (!RECOLORABLE.has(t.format)) { reports.push({ texture: t.name, status: 'skipped', reason: `format ${t.formatName || t.format} not recolorable` }); continue; }
    const m0 = t.mips[0];
    const rgba0 = decodeMip(t.format, t.data.subarray(m0.offset, m0.offset + m0.size), m0.width, m0.height);
    usable.push({ t, rgba0, w: m0.width, h: m0.height });
  }
  if (!usable.length) return reports;

  // Race-variant diff: only for variants of identical size that carry skin tones.
  const raced = usable.filter((u) => SKIN_RACES.has(u.t.info && u.t.info.race));
  let raceSkin = null;
  if (raced.length >= 2 && raced.every((u) => u.w === raced[0].w && u.h === raced[0].h)) {
    raceSkin = skin.raceDiffMask(raced.map((u) => u.rgba0), raced[0].w, raced[0].h);
    if (M.coverage(raceSkin) < 0.0005) raceSkin = null; // variants identical -> no skin in this garment
  }

  for (const u of usable) {
    const s = u.t.settings || {};
    const useRace = raceSkin && raced.includes(u) ? raceSkin : null;
    const pm = buildProtectMask({
      rgba: u.rgba0, width: u.w, height: u.h,
      skinMode: useRace ? 'normal' : s.skinMode, skinModel: s.skinModel, raceSkin: useRace,
      lensMode: s.lensMode, uv: s.uv, protectHair: s.protectHair !== false, protectRects: s.protectRects,
      keepMetal: s.keepMetal, spec: s.spec, lensMeshes: s.lensMeshes, lensForward: s.lensForward, meshes: s.meshes,
    });
    u.pm = pm;
    u.pad = pm.padding;
  }

  // One plan per same-size group (race variants must end up identical on the cloth).
  const primary = usable.slice().sort((a, b) => M.coverage(a.pm.protect) - M.coverage(b.pm.protect))[0];
  const plan = analyze(primary.rgba0, primary.w, primary.h, primary.pm.protect, ctx.options, { ignore: primary.pad && primary.pad.mask });

  for (const u of usable) {
    const t = u.t;
    const localPlan = (u.w === primary.w && u.h === primary.h) ? plan : analyze(u.rgba0, u.w, u.h, u.pm.protect, ctx.options, { ignore: u.pad && u.pad.mask });
    const report = { texture: t.name, format: t.formatName, size: `${u.w}x${u.h}`, mips: t.mips.length, status: 'recolored', protect: u.pm.coverage, skinSource: u.pm.parts.skinSource || null, padding: u.pad ? { source: u.pad.source, coverage: +M.coverage(u.pad.mask).toFixed(3) } : null, plan: publicPlan(localPlan) };
    if (localPlan.empty) { report.status = 'skipped'; report.reason = 'no recolorable texels (fully protected)'; reports.push(report); continue; }

    const original = Uint8Array.from(t.data); // for bit-exact alpha copy + preview
    let accentCov = 0;
    for (let li = 0; li < t.mips.length; li++) {
      const mip = t.mips[li];
      const src = li === 0 ? u.rgba0 : decodeMip(t.format, original.subarray(mip.offset, mip.offset + mip.size), mip.width, mip.height);
      const prot = li === 0 ? u.pm.protect : M.resizeMask(u.pm.protect, u.w, u.h, mip.width, mip.height);
      const cache = li === 0 && localPlan === plan && u === primary ? { planes: plan._planes, accent: plan._accent } : {};
      if (li === 0) {
        const planes = cache.planes || u.pm.planes;
        cache.planes = planes;
        cache.accent = cache.accent || designMask(planes, mip.width * mip.height, localPlan, mip.width, mip.height);
        accentCov = localPlan.options.keepAccents ? M.coverage(cache.accent) : 0;
      }
      const out = apply(src, mip.width, mip.height, prot, localPlan, ctx.color, cache);
      encodeMip(t.format, out, mip.width, mip.height, t.data.subarray(mip.offset, mip.offset + mip.size), original.subarray(mip.offset, mip.offset + mip.size));
      if (li === 0 && ctx.preview) {
        const pn = t.previewName || t.name;
        ctx.preview(pn, 'before', u.rgba0, u.w, u.h);
        ctx.preview(pn, 'after', decodeMip(t.format, t.data.subarray(mip.offset, mip.offset + mip.size), mip.width, mip.height), u.w, u.h);
        ctx.preview(pn, 'protect', u.pm.protect, u.w, u.h);
        if (cache.accent && localPlan.options.keepAccents) ctx.preview(pn, 'accents', cache.accent, u.w, u.h);
      }
    }
    report.accentCoverage = +accentCov.toFixed(4);
    reports.push(report);
  }
  return reports;
}

module.exports = { recolorGroup };
