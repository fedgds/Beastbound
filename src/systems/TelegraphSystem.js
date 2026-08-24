/**
 * TelegraphSystem — spec §4.2, the most important readability system.
 *
 * NOTHING powerful is allowed to resolve without first passing through here.
 * A telegraph:
 *   • runs for ~0.3–0.5s of wind-up before the effect fires,
 *   • paints the exact affected area on the ground,
 *   • flashes the caster's silhouette in the colour of the threat type,
 *   • names the incoming skill above the caster,
 *   • publishes its area so SummonSystem can hatch grid cells inside it and
 *     MonsterAI/SkillSystem can react (Croak of Silence cancels it).
 *
 * Colour language (§5): red = AoE damage, yellow = buff/heal, purple = control.
 */

import { COLORS, DEPTH, TELEGRAPH_KIND, telegraphColor } from '../config.js';

let nextId = 1;

export default class TelegraphSystem {
  constructor(scene) {
    this.scene = scene;
    this.active = [];
  }

  /**
   * @returns {{id:number, cancel:Function, kind:string}} handle
   */
  begin(cfg) {
    const color = telegraphColor(cfg.kind);
    const tg = {
      id: nextId++,
      kind: cfg.kind ?? TELEGRAPH_KIND.DAMAGE,
      shape: cfg.shape ?? 'circle',
      radius: cfg.radius ?? 100,
      arc: cfg.arc ?? 90,
      duration: cfg.duration ?? 0.4,
      elapsed: 0,
      color,
      label: cfg.label ?? '',
      source: cfg.source,
      /** Fixed ground position — telegraphs do NOT chase the player. */
      x: cfg.x,
      y: cfg.y,
      facing: cfg.facing ?? -1,
      heavy: !!cfg.heavy,
      onComplete: cfg.onComplete,
      onCancel: cfg.onCancel,
      cancelled: false,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      flashPhase: 0,
    };

    tg.text = this.scene.add.text(tg.x, tg.y - 74, tg.label, {
      fontFamily: 'monospace',
      fontSize: tg.heavy ? '14px' : '11px',
      fontStyle: 'bold',
      color: `#${color.toString(16).padStart(6, '0')}`,
      stroke: '#0b0912',
      strokeThickness: 4,
    }).setOrigin(0.5).setDepth(DEPTH.popup);

    this.scene.tweens.add({
      targets: tg.text,
      scale: { from: 0.7, to: 1 },
      duration: 140,
      ease: 'Back.out',
    });

    // Heavy skills (the ultimate) get an extra audible-feeling punch of warning.
    if (tg.heavy) {
      this.scene.fx.screenFlash(color, 0.12, 140);
      this.scene.fx.shake(0.002, 200);
    }

    tg.handle = {
      id: tg.id,
      kind: tg.kind,
      heavy: tg.heavy,
      cancel: (reason) => this.cancel(tg.id, reason),
      get done() { return tg.finished === true; },
    };

    this.active.push(tg);
    return tg.handle;
  }

  /** Used by Swamp Toad's Croak of Silence to interrupt a wind-up (spec §3.1). */
  cancel(id, reason = 'INTERRUPTED') {
    const tg = this.active.find((t) => t.id === id);
    if (!tg || tg.finished) return false;

    tg.cancelled = true;
    tg.finished = true;
    this.#fizzle(tg, reason);
    tg.onCancel?.(reason);
    this.#dispose(tg);
    return true;
  }

  /** Cancels whatever is currently winding up. @returns {boolean} success */
  cancelActive(reason = 'INTERRUPTED') {
    const tg = this.active.find((t) => !t.finished);
    return tg ? this.cancel(tg.id, reason) : false;
  }

  /** True while any powerful skill is winding up — the reaction window. */
  hasActive() {
    return this.active.some((t) => !t.finished);
  }

  currentKind() {
    return this.active.find((t) => !t.finished)?.kind ?? null;
  }

  /** Danger areas for grid hatching / AI avoidance. */
  dangerZones() {
    return this.active.filter((t) => !t.finished && t.kind === TELEGRAPH_KIND.DAMAGE);
  }

  /** Is a world point inside a live damaging telegraph? */
  isDangerous(x, y) {
    return this.dangerZones().some((t) => {
      const d = Phaser.Math.Distance.Between(x, y, t.x, t.y);
      if (d > t.radius) return false;
      if (t.shape !== 'cone') return true;
      const half = Phaser.Math.DegToRad(t.arc) / 2;
      const base = t.facing < 0 ? Math.PI : 0;
      const a = Math.atan2(y - t.y, x - t.x);
      return Math.abs(Phaser.Math.Angle.Wrap(a - base)) <= half;
    });
  }

  #fizzle(tg, reason) {
    this.scene.fx.popText(tg.x, tg.y - 80, reason, COLORS.tgControl);
    this.scene.fx.ring(tg.x, tg.y, tg.radius * 0.7, COLORS.tgControl, 260, 2);
    tg.source?.flash(COLORS.tgControl, 120);
  }

  #dispose(tg) {
    tg.gfx.destroy();
    // Hand the label to a local first: tg.text is nulled straight away so #draw
    // stops touching it, and the fade-out tween must not read it back.
    const label = tg.text;
    tg.text = null;
    if (label) {
      this.scene.tweens.add({
        targets: label,
        alpha: 0,
        y: label.y - 10,
        duration: 220,
        onComplete: () => label.destroy(),
      });
    }
    tg.source?.sprite?.clearTint();
    this.active = this.active.filter((t) => t !== tg);
  }

  update(dt) {
    for (const tg of [...this.active]) {
      if (tg.finished) continue;

      tg.elapsed += dt;
      const p = Phaser.Math.Clamp(tg.elapsed / tg.duration, 0, 1);

      this.#draw(tg, p);
      this.#flashCaster(tg, dt);

      if (p >= 1) {
        tg.finished = true;
        const { onComplete } = tg;
        this.#dispose(tg);
        onComplete?.();
      }
    }
  }

  /** Ground indicator: filled area + a sweep that shows time remaining. */
  #draw(tg, p) {
    const g = tg.gfx;
    g.clear();

    const pulse = 0.35 + 0.25 * Math.sin(p * Math.PI * 6);

    if (tg.shape === 'cone') {
      const half = Phaser.Math.DegToRad(tg.arc) / 2;
      const base = tg.facing < 0 ? Math.PI : 0;

      g.fillStyle(tg.color, 0.16);
      g.slice(tg.x, tg.y, tg.radius, base - half, base + half, false);
      g.fillPath();

      // filling wedge = the part already "charged"
      g.fillStyle(tg.color, 0.34);
      g.slice(tg.x, tg.y, tg.radius * p, base - half, base + half, false);
      g.fillPath();

      g.lineStyle(2, tg.color, pulse + 0.4);
      g.slice(tg.x, tg.y, tg.radius, base - half, base + half, false);
      g.strokePath();
    } else if (tg.shape === 'ring') {
      g.lineStyle(3, tg.color, 0.5 + pulse);
      g.strokeCircle(tg.x, tg.y, tg.radius * (0.55 + 0.45 * p));
      g.lineStyle(1, tg.color, 0.35);
      g.strokeCircle(tg.x, tg.y, tg.radius);
    } else {
      g.fillStyle(tg.color, 0.14);
      g.fillCircle(tg.x, tg.y, tg.radius);
      g.fillStyle(tg.color, 0.3);
      g.fillCircle(tg.x, tg.y, tg.radius * p); // expanding fill = countdown
      g.lineStyle(2, tg.color, 0.55 + pulse * 0.6);
      g.strokeCircle(tg.x, tg.y, tg.radius);

      // crosshair ticks so the centre is unmistakable
      g.lineStyle(2, tg.color, 0.8);
      for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const r0 = tg.radius - 10;
        g.beginPath();
        g.moveTo(tg.x + Math.cos(a) * r0, tg.y + Math.sin(a) * r0);
        g.lineTo(tg.x + Math.cos(a) * (tg.radius + 4), tg.y + Math.sin(a) * (tg.radius + 4));
        g.strokePath();
      }
    }

    if (tg.text) tg.text.setAlpha(0.7 + 0.3 * Math.sin(p * Math.PI * 8));
  }

  /** Flashing silhouette on the caster — impossible to miss. */
  #flashCaster(tg, dt) {
    const src = tg.source;
    if (!src?.sprite) return;
    tg.flashPhase += dt;
    const on = Math.floor(tg.flashPhase / 0.07) % 2 === 0;
    if (on) src.sprite.setTintFill(tg.color);
    else src.sprite.clearTint();
  }

  reset() {
    for (const tg of [...this.active]) {
      tg.finished = true;
      this.#dispose(tg);
    }
    this.active = [];
  }
}
