/**
 * PlayerController — the hands on the hero in Ascent mode.
 *
 * This is HeroAI's opposite number: same state machine, same commitments, but
 * every decision comes from the keyboard and the cursor instead of a timer. It
 * deliberately shares the *resolution* path with the boss (SkillSystem's
 * `performHeroBasic` and `executeHeroEffect`), so a skill cannot behave one way
 * in the player's hands and another way in the AI's.
 *
 * The one hard rule the boss lives by is kept: nothing powerful resolves without
 * completing a telegraph first. The player's wind-ups are shorter (PLAYER
 * .telegraphMult) because for them a telegraph is a commitment rather than a
 * warning — but they are always drawn, and they can always be interrupted.
 *
 *   move        WASD / arrows      (rooted while winding up)
 *   aim         mouse
 *   basic       left click / SPACE / J
 *   skills      1 2 3
 *   ultimate    4 / R
 */

import { PLAYER } from '../config.js';
import { HERO_STATE } from '../data/heroes.js';

/** Cursor closer than this to the hero can't say which way you're facing. */
const AIM_DEADZONE = 10;

export default class PlayerController {
  constructor(scene) {
    this.scene = scene;
    this.enabled = false;
    this.aim = { x: scene.arenaBounds.right - 200, y: scene.arenaBounds.bottom - 120 };
    /** One buffered action, consumed on the next frame the hero is free. */
    this.queued = null;
    this.queuedAt = -Infinity;

    this.#bindInput();
  }

  // ═══ input plumbing ══════════════════════════════════════════════════════
  #bindInput() {
    const kb = this.scene.input.keyboard;
    this.keys = kb.addKeys({
      up: 'W', down: 'S', left: 'A', right: 'D',
      up2: 'UP', down2: 'DOWN', left2: 'LEFT', right2: 'RIGHT',
      basic: 'SPACE', basic2: 'J',
      s1: 'ONE', s2: 'TWO', s3: 'THREE',
      ult: 'FOUR', ult2: 'R',
    });
    // Stop the page scrolling out from under the arena.
    kb.addCapture(['W', 'A', 'S', 'D', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'SPACE',
      'ONE', 'TWO', 'THREE', 'FOUR', 'R', 'J']);

    this.scene.input.on('pointermove', (p) => {
      this.aim.x = p.worldX;
      this.aim.y = p.worldY;
    });
    this.scene.input.on('pointerdown', (p) => {
      if (!this.enabled) return;
      this.aim.x = p.worldX;
      this.aim.y = p.worldY;
      this.request('basic');
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.queued = null;
  }

  /**
   * Buffer an action. Presses land during a recovery frame constantly, so a short
   * buffer is the difference between "responsive" and "the game ate my input" —
   * but it expires, so a press from two seconds ago never fires by surprise.
   */
  request(action) {
    if (!this.enabled) return;
    this.queued = action;
    this.queuedAt = this.scene.clock;
  }

  #takeQueued() {
    if (!this.queued) return null;
    if (this.scene.clock - this.queuedAt > 0.35) { this.queued = null; return null; }
    const action = this.queued;
    this.queued = null;
    return action;
  }

  #pollKeys() {
    const k = this.keys;
    const J = Phaser.Input.Keyboard.JustDown;
    if (J(k.basic) || J(k.basic2)) this.request('basic');
    else if (J(k.s1)) this.request('skill:0');
    else if (J(k.s2)) this.request('skill:1');
    else if (J(k.s3)) this.request('skill:2');
    else if (J(k.ult) || J(k.ult2)) this.request('ult');
  }

  // ═══ frame ═══════════════════════════════════════════════════════════════
  update(dt) {
    const hero = this.scene.hero;
    if (!hero?.alive) return;
    if (this.enabled) this.#pollKeys();

    this.#trackStationary(hero, dt);
    hero.basicCooldown = Math.max(0, hero.basicCooldown - dt);
    hero.target = this.#aimTarget(hero, Infinity);

    if (hero.stunned) {
      if (!hero.animLocked) hero.play('idle');
      this.queued = null;
      return;
    }

    switch (hero.state) {
      case HERO_STATE.TELEGRAPH:
        // Rooted; TelegraphSystem drives completion or cancellation.
        break;

      case HERO_STATE.CAST:
        if (hero.stateExpired) hero.setState(HERO_STATE.RECOVER, hero.pendingRecover ?? 0.3);
        break;

      case HERO_STATE.RECOVER: {
        // Recovery costs the *action*, not the feet: being rooted for the 0.8s
        // after Judgment while five monsters close in reads as a bug.
        const moved = this.#move(hero, dt, PLAYER.recoverMoveMult);
        if (!hero.animLocked) hero.play(moved ? 'move' : 'idle');
        if (hero.stateExpired) hero.setState(HERO_STATE.IDLE);
        break;
      }

      case HERO_STATE.BASIC:
        if (hero.stateExpired) this.#resolveBasic(hero);
        break;

      default:
        this.#act(hero, dt);
        break;
    }
  }

  #act(hero, dt) {
    this.#face(hero);
    const moved = this.#move(hero, dt, PLAYER.moveMult);

    const action = this.#takeQueued();
    if (!action) {
      if (!hero.animLocked) hero.play(moved ? 'move' : 'idle');
      return;
    }

    if (action === 'basic') {
      if (hero.basicCooldown > 0) return;
      hero.basicTarget = this.#aimTarget(hero, hero.basicRange + 14);
      hero.setState(HERO_STATE.BASIC, hero.def.basicWindup);
      hero.playFor('windup', hero.def.basicWindup);
      return;
    }

    const skill = action === 'ult'
      ? hero.def.ultimate
      : hero.skills[Number(action.slice(6))];
    if (skill) this.#startCast(hero, skill);
  }

  // ═══ movement & aim ══════════════════════════════════════════════════════
  #move(hero, dt, mult) {
    if (!this.enabled) return false;
    const k = this.keys;
    let dx = 0;
    let dy = 0;
    if (k.left.isDown || k.left2.isDown) dx -= 1;
    if (k.right.isDown || k.right2.isDown) dx += 1;
    if (k.up.isDown || k.up2.isDown) dy -= 1;
    if (k.down.isDown || k.down2.isDown) dy += 1;
    if (!dx && !dy) return false;

    // Normalise so diagonals aren't 41% faster than the cardinals.
    const len = Math.hypot(dx, dy);
    const step = hero.speed * mult * dt;
    const b = hero.moveBounds();
    hero.x = Phaser.Math.Clamp(hero.x + (dx / len) * step, b.x, b.right);
    hero.y = Phaser.Math.Clamp(hero.y + (dy / len) * step, b.y + 30, b.bottom - 10);
    return true;
  }

  /**
   * Facing follows the cursor, not the movement keys: strafing away from a
   * monster while still swinging at it is the whole point of a twin-stick layout.
   */
  #face(hero) {
    const dx = this.aim.x - hero.x;
    if (Math.abs(dx) < AIM_DEADZONE) return;
    hero.facing = dx >= 0 ? 1 : -1;
  }

  /** Aim point, clamped so a ground cast can never land outside the arena. */
  #aimPoint() {
    const b = this.scene.arenaBounds;
    return {
      x: Phaser.Math.Clamp(this.aim.x, b.x + 18, b.right - 18),
      y: Phaser.Math.Clamp(this.aim.y, b.y + 26, b.bottom - 12),
    };
  }

  /**
   * The monster the player is pointing at: nearest to the cursor, within reach.
   * Cursor proximity beats hero proximity — with a crowd on top of you, the one
   * you are pointing at is the one you meant.
   */
  #aimTarget(hero, maxDistance) {
    let best = null;
    let bestScore = Infinity;
    for (const m of this.scene.monsters) {
      if (!m.alive) continue;
      if (hero.distanceTo(m) > maxDistance) continue;
      const score = Math.hypot(m.x - this.aim.x, (m.y - m.spriteHeight * 0.4) - this.aim.y);
      if (score < bestScore) { bestScore = score; best = m; }
    }
    return best;
  }

  #trackStationary(hero, dt) {
    const moved = Math.abs(hero.x - (hero._prevX ?? hero.x)) > 0.4
      || Math.abs(hero.y - (hero._prevY ?? hero.y)) > 0.4;
    hero.stationaryFor = moved ? 0 : hero.stationaryFor + dt;
    hero._prevX = hero.x;
    hero._prevY = hero.y;
  }

  // ═══ basic attack ════════════════════════════════════════════════════════
  #resolveBasic(hero) {
    hero.basicCooldown = hero.def.basicInterval / (hero.solarActive ? hero.solarAttackSpeedMult : 1);
    hero.setState(HERO_STATE.RECOVER, 0.1);
    hero.play('attack', true);
    this.scene.audio?.playSkill(hero);
    this.scene.skills.performHeroBasic(hero, hero.basicTarget, {
      // A bow with nothing in reach still fires — at the floor under the cursor.
      aim: this.#aimPoint(),
      targetList: this.scene.monsters.filter((m) => m.alive),
    });
    hero.basicTarget = null;
  }

  // ═══ casting ═════════════════════════════════════════════════════════════
  #startCast(hero, skill) {
    if (!hero.skillReady(skill)) {
      const left = Math.max(0, (hero.skillCd[skill.id] ?? 0) - this.scene.clock);
      this.scene.ui?.flashHint(skill.once && hero.skillUsed[skill.id]
        ? `${skill.name} — once per floor, already spent`
        : `${skill.name} — ${left.toFixed(1)}s`, 900);
      return;
    }
    // Triple Pounce blinks between bodies; with an empty room it has nowhere to
    // go, and silently eating a 8s cooldown reads as the button being broken.
    if (skill.effect?.type === 'felineDash' && !this.scene.monsters.some((m) => m.alive)) {
      this.scene.ui?.flashHint(`${skill.name} needs a target`, 900);
      return;
    }

    const tg = skill.telegraph;
    const duration = Math.max(PLAYER.telegraphMin, tg.duration * PLAYER.telegraphMult);
    this.#face(hero);

    // Ground-targeted shapes land under the cursor; everything else is anchored
    // on the hero and swings along its facing.
    const atCursor = !!tg.atTarget && !tg.atSelf;
    const point = this.#aimPoint();
    const ctx = {
      x: atCursor ? point.x : hero.x,
      y: atCursor ? point.y : hero.y - 10,
      facing: hero.facing,
    };
    if (skill.effect?.type === 'blizzard') {
      ctx.spots = this.#blizzardSpots(skill.effect.storms ?? 5, point);
    }

    hero.putOnCd(skill);
    hero.triggerTimers[skill.id] = 0;
    hero.pendingSkill = skill;
    hero.pendingRecover = skill.recover;
    hero.setState(HERO_STATE.TELEGRAPH, duration + 2);
    hero.playFor('windup', duration);

    const spot = ctx.spots?.[0] ?? ctx;
    this.scene.telegraph.begin({
      ...tg,
      duration,
      source: hero,
      x: spot.x,
      y: spot.y,
      spots: ctx.spots,
      facing: ctx.facing,
      onComplete: () => {
        if (!hero.alive) return;
        hero.play('attack', true);
        hero.setState(HERO_STATE.CAST, 0.14);
        this.scene.skills.executeHeroEffect(hero, skill, ctx);
        hero.pendingSkill = null;
      },
      onCancel: () => {
        if (!hero.alive) return;
        hero.pendingSkill = null;
        hero.play('hit', true);
        hero.setState(HERO_STATE.RECOVER, 0.5);
        // Interrupted, not wasted: most of the cooldown comes back.
        if (skill.cooldown) hero.skillCd[skill.id] = this.scene.clock + skill.cooldown * 0.35;
      },
    });
  }

  /** A ring of storms around the cursor, so Blizzard covers what you aimed at. */
  #blizzardSpots(count, point) {
    const b = this.scene.arenaBounds;
    return Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2 - Math.PI / 2;
      return {
        x: Phaser.Math.Clamp(point.x + Math.cos(a) * 105, b.x + 105, b.right - 105),
        y: Phaser.Math.Clamp(point.y + Math.sin(a) * 72, b.y + 80, b.bottom - 55),
      };
    });
  }
}
