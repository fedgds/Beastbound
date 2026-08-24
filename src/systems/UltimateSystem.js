/**
 * UltimateSystem — special-target selection.
 *
 * It decides WHERE the rare Judgment lands: on the densest cluster of
 * monsters. That makes
 * "don't bunch up" a real, learnable rule rather than a random punish.
 */

export default class UltimateSystem {
  constructor(scene) {
    this.scene = scene;
    this.casts = 0;
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

  reset() {
    this.casts = 0;
  }
}
