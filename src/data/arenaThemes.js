/**
 * Arena themes — one dressing per tower floor.
 *
 * The tower is the player's: every floor should look like a different room of
 * the same building, so a returning player knows where they are before reading
 * the floor badge. Themes only carry *look*, never gameplay values.
 *
 * Palette slots (all stone is quantised into 4 values so it dithers cleanly).
 * These are *fully lit* values: ArenaScenery multiplies every stamped tile by a
 * per-cell light tint, so anything authored as "already dark" ends up black once
 * the torchlight falls off. Author the brightest the stone ever gets.
 *   stone3  brightest slab face / lit capstone
 *   stone2  base slab face
 *   stone1  shaded slab face / worn patches
 *   grout   mortar gaps, carved lines, cracks
 *   wallHi  wall capstone highlight
 *   wall    wall brick face
 *   wallLo  wall brick shadow + the lip it casts on the floor
 *   metal   sconce iron / grate / chain
 *   accent  the floor's own colour signature (banners, veins, moss)
 *   flame   torch flame core; the light pool is tinted from `light`
 *   light   torch light pool tint
 *   seal    the carved arcane seal in the middle of the room
 */

export const ARENA_THEMES = {
  /** Floor 1 — cold, damp granite gatehouse. Iron and moss. */
  gatehouse: {
    id: 'gatehouse',
    stone3: 0x474063,
    stone2: 0x393353,
    stone1: 0x2c2742,
    grout: 0x181426,
    wallHi: 0x5d5480,
    wall: 0x413962,
    wallLo: 0x241f38,
    metal: 0x6b6484,
    accent: 0x2a4a3a, // moss, kept dark and desaturated so it never reads as a pickup
    flame: 0xffb347,
    light: 0xff9a3c,
    seal: 0x39d4a0,
    /** Decor mix used when stamping the room. */
    decor: { moss: 6, rubble: 12, crack: 16, stain: 10, grate: 2, chain: 3 },
    banners: null,
    shafts: 0,
  },

  /** Floor 2 — the hall where the tower hangs its colours. Crimson and brass. */
  banners: {
    id: 'banners',
    stone3: 0x50435c,
    stone2: 0x413650,
    stone1: 0x322940,
    grout: 0x1e1626,
    wallHi: 0x6d5a7d,
    wall: 0x4e4062,
    wallLo: 0x2b2238,
    metal: 0x9a7844, // brass
    accent: 0xa32639, // crimson cloth
    flame: 0xffc766,
    light: 0xffa64d,
    seal: 0x39d4a0,
    decor: { moss: 3, rubble: 10, crack: 12, stain: 14, grate: 1, chain: 6 },
    banners: { count: 4, cloth: 0xa32639, trim: 0xd9a544 },
    shafts: 0,
  },

  /** Floor 3 — the knight's own chapel. Pale marble, gold veins, sun shafts. */
  spire: {
    id: 'spire',
    stone3: 0x615574,
    stone2: 0x524766,
    stone1: 0x3f3654,
    grout: 0x251e36,
    wallHi: 0x82739e,
    wall: 0x5f5280,
    wallLo: 0x342a4a,
    metal: 0xc9a227, // gold
    accent: 0xffd98a, // gold veining
    flame: 0xfff0b8,
    light: 0xffe08a,
    seal: 0x39d4a0,
    decor: { moss: 0, rubble: 6, crack: 8, stain: 4, grate: 1, chain: 2 },
    banners: { count: 2, cloth: 0x2f5fb0, trim: 0xd9a544 },
    /** Number of angled light shafts falling across the floor. */
    shafts: 5,
  },

  /** Floor 4 — an obsidian hunting gallery lit by violet witchfire. */
  nightveil: {
    id: 'nightveil',
    stone3: 0x4c405f,
    stone2: 0x392e4d,
    stone1: 0x281f3a,
    grout: 0x120d1d,
    wallHi: 0x69547f,
    wall: 0x463557,
    wallLo: 0x21182f,
    metal: 0x716985,
    accent: 0x8e43bd,
    flame: 0xd18cff,
    light: 0x9f58d2,
    seal: 0x9a55ce,
    decor: { moss: 1, rubble: 8, crack: 18, stain: 16, grate: 3, chain: 7 },
    banners: { count: 3, cloth: 0x251a36, trim: 0x9452bd },
    shafts: 2,
  },
};

/** floor number -> theme. Extra floors reuse the final gallery. */
const BY_FLOOR = ['gatehouse', 'banners', 'spire', 'nightveil'];

export function themeForFloor(floor) {
  const key = BY_FLOOR[Math.min(Math.max(floor, 1), BY_FLOOR.length) - 1];
  return ARENA_THEMES[key];
}
