/**
 * SummonSystem — free-form deployment across the arena.
 *
 * A selected monster lands at the exact world position the player clicks;
 * there is deliberately no placement grid, cell count, or snap-to-cell logic.
 */

import { ARENA, COLORS, DEPTH } from '../config.js';
import Monster from '../entities/Monster.js';
import { MONSTER_BY_ID } from '../data/monsters.js';
import {
  GROUND_SQUASH, P, pxDisc, pxGroundRing, pxLine, pxStar, snap,
} from '../art/PixelDraw.js';

export default class SummonSystem {
  constructor(scene) {
    this.scene = scene;
    this.selectedId = null;
    this.hovered = null;
    this.unlocked = new Set();
    /** Real seconds since the scene started — drives the sigil's rotation. It
     *  is deliberately not the battle clock: the cursor keeps turning through
     *  hitstop, which is what tells the player the game hasn't locked up. */
    this.t = 0;

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

    // the sigil discharges: the ward collapses inward and leaves a scorch
    this.scene.fx.summonBurst(point.x, point.y, COLORS.gridHover);

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
    g.fillStyle(COLORS.gridDanger, 1);
    pxGroundRing(g, snap(point.x), snap(point.y), 16, { dash: 2, gap: 2 });
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 260, onComplete: () => g.destroy() });
  }

  update(dt = 0) {
    this.t += dt;

    const g = this.markGfx;
    g.clear();

    const def = this.selectedDef;
    const point = this.hovered;
    const interactive = this.scene.battle.acceptsInput;
    const valid = point && interactive && this.validate(this.selectedId, point).ok;

    if (point && interactive && this.#isInsideArena(point)) {
      this.#drawSigil(point, valid);
    }

    this.#drawGhost(valid ? point : null, def);
  }

  /**
   * The summoning sigil: where the next monster will be pulled through.
   *
   * Drawn as stamped blocks rather than stroked arcs — a smooth vector circle
   * over nearest-neighbour art immediately reads as an editor overlay. The
   * rings are squashed onto the ground plane so the sigil lies on the floor
   * instead of standing up like a hoop.
   *
   * Everything counter-rotates: the outer runes one way, the inner ward the
   * other. That contrary motion is what makes it read as machinery being
   * wound rather than as a spinning decoration.
   */
  #drawSigil(point, valid) {
    const g = this.markGfx;
    const x = snap(point.x);
    const y = snap(point.y);
    const col = valid ? COLORS.gridHover : COLORS.gridDanger;
    const t = this.t;
    // one shared breath, so the parts pulse together instead of shimmering
    const breath = 0.5 + 0.5 * Math.sin(t * 3.4);

    // outer band of runes, ticking clockwise
    g.fillStyle(col, 0.34 + 0.16 * breath);
    pxGroundRing(g, x, y, 26, { dash: 3, gap: 4, rot: t * 0.9 });

    // the ward: a solid ring with four cardinal ticks reaching outward
    g.fillStyle(col, 0.85);
    pxGroundRing(g, x, y, 15);
    for (let i = 0; i < 4; i++) {
      const a = -t * 1.4 + (i * Math.PI) / 2;
      const c = Math.cos(a);
      const s = Math.sin(a) * GROUND_SQUASH;
      pxLine(g, x + c * 17, y + s * 17, x + c * 23, y + s * 23);
    }

    // the eye: a bright core that breathes, so the cursor is findable even
    // over the busiest floor tile
    g.fillStyle(col, 0.2 + 0.22 * breath);
    pxDisc(g, x, y, 9, 9 * GROUND_SQUASH);
    g.fillStyle(0xffffff, 0.5 + 0.4 * breath);
    pxStar(g, x, y, P * 2);

    // three sparks orbiting the ward: motion at the edge of vision
    for (let i = 0; i < 3; i++) {
      const a = t * 2.1 + (i * Math.PI * 2) / 3;
      const r = 20 + Math.sin(t * 4 + i) * 3;
      g.fillStyle(col, 0.75);
      g.fillRect(snap(x + Math.cos(a) * r), snap(y + Math.sin(a) * r * GROUND_SQUASH), P, P);
    }
  }

  #drawGhost(point, def) {
    const gg = this.ghostGfx;
    gg.clear();

    if (!point || !def) {
      this.ghost.setAlpha(0);
      return;
    }

    this.ghost.setTexture(`${def.art}_idle0`);
    this.ghost.setPosition(snap(point.x), snap(point.y));
    // the ghost breathes in antiphase with the sigil's core: as the eye dims,
    // the shape it will produce comes forward
    this.ghost.setAlpha(0.4 + 0.14 * (0.5 - 0.5 * Math.sin(this.t * 3.4)));

    // Preview attack reach without imposing a placement boundary. Dashed and
    // slowly turning so it never competes with a telegraph ring for attention.
    gg.fillStyle(COLORS.gridHover, 0.4);
    pxGroundRing(gg, snap(point.x), snap(point.y), def.range, {
      dash: 2, gap: 5, rot: this.t * 0.4,
    });
  }

  reset() {
    this.hovered = null;
    this.markGfx.clear();
    this.ghost.setAlpha(0);
    this.ghostGfx.clear();
  }
}
