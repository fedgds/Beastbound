/**
 * Shared base for Monster and Hero: health, statuses, animation state machine,
 * HP bar, hit/death feedback.
 *
 * Time comes from `scene.clock` (seconds, advanced by GameScene with *scaled*
 * dt) so hitstop and pauses freeze cooldowns and status timers consistently.
 */

import { COLORS, COMBAT, DEPTH } from '../config.js';

/** Animation states that must play to completion before idle/move resume. */
const LOCKING = new Set(['windup', 'attack', 'hit', 'die']);

export default class Entity {
  constructor(scene, {
    art, x, y, hp, atk, speed, hitRadius, isHero = false, visualScale = 0.78,
    shadowScale = visualScale,
  }) {
    this.scene = scene;
    this.art = art;
    this.isHero = isHero;

    this.x = x;
    this.y = y;
    this.facing = isHero ? -1 : 1; // heroes look left toward the deploy zone

    this.maxHp = hp;
    this.hp = hp;
    this.baseAtk = atk;
    this.baseSpeed = speed;
    this.hitRadius = hitRadius;
    // Presentation-only: keep a boss imposing without altering combat math.
    this.visualScale = visualScale;

    this.alive = true;
    this.dying = false;
    this.iceWallHp = 0;
    this.iceWallUntil = 0;

    this.status = {
      slowUntil: 0,
      slowMult: 1,
      stunUntil: 0,
      atkBuffUntil: 0,
      atkBuffMult: 1,
      barrierUntil: 0,
      drMult: 1, // damage-taken multiplier from passives
    };

    this.animState = 'idle';
    this.animLockUntil = 0;

    this.shadow = scene.add.image(x, y + 2, 'shadow')
      .setDepth(DEPTH.shadow)
      .setAlpha(0.35)
      // Sized independently of `visualScale`: a sprite baked large and rendered
      // 1:1 still needs the footprint of a boss.
      .setDisplaySize(hitRadius * 2.4 * shadowScale, hitRadius * 1.1 * shadowScale);

    this.sprite = scene.add.sprite(x, y, `${art}_idle0`)
      .setDepth(DEPTH.unit)
      .setOrigin(0.5, 1)
      .setScale(visualScale);
    this.sprite.__entity = this;

    this.hpBar = scene.add.graphics().setDepth(DEPTH.hpbar);
    this.barrierFx = null;

    this.play('idle');
    this.drawHpBar();
  }

  // ── stats ────────────────────────────────────────────────────────────────
  get atk() {
    return this.baseAtk * (this.scene.clock < this.status.atkBuffUntil ? this.status.atkBuffMult : 1);
  }

  get speed() {
    if (this.stunned) return 0;
    const slow = this.scene.clock < this.status.slowUntil ? this.status.slowMult : 1;
    return this.baseSpeed * Math.max(COMBAT.slowFloor, slow);
  }

  get stunned() {
    return this.scene.clock < this.status.stunUntil;
  }

  get hpPct() {
    return this.maxHp <= 0 ? 0 : this.hp / this.maxHp;
  }

  get critChance() { return this.combat?.crit ?? 0; }
  get dodgeChance() { return this.combat?.dodge ?? 0; }
  get blockChance() { return this.combat?.block ?? 0; }

  // ── statuses ─────────────────────────────────────────────────────────────
  applySlow(mult, seconds) {
    const now = this.scene.clock;
    // strongest slow wins; refresh duration
    this.status.slowMult = Math.min(this.status.slowMult <= 1 && now < this.status.slowUntil
      ? this.status.slowMult : 1, mult);
    this.status.slowUntil = Math.max(this.status.slowUntil, now + seconds);
  }

  applyStun(seconds) {
    this.status.stunUntil = Math.max(this.status.stunUntil, this.scene.clock + seconds);
  }

  applyAtkBuff(mult, seconds) {
    this.status.atkBuffMult = Math.max(this.status.atkBuffMult, mult);
    this.status.atkBuffUntil = Math.max(this.status.atkBuffUntil, this.scene.clock + seconds);
  }

  // ── damage / healing ─────────────────────────────────────────────────────
  /** @returns {number} damage actually dealt (0 if already dead). */
  takeDamage(amount, opts = {}) {
    if (!this.alive) return 0;

    // Ice Wall is a real temporary shield rather than cosmetic cover: it
    // absorbs damage before mitigation, then collapses cleanly when depleted.
    let remaining = amount;
    if (this.iceWallHp > 0 && this.scene.clock < this.iceWallUntil) {
      const absorbed = Math.min(remaining, this.iceWallHp);
      this.iceWallHp -= absorbed;
      remaining -= absorbed;
      this.scene.fx.popText(this.x, this.y - this.spriteHeight - 18, `ICE WALL ${Math.ceil(this.iceWallHp)}`, 0xa9f5ff);
      if (this.iceWallHp <= 0) this.setBarrier(false);
      if (remaining <= 0) return 0;
    }

    const dealt = Math.max(1, Math.round(remaining * this.status.drMult));
    this.hp = Math.max(0, this.hp - dealt);

    const chest = this.y - this.spriteHeight * 0.5;
    this.scene.fx.damageNumber(this.x, this.y - this.spriteHeight - 6, dealt, opts);
    // sparks leave along the line the blow travelled, so a hit reads as having
    // come *from* the attacker rather than as a generic burst
    const src = opts.source;
    const dir = src
      ? Math.atan2(chest - (src.y - src.spriteHeight * 0.5), this.x - src.x)
      : null;
    this.scene.fx.hitSpark(this.x, chest, opts.color ?? COLORS.dmgPhysical, 5, dir);

    if (this.hp <= 0) {
      this.die();
    } else if (!this.animLocked || this.animState !== 'die') {
      this.play('hit');
    }

    this.drawHpBar();
    this.onDamaged?.(dealt, opts);
    return dealt;
  }

  heal(amount) {
    if (!this.alive || this.hp >= this.maxHp) return 0;
    const before = this.hp;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    const gained = this.hp - before;
    if (gained > 0) {
      this.scene.fx.damageNumber(this.x, this.y - this.spriteHeight - 6, gained, { heal: true });
      this.drawHpBar();
    }
    return gained;
  }

  knockback(fromX, fromY, force) {
    if (!this.alive) return;
    const a = Math.atan2(this.y - fromY, this.x - fromX);
    this.pendingKnock = { vx: Math.cos(a) * force, vy: Math.sin(a) * force, t: 0.18 };
  }

  die() {
    if (this.dying) return;
    this.dying = true;
    this.alive = false;
    this.status.stunUntil = Infinity;
    this.play('die', true);
    this.hpBar.clear();
    this.barrierFx?.destroy();
    this.barrierFx = null;
    this.scene.fx.deathBurst(this.x, this.y - this.spriteHeight * 0.5, this.deathColor ?? COLORS.white);
    this.onDeath?.();

    this.scene.tweens.add({
      targets: [this.sprite, this.shadow],
      alpha: 0,
      duration: 420,
      delay: 260,
      onComplete: () => this.destroy(),
    });
  }

  // ── animation ────────────────────────────────────────────────────────────
  get spriteHeight() {
    return this.sprite.displayHeight;
  }

  get animLocked() {
    return this.scene.clock < this.animLockUntil;
  }

  /** Plays an animation state; locking states block lower-priority requests. */
  play(state, force = false) {
    if (!force && this.animLocked && !LOCKING.has(state)) return;
    if (!force && this.animState === state && !LOCKING.has(state)) return;

    const key = `${this.art}_${state}`;
    if (!this.scene.anims.exists(key)) return;

    this.animState = state;
    this.sprite.play(key, true);

    if (LOCKING.has(state)) {
      const anim = this.scene.anims.get(key);
      const dur = anim.duration / 1000;
      this.animLockUntil = this.scene.clock + dur;
    } else {
      this.animLockUntil = 0;
    }
  }

  /** Stretches a locking animation to exactly `seconds` (used for telegraphs). */
  playFor(state, seconds) {
    const key = `${this.art}_${state}`;
    if (!this.scene.anims.exists(key)) return;
    this.animState = state;
    const anim = this.scene.anims.get(key);
    this.sprite.play({ key, duration: seconds * 1000, repeat: 0 }, true);
    void anim;
    this.animLockUntil = this.scene.clock + seconds;
  }

  flash(color = 0xffffff, ms = COMBAT.hitFlashMs) {
    this.sprite.setTintFill(color);
    this.scene.time.delayedCall(ms, () => this.sprite.clearTint());
  }

  setBarrier(on) {
    if (on && !this.barrierFx) {
      // Cyan stone-shield ring, after image/skill "Stone Shield Barrier".
      this.barrierFx = this.scene.add.graphics().setDepth(DEPTH.unitFx);
      this.barrierFx.lineStyle(2, COLORS.shield, 0.9);
      this.barrierFx.strokeCircle(0, 0, this.hitRadius + 8);
      this.barrierFx.lineStyle(4, COLORS.shield, 0.25);
      this.barrierFx.strokeCircle(0, 0, this.hitRadius + 8);
      // Four square runes keep the defensive state readable as a magical stone
      // ward rather than a plain selection circle.
      this.barrierFx.fillStyle(0xbff8ff, 0.9);
      const r = this.hitRadius + 8;
      for (let i = 0; i < 4; i++) {
        const a = Math.PI / 4 + i * Math.PI / 2;
        this.barrierFx.fillRect(Math.round(Math.cos(a) * r) - 2, Math.round(Math.sin(a) * r) - 2, 4, 4);
      }
      this.scene.tweens.add({
        targets: this.barrierFx,
        alpha: { from: 0.55, to: 1 },
        duration: 420,
        yoyo: true,
        repeat: -1,
      });
    } else if (!on && this.barrierFx) {
      this.barrierFx.destroy();
      this.barrierFx = null;
    }
  }

  // ── presentation ─────────────────────────────────────────────────────────
  drawHpBar() {
    const g = this.hpBar;
    g.clear();
    if (!this.alive) return;

    const w = this.barWidth ?? 30;
    const h = 4;
    const x = Math.round(this.x - w / 2);
    const y = Math.round(this.y - this.spriteHeight - 8);

    g.fillStyle(0x0b0912, 0.85);
    g.fillRect(x - 1, y - 1, w + 2, h + 2);
    g.fillStyle(0x3a2030, 1);
    g.fillRect(x, y, w, h);

    const pct = this.hpPct;
    const col = this.isHero ? 0xff4d5e : (pct > 0.4 ? 0x5fd97a : 0xffb03a);
    g.fillStyle(col, 1);
    g.fillRect(x, y, Math.max(1, Math.round(w * pct)), h);
  }

  syncSprite() {
    const dy = this.spriteYOffset ?? 0;
    this.sprite.setPosition(Math.round(this.x), Math.round(this.y + dy));
    this.sprite.setFlipX(this.facing < 0);
    this.shadow.setPosition(Math.round(this.x), Math.round(this.y + 2));
    if (this.barrierFx) {
      this.barrierFx.setPosition(Math.round(this.x), Math.round(this.y - this.spriteHeight * 0.5));
    }
  }

  /** Integrates knockback; subclasses call this from their own update(). */
  stepPhysics(dt, bounds) {
    if (this.pendingKnock) {
      const k = this.pendingKnock;
      this.x += k.vx * dt;
      this.y += k.vy * dt;
      k.t -= dt;
      k.vx *= 0.86;
      k.vy *= 0.86;
      if (k.t <= 0) this.pendingKnock = null;
    }
    if (bounds) {
      this.x = Phaser.Math.Clamp(this.x, bounds.x + 12, bounds.right - 12);
      this.y = Phaser.Math.Clamp(this.y, bounds.y + 20, bounds.bottom - 6);
    }
  }

  distanceTo(other) {
    return Phaser.Math.Distance.Between(this.x, this.y, other.x, other.y);
  }

  destroy() {
    this.sprite?.destroy();
    this.shadow?.destroy();
    this.hpBar?.destroy();
    this.barrierFx?.destroy();
    this.destroyed = true;
  }
}
