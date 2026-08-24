/**
 * FxSystem — juice. Damage numbers, sparks, screen shake, hitstop and impact
 * flashes (spec §5). Deliberately cheap: a handful of primitives, no extra art
 * required, so heavy attacks feel heavy without more frames.
 *
 * Every shape is plotted through PixelDraw rather than stroked, and every angle
 * is derived from the direction of the blow rather than from Math.random() —
 * smooth arcs and omnidirectional confetti are the two things that make an
 * effect look bolted onto pixel art instead of drawn for it.
 */

import { COLORS, COMBAT, DEPTH, GAME_H, GAME_W } from '../config.js';
import {
  GROUND_SQUASH, P, pxArc, pxDisc, pxGroundRing, pxLine, pxStar, snap,
} from '../art/PixelDraw.js';

/** Silkscreen is loaded before boot (see main.js) so canvas text measures right. */
const PIXEL_FONT = '"Silkscreen", ui-monospace, monospace';

/**
 * An arc in the air (so a true circle, not ground-squashed), mirrored about the
 * vertical axis when the swing comes from the other side.
 */
function swingArc(g, cx, cy, r, a0, a1, mirror) {
  pxArc(g, cx, cy, r, r, {
    from: mirror ? Math.PI - a1 : a0,
    to: mirror ? Math.PI - a0 : a1,
  });
}

export default class FxSystem {
  constructor(scene) {
    this.scene = scene;
    /** Multiplied into every gameplay dt — hitstop drops this to ~0 briefly. */
    this.timeScale = 1;
    this._hitstopUntil = 0;

    /**
     * Scorch marks, craters and blood burn into one shared canvas rather than
     * spawning a Graphics per hit: the floor accumulates a record of the fight
     * for the price of a single draw call, and nothing has to be tracked or
     * garbage-collected. Cleared per floor by `resetDecals`.
     */
    this.decals = scene.add.renderTexture(0, 0, GAME_W, GAME_H)
      .setOrigin(0, 0)
      .setDepth(DEPTH.floorDecal);
    /** Scratch pad for stamping into `decals`; never on the display list. */
    this._stamp = new Phaser.GameObjects.Graphics(scene);

    this.flashRect = scene.add.rectangle(GAME_W / 2, GAME_H / 2, GAME_W, GAME_H, 0xffffff)
      .setDepth(DEPTH.popup + 5)
      .setAlpha(0)
      .setScrollFactor(0);
  }

  /** Wipes the floor's damage. Called when a floor is (re)built. */
  resetDecals() {
    this.decals.clear();
  }

  /**
   * Burns a shape into the floor permanently.
   * @param {(g: Phaser.GameObjects.Graphics) => void} draw
   */
  #burn(draw) {
    this._stamp.clear();
    draw(this._stamp);
    this.decals.draw(this._stamp);
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

  /**
   * Floating damage number. Set in the pixel face rather than `monospace`, and
   * at a whole-pixel size, so the digits sit on the same grid as the sprites.
   * It rises in discrete hops for the same reason — a smooth tween of a bitmap
   * glyph re-samples it every frame.
   */
  damageNumber(x, y, amount, opts = {}) {
    let color = '#ffe9a8';
    let size = 8;
    let text = `${amount}`;

    if (opts.heal) { color = '#6bffb3'; text = `+${amount}`; }
    else if (opts.crit) { color = '#ff7a3d'; size = 12; text = `${amount}!`; }
    else if (opts.poison) color = '#8ee36b';

    const t = this.scene.add.text(snap(x), snap(y), text, {
      fontFamily: PIXEL_FONT,
      fontSize: `${size}px`,
      color,
      stroke: '#0b0912',
      strokeThickness: 4,
      resolution: 1,
    }).setOrigin(0.5).setDepth(DEPTH.popup);

    const rise = opts.crit ? 26 : 18;
    this.scene.tweens.addCounter({
      from: 0, to: 1,
      duration: opts.crit ? 700 : 520,
      ease: 'Quad.out',
      onUpdate: (tw) => {
        const p = tw.getValue();
        t.y = snap(y - rise * p);
        t.setAlpha(p > 0.6 ? 1 - (p - 0.6) / 0.4 : 1);
      },
      onComplete: () => t.destroy(),
    });
  }

  popText(x, y, message, color = COLORS.white) {
    const t = this.scene.add.text(snap(x), snap(y), message, {
      fontFamily: PIXEL_FONT,
      fontSize: '8px',
      color: `#${color.toString(16).padStart(6, '0')}`,
      stroke: '#0b0912',
      strokeThickness: 4,
      resolution: 1,
    }).setOrigin(0.5).setDepth(DEPTH.popup);

    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: 900, ease: 'Quad.out',
      onUpdate: (tw) => {
        const p = tw.getValue();
        t.y = snap(y - 16 * p);
        t.setAlpha(p > 0.55 ? 1 - (p - 0.55) / 0.45 : 1);
      },
      onComplete: () => t.destroy(),
    });
  }

  /**
   * Spark burst thrown along the line of the blow.
   *
   * `dir` is the direction the hit travelled, in radians. Sparks leave in a
   * cone around it, which is what sells the hit as having come *from* somewhere
   * — a full 360° scatter reads as an explosion no matter how small it is.
   */
  hitSpark(x, y, color = COLORS.dmgPhysical, count = 5, dir = null) {
    const base = dir ?? -Math.PI / 2;
    const spread = dir === null ? Math.PI * 2 : 1.5;

    // the impact flash itself: a hard star, on the grid
    const g = this.scene.add.graphics().setDepth(DEPTH.unitFx);
    g.fillStyle(0xffffff, 0.9);
    pxStar(g, x, y, P * 3);
    this.scene.tweens.add({
      targets: g, alpha: 0, duration: 110, onComplete: () => g.destroy(),
    });

    for (let i = 0; i < count; i++) {
      // fan the cone evenly instead of sampling it: an even fan reads as a
      // deliberate burst, random angles read as noise
      const a = base + ((i + 0.5) / count - 0.5) * spread;
      const d = 11 + (i % 3) * 6;
      const p = this.scene.add.image(snap(x), snap(y), 'px2')
        .setTint(color)
        .setDepth(DEPTH.unitFx);
      this.scene.tweens.add({
        targets: p,
        x: snap(x + Math.cos(a) * d),
        y: snap(y + Math.sin(a) * d),
        alpha: 0,
        duration: 170 + i * 22,
        ease: 'Quad.out',
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
    // an even fan of 12, not 12 random angles: the burst wants a silhouette
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const d = 16 + (i % 4) * 8;
      const p = this.scene.add.image(snap(x), snap(y), i % 2 ? 'px2' : 'px3')
        .setTint(color).setDepth(DEPTH.unitFx);
      this.scene.tweens.add({
        targets: p,
        x: snap(x + Math.cos(a) * d),
        y: snap(y + Math.sin(a) * d - 8),
        alpha: 0,
        duration: 380 + (i % 4) * 70,
        ease: 'Quad.out',
        onComplete: () => p.destroy(),
      });
    }
    // whatever died leaves a stain the floor keeps
    this.#burn((s) => {
      s.fillStyle(color, 0.13);
      pxDisc(s, snap(x), snap(y), 13, 13 * GROUND_SQUASH);
      s.fillStyle(0x000000, 0.18);
      pxDisc(s, snap(x), snap(y), 8, 8 * GROUND_SQUASH);
    });
    this.shake(0.003, 90);
  }

  /**
   * Expanding shockwave used by AoE resolutions and buffs.
   *
   * Squashed onto the ground plane and stepped in discrete radii: a shockwave
   * that grows by whole blocks reads as animation frames, where a smoothly
   * interpolated one reads as a tween.
   */
  ring(x, y, radius, color, ms = 320, thickness = 3) {
    const g = this.scene.add.graphics().setDepth(DEPTH.telegraphAir);
    const cx = snap(x);
    const cy = snap(y);
    const steps = 7;
    let last = -1;

    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: ms,
      onUpdate: (tw) => {
        const p = tw.getValue();
        const step = Math.floor(p * steps);
        if (step === last) return; // only redraw when the radius actually moves
        last = step;
        const r = radius * (0.35 + (step / steps) * 0.65);
        g.clear();
        g.fillStyle(color, 1 - p * 0.85);
        for (let k = 0; k < Math.max(1, Math.round(thickness / P)); k++) {
          pxGroundRing(g, cx, cy, r - k * P);
        }
      },
      onComplete: () => g.destroy(),
    });
  }

  /**
   * The summoning sigil discharging. The ward snaps inward, a star pops at the
   * centre, and the stone keeps a faint rune scar where the monster came
   * through — so a battlefield late in a fight shows where you committed.
   */
  summonBurst(x, y, color = COLORS.gridHover) {
    const cx = snap(x);
    const cy = snap(y);

    const g = this.scene.add.graphics().setDepth(DEPTH.gridMark);
    const steps = 6;
    let last = -1;
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: 260,
      onUpdate: (tw) => {
        const step = Math.floor(tw.getValue() * steps);
        if (step === last) return;
        last = step;
        const k = 1 - step / steps;
        g.clear();
        g.fillStyle(color, 0.35 + 0.55 * k);
        pxGroundRing(g, cx, cy, 6 + 22 * k, { dash: 3, gap: 2, rot: step });
        g.fillStyle(0xffffff, 0.9 * k);
        pxStar(g, cx, cy, P * (2 + step));
      },
      onComplete: () => g.destroy(),
    });

    // the scar left behind
    this.#burn((s) => {
      s.fillStyle(color, 0.12);
      pxGroundRing(s, cx, cy, 14, { dash: 2, gap: 3 });
      s.fillStyle(0x000000, 0.16);
      pxDisc(s, cx, cy, 8, 8 * GROUND_SQUASH);
    });
  }

  /**
   * A permanent mark where something heavy landed. Kept low-contrast: the floor
   * has to stay readable underneath units for the whole fight.
   */
  scorch(x, y, radius = 16, color = 0x000000) {
    const cx = snap(x);
    const cy = snap(y);
    this.#burn((s) => {
      s.fillStyle(color, 0.2);
      pxDisc(s, cx, cy, radius, radius * GROUND_SQUASH);
      s.fillStyle(color, 0.14);
      pxGroundRing(s, cx, cy, radius + P * 2, { dash: 3, gap: 4 });
      // radial cracks: three, so it reads as impact rather than as a stain
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 + 0.4;
        pxLine(s,
          cx + Math.cos(a) * radius, cy + Math.sin(a) * radius * GROUND_SQUASH,
          cx + Math.cos(a) * (radius + 9), cy + Math.sin(a) * (radius + 9) * GROUND_SQUASH);
      }
    });
  }

  /** Dust kicked up where a unit's foot lands. */
  footDust(x, y, facing = 1) {
    for (let i = 0; i < 2; i++) {
      const p = this.scene.add.image(snap(x), snap(y), 'px2')
        .setTint(0x9a8fb8)
        .setAlpha(0.5)
        .setDepth(DEPTH.unitFx);
      this.scene.tweens.add({
        targets: p,
        x: snap(x - facing * (5 + i * 5)),
        y: snap(y - 3 - i * 2),
        alpha: 0,
        duration: 260 + i * 90,
        onComplete: () => p.destroy(),
      });
    }
  }

  /**
   * Slash arc for the hero's melee swings. Three trailing arcs at shrinking
   * radii, each a frame behind the last — the pixel-art way to draw speed,
   * where a single stroked arc just looks like a curve.
   */
  slash(x, y, facing, color = COLORS.white) {
    const g = this.scene.add.graphics().setDepth(DEPTH.unitFx);
    const cx = snap(x);
    const cy = snap(y);
    const steps = 5;
    let last = -1;

    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: 170,
      onUpdate: (tw) => {
        const step = Math.floor(tw.getValue() * steps);
        if (step === last) return;
        last = step;
        const p = step / steps;
        g.clear();
        // sweep from above the shoulder down past the knee, on the facing side
        const mid = -0.55 + p * 1.1;
        for (let k = 0; k < 3; k++) {
          const r = 34 + p * 10 - k * 5;
          const a0 = (mid - 0.42 + k * 0.1) * Math.PI;
          const a1 = (mid + 0.18 - k * 0.06) * Math.PI;
          g.fillStyle(color, (1 - p) * (0.95 - k * 0.28));
          swingArc(g, cx, cy, r, a0, a1, facing < 0);
        }
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Dotted connector used to show the Sprite's alignment synergy. */
  alignmentHint(x1, y, x2, color = 0xeaf7c4) {
    const g = this.scene.add.graphics().setDepth(DEPTH.telegraphGround);
    g.fillStyle(color, 0.7);
    const from = Math.min(x1, x2);
    const to = Math.max(x1, x2);
    for (let x = from; x < to; x += P * 4) {
      g.fillRect(snap(x), snap(y), P * 2, P);
    }
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 400, onComplete: () => g.destroy() });
  }

  /** A compact, palette-led cast effect for monster abilities. */
  skillBurst(x, y, color, kind = 'arcane') {
    const g = this.scene.add.graphics().setDepth(DEPTH.unitFx);
    const cx = snap(x);
    const cy = snap(y);
    const rays = kind === 'explosion' ? 10 : 6;
    const max = kind === 'explosion' ? 34 : 25;
    let last = -1;
    this.scene.tweens.addCounter({
      from: 0, to: 1, duration: kind === 'explosion' ? 300 : 380,
      onUpdate: (tw) => {
        const p = tw.getValue();
        const step = Math.floor(p * 6);
        if (step === last) return;
        last = step;
        const r = 6 + max * p;
        g.clear();
        g.fillStyle(color, (1 - p) * 0.8);
        if (kind === 'rune') {
          pxGroundRing(g, cx, cy, r, { dash: 3, gap: 2, rot: step });
          pxGroundRing(g, cx, cy, Math.max(4, r - 8), { dash: 1, gap: 3, rot: -step });
        } else {
          for (let i = 0; i < rays; i++) {
            const a = (i / rays) * Math.PI * 2 + step * 0.08;
            pxLine(g, cx + Math.cos(a) * 4, cy + Math.sin(a) * 4,
              cx + Math.cos(a) * r, cy + Math.sin(a) * r);
          }
          pxStar(g, cx, cy, Math.max(P * 2, P * (4 - Math.floor(p * 2))));
        }
      },
      onComplete: () => g.destroy(),
    });
  }

  /** Brief afterimage/trail used for arrows, bombs and spectral strikes. */
  trail(x, y, color, angle = 0, length = 18) {
    const g = this.scene.add.graphics().setDepth(DEPTH.unitFx);
    g.fillStyle(color, 0.7);
    pxLine(g, x, y, x - Math.cos(angle) * length, y - Math.sin(angle) * length);
    this.scene.tweens.add({ targets: g, alpha: 0, duration: 150, onComplete: () => g.destroy() });
  }

  /** A faceted temporary ice barricade that reads as both cover and shield. */
  iceWall(x, y, facing, seconds) {
    const g = this.scene.add.graphics().setDepth(DEPTH.unitFx);
    const baseX = snap(x - facing * 20);
    const baseY = snap(y + 16);
    const draw = () => {
      g.clear();
      g.fillStyle(0x4f91bd, 0.82);
      g.fillRect(baseX - 20, baseY - 30, 40, 28);
      g.fillStyle(0x9cecff, 0.9);
      g.fillTriangle(baseX - 22, baseY - 30, baseX - 12, baseY - 47, baseX - 2, baseY - 30);
      g.fillTriangle(baseX - 4, baseY - 30, baseX + 5, baseY - 54, baseX + 14, baseY - 30);
      g.fillStyle(0xe5feff, 0.85);
      g.fillRect(baseX - 16, baseY - 25, 5, 17);
      g.fillRect(baseX + 4, baseY - 27, 5, 18);
      g.fillStyle(0x234d78, 0.7);
      g.fillRect(baseX - 1, baseY - 28, 3, 26);
    };
    draw();
    this.scene.tweens.add({
      targets: g, alpha: { from: 1, to: 0.62 }, duration: 320, yoyo: true, repeat: Math.max(0, Math.floor(seconds / 0.64) - 1),
    });
    this.scene.time.delayedCall(seconds * 1000, () => {
      this.scene.tweens.add({ targets: g, alpha: 0, y: g.y - 10, duration: 200, onComplete: () => g.destroy() });
    });
  }

  destroy() {
    this.flashRect?.destroy();
    this.decals?.destroy();
    this._stamp?.destroy();
  }
}
