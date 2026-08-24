/**
 * ManaSystem — the player's only resource (spec §2.2).
 *
 * Mana regenerates continuously, but every regenerated point is drawn from a
 * finite per-floor Essence Pool. That bound is what makes the §2.3 defeat
 * condition ("out of mana AND all monsters dead") actually reachable, and it
 * puts a cost on every wasted summon.
 */

import { MANA } from '../config.js';
import { CHEAPEST_COST } from '../data/monsters.js';

export default class ManaSystem {
  constructor(scene) {
    this.scene = scene;
    // Floor modifiers only exist when configure() is called by GameScene.
    // Keep construction independent so the title screen can always boot.
    this.max = MANA.max;
    this.mana = MANA.start;
    this.regen = MANA.regenPerSec;
    this.pool = 0;
    this.poolMax = 0;
    this.spentTotal = 0;
  }

  configure(floorCfg) {
    this.max = MANA.max + (floorCfg.manaMaxBonus ?? 0);
    // Reaching a higher floor starts the new battle with extra ready mana.
    // It remains capped by this floor's mana well, so costs stay legible.
    this.mana = Math.min(this.max, MANA.start + (floorCfg.manaBonus ?? 0));
    this.regen = MANA.regenPerSec * floorCfg.manaRegenMult;
    this.pool = floorCfg.essencePool;
    this.poolMax = floorCfg.essencePool;
    this.spentTotal = 0;
  }

  get manaPct() {
    return this.mana / this.max;
  }

  get poolPct() {
    return this.poolMax <= 0 ? 0 : this.pool / this.poolMax;
  }

  /** No essence left to draw on. */
  get poolEmpty() {
    return this.pool <= 0.0001;
  }

  /** Cannot afford anything and cannot regenerate any more. */
  get exhausted() {
    return this.poolEmpty && this.mana < CHEAPEST_COST;
  }

  canAfford(cost) {
    return this.mana >= cost;
  }

  spend(cost) {
    if (!this.canAfford(cost)) return false;
    this.mana -= cost;
    this.spentTotal += cost;
    return true;
  }

  /** Refund path for a summon that failed validation after mana was reserved. */
  refund(cost) {
    this.mana = Math.min(this.max, this.mana + cost);
    this.spentTotal -= cost;
  }

  update(dt) {
    if (this.pool <= 0 || this.mana >= this.max) return;
    const want = this.regen * dt;
    const take = Math.min(want, this.pool, this.max - this.mana);
    this.mana += take;
    this.pool -= take;
  }
}
