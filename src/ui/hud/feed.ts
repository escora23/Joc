// FRONT ULTRA — breaking-news ticker, toasts (incl. alliance requests with accept/decline) and the nuclear
// alarm banner (owner: ui).

import { h, leave, setStyle, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon, UNIT_ICON } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import type { NewsSeverity } from '../../shared/events';
import { tileToLatLon } from '../../shared/geo';
import { t } from '../../shared/i18n';
import type { NukeWeapon } from '../../shared/protocol';
import { UNIT_DEFS } from '../../shared/constants';

// =================================================================================================
// Ticker
// =================================================================================================
interface NewsItem {
  text: string;
  severity: NewsSeverity;
  lat?: number;
  lon?: number;
}

export interface Ticker {
  el: HTMLElement;
  push(item: NewsItem): void;
  update(dt: number): void;
  clear(): void;
}

export function createTicker(hs: HudShared): Ticker {
  const label = h('div', { class: 'fu-tk-label' }, h('i'), tx('news.breaking'));
  const text = h('div', { class: 'fu-tk-text' });
  const time = h('div', { class: 'fu-tk-time fu-mono' });
  const el = h('div', { class: 'fu-ticker fu-interactive is-idle' }, label, h('div', { class: 'fu-tk-viewport' }, text), time);
  const queue: NewsItem[] = [];
  let current: NewsItem | null = null;
  let left = 0;

  el.addEventListener('click', () => {
    if (current && current.lat !== undefined && current.lon !== undefined) {
      hs.sound('click');
      hs.ctx.bus.emit('focusRequest', { lat: current.lat, lon: current.lon, altitudeKm: 3500, durationMs: 1300 });
    }
  });

  function show(item: NewsItem): void {
    current = item;
    left = item.severity === 'critical' ? 9 : 7;
    el.classList.remove('is-idle', 'sev-info', 'sev-warning', 'sev-critical');
    el.classList.add(`sev-${item.severity}`);
    toggleClass(el, 'has-focus', item.lat !== undefined);
    text.classList.remove('is-in');
    void text.offsetWidth;
    text.textContent = item.text;
    text.classList.add('is-in');
    setText(time, formatClock(hs.ctx.sim.view.simTime));
    if (item.severity === 'critical') hs.sound('alert');
    else hs.sound('typewriter');
  }

  return {
    el,
    push(item) {
      if (item.severity === 'critical') {
        queue.unshift(item);
        if (current && current.severity !== 'critical') left = Math.min(left, 0.3);
      } else {
        queue.push(item);
        if (queue.length > 6) queue.splice(0, queue.length - 6);
      }
      if (!current) show(queue.shift()!);
    },
    update(dt) {
      if (!current) return;
      // Breaking news holds while the game is paused.
      if (hs.ctx.sim.view.speed === 0 && hs.ctx.app.state === 'playing') return;
      left -= dt;
      if (left > 0) return;
      const next = queue.shift();
      if (next) show(next);
      else {
        current = null;
        el.classList.add('is-idle');
      }
    },
    clear() {
      queue.length = 0;
      current = null;
      el.classList.add('is-idle');
    },
  };
}

function formatClock(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// =================================================================================================
// Toasts
// =================================================================================================
export type ToastKind = 'info' | 'success' | 'warning' | 'danger' | 'alliance';

export interface Toasts {
  el: HTMLElement;
  push(text: string, kind: ToastKind, durationMs?: number, iconName?: string): HTMLElement;
  allianceRequest(from: number, expiresInSec: number): void;
  update(): void;
  clear(): void;
}

export function createToasts(hs: HudShared): Toasts {
  const ctx = hs.ctx;
  const el = h('div', { class: 'fu-toasts' });
  const timed: { el: HTMLElement; until: number; bar?: HTMLElement; total: number; from?: number; seen?: boolean }[] = [];
  let lastUpdate = 0;
  const KIND_ICON: Record<ToastKind, string> = { info: 'info', success: 'check', warning: 'warning', danger: 'warning', alliance: 'alliance' };

  function push(text: string, kind: ToastKind, durationMs = 4200, iconName?: string): HTMLElement {
    // Collapse exact duplicates that arrive in bursts.
    for (const x of timed) {
      if (x.el.dataset.text === text && !x.from) {
        x.until = performance.now() + durationMs;
        const c = x.el.querySelector('.fu-toast-count') as HTMLElement;
        const n = Number(c.dataset.n || '1') + 1;
        c.dataset.n = String(n);
        c.textContent = `×${n}`;
        return x.el;
      }
    }
    const bar = h('i', { class: 'fu-toast-timer' });
    const tEl = h('div', { class: `fu-toast fu-glass is-${kind} fu-interactive`, 'data-text': text },
      h('div', { class: 'fu-toast-ico' }, icon(iconName ?? KIND_ICON[kind])),
      h('div', { class: 'fu-toast-body' }, h('div', { class: 'fu-toast-text' }, text)),
      h('span', { class: 'fu-toast-count fu-mono' }),
      bar,
    );
    tEl.addEventListener('click', () => dismiss(tEl));
    el.prepend(tEl);
    timed.push({ el: tEl, until: performance.now() + durationMs, bar, total: durationMs });
    while (el.children.length > 6) {
      const last = el.lastElementChild as HTMLElement;
      const i = timed.findIndex((x) => x.el === last);
      if (i >= 0) timed.splice(i, 1);
      last.remove();
    }
    return tEl;
  }

  function dismiss(tEl: HTMLElement): void {
    const i = timed.findIndex((x) => x.el === tEl);
    if (i >= 0) timed.splice(i, 1);
    leave(tEl, 300);
  }

  function allianceRequest(from: number, expiresInSec: number): void {
    const p = ctx.sim.view.players[from];
    if (!p) return;
    const total = Math.max(3, expiresInSec) * 1000;
    const bar = h('i', { class: 'fu-toast-timer' });
    const accept = h('button', { class: 'fu-btn fu-btn--sm fu-btn--success' }, icon('check'), tx('toast.accept'));
    const decline = h('button', { class: 'fu-btn fu-btn--sm fu-btn--danger' }, icon('close'), tx('toast.decline'));
    const tEl = h('div', { class: 'fu-toast fu-glass is-alliance fu-interactive' },
      h('div', { class: 'fu-toast-flag' }, flag(p.color, from)),
      h('div', { class: 'fu-toast-body' },
        h('div', { class: 'fu-toast-kicker' }, icon('alliance'), tx('toast.allianceKicker')),
        h('div', { class: 'fu-toast-text' }, t('toast.allianceText', { name: hs.name(from) })),
        h('div', { class: 'fu-toast-actions' }, accept, decline),
      ),
      bar,
    );
    const reply = (ok: boolean) => {
      ctx.sim.send({ type: 'allianceReply', from, accept: ok });
      hs.sound(ok ? 'confirm' : 'cancel');
      dismiss(tEl);
    };
    accept.addEventListener('click', () => reply(true));
    decline.addEventListener('click', () => reply(false));
    el.prepend(tEl);
    timed.push({ el: tEl, until: performance.now() + total, bar, total, from });
    hs.sound('notify');
  }

  return {
    el,
    push,
    allianceRequest,
    update() {
      const now = performance.now();
      // Toasts (and pending alliance offers) hold while the game is paused.
      const frozen = hs.ctx.sim.view.speed === 0 && hs.ctx.app.state === 'playing';
      const dtMs = lastUpdate > 0 ? now - lastUpdate : 0;
      lastUpdate = now;
      if (frozen) for (const x of timed) x.until += dtMs;
      for (let i = timed.length - 1; i >= 0; i--) {
        const x = timed[i];
        const left = x.until - now;
        if (x.bar) setStyle(x.bar, 'transform', `scaleX(${Math.max(0, left / x.total).toFixed(3)})`);
        if (x.from) {
          // Alliance request answered elsewhere (or expired in the sim): drop the toast.
          const view = hs.ctx.sim.view;
          const req = view.allianceRequests.find((r) => r.from === x.from && r.to === 1);
          const stillPending = !!req;
          if (req) {
            // Follow the sim's own expiry (game time → wall time at the current speed).
            x.seen = true;
            if (!frozen) x.until = now + (Math.max(0, req.expiresTick - view.tick) / 10 / Math.max(1, view.speed)) * 1000;
          }
          else if (x.seen) {
            timed.splice(i, 1);
            leave(x.el, 300);
            continue;
          }
        }
        if (left <= 0) {
          timed.splice(i, 1);
          leave(x.el, 300);
        }
      }
    },
    clear() {
      timed.length = 0;
      el.replaceChildren();
    },
  };
}

// =================================================================================================
// Nuclear alarm
// =================================================================================================
interface Alarm {
  unitId: number;
  targetTile: number;
  etaTick: number;
  weapon: NukeWeapon;
}

export interface NukeAlarm {
  el: HTMLElement;
  edge: HTMLElement;
  add(unitId: number, targetTile: number, etaSec: number, weapon: NukeWeapon): void;
  update(): void;
  clear(): void;
}

export function createNukeAlarm(hs: HudShared): NukeAlarm {
  const ctx = hs.ctx;
  const weaponEl = h('span', { class: 'fu-alarm-weapon' });
  const countEl = h('span', { class: 'fu-alarm-count fu-mono' });
  const moreEl = h('span', { class: 'fu-alarm-more fu-mono' });
  const icoBox = h('div', { class: 'fu-alarm-ico' }, icon('radiation'));
  const el = h('div', { class: 'fu-alarm fu-interactive fu-hidden' },
    h('div', { class: 'fu-alarm-stripes' }),
    icoBox,
    h('div', { class: 'fu-alarm-body' }, h('div', { class: 'fu-alarm-title' }, tx('alarm.title')), h('div', { class: 'fu-alarm-sub' }, weaponEl, h('span', null, ' · '), tx('alarm.target'), moreEl)),
    h('div', { class: 'fu-alarm-eta' }, tx('alarm.impact', undefined, 'small'), countEl),
  );
  const edge = h('div', { class: 'fu-alarm-edge fu-hidden' });
  const alarms: Alarm[] = [];
  let shownWeapon = -1;

  el.addEventListener('click', () => {
    const a = alarms[0];
    if (!a) return;
    const ll = tileToLatLon(a.targetTile);
    hs.sound('click');
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 2500, durationMs: 1000 });
  });

  return {
    el,
    edge,
    add(unitId, targetTile, etaSec, weapon) {
      if (alarms.some((a) => a.unitId === unitId)) return;
      alarms.push({ unitId, targetTile, etaTick: ctx.sim.view.tick + etaSec * 10, weapon });
    },
    update() {
      const view = ctx.sim.view;
      for (let i = alarms.length - 1; i >= 0; i--) {
        const a = alarms[i];
        if (!view.units.has(a.unitId) || view.tick > a.etaTick + 30) alarms.splice(i, 1);
      }
      const on = alarms.length > 0;
      toggleClass(el, 'fu-hidden', !on);
      toggleClass(edge, 'fu-hidden', !on);
      if (!on) return;
      alarms.sort((a, b) => a.etaTick - b.etaTick);
      const a = alarms[0];
      if (a.weapon !== shownWeapon) {
        shownWeapon = a.weapon;
        setText(weaponEl, t(`unit.${UNIT_DEFS[a.weapon].id}`).toUpperCase());
        icoBox.replaceChildren(icon(UNIT_ICON[a.weapon] ?? 'radiation'));
      }
      const secs = Math.max(0, (a.etaTick - view.tick) / 10);
      setText(countEl, `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(Math.floor(secs % 60)).padStart(2, '0')}.${Math.floor((secs * 10) % 10)}`);
      setText(moreEl, alarms.length > 1 ? `  +${alarms.length - 1}` : '');
    },
    clear() {
      alarms.length = 0;
      el.classList.add('fu-hidden');
      edge.classList.add('fu-hidden');
    },
  };
}
