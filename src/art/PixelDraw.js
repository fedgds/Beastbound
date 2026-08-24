/**
 * PixelDraw — everything that puts colour on the screen goes through here, so
 * baked textures and live effects land on the same grid.
 *
 * Two halves:
 *
 *  1. Bake-time helpers (`px`, `dot`, `dither`, `speckle`, `crack`, …) used once
 *     per floor to author the room's textures. These are how the stone gets its
 *     grain: shading is *dithered*, never blended, because a smooth gradient is
 *     the thing that gives a pixel-art surface away as having been generated.
 *
 *  2. Runtime rasterisers (`pxArc`, `pxDisc`, `pxLine`, `pxStar`) for effects.
 *     Phaser's `strokeCircle` / `arc` / `strokePath` draw anti-aliased vector
 *     geometry: a smooth 1px hairline that fades at the edges. Next to nearest-
 *     neighbour sprites that reads as a UI overlay rather than as part of the
 *     game, and it is the single biggest tell that an effect was not drawn by an
 *     artist. So every ring, arc and line here is sampled and stamped as P*P
 *     blocks, giving the stair-stepped silhouette of hand-plotted art.
 *
 * Bake helpers set their own fill. Runtime rasterisers do not — the caller sets
 * `g.fillStyle(color, alpha)` once and plots many shapes into it.
 */

/** Art grid. Every coordinate in the game is a multiple of this. */
export const P = 2;

export const snap = (v) => Math.round(v / P) * P;

/**
 * Ground-plane rings are squashed: the arena is viewed at a slight angle, and
 * a true circle painted on the floor would read as a hoop standing upright.
 * Matches the 56x42 slab proportion.
 */
export const GROUND_SQUASH = 0.55;

// ═══ colour ════════════════════════════════════════════════════════════════

function mix(color, target, amount) {
  const k = Math.max(0, Math.min(1, amount));
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const tr = (target >> 16) & 0xff;
  const tg = (target >> 8) & 0xff;
  const tb = target & 0xff;
  return ((Math.round(r + (tr - r) * k) << 16)
    | (Math.round(g + (tg - g) * k) << 8)
    | Math.round(b + (tb - b) * k));
}

/** Toward white — a lit face. */
export const lighten = (color, amount) => mix(color, 0xffffff, amount);

/** Toward black — a face turned away from the torch. */
export const darken = (color, amount) => mix(color, 0x000000, amount);

// ═══ determinism ═══════════════════════════════════════════════════════════

/**
 * Seeded PRNG factory (mulberry32). Every texture that has "random" grain is
 * baked from one of these, so a floor looks identical every time it is built —
 * a wall whose speckle reshuffles on retry reads as flicker, not as stone.
 */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Positional hash in [0,1). For grain that has to depend on *where* it is. */
export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d)
    ^ Math.imul(y | 0, 0x165667b1)
    ^ Math.imul(seed | 0, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// ═══ bake-time plotting ════════════════════════════════════════════════════

/** Rect, snapped to the grid, never thinner than one block. */
export function px(g, x, y, w, h, color, alpha = 1) {
  const x0 = snap(x);
  const y0 = snap(y);
  g.fillStyle(color, alpha);
  g.fillRect(x0, y0, Math.max(P, snap(x + w) - x0), Math.max(P, snap(y + h) - y0));
}

/** A single block. */
export function dot(g, x, y, color, alpha = 1) {
  g.fillStyle(color, alpha);
  g.fillRect(snap(x), snap(y), P, P);
}

/**
 * Ordered 4x4 Bayer matrix. Thresholded against a coverage fraction it gives
 * the even, woven scatter of hand-dithered shading — where random sampling
 * clumps and reads as dirt.
 */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Fills a rect at partial coverage: `density` 0 draws nothing, 1 draws solid,
 * 0.5 draws a checkerboard.
 *
 * The matrix is indexed in *world* block coordinates rather than per-call, so
 * two adjacent calls interlock instead of showing a seam at the boundary.
 */
export function dither(g, x, y, w, h, color, density = 0.5, alpha = 1) {
  if (density <= 0) return;
  g.fillStyle(color, alpha);
  const bx0 = Math.round(x / P);
  const by0 = Math.round(y / P);
  const bw = Math.max(1, Math.round(w / P));
  const bh = Math.max(1, Math.round(h / P));
  for (let by = 0; by < bh; by++) {
    const row = BAYER4[(by0 + by) & 3];
    for (let bx = 0; bx < bw; bx++) {
      if ((row[(bx0 + bx) & 3] + 0.5) / 16 >= density) continue;
      g.fillRect((bx0 + bx) * P, (by0 + by) * P, P, P);
    }
  }
}

/**
 * Vertical dither gradient: coverage walks from `from` at the top edge to `to`
 * at the bottom. `power` bends the ramp — 1 is linear, higher keeps the light
 * end clean for longer.
 */
export function ditherRampV(g, x, y, w, h, color, from, to, power = 1) {
  const bh = Math.max(1, Math.round(h / P));
  for (let i = 0; i < bh; i++) {
    const t = bh === 1 ? 0 : i / (bh - 1);
    dither(g, x, y + i * P, w, P, color, from + (to - from) * (power === 1 ? t : t ** power));
  }
}

/** `count` scattered blocks inside a rect: chips, moss, soot. */
export function speckle(g, x, y, w, h, color, count, rand = Math.random, alpha = 1) {
  g.fillStyle(color, alpha);
  const bx0 = Math.round(x / P);
  const by0 = Math.round(y / P);
  const bw = Math.max(1, Math.round(w / P));
  const bh = Math.max(1, Math.round(h / P));
  for (let i = 0; i < count; i++) {
    g.fillRect(
      (bx0 + Math.floor(rand() * bw)) * P,
      (by0 + Math.floor(rand() * bh)) * P,
      P, P,
    );
  }
}

/**
 * A fracture running `len` blocks from (x, y) on the given heading.
 *
 * It wanders as it goes — a straight line reads as a scratch, and the small
 * accumulating drift is what makes it read as stone having failed.
 */
export function crack(g, x, y, len, angle, color, rand = Math.random, alpha = 1) {
  g.fillStyle(color, alpha);
  let bx = Math.round(x / P);
  let by = Math.round(y / P);
  let a = angle;
  for (let i = 0; i < len; i++) {
    g.fillRect(bx * P, by * P, P, P);
    a += (rand() - 0.5) * 0.9;
    // one block per step, and it can never stall: if |cos| rounds to 0 then
    // |sin| is over 0.86 and rounds to 1
    bx += Math.round(Math.cos(a));
    by += Math.round(Math.sin(a));
  }
}

/**
 * Bakes a white radial mask texture for additive light — torch pools, flame
 * cores, drifting motes. Callers tint and scale it.
 *
 * The falloff is quantised into `steps` hard bands. Light is the one thing in
 * this game allowed to be soft, but a *continuous* ramp still looks like a
 * shader was pointed at the scene; banding it puts the glow back in the same
 * idiom as the stone it falls on.
 *
 * @param {number} size texture width/height in px
 * @param {object} [o]
 * @param {number} [o.steps] number of alpha bands
 * @param {number} [o.power] falloff exponent; higher = tighter core
 * @param {number} [o.inner] radius fraction held at full alpha
 */
export function bakeRadial(scene, key, size, o = {}) {
  const { steps = 5, power = 2, inner = 0.1 } = o;
  if (scene.textures.exists(key)) return;

  const tex = scene.textures.createCanvas(key, size, size);
  const ctx = tex.getContext();
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const c = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      let a = 0;
      if (r < 1) {
        const f = r <= inner ? 1 : ((1 - r) / (1 - inner)) ** power;
        a = Math.round(f * steps) / steps;
      }
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = Math.round(Math.min(1, a) * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  tex.refresh();
}

// ═══ runtime rasterisers ═══════════════════════════════════════════════════

/**
 * Plots an ellipse outline, or an arc of one.
 *
 * Sampling is deduped: overlapping samples would otherwise double-darken a
 * translucent fill and the ring would come out blotchy.
 *
 * @param {Phaser.GameObjects.Graphics} g
 * @param {number} rx horizontal radius in px
 * @param {number} ry vertical radius in px
 * @param {object} [o]
 * @param {number} [o.from] start angle, radians
 * @param {number} [o.to] end angle, radians
 * @param {number} [o.dash] dash length in blocks; 0 = solid
 * @param {number} [o.gap] gap length in blocks
 * @param {number} [o.rot] rotates the dash pattern without moving the ellipse
 */
export function pxArc(g, cx, cy, rx, ry, o = {}) {
  const { from = 0, to = Math.PI * 2, dash = 0, gap = 0, rot = 0 } = o;
  const rMax = Math.max(rx, ry);
  if (rMax < P) return;

  // one sample per block of arc length, so the outline can never gap
  const step = Math.min(0.3, P / rMax);
  const bcx = Math.round(cx / P);
  const bcy = Math.round(cy / P);
  const bx = rx / P;
  const by = ry / P;
  const period = dash + gap;
  const seen = new Set();

  for (let a = from; a <= to; a += step) {
    if (period > 0) {
      const run = (((a + rot) * bx) % period + period) % period;
      if (run >= dash) continue;
    }
    const px1 = bcx + Math.round(Math.cos(a) * bx);
    const py1 = bcy + Math.round(Math.sin(a) * by);
    const k = px1 * 8192 + py1;
    if (seen.has(k)) continue;
    seen.add(k);
    g.fillRect(px1 * P, py1 * P, P, P);
  }
}

/** Solid ground-plane ring at the given radius. */
export function pxGroundRing(g, cx, cy, r, o = {}) {
  pxArc(g, cx, cy, r, r * GROUND_SQUASH, o);
}

/**
 * Filled ellipse, one span per block row — so a 140px danger circle costs ~70
 * draw commands rather than ~15 000 individual blocks.
 *
 * @param {object} [o]
 * @param {number} [o.every] draw only every Nth row: horizontal scanlines, the
 *   pixel-art idiom for "this area is claimed but not yet active"
 * @param {number} [o.inner] punch a concentric hole of this horizontal radius,
 *   so a scanlined pending area and a solid charged area can share a centre
 *   without double-darkening where they overlap
 */
export function pxDisc(g, cx, cy, rx, ry, o = {}) {
  const { every = 1, inner = 0 } = o;
  const bx = rx / P;
  if (bx <= 0) return;
  const bcx = Math.round(cx / P);
  const bcy = Math.round(cy / P);
  const by = Math.max(1, ry / P);
  const ibx = inner / P;
  const iby = ibx * (by / bx);
  const rows = Math.round(by);

  for (let y = -rows; y <= rows; y++) {
    if (every > 1 && ((((bcy + y) % every) + every) % every) !== 0) continue;
    const t = 1 - (y * y) / (by * by);
    if (t <= 0) continue;
    const w = Math.round(bx * Math.sqrt(t));

    if (ibx > 0 && Math.abs(y) < iby) {
      const it = 1 - (y * y) / (iby * iby);
      const iw = Math.round(ibx * Math.sqrt(Math.max(0, it)));
      if (iw >= w) continue;
      g.fillRect((bcx - w) * P, (bcy + y) * P, (w - iw) * P, P);
      g.fillRect((bcx + iw + 1) * P, (bcy + y) * P, (w - iw) * P, P);
      continue;
    }
    g.fillRect((bcx - w) * P, (bcy + y) * P, (w * 2 + 1) * P, P);
  }
}

/**
 * Filled horizontal cone — the shape every cone telegraph in the game uses,
 * pointing left or right from (cx, cy).
 *
 * Row-spanned like `pxDisc`, and quantised to the block grid, so the sloping
 * edges come out as honest stair-steps instead of a smooth vector wedge.
 *
 * @param {number} half half-angle in radians
 * @param {number} dirX -1 points left, +1 points right
 * @param {object} [o] `every` and `inner`, as `pxDisc`
 */
export function pxCone(g, cx, cy, r, half, dirX, o = {}) {
  const { every = 1, inner = 0 } = o;
  const br = Math.round(r / P);
  if (br < 1) return;
  const bcx = Math.round(cx / P);
  const bcy = Math.round(cy / P);
  const bi = Math.round(inner / P);
  const slope = Math.tan(Math.min(Math.max(half, 0.02), Math.PI / 2 - 0.02));

  for (let y = -br; y <= br; y++) {
    if (every > 1 && ((((bcy + y) % every) + every) % every) !== 0) continue;
    const outer = Math.floor(Math.sqrt(Math.max(0, br * br - y * y)));
    let from = Math.ceil(Math.abs(y) / slope);
    if (bi > 0) {
      const charged = Math.floor(Math.sqrt(Math.max(0, bi * bi - y * y)));
      if (charged >= from) from = charged + 1;
    }
    if (from > outer) continue;
    g.fillRect(
      (dirX < 0 ? bcx - outer : bcx + from) * P,
      (bcy + y) * P,
      (outer - from + 1) * P, P,
    );
  }
}

/** Bresenham line, one block per step. */
export function pxLine(g, x0, y0, x1, y1) {
  let bx = Math.round(x0 / P);
  let by = Math.round(y0 / P);
  const tx = Math.round(x1 / P);
  const ty = Math.round(y1 / P);
  const dx = Math.abs(tx - bx);
  const dy = Math.abs(ty - by);
  const sx = bx < tx ? 1 : -1;
  const sy = by < ty ? 1 : -1;
  let err = dx - dy;
  for (let guard = 0; guard < 4096; guard++) {
    g.fillRect(bx * P, by * P, P, P);
    if (bx === tx && by === ty) return;
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; bx += sx; }
    if (e2 < dx) { err += dx; by += sy; }
  }
}

/**
 * A four-point star / spark: the shape a bright impact reads as in pixel art,
 * where a round glow would just be a blurry dot.
 */
export function pxStar(g, cx, cy, arm) {
  const x = snap(cx);
  const y = snap(cy);
  const a = Math.max(P, snap(arm));
  g.fillRect(x - a, y, a * 2 + P, P);
  g.fillRect(x, y - a, P, a * 2 + P);
  if (a > P * 2) {
    const h = a - P * 2;
    g.fillRect(x - h, y - P, h * 2 + P, P * 3);
    g.fillRect(x - P, y - h, P * 3, h * 2 + P);
  }
}
