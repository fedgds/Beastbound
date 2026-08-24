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
    signature: 'golem',
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
    // The supplied sheet has separate cracked plates rather than one smooth
    // stone block.  These inset marks give the baked sprite that same read.
    details: [
      { x: -13, y: -31, w: 8, h: 3, c: 0xaeb3b5 }, { x: 5, y: -31, w: 7, h: 3, c: 0xaeb3b5 },
      { x: -13, y: -21, w: 7, h: 3, c: 'dark' }, { x: 6, y: -21, w: 6, h: 3, c: 'dark' },
      { x: -14, y: -17, w: 10, h: 2, c: 0x3f4656 }, { x: 4, y: -17, w: 10, h: 2, c: 0x3f4656 },
      { x: -19, y: -27, w: 4, h: 3, c: 'accent' }, { x: 15, y: -27, w: 4, h: 3, c: 'accent' },
      { x: -14, y: -35, w: 6, h: 2, c: 0xc2c7c5 }, { x: 8, y: -35, w: 6, h: 2, c: 0xc2c7c5 },
      { x: -15, y: -24, w: 3, h: 5, c: 0x424957 }, { x: 12, y: -24, w: 3, h: 5, c: 0x424957 },
      { x: -8, y: -40, w: 4, h: 2, c: 0xc8cdcc }, { x: 4, y: -40, w: 4, h: 2, c: 0xc8cdcc },
      { x: -2, y: -30, w: 4, h: 10, c: 0x253342 }, { x: -1, y: -29, w: 2, h: 8, c: 'accent' },
      { x: -12, y: -12, w: 3, h: 5, c: 0x969da7 }, { x: 9, y: -12, w: 3, h: 5, c: 0x969da7 },
    ],
  },

  // ── Goblin Brute (melee DPS) — image/character/monster/2.png
  brute: {
    w: 28, h: 34,
    signature: 'brute',
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
    details: [
      { x: -6, y: -27, w: 12, h: 2, c: 0xe56757 }, { x: -5, y: -24, w: 4, h: 6, c: 'dark' },
      { x: 2, y: -24, w: 4, h: 6, c: 'dark' }, { x: -7, y: -32, w: 3, h: 2, c: 0xf38a72 },
      { x: 3, y: -32, w: 3, h: 2, c: 0xf38a72 }, { x: -5, y: -36, w: 3, h: 2, c: 0xff4c4c },
      { x: 2, y: -36, w: 3, h: 2, c: 0xff4c4c }, { x: 14, y: -32, w: 8, h: 2, c: 0xf0d8bd },
      { x: -10, y: -29, w: 3, h: 8, c: 0x8e2929 }, { x: 7, y: -29, w: 3, h: 8, c: 0x8e2929 },
      { x: -8, y: -18, w: 5, h: 2, c: 0xdf5547 }, { x: 3, y: -18, w: 5, h: 2, c: 0xdf5547 },
      { x: -8, y: -38, w: 2, h: 3, c: 0x6f1f23 }, { x: 6, y: -38, w: 2, h: 3, c: 0x6f1f23 },
      { x: -2, y: -31, w: 4, h: 2, c: 0x53171d }, { x: 16, y: -29, w: 6, h: 2, c: 0x9a765a },
    ],
  },

  // ── Forest Sprite (ranged DPS) — image/character/monster/3.png
  sprite: {
    w: 22, h: 32,
    signature: 'sprite',
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
    details: [
      { x: -6, y: -25, w: 12, h: 2, c: 0x8bd873 }, { x: -4, y: -20, w: 8, h: 2, c: 'dark' },
      { x: -5, y: -34, w: 3, h: 2, c: 0xf4e6a7 }, { x: 2, y: -34, w: 3, h: 2, c: 0xf4e6a7 },
      { x: 10, y: -29, w: 2, h: 12, c: 0xe8d59b }, { x: -6, y: -40, w: 3, h: 3, c: 0x83c760 },
      { x: 3, y: -41, w: 3, h: 3, c: 0x6da94f }, { x: -7, y: -29, w: 3, h: 4, c: 0x78c95f },
      { x: 4, y: -29, w: 3, h: 4, c: 0x78c95f }, { x: -3, y: -23, w: 2, h: 7, c: 0xb5e379 },
      { x: 2, y: -23, w: 2, h: 7, c: 0xb5e379 }, { x: -10, y: -22, w: 2, h: 5, c: 0x296334 },
    ],
  },

  // ── Swamp Toad (CC / debuff) — image/character/monster/4.png
  toad: {
    w: 34, h: 26,
    signature: 'toad',
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
    details: [
      { x: -10, y: -20, w: 7, h: 2, c: 0x9169a3 }, { x: 4, y: -20, w: 7, h: 2, c: 0x9169a3 },
      { x: -13, y: -15, w: 5, h: 2, c: 0x72517d }, { x: 8, y: -15, w: 5, h: 2, c: 0x72517d },
      { x: -9, y: -27, w: 2, h: 4, c: 'line' }, { x: 5, y: -27, w: 2, h: 4, c: 'line' },
      { x: -2, y: -12, w: 4, h: 2, c: 0xd08aa6 },
      { x: -15, y: -9, w: 5, h: 2, c: 0x82608e }, { x: 10, y: -9, w: 5, h: 2, c: 0x82608e },
      { x: -7, y: -18, w: 3, h: 3, c: 0xb781c2 }, { x: 4, y: -18, w: 3, h: 3, c: 0xb781c2 },
      { x: -4, y: -23, w: 8, h: 2, c: 0x73517d }, { x: -3, y: -16, w: 8, h: 2, c: 0x432d50 },
    ],
  },

  // ── Flower Spirit (support) — image/character/monster/5.png
  flower: {
    w: 22, h: 28,
    signature: 'flower',
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
    details: [
      { x: -5, y: -24, w: 10, h: 2, c: 0xffd2e3 }, { x: -4, y: -20, w: 8, h: 2, c: 0xffc1dc },
      { x: -6, y: -37, w: 4, h: 3, c: 0xf2d7ff }, { x: 2, y: -37, w: 4, h: 3, c: 0xf2d7ff },
      { x: -4, y: -30, w: 3, h: 2, c: 0x5e2540 }, { x: 2, y: -30, w: 3, h: 2, c: 0x5e2540 },
      { x: 9, y: -21, w: 3, h: 3, c: 0xffffff },
      { x: -11, y: -21, w: 3, h: 5, c: 0xc9c2e9 }, { x: 9, y: -21, w: 3, h: 5, c: 0xc9c2e9 },
      { x: -7, y: -35, w: 3, h: 3, c: 0xe990bd }, { x: 4, y: -35, w: 3, h: 3, c: 0xe990bd },
      { x: -5, y: -15, w: 10, h: 2, c: 0x9b456f }, { x: -2, y: -11, w: 4, h: 2, c: 0xffdfec },
    ],
  },

  // ── Bomb Goblin — image/character/monster/6.png
  bombGoblin: {
    w: 30, h: 36,
    signature: 'bomb',
    pal: { body: 0xef7c32, dark: 0x873326, accent: 0xffde5b, line: 0x42191a },
    parts: [
      { x: -10, y: -12, w: 8, h: 12, c: 'dark', tag: 'legL' }, { x: 3, y: -12, w: 8, h: 12, c: 'dark', tag: 'legR' },
      { x: -12, y: -27, w: 24, h: 15, c: 'body', tag: 'torso' }, { x: -15, y: -25, w: 5, h: 11, c: 'body', tag: 'armL' },
      { x: 10, y: -25, w: 5, h: 11, c: 'body', tag: 'armR' }, { x: -10, y: -39, w: 20, h: 12, c: 'body', tag: 'head' },
      { x: -6, y: -35, w: 4, h: 4, c: 'accent', tag: 'eye' }, { x: 3, y: -35, w: 4, h: 4, c: 'accent', tag: 'eye' },
      { x: -5, y: -24, w: 10, h: 9, c: 'dark', tag: 'belt' }, { x: 12, y: -37, w: 5, h: 9, c: 0xd94b2f, tag: 'weapon' },
    ],
    details: [
      { x: -8, y: -28, w: 16, h: 2, c: 0xffaf4d }, { x: -8, y: -20, w: 4, h: 4, c: 0xffc23f },
      { x: -1, y: -20, w: 4, h: 4, c: 0xffc23f }, { x: 6, y: -20, w: 4, h: 4, c: 0xffc23f },
      { x: -7, y: -34, w: 2, h: 2, c: 0xffffff }, { x: 4, y: -34, w: 2, h: 2, c: 0xffffff },
      { x: 13, y: -39, w: 2, h: 3, c: 0xfff1a1 }, { x: 14, y: -43, w: 2, h: 3, c: 0xffba43 },
    ],
  },

  // ── Skeleton Rider — image/character/monster/7.png
  skeletonRider: {
    w: 42, h: 42,
    signature: 'rider',
    pal: { body: 0x477c91, dark: 0x223b52, accent: 0x83f1d0, line: 0x101c2b },
    parts: [
      { x: -20, y: -10, w: 40, h: 10, c: 'dark', tag: 'torso' }, { x: -17, y: -18, w: 34, h: 10, c: 'body', tag: 'torso' },
      { x: -16, y: -5, w: 6, h: 9, c: 'dark', tag: 'legL' }, { x: 10, y: -5, w: 6, h: 9, c: 'dark', tag: 'legR' },
      { x: -8, y: -34, w: 16, h: 16, c: 'body', tag: 'torso' }, { x: -6, y: -43, w: 12, h: 9, c: 'body', tag: 'head' },
      { x: -4, y: -40, w: 3, h: 3, c: 'accent', tag: 'eye' }, { x: 2, y: -40, w: 3, h: 3, c: 'accent', tag: 'eye' },
      { x: 11, y: -42, w: 3, h: 34, c: 0x9a684e, tag: 'weapon' }, { x: 10, y: -44, w: 7, h: 5, c: 0xc79a6e, tag: 'weapon' },
    ],
    details: [
      { x: -18, y: -15, w: 28, h: 2, c: 0x6aa3b4 }, { x: -15, y: -7, w: 6, h: 2, c: 0x7eb8c0 },
      { x: -4, y: -30, w: 8, h: 2, c: 0x9d6d51 }, { x: -6, y: -24, w: 12, h: 2, c: 0x9d6d51 },
      { x: -5, y: -39, w: 2, h: 2, c: 0xc4fff1 }, { x: 3, y: -39, w: 2, h: 2, c: 0xc4fff1 },
      { x: -20, y: -3, w: 6, h: 2, c: 0x315b72 }, { x: 14, y: -3, w: 6, h: 2, c: 0x315b72 },
    ],
  },

  // ── Ghostly Wraith — image/character/monster/8.png
  wraith: {
    w: 34, h: 44,
    signature: 'wraith',
    pal: { body: 0x8ccfe1, dark: 0x31566d, accent: 0xe2fbff, line: 0x15283b },
    parts: [
      { x: -13, y: -25, w: 26, h: 24, c: 'body', tag: 'torso' }, { x: -16, y: -30, w: 7, h: 14, c: 'body', tag: 'armL' },
      { x: 9, y: -30, w: 7, h: 14, c: 'body', tag: 'armR' }, { x: -10, y: -42, w: 20, h: 17, c: 'dark', tag: 'head' },
      { x: -7, y: -37, w: 4, h: 4, c: 'accent', tag: 'eye' }, { x: 3, y: -37, w: 4, h: 4, c: 'accent', tag: 'eye' },
      { x: -9, y: -7, w: 8, h: 7, c: 'body', tag: 'wingL' }, { x: 1, y: -5, w: 8, h: 5, c: 'body', tag: 'wingR' },
    ],
    details: [
      { x: -11, y: -28, w: 22, h: 3, c: 0xc9f4fa }, { x: -8, y: -22, w: 16, h: 2, c: 0x5f9db3 },
      { x: -7, y: -32, w: 14, h: 2, c: 0x517e94 }, { x: -8, y: -39, w: 2, h: 2, c: 0xffffff },
      { x: 5, y: -39, w: 2, h: 2, c: 0xffffff }, { x: -12, y: -17, w: 5, h: 2, c: 0xd6faff },
      { x: 7, y: -17, w: 5, h: 2, c: 0xd6faff }, { x: -3, y: -9, w: 6, h: 2, c: 0x4b8096 },
    ],
  },

  // ── Ice Mage (boss) — image/character/hero/2.png
  iceMage: {
    w: 34, h: 48,
    signature: 'iceMage',
    pal: { body: 0x9bc5df, dark: 0x456b91, accent: 0x9ff4ff, line: 0x17263f },
    parts: [
      { x: -14, y: -37, w: 8, h: 25, c: 0x789fc1, tag: 'cape', z: -1 },
      { x: 6, y: -37, w: 8, h: 25, c: 0x789fc1, tag: 'cape', z: -1 },
      { x: -9, y: -12, w: 7, h: 12, c: 'dark', tag: 'legL' },
      { x: 2, y: -12, w: 7, h: 12, c: 'dark', tag: 'legR' },
      { x: -11, y: -34, w: 22, h: 22, c: 'body', tag: 'torso' },
      { x: -22, y: -33, w: 11, h: 19, c: 0x83add0, tag: 'armL' },
      { x: 11, y: -33, w: 11, h: 19, c: 0x83add0, tag: 'armR' },
      { x: -8, y: -46, w: 16, h: 12, c: 0xd6eafa, tag: 'head' },
      { x: -10, y: -51, w: 20, h: 8, c: 0xd9edf9, tag: 'hair' },
      { x: -28, y: -50, w: 3, h: 45, c: 0x638eae, tag: 'weapon' },
      { x: -31, y: -55, w: 9, h: 10, c: 'accent', tag: 'weapon' },
      { x: -4, y: -42, w: 3, h: 2, c: 'accent', tag: 'eye' },
      { x: 2, y: -42, w: 3, h: 2, c: 'accent', tag: 'eye' },
    ],
    details: [
      { x: -9, y: -33, w: 18, h: 3, c: 0xe0f4ff }, { x: -6, y: -28, w: 12, h: 2, c: 0x5d86aa },
      { x: -3, y: -32, w: 6, h: 16, c: 0x628cb0 }, { x: -2, y: -30, w: 4, h: 12, c: 0xb7e9f5 },
      { x: -19, y: -29, w: 5, h: 2, c: 0xc8e8fa }, { x: 14, y: -29, w: 5, h: 2, c: 0xc8e8fa },
      { x: -8, y: -47, w: 5, h: 2, c: 0xffffff }, { x: 3, y: -47, w: 5, h: 2, c: 0xffffff },
      { x: -30, y: -54, w: 7, h: 3, c: 0xe2fbff }, { x: -29, y: -58, w: 4, h: 4, c: 0xffffff },
      { x: -8, y: -14, w: 6, h: 2, c: 0xc7e6f6 }, { x: 3, y: -14, w: 6, h: 2, c: 0xc7e6f6 },
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
    // Derived from hero/1: layered gold plate, blue enamel, chainmail and a
    // lion-marked shield replace the former simple yellow rectangles.
    details: [
      { x: -10, y: -37, w: 20, h: 3, c: 0xffe6a0 }, { x: -8, y: -29, w: 16, h: 2, c: 0xe3a93f },
      { x: -2, y: -35, w: 3, h: 16, c: 0xe0a53a }, { x: -11, y: -18, w: 8, h: 3, c: 0xe8eef7 },
      { x: 3, y: -18, w: 8, h: 3, c: 0xe8eef7 }, { x: -7, y: -48, w: 14, h: 2, c: 0xffe6a0 },
      { x: -5, y: -45, w: 10, h: 2, c: 0x6b4a19 }, { x: -20, y: -31, w: 5, h: 3, c: 0x4a7ad4 },
      { x: -22, y: -27, w: 6, h: 3, c: 0xe8c45a }, { x: -21, y: -23, w: 4, h: 3, c: 0xe8c45a },
      { x: -11, y: -39, w: 3, h: 3, c: 0xffffff }, { x: 15, y: -43, w: 3, h: 23, c: 0xffffff },
      // Cape folds, helmet rivets and armour seams turn the boss silhouette
      // into the layered gold-and-blue figure from the reference sheet.
      { x: -12, y: -39, w: 4, h: 18, c: 0x3158a7 }, { x: -7, y: -37, w: 3, h: 20, c: 0x234789 },
      { x: 5, y: -38, w: 3, h: 20, c: 0x3158a7 }, { x: 9, y: -36, w: 3, h: 17, c: 0x19366f },
      { x: -11, y: -18, w: 5, h: 2, c: 0x5274c7 }, { x: 6, y: -18, w: 5, h: 2, c: 0x5274c7 },
      { x: -8, y: -51, w: 4, h: 2, c: 0xe2a93a }, { x: 4, y: -51, w: 4, h: 2, c: 0xe2a93a },
      { x: -7, y: -43, w: 2, h: 2, c: 0xfff1b7 }, { x: 5, y: -43, w: 2, h: 2, c: 0xfff1b7 },
      { x: -9, y: -26, w: 4, h: 2, c: 0xffd978 }, { x: 5, y: -26, w: 4, h: 2, c: 0xffd978 },
      { x: -8, y: -22, w: 3, h: 2, c: 0xb87e26 }, { x: 5, y: -22, w: 3, h: 2, c: 0xb87e26 },
      // Dithered chainmail links below the breastplate.
      { x: -9, y: -15, w: 3, h: 2, c: 0xc4cad4 }, { x: -3, y: -15, w: 3, h: 2, c: 0x6f7786 },
      { x: 3, y: -15, w: 3, h: 2, c: 0xc4cad4 }, { x: -6, y: -12, w: 3, h: 2, c: 0x6f7786 },
      { x: 0, y: -12, w: 3, h: 2, c: 0xc4cad4 }, { x: 6, y: -12, w: 3, h: 2, c: 0x6f7786 },
      // Blue enamel shield, gold rim and a compact lion-shaped crest.
      { x: -23, y: -35, w: 2, h: 17, c: 0xe7c25c }, { x: -16, y: -35, w: 2, h: 17, c: 0xe7c25c },
      { x: -21, y: -30, w: 5, h: 2, c: 0x183b80 }, { x: -20, y: -27, w: 3, h: 5, c: 0xf1c951 },
      { x: -18, y: -25, w: 3, h: 2, c: 0xf1c951 }, { x: -19, y: -21, w: 2, h: 2, c: 0xf1c951 },
      // Blade fuller and lit crossguard preserve the weapon at small scale.
      { x: 18, y: -45, w: 2, h: 22, c: 0xb9d3ee }, { x: 13, y: -19, w: 13, h: 2, c: 0xf0d084 },
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

  // Material highlights, seams and facial marks. They ride the same body pose
  // as the source parts, preserving the small attack and movement animations.
  for (const part of unit.details ?? []) {
    const r = placePart(part, pose, unit, ox, oy);
    const base = resolveColor(part.c, unit.pal);
    g.fillStyle(base, pose.alpha);
    g.fillRect(r.x, r.y, r.w, r.h);
  }

  // A few hand-placed marks do much more for readability at this scale than
  // adding another generic rectangle to every silhouette.  They are deliberately
  // baked after the construction seams, so each creature keeps its own material
  // language even in the middle of a busy fight.
  drawSignature(g, unit.signature, ox, oy, pose.alpha);

  // pass 3 — charge glow above the head during windup / on the attack snap
  if (pose.charge > 0) {
    const s = snap(4 + pose.charge * 6);
    g.fillStyle(unit.pal.accent, 0.35 + pose.charge * 0.5);
    g.fillRect(snap(ox - s / 2), snap(oy - unit.h - 12 - s), s, s);
  }

  return { W, H };
}

/** Small, species-specific pixel clusters derived from the supplied sheets. */
function drawSignature(g, signature, ox, oy, alpha) {
  if (!signature) return;
  const rect = (x, y, w, h, color, a = 1) => { g.fillStyle(color, alpha * a); g.fillRect(snap(ox + x), snap(oy + y), w, h); };
  const line = (x, y, n, dx, dy, color, a = 1) => {
    for (let i = 0; i < n; i++) rect(x + dx * i, y + dy * i, P, P, color, a);
  };

  switch (signature) {
    case 'golem':
      // Cracked stone plates and the cyan core channels from the concept sheet.
      line(-13, -33, 4, 2, 2, 0x454c5a); line(11, -33, 3, -2, 2, 0x454c5a);
      line(-15, -22, 3, 2, -2, 0xaeb6bd); line(12, -20, 3, -2, -2, 0xaeb6bd);
      rect(-2, -27, 4, 2, 0x9df4ff); rect(-2, -23, 2, 4, 0x45cbe9);
      rect(-21, -19, 3, 2, 0x5fe3ff, .75); rect(18, -19, 3, 2, 0x5fe3ff, .75);
      break;
    case 'brute':
      // Chest segmentation, tusks and axe nicks make the brute read as brutal.
      rect(-8, -24, 16, 2, 0x6e1e22); rect(-2, -27, 2, 9, 0x7c2324);
      rect(-6, -31, 3, 2, 0xf4d5bd); rect(3, -31, 3, 2, 0xf4d5bd);
      line(-11, -18, 3, 2, 1, 0xe66a55, .65); line(15, -35, 4, 2, 0, 0xe6d3b5, .8);
      break;
    case 'sprite':
      // Leaf scales on the mantle and a taut luminous bowstring.
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) rect(-8 + c * 4 + (r % 2) * 2, -25 + r * 3, 3, 2, r === 1 ? 0x86d567 : 0x376f35);
      line(10, -32, 8, 0, 2, 0xeaf7c4, .75); rect(11, -27, 2, 2, 0xb8ff99);
      break;
    case 'toad':
      // Warts, damp highlights, and a curled tongue give the swamp silhouette life.
      rect(-13, -24, 3, 3, 0x805b90); rect(9, -22, 3, 3, 0x805b90); rect(-3, -20, 2, 2, 0xb184b8);
      rect(3, -17, 6, 2, 0xe07e98); rect(7, -15, 3, 3, 0xe07e98); rect(5, -13, 3, 2, 0xc65f7f);
      rect(-12, -11, 2, 4, 0xb6edc5, .7); rect(12, -10, 2, 3, 0xb6edc5, .7);
      break;
    case 'flower':
      // Petal layers and translucent wing veins retain the flower spirit's glow.
      rect(-8, -37, 5, 3, 0xffcce5); rect(3, -37, 5, 3, 0xffcce5); rect(-2, -40, 4, 4, 0xffe7a8);
      line(-11, -23, 4, 2, 2, 0xbfc4ed, .75); line(10, -23, 4, -2, 2, 0xbfc4ed, .75);
      rect(-3, -18, 6, 2, 0xffe1ed); rect(-1, -15, 2, 3, 0xfff4bd);
      break;
    case 'bomb':
      // Lit fuses, metal straps and individual bomb canisters.
      rect(-10, -27, 20, 2, 0x5b2923); rect(-8, -23, 4, 5, 0xffbc38); rect(-1, -23, 4, 5, 0xff8f26); rect(6, -23, 4, 5, 0xffbc38);
      rect(13, -43, 2, 3, 0xffe6a2); rect(15, -45, 2, 2, 0xff8c35); rect(17, -47, 2, 2, 0xffe6a2);
      rect(-3, -30, 6, 2, 0x5c251f); break;
    case 'rider':
      // Ribs, saddle trim and the mount's spectral eye separate it from a normal skeleton.
      for (let i = 0; i < 5; i++) rect(-15 + i * 6, -15, 3, 2, i % 2 ? 0x75a6b4 : 0x29485e);
      rect(-5, -25, 10, 2, 0xb8845c); rect(-20, -10, 3, 2, 0x8cf5dc); rect(16, -13, 4, 2, 0x8cf5dc);
      line(13, -41, 4, 0, 2, 0xd6a174); break;
    case 'wraith':
      // Layered ectoplasmic folds and a cold skull mouth.
      line(-10, -25, 5, 3, 2, 0xd5f9ff, .8); line(9, -25, 4, -3, 2, 0x6cabc0, .9);
      rect(-4, -33, 8, 2, 0x99d9e7); rect(-2, -29, 4, 2, 0xdffcff);
      rect(-14, -18, 3, 2, 0xe3fbff, .7); rect(11, -18, 3, 2, 0xe3fbff, .7);
      break;
    case 'iceMage':
      // Silver hair, embroidered snowflake tabard and a live ice staff.
      line(-9, -49, 8, 2, 0, 0xf4fbff, .9); line(-10, -44, 4, 0, 3, 0xb7d8ee, .85);
      line(8, -44, 4, 0, 3, 0xb7d8ee, .85); rect(-3, -25, 6, 2, 0xe8fbff);
      rect(-1, -22, 2, 8, 0x75abd0); rect(-5, -20, 10, 2, 0x5e8eb2, .8);
      rect(-27, -51, 4, 4, 0xe1fbff); rect(-30, -48, 2, 3, 0x76e5ff); rect(-24, -56, 2, 3, 0x76e5ff);
      rect(15, -39, 3, 5, 0xcff4ff, .8); rect(-20, -39, 3, 5, 0xcff4ff, .8);
      break;
    default:
      break;
  }
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
  box('proj_bomb', 9, 9, 0xef522f, 0x42191a);
  box('proj_wraith', 8, 5, 0xcaf7ff, 0x31566d);
  box('proj_iceShard', 14, 4, 0xbff8ff, 0x397aa2);

  // soft radial blob used for shadows / glows
  g.clear();
  g.fillStyle(0x000000, 1);
  g.fillEllipse(16, 8, 32, 16);
  g.generateTexture('shadow', 32, 16);

  g.destroy();
}
