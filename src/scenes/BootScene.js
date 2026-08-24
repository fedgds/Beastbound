/**
 * BootScene — bakes placeholder textures and registers every animation state,
 * then hands off to GameScene.
 *
 * When real pixel art arrives (spec §10), the load calls go in preload() and
 * `registerAnims` switches to frame-index ranges; nothing else changes.
 */

import {
  ANIM_FPS, ANIM_FRAMES, ANIM_REPEAT, buildFxTextures, buildUnitTextures,
} from '../art/PlaceholderArt.js';

export default class BootScene extends Phaser.Scene {
  constructor() {
    super('Boot');
  }

  create() {
    const units = buildUnitTextures(this);
    buildFxTextures(this);
    this.registerAnims(units);
    this.scene.start('Game');
  }

  /** idle / move / windup / attack / hit / die for every unit (spec §5, §10). */
  registerAnims(units) {
    for (const [unitKey, states] of Object.entries(units)) {
      for (const [state, texKeys] of Object.entries(states)) {
        const key = `${unitKey}_${state}`;
        if (this.anims.exists(key)) continue;
        this.anims.create({
          key,
          frames: texKeys.map((k) => ({ key: k })),
          frameRate: ANIM_FPS[state] ?? 8,
          repeat: ANIM_REPEAT[state] ?? 0,
        });
        void ANIM_FRAMES;
      }
    }
  }
}
