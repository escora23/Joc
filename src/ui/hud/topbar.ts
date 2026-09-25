// FRONT ULTRA — HUD top bar (owner: ui): nation badge, troops/max with growth, gold with income, territory %,
// population; and the top-right time controls (clock, pause/1x/2x/4x, pause menu, settings, help).

import { h, setStyle, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import type { GameSpeed } from '../../shared/types';
import { formatCompact, formatDuration, formatNumber, t } from '../../shared/i18n';

export interface TopBar {
  el: HTMLElement;
  time: HTMLElement;
  refresh(): void;
  rebuildFlag(): void;
}

export function createTopBar(hs: HudShared, actions: { pause(): void; settings(): void; help(): void }): TopBar {
  const ctx = hs.ctx;
  const flagBox = h('div', { class: 'fu-tb-flag' });
  const nameEl = h('div', { class: 'fu-tb-name' });
  const rankEl = h('div', { class: 'fu-tb-rank fu-mono' });

  const stat = (ico: string, key: string, cls: string) => {
    const v = h('span', { class: 'fu-tb-v fu-mono' }, '0');
    const sub = h('span', { class: 'fu-tb-sub fu-mono' }, '');
    const el = h('div', { class: `fu-tb-stat ${cls}` },
      h('div', { class: 'fu-tb-ico' }, icon(ico)),
      h('div', { class: 'fu-tb-body' }, h('div', { class: 'fu-tb-k' }, tx(key)), h('div', { class: 'fu-tb-line' }, v, sub)),
    );
    return { el, v, sub };
  };
  const troops = stat('troops', 'hud.troops', 'is-troops');
  const troopBar = h('i');
  const troopBarWrap = h('div', { class: 'fu-tb-meter' }, troopBar);
  troops.el.querySelector('.fu-tb-body')!.append(troopBarWrap);
  const gold = stat('gold', 'hud.gold', 'is-gold');
  const terr = stat('territory', 'hud.territory', 'is-terr');
  const pop = stat('population', 'hud.population', 'is-pop');

  const bar = h('div', { class: 'fu-topbar fu-glass fu-brackets' },
    h('div', { class: 'fu-tb-nation' }, flagBox, h('div', { class: 'fu-tb-nation-text' }, nameEl, rankEl)),
    h('div', { class: 'fu-tb-sep' }),
    troops.el, gold.el, terr.el, pop.el,
  );

  // ---- time controls ------------------------------------------------------------------------------
  const clock = h('span', { class: 'fu-mono fu-time-clock' }, '0:00');
  const speedBtns = new Map<GameSpeed, HTMLButtonElement>();
  const speeds = h('div', { class: 'fu-seg fu-time-seg' });
  for (const sp of [0, 1, 2, 4] as GameSpeed[]) {
    const b = h('button', { type: 'button', title: sp === 0 ? `${t('hud.pause')} (Space)` : `${sp}×` }, sp === 0 ? icon('pause') : `${sp}×`) as HTMLButtonElement;
    b.addEventListener('click', () => {
      hs.sound('click');
      if (sp === 0) ctx.app.togglePause();
      else ctx.app.setSpeed(sp);
    });
    speedBtns.set(sp, b);
    speeds.append(b);
  }
  const iconBtn = (ico: string, titleKey: string, fn: () => void) => {
    const b = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--icon fu-time-btn', 'data-i18n-title': titleKey, title: t(titleKey) }, icon(ico));
    b.addEventListener('click', () => {
      hs.sound('click');
      fn();
    });
    return b;
  };
  const doomClock = h('b', { class: 'fu-mono' }, '23:45');
  const doom = h('div', { class: 'fu-doom fu-hidden' }, icon('radiation'), h('span', { class: 'fu-caps' }, tx('hud.doomsday')), doomClock);
  let doomMinutes = -1;
  ctx.bus.on('doomsday', (e) => (doomMinutes = Math.max(0, Math.round(e.minutesToMidnight))));
  ctx.bus.on('gameTornDown', () => (doomMinutes = -1));
  const time = h('div', { class: 'fu-time fu-glass fu-interactive' },
    h('div', { class: 'fu-time-main' }, icon('clock'), clock, speeds, iconBtn('help', 'hud.help', actions.help), iconBtn('settings', 'menu.settings', actions.settings), iconBtn('menu', 'hud.menu', actions.pause)),
    doom,
  );

  let lastFlagColor = -1;
  function rebuildFlag(): void {
    const p = hs.human;
    if (!p) return;
    if (p.color === lastFlagColor) return;
    lastFlagColor = p.color;
    flagBox.replaceChildren(flag(p.color, 0));
    bar.style.setProperty('--nation', `#${p.color.toString(16).padStart(6, '0')}`);
  }

  function refresh(): void {
    const view = ctx.sim.view;
    const p = view.human;
    if (!p) return;
    rebuildFlag();
    setText(nameEl, p.name);
    // Rank by territory
    let rank = 1, alive = 0;
    for (const q of view.playerList) {
      if (!q.alive || q.tiles <= 0) continue;
      alive++;
      if (q.id !== p.id && q.tiles > p.tiles) rank++;
    }
    setText(rankEl, p.alive ? t('hud.rank', { rank, total: alive }) : t('hud.eliminated'));
    setText(troops.v, `${formatCompact(p.troops)}`);
    setText(troops.sub, `/ ${formatCompact(p.maxTroops)}  +${formatCompact(p.troopGrowth)}/s`);
    const fill = p.maxTroops > 0 ? Math.min(1, p.troops / p.maxTroops) : 0;
    setStyle(troopBar, 'transform', `scaleX(${fill.toFixed(3)})`);
    toggleClass(troops.el, 'is-full', fill > 0.97);
    setText(gold.v, formatCompact(p.gold));
    setText(gold.sub, `+${formatCompact(p.income)}/s`);
    const land = view.world?.landTiles ?? 1;
    const pct = (p.tiles / land) * 100;
    setText(terr.v, `${pct < 10 ? pct.toFixed(2) : pct.toFixed(1)}%`);
    setText(terr.sub, `${formatNumber(p.tiles)} ▦`);
    setText(pop.v, formatCompact(p.population));
    setText(pop.sub, p.attackingTroops > 0 ? `⚔ ${formatCompact(p.attackingTroops)}` : '');
    toggleClass(pop.sub, 'fu-warn', p.attackingTroops > 0);

    setText(clock, formatDuration(view.simTime));
    for (const [sp, b] of speedBtns) toggleClass(b, 'is-on', view.speed === sp);
    toggleClass(time, 'is-paused', view.speed === 0);
    const d = view.doomsday;
    toggleClass(doom, 'fu-hidden', !(d > 0));
    if (d > 0) {
      // Clock face: 23:45 at level 0 → 00:00 at level 1 (or the sim's own minutes-to-midnight when known).
      const mins = doomMinutes >= 0 ? doomMinutes : Math.max(0, Math.round((1 - d) * 15));
      const hh = mins === 0 ? 0 : 23, mm = mins === 0 ? 0 : 60 - mins;
      setText(doomClock, `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
      toggleClass(doom, 'is-critical', d > 0.8);
    }
  }

  return { el: bar, time, refresh, rebuildFlag };
}
