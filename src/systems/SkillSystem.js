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
import { HERO_STATE } from '../data/heroes.js';
import { GROUND_SQUASH, P, pxArc, pxDisc, pxGroundRing, pxLine, pxStar, snap } from '../art/PixelDraw.js';

const BLOOM_INTERVAL = 2.0;
const BLOOM_HEAL = 6;
const BLOOM_RADIUS = 120;

const DASH_DELAY = 0.09; // wind-up before the monster actually launches
const DASH_TIME = 0.26;
const DASH_SPARK_EVERY = 0.04;

// Frost Nova travels from a white-hot frozen core into denser, darker ice.
// Indices are deliberately discrete so the colour shift stays pixel-art crisp
// instead of becoming a smooth canvas gradient.
const NOVA_ICE_PALETTE = [
  0xffffff, 0xe9ffff, 0xd9fbff, 0xbff4ff,
  0xa9e8ff, 0x8fd8ff, 0x72cbed, 0x4e98c8, 0x2f6f92,
];

const SHIELD_BASH_PALETTE = [
  0xfffee2, 0xfff1a6, 0xffd45c, 0xe99a38, 0xb76526, 0x6b351d,
];

const JUDGMENT_PALETTE = [
  0xffffff, 0xfff7cf, 0xffe88a, 0xffce55, 0xe99a38, 0x9c5b49, 0x63356f,
];

const WHIRLWIND_PALETTE = [
  0xfffee2, 0xfff1a6, 0xffdc7a, 0xffc34d, 0xe99a38, 0xb76526, 0x6b351d,
  0xffffff,
];

// Call of Valor moves from a white-hot blessing into a warm, persistent gold.
// Keeping the tones discrete preserves the stepped sprite-sheet look.
const VALOR_PALETTE = [
  0xffffff, 0xfff8d4, 0xffe89a, 0xffd05c, 0xe7a840, 0xa96f2d, 0x66431f,
];

const SOLAR_PALETTE = [
  0xffffff, 0xfff1a6, 0xffcf55, 0xff9a32, 0xe95424, 0x9f2d20, 0x541b1c,
];

const NIGHTVEIL_PALETTE = [
  0xffffff, 0xeadcff, 0xd0a7ff, 0xaf68ed, 0x8240bd, 0x552b82, 0x2c193f, 0x151021,
];

const VENOM_PALETTE = [
  0xf1ffe3, 0xc9ff86, 0x89e052, 0x4ba83f, 0x7d47ad, 0x472763,
];

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
    this.shieldBashes = [];
    this.judgments = [];
    this.felineDashes = [];
    this.burningPalms = [];
    this.solarRoars = [];
    this.burns = [];
    this.solarFuries = [];
    this.shadowsteps = [];
    this.venomShots = [];
    this.poisons = [];
    this.umbralTraps = [];
    this.eclipseBarrages = [];
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

  /** Force a monster active for the Skill Lab while preserving its real hit path. */
  showcaseMonsterActive(monster, hero) {
    if (!monster?.alive || !hero?.alive) return;
    const id = monster.def.active?.id;
    monster.skillCd = {};
    monster.facing = hero.x >= monster.x ? 1 : -1;

    if (id === 'provoke' || id === 'radiantBloom') {
      this.onMonsterSummoned(monster);
      return;
    }

    if (id === 'recklessCharge' || id === 'lanceCharge') {
      hero.stationaryFor = 3;
      monster.dashing = false;
      monster.dash = null;
      this.tryRecklessCharge(monster, hero);
      return;
    }

    if (id === 'piercingArrow') {
      this.announce(monster, 'PIERCING ARROW', 0xeaf7c4);
      this.scene.audio?.playSkill(monster, id);
      this.scene.fx.alignmentHint(monster.x, monster.y, hero.x, 0xeaf7c4);
      this.scene.combat.fireProjectile(monster, hero, {
        texture: 'proj_pierce', speed: 520, radius: 10, pierce: true,
        trailColor: 0xbfffb0, trailLength: 26, targetList: [hero],
        onHit: (hit) => this.scene.combat.strike(monster, hit, {
          mult: 1.8, color: 0xbfffb0,
          onHit: (target, dealt) => this.#onMonsterHit(monster, target, dealt),
        }),
      });
      return;
    }

    if (id === 'croakOfSilence') {
      this.scene.telegraph.cancelActive('SILENCED');
      hero.applyStun(0.4);
      monster.play('attack', true);
      this.announce(monster, 'CROAK OF SILENCE', COLORS.tgControl);
      this.scene.audio?.playSkill(monster, id);
      this.scene.fx.ring(monster.x, monster.y - 10, 90, COLORS.tgControl, 420, 3);
      this.scene.fx.skillBurst(monster.x, monster.y - monster.spriteHeight * 0.5,
        COLORS.tgControl, 'rune');
      this.scene.fx.impact({ color: COLORS.tgControl, shake: 0.004, flash: 0.18, stop: 70 });
      return;
    }

    // Bombard and Phase Strike already have explicit forced-ready branches in
    // the normal attack executor, so the lab calls that exact production path.
    this.performAttack(monster, hero);
  }

  /** Demonstrate condition-based monster passives on demand in the Skill Lab. */
  showcaseMonsterPassive(monster, hero) {
    if (!monster?.alive || !hero?.alive) return;
    const id = monster.def.passive?.id;
    monster.facing = hero.x >= monster.x ? 1 : -1;

    switch (id) {
      case 'stoneSkin':
        monster.hp = Math.max(1, monster.maxHp * 0.35);
        monster.drawHpBar();
        monster._stoneSkinAnnounced = false;
        this.#tickStoneSkin(monster);
        break;
      case 'frenzyStrike':
        monster.hitCount = 3;
        this.performAttack(monster, hero);
        break;
      case 'snipersFocus':
        monster._focusWasActive = false;
        this.#tickSnipersFocus(monster, hero);
        this.performAttack(monster, hero);
        break;
      case 'mucus':
      case 'shortFuse':
        this.performAttack(monster, hero);
        break;
      case 'bloom':
        monster.hp = Math.max(1, monster.maxHp * 0.62);
        for (const ally of this.scene.monsters) {
          if (ally !== monster && ally.alive) ally.hp = Math.max(1, ally.maxHp * 0.58);
        }
        monster._bloomT = BLOOM_INTERVAL;
        this.#tickBloom(monster, 0);
        this.announce(monster, 'RADIANT BLOOM', COLORS.heal);
        break;
      case 'mounted':
        monster.play('move', true);
        this.announce(monster, 'MOUNTED SPEED', 0x83f1d0);
        this.scene.fx.skillBurst(monster.x, monster.y - monster.spriteHeight * 0.45, 0x83f1d0, 'arcane');
        this.scene.fx.footDust(monster.x, monster.y, monster.facing);
        this.scene.fx.ring(monster.x, monster.y, 48, 0x83f1d0, 360, 2);
        break;
      case 'ethereal':
        monster.play('hit', true);
        this.announce(monster, 'ETHEREAL · DODGE', 0x9be8ff);
        this.scene.fx.skillBurst(monster.x, monster.y - monster.spriteHeight * 0.5, 0x9be8ff, 'arcane');
        this.scene.fx.ring(monster.x, monster.y - 8, 58, 0x9be8ff, 420, 3);
        break;
      default:
        break;
    }
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
    this.#tickShieldBashes(dt);
    this.#tickJudgments(dt);
    this.#tickFelineDashes(dt);
    this.#tickBurningPalms(dt);
    this.#tickSolarRoars(dt);
    this.#tickBurns(dt);
    this.#tickSolarFuries(dt);
    this.#tickShadowsteps(dt);
    this.#tickVenomShots(dt);
    this.#tickPoisons(dt);
    this.#tickUmbralTraps(dt);
    this.#tickEclipseBarrages(dt);
  }

  reset() {
    // One sweep over every live-effect array: each entry owns its Graphics (a
    // couple own a second one in the air layer), and nothing may outlive a floor.
    for (const list of [
      this.blizzards, this.spins, this.auras, this.iceWalls, this.novas, this.lances,
      this.shieldBashes, this.judgments, this.felineDashes, this.burningPalms,
      this.solarRoars, this.burns, this.solarFuries, this.shadowsteps, this.venomShots,
      this.poisons, this.umbralTraps, this.eclipseBarrages,
    ]) {
      for (const e of list) { e.gfx?.destroy(); e.gfxBack?.destroy(); e.gfxAir?.destroy(); }
    }
    this.blizzards = [];
    this.spins = [];
    this.auras = [];
    this.iceWalls = [];
    this.novas = [];
    this.lances = [];
    this.shieldBashes = [];
    this.judgments = [];
    this.felineDashes = [];
    this.burningPalms = [];
    this.solarRoars = [];
    this.burns = [];
    this.solarFuries = [];
    this.shadowsteps = [];
    this.venomShots = [];
    this.poisons = [];
    this.umbralTraps = [];
    this.eclipseBarrages = [];
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
          {
            knockback: eff.knockback,
            color: skill.id === 'shieldBash' ? SHIELD_BASH_PALETTE[2] : COLORS.tgDamage,
          },
        );
        if (skill.id === 'shieldBash') {
          this.#startShieldBash(hero, facing, eff);
        } else {
          this.scene.fx.slash(hero.x + facing * 20, y, facing, COLORS.tgDamage);
        }
        this.scene.fx.impact({
          color: skill.id === 'shieldBash' ? SHIELD_BASH_PALETTE[2] : COLORS.tgDamage,
          shake: 0.012, flash: 0.28, stop: 95,
        });
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
        this.#judgmentFx(hero, skill, x, y, eff);
        break;
      }

      case 'selfBuff': {
        hero.heal(Math.round(hero.maxHp * eff.healPct));
        hero.applyAtkBuff(eff.atkMult, eff.duration);
        hero.enraged = true;
        hero.sprite.setTint(0xffdca8);
        this.scene.fx.skillBurst(hero.x, hero.y - 4, VALOR_PALETTE[2], 'rune');
        this.scene.fx.ring(hero.x, hero.y - 10, 110, VALOR_PALETTE[3], 520, 4);
        this.scene.fx.screenFlash(VALOR_PALETTE[2], 0.25, 180);
        this.scene.fx.popText(hero.x, hero.y - 80, 'ENRAGED', VALOR_PALETTE[2]);
        // A buff that lasts the rest of the fight needs a standing visual, not a
        // single ring the player may have blinked through.
        if (eff.aura) this.#startAura(hero, eff);
        break;
      }

      case 'shadowstep': {
        this.#startShadowstep(hero, eff);
        break;
      }

      case 'venomArrow': {
        const facing = ctx.facing ?? hero.facing;
        this.#startVenomShot(hero, skill, facing, eff);
        break;
      }

      case 'umbralTrap': {
        const x = ctx.x ?? hero.x;
        const y = ctx.y ?? hero.y;
        const victims = this.scene.combat.monstersInCircle(x, y, eff.radius);
        for (const m of victims) {
          this.scene.combat.strike(hero, m, {
            mult: eff.mult, color: NIGHTVEIL_PALETTE[3], knockback: 8,
          });
          m.applyStun(eff.rootSeconds);
          m.applySlow(eff.slowMult, eff.slowSeconds);
        }
        this.#startUmbralTrap(x, y, eff);
        this.scene.fx.scorch(x, y + 8, eff.radius * 0.72, NIGHTVEIL_PALETTE[5]);
        this.#report(skill, victims.length);
        break;
      }

      case 'eclipseBarrage': {
        this.#startEclipseBarrage(hero, skill, ctx, eff);
        break;
      }

      case 'felineDash': {
        this.#startFelineDash(hero, eff);
        break;
      }

      case 'burningPalm': {
        const y = hero.y - 10;
        const facing = ctx.facing ?? hero.facing;
        const victims = this.scene.combat.monstersInCone(
          hero.x, y, facing, eff.radius, eff.arc,
        );
        for (const m of victims) {
          const dealt = this.scene.combat.strike(hero, m, {
            mult: eff.mult,
            color: SOLAR_PALETTE[3],
            knockback: eff.knockback,
          });
          if (dealt > 0) this.#applyBurn(hero, m, eff);
        }
        this.#startBurningPalm(hero, facing, eff);
        this.scene.fx.impact({ color: SOLAR_PALETTE[3], shake: 0.012, flash: 0.3, stop: 90 });
        this.#report(skill, victims.length);
        break;
      }

      case 'solarRoar': {
        const y = hero.y - 10;
        const victims = this.scene.combat.monstersInCircle(hero.x, y, eff.radius);
        for (const m of victims) {
          this.scene.combat.strike(hero, m, {
            mult: eff.mult, color: SOLAR_PALETTE[2], knockback: eff.knockback,
          });
          m.applyStun(eff.stunSeconds);
          m.applySlow(eff.slowMult, eff.slowSeconds);
        }
        this.#startSolarRoar(hero, eff);
        this.scene.fx.impact({ color: SOLAR_PALETTE[2], shake: 0.018, flash: 0.42, stop: 125 });
        this.#report(skill, victims.length);
        break;
      }

      case 'solarLionFury': {
        this.#startSolarFury(hero, skill, eff);
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
          x: hero.x, y, r: eff.radius,
          grow: eff.grow ?? 0.5,
          life: eff.life ?? eff.grow ?? 0.5,
          age: 0,
          phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
          gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
          gfxAir: this.scene.add.graphics().setDepth(DEPTH.unitFx),
        });
        // The casting flash gives the expanding wave a clear source instead
        // of making the first visible frame look like a UI circle appearing.
        this.scene.fx.skillBurst(hero.x, y - 22, 0xd9fbff, 'arcane');
        this.scene.fx.ring(hero.x, y, eff.radius * 0.34, 0xd9fbff, 260, 2);
        this.scene.fx.scorch(hero.x, hero.y, eff.radius * 0.5, 0x8fd8ff);
        this.scene.fx.impact({ color: 0xa9f5ff, shake: 0.012, flash: 0.28, stop: 100 });
        this.#report(skill, victims.length);
        break;
      }

      /** A directional chain of ice eruptions that can be sidestepped. */
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
          phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
          gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
          gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
        });
        // The first fracture opens at the Mage's feet; the remaining crystals
        // then erupt away from it along the warned cone.
        this.scene.fx.skillBurst(hero.x + facing * 14, y + 4, 0xe9ffff, 'rune');
        this.scene.fx.ring(hero.x + facing * 14, y + 5, 30, 0x8fd8ff, 240, 2);
        this.scene.fx.impact({ color: 0xa9f5ff, shake: 0.014, flash: 0.3, stop: 105 });
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

  #judgmentFx(hero, skill, x, y, eff) {
    this.judgments.push({
      hero, skill, x, y,
      radius: eff.radius,
      life: eff.fxLife ?? 1.45,
      age: 0,
      waves: eff.waves ?? 3,
      wave: 0,
      firstWaveDelay: eff.firstWaveDelay ?? 0.12,
      nextWaveAt: eff.firstWaveDelay ?? 0.12,
      waveInterval: eff.waveInterval ?? 0.36,
      mult: eff.mult ?? 1,
      knockback: eff.knockback ?? 70,
      hits: new Set(),
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });

    // The ultimate leaves the floor's biggest scar — the room remembers it
    // after the animated halo and divine column have dissipated.
    this.scene.fx.scorch(x, y, eff.radius * 0.72, JUDGMENT_PALETTE[5]);
  }

  /** One beat of Judgment. Damage is intentionally resolved on the visual
   * pulse, so the three columns feel like three real impacts instead of a
   * single hit wearing a longer animation. */
  #strikeJudgmentWave(judgment) {
    const { hero, x, y, radius, mult, knockback, wave, waves } = judgment;
    if (!hero.alive) return;
    const last = wave === waves - 1;
    const victims = this.scene.combat.monstersInCircle(x, y, radius);
    for (const m of victims) {
      this.scene.combat.strike(hero, m, {
        mult,
        color: last ? JUDGMENT_PALETTE[1] : JUDGMENT_PALETTE[3],
        knockback: last ? knockback : Math.round(knockback * 0.34),
      });
      judgment.hits.add(m);
    }
    const pulseRadius = radius * (0.4 + wave * 0.3);
    this.scene.fx.skillBurst(x, y - 10, JUDGMENT_PALETTE[last ? 1 : 3], 'explosion');
    this.scene.fx.ring(x, y, pulseRadius, JUDGMENT_PALETTE[last ? 1 : 3], 340, last ? 4 : 2);
    this.scene.fx.impact(last
      ? { color: JUDGMENT_PALETTE[1], shake: 0.024, flash: 0.46, stop: 125 }
      : { color: JUDGMENT_PALETTE[3], shake: 0.012, flash: 0.2, stop: 55 });
  }

  #tickJudgments(dt) {
    for (const judgment of [...this.judgments]) {
      judgment.age += dt;
      while (judgment.wave < judgment.waves && judgment.age >= judgment.nextWaveAt) {
        this.#strikeJudgmentWave(judgment);
        judgment.wave += 1;
        judgment.nextWaveAt += judgment.waveInterval;
      }
      const p = Phaser.Math.Clamp(judgment.age / judgment.life, 0, 1);
      const strike = Phaser.Math.Clamp(judgment.age / 0.2, 0, 1);
      const burst = Phaser.Math.Clamp((judgment.age - 0.12) / 0.34, 0, 1);
      const release = Phaser.Math.Clamp((judgment.age - 0.32) / 0.78, 0, 1);
      const fade = p < 0.7 ? 1 : Math.max(0, 1 - (p - 0.7) / 0.3);
      // Three stepped flashes make the pillar visibly judder on each damage
      // beat. The long tail then lets the holy seal decay rather than blink out.
      const beatAge = Math.max(0, judgment.age - (judgment.firstWaveDelay ?? 0.12));
      const beatPhase = (beatAge % judgment.waveInterval) / judgment.waveInterval;
      const activeBeat = judgment.wave < judgment.waves || beatPhase < 0.5;
      const beamFade = activeBeat
        ? 0.55 + Math.max(0, 1 - beatPhase * 2) * 0.45
        : Math.max(0, 1 - (judgment.age - (judgment.nextWaveAt - judgment.waveInterval)) / 0.65);
      const pulseJitter = judgment.wave > 0 ? ((Math.floor(judgment.age * 42) % 2) * 2 - 1) * P : 0;
      const g = judgment.gfx;
      const air = judgment.gfxAir;
      const x = snap(judgment.x);
      const y = snap(judgment.y);
      const radius = judgment.radius;
      g.clear();
      air.clear();

      // The first ground response is a compact white-hot core. It widens into
      // the holy seal only after the descending column has made contact.
      const coreR = radius * (0.08 + burst * 0.18);
      g.fillStyle(JUDGMENT_PALETTE[2], (0.34 + (1 - release) * 0.22) * fade);
      pxDisc(g, x, y, coreR, coreR * GROUND_SQUASH, { every: release > 0.5 ? 2 : 1 });
      g.fillStyle(JUDGMENT_PALETTE[0], 0.82 * (1 - release * 0.7) * fade);
      pxGroundRing(g, x, y, coreR * 0.74, { dash: 3, gap: 2, rot: Math.floor(judgment.age * 16) });

      // Two expanding halos: the outer ring marks the full impact footprint,
      // while the inner solid seal mirrors the circular frames in the sheet.
      if (burst > 0) {
        const outerR = radius * (0.18 + burst * 0.82);
        const crownR = radius * (0.2 + burst * 0.43);
        g.fillStyle(JUDGMENT_PALETTE[3], (0.58 - release * 0.28) * fade);
        pxGroundRing(g, x, y, outerR, {
          dash: release > 0.45 ? 5 : 0,
          gap: release > 0.45 ? 4 : 0,
          rot: release * 5,
        });
        g.fillStyle(JUDGMENT_PALETTE[1], (0.86 - release * 0.4) * fade);
        pxGroundRing(g, x, y, crownR, { dash: 4, gap: 2, rot: -release * 8 });

        // Radial crown blades bend outward from the inner halo. Alternating
        // lengths create the winged sunburst silhouette in the reference.
        const bladeCount = 28;
        for (let i = 0; i < bladeCount; i++) {
          const a = judgment.phase + (i / bladeCount) * Math.PI * 2;
          const blade = radius * (0.1 + (i % 4) * 0.025) * (1 - release * 0.34);
          const x0 = x + Math.cos(a) * crownR;
          const y0 = y + Math.sin(a) * crownR * GROUND_SQUASH;
          const swept = a + (i % 2 ? 0.13 : -0.13);
          const x1 = x + Math.cos(swept) * (crownR + blade);
          const y1 = y + Math.sin(swept) * (crownR + blade) * GROUND_SQUASH;
          g.fillStyle(JUDGMENT_PALETTE[1 + (i % 4)], (0.75 - release * 0.32) * fade);
          pxLine(g, x0, y0, x1, y1);
          if (i % 3 === 0) pxStar(g, x1, y1, P * (1 + (i % 2)));
        }
      }

      // The descending column uses hard, stepped bands: bright central core,
      // warm gold shoulders and faint purple fringe near the floor.
      if (beamFade > 0) {
        const beamTop = Math.max(0, y - 360);
        const beamWidth = P * (5 + Math.round(strike * 7));
        const flicker = Math.floor(judgment.age * 24) % 3;
        air.fillStyle(JUDGMENT_PALETTE[4], 0.34 * beamFade);
        air.fillRect(snap(x - beamWidth * 1.45 + pulseJitter), beamTop, snap(beamWidth * 2.9), y - beamTop);
        air.fillStyle(JUDGMENT_PALETTE[2], 0.8 * beamFade);
        air.fillRect(snap(x - beamWidth * 0.75 - pulseJitter), beamTop, snap(beamWidth * 1.5), y - beamTop + P * 2);
        air.fillStyle(JUDGMENT_PALETTE[0], (0.92 - flicker * 0.08) * beamFade);
        air.fillRect(snap(x - beamWidth * 0.28 + pulseJitter), beamTop, Math.max(P * 2, snap(beamWidth * 0.56)), y - beamTop + P * 4);

        // Broken side streaks keep the pillar from looking like one rectangle.
        for (let i = 0; i < 8; i++) {
          const side = i % 2 ? 1 : -1;
          const sx = snap(x + side * (beamWidth + (i % 4) * P * 2));
          const sy = snap(beamTop + 24 + ((i * 47) % Math.max(40, y - beamTop - 30)));
          air.fillStyle(JUDGMENT_PALETTE[1 + (i % 4)], (0.3 + (i % 3) * 0.12) * beamFade);
          air.fillRect(sx, sy, P, P * (3 + (i % 4)));
        }
      }

      // Impact star and straight rays peak immediately after contact, then
      // recede behind the persistent circular crown.
      const latestWaveAt = judgment.firstWaveDelay
        + Math.max(0, judgment.wave - 1) * judgment.waveInterval;
      const starFade = Math.max(0, 1 - Math.abs(judgment.age - latestWaveAt) / 0.24);
      if (starFade > 0) {
        air.fillStyle(JUDGMENT_PALETTE[0], starFade * 0.94);
        pxStar(air, x, y - 4, P * (4 + Math.round(starFade * 7)));
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const len = radius * (0.2 + starFade * (0.16 + (i % 4) * 0.025));
          pxLine(air, x, y - 4,
            x + Math.cos(a) * len,
            y - 4 + Math.sin(a) * len * 0.72);
        }
      }

      // Gold and purple motes remain after the beam retracts, settling toward
      // the permanent scorch mark instead of disappearing on the impact frame.
      for (let i = 0; i < 52; i++) {
        const q = ((i * 17) % 53) / 52;
        const a = judgment.phase + i * 2.13 + release * (i % 2 ? 0.6 : -0.4);
        const driftR = radius * (0.12 + q * 0.64) * (0.65 + release * 0.35);
        const lift = (1 - release) * (12 + (i % 7) * 5);
        const mx = snap(x + Math.cos(a) * driftR);
        const my = snap(y + Math.sin(a) * driftR * GROUND_SQUASH - lift);
        const tone = i % 6 === 0 ? 6 : 1 + (i % 5);
        const moteFade = Math.min(1, burst * 2) * fade * (0.28 + (i % 4) * 0.14);
        air.fillStyle(JUDGMENT_PALETTE[tone], moteFade);
        air.fillRect(mx, my, i % 9 === 0 ? P * 2 : P, P * (1 + (i % 2)));
      }

      if (judgment.age < judgment.life) continue;
      this.#report(judgment.skill, judgment.hits.size);
      g.destroy();
      air.destroy();
      this.judgments = this.judgments.filter((j) => j !== judgment);
    }
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
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      hits: new Set(),
      fxTail: eff.fxTail ?? 0.82,
      lastBeatAt: null,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.screenFlash(WHIRLWIND_PALETTE[3], 0.18, 130);
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
            color: WHIRLWIND_PALETTE[last ? 1 : 3],
            knockback: last ? spin.knockback : spin.pull,
          });
          spin.hits.add(m);
        }
        this.scene.fx.ring(spin.x, spin.y, r, WHIRLWIND_PALETTE[last ? 1 : 3], 300, 3);
        for (let i = 0; i < 4; i++) {
          const a = spin.age * 11 + (i / 4) * Math.PI * 2;
          this.scene.fx.hitSpark(
            spin.x + Math.cos(a) * r, spin.y + Math.sin(a) * r * GROUND_SQUASH,
            last ? WHIRLWIND_PALETTE[7] : WHIRLWIND_PALETTE[2], 3, a,
          );
        }
        this.scene.audio?.playSkill(hero, last ? 'whirlwind' : 'whirlwindTick');
        this.scene.fx.impact(last
          ? { color: WHIRLWIND_PALETTE[1], shake: 0.016, flash: 0.34, stop: 110 }
          : { color: WHIRLWIND_PALETTE[3], shake: 0.006, flash: 0.12, stop: 45 });
        if (last) spin.lastBeatAt = spin.age;
        spin.beat += 1;
        spin.tick = spin.interval;
      }

      spin.gfx.clear();
      spin.gfxAir.clear();
      this.#drawWhirlwind(spin.gfx, spin.gfxAir, spin);

      if (spin.beat < spin.ticks && hero.alive) continue;
      // Let the explosion peak collapse into drifting wind dust before cleanup.
      if (spin.lastBeatAt !== null && spin.age - spin.lastBeatAt < spin.fxTail) continue;
      hero.facing = spin.facing0;
      this.scene.fx.scorch(spin.x, hero.y, spin.radius * 0.42, WHIRLWIND_PALETTE[5]);
      this.#report(spin.skill, spin.hits.size);
      spin.gfx.destroy();
      spin.gfxAir.destroy();
      this.spins = this.spins.filter((s) => s !== spin);
    }
  }

  /** Expanding spiral blades, explosion peak, then a long particle dissolve. */
  #drawWhirlwind(g, air, spin) {
    const x = snap(spin.x);
    const y = snap(spin.y);
    const a = spin.age * 12.5;
    const stepIndex = Math.min(Math.max(0, spin.beat), spin.steps.length - 1);
    const targetReach = spin.radius * (spin.steps[stepIndex] ?? 1);
    const windup = Phaser.Math.Clamp(spin.age / 0.22, 0, 1);
    const reach = targetReach * (0.28 + windup * 0.72);
    const tailP = spin.lastBeatAt === null
      ? 0
      : Phaser.Math.Clamp((spin.age - spin.lastBeatAt) / spin.fxTail, 0, 1);
    const vortexFade = spin.lastBeatAt === null ? 1 : Math.max(0, 1 - tailP * 1.25);

    // Three ground seals counter-rotate at different speeds. The outer ring is
    // sparse during wind-up, then fills as the damaging radius expands.
    g.fillStyle(WHIRLWIND_PALETTE[5], 0.2 * vortexFade);
    pxDisc(g, x, y + 4, reach * 0.92, reach * 0.92 * GROUND_SQUASH, { every: 5 });
    g.fillStyle(WHIRLWIND_PALETTE[3], 0.42 * vortexFade);
    pxGroundRing(g, x, y + 4, reach, {
      dash: 7, gap: 5, rot: Math.floor(spin.age * 18),
    });
    g.fillStyle(WHIRLWIND_PALETTE[2], 0.34 * vortexFade);
    pxGroundRing(g, x, y + 4, reach * 0.68, {
      dash: 4, gap: 3, rot: -Math.floor(spin.age * 24),
    });
    g.fillStyle(WHIRLWIND_PALETTE[6], 0.46 * vortexFade);
    pxGroundRing(g, x, y + 4, reach * 0.26, {
      dash: 2, gap: 2, rot: Math.floor(spin.age * 31),
    });

    // Sixteen curved blades form the spiral. Each blade is a chain of short
    // pixel lines whose angle bends as it moves outward, producing the hooked
    // wind strokes visible in the reference rather than simple circular arcs.
    const bladeCount = 16;
    const bladeSteps = 7;
    for (let blade = 0; blade < bladeCount; blade++) {
      const base = a + (blade / bladeCount) * Math.PI * 2;
      let px0 = x;
      let py0 = y - 8;
      for (let s = 0; s <= bladeSteps; s++) {
        const q = s / bladeSteps;
        const br = reach * (0.16 + q * 0.82);
        const ba = base + q * (0.72 + (blade % 3) * 0.08);
        const px1 = snap(x + Math.cos(ba) * br);
        const py1 = snap(y - 8 + Math.sin(ba) * br * GROUND_SQUASH);
        if (s > 0) {
          const tone = Math.min(WHIRLWIND_PALETTE.length - 2, 1 + (blade + s) % 5);
          air.fillStyle(WHIRLWIND_PALETTE[tone], (0.48 + q * 0.46) * vortexFade);
          pxLine(air, px0, py0, px1, py1);
          if (s >= bladeSteps - 2 && blade % 2 === 0) {
            air.fillStyle(WHIRLWIND_PALETTE[0], (0.54 + q * 0.35) * vortexFade);
            pxStar(air, px1, py1, s === bladeSteps ? P * 2 : P);
          }
        }
        px0 = px1;
        py0 = py1;
      }
    }

    // Broken outer crescents add the translucent frame-to-frame echoes around
    // the main vortex without closing it into a perfect circular border.
    for (let echo = 0; echo < 5; echo++) {
      const er = reach * (0.74 + echo * 0.055);
      const from = -a * 0.34 + echo * 1.31;
      air.fillStyle(WHIRLWIND_PALETTE[3 + (echo % 3)], (0.24 - echo * 0.025) * vortexFade);
      pxArc(air, x, y - 8, er, er * GROUND_SQUASH, {
        from, to: from + Math.PI * (0.34 + echo * 0.025),
        dash: 4, gap: 3,
      });
    }

    // The final combat beat peaks as a white-blue explosion inside the still
    // rotating blades, then collapses into gold and blue fragments.
    if (spin.lastBeatAt !== null) {
      const since = spin.age - spin.lastBeatAt;
      const peak = Math.max(0, 1 - since / 0.34);
      if (peak > 0) {
        const coreR = spin.radius * (0.12 + (1 - peak) * 0.34);
        air.fillStyle(WHIRLWIND_PALETTE[1], 0.82 * peak);
        pxDisc(air, x, y - 8, coreR, coreR * GROUND_SQUASH, { every: peak < 0.45 ? 2 : 1 });
        air.fillStyle(WHIRLWIND_PALETTE[0], 0.96 * peak);
        pxStar(air, x, y - 8, P * (5 + Math.round(peak * 8)));
        for (let i = 0; i < 20; i++) {
          const ra = a * 0.28 + (i / 20) * Math.PI * 2;
          const len = spin.radius * (0.22 + (i % 5) * 0.045) * peak;
          pxLine(air, x, y - 8,
            x + Math.cos(ra) * len,
            y - 8 + Math.sin(ra) * len * 0.72);
        }
      }
    }

    // Dense motes provide the long dissolve frames: mostly frost-blue during
    // the spin, with warm sparks appearing only after the explosion peak.
    const moteCount = 58;
    const moteAlpha = spin.lastBeatAt === null ? 0.55 : (1 - tailP) * 0.82;
    for (let i = 0; i < moteCount; i++) {
      const q = ((i * 23) % 59) / 58;
      const ma = spin.phase + i * 2.19 + spin.age * (2.2 + (i % 3));
      const spread = reach * (0.18 + q * (0.7 + tailP * 0.55));
      const mx = snap(x + Math.cos(ma) * spread);
      const my = snap(y - 8 + Math.sin(ma) * spread * GROUND_SQUASH - tailP * (i % 5) * 5);
      const warm = spin.lastBeatAt !== null && i % 7 === 0;
      const tone = warm ? 7 : 1 + (i % 6);
      air.fillStyle(WHIRLWIND_PALETTE[tone], moteAlpha * (0.32 + (i % 4) * 0.14));
      air.fillRect(mx, my, i % 11 === 0 ? P * 2 : P, P * (1 + (i % 2)));
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
      intro: eff.auraIntro ?? 0.95,
      age: 0,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      // Split the body rings so their rear halves pass behind the Knight while
      // their front halves cross in front, giving the flat ellipses real depth.
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.ghost),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
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
        this.#drawValorAura(aura.gfx, aura.gfxBack, aura.gfxAir, aura);
        continue;
      }
      aura.gfx.destroy();
      aura.gfxBack.destroy();
      aura.gfxAir.destroy();
      this.auras = this.auras.filter((a) => a !== aura);
    }
  }

  /** Ground blessing, body-wrapping halos, rising light and a lasting gold glow. */
  #drawValorAura(g, back, air, aura) {
    const { hero } = aura;
    const x = snap(hero.x);
    const y = snap(hero.y);
    const h = hero.spriteHeight;
    const chestY = snap(y - h * 0.5);
    const pulse = 0.5 + 0.5 * Math.sin(aura.age * 3.4);
    const introP = Phaser.Math.Clamp(aura.age / aura.intro, 0, 1);
    const introPower = 1 - introP;
    const haloOpen = Phaser.Math.Clamp(introP * 1.8, 0, 1);

    g.clear();
    // The seal expands quickly on cast, then remains as three counter-rotating
    // rings so the long-lived buff is always readable at the Knight's feet.
    const sealR = 30 + haloOpen * 24;
    g.fillStyle(VALOR_PALETTE[5], 0.11 + pulse * 0.04);
    pxDisc(g, x, y + 2, sealR * 0.84, sealR * 0.84 * GROUND_SQUASH, { every: 3 });
    g.fillStyle(VALOR_PALETTE[3], 0.42 + pulse * 0.16);
    pxGroundRing(g, x, y + 2, sealR, { dash: 5, gap: 2, rot: Math.floor(aura.age * 11) });
    g.fillStyle(VALOR_PALETTE[1], 0.33 + pulse * 0.14);
    pxGroundRing(g, x, y + 2, sealR * 0.72, { dash: 2, gap: 2, rot: -Math.floor(aura.age * 15) });
    g.fillStyle(VALOR_PALETTE[4], 0.38);
    pxGroundRing(g, x, y + 2, sealR * 0.42, { dash: 1, gap: 2, rot: Math.floor(aura.age * 18) });

    // The first frames erupt into the jagged sunburst seen in the reference.
    if (introPower > 0) {
      const burstR = 24 + introP * 52;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const inner = 12 + (i % 2) * 6;
        const outer = burstR * (0.72 + (i % 4) * 0.09);
        g.fillStyle(VALOR_PALETTE[i % 3], (0.38 + (i % 3) * 0.12) * introPower);
        pxLine(g,
          x + Math.cos(a) * inner, y + Math.sin(a) * inner * GROUND_SQUASH,
          x + Math.cos(a) * outer, y + Math.sin(a) * outer * GROUND_SQUASH);
      }
      g.fillStyle(VALOR_PALETTE[0], 0.8 * introPower);
      pxStar(g, x, y - 1, P * (3 + Math.round(introPower * 3)));
    }

    back.clear();
    air.clear();

    // A layered pillar rises behind the Knight during the cast. Its hard-edged
    // bands echo the reference's white centre and progressively darker gold rim
    // without introducing a smooth, non-pixel-art gradient.
    if (introPower > 0) {
      const shaftRise = Phaser.Math.Clamp(aura.age / (aura.intro * 0.62), 0, 1);
      const shaftTop = snap(y - (h + 46) * shaftRise);
      const shaftHeight = Math.max(P, y - shaftTop);
      back.fillStyle(VALOR_PALETTE[5], 0.12 * introPower);
      back.fillRect(x - P * 8, shaftTop, P * 16, shaftHeight);
      back.fillStyle(VALOR_PALETTE[3], 0.2 * introPower);
      back.fillRect(x - P * 5, shaftTop, P * 10, shaftHeight);
      back.fillStyle(VALOR_PALETTE[1], 0.36 * introPower);
      back.fillRect(x - P * 2, shaftTop, P * 4, shaftHeight);
      back.fillStyle(VALOR_PALETTE[0], 0.7 * introPower);
      back.fillRect(x - P / 2, shaftTop, P, shaftHeight);
    }

    // Three horizontal halos climb into position during the invocation. Drawing
    // their upper and lower halves on opposite depths makes them encircle the
    // character instead of reading as a straight line across the sprite.
    const haloSpecs = [
      { y: 0.72, rx: 37, ry: 8, speed: 9 },
      { y: 0.48, rx: 45, ry: 10, speed: -7 },
      { y: 0.25, rx: 34, ry: 7, speed: 12 },
    ];
    for (let i = 0; i < haloSpecs.length; i++) {
      const spec = haloSpecs[i];
      const ringY = snap(y - h * spec.y + (1 - haloOpen) * 24);
      const rx = spec.rx * (0.55 + haloOpen * 0.45) * (0.96 + pulse * 0.06);
      const alpha = (0.38 + pulse * 0.22) * (0.55 + haloOpen * 0.45);
      const rot = Math.floor(aura.age * spec.speed) + i * 2;
      back.fillStyle(VALOR_PALETTE[4 - (i % 2)], alpha * 0.68);
      pxArc(back, x, ringY, rx, spec.ry, {
        from: Math.PI, to: Math.PI * 2, dash: 6 - i, gap: 2, rot,
      });
      air.fillStyle(VALOR_PALETTE[1 + (i % 3)], alpha);
      pxArc(air, x, ringY, rx, spec.ry, {
        from: 0, to: Math.PI, dash: 6 - i, gap: 2, rot,
      });
      // White leading glints make each rotating band feel energized.
      const ga = aura.age * (spec.speed > 0 ? 1.7 : -1.5) + i * 2.1;
      air.fillStyle(VALOR_PALETTE[0], 0.46 + pulse * 0.32);
      pxStar(air, x + Math.cos(ga) * rx, ringY + Math.sin(ga) * spec.ry, P * (i === 1 ? 2 : 1));
    }

    // A restrained glow follows the body after the invocation; the sprite tint
    // supplies the golden silhouette while these scanlines create its aura.
    air.fillStyle(VALOR_PALETTE[2], 0.06 + pulse * 0.045);
    pxDisc(air, x, chestY, 22 + pulse * 3, h * 0.48, { every: 4 });
    air.fillStyle(VALOR_PALETTE[0], 0.28 + introPower * 0.52);
    pxStar(air, x, chestY, P * (2 + Math.round(introPower * 4)));

    // Dense upward particles form the opening light column, then settle into a
    // constant shower that communicates the permanent heal/attack buff.
    const moteCount = introPower > 0 ? 34 : 20;
    for (let i = 0; i < moteCount; i++) {
      const seed = ((i * 29) % 71) / 70;
      const ph = (aura.age * (0.42 + (i % 4) * 0.05) + seed) % 1;
      const spread = 11 + (i % 6) * 5 + introPower * 12;
      const drift = Math.sin(aura.age * (1.1 + (i % 3) * 0.25) + i * 2.17);
      const mx = snap(x + drift * spread);
      const my = snap(y - 3 - ph * (h + 34));
      const tone = 1 + ((i + Math.floor(ph * 4)) % (VALOR_PALETTE.length - 1));
      const alpha = (1 - ph * 0.72) * (0.36 + (i % 4) * 0.13);
      air.fillStyle(VALOR_PALETTE[tone], alpha);
      const size = i % 9 === 0 ? P * 2 : P;
      air.fillRect(mx, my, size, i % 5 === 0 ? P * 2 : P);
      if (i % 11 === 0) {
        air.fillStyle(VALOR_PALETTE[0], alpha * 0.9);
        pxStar(air, mx, my, P);
      }
    }
  }

  // ── Shield Bash: a travelling shield crest with stepped afterimages ──────
  #startShieldBash(hero, facing, eff) {
    const y = hero.y - hero.spriteHeight * 0.45;
    this.shieldBashes.push({
      x: hero.x,
      y,
      dir: facing,
      radius: eff.radius,
      travel: eff.waveTravel ?? 0.34,
      life: eff.waveLife ?? 0.68,
      crestScale: eff.crestScale ?? 1,
      age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });

    // Compact release flash: the shield wave should visibly leave the Knight
    // rather than appearing halfway across the cone on its first frame.
    this.scene.fx.skillBurst(hero.x + facing * 18, y, SHIELD_BASH_PALETTE[2], 'arcane');
    this.scene.fx.ring(hero.x + facing * 16, hero.y + 3, 24, SHIELD_BASH_PALETTE[3], 220, 2);
  }

  #tickShieldBashes(dt) {
    for (const bash of [...this.shieldBashes]) {
      bash.age += dt;
      const travelP = Phaser.Math.Clamp(bash.age / bash.travel, 0, 1);
      const lifeP = Phaser.Math.Clamp(bash.age / bash.life, 0, 1);
      const fade = lifeP < 0.68 ? 1 : Math.max(0, 1 - (lifeP - 0.68) / 0.32);
      const g = bash.gfx;
      g.clear();

      // Oldest echo first, bright head last. Each echo occupies an earlier
      // point on the same path instead of scaling a single translucent sprite.
      for (let echo = 3; echo >= 0; echo--) {
        const ep = Math.max(0, travelP - echo * 0.135);
        if (echo > 0 && ep <= 0) continue;
        const x = snap(bash.x + bash.dir * (16 + bash.radius * ep));
        const y = snap(bash.y + Math.sin(bash.phase + ep * 7) * P);
        const alpha = fade * (echo === 0 ? 0.95 : 0.1 + (3 - echo) * 0.1);
        // The leading crest is deliberately almost as tall as the cone's
        // mouth: it now reads as a shield wall sweeping left-to-right (or
        // right-to-left) instead of a small projectile inside its warning.
        const width = (34 + ep * 15 - echo * 2) * bash.crestScale;
        const height = (42 + ep * 13 - echo * 3) * bash.crestScale;
        this.#drawShieldCrest(g, x, y, bash.dir, width, height, alpha, echo === 0, bash.age);
      }

      // Pixel sparks stream backward from the live crest, mirroring the small
      // energy fragments between frames in the reference sheet.
      const headX = snap(bash.x + bash.dir * (16 + bash.radius * travelP));
      for (let i = 0; i < 15; i++) {
        const trail = 8 + (i % 6) * 8 + travelP * 10;
        const sy = snap(bash.y + Math.sin(bash.phase + i * 1.73 + bash.age * 8) * (8 + (i % 4) * 4));
        const sx = snap(headX - bash.dir * trail);
        g.fillStyle(SHIELD_BASH_PALETTE[2 + (i % 4)], (0.22 + (i % 3) * 0.12) * fade);
        g.fillRect(sx, sy, i % 5 === 0 ? P * 2 : P, P);
      }

      if (bash.age < bash.life) continue;
      g.destroy();
      this.shieldBashes = this.shieldBashes.filter((b) => b !== bash);
    }
  }

  /** Pixel-rasterised arrowhead shield with a bright rim and inner sigil. */
  #drawShieldCrest(g, cx, cy, dir, width, height, alpha, bright, age) {
    const halfRows = Math.max(2, Math.round(height / (P * 2)));

    // Scanline-filled convex shield: pointed at the impact side, not a flat
    // rectangle. Alternating tones preserve detail in the translucent echoes.
    for (let row = -halfRows; row <= halfRows; row++) {
      const v = Math.abs(row) / halfRows;
      if (v >= 1) continue;
      const front = cx + dir * width * (0.58 - v * 0.34);
      const back = cx - dir * width * (0.3 - v * 0.16);
      const left = snap(Math.min(front, back));
      const right = snap(Math.max(front, back));
      const tone = bright
        ? 2 + (Math.abs(row) % 3)
        : 4 + (Math.abs(row) % 2);
      g.fillStyle(SHIELD_BASH_PALETTE[tone], alpha * (0.5 + (1 - v) * 0.28));
      g.fillRect(left, snap(cy + row * P), Math.max(P, right - left), P);
    }

    const tipX = snap(cx + dir * width * 0.62);
    const backX = snap(cx - dir * width * 0.34);
    const topY = snap(cy - height * 0.46);
    const bottomY = snap(cy + height * 0.46);

    // Double gold outline and jagged rear fins make the leading frame readable
    // as a magical shield bash instead of a generic projectile.
    g.fillStyle(bright ? SHIELD_BASH_PALETTE[1] : SHIELD_BASH_PALETTE[4], alpha);
    pxLine(g, tipX, cy, snap(cx + dir * width * 0.22), topY);
    pxLine(g, snap(cx + dir * width * 0.22), topY, backX, snap(cy - height * 0.25));
    pxLine(g, backX, snap(cy - height * 0.25), snap(cx - dir * width * 0.22), cy);
    pxLine(g, snap(cx - dir * width * 0.22), cy, backX, snap(cy + height * 0.25));
    pxLine(g, backX, snap(cy + height * 0.25), snap(cx + dir * width * 0.22), bottomY);
    pxLine(g, snap(cx + dir * width * 0.22), bottomY, tipX, cy);

    g.fillStyle(bright ? SHIELD_BASH_PALETTE[0] : SHIELD_BASH_PALETTE[3], alpha * 0.78);
    pxLine(g, tipX - dir * P * 3, cy, snap(cx + dir * width * 0.15), snap(cy - height * 0.31));
    pxLine(g, tipX - dir * P * 3, cy, snap(cx + dir * width * 0.15), snap(cy + height * 0.31));

    for (let fin = -2; fin <= 2; fin++) {
      const fy = snap(cy + fin * height * 0.16);
      const extra = width * (0.16 + (Math.abs(fin) % 2) * 0.08);
      g.fillStyle(SHIELD_BASH_PALETTE[bright ? 2 : 5], alpha * (0.58 - Math.abs(fin) * 0.07));
      pxLine(g, backX, fy, backX - dir * extra, fy + fin * P * 2);
    }

    // Rotating diamond-and-star sigil in the centre of the leading shield.
    const pulse = 0.65 + 0.35 * Math.sin(age * 18);
    const sigil = P * (bright ? 5 : 3);
    g.fillStyle(SHIELD_BASH_PALETTE[bright ? 0 : 3], alpha * pulse);
    pxLine(g, cx, cy - sigil, cx + sigil, cy);
    pxLine(g, cx + sigil, cy, cx, cy + sigil);
    pxLine(g, cx, cy + sigil, cx - sigil, cy);
    pxLine(g, cx - sigil, cy, cx, cy - sigil);
    pxStar(g, cx, cy, bright ? P * 2 : P);
  }

  // ── Ice Wall: a jagged ring whose cracks mirror the shield's state ───────
  #startIceWall(hero, eff) {
    const count = eff.segments ?? 24;
    const ringRadius = eff.ringRadius ?? 68;

    const segments = [];
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (i / count) * Math.PI * 2;
      const radius = ringRadius + ((i % 4) - 1.5) * 3;
      const seg = {
        angle,
        radius,
        x: hero.x + Math.cos(angle) * radius,
        y: hero.y + Math.sin(angle) * radius * GROUND_SQUASH,
        w: 11 + (i % 4) * 2,
        h: 30 + ((i * 17) % 6) * 8 + (i % 5 === 0 ? 18 : 0),
        lean: Math.cos(angle) * (7 + (i % 4) * 2),
        tone: 2 + (i % 4),
        delay: (i % 6) * 0.025,
      };
      segments.push(seg);
      // Four large rune bursts mark the ring; spawning one under every shard
      // would hide the uneven silhouette in a solid flash.
      if (i % 6 === 0) this.scene.fx.skillBurst(seg.x, seg.y, 0xa9f5ff, 'rune');
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
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.unit - 1),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
  }

  #tickIceWalls(dt) {
    for (const wall of [...this.iceWalls]) {
      const { hero } = wall;
      wall.age += dt;
      wall.left -= dt;
      wall.chill -= dt;

      // Keep the ring centred on the shield bearer. The crystal bases retain
      // their individual angles/radii, so moving the Mage never collapses the
      // wall into a line or leaves the shield visual behind.
      for (const seg of wall.segments) {
        seg.x = hero.x + Math.cos(seg.angle) * seg.radius;
        seg.y = hero.y + Math.sin(seg.angle) * seg.radius * GROUND_SQUASH;
      }

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
      wall.gfxBack.clear();
      wall.gfxAir.clear();
      this.#drawIceWall(wall.gfx, wall.gfxBack, wall.gfxAir, wall);

      const spent = hero.iceWallHp <= 0 || wall.left <= 0 || !hero.alive;
      if (!spent) continue;

      // Shatter: every nearby monster is struck once even though the circular
      // wall now contains many overlapping crystal segments.
      const shattered = new Set();
      for (const [i, seg] of wall.segments.entries()) {
        for (const m of this.scene.combat.monstersInCircle(seg.x, seg.y, wall.shatterRadius)) {
          shattered.add(m);
        }
        if (i % 4 === 0) this.scene.fx.ring(seg.x, seg.y, 34, 0xa9f5ff, 360, 3);
        if (i % 2 === 0) this.scene.fx.hitSpark(seg.x, seg.y - seg.h * 0.5, 0xd9fbff, 5, -Math.PI / 2);
        this.scene.fx.scorch(seg.x, seg.y, 8 + (i % 3) * 2, 0x8fd8ff);
      }
      for (const m of shattered) {
        this.scene.combat.strike(hero, m, {
          mult: wall.shatterMult, color: 0xa9f5ff, knockback: 30,
        });
        m.applySlow(wall.slowMult, wall.slowSeconds * 1.4);
      }
      this.scene.fx.impact({ color: 0xa9f5ff, shake: 0.01, flash: 0.22, stop: 80 });
      hero.iceWallHp = 0;
      hero.iceWallUntil = 0;
      hero.setBarrier(false);
      wall.gfx.destroy();
      wall.gfxBack.destroy();
      wall.gfxAir.destroy();
      this.iceWalls = this.iceWalls.filter((w) => w !== wall);
    }
  }

  /** Draws grounded fissures plus back/front crystal layers around the Mage. */
  #drawIceWall(g, back, front, wall) {
    const fade = wall.left < 0.6 ? Math.max(0.15, wall.left / 0.6) : 1;
    const shimmer = 0.5 + 0.5 * Math.sin(wall.age * 4);

    for (const [i, seg] of wall.segments.entries()) {
      const x = snap(seg.x);
      const y = snap(seg.y);
      const rise = Phaser.Math.Clamp((wall.age - seg.delay) / 0.38, 0, 1);
      if (rise <= 0) continue;

      // Frost footprint and two uneven cracks make the crystal read as having
      // punched through the floor rather than hovering around the character.
      const groundTone = Math.min(seg.tone + 3, NOVA_ICE_PALETTE.length - 1);
      g.fillStyle(NOVA_ICE_PALETTE[groundTone], 0.2 * fade * rise);
      pxDisc(g, x, y + 3, seg.w + 7, (seg.w + 7) * GROUND_SQUASH);
      g.fillStyle(NOVA_ICE_PALETTE[Math.min(seg.tone + 2, NOVA_ICE_PALETTE.length - 1)], 0.58 * fade * rise);
      for (const branch of [-1, 1]) {
        const a = seg.angle + branch * (0.28 + (i % 3) * 0.07);
        const len = 13 + (i % 4) * 4;
        pxLine(g, x, y,
          x + Math.cos(a) * len,
          y + Math.sin(a) * len * GROUND_SQUASH);
      }

      // Negative-sine points sit behind the Mage; positive-sine points are in
      // front and cover its feet, creating an actual enclosing ring.
      const layer = Math.sin(seg.angle) < 0 ? back : front;
      this.#drawLanceCrystal(layer, x, y, {
        height: seg.h,
        width: seg.w,
        lean: seg.lean,
        grow: rise,
        tone: seg.tone,
        alpha: fade * (0.9 + shimmer * 0.1),
      });

      // A shorter companion shard doubles the irregular silhouette without
      // making the gameplay segment count (chill/shatter checks) any denser.
      if (i % 2 === 0) {
        const side = i % 4 < 2 ? -1 : 1;
        this.#drawLanceCrystal(layer,
          x + side * (seg.w * 0.72),
          y + (i % 3 - 1) * 3, {
            height: seg.h * (0.42 + (i % 3) * 0.09),
            width: seg.w * 0.62,
            lean: seg.lean * 0.55 + side * 4,
            grow: Phaser.Math.Clamp(rise * 1.15 - 0.08, 0, 1),
            tone: Math.min(seg.tone + 1, NOVA_ICE_PALETTE.length - 2),
            alpha: fade * 0.82,
          });
      }

      // cracks appear as the Mage's shield is spent: the wall shows its HP
      layer.fillStyle(0x2f6f92, 0.75 * fade);
      for (let c = 0; c < wall.stage; c++) {
        const cy = y - seg.h * rise * (0.28 + c * 0.26);
        const dir = (i + c) % 2 ? 1 : -1;
        pxLine(layer, x - dir * seg.w * 0.4, cy, x, cy - 5);
        pxLine(layer, x, cy - 5, x + dir * seg.w * 0.35, cy - 1);
      }
    }
  }

  // ── Frost Nova: an expanding ring of spikes ──────────────────────────────
  #tickNovas(dt) {
    for (const nova of [...this.novas]) {
      nova.age += dt;
      const g = nova.gfx;
      const air = nova.gfxAir;
      g.clear();
      air.clear();

      const p = Math.min(1, nova.age / nova.life);
      const travel = Math.min(1, nova.age / nova.grow);
      const r = nova.r * (0.25 + 0.75 * travel);
      const fade = 1 - p;
      const x = snap(nova.x);
      const y = snap(nova.y);
      const phaseTone = Math.min(
        NOVA_ICE_PALETTE.length - 1,
        Math.floor(p * (NOVA_ICE_PALETTE.length - 3)),
      );

      // Three counter-rotating ice seals give the wave a charged core before
      // the outer wall of frost reaches the monsters.
      g.fillStyle(NOVA_ICE_PALETTE[phaseTone], 0.25 + 0.5 * fade);
      pxGroundRing(g, x, y, r, { dash: 5, gap: 3 });
      g.fillStyle(NOVA_ICE_PALETTE[Math.min(phaseTone + 2, NOVA_ICE_PALETTE.length - 1)], 0.3 * fade);
      pxGroundRing(g, x, y, r * 0.68, { dash: 3, gap: 4, rot: nova.phase + nova.age * 10 });
      g.fillStyle(NOVA_ICE_PALETTE[Math.max(0, phaseTone - 2)], 0.32 * fade);
      pxGroundRing(g, x, y, r * (0.35 + p * 0.18), { dash: 2, gap: 5, rot: -nova.phase - nova.age * 15 });
      g.fillStyle(NOVA_ICE_PALETTE[Math.min(phaseTone + 1, NOVA_ICE_PALETTE.length - 1)], 0.14 * fade);
      pxDisc(g, x, y, r * 0.9, r * 0.9 * GROUND_SQUASH, { every: 3 });

      // A delayed, broken wake keeps the shockwave moving after its bright
      // leading rim has passed. It gives the burst a readable beginning,
      // middle, and release instead of a single expanding hoop.
      const wakeR = r * (0.38 + 0.38 * Math.min(1, p * 1.45));
      g.fillStyle(0x5caecd, 0.42 * fade);
      pxGroundRing(g, x, y, wakeR, { dash: 2, gap: 5, rot: -nova.phase + nova.age * 14 });
      if (p < 0.42) {
        const core = nova.r * (0.08 + p * 0.52);
        g.fillStyle(0xffffff, 0.78 * (1 - p / 0.42));
        for (let i = 0; i < 8; i++) {
          const a = nova.phase + (i / 8) * Math.PI * 2;
          pxLine(g, x, y,
            x + Math.cos(a) * core,
            y + Math.sin(a) * core * GROUND_SQUASH);
        }
      }

      // Persistent ground fractures: the wave opens each crack quickly, then
      // the broken ice remains readable until the very end of the effect.
      // Every ray has deterministic bends and a short branch, so the pattern
      // looks fractured rather than like another perfect radial burst.
      const crackCount = 18;
      const crackGrow = Math.min(1, nova.age / 0.24);
      const crackFade = p < 0.76 ? 0.72 : 0.72 * (1 - (p - 0.76) / 0.24);
      for (let i = 0; i < crackCount; i++) {
        const a = nova.phase * 0.18 + (i / crackCount) * Math.PI * 2;
        const bend = (i % 2 ? 1 : -1) * (0.07 + (i % 4) * 0.025);
        const total = nova.r * (0.52 + (i % 5) * 0.075) * crackGrow;
        const r1 = total * (0.34 + (i % 3) * 0.04);
        const r2 = total * (0.68 + (i % 2) * 0.05);
        const x1 = x + Math.cos(a) * r1;
        const y1 = y + Math.sin(a) * r1 * GROUND_SQUASH;
        const x2 = x + Math.cos(a + bend) * r2;
        const y2 = y + Math.sin(a + bend) * r2 * GROUND_SQUASH;
        const x3 = x + Math.cos(a - bend * 0.45) * total;
        const y3 = y + Math.sin(a - bend * 0.45) * total * GROUND_SQUASH;
        const crackTone = Math.min(
          NOVA_ICE_PALETTE.length - 1,
          phaseTone + 1 + (i % 3),
        );
        g.fillStyle(NOVA_ICE_PALETTE[crackTone], crackFade);
        pxLine(g, x, y, x1, y1);
        pxLine(g, x1, y1, x2, y2);
        pxLine(g, x2, y2, x3, y3);

        const branchA = a + bend + (i % 2 ? 0.34 : -0.34);
        const branch = total * (0.16 + (i % 3) * 0.035);
        pxLine(g, x2, y2,
          x2 + Math.cos(branchA) * branch,
          y2 + Math.sin(branchA) * branch * GROUND_SQUASH);
      }

      // spikes crystallise on the rim and shrink as the wave passes
      const spikeCount = 26;
      for (let i = 0; i < spikeCount; i++) {
        const a = (i / spikeCount) * Math.PI * 2;
        const sx = snap(x + Math.cos(a) * r);
        const sy = snap(y + Math.sin(a) * r * GROUND_SQUASH);
        const arm = P * (1 + Math.round(fade * 2));
        const spikeTone = Math.min(
          NOVA_ICE_PALETTE.length - 1,
          phaseTone + (i % 5),
        );
        g.fillStyle(NOVA_ICE_PALETTE[spikeTone], 0.85 * fade + 0.1);
        pxStar(g, sx, sy, arm);
        g.fillRect(sx - P, sy - arm * 3, P * 2, arm * 3);
        const spike = arm * (2 + Math.round(fade * 2));
        pxLine(g, sx, sy,
          sx + Math.cos(a) * spike,
          sy + Math.sin(a) * spike * GROUND_SQUASH);
      }

      // Suspended shards rise in a spiral above the ground ring.  This second
      // layer keeps Nova from reading as a flat UI circle.
      const shardCount = 38;
      for (let i = 0; i < shardCount; i++) {
        const a = nova.phase + i * 2.4 + nova.age * (7 + (i % 3));
        const q = (i % 8) / 7;
        const orbit = r * (0.2 + q * 0.68) * (0.65 + p * 0.35);
        const sx = snap(x + Math.cos(a) * orbit);
        const sy = snap(y + Math.sin(a) * orbit * GROUND_SQUASH - 8 - q * 38 * (1 - p * 0.45));
        const size = i % 4 === 0 ? P * 3 : P * 2;
        const shardTone = Math.min(
          NOVA_ICE_PALETTE.length - 1,
          phaseTone + Math.floor(q * 3) + (i % 3),
        );
        air.fillStyle(NOVA_ICE_PALETTE[shardTone], (0.3 + q * 0.55) * fade);
        air.fillRect(sx, sy, size, size + P * (i % 2));
        if (i % 3 === 0) {
          pxLine(air, sx, sy,
            sx + Math.cos(a + Math.PI * 0.5) * P * 3,
            sy + Math.sin(a + Math.PI * 0.5) * P * 3);
        }
      }
      air.fillStyle(NOVA_ICE_PALETTE[Math.max(0, phaseTone - 1)], 0.7 * fade);
      pxStar(air, x, snap(y - 24 - (1 - p) * 16), P * (2 + Math.round(fade * 2)));

      if (nova.age < nova.life) continue;
      g.destroy();
      air.destroy();
      this.novas = this.novas.filter((n) => n !== nova);
    }
  }

  // ── Glacial Lance: jagged ice ridges erupt successively from the floor ───
  #tickLances(dt) {
    for (const lance of [...this.lances]) {
      lance.age += dt;
      const g = lance.gfx;
      const air = lance.gfxAir;
      g.clear();
      air?.clear();

      const grow = Math.min(1, lance.age / lance.grow);
      const p = Math.min(1, lance.age / lance.life);
      const fade = p < 0.72 ? 1 : Math.max(0, 1 - (p - 0.72) / 0.28);
      const half = Phaser.Math.DegToRad(lance.arc) / 2;
      const x = snap(lance.x);
      const y = snap(lance.y);
      const clusterCount = 17;
      const front = grow * (clusterCount + 0.8);

      // Each cluster owns one tall crystal and two or three smaller flank
      // shards. Their bases wander inside the cone, creating the rough ridge
      // silhouette from the reference instead of a mechanically straight row.
      for (let i = 0; i < clusterCount; i++) {
        const erupt = Phaser.Math.Clamp(front - i, 0, 1);
        if (erupt <= 0) continue;

        const q = i / (clusterCount - 1);
        const d = 20 + q * (lance.r - 28);
        const coneHalfWidth = Math.max(7, d * Math.tan(half) * 0.8);
        const ridgeOffset = Math.sin(lance.phase + i * 1.87) * coneHalfWidth * 0.55;
        const bx = snap(x + lance.dir * d);
        const by = snap(y + ridgeOffset);
        const tone = Math.min(
          NOVA_ICE_PALETTE.length - 3,
          2 + Math.floor(p * 3) + (i % 2),
        );

        // A dark frozen footprint and branching floor cracks anchor every
        // crystal to the arena instead of letting it read as a flying sprite.
        g.fillStyle(NOVA_ICE_PALETTE[Math.min(tone + 3, NOVA_ICE_PALETTE.length - 1)], 0.28 * fade * erupt);
        pxDisc(g, bx, by + 3, 12 + (i % 4) * 2, (7 + (i % 3)) * GROUND_SQUASH);
        g.fillStyle(NOVA_ICE_PALETTE[Math.min(tone + 2, NOVA_ICE_PALETTE.length - 1)], 0.7 * fade * erupt);
        for (let crack = 0; crack < 4; crack++) {
          const ca = lance.phase * 0.12 + i * 0.73 + crack * Math.PI * 0.5;
          const len = 12 + ((i + crack) % 4) * 4;
          pxLine(g, bx, by,
            bx + Math.cos(ca) * len,
            by + Math.sin(ca) * len * GROUND_SQUASH);
        }

        const mainHeight = 34 + ((i * 19) % 5) * 10 + (i % 3 === 0 ? 14 : 0);
        const mainWidth = 13 + (i % 4) * 3;
        const mainLean = lance.dir * (7 + (i % 5) * 3) * (i % 2 ? 1 : 0.62);
        this.#drawLanceCrystal(air, bx, by, {
          height: mainHeight,
          width: mainWidth,
          lean: mainLean,
          grow: erupt,
          tone,
          alpha: fade,
        });

        const flankCount = i % 3 === 0 ? 3 : 2;
        for (let flank = 0; flank < flankCount; flank++) {
          const side = flank % 2 ? 1 : -1;
          const sideScale = 0.42 + ((i + flank) % 4) * 0.1;
          const sideOffset = side * coneHalfWidth * (0.42 + flank * 0.13);
          const sideGrow = Phaser.Math.Clamp(erupt * 1.2 - flank * 0.08, 0, 1);
          this.#drawLanceCrystal(air,
            snap(bx - lance.dir * (4 + flank * 3)),
            snap(y + ridgeOffset * 0.45 + sideOffset), {
              height: mainHeight * sideScale,
              width: mainWidth * (0.56 + flank * 0.08),
              lean: lance.dir * (5 + flank * 3) + side * 4,
              grow: sideGrow,
              tone: Math.min(tone + 1 + flank, NOVA_ICE_PALETTE.length - 2),
              alpha: fade * 0.9,
            });
        }
      }

      // Chips and frost are concentrated around the advancing eruption front.
      // Once the ridge is fully grown they settle rather than continuing to
      // orbit like the old beam particles did.
      if (air && grow < 1) {
        const frontD = Math.min(lance.r, grow * lance.r);
        const frontWidth = Math.max(10, frontD * Math.tan(half));
        for (let i = 0; i < 24; i++) {
          const behind = (i % 7) * 7;
          const sx = snap(x + lance.dir * Math.max(12, frontD - behind));
          const spread = Math.sin(lance.phase + i * 2.17) * frontWidth * 0.75;
          const sy = snap(y + spread - 8 - (i % 5) * 6 * grow);
          const tone = 1 + (i % 6);
          air.fillStyle(NOVA_ICE_PALETTE[tone], (0.35 + (i % 3) * 0.14) * fade);
          air.fillRect(sx, sy, i % 5 === 0 ? P * 3 : P * 2, P * (1 + (i % 2)));
        }
      }

      if (lance.age < lance.life) continue;
      g.destroy();
      air?.destroy();
      this.lances = this.lances.filter((l) => l !== lance);
    }
  }

  /** A faceted, grid-snapped crystal grown upward from a fixed ground point. */
  #drawLanceCrystal(g, baseX, baseY, opts) {
    if (!g || opts.grow <= 0 || opts.alpha <= 0) return;

    const height = Math.max(P * 2, snap(opts.height * opts.grow));
    const baseWidth = Math.max(P * 3, snap(opts.width * (0.55 + opts.grow * 0.45)));
    const bands = Math.max(2, Math.ceil(height / (P * 2)));
    const darkTone = Math.min(opts.tone + 2, NOVA_ICE_PALETTE.length - 1);
    const lightTone = Math.max(0, opts.tone - 2);

    // Stacked slices form a rough tapered prism. A small deterministic width
    // wobble breaks the perfect triangle and gives each crystal chipped sides.
    for (let band = 0; band < bands; band++) {
      const q = band / Math.max(1, bands - 1);
      const taper = (1 - q) ** 0.72;
      const chip = band % 4 === 1 ? P : (band % 7 === 4 ? -P : 0);
      const width = Math.max(P, snap(baseWidth * taper + chip));
      const cx = snap(baseX + opts.lean * q);
      const cy = snap(baseY - height * q);

      g.fillStyle(NOVA_ICE_PALETTE[opts.tone], opts.alpha * (0.82 + q * 0.12));
      g.fillRect(snap(cx - width / 2), cy, width, P * 2);

      // Deep blue shadow on one face, white glint on the opposite edge.
      if (width >= P * 3) {
        g.fillStyle(NOVA_ICE_PALETTE[darkTone], opts.alpha * 0.72);
        g.fillRect(snap(cx + width / 2 - P), cy, P, P * 2);
        if (band % 2 === 0) {
          g.fillStyle(NOVA_ICE_PALETTE[lightTone], opts.alpha * 0.88);
          g.fillRect(snap(cx - width / 2), cy, P, P);
        }
      }
    }

    // Bright crown and a short base flare sell the instant of eruption.
    const tipX = snap(baseX + opts.lean);
    const tipY = snap(baseY - height);
    g.fillStyle(NOVA_ICE_PALETTE[lightTone], opts.alpha * 0.9);
    pxStar(g, tipX, tipY, opts.grow < 0.75 ? P * 2 : P);
    g.fillStyle(NOVA_ICE_PALETTE[Math.min(opts.tone + 1, NOVA_ICE_PALETTE.length - 1)], opts.alpha * 0.6);
    pxLine(g, baseX - baseWidth * 0.55, baseY, baseX + baseWidth * 0.55, baseY);
  }

  // ── Nightveil Archer: Shadowstep Volley ──────────────────────────────────
  #startShadowstep(hero, eff) {
    const target = hero.target?.alive ? hero.target : null;
    const b = hero.moveBounds();
    const startX = hero.x;
    const startY = hero.y;
    let angle = hero.facing < 0 ? Math.PI : 0;
    let distance = eff.distance ?? 155;

    if (target) {
      angle = Math.atan2(target.y - hero.y, target.x - hero.x);
      distance = Math.min(distance, Math.max(82, hero.distanceTo(target) + 42));
    }

    const endX = Phaser.Math.Clamp(startX + Math.cos(angle) * distance, b.x + 18, b.right - 18);
    const endY = Phaser.Math.Clamp(startY + Math.sin(angle) * distance, b.y + 34, b.bottom - 12);
    hero.facing = Math.cos(angle) >= 0 ? 1 : -1;
    hero.shadowDodgeBonus = eff.dodgeBonus ?? 0.42;
    hero.shadowDodgeUntil = this.scene.clock + (eff.dodgeSeconds ?? 0.8);

    this.shadowsteps.push({
      hero, eff, startX, startY, endX, endY, angle,
      duration: eff.duration ?? 0.3, age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.unitFx),
    });
    this.scene.fx.skillBurst(startX, startY - hero.spriteHeight * 0.46,
      NIGHTVEIL_PALETTE[3], 'arcane');
    this.scene.fx.popText(startX, startY - hero.spriteHeight - 9, 'SHADOWSTEP', NIGHTVEIL_PALETTE[2]);
  }

  #tickShadowsteps(dt) {
    for (const dash of [...this.shadowsteps]) {
      dash.age += dt;
      const p = Phaser.Math.Clamp(dash.age / dash.duration, 0, 1);
      const eased = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;
      const { hero } = dash;
      if (hero.alive) {
        hero.x = Phaser.Math.Linear(dash.startX, dash.endX, eased);
        hero.y = Phaser.Math.Linear(dash.startY, dash.endY, eased);
        hero.sprite.setAlpha(0.46 + Math.abs(p - 0.5) * 0.9);
      }

      const g = dash.gfx;
      g.clear();
      const fade = 1 - p * 0.48;
      // Layered ribbons mark the full travel path; alternating violet values
      // keep the trail textured instead of becoming one translucent line.
      for (let ribbon = -3; ribbon <= 3; ribbon++) {
        const nx = -Math.sin(dash.angle) * ribbon * P * 2;
        const ny = Math.cos(dash.angle) * ribbon * P * 2;
        g.fillStyle(NIGHTVEIL_PALETTE[2 + (Math.abs(ribbon) % 4)],
          (0.13 + (3 - Math.abs(ribbon)) * 0.045) * fade);
        pxLine(g, dash.startX + nx, dash.startY - 40 + ny,
          hero.x - Math.cos(dash.angle) * 14 + nx,
          hero.y - 40 - Math.sin(dash.angle) * 14 + ny);
      }
      // Hooded afterimages are deliberately incomplete silhouettes: head,
      // shoulders and ragged cloak dissolve at different rates.
      for (let echo = 1; echo <= 5; echo++) {
        const q = Math.max(0, eased - echo * 0.105);
        const ex = snap(Phaser.Math.Linear(dash.startX, dash.endX, q));
        const ey = snap(Phaser.Math.Linear(dash.startY, dash.endY, q));
        const alpha = (0.2 - echo * 0.025) * fade;
        g.fillStyle(NIGHTVEIL_PALETTE[5 + (echo % 2)], alpha);
        pxDisc(g, ex, ey - 65, 10, 12, { every: 2 });
        pxLine(g, ex - 14, ey - 53, ex, ey - 17);
        pxLine(g, ex + 14, ey - 53, ex + (echo % 2 ? 5 : -5), ey - 12);
      }
      for (let mote = 0; mote < 18; mote++) {
        const q = (mote + 1) / 19;
        const mx = snap(Phaser.Math.Linear(dash.startX, hero.x, q)
          + Math.sin(dash.phase + mote * 2.17) * 13);
        const my = snap(Phaser.Math.Linear(dash.startY, hero.y, q) - 18
          - (mote % 6) * P * 3);
        g.fillStyle(NIGHTVEIL_PALETTE[2 + (mote % 5)], (0.46 - q * 0.28) * fade);
        g.fillRect(mx, my, mote % 5 === 0 ? P * 2 : P, P);
      }

      if (p < 1 && hero.alive) continue;
      if (hero.alive) {
        hero.x = dash.endX;
        hero.y = dash.endY;
        hero.sprite.setAlpha(1);
        const targets = this.scene.monsters
          .filter((m) => m.alive)
          .sort((a, b) => hero.distanceTo(a) - hero.distanceTo(b));
        for (let i = 0; i < (dash.eff.volley ?? 3) && targets.length; i++) {
          const target = targets[i % targets.length];
          hero.facing = target.x >= hero.x ? 1 : -1;
          this.scene.combat.fireProjectile(hero, target, {
            texture: 'proj_shadowArrow', speed: 720 + i * 35,
            tint: NIGHTVEIL_PALETTE[1 + (i % 3)],
            trailColor: NIGHTVEIL_PALETTE[3 + (i % 2)], trailLength: 24 + i * 3,
            onHit: (hit) => {
              this.scene.combat.strike(hero, hit, {
                mult: dash.eff.mult ?? 0.72, color: NIGHTVEIL_PALETTE[3],
              });
              this.scene.fx.skillBurst(hit.x, hit.y - hit.spriteHeight * 0.5,
                NIGHTVEIL_PALETTE[3], 'arcane');
            },
          });
        }
        this.scene.fx.ring(hero.x, hero.y - 8, 42, NIGHTVEIL_PALETTE[3], 260, 2);
      }
      g.destroy();
      this.shadowsteps = this.shadowsteps.filter((d) => d !== dash);
    }
  }

  // ── Nightveil Archer: Venom Fang + poison ────────────────────────────────
  #startVenomShot(hero, skill, facing, eff) {
    const targets = this.scene.combat.monstersInCone(
      hero.x, hero.y - 10, facing, eff.radius ?? 330, eff.arc ?? 54,
    );
    this.venomShots.push({
      hero, skill, effect: eff,
      x: hero.x + facing * 18,
      y: hero.y - hero.spriteHeight * 0.57,
      dir: facing, range: eff.radius ?? 330,
      count: eff.arrows ?? 10, fired: 0, nextArrowAt: 0,
      interval: eff.arrowInterval ?? 0.09,
      arrowLife: eff.arrowLife ?? 0.52,
      spread: Phaser.Math.DegToRad(eff.arrowSpread ?? 50),
      damageMult: eff.arrowMult ?? 0.18,
      targets, hitSet: new Set(), arrows: [],
      age: 0, phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.skillBurst(hero.x + facing * 22, hero.y - hero.spriteHeight * 0.56,
      VENOM_PALETTE[1], 'arcane');
  }

  #tickVenomShots(dt) {
    for (const shot of [...this.venomShots]) {
      shot.age += dt;
      while (shot.fired < shot.count && shot.age >= shot.nextArrowAt) {
        const base = shot.dir < 0 ? Math.PI : 0;
        // Pick a random point inside the warned cone, then drop the fang from
        // above it. This makes a true area barrage instead of a left-to-right
        // fan whose arrows all share the same horizontal line.
        const liveTargets = shot.targets.filter((m) => m.alive);
        const focus = liveTargets.length
          ? liveTargets[Phaser.Math.Between(0, liveTargets.length - 1)]
          : null;
        const fieldAngle = base + Phaser.Math.FloatBetween(-shot.spread * 0.5, shot.spread * 0.5);
        const fieldRange = Phaser.Math.FloatBetween(44, shot.range);
        // With targets present, each arrow picks one at random and lands at a
        // random nearby point. This keeps every projectile useful while still
        // scattering its impacts across the whole occupied warning area.
        const impactAngle = Phaser.Math.FloatBetween(0, Math.PI * 2);
        const impactOffset = Phaser.Math.FloatBetween(0, 60);
        const endX = focus
          ? focus.x + Math.cos(impactAngle) * impactOffset
          : shot.x + Math.cos(fieldAngle) * fieldRange;
        const endY = focus
          ? focus.y + Math.sin(impactAngle) * impactOffset * 0.72
          : shot.y + Math.sin(fieldAngle) * fieldRange * 0.72;
        const startX = endX + Phaser.Math.FloatBetween(-44, 44);
        const startY = endY - Phaser.Math.FloatBetween(135, 210);
        const angle = Math.atan2(endY - startY, endX - startX);
        shot.arrows.push({ startX, startY, endX, endY, angle, bornAt: shot.age });

        const target = liveTargets
          .sort((a, b) => Phaser.Math.Distance.Between(endX, endY, a.x, a.y)
            - Phaser.Math.Distance.Between(endX, endY, b.x, b.y))[0];
        const hitRange = 76;
        if (target && shot.hero.alive
          && Phaser.Math.Distance.Between(endX, endY, target.x, target.y) <= hitRange) {
          const dealt = this.scene.combat.strike(shot.hero, target, {
            mult: shot.damageMult, color: VENOM_PALETTE[2], ignoreBlock: true,
          });
          if (dealt > 0) this.#applyPoison(shot.hero, target, shot.effect);
          target.applySlow(shot.effect.slowMult, shot.effect.slowSeconds);
          shot.hitSet.add(target);
          this.scene.fx.hitSpark(target.x, target.y - target.spriteHeight * 0.5, VENOM_PALETTE[1], 3, angle);
        }
        shot.fired += 1;
        shot.nextArrowAt += shot.interval;
      }

      const g = shot.gfx;
      g.clear();
      shot.arrows = shot.arrows.filter((arrow) => shot.age - arrow.bornAt < shot.arrowLife);
      // Each fang falls toward its own random impact point inside the warning
      // zone. The head always leads into that point, so arrows never render
      // backwards when the Archer faces left.
      for (const arrow of shot.arrows) {
        const p = Phaser.Math.Clamp((shot.age - arrow.bornAt) / shot.arrowLife, 0, 1);
        const fade = p < 0.72 ? 1 : Math.max(0, 1 - (p - 0.72) / 0.28);
        // The fang raster's head is drawn along its local positive axis;
        // reverse that local axis so its visible point faces the impact.
        const dx = -Math.cos(arrow.angle);
        const dy = -Math.sin(arrow.angle);
        const travel = 1 - (1 - p) ** 3;
        const cx = snap(Phaser.Math.Linear(arrow.startX, arrow.endX, travel));
        const cy = snap(Phaser.Math.Linear(arrow.startY, arrow.endY, travel));
        g.fillStyle(VENOM_PALETTE[0], 0.94 * fade);
        pxLine(g, cx - dx * 26, cy - dy * 26, cx + dx * 11, cy + dy * 11);
        g.fillStyle(VENOM_PALETTE[1], 0.9 * fade);
        pxLine(g, cx + dx * 10, cy + dy * 10, cx + dx * 23 - dy * 6, cy + dy * 23 + dx * 6);
        pxLine(g, cx + dx * 10, cy + dy * 10, cx + dx * 23 + dy * 6, cy + dy * 23 - dx * 6);
        for (let i = 0; i < 8; i++) {
          const tail = 28 + i * 11;
          const tx = snap(cx - dx * tail + Math.sin(arrow.angle + i * 2.1) * P * 2);
          const ty = snap(cy - dy * tail + Math.cos(arrow.angle + i * 2.1) * P * 2);
          g.fillStyle(i % 2 ? VENOM_PALETTE[2] : NIGHTVEIL_PALETTE[3], (0.62 - i * 0.06) * fade);
          g.fillRect(tx, ty, i % 3 === 0 ? P * 2 : P, P);
        }
      }

      if (shot.fired < shot.count || shot.arrows.length) continue;
      this.scene.fx.impact({ color: VENOM_PALETTE[2], shake: 0.012, flash: 0.24, stop: 75 });
      this.#report(shot.skill, shot.hitSet.size);
      g.destroy();
      this.venomShots = this.venomShots.filter((s) => s !== shot);
    }
  }

  #applyPoison(source, target, eff) {
    const existing = this.poisons.find((poison) => poison.target === target);
    if (existing) {
      existing.left = Math.max(existing.left, eff.poisonSeconds ?? 4);
      existing.damage = Math.max(existing.damage, source.atk * (eff.poisonTickMult ?? 0.16));
      return;
    }
    this.poisons.push({
      source, target, left: eff.poisonSeconds ?? 4,
      every: eff.poisonEvery ?? 0.55, tick: eff.poisonEvery ?? 0.55,
      damage: source.atk * (eff.poisonTickMult ?? 0.16), age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.unitFx),
    });
    this.scene.fx.popText(target.x, target.y - target.spriteHeight - 8, 'VENOM', VENOM_PALETTE[2]);
  }

  #tickPoisons(dt) {
    for (const poison of [...this.poisons]) {
      poison.left -= dt;
      poison.tick -= dt;
      poison.age += dt;
      const { target } = poison;
      if (target.alive && poison.left > 0 && poison.tick <= 0) {
        poison.tick += poison.every;
        target.takeDamage(poison.damage, {
          color: VENOM_PALETTE[2], source: poison.source?.alive ? poison.source : undefined,
        });
      }

      const g = poison.gfx;
      g.clear();
      if (target.alive && poison.left > 0) {
        const baseY = target.y - 4;
        for (let i = 0; i < 11; i++) {
          const ph = (poison.age * (0.58 + (i % 4) * 0.13) + i / 11) % 1;
          const px = snap(target.x + Math.sin(poison.phase + i * 2.27) * (8 + (i % 4) * 4));
          const py = snap(baseY - ph * (target.spriteHeight * 0.72));
          g.fillStyle(i % 3 === 0 ? NIGHTVEIL_PALETTE[4] : VENOM_PALETTE[1 + (i % 3)],
            (1 - ph) * 0.64);
          pxDisc(g, px, py, i % 4 === 0 ? P * 2 : P, i % 5 === 0 ? P * 2 : P);
        }
        continue;
      }
      g.destroy();
      this.poisons = this.poisons.filter((p) => p !== poison);
    }
  }

  // ── Nightveil Archer: Umbral Trap ────────────────────────────────────────
  #startUmbralTrap(x, y, eff) {
    this.umbralTraps.push({
      x, y, radius: eff.radius ?? 105, life: eff.life ?? 1.25,
      age: 0, phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.unitFx),
    });
    this.scene.fx.skillBurst(x, y - 10, NIGHTVEIL_PALETTE[3], 'rune');
    this.scene.fx.impact({ color: NIGHTVEIL_PALETTE[4], shake: 0.01, flash: 0.2, stop: 75 });
  }

  #tickUmbralTraps(dt) {
    for (const trap of [...this.umbralTraps]) {
      trap.age += dt;
      const p = Phaser.Math.Clamp(trap.age / trap.life, 0, 1);
      const open = Phaser.Math.Clamp(trap.age / 0.34, 0, 1);
      const fade = p < 0.82 ? 1 : Math.max(0, 1 - (p - 0.82) / 0.18);
      const r = trap.radius * open;
      const pulse = 0.5 + Math.sin(trap.age * 8.5) * 0.5;
      const g = trap.gfx;
      const air = trap.gfxAir;
      g.clear();
      air.clear();

      // Layered abyss: a breathing black core, three counter-rotating seals,
      // and irregular edge fractures keep the trap threatening while it lasts.
      g.fillStyle(NIGHTVEIL_PALETTE[7], (0.32 + pulse * 0.12) * fade);
      pxDisc(g, trap.x, trap.y + 5, r, r * GROUND_SQUASH, { every: 3 });
      g.fillStyle(NIGHTVEIL_PALETTE[6], (0.36 + pulse * 0.16) * fade);
      pxDisc(g, trap.x, trap.y + 5, r * (0.3 + pulse * 0.09), r * (0.3 + pulse * 0.09) * GROUND_SQUASH, { every: 2 });
      g.fillStyle(NIGHTVEIL_PALETTE[4], 0.78 * fade);
      pxGroundRing(g, trap.x, trap.y + 5, r, { dash: 5, gap: 2, rot: trap.age * 18 });
      g.fillStyle(NIGHTVEIL_PALETTE[2], 0.58 * fade);
      pxGroundRing(g, trap.x, trap.y + 5, r * 0.62, { dash: 2, gap: 3, rot: -trap.age * 24 });
      g.fillStyle(NIGHTVEIL_PALETTE[1], (0.38 + pulse * 0.26) * fade);
      pxGroundRing(g, trap.x, trap.y + 5, r * (0.3 + pulse * 0.08), {
        dash: 2, gap: 2, rot: trap.age * 35,
      });
      // Eight hooked teeth point inward while branching cracks reach outward.
      for (let i = 0; i < 12; i++) {
        const a = trap.phase + (i / 12) * Math.PI * 2;
        const inner = r * (0.34 + (i % 3) * 0.04);
        const outer = r * (0.78 + (i % 2) * 0.12);
        g.fillStyle(NIGHTVEIL_PALETTE[3 + (i % 3)], (0.42 + (i % 3) * 0.12) * fade);
        pxLine(g, trap.x + Math.cos(a) * outer, trap.y + 5 + Math.sin(a) * outer * GROUND_SQUASH,
          trap.x + Math.cos(a + 0.12) * inner, trap.y + 5 + Math.sin(a + 0.12) * inner * GROUND_SQUASH);
        if (i % 2 === 0) {
          pxLine(g, trap.x + Math.cos(a) * outer, trap.y + 5 + Math.sin(a) * outer * GROUND_SQUASH,
            trap.x + Math.cos(a) * r * 1.08, trap.y + 5 + Math.sin(a) * r * 1.08 * GROUND_SQUASH);
        }
      }
      // Shadow chains rise and curl above the captured group.
      for (let i = 0; i < 7; i++) {
        const a = trap.phase + i * 2.41;
        const bx = trap.x + Math.cos(a) * r * 0.6;
        const by = trap.y + Math.sin(a) * r * 0.28;
        const height = (24 + (i % 4) * 9) * Math.sin(open * Math.PI * 0.72);
        air.fillStyle(NIGHTVEIL_PALETTE[2 + (i % 4)], (0.38 + (i % 3) * 0.12) * fade);
        for (let link = 0; link < 5; link++) {
          const ly = by - height * (link / 5);
          const lx = bx + Math.sin(trap.age * 8 + i + link) * P * 2;
          pxArc(air, lx, ly, P * 2, P * 3, { from: 0, to: Math.PI * 2, dash: 2, gap: 1 });
        }
      }

      // Six spectral hands breach the rim, opening and closing around anyone
      // inside. Their fingers are deliberately offset so the animation has a
      // restless, grasping rhythm rather than a static ring of decorations.
      for (let hand = 0; hand < 6; hand++) {
        const a = trap.phase + hand * (Math.PI * 2 / 6) + Math.sin(trap.age * 2 + hand) * 0.08;
        const hx = trap.x + Math.cos(a) * r * 0.76;
        const hy = trap.y + 4 + Math.sin(a) * r * 0.38;
        const rise = (18 + pulse * 14 + (hand % 2) * 7) * open;
        const sway = Math.sin(trap.age * 9 + hand * 1.8) * P * 2;
        air.fillStyle(NIGHTVEIL_PALETTE[3 + (hand % 2)], (0.38 + pulse * 0.24) * fade);
        pxDisc(air, hx + sway, hy - rise * 0.42, P * 3, P * 4, { every: 1 });
        for (let finger = -2; finger <= 2; finger++) {
          const fx = hx + sway + finger * P * 2;
          const fy = hy - rise * 0.42;
          air.fillStyle(NIGHTVEIL_PALETTE[1 + ((hand + finger + 4) % 4)], (0.44 + pulse * 0.22) * fade);
          pxLine(air, fx, fy, fx + Math.sin(a) * P * 2, fy - rise * (0.48 + Math.abs(finger) * 0.05));
        }
      }

      // Drifting violet souls rise from the seal for its whole lifetime.
      for (let mote = 0; mote < 30; mote++) {
        const q = ((mote * 23) % 31) / 30;
        const ma = trap.phase + mote * 2.27 + trap.age * (mote % 2 ? 0.45 : -0.35);
        const mr = r * (0.16 + q * 0.78);
        const lift = (trap.age * (15 + (mote % 5) * 5) + mote * 11) % 46;
        const mx = snap(trap.x + Math.cos(ma) * mr);
        const my = snap(trap.y + 4 + Math.sin(ma) * mr * GROUND_SQUASH - lift);
        air.fillStyle(mote % 5 === 0 ? NIGHTVEIL_PALETTE[1] : NIGHTVEIL_PALETTE[3 + (mote % 3)],
          (0.24 + (mote % 4) * 0.11) * fade);
        air.fillRect(mx, my, mote % 7 === 0 ? P * 2 : P, mote % 6 === 0 ? P * 2 : P);
        if (mote % 10 === 0) pxStar(air, mx, my, P);
      }

      if (p < 1) continue;
      g.destroy();
      air.destroy();
      this.umbralTraps = this.umbralTraps.filter((t) => t !== trap);
    }
  }

  // ── Nightveil Archer Ultimate: Eclipse Barrage ───────────────────────────
  #startEclipseBarrage(hero, skill, ctx, eff) {
    const x = ctx.x ?? hero.x;
    const y = ctx.y ?? hero.y;
    this.eclipseBarrages.push({
      hero, skill, x, y, radius: eff.radius ?? 205,
      waves: eff.waves ?? 6, interval: eff.interval ?? 0.28,
      duration: eff.duration ?? 2.3, age: 0, nextWave: 0.16, wave: 0,
      hitSet: new Set(), phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      eff,
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.screenFlash(NIGHTVEIL_PALETTE[4], 0.32, 220);
    this.scene.fx.skillBurst(x, y - 18, NIGHTVEIL_PALETTE[2], 'rune');
    this.scene.fx.popText(x, y - 80, 'ECLIPSE', NIGHTVEIL_PALETTE[1]);
  }

  #tickEclipseBarrages(dt) {
    for (const eclipse of [...this.eclipseBarrages]) {
      eclipse.age += dt;
      const p = Phaser.Math.Clamp(eclipse.age / eclipse.duration, 0, 1);
      const open = Phaser.Math.Clamp(eclipse.age / 0.32, 0, 1);
      const fade = p < 0.82 ? 1 : Math.max(0, 1 - (p - 0.82) / 0.18);

      while (eclipse.wave < eclipse.waves && eclipse.age >= eclipse.nextWave) {
        eclipse.wave += 1;
        eclipse.nextWave += eclipse.interval;
        const final = eclipse.wave === eclipse.waves;
        const victims = this.scene.combat.monstersInCircle(eclipse.x, eclipse.y, eclipse.radius);
        for (const m of victims) {
          eclipse.hitSet.add(m);
          this.scene.combat.strike(eclipse.hero, m, {
            mult: final ? eclipse.eff.finalMult : eclipse.eff.tickMult,
            color: final ? NIGHTVEIL_PALETTE[1] : NIGHTVEIL_PALETTE[3],
            knockback: final ? 34 : 4,
          });
          m.applySlow(eclipse.eff.slowMult, eclipse.eff.slowSeconds);
        }
        const waveAngle = eclipse.phase + eclipse.wave * 1.91;
        const ix = eclipse.x + Math.cos(waveAngle) * eclipse.radius * 0.46;
        const iy = eclipse.y + Math.sin(waveAngle) * eclipse.radius * 0.3;
        this.scene.fx.skillBurst(ix, iy - 8,
          final ? NIGHTVEIL_PALETTE[1] : NIGHTVEIL_PALETTE[3], 'explosion');
        this.scene.fx.ring(eclipse.x, eclipse.y + 4,
          eclipse.radius * (0.35 + eclipse.wave / eclipse.waves * 0.6),
          NIGHTVEIL_PALETTE[2 + (eclipse.wave % 3)], 240, final ? 4 : 2);
        this.scene.audio?.playSkill(eclipse.hero, final ? 'eclipseImpact' : 'eclipseTick');
        if (final) this.scene.fx.impact({ color: NIGHTVEIL_PALETTE[2], shake: 0.022, flash: 0.42, stop: 120 });
      }

      const g = eclipse.gfx;
      const air = eclipse.gfxAir;
      g.clear();
      air.clear();
      const r = eclipse.radius * open;
      g.fillStyle(NIGHTVEIL_PALETTE[7], 0.3 * fade);
      pxDisc(g, eclipse.x, eclipse.y + 6, r, r * GROUND_SQUASH, { every: 3 });
      g.fillStyle(NIGHTVEIL_PALETTE[4], 0.72 * fade);
      pxGroundRing(g, eclipse.x, eclipse.y + 6, r, {
        dash: 8, gap: 3, rot: eclipse.age * 14,
      });
      g.fillStyle(NIGHTVEIL_PALETTE[2], 0.48 * fade);
      pxGroundRing(g, eclipse.x, eclipse.y + 6, r * 0.72, {
        dash: 3, gap: 4, rot: -eclipse.age * 20,
      });
      // Radial runic arrowheads make the seal belong to an archer.
      for (let i = 0; i < 18; i++) {
        const a = eclipse.phase + (i / 18) * Math.PI * 2 + eclipse.age * 0.18;
        const ax = eclipse.x + Math.cos(a) * r * 0.86;
        const ay = eclipse.y + 6 + Math.sin(a) * r * 0.86 * GROUND_SQUASH;
        g.fillStyle(NIGHTVEIL_PALETTE[1 + (i % 5)], (0.4 + (i % 3) * 0.12) * fade);
        pxLine(g, ax, ay, ax - Math.cos(a) * P * 5, ay - Math.sin(a) * P * 3);
        pxLine(g, ax, ay, ax + Math.cos(a + 2.5) * P * 4, ay + Math.sin(a + 2.5) * P * 3);
      }

      // A suspended crescent and crown of rays hang over the impact zone.
      const moonY = eclipse.y - 116;
      air.fillStyle(NIGHTVEIL_PALETTE[2], 0.46 * open * fade);
      pxDisc(air, eclipse.x, moonY, 31, 31, { every: 2 });
      air.fillStyle(NIGHTVEIL_PALETTE[7], 0.72 * open * fade);
      pxDisc(air, eclipse.x + 12, moonY - 5, 27, 27, { every: 2 });
      for (let i = 0; i < 14; i++) {
        const a = eclipse.phase + (i / 14) * Math.PI * 2 - eclipse.age * 0.32;
        air.fillStyle(NIGHTVEIL_PALETTE[2 + (i % 4)], (0.24 + (i % 3) * 0.09) * fade);
        pxLine(air,
          eclipse.x + Math.cos(a) * 38, moonY + Math.sin(a) * 38,
          eclipse.x + Math.cos(a) * (45 + (i % 3) * 5),
          moonY + Math.sin(a) * (45 + (i % 3) * 5));
      }

      // Each arrow follows a different deterministic lane through the warned
      // circle. More lanes appear as successive waves build toward the finale.
      const arrowCount = 22 + eclipse.wave * 4;
      const waveP = ((eclipse.age - 0.16) / eclipse.interval + 10) % 1;
      for (let i = 0; i < arrowCount; i++) {
        const a = eclipse.phase + i * 2.399;
        const spread = ((i * 37) % 101) / 100;
        const ax = snap(eclipse.x + Math.cos(a) * eclipse.radius * spread * 0.82);
        const groundY = eclipse.y + Math.sin(a) * eclipse.radius * spread * 0.46;
        const q = (waveP + (i % 7) / 7) % 1;
        const ay = snap(groundY - (1 - q) * (125 + (i % 5) * 13));
        air.fillStyle(NIGHTVEIL_PALETTE[1 + (i % 5)], (0.34 + q * 0.58) * fade);
        pxLine(air, ax - P * 2, ay - P * 5, ax + P, ay + P * 7);
        if (q > 0.86) {
          air.fillStyle(i % 3 === 0 ? VENOM_PALETTE[1] : NIGHTVEIL_PALETTE[2],
            (q - 0.86) * 5.5 * fade);
          pxStar(air, ax, groundY, P * (i % 4 === 0 ? 3 : 2));
        }
      }

      if (p < 1) continue;
      this.#report(eclipse.skill, eclipse.hitSet.size);
      g.destroy();
      air.destroy();
      this.eclipseBarrages = this.eclipseBarrages.filter((e) => e !== eclipse);
    }
  }

  // ── Lion Monk: Feline Agility ────────────────────────────────────────────
  #startFelineDash(hero, eff) {
    const jumps = eff.jumps ?? 3;
    const targets = this.scene.monsters
      .filter((m) => m.alive)
      .sort((a, b) => hero.distanceTo(a) - hero.distanceTo(b))
      .slice(0, jumps);
    if (!targets.length) return;

    // Cycle the available targets: one monster receives all three blinks;
    // two monsters receive A → B → A; with a crowd, the first three differ.
    const targetCycle = [...targets];
    while (targets.length < jumps) targets.push(targetCycle[targets.length % targetCycle.length]);
    const dash = {
      hero,
      targets,
      jump: 0,
      nextJumpAt: eff.jumpInterval ?? 0.2,
      interval: eff.jumpInterval ?? 0.2,
      damageMult: eff.damageMult ?? 0.56,
      knockback: eff.knockback ?? 16,
      trailLife: eff.trailLife ?? 0.58,
      age: 0,
      trails: [],
      gfx: this.scene.add.graphics().setDepth(DEPTH.unitFx),
    };
    this.felineDashes.push(dash);
    this.#executeFelineBlink(dash);
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 10, 'TRIPLE POUNCE', SOLAR_PALETTE[1]);
  }

  #executeFelineBlink(dash) {
    const { hero } = dash;
    const target = dash.targets[dash.jump];
    // A previous blink can kill a fragile target. Consume that beat rather
    // than stalling the sequence in its timing loop.
    if (!hero.alive || !target?.alive) {
      dash.jump += 1;
      return;
    }
    const startX = hero.x;
    const startY = hero.y;
    const angle = Math.atan2(target.y - startY, target.x - startX);
    const b = hero.moveBounds();
    // Land just off the target's shoulder, so the sprite never sits inside it.
    const landing = 42;
    const endX = Phaser.Math.Clamp(target.x - Math.cos(angle) * landing, b.x + 18, b.right - 18);
    const endY = Phaser.Math.Clamp(target.y - Math.sin(angle) * landing, b.y + 34, b.bottom - 12);
    hero.x = endX;
    hero.y = endY;
    hero.facing = target.x >= endX ? 1 : -1;
    dash.trails.push({ startX, startY, endX, endY, angle, bornAt: dash.age });
    this.scene.combat.strike(hero, target, {
      mult: dash.damageMult, color: SOLAR_PALETTE[2], knockback: dash.knockback, ignoreBlock: true,
    });
    this.scene.fx.slash(target.x - hero.facing * 7, target.y - target.spriteHeight * 0.5, hero.facing, SOLAR_PALETTE[1]);
    this.scene.fx.skillBurst(target.x, target.y - target.spriteHeight * 0.48, SOLAR_PALETTE[2], 'arcane');
    this.scene.audio?.playSkill(hero, 'felineAgility');
    dash.jump += 1;
  }

  #tickFelineDashes(dt) {
    for (const dash of [...this.felineDashes]) {
      dash.age += dt;
      const { hero } = dash;
      while (dash.jump < dash.targets.length && dash.age >= dash.nextJumpAt) {
        this.#executeFelineBlink(dash);
        dash.nextJumpAt += dash.interval;
      }

      const g = dash.gfx;
      g.clear();
      dash.trails = dash.trails.filter((trail) => dash.age - trail.bornAt < dash.trailLife);
      // The hero position snaps immediately; these claw-lined trails connect
      // the previous and next points so three teleports remain readable.
      for (const trail of dash.trails) {
        const p = (dash.age - trail.bornAt) / dash.trailLife;
        const fade = Math.max(0, 1 - p);
        for (let claw = -2; claw <= 2; claw++) {
          const nx = -Math.sin(trail.angle) * claw * P * 2;
          const ny = Math.cos(trail.angle) * claw * P * 2;
          g.fillStyle(SOLAR_PALETTE[claw === 0 ? 1 : 3], (0.24 + (2 - Math.abs(claw)) * 0.09) * fade);
          pxLine(g, trail.startX + nx, trail.startY - 28 + ny, trail.endX + nx, trail.endY - 28 + ny);
        }
        g.fillStyle(SOLAR_PALETTE[1], 0.75 * fade);
        pxStar(g, trail.endX, trail.endY - hero.spriteHeight * 0.45, P * 3);
      }

      if (dash.jump < dash.targets.length || dash.trails.length) continue;
      g.destroy();
      this.felineDashes = this.felineDashes.filter((d) => d !== dash);
    }
  }

  // ── Lion Monk: Burning Palm + burn damage over time ──────────────────────
  #startBurningPalm(hero, facing, eff, opts = {}) {
    this.burningPalms.push({
      x: hero.x + facing * 18,
      y: hero.y - hero.spriteHeight * 0.48,
      dir: facing,
      range: eff.radius ?? 220,
      life: opts.life ?? eff.fxLife ?? 0.62,
      startScale: opts.startScale ?? eff.startScale ?? opts.scale ?? 1,
      endScale: opts.endScale ?? eff.endScale ?? opts.scale ?? 1,
      finisher: !!opts.finisher,
      age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.skillBurst(hero.x + facing * 22, hero.y - hero.spriteHeight * 0.48,
      SOLAR_PALETTE[2], 'explosion');
  }

  #tickBurningPalms(dt) {
    for (const palm of [...this.burningPalms]) {
      palm.age += dt;
      const p = Phaser.Math.Clamp(palm.age / palm.life, 0, 1);
      const travel = palm.range * (1 - (1 - p) ** 2);
      // Start as a compact hand-flame and steadily expand into a giant paw.
      // Delaying the fade leaves the large final silhouette on screen long
      // enough to visually match the wide end of the warning cone.
      const fade = p < 0.78 ? 1 : Math.max(0, 1 - (p - 0.78) / 0.22);
      const growth = Phaser.Math.Linear(palm.startScale, palm.endScale, p);
      const size = growth * (0.92 + Math.sin(p * Math.PI) * 0.16);
      const cx = snap(palm.x + palm.dir * travel);
      const cy = snap(palm.y + Math.sin(palm.phase + p * 8) * P * 2);
      const g = palm.gfx;
      g.clear();

      // A broad palm pad with four forward knuckles creates the lion-paw read.
      g.fillStyle(SOLAR_PALETTE[5], 0.28 * fade);
      pxDisc(g, cx, cy, 21 * size, 15 * size, { every: 2 });
      g.fillStyle(SOLAR_PALETTE[3], 0.78 * fade);
      pxDisc(g, cx, cy, 13 * size, 10 * size);
      g.fillStyle(SOLAR_PALETTE[1], 0.92 * fade);
      pxDisc(g, cx + palm.dir * 3 * size, cy, 7 * size, 6 * size);
      for (let toe = 0; toe < 4; toe++) {
        const ty = cy + (toe - 1.5) * 8 * size;
        const tx = cx + palm.dir * (13 + (toe % 2) * 3) * size;
        g.fillStyle(SOLAR_PALETTE[2 + (toe % 3)], (0.68 + toe * 0.06) * fade);
        pxDisc(g, tx, ty, 7 * size, 5 * size);
        g.fillStyle(SOLAR_PALETTE[0], 0.72 * fade);
        pxLine(g, tx + palm.dir * 3 * size, ty,
          tx + palm.dir * (10 + (toe % 2) * 3) * size, ty);
      }

      // Flame ribbons peel off behind the paw instead of leaving one straight
      // projectile trail.
      for (let flame = 0; flame < 12; flame++) {
        const q = flame / 11;
        const fx = cx - palm.dir * (15 + q * 58) * size;
        const fy = cy + Math.sin(palm.phase + flame * 1.73 + p * 11) * (5 + q * 17) * size;
        g.fillStyle(SOLAR_PALETTE[1 + (flame % 5)], (0.72 - q * 0.54) * fade);
        pxLine(g, fx, fy, fx - palm.dir * (5 + q * 10) * size, fy - (flame % 2 ? P * 2 : -P * 2));
        if (flame % 4 === 0) pxStar(g, fx, fy, P * (palm.finisher ? 2 : 1));
      }

      if (p < 1) continue;
      g.destroy();
      this.burningPalms = this.burningPalms.filter((wave) => wave !== palm);
    }
  }

  // ── Lion Monk: Solar Roar ───────────────────────────────────────────────
  // A sun-shaped shockwave: the ground carries the pressure ring while a
  // briefly resolved lion face in the air gives the crowd-control a signature.
  #startSolarRoar(hero, eff) {
    const y = hero.y - hero.spriteHeight * 0.48;
    this.solarRoars.push({
      x: hero.x,
      y,
      radius: eff.radius ?? 185,
      life: eff.fxLife ?? 1.05,
      age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.skillBurst(hero.x, y, SOLAR_PALETTE[1], 'explosion');
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 12, 'SOLAR ROAR', SOLAR_PALETTE[1]);
  }

  #tickSolarRoars(dt) {
    for (const roar of [...this.solarRoars]) {
      roar.age += dt;
      const p = Phaser.Math.Clamp(roar.age / roar.life, 0, 1);
      const fade = (1 - p) ** 1.35;
      const wave = roar.radius * (1 - (1 - p) ** 2.5);
      const g = roar.gfx;
      const air = roar.gfxAir;
      g.clear();
      air.clear();

      // Three stepped pressure rings make the roar feel like it has mass.
      for (let ring = 0; ring < 3; ring++) {
        const r = Math.max(8, wave - ring * 18);
        g.fillStyle(SOLAR_PALETTE[1 + ring], fade * (0.75 - ring * 0.16));
        pxArc(g, roar.x, roar.y + 18, r, r * GROUND_SQUASH, {
          dash: ring === 2 ? 3 : 0,
          gap: ring === 2 ? 1 : 0,
          rot: roar.phase + p * 2,
        });
      }
      // Flame-like mane rays trail each ring, rather than one uniform circle.
      for (let i = 0; i < 20; i++) {
        const a = (Math.PI * 2 * i) / 20 + roar.phase * 0.16;
        const inner = Math.max(10, wave - 18 - (i % 3) * 5);
        const outer = wave + 10 + (i % 4) * 7;
        const x1 = roar.x + Math.cos(a) * inner;
        const y1 = roar.y + 18 + Math.sin(a) * inner * 0.46;
        const x2 = roar.x + Math.cos(a) * outer;
        const y2 = roar.y + 18 + Math.sin(a) * outer * 0.46;
        g.fillStyle(SOLAR_PALETTE[2 + (i % 3)], fade * 0.68);
        pxLine(g, x1, y1, x2, y2);
      }

      // The solar lion appears only while the wave is young, then dissolves
      // into sparks so it never obscures combat after the control has landed.
      const faceFade = Math.sin(Math.min(1, p * 2.4) * Math.PI) * fade;
      if (faceFade > 0.02) {
        const cx = roar.x;
        const cy = roar.y - 34 - p * 10;
        const mane = 25 + p * 11;
        for (let i = 0; i < 14; i++) {
          const a = (Math.PI * 2 * i) / 14 + roar.phase * 0.08;
          const mx = cx + Math.cos(a) * mane;
          const my = cy + Math.sin(a) * mane * 0.82;
          air.fillStyle(SOLAR_PALETTE[2 + (i % 3)], faceFade * 0.7);
          pxStar(air, mx, my, P * (i % 3 === 0 ? 2 : 1));
        }
        air.fillStyle(SOLAR_PALETTE[3], faceFade * 0.82);
        pxDisc(air, cx, cy, 18, 16, { every: 2 });
        air.fillStyle(SOLAR_PALETTE[1], faceFade * 0.96);
        pxDisc(air, cx, cy + 4, 11, 9, { every: 2 });
        air.fillStyle(SOLAR_PALETTE[6], faceFade);
        pxDisc(air, cx - 7, cy - 3, 3, 3);
        pxDisc(air, cx + 7, cy - 3, 3, 3);
        pxLine(air, cx - 3, cy + 7, cx + 3, cy + 7);
      }

      if (p < 1) continue;
      g.destroy();
      air.destroy();
      this.solarRoars = this.solarRoars.filter((active) => active !== roar);
    }
  }

  #applyBurn(source, target, eff) {
    const existing = this.burns.find((burn) => burn.target === target);
    if (existing) {
      existing.left = Math.max(existing.left, eff.burnSeconds ?? 3.2);
      existing.damage = Math.max(existing.damage, source.atk * (eff.burnTickMult ?? 0.18));
      return;
    }
    this.burns.push({
      source,
      target,
      left: eff.burnSeconds ?? 3.2,
      every: eff.burnEvery ?? 0.5,
      tick: eff.burnEvery ?? 0.5,
      damage: source.atk * (eff.burnTickMult ?? 0.18),
      age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.unitFx),
    });
    this.scene.fx.popText(target.x, target.y - target.spriteHeight - 8, 'BURN', SOLAR_PALETTE[3]);
  }

  #tickBurns(dt) {
    for (const burn of [...this.burns]) {
      burn.left -= dt;
      burn.tick -= dt;
      burn.age += dt;
      const { target } = burn;

      if (target.alive && burn.left > 0 && burn.tick <= 0) {
        burn.tick += burn.every;
        target.takeDamage(burn.damage, {
          color: SOLAR_PALETTE[4],
          source: burn.source?.alive ? burn.source : undefined,
        });
      }

      const g = burn.gfx;
      g.clear();
      if (target.alive && burn.left > 0) {
        const baseY = target.y - 5;
        for (let i = 0; i < 7; i++) {
          const ph = (burn.age * (0.8 + (i % 3) * 0.15) + i / 7) % 1;
          const fx = snap(target.x + Math.sin(burn.phase + i * 2.1) * (5 + (i % 3) * 5));
          const fy = snap(baseY - ph * (target.spriteHeight * 0.65));
          g.fillStyle(SOLAR_PALETTE[2 + (i % 3)], (1 - ph) * 0.72);
          pxLine(g, fx, fy, fx + (i % 2 ? P : -P), fy - P * (2 + (i % 3)));
        }
        continue;
      }
      g.destroy();
      this.burns = this.burns.filter((b) => b !== burn);
    }
  }

  /** Beast-form basic: two solar claw rakes plus a smaller pursuing fire bolt. */
  performSolarBasic(hero, target) {
    if (!hero.solarTransformed || !target?.alive) return;
    const chestY = hero.y - hero.spriteHeight * 0.46;
    this.scene.fx.slash(hero.x + hero.facing * 31, chestY - 8, hero.facing, SOLAR_PALETTE[1]);
    this.scene.fx.slash(hero.x + hero.facing * 38, chestY + 7, hero.facing, SOLAR_PALETTE[3]);
    this.scene.combat.strike(hero, target, {
      mult: 1.12,
      color: SOLAR_PALETTE[2],
      knockback: 14,
      ignoreBlock: true,
    });
    this.scene.fx.skillBurst(hero.x + hero.facing * 28, chestY, SOLAR_PALETTE[2], 'arcane');
    this.fireSolarBasic(hero, target);
    this.scene.fx.hitstop(45);
  }

  /** Bonus flame carried by every beast-form basic attack. */
  fireSolarBasic(hero, target) {
    if (!hero.alive || !hero.solarTransformed || !target?.alive
      || this.scene.clock >= hero.solarFuryUntil) return;
    this.scene.combat.fireProjectile(hero, target, {
      texture: 'proj_solarBolt',
      speed: 520,
      tint: SOLAR_PALETTE[2],
      trailColor: SOLAR_PALETTE[3],
      trailLength: 22,
      radius: 7,
      onHit: (hit) => {
        const dealt = this.scene.combat.strike(hero, hit, {
          mult: hero.solarBoltMult,
          color: SOLAR_PALETTE[2],
          ignoreBlock: true,
        });
        if (dealt > 0) this.#applyBurn(hero, hit, {
          burnSeconds: 1.4, burnEvery: 0.5, burnTickMult: 0.1,
        });
        this.scene.fx.skillBurst(hit.x, hit.y - hit.spriteHeight * 0.5, SOLAR_PALETTE[3], 'arcane');
      },
    });
  }

  // ── Lion Monk: Solar Lion Fury ───────────────────────────────────────────
  #startSolarFury(hero, skill, eff) {
    // The cooldown is longer than the stance, but this guard keeps scripted
    // tests from ever stacking two independently-expiring stat overrides.
    for (const old of [...this.solarFuries].filter((fury) => fury.hero === hero)) {
      this.#cleanupSolarFury(old);
    }

    const transformDuration = eff.transformDuration ?? 1.15;
    // During the morph the Monk is locked inside the solar core. Stat bonuses
    // only begin after the beast sprite has fully emerged.
    hero.solarFuryUntil = this.scene.clock + transformDuration + eff.duration;
    hero.solarTransformed = false;
    hero.setState(HERO_STATE.CAST, transformDuration);
    hero.playFor('windup', transformDuration);
    hero.sprite.setTint(SOLAR_PALETTE[3]);

    this.solarFuries.push({
      hero,
      skill,
      eff,
      left: eff.duration,
      age: 0,
      transformAge: 0,
      transformDuration,
      transformed: false,
      formSwapped: false,
      finishing: false,
      reverting: false,
      revertAge: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.ghost),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
    });
    this.scene.fx.screenFlash(SOLAR_PALETTE[3], 0.34, 220);
    this.scene.fx.ring(hero.x, hero.y - 8, 126, SOLAR_PALETTE[3], 560, 4);
    this.scene.fx.skillBurst(hero.x, hero.y - hero.spriteHeight * 0.48, SOLAR_PALETTE[1], 'explosion');
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 12, 'TRANSFORMING', SOLAR_PALETTE[1]);
  }

  #tickSolarFuries(dt) {
    for (const fury of [...this.solarFuries]) {
      fury.age += dt;
      const { hero, eff } = fury;

      if (!hero.alive) {
        this.#cleanupSolarFury(fury, false);
        continue;
      }

      if (!fury.transformed) {
        fury.transformAge += dt;
        const morphP = Phaser.Math.Clamp(fury.transformAge / fury.transformDuration, 0, 1);
        this.#tickSolarMorphSprite(fury, morphP);
        this.#drawSolarTransformation(fury, morphP);
        if (morphP >= 1) this.#completeSolarTransform(fury);
        continue;
      }

      if (fury.reverting) {
        fury.revertAge += dt;
        const revertDuration = 0.52;
        const revertP = Phaser.Math.Clamp(fury.revertAge / revertDuration, 0, 1);
        this.#tickSolarRevertSprite(fury, revertP);
        this.#drawSolarTransformation(fury, 1 - revertP);
        if (revertP >= 1) {
          this.#cleanupSolarFury(fury);
          if (hero.alive) hero.setState(HERO_STATE.RECOVER, 0.28);
        }
        continue;
      }

      if (!fury.finishing) fury.left -= dt;
      this.#drawSolarFury(fury);
      if (fury.finishing || fury.left > (eff.finisherWindup ?? 0.58)) continue;

      // Do not overwrite a regular skill already being committed. The finale
      // waits for that action to finish, then receives its own real telegraph.
      if (hero.isTelegraphing || hero.state === HERO_STATE.CAST) continue;
      if (!this.scene.monsters.some((m) => m.alive)) {
        this.#cleanupSolarFury(fury);
        continue;
      }
      this.#beginSolarFinisher(fury);
    }
  }

  #tickSolarMorphSprite(fury, p) {
    const { hero } = fury;
    if (p < 0.52) {
      const fade = 1 - (p / 0.52) * 0.76;
      hero.sprite.setAlpha(fade);
      hero.sprite.setScale(hero.visualScale * (1 + p * 0.12), hero.visualScale * (1 - p * 0.18));
      return;
    }
    if (!fury.formSwapped) {
      hero.setCombatForm('lionMonkBeast');
      fury.formSwapped = true;
    }
    const emerge = (p - 0.52) / 0.48;
    hero.sprite.setAlpha(0.24 + emerge * 0.76);
    hero.sprite.setScale(
      hero.visualScale * (0.72 + emerge * 0.28),
      hero.visualScale * (0.84 + emerge * 0.16),
    );
    hero.sprite.setTint(SOLAR_PALETTE[1 + Math.min(3, Math.floor(emerge * 4))]);
  }

  #completeSolarTransform(fury) {
    const { hero, eff } = fury;
    if (!fury.formSwapped) hero.setCombatForm('lionMonkBeast');
    fury.formSwapped = true;
    fury.transformed = true;
    fury.left = eff.duration;
    hero.solarTransformed = true;
    hero.solarMoveSpeedMult = eff.moveSpeedMult ?? 1.45;
    hero.solarAttackSpeedMult = eff.attackSpeedMult ?? 1.8;
    hero.solarBoltMult = eff.boltMult ?? 0.5;
    hero.basicRange = hero.baseBasicRange * (eff.rangeMult ?? 1.55);
    hero.solarFuryUntil = this.scene.clock + eff.duration;
    hero.applyAtkBuff(eff.atkMult ?? 1.7, eff.duration);
    hero.sprite.setAlpha(1).setScale(hero.visualScale).clearTint();
    hero.setState(HERO_STATE.RECOVER, 0.2);
    hero.play('idle', true);
    this.scene.fx.screenFlash(SOLAR_PALETTE[1], 0.42, 220);
    this.scene.fx.skillBurst(hero.x, hero.y - hero.spriteHeight * 0.5, SOLAR_PALETTE[1], 'explosion');
    this.scene.fx.ring(hero.x, hero.y - 8, 138, SOLAR_PALETTE[2], 520, 5);
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 12, 'LION FORM', SOLAR_PALETTE[1]);
  }

  #tickSolarRevertSprite(fury, p) {
    const { hero } = fury;
    if (p < 0.5) {
      hero.sprite.setAlpha(1 - p * 1.45);
      hero.sprite.setScale(hero.visualScale * (1 + p * 0.1), hero.visualScale * (1 - p * 0.16));
      return;
    }
    if (hero.art !== hero.normalArt) hero.resetCombatForm();
    const emerge = (p - 0.5) / 0.5;
    hero.sprite.setAlpha(0.28 + emerge * 0.72);
    hero.sprite.setScale(
      hero.visualScale * (0.82 + emerge * 0.18),
      hero.visualScale * (0.9 + emerge * 0.1),
    );
  }

  #drawSolarTransformation(fury, p) {
    const { hero } = fury;
    const g = fury.gfx;
    const back = fury.gfxBack;
    const air = fury.gfxAir;
    const x = snap(hero.x);
    const y = snap(hero.y);
    const cy = snap(y - hero.spriteHeight * 0.48);
    const pulse = 0.5 + 0.5 * Math.sin(fury.age * 12);
    const orbR = 18 + Math.sin(p * Math.PI) * 48 + p * 12;
    g.clear();
    back.clear();
    air.clear();

    // Expanding solar seal under the body, matching the orb/ring progression in
    // the reference before it condenses into the lion silhouette.
    g.fillStyle(SOLAR_PALETTE[5], 0.18 + p * 0.18);
    pxDisc(g, x, y + 2, 34 + p * 42, (34 + p * 42) * GROUND_SQUASH, { every: 3 });
    g.fillStyle(SOLAR_PALETTE[2], 0.62 + pulse * 0.18);
    pxGroundRing(g, x, y + 2, 38 + p * 48, {
      dash: 7, gap: 3, rot: Math.floor(fury.age * 24),
    });
    g.fillStyle(SOLAR_PALETTE[0], 0.48);
    pxGroundRing(g, x, y + 2, 24 + p * 31, {
      dash: 2, gap: 2, rot: -Math.floor(fury.age * 31),
    });

    // Four hard colour bands create a pixel-art fire sphere rather than a flat
    // orange tint. The white core peaks just before the beast sprite appears.
    back.fillStyle(SOLAR_PALETTE[6], 0.3 + pulse * 0.08);
    pxDisc(back, x, cy, orbR, orbR, { every: 3 });
    back.fillStyle(SOLAR_PALETTE[4], 0.5 + pulse * 0.12);
    pxDisc(back, x, cy, orbR * 0.78, orbR * 0.78, { every: 2 });
    back.fillStyle(SOLAR_PALETTE[2], 0.68 + pulse * 0.14);
    pxDisc(back, x, cy, orbR * 0.54, orbR * 0.54);
    back.fillStyle(SOLAR_PALETTE[0], 0.88);
    pxStar(back, x, cy, P * (4 + Math.round((1 - Math.abs(p - 0.52)) * 5)));

    for (let ring = 0; ring < 3; ring++) {
      const rr = orbR * (0.72 + ring * 0.2);
      air.fillStyle(SOLAR_PALETTE[ring], 0.62 - ring * 0.12);
      pxArc(air, x, cy, rr, rr * (0.62 + ring * 0.08), {
        dash: 8 - ring * 2,
        gap: 3,
        rot: (ring % 2 ? -1 : 1) * fury.age * (8 + ring * 3),
      });
    }

    // The lion face resolves out of the sphere in the second half: mane rays,
    // ears, blazing eyes, muzzle and an open jaw are all drawn explicitly.
    const lionP = Phaser.Math.Clamp((p - 0.42) / 0.58, 0, 1);
    if (lionP > 0) {
      const faceX = x + hero.facing * 5;
      const maneR = 30 + lionP * 18;
      for (let i = 0; i < 20; i++) {
        const a = fury.phase + (i / 20) * Math.PI * 2;
        air.fillStyle(SOLAR_PALETTE[2 + (i % 4)], lionP * (0.4 + (i % 3) * 0.11));
        pxLine(air,
          faceX + Math.cos(a) * maneR * 0.68, cy + Math.sin(a) * maneR * 0.68,
          faceX + Math.cos(a) * maneR * (0.94 + (i % 3) * 0.1),
          cy + Math.sin(a) * maneR * (0.94 + (i % 3) * 0.1));
      }
      air.fillStyle(SOLAR_PALETTE[3], 0.72 * lionP);
      pxLine(air, faceX - 20, cy - 16, faceX - 10, cy - 30);
      pxLine(air, faceX + 20, cy - 16, faceX + 10, cy - 30);
      air.fillStyle(SOLAR_PALETTE[0], 0.95 * lionP);
      air.fillRect(faceX - 13, cy - 6, P * 3, P * 2);
      air.fillRect(faceX + 7, cy - 6, P * 3, P * 2);
      air.fillStyle(SOLAR_PALETTE[1], 0.8 * lionP);
      pxDisc(air, faceX + hero.facing * 7, cy + 8, 13, 8);
      air.fillStyle(SOLAR_PALETTE[6], 0.9 * lionP);
      air.fillRect(faceX + hero.facing * 5 - P, cy + 5, P * 3, P * 3);
      pxLine(air, faceX + hero.facing * 7, cy + 13,
        faceX + hero.facing * 17, cy + 19);
    }

    for (let i = 0; i < 36; i++) {
      const a = fury.phase + i * 2.17 + fury.age * (2 + (i % 4));
      const r = orbR * (0.5 + (i % 7) * 0.13);
      const mx = snap(x + Math.cos(a) * r);
      const my = snap(cy + Math.sin(a) * r - (i % 5) * p * 3);
      air.fillStyle(SOLAR_PALETTE[1 + (i % 5)], 0.34 + (i % 4) * 0.12);
      air.fillRect(mx, my, i % 9 === 0 ? P * 2 : P, i % 6 === 0 ? P * 2 : P);
    }
  }

  #drawSolarFury(fury) {
    const { hero } = fury;
    const x = snap(hero.x);
    const y = snap(hero.y);
    const h = hero.spriteHeight;
    const cx = x;
    const cy = snap(y - h * 0.58);
    const pulse = 0.5 + 0.5 * Math.sin(fury.age * 5.2);
    const open = Phaser.Math.Clamp(fury.age / 0.48, 0, 1);
    const g = fury.gfx;
    const back = fury.gfxBack;
    const air = fury.gfxAir;
    g.clear();
    back.clear();
    air.clear();

    g.fillStyle(SOLAR_PALETTE[5], 0.13 + pulse * 0.04);
    pxDisc(g, x, y + 2, 62, 62 * GROUND_SQUASH, { every: 4 });
    g.fillStyle(SOLAR_PALETTE[3], 0.54 + pulse * 0.16);
    pxGroundRing(g, x, y + 2, 62, { dash: 6, gap: 3, rot: Math.floor(fury.age * 14) });
    g.fillStyle(SOLAR_PALETTE[1], 0.4);
    pxGroundRing(g, x, y + 2, 43, { dash: 2, gap: 3, rot: -Math.floor(fury.age * 19) });

    // Sun rays and a rough mane stay behind the transformed body.
    const maneR = (31 + pulse * 5) * open;
    for (let i = 0; i < 18; i++) {
      const a = fury.phase + (i / 18) * Math.PI * 2;
      const inner = maneR * 0.72;
      const outer = maneR * (1.1 + (i % 3) * 0.12);
      back.fillStyle(SOLAR_PALETTE[2 + (i % 4)], 0.34 + pulse * 0.16);
      pxLine(back,
        cx + Math.cos(a) * inner, cy + Math.sin(a) * inner,
        cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }
    back.fillStyle(SOLAR_PALETTE[4], 0.24 + pulse * 0.08);
    pxDisc(back, cx, cy, maneR, maneR, { every: 3 });

    // Orbiting flame motes keep the entire body energized, not only its head.
    for (let i = 0; i < 24; i++) {
      const ph = (fury.age * (0.42 + (i % 4) * 0.04) + i / 24) % 1;
      const a = fury.phase + i * 2.31 + fury.age * 0.7;
      const mx = snap(x + Math.cos(a) * (20 + (i % 5) * 7));
      const my = snap(y - 4 - ph * (h + 32));
      air.fillStyle(SOLAR_PALETTE[1 + (i % 5)], (1 - ph) * (0.38 + (i % 4) * 0.12));
      air.fillRect(mx, my, i % 8 === 0 ? P * 2 : P, i % 5 === 0 ? P * 2 : P);
    }
  }

  #beginSolarFinisher(fury) {
    const { hero, eff } = fury;
    let target = null;
    let best = Infinity;
    for (const m of this.scene.monsters) {
      if (!m.alive) continue;
      const d = hero.distanceTo(m);
      if (d < best) { best = d; target = m; }
    }
    if (target) hero.facing = target.x >= hero.x ? 1 : -1;
    const facing = hero.facing;
    const windup = eff.finisherWindup ?? 0.58;
    fury.finishing = true;
    hero.pendingSkill = fury.skill;
    hero.setState(HERO_STATE.TELEGRAPH, windup + 2);
    hero.playFor('windup', windup);

    this.scene.telegraph.begin({
      kind: TELEGRAPH_KIND.DAMAGE,
      shape: 'cone',
      radius: eff.finisherRadius,
      arc: eff.finisherArc,
      duration: windup,
      label: 'SOLAR FINISHER',
      heavy: true,
      source: hero,
      x: hero.x,
      y: hero.y - 10,
      facing,
      onComplete: () => {
        if (hero.alive) {
          hero.play('attack', true);
          hero.setState(HERO_STATE.CAST, 0.52);
          this.#finishSolarFury(fury, facing);
          fury.finishing = false;
          fury.reverting = true;
          fury.revertAge = 0;
        }
        hero.pendingSkill = null;
        if (!hero.alive) this.#cleanupSolarFury(fury, false);
      },
      onCancel: () => {
        hero.pendingSkill = null;
        if (hero.alive) {
          hero.play('hit', true);
          hero.setState(HERO_STATE.RECOVER, 0.65);
          this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 12,
            'FINISHER CANCELLED', COLORS.tgControl);
        }
        this.#cleanupSolarFury(fury);
      },
    });
  }

  #finishSolarFury(fury, facing) {
    const { hero, eff, skill } = fury;
    const victims = this.scene.combat.monstersInCone(
      hero.x, hero.y - 10, facing, eff.finisherRadius, eff.finisherArc,
    );
    for (const m of victims) {
      this.scene.combat.strike(hero, m, {
        mult: eff.finisherMult,
        color: SOLAR_PALETTE[1],
        knockback: eff.finisherKnockback,
        ignoreBlock: true,
      });
    }
    this.#startBurningPalm(hero, facing, {
      radius: eff.finisherRadius,
      fxLife: 0.76,
    }, { scale: 1.8, finisher: true, life: 0.76 });
    const impactX = hero.x + facing * eff.finisherRadius * 0.48;
    this.scene.fx.ring(impactX, hero.y - 12, eff.finisherRadius * 0.56, SOLAR_PALETTE[2], 480, 5);
    this.scene.fx.scorch(impactX, hero.y, eff.finisherRadius * 0.42, SOLAR_PALETTE[5]);
    this.scene.fx.impact({ color: SOLAR_PALETTE[1], shake: 0.028, flash: 0.56, stop: 145 });
    this.scene.audio?.playSkill(hero, 'solarFinisher');
    this.#report(skill, victims.length);
  }

  #cleanupSolarFury(fury, clearTint = true) {
    const { hero } = fury;
    if (hero) {
      hero.solarFuryUntil = 0;
      hero.solarTransformed = false;
      hero.solarMoveSpeedMult = 1;
      hero.solarAttackSpeedMult = 1;
      hero.solarBoltMult = 0;
      hero.basicRange = hero.baseBasicRange;
      if (hero.alive) {
        hero.resetCombatForm();
        if (clearTint) hero.sprite.clearTint();
      }
    }
    fury.gfx?.destroy();
    fury.gfxBack?.destroy();
    fury.gfxAir?.destroy();
    this.solarFuries = this.solarFuries.filter((active) => active !== fury);
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
