/**
 * FxSystem — juice. Damage numbers, sparks, screen shake, hitstop and impact
 * flashes (spec §5). Deliberately cheap: a handful of tweened primitives, no
 * extra art required, so heavy attacks feel heavy without more frames.
 */

import { COLORS, COMBAT, DEPTH, GAME_H, GAME_W } from '../config.js';

export default class FxSystem {
  constructor(scene) {
    this.scene = scene;
    /** Multiplied into every gameplay dt — hitstop drops this to ~0 briefly. */
    this.timeScale = 1;
    this._hitstopUntil = 0;

    this.flashRect = scene.add.rectangle(GAME_W / 2, GAME_H / 2, GAME_W, GAME_H, 0xffffff)
      .setDepth(DEPTH.popup + 5)
      .setAlpha(0)
      .setScrollFactor(0);
  }

  update(realDt) {
    if (this._hitstopUntil > 0) {
      this._hitstopUntil -= realDt;
      this.timeScale = this._hitstopUntil > 0 ? 0.04 : 1;
    } else {
      this.timeScale = 1;
    }
  }

  /** Very short freeze that makes an impact land (spec §5). */
  hitstop(ms = COMBAT.hitstopMs) {
    this._hitstopUntil = Math.max(this._hitstopUntil, ms / 1000);
  }

  shake(intensity = 0.004, duration = 120) {
    this.scene.cameras.main.shake(duration, intensity);
  }

  screenFlash(color = 0xffffff, alpha = 0.35, ms = 90) {
    this.flashRect.setFillStyle(color);
    this.flashRect.setAlpha(alpha);
    this.scene.tweens.add({ targets: this.flashRect, alpha: 0, duration: ms });
  }

  /** Big-hit package: flash + shake + hitstop together. */
  impact({ color = COLORS.tgDamage, shake = 0.008, flash = 0.3, stop = 90 } = {}) {
    this.screenFlash(color, flash, 110);
    this.shake(shake, 180);
    this.hitstop(stop);
  }

  damageNumber(x, y, amount, opts = {}) {
    let color = '#ffe9a8';
    let size = 11;
    let text = `${amount}`;

    if (opts.heal) { color = '#6bffb3'; text = `+${amount}`; }
    else if (opts.crit) { color = '#ff7a3d'; size = 14; text = `${amount}!`; }
    else if (opts.poison) color = '#8ee36b';

    const t = this.scene.add.text(x, y, text, {
      fontFamily: 'monospace',
      fontSize: `${size}px`,
      color,
      stroke: '#0b0912',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(DEPTH.popup);

    this.scene.tweens.add({
      targets: t,
      y: y - (opts.crit ? 26 : 18),
      alpha: 0,
      duration: opts.crit ? 700 : 520,
      ease: 'Quad.out',
      onComplete: () => t.destroy(),
    });
  }

  popText(x, y, message, color = COLORS.white) {
    const t = this.scene.add.text(x, y, message, {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: `#${color.toString(16).padStart(6, '0')}`,
      stroke: '#0b0912',
      strokeThickness: 3,
    }).setOrigin(0.5).setDepth(DEPTH.popup);

    this.scene.tweens.add({
      targets: t,
      y: y - 16,
      alpha: 0,
      duration: 900,
      ease: 'Quad.out',
      onComplete: () => t.destroy(),
    });
  }

  /** Small directional spark burst on every hit. */
  hitSpark(x, y, color = COLORS.dmgPhysical, count = 5) {
    for (let i = 0; i < count; i++) {
      const p = this.scene.add.image(x, y, 'px2')
        .setTint(color)
        .setDepth(DEPTH.unitFx);
      const a = Math.random() * Math.PI * 2;
      const d = 10 + Math.random() * 16;
      this.scene.tweens.add({
        targets: p,
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d,
        alpha: 0,
        scale: 0.3,
        duration: 200 + Math.random() * 160,
        onComplete: () => p.destroy(),
      });
    }
  }

  puff(x, y, color = 0xffffff) {
    for (let i = 0; i < 7; i++) {
      const p = this.scene.add.image(x, y, 'px3')
        .setTint(color).setAlpha(0.8).setDepth(DEPTH.unitFx);
      const a = Math.random() * Math.PI * 2;
      this.scene.tweens.add({
        targets: p,
        x: x + Math.cos(a) * (12 + Math.random() * 14),
        y: y - 4 - Math.random() * 16,
        alpha: 0,
        scale: 0.2,
        duration: 320 + Math.random() * 200,
        onComplete: () => p.destroy(),
      });
    }
  }

  deathBurst(x, y, color = 0xffffff) {
    for (let i = 0; i < 12; i++) {
      const p = this.scene.add.image(x, y, i % 2 ? 'px2' : 'px3')
        .setTint(color).setDepth(DEPTH.unitFx);
      const a = Math.random() * Math.PI * 2;
      const d = 16 + Math.random() * 26;
      this.scene.tweens.add({
        targets: p,
        x: x + Math.cos(a) * d,
        y: y + Math.sin(a) * d - 8,
        alpha: 0,
        scale: 0.2,
        angle: Math.random() * 180,
        duration: 380 + Math.random() * 260,
        ease: 'Quad.out',
        onComplete: () => p.destroy(),
      });
    }
    this.shake(0.003, 90);
  }

  /** Expanding ring used by AoE resolutions and buffs. */
  ring(x, y, radius, color, ms = 320, thickness = 3) {
    const g = this.scene.add.graphics().setDepth(DEPTH.telegraphAir);
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: ms,
      onUpdate: (tw) => {
        const p = tw.getValue();
        g.clear();
        g.lineStyle(thickness, color, 1 - p);
        g.strokeCircle(x, y, radius * (0.35 + p * 0.65));
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Slash arc for the hero's melee swings. */
  slash(x, y, facing, color = COLORS.white) {
    const g = this.scene.add.graphics().setDepth(DEPTH.unitFx);
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: 180,
      onUpdate: (tw) => {
        const p = tw.getValue();
        g.clear();
        g.lineStyle(3, color, 1 - p);
        g.beginPath();
        g.arc(x, y, 30 + p * 12, (-0.7 + p * 0.4) * Math.PI, (0.3 + p * 0.4) * Math.PI, facing < 0);
        g.strokePath();
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Dotted connector used to show the Sprite's alignment synergy. */
  alignmentHint(x1, y, x2, color = 0xeaf7c4) {
    const g = this.scene.add.graphics().setDepth(DEPTH.telegraphGround);
    g.lineStyle(1, color, 0.7);
    for (let x = Math.min(x1, x2); x < Math.max(x1, x2); x += 8) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + 4, y);
      g.strokePath();
    }
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 400, onComplete: () => g.destroy() });
  }

  destroy() {
    this.flashRect?.destroy();
  }
}
