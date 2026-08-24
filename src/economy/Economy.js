/**
 * Economy — architecture stub for spec §7.
 *
 * Not wired into any UI yet, deliberately: the prototype's job is the combat
 * loop. What matters now is that the shapes exist so upgrades, equipment and
 * gacha can be layered on without touching gameplay code.
 *
 * The important design constraint from §7: equipment must MODIFY skills rather
 * than add flat stats. `applyEquipment` therefore patches a monster definition's
 * skill ids and params — SkillSystem resolves behaviour from those ids, so a
 * piece of gear can genuinely change what a monster does or even its role.
 */

const STORAGE_KEY = 'climbTower.save.v1';

/** Core-loop upgrades — they change the game, not the numbers (§7). */
export const UPGRADES = {
  manaRegen: { name: 'Ley Attunement', desc: '+15% mana regeneration', cost: 200, max: 5 },
  manaMax: { name: 'Deep Well', desc: '+2 maximum mana', cost: 250, max: 4 },
  essencePool: { name: 'Essence Reservoir', desc: '+12 essence per floor', cost: 220, max: 5 },
  gridCols: { name: 'Expanded Circle', desc: '+1 deployment column', cost: 600, max: 2 },
};

/** Equipment rewrites behaviour. Each entry declares how it patches a monster. */
export const EQUIPMENT = {
  thornedCarapace: {
    name: 'Thorned Carapace',
    slot: 'armor',
    desc: 'Stone Skin also reflects 25% of damage taken.',
    patch: { passiveMods: { stoneSkin: { reflect: 0.25 } } },
  },
  twinFuse: {
    name: 'Twin Fuse',
    slot: 'trinket',
    desc: 'Frenzy Strike triggers every 3rd hit instead of 4th.',
    patch: { passiveMods: { frenzyStrike: { every: 3 } } },
  },
  echoingCroak: {
    name: 'Echoing Croak',
    slot: 'trinket',
    desc: 'Croak of Silence also stuns the hero for 1.2s.',
    patch: { activeMods: { croakOfSilence: { stun: 1.2 } } },
  },
  bloodthornSeed: {
    name: 'Bloodthorn Seed',
    slot: 'trinket',
    desc: 'Bloom damages the hero instead of healing allies — turns Support into DPS.',
    patch: { roleOverride: 'ranged', passiveMods: { bloom: { mode: 'damage' } } },
  },
};

export default class Economy {
  constructor() {
    this.soft = 0;
    this.hard = 0;
    /** Pity counter for a future gacha (§7: guaranteed rare after N pulls). */
    this.pulls = 0;
    this.pityAt = 40;
    this.upgrades = {};
    this.loadout = {}; // monsterId -> [equipmentId]
    this.load();
  }

  grant(reward = {}) {
    this.soft += reward.soft ?? 0;
    this.hard += reward.hard ?? 0;
    this.save();
    return { soft: this.soft, hard: this.hard };
  }

  upgradeLevel(id) {
    return this.upgrades[id] ?? 0;
  }

  canBuy(id) {
    const up = UPGRADES[id];
    if (!up) return false;
    return this.upgradeLevel(id) < up.max && this.soft >= this.#priceOf(id);
  }

  buy(id) {
    if (!this.canBuy(id)) return false;
    this.soft -= this.#priceOf(id);
    this.upgrades[id] = this.upgradeLevel(id) + 1;
    this.save();
    return true;
  }

  #priceOf(id) {
    const up = UPGRADES[id];
    return Math.round(up.cost * (1 + 0.6 * this.upgradeLevel(id)));
  }

  /** Hook point: GameScene can fold these into floor config later. */
  modifiers() {
    return {
      manaRegenMult: 1 + 0.15 * this.upgradeLevel('manaRegen'),
      manaMaxBonus: 2 * this.upgradeLevel('manaMax'),
      essenceBonus: 12 * this.upgradeLevel('essencePool'),
      gridColBonus: this.upgradeLevel('gridCols'),
    };
  }

  /** Returns a patched copy of a monster def with its equipment applied. */
  applyEquipment(def) {
    const items = this.loadout[def.id] ?? [];
    if (!items.length) return def;

    const out = { ...def, passiveMods: {}, activeMods: {} };
    for (const id of items) {
      const patch = EQUIPMENT[id]?.patch;
      if (!patch) continue;
      Object.assign(out.passiveMods, patch.passiveMods ?? {});
      Object.assign(out.activeMods, patch.activeMods ?? {});
      if (patch.roleOverride) out.role = patch.roleOverride;
    }
    return out;
  }

  // ── persistence ──────────────────────────────────────────────────────────
  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        soft: this.soft,
        hard: this.hard,
        pulls: this.pulls,
        upgrades: this.upgrades,
        loadout: this.loadout,
      }));
    } catch { /* private browsing — run stays in-memory */ }
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      this.soft = data.soft ?? 0;
      this.hard = data.hard ?? 0;
      this.pulls = data.pulls ?? 0;
      this.upgrades = data.upgrades ?? {};
      this.loadout = data.loadout ?? {};
    } catch { /* corrupt save — start fresh */ }
  }
}
