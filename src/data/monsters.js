/**
 * Monster roster (spec §3.2). Five roles so synergies and counters are all
 * demonstrable in the prototype. Art keys map to PlaceholderArt units.
 *
 * Skill ids are resolved by SkillSystem's executor registry — data here stays
 * declarative so the economy layer (§7) can later patch/replace skill ids to
 * change behaviour rather than just bumping stats.
 */

export const ROLE = {
  TANK: 'tank',
  MELEE: 'melee',
  RANGED: 'ranged',
  CC: 'cc',
  SUPPORT: 'support',
};

export const ROLE_LABEL = {
  [ROLE.TANK]: 'Tank',
  [ROLE.MELEE]: 'Melee DPS',
  [ROLE.RANGED]: 'Ranged DPS',
  [ROLE.CC]: 'CC / Debuff',
  [ROLE.SUPPORT]: 'Support',
};

export const MONSTERS = [
  {
    id: 'golem',
    name: 'Stone Golem',
    short: 'Golem',
    role: ROLE.TANK,
    art: 'golem',
    cost: 4,
    hp: 220,
    atk: 8,
    speed: 42,
    range: 40,
    attackInterval: 1.4,
    hitRadius: 15,
    tint: '#7d8496',
    passive: {
      id: 'stoneSkin',
      name: 'Stone Skin',
      desc: 'Below 40% HP, takes 40% less damage (barrier flares up).',
    },
    active: {
      id: 'provoke',
      name: 'Provoke',
      desc: 'On summon, taunts the hero for 3s — pulls aggro off everyone else.',
      cooldown: 0,
    },
  },

  {
    id: 'brute',
    name: 'Goblin Brute',
    short: 'Brute',
    role: ROLE.MELEE,
    art: 'brute',
    cost: 3,
    hp: 90,
    atk: 16,
    speed: 78,
    range: 34,
    attackInterval: 0.75,
    hitRadius: 12,
    tint: '#b93a3a',
    passive: {
      id: 'frenzyStrike',
      name: 'Frenzy Strike',
      desc: 'Every 4th hit is a guaranteed critical (x2.2).',
    },
    active: {
      id: 'recklessCharge',
      name: 'Reckless Charge',
      desc: 'If the hero holds still 1.5s, dashes in for a heavy impact.',
      cooldown: 7,
    },
  },

  {
    id: 'sprite',
    name: 'Forest Sprite',
    short: 'Sprite',
    role: ROLE.RANGED,
    art: 'sprite',
    cost: 3,
    hp: 60,
    atk: 12,
    speed: 60,
    range: 210,
    attackInterval: 1.0,
    hitRadius: 10,
    tint: '#4fae5a',
    passive: {
      id: 'snipersFocus',
      name: "Sniper's Focus",
      desc: 'Deals +45% damage while standing outside the hero aggro ring.',
    },
    active: {
      id: 'piercingArrow',
      name: 'Piercing Arrow',
      desc: 'With another monster on its horizontal line, fires a piercing shot.',
      cooldown: 5,
    },
  },

  {
    id: 'toad',
    name: 'Swamp Toad',
    short: 'Toad',
    role: ROLE.CC,
    art: 'toad',
    cost: 4,
    hp: 110,
    atk: 7,
    speed: 50,
    range: 150,
    attackInterval: 1.1,
    hitRadius: 14,
    tint: '#8b6bb0',
    passive: {
      id: 'mucus',
      name: 'Mucus',
      desc: 'Hits slow the hero by 30% for 2s.',
    },
    active: {
      id: 'croakOfSilence',
      name: 'Croak of Silence',
      desc: 'Cancels a hero skill while it is still telegraphing.',
      cooldown: 12,
    },
  },

  {
    id: 'flower',
    name: 'Flower Spirit',
    short: 'Spirit',
    role: ROLE.SUPPORT,
    art: 'flower',
    cost: 5,
    hp: 70,
    atk: 5,
    speed: 55,
    range: 120,
    attackInterval: 1.3,
    hitRadius: 10,
    tint: '#f2a0c0',
    passive: {
      id: 'bloom',
      name: 'Bloom',
      desc: 'Heals nearby allies 6 HP every 2s.',
    },
    active: {
      id: 'radiantBloom',
      name: 'Radiant Bloom',
      desc: 'On summon, grants the whole team +25% ATK for 8s.',
      cooldown: 0,
    },
  },
];

export const MONSTER_BY_ID = Object.fromEntries(MONSTERS.map((m) => [m.id, m]));

export const CHEAPEST_COST = Math.min(...MONSTERS.map((m) => m.cost));
