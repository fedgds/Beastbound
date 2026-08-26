/**
 * Ascent-mode floor track — the mirror of data/floors.js.
 *
 * In defence mode a floor describes the boss you must break and the essence you
 * get to break it with. Here it describes the garrison *you* must break: which
 * monsters pour in, in what order, and how hard they hit.
 *
 * The shape is deliberately compatible with data/floors.js (`floor`, `title`,
 * `brief`, `hpMult`/`atkMult`/`speedMult`, `reward`) so TowerSystem, the floor
 * plaque and the pips all work against either track unchanged.
 *
 * `hpMult` / `atkMult` / `speedMult` scale the *player's* hero, exactly as they
 * scale the boss in defence mode. `monsterHpMult` / `monsterAtkMult` scale the
 * opposition, which is the knob that actually carries the difficulty curve — the
 * hero's kit stays constant so a floor is won by playing better, not by arriving
 * with bigger numbers.
 */

export const ASCENT_FLOORS = [
  {
    floor: 1,
    title: 'Gatehouse Chapel',
    brief: 'The garrison is still waking up. Clear the gate before word travels.',
    hpMult: 1.15,
    atkMult: 1.8,
    speedMult: 1,
    ultRateMult: 1,
    monsterHpMult: 0.9,
    monsterAtkMult: 1,
    /** Fraction of max HP restored when the floor is cleared. */
    healOnClear: 0.4,
    reward: { soft: 120 },
    waves: [
      { spawns: ['brute', 'brute', 'sprite'] },
      { spawns: ['golem', 'brute', 'sprite', 'sprite'] },
      { spawns: ['golem', 'brute', 'brute', 'toad'], elite: 'brute' },
    ],
  },

  {
    floor: 2,
    title: 'Frostbound Hall',
    brief: 'Ranged fire from the balconies. Close the distance or die at it.',
    hpMult: 1.15,
    atkMult: 1.8,
    speedMult: 1,
    ultRateMult: 1,
    monsterHpMult: 1,
    monsterAtkMult: 1.1,
    healOnClear: 0.4,
    reward: { soft: 180 },
    waves: [
      { spawns: ['sprite', 'sprite', 'brute', 'toad'] },
      { spawns: ['golem', 'sprite', 'sprite', 'flower', 'brute'] },
      { spawns: ['golem', 'skeletonRider', 'sprite', 'toad', 'flower'], elite: 'skeletonRider' },
    ],
  },

  {
    floor: 3,
    title: 'Sunmane Dojo',
    brief: 'Bombers behind a wall of stone. Nothing here waits its turn.',
    hpMult: 1.15,
    atkMult: 1.8,
    speedMult: 1,
    ultRateMult: 1,
    monsterHpMult: 1.15,
    monsterAtkMult: 1.25,
    healOnClear: 0.45,
    reward: { soft: 240 },
    waves: [
      { spawns: ['skeletonRider', 'brute', 'bombGoblin', 'sprite'] },
      { spawns: ['golem', 'golem', 'bombGoblin', 'flower', 'sprite'] },
      { spawns: ['skeletonRider', 'skeletonRider', 'brute', 'toad', 'sprite'] },
      { spawns: ['golem', 'bombGoblin', 'bombGoblin', 'flower', 'brute'], elite: 'bombGoblin' },
    ],
  },

  {
    floor: 4,
    title: 'Nightveil Gallery',
    brief: 'The whole tower is awake and it is all in this room.',
    hpMult: 1.15,
    atkMult: 1.8,
    speedMult: 1,
    ultRateMult: 1,
    monsterHpMult: 1.3,
    monsterAtkMult: 1.4,
    healOnClear: 0.5,
    reward: { soft: 320, hard: 3 },
    waves: [
      { spawns: ['wraith', 'wraith', 'skeletonRider', 'brute'] },
      { spawns: ['golem', 'wraith', 'bombGoblin', 'sprite', 'flower'] },
      { spawns: ['skeletonRider', 'skeletonRider', 'wraith', 'toad', 'bombGoblin'] },
      {
        spawns: ['golem', 'golem', 'wraith', 'skeletonRider', 'bombGoblin', 'flower'],
        elite: 'wraith',
      },
    ],
  },
];

export const ASCENT_FLOOR_COUNT = ASCENT_FLOORS.length;

export function getAscentFloor(n) {
  return ASCENT_FLOORS[Math.min(Math.max(1, n), ASCENT_FLOOR_COUNT) - 1];
}

/** Total bodies on a floor, elites included — used by the intro banner. */
export function ascentFloorSize(cfg) {
  return cfg.waves.reduce((sum, w) => sum + w.spawns.length + (w.elite ? 1 : 0), 0);
}
