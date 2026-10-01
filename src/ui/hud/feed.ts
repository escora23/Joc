// FRONT ULTRA — breaking-news ticker (owner: ui).

import { h, setText, toggleClass } from '../dom';
import { tx } from '../tx';
import type { HudShared } from './shared';
import type { NewsSeverity } from '../../shared/events';

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
  // An opaque bar: labels, badges and the battle's banners keep out from under it (occlusion rects).
  const el = h('div', { class: 'fu-ticker fu-interactive is-idle', 'data-occludes': '' }, label, h('div', { class: 'fu-tk-viewport' }, text), time);
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
        // Breaking news pre-empts a routine item at once, even while paused (an auto-pause follows most of them):
        // the routine item goes back to the front of the queue.
        if (current && current.severity !== 'critical') {
          queue.unshift(current);
          show(item);
          return;
        }
        let at = 0;
        while (at < queue.length && queue[at]!.severity === 'critical') at++;
        queue.splice(at, 0, item);
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
