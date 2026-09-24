'use strict';
/**
 * GTA V ped streaming naming conventions (story peds, add-on peds, freemode clothing).
 *
 *   [ped^]<comp>_<ddd>_<u|r>.ydd                 drawable (u = universal, r = race/skin variants)
 *   [ped^]<comp>_diff_<ddd>_<v>_<race>.ytd        diffuse, v = variation letter a..z
 *   [ped^]<comp>_normal_<ddd>, <comp>_spec_<ddd>  (usually embedded in the .ydd)
 *   [ped^]p_<anchor>_<ddd>.ydd / p_<anchor>_diff_<ddd>_<v>.ytd   props
 *
 * race: uni (no skin), whi bla chi lat ara bal jam kor ita pak (skin-tone variants)
 * "ped^file" is the FiveM stream convention for "file inside the ped's folder".
 */

const RACES = ['uni', 'whi', 'bla', 'chi', 'lat', 'ara', 'bal', 'jam', 'kor', 'ita', 'pak'];
const SKIN_RACES = new Set(RACES.filter((r) => r !== 'uni'));

const COMPONENTS = ['head', 'berd', 'hair', 'uppr', 'lowr', 'hand', 'feet', 'teef', 'accs', 'task', 'decl', 'jbib'];
const PROPS = ['head', 'eyes', 'ears', 'mouth', 'lhand', 'rhand', 'lwrist', 'rwrist', 'hip', 'lfoot', 'rfoot'];

/**
 * Default per-component policy.
 *   skip     – never touched (face, teeth, hair, decals = the design)
 *   recolor  – recolored, skin/tattoo protection on
 *   lens     – recolored, lens/visor protection on (glasses, helmets, masks)
 */
const COMPONENT_POLICY = {
  head: 'skip', teef: 'skip', hair: 'skip', decl: 'skip',
  berd: 'auto', // story/add-on peds: beard (skip). freemode: masks (recolor + lens)
  uppr: 'recolor', lowr: 'recolor', hand: 'recolor', feet: 'recolor', accs: 'recolor', task: 'recolor', jbib: 'recolor',
  p_head: 'lens', p_eyes: 'lens', p_mouth: 'lens',
  p_ears: 'recolor', p_lhand: 'recolor', p_rhand: 'recolor', p_lwrist: 'recolor', p_rwrist: 'recolor', p_hip: 'recolor', p_lfoot: 'recolor', p_rfoot: 'recolor',
};

function splitPed(base) {
  const i = base.lastIndexOf('^');
  return i >= 0 ? { ped: base.slice(0, i), name: base.slice(i + 1) } : { ped: null, name: base };
}

/**
 * Parse a file or texture name.
 * @param {string} raw e.g. "ig_jayjay^uppr_diff_000_a_uni.ytd" or "p_eyes_diff_001_b"
 */
function parseName(raw) {
  const base = String(raw).replace(/\\/g, '/').split('/').pop().trim().replace(/\.(ytd|ydd|ydr|yft|dds|png)$/i, '').trim().toLowerCase().replace(/^'+/, '');
  const sp = splitPed(base);
  const ped = sp.ped;
  const name = sp.name.replace(/^'+/, '').trim();
  const info = { raw, base, ped, name, kind: 'unknown', prop: false, component: null, index: null, textureType: null, variant: null, race: null, drawableFlag: null };

  let m = /^(p_)?([a-z]+)_(diff|normal|spec)_(\d{3})(?:_([a-z]))?(?:_([a-z]{3}))?$/.exec(name);
  if (m) {
    info.kind = 'texture';
    info.prop = !!m[1];
    info.component = (m[1] || '') + m[2];
    info.textureType = m[3] === 'diff' ? 'diffuse' : m[3];
    info.index = parseInt(m[4], 10);
    info.variant = m[5] || null;
    info.race = m[6] || (info.prop ? 'uni' : null);
    return finish(info);
  }
  m = /^(p_)?([a-z]+)_(\d{3})(?:_([ur]))?$/.exec(name);
  if (m) {
    info.kind = 'drawable';
    info.prop = !!m[1];
    info.component = (m[1] || '') + m[2];
    info.index = parseInt(m[3], 10);
    info.drawableFlag = m[4] || null;
    return finish(info);
  }
  // generic texture suffix conventions (_n normal, _s spec)
  if (/(_n|_nrm|_normal)$/.test(name)) info.textureType = 'normal';
  else if (/(_s|_spec|_specular)$/.test(name)) info.textureType = 'spec';
  return info;
}

function finish(info) {
  info.stem = `${info.component}_${String(info.index).padStart(3, '0')}`;
  info.hasSkinVariants = info.race ? SKIN_RACES.has(info.race) : info.drawableFlag === 'r';
  return info;
}

let _drawableNames = null;
/** Reverse a DrawableDictionary name hash (joaat of e.g. "uppr_000_r", "p_head_002"). */
function drawableNameFromHash(hash) {
  if (!_drawableNames) {
    const { joaat } = require('../util/joaat');
    _drawableNames = new Map();
    for (const c of COMPONENTS) for (let i = 0; i < 128; i++) for (const f of ['u', 'r']) { const n = `${c}_${String(i).padStart(3, '0')}_${f}`; _drawableNames.set(joaat(n), n); }
    for (const c of PROPS) for (let i = 0; i < 128; i++) { const n = `p_${c}_${String(i).padStart(3, '0')}`; _drawableNames.set(joaat(n), n); }
  }
  return _drawableNames.get(hash >>> 0) || null;
}

function isFreemodePed(ped) { return !!ped && /^mp_[mf]_freemode_01/.test(ped); }

/** Resolve the effective policy for a component given the ped. */
function policyFor(component, ped, overrides = {}) {
  let p = overrides[component] || COMPONENT_POLICY[component] || 'recolor';
  if (p === 'auto' && component === 'berd') p = isFreemodePed(ped) ? 'lens' : 'skip';
  return p;
}

module.exports = { drawableNameFromHash, RACES, SKIN_RACES, COMPONENTS, PROPS, COMPONENT_POLICY, parseName, policyFor, isFreemodePed };
