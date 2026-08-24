/**
 * GameScene — wires the systems together and owns the update order.
 *
 * It holds no gameplay rules itself: floors come from TowerSystem, resources
 * from ManaSystem, behaviour from the two AI modules, readability from
 * TelegraphSystem, and presentation from UISystem/FxSystem.
 */

import { ARENA, COLORS, DEPTH, HERO_ZONE } from '../config.js';
import Hero from '../entities/Hero.js';
import HeroAI from '../ai/HeroAI.js';
import MonsterAI from '../ai/MonsterAI.js';
import BattleSystem from '../systems/BattleSystem.js';
import CombatSystem from '../systems/CombatSystem.js';
import FxSystem from '../systems/FxSystem.js';
import ManaSystem from '../systems/ManaSystem.js';
import SkillSystem from '../systems/SkillSystem.js';
import SummonSystem from '../systems/SummonSystem.js';
import TelegraphSystem from '../systems/TelegraphSystem.js';
import TowerSystem from '../systems/TowerSystem.js';
import UltimateSystem from '../systems/UltimateSystem.js';
import UISystem from '../ui/UISystem.js';
import Economy from '../economy/Economy.js';
import { HEROES } from '../data/heroes.js';
import { MONSTER_BY_ID, ROLE_LABEL } from '../data/monsters.js';

const MAX_DT = 1 / 20; // clamp so a tab-out can never teleport the simulation

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  create() {
    /** Battle clock in seconds, advanced by *scaled* dt (hitstop-aware). */
    this.clock = 0;
    this.monsters = [];
    this.hero = null;

    this.arenaBounds = {
      x: ARENA.x, y: ARENA.y, right: ARENA.right, bottom: ARENA.bottom,
    };

    this.#drawArena();

    // order matters: fx first (entities report through it), ui last
    this.economy = new Economy();
    this.fx = new FxSystem(this);
    this.mana = new ManaSystem(this);
    this.telegraph = new TelegraphSystem(this);
    this.combat = new CombatSystem(this);
    this.skills = new SkillSystem(this);
    this.ultimate = new UltimateSystem(this);
    this.battle = new BattleSystem(this);
    this.tower = new TowerSystem(this);
    this.summon = new SummonSystem(this);
    this.monsterAI = new MonsterAI(this);
    this.heroAI = new HeroAI(this);
    this.ui = new UISystem(this);

    this.events.on('battle-victory', () => this.#onVictory());
    this.events.on('battle-defeat', () => this.#onDefeat());
    this.events.on('selection-changed', (id) => {
      const def = MONSTER_BY_ID[id];
      if (def) this.ui.flashHint(`${def.name} selected — ${def.cost} mana`);
    });

    this.startFloor();
  }

  // ═══ floor lifecycle ═════════════════════════════════════════════════════
  startFloor() {
    const cfg = this.tower.config;

    // tear down anything left from the previous attempt
    for (const m of this.monsters) m.destroy();
    this.monsters = [];
    this.hero?.destroy();
    this.hero = null;
    this.telegraph.reset();
    this.combat.reset();
    this.ultimate.reset();
    document.body.classList.remove('danger');

    this.mana.configure(cfg);
    this.summon.configure(cfg);
    this.summon.reset();
    this.ui.buildCards(cfg.unlockedMonsters);

    const def = HEROES[cfg.heroId];
    this.hero = new Hero(
      this, def, cfg,
      ARENA.cx,
      ARENA.cy + 24,
    );
    this.ui.el.heroName.textContent = def.name.toUpperCase();

    this.battle.toIntro();
    this.ui.setDefaultHint('Select a monster (or press 1–5), then click anywhere on the battlefield.');
    this.#showIntroBanner(cfg, def);
  }

  #showIntroBanner(cfg, heroDef) {
    const skills = heroDef.skills
      .filter((s) => cfg.floor >= s.minFloor)
      .map((s) => s.name);
    const roster = cfg.unlockedMonsters
      .map((id) => `<b>${MONSTER_BY_ID[id].short}</b> <span class="dim">(${ROLE_LABEL[MONSTER_BY_ID[id].role]})</span>`)
      .join(' · ');

    this.ui.showBanner({
      title: `FLOOR ${cfg.floor} — ${cfg.title.toUpperCase()}`,
      sub: `<em>${heroDef.name}</em> — ${cfg.brief}<br>
            Kit: Slash · ${skills.join(' · ')} · <em>Judgment</em> (ultimate)<br><br>
            Roster: ${roster}<br>
            Essence budget: <b>${cfg.essencePool}</b> · Place monsters freely anywhere on the battlefield<br><br>
            <span class="dim">Watch the wind-up colours — red AoE, yellow buff, purple control.
            A telegraphing skill can be cancelled by summoning the Swamp Toad.</span>`,
      button: 'BEGIN',
      onAction: () => {
        this.ui.hideBanner();
        this.battle.begin();
      },
    });
  }

  #onVictory() {
    const reward = this.tower.clearFloor();
    const last = this.tower.isFinalFloor;
    const survivors = this.monsters.filter((m) => m.alive).length;

    this.fx.screenFlash(0x8bffd8, 0.3, 240);
    this.ui.showBanner({
      title: last ? 'TOWER CLEARED' : 'FLOOR CLEARED',
      tone: 'victory',
      sub: `Survivors: <b>${survivors}</b> · Essence left: <b>${Math.ceil(this.mana.pool)}</b><br>
            Reward: <b>${reward.soft}</b> soft${reward.hard ? ` · <b>${reward.hard}</b> hard` : ''}
            <span class="dim">(banked for the meta layer)</span>`,
      button: last ? 'NEW RUN' : 'NEXT FLOOR',
      onAction: () => {
        if (last) this.tower.resetRun();
        else this.tower.advance();
        this.ui.hideBanner();
        this.startFloor();
      },
    });
  }

  #onDefeat() {
    const lives = this.tower.loseLife();
    const over = lives <= 0;

    this.fx.screenFlash(0xff3b4e, 0.34, 260);
    this.ui.showBanner({
      title: 'DEFEATED',
      tone: 'defeat',
      sub: over
        ? `The tower holds. <b>Floor ${this.tower.floor}</b> was as far as you got.<br>
           <span class="dim">Out of essence with nothing left on the field.</span>`
        : `Out of essence with nothing left alive.<br>
           Attempts remaining: <b>${lives}</b><br><br>
           <span class="dim">Try spending earlier — idle essence still drains, and a
           Toad held in reserve can delete the ultimate outright.</span>`,
      button: over ? 'NEW RUN' : 'RETRY FLOOR',
      onAction: () => {
        if (over) this.tower.resetRun();
        this.ui.hideBanner();
        this.startFloor();
      },
    });
  }

  // ═══ update ══════════════════════════════════════════════════════════════
  update(_time, delta) {
    const realDt = Math.min(delta / 1000, MAX_DT);
    this.fx.update(realDt);
    const dt = realDt * this.fx.timeScale;

    if (this.battle.running) {
      this.clock += dt;

      this.mana.update(dt);
      this.telegraph.update(dt);
      this.heroAI.update(dt);
      this.monsterAI.update(dt);
      this.skills.update(dt);
      this.combat.update(dt);
      this.hero?.update(dt);
      this.battle.update(dt);
    } else {
      // keep sprites/rings coherent while a banner is up
      this.hero?.syncSprite();
      this.hero?.drawAggro();
      for (const m of this.monsters) m.syncSprite();
    }

    this.summon.update();
    this.ui.update();

    this.monsters = this.monsters.filter((m) => !m.destroyed);
  }

  // ═══ arena backdrop ══════════════════════════════════════════════════════
  #drawArena() {
    const g = this.add.graphics().setDepth(DEPTH.floor);

    // outer wall
    g.fillStyle(COLORS.wall, 1);
    g.fillRect(0, 0, ARENA.right + ARENA.x, ARENA.bottom + 128);

    // floor plate
    g.fillStyle(COLORS.floorDark, 1);
    g.fillRect(ARENA.x, ARENA.y, ARENA.w, ARENA.h);

    // 24px checker so movement and distance read clearly
    g.fillStyle(COLORS.floorLight, 1);
    const t = 24;
    for (let y = 0; y * t < ARENA.h; y++) {
      for (let x = 0; x * t < ARENA.w; x++) {
        if ((x + y) % 2 !== 0) continue;
        g.fillRect(
          ARENA.x + x * t,
          ARENA.y + y * t,
          Math.min(t, ARENA.w - x * t),
          Math.min(t, ARENA.h - y * t),
        );
      }
    }

    // central hero domain — the player may still summon anywhere on the floor
    g.fillStyle(0x2a1c2e, 0.5);
    g.fillRect(HERO_ZONE.x, ARENA.y, HERO_ZONE.w, ARENA.h);
    g.lineStyle(1, 0x5a3a52, 0.6);
    g.strokeRect(HERO_ZONE.x, ARENA.y, HERO_ZONE.w, ARENA.h);

    // frame
    g.lineStyle(2, 0x0b0912, 1);
    g.strokeRect(ARENA.x - 1, ARENA.y - 1, ARENA.w + 2, ARENA.h + 2);

    this.add.text(HERO_ZONE.x + 6, ARENA.y + 5, 'HERO DOMAIN', {
      fontFamily: 'monospace', fontSize: '8px', color: '#6b4a63',
    }).setDepth(DEPTH.floor + 1);

    this.add.text(ARENA.x + 8, ARENA.y + 5, 'SUMMON ANYWHERE', {
      fontFamily: 'monospace', fontSize: '8px', color: '#39d4a0',
    }).setDepth(DEPTH.floor + 1).setAlpha(0.7);
  }
}
