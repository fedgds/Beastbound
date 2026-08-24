/**
 * Tower floors (spec §2.1). Difficulty rises through stat multipliers, extra
 * hero skills (gated by `minFloor` in data/heroes.js), a faster ultimate, and
 * a tighter essence budget relative to the hero's HP.
 *
 * `gridCols` is retained for save/config compatibility; deployment is free
 * placement across the complete battlefield on every floor.
 * `essencePool` is the finite mana budget that makes the §2.3 defeat condition
 * actually reachable — see the plan's design note.
 */

export const FLOORS = [
  {
    floor: 1,
    heroId: 'goldenKnight',
    title: 'Gatehouse',
    hpMult: 1.0,
    atkMult: 1.0,
    speedMult: 1.0,
    ultRateMult: 1.0,
    essencePool: 60,
    manaRegenMult: 1.0,
    gridCols: 4,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad'],
    reward: { soft: 120 },
    brief: 'Basic attacks + Shield Bash. Watch the red wind-up.',
  },
  {
    floor: 2,
    heroId: 'goldenKnight',
    title: 'Hall of Banners',
    hpMult: 1.35,
    atkMult: 1.2,
    speedMult: 1.05,
    ultRateMult: 1.1,
    essencePool: 72,
    manaRegenMult: 1.05,
    gridCols: 5,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad', 'flower'],
    reward: { soft: 200 },
    brief: 'Adds Whirlwind — punishes 3+ monsters clustered together.',
  },
  {
    floor: 3,
    heroId: 'goldenKnight',
    title: 'Solar Spire',
    hpMult: 1.8,
    atkMult: 1.45,
    speedMult: 1.1,
    ultRateMult: 1.3,
    essencePool: 88,
    manaRegenMult: 1.1,
    gridCols: 5,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad', 'flower'],
    reward: { soft: 350, hard: 1 },
    brief: 'Adds Call of Valor at 50% HP, and charges Judgment far faster.',
  },
];

export const FLOOR_COUNT = FLOORS.length;

export function getFloor(n) {
  return FLOORS[Phaser.Math.Clamp(n - 1, 0, FLOORS.length - 1)];
}
