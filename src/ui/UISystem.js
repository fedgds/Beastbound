/**
 * UISystem — the HTML/CSS overlay (spec §6, §11).
 *
 * The Phaser canvas owns the battlefield; everything informational lives in DOM
 * so it styles and reflows cleanly. This module is the only place that touches
 * the document.
 *
 * It must answer, at a glance and at all times:
 *   how much mana · what I can afford · where I may summon · how dangerous the
 *   hero is right now · how close the ultimate is · which floor I'm on.
 *
 * Two readouts here exist because the state was previously invisible: the
 * attempts pips (TowerSystem.lives) and the hero skill chips (Hero.skillCd) —
 * you could lose a run, or eat a Shield Bash, with no warning either was coming.
 */

import { MONSTER_BY_ID, ROLE_LABEL } from '../data/monsters.js';

const $ = (id) => document.getElementById(id);

/**
 * PlaceholderArt draws every frame feet-down and horizontally centred, with the
 * ground this far above the bottom edge. Placing portraits by that anchor beats
 * measuring the sprite: no trimming, and no fractional scaling to shimmer.
 */
const FEET_INSET = 4;

/**
 * Points a portrait <img> at a baked unit frame.
 *
 * The frames live in Phaser's texture manager as canvases, so they can be handed
 * to an <img> via a data URL without a network round-trip. Nearest-neighbour is
 * forced on the way out — the browser would otherwise smooth it.
 *
 * `scale` must stay an integer: 2x doubles every pixel exactly, where 1.5x would
 * resample and the sprite would shimmer as the row redraws. A 32px-wide unit at
 * 2x is 64px, which is exactly the width of a card niche.
 */
function setPortrait(scene, img, texKey, scale = 1) {
  if (!scene.textures.exists(texKey)) return;
  const src = scene.textures.get(texKey).getSourceImage();
  const cv = document.createElement('canvas');
  cv.width = src.width;
  cv.height = src.height;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, 0, 0);
  img.width = cv.width * scale;
  img.height = cv.height * scale;
  // sink the frame until the feet meet the niche floor, leaving 2px of the
  // sprite's own contact shadow showing
  img.style.bottom = `${-(FEET_INSET * scale - 2)}px`;
  img.src = cv.toDataURL();
}

/** 'Shield Bash' -> 'BASH'. Chips are 5 characters wide at most. */
function chipLabel(name) {
  const last = name.trim().split(/\s+/).pop();
  return last.toUpperCase().slice(0, 5);
}

export default class UISystem {
  constructor(scene) {
    this.scene = scene;

    this.el = {
      floorNum: $('floor-num'),
      floorTotal: $('floor-total'),
      floorTitle: $('floor-title'),
      floorPips: $('floor-pips'),
      livesPips: $('lives-pips'),
      heroFace: $('hero-face'),
      heroName: $('hero-name'),
      heroTags: $('hero-tags'),
      heroHpText: $('hero-hp-text'),
      heroHpFill: $('hero-hp-fill'),
      heroHpTrail: $('hero-hp-trail'),
      heroUltFill: $('hero-ult-fill'),
      heroSkills: $('hero-skills'),
      manaText: $('mana-text'),
      manaShards: $('mana-shards'),
      essenceText: $('essence-text'),
      essenceFill: $('essence-fill'),
      aliveNum: $('alive-num'),
      cards: $('cards'),
      hint: $('hint-text'),
      callout: $('callout'),
      banner: $('banner'),
      bannerTitle: $('banner-title'),
      bannerSub: $('banner-sub'),
      bannerBtn: $('banner-btn'),
    };

    this.cardEls = new Map();
    this.shardEls = [];
    this.skillEls = new Map();
    this.hintTimer = null;
    this.bannerAction = null;

    this.#buildPips();
    this.#buildShards();

    this.el.bannerBtn.addEventListener('click', () => this.bannerAction?.());

    // Hotkeys 1–5 mirror the card row.
    window.addEventListener('keydown', (e) => this.#onKey(e));
  }

  #onKey(e) {
    if (e.repeat) return;
    if (e.key === 'Enter' || e.key === ' ') {
      if (!this.el.banner.classList.contains('hidden')) {
        e.preventDefault();
        this.bannerAction?.();
      }
      return;
    }
    const order = this.order ?? [];
    const idx = Number(e.key) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < order.length) {
      this.scene.summon.setSelected(order[idx]);
    }
  }

  // ═══ one-time structure ══════════════════════════════════════════════════

  /** One pip per floor of the tower, and one per remaining attempt. */
  #buildPips() {
    const { tower } = this.scene;
    const fill = (host, n) => {
      host.innerHTML = '';
      for (let i = 0; i < n; i++) {
        const p = document.createElement('i');
        p.className = 'pip';
        host.appendChild(p);
      }
    };
    fill(this.el.floorPips, tower.total);
    fill(this.el.livesPips, tower.lives);
    this.el.floorTotal.textContent = `/${tower.total}`;
  }

  /**
   * One socket per point of maximum mana. Built from ManaSystem rather than
   * hard-coded, so the row stays honest if the cap ever changes.
   */
  #buildShards() {
    const n = this.scene.mana.max;
    const host = this.el.manaShards;
    host.innerHTML = '';
    host.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
    this.shardEls = [];
    for (let i = 0; i < n; i++) {
      const s = document.createElement('i');
      s.className = 'shard';
      host.appendChild(s);
      this.shardEls.push(s);
    }
  }

  /** The room's name, inscribed in the top bar. Called once per floor. */
  setFloor(cfg) {
    this.el.floorTitle.textContent = cfg.title.toUpperCase();
  }

  /** Sets the intruder's name and portrait. Called once per floor. */
  setHero(def) {
    this.el.heroName.textContent = def.name.toUpperCase();
    setPortrait(this.scene, this.el.heroFace, `${def.art}_idle0`);
    this.#buildSkillChips();
  }

  /** A chip per skill unlocked on this floor, so cooldowns are legible. */
  #buildSkillChips() {
    const host = this.el.heroSkills;
    host.innerHTML = '';
    this.skillEls.clear();
    for (const skill of this.scene.hero?.skills ?? []) {
      const chip = document.createElement('div');
      chip.className = 'skill-chip';
      chip.innerHTML = `<i class="cd"></i><span>${chipLabel(skill.name)}</span>`;
      chip.title = `${skill.name} — ${skill.cooldown >= 999 ? 'once per floor' : `${skill.cooldown}s cooldown`}`;
      host.appendChild(chip);
      this.skillEls.set(skill.id, { chip, cd: chip.querySelector('.cd'), skill });
    }
  }

  // ═══ card row ════════════════════════════════════════════════════════════
  buildCards(unlockedIds) {
    this.order = [...unlockedIds];
    this.el.cards.innerHTML = '';
    this.cardEls.clear();

    this.order.forEach((id, i) => {
      const def = MONSTER_BY_ID[id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'card';
      card.dataset.id = id;
      card.innerHTML = `
        <span class="key">${i + 1}</span>
        <span class="portrait"><img alt="" /></span>
        <span class="cname">${def.short}</span>
        <span class="crole"><i class="dot" style="background:${def.tint}"></i>${ROLE_LABEL[def.role]}</span>
        <span class="cpassive">${def.passive.name}</span>
        <span class="cfoot">
          <span class="cstats"><i>${def.hp}</i>HP · <i>${def.atk}</i>ATK</span>
          <span class="cost">${'<i class="cpip"></i>'.repeat(def.cost)}</span>
        </span>
      `;
      setPortrait(this.scene, card.querySelector('.portrait img'), `${def.art}_idle0`, 2);

      card.title = `${def.name} — ${def.cost} mana
Passive: ${def.passive.name} — ${def.passive.desc}
Active:  ${def.active.name} — ${def.active.desc}`;

      card.addEventListener('click', () => this.scene.summon.setSelected(id));
      card.addEventListener('mouseenter', () => this.flashHint(
        `${def.passive.name}: ${def.passive.desc}`, 2600,
      ));

      this.el.cards.appendChild(card);
      this.cardEls.set(id, card);
    });
  }

  // ═══ per-frame refresh ═══════════════════════════════════════════════════
  update() {
    const { hero, mana, tower, summon, battle, telegraph, monsters } = this.scene;

    this.el.floorNum.textContent = tower.floor;
    this.#renderPips(tower);

    if (hero) {
      this.#renderHero(hero);
      this.#renderSkills(hero);
    }
    this.#renderMana(mana, summon);

    this.el.essenceFill.style.width = `${mana.poolPct * 100}%`;
    this.el.essenceText.textContent = Math.ceil(mana.pool);
    this.el.essenceFill.classList.toggle('low', mana.poolPct < 0.25);

    this.el.aliveNum.textContent = monsters.filter((m) => m.alive).length;

    // ── cards: affordability + selection ──
    for (const [id, el] of this.cardEls) {
      const def = MONSTER_BY_ID[id];
      el.classList.toggle('selected', summon.selectedId === id);
      el.classList.toggle('poor', !mana.canAfford(def.cost));
      el.classList.toggle('disabled', !battle.acceptsInput);
    }

    // ── telegraph callout: the loudest thing on screen while winding up ──
    const kind = telegraph.currentKind();
    if (kind) {
      this.el.callout.className = `show ${kind}`;
      this.el.callout.textContent = kind === 'buff'
        ? 'HERO IS BUFFING'
        : (kind === 'control' ? 'CONTROL INCOMING' : 'AoE INCOMING');
    } else {
      this.el.callout.className = '';
    }

    document.body.classList.toggle('danger', battle.inDanger);
  }

  #renderPips(tower) {
    const pips = this.el.floorPips.children;
    for (let i = 0; i < pips.length; i++) {
      const floor = i + 1;
      pips[i].className = 'pip'
        + (tower.clearedFloors.includes(floor) ? ' done' : '')
        + (floor === tower.floor ? ' here' : '');
    }
    const lives = this.el.livesPips.children;
    for (let i = 0; i < lives.length; i++) {
      lives[i].className = `pip ${i < tower.lives ? 'left' : 'spent'}`;
    }
  }

  #renderHero(hero) {
    const pct = Math.max(0, hero.hpPct);
    this.el.heroHpFill.style.width = `${pct * 100}%`;
    this.el.heroHpText.textContent = `${Math.ceil(Math.max(0, hero.hp))}/${hero.maxHp}`;

    // Both bands track the same number; the trail's CSS transition is slower and
    // delayed, so the pale strip left behind it *is* the damage just taken. No
    // JS state — the easing is the animation.
    this.el.heroHpTrail.style.width = `${pct * 100}%`;

    this.el.heroUltFill.style.width = `${hero.energyPct * 100}%`;
    this.el.heroUltFill.classList.toggle('ready', hero.ultReady);
    this.#renderHeroTags(hero);
  }

  #renderSkills(hero) {
    const now = this.scene.clock;
    for (const [id, { chip, cd, skill }] of this.skillEls) {
      const spent = skill.once && hero.skillUsed[id];
      const left = Math.max(0, (hero.skillCd[id] ?? 0) - now);
      const armed = !spent && left <= 0;
      const firing = hero.pendingSkill?.id === id;

      // the fill drains left-to-right as the cooldown runs down
      cd.style.width = spent ? '0%' : `${(left / Math.max(0.001, skill.cooldown)) * 100}%`;
      chip.classList.toggle('armed', armed && !firing);
      chip.classList.toggle('firing', !!firing);
      chip.classList.toggle('spent', !!spent);
    }
  }

  /**
   * Mana as a countable row. `claim` marks the exact sockets the armed monster
   * would drain, so the decision is "are those shards there" rather than
   * arithmetic against a bar.
   */
  #renderMana(mana, summon) {
    const whole = Math.floor(mana.mana);
    const frac = mana.mana - whole;
    this.el.manaText.textContent = `${whole}/${mana.max}`;

    const sel = MONSTER_BY_ID[summon.selectedId];
    const claimFrom = sel && mana.canAfford(sel.cost) ? whole - sel.cost : -1;

    for (let i = 0; i < this.shardEls.length; i++) {
      let cls = 'shard';
      if (i < whole) cls += ' full';
      else if (i === whole && frac > 0.12) cls += ` c${Math.min(3, Math.floor(frac * 4))}`;
      if (claimFrom >= 0 && i >= claimFrom && i < whole) cls += ' claim';
      if (this.shardEls[i].className !== cls) this.shardEls[i].className = cls;
    }
  }

  #renderHeroTags(hero) {
    const tags = [];
    const now = this.scene.clock;
    if (hero.taunt && now < hero.taunt.until) tags.push(['TAUNTED', 'purple']);
    if (now < hero.status.slowUntil) tags.push(['SLOWED', 'purple']);
    if (hero.stunned && hero.alive) tags.push(['STUNNED', 'purple']);
    if (hero.enraged) tags.push(['ENRAGED', 'yellow']);
    if (hero.ultReady) tags.push(['ULT READY', 'red']);

    const html = tags.map(([t, c]) => `<i class="tag ${c}">${t}</i>`).join('');
    if (html !== this._tagHtml) {
      this.el.heroTags.innerHTML = html;
      this._tagHtml = html;
    }
  }

  // ═══ transient messages ══════════════════════════════════════════════════
  flashHint(text, ms = 1800) {
    this.el.hint.textContent = text;
    this.el.hint.classList.add('flash');
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => {
      this.el.hint.classList.remove('flash');
      this.el.hint.textContent = this.defaultHint ?? '';
    }, ms);
  }

  setDefaultHint(text) {
    this.defaultHint = text;
    if (!this.el.hint.classList.contains('flash')) this.el.hint.textContent = text;
  }

  // ═══ banner ══════════════════════════════════════════════════════════════
  showBanner({ title, sub, button, tone = '', onAction }) {
    this.el.bannerTitle.textContent = title;
    this.el.bannerSub.innerHTML = sub ?? '';
    this.el.bannerBtn.textContent = button ?? 'CONTINUE';
    this.el.banner.className = tone;
    this.bannerAction = onAction;
    this.el.bannerBtn.focus();
  }

  hideBanner() {
    this.el.banner.className = 'hidden';
    this.bannerAction = null;
  }
}
