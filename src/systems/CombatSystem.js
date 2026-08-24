/**
 * CombatSystem — the single place damage is resolved.
 *
 * Handles melee hits, projectiles, and the AoE shape queries the hero's
 * telegraphed skills need (circle / cone / line). Keeping this centralised
 * means crit, buffs, damage reduction and feedback stay consistent.
 */

import { COLORS, COMBAT, DEPTH } from '../config.js';

class Projectile {
  constructor(scene, opts) {
    this.scene = scene;
    Object.assign(this, opts);
    this.sprite = scene.add.image(this.x, this.y, this.texture)
      .setDepth(DEPTH.projectile)
      .setRotation(Math.atan2(this.vy, this.vx));
    if (this.tint) this.sprite.setTint(this.tint);
    if (this.scaleX) this.sprite.setScale(this.scaleX, this.scaleY ?? 1);
    this.life = this.life ?? 2.2;
    this.hitSet = new Set();
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    this.sprite.setPosition(Math.round(this.x), Math.round(this.y));

    for (const target of this.targets()) {
      if (!target.alive || this.hitSet.has(target)) continue;
      const r = target.hitRadius + this.radius;
      const dy = target.y - target.spriteHeight * 0.5;
      if (Phaser.Math.Distance.Between(this.x, this.y, target.x, dy) <= r) {
        this.hitSet.add(target);
        this.onHit?.(target);
        if (!this.pierce) return this.kill();
      }
    }

    const b = this.scene.arenaBounds;
    if (this.life <= 0 || this.x < b.x - 40 || this.x > b.right + 40) this.kill();
    return undefined;
  }

  targets() {
    return this.targetList ?? [];
  }

  kill() {
    this.dead = true;
    this.scene.fx.hitSpark(this.x, this.y, this.tint ?? COLORS.white, 3);
    this.sprite.destroy();
    return undefined;
  }
}

export default class CombatSystem {
  constructor(scene) {
    this.scene = scene;
    this.projectiles = [];
  }

  // ── basic resolution ─────────────────────────────────────────────────────
  /**
   * Resolves one attack from `attacker` onto `target`.
   * @returns {number} damage dealt
   */
  strike(attacker, target, opts = {}) {
    if (!target?.alive || !attacker.alive) return 0;

    const mult = opts.mult ?? 1;
    const crit = opts.crit ?? false;
    const raw = attacker.atk * mult * (crit ? COMBAT.critMultiplier : 1);

    const dealt = target.takeDamage(raw, {
      crit,
      color: opts.color ?? (crit ? COLORS.dmgCrit : COLORS.dmgPhysical),
      source: attacker,
    });

    if (opts.knockback) target.knockback(attacker.x, attacker.y, opts.knockback);
    if (crit) this.scene.fx.impact({ color: COLORS.dmgCrit, shake: 0.005, flash: 0.14, stop: 55 });

    opts.onHit?.(target, dealt, crit);
    return dealt;
  }

  // ── projectiles ──────────────────────────────────────────────────────────
  fireProjectile(attacker, target, opts = {}) {
    const sx = attacker.x + attacker.facing * 10;
    const sy = attacker.y - attacker.spriteHeight * 0.55;
    const tx = target.x;
    const ty = target.y - target.spriteHeight * 0.5;
    const speed = opts.speed ?? 340;
    const a = Math.atan2(ty - sy, tx - sx);

    const p = new Projectile(this.scene, {
      x: sx,
      y: sy,
      vx: Math.cos(a) * speed,
      vy: Math.sin(a) * speed,
      texture: opts.texture ?? 'proj_arrow',
      tint: opts.tint,
      radius: opts.radius ?? 6,
      pierce: opts.pierce ?? false,
      scaleX: opts.scaleX,
      scaleY: opts.scaleY,
      targetList: opts.targetList ?? [target],
      onHit: (hit) => opts.onHit?.(hit),
    });
    this.projectiles.push(p);
    return p;
  }

  // ── AoE queries ──────────────────────────────────────────────────────────
  monstersInCircle(x, y, radius) {
    return this.scene.monsters.filter((m) => m.alive
      && Phaser.Math.Distance.Between(x, y, m.x, m.y - m.spriteHeight * 0.4) <= radius + m.hitRadius);
  }

  monstersInCone(x, y, facing, radius, arcDeg) {
    const half = Phaser.Math.DegToRad(arcDeg) / 2;
    const base = facing < 0 ? Math.PI : 0;
    return this.scene.monsters.filter((m) => {
      if (!m.alive) return false;
      const my = m.y - m.spriteHeight * 0.4;
      if (Phaser.Math.Distance.Between(x, y, m.x, my) > radius + m.hitRadius) return false;
      const a = Math.atan2(my - y, m.x - x);
      return Math.abs(Phaser.Math.Angle.Wrap(a - base)) <= half;
    });
  }

  /** Applies flat damage to everything in a circle (hero AoE skills). */
  circleDamage(source, x, y, radius, amount, opts = {}) {
    const victims = this.monstersInCircle(x, y, radius);
    for (const m of victims) {
      m.takeDamage(amount, { color: opts.color ?? COLORS.tgDamage, source });
      if (opts.knockback) m.knockback(x, y, opts.knockback);
    }
    return victims;
  }

  coneDamage(source, x, y, facing, radius, arcDeg, amount, opts = {}) {
    const victims = this.monstersInCone(x, y, facing, radius, arcDeg);
    for (const m of victims) {
      m.takeDamage(amount, { color: opts.color ?? COLORS.tgDamage, source });
      if (opts.knockback) m.knockback(x, y, opts.knockback);
    }
    return victims;
  }

  update(dt) {
    for (const p of this.projectiles) p.update(dt);
    this.projectiles = this.projectiles.filter((p) => !p.dead);
  }

  reset() {
    for (const p of this.projectiles) p.sprite?.destroy();
    this.projectiles = [];
  }
}
