/**
 * AscentSystem — the wave director and win/lose rules for Ascent mode.
 *
 * BattleSystem's conditions are inverted here, which is the whole mode in one
 * sentence: in defence you win when the hero dies, and here you lose when it
 * does. Rather than bolt a second personality onto BattleSystem, this is its
 * sibling — it owns its own state machine and emits the same shape of events, so
 * GameScene wires it the same way.
 *
 * Everything is dt-driven off `scene.clock`. No tweens, no delayedCall: a spawn
 * timer that ran on real time would keep counting through hitstop and would be
 * invisible to a stepped verification harness.
 */

import { ARENA, PLAYER } from '../config.js';
import Monster from '../entities/Monster.js';
import { MONSTER_BY_ID } from '../data/monsters.js';

export const ASCENT_STATE = {
  INTRO: 'intro',
  SPAWNING: 'spawning',
  FIGHT: 'fight',
  BREATHER: 'breather',
  CLEARED: 'cleared',
  DEFEAT: 'defeat',
};

export default class AscentSystem {
  constructor(scene) {
    this.scene = scene;
    this.state = ASCENT_STATE.INTRO;
    this.cfg = null;
    this.waveIndex = -1;
    this.queue = [];
    this.spawnTimer = 0;
    this.breather = 0;
    this.deathTimer = 0;
    this.elapsed = 0;
    this.killed = 0;
  }

  /** Loads a floor without starting it — the intro banner sits in between. */
  configure(cfg) {
    this.cfg = cfg;
    this.state = ASCENT_STATE.INTRO;
    this.waveIndex = -1;
    this.queue = [];
    this.spawnTimer = 0;
    this.breather = 0;
    this.deathTimer = 0;
    this.elapsed = 0;
    this.killed = 0;
  }

  begin() {
    if (!this.cfg) return;
    this.elapsed = 0;
    this.#startWave(0);
    this.scene.events.emit('ascent-begin');
  }

  // ── readouts the HUD asks for ──
  get running() {
    return this.state === ASCENT_STATE.SPAWNING
      || this.state === ASCENT_STATE.FIGHT
      || this.state === ASCENT_STATE.BREATHER;
  }

  get finished() {
    return this.state === ASCENT_STATE.CLEARED || this.state === ASCENT_STATE.DEFEAT;
  }

  get waveCount() {
    return this.cfg?.waves.length ?? 0;
  }

  /** 1-based, and never 0 — the banner reads "WAVE 1/3" before the first spawn. */
  get waveNumber() {
    return Math.min(this.waveCount, Math.max(1, this.waveIndex + 1));
  }

  get pending() {
    return this.queue.length;
  }

  get monstersLeft() {
    return this.scene.monsters.filter((m) => m.alive).length + this.queue.length;
  }

  get isFinalWave() {
    return this.waveIndex >= this.waveCount - 1;
  }

  /** Ascent's answer to BattleSystem.inDanger: your own health, not your wallet. */
  get inDanger() {
    const { hero } = this.scene;
    return !!hero?.alive && hero.hpPct < 0.28;
  }

  /** One line of state for the HUD, phrased for the player. */
  get phaseLabel() {
    if (this.state === ASCENT_STATE.BREATHER) return `WAVE ${this.waveNumber + 1} INCOMING`;
    if (this.state === ASCENT_STATE.SPAWNING) return 'BREACHING';
    if (this.state === ASCENT_STATE.FIGHT) return this.isFinalWave ? 'FINAL WAVE' : 'FIGHT';
    return 'HOLD';
  }

  // ═══ frame ═══════════════════════════════════════════════════════════════
  update(dt) {
    if (!this.running) return;
    this.elapsed += dt;

    // ── defeat: the mode's one loss condition ──
    const { hero } = this.scene;
    if (!hero || !hero.alive) {
      this.deathTimer += dt;
      if (this.deathTimer > PLAYER.deathDelay) this.#finish(ASCENT_STATE.DEFEAT);
      return;
    }

    this.#drainQueue(dt);

    if (this.state === ASCENT_STATE.BREATHER) {
      this.breather -= dt;
      if (this.breather <= 0) this.#startWave(this.waveIndex + 1);
      return;
    }

    if (this.state === ASCENT_STATE.SPAWNING && !this.queue.length) {
      this.state = ASCENT_STATE.FIGHT;
    }

    if (this.state !== ASCENT_STATE.FIGHT) return;
    if (this.scene.monsters.some((m) => m.alive)) return;

    if (this.isFinalWave) {
      this.#finish(ASCENT_STATE.CLEARED);
      return;
    }
    this.state = ASCENT_STATE.BREATHER;
    this.breather = PLAYER.breatherSeconds;
    this.scene.ui?.flashHint(`Wave cleared — ${this.waveCount - this.waveNumber} to go`);
  }

  #finish(state) {
    this.state = state;
    this.scene.events.emit(state === ASCENT_STATE.CLEARED ? 'ascent-cleared' : 'ascent-defeat');
  }

  // ═══ waves ═══════════════════════════════════════════════════════════════
  #startWave(index) {
    const wave = this.cfg.waves[index];
    if (!wave) { this.#finish(ASCENT_STATE.CLEARED); return; }

    this.waveIndex = index;
    this.state = ASCENT_STATE.SPAWNING;
    this.spawnTimer = 0;

    // The elite leads: it arrives first so the player reads the wave's shape
    // before the escort is on top of them.
    const ids = wave.elite ? [wave.elite, ...wave.spawns] : [...wave.spawns];
    this.queue = ids.map((id, i) => ({
      id,
      elite: !!wave.elite && i === 0,
      ...this.#entryPoint(i, ids.length),
    }));

    this.scene.fx.screenFlash(0xff7a3d, 0.12, 200);
    this.scene.ui?.flashHint(wave.elite
      ? `WAVE ${index + 1} — an elite ${MONSTER_BY_ID[wave.elite].short} leads it`
      : `WAVE ${index + 1} of ${this.waveCount}`);
  }

  /**
   * Entry points are spread along the far edge and the two flanks, so a wave
   * arrives as a front rather than a single stack the player can stand beside.
   */
  #entryPoint(i, count) {
    const b = this.scene.arenaBounds ?? ARENA;
    const inset = 46;
    if (i % 5 === 3) return { x: b.x + inset, y: b.y + 90 + (i * 37) % 140 };
    if (i % 5 === 4) return { x: b.right - inset, y: b.y + 90 + (i * 53) % 140 };
    const span = b.right - b.x - inset * 4;
    const t = count <= 1 ? 0.5 : (i + 0.5) / count;
    return { x: b.x + inset * 2 + span * t, y: b.y + 26 + (i % 2) * 30 };
  }

  #drainQueue(dt) {
    if (!this.queue.length) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = PLAYER.spawnStagger;
    this.#spawn(this.queue.shift());
  }

  #spawn(order) {
    const base = MONSTER_BY_ID[order.id];
    if (!base) return;

    const monster = new Monster(this.scene, this.#scaledDef(base, order.elite),
      order.x, order.y);
    if (order.elite) {
      // Presentation only — the stat bump is already baked into the def clone.
      monster.visualScale *= PLAYER.eliteScale;
      monster.sprite.setScale(monster.visualScale);
      monster.barWidth = 34;
      this.scene.fx.popText(order.x, order.y - 40, 'ELITE', 0xff7a3d);
      this.scene.fx.screenFlash(0xff3b4e, 0.18, 260);
    }

    this.scene.monsters.push(monster);
    this.scene.skills.onMonsterSummoned(monster);
    this.scene.events.emit('monster-summoned', monster);
  }

  /**
   * Per-floor scaling lives in a def *clone* rather than in Monster's constructor:
   * everything downstream (skills, inspector, death text, tint) reads `def`, and a
   * clone keeps all of it working without threading a multiplier through the
   * entity layer. `id`, `art` and the skill blocks are untouched, so SkillSystem's
   * executor registry still resolves normally.
   */
  #scaledDef(base, elite) {
    const hp = base.hp * (this.cfg.monsterHpMult ?? 1) * (elite ? PLAYER.eliteHpMult : 1);
    const atk = base.atk * (this.cfg.monsterAtkMult ?? 1) * (elite ? PLAYER.eliteAtkMult : 1);
    return {
      ...base,
      hp: Math.round(hp),
      atk: Math.round(atk * 10) / 10,
      name: elite ? `Elite ${base.name}` : base.name,
      short: elite ? `Elite ${base.short}` : base.short,
    };
  }

  reset() {
    this.configure(this.cfg);
  }
}
