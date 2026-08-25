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
import { GROUND_SQUASH, P, pxArc, pxDisc, pxGroundRing, pxLine, pxStar, snap } from '../art/PixelDraw.js';

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
    this.blizzards = [];
    // Persistent, dt-driven hero effects. Each is an array of live instances
    // ticked from update(dt) off scene.clock, drawn per frame into its own
    // Graphics, and cleared in reset() — never a tween or delayedCall, which
    // ride real RAF and are invisible to the game.step harness (and hitstop).
    this.spins = [];
    this.auras = [];
    this.iceWalls = [];
    this.novas = [];
    this.lances = [];
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
        this.scene.fx.skillBurst(monster.x, monster.y - 12, COLORS.shield, 'rune');
        this.announce(monster, 'PROVOKE', COLORS.tgControl);
        this.scene.audio?.playSkill(monster, active.id);
        break;
      }
      // Support: team-wide ATK buff on arrival.
      case 'radiantBloom': {
        for (const m of this.scene.monsters) {
          if (m.alive) {
            m.applyAtkBuff(1.25, 8);
            this.scene.fx.ring(m.x, m.y, 26, COLORS.tgBuff, 320, 2);
            this.scene.fx.skillBurst(m.x, m.y - m.spriteHeight * 0.45, COLORS.heal, 'rune');
          }
        }
        this.announce(monster, '+25% TEAM ATK', COLORS.tgBuff);
        this.scene.audio?.playSkill(monster, active.id);
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
    this.#tickBlizzards(dt);
    this.#tickSpins(dt);
    this.#tickAuras(dt);
    this.#tickIceWalls(dt);
    this.#tickNovas(dt);
    this.#tickLances(dt);
  }

  reset() {
    // One sweep over every live-effect array: each entry owns its Graphics (a
    // couple own a second one in the air layer), and nothing may outlive a floor.
    for (const list of [
      this.blizzards, this.spins, this.auras, this.iceWalls, this.novas, this.lances,
    ]) {
      for (const e of list) { e.gfx?.destroy(); e.gfxAir?.destroy(); }
    }
    this.blizzards = [];
    this.spins = [];
    this.auras = [];
    this.iceWalls = [];
    this.novas = [];
    this.lances = [];
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
    if (safe && !m._focusWasActive) {
      this.scene.fx.skillBurst(m.x, m.y - m.spriteHeight * 0.55, 0xbfffb0, 'rune');
    }
    m._focusWasActive = safe;
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
    if (healed > 0) {
      this.scene.fx.ring(m.x, m.y, BLOOM_RADIUS, COLORS.heal, 420, 2);
      this.scene.fx.skillBurst(m.x, m.y - m.spriteHeight * 0.55, COLORS.heal, 'arcane');
      this.scene.audio?.playSkill(m, 'bloom');
    }
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
    this.scene.audio?.playSkill(m, m.def.active.id);
    this.scene.fx.ring(m.x, m.y - 10, 90, COLORS.tgControl, 420, 3);
    this.scene.fx.skillBurst(m.x, m.y - m.spriteHeight * 0.5, COLORS.tgControl, 'rune');
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
    const bombard = active === 'bombard' && monster.canUseSkill('bombard', monster.def.active.cooldown);
    const phase = active === 'phaseStrike' && monster.canUseSkill('phaseStrike', monster.def.active.cooldown);

    monster.facing = target.x >= monster.x ? 1 : -1;
    monster.play('attack');
    monster.resetAttackTimer();
    this.scene.audio?.playSkill(monster);

    const onHit = (hit, dealt) => this.#onMonsterHit(monster, hit, dealt);

    if (bombard || phase) {
      monster.putSkillOnCd(active, monster.def.active.cooldown);
      this.announce(monster, bombard ? 'BOMBARD!' : 'PHASE STRIKE!', bombard ? 0xffa23d : 0x9be8ff);
      this.scene.audio?.playSkill(monster, active);
      this.scene.fx.skillBurst(monster.x + monster.facing * 10, monster.y - monster.spriteHeight * 0.55,
        bombard ? 0xff9a3d : 0x9be8ff, bombard ? 'explosion' : 'arcane');
    }

    if (aligned) {
      monster.putSkillOnCd('piercingArrow', monster.def.active.cooldown);
      this.announce(monster, 'PIERCING ARROW', 0xeaf7c4);
      this.scene.audio?.playSkill(monster, active);
      this.scene.fx.alignmentHint(monster.x, aligned.y, aligned.x, 0xeaf7c4);
      this.scene.combat.fireProjectile(monster, target, {
        texture: 'proj_pierce',
        speed: 460,
        radius: 10,
        pierce: true,
        trailColor: 0xbfffb0,
        trailLength: 22,
        onHit: (hit) => {
          this.scene.combat.strike(monster, hit, { mult: mult * 1.8, crit, onHit });
        },
      });
      return;
    }

    if (monster.def.range > 60) {
      this.scene.combat.fireProjectile(monster, target, {
        texture: bombard ? 'proj_bomb' : this.#projectileFor(monster),
        tint: bombard ? 0xff7a3d : (monster.role === ROLE.CC ? 0x8ee36b : undefined),
        speed: bombard ? 270 : (monster.role === ROLE.RANGED ? 400 : 300),
        scaleX: bombard ? 1.25 : undefined,
        scaleY: bombard ? 1.25 : undefined,
        trailColor: bombard ? 0xff8b35 : (phase ? 0x9be8ff : (monster.role === ROLE.CC ? 0x8ee36b : 0xbfffb0)),
        trailLength: bombard ? 22 : 14,
        onHit: (hit) => this.scene.combat.strike(monster, hit, {
          mult: mult * (bombard ? 2.2 : (phase ? 1.5 : 1)), crit, onHit,
          ignoreDodge: phase, ignoreBlock: phase,
        }) && (bombard
          ? this.scene.fx.skillBurst(hit.x, hit.y - hit.spriteHeight * 0.45, 0xff8b35, 'explosion')
          : (phase ? this.scene.fx.skillBurst(hit.x, hit.y - hit.spriteHeight * 0.45, 0x9be8ff, 'arcane') : null)),
      });
    } else {
      this.scene.fx.slash(
        monster.x + monster.facing * 14,
        monster.y - monster.spriteHeight * 0.5,
        monster.facing,
        crit ? COLORS.dmgCrit : COLORS.white,
      );
      this.scene.combat.strike(monster, target, {
        mult: mult * (phase ? 1.5 : 1), crit, onHit, ignoreDodge: phase, ignoreBlock: phase,
      });
    }

    if (crit) {
      this.announce(monster, 'FRENZY!', COLORS.dmgCrit);
      this.scene.fx.skillBurst(monster.x + monster.facing * 14, monster.y - monster.spriteHeight * 0.55, COLORS.dmgCrit, 'arcane');
    }
  }

  #projectileFor(monster) {
    if (monster.def.id === 'wraith') return 'proj_wraith';
    if (monster.role === ROLE.CC) return 'proj_glob';
    if (monster.role === ROLE.SUPPORT) return 'proj_mote';
    return 'proj_arrow';
  }

  /** CC passive: every landed hit slows. */
  #onMonsterHit(monster, target, dealt) {
    void dealt;
    if (monster.def.passive?.id === 'shortFuse' && target.alive) {
      this.scene.fx.scorch(target.x, target.y, 18);
      this.scene.fx.hitSpark(target.x, target.y - target.spriteHeight * 0.45, 0xff9a3d, 4);
    }
    if (monster.def.passive?.id === 'mucus' && target.alive) {
      target.applySlow(0.7, 2);
      target.sprite.setTint(0xc9a6ff);
      this.scene.fx.skillBurst(target.x, target.y - target.spriteHeight * 0.5, 0x9b77bd, 'arcane');
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
    if (!['recklessCharge', 'lanceCharge'].includes(monster.def.active?.id)) return false;
    if (!hero?.alive || monster.dashing) return false;
    if (hero.stationaryFor < 1.5) return false;
    if (!monster.canUseSkill('recklessCharge', monster.def.active.cooldown)) return false;

    const dist = monster.distanceTo(hero);
    if (dist < 50 || dist > 320) return false;

    monster.putSkillOnCd('recklessCharge', monster.def.active.cooldown);
    monster.dashing = true;
    monster.facing = hero.x >= monster.x ? 1 : -1;
    monster.play('windup');
    this.announce(monster, monster.def.active.id === 'lanceCharge' ? 'LANCE CHARGE' : 'RECKLESS CHARGE', COLORS.dmgCrit);
    this.scene.audio?.playSkill(monster, monster.def.active.id);
    this.scene.fx.skillBurst(monster.x, monster.y - monster.spriteHeight * 0.45,
      monster.def.active.id === 'lanceCharge' ? 0x83f1d0 : COLORS.dmgCrit, 'arcane');

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
      // the trail throws *backwards*: sparks shed behind a charge, not ahead
      const back = Math.atan2(d.sy - d.ty, d.sx - d.tx);
      const chargeColor = monster.def.active?.id === 'lanceCharge' ? 0x83f1d0 : COLORS.dmgCrit;
      this.scene.fx.hitSpark(monster.x, monster.y - 8, chargeColor, 2, back);
      this.scene.fx.footDust(monster.x, monster.y, d.tx > d.sx ? 1 : -1);
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
    const chargeColor = monster.def.active?.id === 'lanceCharge' ? 0x83f1d0 : COLORS.dmgCrit;
    this.scene.fx.skillBurst(monster.x, monster.y - monster.spriteHeight * 0.45, chargeColor, 'explosion');
    this.scene.fx.impact({ color: chargeColor, shake: 0.006, flash: 0.2, stop: 70 });
  }

  // ═══ hero skill effects (run after the telegraph completes) ══════════════
  executeHeroEffect(hero, skill, ctx = {}) {
    const eff = skill.effect;
    const dmg = hero.atk * (eff.mult ?? 1);
    this.scene.audio?.playSkill(hero, skill.id);

    switch (eff.type) {
      case 'coneDamage': {
        const y = hero.y - 10;
        // Resolve on the facing the telegraph was *drawn* with, not the live one
        // — the drawn shape is the contract the player read.
        const facing = ctx.facing ?? hero.facing;
        const victims = this.scene.combat.coneDamage(
          hero, hero.x, y, facing, eff.radius, eff.arc, dmg,
          { knockback: eff.knockback },
        );
        this.scene.fx.slash(hero.x + facing * 20, y, facing, COLORS.tgDamage);
        this.scene.fx.impact({ color: COLORS.tgDamage, shake: 0.01, flash: 0.25, stop: 90 });
        this.#report(skill, victims.length);
        break;
      }

      case 'circleDamage': {
        const victims = this.scene.combat.circleDamage(
          hero, hero.x, hero.y - 10, eff.radius, dmg, { knockback: eff.knockback },
        );
        this.scene.fx.ring(hero.x, hero.y - 10, eff.radius, COLORS.tgDamage, 380, 4);
        this.scene.fx.scorch(hero.x, hero.y, eff.radius * 0.62);
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
        // A buff that lasts the rest of the fight needs a standing visual, not a
        // single ring the player may have blinked through.
        if (eff.aura) this.#startAura(hero, eff);
        break;
      }

      /** Three revolutions that drag the crowd in, then throw it. */
      case 'spinAttack': {
        this.#startSpin(hero, skill, eff);
        break;
      }

      case 'iceWall': {
        hero.iceWallHp = eff.shield;
        hero.iceWallUntil = this.scene.clock + eff.duration;
        hero.setBarrier(true);
        // Expiry is driven by #tickIceWalls against scene.clock, so the wall
        // freezes with the rest of the fight instead of running on wall time.
        this.#startIceWall(hero, eff);
        this.scene.fx.skillBurst(hero.x, hero.y - hero.spriteHeight * 0.5, 0xa9f5ff, 'rune');
        this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 12, `ICE WALL · ${eff.shield}`, 0xa9f5ff);
        break;
      }

      /** Point-blank freeze: the Mage's answer to melee that closed the gap. */
      case 'frostNova': {
        const y = hero.y - 10;
        const victims = this.scene.combat.monstersInCircle(hero.x, y, eff.radius);
        for (const m of victims) {
          this.scene.combat.strike(hero, m, {
            mult: eff.mult, color: 0xa9f5ff, knockback: eff.knockback,
          });
          m.applySlow(eff.slowMult, eff.slowSeconds);
          m.applyStun(eff.stunSeconds);
        }
        this.novas.push({
          x: hero.x, y, r: eff.radius, life: eff.grow ?? 0.5, age: 0,
          gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
        });
        this.scene.fx.scorch(hero.x, hero.y, eff.radius * 0.5, 0x8fd8ff);
        this.scene.fx.impact({ color: 0xa9f5ff, shake: 0.009, flash: 0.24, stop: 85 });
        this.#report(skill, victims.length);
        break;
      }

      /** A long, thin, sidesteppable line — the sniper half of the Mage's kit. */
      case 'lanceBeam': {
        const y = hero.y - 14;
        const facing = ctx.facing ?? hero.facing;
        const victims = this.scene.combat.monstersInCone(
          hero.x, y, facing, eff.radius, eff.arc,
        );
        for (const m of victims) {
          this.scene.combat.strike(hero, m, {
            mult: eff.mult, color: 0xa9f5ff, knockback: eff.knockback, ignoreBlock: true,
          });
          m.applySlow(eff.slowMult, eff.slowSeconds);
          this.scene.fx.hitSpark(m.x, m.y - m.spriteHeight * 0.5, 0xd9fbff, 6,
            facing < 0 ? Math.PI : 0);
        }
        this.lances.push({
          x: hero.x, y, dir: facing, r: eff.radius, arc: eff.arc,
          grow: eff.grow ?? 0.25, life: eff.life ?? 0.5, age: 0,
          gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
        });
        this.scene.fx.impact({ color: 0xa9f5ff, shake: 0.011, flash: 0.26, stop: 90 });
        this.#report(skill, victims.length);
        break;
      }

      case 'blizzard': {
        this.#startBlizzard(hero, ctx.spots, eff);
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
    // the ultimate leaves the floor's biggest scar — the room remembers it
    this.scene.fx.scorch(x, y, radius * 0.8);
    this.scene.fx.impact({ color: COLORS.tgDamage, shake: 0.022, flash: 0.5, stop: 130 });
  }

  #startBlizzard(hero, spots, eff) {
    const b = this.scene.arenaBounds;
    const centres = spots?.length ? spots : Array.from({ length: eff.storms ?? 3 }, () => ({
      x: Phaser.Math.Between(b.x + eff.radius, b.right - eff.radius),
      y: Phaser.Math.Between(b.y + eff.radius, b.bottom - eff.radius),
    }));
    for (const spot of centres) {
      const storm = {
        x: spot.x, y: spot.y, r: eff.radius, left: eff.duration, tick: 0,
        interval: eff.tick, mult: eff.tickMult, slowMult: eff.slowMult, slowSeconds: eff.slowSeconds,
        vx: Phaser.Math.FloatBetween(26, 42) * (Math.random() < 0.5 ? -1 : 1),
        vy: Phaser.Math.FloatBetween(18, 34) * (Math.random() < 0.5 ? -1 : 1),
        spin: Phaser.Math.FloatBetween(0, Math.PI * 2), age: 0,
        gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
      };
      this.blizzards.push(storm);
      this.scene.fx.skillBurst(storm.x, storm.y, 0xa9f5ff, 'rune');
    }
    this.scene.fx.screenFlash(0xbff8ff, 0.16, 130);
  }

  #tickBlizzards(dt) {
    for (const storm of [...this.blizzards]) {
      storm.left -= dt;
      storm.tick -= dt;
      storm.age += dt;
      storm.spin += dt * 8;

      // Vortices roam rather than parking: three paths criss-cross naturally,
      // while an inset keeps their damaging radius inside the playable room.
      const b = this.scene.arenaBounds;
      const margin = storm.r + 8;
      storm.x += storm.vx * dt;
      storm.y += storm.vy * dt;
      if (storm.x < b.x + margin || storm.x > b.right - margin) {
        storm.vx *= -1;
        storm.x = Phaser.Math.Clamp(storm.x, b.x + margin, b.right - margin);
      }
      if (storm.y < b.y + margin || storm.y > b.bottom - margin) {
        storm.vy *= -1;
        storm.y = Phaser.Math.Clamp(storm.y, b.y + margin, b.bottom - margin);
      }

      const g = storm.gfx;
      g.clear();
      this.#drawBlizzardVortex(g, storm);
      if (storm.tick <= 0) {
        storm.tick = storm.interval;
        for (const m of this.scene.combat.monstersInCircle(storm.x, storm.y, storm.r)) {
          this.scene.combat.strike(this.scene.hero, m, { mult: storm.mult, color: 0xa9f5ff });
          m.applySlow(storm.slowMult, storm.slowSeconds);
        }
      }
      if (storm.left > 0) continue;
      g.destroy();
      this.blizzards = this.blizzards.filter((s) => s !== storm);
    }
  }

  /** A tapered column of rotating pixel arcs — readable as a tornado at a glance. */
  #drawBlizzardVortex(g, storm) {
    const x = snap(storm.x);
    const y = snap(storm.y);
    // Wide, faint ground circulation conveys the actual damaging/slow area.
    g.fillStyle(0x91eaff, 0.09);
    pxGroundRing(g, x, y + 5, storm.r * 0.9, { dash: 5, gap: 4, rot: Math.floor(storm.age * 8) });
    g.fillStyle(0x4e98c8, 0.24);
    pxGroundRing(g, x, y + 5, 27, { dash: 3, gap: 2, rot: -Math.floor(storm.age * 12) });

    // Bottom is a tight funnel; each higher band is wider and shifted, making
    // a true spiralling cone rather than a circular damage marker.
    for (let band = 0; band < 5; band++) {
      const q = band / 4;
      const py = y + 16 - q * 58;
      const width = 10 + q * 31;
      const phase = storm.spin + band * 1.15;
      g.fillStyle(band % 2 ? 0xd9fbff : 0x72cbed, 0.86 - band * 0.08);
      pxArc(g, x + Math.sin(phase) * 6, py, width, 4 + q * 4, {
        from: phase + 0.3, to: phase + Math.PI * 1.32, dash: 8, gap: 2, rot: storm.age * 5,
      });
      g.fillStyle(0xffffff, 0.5);
      pxArc(g, x - Math.sin(phase) * 5, py - 2, width * 0.68, 3 + q * 3, {
        from: phase + Math.PI * 0.72, to: phase + Math.PI * 1.55, dash: 5, gap: 3, rot: -storm.age * 7,
      });
    }

    // Ice fragments orbit at different heights; their asymmetric paths make
    // the vortex feel violent instead of like a looping halo.
    for (let i = 0; i < 12; i++) {
      const q = (i % 5) / 4;
      const a = storm.spin * (1.7 + q) + i * 1.91;
      const radius = 12 + q * 35;
      const px = snap(x + Math.cos(a) * radius);
      const py = snap(y + 14 - q * 58 + Math.sin(a) * 7);
      g.fillStyle(i % 3 === 0 ? 0xffffff : 0x8deaff, 0.78);
      g.fillRect(px, py, P * (i % 3 === 0 ? 2 : 1), P * 2);
    }
    // Cold lightning stitches the funnel to the ground every other beat.
    if (Math.floor(storm.age * 6) % 2 === 0) {
      g.fillStyle(0xe9ffff, 0.72);
      pxLine(g, x - 4, y - 35, x + 4, y - 16);
      pxLine(g, x + 4, y - 16, x - 2, y + 5);
    }
  }

  // ═══ persistent hero effects ═════════════════════════════════════════════
  // Everything below follows the blizzard pattern: an entry pushed onto an
  // array, advanced by dt off scene.clock, redrawn into its own Graphics each
  // frame, and torn down by its own tick. No tweens, no delayedCall.

  /** Nearest living monster to `unit`, or null. Used to aim walls and spins. */
  #nearestMonster(unit) {
    let best = null;
    let bestD = Infinity;
    for (const m of this.scene.monsters) {
      if (!m.alive) continue;
      const d = Phaser.Math.Distance.Between(unit.x, unit.y, m.x, m.y);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // ── Whirlwind: three revolutions that drag the crowd in, then throw it ────
  #startSpin(hero, skill, eff) {
    this.spins.push({
      hero,
      skill,
      x: hero.x,
      y: hero.y - 10,
      radius: eff.radius,
      steps: eff.steps ?? [1],
      mult: eff.mult,
      ticks: eff.ticks ?? 3,
      interval: eff.interval ?? 0.34,
      pull: eff.pull ?? 0,
      knockback: eff.knockback ?? 0,
      spinEvery: eff.spinEvery ?? 0.09,
      beat: 0,
      tick: 0,          // fires the first revolution on the frame it starts
      spinT: 0,
      facing0: hero.facing,
      age: 0,
      hits: new Set(),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.screenFlash(COLORS.tgDamage, 0.16, 120);
  }

  #tickSpins(dt) {
    for (const spin of [...this.spins]) {
      const { hero } = spin;
      spin.age += dt;
      spin.tick -= dt;
      spin.spinT -= dt;

      // The spin follows the Knight rather than the cast point: he plants and
      // turns, so the vortex should sit on him even if knockback nudges him.
      if (hero.alive) { spin.x = hero.x; spin.y = hero.y - 10; }

      // Mirroring the sprite sells the rotation without setAngle, which would
      // resample the pixels off the lattice.
      if (spin.spinT <= 0 && hero.alive) {
        spin.spinT = spin.spinEvery;
        hero.facing *= -1;
      }

      if (spin.tick <= 0 && spin.beat < spin.ticks) {
        const last = spin.beat === spin.ticks - 1;
        const r = spin.radius * (spin.steps[Math.min(spin.beat, spin.steps.length - 1)] ?? 1);
        for (const m of this.scene.combat.monstersInCircle(spin.x, spin.y, r)) {
          // Beats 1-2 pull inward (negative force), the last one blasts out.
          this.scene.combat.strike(hero, m, {
            mult: spin.mult,
            color: COLORS.tgDamage,
            knockback: last ? spin.knockback : spin.pull,
          });
          spin.hits.add(m);
        }
        this.scene.fx.ring(spin.x, spin.y, r, COLORS.tgDamage, 300, 3);
        for (let i = 0; i < 4; i++) {
          const a = spin.age * 11 + (i / 4) * Math.PI * 2;
          this.scene.fx.hitSpark(
            spin.x + Math.cos(a) * r, spin.y + Math.sin(a) * r * GROUND_SQUASH,
            0xffe6a0, 3, a,
          );
        }
        this.scene.audio?.playSkill(hero, last ? 'whirlwind' : 'whirlwindTick');
        this.scene.fx.impact(last
          ? { color: COLORS.tgDamage, shake: 0.014, flash: 0.28, stop: 100 }
          : { color: COLORS.tgDamage, shake: 0.006, flash: 0.1, stop: 45 });
        spin.beat += 1;
        spin.tick = spin.interval;
      }

      spin.gfx.clear();
      this.#drawWhirlwind(spin.gfx, spin);

      if (spin.beat < spin.ticks && hero.alive) continue;
      // tail: let the last arc finish sweeping before the graphics goes away
      if (hero.alive && spin.tick > spin.interval - 0.18) continue;
      hero.facing = spin.facing0;
      this.scene.fx.scorch(spin.x, hero.y, spin.radius * 0.5);
      this.#report(spin.skill, spin.hits.size);
      spin.gfx.destroy();
      this.spins = this.spins.filter((s) => s !== spin);
    }
  }

  /** Three trailing blade arcs over a counter-rotating dust ring. */
  #drawWhirlwind(g, spin) {
    const x = snap(spin.x);
    const y = snap(spin.y);
    const a = spin.age * 11;
    const reach = spin.radius * (spin.steps[Math.min(spin.beat, spin.steps.length - 1)] ?? 1);

    // the actual damaging area, plus a tighter ring spinning the other way so
    // the floor itself looks dragged around
    g.fillStyle(0xffd9a0, 0.15);
    pxGroundRing(g, x, y, reach, { dash: 6, gap: 5, rot: Math.floor(spin.age * 14) });
    g.fillStyle(0xffb45c, 0.3);
    pxGroundRing(g, x, y, reach * 0.55, { dash: 3, gap: 3, rot: -Math.floor(spin.age * 18) });

    // each arc is a frame behind the last and slightly smaller — the pixel-art
    // way to draw a sweep, where one arc just reads as a curve
    for (let k = 0; k < 3; k++) {
      const r = reach * (1 - k * 0.15);
      const from = a - k * 0.5;
      g.fillStyle(k === 0 ? 0xffffff : COLORS.tgDamage, 0.9 - k * 0.27);
      pxArc(g, x, y - 10 + k * 4, r, r * GROUND_SQUASH, {
        from, to: from + Math.PI * (0.7 - k * 0.12),
      });
    }

    // wind streaks flung outward, riding the same clock as the blades
    g.fillStyle(0xffe6a0, 0.5);
    for (let i = 0; i < 6; i++) {
      const wa = a * 0.8 + (i / 6) * Math.PI * 2;
      const inner = reach * 0.45;
      pxLine(g,
        x + Math.cos(wa) * inner, y - 8 + Math.sin(wa) * inner * GROUND_SQUASH,
        x + Math.cos(wa) * reach, y - 8 + Math.sin(wa) * reach * GROUND_SQUASH);
    }
  }

  // ── Call of Valor: a standing aura, not a single ring ────────────────────
  #startAura(hero, eff) {
    this.auras.push({
      hero,
      left: eff.duration ?? 999,
      regenPct: eff.regenPct ?? 0,
      regenEvery: eff.regenEvery ?? 2,
      regen: eff.regenEvery ?? 2,
      age: 0,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.unitFx),
    });
  }

  #tickAuras(dt) {
    for (const aura of [...this.auras]) {
      const { hero } = aura;
      aura.age += dt;
      aura.left -= dt;

      if (aura.regenPct > 0) {
        aura.regen -= dt;
        if (aura.regen <= 0) {
          aura.regen = aura.regenEvery;
          if (hero.alive) hero.heal(Math.round(hero.maxHp * aura.regenPct));
        }
      }

      if (hero.alive && aura.left > 0) {
        this.#drawValorAura(aura.gfx, aura.gfxAir, aura);
        continue;
      }
      aura.gfx.destroy();
      aura.gfxAir.destroy();
      this.auras = this.auras.filter((a) => a !== aura);
    }
  }

  /** Rotating gold ground ring, rising motes and a pair of pixel banners. */
  #drawValorAura(g, air, aura) {
    const { hero } = aura;
    const x = snap(hero.x);
    const y = snap(hero.y);
    const pulse = 0.5 + 0.5 * Math.sin(aura.age * 3.2);

    g.clear();
    g.fillStyle(COLORS.tgBuff, 0.2 + pulse * 0.14);
    pxGroundRing(g, x, y, 34, { dash: 4, gap: 3, rot: Math.floor(aura.age * 9) });
    g.fillStyle(0xffe6a0, 0.14 + pulse * 0.1);
    pxGroundRing(g, x, y, 47, { dash: 2, gap: 5, rot: -Math.floor(aura.age * 6) });

    air.clear();
    // six motes on independent phases: a standing flame rather than a halo
    for (let i = 0; i < 6; i++) {
      const ph = (aura.age * 0.55 + i / 6) % 1;
      const mx = x + Math.cos(i * 2.4 + aura.age * 0.8) * (13 + (i % 3) * 8);
      const my = y - 4 - ph * 54;
      air.fillStyle(i % 2 ? COLORS.tgBuff : 0xfff1b7, (1 - ph) * 0.85);
      air.fillRect(snap(mx), snap(my), P * (i % 3 === 0 ? 2 : 1), P);
    }
    // twin banners at the shoulders, rippling on the same clock
    const top = y - hero.spriteHeight * 0.92;
    for (const side of [-1, 1]) {
      for (let s = 0; s < 6; s++) {
        const w = (6 - s) * P;
        const sway = Math.round(Math.sin(aura.age * 4 + s * 0.7 + side) * 2) * P;
        air.fillStyle(s % 2 ? 0xc9962c : COLORS.tgBuff, 0.72);
        air.fillRect(snap(hero.x + side * 27 + sway - w / 2), snap(top + s * 6), w, P * 2);
      }
    }
  }

  // ── Ice Wall: a real barricade the shield's state is legible on ──────────
  #startIceWall(hero, eff) {
    const threat = this.#nearestMonster(hero);
    const a = threat
      ? Math.atan2(threat.y - hero.y, threat.x - hero.x)
      : (hero.facing < 0 ? Math.PI : 0);
    // pillars stand between the Mage and the pack, spread along the line
    // perpendicular to the threat so they actually block the approach
    const cx = hero.x + Math.cos(a) * 40;
    const cy = hero.y + Math.sin(a) * 40 * GROUND_SQUASH;
    const nx = -Math.sin(a);
    const ny = Math.cos(a) * GROUND_SQUASH;
    const count = eff.segments ?? 3;

    const segments = [];
    for (let i = 0; i < count; i++) {
      const t = (i - (count - 1) / 2) * 30;
      segments.push({
        x: cx + nx * t,
        y: cy + ny * t,
        w: 14 - Math.abs(i - (count - 1) / 2) * 2,
        h: 40 - Math.abs(i - (count - 1) / 2) * 7,
      });
      this.scene.fx.skillBurst(cx + nx * t, cy + ny * t, 0xa9f5ff, 'rune');
    }

    this.iceWalls.push({
      hero,
      segments,
      shield: eff.shield,
      left: eff.duration,
      chill: eff.chillEvery ?? 0.7,
      chillEvery: eff.chillEvery ?? 0.7,
      chillRadius: eff.chillRadius ?? 46,
      chillMult: eff.chillMult ?? 0.2,
      slowMult: eff.slowMult ?? 0.6,
      slowSeconds: eff.slowSeconds ?? 1.1,
      shatterMult: eff.shatterMult ?? 0.9,
      shatterRadius: eff.shatterRadius ?? 84,
      stage: 0,
      age: 0,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
  }

  #tickIceWalls(dt) {
    for (const wall of [...this.iceWalls]) {
      const { hero } = wall;
      wall.age += dt;
      wall.left -= dt;
      wall.chill -= dt;

      // The pillars carry the shield's remaining health as crack stages, so the
      // number on the Mage and the thing on the floor never disagree.
      const pct = Phaser.Math.Clamp(hero.iceWallHp / wall.shield, 0, 1);
      wall.stage = Math.min(2, Math.floor((1 - pct) * 3));

      if (wall.chill <= 0) {
        wall.chill = wall.chillEvery;
        const chilled = new Set();
        for (const seg of wall.segments) {
          for (const m of this.scene.combat.monstersInCircle(seg.x, seg.y, wall.chillRadius)) {
            chilled.add(m);
          }
        }
        for (const m of chilled) {
          this.scene.combat.strike(hero, m, { mult: wall.chillMult, color: 0xa9f5ff });
          m.applySlow(wall.slowMult, wall.slowSeconds);
        }
      }

      wall.gfx.clear();
      this.#drawIceWall(wall.gfx, wall);

      const spent = hero.iceWallHp <= 0 || wall.left <= 0 || !hero.alive;
      if (!spent) continue;

      // Shatter: the barricade cashes itself in rather than fading out.
      for (const seg of wall.segments) {
        for (const m of this.scene.combat.monstersInCircle(seg.x, seg.y, wall.shatterRadius)) {
          this.scene.combat.strike(hero, m, {
            mult: wall.shatterMult, color: 0xa9f5ff, knockback: 30,
          });
          m.applySlow(wall.slowMult, wall.slowSeconds * 1.4);
        }
        this.scene.fx.ring(seg.x, seg.y, wall.shatterRadius, 0xa9f5ff, 360, 3);
        this.scene.fx.hitSpark(seg.x, seg.y - seg.h * 0.5, 0xd9fbff, 7, -Math.PI / 2);
        this.scene.fx.scorch(seg.x, seg.y, 12, 0x8fd8ff);
      }
      this.scene.fx.impact({ color: 0xa9f5ff, shake: 0.01, flash: 0.22, stop: 80 });
      hero.iceWallHp = 0;
      hero.iceWallUntil = 0;
      hero.setBarrier(false);
      wall.gfx.destroy();
      this.iceWalls = this.iceWalls.filter((w) => w !== wall);
    }
  }

  /** Tapered pillars on the grid — stacked rects and pxLine cracks, no AA. */
  #drawIceWall(g, wall) {
    const fade = wall.left < 0.6 ? Math.max(0.15, wall.left / 0.6) : 1;
    const shimmer = 0.5 + 0.5 * Math.sin(wall.age * 4);

    for (const [i, seg] of wall.segments.entries()) {
      const x = snap(seg.x);
      const y = snap(seg.y);

      // rime bite where the pillar tore out of the floor
      g.fillStyle(0x7fd4ef, 0.2 * fade);
      pxDisc(g, x, y, seg.w + 8, (seg.w + 8) * GROUND_SQUASH);

      // the shaft: five bands, each narrower than the last, so it tapers
      const bands = 5;
      for (let b = 0; b < bands; b++) {
        const q = b / bands;
        const bw = Math.max(P * 2, Math.round((seg.w * (1 - q * 0.6)) / P) * P);
        const bh = Math.ceil((seg.h / bands) / P) * P;
        g.fillStyle(b % 2 ? 0x9fdcf5 : 0xc7eeff, (0.92 - q * 0.16) * fade);
        g.fillRect(snap(x - bw / 2), snap(y - seg.h * (q + 1 / bands)), bw, bh);
      }

      // lit edge and inner glow — the difference between ice and a grey slab
      g.fillStyle(0xffffff, (0.55 + shimmer * 0.3) * fade);
      g.fillRect(snap(x - seg.w / 2), snap(y - seg.h), P, snap(seg.h * 0.8));
      g.fillStyle(0xe9ffff, 0.3 * fade);
      g.fillRect(snap(x + seg.w / 2 - P * 2), snap(y - seg.h * 0.7), P, snap(seg.h * 0.5));

      // cracks appear as the Mage's shield is spent: the wall shows its HP
      g.fillStyle(0x2f6f92, 0.75 * fade);
      for (let c = 0; c < wall.stage; c++) {
        const cy = y - seg.h * (0.28 + c * 0.26);
        const dir = (i + c) % 2 ? 1 : -1;
        pxLine(g, x - dir * seg.w * 0.4, cy, x, cy - 5);
        pxLine(g, x, cy - 5, x + dir * seg.w * 0.35, cy - 1);
      }
    }
  }

  // ── Frost Nova: an expanding ring of spikes ──────────────────────────────
  #tickNovas(dt) {
    for (const nova of [...this.novas]) {
      nova.age += dt;
      const g = nova.gfx;
      g.clear();

      const p = Math.min(1, nova.age / nova.life);
      const r = nova.r * (0.25 + 0.75 * p);
      const fade = 1 - p;
      const x = snap(nova.x);
      const y = snap(nova.y);

      g.fillStyle(0xd9fbff, 0.25 + 0.5 * fade);
      pxGroundRing(g, x, y, r, { dash: 5, gap: 3 });
      g.fillStyle(0x8fd8ff, 0.3 * fade);
      pxGroundRing(g, x, y, r * 0.68, { dash: 3, gap: 4, rot: Math.floor(nova.age * 10) });
      g.fillStyle(0xa9f5ff, 0.14 * fade);
      pxDisc(g, x, y, r * 0.9, r * 0.9 * GROUND_SQUASH, { every: 3 });

      // spikes crystallise on the rim and shrink as the wave passes
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const sx = snap(x + Math.cos(a) * r);
        const sy = snap(y + Math.sin(a) * r * GROUND_SQUASH);
        const arm = P * (1 + Math.round(fade * 2));
        g.fillStyle(i % 2 ? 0xffffff : 0xa9f5ff, 0.85 * fade + 0.1);
        pxStar(g, sx, sy, arm);
        g.fillRect(sx - P, sy - arm * 3, P * 2, arm * 3);
      }

      if (nova.age < nova.life) continue;
      g.destroy();
      this.novas = this.novas.filter((n) => n !== nova);
    }
  }

  // ── Glacial Lance: a beam that crystallises, then shatters ───────────────
  #tickLances(dt) {
    for (const lance of [...this.lances]) {
      lance.age += dt;
      const g = lance.gfx;
      g.clear();

      const grow = Math.min(1, lance.age / lance.grow);
      const p = Math.min(1, lance.age / lance.life);
      const fade = 1 - p * p; // holds bright while it grows, then drops fast
      const reach = lance.r * grow;
      const half = Phaser.Math.DegToRad(lance.arc) / 2;
      const x = snap(lance.x);
      const y = snap(lance.y);
      const step = P * 4;

      // the shaft, widening with distance exactly like the telegraph cone
      for (let d = 0; d < reach; d += step) {
        const w = Math.max(P * 2, Math.round((6 + d * Math.tan(half)) / P) * P);
        const sx = snap(x + lance.dir * d);
        g.fillStyle((d / step) % 2 ? 0xd9fbff : 0x8fd8ff, (0.92 - (d / lance.r) * 0.35) * fade);
        g.fillRect(lance.dir < 0 ? sx - step : sx, snap(y - w / 2), step, w);
      }
      // lit spine down the middle
      g.fillStyle(0xffffff, 0.85 * fade);
      g.fillRect(snap(lance.dir < 0 ? x - reach : x), snap(y - P / 2), snap(reach), P);

      // shards flake off the beam and drift perpendicular as it breaks up
      for (let i = 0; i < 10; i++) {
        const d = ((i + 1) / 11) * reach;
        const drift = (i % 2 ? 1 : -1) * (4 + p * 26 + (i % 3) * 3);
        g.fillStyle(i % 3 === 0 ? 0xffffff : 0xa9f5ff, 0.8 * fade);
        g.fillRect(snap(x + lance.dir * d), snap(y + drift), P * 2, P);
      }
      // the staff-side flare, so the beam clearly comes from the Mage
      g.fillStyle(0xe9ffff, 0.7 * fade);
      pxStar(g, x, y, P * (2 + Math.round(fade * 2)));

      if (lance.age < lance.life) continue;
      g.destroy();
      this.lances = this.lances.filter((l) => l !== lance);
    }
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
