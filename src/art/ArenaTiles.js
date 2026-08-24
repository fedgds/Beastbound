/**
 * ArenaTiles — bakes every static piece of the room into textures.
 *
 * One bake per theme, cached by key, so re-entering a floor costs nothing. The
 * pieces are deliberately small (a slab, a brick course, one sconce) because
 * ArenaScenery stamps them into a RenderTexture: baking 160 tiles is cheap,
 * dithering 376 000 floor pixels through Graphics commands is not.
 */

import { TILE, WALL } from '../config.js';
import {
  P, crack, darken, dither, ditherRampV, dot, hash2, lighten, px, rng, snap, speckle,
} from './PixelDraw.js';

export const FLAME_FRAMES = 6;
const SLAB_VARIANTS = 6;

/** Texture key helpers — themes namespace everything so bakes never collide. */
const K = {
  slab: (t, i) => `ar_${t}_slab${i}`,
  wall: (t, i) => `ar_${t}_wall${i}`,
  cap: (t) => `ar_${t}_cap`,
  pilaster: (t) => `ar_${t}_pil`,
  alcove: (t) => `ar_${t}_alc`,
  sconce: (t) => `ar_${t}_sconce`,
  flame: (t, i) => `ar_${t}_flame${i}`,
  banner: (t, i) => `ar_${t}_banner${i}`,
  moss: (t, i) => `ar_${t}_moss${i}`,
  rubble: (t, i) => `ar_${t}_rubble${i}`,
  stain: (t, i) => `ar_${t}_stain${i}`,
  grate: (t) => `ar_${t}_grate`,
  chain: (t) => `ar_${t}_chain`,
  lip: (t) => `ar_${t}_lip`,
  side: (t) => `ar_${t}_side`,
};
export { K as ARENA_KEYS };

/* ══ floor slabs ═══════════════════════════════════════════════════════════ */

/**
 * One flagstone: a mortar gutter on the top/left, a lit top bevel, a shaded
 * bottom, then wear. Variants differ in base tone and damage so a stamped grid
 * never shows an obvious repeat.
 */
function bakeSlab(g, theme, i, rand) {
  const { w, h } = TILE;
  const tones = [theme.stone2, theme.stone2, theme.stone1, theme.stone2, theme.stone3, theme.stone1];
  const base = tones[i % tones.length];

  // mortar bed shows through the gutters
  px(g, 0, 0, w, h, theme.grout, 1);

  // the slab face, inset by the mortar gap
  const gap = P;
  px(g, gap, gap, w - gap * 2, h - gap * 2, base, 1);

  // Lit top edge + top-left corner: a single light source, high and left.
  // The bevel strength varies per variant and the run is broken where the stone
  // has worn — an unbroken bevel on every slab turns the floor into a lattice.
  const lit = [0.15, 0.08, 0.12, 0.05, 0.17, 0.1][i % 6];
  const edge = lighten(base, lit);
  for (let x = gap; x < w - gap; x += P * 3) {
    if (hash2(x, i * 13, 7) < 0.24) continue; // a chipped-away stretch of bevel
    px(g, x, gap, Math.min(P * 3, w - gap - x), P, edge, 1);
  }
  for (let y = gap; y < h - gap; y += P * 3) {
    if (hash2(i * 17, y, 11) < 0.3) continue;
    px(g, gap, y, P, Math.min(P * 3, h - gap - y), lighten(base, lit * 0.65), 1);
  }

  // shaded bottom / right, dithered so the falloff stays in palette
  ditherRampV(g, gap, h - gap - P * 4, w - gap * 2, P * 4, darken(base, 0.45), 0.15, 0.9);
  dither(g, w - gap - P * 2, gap, P * 2, h - gap * 2, darken(base, 0.4), 0.55);

  // wear: grit, chipped corners, and on some variants a real crack
  speckle(g, gap, gap, w - gap * 2, h - gap * 2, darken(base, 0.3), 14, rand, 0.5);
  speckle(g, gap, gap, w - gap * 2, h - gap * 2, lighten(base, 0.14), 8, rand, 0.4);

  if (i % 3 === 0) {
    // chipped corner — mortar shows through
    const cw = snap(4 + rand() * 6);
    px(g, w - gap - cw, h - gap - cw, cw, cw, theme.grout, 0.85);
  }
  if (i % 2 === 1) {
    crack(g, snap(w * (0.25 + rand() * 0.5)), snap(h * 0.3), 10 + Math.floor(rand() * 10),
      rand() * Math.PI, theme.grout, rand, 0.7);
  }
}

/* ══ back wall ═════════════════════════════════════════════════════════════ */

/** A full-height column of the back wall: staggered brick courses. */
function bakeWallColumn(g, theme, i, rand) {
  const w = TILE.w;
  const h = WALL.h;
  const courseH = 16;
  const brickW = 28;

  px(g, 0, 0, w, h, theme.wallLo, 1);

  let row = 0;
  for (let y = 0; y < h; y += courseH) {
    const offset = (row + i) % 2 === 0 ? 0 : -brickW / 2;
    for (let x = offset; x < w; x += brickW) {
      const bx = Math.max(0, x);
      const bw = Math.min(brickW - P, w - bx);
      if (bw <= P) continue;

      const n = hash2(Math.round(x), y, i * 31);
      const face = n < 0.18 ? theme.wallHi : (n > 0.82 ? theme.wallLo : theme.wall);
      px(g, bx, y, bw, courseH - P, face, 1);
      // top bevel + bottom shade give each brick volume
      px(g, bx, y, bw, P, lighten(face, 0.18), 1);
      dither(g, bx, y + courseH - P * 2, bw, P, darken(face, 0.5), 0.7);
      if (n > 0.6) speckle(g, bx, y, bw, courseH - P, darken(face, 0.35), 5, rand, 0.45);
    }
    row++;
  }

  // the whole wall sits in shadow toward the floor — it faces away from the light
  ditherRampV(g, 0, h * 0.45, w, h * 0.55, darken(theme.wall, 0.75), 0, 0.55, 1);
  // ambient grime at the very base
  speckle(g, 0, h - 14, w, 14, theme.grout, 26, rand, 0.5);
}

/** Capstone that reads as the wall's lit top lip. */
function bakeCap(g, theme) {
  const w = TILE.w;
  px(g, 0, 0, w, 10, theme.wall, 1);
  px(g, 0, 0, w, P, lighten(theme.wallHi, 0.35), 1);
  px(g, 0, P, w, P * 2, theme.wallHi, 1);
  dither(g, 0, 8, w, P, theme.grout, 0.8);
}

/** Load-bearing pilaster: a column that breaks up the brick rhythm. */
function bakePilaster(g, theme) {
  const w = 24;
  const h = WALL.h + 12;
  px(g, 0, 0, w, h, theme.wall, 1);
  px(g, 0, 0, P * 2, h, lighten(theme.wallHi, 0.2), 1);
  px(g, w - P * 2, 0, P * 2, h, darken(theme.wallLo, 0.3), 1);
  // capital and base flare
  px(g, -P * 2, 0, w + P * 4, 8, theme.wallHi, 1);
  px(g, -P * 2, 0, w + P * 4, P, lighten(theme.wallHi, 0.4), 1);
  px(g, -P * 2, h - 10, w + P * 4, 10, theme.wallHi, 1);
  dither(g, -P * 2, h - P * 2, w + P * 4, P * 2, theme.grout, 0.8);
  ditherRampV(g, 0, 12, w, h - 26, darken(theme.wall, 0.6), 0, 0.4);
}

/** Barred alcove — the room's only source of cold outside light. */
function bakeAlcove(g, theme) {
  const w = 40;
  const h = 52;
  // recessed opening
  px(g, 0, 0, w, h, darken(theme.wallLo, 0.55), 1);
  px(g, P * 2, P * 2, w - P * 4, h - P * 4, 0x0a0912, 1);
  // cold daylight bleeding in behind the bars
  ditherRampV(g, P * 2, P * 2, w - P * 4, h - P * 4, 0x6d86b8, 0.55, 0.05, 1);
  // iron bars
  for (let x = P * 4; x < w - P * 4; x += 10) px(g, x, P * 2, P, h - P * 4, theme.metal, 1);
  px(g, P * 2, h / 2, w - P * 4, P, theme.metal, 1);
  // arch lintel
  px(g, -P, 0, w + P * 2, P * 2, theme.wallHi, 1);
  px(g, -P, h - P * 2, w + P * 2, P * 2, darken(theme.wallLo, 0.4), 1);
}

/* ══ torch ═════════════════════════════════════════════════════════════════ */

function bakeSconce(g, theme) {
  const w = 14;
  // bracket arm + bowl
  px(g, 4, 10, 6, 8, darken(theme.metal, 0.45), 1);
  px(g, 0, 4, w, 6, theme.metal, 1);
  px(g, 0, 4, w, P, lighten(theme.metal, 0.35), 1);
  px(g, P, 10, w - P * 2, P * 2, darken(theme.metal, 0.3), 1);
  // coals in the bowl
  px(g, 4, 2, 6, P * 2, 0x8a2f16, 1);
  dot(g, 4, 2, 0xff7a3d, 1);
  dot(g, 8, 2, 0xffb347, 1);
}

/**
 * One frame of a torch flame. Width follows a teardrop profile modulated by
 * two out-of-phase sines, so six frames loop without an obvious cycle.
 */
function bakeFlame(g, theme, frame) {
  const W = 22;
  const H = 30;
  const cx = W / 2;
  const phase = (frame / FLAME_FRAMES) * Math.PI * 2;

  const core = lighten(theme.flame, 0.55);
  const mid = theme.flame;
  const outer = darken(theme.flame, 0.42);

  for (let y = 0; y < H; y += P) {
    const t = y / H; // 0 = tip, 1 = base
    // teardrop: narrow tip, widest at ~70% down, tucked in at the base
    const profile = Math.sin(Math.pow(t, 0.62) * Math.PI * 0.92);
    const wobble = Math.sin(phase + t * 5.2) * (1 - t) * 2.6
      + Math.sin(phase * 1.7 + t * 9.1) * (1 - t) * 1.2;

    const halfOuter = profile * 9 + 1;
    if (halfOuter < P) continue;
    const lean = wobble;

    px(g, cx + lean - halfOuter, y, halfOuter * 2, P, outer, 1);

    const halfMid = halfOuter - 2 - Math.sin(phase * 1.3) * 0.6;
    if (halfMid > P && t > 0.1) px(g, cx + lean * 0.8 - halfMid, y, halfMid * 2, P, mid, 1);

    const halfCore = halfMid - 3;
    if (halfCore > P && t > 0.34) px(g, cx + lean * 0.55 - halfCore, y, halfCore * 2, P, core, 1);
  }

  // a couple of detached sparks riding above the tip
  const sp = Math.sin(phase * 2.1);
  dot(g, cx + sp * 3, P * 2 - (frame % 3) * P, core, 0.9);
  dot(g, cx - sp * 4, P, mid, 0.55);
}

/* ══ banner ════════════════════════════════════════════════════════════════ */

/** Hanging cloth, three sway frames. Floors 2–3 hang the tower's colours. */
function bakeBanner(g, theme, frame) {
  const cfg = theme.banners;
  const W = 30;
  const H = 74;
  const sway = [0, 1, 0, -1][frame % 4] ?? 0;

  // rail
  px(g, 2, 0, W - 4, 4, theme.metal, 1);
  px(g, 2, 0, W - 4, P, lighten(theme.metal, 0.4), 1);

  for (let y = 4; y < H; y += P) {
    const t = (y - 4) / (H - 4);
    const lean = sway * t * 3;
    const w = W - 8 - t * 4;
    const x = (W - w) / 2 + lean;
    px(g, x, y, w, P, cfg.cloth, 1);
    // fold shading: two vertical creases that shift with the sway
    dither(g, x + w * 0.24 + sway, y, P * 2, P, darken(cfg.cloth, 0.45), 0.8);
    dither(g, x + w * 0.68 - sway, y, P * 2, P, darken(cfg.cloth, 0.3), 0.6);
    px(g, x, y, P, P, lighten(cfg.cloth, 0.2), 1);
  }

  // trim band + a pointed hem
  px(g, 6 + sway, 14, W - 12, P * 2, cfg.trim, 1);
  const hemY = H - 10;
  for (let i = 0; i < 5; i++) {
    const w = W - 10 - i * P * 2;
    px(g, (W - w) / 2 + sway * 3, hemY + i * P, w, P, cfg.trim, 1);
  }
}

/* ══ floor decals ══════════════════════════════════════════════════════════ */

function bakeMoss(g, theme, i, rand) {
  const S = 26;
  const col = theme.accent;
  const blobs = 4 + i;
  for (let b = 0; b < blobs; b++) {
    const bx = rand() * S;
    const by = rand() * S;
    const r = 3 + rand() * 5;
    for (let y = -r; y <= r; y += P) {
      for (let x = -r; x <= r; x += P) {
        if (Math.hypot(x, y) > r) continue;
        const shade = rand();
        dot(g, bx + x, by + y, shade < 0.3 ? lighten(col, 0.25) : (shade > 0.8 ? darken(col, 0.4) : col), 0.85);
      }
    }
  }
  speckle(g, 0, 0, S, S, lighten(col, 0.4), 10, rand, 0.7);
}

function bakeRubble(g, theme, i, rand) {
  const S = 22;
  const pieces = 2 + i;
  for (let p = 0; p < pieces; p++) {
    const w = snap(4 + rand() * 7);
    const h = snap(3 + rand() * 5);
    const x = snap(rand() * (S - w));
    const y = snap(rand() * (S - h));
    // a chip of stone with a lit top and a contact shadow
    dither(g, x + P, y + h, w, P * 2, 0x000000, 0.55);
    px(g, x, y, w, h, theme.stone3, 1);
    px(g, x, y, w, P, lighten(theme.stone3, 0.3), 1);
    px(g, x, y + h - P, w, P, darken(theme.stone3, 0.45), 1);
  }
}

function bakeStain(g, theme, i, rand) {
  const S = 34;
  const col = darken(theme.grout, 0.25);
  const r = 8 + i * 3;
  for (let y = 0; y < S; y += P) {
    for (let x = 0; x < S; x += P) {
      const d = Math.hypot(x - S / 2, y - S / 2) / r;
      if (d > 1) continue;
      dither(g, x, y, P, P, col, (1 - d) * 0.75);
    }
  }
  speckle(g, 0, 0, S, S, col, 18, rand, 0.4);
}

/** Iron drain grate — a hard man-made shape among all the worn stone. */
function bakeGrate(g, theme) {
  const S = 30;
  px(g, 0, 0, S, S, darken(theme.grout, 0.5), 1);
  px(g, P, P, S - P * 2, S - P * 2, 0x07060c, 1);
  for (let x = P * 2; x < S - P * 2; x += 8) px(g, x, P * 2, P * 2, S - P * 4, theme.metal, 1);
  px(g, 0, 0, S, P, lighten(theme.metal, 0.2), 0.7);
  dither(g, 0, S - P * 2, S, P * 2, 0x000000, 0.6);
}

/** Chain pooled on the floor — a little narrative, cheaply. */
function bakeChain(g, theme, rand) {
  let cx = 4;
  let cy = 18;
  let a = -0.4;
  for (let i = 0; i < 14; i++) {
    a += (rand() - 0.5) * 0.8;
    cx += Math.cos(a) * 2.4;
    cy += Math.sin(a) * 2.4;
    px(g, cx, cy, P * 2, P * 2, theme.metal, 1);
    dot(g, cx, cy, lighten(theme.metal, 0.35), 1);
    dot(g, cx + P, cy + P, darken(theme.metal, 0.5), 1);
  }
}

/* ══ near edge ═════════════════════════════════════════════════════════════ */

/** Foreground lip: the near wall the camera looks over. Occludes feet slightly. */
function bakeLip(g, theme) {
  const w = TILE.w;
  const h = 14;
  ditherRampV(g, 0, 0, w, 6, 0x000000, 0.5, 0.9);
  px(g, 0, 6, w, h - 6, theme.wallLo, 1);
  px(g, 0, 6, w, P, theme.wall, 1);
  px(g, 0, 6, w, P, lighten(theme.wall, 0.1), 1);
}

/** Side wall strip running down the left/right arena edges. */
function bakeSide(g, theme) {
  const w = 14;
  const h = TILE.h;
  px(g, 0, 0, w, h, theme.wall, 1);
  px(g, 0, 0, P, h, lighten(theme.wallHi, 0.15), 1);
  px(g, w - P * 2, 0, P * 2, h, darken(theme.wallLo, 0.35), 1);
  for (let y = 0; y < h; y += 16) dither(g, 0, y, w, P, theme.grout, 0.8);
  ditherRampV(g, 0, 0, w, h, darken(theme.wall, 0.6), 0.25, 0.25);
}

/* ══ public bake ═══════════════════════════════════════════════════════════ */

/** Bakes every texture this theme needs. Idempotent. */
export function bakeThemeTextures(scene, theme) {
  const id = theme.id;
  if (scene.textures.exists(K.slab(id, 0))) return;

  const g = new Phaser.GameObjects.Graphics(scene);
  const rand = rng(0x51ce + id.length * 7919);

  const emit = (key, w, h, draw) => {
    g.clear();
    draw();
    g.generateTexture(key, snap(w), snap(h));
  };

  for (let i = 0; i < SLAB_VARIANTS; i++) {
    emit(K.slab(id, i), TILE.w, TILE.h, () => bakeSlab(g, theme, i, rand));
  }
  for (let i = 0; i < 4; i++) {
    emit(K.wall(id, i), TILE.w, WALL.h, () => bakeWallColumn(g, theme, i, rand));
  }
  emit(K.cap(id), TILE.w, 10, () => bakeCap(g, theme));
  emit(K.pilaster(id), 28, WALL.h + 12, () => bakePilaster(g, theme));
  emit(K.alcove(id), 40, 52, () => bakeAlcove(g, theme));
  emit(K.sconce(id), 14, 20, () => bakeSconce(g, theme));

  for (let i = 0; i < FLAME_FRAMES; i++) {
    emit(K.flame(id, i), 22, 30, () => bakeFlame(g, theme, i));
  }
  if (theme.banners) {
    for (let i = 0; i < 4; i++) {
      emit(K.banner(id, i), 30, 74, () => bakeBanner(g, theme, i));
    }
  }
  for (let i = 0; i < 3; i++) {
    emit(K.moss(id, i), 26, 26, () => bakeMoss(g, theme, i, rand));
    emit(K.rubble(id, i), 22, 22, () => bakeRubble(g, theme, i, rand));
    emit(K.stain(id, i), 34, 34, () => bakeStain(g, theme, i, rand));
  }
  emit(K.grate(id), 30, 30, () => bakeGrate(g, theme));
  emit(K.chain(id), 40, 34, () => bakeChain(g, theme, rand));
  emit(K.lip(id), TILE.w, 14, () => bakeLip(g, theme));
  emit(K.side(id), 14, TILE.h, () => bakeSide(g, theme));

  g.destroy();
}
