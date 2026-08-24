/**
 * BattleSystem — battle-state machine and the win/lose conditions (spec §2.3).
 *
 * Victory: the hero dies.
 * Defeat : the essence pool is dry, the player cannot afford the cheapest
 *          monster, and nothing is left alive on the field.
 */

import { CHEAPEST_COST } from '../data/monsters.js';

export const BATTLE_STATE = {
  INTRO: 'intro',
  FIGHT: 'fight',
  VICTORY: 'victory',
  DEFEAT: 'defeat',
};

export default class BattleSystem {
  constructor(scene) {
    this.scene = scene;
    this.state = BATTLE_STATE.INTRO;
    this.elapsed = 0;
    this.resolveDelay = 0;
  }

  /** Grid clicks and card selection are only live during the fight. */
  get acceptsInput() {
    return this.state === BATTLE_STATE.FIGHT;
  }

  get running() {
    return this.state === BATTLE_STATE.FIGHT;
  }

  get finished() {
    return this.state === BATTLE_STATE.VICTORY || this.state === BATTLE_STATE.DEFEAT;
  }

  begin() {
    this.state = BATTLE_STATE.FIGHT;
    this.elapsed = 0;
    this.resolveDelay = 0;
    this.scene.events.emit('battle-begin');
  }

  toIntro() {
    this.state = BATTLE_STATE.INTRO;
    this.elapsed = 0;
  }

  update(dt) {
    if (this.state !== BATTLE_STATE.FIGHT) return;
    this.elapsed += dt;

    const { hero, mana } = this.scene;
    const livingMonsters = this.scene.monsters.some((m) => m.alive);

    // ── victory ──
    if (hero && !hero.alive) {
      this.resolveDelay += dt;
      if (this.resolveDelay > 1.1) this.#finish(BATTLE_STATE.VICTORY);
      return;
    }

    // ── defeat: no resource, no board, no way back ──
    // 2s grace so the opening moments can never register a loss.
    if (this.elapsed > 2 && !livingMonsters && mana.poolEmpty && mana.mana < CHEAPEST_COST) {
      this.resolveDelay += dt;
      if (this.resolveDelay > 0.6) this.#finish(BATTLE_STATE.DEFEAT);
      return;
    }

    this.resolveDelay = 0;
  }

  /** How close the player is to running dry — surfaced in the UI as a warning. */
  get inDanger() {
    const { mana } = this.scene;
    const living = this.scene.monsters.filter((m) => m.alive).length;
    return mana.poolPct < 0.2 && living <= 1;
  }

  #finish(state) {
    this.state = state;
    this.scene.events.emit(state === BATTLE_STATE.VICTORY ? 'battle-victory' : 'battle-defeat');
  }
}
