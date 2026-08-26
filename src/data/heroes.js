/**
 * Hero definitions (spec §4).
 *
 * Every powerful skill carries a `telegraph` block — that is the contract the
 * TelegraphSystem renders and the player reads. `kind` maps to the colour
 * language in §5: damage=red, buff=yellow, control=purple.
 *
 * A hero always brings every skill in its definition whenever it appears.
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
  // Every hero should be able to close, reposition and strike ahead of the
  // quickest regular monster (94 move speed / 0.75s attack interval).
  speed: 112,
  hitRadius: 20,
  visualScale: 1,
  shadowScale: 1.45,
  combat: { crit: 0.12, dodge: 0.06, block: 0.18 },

  /** Aggro / attack ring, drawn on the battlefield (spec §2.3, §6). */
  aggroRadius: 150,
  basicRange: 90,
  basicInterval: 0.62,
  /** Short anticipation on the basic attack — readable but not a full telegraph. */
  basicWindup: 0.12,

  /** A move is rolled after each of these quiet intervals. */
  skillInterval: { min: 3.4, max: 5.8 },
  specialChance: 0.14,

  skills: [
    {
      id: 'shieldBash',
      name: 'Shield Bash',
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
      effect: {
        type: 'coneDamage', radius: 130, arc: 75, mult: 1.3, knockback: 46,
        // A broad crest sweeps across the complete warned cone before its
        // afterimages burn away, so the projectile matches its hit area.
        waveTravel: 0.42, waveLife: 0.9, crestScale: 1.65,
      },
      recover: 0.45,
    },
    {
      id: 'whirlwind',
      name: 'Whirlwind',
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
        fxTail: 0.82,
      },
      recover: 0.6,
    },
    {
      id: 'valor',
      name: 'Call of Valor',
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
        auraIntro: 0.95,
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
    effect: {
      type: 'circleDamageAt', radius: 200, mult: 1.12, knockback: 70,
      waves: 3, waveInterval: 0.36, firstWaveDelay: 0.12, fxLife: 1.95,
    },
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
  speed: 106,
  hitRadius: 18,
  visualScale: 1,
  shadowScale: 1.4,
  combat: { crit: 0.1, dodge: 0.1, block: 0.12 },
  aggroRadius: 210,
  basicRange: 290,
  basicInterval: 0.64,
  basicWindup: 0.18,
  basicProjectile: { texture: 'proj_iceShard', speed: 560, slowMult: 0.82, slowSeconds: 1.15 },
  skillInterval: { min: 3.7, max: 5.4 },
  specialChance: 0.2,
  skills: [
    {
      id: 'iceWall', name: 'Ice Wall', cooldown: 10, priority: 1,
      telegraph: { kind: TELEGRAPH_KIND.BUFF, shape: 'ring', radius: 74, duration: 0.42, label: 'ICE WALL' },
      /**
       * A real barricade, not just a number on the Mage: a jagged ring rises
       * around it, chills anything that stands next to the crystals, cracks as
       * the shield is spent, and shatters when it breaks or times out.
       * `shield`/`duration` still drive Entity.takeDamage's absorb.
       */
      effect: {
        type: 'iceWall',
        shield: 165,
        duration: 4.5,
        segments: 24,
        ringRadius: 68,
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
      id: 'frostNova', name: 'Frost Nova', cooldown: 7, priority: 2,
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
        life: 0.85,
      },
      recover: 0.4,
    },
    {
      id: 'glacialLance', name: 'Glacial Lance', cooldown: 8, priority: 2,
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
        grow: 0.48,
        life: 1.1,
      },
      recover: 0.45,
    },
  ],
  ultimate: {
    id: 'blizzard', name: 'Blizzard', cooldown: 12, priority: 8,
    telegraph: { kind: TELEGRAPH_KIND.DAMAGE, shape: 'circle', radius: 118, duration: 0.65, label: 'BLIZZARD ×5', heavy: true },
    effect: { type: 'blizzard', storms: 5, radius: 96, duration: 4.4, tick: 0.55, tickMult: 0.34, slowMult: 0.64, slowSeconds: 0.8 },
    recover: 0.65,
  },
};

export const LION_MONK = {
  id: 'lionMonk',
  name: 'Lion Monk',
  art: 'lionMonk',
  basicName: 'Sun Fist',
  hp: 1380,
  atk: 21,
  speed: 116,
  hitRadius: 19,
  visualScale: 1,
  shadowScale: 1.42,
  combat: { crit: 0.16, dodge: 0.2, block: 0.08 },
  aggroRadius: 190,
  basicRange: 86,
  basicInterval: 0.58,
  basicWindup: 0.1,
  skillInterval: { min: 3.1, max: 4.9 },
  specialChance: 0.2,
  skills: [
    {
      id: 'felineAgility',
      name: 'Feline Agility',
      cooldown: 8,
      priority: 1,
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE,
        shape: 'circle',
        radius: 195,
        duration: 0.38,
        label: 'TRIPLE POUNCE',
      },
      effect: {
        type: 'felineDash',
        jumps: 3,
        jumpInterval: 0.2,
        damageMult: 0.56,
        knockback: 16,
        trailLife: 0.58,
      },
      recover: 0.62,
    },
    {
      id: 'burningPalm',
      name: 'Burning Palm',
      cooldown: 7,
      priority: 2,
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE,
        shape: 'cone',
        radius: 220,
        arc: 38,
        duration: 0.48,
        label: 'BURNING PALM',
      },
      effect: {
        type: 'burningPalm',
        radius: 220,
        arc: 38,
        mult: 1.45,
        knockback: 24,
        burnSeconds: 3.2,
        burnEvery: 0.5,
        burnTickMult: 0.18,
        // The paw leaves the hand small, then blooms to the full cone width.
        fxLife: 0.78,
        startScale: 0.58,
        endScale: 2.25,
      },
      recover: 0.42,
    },
    {
      id: 'solarRoar',
      name: 'Solar Roar',
      cooldown: 10,
      priority: 3,
      trigger: { type: 'crowd', radius: 185, count: 2 },
      telegraph: {
        kind: TELEGRAPH_KIND.CONTROL,
        shape: 'ring',
        radius: 185,
        duration: 0.66,
        label: 'SOLAR ROAR',
        atSelf: true,
      },
      effect: {
        type: 'solarRoar',
        radius: 185,
        mult: 0.95,
        knockback: 56,
        stunSeconds: 0.75,
        slowMult: 0.62,
        slowSeconds: 2.1,
        fxLife: 1.05,
      },
      recover: 0.38,
    },
  ],
  ultimate: {
    id: 'solarLionFury',
    name: 'Solar Lion Fury',
    cooldown: 18,
    priority: 10,
    telegraph: {
      kind: TELEGRAPH_KIND.BUFF,
      shape: 'ring',
      radius: 126,
      duration: 0.58,
      label: 'SOLAR LION FURY',
      heavy: true,
      atSelf: true,
    },
    effect: {
      type: 'solarLionFury',
      transformDuration: 1.15,
      duration: 7,
      atkMult: 1.7,
      moveSpeedMult: 1.45,
      attackSpeedMult: 1.8,
      rangeMult: 1.55,
      boltMult: 0.5,
      finisherWindup: 0.58,
      finisherRadius: 195,
      finisherArc: 58,
      finisherMult: 3.2,
      finisherKnockback: 88,
    },
    recover: 0.5,
  },
};

export const NIGHTVEIL_ARCHER = {
  id: 'nightveilArcher',
  name: 'Nightveil Archer',
  art: 'nightveilArcher',
  basicName: 'Dusk Arrow',
  hp: 1320,
  atk: 20,
  speed: 110,
  hitRadius: 18,
  visualScale: 1,
  shadowScale: 1.4,
  combat: { crit: 0.22, dodge: 0.18, block: 0.05 },
  aggroRadius: 230,
  basicRange: 310,
  basicInterval: 0.6,
  basicWindup: 0.16,
  basicProjectile: {
    texture: 'proj_shadowArrow', speed: 650,
    tint: 0xd8b8ff, trailColor: 0x8d4dcc, hitColor: 0xb86cff,
    burstColor: 0x9d5bd2, burstKind: 'arcane', trailLength: 25,
  },
  skillInterval: { min: 3.2, max: 4.8 },
  specialChance: 0.2,
  skills: [
    {
      id: 'shadowstep', name: 'Shadowstep Volley', cooldown: 6, priority: 1,
      telegraph: {
        kind: TELEGRAPH_KIND.CONTROL, shape: 'cone', radius: 180, arc: 24,
        duration: 0.34, label: 'SHADOWSTEP',
      },
      effect: {
        type: 'shadowstep', distance: 155, duration: 0.3,
        volley: 3, mult: 0.72, dodgeBonus: 0.42, dodgeSeconds: 0.8,
      },
      recover: 0.22,
    },
    {
      id: 'venomFang', name: 'Venom Fang', cooldown: 7, priority: 2,
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE, shape: 'cone', radius: 330, arc: 54,
        duration: 0.5, label: 'VENOM FANG', aimAtCluster: true,
      },
      effect: {
        type: 'venomArrow', radius: 330, arc: 54,
        arrows: 10, arrowInterval: 0.09, arrowMult: 0.18,
        arrowLife: 0.52, arrowSpread: 50,
        poisonSeconds: 4, poisonEvery: 0.55, poisonTickMult: 0.16,
        slowMult: 0.72, slowSeconds: 1.6,
      },
      recover: 0.72,
    },
    {
      id: 'umbralTrap', name: 'Umbral Trap', cooldown: 9, priority: 3,
      trigger: { type: 'crowd', radius: 220, count: 2 },
      telegraph: {
        kind: TELEGRAPH_KIND.CONTROL, shape: 'circle', radius: 105,
        duration: 0.55, label: 'UMBRAL TRAP', atTarget: true,
      },
      effect: {
        type: 'umbralTrap', radius: 105, mult: 1.05,
        rootSeconds: 1.15, slowMult: 0.48, slowSeconds: 2.4, life: 2.8,
      },
      recover: 0.4,
    },
  ],
  ultimate: {
    id: 'eclipseBarrage', name: 'Eclipse Barrage', cooldown: 15, priority: 10,
    telegraph: {
      kind: TELEGRAPH_KIND.DAMAGE, shape: 'circle', radius: 205,
      duration: 0.7, label: 'ECLIPSE BARRAGE', atTarget: true, heavy: true,
    },
    effect: {
      type: 'eclipseBarrage', radius: 205, waves: 6, interval: 0.28,
      tickMult: 0.52, finalMult: 1.3, slowMult: 0.65, slowSeconds: 0.7,
      duration: 2.3,
    },
    recover: 0.62,
  },
};

export const HEROES = {
  goldenKnight: GOLDEN_KNIGHT,
  iceMage: ICE_MAGE,
  lionMonk: LION_MONK,
  nightveilArcher: NIGHTVEIL_ARCHER,
};
