// FRONT ULTRA — HUD top bar (owner: ui): nation badge, troops/max with growth, gold with income, territory %,
// population; and the top-right time controls (clock, pause/1x/2x/4x, pause menu, settings, help).

import { h, setStyle, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon } from '../icons';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { createBonusLedger, goldTip, popTip, territoryTip, troopsTip, warsTip } from './explain';
import type { HudShared } from './shared';
import type { GameSpeed } from '../../shared/types';
import { HUMAN_ID } from '../../shared/constants';
import { formatCompact, formatNumber, t, tn } from '../../shared/i18n';

export interface TopBar {
  el: HTMLElement;
  time: HTMLElement;
  refresh(): void;
  rebuildFlag(): void;
}

export interface TopBarActions {
  pause(): void;
  settings(): void;
  help(): void;
  /** v2 (W3): the nations drawer (N), the alert log (L) and the count of inbox items waiting. */
  nations?(): void;
  log?(): void;
  pending?(): number;
}

export function createTopBar(hs: HudShared, actions: TopBarActions): TopBar {
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
  // v2 (W3, §12.2): every figure explains itself with its per-hour breakdown.
  const ledger = createBonusLedger(hs);
  tip(troops.el, () => troopsTip(hs));
  tip(gold.el, () => goldTip(hs, ledger));
  tip(terr.el, () => territoryTip(hs));
  tip(pop.el, () => popTip(hs));
  const warsN = h('span', { class: 'fu-tb-v fu-mono' }, '0');
  const wars = h('div', { class: 'fu-tb-stat is-wars fu-interactive' },
    h('div', { class: 'fu-tb-ico' }, icon('attack')),
    h('div', { class: 'fu-tb-body' }, h('div', { class: 'fu-tb-k' }, tx('tb.wars')), h('div', { class: 'fu-tb-line' }, warsN)),
  );
  tip(wars, () => warsTip(hs));
  wars.addEventListener('click', () => {
    hs.sound('click');
    actions.nations?.();
  });

  const bar = h('div', { class: 'fu-topbar fu-glass fu-brackets' },
    h('div', { class: 'fu-tb-nation' }, flagBox, h('div', { class: 'fu-tb-nation-text' }, nameEl, rankEl)),
    h('div', { class: 'fu-tb-sep' }),
    troops.el, gold.el, terr.el, pop.el, wars,
  );

  // ---- time controls ------------------------------------------------------------------------------
  // v2 (§2.7): «DÍA n» with a 24-segment bar that fills one segment per game hour (elapsed game time, never a time of
  // day), the speed buttons (pause, 0.5x..4x) and the scale chip of the running clock mode.
  const dayLabel = h('span', { class: 'fu-mono fu-day-label' }, t('clock.day', { day: 1 }));
  const hourBar = h('div', { class: 'fu-hourbar' });
  const hourSegs: HTMLElement[] = [];
  for (let i = 0; i < 24; i++) {
    const seg = h('i');
    hourSegs.push(seg);
    hourBar.append(seg);
  }
  const clock = h('div', { class: 'fu-time-clock fu-daybox' }, dayLabel, hourBar);
  const chip = h('div', { class: 'fu-clockchip fu-mono' }, '');
  const speedBtns = new Map<GameSpeed, HTMLButtonElement>();
  const speeds = h('div', { class: 'fu-seg fu-time-seg' });
  for (const sp of [0, 0.5, 1, 2, 4] as GameSpeed[]) {
    const label = sp === 0.5 ? t('hud.speed.half') : `${sp}×`;
    const title = sp === 0 ? `${t('hud.pause')} (Space)` : t('hud.speed.tip', { speed: sp === 0.5 ? '0,5' : sp, per: perSecond(sp) });
    const b = h('button', { type: 'button' }, sp === 0 ? icon('pause') : label) as HTMLButtonElement;
    tip(b, () => ({ title: sp === 0 ? t('hud.pause') : t('tb.speed.title', { speed: sp === 0.5 ? '0,5' : sp }), text: title, hotkey: sp === 0 ? t('keys.space') : '+ / −', lines: [t('tb.speed.line')] }));
    b.addEventListener('click', () => {
      hs.sound('click');
      if (sp === 0) ctx.app.togglePause();
      else ctx.app.setSpeed(sp);
    });
    speedBtns.set(sp, b);
    speeds.append(b);
  }
  const iconBtn = (ico: string, titleKey: string, fn: () => void, tipKey?: string, hotkey?: string) => {
    const b = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--icon fu-time-btn' }, icon(ico));
    tip(b, () => ({ title: t(titleKey), text: tipKey ? t(tipKey) : undefined, hotkey }));
    b.addEventListener('click', () => {
      hs.sound('click');
      fn();
    });
    return b;
  };
  const nationsBadge = h('span', { class: 'fu-tb-badge fu-mono fu-hidden' });
  const nationsBtn = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--icon fu-time-btn fu-nations-btn' }, icon('globe'), nationsBadge);
  tip(nationsBtn, () => ({ title: t('nations.title'), text: t('tb.nations.tip'), hotkey: 'N', now: [[t('inbox.pending'), String(actions.pending?.() ?? 0)]] }));
  nationsBtn.addEventListener('click', () => {
    hs.sound('click');
    actions.nations?.();
  });
  const doomClock = h('b', { class: 'fu-mono' }, '23:45');
  const doom = h('div', { class: 'fu-doom fu-hidden' }, icon('radiation'), h('span', { class: 'fu-caps' }, tx('hud.doomsday')), doomClock);
  let doomMinutes = -1;
  ctx.bus.on('doomsday', (e) => (doomMinutes = Math.max(0, Math.round(e.minutesToMidnight))));
  ctx.bus.on('gameTornDown', () => (doomMinutes = -1));
  // v2 (§4.18): the hegemony countdown chip («Alemania alcanzará la hegemonía en 6 días»).
  const hegChip = h('div', { class: 'fu-hegchip fu-mono fu-hidden' }, '');
  let heg = { leader: 0, until: 0 };
  ctx.bus.on('hegemony', (e) => {
    heg = e.stage === 'start' ? { leader: e.leader, until: e.untilTick } : { leader: 0, until: 0 };
  });
  ctx.bus.on('gameTornDown', () => (heg = { leader: 0, until: 0 }));
  const time = h('div', { class: 'fu-time fu-glass fu-interactive' },
    h('div', { class: 'fu-time-main' }, icon('clock'), clock, speeds,
      nationsBtn, iconBtn('bell', 'alerts.log', () => actions.log?.(), 'alerts.log.tip', 'L'),
      iconBtn('help', 'hud.help', actions.help, 'tb.help.tip', 'F1'), iconBtn('settings', 'menu.settings', actions.settings, 'tb.settings.tip'), iconBtn('menu', 'hud.menu', actions.pause, 'tb.menu.tip', 'Esc')),
    chip,
    hegChip,
    doom,
  );
  let lastDay = -1, lastHour = -1, lastChip = '', lastMode = '';
  let dayTip = '', chipTip = '';
  tip(clock, () => ({ title: t('tb.day.title'), text: dayTip }));
  tip(chip, () => ({ title: t('tb.clock.title'), text: chipTip, lines: [t('tb.clock.air'), t('tb.clock.crisis')] }));

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
    setText(troops.sub, `/ ${formatCompact(p.maxTroops)}  +${formatCompact(p.troopGrowth)}/h`);
    const fill = p.maxTroops > 0 ? Math.min(1, p.troops / p.maxTroops) : 0;
    setStyle(troopBar, 'transform', `scaleX(${fill.toFixed(3)})`);
    toggleClass(troops.el, 'is-full', fill > 0.97);
    setText(gold.v, formatCompact(p.gold));
    setText(gold.sub, `+${formatCompact(p.income)}/h`);
    let nw = 0;
    for (const w of view.wars) if (w.aggressor === HUMAN_ID || w.target === HUMAN_ID) nw++;
    setText(warsN, String(nw));
    toggleClass(wars, 'is-active', nw > 0);
    const pend = actions.pending?.() ?? 0;
    setText(nationsBadge, String(pend));
    toggleClass(nationsBadge, 'fu-hidden', pend === 0);
    const land = view.world?.landTiles ?? 1;
    const pct = (p.tiles / land) * 100;
    setText(terr.v, `${pct < 10 ? pct.toFixed(2) : pct.toFixed(1)}%`);
    setText(terr.sub, `${formatNumber(p.tiles)} ▦`);
    setText(pop.v, formatCompact(p.population));
    setText(pop.sub, p.attackingTroops > 0 ? `⚔ ${formatCompact(p.attackingTroops)}` : '');
    toggleClass(pop.sub, 'fu-warn', p.attackingTroops > 0);

    // Day counter: elapsed game time (tick / 10 = game hours).
    const hours = Math.max(0, Math.floor(view.gameHours));
    const day = Math.floor(hours / 24) + 1, hourOfDay = hours % 24;
    if (day !== lastDay) {
      lastDay = day;
      setText(dayLabel, t('clock.day', { day }));
    }
    if (hourOfDay !== lastHour || day !== lastDay) {
      lastHour = hourOfDay;
      for (let i = 0; i < 24; i++) toggleClass(hourSegs[i], 'is-on', i < hourOfDay);
      dayTip = tn('clock.day.tip', hours, { day, hours: formatNumber(hours) });
    }
    // Scale chip: what one real second means right now.
    const c = view.clock;
    let chipText: string, tipTx: string;
    const sp = view.speed;
    const spLabel = sp === 0.5 ? (t('hud.speed.half').replace('×', '')) : String(sp);
    switch (c.mode) {
      case 'crisis': chipText = t('clock.chip.crisis'); tipTx = t('clock.tip.crisis'); break;
      case 'observation': chipText = t('clock.chip.observation'); tipTx = t('clock.tip.observation'); break;
      case 'tactical': chipText = t('clock.chip.tactical'); tipTx = t('clock.tip.tactical'); break;
      case 'travel': chipText = t(c.throttled ? 'clock.chip.travelThrottled' : 'clock.chip.travel', { rate: Math.round(c.rate) }); tipTx = t('clock.tip.travel'); break;
      default:
        if (sp === 0) {
          chipText = t('clock.chip.paused');
          tipTx = t('clock.tip.paused');
        } else {
          chipText = t('clock.chip.strategic', { speed: spLabel, per: perSecond(sp) });
          tipTx = t('clock.tip.strategic', { speed: spLabel, per: perSecond(sp) });
        }
    }
    if (sp === 0 && c.mode !== 'strategic') chipText = `${t('clock.chip.paused')} · ${chipText}`;
    if (chipText !== lastChip) {
      lastChip = chipText;
      setText(chip, chipText);
      chipTip = tipTx;
    }
    if (c.mode !== lastMode) {
      lastMode = c.mode;
      chip.dataset.mode = c.mode;
    }
    toggleClass(hegChip, 'fu-hidden', heg.leader === 0);
    if (heg.leader) {
      const days = Math.max(0, Math.ceil((heg.until - view.tick) / 240));
      setText(hegChip, heg.leader === HUMAN_ID ? t('hegemony.chipUs', { days }) : t('hegemony.chip', { name: hs.name(heg.leader), days }));
    }
    for (const [spd, b] of speedBtns) toggleClass(b, 'is-on', view.speed === spd);
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

/** Game time per real second at a strategic speed ("30 min", "1 h", "4 h"). */
function perSecond(sp: GameSpeed): string {
  if (sp === 0.5) return t('clock.per.30min');
  return t('clock.per.hours', { n: sp });
}
