/**
 * Tower floors (spec §2.1). Difficulty rises through stat multipliers, extra
 * stronger hero stats, a faster ultimate, and a tighter essence budget
 * relative to the hero's HP. Each hero always brings its complete skill kit.
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
    title: 'Gatehouse Chapel',
    hpMult: 1.0,
    atkMult: 1.0,
    speedMult: 1.0,
    ultRateMult: 1.0,
    essencePool: 96,
    manaBonus: 0,
    manaMaxBonus: 0,
    manaRegenMult: 1.0,
    gridCols: 4,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad'],
    reward: { soft: 120 },
    brief: 'Break the first guardian: surround Shield Bash, escape Whirlwind, and spread out before Judgment.',
  },
  {
    floor: 2,
    heroId: 'iceMage',
    title: 'Frostbound Hall',
    hpMult: 1.45,
    atkMult: 1.2,
    speedMult: 1.05,
    ultRateMult: 1.1,
    essencePool: 128,
    manaBonus: 3,
    manaMaxBonus: 2,
    manaRegenMult: 1.1,
    gridCols: 5,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad', 'flower'],
    reward: { soft: 200 },
    brief: 'Ice magic controls the field — spread out before Nova and sidestep the advancing Lance.',
  },
  {
    floor: 3,
    heroId: 'lionMonk',
    title: 'Sunmane Dojo',
    hpMult: 1.72,
    atkMult: 1.34,
    speedMult: 1.1,
    ultRateMult: 1.2,
    essencePool: 156,
    manaBonus: 6,
    manaMaxBonus: 4,
    manaRegenMult: 1.2,
    gridCols: 5,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad', 'flower', 'bombGoblin', 'skeletonRider'],
    reward: { soft: 300 },
    brief: 'Keep pace with the Lion Monk, avoid Burning Palm, and survive his complete Solar Lion transformation.',
  },
  {
    floor: 4,
    heroId: 'nightveilArcher',
    title: 'Nightveil Gallery',
    hpMult: 2.05,
    atkMult: 1.48,
    speedMult: 1.14,
    ultRateMult: 1.32,
    essencePool: 180,
    manaBonus: 8,
    manaMaxBonus: 5,
    manaRegenMult: 1.25,
    gridCols: 5,
    unlockedMonsters: ['golem', 'brute', 'sprite', 'toad', 'flower', 'bombGoblin', 'skeletonRider', 'wraith'],
    reward: { soft: 420, hard: 1 },
    brief: 'The final hunter controls every lane: break formation against traps, sidestep venom shots, and escape the eclipse.',
  },
];

export const FLOOR_COUNT = FLOORS.length;

export function getFloor(n) {
  return FLOORS[Phaser.Math.Clamp(n - 1, 0, FLOORS.length - 1)];
}
