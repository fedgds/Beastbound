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
import { P, pxArc, pxGroundRing, pxLine, snap } from '../art/PixelDraw.js';

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
  }

  reset() {
    for (const storm of this.blizzards) storm.gfx?.destroy();
    this.blizzards = [];
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
        break;
      }

      case 'iceWall': {
        hero.iceWallHp = eff.shield;
        hero.iceWallUntil = this.scene.clock + eff.duration;
        hero.setBarrier(true);
        this.scene.fx.iceWall(hero.x, hero.y - hero.spriteHeight * 0.42, hero.facing, eff.duration);
        this.scene.fx.skillBurst(hero.x, hero.y - hero.spriteHeight * 0.5, 0xa9f5ff, 'rune');
        this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 12, `ICE WALL · ${eff.shield}`, 0xa9f5ff);
        this.scene.time.delayedCall(eff.duration * 1000, () => {
          if (hero.iceWallUntil <= this.scene.clock + 0.02) {
            hero.iceWallHp = 0;
            hero.setBarrier(false);
          }
        });
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
