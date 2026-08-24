/**
 * Global tuning + layout constants.
 * Everything positional lives here so the arena can be re-laid-out (or made
 * responsive later) without hunting through gameplay code.
 */

export const GAME_W = 1152;
export const GAME_H = 672;

/**
 * Height of the HTML bars that sit over the canvas. `styles/ui.css` must use the
 * same two numbers — the wall band tucks under `HUD.top` and the foreground lip
 * meets `HUD.bottom`, so a mismatch shows up as a seam.
 */
export const HUD = { top: 84, bottom: 136 };

/** Back wall band drawn above the floor. Purely scenery — nothing walks here. */
export const WALL = { y: HUD.top, h: 116 };
WALL.bottom = WALL.y + WALL.h; // 200

/** The battlefield rect: 20 x 8 slabs, exactly. */
export const ARENA = { x: 16, y: WALL.bottom, w: 1120, h: 336 };
ARENA.right = ARENA.x + ARENA.w;
ARENA.bottom = ARENA.y + ARENA.h; // 536 = GAME_H - HUD.bottom
ARENA.cx = ARENA.x + ARENA.w / 2;
ARENA.cy = ARENA.y + ARENA.h / 2;

/** Central home area the hero patrols while idle. It can still chase anywhere
 * in the arena (see Hero.moveBounds()). */
export const HERO_ZONE = { x: ARENA.cx - 144, w: 288 };

/** Size of one floor slab, in px. Divides ARENA exactly: 20 cols x 8 rows. */
export const TILE = { w: 56, h: 42 };

export const COLORS = {
  // arena
  floorDark: 0x171423,
  floorLight: 0x1e1b2e,
  wall: 0x2c2740,
  gridLine: 0x3a3457,
  gridOk: 0x39d4a0,
  gridHover: 0x7cf2c6,
  gridLocked: 0x5a4a6e,
  gridDanger: 0xff4d5e,

  // telegraph language (spec §5)
  tgDamage: 0xff3b4e, // red    -> powerful AoE incoming
  tgBuff: 0xffd23f, // yellow -> self-buff / heal incoming
  tgControl: 0xa855f7, // purple -> CC / control incoming

  aggro: 0xff6b81,
  heroBody: 0xffc95c,
  white: 0xffffff,

  dmgPhysical: 0xffe9a8,
  dmgCrit: 0xff7a3d,
  dmgPoison: 0x8ee36b,
  heal: 0x6bffb3,
  shield: 0x5fe3ff,
};

/** Render order. */
export const DEPTH = {
  floor: 0,
  floorDecal: 2, // scorch marks, blood, footprints burned into the stone
  gridBase: 5,
  gridMark: 6,
  aggro: 10,
  telegraphGround: 12,
  ghost: 18,
  shadow: 19,
  unit: 20,
  unitFx: 26,
  projectile: 30,
  telegraphAir: 34,
  hpbar: 40,
  wallFront: 44, // the wall's cast shadow + foreground lip
  light: 46, // additive torch pools and light shafts
  popup: 50,
  vignette: 60,
};

/** Damage / status tuning shared by several systems. */
export const COMBAT = {
  critMultiplier: 2.2,
  hitstopMs: 60,
  hitFlashMs: 70,
  slowFloor: 0.25, // slows can never take speed below 25%
};

export const MANA = {
  start: 6,
  max: 12,
  regenPerSec: 1.0,
};

/** Frame durations for the placeholder animations (spec §5: 4-8 frames). */
export const ANIM = {
  idleFps: 5,
  moveFps: 9,
  windupFps: 12,
  attackFps: 14,
  hitFps: 14,
  dieFps: 9,
};

export const TELEGRAPH_KIND = {
  DAMAGE: 'damage',
  BUFF: 'buff',
  CONTROL: 'control',
};

export function telegraphColor(kind) {
  if (kind === TELEGRAPH_KIND.BUFF) return COLORS.tgBuff;
  if (kind === TELEGRAPH_KIND.CONTROL) return COLORS.tgControl;
  return COLORS.tgDamage;
}
