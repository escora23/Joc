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
import { takeControlAtFront } from './takeAction';
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
import { labelRects } from '../../render/globe/labels';

/** Badges show above this camera altitude (km): the same threshold as the orbit overlay. */
const BADGE_MIN_ALT = 150;
const MAX_BADGES = 14;

/** Distance (px) between segment a-b and an axis-aligned rectangle (0 when they touch). */
function segRectDist(ax: number, ay: number, bx: number, by: number, x0: number, y0: number, x1: number, y1: number): number {
  const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  if (inside(ax, ay) || inside(bx, by)) return 0;
  // Segment against the four edges.
  const cross = (px: number, py: number, qx: number, qy: number, rx: number, ry: number, sx: number, sy: number): boolean => {
    const d = (qx - px) * (sy - ry) - (qy - py) * (sx - rx);
    if (Math.abs(d) < 1e-9) return false;
    const t = ((rx - px) * (sy - ry) - (ry - py) * (sx - rx)) / d, u = ((rx - px) * (qy - py) - (ry - py) * (qx - px)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  if (cross(ax, ay, bx, by, x0, y0, x1, y0) || cross(ax, ay, bx, by, x1, y0, x1, y1) || cross(ax, ay, bx, by, x1, y1, x0, y1) || cross(ax, ay, bx, by, x0, y1, x0, y0)) return 0;
  const ptSeg = (px: number, py: number): number => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    return Math.hypot(ax + dx * t - px, ay + dy * t - py);
  };
  const ptRect = (px: number, py: number): number => Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(y0 - py, 0, py - y1));
  return Math.min(ptRect(ax, ay), ptRect(bx, by), ptSeg(x0, y0), ptSeg(x1, y0), ptSeg(x0, y1), ptSeg(x1, y1));
}

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
  /** The sky over the front (#25): who has more fighters on patrol there, and the drones in support. */
  sky: HTMLElement;
  divs: HTMLElement;
  /** World anchor (unit sphere, slightly lifted) and priority for the declutter. */
  pos: THREE.Vector3;
  /** A point 1.5 tiles behind the line on the attacker's side: the badge is pushed that way, off the band. */
  back: THREE.Vector3;
  /**
   * What the badge must not cover, in world points (W6 final): the band's polyline, the mobilization arrows' reach on
   * the aggressor's side while it mobilizes, and each offensive's operational arrow (tail, tip); the preferred side.
   */
  line: THREE.Vector3[];
  mob: THREE.Vector3[];
  arrows: THREE.Vector3[];
  side: 1 | -1;
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
    const sky = h('span', { class: 'fu-fb-sky' });
    const divs = h('div', { class: 'fu-fb-divs' }, divA, sky, divB);
    const lead = h('i', { class: 'fu-fb-lead' });
    // Owner item 32: every battle of the human's carries «Tomar el control aquí» on its marker (one click).
    const take = h('button', { class: 'fu-fb-take', type: 'button' }) as HTMLButtonElement;
    const e = h('div', { class: 'fu-fb fu-interactive' }, lead,
      h('div', { class: 'fu-fb-row' }, chipA, dir, chipB),
      h('div', { class: 'fu-fb-bar' }, barA, barB),
      adv,
      divs,
      take,
    );
    take.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hs.sound('click');
      takeControlAtFront(hs, key);
    });
    tip(take, () => ({ title: t('hud.takeHere'), text: t('hud.takeHere.tip'), hotkey: 'T' }));
    e.dataset.key = String(key);
    e.addEventListener('click', (ev) => {
      ev.stopPropagation();
      hs.sound('click');
      ctx.bus.emit('frontSelected', { key, fly: true });
    });
    // Feedback 3 (#26): double click takes control at this front (the unit engaged there goes to the action).
    e.addEventListener('dblclick', (ev) => {
      ev.stopPropagation();
      const f = ctx.sim.view.frontByKey.get(key);
      if (f && (f.a === HUMAN_ID || f.b === HUMAN_ID)) takeControlAtFront(hs, key);
    });
    tip(e, () => badgeTip(key));
    el.append(e);
    return {
      key, el: e, lead, chipA, chipB, dir, barA, barB, adv, divA, divB, sky, divs, pos: new THREE.Vector3(), back: new THREE.Vector3(), prio: 0, seen: false,
      w: 120, hgt: 60, line: [], mob: [], arrows: [], side: 1,
    };
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
    // Feedback 3 (#28): what supports the lead offensive, and its power from them (the same numbers as the Guerra panel).
    if (s.lead && !s.quiet) {
      const d = s.lead.divAtk ?? 0;
      now.push([t('fr.tip.support'), t('fr.tip.supportV', { d, pct: Math.round((Math.min(2, 1 + 0.25 * d) - 1) * 100), dd: s.lead.divDef ?? 0 })]);
    }
    const air = skyOf(f, s.att);
    if (air.any) now.push([t('fr.tip.sky'), t('fr.tip.skyV', { a: air.att, d: air.def, ca: air.casAtt, cd: air.casDef, who: air.owner ? hs.name(air.owner) : t('fr.tip.skyNobody') })]);
    const mine = f.a === HUMAN_ID || f.b === HUMAN_ID;
    return { title: name, text: t(s.quiet ? 'fr.tip.quiet' : 'fr.tip.text'), now, lines: mine ? [t('fr.tip.click'), t('hud.takeHere.badge')] : [t('fr.tip.click')], hotkey: 'G' };
  }

  /** Fighters on patrol and drones in support over the front, per side (attacker first), and who owns the sky. */
  function skyOf(f: FrontView, att: number) {
    const aIsAtt = f.a === att;
    const fa = f.airA ?? 0, fb = f.airB ?? 0, ca = f.casA ?? 0, cb = f.casB ?? 0;
    const owner = fa > fb ? f.a : fb > fa ? f.b : 0;
    return {
      att: aIsAtt ? fa : fb, def: aIsAtt ? fb : fa, casAtt: aIsAtt ? ca : cb, casDef: aIsAtt ? cb : ca,
      owner, any: fa + fb + ca + cb > 0,
    };
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
    // The sky (#25): «✈» in the colour of the side that owns it (more fighters on patrol over the line), dim if nobody.
    const air = skyOf(f, s.att);
    setText(b.sky, air.any ? '✈' : '');
    b.sky.style.color = air.owner ? hexToCss(view.players[air.owner]?.color ?? 0x888888) : '';
    toggleClass(b.divs, 'fu-hidden', !b.divA.textContent && !b.divB.textContent && !b.sky.textContent);
    toggleClass(b.el, 'is-quiet', s.quiet);
    toggleClass(b.el, 'is-human', f.a === HUMAN_ID || f.b === HUMAN_ID);
    // A battle being fought now (an offensive on the front): the marker pulses.
    toggleClass(b.el, 'is-battle', !s.quiet);
    const takeBtn = b.el.querySelector('.fu-fb-take') as HTMLElement | null;
    if (takeBtn) setText(takeBtn, `⌖ ${t('hud.takeHere')}`);
    toggleClass(b.el, 'is-losing', s.def === HUMAN_ID && s.gaining > 0);
    b.el.dataset.att = String(s.att);
    b.el.dataset.def = String(s.def);
    b.el.dataset.share = s.share.toFixed(3);
    b.el.dataset.gaining = String(s.gaining);
  }

  /** World point of continuous tile coords into `out` (reused vectors). */
  function worldAt(arr: THREE.Vector3[], i: number, x: number, y: number): void {
    if (!arr[i]) arr[i] = new THREE.Vector3();
    tileXYToLatLon(x, Math.max(0, Math.min(MAP_H - 1e-3, y)), ll);
    latLonToVec3(ll.lat, ll.lon, 1.003, arr[i]);
  }

  /**
   * What a badge must keep clear of (4 Hz): the band's line (subsampled to ≤ 24 points), the mobilization arrows' reach
   * on the aggressor's side (0.6-3.6 tiles back from the border) while it mobilizes, and each offensive's arrow on the
   * front, from 3 tiles behind its live contact to its axis point. The badge prefers the attacker's side, the target's
   * side while the aggressor mobilizes (its arrows fill the other one).
   */
  function obstacles(b: Badge, f: FrontView, att: number): void {
    const view = ctx.sim.view;
    const s = f.samples;
    const n = s.length >> 1;
    const step = Math.max(1, Math.ceil(n / 24));
    let k = 0;
    for (let v = 0; v < n; v += step) worldAt(b.line, k++, s[v * 2] + f.dirX * 0.5, s[v * 2 + 1] + f.dirY * 0.5);
    if (n > 1 && (n - 1) % step !== 0) worldAt(b.line, k++, s[(n - 1) * 2] + f.dirX * 0.5, s[(n - 1) * 2 + 1] + f.dirY * 0.5);
    b.line.length = k;
    const w = view.warBetween(f.a, f.b);
    const mobilizing = !!w && view.tick < w.mobilizeUntilTick;
    k = 0;
    if (mobilizing && w) {
      const sg = f.a === w.aggressor ? -1 : 1;
      for (let v = 0; v < n; v += step) worldAt(b.mob, k++, s[v * 2] + f.dirX * (0.5 + 2.1 * sg), s[v * 2 + 1] + f.dirY * (0.5 + 2.1 * sg));
    }
    b.mob.length = k;
    k = 0;
    for (const a of view.attacks) {
      if (a.frontKey !== f.key || a.naval || a.state === 'retreating' || a.defender === 0) continue;
      const cx = a.contactX >= 0 ? a.contactX : a.originX, cy = a.contactX >= 0 ? a.contactY : a.originY;
      if (cx < 0) continue;
      let dx = a.x - cx, dy = a.y - cy;
      if (dx > 800) dx -= 1600;
      else if (dx < -800) dx += 1600;
      const l = Math.hypot(dx, dy);
      const ux = l > 0.3 ? dx / l : f.dirX * (a.attacker === f.a ? 1 : -1), uy = l > 0.3 ? dy / l : f.dirY * (a.attacker === f.a ? 1 : -1);
      worldAt(b.arrows, k++, cx - ux * 3, cy - uy * 3);
      worldAt(b.arrows, k++, l > 2 ? a.x : cx + ux * 2, l > 2 ? a.y : cy + uy * 2);
    }
    b.arrows.length = k;
    const attSide = att === f.a ? -1 : 1;
    b.side = (mobilizing && w ? (f.a === w.aggressor ? 1 : -1) : attSide) as 1 | -1;
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
      const sd = sidesOf(ctx.sim.view, f);
      const sgn = sd.att === f.a ? -1.5 : 1.5;
      tileXYToLatLon(anchor.x + f.dirX * sgn, Math.max(0, Math.min(MAP_H - 1, anchor.y + f.dirY * sgn)), ll);
      latLonToVec3(ll.lat, ll.lon, 1.003, b.back);
      obstacles(b, f, sd.att);
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

  /** Candidate gaps (px) between the band's middle and the badge's edge, nearest first. */
  const GAPS = [16, 30, 48, 70, 96, 130, 170];
  const segA: number[] = [], segB: number[] = [], segC: number[] = [];

  /** +1 when b.back (the attacker's side) is the side b.side names, else -1. */
  function sideOfBack(b: Badge): 1 | -1 {
    const f = ctx.sim.view.frontByKey.get(b.key);
    if (!f) return b.side;
    const att = sidesOf(ctx.sim.view, f).att;
    return (att === f.a ? -1 : 1) as 1 | -1;
  }

  /** Project world points to screen px pairs (NaN for points behind the globe or the camera). */
  function project(pts: THREE.Vector3[], out: number[]): void {
    const cam = ctx.camera;
    const W = window.innerWidth, H = window.innerHeight;
    out.length = pts.length * 2;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const facing = vc.copy(camPos).sub(p).dot(p) > 0;
      vc.copy(p).project(cam);
      if (!facing || vc.z > 1) {
        out[i * 2] = NaN;
        out[i * 2 + 1] = NaN;
        continue;
      }
      out[i * 2] = ((vc.x + 1) / 2) * W;
      out[i * 2 + 1] = ((1 - vc.y) / 2) * H;
    }
  }

  /** Does the rectangle come within `half` px of the polyline (pairs = separate segments)? */
  function hitsPolyline(pts: number[], x0: number, y0: number, x1: number, y1: number, half: number, pairs: boolean): boolean {
    const n = pts.length >> 1;
    for (let i = 0; i + 1 < n; i += pairs ? 2 : 1) {
      const ax = pts[i * 2], ay = pts[i * 2 + 1], qx = pts[i * 2 + 2], qy = pts[i * 2 + 3];
      if (!Number.isFinite(ax) || !Number.isFinite(qx)) continue;
      if (segRectDist(ax, ay, qx, qy, x0, y0, x1, y1) < half) return true;
    }
    if (n === 1 && Number.isFinite(pts[0])) return segRectDist(pts[0], pts[1], pts[0], pts[1], x0, y0, x1, y1) < half;
    return false;
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
      // The badge stands off the band (W6 final: clear of the band's whole screen polyline, not only its middle's
      // normal), on its preferred side, as close as it can: the band, its chevrons, the mobilization arrows and the
      // operational arrow stay visible; a short leader line ties it to the middle of the front.
      vc.copy(b.back).project(cam);
      let bx = ((vc.x + 1) / 2) * W - x, by = ((1 - vc.y) / 2) * H - y;
      const bl = Math.hypot(bx, by);
      // Pixels per tile at the anchor (b.back is 1.5 tiles away): the band is 0.75 tile wide each side, ≥ 7 px.
      const tilePx = bl / 1.5;
      if (bl < 1e-3) {
        bx = 0;
        by = -1;
      } else {
        bx /= bl;
        by /= bl;
      }
      if (b.side !== sideOfBack(b)) {
        bx = -bx;
        by = -by;
      }
      const bandHalf = Math.max(9, tilePx * 0.75) + 4;
      const mobHalf = tilePx * 1.5 + 8;
      project(b.line, segA);
      project(b.mob, segB);
      project(b.arrows, segC);
      let cx = 0, cy = 0, reach = 26, found = false;
      for (const sd of [1, -1]) {
        const dx = bx * sd, dy = by * sd;
        const r0 = Math.min(Math.abs(dx) > 1e-3 ? b.w / 2 / Math.abs(dx) : 1e9, Math.abs(dy) > 1e-3 ? b.hgt / 2 / Math.abs(dy) : 1e9);
        for (const gap of GAPS) {
          const px = x + dx * (r0 + gap), py = y + dy * (r0 + gap);
          const rx0 = px - b.w / 2, ry0 = py - b.hgt / 2, rx1 = rx0 + b.w, ry1 = ry0 + b.hgt;
          if (rx0 < 2 || ry0 < 2 || rx1 > W - 2 || ry1 > H - 2) continue;
          if (hitsPolyline(segA, rx0, ry0, rx1, ry1, bandHalf, false)) continue;
          if (hitsPolyline(segB, rx0, ry0, rx1, ry1, mobHalf, false)) continue;
          if (hitsPolyline(segC, rx0, ry0, rx1, ry1, 9, true)) continue;
          if (placed.some((r) => rx0 < r.x1 && rx1 > r.x0 && ry0 < r.y1 && ry1 > r.y0)) continue;
          // Nor over a nation's name on the map (the badge would cut «COMANDANTE» in two).
          if (labelRects().some((r) => rx0 < r.x1 && rx1 > r.x0 && ry0 < r.y1 && ry1 > r.y0)) continue;
          cx = px;
          cy = py;
          reach = r0 + gap;
          bx = dx;
          by = dy;
          found = true;
          break;
        }
        if (found) break;
      }
      if (!found) {
        // Nowhere clear: the old place, just off the middle of the band on the preferred side.
        reach = Math.min(Math.abs(bx) > 1e-3 ? b.w / 2 / Math.abs(bx) : 1e9, Math.abs(by) > 1e-3 ? b.hgt / 2 / Math.abs(by) : 1e9) + 26;
        cx = x + bx * reach;
        cy = y + by * reach;
      }
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
