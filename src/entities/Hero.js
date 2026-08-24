/**
 * Hero — the floor boss. Owns stats, timed random skills, aggro visualisation and
 * skill cooldowns. Behaviour lives in ai/HeroAI.js; telegraph rendering lives
 * in systems/TelegraphSystem.js.
 */

import Entity from './Entity.js';
import { COLORS, DEPTH, HERO_ZONE } from '../config.js';
import { HERO_STATE } from '../data/heroes.js';

export default class Hero extends Entity {
  constructor(scene, def, floorCfg, x, y) {
    super(scene, {
      art: def.art,
      x, y,
      hp: Math.round(def.hp * floorCfg.hpMult),
      atk: def.atk * floorCfg.atkMult,
      speed: def.speed * floorCfg.speedMult,
      hitRadius: def.hitRadius,
      isHero: true,
      visualScale: def.visualScale ?? 1.42,
    });

    this.def = def;
    this.combat = def.combat ?? {};
    this.floorCfg = floorCfg;
    this.barWidth = 0; // hero HP is shown in the HTML overlay instead
    this.deathColor = COLORS.heroBody;

    this.aggroRadius = def.aggroRadius;
    this.basicRange = def.basicRange;
    this.basicCooldown = 0;

    /** Only skills unlocked on this floor (difficulty ramp, spec §2.1). */
    this.skills = def.skills.filter((s) => floorCfg.floor >= s.minFloor);
    this.skillCd = {};
    this.skillUsed = {};
    this.triggerTimers = {};
    this.nextSkillAt = scene.clock + Phaser.Math.FloatBetween(def.skillInterval.min, def.skillInterval.max);

    this.state = HERO_STATE.IDLE;
    this.stateUntil = 0;
    this.pendingSkill = null;
    this.telegraph = null;
    this.target = null;
    this.taunt = null;
    this.enraged = false;

    /** How long the hero has held still — Reckless Charge reads this. */
    this.stationaryFor = 0;
    this.patrolDir = 1;
    this.homeX = x;
    this.homeY = y;

    this.aggroGfx = scene.add.graphics().setDepth(DEPTH.aggro);
    this.drawAggro();
  }

  get isTelegraphing() {
    return this.state === HERO_STATE.TELEGRAPH;
  }

  skillReady(skill) {
    if (skill.once && this.skillUsed[skill.id]) return false;
    return (this.skillCd[skill.id] ?? 0) <= this.scene.clock;
  }

  putOnCd(skill) {
    this.skillCd[skill.id] = this.scene.clock + skill.cooldown;
    this.skillUsed[skill.id] = true;
  }

  setState(state, seconds = 0) {
    this.state = state;
    this.stateUntil = this.scene.clock + seconds;
  }

  get stateExpired() {
    return this.scene.clock >= this.stateUntil;
  }

  /** Taunt from Stone Golem's Provoke — forces target selection (spec §3.2). */
  applyTaunt(monster, seconds) {
    this.taunt = { target: monster, until: this.scene.clock + seconds };
    this.scene.fx.popText(this.x, this.y - this.spriteHeight - 18, 'TAUNTED', COLORS.tgControl);
  }

  get tauntTarget() {
    if (!this.taunt) return null;
    if (this.scene.clock >= this.taunt.until || !this.taunt.target?.alive) {
      this.taunt = null;
      return null;
    }
    return this.taunt.target;
  }

  /** Semi-transparent aggro/attack area required by spec §2.3 / §6. */
  drawAggro() {
    const g = this.aggroGfx;
    g.clear();
    if (!this.alive) return;

    const cy = this.y - 4;
    const danger = this.isTelegraphing || this.state === HERO_STATE.CAST;

    g.fillStyle(COLORS.aggro, danger ? 0.13 : 0.07);
    g.fillCircle(this.x, cy, this.aggroRadius);

    // dashed outline so the boundary reads exactly
    const steps = 48;
    g.lineStyle(1, COLORS.aggro, danger ? 0.85 : 0.5);
    for (let i = 0; i < steps; i += 2) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1) / steps) * Math.PI * 2;
      g.beginPath();
      g.moveTo(this.x + Math.cos(a0) * this.aggroRadius, cy + Math.sin(a0) * this.aggroRadius);
      g.lineTo(this.x + Math.cos(a1) * this.aggroRadius, cy + Math.sin(a1) * this.aggroRadius);
      g.strokePath();
    }

    // inner basic-attack range
    g.lineStyle(1, COLORS.aggro, 0.28);
    g.strokeCircle(this.x, cy, this.basicRange);
  }

  update(dt) {
    if (!this.alive) {
      this.aggroGfx.clear();
      this.syncSprite();
      return;
    }
    this.stepPhysics(dt, this.moveBounds());
    this.syncSprite();
    this.drawAggro();
  }

  /** Where the hero may go when chasing: the whole arena, slightly inset.
   *  Without this a back-line Support could park outside the guard post and
   *  stalemate the fight forever. */
  moveBounds() {
    const b = this.scene.arenaBounds;
    return { x: b.x + 24, right: b.right - 24, y: b.y, bottom: b.bottom };
  }

  /** Where the hero idles when nothing is deployed. */
  patrolBounds() {
    const b = this.scene.arenaBounds;
    return {
      x: Math.max(b.x + 24, HERO_ZONE.x),
      right: Math.min(b.right - 24, HERO_ZONE.x + HERO_ZONE.w),
      y: b.y,
      bottom: b.bottom,
    };
  }

  destroy() {
    this.aggroGfx?.destroy();
    super.destroy();
  }
}
