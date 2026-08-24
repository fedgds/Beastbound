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

  hp: 900,
  atk: 22,
  speed: 46,
  hitRadius: 20,

  /** Aggro / attack ring, drawn on the battlefield (spec §2.3, §6). */
  aggroRadius: 150,
  basicRange: 90,
  basicInterval: 1.1,
  /** Short anticipation on the basic attack — readable but not a full telegraph. */
  basicWindup: 0.12,

  /** Ultimate charge (spec §4.1). */
  ultEnergyMax: 100,
  ultEnergyPerSec: 8,
  ultEnergyPerDamage: 0.35,

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
      cooldown: 9,
      priority: 2,
      trigger: { type: 'crowd', radius: 130, count: 3 },
      telegraph: {
        kind: TELEGRAPH_KIND.DAMAGE,
        shape: 'circle',
        radius: 150,
        duration: 0.45,
        label: 'WHIRLWIND',
      },
      effect: { type: 'circleDamage', radius: 150, mult: 1.7, knockback: 30 },
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
      effect: { type: 'selfBuff', healPct: 0.15, atkMult: 1.3, duration: 999 },
      recover: 0.35,
    },
  ],

  ultimate: {
    id: 'judgment',
    name: 'Judgment',
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

export const HEROES = { goldenKnight: GOLDEN_KNIGHT };
