/**
 * SkillSystem — every trigger-based ability in the game (spec §3).
 *
 * Monster skills are NEVER player-activated. Passives (Skill 1) evaluate from
 * simple, visually readable conditions; actives (Skill 2) fire off cooldowns or
 * combat conditions. AI decides *when* to attack; this module decides *what*
 * that attack does, so all skill behaviour stays in one place.
 *
 * It also executes the hero's skill effects once their telegraph completes.
 */

import { COLORS, DEPTH, TELEGRAPH_KIND } from '../config.js';
import { ROLE } from '../data/monsters.js';

const BLOOM_INTERVAL = 2.0;
const BLOOM_HEAL = 6;
const BLOOM_RADIUS = 120;

const DASH_DELAY = 0.09; // wind-up before the monster actually launches
const DASH_TIME = 0.26;
const DASH_SPARK_EVERY = 0.04;

export default class SkillSystem {
  constructor(scene) {
    this.scene = scene;
    this.log = [];
  }

  // ═══ monster skill 2 — "on summon" triggers ══════════════════════════════
  onMonsterSummoned(monster) {
    const active = monster.def.active;
    if (!active) return;

    switch (active.id) {
      // Tank: taunt and pull aggro the moment it lands (spec §3.2).
      case 'provoke': {
        this.scene.hero?.applyTaunt(monster, 3);
        this.scene.fx.ring(monster.x, monster.y, 60, COLORS.tgControl, 380, 2);
        this.announce(monster, 'PROVOKE', COLORS.tgControl);
        break;
      }
      // Support: team-wide ATK buff on arrival.
      case 'radiantBloom': {
        for (const m of this.scene.monsters) {
          if (m.alive) {
            m.applyAtkBuff(1.25, 8);
            this.scene.fx.ring(m.x, m.y, 26, COLORS.tgBuff, 320, 2);
          }
        }
        this.announce(monster, '+25% TEAM ATK', COLORS.tgBuff);
        break;
      }
      default:
        break;
    }
  }

  announce(unit, text, color) {
    this.scene.fx.popText(unit.x, unit.y - unit.spriteHeight - 10, text, color);
  }

  // ═══ per-frame passive / active evaluation ═══════════════════════════════
  update(dt) {
    const { hero } = this.scene;

    for (const m of this.scene.monsters) {
      if (!m.alive) continue;

      this.#tickStoneSkin(m);
      this.#tickSnipersFocus(m, hero);
      this.#tickBloom(m, dt);
      this.#tickCroak(m, hero);
    }
  }

  /** Tank passive: heavy damage reduction once badly hurt. */
  #tickStoneSkin(m) {
    if (m.def.passive?.id !== 'stoneSkin') return;
    const on = m.hpPct < 0.4;
    m.status.drMult = on ? 0.6 : 1;
    m.setBarrier(on);
    if (on && !m._stoneSkinAnnounced) {
      m._stoneSkinAnnounced = true;
      this.announce(m, 'STONE SKIN', COLORS.shield);
    }
  }

  /** Ranged passive: rewarded for holding position outside the aggro ring. */
  #tickSnipersFocus(m, hero) {
    if (m.def.passive?.id !== 'snipersFocus') return;
    const safe = hero?.alive
      ? Phaser.Math.Distance.Between(m.x, m.y, hero.x, hero.y) > hero.aggroRadius
      : true;
    m._focusActive = safe;
    if (safe) m.sprite.setTint(0xbfffb0);
    else m.sprite.clearTint();
  }

  /** Support passive: periodic AoE heal on nearby allies. */
  #tickBloom(m, dt) {
    if (m.def.passive?.id !== 'bloom') return;
    m._bloomT = (m._bloomT ?? 0) + dt;
    if (m._bloomT < BLOOM_INTERVAL) return;
    m._bloomT = 0;

    let healed = 0;
    for (const other of this.scene.monsters) {
      if (!other.alive || other === m) continue;
      if (Phaser.Math.Distance.Between(m.x, m.y, other.x, other.y) > BLOOM_RADIUS) continue;
      if (other.hp >= other.maxHp) continue;
      other.heal(BLOOM_HEAL);
      healed++;
    }
    m.heal(Math.round(BLOOM_HEAL / 2));
    if (healed > 0) this.scene.fx.ring(m.x, m.y, BLOOM_RADIUS, COLORS.heal, 420, 2);
  }

  /**
   * CC active: the headline counter-play. While the hero is winding up a
   * powerful skill, the Toad cancels it outright (spec §3.1 / §4.2).
   */
  #tickCroak(m, hero) {
    if (m.def.active?.id !== 'croakOfSilence') return;
    if (!hero?.alive || !this.scene.telegraph.hasActive()) return;
    if (!m.canUseSkill('croakOfSilence', m.def.active.cooldown)) return;

    const cancelled = this.scene.telegraph.cancelActive('SILENCED');
    if (!cancelled) return;

    m.putSkillOnCd('croakOfSilence', m.def.active.cooldown);
    m.play('attack');
    hero.applyStun(0.4);
    this.announce(m, 'CROAK OF SILENCE', COLORS.tgControl);
    this.scene.fx.ring(m.x, m.y - 10, 90, COLORS.tgControl, 420, 3);
    this.scene.fx.impact({ color: COLORS.tgControl, shake: 0.004, flash: 0.18, stop: 70 });
  }

  // ═══ monster attack resolution ═══════════════════════════════════════════
  /**
   * Called by MonsterAI when a monster's attack timer elapses in range.
   * Applies passive modifiers and the piercing-alignment active.
   */
  performAttack(monster, target) {
    if (!target?.alive) return;

    const passive = monster.def.passive?.id;
    const active = monster.def.active?.id;

    // Melee DPS passive: guaranteed crit on every 4th swing.
    const crit = passive === 'frenzyStrike' && (monster.hitCount + 1) % 4 === 0;

    // Ranged DPS passive: bonus damage while outside the aggro ring.
    let mult = 1;
    if (passive === 'snipersFocus' && monster._focusActive) mult *= 1.45;

    // Ranged DPS active: horizontal alignment enables a piercing shot.
    const aligned = active === 'piercingArrow'
      && monster.canUseSkill('piercingArrow', monster.def.active.cooldown)
      && this.#alignedAlly(monster);

    monster.facing = target.x >= monster.x ? 1 : -1;
    monster.play('attack');
    monster.resetAttackTimer();

    const onHit = (hit, dealt) => this.#onMonsterHit(monster, hit, dealt);

    if (aligned) {
      monster.putSkillOnCd('piercingArrow', monster.def.active.cooldown);
      this.announce(monster, 'PIERCING ARROW', 0xeaf7c4);
      this.scene.fx.alignmentHint(monster.x, aligned.y, aligned.x, 0xeaf7c4);
      this.scene.combat.fireProjectile(monster, target, {
        texture: 'proj_pierce',
        speed: 460,
        radius: 10,
        pierce: true,
        onHit: (hit) => {
          this.scene.combat.strike(monster, hit, { mult: mult * 1.8, crit, onHit });
        },
      });
      return;
    }

    if (monster.def.range > 60) {
      this.scene.combat.fireProjectile(monster, target, {
        texture: this.#projectileFor(monster),
        tint: monster.role === ROLE.CC ? 0x8ee36b : undefined,
        speed: monster.role === ROLE.RANGED ? 400 : 300,
        onHit: (hit) => this.scene.combat.strike(monster, hit, { mult, crit, onHit }),
      });
    } else {
      this.scene.fx.slash(
        monster.x + monster.facing * 14,
        monster.y - monster.spriteHeight * 0.5,
        monster.facing,
        crit ? COLORS.dmgCrit : COLORS.white,
      );
      this.scene.combat.strike(monster, target, { mult, crit, onHit });
    }

    if (crit) this.announce(monster, 'FRENZY!', COLORS.dmgCrit);
  }

  #projectileFor(monster) {
    if (monster.role === ROLE.CC) return 'proj_glob';
    if (monster.role === ROLE.SUPPORT) return 'proj_mote';
    return 'proj_arrow';
  }

  /** CC passive: every landed hit slows. */
  #onMonsterHit(monster, target, dealt) {
    void dealt;
    if (monster.def.passive?.id === 'mucus' && target.alive) {
      target.applySlow(0.7, 2);
      target.sprite.setTint(0xc9a6ff);
      this.scene.time.delayedCall(160, () => {
        if (target.alive && !this.scene.telegraph.hasActive()) target.sprite.clearTint();
      });
    }
  }

  /** Another living monster sharing this one's horizontal line (spec §3.2). */
  #alignedAlly(monster) {
    for (const other of this.scene.monsters) {
      if (other === monster || !other.alive) continue;
      if (Math.abs(other.y - monster.y) <= 20) return other;
    }
    return null;
  }

  // ═══ melee-DPS dash active ═══════════════════════════════════════════════
  /** Reckless Charge: punishes a hero that stands still (spec §3.2). */
  tryRecklessCharge(monster, hero) {
    if (monster.def.active?.id !== 'recklessCharge') return false;
    if (!hero?.alive || monster.dashing) return false;
    if (hero.stationaryFor < 1.5) return false;
    if (!monster.canUseSkill('recklessCharge', monster.def.active.cooldown)) return false;

    const dist = monster.distanceTo(hero);
    if (dist < 50 || dist > 320) return false;

    monster.putSkillOnCd('recklessCharge', monster.def.active.cooldown);
    monster.dashing = true;
    monster.facing = hero.x >= monster.x ? 1 : -1;
    monster.play('windup');
    this.announce(monster, 'RECKLESS CHARGE', COLORS.dmgCrit);

    const b = this.scene.arenaBounds;
    const tx = hero.x - monster.facing * (hero.hitRadius + monster.def.range * 0.6);
    monster.dash = {
      sx: monster.x,
      sy: monster.y,
      tx: Phaser.Math.Clamp(tx, b.x + 14, b.right - 14),
      ty: Phaser.Math.Clamp(hero.y, b.y + 22, b.bottom - 8),
      t: 0,
      spark: 0,
    };
    return true;
  }

  /**
   * Advances a dash. Deliberately driven by the battle clock rather than a tween:
   * it is gameplay, so it has to obey hitstop like every other timer, and a
   * half-finished dash must never be able to strand the monster (a tween that
   * gets interrupted would leave `dashing` true forever).
   */
  tickDash(monster, dt) {
    const d = monster.dash;
    if (!d) { monster.dashing = false; return; }

    d.t += dt;
    if (d.t < DASH_DELAY) return;

    const p = Phaser.Math.Clamp((d.t - DASH_DELAY) / DASH_TIME, 0, 1);
    const eased = p * p; // Quad.in — slow launch, hard arrival
    monster.x = d.sx + (d.tx - d.sx) * eased;
    monster.y = d.sy + (d.ty - d.sy) * eased;

    d.spark -= dt;
    if (d.spark <= 0) {
      d.spark = DASH_SPARK_EVERY;
      this.scene.fx.hitSpark(monster.x, monster.y - 8, COLORS.dmgCrit, 2);
    }

    if (p < 1) return;

    monster.dash = null;
    monster.dashing = false;
    const hero = this.scene.hero;
    if (!monster.alive || !hero?.alive) return;

    monster.play('attack');
    this.scene.combat.strike(monster, hero, {
      mult: 1.6,
      knockback: 22,
      onHit: (h, dealt) => this.#onMonsterHit(monster, h, dealt),
    });
    this.scene.fx.impact({ color: COLORS.dmgCrit, shake: 0.006, flash: 0.2, stop: 70 });
  }

  // ═══ hero skill effects (run after the telegraph completes) ══════════════
  executeHeroEffect(hero, skill, ctx = {}) {
    const eff = skill.effect;
    const dmg = hero.atk * (eff.mult ?? 1);

    switch (eff.type) {
      case 'coneDamage': {
        const y = hero.y - 10;
        const victims = this.scene.combat.coneDamage(
          hero, hero.x, y, hero.facing, eff.radius, eff.arc, dmg,
          { knockback: eff.knockback },
        );
        this.scene.fx.slash(hero.x + hero.facing * 20, y, hero.facing, COLORS.tgDamage);
        this.scene.fx.impact({ color: COLORS.tgDamage, shake: 0.01, flash: 0.25, stop: 90 });
        this.#report(skill, victims.length);
        break;
      }

      case 'circleDamage': {
        const victims = this.scene.combat.circleDamage(
          hero, hero.x, hero.y - 10, eff.radius, dmg, { knockback: eff.knockback },
        );
        this.scene.fx.ring(hero.x, hero.y - 10, eff.radius, COLORS.tgDamage, 380, 4);
        this.scene.fx.impact({ color: COLORS.tgDamage, shake: 0.013, flash: 0.3, stop: 100 });
        this.#report(skill, victims.length);
        break;
      }

      case 'circleDamageAt': {
        const x = ctx.x ?? hero.x;
        const y = ctx.y ?? hero.y;
        const victims = this.scene.combat.circleDamage(
          hero, x, y, eff.radius, dmg, { knockback: eff.knockback },
        );
        this.#judgmentFx(x, y, eff.radius);
        this.#report(skill, victims.length);
        break;
      }

      case 'selfBuff': {
        hero.heal(Math.round(hero.maxHp * eff.healPct));
        hero.applyAtkBuff(eff.atkMult, eff.duration);
        hero.enraged = true;
        hero.sprite.setTint(0xffdca8);
        this.scene.fx.ring(hero.x, hero.y - 10, 110, COLORS.tgBuff, 520, 4);
        this.scene.fx.screenFlash(COLORS.tgBuff, 0.22, 160);
        this.scene.fx.popText(hero.x, hero.y - 80, 'ENRAGED', COLORS.tgBuff);
        break;
      }

      default:
        break;
    }
  }

  #judgmentFx(x, y, radius) {
    // vertical column of light landing on the marked circle
    const beam = this.scene.add.rectangle(x, y - 200, radius * 0.7, 420, COLORS.tgDamage, 0.5)
      .setDepth(DEPTH.telegraphAir);
    this.scene.tweens.add({
      targets: beam,
      scaleX: { from: 1.4, to: 0.2 },
      alpha: 0,
      duration: 320,
      onComplete: () => beam.destroy(),
    });
    this.scene.fx.ring(x, y, radius, COLORS.tgDamage, 480, 5);
    this.scene.fx.ring(x, y, radius * 0.6, COLORS.white, 300, 3);
    this.scene.fx.impact({ color: COLORS.tgDamage, shake: 0.022, flash: 0.5, stop: 130 });
  }

  #report(skill, hits) {
    this.scene.ui?.flashHint(hits > 0
      ? `${skill.name} hit ${hits} monster${hits === 1 ? '' : 's'}`
      : `${skill.name} missed — good read!`);
  }

  /** Telegraph kind helper used by the hero AI when picking a skill. */
  static kindOf(skill) {
    return skill.telegraph?.kind ?? TELEGRAPH_KIND.DAMAGE;
  }
}
