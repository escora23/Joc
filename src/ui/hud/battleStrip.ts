// FRONT ULTRA — the ground battle's HUD strip and nation banners (DESIGN_V2 §11.7; owner: ui, W6).
//
// When the camera is down in a ground battle (render/battle, below ~42 km), a strip at the top of the screen names it:
//   «FRENTE DE ZARAGOZA · [CHE] Suiza (ataca) 320.000 ▶ 180.000 [TÚ] Comandante (defiende) · avance 5 km/h · 3.er día de combate»
// with a second line saying how the line moves (observation time: 1 s = 1 min, or waiting for the next tile), and a
// floating banner with each nation's colour and name stands above its side's line. All numbers are the sim's (the
// front's troops, the measured advance, the days since it opened), through the same helpers as the badges and panel.

import * as THREE from 'three';
import { h, setText, toggleClass } from '../dom';
import { tip } from '../tooltip';
import { icon } from '../icons';
import { frontAction, takeControlAtFront, takeControlAtPlace } from './takeAction';
import { tx } from '../tx';
import { hexToCss } from '../../shared/color';
import { formatNumber, t } from '../../shared/i18n';
import { HUMAN_ID, UNIT_DEFS } from '../../shared/constants';
import { battleCentre, greatCircleKm, latLonToTileXY, tileXYToLatLon } from '../../shared/geo';
import { frontName } from './forcesInfo';
import { unitLabel } from './news';
import { advanceText, combatDayText, isoOf, sidesOf, troopsText } from './frontsInfo';
import type { HudShared } from './shared';

export interface BattleStrip {
  el: HTMLElement;
  banners: HTMLElement;
  /** The battle pointer (FEEDBACK #11): «▼ Frente de Zaragoza · la batalla, a 44 km · [Ir a la batalla]». */
  pointer: HTMLElement;
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
  // Feedback 3 (#26/#29e): take control here — your division in this battle (its soldiers are handed over), else the
  // nearest one marches to it.
  const take = h('button', { class: 'fu-btn fu-btn--sm fu-btn--amber fu-bstrip-take' }, icon('takeControl'), tx('hud.takeHere'), h('span', { class: 'fu-kbd' }, 'T')) as HTMLButtonElement;
  take.style.pointerEvents = 'auto';
  take.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  take.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const bv = ctx.battle.active ? ctx.battle.view?.() ?? null : null;
    let best = 0, bd = Infinity;
    for (const d of bv?.divisions ?? []) {
      const du = ctx.sim.view.units.get(d.unitId);
      if (!du || du.owner !== HUMAN_ID || !UNIT_DEFS[du.type].command || d.km >= bd) continue;
      bd = d.km;
      best = du.id;
    }
    // Fix pass 3 (#26/#29e): the same goal as every other front entry — this battle's front and, when it is our
    // offensive (or theirs on us), its live contact — so a division listed here but standing well behind the line
    // marches to the contact leg by leg instead of starting the scene where it waits.
    const key = bv?.frontKey ?? 0;
    const act = key ? frontAction(ctx.sim.view, key) : null;
    const c0 = centreOfBattle() ?? ctx.battle.pointer?.() ?? null;
    const label = title.textContent || t('fr.front');
    if (best) {
      const bu = ctx.sim.view.units.get(best)!;
      const gxy = c0 ? latLonToTileXY(c0.lat, c0.lon) : act ? { x: act.x, y: act.y } : { x: bu.x, y: bu.y };
      hs.sound('whoosh');
      hs.flags.commandEntered = true;
      hs.setMode({ kind: 'none' });
      void ctx.app.enterCommandMode(best, { x: gxy.x, y: gxy.y, label, ...(key ? { frontKey: key } : {}), ...(act?.attackId ? { attackId: act.attackId } : {}) });
      return;
    }
    if (key && act) {
      hs.flags.commandEntered = true;
      takeControlAtFront(hs, key);
      return;
    }
    if (!c0) {
      hs.sound('error');
      return;
    }
    takeControlAtPlace(hs, c0.lat, c0.lon, label, key);
  });
  tip(take, () => ({ title: t('hud.takeHere'), text: t('hud.takeHere.battle'), hotkey: 'T' }));
  const el = h('div', { class: 'fu-bstrip fu-hidden' },
    h('div', { class: 'fu-bstrip-main' }, title, h('span', null, '·'), chipA, sideA, arrow, chipB, sideB, h('span', null, '·'), adv, h('span', null, '·'), day, take),
    sub,
  );
  const bannerEls = [h('div', { class: 'fu-bbanner' }), h('div', { class: 'fu-bbanner' })];
  // Each banner's text is kept apart so the edge arrow can be put in front of it (a banner whose side is out of view
  // waits at the edge of the screen pointing at it: both sides always named).
  const bannerText = ['', ''];
  // Markers over the real divisions on the battlefield (up to 6): «▣ 1.ª División acorazada · Suiza».
  const divEls = Array.from({ length: 6 }, () => h('div', { class: 'fu-bdiv' }));
  const divIds = divEls.map(() => 0);
  // A click on a division's marker selects it (its card offers «Tomar el mando», and T takes command of it here).
  divEls.forEach((e, k) => {
    e.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    e.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = divIds[k];
      if (!id || !ctx.sim.view.units.has(id)) return;
      hs.select({ kind: 'unit', id });
      hs.sound('click');
    });
    tip(e, () => {
      const u = ctx.sim.view.units.get(divIds[k]);
      return { title: u ? unitLabel(u.type, u.serial) : t('fr.front'), text: t(u?.owner === HUMAN_ID ? 'fr.div.tipOwn' : 'fr.div.tip') };
    });
  });
  const banners = h('div', { class: 'fu-bbanners fu-hidden' }, ...divEls, ...bannerEls);
  const v = new THREE.Vector3(), vc = new THREE.Vector3();
  // The battle's centre (the middle of its soldiers; shared/geo battleCentre), refreshed at most once a second.
  let centre: { lat: number; lon: number } | null = null, centreAt = -1e9;
  function centreOfBattle(): { lat: number; lon: number } | null {
    const now = performance.now();
    if (now - centreAt > 1000) {
      centreAt = now;
      const ho = ctx.battle.active ? ctx.battle.handoff?.() ?? null : null;
      centre = ho ? battleCentre(ho) : null;
    }
    return centre;
  }
  // ---- the battle pointer ----
  const pArrow = h('span', { class: 'fu-bpointer-arrow' });
  const pText = h('span');
  const pGo = h('button', { class: 'fu-btn fu-btn--sm fu-btn--amber' }, tx('fr.pointer.go')) as HTMLButtonElement;
  const pointer = h('div', { class: 'fu-bpointer fu-hidden' }, pArrow, pText, pGo);
  tip(pGo, () => ({ title: t('fr.pointer.go'), text: t('fr.pointer.tip') }));
  pGo.addEventListener('click', () => {
    const p = ctx.battle.pointer?.();
    if (!p) return;
    hs.sound('whoosh');
    // Down to the line, looking across it from our side: the soldiers and both banners in view.
    void ctx.cameraRig.flyTo({ lat: p.lat, lon: p.lon, altitudeKm: 3, tilt: 1.12, heading: p.heading }, 1800);
  });
  function updatePointer(): void {
    const p = ctx.app.state === 'playing' ? ctx.battle.pointer?.() ?? null : null;
    toggleClass(pointer, 'fu-hidden', !p);
    if (!p) return;
    const W = window.innerWidth, H = window.innerHeight;
    const r = ctx.globe.surfaceRadiusAt(p.lat, p.lon);
    const la = (p.lat * Math.PI) / 180, lo = (p.lon * Math.PI) / 180;
    v.set(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
    const behind = vc.copy(v).sub(ctx.camera.position).dot(v) > 0;
    vc.copy(v).project(ctx.camera);
    let x = ((vc.x + 1) / 2) * W, y = ((1 - vc.y) / 2) * H;
    const bw = pointer.offsetWidth || 300, bh = pointer.offsetHeight || 32;
    // On screen: the label stands just above the point, an arrow pointing down at it. Off screen: it waits at the top
    // centre of the view (under the top bar, clear of the side panels) with an arrow turned toward the battle.
    const inView = !behind && vc.z < 1 && x > bw / 2 + 10 && x < W - bw / 2 - 10 && y > bh + 150 && y < H - 130;
    let angle = 90;
    let px = x - bw / 2, py = y - bh - 14;
    if (!inView) {
      let dx = vc.x, dy = -vc.y;
      if (behind || vc.z >= 1) {
        dx = -dx;
        dy = Math.abs(dy) + 1;
      }
      angle = (Math.atan2(dy * H, dx * W) * 180) / Math.PI;
      px = W / 2 - bw / 2;
      py = 118;
      // Clear of every HUD panel: step down until free.
      const rects: { left: number; right: number; top: number; bottom: number }[] = [...ctx.ui.getOccludedRects()];
      if (!el.classList.contains('fu-hidden')) rects.push(el.getBoundingClientRect());
      for (let k = 0; k < 12; k++) {
        const hit = rects.some((r) => px < r.right && px + bw > r.left && py < r.bottom && py + bh > r.top);
        if (!hit) break;
        py += 34;
      }
    }
    const text = t('fr.pointer', { front: frontName(hs, p.frontKey) || t('fr.front'), km: formatNumber(Math.round(p.km)) });
    if (pText.textContent !== text) setText(pText, text);
    if (pArrow.textContent !== '➤') setText(pArrow, '➤');
    pArrow.style.transform = `rotate(${angle.toFixed(0)}deg)`;
    px = Math.max(8, Math.min(W - bw - 8, px));
    py = Math.max(8, Math.min(H - bh - 110, py));
    pointer.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
  }

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
    pointer,
    update() {
      updatePointer();
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
          bannerText[k] = t(att === b.owner && f && !f.quiet ? 'fr.banner.attacks' : 'fr.banner.defends', { name: hs.name(b.owner) || '—' });
        }
      }
      // Banners follow the camera every frame. Each stands at the first of its spots (behind its side's line) that is
      // on screen, clear of every HUD panel and of the strip, and not on the other banner.
      const cam = ctx.camera;
      const W = window.innerWidth, H = window.innerHeight;
      const rects = ctx.ui.getOccludedRects();
      const sr = el.getBoundingClientRect();
      let taken: { l: number; r: number; t: number; b: number } | null = null;
      for (let k = 0; k < 2; k++) {
        const b = bv.banners[k];
        const e = bannerEls[k];
        const bw = e.offsetWidth || 170, bh = e.offsetHeight || 26;
        let px = 0, py = 0, found = false;
        for (const sp of b.spots.length ? b.spots : [b]) {
          v.set(sp.x, sp.y, sp.z);
          vc.copy(v).project(cam);
          if (!(vc.z < 1 && Math.abs(vc.x) < 1.05 && Math.abs(vc.y) < 1.05)) continue;
          const x = ((vc.x + 1) / 2) * W, y = ((1 - vc.y) / 2) * H;
          const box = { l: x + 2, r: x + 14 + bw, t: y - 46, b: y - 34 + bh };
          if (box.l < 4 || box.r > W - 4 || box.t < 4 || box.b > H - 4) continue;
          const hit = (r: { left: number; right: number; top: number; bottom: number }) =>
            box.l < r.right && box.r > r.left && box.t < r.bottom && box.b > r.top;
          if (rects.some(hit) || (sr.width > 0 && hit(sr))) continue;
          if (taken && box.l < taken.r && box.r > taken.l && box.t < taken.b && box.b > taken.t) continue;
          px = x;
          py = y;
          taken = box;
          found = true;
          break;
        }
        let edge = '';
        if (!found) {
          // No spot of that side is in view (a low camera looking at the other side, W6 final): the banner waits at the
          // edge of the screen toward its side's line, clear of the panels and of the other banner.
          const sp = b.spots.length ? b.spots[0] : b;
          v.set(sp.x, sp.y, sp.z);
          vc.copy(v).project(cam);
          const behind = !(vc.z < 1);
          let dx = vc.x, dy = -vc.y;
          if (behind) {
            dx = -dx;
            dy = Math.abs(dy) + 1;
          }
          const m = Math.max(Math.abs(dx) / 0.8, Math.abs(dy) / 0.7, 1e-6);
          const ex = W / 2 + (dx / m) * (W / 2), ey = H / 2 + (dy / m) * (H / 2);
          edge = Math.abs(dx) / 0.8 >= Math.abs(dy) / 0.7 ? (dx < 0 ? '◀ ' : '▶ ') : dy < 0 ? '▲ ' : '▼ ';
          const alongX = edge === '▲ ' || edge === '▼ ';
          // Along the edge first, then further in (the top and the sides are lined with HUD panels).
          const inX = edge === '◀ ' ? 1 : edge === '▶ ' ? -1 : 0, inY = edge === '▲ ' ? 1 : edge === '▼ ' ? -1 : 0;
          search: for (const inward of [0, 50, 100, 150, 200, 260, 330]) {
            for (const off of [0, 60, -60, 120, -120, 200, -200, 300, -300]) {
              const x = Math.max(12, Math.min(W - bw - 30, (alongX ? ex + off : ex) - (edge === '▶ ' ? bw + 20 : 0) + inX * inward));
              const y = Math.max(52, Math.min(H - 12, (alongX ? ey : ey + off) + inY * inward));
              const box = { l: x + 2, r: x + 14 + bw, t: y - 46, b: y - 34 + bh };
              if (box.l < 4 || box.r > W - 4 || box.t < 4 || box.b > H - 4) continue;
              const hit = (r: { left: number; right: number; top: number; bottom: number }) =>
                box.l < r.right && box.r > r.left && box.t < r.bottom && box.b > r.top;
              if (rects.some(hit) || (sr.width > 0 && hit(sr))) continue;
              if (taken && box.l < taken.r && box.r > taken.l && box.t < taken.b && box.b > taken.t) continue;
              px = x;
              py = y;
              taken = box;
              found = true;
              break search;
            }
          }
        }
        const text = `${edge}${bannerText[k]}`;
        if (e.dataset.t !== text) {
          e.dataset.t = text;
          setText(e, text);
        }
        toggleClass(e, 'is-edge', !!edge);
        if (!found) {
          e.style.display = 'none';
          continue;
        }
        e.style.display = '';
        e.style.transform = `translate(${(px + 8).toFixed(1)}px, ${(py - 40).toFixed(1)}px)`;
      }
      // Division markers: where the formation is, when it is on screen and clear of the panels and the banners.
      const view = ctx.sim.view;
      const markBoxes: { l: number; r: number; t: number; b: number }[] = [];
      for (let k = 0; k < divEls.length; k++) {
        const e = divEls[k];
        const d = bv.divisions[k];
        const u = d ? view.units.get(d.unitId) : undefined;
        if (!d || !u) {
          e.style.display = 'none';
          divIds[k] = 0;
          continue;
        }
        if (divIds[k] !== d.unitId) {
          divIds[k] = d.unitId;
          e.style.setProperty('--c', hexToCss(view.players[d.owner]?.color ?? 0x888888));
        }
        v.set(d.x, d.y, d.z);
        vc.copy(v).project(cam);
        const bw = e.offsetWidth || 150, bh = e.offsetHeight || 18;
        let x = ((vc.x + 1) / 2) * W, y = ((1 - vc.y) / 2) * H;
        // Off screen (or behind the camera): the marker waits at the edge of the view, on the division's side, with its
        // bearing and distance, so the player knows where the armour is.
        const behind = !(vc.z < 1);
        const inView = !behind && x - bw / 2 > 8 && x + bw / 2 < W - 8 && y - bh - 6 > 8 && y < H - 8;
        let edge = '';
        if (!inView) {
          let dx = vc.x, dy = -vc.y;
          if (behind) {
            dx = -dx;
            dy = Math.abs(dy) + 1;
          }
          const m = Math.max(Math.abs(dx) / 0.62, Math.abs(dy) / 0.62, 1e-6);
          x = W / 2 + (dx / m) * (W / 2);
          y = H / 2 + (dy / m) * (H / 2);
          edge = Math.abs(dx) * H > Math.abs(dy) * W * 0.9 ? (dx < 0 ? '◀ ' : '▶ ') : dy < 0 ? '▲ ' : '▼ ';
        }
        // Off screen: how far it is from the battle's centre (the same distance command mode shows, #24).
        let km = d.km;
        if (edge) {
          const c = centreOfBattle();
          if (c) {
            const ul = tileXYToLatLon(u.x, u.y);
            km = greatCircleKm(ul.lat, ul.lon, c.lat, c.lon);
          }
        }
        const text = `${edge}▣ ${unitLabel(u.type, u.serial)} · ${hs.name(d.owner) || '—'}${edge ? ` · ${t('battle.div.fromBattle', { km: formatNumber(km, km < 10 ? 1 : 0) })}` : ''}`;
        if (e.dataset.t !== text) {
          e.dataset.t = text;
          setText(e, text);
        }
        toggleClass(e, 'is-edge', !!edge);
        toggleClass(e, 'is-sel', hs.selection.kind === 'unit' && hs.selection.id === d.unitId);
        // Above its formation, else a little lower or higher, clear of the panels, the strip, the banners and the other
        // markers.
        let placedBox: { l: number; r: number; t: number; b: number } | null = null;
        // (Then shifted toward the middle of the screen, off a side panel.)
        const toMid = x < W / 2 ? 1 : -1;
        const tries: [number, number][] = [];
        for (const dx of [0, 0.7, 1.4]) for (const dy of [0, 26, -26, 52]) tries.push([dx * bw * toMid, dy]);
        for (const [dx, dy] of tries) {
          const box = { l: x - bw / 2 + dx, r: x + bw / 2 + dx, t: y - bh - 6 + dy, b: y - 6 + dy };
          const hit = (r: { left: number; right: number; top: number; bottom: number }) =>
            box.l < r.right && box.r > r.left && box.t < r.bottom && box.b > r.top;
          if (box.t < 4 || box.b > H - 4) continue;
          if (rects.some(hit) || (sr.width > 0 && hit(sr)) || bannerEls.some((b) => b.style.display !== 'none' && hit(b.getBoundingClientRect()))) continue;
          if (markBoxes.some((q) => box.l < q.r && box.r > q.l && box.t < q.b && box.b > q.t)) continue;
          placedBox = box;
          break;
        }
        if (!placedBox) {
          e.style.display = 'none';
          continue;
        }
        markBoxes.push(placedBox);
        e.style.display = '';
        e.style.transform = `translate(${placedBox.l.toFixed(1)}px, ${placedBox.t.toFixed(1)}px)`;
      }
    },
  };
}
