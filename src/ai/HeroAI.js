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

    // A move is selected only on a timed beat. Regular skills are the default;
    // Judgment is a deliberately rare roll rather than a mana-funded certainty.
    const skill = this.#pickSkill(hero);
    if (skill) {
      if (skill.id === hero.def.ultimate.id) this.#startUltimate(hero);
      else this.#startSkill(hero, skill);
      return;
    }

    // Basic attacks fill the space between timed skill rolls.
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

  /** Rolls one action at a time. The special's 14% weight is lower than the
   * combined normal-skill weight, and its own cooldown prevents streaks. */
  #pickSkill(hero) {
    if (this.scene.clock < hero.nextSkillAt) return null;

    const cadence = hero.def.skillInterval;
    hero.nextSkillAt = this.scene.clock + Phaser.Math.FloatBetween(cadence.min, cadence.max);

    if (!this.scene.monsters.some((m) => m.alive)) return null;

    const special = hero.def.ultimate;
    if (hero.skillReady(special) && Math.random() < hero.def.specialChance) return special;

    const regular = hero.skills.filter((skill) => hero.skillReady(skill));
    if (!regular.length) return null;
    // Honour the trigger blocks in heroes.js: a self-centred nova fired into an
    // empty arena, or a crowd-clear with nothing crowded, wastes the cadence and
    // reads as the boss flailing. Prefer skills whose trigger is satisfied, but
    // never stall — if the filter empties the list, fall back to the full set so
    // a move still comes out on the beat.
    const wanted = regular.filter((skill) => this.#triggerSatisfied(hero, skill));
    return Phaser.Utils.Array.GetRandom(wanted.length ? wanted : regular);
  }

  /** True when a skill's `crowd` / `nearbyFor` trigger currently holds. Skills
   *  with no trigger (or one we don't gate on) always pass. */
  #triggerSatisfied(hero, skill) {
    const trig = skill.trigger;
    if (!trig) return true;
    const monsters = this.scene.monsters;
    if (trig.type === 'crowd') {
      const near = monsters.filter((m) => m.alive
        && hero.distanceTo(m) <= trig.radius).length;
      return near >= (trig.count ?? 1);
    }
    if (trig.type === 'nearbyFor') {
      return monsters.some((m) => m.alive && hero.distanceTo(m) <= trig.radius);
    }
    return true;
  }

  // ═══ skill / ultimate launch ═════════════════════════════════════════════
  #startSkill(hero, skill) {
    const tg = skill.telegraph;
    hero.putOnCd(skill);
    hero.triggerTimers[skill.id] = 0;
    hero.pendingSkill = skill;
    hero.pendingRecover = skill.recover;

    // Face the commitment before the telegraph is built. #decide sets facing
    // from the target only on the basic-attack path, so without this a cone
    // captures last beat's facing and points the wrong way.
    if (tg.aimAtCluster) {
      // A long line wants the pack, not the nearest straggler — reuse the
      // ultimate's cluster finder so the beam lands where bodies actually are.
      const spot = this.scene.ultimate.pickTarget(hero, (tg.radius ?? 200) * 0.5);
      hero.facing = spot.x >= hero.x ? 1 : -1;
    } else if (hero.target) {
      hero.facing = hero.target.x >= hero.x ? 1 : -1;
    }

    // Ground position is fixed at wind-up time — the telegraph never chases.
    const ctx = { x: hero.x, y: hero.y - 10, facing: hero.facing };
    if (skill.effect?.type === 'blizzard') ctx.spots = this.#blizzardSpots(skill.effect.storms);

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

    hero.putOnCd(ult);

    hero.pendingSkill = ult;
    hero.pendingRecover = ult.recover;

    const ctx = { x: spot.x, y: spot.y, facing: spot.x >= hero.x ? 1 : -1 };
    if (ult.effect?.type === 'blizzard') ctx.spots = this.#blizzardSpots(ult.effect.storms);
    hero.facing = ctx.facing;

    hero.setState(HERO_STATE.TELEGRAPH, tg.duration + 2);
    hero.playFor('windup', tg.duration);

    this.scene.ui?.flashHint(`RARE ${ult.name.toUpperCase()} — spread out or silence it!`);

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
    this.scene.audio?.playSkill(hero);

    if (!target?.alive || hero.distanceTo(target) > hero.basicRange + 14) {
      this.scene.fx.slash(hero.x + hero.facing * 22, hero.y - 26, hero.facing, 0x9fb6d8);
      return;
    }

    if (hero.def.basicProjectile) {
      const shard = hero.def.basicProjectile;
      this.scene.combat.fireProjectile(hero, target, {
        texture: shard.texture,
        speed: shard.speed,
        tint: 0xbff8ff,
        trailColor: 0x91eaff,
        trailLength: 20,
        onHit: (hit) => {
          this.scene.combat.strike(hero, hit, { color: 0x9cecff });
          hit.applySlow(shard.slowMult, shard.slowSeconds);
          this.scene.fx.skillBurst(hit.x, hit.y - hit.spriteHeight * 0.5, 0xa9f5ff, 'arcane');
        },
      });
      return;
    }

    this.scene.fx.slash(hero.x + hero.facing * 22, hero.y - 26, hero.facing, COLORS.white);
    this.scene.combat.strike(hero, target, { knockback: 8 });
    this.scene.fx.hitstop(35);
  }

  /** Three fixed random storm centres: the warning resolves into real terrain. */
  #blizzardSpots(count = 3) {
    const b = this.scene.arenaBounds;
    return Array.from({ length: count }, () => ({
      x: Phaser.Math.Between(b.x + 110, b.right - 110),
      y: Phaser.Math.Between(b.y + 85, b.bottom - 55),
    }));
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
