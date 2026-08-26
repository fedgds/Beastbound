/**
 * SkillForms — solid, shaded pixel-art primitives for skill effects.
 *
 * PixelDraw gives us honest rasterisers (lines, arcs, discs). What it does not
 * give us is *volume*. A fan of `pxLine` rays plus two dashed ground rings will
 * always read as line-art laid over the scene, however many of them there are.
 * The two effects in this game that read as drawn-by-hand — Ice Wall and
 * Glacial Lance — do one thing differently: every shape is built from stacked
 * solid bands with a dark face on one side, a glint on the other, and a
 * stair-stepped silhouette that never resolves into a clean primitive.
 *
 * This module generalises that recipe. Each form takes a `palette` (an array of
 * hand-authored tones, index 0 brightest) and a `tone` index, then derives its
 * own shadow and highlight by *stepping along the ramp* rather than blending
 * toward white — which is what keeps a whole effect inside one deliberate
 * palette instead of washing out.
 *
 * Conventions shared by every export:
 *   - the caller owns the Graphics and its depth; forms only set `fillStyle`
 *   - `alpha` scales the whole form, so a caller can fade it per frame
 *   - `squash` (default 1) flattens vertically; pass GROUND_SQUASH for floors
 *   - nothing is randomised at draw time. Wobble is derived from the block
 *     index or an explicit `seed`, so a form redrawn every frame never shimmers
 */

import { GROUND_SQUASH, P, pxDisc, pxLine, snap } from './PixelDraw.js';

/** Palette lookup, clamped — forms step off both ends of the ramp freely. */
export function shade(palette, i) {
  return palette[Math.max(0, Math.min(palette.length - 1, Math.round(i)))];
}

/** One block, in whatever fill the caller set. */
function blk(g, x, y) {
  g.fillRect(snap(x), snap(y), P, P);
}

/** Deterministic wobble in [-1, 1] from an integer index. */
function wob(i, seed = 0) {
  const h = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

/**
 * The workhorse: a solid tapered wedge cast from (cx, cy) along `angle`.
 *
 * This replaces every `pxLine` ray in the codebase. A ray has no silhouette; a
 * wedge has a wide root, a point, a shaded trailing face and a lit leading one,
 * so a crown of eight of them reads as forged metal rather than as a starburst.
 *
 * @param {object} o
 * @param {number[]} o.palette tone ramp, 0 = brightest
 * @param {number} [o.tone] index into the ramp for the body fill
 * @param {number} o.angle heading, radians
 * @param {number} [o.r0] inner radius (the root)
 * @param {number} [o.r1] outer radius (the point)
 * @param {number} [o.w0] width at the root, px
 * @param {number} [o.w1] width at the point, px
 * @param {number} [o.taper] 1 = linear, >1 holds the width then pinches late
 * @param {boolean} [o.notch] break the straight edge with 1-block chips
 * @param {boolean} [o.core] plot a bright centre line on wide sections
 */
export function solidWedge(g, cx, cy, o) {
  const {
    palette, tone = 2, angle, r0 = 0, r1 = 40, w0 = 12, w1 = 2,
    alpha = 1, squash = 1, taper = 1, notch = true, glint = true,
    core = false, seed = 0,
  } = o;
  const span = r1 - r0;
  if (span < P || alpha <= 0) return;
  const steps = Math.max(2, Math.round(span / P));
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const nx = -sa;
  const ny = ca * squash;
  const body = shade(palette, tone);
  const dark = shade(palette, tone + 2);
  const lit = shade(palette, tone - 2);

  for (let i = 0; i <= steps; i++) {
    const q = i / steps;
    const r = r0 + span * q;
    let w = w0 + (w1 - w0) * (taper === 1 ? q : q ** taper);
    if (notch) w += Math.round(wob(i, seed)) * P;
    w = Math.max(P, w);
    const bx = cx + ca * r;
    const by = cy + sa * r * squash;
    const ex = nx * (w / 2);
    const ey = ny * (w / 2);
    g.fillStyle(body, alpha);
    pxLine(g, bx - ex, by - ey, bx + ex, by + ey);
    if (w < P * 3) continue;
    g.fillStyle(dark, alpha * 0.85);
    blk(g, bx + ex, by + ey);
    if (glint && i % 2 === 0) {
      g.fillStyle(lit, alpha * 0.95);
      blk(g, bx - ex, by - ey);
    }
    if (core && w >= P * 5) {
      g.fillStyle(shade(palette, tone - 3), alpha * 0.85);
      blk(g, bx, by);
    }
  }
}

/**
 * A thick arc with body: the swung-blade / shockwave-shell primitive.
 *
 * `taperEnds` bells the thickness toward the middle of the sweep, which is what
 * makes it read as one stroke of a weapon instead of a slice cut out of a hoop.
 * The inner edge takes the shadow tone and the outer rim the highlight, so the
 * band appears to be a surface facing away from the caster.
 */
export function solidArcBand(g, cx, cy, o) {
  const {
    palette, tone = 2, from, to, r, thickness = 6, alpha = 1,
    squash = 1, taperEnds = 0.55, glint = true, notch = true, seed = 0,
  } = o;
  if (r < P || alpha <= 0) return;
  const arc = to - from;
  const n = Math.max(3, Math.round((Math.abs(arc) * r) / P));
  const body = shade(palette, tone);
  const dark = shade(palette, tone + 2);
  const lit = shade(palette, tone - 2);

  for (let i = 0; i <= n; i++) {
    const q = i / n;
    const a = from + arc * q;
    const bell = taperEnds > 0 ? Math.sin(Math.PI * q) ** taperEnds : 1;
    let t = thickness * bell;
    if (notch) t += Math.round(wob(i, seed)) * P;
    t = Math.max(P, snap(t));
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x0 = cx + ca * (r - t / 2);
    const y0 = cy + sa * (r - t / 2) * squash;
    const x1 = cx + ca * (r + t / 2);
    const y1 = cy + sa * (r + t / 2) * squash;
    g.fillStyle(body, alpha);
    pxLine(g, x0, y0, x1, y1);
    if (t < P * 3) continue;
    g.fillStyle(dark, alpha * 0.8);
    blk(g, x0, y0);
    if (glint && i % 2 === 0) {
      g.fillStyle(lit, alpha);
      blk(g, x1, y1);
    }
  }
}

/**
 * A solid ground ring with real thickness — the anchor almost every effect
 * needs. A 1-block dashed `pxGroundRing` floats; a band with a dark inner lip
 * and a lit outer crest reads as a ridge of displaced stone.
 *
 * `bite` scallops the outer edge so the ring is never a perfect ellipse.
 */
export function groundBand(g, cx, cy, r, o = {}) {
  const {
    palette, tone = 3, thickness = 5, alpha = 1, bite = 1,
    seed = 0, glint = true, arcFrom = 0, arcTo = Math.PI * 2,
  } = o;
  if (r < P || alpha <= 0) return;
  const n = Math.max(8, Math.round((r * Math.abs(arcTo - arcFrom)) / P));
  const body = shade(palette, tone);
  const dark = shade(palette, tone + 2);
  const lit = shade(palette, tone - 2);

  for (let i = 0; i <= n; i++) {
    const a = arcFrom + (arcTo - arcFrom) * (i / n);
    const t = Math.max(P, snap(thickness + wob(i, seed) * bite * P));
    const ca = Math.cos(a);
    const sa = Math.sin(a) * GROUND_SQUASH;
    const x0 = cx + ca * (r - t / 2);
    const y0 = cy + sa * (r - t / 2);
    const x1 = cx + ca * (r + t / 2);
    const y1 = cy + sa * (r + t / 2);
    g.fillStyle(body, alpha);
    pxLine(g, x0, y0, x1, y1);
    if (t < P * 2) continue;
    g.fillStyle(dark, alpha * 0.9);
    blk(g, x0, y0);
    // the near side of the ridge is the face the torchlight actually reaches
    if (glint && i % 3 === 0 && sa >= 0) {
      g.fillStyle(lit, alpha);
      blk(g, x1, y1);
    }
  }
}

/**
 * A branching fracture across the floor, drawn with a bright hairline inside a
 * darker channel so it reads as depth rather than as a drawn line. `reveal`
 * grows it from the origin outward, which is how a crack should ever appear.
 */
export function groundCrack(g, x, y, o) {
  const {
    palette, tone = 4, angle, length = 40, alpha = 1, reveal = 1,
    seed = 0, branches = 2, width = 3,
  } = o;
  const len = length * Math.max(0, Math.min(1, reveal));
  if (len < P * 2 || alpha <= 0) return;
  const steps = Math.max(2, Math.round(len / P));
  const dark = shade(palette, tone + 2);
  const hot = shade(palette, tone - 2);
  let a = angle;
  let px0 = x;
  let py0 = y;
  const pts = [];

  for (let i = 0; i < steps; i++) {
    a = angle + wob(i, seed) * 0.42 * (i / steps);
    const w = Math.max(P, snap(width * (1 - i / steps)));
    const nx = px0 + Math.cos(a) * P;
    const ny = py0 + Math.sin(a) * P * GROUND_SQUASH;
    g.fillStyle(dark, alpha);
    pxLine(g, px0, py0 - w / 2, px0, py0 + w / 2);
    if (i % 2 === 0) {
      g.fillStyle(hot, alpha * 0.85);
      blk(g, px0, py0);
    }
    if (i > steps * 0.3 && i % 5 === 0) pts.push({ x: px0, y: py0, a, i });
    px0 = nx;
    py0 = ny;
  }

  for (let b = 0; b < branches && b < pts.length; b++) {
    const p = pts[pts.length - 1 - b];
    groundCrack(g, p.x, p.y, {
      palette, tone, angle: p.a + (b % 2 ? 0.85 : -0.85), alpha: alpha * 0.8,
      length: (len - p.i * P) * 0.55, reveal: 1, seed: seed + b * 7 + 3,
      branches: 0, width: Math.max(P, width - P),
    });
  }
}

/**
 * A licking flame: stacked bands whose profile swells low and pinches to a
 * point, with three nested tone layers so it has an outer skin, a body and a
 * white-hot core. `sway` bends the spine, `seed` phases the bend.
 */
export function flameTongue(g, x, y, o) {
  const {
    palette, tone = 3, height = 26, width = 12, angle = -Math.PI / 2,
    alpha = 1, sway = 0, grow = 1, seed = 0, coreTone = null, squash = 1,
  } = o;
  const h = height * grow;
  if (h < P * 2 || alpha <= 0) return;
  const bands = Math.max(3, Math.round(h / (P * 2)));
  const ca = Math.cos(angle);
  const sa = Math.sin(angle) * squash;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle) * squash;
  const skin = shade(palette, tone + 1);
  const body = shade(palette, tone);
  const core = shade(palette, coreTone ?? tone - 3);

  for (let b = 0; b < bands; b++) {
    const q = b / (bands - 1 || 1);
    const prof = Math.sin(Math.PI * (0.2 + q * 0.8)) ** 0.8 * (1 - q * 0.5);
    const w = Math.max(P, snap(width * prof));
    const lean = Math.sin(q * 2.6 + seed) * sway * q;
    const d = h * q;
    const bx = x + ca * d + nx * lean;
    const by = y + sa * d + ny * lean;
    const put = (ww, color, al) => {
      g.fillStyle(color, al);
      pxLine(g, bx - nx * (ww / 2), by - ny * (ww / 2), bx + nx * (ww / 2), by + ny * (ww / 2));
    };
    put(w, skin, alpha * (0.6 + q * 0.25));
    if (w >= P * 3) put(Math.max(P, w - P * 2), body, alpha * 0.95);
    if (w >= P * 5 && q < 0.74) put(Math.max(P, w - P * 4), core, alpha);
  }
  g.fillStyle(shade(palette, tone - 1), alpha * 0.9);
  blk(g, x + ca * h, y + sa * h);
}

/**
 * A shaded lump of debris — thrown stone, ice chip, ember. Dented off-round on
 * purpose: the top rows take the lighter tone, the right edge the shadow, so a
 * dozen of these read as tumbling solids rather than as square particles.
 */
export function debrisChunk(g, x, y, o) {
  const {
    palette, tone = 3, size = 8, alpha = 1, seed = 0, squash = 0.85, spin = 0,
  } = o;
  const r = Math.max(P, snap(size));
  if (alpha <= 0) return;
  const rows = Math.max(1, Math.round((r * squash) / P));
  const body = shade(palette, tone);
  const dark = shade(palette, tone + 2);

  for (let i = -rows; i <= rows; i++) {
    const q = i / (rows + 0.35);
    let w = Math.sqrt(Math.max(0, 1 - q * q)) * r + wob(i * 3 + spin, seed) * P;
    w = Math.max(P, snap(w));
    const yy = snap(y + i * P);
    g.fillStyle(i < 0 ? shade(palette, tone - 1) : body, alpha);
    g.fillRect(snap(x - w), yy, w * 2, P);
    g.fillStyle(dark, alpha * 0.85);
    blk(g, x + w - P, yy);
  }
  g.fillStyle(shade(palette, tone - 3), alpha);
  blk(g, x - r * 0.35, y - rows * P + P);
}

/**
 * A fan of solid shards thrown along `angle`. Replaces the 1-block "mote"
 * scatter: shards have length, taper and a shaded side, so a burst has weight.
 */
export function shardFan(g, x, y, o) {
  const {
    palette, tone = 2, angle = 0, spread = 1.2, count = 6, r0 = 4, r1 = 22,
    alpha = 1, squash = 1, seed = 0, width = 4,
  } = o;
  for (let i = 0; i < count; i++) {
    const q = count === 1 ? 0.5 : (i + 0.5) / count;
    const a = angle + (q - 0.5) * spread;
    const k = 0.7 + 0.3 * Math.abs(Math.sin(i * 2.1 + seed));
    solidWedge(g, x + Math.cos(a) * r0, y + Math.sin(a) * r0 * squash, {
      palette, tone: tone + (i % 2), angle: a, r0: 0, r1: (r1 - r0) * k,
      w0: width, w1: P, alpha: alpha * (0.75 + 0.25 * k), squash,
      taper: 1.3, notch: false, seed: seed + i,
    });
  }
}

/**
 * A whole arrow: two-block shaft with a shadowed underside, a solid stepped
 * barbed head, and swept fletching. Drawn tip-first at (x, y).
 */
export function arrowForm(g, x, y, o) {
  const {
    palette, tone = 2, angle = 0, length = 22, alpha = 1,
    head = 7, fletch = true, spark = true, squash = 1,
  } = o;
  if (alpha <= 0 || length < P * 3) return;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle) * squash;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle) * squash;
  const tailX = x - ca * length;
  const tailY = y - sa * length;
  const body = shade(palette, tone);

  g.fillStyle(body, alpha);
  pxLine(g, x, y, tailX, tailY);
  g.fillStyle(shade(palette, tone + 2), alpha * 0.8);
  pxLine(g, x + nx * P, y + ny * P, tailX + nx * P, tailY + ny * P);

  const hb = Math.max(2, Math.round(head / P));
  for (let i = 0; i < hb; i++) {
    const w = Math.max(P, (hb - i) * P * 0.95);
    const bx = x - ca * i * P;
    const by = y - sa * i * P;
    g.fillStyle(i === 0 ? shade(palette, tone - 2) : body, alpha);
    pxLine(g, bx - nx * (w / 2), by - ny * (w / 2), bx + nx * (w / 2), by + ny * (w / 2));
  }

  if (fletch) {
    g.fillStyle(shade(palette, tone + 1), alpha * 0.9);
    for (let i = 0; i < 3; i++) {
      const bx = tailX + ca * i * P * 1.7;
      const by = tailY + sa * i * P * 1.7;
      const w = (3 - i) * P;
      pxLine(g, bx - nx * w, by - ny * w, bx + nx * w, by + ny * w);
    }
  }
  if (spark) {
    g.fillStyle(shade(palette, 0), alpha * 0.9);
    blk(g, x, y);
  }
}

/**
 * A curved tapering fang / horn. `curve` bends the spine as it rises, so a pair
 * facing each other reads unmistakably as a maw.
 */
export function fangForm(g, x, y, o) {
  const {
    palette, tone = 2, angle = -Math.PI / 2, length = 20, width = 7,
    curve = 0.5, alpha = 1, grow = 1, squash = 1,
  } = o;
  const h = length * grow;
  if (h < P * 2 || alpha <= 0) return;
  const bands = Math.max(2, Math.round(h / P));
  const body = shade(palette, tone);
  const dark = shade(palette, tone + 2);
  const lit = shade(palette, tone - 2);

  for (let b = 0; b <= bands; b++) {
    const q = b / bands;
    const a = angle + curve * q * q;
    const am = angle + (curve * q * q) / 2;
    const w = Math.max(P, snap(width * (1 - q) ** 0.62));
    const bx = x + Math.cos(am) * h * q;
    const by = y + Math.sin(am) * h * q * squash;
    const nx = -Math.sin(a);
    const ny = Math.cos(a) * squash;
    g.fillStyle(body, alpha);
    pxLine(g, bx - nx * (w / 2), by - ny * (w / 2), bx + nx * (w / 2), by + ny * (w / 2));
    if (w < P * 2) continue;
    g.fillStyle(dark, alpha * 0.85);
    blk(g, bx + nx * (w / 2), by + ny * (w / 2));
    if (b % 2 === 0) {
      g.fillStyle(lit, alpha);
      blk(g, bx - nx * (w / 2), by - ny * (w / 2));
    }
  }
}

/** Parallel tapered gashes — a claw strike, not four scratches. */
export function clawGash(g, x, y, o) {
  const {
    palette, tone = 2, angle = 0, length = 34, spread = 9, claws = 4,
    alpha = 1, width = 6, squash = 1, reveal = 1, seed = 0,
  } = o;
  if (alpha <= 0) return;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle) * squash;
  for (let c = 0; c < claws; c++) {
    const off = (c - (claws - 1) / 2) * spread;
    const bell = 1 - (Math.abs(off) / (spread * claws)) * 1.3;
    const len = Math.max(P * 2, length * bell * reveal);
    solidWedge(g, x + nx * off, y + ny * off, {
      palette, tone: tone + (c % 2), angle, r0: 0, r1: len,
      w0: width, w1: P, alpha: alpha * (c % 2 ? 0.82 : 1), squash,
      taper: 1.6, notch: false, seed: seed + c,
    });
  }
}

/**
 * A faceted column of light standing on the floor. Facets step across the width
 * in alternating tones and hard horizontal bands ride up it, so it reads as
 * banded glass rather than as an alpha-blended gradient rectangle.
 */
export function pillarForm(g, x, yBase, o) {
  const {
    palette, tone = 2, height = 120, width = 26, alpha = 1, grow = 1,
    facets = 4, flare = 1.9, taper = 0.66, bandEvery = 7, bandPhase = 0,
    topFade = 0, dissolve = 0, seed = 0,
  } = o;
  const h = height * grow;
  if (h < P * 2 || alpha <= 0) return;
  const rows = Math.max(2, Math.round(h / P));

  for (let i = 0; i < rows; i++) {
    const q = i / (rows - 1 || 1);
    const bell = q < 0.14 ? flare - (flare - 1) * (q / 0.14) : 1;
    const w = Math.max(P, snap(width * (1 - q * taper) * bell));
    const yy = snap(yBase - i * P);
    // A shaft of light has no lid: the top rows thin out and break into
    // separate blocks instead of ending on a hard flat cap.
    const fadeA = topFade > 0 && q > 1 - topFade
      ? Math.max(0, 1 - (q - (1 - topFade)) / topFade) ** 1.4
      : 1;
    if (fadeA <= 0.02) continue;
    const gap = dissolve > 0 ? dissolve * q * q : 0;
    const bands = Math.max(1, Math.min(facets, Math.round(w / P)));
    const fw = Math.max(P, snap((w * 2) / bands));
    for (let f = 0; f < bands; f++) {
      if (gap > 0 && Math.abs(wob(i * 3 + f, seed + 5)) < gap) continue;
      const edge = f === 0 || f === bands - 1;
      const t = tone + (f === bands - 1 ? 2 : (edge ? 1 : -1 + (f % 2)));
      g.fillStyle(shade(palette, t), alpha * (0.95 - q * 0.3) * fadeA);
      g.fillRect(snap(x - w + f * fw), yy, fw, P);
    }
    if (bandEvery > 0 && (i + bandPhase) % bandEvery === 0) {
      g.fillStyle(shade(palette, 0), alpha * 0.85 * fadeA);
      g.fillRect(snap(x - w), yy, w * 2, P);
    }
  }
}

/** Solid crescent: a disc with an offset disc punched out of it. */
export function crescentForm(g, x, y, o) {
  const {
    palette, tone = 2, r = 22, bite = 0.72, angle = 0, alpha = 1,
    squash = 1, rim = true,
  } = o;
  if (r < P * 2 || alpha <= 0) return;
  const ox = x + Math.cos(angle) * r * bite;
  const oy = y + Math.sin(angle) * r * bite * squash;
  const rows = Math.max(2, Math.round((r * squash) / P));
  const ir = r * 0.94;

  for (let i = -rows; i <= rows; i++) {
    const q = i / rows;
    const t = 1 - q * q;
    if (t <= 0) continue;
    const w = snap(r * Math.sqrt(t));
    const yy = snap(y + i * P);
    // the bitten-out disc, evaluated on this same scanline
    const dy = (yy - oy) / squash;
    const it = 1 - (dy * dy) / (ir * ir);
    const iw = it > 0 ? snap(ir * Math.sqrt(it)) : -1;
    const x0 = snap(x - w);
    const x1 = snap(x + w);
    const c0 = iw >= 0 ? snap(ox - iw) : Infinity;
    const c1 = iw >= 0 ? snap(ox + iw) : -Infinity;
    g.fillStyle(shade(palette, tone + (i > 0 ? 1 : 0)), alpha);
    if (c0 > x0) g.fillRect(x0, yy, Math.min(x1, c0) - x0 + P, P);
    if (c1 < x1) g.fillRect(Math.max(x0, c1), yy, x1 - Math.max(x0, c1) + P, P);
    if (rim && i % 3 === 0) {
      g.fillStyle(shade(palette, tone - 2), alpha);
      blk(g, c0 > x0 ? x0 : x1, yy);
    }
  }
}

/**
 * A hooded humanoid silhouette standing on (x, yFeet). Built as a solid stack
 * of rows — hood, shoulders, torso, legs — with a rim-light down the leading
 * edge and a torn cloak trailing behind, so an afterimage reads as a *person*
 * rather than as a blurred smear.
 */
export function figureForm(g, x, yFeet, o) {
  const {
    palette, tone = 5, height = 34, alpha = 1, facing = 1, lean = 0,
    cloak = 1, rimTone = null,
  } = o;
  if (alpha <= 0 || height < P * 6) return;
  const h = snap(height);
  const rows = Math.round(h / P);
  const body = shade(palette, tone);
  const dark = shade(palette, tone + 1);
  const rim = shade(palette, rimTone ?? tone - 3);

  for (let i = 0; i < rows; i++) {
    const q = i / (rows - 1);
    let w;
    if (q > 0.8) w = h * 0.115 * Math.sin(Math.PI * Math.min(1, (1 - q) / 0.2 + 0.42));
    else if (q > 0.66) w = h * 0.2 * (0.72 + (q - 0.66) * 2);
    else if (q > 0.26) w = h * (0.1 + 0.075 * (0.66 - q));
    else w = h * (0.055 + 0.06 * q);
    w = Math.max(P, snap(w));
    const xx = snap(x + lean * q * facing);
    const yy = snap(yFeet - i * P);
    g.fillStyle(body, alpha);
    g.fillRect(xx - w, yy, w * 2, P);
    g.fillStyle(dark, alpha);
    g.fillRect(facing > 0 ? xx + w - P : xx - w, yy, P, P);
    if (i % 3 === 0) {
      g.fillStyle(rim, alpha * 0.8);
      g.fillRect(facing > 0 ? xx - w : xx + w - P, yy, P, P);
    }
  }

  if (cloak > 0) {
    const top = yFeet - h * 0.7;
    // the cloak always trails away from the direction of travel
    const back = facing > 0 ? Math.PI : 0;
    for (let i = 0; i < 5; i++) {
      const q = i / 4;
      solidWedge(g, x - facing * h * 0.06, top + q * h * 0.3, {
        palette, tone: tone + 1, angle: back + facing * (0.3 + q * 0.5),
        r0: 0, r1: h * (0.34 - q * 0.14) * cloak,
        w0: P * 3, w1: P, alpha: alpha * (0.8 - q * 0.25),
        taper: 1.4, notch: true, glint: false, seed: i * 3,
      });
    }
  }
}

/**
 * A grasping hand: solid palm with four tapering fingers and an opposed thumb.
 * `close` folds the fingers inward (0 = splayed open, 1 = clenched).
 */
export function clawHand(g, x, y, o) {
  const {
    palette, tone = 4, angle = -Math.PI / 2, size = 12, alpha = 1,
    close = 0, squash = 1,
  } = o;
  if (alpha <= 0 || size < P * 2) return;
  const palm = Math.max(P * 2, snap(size * 0.5));
  g.fillStyle(shade(palette, tone), alpha);
  pxDisc(g, snap(x), snap(y), palm, palm * 0.82 * squash);
  g.fillStyle(shade(palette, tone + 2), alpha * 0.9);
  pxDisc(g, snap(x + P), snap(y + P), palm * 0.7, palm * 0.5 * squash);
  g.fillStyle(shade(palette, tone - 2), alpha * 0.85);
  pxDisc(g, snap(x - P), snap(y - P * 2), palm * 0.34, palm * 0.26 * squash);

  for (let f = 0; f < 5; f++) {
    const thumb = f === 4;
    const spread = thumb ? 1.35 : (f - 1.5) * 0.34;
    const a = angle + spread * (1 - close * 0.55);
    const len = size * (thumb ? 0.62 : 0.95 - Math.abs(f - 1.5) * 0.14);
    fangForm(g, x + Math.cos(a) * palm * 0.7, y + Math.sin(a) * palm * 0.6 * squash, {
      palette, tone: tone - (f % 2), angle: a, length: len,
      width: Math.max(P * 2, size * 0.2), curve: close * 1.15 + 0.22,
      alpha, squash, grow: 1,
    });
  }
}

/**
 * A roaring lion's head seen head-on: a mane of solid wedges, a shaded skull, a
 * muzzle, two lit eyes and a maw with fangs. `open` swings the jaw.
 */
export function lionMaw(g, x, y, o) {
  const {
    palette, tone = 2, size = 34, alpha = 1, open = 1, maneSpin = 0, squash = 1,
  } = o;
  if (alpha <= 0 || size < P * 6) return;
  const r = size * 0.5;

  // mane: two staggered rings of solid wedges
  for (let ring = 0; ring < 2; ring++) {
    const n = ring === 0 ? 14 : 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + maneSpin * (ring ? -0.7 : 1) + ring * 0.22;
      solidWedge(g, x, y, {
        palette, tone: tone + 2 + ring, angle: a,
        r0: r * (0.72 + ring * 0.16), r1: r * (1.5 + ring * 0.34 + 0.12 * Math.sin(i * 2.3)),
        w0: r * 0.34, w1: P, alpha: alpha * (ring ? 0.72 : 0.95),
        squash, taper: 1.35, notch: true, glint: ring === 0, seed: i + ring * 5,
      });
    }
  }

  // skull
  g.fillStyle(shade(palette, tone + 1), alpha);
  pxDisc(g, snap(x), snap(y), snap(r * 0.86), snap(r * 0.78 * squash));
  g.fillStyle(shade(palette, tone), alpha);
  pxDisc(g, snap(x), snap(y - r * 0.16), snap(r * 0.7), snap(r * 0.5 * squash));
  g.fillStyle(shade(palette, tone + 3), alpha * 0.85);
  pxDisc(g, snap(x), snap(y + r * 0.34), snap(r * 0.52), snap(r * 0.3 * squash));

  // eyes and brow
  g.fillStyle(shade(palette, 0), alpha);
  for (const s of [-1, 1]) {
    g.fillRect(snap(x + s * r * 0.34 - P), snap(y - r * 0.24), P * 2, P * 2);
  }
  g.fillStyle(shade(palette, tone + 4), alpha * 0.9);
  for (const s of [-1, 1]) {
    pxLine(g, x + s * r * 0.16, y - r * 0.44, x + s * r * 0.56, y - r * 0.32);
  }

  // maw
  const jaw = r * (0.2 + open * 0.4);
  g.fillStyle(shade(palette, tone + 5), alpha);
  pxDisc(g, snap(x), snap(y + r * 0.46), snap(r * 0.34), snap(jaw * squash));
  for (let i = 0; i < 4; i++) {
    const s = i < 2 ? -1 : 1;
    fangForm(g, x + s * r * (i % 2 ? 0.1 : 0.24), y + r * 0.46 - jaw * 0.7 * squash, {
      palette, tone: 0, angle: Math.PI / 2, length: jaw * 0.8,
      width: P * 3, curve: -s * 0.3, alpha, squash,
    });
  }
}

/**
 * A block-glyph rune: a small solid sigil made of axis-aligned strokes. Six
 * variants, selected by `variant`, so a ring of them reads as writing.
 */
export function runeGlyph(g, x, y, o) {
  const {
    palette, tone = 1, size = 8, alpha = 1, variant = 0, angle = 0,
  } = o;
  if (alpha <= 0) return;
  const s = Math.max(P * 2, snap(size));
  const h = s / 2;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const rot = (dx, dy) => [x + dx * ca - dy * sa, y + dx * sa + dy * ca];
  const strokes = [
    [[-h, -h, h, -h], [0, -h, 0, h], [-h, h, h, h]],            // I
    [[0, -h, 0, h], [-h, 0, h, 0]],                              // +
    [[-h, -h, h, h], [h, -h, -h, h]],                            // x
    [[-h, -h, -h, h], [-h, 0, h, -h], [h, -h, h, h]],            // N
    [[-h, h, 0, -h], [0, -h, h, h], [-h * 0.5, 0, h * 0.5, 0]],  // A
    [[-h, -h, h, -h], [h, -h, -h, h], [-h, h, h, h]],            // Z
  ][variant % 6];

  // shadow first, so the lit stroke sits on top of its own drop shadow
  g.fillStyle(shade(palette, tone + 2), alpha * 0.7);
  for (const [ax, ay, bx, by] of strokes) {
    const [x0, y0] = rot(ax, ay + P);
    const [x1, y1] = rot(bx, by + P);
    pxLine(g, x0, y0, x1, y1);
  }
  g.fillStyle(shade(palette, tone), alpha);
  for (const [ax, ay, bx, by] of strokes) {
    const [x0, y0] = rot(ax, ay);
    const [x1, y1] = rot(bx, by);
    pxLine(g, x0, y0, x1, y1);
  }
}

/** A billow of dust or smoke: overlapping lumps, lit on top, dark underneath. */
export function dustPuff(g, x, y, o) {
  const {
    palette, tone = 4, size = 16, alpha = 1, lumps = 4, seed = 0, squash = 0.7,
  } = o;
  if (alpha <= 0 || size < P * 2) return;
  for (let i = 0; i < lumps; i++) {
    const a = (i / lumps) * Math.PI * 2 + seed;
    const d = size * 0.42 * (0.5 + 0.5 * Math.abs(Math.sin(i * 1.7 + seed)));
    debrisChunk(g, x + Math.cos(a) * d, y + Math.sin(a) * d * squash, {
      palette, tone: tone + (i % 2), size: size * (0.5 + 0.22 * ((i + 1) % 3)),
      alpha: alpha * (0.72 + 0.28 * ((i % 2) === 0 ? 1 : 0.6)),
      seed: seed + i * 4, squash: 0.9,
    });
  }
}

