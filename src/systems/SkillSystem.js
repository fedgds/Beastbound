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
import {
  GROUND_SQUASH, P, pxDisc, pxLine, pxStar, snap,
} from '../art/PixelDraw.js';
// Solid, shaded forms. Everything below that used to be a fan of pxLine rays or
// a scatter of 1-block motes now goes through these, so each effect has a
// silhouette and a lit side instead of being line-art laid over the arena.
import {
  arrowForm, clawGash, clawHand, crescentForm, debrisChunk, dustPuff, fangForm,
  figureForm, flameTongue, groundBand, groundCrack, lionMaw, pillarForm,
  runeGlyph, shade, shardFan, solidArcBand, solidWedge,
} from '../art/SkillForms.js';

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
      const pal = JUDGMENT_PALETTE;
      g.clear();
      air.clear();

      const latestWaveAt = judgment.firstWaveDelay
        + Math.max(0, judgment.wave - 1) * judgment.waveInterval;
      const punch = Math.max(0, 1 - Math.abs(judgment.age - latestWaveAt) / 0.3);
      const done = judgment.wave >= judgment.waves;

      // ── the seal, and the floor it ruins ──────────────────────────────
      // Scorched core first, so the halo bands sit on burnt stone.
      const coreR = radius * (0.1 + burst * 0.22);
      g.fillStyle(shade(pal, 6), (0.4 + (1 - release) * 0.2) * fade);
      pxDisc(g, x, y, coreR, coreR * GROUND_SQUASH, { every: 2 });
      g.fillStyle(shade(pal, 2), (0.3 + punch * 0.4) * fade);
      pxDisc(g, x, y, coreR * 0.55, coreR * 0.55 * GROUND_SQUASH);

      if (burst > 0) {
        const outerR = radius * (0.18 + burst * 0.82);
        const crownR = radius * (0.22 + burst * 0.42);
        groundBand(g, x, y, outerR, {
          palette: pal, tone: 3, thickness: P * (2 + Math.round(punch * 3)),
          alpha: (0.72 - release * 0.24) * fade, bite: 1.6, seed: 5,
        });
        groundBand(g, x, y, crownR, {
          palette: pal, tone: 1, thickness: P * 3,
          alpha: (0.8 - release * 0.3) * fade, bite: 1, seed: 12,
        });

        // Twelve runes struck into the inner seal — a verdict, in writing.
        const runeSpin = judgment.age * 0.5;
        for (let i = 0; i < 12; i++) {
          const a = runeSpin + (i / 12) * Math.PI * 2;
          runeGlyph(g,
            x + Math.cos(a) * crownR * 0.98,
            y + Math.sin(a) * crownR * 0.98 * GROUND_SQUASH, {
              palette: pal, tone: 1, size: 8 + (i % 3),
              alpha: (0.62 + punch * 0.35 - release * 0.22) * fade,
              variant: i % 6,
            });
        }

        // Each beat drives the fractures further out. They never close again.
        const crackReveal = Phaser.Math.Clamp(
          (judgment.wave + Math.min(1, (judgment.age - latestWaveAt) * 4)) / judgment.waves, 0, 1,
        );
        for (let i = 0; i < 14; i++) {
          const a = judgment.phase + (i / 14) * Math.PI * 2;
          groundCrack(g, x + Math.cos(a) * coreR * 0.7, y + Math.sin(a) * coreR * 0.7 * GROUND_SQUASH, {
            palette: pal, tone: 4, angle: a,
            length: radius * (0.62 + (i % 4) * 0.11),
            alpha: (0.55 - release * 0.18) * fade,
            reveal: crackReveal, seed: i * 3 + 2, branches: 2, width: P * 2,
          });
        }
      }

      // ── the sword ────────────────────────────────────────────────────
      // It hangs at the floor on the instant of each beat, rebounds, then falls
      // again — so three hits read as three swings of one weapon.
      let lift;
      if (judgment.age < judgment.firstWaveDelay) {
        lift = 1 - (judgment.age / judgment.firstWaveDelay) ** 2;
      } else if (done) {
        lift = 0;
      } else if (beatPhase < 0.3) {
        lift = (beatPhase / 0.3) ** 0.7 * 0.6;
      } else {
        lift = (1 - ((beatPhase - 0.3) / 0.7) ** 2.4) * 0.6;
      }

      const swordA = fade * (done ? Math.max(0, 1 - release * 1.25) : 1);
      if (swordA > 0.02) {
        const bladeLen = 176;
        const jx = snap(x + pulseJitter);
        const tipY = snap(y - lift * 300);

        // The shaft of light the sword falls inside.
        pillarForm(air, jx, tipY, {
          palette: pal, tone: 2,
          height: Math.max(P * 4, tipY - Math.max(0, y - 400)),
          width: 15 + punch * 13,
          alpha: (0.2 + punch * 0.24) * beamFade * fade,
          grow: 1, facets: 4, flare: 2.4, taper: 0.42,
          bandEvery: 6, bandPhase: Math.floor(judgment.age * 22),
          topFade: 0.4, dissolve: 0.5, seed: 8,
        });

        // Afterimages of the plunge: the same weapon, one and two beats above.
        if (lift > 0.04) {
          for (let a = 2; a >= 1; a--) {
            this.#drawJudgmentSword(air, jx, snap(tipY + a * 34 + lift * 40), bladeLen,
              swordA * 0.16 * a * lift, 0);
          }
        }
        this.#drawJudgmentSword(air, jx, tipY, bladeLen, swordA, punch);
      }

      // ── the moment of contact ────────────────────────────────────────
      if (punch > 0.02) {
        for (let i = 0; i < 14; i++) {
          const a = judgment.phase * 0.5 + (i / 14) * Math.PI * 2;
          shardFan(air, x + Math.cos(a) * coreR, y + Math.sin(a) * coreR * GROUND_SQUASH, {
            palette: pal, tone: 1 + (i % 3), angle: a, spread: 0.5, count: 3,
            r0: 0, r1: radius * 0.24 * punch + 8, alpha: punch * 0.7,
            squash: GROUND_SQUASH, seed: i, width: P * 2,
          });
        }
        solidArcBand(air, x, y - 2, {
          palette: pal, tone: 0, from: 0, to: Math.PI * 2,
          r: radius * (0.2 + (1 - punch) * 0.8), thickness: P * (1 + Math.round(punch * 4)),
          alpha: punch * 0.85, squash: GROUND_SQUASH, taperEnds: 0, seed: 22,
        });
      }

      // Dust ring rolling out from the last strike, and embers settling into the
      // scorch mark rather than blinking out on the impact frame.
      if (release > 0.02) {
        for (let i = 0; i < 10; i++) {
          const a = judgment.phase + (i / 10) * Math.PI * 2;
          const pr = radius * (0.4 + release * 0.62);
          dustPuff(g, x + Math.cos(a) * pr, y + Math.sin(a) * pr * GROUND_SQUASH, {
            palette: pal, tone: 4, size: 16 + release * 16,
            alpha: 0.34 * (1 - release) * fade, lumps: 3, seed: i * 4, squash: 0.6,
          });
        }
      }
      for (let i = 0; i < 22; i++) {
        const q = ((i * 17) % 23) / 22;
        const a = judgment.phase + i * 2.13 + release * (i % 2 ? 0.6 : -0.4);
        const driftR = radius * (0.14 + q * 0.6) * (0.65 + release * 0.35);
        const emberLift = (1 - release) * (14 + (i % 7) * 6);
        debrisChunk(air,
          snap(x + Math.cos(a) * driftR),
          snap(y + Math.sin(a) * driftR * GROUND_SQUASH - emberLift), {
            palette: pal, tone: i % 6 === 0 ? 6 : 1 + (i % 4),
            size: P * (1 + (i % 3)),
            alpha: Math.min(1, burst * 2) * fade * (0.34 + (i % 4) * 0.15),
            seed: i * 5, squash: 0.9, spin: Math.floor(judgment.age * 14 + i),
          });
      }

      if (judgment.age < judgment.life) continue;
      this.#report(judgment.skill, judgment.hits.size);
      g.destroy();
      air.destroy();
      this.judgments = this.judgments.filter((j) => j !== judgment);
    }
  }

  /**
   * One greatsword, point down, drawn from its tip. A parallel-sided blade with
   * a real point, a centred fuller, a heavy straight crossguard with drooping
   * quillons, a wrapped grip and a faceted pommel — so three beats read as one
   * weapon being driven into the floor three times, not as a beam of light.
   */
  #drawJudgmentSword(g, jx, tipY, bladeLen, alpha, punch) {
    if (alpha <= 0.02) return;
    const pal = JUDGMENT_PALETTE;
    const halfW = P * 6;
    const rows = Math.round(bladeLen / P);
    const pointRows = Math.round(rows * 0.17);

    // ── blade ────────────────────────────────────────────────────────────
    for (let i = 0; i < rows; i++) {
      const yy = snap(tipY - i * P);
      let w;
      if (i < pointRows) w = Math.max(P, snap(halfW * (i / pointRows) ** 0.62));
      else w = Math.max(P, snap(halfW * (1 - ((i - pointRows) / rows) * 0.1)));
      const x0 = snap(jx - w);
      const span = w * 2;
      // body, then the two ground edges: lit on the left, shaded on the right
      g.fillStyle(shade(pal, 3), alpha * 0.95);
      g.fillRect(x0, yy, span, P);
      g.fillStyle(shade(pal, 1), alpha);
      g.fillRect(x0, yy, P, P);
      g.fillStyle(shade(pal, 5), alpha * 0.92);
      g.fillRect(x0 + span - P, yy, P, P);
      // fuller: a recessed channel down the centre, dark then bright
      if (w > P * 2 && i > pointRows * 0.7) {
        g.fillStyle(shade(pal, 5), alpha * 0.75);
        g.fillRect(snap(jx - P), yy, P * 2, P);
        g.fillStyle(shade(pal, 0), alpha * 0.85);
        g.fillRect(snap(jx - P), yy, P, P);
      }
      // three struck inscription bands, not a ladder of rungs
      if (i > pointRows && i % 23 === (punch > 0.5 ? 3 : 9)) {
        g.fillStyle(shade(pal, 0), alpha * (0.34 + punch * 0.4));
        g.fillRect(x0 + P, yy, span - P * 2, P);
      }
    }

    const guardY = snap(tipY - rows * P);
    // ── crossguard: a straight bar with drooping quillons ────────────────
    for (let r = 0; r < 6; r++) {
      const gw = snap(42 - r * 2);
      const yy = snap(guardY + r * P - P * 2);
      g.fillStyle(shade(pal, r === 0 ? 2 : r > 3 ? 5 : 3), alpha);
      g.fillRect(snap(jx - gw), yy, gw * 2, P);
      g.fillStyle(shade(pal, r === 0 ? 0 : 4), alpha);
      g.fillRect(snap(jx - gw), yy, P, P);
      g.fillRect(snap(jx + gw - P), yy, P, P);
    }
    for (const s of [-1, 1]) {
      solidWedge(g, jx + s * 40, guardY, {
        palette: pal, tone: 3, angle: s > 0 ? 0.85 : Math.PI - 0.85,
        r0: 0, r1: 16, w0: P * 4, w1: P,
        alpha, taper: 1.3, notch: false, seed: s > 0 ? 13 : 14,
      });
    }
    // langets clamping the blade under the guard
    g.fillStyle(shade(pal, 4), alpha);
    g.fillRect(snap(jx - halfW - P), snap(guardY + P * 4), (halfW + P) * 2, P * 3);
    g.fillStyle(shade(pal, 1), alpha);
    g.fillRect(snap(jx - halfW - P), snap(guardY + P * 4), P * 2, P);

    // ── wrapped grip ─────────────────────────────────────────────────────
    const gripRows = 15;
    for (let r = 0; r < gripRows; r++) {
      const yy = snap(guardY - P * 3 - r * P);
      const gw = P * (r > gripRows - 3 ? 2 : 3);
      g.fillStyle(shade(pal, r % 3 === 0 ? 4 : 6), alpha);
      g.fillRect(snap(jx - gw), yy, gw * 2, P);
      g.fillStyle(shade(pal, r % 3 === 0 ? 2 : 5), alpha);
      g.fillRect(snap(jx - gw), yy, P, P);
    }

    // ── pommel ───────────────────────────────────────────────────────────
    const pomY = snap(guardY - P * 3 - gripRows * P - P * 3);
    g.fillStyle(shade(pal, 4), alpha);
    pxDisc(g, jx, pomY, P * 5, P * 4);
    g.fillStyle(shade(pal, 2), alpha);
    pxDisc(g, snap(jx - P), snap(pomY - P), P * 3, P * 2);
    g.fillStyle(shade(pal, 0), alpha);
    g.fillRect(snap(jx - P), snap(pomY - P * 2), P * 2, P);
    runeGlyph(g, jx, pomY, {
      palette: pal, tone: 0, size: 5, alpha: alpha * (0.6 + punch * 0.4), variant: 1,
    });
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
        spin: Phaser.Math.FloatBetween(0, Math.PI * 2), age: 0, redraw: 0,
        gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
        // The drift and scour the column carves belong on the floor, under the
        // monsters it is freezing — the column itself stays in the air layer.
        gfxBack: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
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
      const back = storm.gfxBack;
      // The column is expensive and up to five of them run at once, so it is
      // re-rasterised on its own ~26 Hz beat instead of every frame. A vortex
      // stepping on a slightly coarser clock also looks more hand-animated; the
      // few pixels of lag against its own drift are invisible.
      storm.redraw -= dt;
      if (storm.redraw <= 0) {
        storm.redraw += 1 / 26;
        g.clear();
        back.clear();
        this.#drawBlizzardVortex(g, back, storm);
      }
      if (storm.tick <= 0) {
        storm.tick = storm.interval;
        for (const m of this.scene.combat.monstersInCircle(storm.x, storm.y, storm.r)) {
          this.scene.combat.strike(this.scene.hero, m, { mult: storm.mult, color: 0xa9f5ff });
          m.applySlow(storm.slowMult, storm.slowSeconds);
        }
      }
      if (storm.left > 0) continue;
      g.destroy();
      back.destroy();
      this.blizzards = this.blizzards.filter((s) => s !== storm);
    }
  }

  /**
   * A cyclone of snow rather than a stack of arcs.
   *
   * Floor: a scoured drift with counter-rotating bands and tangential wind
   * streaks, so the ground shows which way the air is turning. Air: a shadowed
   * eye with six shells of wind wrapped around it — tight at the floor, flared
   * into a flat crown — plus ice torn loose and thrown around the outside. It
   * spins up over the first half-second and unravels over the last one, so the
   * storm has a beginning and an end instead of popping in and out.
   */
  #drawBlizzardVortex(g, back, storm) {
    const x = snap(storm.x);
    const y = snap(storm.y);
    const pal = NOVA_ICE_PALETTE;
    const spin = storm.spin;

    const open = Phaser.Math.Clamp(storm.age / 0.55, 0, 1);
    const close = Phaser.Math.Clamp(storm.left / 0.5, 0, 1);
    const power = open * close;
    if (power <= 0.02) return;
    const H = 94 * (0.42 + power * 0.58); // column height
    const R = 47 * (0.48 + power * 0.52); // crown radius

    // ── floor: packed drift, then the scour marks the rotation leaves ────────
    back.fillStyle(shade(pal, 7), 0.15 * power);
    pxDisc(back, x, y + 4, storm.r * 0.94, storm.r * 0.94 * GROUND_SQUASH, { every: 3 });
    back.fillStyle(shade(pal, 4), 0.15 * power);
    pxDisc(back, x, y + 4, 30, 30 * GROUND_SQUASH, { every: 2 });

    // Counter-rotating partial bands. Complete rings would read as a damage
    // marker — that is the telegraph's job, not the storm's.
    for (let s = 0; s < 3; s++) {
      const rr = storm.r * (0.94 - s * 0.3);
      const dir = s % 2 ? -1 : 1;
      const from = spin * dir * (0.45 + s * 0.2) + s * 2.1;
      groundBand(back, x, y + 4, rr, {
        palette: pal, tone: s === 1 ? 2 : 6,
        thickness: P * (s === 1 ? 3 : 2),
        alpha: (s === 1 ? 0.5 : 0.3) * power, bite: 1.6, seed: s * 5,
        arcFrom: from, arcTo: from + Math.PI * (1.05 + s * 0.28),
      });
    }
    // Tangential streaks: snow being dragged around, not radial spokes.
    for (let i = 0; i < 5; i++) {
      const a = spin * 0.55 + (i / 5) * Math.PI * 2;
      const rr = storm.r * (0.52 + ((i * 3) % 7) / 17);
      solidWedge(back, x + Math.cos(a) * rr, y + 4 + Math.sin(a) * rr * GROUND_SQUASH, {
        palette: pal, tone: 4 + (i % 3), angle: a + Math.PI * 0.5,
        r0: 0, r1: 19 + (i % 4) * 7, w0: P * 2, w1: P,
        alpha: 0.34 * power, squash: GROUND_SQUASH,
        taper: 1.4, notch: false, seed: i * 4,
      });
    }
    for (let i = 0; i < 3; i++) {
      const a = -spin * 0.45 + (i / 3) * Math.PI * 2;
      dustPuff(back,
        x + Math.cos(a) * storm.r * 0.68,
        y + 6 + Math.sin(a) * storm.r * 0.68 * GROUND_SQUASH, {
          palette: pal, tone: 6, size: 14 + (i % 2) * 5,
          alpha: 0.26 * power, lumps: 3, seed: i * 6,
        });
    }

    // ── the eye: a shadowed core for the shells to wrap ─────────────────────
    pillarForm(g, x, y + 6, {
      palette: pal, tone: 7, height: H * 0.9, width: 9 + power * 7,
      alpha: 0.45 * power, grow: 1, facets: 3, flare: 1.7, taper: 0.5,
      bandEvery: 5, bandPhase: Math.floor(storm.age * 26),
      topFade: 0.5, dissolve: 0.45, seed: 11,
    });

    // ── five shells of wind, bottom first so the column stacks correctly ────
    // Mid tones on the body, highlights only on the outer crest: a column made
    // entirely of the bright end of the ramp reads as one white smear.
    for (let b = 0; b < 5; b++) {
      const q = b / 4;
      const sx = snap(x + Math.sin(spin * 0.5 + q * 2.4) * (4 + q * 9));
      const sy = snap(y + 10 - q * H);
      const rr = R * (0.22 + 0.78 * q ** 0.9);
      const sq = 0.4 + q * 0.13;
      const th = P * 2 + q * P * 3;
      const phase = spin * (1.55 - q * 0.5) + b * 1.05;

      // far side first, in the shadow tones, so the near sweep sits over it
      solidArcBand(g, sx, sy, {
        palette: pal, tone: 7, from: phase + Math.PI * 1.3,
        to: phase + Math.PI * 2.15, r: rr, thickness: th * 0.8,
        alpha: 0.55 * power, squash: sq, taperEnds: 0.4, glint: false, seed: b * 3,
      });
      solidArcBand(g, sx, sy, {
        palette: pal, tone: 4 + (b % 2), from: phase, to: phase + Math.PI * 1.34,
        r: rr, thickness: th, alpha: (0.92 - q * 0.12) * power,
        squash: sq, taperEnds: 0.5, seed: b * 3 + 1,
      });
      // one bright thread low in the column, where the wind is fastest
      if (b % 3 === 0) {
        solidArcBand(g, sx, sy, {
          palette: pal, tone: 2, from: phase + Math.PI * 0.75,
          to: phase + Math.PI * 1.5, r: rr * 0.52, thickness: P * 2,
          alpha: 0.6 * power, squash: sq, taperEnds: 0.6, glint: false, seed: b * 7,
        });
      }
    }

    // ── crown: the flat cloud lid the column feeds ──────────────────────────
    const crownY = snap(y + 10 - H);
    solidArcBand(g, x, crownY, {
      palette: pal, tone: 6, from: 0, to: Math.PI * 2, r: R * 1.16,
      thickness: P * 3, alpha: 0.5 * power, squash: 0.34,
      taperEnds: 0, glint: false, seed: 21,
    });
    solidArcBand(g, x, crownY, {
      palette: pal, tone: 3, from: spin * 0.4, to: spin * 0.4 + Math.PI * 0.9,
      r: R * 1.16, thickness: P * 3, alpha: 0.8 * power, squash: 0.34, seed: 22,
    });
    for (let i = 0; i < 3; i++) {
      const a = spin * 0.4 + (i / 3) * Math.PI * 2;
      dustPuff(g, x + Math.cos(a) * R * 0.95, crownY + Math.sin(a) * R * 0.32, {
        palette: pal, tone: 5, size: 15 + (i % 2) * 6,
        alpha: 0.42 * power, lumps: 3, seed: i * 9 + 2,
      });
    }

    // ── torn ice: chunks on the orbit, whole shards flung out at the rim ────
    for (let i = 0; i < 10; i++) {
      const q = (i % 5) / 4;
      const a = spin * (1.6 + q) + i * 1.91;
      const rad = R * (0.3 + q * 0.88);
      debrisChunk(g,
        snap(x + Math.cos(a) * rad),
        snap(y + 12 - q * H + Math.sin(a) * rad * 0.34), {
          palette: pal, tone: 3 + (i % 3), size: 5 + (i % 3) * 3,
          alpha: (0.9 - q * 0.12) * power, seed: i * 5, spin: Math.floor(spin * 3 + i),
        });
    }
    for (let i = 0; i < 4; i++) {
      const a = -spin * 1.2 + (i / 4) * Math.PI * 2;
      const q = ((i * 2) % 5) / 4;
      const rad = R * (0.85 + q * 0.4);
      this.#drawLanceCrystal(g,
        snap(x + Math.cos(a) * rad),
        snap(y + 14 - q * H * 0.8), {
          height: 17 + (i % 3) * 7, width: 8 + (i % 2) * 3,
          tone: 3 + (i % 3), lean: Math.cos(a) * 13, grow: 1, alpha: 0.9 * power,
        });
    }

    // ── base spray + cold lightning stitching the funnel to the floor ───────
    for (let i = 0; i < 4; i++) {
      const a = spin * 0.9 + (i / 4) * Math.PI * 2;
      shardFan(g, x + Math.cos(a) * 12, y + 12 + Math.sin(a) * 6, {
        palette: pal, tone: 2 + (i % 3), angle: a, spread: 0.5, count: 2,
        r0: 4, r1: 22 + (i % 3) * 8, alpha: 0.55 * power,
        squash: GROUND_SQUASH, seed: i * 3, width: P * 2,
      });
    }
    const beat = Math.floor(storm.age * 6);
    if (beat % 2 === 0) {
      const side = beat % 4 === 0 ? 1 : -1;
      let bx = x + side * 8;
      let by = crownY + 12;
      for (let s = 0; s < 3; s++) {
        const nx = x + side * (s % 2 === 0 ? -7 : 9) + side * s * 3;
        const ny = by + (y + 6 - by) / (3 - s);
        solidWedge(g, bx, by, {
          palette: pal, tone: s === 0 ? 0 : 1,
          angle: Math.atan2(ny - by, nx - bx),
          r0: 0, r1: Math.hypot(nx - bx, ny - by),
          w0: P * 2, w1: P, alpha: 0.8 * power,
          taper: 1, notch: false, seed: s * 6,
        });
        bx = nx;
        by = ny;
      }
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

  /**
   * A cyclone with a body. Six blade shells stack into a funnel that widens as
   * it rises, debris is carried up the column, two bright sword trails cut
   * through it at chest height, and the last beat blows the whole shell outward
   * as solid rings and shards instead of flashing a star.
   */
  #drawWhirlwind(g, air, spin) {
    const pal = WHIRLWIND_PALETTE;
    const x = snap(spin.x);
    const y = snap(spin.y);
    const groundY = snap(spin.y + 11);
    const rot = spin.age * 11;
    const stepIndex = Math.min(Math.max(0, spin.beat), spin.steps.length - 1);
    const targetReach = spin.radius * (spin.steps[stepIndex] ?? 1);
    const windup = Phaser.Math.Clamp(spin.age / 0.24, 0, 1);
    const reach = targetReach * (0.3 + windup * 0.7);
    const tailP = spin.lastBeatAt === null
      ? 0
      : Phaser.Math.Clamp((spin.age - spin.lastBeatAt) / spin.fxTail, 0, 1);
    const fade = spin.lastBeatAt === null ? 1 : Math.max(0, 1 - tailP * 1.2);

    // ── the floor being scoured ───────────────────────────────────────────
    if (fade > 0) {
      g.fillStyle(shade(pal, 6), 0.16 * fade);
      pxDisc(g, x, groundY, reach * 0.95, reach * 0.95 * GROUND_SQUASH, { every: 4 });
      groundBand(g, x, groundY, reach, {
        palette: pal, tone: 3, thickness: P * 3, alpha: 0.52 * fade, bite: 1.4, seed: 3,
      });
      groundBand(g, x, groundY, reach * (0.52 + 0.06 * Math.sin(rot * 0.5)), {
        palette: pal, tone: 2, thickness: P * 2, alpha: 0.4 * fade, bite: 1, seed: 8,
      });
      for (let i = 0; i < 9; i++) {
        const ca = (i / 9) * Math.PI * 2 - rot * 0.09;
        groundCrack(g,
          x + Math.cos(ca) * reach * 0.2,
          groundY + Math.sin(ca) * reach * 0.2 * GROUND_SQUASH, {
            palette: pal, tone: 5, angle: ca,
            length: reach * (0.48 + (i % 3) * 0.17),
            alpha: 0.42 * fade, reveal: windup, seed: i * 4 + 2,
            branches: 1, width: P * 2,
          });
      }
    }

    // ── the funnel: shells that widen as they rise ────────────────────────
    // Each shell is a thick swung band drawn as a partial sweep, so the near
    // side reads in front of the Knight and the far side behind him.
    const shells = 6;
    for (let s = 0; s < shells; s++) {
      const q = s / (shells - 1);
      const sr = reach * (0.3 + q * 0.72);
      const sy = y + 8 - q * 46;
      const speed = 1 + q * 0.45;
      const from = rot * speed + s * 1.9;
      solidArcBand(air, x, sy, {
        palette: pal, tone: 1 + (s % 3),
        from, to: from + Math.PI * (1.05 + q * 0.35),
        r: sr, thickness: P * (4 - Math.round(q * 1.6)),
        alpha: (0.9 - q * 0.28) * fade,
        squash: GROUND_SQUASH * (1 - q * 0.2),
        taperEnds: 0.7, seed: s * 3 + 1,
      });
      // the trailing half of the same shell, dimmer: the wrap-around
      solidArcBand(air, x, sy, {
        palette: pal, tone: 4 + (s % 2),
        from: from + Math.PI * 1.2, to: from + Math.PI * 1.95,
        r: sr * 0.97, thickness: P * 2,
        alpha: (0.4 - q * 0.12) * fade,
        squash: GROUND_SQUASH * (1 - q * 0.2),
        taperEnds: 0.5, glint: false, seed: s * 3 + 9,
      });
    }

    // Debris pulled off the floor and carried up the funnel. Height is tied to
    // its own phase, so the column always has chunks at every altitude.
    for (let i = 0; i < 16; i++) {
      const lift = ((spin.age * 0.9 + i * 0.11) % 1);
      const da = rot * (1.15 + (i % 3) * 0.12) + i * 2.3;
      const dr = reach * (0.34 + lift * 0.6);
      debrisChunk(air,
        x + Math.cos(da) * dr,
        y + 8 - lift * 52 + Math.sin(da) * dr * GROUND_SQUASH * 0.5, {
          palette: pal, tone: 3 + (i % 3),
          size: P * (2 + (i % 3)) * (1 - lift * 0.35),
          alpha: (0.85 - lift * 0.5) * fade, seed: i * 5,
          spin: Math.floor(spin.age * 24 + i),
        });
    }

    // Two bright sword trails at chest height — the actual weapon inside the
    // wind, so the cyclone reads as something the Knight is doing.
    for (const s of [0, 1]) {
      const from = -rot * 1.9 + s * Math.PI;
      solidArcBand(air, x, y - 4, {
        palette: pal, tone: 0,
        from, to: from + Math.PI * 0.62,
        r: reach * 0.86, thickness: P * 3,
        alpha: 0.92 * fade, squash: GROUND_SQUASH * 0.9,
        taperEnds: 1.1, seed: 21 + s,
      });
    }

    // ── the final beat: the shell blows outward ───────────────────────────
    if (spin.lastBeatAt !== null) {
      const since = spin.age - spin.lastBeatAt;
      const peak = Math.max(0, 1 - since / 0.42);
      if (peak > 0) {
        const blastR = spin.radius * (0.4 + (1 - peak) * 0.85);
        solidArcBand(air, x, y - 2, {
          palette: pal, tone: 0,
          from: 0, to: Math.PI * 2,
          r: blastR, thickness: P * (2 + Math.round(peak * 5)),
          alpha: 0.9 * peak, squash: GROUND_SQUASH,
          taperEnds: 0, seed: 33,
        });
        solidArcBand(air, x, y - 2, {
          palette: pal, tone: 3,
          from: 0, to: Math.PI * 2,
          r: blastR * 0.72, thickness: P * 3,
          alpha: 0.6 * peak, squash: GROUND_SQUASH,
          taperEnds: 0, glint: false, seed: 34,
        });
        for (let i = 0; i < 12; i++) {
          const ba = (i / 12) * Math.PI * 2 + rot * 0.1;
          shardFan(air, x + Math.cos(ba) * blastR * 0.5,
            y - 2 + Math.sin(ba) * blastR * 0.5 * GROUND_SQUASH, {
              palette: pal, tone: 1 + (i % 3), angle: ba, spread: 0.5,
              count: 3, r0: 0, r1: 26 * peak + 8, alpha: 0.9 * peak,
              squash: GROUND_SQUASH, seed: i, width: P * 3,
            });
        }
      }
      // Dust ring settling after the blast — the long dissolve.
      if (tailP > 0.1) {
        for (let i = 0; i < 10; i++) {
          const pa = (i / 10) * Math.PI * 2 + 0.3;
          const pr = spin.radius * (0.55 + tailP * 0.6);
          dustPuff(g, x + Math.cos(pa) * pr, groundY + Math.sin(pa) * pr * GROUND_SQUASH, {
            palette: pal, tone: 4, size: 16 + tailP * 14,
            alpha: 0.4 * (1 - tailP), lumps: 3, seed: i * 3, squash: 0.6,
          });
        }
      }
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

  /**
   * A knighting, not a ring. The floor takes a struck seal ringed with runes, a
   * faceted pillar of light stands up behind the Knight, two wings of light open
   * at his shoulders on the invocation, and a crown of eight blades hangs above
   * his head for as long as the blessing lasts.
   */
  #drawValorAura(g, back, air, aura) {
    const { hero } = aura;
    const pal = VALOR_PALETTE;
    const x = snap(hero.x);
    const y = snap(hero.y);
    const h = hero.spriteHeight;
    const chestY = snap(y - h * 0.5);
    const headY = snap(y - h * 1.02);
    const pulse = 0.5 + 0.5 * Math.sin(aura.age * 3.4);
    const introP = Phaser.Math.Clamp(aura.age / aura.intro, 0, 1);
    const introPower = 1 - introP;
    const open = Phaser.Math.Clamp(introP * 1.8, 0, 1);

    // ── the struck seal ───────────────────────────────────────────────────
    g.clear();
    const sealR = 30 + open * 24;
    g.fillStyle(shade(pal, 6), 0.12 + pulse * 0.04);
    pxDisc(g, x, y + 2, sealR * 0.86, sealR * 0.86 * GROUND_SQUASH, { every: 3 });
    groundBand(g, x, y + 2, sealR, {
      palette: pal, tone: 3, thickness: P * 3,
      alpha: 0.6 + pulse * 0.18, bite: 1.1, seed: 4,
    });
    groundBand(g, x, y + 2, sealR * 0.58, {
      palette: pal, tone: 2, thickness: P * 2,
      alpha: 0.45 + pulse * 0.14, bite: 0.7, seed: 11,
    });
    // Eight runes ride the seal, turning slowly — writing, not a dashed line.
    const runeSpin = aura.age * 0.55;
    for (let i = 0; i < 8; i++) {
      const a = runeSpin + (i / 8) * Math.PI * 2;
      runeGlyph(g,
        x + Math.cos(a) * sealR * 0.79,
        y + 2 + Math.sin(a) * sealR * 0.79 * GROUND_SQUASH, {
          palette: pal, tone: 1, size: 7 + (i % 2) * 2,
          alpha: (0.5 + pulse * 0.35) * open, variant: i % 6,
        });
    }
    // The invocation cracks the flagstones outward once, and they stay cracked.
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      groundCrack(g, x + Math.cos(a) * sealR * 0.3, y + 2 + Math.sin(a) * sealR * 0.3 * GROUND_SQUASH, {
        palette: pal, tone: 5, angle: a, length: sealR * (0.7 + (i % 3) * 0.2),
        alpha: 0.3 + introPower * 0.3, reveal: open, seed: i * 6 + 1,
        branches: 1, width: P * 2,
      });
    }

    back.clear();
    air.clear();

    // ── the pillar ────────────────────────────────────────────────────────
    // Full and faceted while the blessing lands, then held as a thin banded
    // shaft so the permanent buff never stops being visible.
    const rise = Phaser.Math.Clamp(aura.age / (aura.intro * 0.55), 0, 1);
    pillarForm(back, x, y + 2, {
      palette: pal, tone: 1,
      height: h + 74, width: 6 + introPower * 18,
      alpha: 0.16 + introPower * 0.62, grow: rise,
      facets: 4, flare: 2.1, taper: 0.5,
      bandEvery: 7, bandPhase: Math.floor(aura.age * 12),
      topFade: 0.46, dissolve: 0.55, seed: 3,
    });

    // ── wings of light, only during the invocation ────────────────────────
    // Five pinions a side, longest through the middle, swept from up-and-out
    // to down-and-out so the pair reads as a spread wing rather than a fan of
    // spikes. Tones stay in the bright half of the ramp — these are light.
    if (introPower > 0.02) {
      const wingSpan = 30 + introP * 54;
      for (const s of [-1, 1]) {
        for (let f = 0; f < 5; f++) {
          const q = f / 4;
          const bell = Math.sin(Math.PI * (0.24 + q * 0.62));
          const out = -0.95 + q * 1.24;
          solidWedge(air, x + s * P * 3, chestY - P * 4 + f * P * 3, {
            palette: pal, tone: f === 0 || f === 4 ? 4 : 3,
            angle: s > 0 ? out : Math.PI - out,
            r0: P * 2, r1: wingSpan * (0.62 + bell * 0.5),
            w0: P * 5, w1: P, alpha: introPower * (0.95 - q * 0.15),
            taper: 1.6, seed: f * 3 + (s > 0 ? 0 : 7),
          });
        }
        // A shoulder coverts block ties the pinions back to the body.
        solidWedge(air, x + s * P, chestY - P, {
          palette: pal, tone: 3,
          angle: s > 0 ? -0.35 : Math.PI + 0.35,
          r0: 0, r1: wingSpan * 0.34, w0: P * 8, w1: P * 3,
          alpha: introPower * 0.75, taper: 1.2, seed: s > 0 ? 21 : 22,
        });
      }
    }

    // ── the crown: eight blades hanging over the head ────────────────────
    const crownR = 15 + open * 7;
    const crownSpin = aura.age * 1.15;
    for (let i = 0; i < 8; i++) {
      const a = crownSpin + (i / 8) * Math.PI * 2;
      const tall = i % 2 === 0;
      solidWedge(air, x + Math.cos(a) * crownR, headY + Math.sin(a) * crownR * 0.4, {
        palette: pal, tone: tall ? 1 : 3,
        angle: -Math.PI / 2, r0: 0, r1: (tall ? 15 : 9) * open,
        w0: P * 3, w1: P, alpha: (0.55 + pulse * 0.4) * open,
        taper: 1.5, seed: i,
      });
    }
    solidArcBand(air, x, headY, {
      palette: pal, tone: 2, from: 0, to: Math.PI * 2,
      r: crownR, thickness: P * 2, alpha: (0.5 + pulse * 0.3) * open,
      squash: 0.4, taperEnds: 0, glint: false, seed: 17,
    });

    // ── body halos: solid bands, split around the Knight ─────────────────
    const haloSpecs = [
      { y: 0.72, r: 37, speed: 9 },
      { y: 0.48, r: 45, speed: -7 },
      { y: 0.25, r: 34, speed: 12 },
    ];
    for (let i = 0; i < haloSpecs.length; i++) {
      const spec = haloSpecs[i];
      const ringY = snap(y - h * spec.y + (1 - open) * 24);
      const r = spec.r * (0.55 + open * 0.45) * (0.96 + pulse * 0.06);
      const alpha = (0.62 + pulse * 0.22) * (0.55 + open * 0.45);
      const sq = 0.22 + i * 0.03;
      const off = aura.age * spec.speed * 0.14;
      solidArcBand(back, x, ringY, {
        palette: pal, tone: 4, from: Math.PI + off, to: Math.PI * 2 + off,
        r, thickness: P * 2, alpha: alpha * 0.66, squash: sq,
        taperEnds: 0.4, glint: false, seed: i * 4 + 2,
      });
      solidArcBand(air, x, ringY, {
        palette: pal, tone: 2 + (i % 2), from: off, to: Math.PI + off,
        r, thickness: P * (3 - (i % 2)), alpha, squash: sq,
        taperEnds: 0.4, seed: i * 4 + 5,
      });
    }

    // A held glow on the body so the tinted silhouette has something to sit in.
    air.fillStyle(shade(pal, 2), 0.06 + pulse * 0.045);
    pxDisc(air, x, chestY, 22 + pulse * 3, h * 0.48, { every: 4 });

    // ── embers, with weight ──────────────────────────────────────────────
    const emberCount = introPower > 0 ? 20 : 12;
    for (let i = 0; i < emberCount; i++) {
      const seed = ((i * 29) % 71) / 70;
      const ph = (aura.age * (0.4 + (i % 4) * 0.05) + seed) % 1;
      const spread = 12 + (i % 5) * 6 + introPower * 14;
      const drift = Math.sin(aura.age * (1.1 + (i % 3) * 0.25) + i * 2.17);
      debrisChunk(air,
        snap(x + drift * spread),
        snap(y - 3 - ph * (h + 34)), {
          palette: pal, tone: 1 + (i % 4),
          size: P * (1 + (i % 3)) * (1 - ph * 0.4),
          alpha: (1 - ph * 0.78) * (0.55 + (i % 4) * 0.11),
          seed: i * 3, squash: 0.9, spin: Math.floor(aura.age * 10 + i),
        });
    }
  }

  // ── Shield Bash: a forged shield wall ploughing down the cone ─────────────
  #startShieldBash(hero, facing, eff) {
    const y = hero.y - hero.spriteHeight * 0.45;
    this.shieldBashes.push({
      x: hero.x,
      y,
      groundY: hero.y + 2,
      dir: facing,
      radius: eff.radius,
      // The floor wake is drawn inside the warned cone, so it needs its width.
      half: Phaser.Math.DegToRad(eff.arc ?? 75) / 2,
      travel: eff.waveTravel ?? 0.34,
      life: eff.waveLife ?? 0.68,
      crestScale: eff.crestScale ?? 1,
      age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      // Two layers: the stone the wall has already ploughed through, and the
      // wall itself passing in front of everything it is about to hit.
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphGround),
      gfxAir: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
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
      const air = bash.gfxAir;
      const pal = SHIELD_BASH_PALETTE;
      g.clear();
      air.clear();

      const headX = bash.x + bash.dir * (16 + bash.radius * travelP);
      const rootX = bash.x + bash.dir * 14;

      // ── the floor the wall has already been driven through ────────────────
      // Ridges of displaced stone left inside the warned cone, then real
      // fractures opening from the Knight's feet as the crest passes over them.
      const wake = Math.max(P, bash.radius * travelP);
      const arcMid = bash.dir > 0 ? 0 : Math.PI;
      for (let i = 0; i < 4; i++) {
        const q = (i + 1) / 4;
        groundBand(g, rootX, bash.groundY, wake * q, {
          palette: pal, tone: 3 + (i % 2),
          thickness: P * (3 - (i % 2)),
          alpha: (0.16 + q * 0.3) * fade,
          bite: 1.5, seed: i * 7 + 1,
          arcFrom: arcMid - bash.half * (0.55 + q * 0.45),
          arcTo: arcMid + bash.half * (0.55 + q * 0.45),
        });
      }

      for (let i = 0; i < 7; i++) {
        const q = (i + 0.5) / 7;
        const a = (q - 0.5) * bash.half * 1.85;
        groundCrack(g, rootX, bash.groundY, {
          palette: pal,
          tone: 3,
          angle: bash.dir > 0 ? a : Math.PI - a,
          length: bash.radius * (0.6 + (i % 3) * 0.17),
          alpha: 0.55 * fade,
          reveal: Phaser.Math.Clamp(travelP * 1.3 - q * 0.12, 0, 1),
          seed: i * 5 + 1,
          branches: 1,
          width: P * 2,
        });
      }

      // Dust rolls off the trailing edge and settles; chips are thrown ahead of
      // the rim, so the wall visibly displaces the room rather than passing it.
      for (let i = 0; i < 6; i++) {
        const back = travelP - (i + 1) * 0.055;
        if (back <= 0) continue;
        const bx = bash.x + bash.dir * (16 + bash.radius * back);
        const side = (i % 2 ? 1 : -1) * (9 + i * 5);
        dustPuff(g, bx - bash.dir * 4, bash.groundY + 2 + side * 0.32, {
          palette: pal, tone: 4, size: 13 + i * 3,
          alpha: 0.34 * fade * (1 - i / 7), lumps: 3, seed: i * 3 + 2, squash: 0.6,
        });
      }
      for (let i = 0; i < 8; i++) {
        const a = (((i + 0.5) / 8) - 0.5) * bash.half * 1.6;
        const fly = 12 + ((i * 37) % 30) + travelP * 26;
        debrisChunk(g,
          headX + bash.dir * Math.cos(a) * fly,
          bash.groundY + Math.sin(a) * fly * GROUND_SQUASH - travelP * (6 + (i % 4) * 4), {
            palette: pal, tone: 3 + (i % 2), size: P * (2 + (i % 3)),
            alpha: (0.5 + (i % 3) * 0.15) * fade, seed: i * 7, spin: Math.floor(bash.age * 30),
          });
      }

      // ── the wall itself: oldest echo first, live crest last ──────────────
      for (let echo = 3; echo >= 0; echo--) {
        const ep = Math.max(0, travelP - echo * 0.135);
        if (echo > 0 && ep <= 0) continue;
        const x = snap(bash.x + bash.dir * (16 + bash.radius * ep));
        const y = snap(bash.y + Math.sin(bash.phase + ep * 7) * P);
        const alpha = fade * (echo === 0 ? 1 : 0.12 + (3 - echo) * 0.1);
        const width = (34 + ep * 15 - echo * 2) * bash.crestScale;
        const height = (44 + ep * 13 - echo * 3) * bash.crestScale;
        this.#drawShieldCrest(air, x, y, bash.dir, width, height, alpha, echo === 0, bash.age);
      }

      // A thin compression front runs a few pixels ahead of the live rim.
      solidArcBand(air, headX - bash.dir * 6, bash.y, {
        palette: pal, tone: 0,
        from: bash.dir > 0 ? -1.15 : Math.PI - 1.15,
        to: bash.dir > 0 ? 1.15 : Math.PI + 1.15,
        r: 34 * bash.crestScale, thickness: P * 2,
        alpha: 0.7 * fade * (1 - travelP * 0.4), squash: 0.86,
        taperEnds: 0.45, seed: 9,
      });

      if (bash.age < bash.life) continue;
      g.destroy();
      air.destroy();
      this.shieldBashes = this.shieldBashes.filter((b) => b !== bash);
    }
  }

  /**
   * A shield with body: a heater-shield plate — flat across the top, bowed on
   * the leading edge, tapering to a point at the bottom — with a bright leading
   * rim of studs, a domed boss and a forward spike, struck runes, and swept fins
   * at the rear. Solid enough to read as forged metal at 1x.
   */
  #drawShieldCrest(g, cx, cy, dir, width, height, alpha, bright, age) {
    const pal = SHIELD_BASH_PALETTE;
    const rows = Math.max(3, Math.round(height / (P * 2)));
    const base = bright ? 2 : 4;
    const edges = [];

    for (let row = -rows; row <= rows; row++) {
      const t = (row + rows) / (rows * 2); // 0 = top of the plate
      // flat top with a rounded corner, straight sides, point at the bottom
      const cap = t < 0.1 ? Math.sqrt(Math.max(0, 1 - ((0.1 - t) / 0.1) ** 2)) : 1;
      const tip = t > 0.58 ? Math.max(0, 1 - ((t - 0.58) / 0.42) ** 1.5) : 1;
      const prof = cap * tip;
      if (prof <= 0.02) continue;
      const front = cx + dir * width * (0.1 + prof * 0.5);
      const back = cx - dir * width * 0.26 * Math.max(0.25, prof);
      const left = snap(Math.min(front, back));
      const right = snap(Math.max(front, back));
      const y = snap(cy + row * P);
      const lead = dir > 0 ? right - P : left;
      const trail = dir > 0 ? left : right - P;

      // body, shaded top-lit: the upper half of the plate catches the torch
      g.fillStyle(shade(pal, base + (t > 0.5 ? 1 : 0)), alpha * (0.62 + prof * 0.3));
      g.fillRect(left, y, Math.max(P, right - left), P);
      // two-block leading rim so the bow reads as a raised edge
      g.fillStyle(shade(pal, base - 2), alpha);
      g.fillRect(lead, y, P, P);
      g.fillStyle(shade(pal, base - 1), alpha * 0.9);
      g.fillRect(lead - dir * P, y, P, P);
      g.fillStyle(shade(pal, base + 2), alpha * 0.9);
      g.fillRect(trail, y, P, P);
      edges.push([lead, y]);
    }

    // studs riveted along the leading rim
    g.fillStyle(shade(pal, bright ? 0 : 2), alpha);
    for (let i = 1; i < edges.length; i += 3) {
      g.fillRect(edges[i][0] + dir * P, edges[i][1], P, P);
    }

    // domed boss: lit crown, thin shadow crescent, forward spike
    const bx = snap(cx + dir * width * 0.08);
    const bossR = Math.max(P * 2, width * 0.2);
    g.fillStyle(shade(pal, base + 2), alpha);
    pxDisc(g, snap(bx + P), snap(cy + P), bossR, bossR * 0.92);
    g.fillStyle(shade(pal, base - 1), alpha);
    pxDisc(g, bx, snap(cy), bossR * 0.86, bossR * 0.78);
    g.fillStyle(shade(pal, base - 3), alpha);
    pxDisc(g, snap(bx - P), snap(cy - P * 2), bossR * 0.4, bossR * 0.3);
    solidWedge(g, bx, cy, {
      palette: pal, tone: base - 2, angle: dir > 0 ? 0 : Math.PI,
      r0: bossR * 0.5, r1: bossR * 0.5 + width * 0.3,
      w0: P * 5, w1: P, alpha, taper: 1.5, notch: false, seed: 6,
    });

    // two struck runes, pulsing with the cast
    const glow = alpha * (0.62 + 0.38 * Math.sin(age * 18));
    for (const s of [-1, 1]) {
      runeGlyph(g, bx, cy + s * height * 0.28, {
        palette: pal, tone: bright ? 0 : 2, size: width * 0.16,
        alpha: glow, variant: s < 0 ? 3 : 5,
      });
    }

    // swept rear fins: the wall is being driven, and the drive shows
    for (let fin = -2; fin <= 2; fin++) {
      solidWedge(g, cx - dir * width * 0.24, cy + fin * height * 0.26, {
        palette: pal, tone: base + 2,
        angle: (dir > 0 ? Math.PI : 0) + fin * 0.26 * dir,
        r0: 0, r1: width * (0.26 + (Math.abs(fin) % 2) * 0.14),
        w0: P * 4, w1: P, alpha: alpha * (0.7 - Math.abs(fin) * 0.11),
        taper: 1.4, glint: false, seed: fin + 4,
      });
    }
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

      const pal = NOVA_ICE_PALETTE;
      const punch = Math.max(0, 1 - nova.age / 0.16);

      // ── the floor freezes over, then splits ──────────────────────────────
      // A sheet of rime is laid down inside the wave, dithered so the edge
      // dissolves into bare stone instead of ending on a hard circle.
      g.fillStyle(shade(pal, 7), (0.16 + travel * 0.14) * fade);
      pxDisc(g, x, y, r * 0.97, r * 0.97 * GROUND_SQUASH, { every: 3 });
      g.fillStyle(shade(pal, 5), (0.12 + punch * 0.2) * fade);
      pxDisc(g, x, y, r * 0.6, r * 0.6 * GROUND_SQUASH, { every: 4 });
      g.fillStyle(shade(pal, 1), (0.34 + punch * 0.5) * fade);
      pxDisc(g, x, y, r * (0.1 + punch * 0.16), r * (0.1 + punch * 0.16) * GROUND_SQUASH);

      // The advancing wall of frost, and the settled ridge left behind it. A
      // deep rim on the outside keeps the wall from bleeding into bare stone.
      groundBand(g, x, y, r + P * 2, {
        palette: pal, tone: 8, thickness: P * 2,
        alpha: 0.5 * fade, bite: 1.4, seed: 15, glint: false,
      });
      groundBand(g, x, y, r, {
        palette: pal, tone: 1, thickness: P * (2 + Math.round(fade * 3)),
        alpha: (0.7 + punch * 0.3) * fade, bite: 1.2, seed: 3,
      });
      groundBand(g, x, y, r * 0.66, {
        palette: pal, tone: 5, thickness: P * 2,
        alpha: 0.5 * fade, bite: 1.7, seed: 9,
      });

      // Fractures spread with the wave and stay open in the ice behind it.
      for (let i = 0; i < 16; i++) {
        const a = nova.phase * 0.18 + (i / 16) * Math.PI * 2;
        groundCrack(g, x + Math.cos(a) * r * 0.12, y + Math.sin(a) * r * 0.12 * GROUND_SQUASH, {
          palette: pal, tone: 6, angle: a,
          length: nova.r * (0.6 + (i % 5) * 0.09),
          alpha: 0.62 * fade, reveal: Math.min(1, travel * 1.15),
          seed: i * 4 + 1, branches: 2, width: P * 2,
        });
      }

      // Ground fog clinging to the rime just inside the rim.
      for (let i = 0; i < 8; i++) {
        const a = nova.phase + (i / 8) * Math.PI * 2 + nova.age * 0.6;
        dustPuff(g, x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8 * GROUND_SQUASH, {
          palette: pal, tone: 3, size: 15 + travel * 12,
          alpha: 0.24 * fade, lumps: 3, seed: i * 5 + 2, squash: 0.55,
        });
      }

      // ── the eruption ─────────────────────────────────────────────────────
      // A cluster bursts out of the caster's feet on frame one, then a ring of
      // real crystals tears up out of the floor as the wave reaches each radius.
      for (let i = 0; i < 6; i++) {
        const a = nova.phase + (i / 6) * Math.PI * 2;
        const core = Math.min(1, nova.age / 0.1);
        // Spread far enough apart that six spikes read as six spikes; the dark
        // block at each foot keeps them off the bright rime behind them.
        const cd = 15 + (i % 3) * 5;
        air.fillStyle(shade(pal, 8), fade * 0.6);
        air.fillRect(snap(x + Math.cos(a) * cd - P * 2), snap(y + Math.sin(a) * cd * 0.6 + 2), P * 4, P * 2);
        this.#drawLanceCrystal(air,
          snap(x + Math.cos(a) * cd), snap(y + Math.sin(a) * cd * 0.6 + 2), {
            height: 34 + (i % 3) * 16, width: 12 + (i % 2) * 6,
            grow: core * (0.6 + fade * 0.4), alpha: fade * 0.95,
            tone: 2 + (i % 4), lean: Math.cos(a) * 12,
          });
      }
      const rimCount = 22;
      for (let i = 0; i < rimCount; i++) {
        const a = (i / rimCount) * Math.PI * 2 + nova.phase * 0.1;
        const q = ((i * 9) % rimCount) / (rimCount - 1);
        // Weighted outward: crystals belong at the wave front, where they
        // silhouette against bare stone instead of against their own rime.
        const at = 0.46 + q * 0.56;
        const grow = Phaser.Math.Clamp((travel - at * 0.82) * 5, 0, 1);
        if (grow <= 0) continue;
        const rr = nova.r * at;
        const bx = snap(x + Math.cos(a) * rr);
        const by = snap(y + Math.sin(a) * rr * GROUND_SQUASH + 2);
        air.fillStyle(shade(pal, 8), fade * grow * 0.55);
        air.fillRect(bx - P * 2, by, P * 4, P * 2);
        this.#drawLanceCrystal(air, bx, by, {
          height: 26 + (i % 4) * 11 + (1 - at) * 14, width: 10 + (i % 3) * 4,
          grow: grow * (0.55 + fade * 0.45), alpha: fade * (0.7 + grow * 0.3),
          tone: 2 + (i % 4), lean: Math.cos(a) * 7,
        });
      }

      // The cold front standing over the rim: bright on the near face, dim
      // where it wraps behind, so the wave has a front and a back.
      solidArcBand(air, x, y - 6, {
        palette: pal, tone: 1, from: 0, to: Math.PI,
        r, thickness: P * (2 + Math.round(fade * 2)),
        alpha: 0.72 * fade, squash: GROUND_SQUASH * 1.1, taperEnds: 0, seed: 5,
      });
      solidArcBand(g, x, y - 6, {
        palette: pal, tone: 4, from: Math.PI, to: Math.PI * 2,
        r, thickness: P * 2, alpha: 0.4 * fade,
        squash: GROUND_SQUASH * 1.1, taperEnds: 0, glint: false, seed: 6,
      });

      // Shrapnel thrown outward on the break, then rime drifting up off the ice.
      if (punch > 0.02) {
        for (let i = 0; i < 12; i++) {
          const a = nova.phase * 0.5 + (i / 12) * Math.PI * 2;
          shardFan(air, x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9 * GROUND_SQUASH, {
            palette: pal, tone: 1 + (i % 3), angle: a, spread: 0.5, count: 3,
            r0: 0, r1: 12 + punch * 26, alpha: punch * 0.9,
            squash: GROUND_SQUASH, seed: i * 3, width: P * 3,
          });
        }
      }
      for (let i = 0; i < 18; i++) {
        const a = nova.phase + i * 2.4 + nova.age * (2.5 + (i % 3) * 0.7);
        const q = (i % 6) / 5;
        const orbit = r * (0.24 + q * 0.7);
        debrisChunk(air,
          snap(x + Math.cos(a) * orbit),
          snap(y + Math.sin(a) * orbit * GROUND_SQUASH - 6 - q * 34 - travel * 12), {
            palette: pal, tone: 1 + (i % 4), size: P * (1 + (i % 3)),
            alpha: (0.4 + q * 0.4) * fade, seed: i * 7, squash: 0.9,
            spin: Math.floor(nova.age * 12 + i),
          });
      }
      for (let i = 0; i < 5; i++) {
        const a = nova.phase * 1.3 + (i / 5) * Math.PI * 2;
        dustPuff(air, x + Math.cos(a) * r * 0.45, y + Math.sin(a) * r * 0.3 - 18 - i * 5, {
          palette: pal, tone: 2, size: 12 + i * 3 + travel * 10,
          alpha: 0.2 * fade, lumps: 3, seed: i * 9 + 4, squash: 0.8,
        });
      }

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
      // The torn veil and the hooded echoes belong behind the fighters; only
      // the shards thrown off the tear sit in front of them.
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.ghost),
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
      const back = dash.gfxBack;
      g.clear();
      back.clear();
      const pal = NIGHTVEIL_PALETTE;
      const fade = 1 - p * 0.48;
      const chest = hero.spriteHeight * 0.5;
      const facing = Math.cos(dash.angle) >= 0 ? 1 : -1;
      const nx = -Math.sin(dash.angle);
      const ny = Math.cos(dash.angle);
      const sx = snap(dash.startX);
      const sy = snap(dash.startY - chest);
      const hx = snap(hero.x - Math.cos(dash.angle) * 12);
      const hy = snap(hero.y - chest - Math.sin(dash.angle) * 12);

      // ── the torn veil: a ribbon of shadow dragged along the path ─────────
      // Widest at the departure point, where the archer's outline is still
      // unravelling, narrowing to a point at their heels.
      const segs = 6;
      for (let i = 0; i < segs; i++) {
        const q0 = i / segs;
        const q1 = (i + 1) / segs;
        const ax = sx + (hx - sx) * q0;
        const ay = sy + (hy - sy) * q0;
        const bx = sx + (hx - sx) * q1;
        const by = sy + (hy - sy) * q1;
        const a = Math.atan2(by - ay, bx - ax);
        const seglen = Math.hypot(bx - ax, by - ay) + P;
        solidWedge(back, ax, ay, {
          palette: pal, tone: 5, angle: a, r0: 0, r1: seglen,
          w0: P * (13 - q0 * 8), w1: P * (13 - q1 * 8),
          alpha: fade * (0.7 - q1 * 0.26), taper: 1, notch: true, seed: i * 3,
        });
        for (const s of [-1, 1]) {
          const off = P * (6 - q1 * 3.5) * s;
          solidWedge(back, ax + nx * off, ay + ny * off, {
            palette: pal, tone: 1 + (i % 2), angle: a, r0: 0, r1: seglen,
            w0: P, w1: P * 2, alpha: fade * (0.72 - q1 * 0.34),
            taper: 1, notch: false, seed: i + (s > 0 ? 13 : 19),
          });
        }
      }

      // ── four hooded echoes strung along it, each further gone ────────────
      for (let echo = 1; echo <= 4; echo++) {
        const q = Math.max(0, eased - echo * 0.13);
        if (q <= 0.001) continue;
        figureForm(back, snap(Phaser.Math.Linear(dash.startX, dash.endX, q)),
          snap(Phaser.Math.Linear(dash.startY, dash.endY, q)), {
            palette: pal, tone: 3 + (echo % 2), height: hero.spriteHeight * 0.96,
            alpha: fade * (0.68 - echo * 0.12), facing, lean: -facing * 5,
            cloak: 1, rimTone: 1,
          });
      }

      // ── the tear left behind at the departure point ──────────────────────
      const tear = Math.max(0, 1 - p / 0.7);
      if (tear > 0.02) {
        crescentForm(g, sx, sy, {
          palette: pal, tone: 2, r: 20 + (1 - tear) * 24, bite: 0.5,
          angle: dash.angle + Math.PI, alpha: tear * 0.8, squash: 0.9, rim: true,
        });
        shardFan(g, sx, sy, {
          palette: pal, tone: 1, angle: dash.angle + Math.PI, spread: 2.3,
          count: 7, r0: 8, r1: 24 + (1 - tear) * 30, alpha: tear * 0.85,
          squash: 0.85, width: P * 2, seed: dash.phase,
        });
      }
      // Shreds of the veil torn loose and left hanging over the path.
      for (let i = 0; i < 9; i++) {
        const q = (i + 1) / 10;
        const drift = Math.sin(dash.phase + i * 2.17) * 15;
        debrisChunk(g, snap(sx + (hx - sx) * q + nx * drift),
          snap(sy + (hy - sy) * q + ny * drift - (i % 4) * P * 3), {
            palette: pal, tone: 1 + (i % 4), size: 4 + (i % 3) * 2,
            alpha: (0.7 - q * 0.35) * fade, seed: i * 4, spin: i,
          });
      }
      // The arrival: shadow gathering back into a body, behind it so the
      // archer's own silhouette stays clean.
      if (p > 0.55) {
        const land = (p - 0.55) / 0.45;
        crescentForm(back, snap(hero.x), snap(hero.y - chest), {
          palette: pal, tone: 1, r: 32 - land * 12, bite: 0.62,
          angle: dash.angle, alpha: (1 - land) * 0.62, squash: 0.9, rim: true,
        });
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
      back.destroy();
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
      // Acid splats stay on the stone under the monsters they land around.
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.floorDecal),
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
      const back = shot.gfxBack;
      g.clear();
      back.clear();
      const pal = VENOM_PALETTE;
      shot.arrows = shot.arrows.filter((arrow) => shot.age - arrow.bornAt < shot.arrowLife);
      // Each fang falls toward its own random impact point inside the warning
      // zone, then bursts: the shaft is a solid arrow with a curved fang for a
      // head, and where it lands it leaves acid eating into the stone.
      for (const arrow of shot.arrows) {
        const p = Phaser.Math.Clamp((shot.age - arrow.bornAt) / shot.arrowLife, 0, 1);
        const fade = p < 0.72 ? 1 : Math.max(0, 1 - (p - 0.72) / 0.28);
        const travel = 1 - (1 - p) ** 3;
        const cx = snap(Phaser.Math.Linear(arrow.startX, arrow.endX, travel));
        const cy = snap(Phaser.Math.Linear(arrow.startY, arrow.endY, travel));
        const land = Phaser.Math.Clamp((p - 0.5) / 0.5, 0, 1);
        const flight = 1 - land;

        // ── the splat, growing under the impact point ──────────────────────
        if (land > 0) {
          const ex = snap(arrow.endX);
          const ey = snap(arrow.endY + 2);
          const rr = (13 + land * 17) * (1 - land * 0.12);
          back.fillStyle(shade(pal, 3), fade * land * 0.5);
          pxDisc(back, ex, ey, rr, rr * GROUND_SQUASH, { every: 2 });
          back.fillStyle(shade(pal, 1), fade * land * 0.4);
          pxDisc(back, ex, ey, rr * 0.44, rr * 0.44 * GROUND_SQUASH);
          groundBand(back, ex, ey, rr, {
            palette: pal, tone: 2, thickness: P * 2, alpha: fade * land * 0.75,
            bite: 1.7, seed: Math.round(arrow.startX), glint: false,
          });
          // Droplets thrown back out of the puddle, and the vapour off it.
          shardFan(g, ex, ey - 2, {
            palette: pal, tone: 1, angle: -Math.PI / 2, spread: 2.7, count: 6,
            r0: 4, r1: 8 + land * 20, alpha: fade * (1 - land) * 0.95,
            squash: 0.75, width: P * 2, seed: arrow.startY,
          });
          dustPuff(g, ex, ey - 6 - land * 12, {
            palette: pal, tone: 2, size: 12 + land * 16, alpha: fade * (0.5 - land * 0.34),
            lumps: 3, seed: arrow.startX, squash: 0.8,
          });
        }

        // ── the fang still in the air ──────────────────────────────────────
        if (flight > 0.02) {
          arrowForm(g, cx, cy, {
            palette: pal, tone: 2, angle: arrow.angle, length: 24 + flight * 10,
            alpha: fade * Math.min(1, flight * 3), head: 9, fletch: true, spark: true,
          });
          // A curved fang for a head — this is Venom Fang, not a plain arrow.
          fangForm(g, snap(cx - Math.cos(arrow.angle) * 12), snap(cy - Math.sin(arrow.angle) * 12), {
            palette: pal, tone: 1, angle: arrow.angle, length: 14, width: 8,
            curve: 0.4, alpha: fade * Math.min(1, flight * 3), grow: 1,
          });
          // Venom shaken off the shaft on the way down.
          for (let i = 0; i < 4; i++) {
            const tail = 26 + i * 13;
            debrisChunk(g, snap(cx - Math.cos(arrow.angle) * tail
              + Math.sin(arrow.angle + i * 2.1) * P * 3),
            snap(cy - Math.sin(arrow.angle) * tail + Math.cos(arrow.angle + i * 2.1) * P * 3), {
              palette: pal, tone: 1 + (i % 3), size: 4 - (i % 2),
              alpha: fade * flight * (0.7 - i * 0.13), seed: i * 5, spin: i,
            });
          }
        }
      }

      if (shot.fired < shot.count || shot.arrows.length) continue;
      this.scene.fx.impact({ color: VENOM_PALETTE[2], shake: 0.012, flash: 0.24, stop: 75 });
      this.#report(shot.skill, shot.hitSet.size);
      g.destroy();
      back.destroy();
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
        const pal = VENOM_PALETTE;
        const baseY = target.y - 4;
        const h = target.spriteHeight;
        // Three columns of vapour boiling off the body, plus fat droplets of
        // venom running down it. The tick beat brightens the whole thing.
        const beat = Math.max(0, 1 - (poison.every - poison.tick) / 0.22);
        for (let i = 0; i < 3; i++) {
          const ph = (poison.age * (0.62 + i * 0.11) + i / 3) % 1;
          dustPuff(g, snap(target.x + Math.sin(poison.phase + i * 2.27) * (7 + i * 4)),
            snap(baseY - ph * h * 0.85), {
              palette: pal, tone: 1 + (i % 2), size: 7 + ph * 7,
              alpha: (1 - ph) * (0.34 + beat * 0.22), lumps: 3,
              seed: poison.phase + i * 3.1, squash: 0.85,
            });
        }
        for (let i = 0; i < 5; i++) {
          const ph = (poison.age * (0.9 + (i % 3) * 0.2) + i / 5) % 1;
          debrisChunk(g, snap(target.x + Math.sin(poison.phase * 1.4 + i * 1.9) * (h * 0.2)),
            snap(target.y - h * 0.78 + ph * h * 0.7), {
              palette: pal, tone: 1 + (i % 3), size: 3 + (i % 2) * 2,
              alpha: (1 - ph * 0.6) * (0.55 + beat * 0.35), seed: i * 4, spin: i,
            });
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
      const pal = NIGHTVEIL_PALETTE;
      const gy = trap.y + 5;

      // ── the pit: a shaft going down, with a binding circle written round it ─
      g.fillStyle(shade(pal, 7), (0.44 + pulse * 0.12) * fade);
      pxDisc(g, trap.x, gy, r, r * GROUND_SQUASH, { every: 1 });
      g.fillStyle(shade(pal, 6), (0.6 + pulse * 0.16) * fade);
      pxDisc(g, trap.x, gy, r * 0.66, r * 0.66 * GROUND_SQUASH, { every: 2 });
      // The far lip catches the glow from below, which is what makes the black
      // read as a hole rather than a disc lying on the stone.
      crescentForm(g, snap(trap.x), snap(gy - r * 0.2 * GROUND_SQUASH), {
        palette: pal, tone: 3, r: r * 0.52, bite: 0.68, angle: -Math.PI / 2,
        alpha: (0.5 + pulse * 0.2) * fade, squash: GROUND_SQUASH * 1.1, rim: true,
      });
      g.fillStyle(shade(pal, 3), (0.5 + pulse * 0.3) * fade);
      pxDisc(g, trap.x, gy, r * (0.2 + pulse * 0.06), r * (0.2 + pulse * 0.06) * GROUND_SQUASH);
      g.fillStyle(shade(pal, 1), (0.35 + pulse * 0.4) * fade);
      pxDisc(g, trap.x, gy, r * 0.09, r * 0.09 * GROUND_SQUASH);
      for (let ring = 0; ring < 2; ring++) {
        groundBand(g, trap.x, gy, r * (1 - ring * 0.38), {
          palette: pal, tone: ring ? 1 : 3, thickness: P * (3 - ring),
          alpha: (0.85 - ring * 0.2) * fade, bite: 1.2 + ring * 0.8,
          seed: ring * 6 + Math.floor(trap.age * 4), glint: ring === 0,
        });
      }
      // Ten sigils turning on the rim: this is a bound circle, not a hole.
      for (let i = 0; i < 10; i++) {
        const a = trap.phase + (i / 10) * Math.PI * 2 + trap.age * 0.6;
        runeGlyph(g, snap(trap.x + Math.cos(a) * r * 0.86),
          snap(gy + Math.sin(a) * r * 0.86 * GROUND_SQUASH), {
            palette: pal, tone: 1 + (i % 3), size: 8 + (i % 2) * 3,
            alpha: (0.45 + pulse * 0.45) * fade * open, variant: i,
          });
      }
      // Hooked stone teeth leaning inward over the lip.
      for (let i = 0; i < 10; i++) {
        const a = trap.phase * 1.3 + (i / 10) * Math.PI * 2;
        const outer = r * (0.92 + (i % 2) * 0.1);
        solidWedge(g, trap.x + Math.cos(a) * outer, gy + Math.sin(a) * outer * GROUND_SQUASH, {
          palette: pal, tone: 4 + (i % 2), angle: a + Math.PI,
          r0: 0, r1: r * (0.3 + (i % 3) * 0.07), w0: P * 5, w1: P,
          alpha: (0.72 + pulse * 0.2) * fade, squash: GROUND_SQUASH,
          taper: 1.5, notch: true, glint: i % 3 === 0, seed: i * 4,
        });
      }
      for (let i = 0; i < 7; i++) {
        const a = trap.phase + (i / 7) * Math.PI * 2;
        groundCrack(g, snap(trap.x + Math.cos(a) * r * 0.9),
          snap(gy + Math.sin(a) * r * 0.9 * GROUND_SQUASH), {
            palette: pal, tone: 3, angle: a, length: r * (0.32 + (i % 3) * 0.14),
            alpha: 0.6 * fade, reveal: open, seed: i * 5, branches: 2, width: P * 2,
          });
      }

      // ── six arms out of the pit, grasping on their own rhythm ────────────
      for (let hand = 0; hand < 6; hand++) {
        const a = trap.phase + hand * (Math.PI * 2 / 6) + Math.sin(trap.age * 2 + hand) * 0.08;
        const bx = snap(trap.x + Math.cos(a) * r * 0.62);
        const by = snap(gy + Math.sin(a) * r * 0.62 * GROUND_SQUASH);
        const grip = 0.5 + 0.5 * Math.sin(trap.age * 7 + hand * 1.7);
        const rise = (30 + grip * 16 + (hand % 2) * 8) * open;
        const sway = Math.sin(trap.age * 9 + hand * 1.8) * P * 2;
        const hx = snap(bx + sway);
        const hy = snap(by - rise);
        // the forearm, still half in the ground
        solidWedge(air, bx, by + P, {
          palette: pal, tone: 4, angle: Math.atan2(hy - by, hx - bx),
          r0: 0, r1: rise + P * 2, w0: P * 5, w1: P * 3,
          alpha: (0.76 + pulse * 0.18) * fade, taper: 1.1, notch: true, seed: hand * 3,
        });
        // A shadow behind the hand: it breaches over the bright seal, and two
        // pale silhouettes on top of each other read as one smear.
        air.fillStyle(shade(pal, 7), 0.6 * fade);
        pxDisc(air, hx, hy, snap(15 + grip * 4), snap(13 + grip * 3));
        clawHand(air, hx, hy, {
          palette: pal, tone: 3, angle: -Math.PI / 2 + Math.sin(a) * 0.5,
          size: 22 + grip * 6, alpha: (0.82 + pulse * 0.18) * fade,
          close: 0.22 + grip * 0.62, squash: 0.9,
        });
      }

      // Souls torn loose, spiralling up out of the seal.
      for (let mote = 0; mote < 14; mote++) {
        const q = ((mote * 5) % 14) / 13;
        const ma = trap.phase + mote * 2.27 + trap.age * (mote % 2 ? 0.55 : -0.4);
        const mr = r * (0.2 + q * 0.74);
        const lift = (trap.age * (18 + (mote % 5) * 6) + mote * 9) % 52;
        debrisChunk(air, snap(trap.x + Math.cos(ma) * mr),
          snap(gy + Math.sin(ma) * mr * GROUND_SQUASH - lift), {
            palette: pal, tone: 1 + (mote % 4), size: 3 + (mote % 3) * 2,
            alpha: (1 - lift / 52) * (0.5 + (mote % 3) * 0.16) * fade,
            seed: mote * 4, spin: mote,
          });
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
      const pal = NIGHTVEIL_PALETTE;
      const r = eclipse.radius * open;
      const gy = eclipse.y + 6;
      // How long since the last volley actually landed — every layer below
      // punches on this beat, so the seal breathes with the damage ticks
      // instead of on a decorative sine of its own.
      const beat = Math.max(0, 1 - (eclipse.age - (eclipse.nextWave - eclipse.interval)) / 0.2);
      const built = eclipse.wave / eclipse.waves;

      // ── the seal: a wide dark bowl the volleys are being funnelled into ───
      g.fillStyle(shade(pal, 7), (0.34 + beat * 0.14) * fade);
      pxDisc(g, eclipse.x, gy, r, r * GROUND_SQUASH, { every: 2 });
      g.fillStyle(shade(pal, 5), (0.24 + beat * 0.3) * fade);
      pxDisc(g, eclipse.x, gy, r * (0.4 + beat * 0.24), r * (0.4 + beat * 0.24) * GROUND_SQUASH, { every: 3 });
      for (let ring = 0; ring < 3; ring++) {
        groundBand(g, eclipse.x, gy, r * (1 - ring * 0.27), {
          palette: pal, tone: ring === 0 ? 2 : 3 + ring,
          thickness: P * (3 - ring * 0.5),
          alpha: (0.66 - ring * 0.14 + beat * 0.16) * fade,
          bite: 1 + ring * 0.7, seed: ring * 6 + eclipse.wave * 3,
          glint: false,
        });
      }
      // A ring of arrowheads driven into the stone, pointing inward: the seal
      // belongs to an archer, not to a generic circle of runes.
      for (let i = 0; i < 12; i++) {
        const a = eclipse.phase + (i / 12) * Math.PI * 2 + eclipse.age * 0.22;
        const outer = r * 0.93;
        solidWedge(g, eclipse.x + Math.cos(a) * outer, gy + Math.sin(a) * outer * GROUND_SQUASH, {
          palette: pal, tone: 3 + (i % 2), angle: a + Math.PI,
          r0: 0, r1: r * 0.19, w0: P * 5, w1: P,
          alpha: (0.62 + beat * 0.22) * fade, squash: GROUND_SQUASH,
          taper: 1.6, notch: true, seed: i * 5,
        });
        runeGlyph(g, snap(eclipse.x + Math.cos(a) * r * 0.66),
          snap(gy + Math.sin(a) * r * 0.66 * GROUND_SQUASH), {
            palette: pal, tone: 2 + (i % 2), size: 8 + (i % 2) * 3,
            alpha: (0.28 + beat * 0.4) * fade * open, variant: i + 3,
          });
      }
      // The floor loses more of itself with every volley that lands.
      for (let i = 0; i < 8; i++) {
        const a = eclipse.phase * 1.4 + (i / 8) * Math.PI * 2;
        groundCrack(g, snap(eclipse.x + Math.cos(a) * r * 0.3),
          snap(gy + Math.sin(a) * r * 0.3 * GROUND_SQUASH), {
            palette: pal, tone: 4, angle: a, length: r * 0.72,
            alpha: 0.6 * fade, reveal: Math.min(1, built * 1.2),
            seed: i * 7, branches: 3, width: P * 2,
          });
      }

      // ── the eclipse: a black sun with a corona, hanging over the seal ─────
      const moonY = eclipse.y - 116;
      const moonR = 30 + beat * 5;
      // The corona first, so the black disc bites a hole out of it.
      for (let i = 0; i < 18; i++) {
        const a = eclipse.phase + (i / 18) * Math.PI * 2 - eclipse.age * 0.34;
        solidWedge(air, snap(eclipse.x + Math.cos(a) * moonR * 0.9),
          snap(moonY + Math.sin(a) * moonR * 0.9), {
            palette: pal, tone: 2 + (i % 3), angle: a,
            r0: 0, r1: (16 + (i % 4) * 13) * (0.7 + beat * 0.5),
            w0: P * 4, w1: P, alpha: (0.5 - (i % 3) * 0.1 + beat * 0.18) * open * fade,
            taper: 1.5, notch: i % 2 === 0, seed: i * 3,
          });
      }
      for (let s = 0; s < 2; s++) {
        const spin = eclipse.age * (s ? 1.6 : -1.15) + s * 2.1;
        solidArcBand(air, eclipse.x, moonY, {
          palette: pal, tone: s ? 4 : 2, from: spin, to: spin + Math.PI * 1.35,
          r: moonR * (1.16 + s * 0.24), thickness: P * (2.5 - s * 0.5),
          alpha: (0.55 - s * 0.16) * open * fade, squash: 0.9,
          taperEnds: 0.5, seed: s * 9,
        });
      }
      // The lit sliver goes down first and the black body is stamped over it,
      // so what survives is a rim of light escaping round one side — an
      // eclipse, not a bright moon with a dark bite taken out of it.
      crescentForm(air, snap(eclipse.x), snap(moonY), {
        palette: pal, tone: 1, r: moonR + P * 3, bite: 0.9,
        angle: -0.5 + Math.sin(eclipse.age * 0.9) * 0.35,
        alpha: (0.8 + beat * 0.2) * open * fade, squash: 1, rim: true,
      });
      air.fillStyle(shade(pal, 7), 0.95 * open * fade);
      pxDisc(air, eclipse.x, moonY, snap(moonR), snap(moonR));
      air.fillStyle(shade(pal, 6), 0.5 * open * fade);
      pxDisc(air, eclipse.x, moonY, snap(moonR * 0.72), snap(moonR * 0.72), { every: 2 });
      // A shaft of dark light between the eclipse and the seal, so the arrows
      // are visibly coming from somewhere.
      solidWedge(air, snap(eclipse.x), snap(moonY + moonR * 0.6), {
        palette: pal, tone: 5, angle: Math.PI / 2,
        r0: 0, r1: 116 - moonR * 0.6, w0: moonR * 0.9, w1: r * 0.78,
        alpha: (0.2 + beat * 0.16) * open * fade, taper: 1, seed: 4,
      });

      // Each arrow follows a different deterministic lane through the warned
      // circle. More lanes appear as successive waves build toward the finale.
      const arrowCount = 13 + eclipse.wave * 2;
      const waveP = ((eclipse.age - 0.16) / eclipse.interval + 10) % 1;
      for (let i = 0; i < arrowCount; i++) {
        const a = eclipse.phase + i * 2.399;
        const spread = ((i * 37) % 101) / 100;
        const ax = snap(eclipse.x + Math.cos(a) * eclipse.radius * spread * 0.82);
        const groundY = eclipse.y + Math.sin(a) * eclipse.radius * spread * 0.46;
        const q = (waveP + (i % 7) / 7) % 1;
        const ay = snap(groundY - (1 - q) * (125 + (i % 5) * 13));
        const lean = ((i % 5) - 2) * 0.07;
        if (q < 0.9) {
          const av = (0.55 + q * 0.45) * fade;
          arrowForm(air, ax, ay, {
            palette: pal, tone: 1 + (i % 3), angle: Math.PI / 2 + lean,
            length: 30 + (i % 3) * 8, alpha: av,
            head: 9, fletch: false, spark: q > 0.5,
          });
          // A real barbed head on the leading end, and two short feathers at
          // the nock. arrowForm's own fletching is wider than its head, which
          // on a shaft seen falling almost end-on reads as a hanging "T".
          solidWedge(air, ax, snap(ay - 13), {
            palette: pal, tone: 1 + (i % 2), angle: Math.PI / 2 + lean,
            r0: 0, r1: 13, w0: P * 5, w1: P, alpha: av,
            taper: 1.35, notch: true, glint: i % 3 === 0, seed: i * 2,
          });
          for (const side of [-1, 1]) {
            solidWedge(air, ax, snap(ay - (30 + (i % 3) * 8)), {
              palette: pal, tone: 3, angle: -Math.PI / 2 + lean + side * 0.7,
              r0: 0, r1: 9, w0: P * 2, w1: P, alpha: av * 0.85,
              taper: 1.2, seed: i + (side > 0 ? 5 : 11),
            });
          }
        } else {
          // The last beat of a lane is the hit: the shaft shatters on the stone.
          const hit = (q - 0.9) / 0.1;
          shardFan(air, ax, snap(groundY), {
            palette: pal, tone: i % 4 === 0 ? 0 : 1, angle: -Math.PI / 2,
            spread: 2.5, count: 5, r0: 3, r1: 10 + hit * 22,
            alpha: (1 - hit) * 0.95 * fade, squash: 0.7, width: P * 2, seed: i * 3,
          });
          for (let d = 0; d < 3; d++) {
            debrisChunk(air, snap(ax + ((d - 1) * 7 + (i % 3) * 2)),
              snap(groundY - hit * (14 + d * 6)), {
                palette: pal, tone: 2 + ((i + d) % 3), size: 3 + (d % 2) * 2,
                alpha: (1 - hit) * 0.8 * fade, seed: i + d * 5, spin: d,
              });
          }
          dustPuff(air, ax, snap(groundY - 4), {
            palette: pal, tone: 4, size: 12 + hit * 14,
            alpha: (1 - hit) * 0.4 * fade, lumps: 3, seed: i * 2, squash: 0.75,
          });
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
      // Afterimages and the air-rake belong *behind* the fighters; only the
      // claw marks and the landing flash sit in front of them.
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.ghost),
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
      const back = dash.gfxBack;
      g.clear();
      back.clear();
      dash.trails = dash.trails.filter((trail) => dash.age - trail.bornAt < dash.trailLife);
      // The hero position snaps immediately, so each hop has to be *told* after
      // the fact: a rake of air behind the leap, three afterimages of the monk
      // strung along it, and the claw marks it left at the far end.
      const pal = SOLAR_PALETTE;
      for (const trail of dash.trails) {
        const p = (dash.age - trail.bornAt) / dash.trailLife;
        const fade = Math.max(0, 1 - p) ** 1.2;
        if (fade <= 0.02) continue;
        const chest = hero.spriteHeight * 0.5;
        const sx = trail.startX;
        const sy = trail.startY - chest;
        const ex = trail.endX;
        const ey = trail.endY - chest;
        const len = Math.hypot(ex - sx, ey - sy);
        const back180 = trail.angle + Math.PI;
        const facing = Math.cos(trail.angle) >= 0 ? 1 : -1;
        const nx = -Math.sin(trail.angle);
        const ny = Math.cos(trail.angle);

        // ── the leap: a bowed arc, not a straight beam. Six chained segments
        // widen toward the landing, with two claw lines raked parallel ─────
        const bow = -Math.min(54, len * 0.26);
        const arcAt = (q, base) => base + bow * Math.sin(Math.PI * q);
        if (len > P * 3) {
          const segs = 6;
          for (let i = 0; i < segs; i++) {
            const q0 = i / segs;
            const q1 = (i + 1) / segs;
            const ax = sx + (ex - sx) * q0;
            const ay = arcAt(q0, sy + (ey - sy) * q0);
            const bx2 = sx + (ex - sx) * q1;
            const by2 = arcAt(q1, sy + (ey - sy) * q1);
            const a = Math.atan2(by2 - ay, bx2 - ax);
            const seglen = Math.hypot(bx2 - ax, by2 - ay) + P;
            const w = P * (1.5 + 6 * q1);
            solidWedge(back, ax, ay, {
              palette: pal, tone: 2, angle: a, r0: 0, r1: seglen,
              w0: w - P, w1: w, alpha: fade * (0.45 + q1 * 0.5),
              taper: 1, notch: false, seed: i * 3,
            });
            for (const s of [-1, 1]) {
              const off = (5 + 7 * q1) * s;
              solidWedge(back, ax + nx * off, ay + ny * off, {
                palette: pal, tone: 4, angle: a, r0: 0, r1: seglen,
                w0: P, w1: P * 2, alpha: fade * 0.55 * q1,
                taper: 1, notch: false, seed: i + (s > 0 ? 11 : 17),
              });
            }
          }
        }

        // ── three afterimages of the monk, lifted along the same arc ───────
        for (let i = 0; i < 3; i++) {
          const q = 0.22 + i * 0.28;
          figureForm(back,
            snap(trail.startX + (trail.endX - trail.startX) * q),
            snap(arcAt(q, trail.startY + (trail.endY - trail.startY) * q)), {
              palette: pal, tone: 4 - i, height: hero.spriteHeight * 0.92,
              alpha: fade * (0.26 + i * 0.18), facing, lean: facing * 6,
              cloak: 0.9, rimTone: 1,
            });
        }

        // ── dust kicked at both ends ──────────────────────────────────────
        dustPuff(back, trail.startX, trail.startY + 2, {
          palette: pal, tone: 5, size: 13 + p * 16, alpha: fade * 0.4,
          lumps: 4, seed: 2, squash: 0.5,
        });
        dustPuff(back, trail.endX - facing * 8, trail.endY + 2, {
          palette: pal, tone: 4, size: 11 + p * 20, alpha: fade * 0.5,
          lumps: 4, seed: 6, squash: 0.5,
        });

        // ── the strike: claw marks torn open across the landing, plus the
        // crescent of the pounce itself ───────────────────────────────────
        const strike = Phaser.Math.Clamp(p / 0.26, 0, 1);
        const strikeFade = fade * (1 - Math.max(0, p - 0.45) / 0.55);
        if (strikeFade > 0.02) {
          clawGash(g, ex + facing * 6, ey - 4, {
            palette: pal, tone: 1, angle: trail.angle - facing * 0.32,
            length: 46, spread: 11, claws: 4, alpha: strikeFade,
            width: P * 4, reveal: strike, seed: 4,
          });
          crescentForm(g, ex + facing * 14, ey, {
            palette: pal, tone: 2, r: 16 + strike * 13, bite: 0.66,
            angle: back180, alpha: strikeFade * 0.8, squash: 1.15,
          });
          shardFan(g, ex + facing * 10, ey, {
            palette: pal, tone: 0, angle: trail.angle, spread: 1.5, count: 4,
            r0: 6, r1: 14 + strike * 16, alpha: strikeFade * 0.9, seed: 7, width: P * 2,
          });
        }
      }

      if (dash.jump < dash.targets.length || dash.trails.length) continue;
      g.destroy();
      back.destroy();
      this.felineDashes = this.felineDashes.filter((d) => d !== dash);
    }
  }

  // ── Lion Monk: Burning Palm + burn damage over time ──────────────────────
  #startBurningPalm(hero, facing, eff, opts = {}) {
    this.burningPalms.push({
      x: hero.x + facing * 18,
      y: hero.y - hero.spriteHeight * 0.48,
      groundY: hero.y,
      dir: facing,
      range: eff.radius ?? 220,
      life: opts.life ?? eff.fxLife ?? 0.62,
      startScale: opts.startScale ?? eff.startScale ?? opts.scale ?? 1,
      endScale: opts.endScale ?? eff.endScale ?? opts.scale ?? 1,
      finisher: !!opts.finisher,
      age: 0,
      phase: Phaser.Math.FloatBetween(0, Math.PI * 2),
      gfx: this.scene.add.graphics().setDepth(DEPTH.telegraphAir),
      // Scorch marks it leaves on the floor as it passes, under the fighters.
      gfxBack: this.scene.add.graphics().setDepth(DEPTH.floorDecal),
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
      const back = palm.gfxBack;
      g.clear();
      back.clear();
      const pal = SOLAR_PALETTE;
      const dir = palm.dir;
      const aim = dir > 0 ? 0 : Math.PI;

      // ── the floor it has already crossed keeps burning ───────────────────
      // Scorch blots are laid down behind the paw, oldest and coolest first, so
      // the cone the telegraph promised is still legible after the paw is gone.
      const gy = snap((palm.groundY ?? palm.y + 30) + 4);
      for (let i = 0; i < 7; i++) {
        const q = i / 6;
        const bx = snap(palm.x + dir * travel * q);
        const heat = Math.max(0, 1 - (travel * (1 - q)) / (palm.range * 0.55));
        const rad = (10 + q * 15) * growth;
        back.fillStyle(shade(pal, 6), 0.5 * fade * (0.5 + q * 0.5));
        pxDisc(back, bx, gy, rad, rad * GROUND_SQUASH, { every: 2 });
        if (heat > 0.04) {
          back.fillStyle(shade(pal, 3), 0.34 * fade * heat);
          pxDisc(back, bx, gy, rad * 0.55, rad * 0.55 * GROUND_SQUASH, { every: 3 });
        }
      }

      // ── the paw: a real hand, palm-first, wreathed in flame ──────────────
      // Smoke and outer flame first so the hand stays the crispest thing in it.
      for (let i = 0; i < 4; i++) {
        const q = i / 3;
        dustPuff(g, cx - dir * (16 + q * 46) * size,
          cy + Math.sin(palm.phase + q * 4 + p * 7) * 11 * size, {
            palette: pal, tone: 5, size: (13 + q * 15) * size,
            alpha: fade * (0.4 - q * 0.22), lumps: 3, seed: i * 5 + 1,
          });
      }
      // Three tongues, staggered back along the path and fanned apart, so the
      // wake stays a wake — five parallel ones comb into a striped pattern.
      for (let i = 0; i < 3; i++) {
        const spread = (i - 1) * 1.05;
        flameTongue(g,
          cx - dir * (14 + i * 15) * size, cy + spread * 13 * size, {
            palette: pal, tone: 3 + (i % 2),
            height: (26 + (i % 3) * 15) * size, width: (11 + (i % 2) * 7) * size,
            angle: aim + Math.PI + spread * 0.62,
            alpha: fade * (0.62 - Math.abs(spread) * 0.16),
            sway: 13 * size, grow: 1, seed: palm.phase + i * 2.3 + p * 9,
          });
      }

      clawHand(g, cx, cy, {
        palette: pal, tone: 2, angle: aim, size: 30 * size,
        alpha: fade, close: 0.32, squash: 0.94,
      });
      // A hot core in the pad, and a wedge of pressure ahead of it.
      g.fillStyle(shade(pal, 1), fade * 0.6);
      pxDisc(g, cx, cy, 5 * size, 4 * size);
      g.fillStyle(shade(pal, 0), fade * (palm.finisher ? 0.8 : 0.55));
      pxDisc(g, cx + dir * 2 * size, cy, 3 * size, 2.6 * size);
      for (const s of [-1, 1]) {
        solidWedge(g, cx + dir * 16 * size, cy + s * 9 * size, {
          palette: pal, tone: 1, angle: aim + s * 0.34,
          r0: 0, r1: (18 + p * 16) * size, w0: P * 3, w1: P,
          alpha: fade * 0.75, taper: 1.5, notch: false, seed: s > 0 ? 2 : 9,
        });
      }
      // Embers thrown off the knuckles.
      for (let i = 0; i < 6; i++) {
        const a = palm.phase + i * 1.9 + p * 5;
        debrisChunk(g,
          snap(cx - dir * (4 + (i % 3) * 12) * size + Math.cos(a) * 9 * size),
          snap(cy + Math.sin(a) * 15 * size), {
            palette: pal, tone: 1 + (i % 3), size: (3 + (i % 2) * 2) * size,
            alpha: fade * 0.9, seed: i * 3, spin: i,
          });
      }
      if (palm.finisher) {
        // The ultimate's finisher lands a full maw behind the strike.
        lionMaw(g, cx - dir * 6 * size, cy, {
          palette: pal, tone: 2, size: 46 * size, alpha: fade * 0.55,
          open: 0.4 + p * 0.6, maneSpin: palm.phase + p * 3, squash: 0.95,
        });
      }

      if (p < 1) continue;
      g.destroy();
      back.destroy();
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
    // Clears the lion's head, which now rides well above the monk.
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 84, 'SOLAR ROAR', SOLAR_PALETTE[1]);
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
      const pal = SOLAR_PALETTE;
      const gy = roar.y + 18;
      const punch = Math.max(0, 1 - p / 0.22);

      // ── the floor takes the pressure ─────────────────────────────────────
      // A hot wash inside the wave, then three stepped ridges: the leading one
      // bright and thick, the two behind it settling and cooling.
      g.fillStyle(shade(pal, 5), 0.2 * fade);
      pxDisc(g, roar.x, gy, wave * 0.95, wave * 0.95 * GROUND_SQUASH, { every: 3 });
      g.fillStyle(shade(pal, 2), (0.2 + punch * 0.4) * fade);
      pxDisc(g, roar.x, gy, wave * 0.3, wave * 0.3 * GROUND_SQUASH, { every: 2 });
      for (let ring = 0; ring < 3; ring++) {
        const r = Math.max(8, wave - ring * 20);
        groundBand(g, roar.x, gy, r, {
          palette: pal, tone: 1 + ring * 2,
          thickness: P * (ring === 0 ? 3 : 2),
          alpha: fade * (0.85 - ring * 0.22), bite: 1.3 + ring * 0.4,
          seed: ring * 7 + 1, glint: ring === 0,
        });
      }

      // Mane licks: solid flame wedges thrown outward through the wave front,
      // not a fan of hairlines.
      for (let i = 0; i < 14; i++) {
        const a = (Math.PI * 2 * i) / 14 + roar.phase * 0.16 + p * 0.4;
        const inner = Math.max(10, wave - 22 - (i % 3) * 6);
        solidWedge(g, roar.x + Math.cos(a) * inner, gy + Math.sin(a) * inner * GROUND_SQUASH, {
          palette: pal, tone: 1 + (i % 3), angle: a,
          r0: 0, r1: 26 + (i % 4) * 11, w0: P * 4, w1: P,
          alpha: fade * 0.7, squash: GROUND_SQUASH,
          taper: 1.5, seed: i * 3,
        });
      }
      // Stone split by the shout, revealed with the wave.
      for (let i = 0; i < 8; i++) {
        const a = roar.phase * 0.2 + (i / 8) * Math.PI * 2;
        groundCrack(g, roar.x + Math.cos(a) * 12, gy + Math.sin(a) * 12 * GROUND_SQUASH, {
          palette: pal, tone: 5, angle: a, length: roar.radius * (0.5 + (i % 3) * 0.13),
          alpha: 0.6 * fade, reveal: Math.min(1, p * 2.1), seed: i * 5, branches: 2, width: P * 2,
        });
      }
      for (let i = 0; i < 6; i++) {
        const a = roar.phase + (i / 6) * Math.PI * 2;
        dustPuff(g, roar.x + Math.cos(a) * wave * 0.86, gy + Math.sin(a) * wave * 0.86 * GROUND_SQUASH, {
          palette: pal, tone: 4, size: 15 + p * 16, alpha: fade * 0.34,
          lumps: 3, seed: i * 4 + 3, squash: 0.55,
        });
      }

      // ── the lion, roaring out of the caster ──────────────────────────────
      // It resolves in a couple of frames, rides up over the monk as the wave
      // travels, and burns out with it.
      const faceFade = fade * Math.min(1, p / 0.09);
      if (faceFade > 0.02) {
        const cx = roar.x;
        const cy = roar.y - 48 - p * 34;
        const size = 74 + p * 36;
        // A dark backing disc: without it the head sits on the monk's bright
        // armour and the two silhouettes merge into one orange mass.
        air.fillStyle(shade(pal, 6), faceFade * 0.7);
        pxDisc(air, snap(cx), snap(cy), snap(size * 0.5), snap(size * 0.44));
        lionMaw(air, cx, cy, {
          palette: pal, tone: 1, size, alpha: faceFade,
          open: 0.3 + Math.min(1, p * 3.4) * 0.7,
          maneSpin: roar.phase + p * 2.2, squash: 0.95,
        });
        // Flame streaming out of the open jaw, and the blast it pushes ahead.
        for (let i = 0; i < 4; i++) {
          const spread = (i - 1.5) * 0.52;
          flameTongue(air, cx + spread * 9, cy + size * 0.3, {
            palette: pal, tone: 2 + (i % 2), height: 22 + p * 44,
            width: 10 + (i % 2) * 6, angle: Math.PI / 2 + spread * 0.42,
            alpha: faceFade * 0.72, sway: 11, grow: 1, seed: roar.phase + i * 2.1,
          });
        }
        for (let s = 0; s < 2; s++) {
          solidArcBand(air, cx, cy + size * 0.24, {
            palette: pal, tone: s ? 3 : 0,
            from: Math.PI * (0.1 + s * 0.07), to: Math.PI * (0.9 - s * 0.07),
            r: size * 0.6 + p * 78 + s * 16, thickness: P * (3 - s),
            alpha: faceFade * (0.72 - s * 0.3), squash: 0.72, seed: s * 9,
          });
        }
        // Embers blown off the mane.
        for (let i = 0; i < 9; i++) {
          const a = roar.phase * 1.3 + i * 0.79;
          const d = size * 0.55 + p * 74 + (i % 3) * 10;
          debrisChunk(air, snap(cx + Math.cos(a) * d), snap(cy + Math.sin(a) * d * 0.7), {
            palette: pal, tone: 1 + (i % 3), size: 4 + (i % 2) * 3,
            alpha: faceFade * 0.85, seed: i * 6, spin: i,
          });
        }
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
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 70, 'TRANSFORMING', SOLAR_PALETTE[1]);
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
    this.scene.fx.popText(hero.x, hero.y - hero.spriteHeight - 70, 'LION FORM', SOLAR_PALETTE[1]);
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

  /**
   * The morph, and — replayed backwards with `p` running 1 → 0 — the revert.
   * A summoning seal burns into the floor, the Monk is swallowed by a fire
   * sphere with a real corona, and in the second half a lion's head resolves
   * out of it. Everything is driven by `p` alone so the reverse plays clean.
   */
  #drawSolarTransformation(fury, p) {
    const { hero } = fury;
    const g = fury.gfx;
    const back = fury.gfxBack;
    const air = fury.gfxAir;
    const pal = SOLAR_PALETTE;
    const x = snap(hero.x);
    const y = snap(hero.y);
    const cy = snap(y - hero.spriteHeight * 0.48);
    const pulse = 0.5 + 0.5 * Math.sin(fury.age * 12);
    const orbR = 18 + Math.sin(p * Math.PI) * 48 + p * 12;
    g.clear();
    back.clear();
    air.clear();

    // ── the seal ─────────────────────────────────────────────────────────
    const sealR = 38 + p * 48;
    g.fillStyle(shade(pal, 5), 0.16 + p * 0.2);
    pxDisc(g, x, y + 2, sealR * 0.92, sealR * 0.92 * GROUND_SQUASH, { every: 3 });
    g.fillStyle(shade(pal, 2), 0.24 + pulse * 0.16);
    pxDisc(g, x, y + 2, sealR * 0.3, sealR * 0.3 * GROUND_SQUASH, { every: 2 });
    for (let ring = 0; ring < 2; ring++) {
      groundBand(g, x, y + 2, sealR * (1 - ring * 0.36), {
        palette: pal, tone: ring ? 3 : 1, thickness: P * (3 - ring),
        alpha: 0.7 + pulse * 0.2, bite: 1.2 + ring * 0.6,
        seed: ring * 5 + 2, glint: ring === 0,
      });
    }
    // Eight glyphs turning on the outer band: this is a summoning, so it is
    // written on the floor rather than just glowing.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + fury.age * 0.5;
      runeGlyph(g, snap(x + Math.cos(a) * sealR * 0.82),
        snap(y + 2 + Math.sin(a) * sealR * 0.82 * GROUND_SQUASH), {
          palette: pal, tone: 1 + (i % 3), size: 9 + (i % 2) * 3,
          alpha: (0.5 + pulse * 0.4) * Math.min(1, p * 2), variant: i,
        });
    }
    for (let i = 0; i < 6; i++) {
      const a = fury.phase * 0.4 + (i / 6) * Math.PI * 2;
      groundCrack(g, snap(x + Math.cos(a) * 14), snap(y + 2 + Math.sin(a) * 14 * GROUND_SQUASH), {
        palette: pal, tone: 5, angle: a, length: sealR * (0.7 + (i % 3) * 0.16),
        alpha: 0.55 * p, reveal: Math.min(1, p * 1.6), seed: i * 4, branches: 2, width: P * 2,
      });
    }

    // ── the fire sphere, behind the fading body ──────────────────────────
    // Its bright core is consumed as the beast resolves, so the two never
    // compete for the same pixels.
    const lionP = Phaser.Math.Clamp((p - 0.42) / 0.58, 0, 1);
    const core = 1 - lionP * 0.72;
    back.fillStyle(shade(pal, 6), 0.32 + pulse * 0.08);
    pxDisc(back, x, cy, orbR, orbR, { every: 3 });
    back.fillStyle(shade(pal, 4), (0.52 + pulse * 0.12) * (1 - lionP * 0.4));
    pxDisc(back, x, cy, orbR * 0.78, orbR * 0.78, { every: 2 });
    back.fillStyle(shade(pal, 2), (0.7 + pulse * 0.14) * core);
    pxDisc(back, x, cy, orbR * 0.54, orbR * 0.54);
    back.fillStyle(shade(pal, 0), 0.9 * core);
    pxDisc(back, x, cy, orbR * 0.2, orbR * 0.2);
    // A corona of real flame, not a ring of dots.
    for (let i = 0; i < 12; i++) {
      const a = fury.phase + (i / 12) * Math.PI * 2 + fury.age * 0.8;
      flameTongue(back, snap(x + Math.cos(a) * orbR * 0.8), snap(cy + Math.sin(a) * orbR * 0.8), {
        palette: pal, tone: 2 + (i % 3),
        height: orbR * (0.5 + (i % 3) * 0.16), width: 9 + (i % 2) * 5,
        angle: a - Math.PI / 2, alpha: 0.62 + pulse * 0.2,
        sway: 9, grow: Math.min(1, p * 1.8), seed: i * 2.4 + fury.age,
      });
    }
    for (let s = 0; s < 3; s++) {
      solidArcBand(air, x, cy, {
        palette: pal, tone: s, from: fury.age * (s % 2 ? -2.6 : 2.2) + s * 1.4,
        to: fury.age * (s % 2 ? -2.6 : 2.2) + s * 1.4 + Math.PI * (1.05 + s * 0.2),
        r: orbR * (0.82 + s * 0.22), thickness: P * (3 - s),
        alpha: 0.66 - s * 0.16, squash: 0.6 + s * 0.09,
        taperEnds: 0.55, glint: s === 0, seed: s * 6,
      });
    }

    // ── the beast resolving out of the sphere ────────────────────────────
    if (lionP > 0) {
      const faceX = snap(x + hero.facing * 4);
      const size = 52 + lionP * 34;
      // A shadow the head sits in, so it silhouettes against the fire behind.
      air.fillStyle(shade(pal, 6), lionP * 0.8);
      pxDisc(air, faceX, cy, snap(size * 0.5), snap(size * 0.46));
      lionMaw(air, faceX, cy, {
        palette: pal, tone: 1, size, alpha: 0.55 + lionP * 0.45,
        open: 0.25 + lionP * 0.75, maneSpin: fury.phase + fury.age * 1.4, squash: 0.94,
      });
    }

    // Sparks torn off the sphere and dragged upward.
    for (let i = 0; i < 14; i++) {
      const a = fury.phase + i * 2.17 + fury.age * (2 + (i % 4));
      const r = orbR * (0.55 + (i % 5) * 0.16);
      debrisChunk(air, snap(x + Math.cos(a) * r), snap(cy + Math.sin(a) * r - (i % 5) * p * 5), {
        palette: pal, tone: 1 + (i % 3), size: 3 + (i % 3) * 2,
        alpha: 0.4 + (i % 4) * 0.15, seed: i * 3, spin: i,
      });
    }
  }

  /**
   * The stance itself, held for seven seconds while the beast fights: a solar
   * seal that turns under its feet, a wedge mane burning behind the body, and
   * heat rising off it. Kept deliberately lean — it redraws every frame for
   * the whole duration, alongside live combat.
   */
  #drawSolarFury(fury) {
    const { hero } = fury;
    const pal = SOLAR_PALETTE;
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

    g.fillStyle(shade(pal, 5), 0.14 + pulse * 0.05);
    pxDisc(g, x, y + 2, 60, 60 * GROUND_SQUASH, { every: 4 });
    for (let ring = 0; ring < 2; ring++) {
      groundBand(g, x, y + 2, ring ? 42 : 62, {
        palette: pal, tone: ring ? 1 : 3, thickness: P * (2 - ring * 0.5),
        alpha: (ring ? 0.5 : 0.72) + pulse * 0.16, bite: ring ? 1.6 : 1,
        seed: ring * 9 + Math.floor(fury.age * 3), glint: ring === 0,
      });
    }

    // The mane: solid wedges behind the body, sized to reach past the beast's
    // silhouette so the burning crown is visible around it rather than hidden.
    const maneR = (47 + pulse * 6) * open;
    for (let i = 0; i < 16; i++) {
      const a = fury.phase + (i / 16) * Math.PI * 2 + fury.age * 0.35;
      solidWedge(back, cx, cy, {
        palette: pal, tone: 2 + (i % 3), angle: a,
        r0: maneR * 0.5, r1: maneR * (1.06 + (i % 3) * 0.14),
        w0: maneR * 0.26, w1: P, alpha: (0.6 + pulse * 0.22) * open,
        taper: 1.4, notch: true, glint: i % 4 === 0, seed: i * 3,
      });
    }
    back.fillStyle(shade(pal, 5), 0.26 + pulse * 0.08);
    pxDisc(back, cx, cy, maneR * 0.72, maneR * 0.72, { every: 3 });
    // Two counter-turning bands of solar wind framing the body.
    for (let s = 0; s < 2; s++) {
      const spin = fury.age * (s ? -1.5 : 1.9) + s * 2.2;
      solidArcBand(back, cx, snap(cy + h * 0.16), {
        palette: pal, tone: s ? 3 : 1, from: spin, to: spin + Math.PI * 1.25,
        r: (52 + s * 13) * open, thickness: P * (2.5 - s * 0.5),
        alpha: (0.62 - s * 0.18) * open, squash: 0.62,
        taperEnds: 0.5, glint: s === 0, seed: s * 7,
      });
    }

    // Heat coming off the body, and embers riding it up.
    for (let i = 0; i < 3; i++) {
      const ph = (fury.age * 0.7 + i / 3) % 1;
      flameTongue(air, snap(x + Math.sin(fury.age * 2.2 + i * 2.1) * 13), snap(y - 6 - ph * h * 0.5), {
        palette: pal, tone: 2 + (i % 2), height: 20 + (1 - ph) * 20,
        width: 9 + (i % 2) * 5, angle: -Math.PI / 2,
        alpha: (1 - ph) * 0.6 * open, sway: 8, grow: 1, seed: fury.age + i * 3.1,
      });
    }
    for (let i = 0; i < 10; i++) {
      const ph = (fury.age * (0.42 + (i % 4) * 0.04) + i / 10) % 1;
      const a = fury.phase + i * 2.31 + fury.age * 0.7;
      debrisChunk(air, snap(x + Math.cos(a) * (20 + (i % 5) * 8)), snap(y - 4 - ph * (h + 30)), {
        palette: pal, tone: 1 + (i % 3), size: 3 + (i % 2) * 3,
        alpha: (1 - ph) * (0.7 + (i % 3) * 0.12), seed: i * 5, spin: i,
      });
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
