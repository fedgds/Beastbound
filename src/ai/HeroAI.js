/**
 * HeroAI — pattern-based boss behaviour (spec §4).
 *
 * State machine:
 *   IDLE ─▶ APPROACH ─▶ BASIC ─▶ RECOVER ─┐
 *     └──▶ TELEGRAPH ─▶ CAST ─▶ RECOVER ──┘
 *
 * The hard rule: a powerful skill NEVER resolves without first completing a
 * telegraph. The hero also stands perfectly still while winding up, which both
 * reads clearly and feeds the Goblin Brute's "hero held still" dash trigger.
 */

import { HERO_STATE } from '../data/heroes.js';
import { COLORS } from '../config.js';

export default class HeroAI {
  constructor(scene) {
    this.scene = scene;
  }

  update(dt) {
    const { hero } = this.scene;
    if (!hero?.alive) return;

    this.#trackStationary(hero, dt);

    if (hero.stunned) {
      if (!hero.animLocked) hero.play('idle');
      return;
    }

    switch (hero.state) {
      case HERO_STATE.TELEGRAPH:
        // Hold still; TelegraphSystem drives completion/cancellation.
        break;

      case HERO_STATE.CAST:
        if (hero.stateExpired) hero.setState(HERO_STATE.RECOVER, hero.pendingRecover ?? 0.3);
        break;

      case HERO_STATE.RECOVER:
        if (!hero.animLocked) hero.play('idle');
        if (hero.stateExpired) hero.setState(HERO_STATE.IDLE);
        break;

      case HERO_STATE.BASIC:
        if (hero.stateExpired) this.#resolveBasic(hero);
        break;

      default:
        this.#decide(hero, dt);
        break;
    }
  }

  #trackStationary(hero, dt) {
    const moved = Math.abs(hero.x - (hero._prevX ?? hero.x)) > 0.4
      || Math.abs(hero.y - (hero._prevY ?? hero.y)) > 0.4;
    hero.stationaryFor = moved ? 0 : hero.stationaryFor + dt;
    hero._prevX = hero.x;
    hero._prevY = hero.y;
  }

  // ═══ decision layer ══════════════════════════════════════════════════════
  #decide(hero, dt) {
    const target = this.#pickTarget(hero);
    hero.target = target;

    // 1) ultimate outranks everything
    if (this.scene.ultimate.ready(hero)) {
      this.#startUltimate(hero);
      return;
    }

    // 2) conditional skills, highest priority first
    const skill = this.#pickSkill(hero, dt);
    if (skill) {
      this.#startSkill(hero, skill);
      return;
    }

    // 3) basic attack
    if (target) {
      hero.facing = target.x >= hero.x ? 1 : -1;
      const dist = hero.distanceTo(target);

      if (dist <= hero.basicRange) {
        hero.basicCooldown -= dt;
        if (hero.basicCooldown <= 0) {
          hero.basicTarget = target;
          hero.setState(HERO_STATE.BASIC, hero.def.basicWindup);
          hero.playFor('windup', hero.def.basicWindup);
          return;
        }
        if (!hero.animLocked) hero.play('idle');
        return;
      }

      // 4) approach anything inside the aggro ring
      if (dist <= hero.aggroRadius * 2.6) {
        this.#moveToward(hero, target.x, target.y, dt);
        if (!hero.animLocked) hero.play('move');
        return;
      }
    }

    this.#patrol(hero, dt);
  }

  /** Taunt overrides everything, otherwise the closest living monster. */
  #pickTarget(hero) {
    const taunted = hero.tauntTarget;
    if (taunted) return taunted;

    let best = null;
    let bestD = Infinity;
    for (const m of this.scene.monsters) {
      if (!m.alive) continue;
      const d = hero.distanceTo(m);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  /** Evaluates each unlocked skill's trigger; returns the highest priority hit. */
  #pickSkill(hero, dt) {
    const candidates = [];

    for (const skill of hero.skills) {
      if (!hero.skillReady(skill)) continue;
      if (this.#triggerMet(hero, skill, dt)) candidates.push(skill);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return candidates[0];
  }

  #triggerMet(hero, skill, dt) {
    const t = skill.trigger;
    const key = skill.id;

    switch (t.type) {
      // "a monster has been in my face for N seconds"
      case 'nearbyFor': {
        const near = this.#countWithin(hero, t.radius);
        hero.triggerTimers[key] = near > 0 ? (hero.triggerTimers[key] ?? 0) + dt : 0;
        return hero.triggerTimers[key] >= t.seconds;
      }

      // "I'm surrounded" — punishes clustering (spec §4.1)
      case 'crowd':
        return this.#countWithin(hero, t.radius) >= t.count;

      case 'hpBelow':
        return hero.hpPct < t.pct;

      default:
        return false;
    }
  }

  #countWithin(hero, radius) {
    let n = 0;
    for (const m of this.scene.monsters) {
      if (m.alive && hero.distanceTo(m) <= radius) n++;
    }
    return n;
  }

  // ═══ skill / ultimate launch ═════════════════════════════════════════════
  #startSkill(hero, skill) {
    const tg = skill.telegraph;
    hero.putOnCd(skill);
    hero.triggerTimers[skill.id] = 0;
    hero.pendingSkill = skill;
    hero.pendingRecover = skill.recover;

    // Ground position is fixed at wind-up time — the telegraph never chases.
    const ctx = { x: hero.x, y: hero.y - 10, facing: hero.facing };

    hero.setState(HERO_STATE.TELEGRAPH, tg.duration + 2);
    hero.playFor('windup', tg.duration);

    this.scene.telegraph.begin({
      ...tg,
      source: hero,
      x: ctx.x,
      y: ctx.y,
      facing: ctx.facing,
      onComplete: () => this.#resolveSkill(hero, skill, ctx),
      onCancel: () => this.#onCancelled(hero, skill),
    });
  }

  #startUltimate(hero) {
    const ult = hero.def.ultimate;
    const tg = ult.telegraph;
    const spot = this.scene.ultimate.pickTarget(hero, tg.radius * 0.55);

    // Energy is spent the moment the wind-up starts: interrupting the ultimate
    // deletes it entirely, which is the biggest payoff for a well-timed Toad.
    this.scene.ultimate.consume(hero);

    hero.pendingSkill = ult;
    hero.pendingRecover = ult.recover;

    const ctx = { x: spot.x, y: spot.y, facing: spot.x >= hero.x ? 1 : -1 };
    hero.facing = ctx.facing;

    hero.setState(HERO_STATE.TELEGRAPH, tg.duration + 2);
    hero.playFor('windup', tg.duration);

    this.scene.ui?.flashHint('JUDGMENT incoming — spread out or silence it!');

    this.scene.telegraph.begin({
      ...tg,
      source: hero,
      x: ctx.x,
      y: ctx.y,
      facing: ctx.facing,
      onComplete: () => this.#resolveSkill(hero, ult, ctx),
      onCancel: () => this.#onCancelled(hero, ult),
    });
  }

  #resolveSkill(hero, skill, ctx) {
    if (!hero.alive) return;
    hero.play('attack', true);
    hero.setState(HERO_STATE.CAST, 0.14);
    this.scene.skills.executeHeroEffect(hero, skill, ctx);
    hero.pendingSkill = null;
  }

  #onCancelled(hero, skill) {
    if (!hero.alive) return;
    hero.pendingSkill = null;
    hero.play('hit', true);
    // Interrupting leaves the hero staggered — the reward for a correct read.
    hero.setState(HERO_STATE.RECOVER, 0.9);
    if (skill.cooldown) {
      hero.skillCd[skill.id] = this.scene.clock + skill.cooldown * 0.6;
    }
    this.scene.fx.popText(hero.x, hero.y - 92, `${skill.name} CANCELLED`, COLORS.tgControl);
  }

  #resolveBasic(hero) {
    const target = hero.basicTarget;
    hero.basicCooldown = hero.def.basicInterval;
    hero.setState(HERO_STATE.RECOVER, 0.16);
    hero.play('attack', true);

    if (!target?.alive || hero.distanceTo(target) > hero.basicRange + 14) {
      this.scene.fx.slash(hero.x + hero.facing * 22, hero.y - 26, hero.facing, 0x9fb6d8);
      return;
    }

    this.scene.fx.slash(hero.x + hero.facing * 22, hero.y - 26, hero.facing, COLORS.white);
    this.scene.combat.strike(hero, target, { knockback: 8 });
    this.scene.fx.hitstop(35);
  }

  // ═══ movement ════════════════════════════════════════════════════════════
  #moveToward(hero, tx, ty, dt) {
    const a = Math.atan2(ty - hero.y, tx - hero.x);
    // Chasing uses the full arena, not the guard post — otherwise a back-line
    // Support parked past the hero's left bound would stalemate the floor.
    const b = hero.moveBounds();
    hero.x = Phaser.Math.Clamp(hero.x + Math.cos(a) * hero.speed * dt, b.x, b.right);
    hero.y = Phaser.Math.Clamp(hero.y + Math.sin(a) * hero.speed * dt, b.y + 30, b.bottom - 10);
  }

  /** Slow sweep across the guard post when nothing is deployed. If the hero
   *  chased out of the post it walks back rather than snapping. */
  #patrol(hero, dt) {
    const b = hero.patrolBounds();

    if (hero.x < b.x) {
      hero.x = Math.min(b.x, hero.x + hero.speed * 0.8 * dt);
      hero.facing = 1;
      if (!hero.animLocked) hero.play('move');
      return;
    }

    hero.x += hero.patrolDir * hero.speed * 0.45 * dt;
    if (hero.x > b.right - 20) { hero.x = b.right - 20; hero.patrolDir = -1; }
    if (hero.x < b.x + 20) { hero.x = b.x + 20; hero.patrolDir = 1; }
    hero.facing = -1;
    if (!hero.animLocked) hero.play('move');
  }
}
