/**
 * Entry point. Phaser is loaded from the CDN in index.html, so it is a global
 * here rather than an import — that keeps the project buildless and directly
 * static-hostable (spec §8, §12).
 */

import { GAME_H, GAME_W } from './config.js';
import BootScene from './scenes/BootScene.js';
import GameScene from './scenes/GameScene.js';

const CONFIG = {
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
};

/**
 * The stage is authored at a fixed 1152x672. Rather than letting it overflow on
 * a small window, scale it down to fit — never up, because pixel art enlarged by
 * a fractional factor shimmers. `image-rendering: pixelated` keeps the sampling
 * nearest-neighbour on the way down.
 */
function fitStage() {
  const pad = 16;
  const s = Math.min(
    1,
    (window.innerWidth - pad) / GAME_W,
    (window.innerHeight - pad) / GAME_H,
  );
  document.documentElement.style.setProperty('--fit', String(Math.max(0.2, s)));
}
fitStage();
window.addEventListener('resize', fitStage);

/**
 * Boot once the pixel webfonts have landed. Canvas text measures against
 * whatever font is loaded *at draw time* and does not reflow later, so floating
 * damage numbers baked before the font arrives would keep the fallback metrics
 * for the rest of the session. The race is capped so a blocked font CDN delays
 * the game by a moment rather than forever.
 */
function boot() {
  const game = new Phaser.Game(CONFIG);
  window.game = game; // handy for poking at state from the console during tuning
}

const fonts = document.fonts?.ready ?? Promise.resolve();
Promise.race([fonts, new Promise((r) => setTimeout(r, 1200))]).then(boot);
