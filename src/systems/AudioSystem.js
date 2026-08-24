/**
 * Tiny procedural sound bank. Browser oscillators keep the prototype
 * self-contained while still giving every unit/ability its own audio identity.
 * `unlock()` is called from a player click, satisfying autoplay policies.
 */
export default class AudioSystem {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  unlock() {
    if (!this.enabled) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    this.ctx ??= new Context();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(freq, duration = 0.1, type = 'square', gain = 0.045, slide = null) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const amp = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slide), now + duration);
    amp.gain.setValueAtTime(0.001, now);
    amp.gain.exponentialRampToValueAtTime(gain, now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(amp).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  playSkill(unit, skillId) {
    const tones = {
      provoke: [130, 0.22, 'sawtooth', 0.06, 76],
      recklessCharge: [105, 0.2, 'sawtooth', 0.07, 52],
      piercingArrow: [720, 0.14, 'square', 0.04, 1180],
      croakOfSilence: [210, 0.3, 'triangle', 0.06, 92],
      radiantBloom: [520, 0.28, 'sine', 0.05, 820],
      bloom: [610, 0.18, 'sine', 0.028, 760],
      shieldBash: [160, 0.18, 'square', 0.065, 90],
      whirlwind: [290, 0.22, 'sawtooth', 0.055, 610],
      valor: [420, 0.35, 'sine', 0.055, 760],
      judgment: [95, 0.5, 'sawtooth', 0.075, 38],
      bombard: [118, 0.25, 'sawtooth', 0.07, 48],
      lanceCharge: [145, 0.2, 'sawtooth', 0.06, 72],
      phaseStrike: [690, 0.25, 'sine', 0.05, 310],
      // Basic attacks have a separate timbre for each creature as well.
      golem: [125, 0.1, 'triangle', 0.04, 88],
      brute: [175, 0.08, 'sawtooth', 0.045, 120],
      sprite: [640, 0.07, 'square', 0.028, 880],
      toad: [245, 0.12, 'triangle', 0.035, 170],
      flower: [490, 0.1, 'sine', 0.026, 610],
      bombGoblin: [230, 0.08, 'square', 0.035, 170],
      skeletonRider: [160, 0.09, 'triangle', 0.04, 105],
      wraith: [530, 0.12, 'sine', 0.03, 390],
      goldenKnight: [155, 0.1, 'square', 0.045, 112],
    };
    const sound = tones[skillId ?? unit?.def?.id]
      ?? (unit?.isHero ? [180, 0.13, 'square', 0.04, 130] : [350, 0.09, 'square', 0.025, 280]);
    this.tone(...sound);
    // A bright overtone differentiates named abilities from basic attacks.
    if (skillId) this.tone(sound[0] * 2, Math.min(0.13, sound[1]), 'sine', sound[3] * 0.35);
  }

  playCombat(kind) {
    const sounds = {
      hit: [190, 0.055, 'square', 0.022, 150],
      crit: [380, 0.13, 'square', 0.05, 720],
      dodge: [700, 0.1, 'sine', 0.035, 980],
      block: [110, 0.12, 'triangle', 0.045, 80],
    };
    this.tone(...sounds[kind]);
  }
}
