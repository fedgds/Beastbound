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
 */

import { MONSTER_BY_ID, ROLE_LABEL } from '../data/monsters.js';

const $ = (id) => document.getElementById(id);

export default class UISystem {
  constructor(scene) {
    this.scene = scene;

    this.el = {
      floorNum: $('floor-num'),
      heroName: $('hero-name'),
      heroTags: $('hero-tags'),
      heroHpText: $('hero-hp-text'),
      heroHpFill: $('hero-hp-fill'),
      heroUltFill: $('hero-ult-fill'),
      manaText: $('mana-text'),
      manaFill: $('mana-fill'),
      essenceText: $('essence-text'),
      essenceFill: $('essence-fill'),
      cards: $('cards'),
      hint: $('hint-text'),
      callout: $('callout'),
      banner: $('banner'),
      bannerTitle: $('banner-title'),
      bannerSub: $('banner-sub'),
      bannerBtn: $('banner-btn'),
    };

    this.cardEls = new Map();
    this.hintTimer = null;
    this.bannerAction = null;

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
        <span class="swatch" style="background:${def.tint}"></span>
        <span class="cname">${def.short}</span>
        <span class="crole">${ROLE_LABEL[def.role]}</span>
        <span class="cost"><b>${def.cost}</b></span>
      `;
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
    const { hero, mana, tower, summon, battle, telegraph } = this.scene;

    this.el.floorNum.textContent = tower.floor;

    // ── hero ──
    if (hero) {
      const pct = Math.max(0, hero.hpPct) * 100;
      this.el.heroHpFill.style.width = `${pct}%`;
      this.el.heroHpText.textContent = `${Math.ceil(Math.max(0, hero.hp))}/${hero.maxHp}`;
      this.el.heroUltFill.style.width = `${hero.energyPct * 100}%`;
      this.el.heroUltFill.classList.toggle('ready', hero.ultReady);
      this.#renderHeroTags(hero);
    }

    // ── mana + essence ──
    this.el.manaFill.style.width = `${mana.manaPct * 100}%`;
    this.el.manaText.textContent = `${Math.floor(mana.mana)}/${mana.max}`;
    this.el.essenceFill.style.width = `${mana.poolPct * 100}%`;
    this.el.essenceText.textContent = Math.ceil(mana.pool);
    this.el.essenceFill.classList.toggle('low', mana.poolPct < 0.25);

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
