// FRONT ULTRA — the ground battle's HUD strip and nation banners (DESIGN_V2 §11.7; owner: ui, W6).
//
// When the camera is down in a ground battle (render/battle, below ~42 km), a strip at the top of the screen names it:
//   «FRENTE DE ZARAGOZA · [CHE] Suiza (ataca) 320.000 ▶ 180.000 [TÚ] Comandante (defiende) · avance 5 km/h · 3.er día de combate»
// with a second line saying how the line moves (observation time: 1 s = 1 min, or waiting for the next tile), and a
// floating banner with each nation's colour and name stands above its side's line. All numbers are the sim's (the
// front's troops, the measured advance, the days since it opened), through the same helpers as the badges and panel.

import * as THREE from 'three';
import { h, setText, toggleClass } from '../dom';
import { hexToCss } from '../../shared/color';
import { t } from '../../shared/i18n';
import { frontName } from './forcesInfo';
import { advanceText, combatDayText, isoOf, sidesOf, troopsText } from './frontsInfo';
import type { HudShared } from './shared';

export interface BattleStrip {
  el: HTMLElement;
  banners: HTMLElement;
  update(): void;
}

export function createBattleStrip(hs: HudShared): BattleStrip {
  const ctx = hs.ctx;
  const title = h('span', { class: 'fu-bstrip-title' });
  const chipA = h('span', { class: 'fu-fb-chip' }), chipB = h('span', { class: 'fu-fb-chip' });
  const sideA = h('span'), sideB = h('span');
  const arrow = h('span', { class: 'fu-fb-dir' });
  const adv = h('span');
  const day = h('span');
  const sub = h('div', { class: 'fu-bstrip-sub' });
  const el = h('div', { class: 'fu-bstrip fu-hidden' },
    h('div', { class: 'fu-bstrip-main' }, title, h('span', null, '·'), chipA, sideA, arrow, chipB, sideB, h('span', null, '·'), adv, h('span', null, '·'), day),
    sub,
  );
  const bannerEls = [h('div', { class: 'fu-bbanner' }), h('div', { class: 'fu-bbanner' })];
  const banners = h('div', { class: 'fu-bbanners fu-hidden' }, ...bannerEls);
  const v = new THREE.Vector3(), vc = new THREE.Vector3();
  let acc = 1;
  // A language change repaints at once (the strip otherwise refreshes 4 times a second).
  ctx.bus.on('languageChanged', () => (acc = 1));

  function paintText(key: number): boolean {
    const view = ctx.sim.view;
    const f = view.frontByKey.get(key);
    if (!f) return false;
    const s = sidesOf(view, f);
    const aIsAtt = s.att === f.a;
    const tAtt = aIsAtt ? f.troopsA : f.troopsB, tDef = aIsAtt ? f.troopsB : f.troopsA;
    setText(title, frontName(hs, key) || t('fr.front'));
    chipA.style.setProperty('--c', hexToCss(view.players[s.att]?.color ?? 0x888888));
    chipB.style.setProperty('--c', hexToCss(view.players[s.def]?.color ?? 0x888888));
    setText(chipA, isoOf(view, s.att));
    setText(chipB, isoOf(view, s.def));
    setText(sideA, `${hs.name(s.att)} (${t(s.quiet ? 'fr.strip.quiet' : 'fr.strip.attacks')}) ${troopsText(tAtt)}`);
    setText(sideB, `${troopsText(tDef)} ${hs.name(s.def)}${s.quiet ? '' : ` (${t('fr.strip.defends')})`}`);
    setText(arrow, s.quiet ? '·' : s.gaining < 0 ? '◀' : s.gaining > 0 ? '▶' : '‖');
    setText(adv, s.quiet ? t('fr.adv.quiet') : t('fr.strip.advance', { v: advanceText(view, f, s, false) }));
    setText(day, combatDayText(view, f));
    return true;
  }

  return {
    el,
    banners,
    update() {
      const bv = ctx.app.state === 'playing' ? ctx.battle.view?.() ?? null : null;
      const on = !!bv && bv.fade > 0.3 && bv.frontKey > 0;
      toggleClass(el, 'fu-hidden', !on);
      toggleClass(banners, 'fu-hidden', !on);
      if (!on || !bv) return;
      acc += Math.max(ctx.frame.dt, 0.05);
      if (acc >= 0.25) {
        acc = 0;
        if (!paintText(bv.frontKey)) {
          toggleClass(el, 'fu-hidden', true);
          toggleClass(banners, 'fu-hidden', true);
          return;
        }
        const view = ctx.sim.view;
        const mode = view.clock.mode;
        setText(sub, view.speed === 0 ? t('fr.strip.paused') : bv.lineLive || mode === 'observation' || mode === 'crisis' ? t('fr.strip.observation') : t('fr.strip.frozen'));
        for (let k = 0; k < 2; k++) {
          const b = bv.banners[k];
          const p = view.players[b.owner];
          bannerEls[k].style.setProperty('--c', hexToCss(p?.color ?? 0x888888));
          const f = view.frontByKey.get(bv.frontKey);
          const att = f ? sidesOf(view, f).att : 0;
          setText(bannerEls[k], t(att === b.owner && f && !f.quiet ? 'fr.banner.attacks' : 'fr.banner.defends', { name: hs.name(b.owner) || '—' }));
        }
      }
      // Banners follow the camera every frame.
      const cam = ctx.camera;
      const W = window.innerWidth, H = window.innerHeight;
      for (let k = 0; k < 2; k++) {
        const b = bv.banners[k];
        v.set(b.x, b.y, b.z);
        vc.copy(v).project(cam);
        const ok = vc.z < 1 && Math.abs(vc.x) < 1.05 && Math.abs(vc.y) < 1.05;
        const e = bannerEls[k];
        if (!ok) {
          e.style.display = 'none';
          continue;
        }
        const x = ((vc.x + 1) / 2) * W, y = ((1 - vc.y) / 2) * H;
        // Never under a HUD panel (alerts, leaderboard, build bar): a banner there would be unreadable.
        let hidden = false;
        for (const r of ctx.ui.getOccludedRects()) {
          if (x + 8 < r.right && x + 170 > r.left && y - 40 < r.bottom && y - 14 > r.top) {
            hidden = true;
            break;
          }
        }
        if (hidden) {
          e.style.display = 'none';
          continue;
        }
        e.style.display = '';
        e.style.transform = `translate(${(x + 8).toFixed(1)}px, ${(y - 40).toFixed(1)}px)`;
      }
    },
  };
}
