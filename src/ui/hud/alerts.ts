// FRONT ULTRA — alerts (DESIGN_V2 §8.1–§8.6; owner: ui, built by W3).
//
// One API for every located warning: the bus event `alert` (or ctx.ui.alert). An alert is
// {kind, severity, title, body, lat/lon, groupKey, actors, autoPause, ...} and goes to:
//
//   * the FEED (top-left, replaces the v1 toasts): at most 5 visible, newest on top, one entry per groupKey that updates
//     its numbers instead of stacking; clicking an entry flies the camera there (or opens the inbox item); × dismisses.
//     Critical alerts stay until acknowledged; the rest leave after 20 real seconds (held while the game is paused);
//   * the REGISTRO log (bell): the last 200 alerts, filterable, each clickable;
//   * GLOBE MARKERS: a pulsing ring with the alert icon at the place, projected at 10 Hz; an arrow on the screen edge
//     points to danger and critical alerts that are off-screen or behind the planet;
//   * MINIMAP PINGS (an expanding circle for 1.5 s), the ticker when asked, and the AUTO-PAUSE (§8.5): when the kind is
//     enabled in Settings > Juego the game pauses and a banner says why, with [Ver] and [Reanudar]. The camera never
//     moves by itself.
//
// Debug / verification hook: window.__fuAlerts (list, log, pings, markers, banner).

import { h, leave, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon } from '../icons';
import { openModal, type ModalHandle } from '../modal';
import { describePlace, describeTile } from '../places';
import { tip, type TipData } from '../tooltip';
import { tx } from '../tx';
import type { HudShared } from './shared';
import type { AlertInput, AlertSeverity, AutoPauseKind } from '../../shared/events';
import { FRONT_PRIORITY_WEIGHT, HUMAN_ID, MAP_W } from '../../shared/constants';
import { latLonToVec3, tileToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import type { FrontView, GameSpeed } from '../../shared/types';
import * as THREE from 'three';

export interface Alert {
  id: number;
  input: AlertInput;
  createdTick: number;
  updatedTick: number;
  /** Real ms left in the feed (held while paused); Infinity for sticky entries. */
  leftMs: number;
  acknowledged: boolean;
  count: number;
  el: HTMLElement | null;
  marker: HTMLElement | null;
}

export interface AlertCenter {
  feedEl: HTMLElement;
  markersEl: HTMLElement;
  bannerEl: HTMLElement;
  raise(input: AlertInput): Alert;
  /** Remove a grouped entry (the front went quiet, the proposal was answered...). */
  resolve(groupKey: string): void;
  update(dt: number): void;
  openLog(): void;
  clear(): void;
  /** Unacknowledged entries in the feed. */
  live(): Alert[];
  onPing: ((lat: number, lon: number, severity: AlertSeverity) => void) | null;
  onTicker: ((text: string, severity: 'info' | 'warning' | 'critical', lat?: number, lon?: number) => void) | null;
  onOpenProposal: ((id: number) => void) | null;
}

const SEV_ORDER: Record<AlertSeverity, number> = { info: 0, warning: 1, danger: 2, critical: 3 };
const SEV_ICON: Record<AlertSeverity, string> = { info: 'info', warning: 'warning', danger: 'attack', critical: 'warning' };
const FEED_MAX = 5;
const LOG_MAX = 200;
const DEFAULT_TTL_MS = 20_000;

export function createAlertCenter(hs: HudShared): AlertCenter {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  const list = h('div', { class: 'fu-alerts-list' });
  const logBtn = h('button', { class: 'fu-alerts-log fu-interactive' }, icon('bell'), tx('alerts.log'), h('span', { class: 'fu-alerts-n fu-mono' }));
  tip(logBtn, () => ({ title: t('alerts.log'), text: t('alerts.log.tip') }));
  const feedEl = h('div', { class: 'fu-alerts' }, list, logBtn);
  const markersEl = h('div', { class: 'fu-markers' });
  const bannerText = h('span', { class: 'fu-ap-text' });
  const bannerView = h('button', { class: 'fu-btn fu-btn--sm' }, icon('eye'), tx('alerts.autoPause.view'));
  const bannerResume = h('button', { class: 'fu-btn fu-btn--sm fu-btn--primary' }, icon('play'), tx('alerts.autoPause.resume'));
  tip(bannerView, () => ({ title: t('alerts.autoPause.view'), text: t('alerts.autoPause.view.tip') }));
  tip(bannerResume, () => ({ title: t('alerts.autoPause.resume'), text: t('alerts.autoPause.resume.tip') }));
  const bannerPrio = h('button', { class: 'fu-btn fu-btn--sm fu-hidden' }, icon('shield'), h('span', null, '')) as HTMLButtonElement;
  const bannerEl = h('div', { class: 'fu-autopause fu-interactive fu-hidden' },
    h('span', { class: 'fu-ap-kicker' }, icon('pause'), tx('alerts.autoPause.kicker')), bannerText, bannerPrio, bannerView, bannerResume);

  const all: Alert[] = [];
  const byGroup = new Map<string, Alert>();
  let nextId = 1;
  let pings = 0;
  let pausedBy: { alert: Alert; resume: GameSpeed } | null = null;
  const center: AlertCenter = {
    feedEl, markersEl, bannerEl, raise, resolve, update, openLog, clear,
    live: () => all.filter((a) => a.el && !a.acknowledged),
    onPing: null, onTicker: null, onOpenProposal: null,
  };

  const inGame = () => ctx.app.state === 'playing' || ctx.app.state === 'command' || ctx.app.state === 'spawn';

  // While the pointer is over the feed the entries hold still: new or escalated entries wait (at most HOLD_MAX_MS) and
  // timers stop, so the entry the player is aiming at never slides away under the cursor.
  const HOLD_MAX_MS = 10_000;
  let holdSince = -1;
  const held: Alert[] = [];
  const holding = () => holdSince >= 0 && performance.now() - holdSince < HOLD_MAX_MS;
  function place(a: Alert): void {
    if (!a.el) return;
    if (holding()) {
      if (!held.includes(a)) held.push(a);
      return;
    }
    list.prepend(a.el);
    trimFeed();
  }
  function flushHeld(): void {
    const q = held.splice(0);
    for (const a of q) if (a.el && !a.acknowledged) list.prepend(a.el);
    if (q.length) trimFeed();
  }
  list.addEventListener('pointerenter', () => {
    holdSince = performance.now();
  });
  list.addEventListener('pointerleave', () => {
    holdSince = -1;
    flushHeld();
  });

  function fly(a: Alert): void {
    const i = a.input;
    if (i.lat === undefined || i.lon === undefined) return;
    const alt = i.severity === 'info' ? 3000 : 2200;
    ctx.bus.emit('focusRequest', { lat: i.lat, lon: i.lon, altitudeKm: alt, durationMs: 1200 });
  }

  function activate(a: Alert): void {
    hs.sound('click');
    // v2 (W4): an entry about one of our units selects it too (unitReady «Ver», strike results).
    const uid = a.input.unitId;
    if (uid !== undefined && ctx.sim.view.units.get(uid)?.owner === HUMAN_ID) hs.select({ kind: 'unit', id: uid });
    if (a.input.proposalId && center.onOpenProposal) center.onOpenProposal(a.input.proposalId);
    else fly(a);
    acknowledge(a);
  }

  function acknowledge(a: Alert): void {
    a.acknowledged = true;
    if (a.input.tiles) ctx.globe.setTileMarks?.(`alert:${a.id}`, null);
    if (a.el) {
      const el = a.el;
      a.el = null;
      leave(el, 300);
    }
    if (a.marker) {
      a.marker.remove();
      a.marker = null;
    }
    refreshCount();
  }

  /** Age since the entry last changed: a grouped entry updated in place (an answer to a proposal, a front's new numbers) reads as new. */
  function ageText(a: Alert): string {
    const h = Math.max(0, Math.round((view().tick - a.updatedTick) / 10));
    return h <= 0 ? t('alerts.age.now') : t('alerts.age.hours', { h: formatNumber(h) });
  }

  // ---- front priority (v2 W3) --------------------------------------------------------------------------------
  // The offensive, capital-threat, front-loss and unrest texts tell the player to raise that front's priority: the
  // entry (and the auto-pause banner) does it in one click, with the sim's own rule in the tooltip (§4.4: the home
  // garrison is shared among our fronts by priority weight × length; «alta» doubles the weight; redeployment closes
  // 63 % of the gap in 4.5 h).
  function frontSide(key: number): { f: FrontView; s: 0 | 1 } | null {
    const f = view().frontByKey.get(key);
    if (!f) return null;
    if (f.b === HUMAN_ID) return { f, s: 1 };
    if (f.a === HUMAN_ID) return { f, s: 0 };
    return null;
  }
  /** The front an entry acts on: its own key, else the human's front with `frontEnemy` nearest the entry's place. */
  function alertFront(i: AlertInput): number {
    if (i.frontKey) return i.frontKey;
    if (!i.frontEnemy || i.lat === undefined || i.lon === undefined) return 0;
    const x = ((i.lon + 180) / 360) * MAP_W, y = ((90 - i.lat) / 180) * (MAP_W / 2);
    let best = 0, bd = Infinity;
    for (const f of view().fronts) {
      if (!((f.a === HUMAN_ID && f.b === i.frontEnemy) || (f.b === HUMAN_ID && f.a === i.frontEnemy))) continue;
      const sm = f.samples;
      for (let k = 0; k + 1 < sm.length; k += 2) {
        let dx = Math.abs(sm[k] - x);
        if (dx > MAP_W / 2) dx = MAP_W - dx;
        const d = dx * dx + (sm[k + 1] - y) ** 2;
        if (d < bd) {
          bd = d;
          best = f.key;
        }
      }
    }
    return best;
  }
  function frontPriority(key: number): number {
    const r = frontSide(key);
    if (!r) return -1;
    return r.s ? r.f.priorityB : r.f.priorityA;
  }
  function priorityTip(key: number): TipData {
    const title = t('alerts.priority.title');
    const r = frontSide(key);
    if (!r) return { title, text: t('alerts.priority.gone') };
    const { f, s } = r;
    const prio = s ? f.priorityB : f.priorityA;
    const gar = s ? f.garrisonB : f.garrisonA;
    const share = s ? f.shareB : f.shareA;
    const target = s ? f.targetShareB : f.targetShareA;
    const now: [string, string][] = [[t('alerts.priority.garrison'), formatNumber(Math.round(gar / 1000) * 1000)], [t('alerts.priority.share'), `${formatNumber(Math.round(share * 100))} %`]];
    if (prio >= 2) return { title, text: t('alerts.priority.already'), now, lines: [t('alerts.priority.line')] };
    // The same total weight with this front's weight doubled from its current level: the new target share.
    const k = FRONT_PRIORITY_WEIGHT[2] / (FRONT_PRIORITY_WEIGHT[prio] ?? 1);
    const next = target > 0 ? (target * k) / (1 - target + target * k) : 0;
    const expect = share > 0.001 ? (gar * next) / share : gar;
    return {
      title, text: t('alerts.priority.tip'), now,
      next: [[t('alerts.priority.share'), `${formatNumber(Math.round(next * 100))} %`], [t('alerts.priority.garrison'), `≈ ${formatNumber(Math.round(expect / 1000) * 1000)}`]],
      lines: [t('alerts.priority.line')],
    };
  }
  function paintPriority(btn: HTMLElement, key: number): void {
    const p = frontPriority(key);
    toggleClass(btn, 'fu-hidden', p < 0);
    toggleClass(btn, 'is-on', p >= 2);
    const label = btn.querySelector('span') ?? btn;
    setText(label as HTMLElement, t(p >= 2 ? 'alerts.priority.on' : 'alerts.priority'));
  }
  function raisePriority(key: number, btn: HTMLElement): void {
    const p = frontPriority(key);
    if (p < 0 || p >= 2) {
      hs.sound(p < 0 ? 'error' : 'click');
      return;
    }
    ctx.sim.send({ type: 'setFrontPriority', frontKey: key, priority: 2 });
    hs.sound('confirm');
    setText((btn.querySelector('span') ?? btn) as HTMLElement, t('alerts.priority.on'));
    btn.classList.add('is-on');
  }
  bannerPrio.addEventListener('click', () => {
    const key = pausedBy ? alertFront(pausedBy.alert.input) : 0;
    if (key) raisePriority(key, bannerPrio);
  });
  tip(bannerPrio, () => {
    const key = pausedBy ? alertFront(pausedBy.alert.input) : 0;
    return key ? priorityTip(key) : null;
  });

  function build(a: Alert): HTMLElement {
    const i = a.input;
    const close = h('button', { class: 'fu-alert-x', 'aria-label': 'close' }, icon('close'));
    tip(close, () => ({ title: t('alerts.dismiss'), text: t(i.severity === 'critical' ? 'alerts.dismiss.critical' : 'alerts.dismiss.tip') }));
    // «Prioridad alta» for the front the entry is about (kept on the entry; refreshEntry repaints it).
    const prio = h('button', { class: 'fu-alert-prio', type: 'button' }, icon('shield'), h('span', null, ''));
    if (i.frontKey || i.frontEnemy) {
      paintPriority(prio, alertFront(i));
      tip(prio, () => {
        const key = alertFront(a.input);
        return key ? priorityTip(key) : null;
      });
      prio.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = alertFront(a.input);
        if (key) raisePriority(key, prio);
      });
    } else prio.classList.add('fu-hidden');
    const flags = h('div', { class: 'fu-alert-flags' });
    for (const id of (i.actors ?? []).slice(0, 2)) {
      const p = view().players[id];
      if (p && id !== HUMAN_ID) flags.append(flag(p.color, id));
    }
    const el = h('div', { class: `fu-alert fu-glass is-${i.severity} fu-interactive`, 'data-kind': i.kind },
      h('div', { class: 'fu-alert-ico' }, icon(i.icon ?? SEV_ICON[i.severity])),
      h('div', { class: 'fu-alert-main' },
        h('div', { class: 'fu-alert-title' }, h('span', { class: 'fu-alert-t' }, i.title), flags),
        i.body ? h('div', { class: 'fu-alert-body' }, i.body) : null,
        h('div', { class: 'fu-alert-meta fu-mono' }, h('span', { class: 'fu-alert-age' }, ageText(a)), h('span', { class: 'fu-alert-count' }),
          i.lat !== undefined ? h('span', { class: 'fu-alert-go' }, icon('eye'), t(i.proposalId ? 'alerts.open' : 'alerts.fly')) : i.proposalId ? h('span', { class: 'fu-alert-go' }, icon('inbox'), t('alerts.open')) : null,
          prio),
      ),
      close,
      h('i', { class: 'fu-alert-timer' }),
    );
    tip(el, () => ({ title: i.title, text: i.proposalId ? t('alerts.click.inbox') : i.lat !== undefined ? t('alerts.click.fly') : t('alerts.click.none') }));
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.fu-alert-x, .fu-alert-prio')) return;
      activate(a);
    });
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      hs.sound('close');
      acknowledge(a);
    });
    return el;
  }

  function refreshEntry(a: Alert): void {
    if (!a.el) return;
    const i = a.input;
    a.el.className = `fu-alert fu-glass is-${i.severity} fu-interactive is-bump`;
    setText(a.el.querySelector('.fu-alert-t') as HTMLElement, i.title);
    const body = a.el.querySelector('.fu-alert-body') as HTMLElement | null;
    if (body) setText(body, i.body ?? '');
    else if (i.body) a.el.querySelector('.fu-alert-main')!.insertBefore(h('div', { class: 'fu-alert-body' }, i.body), a.el.querySelector('.fu-alert-meta'));
    setText(a.el.querySelector('.fu-alert-count') as HTMLElement, a.count > 1 ? `×${a.count}` : '');
    setText(a.el.querySelector('.fu-alert-age') as HTMLElement, ageText(a));
    const prio = a.el.querySelector('.fu-alert-prio') as HTMLElement | null;
    if (prio && (i.frontKey || i.frontEnemy)) paintPriority(prio, alertFront(i));
  }

  function raise(input: AlertInput): Alert {
    const tick = view().tick;
    const sticky = input.sticky || input.severity === 'critical';
    const ttl = sticky ? Infinity : (input.ttlSec ?? DEFAULT_TTL_MS / 1000) * 1000;
    let a = input.groupKey ? byGroup.get(input.groupKey) : undefined;
    let fresh = false;
    if (a && !a.acknowledged && a.el) {
      // One entry per group: update its numbers, keep its place, restart its timer.
      const escalated = SEV_ORDER[input.severity] > SEV_ORDER[a.input.severity];
      const sameKind = a.input.kind === input.kind;
      if (a.input.tiles && !input.tiles) ctx.globe.setTileMarks?.(`alert:${a.id}`, null);
      a.input = { ...input, severity: sameKind && !escalated ? a.input.severity : input.severity };
      a.updatedTick = tick;
      if (sameKind) a.count++;
      a.leftMs = ttl;
      refreshEntry(a);
      if (escalated) place(a);
    } else {
      fresh = true;
      a = { id: nextId++, input, createdTick: tick, updatedTick: tick, leftMs: ttl, acknowledged: false, count: 1, el: null, marker: null };
      all.push(a);
      if (all.length > LOG_MAX) {
        const old = all.shift()!;
        if (old.el) old.el.remove();
        if (old.marker) old.marker.remove();
      }
      if (input.groupKey) byGroup.set(input.groupKey, a);
      if (inGame()) {
        a.el = build(a);
        place(a);
      }
    }
    if (input.tiles && input.tiles.length) ctx.globe.setTileMarks?.(`alert:${a.id}`, input.tiles, input.severity === 'info' ? 0x3fd0ff : input.severity === 'warning' ? 0xffb53d : 0xff4a4a, true);
    if (fresh || SEV_ORDER[input.severity] >= 2) {
      if (input.lat !== undefined && input.lon !== undefined && inGame()) {
        pings++;
        center.onPing?.(input.lat, input.lon, input.severity);
      }
    }
    if (fresh && input.ticker) center.onTicker?.(input.title + (input.body ? ` · ${input.body}` : ''), input.severity === 'critical' || input.severity === 'danger' ? 'critical' : input.severity === 'warning' ? 'warning' : 'info', input.lat, input.lon);
    // The globe marker (or its edge arrow) appears in the same frame as the entry, not at the next 10 Hz projection.
    if (fresh && input.lat !== undefined && inGame()) projectMarkers();
    if (fresh && input.autoPause) maybeAutoPause(a, input.autoPause);
    ctx.bus.emit('uiSound', { kind: input.severity === 'info' ? 'notify' : 'alert' });
    refreshCount();
    return a;
  }

  function trimFeed(): void {
    // At most 5 visible: drop the oldest non-critical first.
    const els = [...list.children] as HTMLElement[];
    if (els.length <= FEED_MAX) return;
    const live = all.filter((x) => x.el);
    live.sort((x, y) => SEV_ORDER[x.input.severity] - SEV_ORDER[y.input.severity] || x.updatedTick - y.updatedTick);
    let n = els.length - FEED_MAX;
    for (const x of live) {
      if (n <= 0) break;
      if (x.input.severity === 'critical') continue;
      x.el!.remove();
      x.el = null;
      if (x.marker) {
        x.marker.remove();
        x.marker = null;
      }
      n--;
    }
  }

  function resolve(groupKey: string): void {
    const a = byGroup.get(groupKey);
    if (!a) return;
    byGroup.delete(groupKey);
    if (a.el && !a.acknowledged) {
      a.leftMs = Math.min(a.leftMs, 4000);
      if (a.input.severity === 'critical') acknowledge(a);
    }
  }

  function maybeAutoPause(a: Alert, kind: AutoPauseKind): void {
    const s = ctx.settings.get();
    if (!s.autoPause?.[kind]) return;
    if (ctx.app.state !== 'playing') return;
    const sp = view().speed;
    if (sp === 0 && !pausedBy) return;
    const resume = pausedBy ? pausedBy.resume : sp;
    pausedBy = { alert: a, resume };
    if (sp !== 0) ctx.app.setSpeed(0);
    setText(bannerText, `${a.input.title}${a.input.body ? ` · ${a.input.body}` : ''}`);
    toggleClass(bannerView, 'fu-hidden', a.input.lat === undefined && !a.input.proposalId);
    paintPriority(bannerPrio, alertFront(a.input));
    bannerEl.classList.remove('fu-hidden');
    bannerEl.dataset.kind = kind;
    ctx.bus.emit('autoPaused', { kind, text: a.input.title });
  }
  bannerView.addEventListener('click', () => {
    if (pausedBy) {
      hs.sound('click');
      if (pausedBy.alert.input.proposalId && center.onOpenProposal) center.onOpenProposal(pausedBy.alert.input.proposalId);
      else fly(pausedBy.alert);
    }
  });
  bannerResume.addEventListener('click', () => {
    hs.sound('click');
    const r = pausedBy?.resume ?? 1;
    hideBanner();
    ctx.app.setSpeed(r || 1);
  });
  function hideBanner(): void {
    pausedBy = null;
    bannerEl.classList.add('fu-hidden');
  }
  ctx.bus.on('speedChanged', (e) => {
    if (e.speed !== 0 && pausedBy) hideBanner();
  });

  const nEl = logBtn.querySelector('.fu-alerts-n') as HTMLElement;
  function refreshCount(): void {
    const n = all.length;
    setText(nEl, n > 0 ? String(n) : '');
    toggleClass(logBtn, 'fu-hidden', n === 0);
  }

  // ---- feed height ----------------------------------------------------------------------------------
  // The feed grows down from the top-left corner; it must never cover the advisor or the minimap below it (nor push
  // the Registro button under them): the list is capped to the room left and fades out at the bottom when clipped.
  function fitFeed(): void {
    const top = list.getBoundingClientRect().top;
    if (!top && !list.childElementCount) return;
    let limit = window.innerHeight;
    for (const e of document.querySelectorAll('.fu-hud-left > *, .fu-hud-bl')) {
      const r = e.getBoundingClientRect();
      if (r.height > 0 && r.top > top) limit = Math.min(limit, r.top);
    }
    const room = Math.max(90, Math.floor(limit - top - logBtn.offsetHeight - 18));
    list.style.maxHeight = `${room}px`;
    toggleClass(list, 'is-clipped', list.scrollHeight > room + 2);
  }

  // ---- globe markers ------------------------------------------------------------------------------
  const v = new THREE.Vector3();
  const vc = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let acc = 0;
  let lastMs = performance.now();

  function projectMarkers(): void {
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    camPos.copy(cam.position);
    const W = window.innerWidth, H = window.innerHeight;
    const strategic = ctx.app.state === 'playing' || ctx.app.state === 'spawn';
    for (const a of all) {
      const i = a.input;
      const want = strategic && !!a.el && !a.acknowledged && i.lat !== undefined && i.lon !== undefined && SEV_ORDER[i.severity] >= 1;
      if (!want) {
        if (a.marker) {
          a.marker.remove();
          a.marker = null;
        }
        continue;
      }
      if (!a.marker) {
        const m = h('div', { class: `fu-marker is-${i.severity} fu-interactive` }, h('div', { class: 'fu-marker-ring' }), h('div', { class: 'fu-marker-ico' }, icon(i.icon ?? SEV_ICON[i.severity])), h('div', { class: 'fu-marker-arrow' }, icon('chevronUp')));
        m.addEventListener('click', () => activate(a));
        tip(m, () => ({ title: a.input.title, text: a.input.body ?? '' }));
        a.marker = m;
        markersEl.append(m);
      }
      a.marker.className = `fu-marker is-${i.severity} fu-interactive`;
      latLonToVec3(i.lat!, i.lon!, 1.002, v);
      const facing = vc.copy(camPos).sub(v).dot(v) > 0;
      vc.copy(v).project(cam);
      const onScreen = facing && vc.z < 1 && Math.abs(vc.x) <= 0.96 && Math.abs(vc.y) <= 0.94;
      if (onScreen) {
        a.marker.classList.remove('is-edge');
        a.marker.style.transform = `translate(${((vc.x + 1) / 2) * W}px, ${((1 - vc.y) / 2) * H}px)`;
        continue;
      }
      if (SEV_ORDER[i.severity] < 2) {
        a.marker.style.transform = 'translate(-999px,-999px)';
        continue;
      }
      // Off-screen or behind the planet: an arrow on the screen edge, pointing the way the camera must turn.
      vc.copy(v).applyMatrix4(cam.matrixWorldInverse);
      let dx = vc.x, dy = -vc.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len;
      dy /= len;
      const mx = W / 2 - 34, my = H / 2 - 34;
      const k = Math.min(mx / Math.max(1e-6, Math.abs(dx)), my / Math.max(1e-6, Math.abs(dy)));
      a.marker.classList.add('is-edge');
      a.marker.style.transform = `translate(${W / 2 + dx * k}px, ${H / 2 + dy * k}px)`;
      (a.marker.querySelector('.fu-marker-arrow') as HTMLElement).style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI + 90}deg)`;
    }
  }

  function update(dt: number): void {
    const now = performance.now();
    const dMs = Math.min(1000, now - lastMs);
    lastMs = now;
    const paused = (view().speed === 0 && ctx.app.state === 'playing') || holding();
    if (held.length && !holding()) flushHeld();
    for (const a of all) {
      if (!a.el || a.acknowledged) continue;
      if (!paused && Number.isFinite(a.leftMs)) {
        a.leftMs -= dMs;
        if (a.leftMs <= 0) {
          const el = a.el;
          a.el = null;
          leave(el, 300);
          if (a.input.tiles) ctx.globe.setTileMarks?.(`alert:${a.id}`, null);
          continue;
        }
        const bar = a.el.querySelector('.fu-alert-timer') as HTMLElement;
        const ttl = (a.input.ttlSec ?? DEFAULT_TTL_MS / 1000) * 1000;
        bar.style.transform = `scaleX(${Math.max(0, Math.min(1, a.leftMs / ttl)).toFixed(3)})`;
      }
    }
    acc += dt;
    if (acc >= 0.1) {
      acc = 0;
      fitFeed();
      projectMarkers();
      for (const a of all) if (a.el) setText(a.el.querySelector('.fu-alert-age') as HTMLElement, ageText(a));
      // A front that appears after its entry (a declaration's fronts), or a priority set elsewhere: repaint at 1 Hz.
      if (now - prioPaintMs > 1000) {
        prioPaintMs = now;
        for (const a of all) {
          if (!a.el || !(a.input.frontKey || a.input.frontEnemy)) continue;
          const b = a.el.querySelector('.fu-alert-prio') as HTMLElement | null;
          if (b) paintPriority(b, alertFront(a.input));
        }
        if (pausedBy && !bannerEl.classList.contains('fu-hidden')) paintPriority(bannerPrio, alertFront(pausedBy.alert.input));
      }
    }
  }
  let prioPaintMs = 0;

  // ---- Registro --------------------------------------------------------------------------------
  let logModal: ModalHandle | null = null;
  function openLog(): void {
    if (logModal) {
      logModal.close();
      return;
    }
    hs.sound('open');
    let filter: 'all' | 'danger' | 'warning' | 'info' = 'all';
    const rows = h('div', { class: 'fu-log-rows' });
    const seg = h('div', { class: 'fu-seg fu-log-filter' });
    const paint = () => {
      rows.replaceChildren();
      const items = all.filter((a) => filter === 'all' || (filter === 'danger' ? SEV_ORDER[a.input.severity] >= 2 : a.input.severity === filter)).slice().reverse().sort((x, y) => y.updatedTick - x.updatedTick);
      if (!items.length) rows.append(tx('alerts.log.empty', undefined, 'p'));
      for (const a of items) {
        const r = h('div', { class: `fu-log-row is-${a.input.severity}` },
          h('span', { class: 'fu-log-ico' }, icon(a.input.icon ?? SEV_ICON[a.input.severity])),
          h('div', { class: 'fu-log-main' }, h('b', null, a.input.title), a.input.body ? h('span', null, a.input.body) : null),
          h('span', { class: 'fu-log-age fu-mono' }, t('alerts.log.day', { day: Math.floor(a.updatedTick / 240) + 1, hour: Math.floor((a.updatedTick % 240) / 10) })),
        );
        if (a.input.lat !== undefined || a.input.proposalId) {
          r.classList.add('is-go');
          r.addEventListener('click', () => {
            logModal?.close();
            activate(a);
          });
        }
        rows.append(r);
      }
    };
    for (const f of ['all', 'danger', 'warning', 'info'] as const) {
      const b = h('button', { type: 'button', class: f === filter ? 'is-on' : '' }, tx(`alerts.filter.${f}`));
      b.addEventListener('click', () => {
        filter = f;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('is-on', x === b));
        hs.sound('click');
        paint();
      });
      seg.append(b);
    }
    paint();
    logModal = openModal({
      titleKey: 'alerts.log.title', kickerKey: 'alerts.log.kicker', className: 'fu-log', body: h('div', null, seg, rows),
      onClose: () => (logModal = null),
    });
    ctx.bus.emit('panelToggled', { panel: 'log', open: true });
  }
  logBtn.addEventListener('click', () => openLog());

  function clear(): void {
    for (const a of all) {
      if (a.el) a.el.remove();
      if (a.marker) a.marker.remove();
      if (a.input.tiles) ctx.globe.setTileMarks?.(`alert:${a.id}`, null);
    }
    all.length = 0;
    byGroup.clear();
    held.length = 0;
    holdSince = -1;
    list.replaceChildren();
    markersEl.replaceChildren();
    hideBanner();
    refreshCount();
  }

  ctx.bus.on('alert', (e) => raise(e.input));
  refreshCount();

  (window as unknown as { __fuAlerts?: unknown }).__fuAlerts = {
    list: () => all.map((a) => ({ id: a.id, kind: a.input.kind, severity: a.input.severity, title: a.input.title, body: a.input.body ?? '', groupKey: a.input.groupKey ?? '', lat: a.input.lat, lon: a.input.lon, count: a.count, inFeed: !!a.el, marker: !!a.marker, edge: !!a.marker?.classList.contains('is-edge'), tick: a.createdTick, updatedTick: a.updatedTick, age: ageText(a) })),
    feed: () => [...list.querySelectorAll('.fu-alert')].map((e) => (e as HTMLElement).innerText),
    pings: () => pings,
    banner: () => (bannerEl.classList.contains('fu-hidden') ? '' : bannerEl.innerText),
    click: (id: number) => {
      const a = all.find((x) => x.id === id);
      if (a) activate(a);
    },
    /** The place name the alerts use for a tile (verification: «does the airRaid alert name the base?»). */
    place: (tile: number) => {
      const p = describeTile(view(), tile);
      return p.named ? p.name : p.text;
    },
    /** The full place description of a tile as seen from a given capital tile (w3-verify V5d). */
    placeFrom: (tile: number, capitalTile: number) => {
      const ll = tileToLatLon(tile);
      return describePlace(view(), ll.lat, ll.lon, HUMAN_ID, capitalTile);
    },
  };
  return center;
}
