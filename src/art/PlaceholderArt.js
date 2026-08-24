/**
 * PlaceholderArt — the ONLY module that knows what units look like.
 *
 * It procedurally bakes chunky, outlined, pixel-ish frames into individual
 * textures named `<key>_<state><frameIndex>` (e.g. `golem_idle0`).
 * BootScene then stitches those into Phaser animations.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SWAPPING IN REAL PIXEL ART (spec §10)
 * Replace `buildAll()` with:
 *     scene.load.spritesheet('golem', 'assets/golem.png', {frameWidth:32,frameHeight:32});
 * and update ANIM_FRAMES below to plain frame-index ranges. Nothing outside
 * this file and BootScene needs to change, because entities only ever refer to
 * animation keys ('golem_idle', 'golem_attack', …), never to textures.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ANIM } from '../config.js';

/** Frame counts per state — spec §5 asks for short, readable 4–8 frame actions. */
export const ANIM_FRAMES = {
  idle: 4,
  move: 6,
  windup: 3,
  attack: 4,
  hit: 2,
  die: 5,
};

export const ANIM_FPS = {
  idle: ANIM.idleFps,
  move: ANIM.moveFps,
  windup: ANIM.windupFps,
  attack: ANIM.attackFps,
  hit: ANIM.hitFps,
  die: ANIM.dieFps,
};

export const ANIM_REPEAT = {
  idle: -1,
  move: -1,
  windup: 0,
  attack: 0,
  hit: 0,
  die: 0,
};

const P = 2; // "pixel" quantum — all geometry snaps to this for a chunky look

const snap = (v) => Math.round(v / P) * P;

/**
 * Unit silhouettes. Parts use a feet-anchored, centre-origin space:
 *   x = 0 is the unit's centre, y = 0 is the ground, negative y is up.
 * `c` picks a palette slot, `tag` drives which pose transforms apply,
 * `z` < 0 renders behind the body (capes, wings).
 */
const UNITS = {
  // ── Stone Golem (tank) — image/character/monster/1.png
  golem: {
    w: 36, h: 40,
    pal: { body: 0x7d8496, dark: 0x565d6d, accent: 0x5fe3ff, line: 0x24283a },
    parts: [
      { x: -14, y: -14, w: 10, h: 14, c: 'dark', tag: 'legL' },
      { x: 4, y: -14, w: 10, h: 14, c: 'dark', tag: 'legR' },
      { x: -16, y: -34, w: 32, h: 20, c: 'body', tag: 'torso' },
      { x: -6, y: -30, w: 12, h: 10, c: 'accent', tag: 'core' },
      { x: -22, y: -32, w: 8, h: 18, c: 'body', tag: 'armL' },
      { x: 14, y: -32, w: 10, h: 20, c: 'body', tag: 'armR' },
      { x: -10, y: -44, w: 20, h: 10, c: 'body', tag: 'head' },
      { x: -6, y: -42, w: 4, h: 4, c: 'accent', tag: 'eye' },
      { x: 2, y: -42, w: 4, h: 4, c: 'accent', tag: 'eye' },
    ],
  },

  // ── Goblin Brute (melee DPS) — image/character/monster/2.png
  brute: {
    w: 28, h: 34,
    pal: { body: 0xb93a3a, dark: 0x7d2222, accent: 0xcfd4dc, line: 0x2e1010 },
    parts: [
      { x: -10, y: -12, w: 8, h: 12, c: 'dark', tag: 'legL' },
      { x: 2, y: -12, w: 8, h: 12, c: 'dark', tag: 'legR' },
      { x: -11, y: -28, w: 22, h: 16, c: 'body', tag: 'torso' },
      { x: -8, y: -22, w: 16, h: 4, c: 'dark', tag: 'belt' },
      { x: -16, y: -26, w: 6, h: 14, c: 'body', tag: 'armL' },
      { x: 10, y: -26, w: 6, h: 12, c: 'body', tag: 'armR' },
      { x: -8, y: -38, w: 16, h: 10, c: 'body', tag: 'head' },
      { x: -14, y: -38, w: 6, h: 4, c: 'body', tag: 'earL' },
      { x: 8, y: -38, w: 6, h: 4, c: 'body', tag: 'earR' },
      { x: -5, y: -36, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: 2, y: -36, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: 14, y: -30, w: 4, h: 16, c: 'dark', tag: 'weapon' },
      { x: 12, y: -34, w: 12, h: 8, c: 'accent', tag: 'weapon' },
    ],
  },

  // ── Forest Sprite (ranged DPS) — image/character/monster/3.png
  sprite: {
    w: 22, h: 32,
    pal: { body: 0x4fae5a, dark: 0x2f7538, accent: 0xd9c27a, line: 0x12301a },
    parts: [
      { x: -7, y: -12, w: 5, h: 12, c: 'dark', tag: 'legL' },
      { x: 2, y: -12, w: 5, h: 12, c: 'dark', tag: 'legR' },
      { x: -8, y: -26, w: 16, h: 14, c: 'body', tag: 'torso' },
      { x: -12, y: -24, w: 5, h: 12, c: 'body', tag: 'armL' },
      { x: 8, y: -24, w: 5, h: 10, c: 'body', tag: 'armR' },
      { x: -7, y: -36, w: 14, h: 10, c: 'body', tag: 'head' },
      { x: -4, y: -34, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: 2, y: -34, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: -6, y: -44, w: 4, h: 8, c: 'dark', tag: 'leafL' },
      { x: 3, y: -42, w: 4, h: 6, c: 'dark', tag: 'leafR' },
      { x: 12, y: -34, w: 3, h: 22, c: 'accent', tag: 'weapon' }, // bow stave
    ],
  },

  // ── Swamp Toad (CC / debuff) — image/character/monster/4.png
  toad: {
    w: 34, h: 26,
    pal: { body: 0x5a3f6b, dark: 0x3c2849, accent: 0xffd23f, line: 0x1d1426 },
    parts: [
      { x: -16, y: -8, w: 8, h: 8, c: 'dark', tag: 'legL' },
      { x: 8, y: -8, w: 8, h: 8, c: 'dark', tag: 'legR' },
      { x: -15, y: -22, w: 30, h: 16, c: 'body', tag: 'torso' },
      { x: -11, y: -12, w: 22, h: 6, c: 'dark', tag: 'belly' },
      { x: -13, y: -28, w: 26, h: 8, c: 'body', tag: 'head' },
      { x: -10, y: -30, w: 8, h: 8, c: 'accent', tag: 'eye' },
      { x: 2, y: -30, w: 8, h: 8, c: 'accent', tag: 'eye' },
      { x: -8, y: -28, w: 3, h: 5, c: 'line', tag: 'pupil' },
      { x: 4, y: -28, w: 3, h: 5, c: 'line', tag: 'pupil' },
      { x: -4, y: -18, w: 14, h: 3, c: 0xc4607a, tag: 'weapon' }, // tongue
    ],
  },

  // ── Flower Spirit (support) — image/character/monster/5.png
  flower: {
    w: 22, h: 28,
    pal: { body: 0xf2a0c0, dark: 0xb85c86, accent: 0xfff2b0, line: 0x5e2540 },
    parts: [
      { x: -12, y: -24, w: 8, h: 12, c: 0xd8d2f0, tag: 'wingL', z: -1 },
      { x: 4, y: -24, w: 8, h: 12, c: 0xd8d2f0, tag: 'wingR', z: -1 },
      { x: -3, y: -10, w: 3, h: 10, c: 'dark', tag: 'legL' },
      { x: 1, y: -10, w: 3, h: 10, c: 'dark', tag: 'legR' },
      { x: -7, y: -24, w: 14, h: 14, c: 'body', tag: 'torso' },
      { x: -5, y: -18, w: 10, h: 6, c: 'dark', tag: 'skirt' },
      { x: -6, y: -32, w: 12, h: 8, c: 'body', tag: 'head' },
      { x: -8, y: -38, w: 16, h: 6, c: 'dark', tag: 'petals' },
      { x: -4, y: -30, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: 2, y: -30, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: 8, y: -22, w: 6, h: 6, c: 'accent', tag: 'weapon' }, // light mote
    ],
  },

  // ── Golden Knight (hero) — image/character/hero/1.png
  knight: {
    w: 34, h: 48,
    pal: { body: 0xffc95c, dark: 0xc99433, accent: 0xe8eef7, line: 0x4a3410 },
    parts: [
      { x: -12, y: -40, w: 24, h: 30, c: 0x4a7ad4, tag: 'cape', z: -1 },
      { x: -11, y: -16, w: 9, h: 16, c: 'dark', tag: 'legL' },
      { x: 2, y: -16, w: 9, h: 16, c: 'dark', tag: 'legR' },
      { x: -13, y: -38, w: 26, h: 22, c: 'body', tag: 'torso' },
      { x: -9, y: -34, w: 18, h: 5, c: 'accent', tag: 'trim' },
      { x: -20, y: -36, w: 8, h: 18, c: 'body', tag: 'armL' },
      { x: -24, y: -38, w: 10, h: 22, c: 'accent', tag: 'shield' },
      { x: 12, y: -36, w: 7, h: 16, c: 'body', tag: 'armR' },
      { x: -9, y: -50, w: 18, h: 12, c: 'body', tag: 'head' },
      { x: -6, y: -46, w: 12, h: 4, c: 'line', tag: 'visor' },
      { x: -4, y: -58, w: 8, h: 8, c: 0xe0453f, tag: 'plume' },
      { x: 17, y: -46, w: 5, h: 32, c: 'accent', tag: 'weapon' }, // sword
      { x: 14, y: -18, w: 11, h: 4, c: 'dark', tag: 'weapon' }, // crossguard
    ],
  },
};

/** Per-state pose curves. Returns a pose object for frame `i` of `n`. */
function poseFor(state, i, n, unit) {
  const t = n <= 1 ? 0 : i / (n - 1);
  const pose = {
    bob: 0, lean: 0, arm: 0, sy: 1, alpha: 1,
    flash: 0, charge: 0, sink: 0,
  };

  switch (state) {
    case 'idle':
      // gentle 2px breathing bob
      pose.bob = -P * Math.round(Math.sin(t * Math.PI * 2) * 1);
      break;

    case 'move':
      // bob + slight forward lean, legs read as a stride via the bob phase
      pose.bob = -P * Math.abs(Math.round(Math.sin(t * Math.PI * 2) * 1.5));
      pose.lean = P * Math.round(Math.sin(t * Math.PI * 2));
      pose.arm = P * Math.round(Math.cos(t * Math.PI * 2) * 1.5);
      break;

    case 'windup':
      // crouch back, pull the weapon behind, build an accent charge glow
      pose.lean = -P * (1 + i);
      pose.arm = -P * (2 + i * 2);
      pose.sy = 1 - 0.04 * i;
      pose.charge = (i + 1) / n;
      break;

    case 'attack':
      // frame 0 snaps forward, then settles
      pose.lean = P * [4, 3, 2, 1][i];
      pose.arm = P * [7, 5, 3, 1][i];
      pose.bob = -P * [1, 1, 0, 0][i];
      pose.charge = i === 0 ? 1 : 0;
      break;

    case 'hit':
      pose.lean = -P * (2 - i);
      pose.flash = i === 0 ? 1 : 0.5;
      pose.bob = -P;
      break;

    case 'die':
      pose.sy = 1 - 0.18 * i;
      pose.alpha = 1 - 0.18 * i;
      pose.lean = -P * i;
      pose.sink = P * i;
      break;
  }

  if (unit.h < 30) pose.bob = Math.round(pose.bob / 2); // small units bob less
  return pose;
}

function resolveColor(c, pal) {
  if (typeof c === 'number') return c;
  return pal[c] ?? pal.body;
}

/** Applies a pose to one part, returning screen-space rect. */
function placePart(part, pose, unit, ox, oy) {
  const upper = part.y + part.h / 2 < -unit.h * 0.45;
  const isArm = part.tag === 'weapon' || part.tag === 'armR' || part.tag === 'shield';

  let x = part.x;
  let y = part.y;
  let w = part.w;
  let h = part.h;

  if (upper) x += pose.lean;
  if (isArm) x += pose.arm;
  if (part.tag === 'wingL') x -= pose.arm * 0.5;
  if (part.tag === 'wingR') x += pose.arm * 0.5;

  // squash toward the feet, then bob/sink the whole body
  y = y * pose.sy;
  h = h * pose.sy;
  y += pose.bob + pose.sink;

  return {
    x: snap(ox + x),
    y: snap(oy + y),
    w: Math.max(P, snap(w)),
    h: Math.max(P, snap(h)),
  };
}

function drawFrame(g, unit, pose) {
  const W = unit.w + 32;
  const H = unit.h + 20;
  const ox = W / 2;
  const oy = H - 4;

  const parts = [...unit.parts].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
  const rects = parts.map((p) => ({ p, r: placePart(p, pose, unit, ox, oy) }));

  // pass 1 — unified silhouette outline
  g.fillStyle(unit.pal.line, pose.alpha);
  for (const { r } of rects) g.fillRect(r.x - P, r.y - P, r.w + P * 2, r.h + P * 2);

  // pass 2 — fills (white-out on hit frames so damage reads instantly)
  for (const { p, r } of rects) {
    const base = resolveColor(p.c, unit.pal);
    const col = pose.flash > 0
      ? Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.IntegerToColor(base),
        Phaser.Display.Color.IntegerToColor(0xffffff),
        100, pose.flash * 100,
      )
      : null;
    const fill = col ? Phaser.Display.Color.GetColor(col.r, col.g, col.b) : base;
    g.fillStyle(fill, pose.alpha);
    g.fillRect(r.x, r.y, r.w, r.h);
  }

  // pass 3 — charge glow above the head during windup / on the attack snap
  if (pose.charge > 0) {
    const s = snap(4 + pose.charge * 6);
    g.fillStyle(unit.pal.accent, 0.35 + pose.charge * 0.5);
    g.fillRect(snap(ox - s / 2), snap(oy - unit.h - 12 - s), s, s);
  }

  return { W, H };
}

/** Bakes every unit × state × frame into its own texture. */
export function buildUnitTextures(scene) {
  const g = scene.add.graphics();
  const built = {};

  for (const [key, unit] of Object.entries(UNITS)) {
    built[key] = {};
    for (const [state, n] of Object.entries(ANIM_FRAMES)) {
      built[key][state] = [];
      for (let i = 0; i < n; i++) {
        g.clear();
        const { W, H } = drawFrame(g, unit, poseFor(state, i, n, unit));
        const texKey = `${key}_${state}${i}`;
        g.generateTexture(texKey, W, H);
        built[key][state].push(texKey);
      }
    }
  }

  g.destroy();
  return built;
}

/** Small textures for projectiles, particles and ground marks. */
export function buildFxTextures(scene) {
  const g = scene.add.graphics();

  const box = (key, w, h, color, line = null) => {
    g.clear();
    if (line !== null) {
      g.fillStyle(line, 1);
      g.fillRect(0, 0, w + 4, h + 4);
      g.fillStyle(color, 1);
      g.fillRect(2, 2, w, h);
      g.generateTexture(key, w + 4, h + 4);
    } else {
      g.fillStyle(color, 1);
      g.fillRect(0, 0, w, h);
      g.generateTexture(key, w, h);
    }
  };

  // particles
  box('px1', 2, 2, 0xffffff);
  box('px2', 4, 4, 0xffffff);
  box('px3', 6, 6, 0xffffff);

  // projectiles
  box('proj_arrow', 12, 2, 0xd9c27a, 0x12301a);
  box('proj_glob', 6, 6, 0x8ee36b, 0x1d1426);
  box('proj_mote', 6, 6, 0xfff2b0, 0x5e2540);
  box('proj_pierce', 20, 4, 0xeaf7c4, 0x2f7538);

  // soft radial blob used for shadows / glows
  g.clear();
  g.fillStyle(0x000000, 1);
  g.fillEllipse(16, 8, 32, 16);
  g.generateTexture('shadow', 32, 16);

  g.destroy();
}
