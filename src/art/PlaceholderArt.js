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
import { dither, ditherRampV, rng, speckle } from './PixelDraw.js';

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
  // Baked at 46x68 and rendered 1:1, so the hood, layered robe, snowflake
  // embroidery and faceted staff crystal all have room to read.
  iceMage: {
    w: 46, h: 68, // Giữ nguyên kích thước khung hình
    signature: 'iceMage_v2_Detailed',
    poseAmp: 1.5,
    pal: { 
      body: 0x9bc5df, dark: 0x456b91, accent: 0x9ff4ff, line: 0x17263f, 
      skin: 0xFDEFD3, // Thêm màu da
      iceWhite: 0xFFFFFF 
    },
    parts: [
      // --- Phần Tóc và Đầu (Thay đổi lớn: Bỏ mũ trùm, lộ mặt) ---
      // Tóc dài phía sau (giữ nguyên)
      { x: -14, y: -64, w: 6, h: 28, c: 0xe6eef5, tag: 'hair', z: -1 },
      { x: 8, y: -64, w: 6, h: 28, c: 0xe6eef5, tag: 'hair', z: -1 },
      
      // Khuôn mặt (thay thế phần mũ trùm cũ)
      { x: -8, y: -67, w: 16, h: 14, c: 0xFDEFD3, tag: 'head' }, // Da mặt
      { x: -6, y: -65, w: 12, h: 8, c: 0xe6eef5, tag: 'hair' }, // Tóc mái trước trán
      { x: -3, y: -62, w: 6, h: 1, c: 0x456b91, tag: 'eyebrow' }, // Lông mày
      { x: -5, y: -61, w: 3, h: 2, c: 0x17263f, tag: 'eyeL' }, // Mắt trái
      { x: 2, y: -61, w: 3, h: 2, c: 0x17263f, tag: 'eyeR' }, // Mắt phải
      { x: -1, y: -58, w: 2, h: 2, c: 0x9bc5df, tag: 'nose' }, // Mũi
      { x: -2, y: -55, w: 4, h: 1, c: 0x7fa8c9, tag: 'mouth' }, // Miệng
      { x: -3, y: -69, w: 6, h: 3, c: 0x9ff4ff, tag: 'head_acc' }, // Vương miện băng nhỏ

      // --- Phần Thân và Trang phục (Cập nhật hở cổ chữ V, thêm lông vũ băng) ---
      // Cổ áo lông vũ băng (thay thế cổ áo kín cũ)
      { x: -14, y: -57, w: 28, h: 10, c: 0xFFFFFF, tag: 'torso' }, // Lớp lông vũ trắng
      { x: -10, y: -54, w: 20, h: 12, c: 0xdff2ff, tag: 'torso' }, // Lớp trong cổ áo

      // Thân áo chính (tạo hình chữ V hở ngực)
      { x: -6, y: -50, w: 12, h: 40, c: 0xc3dcee, tag: 'torso' }, // Tabard giữa (giữ)
      { x: -15, y: -52, w: 30, h: 16, c: 0x7fa8c9, tag: 'torso' }, // Phần ngực trên
      { x: -18, y: -38, w: 36, h: 14, c: 0x7fa8c9, tag: 'torso' }, // Phần eo
      { x: -16, y: -26, w: 32, h: 16, c: 0x6f97b8, tag: 'torso' }, // Hông váy
      { x: -14, y: -12, w: 28, h: 10, c: 0x6f97b8, tag: 'torso' }, // Gấu váy
      
      // Quần bó / Chân váy lót trong
      { x: -6, y: -15, w: 12, h: 30, c: 0x9bc5df, tag: 'legs_inner' },

      // --- Phần Tay và Vũ khí ---
      // Tay áo rộng (bell sleeves - giữ nguyên vị trí nhưng điều chỉnh màu)
      { x: -24, y: -52, w: 13, h: 24, c: 0x7fa8c9, tag: 'armL' },
      { x: 11, y: -52, w: 13, h: 24, c: 0x7fa8c9, tag: 'armR' },
      
      // Cánh tay trái (cầm trượng)
      { x: -22, y: -50, w: 4, h: 10, c: 0xFDEFD3, tag: 'handL' },
      // Trượng băng (cao vút bên trái)
      { x: -27, y: -76, w: 4, h: 68, c: 0x8fa9c4, tag: 'weapon_shaft' }, // Thân trượng
      { x: -31, y: -82, w: 12, h: 13, c: 0x9ff4ff, tag: 'weapon_crystal' }, // Tinh thể đỉnh trượng

      // Cánh tay phải (phép thuật) - MỚI
      { x: 14, y: -50, w: 4, h: 10, c: 0xFDEFD3, tag: 'handR' }, // Bàn tay phải
      { x: 18, y: -56, w: 6, h: 6, c: 0x9ff4ff, tag: 'magic_crystal_R' }, // Tinh thể nhỏ tay phải

      // --- Phần Chân và Giày (Giữ nguyên) ---
      { x: -10, y: -10, w: 8, h: 10, c: 0x2e4763, tag: 'legL' },
      { x: 2, y: -10, w: 8, h: 10, c: 0x2e4763, tag: 'legR' },
    ],
    details: [
      // --- Chi tiết Trang trí (Thêm pha lê treo và pha lê bay) ---
      
      // Dải pha lê treo quanh eo (vị trí thắt lưng cũ)
      { x: -14, y: -38, w: 28, h: 2, c: 0x9ff4ff, tag: 'waist_crystal_chain' },
      { x: -3, y: -35, w: 6, h: 12, c: 0x9ff4ff, tag: 'waist_crystal_dangle' }, // Pha lê trung tâm

      // Pha lê treo ở tay áo
      { x: -22, y: -40, w: 2, h: 8, c: 0x9ff4ff, tag: 'sleeveL_dangle' },
      { x: -19, y: -35, w: 2, h: 6, c: 0x9ff4ff, tag: 'sleeveL_dangle' },
      { x: 19, y: -40, w: 2, h: 8, c: 0x9ff4ff, tag: 'sleeveR_dangle' },
      { x: 22, y: -35, w: 2, h: 6, c: 0x9ff4ff, tag: 'sleeveR_dangle' },

      // Pha lê treo dọc váy (cập nhật theo hình ảnh)
      { x: -9, y: -24, w: 2, h: 6, c: 0x9ff4ff, tag: 'skirt_dangle' },
      { x: 7, y: -24, w: 2, h: 6, c: 0x9ff4ff, tag: 'skirt_dangle' },
      { x: -3, y: -18, w: 6, h: 12, c: 0x9ff4ff, tag: 'skirt_dangle_center' }, // Pha lê lớn giữa váy

      // Họa tiết bông tuyết trên tabard (cập nhật màu sắc)
      { x: -4, y: -46, w: 8, h: 8, c: 0x9ff4ff, tag: 'snowflake_emblem' },

      // --- Các tinh thể pha lê bay lơ lửng (MỚI - tagged để dễ di chuyển) ---
      // Cụm bên trái (trên vai trái)
      { x: -35, y: -60, w: 6, h: 8, c: 0x9ff4ff, tag: 'floating_crystal' },
      { x: -40, y: -55, w: 4, h: 6, c: 0x9ff4ff, tag: 'floating_crystal' },
      // Cụm bên phải (trên vai phải và tay phải)
      { x: 30, y: -60, w: 6, h: 8, c: 0x9ff4ff, tag: 'floating_crystal' },
      { x: 35, y: -55, w: 4, h: 6, c: 0x9ff4ff, tag: 'floating_crystal' },
      { x: 25, y: -50, w: 5, h: 5, c: 0x9ff4ff, tag: 'floating_crystal' }, // Gần tay phải

      // --- Chi tiết nhỏ trên trang phục (viền cổ, viền tay) ---
      // Cập nhật viền cổ áo và viền tay áo bằng màu sáng (accent/iceWhite)
      { x: -14, y: -57, w: 28, h: 1, c: 0xFFFFFF, tag: 'collar_trim' },
      { x: -24, y: -52, w: 1, h: 24, c: 0xFFFFFF, tag: 'sleeveL_trim' },
      { x: 23, y: -52, w: 1, h: 24, c: 0xFFFFFF, tag: 'sleeveR_trim' },

      // --- Chi tiết trên vũ khí (cập nhật theo hình) ---
      { x: -29, y: -81, w: 8, h: 11, c: 0xFFFFFF, tag: 'weapon_crystal_highlight' }, // Điểm sáng tinh thể
      { x: -26, y: -70, w: 2, h: 6, c: 0x9ff4ff, tag: 'weapon_handle_acc' }, // Chi tiết tay cầm

      // --- Hiệu ứng phép thuật ở tay phải (MỚI) ---
      { x: 16, y: -58, w: 10, h: 10, c: 0x9ff4ff, alpha: 0.5, tag: 'magic_swirl_R' }, // Vòng xoáy phép thuật mờ
    ],
  },

  // ── Lion Monk (hero) — image/character/hero/3.png
  // The concept sheet is not a gameplay sprite sheet, so this compact combat
  // silhouette translates its defining shapes: broad gold mane, bare muscular
  // torso, crimson sash, wrapped fists, loose dark trousers and ankle wraps.
  lionMonk: {
    w: 52, h: 78,
    signature: 'lionMonk',
    poseAmp: 1.65,
    pal: {
      body: 0xc9823f,
      dark: 0x493029,
      accent: 0xffbd52,
      line: 0x2b1714,
      skin: 0xd9954d,
      wrap: 0xd8c3a1,
    },
    parts: [
      // Mane mass sits behind the face and shoulders.
      { x: -22, y: -78, w: 44, h: 31, c: 0x7c421f, tag: 'mane', z: -2 },
      { x: -27, y: -72, w: 10, h: 28, c: 0x9c5729, tag: 'mane', z: -2 },
      { x: 17, y: -72, w: 10, h: 28, c: 0x9c5729, tag: 'mane', z: -2 },

      // Feet, shin wraps and loose martial trousers.
      { x: -18, y: -6, w: 16, h: 6, c: 'skin', tag: 'legL' },
      { x: 3, y: -6, w: 16, h: 6, c: 'skin', tag: 'legR' },
      { x: -16, y: -18, w: 12, h: 13, c: 0x8f2f2b, tag: 'legL' },
      { x: 5, y: -18, w: 12, h: 13, c: 0x8f2f2b, tag: 'legR' },
      { x: -18, y: -39, w: 16, h: 23, c: 0x252733, tag: 'legL' },
      { x: 2, y: -39, w: 16, h: 23, c: 0x252733, tag: 'legR' },
      { x: -21, y: -46, w: 42, h: 13, c: 0x30323f, tag: 'torso' },
      { x: -22, y: -48, w: 44, h: 7, c: 0x641f23, tag: 'belt' },

      // Bare torso, shoulders and powerful forearms.
      { x: -18, y: -67, w: 36, h: 24, c: 'skin', tag: 'torso' },
      { x: -28, y: -66, w: 12, h: 24, c: 'skin', tag: 'armL' },
      { x: 16, y: -66, w: 12, h: 24, c: 'skin', tag: 'armR' },
      { x: -30, y: -48, w: 13, h: 18, c: 'wrap', tag: 'armL' },
      { x: 17, y: -48, w: 13, h: 18, c: 'wrap', tag: 'armR' },
      { x: -31, y: -35, w: 14, h: 11, c: 0xbda98b, tag: 'armL' },
      { x: 17, y: -35, w: 14, h: 11, c: 0xbda98b, tag: 'armR' },

      // Lion face, muzzle and ears framed by the mane.
      { x: -15, y: -88, w: 30, h: 23, c: 'skin', tag: 'head' },
      { x: -18, y: -88, w: 9, h: 9, c: 0x9c5729, tag: 'head' },
      { x: 9, y: -88, w: 9, h: 9, c: 0x9c5729, tag: 'head' },
      { x: -10, y: -75, w: 20, h: 12, c: 0xe2a15b, tag: 'head' },
      { x: -4, y: -71, w: 8, h: 6, c: 0x4b261b, tag: 'head' },
    ],
    details: [
      // Red sash crossing the chest in stepped diagonal segments.
      { x: -16, y: -68, w: 8, h: 9, c: 0x7b2425, tag: 'torso' },
      { x: -10, y: -61, w: 8, h: 9, c: 0x7b2425, tag: 'torso' },
      { x: -4, y: -54, w: 9, h: 9, c: 0x7b2425, tag: 'torso' },
      { x: 2, y: -48, w: 17, h: 5, c: 0xa73b2e, tag: 'belt' },
      // Face and bright amber eyes.
      { x: -9, y: -82, w: 5, h: 3, c: 0x2b1714, tag: 'head' },
      { x: 4, y: -82, w: 5, h: 3, c: 0x2b1714, tag: 'head' },
      { x: -8, y: -82, w: 2, h: 2, c: 0xffd76a, tag: 'head' },
      { x: 6, y: -82, w: 2, h: 2, c: 0xffd76a, tag: 'head' },
      { x: -7, y: -67, w: 14, h: 2, c: 0x341b17, tag: 'head' },
      // Wrapped-knuckle bands and red wrist ties.
      { x: -30, y: -44, w: 13, h: 3, c: 0x8d3029, tag: 'armL' },
      { x: 17, y: -44, w: 13, h: 3, c: 0x8d3029, tag: 'armR' },
      { x: -29, y: -38, w: 12, h: 2, c: 0xf0ddbc, tag: 'armL' },
      { x: 18, y: -38, w: 12, h: 2, c: 0xf0ddbc, tag: 'armR' },
      // Gold edging on belt and ankle wraps.
      { x: -22, y: -48, w: 44, h: 2, c: 0xd99a3c, tag: 'belt' },
      { x: -16, y: -16, w: 12, h: 2, c: 0xd99a3c, tag: 'legL' },
      { x: 5, y: -16, w: 12, h: 2, c: 0xd99a3c, tag: 'legR' },
    ],
  },

  // ── Solar Lion beast form ────────────────────────────────────────────────
  // A separate quadruped animation set makes Solar Lion Fury a real form
  // change. It is wider, lower and built around a massive ember mane rather
  // than reusing the humanoid body under a tint.
  lionMonkBeast: {
    w: 78, h: 62,
    signature: 'solarLionBeast',
    poseAmp: 1.8,
    pal: {
      body: 0xd86c2d,
      dark: 0x74251f,
      accent: 0xffd665,
      line: 0x35151a,
    },
    parts: [
      // Long flaming tail behind the body, built as stepped segments.
      { x: -47, y: -40, w: 20, h: 8, c: 0x7f2920, tag: 'tail', z: -3 },
      { x: -54, y: -49, w: 12, h: 10, c: 0xb84323, tag: 'tail', z: -3 },
      { x: -58, y: -60, w: 10, h: 13, c: 0xf07a2e, tag: 'tail', z: -3 },
      { x: -60, y: -67, w: 8, h: 10, c: 0xffc34d, tag: 'tail', z: -3 },

      // Rear legs, belly and the long feline torso.
      { x: -23, y: -27, w: 12, h: 27, c: 0xa63b24, tag: 'legL', z: -1 },
      { x: -10, y: -23, w: 11, h: 23, c: 0xc55428, tag: 'legR', z: -1 },
      { x: -29, y: -48, w: 54, h: 27, c: 'body', tag: 'torso' },
      { x: -25, y: -25, w: 43, h: 12, c: 0xb94826, tag: 'torso' },
      { x: -27, y: -7, w: 18, h: 7, c: 0x8b2d22, tag: 'legL' },
      { x: -11, y: -7, w: 17, h: 7, c: 0x9e3622, tag: 'legR' },

      // Forelegs use arm tags so the attack animation drives a real claw swipe.
      { x: 18, y: -31, w: 12, h: 31, c: 0xc85327, tag: 'armL' },
      { x: 29, y: -29, w: 13, h: 29, c: 0xe3772f, tag: 'armR' },
      { x: 16, y: -7, w: 18, h: 7, c: 0x9a3021, tag: 'armL' },
      { x: 29, y: -7, w: 20, h: 7, c: 0xbd4324, tag: 'armR' },

      // Layered mane plates: dark outer mass, orange middle, sunlit inner rim.
      { x: 7, y: -66, w: 37, h: 43, c: 0x70211f, tag: 'mane', z: -1 },
      { x: 13, y: -64, w: 33, h: 38, c: 0xa73722, tag: 'mane', z: -1 },
      { x: 18, y: -60, w: 28, h: 32, c: 0xe36d2c, tag: 'mane', z: -1 },

      // Side-profile lion head, bright eye and open roaring muzzle.
      { x: 21, y: -63, w: 29, h: 24, c: 0xe9853c, tag: 'head' },
      { x: 20, y: -69, w: 11, h: 10, c: 0xa83923, tag: 'head' },
      { x: 37, y: -51, w: 17, h: 13, c: 0xf1a650, tag: 'head' },
      { x: 42, y: -46, w: 14, h: 9, c: 0x5b211d, tag: 'head' },
      { x: 40, y: -38, w: 15, h: 7, c: 0xe87934, tag: 'head' },
      { x: 44, y: -34, w: 11, h: 5, c: 0x361519, tag: 'head' },
    ],
    details: [
      // Molten dorsal ridge and flame-like body stripes.
      { x: -23, y: -49, w: 46, h: 3, c: 0xffb746, tag: 'torso' },
      { x: -17, y: -45, w: 6, h: 15, c: 0x8e2b20, tag: 'torso' },
      { x: -5, y: -45, w: 6, h: 13, c: 0x9c3020, tag: 'torso' },
      { x: 7, y: -44, w: 5, h: 12, c: 0x8e2b20, tag: 'torso' },
      // Brow, sun eye, nose, fangs and tongue inside the roar.
      { x: 32, y: -58, w: 9, h: 3, c: 0x76221c, tag: 'head' },
      { x: 35, y: -55, w: 5, h: 4, c: 0xffef9a, tag: 'head' },
      { x: 37, y: -54, w: 2, h: 2, c: 0xffffff, tag: 'head' },
      { x: 49, y: -49, w: 7, h: 5, c: 0x2c1317, tag: 'head' },
      { x: 44, y: -40, w: 4, h: 6, c: 0xffedbd, tag: 'head' },
      { x: 51, y: -39, w: 4, h: 5, c: 0xffedbd, tag: 'head' },
      { x: 46, y: -34, w: 8, h: 2, c: 0xe84c30, tag: 'head' },
      // Hot knuckles and individual white claw tips.
      { x: 19, y: -8, w: 15, h: 3, c: 0xff9b37, tag: 'armL' },
      { x: 31, y: -8, w: 18, h: 3, c: 0xffbd4e, tag: 'armR' },
      { x: 43, y: -5, w: 7, h: 3, c: 0xfff2c4, tag: 'armR' },
    ],
  },

  // ── Nightveil Archer (hero) — image/character/hero/4.png
  // The concept's hood, layered torn cloak, crossed chest straps, violet bow
  // and ankle smoke are rebuilt as a tall combat silhouette with enough room
  // for individual buckles, arrow fletching and cloth highlights.
  nightveilArcher: {
    w: 70, h: 92,
    signature: 'nightveilArcher',
    poseAmp: 1.7,
    pal: {
      body: 0x292b3a,
      dark: 0x171923,
      accent: 0xa85ae6,
      line: 0x090b12,
      cloth: 0x383b4c,
      leather: 0x4b3b38,
      steel: 0xb8c1d3,
    },
    parts: [
      // Quiver and arrow shafts sit behind the shoulder and cloak.
      { x: -23, y: -77, w: 11, h: 39, c: 0x241c22, tag: 'cape', z: -4 },
      { x: -25, y: -91, w: 3, h: 35, c: 0x888ca1, tag: 'cape', z: -5 },
      { x: -19, y: -94, w: 3, h: 37, c: 0x9c91ad, tag: 'cape', z: -5 },
      { x: -13, y: -90, w: 3, h: 31, c: 0x73798d, tag: 'cape', z: -5 },
      { x: -29, y: -96, w: 9, h: 6, c: 0x6e3aa1, tag: 'cape', z: -5 },
      { x: -23, y: -99, w: 9, h: 6, c: 0x8c4fc1, tag: 'cape', z: -5 },
      { x: -17, y: -95, w: 9, h: 6, c: 0x553075, tag: 'cape', z: -5 },

      // Long split cloak, deliberately asymmetric and ragged at the hem.
      { x: -25, y: -66, w: 50, h: 46, c: 'dark', tag: 'cape', z: -3 },
      { x: -29, y: -55, w: 16, h: 47, c: 0x20222f, tag: 'cape', z: -3 },
      { x: 12, y: -57, w: 17, h: 42, c: 0x242633, tag: 'cape', z: -3 },
      { x: -28, y: -13, w: 10, h: 13, c: 0x171923, tag: 'cape', z: -3 },
      { x: -16, y: -17, w: 9, h: 17, c: 0x20222f, tag: 'cape', z: -3 },
      { x: 10, y: -18, w: 10, h: 18, c: 0x20222f, tag: 'cape', z: -3 },
      { x: 21, y: -11, w: 8, h: 11, c: 0x171923, tag: 'cape', z: -3 },

      // Boots, wrapped shins and fitted assassin trousers.
      { x: -18, y: -7, w: 16, h: 7, c: 0x11131c, tag: 'legL' },
      { x: 4, y: -7, w: 17, h: 7, c: 0x11131c, tag: 'legR' },
      { x: -16, y: -25, w: 12, h: 20, c: 0x252735, tag: 'legL' },
      { x: 6, y: -25, w: 12, h: 20, c: 0x2e3040, tag: 'legR' },
      { x: -19, y: -38, w: 17, h: 18, c: 0x20222d, tag: 'legL' },
      { x: 2, y: -38, w: 18, h: 18, c: 0x292b38, tag: 'legR' },

      // Layered jerkin, shoulder mantle and crossed harness.
      { x: -20, y: -69, w: 40, h: 36, c: 'body', tag: 'torso' },
      { x: -16, y: -65, w: 32, h: 27, c: 0x343541, tag: 'torso' },
      { x: -23, y: -71, w: 46, h: 12, c: 'cloth', tag: 'torso' },
      { x: -20, y: -43, w: 40, h: 8, c: 0x171923, tag: 'belt' },
      { x: -5, y: -44, w: 10, h: 10, c: 'leather', tag: 'belt' },
      { x: -25, y: -67, w: 12, h: 31, c: 0x242632, tag: 'armL' },
      { x: 13, y: -67, w: 12, h: 31, c: 0x30323f, tag: 'armR' },
      { x: -27, y: -42, w: 13, h: 10, c: 0x151720, tag: 'armL' },
      { x: 14, y: -42, w: 13, h: 10, c: 0x181a22, tag: 'armR' },

      // Deep hood, warm face slit and layered mask from the concept sheet.
      { x: -20, y: -91, w: 40, h: 28, c: 0x151720, tag: 'head' },
      { x: -16, y: -94, w: 32, h: 14, c: 0x232532, tag: 'head' },
      { x: -12, y: -83, w: 24, h: 16, c: 0xa75f4d, tag: 'head' },
      { x: -14, y: -78, w: 28, h: 14, c: 0x20222c, tag: 'head' },
      { x: -17, y: -69, w: 34, h: 8, c: 0x2e303e, tag: 'head' },

      // Recurve bow: stepped dark limbs around a luminous violet inner stave.
      { x: 31, y: -87, w: 7, h: 59, c: 0x10121b, tag: 'weapon', z: 1 },
      { x: 36, y: -91, w: 8, h: 18, c: 0x171923, tag: 'weapon', z: 1 },
      { x: 36, y: -42, w: 8, h: 18, c: 0x171923, tag: 'weapon', z: 1 },
      { x: 27, y: -64, w: 9, h: 10, c: 'leather', tag: 'weapon', z: 1 },
      { x: 28, y: -82, w: 5, h: 23, c: 0x6f369a, tag: 'weapon', z: 2 },
      { x: 28, y: -55, w: 5, h: 22, c: 0x8d43c0, tag: 'weapon', z: 2 },
    ],
    details: [
      // Crossed harness and silver clasp.
      { x: -17, y: -68, w: 8, h: 8, c: 'leather', tag: 'torso' },
      { x: -11, y: -62, w: 8, h: 8, c: 'leather', tag: 'torso' },
      { x: -5, y: -56, w: 8, h: 8, c: 'leather', tag: 'torso' },
      { x: 3, y: -68, w: 7, h: 8, c: 0x3a2e31, tag: 'torso' },
      { x: -2, y: -62, w: 7, h: 8, c: 0x3a2e31, tag: 'torso' },
      { x: -5, y: -59, w: 10, h: 9, c: 0x8e96aa, tag: 'torso' },
      { x: -2, y: -57, w: 4, h: 5, c: 0xd9dfed, tag: 'torso' },
      // One visible amber eye line under the hood and stitched mask ridges.
      { x: -9, y: -82, w: 7, h: 3, c: 0xf08a68, tag: 'head' },
      { x: 3, y: -82, w: 7, h: 3, c: 0xc95b54, tag: 'head' },
      { x: -10, y: -74, w: 20, h: 2, c: 0x444757, tag: 'head' },
      { x: -8, y: -70, w: 16, h: 2, c: 0x151720, tag: 'head' },
      // Bracers, knee bands, boot buckles and restrained purple piping.
      { x: -26, y: -43, w: 12, h: 3, c: 0x595b6a, tag: 'armL' },
      { x: 15, y: -43, w: 12, h: 3, c: 0x77778a, tag: 'armR' },
      { x: -16, y: -23, w: 12, h: 3, c: 0x633a79, tag: 'legL' },
      { x: 6, y: -23, w: 12, h: 3, c: 0x7e4796, tag: 'legR' },
      { x: -14, y: -6, w: 5, h: 3, c: 0x818596, tag: 'legL' },
      { x: 8, y: -6, w: 5, h: 3, c: 0x818596, tag: 'legR' },
      // Bow edge highlights and grip wraps ride the attack pose.
      { x: 30, y: -83, w: 3, h: 24, c: 0xc06fff, tag: 'weapon' },
      { x: 30, y: -54, w: 3, h: 22, c: 0x9b50dc, tag: 'weapon' },
      { x: 27, y: -61, w: 10, h: 3, c: 0xb7bfd0, tag: 'weapon' },
      { x: 28, y: -58, w: 8, h: 4, c: 0x3c283c, tag: 'weapon' },
    ],
  },

  // ── Golden Knight (hero) — image/character/hero/1.png
  // Baked at 48x68 and rendered 1:1: helm slits, pauldron lames, the kite
  // shield's crest and the sword's fuller all need real pixels to exist.
  knight: {
    w: 48, h: 68,
    signature: 'knight',
    poseAmp: 1.5,
    pal: { body: 0xffc95c, dark: 0xc99433, accent: 0xe8eef7, line: 0x4a3410 },
    parts: [
      // blue cape behind everything
      { x: -16, y: -56, w: 32, h: 44, c: 0x3a63b4, tag: 'cape', z: -1 },
      // sabatons, greaves, poleyn knee cops, cuisses
      { x: -14, y: -6, w: 12, h: 6, c: 'dark', tag: 'legL' },
      { x: 3, y: -6, w: 12, h: 6, c: 'dark', tag: 'legR' },
      { x: -13, y: -20, w: 10, h: 15, c: 0xd8a441, tag: 'legL' },
      { x: 4, y: -20, w: 10, h: 15, c: 0xd8a441, tag: 'legR' },
      { x: -14, y: -24, w: 11, h: 6, c: 'body', tag: 'legL' },
      { x: 4, y: -24, w: 11, h: 6, c: 'body', tag: 'legR' },
      // blue tabard tail under the chainmail skirt
      { x: -8, y: -34, w: 16, h: 18, c: 0x2c4f95, tag: 'torso' },
      // chainmail skirt
      { x: -16, y: -38, w: 32, h: 12, c: 0x8f96a4, tag: 'torso' },
      // leather belt
      { x: -17, y: -42, w: 34, h: 5, c: 0x6b4a19, tag: 'belt' },
      // gold cuirass with a raised centre ridge
      { x: -18, y: -60, w: 36, h: 20, c: 'body', tag: 'torso' },
      { x: -4, y: -60, w: 8, h: 20, c: 0xffe6a0, tag: 'torso' },
      // gorget
      { x: -12, y: -64, w: 24, h: 6, c: 0xd8a441, tag: 'torso' },
      // two-lame pauldrons
      { x: -28, y: -62, w: 13, h: 9, c: 'body', tag: 'armL' },
      { x: -27, y: -54, w: 11, h: 7, c: 0xd8a441, tag: 'armL' },
      { x: 15, y: -62, w: 13, h: 9, c: 'body', tag: 'armR' },
      { x: 16, y: -54, w: 11, h: 7, c: 0xd8a441, tag: 'armR' },
      // upper arms
      { x: -25, y: -50, w: 9, h: 18, c: 0xd8a441, tag: 'armL' },
      { x: 17, y: -50, w: 9, h: 18, c: 0xd8a441, tag: 'armR' },
      // large blue kite shield on the leading arm
      { x: -34, y: -56, w: 16, h: 34, c: 0x2c4f95, tag: 'shield' },
      { x: -32, y: -22, w: 12, h: 7, c: 0x2c4f95, tag: 'shield' },
      // helm: skull, cheek guards, T-slot visor
      { x: -13, y: -80, w: 26, h: 18, c: 'body', tag: 'head' },
      { x: -13, y: -70, w: 6, h: 8, c: 0xd8a441, tag: 'head' },
      { x: 7, y: -70, w: 6, h: 8, c: 0xd8a441, tag: 'head' },
      { x: -2, y: -78, w: 4, h: 14, c: 'line', tag: 'visor' },
      { x: -10, y: -72, w: 20, h: 4, c: 'line', tag: 'visor' },
      // crimson horsehair plume
      { x: -5, y: -90, w: 10, h: 11, c: 0xe0453f, tag: 'plume' },
      { x: -3, y: -94, w: 6, h: 5, c: 0xc0302f, tag: 'plume' },
      // broadsword: blade, crossguard quillons, wrapped grip, pommel
      { x: 26, y: -74, w: 7, h: 46, c: 'accent', tag: 'weapon' },
      { x: 21, y: -30, w: 17, h: 5, c: 'body', tag: 'weapon' },
      { x: 27, y: -25, w: 5, h: 10, c: 0x6b4a19, tag: 'weapon' },
      { x: 26, y: -16, w: 7, h: 5, c: 'body', tag: 'weapon' },
    ],
    details: [
      // cuirass edge highlight and the blue enamel medallion in the centre ridge
      { x: -18, y: -60, w: 36, h: 2, c: 0xfff1b7, tag: 'torso' },
      { x: -5, y: -54, w: 10, h: 10, c: 0x2c4f95, tag: 'torso' },
      { x: -3, y: -52, w: 6, h: 6, c: 0x8fb6ee, tag: 'torso' },
      // gold belt buckle
      { x: -4, y: -42, w: 8, h: 5, c: 0xf1c951, tag: 'belt' },
      // shield rim + boss — tagged so they ride the shield arm
      { x: -34, y: -56, w: 16, h: 3, c: 0xe7c25c, tag: 'shield' },
      { x: -34, y: -56, w: 3, h: 34, c: 0xe7c25c, tag: 'shield' },
      { x: -21, y: -56, w: 3, h: 34, c: 0xe7c25c, tag: 'shield' },
      { x: -34, y: -25, w: 16, h: 3, c: 0xe7c25c, tag: 'shield' },
      // lion rampant crest, tagged to the shield
      { x: -29, y: -48, w: 3, h: 10, c: 0xf1c951, tag: 'shield' },
      { x: -26, y: -50, w: 4, h: 4, c: 0xf1c951, tag: 'shield' },
      { x: -24, y: -46, w: 4, h: 8, c: 0xf1c951, tag: 'shield' },
      { x: -30, y: -42, w: 3, h: 3, c: 0xf1c951, tag: 'shield' },
      { x: -22, y: -38, w: 3, h: 4, c: 0xf1c951, tag: 'shield' },
      // blade fuller and lit edge — ride the sword arm
      { x: 29, y: -72, w: 3, h: 42, c: 0xb9d3ee, tag: 'weapon' },
      { x: 26, y: -72, w: 2, h: 42, c: 0xffffff, tag: 'weapon' },
      { x: 21, y: -30, w: 17, h: 2, c: 0xfff1b7, tag: 'weapon' },
      // helm crown highlight
      { x: -13, y: -80, w: 26, h: 3, c: 0xffe6a0, tag: 'head' },
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

  // Absolute pixel amplitudes read as less motion on a taller body, so heroes
  // opt into a larger swing via `poseAmp`. placePart re-snaps to the grid.
  const amp = unit.poseAmp ?? 1;
  if (amp !== 1) { pose.bob *= amp; pose.lean *= amp; pose.arm *= amp; }
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
  drawSignature(g, unit, ox, oy, pose.alpha);

  // pass 3 — charge glow above the head during windup / on the attack snap
  if (pose.charge > 0) {
    const s = snap(4 + pose.charge * 6);
    g.fillStyle(unit.pal.accent, 0.35 + pose.charge * 0.5);
    g.fillRect(snap(ox - s / 2), snap(oy - unit.h - 12 - s), s, s);
  }

  return { W, H };
}

/**
 * Small, species-specific pixel clusters derived from the supplied sheets.
 *
 * These are drawn *statically* — only `alpha` is applied, not the pose — so this
 * is the right home for surface grain (chainmail, robe shading, cape folds) that
 * sits on the body's least-mobile areas, and for elements that should read as
 * floating rather than welded on. Detail that has to track a swinging arm or
 * weapon belongs in `details`, which runs through `placePart`.
 */
function drawSignature(g, unit, ox, oy, alpha) {
  const signature = unit.signature;
  if (!signature) return;
  const rect = (x, y, w, h, color, a = 1) => { g.fillStyle(color, alpha * a); g.fillRect(snap(ox + x), snap(oy + y), w, h); };
  const line = (x, y, n, dx, dy, color, a = 1) => {
    for (let i = 0; i < n; i++) rect(x + dx * i, y + dy * i, P, P, color, a);
  };
  // Bake-time grain, in frame coordinates. The Bayer matrix is indexed in world
  // block coords, so adjacent calls interlock instead of showing a seam.
  const grain = (x, y, w, h, color, density, a = 1) => dither(g, snap(ox + x), snap(oy + y), w, h, color, density, alpha * a);
  const rampV = (x, y, w, h, color, from, to, power = 1, a = 1) => ditherRampV(g, snap(ox + x), snap(oy + y), w, h, color, from, to, power, alpha * a);
  const fleck = (x, y, w, h, color, count, seed, a = 1) => speckle(g, snap(ox + x), snap(oy + y), w, h, color, count, rng(seed), alpha * a);

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
    case 'nightveilArcher':
      // Hood planes and cloak folds avoid a flat black silhouette.
      line(-16, -91, 6, 3, 2, 0x4b4e60, 0.72);
      line(15, -88, 5, -3, 3, 0x0d0f17, 0.9);
      line(-21, -61, 8, 3, 5, 0x4a4c5e, 0.48);
      line(20, -59, 7, -3, 6, 0x11131c, 0.9);
      line(-12, -51, 7, 2, 5, 0x5a3b62, 0.34);
      // Taut bowstring and a nocked violet arrow, all grid-snapped.
      line(40, -88, 14, -1, 4, 0xb9a7cc, 0.72);
      line(27, -58, 14, 1, 2, 0xb9a7cc, 0.72);
      line(4, -59, 16, 2, 0, 0xb35cf0, 0.94);
      rect(34, -61, 8, 4, 0xe5cfff); rect(7, -62, 5, 2, 0xede8f4);
      // Purple seam light and small metal studs on the harness.
      rect(-18, -68, 3, 20, 0x713a8d, 0.65);
      for (let i = 0; i < 5; i++) rect(-10 + i * 5, -43, 2, 2, i % 2 ? 0xb6bdcf : 0x6d7180);
      // Shadow smoke curls around the boots instead of being baked as a blob.
      line(-25, -4, 7, -3, -2, 0x7d3dae, 0.42);
      line(22, -3, 7, 3, -2, 0x9c55d0, 0.38);
      fleck(-36, -17, 72, 17, 0x8c47bc, 22, 0x4a17, 0.38);
      break;
    case 'lionMonk':
      // Alternating mane locks keep the head from reading as a round helmet.
      for (let i = 0; i < 7; i++) {
        const side = i % 2 ? 1 : -1;
        line(side * (14 + (i % 3) * 2), -83 + i * 5, 4, side * 2, 2,
          i % 2 ? 0xe4a344 : 0xb86b2d, 0.9);
      }
      // Brow, muzzle and tiny fang clusters sharpen the lion expression.
      line(-10, -84, 4, 2, 1, 0x5a2e1d); line(9, -84, 4, -2, 1, 0x5a2e1d);
      rect(-4, -72, 8, 3, 0xf0b86e); rect(-5, -68, 3, 3, 0xf4ddaf); rect(2, -68, 3, 3, 0xf4ddaf);
      // Chest/ab shadows and the gold piping along the stepped red sash.
      rect(-2, -62, 4, 13, 0x9b5a33, 0.55);
      rect(-12, -57, 9, 2, 0xf1b75a, 0.8); rect(-6, -50, 9, 2, 0xf1b75a, 0.8);
      line(-13, -55, 3, 5, 5, 0xe2a14a, 0.85);
      // Cloth folds and bandage seams from the concept art.
      line(-17, -36, 5, 2, 5, 0x171923, 0.8); line(15, -36, 5, -2, 5, 0x3f4250, 0.75);
      for (let i = 0; i < 4; i++) {
        rect(-28, -42 + i * 4, 10, 2, i % 2 ? 0xa69379 : 0xeee0c5);
        rect(18, -42 + i * 4, 10, 2, i % 2 ? 0xa69379 : 0xeee0c5);
      }
      break;
    case 'solarLionBeast':
      // Jagged outer mane locks extend beyond the rectangular construction
      // layers, producing a fiery silhouette even when the aura is hidden.
      for (let i = 0; i < 11; i++) {
        const a = -1.7 + i * 0.3;
        const sx = 27 + Math.cos(a) * 22;
        const sy = -47 + Math.sin(a) * 23;
        line(sx, sy, 4 + (i % 3), Math.cos(a) * 2, Math.sin(a) * 2,
          i % 3 === 0 ? 0xffc04b : (i % 2 ? 0xf0782d : 0x9f3121), 0.92);
      }
      // Ember scales and darker tiger-like flame marks across the flank.
      fleck(-25, -46, 48, 22, 0xffa13a, 34, 0x5101, 0.74);
      line(-18, -44, 5, 2, 3, 0x7d241e, 0.9);
      line(-4, -45, 5, 2, 3, 0x7d241e, 0.85);
      line(10, -43, 4, 2, 3, 0x7d241e, 0.82);
      // Bright spine and chest core make the empowered form look internally lit.
      line(-22, -49, 20, 2, 0, 0xffdf72, 0.72);
      rampV(18, -57, 23, 24, 0xffc04f, 0.56, 0.05, 1.2, 0.72);
      rect(34, -55, 4, 3, 0xffffff, 0.9);
      // Tail sparks and claw glints remain part of every baked animation frame.
      rect(-59, -67, 4, 4, 0xffffff, 0.82);
      rect(-55, -62, 5, 3, 0xffdf72, 0.86);
      rect(44, -5, 7, 2, 0xffffff, 0.9);
      break;
    case 'iceMage':
      // Robe shading: the outer layer deepens toward the hem, and the flare
      // catches a little cold rim light off the floor.
      rampV(-15, -46, 30, 26, 0x456b91, 0, 0.55, 1.5);
      rampV(-18, -22, 36, 14, 0x2f4f6f, 0.1, 0.6, 1.2);
      grain(-18, -14, 36, 4, 0xbfe3f6, 0.35);
      // Frost crust along the mantle collar and hood rim.
      fleck(-13, -60, 26, 6, 0xffffff, 14, 0x51ce, 0.9);
      fleck(-12, -74, 24, 4, 0xe8f8ff, 9, 0x77a1, 0.8);
      // Embroidered snowflake on the inner tabard — six arms plus a bright hub.
      rect(-1, -48, 2, 18, 0x8fd6ef, 0.95);
      rect(-6, -40, 12, 2, 0x8fd6ef, 0.95);
      line(-5, -45, 5, 2, 2, 0x8fd6ef, 0.9);
      line(4, -45, 5, -2, 2, 0x8fd6ef, 0.9);
      rect(-2, -41, 4, 4, 0xffffff);
      rect(-1, -47, 2, 2, 0xe8fbff); rect(-1, -32, 2, 2, 0xe8fbff);
      // Silver hair strands catching the light.
      line(-13, -62, 9, 0, 3, 0xffffff, 0.75);
      line(11, -62, 9, 0, 3, 0xf4fbff, 0.7);
      // Staff crystal: an inner core that reads as lit from within.
      rect(-27, -78, 4, 6, 0xffffff);
      rect(-28, -75, 6, 2, 0xdff7ff, 0.9);
      grain(-31, -82, 12, 13, 0xffffff, 0.28, 0.85);
      // Three ice shards orbiting the mage, faint so they read as floating.
      rect(-36, -68, 4, 4, 0x9ff4ff, 0.5); rect(-35, -67, 2, 2, 0xffffff, 0.6);
      rect(16, -60, 4, 4, 0x9ff4ff, 0.45); rect(17, -59, 2, 2, 0xffffff, 0.55);
      rect(-8, -84, 4, 4, 0x9ff4ff, 0.4); rect(-7, -83, 2, 2, 0xffffff, 0.5);
      break;
    case 'knight':
      // Gold plate: lit across the top of the cuirass, shadowed underneath.
      rampV(-18, -52, 36, 12, 0xb8862c, 0, 0.6, 1.5);
      grain(-18, -60, 36, 4, 0xfff1b7, 0.3);
      // Dithered chainmail, kept clear of the blue tabard running down the middle.
      grain(-16, -38, 8, 12, 0xb0b8c6, 0.5);
      grain(8, -38, 8, 12, 0xb0b8c6, 0.5);
      grain(-16, -38, 8, 12, 0x5b6376, 0.25);
      grain(8, -38, 8, 12, 0x5b6376, 0.25);
      // Cape folds, only where the drape clears the body on either side.
      rampV(-16, -54, 4, 42, 0x1f3d76, 0.2, 0.7, 1.3);
      rampV(12, -54, 4, 42, 0x1f3d76, 0.2, 0.7, 1.3);
      line(-15, -50, 8, 0, 5, 0x5c86d8, 0.6);
      line(13, -50, 8, 0, 5, 0x5c86d8, 0.6);
      // Pauldron lame edges and a scuffed rivet line across the cuirass.
      line(-27, -56, 5, 2, 0, 0xfff1b7, 0.85);
      line(17, -56, 5, 2, 0, 0xfff1b7, 0.85);
      fleck(-16, -50, 32, 8, 0xffe6a0, 12, 0x9a17, 0.7);
      // Visor: a cold glint deep in the T-slot rather than visible eyes.
      rect(-8, -71, 3, 2, 0x9ff4ff, 0.85); rect(5, -71, 3, 2, 0x9ff4ff, 0.85);
      rect(-1, -76, 2, 3, 0x6fd8ee, 0.5);
      // Horsehair plume strands.
      line(-5, -88, 5, 0, 2, 0xf4726a, 0.8);
      line(3, -88, 5, 0, 2, 0x9e2725, 0.8);
      // Greave and sabaton highlights.
      rect(-13, -18, 3, 12, 0xffe6a0, 0.7); rect(10, -18, 3, 12, 0xffe6a0, 0.7);
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
  box('proj_solarBolt', 12, 5, 0xffd05c, 0x8a2d1f);
  box('proj_shadowArrow', 18, 3, 0xd8b8ff, 0x2a1739);

  // soft radial blob used for shadows / glows
  g.clear();
  g.fillStyle(0x000000, 1);
  g.fillEllipse(16, 8, 32, 16);
  g.generateTexture('shadow', 32, 16);

  g.destroy();
}
