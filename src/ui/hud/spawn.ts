// FRONT ULTRA — spawn phase overlay (owner: ui): "found your capital" briefing with a countdown ring, the
// number of nations already deployed, and confirmation once the capital is placed (it can still be moved).

import { h, setStyle, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { HUMAN_ID } from '../../shared/constants';
import { countryName, t } from '../../shared/i18n';

export interface SpawnOverlay {
  el: HTMLElement;
  refresh(): void;
  invalidate(): void;
}

export function createSpawnOverlay(hs: HudShared): SpawnOverlay {
  const ctx = hs.ctx;
  const secs = h('div', { class: 'fu-sp-secs fu-mono' }, '--');
  const ring = h('div', { class: 'fu-sp-ring' }, secs, h('small', null, tx('spawn.seconds')));
  const title = h('h2', { class: 'fu-sp-title' });
  const text = h('p', { class: 'fu-sp-text' });
  const nations = h('span', { class: 'fu-mono' }, '0');
  const status = h('div', { class: 'fu-sp-status' }, h('i'), h('span', null, nations, ' ', tx('spawn.deployed')));
  const el = h('div', { class: 'fu-spawn fu-glass fu-brackets' },
    ring,
    h('div', { class: 'fu-sp-body' }, tx('spawn.kicker', undefined, 'div'), title, text, status),
  );
  el.querySelector('.fu-sp-body > div')!.classList.add('fu-sp-kicker');
  const hint = h('div', { class: 'fu-sp-hint' }, icon('mouse'), tx('spawn.clickHint'));
  const wrap = h('div', { class: 'fu-spawn-wrap' }, el, hint);

  let placed = -2;
  return {
    el: wrap,
    invalidate() {
      placed = -2;
    },
    refresh() {
      const view = ctx.sim.view;
      const me = view.human;
      const spawned = !!me?.spawned;
      const cap = me?.capitalTile ?? -1;
      if ((spawned ? cap : -1) !== placed) {
        placed = spawned ? cap : -1;
        toggleClass(el, 'is-placed', spawned);
        toggleClass(hint, 'fu-hidden', spawned);
        if (spawned && view.world) {
          const c = countryName(view.world.countries[view.world.country[cap]]);
          setText(title, t('spawn.placedTitle'));
          setText(text, t('spawn.placedText', { place: c || t('hud.neutralLand') }));
        } else {
          setText(title, t('spawn.title'));
          setText(text, t('spawn.hint'));
        }
      }
      let n = 0;
      for (const p of view.playerList) if (p.spawned && p.id !== HUMAN_ID && p.kind === 'nation') n++;
      setText(nations, String(n));
      const left = view.spawnDeadlineTick > 0 ? Math.max(0, (view.spawnDeadlineTick - view.tick) / 10) : -1;
      const total = (view.config?.spawnTimeoutTicks ?? 900) / 10;
      if (left >= 0 && left < 1e6) {
        setText(secs, String(Math.ceil(left)));
        setStyle(ring, '--p', `${Math.max(0, Math.min(1, left / total)) * 360}deg`);
        toggleClass(ring, 'is-low', left < 10);
      } else {
        setText(secs, '∞');
        setStyle(ring, '--p', '360deg');
      }
    },
  };
}
