'use strict';
/**
 * fivem-recolor – public API
 *
 *   const { recolorStream, recolorFiles } = require('fivem-recolor');
 *
 *   // whole stream folder -> new folder (+ recolor-report.json)
 *   await recolorStream({ input: 'C:/.../ig_jayjay/stream', output: 'C:/.../stream_d3ac92', color: '#d3ac92' });
 *
 *   // in memory (web upload etc.)
 *   const { files, report } = await recolorFiles([{ path: 'ig_jayjay^uppr_diff_000_a_uni.ytd', buffer }], { color: '#d3ac92' });
 *
 *   // raw pixels (your own decoder / PNG / canvas)
 *   const { pixels } = recolorRGBA(rgba, width, height, '#d3ac92', { protect });
 */
const { recolorStream, recolorFiles } = require('./ped/pipeline');
const { recolorRGBA, analyze, apply, DEFAULTS } = require('./core/recolor');
const { buildProtectMask } = require('./core/protect');
const { readRsc7 } = require('./formats/rsc7');
const { readYtd } = require('./formats/texture');
const { readYdd, readYdr } = require('./formats/drawable');
const { readDDS } = require('./formats/dds');
const { decodeMip, encodeMip } = require('./texture/codec');
const { parseName, policyFor, COMPONENT_POLICY } = require('./ped/naming');
const { encodePNG, decodePNG } = require('./util/png');

module.exports = {
  recolorStream,
  recolorFiles,
  recolorRGBA,
  analyze,
  apply,
  buildProtectMask,
  RECOLOR_DEFAULTS: DEFAULTS,
  COMPONENT_POLICY,
  parseName,
  policyFor,
  formats: { readRsc7, readYtd, readYdd, readYdr, readDDS, decodeMip, encodeMip, encodePNG, decodePNG },
};
