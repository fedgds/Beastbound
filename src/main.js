/**
 * Entry point. Phaser is loaded from the CDN in index.html, so it is a global
 * here rather than an import — that keeps the project buildless and directly
 * static-hostable (spec §8, §12).
 */

import { GAME_H, GAME_W } from './config.js';
import BootScene from './scenes/BootScene.js';
import GameScene from './scenes/GameScene.js';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: GAME_W,
  height: GAME_H,
  backgroundColor: '#0b0912',
  pixelArt: true,
  roundPixels: true,
  // No physics: movement and hit tests are manual dt maths, which stays
  // deterministic and lets FxSystem's hitstop scale gameplay time directly.
  scale: {
    mode: Phaser.Scale.NONE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  scene: [BootScene, GameScene],
});

// handy for poking at state from the console during tuning
window.game = game;
