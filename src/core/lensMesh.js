'use strict';
/**
 * Lens / visor detection from the MESH (model knowledge), for props whose lenses are
 * opaque and share the frame's shader (no alpha, no glass shader to go on).
 *
 * The drawable is split into connected pieces (triangles sharing vertices). A piece is
 * a lens when:
 *   - its surface normals agree (area-weighted coherence) -> a pane, not a helmet shell
 *   - its UV island has no holes                          -> not the frame ring around a lens
 *   - its UV island is compact                            -> not a temple arm / strap
 *   - its texels are one even colour                      -> a tinted/mirrored pane
 *   - that colour clearly differs from the rest of the prop -> not a cap brim in cap colour
 */
const M = require('./masks');

/**
 * Weld vertices that share position AND UV (many exporters write every triangle with its own
 * vertices – a real helmet came in as 2554 one-triangle "pieces"). Returns a vertex -> id map.
 */
function weldMap(pos, uv, vcount) {
  const ids = new Int32Array(vcount);
  const seen = new Map();
  const q = (v) => Math.round(v * 1e4);
  for (let v = 0; v < vcount; v++) {
    const key = `${q(pos[v * 3])},${q(pos[v * 3 + 1])},${q(pos[v * 3 + 2])},${q(uv[v * 2])},${q(uv[v * 2 + 1])}`;
    let id = seen.get(key);
    if (id === undefined) { id = v; seen.set(key, v); }
    ids[v] = id;
  }
  return ids;
}

function components(indices, vcount, weld) {
  const parent = new Int32Array(vcount).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = find(weld[indices[t]]), b = find(weld[indices[t + 1]]), c = find(weld[indices[t + 2]]);
    parent[b] = a; parent[find(c)] = a;
  }
  const byRoot = new Map();
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const r = find(weld[indices[t]]);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(t);
  }
  return [...byRoot.values()];
}

/**
 * @param {Array<{mesh:{pos:Float32Array,uv:Float32Array,indices:Uint16Array,vertexCount:number}}>} geoms
 * @param {{L:Float32Array,A:Float32Array,B:Float32Array}} planes  texture in OKLab
 * @returns {{mask:Float32Array, pieces:object[]}|null}
 */
function lensFromMesh(geoms, planes, w, h, { minCoherence = 0.75, maxHoleFrac = 0.06, maxAspect = 3.2, maxStd = 0.06, minContrast = 0.12, minUV = 0.002, debug = false, forwardAxis = null, minForward = 0.6 } = {}) {
  const n = w * h;
  const pieces = [];
  for (const g of geoms) {
    const m = g.mesh; if (!m || !m.pos || !m.indices) continue;
    for (const tris of components(m.indices, m.vertexCount, weldMap(m.pos, m.uv, m.vertexCount))) {
      let nx = 0, ny = 0, nz = 0, area = 0;
      const uvTris = new Float32Array(tris.length * 6);
      tris.forEach((t, k) => {
        const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const ax = m.pos[b * 3] - m.pos[a * 3], ay = m.pos[b * 3 + 1] - m.pos[a * 3 + 1], az = m.pos[b * 3 + 2] - m.pos[a * 3 + 2];
        const bx = m.pos[c * 3] - m.pos[a * 3], by = m.pos[c * 3 + 1] - m.pos[a * 3 + 1], bz = m.pos[c * 3 + 2] - m.pos[a * 3 + 2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        nx += cx; ny += cy; nz += cz; area += Math.hypot(cx, cy, cz);
        for (const [j, v] of [[0, a], [1, b], [2, c]]) { uvTris[k * 6 + j * 2] = m.uv[v * 2]; uvTris[k * 6 + j * 2 + 1] = m.uv[v * 2 + 1]; }
      });
      if (area <= 0) continue;
      const coherence = Math.hypot(nx, ny, nz) / area;
      // how much the pane faces the prop's forward axis (head props: +Y in head-bone space)
      const facing = forwardAxis ? Math.abs(nx * forwardAxis[0] + ny * forwardAxis[1] + nz * forwardAxis[2]) / (Math.hypot(nx, ny, nz) || 1) : 1;
      const island = M.rasterizeUVTriangles(uvTris, w, h);
      pieces.push({ triangles: tris.length, coherence, facing, island });
    }
  }
  if (pieces.length < 2) return null;
  // median colour (robust: the rest of a prop is "the frame", not frame+lens averaged)
  const stat = (mask) => {
    const Ls = [], As = [], Bs = [];
    let s = 0, s2 = 0;
    const step = Math.max(1, Math.floor(n / 400000));
    for (let i = 0; i < n; i += step) if (mask[i]) { const L = planes.L[i]; Ls.push(L); As.push(planes.A[i]); Bs.push(planes.B[i]); s += L; s2 += L * L; }
    const c = Ls.length;
    if (!c) return null;
    const med = (a) => Float32Array.from(a).sort()[a.length >> 1];
    const mL = s / c;
    return { L: med(Ls), A: med(As), B: med(Bs), std: Math.sqrt(Math.max(0, s2 / c - mL * mL)), count: c };
  };
  const lens = new Uint8Array(n);
  let totalTris = 0, lensTris = 0;
  for (const p of pieces) totalTris += p.triangles;
  const used = new Uint8Array(n);
  for (const p of pieces) for (let i = 0; i < n; i++) if (p.island[i]) used[i] = 1;
  // pass 1: shape tests (coherent pane, no hole, compact)
  for (const p of pieces) {
    p.uvCov = p.island.reduce((x, v) => x + v, 0);
    p.shapeOk = false;
    // a lens/visor looks FORWARD; a flat panel facing down (neck liner) or sideways is not one.
    // Visors wrap around (less flat than a glasses lens) and are often UV-collapsed onto a tiny
    // solid patch, so forward-facing pieces get a looser flatness bound and no minimum UV area.
    const forwardPane = !!forwardAxis && p.facing >= 0.85;
    const minCoh = forwardPane ? Math.min(minCoherence, 0.6) : minCoherence;
    if (p.uvCov < (forwardPane ? 16 : n * minUV) || p.coherence < minCoh || p.facing < minForward) continue;
    p.forwardPane = forwardPane;
    const filled = M.fillHoles(p.island, w, h, n);
    const fcov = filled.reduce((x, v) => x + v, 0);
    p.holeFrac = (fcov - p.uvCov) / fcov;
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, k = 0;
    for (let i = 0; i < n; i++) if (p.island[i]) { const x = i % w, y = (i / w) | 0; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; k++; }
    const vx = sxx / k - (sx / k) ** 2, vy = syy / k - (sy / k) ** 2, cxy = sxy / k - (sx / k) * (sy / k);
    const tr = vx + vy, det = Math.sqrt(((vx - vy) / 2) ** 2 + cxy * cxy);
    p.aspect = Math.sqrt((tr / 2 + det) / Math.max(1e-9, tr / 2 - det));
    p.shapeOk = p.holeFrac <= maxHoleFrac && p.aspect <= maxAspect;
  }
  // "the frame" = pieces that are definitely not panes; candidates must differ from it
  const frame = new Uint8Array(n);
  for (const p of pieces) if (!p.shapeOk) for (let i = 0; i < n; i++) if (p.island[i]) frame[i] = 1;
  const fs = stat(frame);
  // pass 2: colour tests
  for (const p of pieces) {
    p.lens = false;
    if (!p.shapeOk) continue;
    const st = stat(M.erode(p.island, w, h, 2)) || stat(p.island);
    p.std = st.std;
    p.contrast = fs ? Math.hypot(st.L - fs.L, st.A - fs.A, st.B - fs.B) : 1;
    p.L = st.L;
    // tinted visor: forward pane in one very dark colour – it may match a black shell exactly
    const darkVisor = p.forwardPane && st.L < 0.12;
    p.lens = p.std <= maxStd && (p.contrast >= minContrast || darkVisor);
    if (p.lens) {
      lensTris += p.triangles;
      // only texels that actually carry the lens colour: an island can graze the frame
      // colour at its border, and dilating that would leave a frame sliver un-recolored
      for (let i = 0; i < n; i++) {
        if (!p.island[i]) continue;
        if (Math.hypot(planes.L[i] - st.L, planes.A[i] - st.A, planes.B[i] - st.B) < Math.max(0.08, p.contrast * 0.5)) lens[i] = 1;
      }
    }
  }
  const lcov = lens.reduce((x, v) => x + v, 0), ucov = used.reduce((x, v) => x + v, 0);
  void ucov;
  if (debug) return { lensTris, totalTris, pieces: pieces.map(({ island, ...r }) => ({ ...r, uv: island.reduce((x, v) => x + v, 0) / n })), lcov: lcov / n, ucov: ucov / n };
  // "most of the model is lens" = wrong reading (lenses are a handful of triangles; UV
  // area is no guide – modders often give lenses a big chunk of texture space)
  if (!lcov || lensTris > totalTris * 0.5) return null;
  // grow only into texels of the same lens colour (covers DXT edge blocks, not the frame)
  const mask = M.boxBlur(M.toFloat(M.dilate(lens, w, h, 1)), w, h, 1);
  return { mask, pieces: pieces.map(({ island, ...r }) => r) };
}

/**
 * Rasterised UV island of every connected mesh piece (after welding). Used by skin/tattoo
 * logic: a leg, an arm and a shorts panel are separate pieces with separate islands.
 * @returns {Array<{triangles:number, island:Uint8Array, area:number}>}
 */
function meshIslands(geoms, w, h) {
  const out = [];
  for (const g of geoms || []) {
    const m = g.mesh; if (!m || !m.pos || !m.indices || !m.uv) continue;
    for (const tris of components(m.indices, m.vertexCount, weldMap(m.pos, m.uv, m.vertexCount))) {
      const uvTris = new Float32Array(tris.length * 6);
      tris.forEach((t, k) => { for (let j = 0; j < 3; j++) { const v = m.indices[t + j]; uvTris[k * 6 + j * 2] = m.uv[v * 2]; uvTris[k * 6 + j * 2 + 1] = m.uv[v * 2 + 1]; } });
      const island = M.rasterizeUVTriangles(uvTris, w, h);
      let area = 0; for (let i = 0; i < island.length; i++) area += island[i];
      if (area) out.push({ triangles: tris.length, island, area });
    }
  }
  return out;
}

module.exports = { lensFromMesh, meshIslands };
