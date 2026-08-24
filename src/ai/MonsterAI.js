/**
 * MonsterAI — steering and engagement per role (spec §2.3).
 *
 * The player never controls a monster after it lands, so each role's behaviour
 * has to be immediately readable on screen:
 *   Tank    closes and parks on top of the hero, soaking hits.
 *   Melee   charges in, and punishes a stationary hero with a dash.
 *   Ranged  deliberately holds OUTSIDE the hero aggro ring (its passive pays it
 *           to do exactly that).
 *   CC      kites at the edge of its own reach, spamming slows.
 *   Support drifts toward the ally that needs healing most, hanging well back.
 *
 * Deliberate design choice: monsters do NOT dodge hero telegraphs. The reaction
 * window belongs to the player (don't summon there / interrupt it) — automatic
 * dodging would make every telegraph toothless.
 */

import { ROLE } from '../data/monsters.js';

const SEPARATION_DIST = 20;
const SEPARATION_PUSH = 26;
const ARRIVE_EPS = 5;

export default class MonsterAI {
  constructor(scene) {
    this.scene = scene;
  }

  update(dt) {
    const { hero } = this.scene;
    const monsters = this.scene.monsters;

    for (const m of monsters) {
      if (!m.alive) continue;

      // Dashing / stunned monsters are not steered.
      if (m.dashing) { this.scene.skills.tickDash(m, dt); m.update(dt); continue; }
      if (m.stunned) { m.play('idle'); m.update(dt); continue; }

      if (!hero?.alive) {
        m.play('idle');
        this.#separate(m, monsters, dt);
        m.update(dt);
        continue;
      }

      m.facing = hero.x >= m.x ? 1 : -1;

      // melee active can pre-empt normal steering
      if (m.role === ROLE.MELEE && this.scene.skills.tryRecklessCharge(m, hero)) {
        m.update(dt);
        continue;
      }

      const desired = this.#desiredDistance(m, hero);
      const dist = m.distanceTo(hero);
      const inRange = dist <= m.def.range;

      // ── attack if able ──
      if (inRange && m.tickAttack(dt)) {
        this.scene.skills.performAttack(m, hero);
      }

      // ── move toward the role's preferred standoff ──
      const delta = dist - desired;
      if (Math.abs(delta) > ARRIVE_EPS) {
        this.#stepToward(m, hero, delta > 0 ? 1 : -1, dt);
        if (!m.animLocked) m.play('move');
      } else if (m.role === ROLE.SUPPORT) {
        this.#supportDrift(m, dt);
      } else if (!m.animLocked) {
        m.play('idle');
      }

      this.#separate(m, monsters, dt);
      m.update(dt);
    }
  }

  /** Role-specific standoff distance from the hero. */
  #desiredDistance(m, hero) {
    switch (m.role) {
      case ROLE.TANK:
        // parks inside the hero's face to absorb basic attacks
        return Math.max(hero.hitRadius + 14, m.def.range * 0.6);

      case ROLE.MELEE:
        return Math.max(hero.hitRadius + 10, m.def.range * 0.7);

      case ROLE.RANGED:
        // stay outside the aggro ring but inside our own range
        return Phaser.Math.Clamp(
          hero.aggroRadius + 24,
          hero.aggroRadius + 24,
          m.def.range * 0.95,
        );

      case ROLE.CC:
        // hover at the edge of our reach — accepts some risk to keep slowing
        return m.def.range * 0.92;

      case ROLE.SUPPORT:
        // hang well back; healing is the job, poking is incidental
        return Math.max(hero.aggroRadius + 60, m.def.range * 0.95);

      default:
        return m.def.range * 0.8;
    }
  }

  #stepToward(m, hero, sign, dt) {
    const a = Math.atan2(hero.y - m.y, hero.x - m.x);
    const step = m.speed * dt * sign;
    const nx = m.x + Math.cos(a) * step;
    const ny = m.y + Math.sin(a) * step;

    const b = this.scene.arenaBounds;
    m.x = Phaser.Math.Clamp(nx, b.x + 14, b.right - 14);
    m.y = Phaser.Math.Clamp(ny, b.y + 22, b.bottom - 8);
  }

  /** Support: drift toward whichever ally is hurt worst. */
  #supportDrift(m, dt) {
    let worst = null;
    for (const other of this.scene.monsters) {
      if (!other.alive || other === m) continue;
      if (other.hpPct >= 0.95) continue;
      if (!worst || other.hpPct < worst.hpPct) worst = other;
    }
    if (!worst) { if (!m.animLocked) m.play('idle'); return; }

    const d = Phaser.Math.Distance.Between(m.x, m.y, worst.x, worst.y);
    if (d < 70) { if (!m.animLocked) m.play('idle'); return; }

    const a = Math.atan2(worst.y - m.y, worst.x - m.x);
    const b = this.scene.arenaBounds;
    m.x = Phaser.Math.Clamp(m.x + Math.cos(a) * m.speed * dt * 0.8, b.x + 14, b.right - 14);
    m.y = Phaser.Math.Clamp(m.y + Math.sin(a) * m.speed * dt * 0.8, b.y + 22, b.bottom - 8);
    if (!m.animLocked) m.play('move');
  }

  /** Soft repulsion so stacked monsters stay individually readable. */
  #separate(m, all, dt) {
    for (const other of all) {
      if (other === m || !other.alive) continue;
      const dx = m.x - other.x;
      const dy = m.y - other.y;
      const d = Math.hypot(dx, dy);
      if (d > SEPARATION_DIST || d === 0) continue;
      const push = (1 - d / SEPARATION_DIST) * SEPARATION_PUSH * dt;
      m.x += (dx / d) * push;
      m.y += (dy / d) * push;
    }
    const b = this.scene.arenaBounds;
    m.x = Phaser.Math.Clamp(m.x, b.x + 14, b.right - 14);
    m.y = Phaser.Math.Clamp(m.y, b.y + 22, b.bottom - 8);
  }
}
