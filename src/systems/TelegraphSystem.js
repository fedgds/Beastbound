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
import { pxArc, pxCone, pxDisc, pxLine, snap } from '../art/PixelDraw.js';
import { PIXEL_FONT } from './FxSystem.js';

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
      // Multi-zone skills (Blizzard) roll every centre at wind-up. Keeping
      // them on one telegraph makes interrupt/cancel resolve atomically.
      spots: cfg.spots?.length ? cfg.spots : [{ x: cfg.x, y: cfg.y }],
      facing: cfg.facing ?? -1,
      heavy: !!cfg.heavy,
      onComplete: cfg.onComplete,
      onCancel: cfg.onCancel,
      cancelled: false,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      flashPhase: 0,
    };

    // Set in the pixel face at a whole-pixel size, like every other bit of text
    // in the game. Deliberately not tweened: scaling a bitmap glyph up from 0.7
    // re-samples it every frame, which is exactly what the pixel font avoids.
    tg.text = this.scene.add.text(snap(tg.x), snap(tg.y - 74), tg.label, {
      fontFamily: PIXEL_FONT,
      fontSize: tg.heavy ? '16px' : '8px',
      color: `#${color.toString(16).padStart(6, '0')}`,
      stroke: '#0b0912',
      strokeThickness: 4,
      resolution: 1,
    }).setOrigin(0.5).setDepth(DEPTH.popup);

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
      return t.spots.some((spot) => {
        const d = Phaser.Math.Distance.Between(x, y, spot.x, spot.y);
        if (d > t.radius) return false;
        if (t.shape !== 'cone') return true;
        const half = Phaser.Math.DegToRad(t.arc) / 2;
        const base = t.facing < 0 ? Math.PI : 0;
        const a = Math.atan2(y - spot.y, x - spot.x);
        return Math.abs(Phaser.Math.Angle.Wrap(a - base)) <= half;
      });
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
    // stops touching it. Destroyed outright rather than faded — a tween would
    // ride real RAF (so the label would outlive the floor whenever the sim is
    // stepped manually), and the effect's own flash lands on the same frame.
    const label = tg.text;
    tg.text = null;
    label?.destroy();
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

  /**
   * Ground indicator: filled area + a sweep that shows time remaining.
   *
   * Every shape is rasterised onto the P lattice instead of stroked. An
   * anti-aliased circle under pixel-art sprites is the single loudest tell that
   * an overlay wasn't drawn for the game. The circles are *true* circles
   * (rx === ry), deliberately not ground-squashed: combat resolves on plain
   * distance, so the drawn area has to be the area that actually gets hit.
   */
  #draw(tg, p) {
    const g = tg.gfx;
    g.clear();

    const pulse = 0.35 + 0.25 * Math.sin(p * Math.PI * 6);
    const r = tg.radius;

    for (const spot of tg.spots) {
      const x = snap(spot.x);
      const y = snap(spot.y);

      if (tg.shape === 'cone') {
        const half = Phaser.Math.DegToRad(tg.arc) / 2;
        const base = tg.facing < 0 ? Math.PI : 0;

        // hatched full extent, then a solid wedge that fills as the cast charges
        g.fillStyle(tg.color, 0.22);
        pxCone(g, x, y, r, half, tg.facing, { every: 2 });
        g.fillStyle(tg.color, 0.4);
        pxCone(g, x, y, r * p, half, tg.facing);

        // rim + the two edges, so the exact boundary is unambiguous
        g.fillStyle(tg.color, Math.min(1, pulse + 0.45));
        pxArc(g, x, y, r, r, { from: base - half, to: base + half });
        for (const s of [-1, 1]) {
          const a = base + s * half;
          pxLine(g, x, y, x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
      } else if (tg.shape === 'ring') {
        const rr = r * (0.55 + 0.45 * p);
        g.fillStyle(tg.color, Math.min(1, 0.5 + pulse));
        pxArc(g, x, y, rr, rr, { dash: 5, gap: 3, rot: p * 4 });
        g.fillStyle(tg.color, 0.35);
        pxArc(g, x, y, r, r, { dash: 2, gap: 4 });
      } else {
        g.fillStyle(tg.color, 0.16);
        pxDisc(g, x, y, r, r, { every: 2 });
        g.fillStyle(tg.color, 0.32);
        pxDisc(g, x, y, r * p, r * p); // expanding fill = countdown
        g.fillStyle(tg.color, Math.min(1, 0.55 + pulse * 0.6));
        pxArc(g, x, y, r, r);

        // crosshair ticks so the centre is unmistakable
        g.fillStyle(tg.color, 0.85);
        for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          const r0 = r - 10;
          pxLine(g,
            x + Math.cos(a) * r0, y + Math.sin(a) * r0,
            x + Math.cos(a) * (r + 4), y + Math.sin(a) * (r + 4));
        }
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
