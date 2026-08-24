/**
 * SummonSystem — free-form deployment across the arena.
 *
 * A selected monster lands at the exact world position the player clicks;
 * there is deliberately no placement grid, cell count, or snap-to-cell logic.
 */

import { ARENA, COLORS, DEPTH } from '../config.js';
import Monster from '../entities/Monster.js';
import { MONSTER_BY_ID } from '../data/monsters.js';

export default class SummonSystem {
  constructor(scene) {
    this.scene = scene;
    this.selectedId = null;
    this.hovered = null;
    this.unlocked = new Set();

    this.markGfx = scene.add.graphics().setDepth(DEPTH.gridMark);
    this.ghost = scene.add.sprite(0, 0, 'golem_idle0')
      .setDepth(DEPTH.ghost)
      .setOrigin(0.5, 1)
      .setAlpha(0)
      .setTint(0x9fe8ff);
    this.ghostGfx = scene.add.graphics().setDepth(DEPTH.ghost);

    scene.input.on('pointermove', (p) => this.#onMove(p));
    scene.input.on('pointerdown', (p) => this.#onDown(p));
  }

  configure(floorCfg) {
    this.unlocked = new Set(floorCfg.unlockedMonsters);
    if (!this.unlocked.has(this.selectedId)) {
      this.selectedId = floorCfg.unlockedMonsters[0] ?? null;
    }
  }

  setSelected(id) {
    this.selectedId = id;
    this.scene.events.emit('selection-changed', id);
  }

  get selectedDef() {
    return this.selectedId ? MONSTER_BY_ID[this.selectedId] : null;
  }

  #onMove(pointer) {
    this.hovered = { x: pointer.worldX, y: pointer.worldY };
  }

  #onDown(pointer) {
    if (!this.scene.battle.acceptsInput) return;
    this.trySummon(this.selectedId, { x: pointer.worldX, y: pointer.worldY });
  }

  /** @returns {{ok:boolean, reason?:string}} */
  validate(defId, point) {
    if (!defId) return { ok: false, reason: 'Pick a monster first' };
    if (!this.unlocked.has(defId)) return { ok: false, reason: 'Not available on this floor' };
    if (!this.#isInsideArena(point)) return { ok: false, reason: 'Click anywhere inside the battlefield' };

    const def = MONSTER_BY_ID[defId];
    if (!this.scene.mana.canAfford(def.cost)) return { ok: false, reason: 'Not enough mana' };
    return { ok: true };
  }

  trySummon(defId, point) {
    const check = this.validate(defId, point);
    if (!check.ok) {
      this.scene.ui.flashHint(check.reason);
      if (point && !this.#isInsideArena(point)) this.#denyPulse(point);
      return null;
    }

    const def = MONSTER_BY_ID[defId];
    this.scene.mana.spend(def.cost);

    // Use the unmodified click coordinate: summons are not snapped to a grid.
    const monster = new Monster(this.scene, def, point.x, point.y);
    this.scene.monsters.push(monster);

    this.scene.skills.onMonsterSummoned(monster);
    this.scene.events.emit('monster-summoned', monster);
    return monster;
  }

  #isInsideArena(point) {
    return !!point
      && point.x >= ARENA.x && point.x <= ARENA.right
      && point.y >= ARENA.y && point.y <= ARENA.bottom;
  }

  #denyPulse(point) {
    const g = this.scene.add.graphics().setDepth(DEPTH.gridMark);
    g.lineStyle(2, COLORS.gridDanger, 1);
    g.strokeCircle(point.x, point.y, 14);
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 260, onComplete: () => g.destroy() });
  }

  update() {
    const g = this.markGfx;
    g.clear();

    const def = this.selectedDef;
    const point = this.hovered;
    const interactive = this.scene.battle.acceptsInput;
    const valid = point && interactive && this.validate(this.selectedId, point).ok;

    if (point && interactive && this.#isInsideArena(point)) {
      const col = valid ? COLORS.gridHover : COLORS.gridDanger;
      g.lineStyle(2, col, 1);
      g.strokeCircle(point.x, point.y, 14);
      g.lineStyle(1, col, 0.55);
      g.strokeCircle(point.x, point.y, 20);
    }

    this.#drawGhost(valid ? point : null, def);
  }

  #drawGhost(point, def) {
    const gg = this.ghostGfx;
    gg.clear();

    if (!point || !def) {
      this.ghost.setAlpha(0);
      return;
    }

    this.ghost.setTexture(`${def.art}_idle0`);
    this.ghost.setPosition(point.x, point.y);
    this.ghost.setAlpha(0.55);

    // Preview attack reach without imposing a placement boundary.
    gg.lineStyle(1, COLORS.gridHover, 0.5);
    gg.strokeCircle(point.x, point.y, def.range);
  }

  reset() {
    this.hovered = null;
    this.markGfx.clear();
    this.ghost.setAlpha(0);
    this.ghostGfx.clear();
  }
}
