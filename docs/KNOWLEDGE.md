# FiveM / GTA V ped recoloring – knowledge base

This is the reference for anyone (human or AI) continuing work on this recolorer or wiring it into
the NodeJS app. Everything here was verified against real files (see "Validation" at the bottom),
not just recalled.

---

## 1. What is inside a ped `stream` folder

Two layouts exist, and the pipeline handles both.

### A. Split files (freemode clothing, most story/`ig_` peds)
```
<ped>^uppr_000_r.ydd            drawable (mesh). _u = universal, _r = has skin-tone variants
<ped>^uppr_diff_000_a_whi.ytd   diffuse texture, variation "a", skin tone "whi"
<ped>^uppr_diff_000_a_bla.ytd   same garment, other skin tone
<ped>^p_eyes_000.ydd            prop drawable (glasses)
<ped>^p_eyes_diff_000_a.ytd     prop diffuse (props have no race suffix)
```
`ped^file` is FiveM's way of saying "file inside the ped's folder".

### B. Single-file ped (common for add-on peds, likely `ig_jayjay`)
```
ig_jayjay.yft   skeleton/fragment – never touched
ig_jayjay.ymt   variation meta – never touched
ig_jayjay.ydd   ONE DrawableDictionary with every drawable (keys = joaat("uppr_000_r") ...)
ig_jayjay.ytd   ONE TextureDictionary with every texture (names inside are meaningful here)
```

### Components
| code | slot | default policy |
|---|---|---|
| head | face + skin | **skip** (skin) |
| teef | teeth | **skip** |
| hair | hair | **skip** (`--hair` to include) |
| decl | decals / logos / badges | **skip** (it *is* the design) |
| berd | beard on story peds, mask on freemode | skip on story peds, recolor with lens protection on freemode |
| uppr, lowr, feet, hand, accs, task, jbib | clothing | recolor + skin/tattoo protection |
| p_head, p_eyes, p_mouth | hats/helmets, glasses, masks | recolor + **lens/visor protection** |
| p_ears, p_lwrist, p_rwrist, p_lhand, ... | jewellery, watches | recolor (+ lens protection if the model has a glass shader) |

Race suffixes: `uni` (no skin), `whi bla chi lat ara bal jam kor ita pak` (skin tones).
A `_r` drawable uses the race textures, which is how GTA tells you a garment shows skin.

### Texture kinds
* `*_diff_*` → diffuse → **the only thing we recolor**
* `*_normal_*` → normal map → never touched (it holds the wrinkles/stitching relief that keeps
  the recolor looking detailed in game)
* `*_spec_*` → specular → never touched
* palettes (`ped_palette` shader, usage TINTPALETTE) → never touched
* Normal/spec are usually **embedded in the .ydd**; diffuses live in .ytd files.

---

## 2. Binary formats (legacy PC = what FiveM streams)

### RSC7 container (`src/formats/rsc7.js`)
```
0x00 'RSC7' (0x37435352)   0x04 version (ytd 13, ydd/ydr 165, yft 162; Gen9 ytd = 5 -> unsupported)
0x08 systemFlags            0x0C graphicsFlags
0x10 raw DEFLATE( system pages || graphics pages )
```
Pointers are virtual: `0x5xxxxxxx` = system segment, `0x6xxxxxxx` = graphics segment.
Segment sizes come from the flags (`sizeFromFlags`, same as CodeWalker).

**Write strategy:** recoloring never changes size/format/mip count, so we decode each mip,
recolor, re-encode *into the same bytes*, and recompress with the ORIGINAL flags. Nothing
moves, no pointer is rewritten, the system segment stays byte-identical. This is the safest
possible way to write a GTA resource.

### Texture structures (`src/formats/texture.js`)
TextureDictionary (resource root of .ytd): `0x30` ptr to texture pointer array, `0x38` u16 count.
Texture (0x90 bytes): `0x28` name ptr, `0x40` usage (&0x1F), `0x50` width, `0x52` height,
`0x56` stride, `0x58` format, `0x5D` levels, `0x70` data ptr (graphics). Mip `i` is
`floor(W/2^i) x floor(H/2^i)`, blocks `max(1,ceil(w/4))`, stored back-to-back.

Formats: DXT1 (BC1), DXT3, DXT5 (BC3), BC7 (`0x20374342`), A8R8G8B8 (BGRA), A8B8G8R8 (RGBA),
ATI1/ATI2 (single-channel / normal maps – not recolored).

### Drawables (`src/formats/drawable.js`)
DrawableDictionary root: `0x20` hashes ptr, `0x30` drawable ptr array, `0x38` count.
Drawable: `0x10` ShaderGroup, `0x50` high-LOD model list header `{ptr,u16 count}`.
ShaderGroup: `0x08` embedded TextureDictionary, `0x10` shader ptr array, `0x18` count.
ShaderFX: `0x00` params ptr, `0x08` name hash, `0x10` param count, `0x18` file hash.
Params: `count x 16` headers `{u8 type, .., u64 ptr}` → vector data (`16*type` bytes each) → `count x u32` name hashes.
Texture params (`type 0`) point at a TextureBase (name at +0x28). `DiffuseSampler = joaat("diffusesampler")`.
Model: `0x08` geometry ptr array, `0x10` count, `0x20` u16 shader index per geometry.
Geometry: `0x18` VertexBuffer, `0x38` IndexBuffer, `0x78` vertex data ptr.
VertexBuffer: `0x08` stride, `0x10` data ptr 1, `0x18` count, `0x20` data ptr 2, `0x30` declaration.
Declaration: `0x00` flags (bit per semantic), `0x08` u64 types (4 bits per semantic).
TexCoord0 = semantic 6; type 1 = half2, 5 = float2. IndexBuffer: `0x08` count, `0x10` ptr (u16).
UVs are D3D convention (v down = texture rows), may exceed 0..1 (wrap).

---

## 3. Real-world gotchas found while testing on real packs

1. **The texture name inside a `.ytd` is often stale.** `jbib_diff_008_a_uni.ytd` contained a texture
   named `jbib_diff_001_a_uni`; `p_head_diff_003_b.ytd` contained `p_head_diff_000_a`. GTA resolves by
   FILE name → for single-texture .ytd files we classify by the file name first.
2. **The shader's DiffuseSampler name in a .ydd is also stale** (a `lowr_000_r` drawable referencing
   `lowr_diff_003_a_whi`). The ped variation system swaps the diffuse of *every* shader in a
   component drawable, so UV masks are matched by drawable (component + index), not by that name.
3. **Some exporters leave VertexBuffer data pointer 1 empty** and only fill pointer 2 → we fall back
   pointer1 → pointer2 → geometry +0x78.
4. **Modders reuse shaders creatively**: a shoe drawn with `ped_hair_cutout_alpha`. "Hair" role is only
   honoured in hair/berd/head slots.
5. **Texture usage flags lie** (a normal map flagged DIFFUSE). Name first, usage second, content
   (average ≈ (128,128,255) = normal map) third.
6. **Non-power-of-two sizes with 1 mip** (2136x2136, 1244x1224) are common in add-on packs – supported.
7. File names in the wild: `...^'jbib_diff_008_c_uni.ytd` (stray quote), `..._b_uni .ytd` (space) – tolerated.
8. A watch prop had a real `ped_alpha` geometry covering a tiny UV patch = the watch glass. That's
   exactly the "lens" signal we use.

---

## 4. The recolor algorithm (`src/core/recolor.js`)

Why naive methods fail: hue shift does nothing on black/white/grey; multiply keeps black black;
"replace colour" flattens wrinkles, seams, AO and prints.

All math is in **OKLab** (perceptually uniform: a lightness step looks the same on dark and light fabric).
Target `#d3ac92` = OKLab L 0.773, a 0.033, b 0.048 (chroma 0.058, hue 55°).

1. **Cloth texels** = not protected and alpha ≥ 16.
2. **Material hues**: hue histogram of chromatic cloth texels (C ≥ 0.045); peaks covering ≥ 8 %
   are *materials*.
3. **Accents (the design)**: chromatic texels whose hue is > ~32° away from every material hue
   (logos, stripes, stitching). They are cleaned into crisp regions (threshold → open → drop specks →
   1 px feather) and kept in their original colour (`keepAccents`, CLI `--tint-accents` to disable).
   Neutral texels (grey/black/white prints) are never accents: they are tinted and keep their contrast.
4. **Lightness materials**: modes of the cloth L-histogram (≥ 10 % share, ≥ 0.14 apart), e.g. black
   suit / white shirt / grey tie.
5. **Monotonic tone curve** (`buildToneCurve`): the dominant material's median lands exactly on the
   target L; every other material keeps its tonal order and separation (soft-knee compressed only as
   much as the headroom needs); inside each material the detail slope stays ≈ 1 (never below 0.35).
   Built from control points + LUT and forced non-decreasing, so shading can never invert.
6. **Chroma**: target hue/chroma, faded towards shadows/highlights like a dyed material
   (`chromaFalloff`), plus 25 % of the source's relative saturation variation when the source
   material was clearly coloured (heather, dirt).
7. **Gamut mapping**: out-of-gamut → reduce chroma at constant L and hue (binary search).
8. **Blend**: `out = mix(tinted, original, max(protect, accent))`. Alpha is never modified; for
   DXT3/DXT5 the original alpha blocks are copied bit-exact.
9. The plan (modes, hues) is computed once at mip 0 and applied to **every mip** with the mask
   downsampled, so mips stay consistent. Race variants of the same garment share one plan so the
   cloth comes out identical for every skin tone.

Tunables (`RECOLOR_DEFAULTS`): keepAccents, accentMaxShare, accentMinChroma, accentHueDistance,
contrast, chromaFalloff, keepChromaVariation, strength, materialSeparation, materialMinShare,
materialMinGap, minDetail, minL/maxL, knee.

---

## 5. Protection masks (`src/core/protect.js`, `src/color/skin.js`)

Everything that must not change goes into one feathered `protect` mask (1 = keep original).

### Skin (strongest source first)
1. **Race-variant diff** – `_whi`/`_bla`/... variants of one garment are identical on cloth and differ on
   skin. Pixels that differ = skin (plus tattoos baked on skin). Cleaned with open/close/hole-fill.
2. **Ped skin model** – robust 3-D Gaussian in OKLab fitted to THIS ped's `head_diff` texture
   (eyes, brows, lips filtered out by iterative trimming), with widened L variance for AO. Much
   tighter than a generic detector.
3. **Generic model** (no head texture): OKLab hue band. Measured:

| sample | OKLab h | C |
|---|---|---|
| skin pale → very dark (7 tones) | 42–53° | 0.03–0.09 |
| GTA `_whi`-like skin | 43° | 0.067 |
| khaki jacket (real texture) | 80–90° | 0.07 |
| brown work pants (real texture) | 60–90°, mostly 70s | 0.06 |
| olive | 96° | 0.06 |
| camel | 71° | 0.08 |
| leather brown | 50° ⚠ overlaps skin | 0.08 |

   The classic YCbCr rule scored ALL of these 1.0 → it protected whole tan jackets. The OKLab gate
   (22–68° with soft edges) fixes that. Without a ped model, a "skin" region covering > 55 %
   (race textures) / > 25 % (uni textures) of the visible garment is rejected as fabric.

Policy (`skin: 'auto'`): race textures → normal detection; `_uni` → strict; props → off.

### Tattoos
Tattoos (dark ink) aren't skin-coloured, so they are recovered as **holes enclosed by skin**
(`fillHoles`, up to 3 % of the texture), plus the race-diff catches them directly.

### Lenses / visors / glass
* **Alpha**: large regions with alpha in [6, 250] (tinted lenses, visors) on lens-policy components
  or any drawable with a glass/alpha shader.
* **Model UVs**: geometries whose shader is glass / `ped_alpha` / `*_alpha` / reflect are rasterised
  from their UV triangles into the texture → protected. If > 70 % of the drawable is "lens" the
  signal is ignored (whole prop drawn with an alpha shader for cut-outs).
* Name contains `lens|glass|visor|shield` → whole texture skipped.
* Opaque mirror visors with no alpha and no separate shader can't be told apart automatically →
  use `protectRects` (UV rectangles) for that texture.

### Decals / hair
Decal-shader geometries (`ped_decal*`) → protected via UVs (they're the printed design).
Hair-shader geometries in hair/berd/head slots → protected unless `recolorHair`.

---

## 6. Block compression (`src/texture/`)

* Decoders: BC1/2/3 per D3D spec (±1 LSB vs bcdec = within spec), BC7 all 8 modes (bit-exact vs bcdec).
* BC1 encoder: PCA axis → endpoints → 3 rounds of least-squares refinement in 565 → endpoint nudging;
  punch-through alpha preserved. Re-encoding a BC1 image ≈ 62 dB PSNR (visually lossless).
* BC7 encoder: mode 6 (smooth / alpha), mode 5 (separate alpha), mode 1 (2 subsets, best 8 of 64
  partitions) for hard edges. ≈ 54 dB on re-encode, ~43 dB on photographic content.

---

## 7. Validation done

* bcdec reference test images: BC7 bit-exact, DXT ±1.
* Real freemode clothing pack (Zerofour04/FiveM-ClothingPack): 14 diffuse textures (tops, pants with
  `_whi`, shoes, hat prop, watch prop with a glass geometry); 15 normal/spec correctly skipped;
  outputs re-parse; previews checked visually.
* Real single-file add-on peds (Ratchet-master/FiveM-Ready-Addon-Peds-Pack: `wick2`, a Batman suit
  renamed `a_m_y_runner_01`): head/teeth/hair untouched, bare-hands texture fully protected by the
  ped skin model, suit/shirt/tie keep tonal separation; resource flags + system segment byte-identical,
  every non-recolored texture byte-identical.
* `npm test`: synthetic peds (skin + tattoo + khaki strip + tinted lens, race variants) assert exact
  keep/change behaviour.

## 8. Known limits / next steps
* Gen9 (Enhanced) resources are rejected (FiveM uses legacy).
* Skin-coloured *leather* next to skin with no head texture can still be ambiguous → pass
  `skinTones` or `--skin-tone`, or `protectRects`.
* A ~30 texture ped takes ~30 s single-threaded; a `worker_threads` pool per texture group is the
  obvious speed-up if the app needs it.
* `.ymt` is never edited: recoloring changes pixels only, so no meta changes are needed.
