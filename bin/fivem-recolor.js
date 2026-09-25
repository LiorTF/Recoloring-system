#!/usr/bin/env node
'use strict';
const path = require('path');
const { recolorStream } = require('../src');

const HELP = `
fivem-recolor <stream folder> [options]

  --color <#rrggbb>        target colour (default #d3ac92)
  --out <folder>           output folder (default <input>_recolored)
  --preview <folder>       write before/after/protect/accent PNGs for every texture
  --skin auto|always|off   skin/tattoo protection (default auto)
  --skin-tone <#rrggbb>    extra skin colour sample (repeatable)
  --tint-accents           also tint logos/stripes (default: keep their colour)
  --contrast <n>           detail contrast multiplier (default 1.0)
  --strength <0..1>        blend with original (default 1.0)
  --hair                   recolor hair too
  --extras none|black|white|both
                           also add black and/or white versions of every garment as new
                           texture variations (next free letters, e.g. _a colour, _b black, _c white)
  --black <#rrggbb>        the "black" used by --extras (default #1c1c1c)
  --white <#rrggbb>        the "white" used by --extras (default #ececec)
  --component <c>=<policy> override policy, e.g. berd=recolor p_eyes=skip (repeatable)
  --skip <regex>           never touch textures matching (repeatable)
  --quiet
`;

function parseArgs(argv) {
  const o = { components: {}, skipTextures: [], skinTones: [], recolor: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--color': o.color = next(); break;
      case '--out': o.output = next(); break;
      case '--preview': o.previewDir = next(); break;
      case '--skin': o.skin = next(); break;
      case '--skin-tone': o.skinTones.push(next()); break;
      case '--tint-accents': o.recolor.keepAccents = false; break;
      case '--contrast': o.recolor.contrast = parseFloat(next()); break;
      case '--strength': o.recolor.strength = parseFloat(next()); break;
      case '--hair': o.recolorHair = true; break;
      case '--extras': o.extras = next(); break;
      case '--black': (o.extraColors = o.extraColors || {}).black = next(); break;
      case '--white': (o.extraColors = o.extraColors || {}).white = next(); break;
      case '--component': { const [k, v] = next().split('='); o.components[k] = v; break; }
      case '--skip': o.skipTextures.push(next()); break;
      case '--quiet': o.quiet = true; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      default: rest.push(a);
    }
  }
  o.input = rest[0];
  return o;
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  if (!o.input) { console.log(HELP); process.exit(1); }
  o.log = o.quiet ? () => {} : (m) => console.log(m);
  const report = await recolorStream(o);
  const done = report.textures.filter((t) => t.status === 'recolored');
  const skipped = report.textures.filter((t) => t.status !== 'recolored');
  console.log(`\nrecolored ${done.length} texture(s), skipped ${skipped.length}, ${report.seconds}s`);
  for (const t of skipped) console.log(`  skip ${t.texture}: ${t.reason}`);
  for (const e of report.extras || []) console.log(`  + ${e.color} variant _${e.variant}: ${e.file}`);
  for (const w of report.warnings) console.log(`  warn ${w}`);
  console.log(`output: ${report.output}\nreport: ${path.join(report.output, 'recolor-report.json')}`);
})().catch((e) => { console.error(e); process.exit(1); });
