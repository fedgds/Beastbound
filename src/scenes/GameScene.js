/**
 * GameScene — wires the systems together and owns the update order.
 *
 * It holds no gameplay rules itself: floors come from TowerSystem, resources
 * from ManaSystem, behaviour from the two AI modules, readability from
 * TelegraphSystem, and presentation from UISystem/FxSystem.
 */

import { ARENA, MANA, MODE } from '../config.js';
import ArenaScenery from '../art/ArenaScenery.js';
import Hero from '../entities/Hero.js';
import Monster from '../entities/Monster.js';
import HeroAI from '../ai/HeroAI.js';
import MonsterAI from '../ai/MonsterAI.js';
import PlayerController from '../ai/PlayerController.js';
import AscentSystem from '../systems/AscentSystem.js';
import BattleSystem from '../systems/BattleSystem.js';
import CombatSystem from '../systems/CombatSystem.js';
import FxSystem from '../systems/FxSystem.js';
import ManaSystem from '../systems/ManaSystem.js';
import SkillSystem from '../systems/SkillSystem.js';
import SummonSystem from '../systems/SummonSystem.js';
import TelegraphSystem from '../systems/TelegraphSystem.js';
import TowerSystem from '../systems/TowerSystem.js';
import UltimateSystem from '../systems/UltimateSystem.js';
import AudioSystem from '../systems/AudioSystem.js';
import UISystem from '../ui/UISystem.js';
import Economy from '../economy/Economy.js';
import { HEROES, HERO_STATE } from '../data/heroes.js';
import { MONSTERS, MONSTER_BY_ID, ROLE_LABEL } from '../data/monsters.js';
import { FLOORS } from '../data/floors.js';
import { ASCENT_FLOORS, ascentFloorSize } from '../data/ascentFloors.js';
import { themeForFloor } from '../data/arenaThemes.js';

const MAX_DT = 1 / 20; // clamp so a tab-out can never teleport the simulation

const LAB_FLOOR = {
  floor: 0, hpMult: 1, atkMult: 1, speedMult: 1, ultRateMult: 1,
};
const LAB_TARGET_FLOOR = { ...LAB_FLOOR, hpMult: 12, atkMult: 0.1 };
const LAB_DUMMY = {
  id: 'labDummy', name: 'Training Construct', short: 'Dummy', art: 'golem',
  role: 'tank', cost: 0, hp: 9999, atk: 0, speed: 0, range: 0,
  attackInterval: 99, hitRadius: 16, tint: '#8f78a8',
  combat: { crit: 0, dodge: 0, block: 0 }, passive: null, active: null,
};

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('Game');
  }

  create() {
    /** Battle clock in seconds, advanced by *scaled* dt (hitstop-aware). */
    this.clock = 0;
    this.monsters = [];
    this.hero = null;
    this.needsMainMenu = true;
    /** Which loop is live. See config.MODE — nothing keeps a second copy. */
    this.mode = MODE.DEFENSE;
    this.labKind = 'hero';
    this.labSelectedHeroId = 'goldenKnight';
    this.labSelectedMonsterId = 'golem';
    this.ascentHeroId = 'goldenKnight';

    this.arenaBounds = {
      x: ARENA.x, y: ARENA.y, right: ARENA.right, bottom: ARENA.bottom,
    };

    /** The room. Rebuilt per floor; owns every static and ambient visual. */
    this.arena = new ArenaScenery(this);

    // order matters: fx first (entities report through it), ui last
    this.economy = new Economy();
    this.fx = new FxSystem(this);
    this.audio = new AudioSystem();
    this.mana = new ManaSystem(this);
    this.telegraph = new TelegraphSystem(this);
    this.combat = new CombatSystem(this);
    this.skills = new SkillSystem(this);
    this.ultimate = new UltimateSystem(this);
    this.battle = new BattleSystem(this);
    this.ascent = new AscentSystem(this);
    this.tower = new TowerSystem(this);
    this.summon = new SummonSystem(this);
    this.monsterAI = new MonsterAI(this);
    this.heroAI = new HeroAI(this);
    this.player = new PlayerController(this);
    this.ui = new UISystem(this);

    this.events.on('battle-victory', () => this.#onVictory());
    this.events.on('battle-defeat', () => this.#onDefeat());
    this.events.on('ascent-cleared', () => this.#onAscentCleared());
    this.events.on('ascent-defeat', () => this.#onAscentDefeat());
    this.events.on('selection-changed', (id) => {
      const def = MONSTER_BY_ID[id];
      if (def) this.ui.flashHint(`${def.name} selected — ${def.cost} mana`);
    });

    this.startFloor();
  }

  /** Everything a fresh attempt has to forget, in either mode. */
  #clearField() {
    for (const m of this.monsters) m.destroy();
    this.monsters = [];
    this.hero?.destroy();
    this.hero = null;
    this.telegraph.reset();
    this.combat.reset();
    this.skills.reset();
    this.ultimate.reset();
    this.fx.resetDecals(); // the previous attempt's scorch marks go with it
    document.body.classList.remove('danger');
  }

  // ═══ floor lifecycle ═════════════════════════════════════════════════════
  startFloor() {
    this.mode = MODE.DEFENSE;
    if (this.tower.floors !== FLOORS) this.tower.setTrack(FLOORS);
    this.ui.setMode(MODE.DEFENSE);
    this.player.setEnabled(false);
    const cfg = this.tower.config;

    // dress the room before anything is placed in it
    this.arena.build(themeForFloor(cfg.floor));

    // tear down anything left from the previous attempt
    this.#clearField();

    this.mana.configure(cfg);
    this.summon.reset();
    this.ui.setFloor(cfg);

    const def = HEROES[cfg.heroId];
    this.hero = new Hero(
      this, def, cfg,
      ARENA.cx,
      ARENA.cy + 24,
    );
    // after the Hero exists: the dossier reads its unlocked skills
    this.ui.setHero(def);

    this.battle.toIntro();
    this.ui.setDefaultHint('Select a monster (or press 1–5), then click anywhere on the battlefield.');
    if (this.needsMainMenu) {
      this.needsMainMenu = false;
      this.ui.showMainMenu(() => {
        this.ui.hideMainMenu();
        this.#showRosterSelection(cfg, def);
      }, () => this.#enterSkillLab(), () => this.#enterAscent());
    } else {
      this.#showRosterSelection(cfg, def);
    }
  }

  #showRosterSelection(cfg, heroDef) {
    const defaults = [...cfg.unlockedMonsters];
    for (const def of MONSTERS) {
      if (defaults.length >= 5) break;
      if (!defaults.includes(def.id)) defaults.push(def.id);
    }
    this.ui.showRosterSelection(defaults, (roster) => {
      this.summon.configure({ ...cfg, unlockedMonsters: roster });
      this.ui.buildCards(roster);
      this.#showIntroBanner(cfg, heroDef, roster);
    });
  }

  #showIntroBanner(cfg, heroDef, rosterIds) {
    const skills = heroDef.skills.map((s) => s.name);
    const roster = rosterIds
      .map((id) => `<b>${MONSTER_BY_ID[id].short}</b> <span class="dim">(${ROLE_LABEL[MONSTER_BY_ID[id].role]})</span>`)
      .join(' · ');

    this.ui.showBanner({
      title: `FLOOR ${cfg.floor} — ${cfg.title.toUpperCase()}`,
      sub: `<em>${heroDef.name}</em> — ${cfg.brief}<br>
            Kit: ${heroDef.basicName ?? 'Attack'} · ${skills.join(' · ')} · <em>${heroDef.ultimate.name}</em> (rare special)<br><br>
            Roster: ${roster}<br>
            Starting mana: <b>${MANA.start + (cfg.manaBonus ?? 0)}</b>/${MANA.max + (cfg.manaMaxBonus ?? 0)} · Essence budget: <b>${cfg.essencePool}</b><br>
            Place monsters freely anywhere on the battlefield<br><br>
            <span class="dim">The boss rolls a move every few seconds. Its special is rare;
            a telegraphing move can be cancelled by summoning the Swamp Toad.</span>`,
      button: 'BEGIN',
      onAction: () => {
        this.audio.unlock();
        this.ui.hideBanner();
        this.battle.begin();
      },
    });
  }

  // ═══ skill lab ══════════════════════════════════════════════════════════
  #enterSkillLab() {
    this.ui.hideMainMenu();
    this.ui.hideBanner();
    this.mode = MODE.LAB;
    this.ui.setMode(MODE.LAB);
    this.player.setEnabled(false);
    this.battle.toIntro();
    this.arena.build(themeForFloor(4));
    this.ui.showSkillLab({
      heroes: Object.values(HEROES),
      monsters: MONSTERS,
      onHero: (id) => this.#loadLabHero(id),
      onMonster: (id) => this.#loadLabMonster(id),
      onAction: (id) => this.#runLabAction(id),
      onReset: () => this.#resetSkillLab(),
      onExit: () => this.#exitSkillLab(),
    });
    this.#loadLabHero(this.labSelectedHeroId);
  }

  #clearLabActors() {
    this.telegraph.reset();
    this.combat.reset();
    this.skills.reset();
    this.fx.resetDecals();
    for (const m of this.monsters) m.destroy();
    this.monsters = [];
    this.hero?.destroy();
    this.hero = null;
    this.labCaster = null;
    this.labPrimaryTarget = null;
    this.clock = 0;
    document.body.classList.remove('danger');
  }

  #loadLabHero(id) {
    const def = HEROES[id];
    if (!def) return;
    this.#clearLabActors();
    this.labKind = 'hero';
    this.labSelectedHeroId = id;

    const x = ARENA.cx - 170;
    const y = ARENA.cy + 24;
    this.hero = new Hero(this, def, LAB_FLOOR, x, y);
    this.hero.nextSkillAt = Infinity;
    this.hero.stationaryFor = 999;
    this.ui.setHero(def);

    const targetX = Phaser.Math.Clamp(
      x + Math.max(76, Math.min(286, def.basicRange * 0.82)),
      ARENA.x + 80, ARENA.right - 90,
    );
    const positions = [
      { x: targetX, y },
      { x: Math.min(ARENA.right - 60, targetX + 48), y: y - 62 },
      { x: Math.min(ARENA.right - 54, targetX + 66), y: y + 62 },
    ];
    this.monsters = positions.map((p) => new Monster(this, LAB_DUMMY, p.x, p.y));
    this.labPrimaryTarget = this.monsters[0];
    this.hero.target = this.labPrimaryTarget;
    this.hero.facing = 1;

    const actions = [
      {
        id: 'basic', label: def.basicName ?? 'Basic Attack', tone: '',
        desc: 'Real basic attack · transformed variants included',
      },
      ...def.skills.map((skill) => ({
        id: `skill:${skill.id}`, label: skill.name, tone: 'active-skill',
        desc: `${skill.telegraph.label} · ${skill.telegraph.shape} ${skill.telegraph.radius ?? ''}`,
      })),
      {
        id: `skill:${def.ultimate.id}`, label: `ULT · ${def.ultimate.name}`, tone: 'ultimate',
        desc: 'Full telegraph and ultimate effect · cooldown disabled',
      },
    ];
    this.ui.setSkillLabSelection(
      'hero', id, def.name,
      'Three durable training constructs receive the real attack and status effects.',
      actions,
    );
  }

  #loadLabMonster(id) {
    const def = MONSTER_BY_ID[id];
    const heroDef = HEROES[this.labSelectedHeroId] ?? HEROES.goldenKnight;
    if (!def || !heroDef) return;
    this.#clearLabActors();
    this.labKind = 'monster';
    this.labSelectedMonsterId = id;

    const y = ARENA.cy + 24;
    this.hero = new Hero(this, heroDef, LAB_TARGET_FLOOR, ARENA.cx + 150, y);
    this.hero.nextSkillAt = Infinity;
    this.hero.stationaryFor = 999;
    this.ui.setHero(heroDef);

    this.labCaster = new Monster(this, def, ARENA.cx - 120, y);
    this.labCaster.facing = 1;
    this.monsters = [this.labCaster];
    // Bloom needs an injured ally to display the team-heal branch. Keep that
    // assistant out of the way for every other monster.
    if (def.passive?.id === 'bloom') {
      const ally = new Monster(this, LAB_DUMMY, ARENA.cx - 55, y + 55);
      this.monsters.push(ally);
    }
    this.labCasterStart = { x: this.labCaster.x, y: this.labCaster.y };

    this.ui.setSkillLabSelection(
      'monster', id, def.name,
      `The selected monster attacks ${heroDef.name}; conditions and cooldowns are forced ready.`,
      [
        { id: 'basic', label: 'BASIC ATTACK', desc: 'Normal attack and projectile path' },
        { id: 'passive', label: `PASSIVE · ${def.passive.name}`, tone: 'passive', desc: def.passive.desc },
        { id: 'active', label: `ACTIVE · ${def.active.name}`, tone: 'active-skill', desc: def.active.desc },
      ],
    );
  }

  #runLabAction(actionId) {
    this.audio.unlock();
    if (this.labKind === 'hero') {
      if (actionId === 'basic') {
        this.telegraph.reset();
        this.heroAI.performBasicNow(this.hero, this.labPrimaryTarget);
        return;
      }
      const id = actionId.replace(/^skill:/, '');
      const skill = [...this.hero.def.skills, this.hero.def.ultimate].find((s) => s.id === id);
      if (skill) this.#castLabHeroSkill(skill);
      return;
    }

    const monster = this.labCaster;
    if (!monster?.alive || !this.hero?.alive) return;
    monster.x = this.labCasterStart.x;
    monster.y = this.labCasterStart.y;
    monster.dashing = false;
    monster.dash = null;
    monster.skillCd = {};
    this.hero.hp = this.hero.maxHp;
    this.hero.status.stunUntil = 0;
    this.hero.status.slowUntil = 0;
    this.hero.stationaryFor = 999;
    this.hero.sprite.clearTint();

    if (actionId === 'basic') {
      const activeId = monster.def.active?.id;
      if (activeId) monster.skillCd[activeId] = Infinity;
      // Charge skills use an internal shared key in the production executor.
      monster.skillCd.recklessCharge = Infinity;
      this.skills.performAttack(monster, this.hero);
      monster.skillCd = {};
    } else if (actionId === 'passive') {
      const activeId = monster.def.active?.id;
      if (activeId) monster.skillCd[activeId] = Infinity;
      monster.skillCd.recklessCharge = Infinity;
      this.skills.showcaseMonsterPassive(monster, this.hero);
      monster.skillCd = {};
    } else if (actionId === 'active') {
      this.skills.showcaseMonsterActive(monster, this.hero);
    }
  }

  #castLabHeroSkill(skill) {
    const hero = this.hero;
    const target = this.labPrimaryTarget;
    if (!hero?.alive || !target?.alive) return;
    this.telegraph.reset();
    hero.pendingSkill = skill;
    hero.pendingRecover = skill.recover;
    hero.target = target;
    hero.facing = target.x >= hero.x ? 1 : -1;
    for (const m of this.monsters) {
      if (!m.alive) continue;
      m.hp = m.maxHp;
      m.status.stunUntil = 0;
      m.status.slowUntil = 0;
      m.drawHpBar();
    }

    const tg = skill.telegraph;
    const atTarget = tg.atTarget && !tg.atSelf;
    const ctx = {
      x: atTarget ? target.x : hero.x,
      y: atTarget ? target.y : hero.y - 10,
      facing: hero.facing,
    };
    if (skill.effect?.type === 'blizzard') {
      const count = skill.effect.storms ?? 5;
      ctx.spots = Array.from({ length: count }, (_, i) => {
        const a = (i / count) * Math.PI * 2 - Math.PI / 2;
        return {
          x: Phaser.Math.Clamp(target.x + Math.cos(a) * 105, ARENA.x + 105, ARENA.right - 105),
          y: Phaser.Math.Clamp(target.y + Math.sin(a) * 72, ARENA.y + 80, ARENA.bottom - 55),
        };
      });
    }

    const telegraphSpot = ctx.spots?.[0] ?? ctx;
    hero.setState(HERO_STATE.TELEGRAPH, tg.duration + 1);
    hero.playFor('windup', tg.duration);
    this.telegraph.begin({
      ...tg,
      source: hero,
      x: telegraphSpot.x,
      y: telegraphSpot.y,
      spots: ctx.spots,
      facing: ctx.facing,
      onComplete: () => {
        if (!hero.alive) return;
        hero.play('attack', true);
        hero.setState(HERO_STATE.CAST, 0.18);
        this.skills.executeHeroEffect(hero, skill, ctx);
        hero.pendingSkill = null;
      },
      onCancel: () => {
        hero.pendingSkill = null;
        hero.setState(HERO_STATE.IDLE);
      },
    });
  }

  #resetSkillLab() {
    if (this.labKind === 'monster') this.#loadLabMonster(this.labSelectedMonsterId);
    else this.#loadLabHero(this.labSelectedHeroId);
  }

  #exitSkillLab() {
    this.ui.hideSkillLab();
    this.#clearLabActors();
    this.needsMainMenu = true;
    this.startFloor();
  }

  // ═══ ascent mode ═════════════════════════════════════════════════════════
  /**
   * Menu → hero draft. Swapping the floor track resets the run to floor 1 with a
   * full set of attempts, so this is the only place it may be called.
   */
  #enterAscent() {
    this.ui.hideMainMenu();
    this.ui.hideBanner();
    this.mode = MODE.ASCENT;
    this.tower.setTrack(ASCENT_FLOORS);
    this.ui.setMode(MODE.ASCENT);
    this.player.setEnabled(false);
    this.battle.toIntro();
    this.#clearField();

    /** Health carries between floors; clearing one gives a fraction of it back. */
    this.ascentHpPct = 1;

    const cfg = this.tower.config;
    this.arena.build(themeForFloor(cfg.floor));
    this.ui.setFloor(cfg);
    this.ui.showHeroSelection(Object.values(HEROES), (id) => {
      this.ascentHeroId = id;
      this.ui.hideBanner();
      this.startAscentFloor();
    });
  }

  startAscentFloor() {
    this.mode = MODE.ASCENT;
    this.ui.setMode(MODE.ASCENT);
    this.player.setEnabled(false); // the intro banner hands control over
    const cfg = this.tower.config;

    this.arena.build(themeForFloor(cfg.floor));
    this.#clearField();
    this.ascent.configure(cfg);
    this.ui.setFloor(cfg);

    const def = HEROES[this.ascentHeroId] ?? HEROES.goldenKnight;
    this.hero = new Hero(this, def, cfg, ARENA.cx, ARENA.bottom - 74);
    this.hero.playerControlled = true;
    // HeroAI never ticks in this mode, but the roll timer is seeded in the Hero
    // constructor — left alone it would be a loaded gun aimed at the player's kit.
    this.hero.nextSkillAt = Infinity;
    this.hero.hp = Math.max(1, Math.round(this.hero.maxHp * (this.ascentHpPct ?? 1)));
    this.hero.drawAggro(); // redraw: the ring is the player's reach, not a threat
    this.ui.setHero(def);
    this.ui.buildAscentActions(def, (id) => this.player.request(id));
    this.ui.setDefaultHint('WASD move · mouse aim · click attack · 1–3 skills · 4 ultimate.');

    this.#showAscentIntro(cfg, def);
  }

  #showAscentIntro(cfg, def) {
    const bodies = ascentFloorSize(cfg);
    const elites = cfg.waves.filter((w) => w.elite).length;
    const heal = Math.round((cfg.healOnClear ?? 0) * 100);

    this.ui.showBanner({
      title: `FLOOR ${cfg.floor} — ${cfg.title.toUpperCase()}`,
      sub: `<em>${def.name}</em> — ${cfg.brief}<br>
            Garrison: <b>${bodies}</b> monsters over <b>${cfg.waves.length}</b> waves${elites ? ` · <b>${elites}</b> elite` : ''}<br>
            Kit: ${def.basicName ?? 'Attack'} · ${def.skills.map((s) => s.name).join(' · ')} · <em>${def.ultimate.name}</em><br><br>
            <span class="dim">Your wind-ups are shortened but they still telegraph — a cast is a
            commitment. Damage carries between floors; clearing this one restores ${heal}% of your health.</span>`,
      button: 'CLIMB',
      onAction: () => {
        this.audio.unlock();
        this.ui.hideBanner();
        this.player.setEnabled(true);
        this.ascent.begin();
      },
    });
  }

  #onAscentCleared() {
    const reward = this.tower.clearFloor();
    const cfg = this.tower.config;
    const last = this.tower.isFinalFloor;
    this.player.setEnabled(false);

    const before = this.hero?.hpPct ?? 1;
    this.ascentHpPct = Math.min(1, before + (cfg.healOnClear ?? 0));

    this.fx.screenFlash(0x8bffd8, 0.3, 240);
    this.ui.showBanner({
      title: last ? 'TOWER CONQUERED' : 'FLOOR CLEARED',
      tone: 'victory',
      sub: `Monsters put down: <b>${ascentFloorSize(cfg)}</b> · Health left: <b>${Math.round(before * 100)}%</b><br>
            ${last ? '' : `Recovered to <b>${Math.round(this.ascentHpPct * 100)}%</b> for the next floor<br>`}
            Reward: <b>${reward.soft}</b> soft${reward.hard ? ` · <b>${reward.hard}</b> hard` : ''}
            <span class="dim">(banked for the meta layer)</span>`,
      button: last ? 'NEW RUN' : 'NEXT FLOOR',
      onAction: () => {
        this.ui.hideBanner();
        if (last) {
          this.tower.resetRun();
          this.ascentHpPct = 1;
        } else {
          this.tower.advance();
        }
        this.startAscentFloor();
      },
    });
  }

  #onAscentDefeat() {
    const lives = this.tower.loseLife();
    const over = lives <= 0;
    this.player.setEnabled(false);

    this.fx.screenFlash(0xff3b4e, 0.34, 260);
    this.ui.showBanner({
      title: 'YOU FELL',
      tone: 'defeat',
      sub: over
        ? `The tower keeps its floors. <b>Floor ${this.tower.floor}</b> was as high as you got.<br>
           <span class="dim">Out of attempts.</span>`
        : `Wave <b>${this.ascent.waveNumber}</b> of ${this.ascent.waveCount} — ${this.ascent.monstersLeft} still standing.<br>
           Attempts remaining: <b>${lives}</b><br><br>
           <span class="dim">Retrying restores you to full. Keep moving during recovery, and
           save the ultimate for the wave that leads with an elite.</span>`,
      button: over ? 'BACK TO MENU' : 'RETRY FLOOR',
      onAction: () => {
        this.ui.hideBanner();
        if (over) {
          this.needsMainMenu = true;
          this.startFloor(); // switches the track back and resets the run
          return;
        }
        this.ascentHpPct = 1;
        this.startAscentFloor();
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
           Toad held in reserve can cancel a rare special outright.</span>`,
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

    // the room runs on real time: torches keep burning through hitstop
    this.arena.update(realDt);

    if (this.mode === MODE.LAB) {
      this.clock += dt;
      this.telegraph.update(dt);
      this.skills.update(dt);
      this.combat.update(dt);
      this.hero?.update(dt);
      for (const m of this.monsters) {
        if (m.dashing) this.skills.tickDash(m, dt);
        m.update(dt);
      }
    } else if (this.mode === MODE.ASCENT) {
      if (this.ascent.running) {
        this.clock += dt;

        // no mana tick and no HeroAI: the resources are cooldowns, and the hero
        // is driven by the keyboard. Everything else is the defence loop.
        this.telegraph.update(dt);
        this.player.update(dt);
        this.monsterAI.update(dt);
        this.skills.update(dt);
        this.combat.update(dt);
        this.hero?.update(dt);
        this.ascent.update(dt);
      } else {
        this.hero?.syncSprite();
        this.hero?.drawAggro();
        for (const m of this.monsters) m.syncSprite();
      }
    } else if (this.battle.running) {
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

    // the sigil turns on real time too — a frozen cursor during hitstop reads
    // as the game having hung. Ascent has nothing to place, so it has no sigil.
    if (this.mode !== MODE.ASCENT) this.summon.update(realDt);
    this.ui.update();

    this.monsters = this.monsters.filter((m) => !m.destroyed);
  }
}
