/**
 * UltimateSystem — spec §4.1.
 *
 * The hero's energy bar fills both over time and from damage taken (both live
 * on Hero). This system decides when the ultimate is allowed to fire and, more
 * importantly, WHERE it lands: on the densest cluster of monsters. That makes
 * "don't bunch up" a real, learnable rule rather than a random punish.
 */

export default class UltimateSystem {
  constructor(scene) {
    this.scene = scene;
    this.casts = 0;
  }

  ready(hero) {
    if (!hero.alive || !hero.ultReady || hero.stunned) return false;
    // Never burn the ultimate on an empty board — Judgment has to read as a
    // punish for what the player put down, not as ambient background damage.
    return this.scene.monsters.some((m) => m.alive);
  }

  /**
   * Densest monster cluster within `radius`, as a world point.
   * Falls back to just in front of the hero when nothing is deployed.
   */
  pickTarget(hero, radius) {
    const alive = this.scene.monsters.filter((m) => m.alive);
    if (alive.length === 0) {
      return { x: hero.x - 120, y: hero.y, count: 0 };
    }

    let best = null;
    for (const anchor of alive) {
      const group = alive.filter(
        (m) => Phaser.Math.Distance.Between(anchor.x, anchor.y, m.x, m.y) <= radius,
      );
      // tie-break toward the group with the most total remaining HP
      const hp = group.reduce((s, m) => s + m.hp, 0);
      if (!best || group.length > best.group.length
        || (group.length === best.group.length && hp > best.hp)) {
        best = { group, hp };
      }
    }

    const cx = best.group.reduce((s, m) => s + m.x, 0) / best.group.length;
    const cy = best.group.reduce((s, m) => s + m.y, 0) / best.group.length;

    const b = this.scene.arenaBounds;
    return {
      x: Phaser.Math.Clamp(cx, b.x + 30, b.right - 30),
      y: Phaser.Math.Clamp(cy, b.y + 30, b.bottom - 20),
      count: best.group.length,
    };
  }

  consume(hero) {
    hero.energy = 0;
    this.casts++;
  }

  reset() {
    this.casts = 0;
  }
}
