// FRONT ULTRA — front badges on the globe (DESIGN_V2 §11.2; owner: ui, W6).
//
// At the middle of every front band (render/battle/overlay.ts draws the band and the arrows) a small card says, from
// orbit, who fights whom and who is winning:
//   [ESP] ▶ [TÚ]          the two nations' colour chips with their ISO3 codes (attacker left, «TÚ» for the human);
//   ████████░░░░          the tug of war: the attacker's share of the power on this front, Pa / (Pa + Pd);
//   ▶ 5 km/h · consolidando   the MEASURED advance (or «‖ estancado», «contacto», «en calma» on a quiet front);
//   ▣2  ▣1                the divisions attached on each side.
// Hover: names, troops and garrisons per side, casualties, days of fighting, divisions. Click: the front is selected
// (bus 'frontSelected': the Guerra panel opens on it and the camera flies there).
// Shown above 150 km in the strategic view (hidden in command mode and at ground level, where the HUD strip takes
// over), decluttered: fronts involving the human first, then the hottest; a badge never covers another one or a HUD
// panel. Quiet fronts get a badge only when the human is on one side of them.

import { h, setText, toggleClass } from '../dom';
import { tip } from '../tooltip';
import { hexToCss } from '../../shared/color';
import { HUMAN_ID, MAP_H } from '../../shared/constants';
import { latLonToVec3, tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import type { FrontView, LatLon } from '../../shared/types';
import * as THREE from 'three';
import { frontName } from './forcesInfo';
import { advanceText, combatDays, frontAnchor, isoOf, sidesOf, troopsText } from './frontsInfo';
import type { HudShared } from './shared';

/** Badges show above this camera altitude (km): the same threshold as the orbit overlay. */
const BADGE_MIN_ALT = 150;
const MAX_BADGES = 14;

interface Badge {
  key: number;
  el: HTMLElement;
  chipA: HTMLElement;
  chipB: HTMLElement;
  dir: HTMLElement;
  barA: HTMLElement;
  barB: HTMLElement;
  adv: HTMLElement;
  divA: HTMLElement;
  divB: HTMLElement;
  /** World anchor (unit sphere, slightly lifted) and priority for the declutter. */
  pos: THREE.Vector3;
  /** A point 1.5 tiles behind the line on the attacker's side: the badge is pushed that way, off the band. */
  back: THREE.Vector3;
  prio: number;
  seen: boolean;
  /** Leader line from the front's middle to the badge. */
  lead: HTMLElement;
  w: number;
  hgt: number;
}

export interface FrontBadges {
  el: HTMLElement;
  update(): void;
  clear(): void;
  /** Tests: keys of the badges on screen with their client rectangles. */
  shown(): { key: number; x: number; y: number; w: number; h: number; text: string }[];
}

export function createFrontBadges(hs: HudShared): FrontBadges {
  const ctx = hs.ctx;
  const el = h('div', { class: 'fu-fbadges' });
  const badges = new Map<number, Badge>();
  const ll: LatLon = { lat: 0, lon: 0 };
  const anchor = { x: 0, y: 0 };
  const v = new THREE.Vector3(), camPos = new THREE.Vector3(), vc = new THREE.Vector3();
  let contentAcc = 0;
  let lastFronts: readonly FrontView[] | null = null;
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const order: Badge[] = [];

  function make(key: number): Badge {
    const chipA = h('span', { class: 'fu-fb-chip' });
    const chipB = h('span', { class: 'fu-fb-chip' });
    const dir = h('span', { class: 'fu-fb-dir' });
    const barA = h('i', { class: 'fu-fb-a' });
    const barB = h('i', { class: 'fu-fb-b' });
    const adv = h('div', { class: 'fu-fb-adv fu-mono' });
    const divA = h('span', { class: 'fu-fb-div' });
    const divB = h('span', { class: 'fu-fb-div' });
    const lead = h('i', { class: 'fu-fb-lead' });
    const e = h('div', { class: 'fu-fb fu-interactive' }, lead,
      h('div', { class: 'fu-fb-row' }, chipA, dir, chipB),
      h('div', { class: 'fu-fb-bar' }, barA, barB),
      adv,
      h('div', { class: 'fu-fb-divs' }, divA, divB),
    );
    e.dataset.key = String(key);
    e.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hs.sound('click');
      ctx.bus.emit('frontSelected', { key, fly: true });
    });
    tip(e, () => badgeTip(key));
    el.append(e);
    return { key, el: e, lead, chipA, chipB, dir, barA, barB, adv, divA, divB, pos: new THREE.Vector3(), back: new THREE.Vector3(), prio: 0, seen: false, w: 120, hgt: 60 };
  }

  function badgeTip(key: number) {
    const view = ctx.sim.view;
    const f = view.frontByKey.get(key);
    if (!f) return { title: t('fr.gone') };
    const s = sidesOf(view, f);
    const name = frontName(hs, key) || t('fr.front');
    const now: [string, string][] = [
      [t('fr.tip.attacker'), `${hs.name(s.att)}${s.quiet ? '' : ` · ${troopsText(s.lead?.troops ?? 0)}`}`],
      [t('fr.tip.defender'), hs.name(s.def)],
      [t('fr.tip.garrisons'), `${troopsText(s.garAtt)} / ${troopsText(s.garDef)}`],
      [t('fr.tip.balance'), `${formatNumber(Math.round(s.share * 100))} % / ${formatNumber(Math.round((1 - s.share) * 100))} %`],
      [t('fr.tip.advance'), advanceText(view, f, s, false)],
      [t('fr.tip.casualties'), `${troopsText(s.casAtt)} / ${troopsText(s.casDef)}`],
      [t('fr.tip.days'), formatNumber(combatDays(view, f), 1)],
      [t('fr.tip.divisions'), `${s.divAtt} / ${s.divDef}`],
    ];
    return { title: name, text: t(s.quiet ? 'fr.tip.quiet' : 'fr.tip.text'), now, lines: [t('fr.tip.click')], hotkey: 'G' };
  }

  function paint(b: Badge, f: FrontView): void {
    const view = ctx.sim.view;
    const s = sidesOf(view, f);
    const ca = view.players[s.att]?.color ?? 0x888888, cb = view.players[s.def]?.color ?? 0x888888;
    b.chipA.style.setProperty('--c', hexToCss(ca));
    b.chipB.style.setProperty('--c', hexToCss(cb));
    setText(b.chipA, isoOf(view, s.att));
    setText(b.chipB, isoOf(view, s.def));
    toggleClass(b.chipA, 'is-you', s.att === HUMAN_ID);
    toggleClass(b.chipB, 'is-you', s.def === HUMAN_ID);
    setText(b.dir, s.quiet ? '·' : s.gaining < 0 ? '◀' : s.gaining > 0 ? '▶' : '‖');
    b.barA.style.width = `${(s.share * 100).toFixed(1)}%`;
    b.barB.style.width = `${((1 - s.share) * 100).toFixed(1)}%`;
    b.barA.style.background = hexToCss(ca);
    b.barB.style.background = hexToCss(cb);
    setText(b.adv, advanceText(view, f, s));
    setText(b.divA, s.divAtt > 0 ? `▣${s.divAtt}` : '');
    setText(b.divB, s.divDef > 0 ? `▣${s.divDef}` : '');
    toggleClass(b.el, 'is-quiet', s.quiet);
    toggleClass(b.el, 'is-human', f.a === HUMAN_ID || f.b === HUMAN_ID);
    toggleClass(b.el, 'is-losing', s.def === HUMAN_ID && s.gaining > 0);
    b.el.dataset.att = String(s.att);
    b.el.dataset.def = String(s.def);
    b.el.dataset.share = s.share.toFixed(3);
    b.el.dataset.gaining = String(s.gaining);
  }

  function refreshContent(): void {
    const view = ctx.sim.view;
    for (const b of badges.values()) b.seen = false;
    order.length = 0;
    for (const f of view.fronts) {
      if (f.b === 0 || f.a === 0) continue;
      const human = f.a === HUMAN_ID || f.b === HUMAN_ID;
      if (f.quiet && !human) continue;
      let b = badges.get(f.key);
      if (!b) {
        b = make(f.key);
        badges.set(f.key, b);
      }
      b.seen = true;
      frontAnchor(f, anchor);
      tileXYToLatLon(anchor.x, anchor.y, ll);
      latLonToVec3(ll.lat, ll.lon, 1.003, b.pos);
      const sgn = sidesOf(ctx.sim.view, f).att === f.a ? -1.5 : 1.5;
      tileXYToLatLon(anchor.x + f.dirX * sgn, Math.max(0, Math.min(MAP_H - 1, anchor.y + f.dirY * sgn)), ll);
      latLonToVec3(ll.lat, ll.lon, 1.003, b.back);
      b.prio = (human ? 10 : 0) + (f.quiet ? 0 : 5) + f.intensity;
      paint(b, f);
      order.push(b);
    }
    for (const [k, b] of badges) {
      if (b.seen) continue;
      b.el.remove();
      badges.delete(k);
    }
    order.sort((p, q) => q.prio - p.prio || p.key - q.key);
    // Measure once per content refresh (the layout is stable between refreshes).
    for (const b of order) {
      b.w = b.el.offsetWidth || 120;
      b.hgt = b.el.offsetHeight || 60;
    }
  }

  function position(): void {
    const cam = ctx.camera;
    camPos.copy(cam.position);
    const W = window.innerWidth, H = window.innerHeight;
    placed.length = 0;
    for (const r of ctx.ui.getOccludedRects()) placed.push({ x0: r.left, y0: r.top, x1: r.right, y1: r.bottom });
    let n = 0;
    for (const b of order) {
      v.copy(b.pos);
      const facing = vc.copy(camPos).sub(v).dot(v) > 0;
      vc.copy(v).project(cam);
      let ok = facing && vc.z < 1 && Math.abs(vc.x) < 0.98 && Math.abs(vc.y) < 0.98 && n < MAX_BADGES;
      const x = ((vc.x + 1) / 2) * W, y = ((1 - vc.y) / 2) * H;
      // The badge stands off the band on the attacker's side (behind its line), so the band, its chevrons and the
      // arrowhead stay visible; a short leader line ties it to the middle of the front.
      vc.copy(b.back).project(cam);
      let bx = ((vc.x + 1) / 2) * W - x, by = ((1 - vc.y) / 2) * H - y;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-3) {
        bx = 0;
        by = -1;
      } else {
        bx /= bl;
        by /= bl;
      }
      // Distance from the anchor to the badge rectangle's edge along (bx, by), plus a gap.
      const reach = Math.min(Math.abs(bx) > 1e-3 ? b.w / 2 / Math.abs(bx) : 1e9, Math.abs(by) > 1e-3 ? b.hgt / 2 / Math.abs(by) : 1e9) + 26;
      const cx = x + bx * reach, cy = y + by * reach;
      const x0 = cx - b.w / 2, y0 = cy - b.hgt / 2, x1 = x0 + b.w, y1 = y0 + b.hgt;
      b.lead.style.transform = `translate(${(x - x0).toFixed(1)}px, ${(y - y0).toFixed(1)}px) rotate(${Math.atan2(by, bx).toFixed(3)}rad)`;
      b.lead.style.width = `${Math.max(0, reach - Math.min(b.w, b.hgt) * 0.3).toFixed(0)}px`;
      if (ok) {
        for (const r of placed) {
          if (x0 < r.x1 && x1 > r.x0 && y0 < r.y1 && y1 > r.y0) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) {
        if (b.el.style.display !== 'none') b.el.style.display = 'none';
        continue;
      }
      placed.push({ x0, y0, x1, y1 });
      n++;
      if (b.el.style.display === 'none') b.el.style.display = '';
      b.el.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`;
    }
  }

  return {
    el,
    update() {
      const view = ctx.sim.view;
      const alt = ctx.cameraRig.getState().altitudeKm;
      const on = ctx.app.state === 'playing' && view.phase === 'playing' && alt > BADGE_MIN_ALT;
      toggleClass(el, 'fu-hidden', !on);
      if (!on) return;
      const dt = ctx.frame.dt;
      contentAcc += dt;
      if (view.fronts !== lastFronts || contentAcc > 0.25) {
        lastFronts = view.fronts;
        contentAcc = 0;
        refreshContent();
      }
      position();
    },
    clear() {
      for (const b of badges.values()) b.el.remove();
      badges.clear();
      order.length = 0;
      lastFronts = null;
    },
    shown() {
      const out: { key: number; x: number; y: number; w: number; h: number; text: string }[] = [];
      for (const b of order) {
        if (b.el.style.display === 'none' || el.classList.contains('fu-hidden')) continue;
        const r = b.el.getBoundingClientRect();
        out.push({ key: b.key, x: r.left, y: r.top, w: r.width, h: r.height, text: b.el.textContent ?? '' });
      }
      return out;
    },
  };
}
