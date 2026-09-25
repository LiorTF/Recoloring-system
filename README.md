# fivem-recolor

Recolor a whole GTA V / FiveM ped (or clothing pack) to one colour, e.g. `#d3ac92`, **directly inside
the `.ytd` / `.ydd` files**, while keeping:

- the design: folds, seams, stitching, prints, logos, stripes, and tonal separation between materials (a white shirt under a black suit stays lighter)
- skin and tattoos: learned from the ped's own head texture and from skin-tone variants
- lenses, visors and watch glass: from alpha and from the model's glass-shader UVs
- metal hardware (zipper pulls, buckles) and the black ink of coloured prints
- normal / spec maps, face, teeth and hair (never touched)

`src/preview/render.js` renders a `.ydd` mesh with a texture (no GPU) for before/after previews.

Zero dependencies, Node ≥ 18.

## CLI

```bash
node bin/fivem-recolor.js "C:\Users\LioR\Desktop\ig_jayjay\stream" --color "#d3ac92" --preview preview
```

This writes `…\stream_recolored\` (a complete, drop-in stream folder) plus `recolor-report.json`, and
`preview\*.before|after|protect|accents.png` for every texture so you can check the masks.

### Black / white extra variants

```bash
node bin/fivem-recolor.js "...\stream" --color "#c0202a" --extras both
```

`--extras none|black|white|both` also writes black and/or white versions of every garment as **new
texture variations** on the next free letters: a garment with only `_a` gets `_a` = your colour,
`_b` = black, `_c` = white (`black` or `white` alone → just `_b`). Garments that already have more
variants get the letters after them, so nothing existing is overwritten. The extras are made from the
original `_a` design with the same protection (skin, tattoos, lenses, metal, prints). Defaults are
`#1c1c1c` / `#ececec` (not pure black/white, so folds and stitching keep their shading); change them
with `--black` / `--white`. **The ped `.ymt` must declare the extra textures** (texture count per
drawable), otherwise the game won't show them – they are listed in `report.extras`.

Options: `--out`, `--skin auto|always|off`, `--skin-tone #rrggbb`, `--tint-accents`,
`--contrast 1.0`, `--strength 1.0`, `--hair`, `--component berd=recolor`, `--skip <regex>`.

## API (for the Node app)

```js
const { recolorStream, recolorFiles, recolorRGBA } = require('./src');

// folder -> folder
const report = await recolorStream({ input, output, color: '#d3ac92', previewDir });

// in memory (uploads): [{ path, buffer }] -> [{ path, buffer, changed }]
const { files, report } = await recolorFiles(uploaded, { color: '#d3ac92' });

// raw RGBA (if the app already decodes textures itself)
const { pixels } = recolorRGBA(rgba, width, height, '#d3ac92', { protect });
```

Options for both: `extras` (`'none'|'black'|'white'|'both'`), `extraColors` (`{ black, white }`), `skin`, `skinTones`, `recolorHair`, `components` (policy overrides),
`protectRects` (`{ textureName: [{x,y,w,h}] }` in 0..1 UV), `skipTextures`, `recolor` (algorithm
tunables, see `RECOLOR_DEFAULTS`).

## How it works

See [`docs/KNOWLEDGE.md`](docs/KNOWLEDGE.md): file layouts, binary structures, the OKLab tone-curve
algorithm, how skin/tattoo/lens masks are built, and what testing on real packs revealed.

```
npm test
```
