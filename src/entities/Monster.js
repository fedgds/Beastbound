/**
 * Monster — a committed deployment. It owns stats, attack cadence, and skill
 * bookkeeping; MonsterAI owns steering. The player can never move it (spec §2.2).
 */

import Entity from './Entity.js';
import { COLORS, DEPTH } from '../config.js';
import { ROLE } from '../data/monsters.js';

let nextId = 1;

export default class Monster extends Entity {
  constructor(scene, def, x, y) {
    super(scene, {
      art: def.art,
      x, y,
      hp: def.hp,
      atk: def.atk,
      speed: def.speed,
      hitRadius: def.hitRadius,
    });

    this.uid = nextId++;
    this.def = def;
    this.combat = def.combat ?? {};
    this.role = def.role;
    this.barWidth = 26;
    this.deathColor = Phaser.Display.Color.HexStringToColor(def.tint).color;

    this.attackCooldown = def.attackInterval * 0.35; // slight ramp-in
    this.hitCount = 0;
    this.skillCd = {};
    this.spawnedAt = scene.clock;

    /** Reckless Charge state, advanced by SkillSystem.tickDash(). */
    this.dashing = false;
    this.dash = null;

    // ranged units keep a preferred standoff band
    this.standoff = def.range * 0.85;

    this.summonFx();
  }

  get isRanged() {
    return this.role === ROLE.RANGED || this.role === ROLE.CC || this.role === ROLE.SUPPORT;
  }

  summonFx() {
    const col = this.deathColor;
    const ring = this.scene.add.graphics().setDepth(DEPTH.telegraphGround);
    ring.lineStyle(2, col, 1);
    ring.strokeCircle(this.x, this.y, 6);
    this.scene.tweens.add({
      targets: ring,
      alpha: 0,
      duration: 380,
      onUpdate: (tw) => {
        const p = tw.progress;
        ring.clear();
        ring.lineStyle(2, col, 1 - p);
        ring.strokeCircle(this.x, this.y, 6 + p * 26);
      },
      onComplete: () => ring.destroy(),
    });

    // Drop-in: tweened through spriteYOffset so the per-frame syncSprite()
    // doesn't immediately snap the sprite back to the ground.
    this.sprite.setAlpha(0);
    this.spriteYOffset = -14;
    this.scene.tweens.add({
      targets: this.sprite,
      alpha: 1,
      duration: 220,
    });
    this.scene.tweens.add({
      targets: this,
      spriteYOffset: 0,
      duration: 260,
      ease: 'Back.out',
    });
    this.scene.fx.puff(this.x, this.y, col);
  }

  canUseSkill(id, cooldown) {
    return (this.skillCd[id] ?? 0) <= this.scene.clock && cooldown >= 0;
  }

  putSkillOnCd(id, cooldown) {
    this.skillCd[id] = this.scene.clock + cooldown;
  }

  /** Tick attack cadence; returns true when an attack should resolve now. */
  tickAttack(dt) {
    if (this.stunned || this.dying) return false;
    this.attackCooldown -= dt;
    return this.attackCooldown <= 0;
  }

  resetAttackTimer() {
    this.attackCooldown = this.def.attackInterval;
    this.hitCount++;
  }

  update(dt) {
    if (!this.alive) {
      this.syncSprite();
      return;
    }
    this.stepPhysics(dt, this.scene.arenaBounds);
    this.syncSprite();
    this.drawHpBar();
  }

  onDamaged() {
    // Stone Skin barrier visibility is refreshed by SkillSystem each tick.
    this.scene.fx.shake(0.0015, 60);
  }

  onDeath() {
    // A monster killed mid-dash must not keep its dash state around.
    this.dashing = false;
    this.dash = null;
    this.scene.fx.popText(this.x, this.y - 30, `${this.def.short} down`, COLORS.dmgCrit);
  }
}
