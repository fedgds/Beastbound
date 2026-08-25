/**
 * Hero definitions (spec §4).
 *
 * Every powerful skill carries a `telegraph` block — that is the contract the
 * TelegraphSystem renders and the player reads. `kind` maps to the colour
 * language in §5: damage=red, buff=yellow, control=purple.
 *
 * `minFloor` gates a skill so the Knight gains one new pattern per floor.
 */

import { TELEGRAPH_KIND } from '../config.js';

export const HERO_STATE = {
  IDLE: 'idle',
  APPROACH: 'approach',
  BASIC: 'basic',
  TELEGRAPH: 'telegraph',
  CAST: 'cast',
  RECOVER: 'recover',
};

export const GOLDEN_KNIGHT = {
  id: 'goldenKnight',
  name: 'Golden Knight',
  art: 'knight',
  basicName: 'Slash',

  // The player can field a crowd now, so the Knight needs time to answer it
  // with telegraphed AoE rather than disappearing during the opening rush.
  hp: 1500,
  atk: 22,
  speed: 46,
  hitRadius: 20,
  visualScale: 1,
  shadowScale: 1.45,
  combat: { crit: 0.12, dodge: 0.06, block: 0.18 },

  /** Aggro / attack ring, drawn on the battlefield (spec §2.3, §6). */
  aggroRadius: 150,
  basicRange: 90,
  basicInterval: 1.1,
  /** Short anticipation on the basic attack — readable but not a full telegraph. */
  basicWindup: 0.12,

  /** A move is rolled after each of these quiet intervals. */
  skillInterval: { min: 3.4, max: 5.8 },
  specialChance: 0.14,

  skills: [
    {
      id: 'shieldBash',
      name: 'Shield Bash',
      minFloor: 1,
      cooldown: 6,
      priority: 1,
      trigger: { type: 'nearbyFor', radius: 110, seconds: 0.6 },
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE,
        shape: 'cone',
        radius: 130,
        arc: 75,
        duration: 0.4,
        label: 'SHIELD BASH',
      },
      effect: { type: 'coneDamage', radius: 130, arc: 75, mult: 1.3, knockback: 46 },
      recover: 0.45,
    },
    {
      id: 'whirlwind',
      name: 'Whirlwind',
      minFloor: 2,
      // Longer than the old instant hit: the vacuum drags the crowd in before
      // the last beat throws it, so it catches more and deserves the extra cd.
      cooldown: 10,
      priority: 2,
      trigger: { type: 'crowd', radius: 130, count: 3 },
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE,
        shape: 'circle',
        radius: 150,
        duration: 0.45,
        label: 'WHIRLWIND',
      },
      /**
       * Three revolutions instead of one snapshot. Radius steps outward per
       * beat; beats 1-2 pull inward (negative knockback), beat 3 blasts out.
       */
      effect: {
        type: 'spinAttack',
        radius: 150,
        mult: 0.62,
        ticks: 3,
        interval: 0.34,
        steps: [0.72, 0.86, 1],
        pull: -26,
        knockback: 54,
        spinEvery: 0.09,
      },
      recover: 0.6,
    },
    {
      id: 'valor',
      name: 'Call of Valor',
      minFloor: 3,
      cooldown: 999,
      once: true,
      priority: 3,
      trigger: { type: 'hpBelow', pct: 0.5 },
      telegraph: {
        kind: TELEGRAPH_KIND.BUFF,
        shape: 'ring',
        radius: 90,
        duration: 0.4,
        label: 'CALL OF VALOR',
      },
      /** Lasts the fight, so it earns a sustained aura rather than one ring. */
      effect: {
        type: 'selfBuff',
        healPct: 0.15,
        atkMult: 1.3,
        duration: 999,
        aura: 'valor',
        regenPct: 0.02,
        regenEvery: 2,
      },
      recover: 0.35,
    },
  ],

  ultimate: {
    id: 'judgment',
    name: 'Judgment',
    cooldown: 16,
    priority: 10,
    /** Targets the densest monster cluster so it punishes bunching up. */
    telegraph: {
      kind: TELEGRAPH_KIND.DAMAGE,
      shape: 'circle',
      radius: 200,
      duration: 0.5,
      label: 'JUDGMENT',
      atTarget: true,
      heavy: true,
    },
    effect: { type: 'circleDamageAt', radius: 200, mult: 3.0, knockback: 70 },
    recover: 0.8,
  },
};

export const ICE_MAGE = {
  id: 'iceMage',
  name: 'Ice Mage',
  art: 'iceMage',
  basicName: 'Ice Shard',
  hp: 1550,
  atk: 18,
  speed: 38,
  hitRadius: 18,
  visualScale: 1,
  shadowScale: 1.4,
  combat: { crit: 0.1, dodge: 0.1, block: 0.12 },
  aggroRadius: 210,
  basicRange: 290,
  basicInterval: 0.82,
  basicWindup: 0.18,
  basicProjectile: { texture: 'proj_iceShard', speed: 560, slowMult: 0.82, slowSeconds: 1.15 },
  skillInterval: { min: 3.7, max: 5.4 },
  specialChance: 0.2,
  skills: [
    {
      id: 'iceWall', name: 'Ice Wall', minFloor: 1, cooldown: 10, priority: 1,
      telegraph: { kind: TELEGRAPH_KIND.BUFF, shape: 'ring', radius: 74, duration: 0.42, label: 'ICE WALL' },
      /**
       * A real barricade, not just a number on the Mage: three pillars raise
       * between it and the nearest cluster, chill anything that stands next to
       * them, crack as the shield is spent, and shatter when it breaks or times
       * out. `shield`/`duration` still drive Entity.takeDamage's absorb.
       */
      effect: {
        type: 'iceWall',
        shield: 165,
        duration: 4.5,
        segments: 3,
        chillRadius: 46,
        chillMult: 0.22,
        chillEvery: 0.7,
        slowMult: 0.6,
        slowSeconds: 1.1,
        shatterMult: 0.9,
        shatterRadius: 84,
      },
      recover: 0.35,
    },
    {
      id: 'frostNova', name: 'Frost Nova', minFloor: 1, cooldown: 7, priority: 2,
      /** Punishes melee closing in — the Mage wants to kite at basicRange 290. */
      trigger: { type: 'nearbyFor', radius: 130, seconds: 0.5 },
      telegraph: { kind: TELEGRAPH_KIND.CONTROL, shape: 'circle', radius: 120, duration: 0.42, label: 'FROST NOVA' },
      effect: {
        type: 'frostNova',
        radius: 120,
        mult: 1.05,
        slowMult: 0.45,
        slowSeconds: 2.2,
        stunSeconds: 0.5,
        knockback: 18,
        grow: 0.5,
      },
      recover: 0.4,
    },
    {
      id: 'glacialLance', name: 'Glacial Lance', minFloor: 1, cooldown: 8, priority: 2,
      /** A long directional threat the player can sidestep — aimed at the pack. */
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE, shape: 'cone', radius: 300, arc: 20,
        duration: 0.5, label: 'GLACIAL LANCE', aimAtCluster: true,
      },
      effect: {
        type: 'lanceBeam',
        radius: 300,
        arc: 20,
        mult: 1.5,
        slowMult: 0.55,
        slowSeconds: 1.4,
        knockback: 22,
        grow: 0.25,
        life: 0.5,
      },
      recover: 0.45,
    },
  ],
  ultimate: {
    id: 'blizzard', name: 'Blizzard', cooldown: 12, priority: 8,
    telegraph: { kind: TELEGRAPH_KIND.DAMAGE, shape: 'circle', radius: 118, duration: 0.65, label: 'BLIZZARD ×3', heavy: true },
    effect: { type: 'blizzard', storms: 3, radius: 96, duration: 4.4, tick: 0.55, tickMult: 0.34, slowMult: 0.64, slowSeconds: 0.8 },
    recover: 0.65,
  },
};

export const HEROES = { goldenKnight: GOLDEN_KNIGHT, iceMage: ICE_MAGE };
