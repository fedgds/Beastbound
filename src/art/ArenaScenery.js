/**
 * ArenaScenery — assembles one dungeon room and keeps it alive.
 *
 * Two halves:
 *   `build(theme)` stamps every static piece (wall, floor, decals, the carved
 *   seal, the near lip) into a single RenderTexture. After that the whole room
 *   costs one draw call, no matter how many thousand tiles went into it.
 *
 *   `update(dt)` runs only what must move: torch flames, the light they throw,
 *   embers, drifting dust, banner sway, and the pulse that travels around the
 *   seal. It takes *real* dt, so the room keeps breathing during hitstop.
 */

import { ARENA, DEPTH, GAME_H, GAME_W, HERO_ZONE, TILE, WALL } from '../config.js';
import { ARENA_KEYS as K, FLAME_FRAMES, bakeThemeTextures } from './ArenaTiles.js';
import {
  P, bakeRadial, dither, ditherRampV, dot, hash2, lighten, px, rng, snap,
} from './PixelDraw.js';

const COLS = Math.round(ARENA.w / TILE.w); // 20
const ROWS = Math.round(ARENA.h / TILE.h); // 8

/** The wall is divided into five bays. Pilasters split them, torches centre them. */
const BAYS = 5;
const PILASTER_X = Array.from({ length: BAYS + 1 },
  (_, i) => snap(ARENA.x + (ARENA.w * i) / BAYS));
const TORCH_X = Array.from({ length: BAYS },
  (_, i) => snap(ARENA.x + (ARENA.w * (i + 0.5)) / BAYS));
/** Alcoves tuck into the outer bays, clear of both torch and pilaster. */
const ALCOVE_X = [snap(TORCH_X[0] - 60), snap(TORCH_X[BAYS - 1] + 60)];
/** Cloth hangs on the interior pilasters — the only place you'd nail a rail. */
const BANNER_SLOTS = PILASTER_X.slice(1, -1);

/** Picks `n` slots from the middle outward, so fewer banners stay centred. */
function centred(slots, n) {
  if (n >= slots.length) return slots.slice();
  const drop = slots.length - n;
  const start = Math.floor(drop / 2);
  return slots.slice(start, start + n);
}

/** Graphics that never touches the display list — a scratch pad for bakes. */
const scratch = (scene) => new Phaser.GameObjects.Graphics(scene);

/**
 * How bright each floor row is. The torches hang on the back wall, so row 1 sits
 * in the middle of their pools and the near rows fall away. Discrete per-row
 * tones are how a tileset lights a room — a dithered ramp over this much area
 * just reads as a checkerboard. Row 0 is only slightly dim because the wall
 * already casts a hard shadow across it.
 */
const ROW_LIGHT = [0.82, 1, 0.96, 0.9, 0.83, 0.75, 0.67, 0.58];

/** 0xRRGGBB multiply tint for a brightness in 0..1, quantised to 12 steps. */
function shade(b) {
  const q = Math.round(Math.max(0.2, Math.min(1, b)) * 12) / 12;
  const v = Math.round(255 * q);
  return (v << 16) | (v << 8) | v;
}

/**
 * How strongly the torches light a point at this x, 0..1.
 *
 * `reach` has to be meaningfully *shorter* than the gap between torches or the
 * pools overlap into flat ambient light and the tint stops reading as lighting.
 * The bays are 224px apart, so anything past ~180 flattens out.
 */
function torchFalloff(x, reach) {
  let near = 0;
  for (const tx of TORCH_X) {
    const d = Math.abs(x - tx) / reach;
    near = Math.max(near, 1 - d * d);
  }
  return Math.max(0, near);
}

export class ArenaScenery {
  constructor(scene) {
    this.scene = scene;
    this.theme = null;
    this.t = 0;

    this.parts = []; // everything destroyed on rebuild
    this.torches = [];
    this.banners = [];
    this.shafts = [];
    this.motes = [];
    this.embers = [];
    this.runes = [];
    this.mask = null;
    this.maskGfx = null;
  }

  /* ══ build ═══════════════════════════════════════════════════════════════ */

  build(theme) {
    this.#teardown();
    this.theme = theme;
    const scene = this.scene;

    bakeThemeTextures(scene, theme);
    bakeRadial(scene, 'ar_pool', 256, { steps: 6, power: 2.3, inner: 0.02 });
    bakeRadial(scene, 'ar_core', 96, { steps: 5, power: 1.6, inner: 0.14 });
    bakeRadial(scene, 'ar_mote', 8, { steps: 3, power: 1.3, inner: 0.25 });
    this.#bakeVignette();
    this.#bakeShaft();

    this.#stampRoom(theme);
    this.#addSeal(theme);
    this.#addTorches(theme);
    this.#addBanners(theme);
    this.#addShafts(theme);
    this.#addMotes(theme);

    const vig = scene.add.image(0, 0, 'ar_vignette')
      .setOrigin(0, 0)
      .setDepth(DEPTH.vignette);
    this.parts.push(vig);
  }

  /* ── the static bake ─────────────────────────────────────────────────── */

  #stampRoom(theme) {
    const scene = this.scene;
    const id = theme.id;
    const rand = rng(0xa11ce + id.length * 104729);

    const rt = scene.add.renderTexture(0, 0, GAME_W, GAME_H)
      .setOrigin(0, 0)
      .setDepth(DEPTH.floor);
    this.parts.push(rt);

    const g = scratch(scene);
    const flush = () => { rt.draw(g); g.clear(); };

    // ── the void the room sits in
    px(g, 0, 0, GAME_W, GAME_H, 0x07060c, 1);
    flush();

    // ── back wall, full canvas width so no HUD edge ever reveals a seam.
    // Each column is tinted by how close it sits to a torch, so the light in
    // the room comes from somewhere rather than being ambient. The wall takes
    // the widest swing of anything in the room — it's the surface the torches
    // are actually bolted to.
    for (let x = 0; x < GAME_W; x += TILE.w) {
      const b = 0.34 + 0.66 * torchFalloff(x + TILE.w / 2, 150);
      rt.drawFrame(K.wall(id, Math.floor(hash2(x, 0, 11) * 4)), '__BASE',
        x, WALL.y, 1, shade(b));
    }
    for (let x = 0; x < GAME_W; x += TILE.w) {
      rt.drawFrame(K.cap(id), '__BASE', x, WALL.y - 8, 1,
        shade(0.3 + 0.6 * torchFalloff(x + TILE.w / 2, 170)));
    }
    for (const x of ALCOVE_X) rt.draw(K.alcove(id), x - 20, WALL.y + 22);
    for (const x of PILASTER_X) {
      rt.drawFrame(K.pilaster(id), '__BASE', x - 14, WALL.y - 6, 1,
        shade(0.4 + 0.6 * torchFalloff(x, 165)));
    }

    // ── floor: 20 x 8 flagstones. Variant per cell breaks the grid; tint per
    // cell puts the room in the torchlight. The floor swings less than the wall
    // — units have to stay readable wherever they stand.
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cx = ARENA.x + c * TILE.w + TILE.w / 2;
        const b = ROW_LIGHT[r] * (0.66 + 0.42 * torchFalloff(cx, 175));
        rt.drawFrame(K.slab(id, Math.floor(hash2(c, r, 7) * 6)), '__BASE',
          ARENA.x + c * TILE.w, ARENA.y + r * TILE.h, 1, shade(b));
      }
    }

    // ── decor: everything this room has lived through
    const scatter = (key, count, pad = 20) => {
      for (let i = 0; i < count; i++) {
        rt.draw(key,
          snap(ARENA.x + pad + rand() * (ARENA.w - pad * 2)),
          snap(ARENA.y + pad + rand() * (ARENA.h - pad * 2)));
      }
    };
    const d = theme.decor;
    for (let i = 0; i < 3; i++) {
      scatter(K.stain(id, i), Math.round(d.stain / 3));
      scatter(K.moss(id, i), Math.round(d.moss / 3));
      scatter(K.rubble(id, i), Math.round(d.rubble / 3));
    }
    scatter(K.grate(id), d.grate, 70);
    scatter(K.chain(id), d.chain, 40);

    // cracks ignore slab seams — that's the point, so they're drawn free-hand
    g.fillStyle(theme.grout, 0.9);
    for (let i = 0; i < d.crack; i++) {
      let cx = ARENA.x + 30 + rand() * (ARENA.w - 60);
      let cy = ARENA.y + 30 + rand() * (ARENA.h - 60);
      let a = rand() * Math.PI * 2;
      const len = 22 + Math.floor(rand() * 26);
      for (let s = 0; s < len; s++) {
        a += (rand() - 0.5) * 0.7;
        cx += Math.cos(a) * P;
        cy += Math.sin(a) * P;
        g.fillRect(snap(cx), snap(cy), P, P);
      }
    }
    flush();

    // ── moss creeps out of the wall/floor joint on damp floors
    if (d.moss > 0) {
      for (let x = ARENA.x; x < ARENA.right; x += 6) {
        const n = hash2(x, 3, 5);
        if (n > 0.45) continue;
        dither(g, x, ARENA.y, P * 2, 2 + Math.floor(n * 10), theme.accent, 0.6 + n);
      }
      flush();
    }

    // ── the hero's ground, marked by two carved boundary grooves
    for (const bx of [HERO_ZONE.x, HERO_ZONE.x + HERO_ZONE.w]) {
      for (let y = ARENA.y + 6; y < ARENA.bottom - 8; y += 12) {
        px(g, bx, y, P, 8, theme.grout, 0.9);
        px(g, bx + P, y + P, P, 8, lighten(theme.stone3, 0.25), 0.35);
      }
    }
    flush();

    // ── the wall's cast shadow: the strongest depth cue in the room.
    // Power-curved, not linear: a linear ramp lingers around 50% coverage, and
    // 50% ordered dither is a checkerboard, which reads as fabric, not shadow.
    const csh = 40;
    for (let i = 0; i * P < csh; i++) {
      const a = Math.pow(1 - (i * P) / csh, 2.2) * 0.82;
      if (a < 0.02) continue;
      dither(g, 0, ARENA.y + i * P, GAME_W, P, 0x000000, a);
    }
    // the near rows already carry their own tone from ROW_LIGHT, so nothing
    // else is layered here — a second pass would only add pattern
    flush();

    // ── side walls down the left and right margins
    for (let y = WALL.y; y < ARENA.bottom; y += TILE.h) {
      rt.draw(K.side(id), 0, y);
      rt.draw(K.side(id), GAME_W - 14, y);
    }

    // ── foreground lip the camera looks over
    for (let x = 0; x < GAME_W; x += TILE.w) rt.draw(K.lip(id), x, ARENA.bottom - 8);

    // ── above the wall is out of frame; keep it black behind the HUD
    px(g, 0, 0, GAME_W, WALL.y - 8, 0x07060c, 1);
    flush();

    g.destroy();
  }

  /* ── the carved seal that marks the hero's ground ────────────────────── */

  #addSeal(theme) {
    const scene = this.scene;
    const R = Math.round(HERO_ZONE.w / 2) - 8;
    const SQUASH = 0.6; // the floor recedes, so the seal reads as an ellipse
    const key = `ar_${theme.id}_seal`;
    const cx = snap(ARENA.cx);
    const cy = snap(ARENA.cy + 30);

    if (!scene.textures.exists(key)) {
      const g = scratch(scene);
      const S = R * 2 + 8;
      const o = S / 2;
      const oy = R * SQUASH + 4;

      // a chiselled groove: dark cut with a lit lip on the near side
      const carve = (radius, thick, ratio) => {
        for (let a = 0; a < Math.PI * 2; a += 0.007) {
          const c = Math.cos(a);
          const s = Math.sin(a);
          for (let k = 0; k < thick; k += P) {
            dither(g, o + c * (radius + k), oy + s * (radius + k) * SQUASH,
              P, P, theme.grout, ratio);
          }
          dot(g, o + c * (radius - P), oy + s * (radius - P) * SQUASH - P,
            lighten(theme.stone3, 0.35), 0.4);
        }
      };
      carve(R, P * 2, 0.95);
      carve(R - 24, P * 2, 0.8);
      carve(R - 28, P, 0.45);

      // eight spokes tying the two rings together
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        for (let rr = R - 28; rr < R; rr += P) {
          dot(g, o + Math.cos(a) * rr, oy + Math.sin(a) * rr * SQUASH, theme.grout, 0.85);
        }
      }
      g.generateTexture(key, S, snap(oy * 2 + 8));
      g.destroy();
    }

    const seal = scene.add.image(cx, cy, key).setDepth(DEPTH.floorDecal);
    this.parts.push(seal);

    // 12 rune marks on the rim; a pulse of light runs around them
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const rune = scene.add.image(
        snap(cx + Math.cos(a) * (R - 14)),
        snap(cy + Math.sin(a) * (R - 14) * SQUASH),
        'ar_core',
      )
        .setDepth(DEPTH.floorDecal)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDisplaySize(22, 15)
        .setTint(theme.seal)
        .setAlpha(0.08);
      rune.__phase = i / 12;
      this.runes.push(rune);
      this.parts.push(rune);
    }
  }

  /* ── torches ─────────────────────────────────────────────────────────── */

  #addTorches(theme) {
    const scene = this.scene;
    const id = theme.id;
    const y = WALL.y + WALL.h - 30;

    TORCH_X.forEach((x, i) => {
      const sconce = scene.add.image(x, y, K.sconce(id)).setDepth(4);
      const flame = scene.add.image(x, y - 10, K.flame(id, 0))
        .setOrigin(0.5, 1)
        .setDepth(5)
        .setBlendMode(Phaser.BlendModes.ADD);

      // tight halo on the flame itself
      const core = scene.add.image(x, y - 22, 'ar_core')
        .setDepth(3)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(theme.light)
        .setDisplaySize(84, 84);

      // the pool it throws on the stone — squashed, because the floor recedes
      const pool = scene.add.image(x, ARENA.y + 62, 'ar_pool')
        .setDepth(DEPTH.floorDecal)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(theme.light)
        .setDisplaySize(300, 190);

      // a wider, fainter wash that also falls on whatever is standing there
      const wash = scene.add.image(x, ARENA.y + 120, 'ar_pool')
        .setDepth(DEPTH.light)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(theme.light)
        .setDisplaySize(460, 320);

      this.parts.push(sconce, flame, core, pool, wash);
      this.torches.push({
        x, y, flame, core, pool, wash,
        frame: i % FLAME_FRAMES,
        acc: 0,
        seed: i * 2.39996, // golden-angle offsets: no two torches ever sync
        emberAcc: 0.4 + i * 0.17,
      });
    });
  }

  /* ── banners ─────────────────────────────────────────────────────────── */

  #addBanners(theme) {
    if (!theme.banners) return;
    const scene = this.scene;
    centred(BANNER_SLOTS, theme.banners.count).forEach((x, i) => {
      const b = scene.add.image(x, WALL.y + 4, K.banner(theme.id, 0))
        .setOrigin(0.5, 0)
        .setDepth(6);
      b.__phase = i * 0.9;
      this.banners.push(b);
      this.parts.push(b);
    });
  }

  /* ── light shafts (top floor only) ───────────────────────────────────── */

  #addShafts(theme) {
    if (!theme.shafts) return;
    const scene = this.scene;

    this.maskGfx = scratch(scene);
    this.maskGfx.fillStyle(0xffffff, 1);
    this.maskGfx.fillRect(ARENA.x, ARENA.y - 4, ARENA.w, ARENA.h - 6);
    this.mask = this.maskGfx.createGeometryMask();

    for (let i = 0; i < theme.shafts; i++) {
      const s = scene.add.image(
        snap(ARENA.x + ((i + 0.5) / theme.shafts) * ARENA.w),
        ARENA.y - 24,
        'ar_shaft',
      )
        .setOrigin(0.5, 0)
        .setDepth(DEPTH.light)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(theme.light)
        .setRotation(0.24)
        .setAlpha(0.09);
      s.setMask(this.mask);
      s.__phase = i * 1.3;
      this.shafts.push(s);
      this.parts.push(s);
    }
  }

  /* ── airborne dust ───────────────────────────────────────────────────── */

  #addMotes(theme) {
    const scene = this.scene;
    const rand = rng(0xd0d0 + theme.id.length);
    for (let i = 0; i < 46; i++) {
      const big = rand() < 0.25;
      const m = scene.add.image(0, 0, 'ar_mote')
        .setDepth(DEPTH.light)
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(theme.light)
        .setDisplaySize(big ? 6 : 4, big ? 6 : 4);
      m.__x = ARENA.x + rand() * ARENA.w;
      m.__y = ARENA.y - 30 + rand() * (ARENA.h + 30);
      m.__vx = (rand() - 0.5) * 9;
      m.__vy = -3 - rand() * 7;
      m.__phase = rand() * Math.PI * 2;
      m.__amp = 0.1 + rand() * 0.22;
      this.motes.push(m);
      this.parts.push(m);
    }
  }

  /* ══ theme-independent bakes ═════════════════════════════════════════════ */

  /**
   * Edge darkening. The curve matters more than the width: a linear dither ramp
   * spends most of its area near 50% coverage, which reads as a checkerboard
   * rather than as shadow. Raising it to a power keeps almost the whole ramp
   * sparse and only goes solid in the last few pixels.
   */
  #bakeVignette() {
    const scene = this.scene;
    if (scene.textures.exists('ar_vignette')) return;
    const g = scratch(scene);

    const ex = 44;
    for (let i = 0; i * P < ex; i++) {
      const a = Math.pow(1 - (i * P) / ex, 2.6) * 0.44;
      if (a < 0.02) continue;
      dither(g, i * P, 0, P, GAME_H, 0x000000, a);
      dither(g, GAME_W - (i + 1) * P, 0, P, GAME_H, 0x000000, a);
    }
    // a touch along the near edge, so the foreground lip sits in its own shadow
    const ey = 26;
    for (let i = 0; i * P < ey; i++) {
      const a = Math.pow(1 - (i * P) / ey, 2.2) * 0.42;
      if (a < 0.02) continue;
      dither(g, 0, ARENA.bottom - 8 - (i + 1) * P, GAME_W, P, 0x000000, a);
    }

    g.generateTexture('ar_vignette', GAME_W, GAME_H);
    g.destroy();
  }

  #bakeShaft() {
    const scene = this.scene;
    if (scene.textures.exists('ar_shaft')) return;
    const W = 88;
    const H = 440;
    const g = scratch(scene);
    for (let x = 0; x < W; x += P) {
      const across = Math.sin((x / W) * Math.PI);
      for (let y = 0; y < H; y += P) {
        const a = across * across * (1 - (y / H) * 0.85) * 0.95;
        if (a > 0.03) dither(g, x, y, P, P, 0xffffff, a);
      }
    }
    g.generateTexture('ar_shaft', W, H);
    g.destroy();
  }

  /* ══ per-frame ═══════════════════════════════════════════════════════════ */

  update(dt) {
    if (!this.theme) return;
    this.t += dt;
    const t = this.t;

    // ── torches: frame advance plus a two-sine flicker driving every light
    for (const tor of this.torches) {
      tor.acc += dt;
      if (tor.acc > 1 / 12) {
        tor.acc = 0;
        tor.frame = (tor.frame + 1) % FLAME_FRAMES;
        tor.flame.setTexture(K.flame(this.theme.id, tor.frame));
      }
      const f = 0.8
        + Math.sin(t * 7.3 + tor.seed) * 0.13
        + Math.sin(t * 17.1 + tor.seed * 3.1) * 0.07;
      // the baked tint carries the *shape* of the lighting; these add its colour
      // and its flicker, which a baked tint can't do
      tor.core.setAlpha(0.3 * f + 0.1).setScale(f * 0.9);
      tor.pool.setAlpha(0.2 * f + 0.05).setScale(1.14 + (f - 0.8) * 0.3);
      tor.wash.setAlpha(0.07 * f + 0.02);

      tor.emberAcc -= dt;
      if (tor.emberAcc <= 0) {
        tor.emberAcc = 0.35 + Math.random() * 0.7;
        this.#spawnEmber(tor);
      }
    }

    // ── embers rise, cool, wink out
    for (let i = this.embers.length - 1; i >= 0; i--) {
      const e = this.embers[i];
      e.life -= dt;
      if (e.life <= 0) {
        e.img.destroy();
        this.embers.splice(i, 1);
        continue;
      }
      e.vy += 6 * dt; // buoyancy fades as it cools
      e.x += Math.sin(t * 4 + e.seed) * 9 * dt;
      e.y += e.vy * dt;
      e.img.setPosition(snap(e.x), snap(e.y)).setAlpha((e.life / e.max) * 0.9);
    }

    // ── dust drifting through the light
    for (const m of this.motes) {
      m.__x += m.__vx * dt;
      m.__y += m.__vy * dt;
      if (m.__y < ARENA.y - 40) {
        m.__y = ARENA.bottom + 10;
        m.__x = ARENA.x + Math.random() * ARENA.w;
      }
      if (m.__x < ARENA.x) m.__x = ARENA.right;
      else if (m.__x > ARENA.right) m.__x = ARENA.x;
      m.setPosition(snap(m.__x), snap(m.__y));
      m.setAlpha(m.__amp * (0.55 + 0.45 * Math.sin(t * 2.1 + m.__phase)));
    }

    // ── cloth sways on a slow 4-frame cycle
    for (const b of this.banners) {
      b.setTexture(K.banner(this.theme.id, Math.floor((t * 1.6 + b.__phase) % 4)));
    }

    // ── shafts breathe; the dust crossing them is what sells the volume
    for (const s of this.shafts) {
      s.setAlpha(0.07 + 0.04 * Math.sin(t * 0.55 + s.__phase));
    }

    // ── one pulse travels around the seal every 3.2s
    const head = (t / 3.2) % 1;
    for (const r of this.runes) {
      let d = Math.abs(head - r.__phase);
      if (d > 0.5) d = 1 - d;
      const near = Math.max(0, 1 - d * 7);
      r.setAlpha(0.06 + near * near * 0.5).setScale(0.9 + near * 0.5);
    }
  }

  #spawnEmber(tor) {
    const max = 1.1 + Math.random() * 0.9;
    const img = this.scene.add.image(tor.x, tor.y - 24, 'ar_mote')
      .setDepth(DEPTH.light)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setTint(this.theme.flame)
      .setDisplaySize(4, 4);
    this.embers.push({
      img,
      x: tor.x + (Math.random() - 0.5) * 8,
      y: tor.y - 24,
      vy: -22 - Math.random() * 14,
      seed: Math.random() * 9,
      life: max,
      max,
    });
  }

  /* ══ lifecycle ═══════════════════════════════════════════════════════════ */

  #teardown() {
    for (const p of this.parts) p.destroy();
    for (const e of this.embers) e.img.destroy();
    if (this.mask) this.mask.destroy();
    if (this.maskGfx) this.maskGfx.destroy();
    this.parts = [];
    this.torches = [];
    this.banners = [];
    this.shafts = [];
    this.motes = [];
    this.embers = [];
    this.runes = [];
    this.mask = null;
    this.maskGfx = null;
  }

  destroy() {
    this.#teardown();
    this.theme = null;
  }
}

export default ArenaScenery;
