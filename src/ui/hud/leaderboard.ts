// FRONT ULTRA — leaderboard (owner: ui): top 10 nations by territory with the player's rank pinned, allies
// and traitors marked. Rows are pre-built and patched in place (<= 4 Hz); clicking a row selects the nation
// and flies the camera there.

import { h, setStyle, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { HUMAN_ID } from '../../shared/constants';
import { hexToCss } from '../../shared/color';
import { tileXYToLatLon, tileToLatLon } from '../../shared/geo';
import { formatCompact } from '../../shared/i18n';
import type { PlayerView } from '../../shared/types';

const ROWS = 10;

interface Row {
  el: HTMLElement;
  rank: HTMLElement;
  sw: HTMLElement;
  name: HTMLElement;
  badge: HTMLElement;
  pct: HTMLElement;
  bar: HTMLElement;
  troops: HTMLElement;
  id: number;
}

export interface Leaderboard {
  el: HTMLElement;
  refresh(): void;
  toggle(): void;
}

export function createLeaderboard(hs: HudShared): Leaderboard {
  const ctx = hs.ctx;
  const body = h('div', { class: 'fu-lb-rows' });
  const collapse = h('button', { class: 'fu-lb-toggle', title: 'Tab' }, icon('chevronUp'));
  const el = h('div', { class: 'fu-lb fu-glass fu-interactive' },
    h('div', { class: 'fu-lb-head' }, h('div', { class: 'fu-panel-title' }, icon('crown'), tx('hud.leaderboard')), h('span', { class: 'fu-kbd' }, 'Tab'), collapse),
    h('div', { class: 'fu-lb-cols fu-caps' }, h('span', null, '#'), tx('hud.lb.nation'), tx('hud.lb.land'), tx('hud.lb.troops')),
    body,
  );
  const rows: Row[] = [];
  const mkRow = (pinned: boolean): Row => {
    const rank = h('span', { class: 'fu-lb-rank fu-mono' });
    const sw = h('i', { class: 'fu-lb-sw' });
    const name = h('span', { class: 'fu-lb-name' });
    const badge = h('span', { class: 'fu-lb-badge' });
    const pct = h('span', { class: 'fu-lb-pct fu-mono' });
    const bar = h('i', { class: 'fu-lb-bar' });
    const troops = h('span', { class: 'fu-lb-troops fu-mono' });
    const rowEl = h('div', { class: `fu-lb-row${pinned ? ' is-pinned' : ''}` }, bar, rank, h('span', { class: 'fu-lb-who' }, sw, name, badge), pct, troops);
    const row: Row = { el: rowEl, rank, sw, name, badge, pct, bar, troops, id: 0 };
    rowEl.addEventListener('click', () => {
      if (!row.id) return;
      hs.sound('click');
      const p = ctx.sim.view.players[row.id];
      if (!p) return;
      if (row.id !== HUMAN_ID) hs.select({ kind: 'nation', id: row.id });
      const ll = p.labelSize > 0 ? tileXYToLatLon(p.labelX, p.labelY) : p.capitalTile >= 0 ? tileToLatLon(p.capitalTile) : null;
      if (ll) ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 5200, durationMs: 1400 });
    });
    rowEl.addEventListener('mouseenter', () => hs.sound('hover'));
    return row;
  };
  for (let i = 0; i < ROWS; i++) {
    const r = mkRow(false);
    rows.push(r);
    body.append(r.el);
  }
  const pinnedSep = h('div', { class: 'fu-lb-gap' }, '···');
  const pinned = mkRow(true);
  body.append(pinnedSep, pinned.el);

  let collapsed = false;
  const toggle = () => {
    collapsed = !collapsed;
    toggleClass(el, 'is-collapsed', collapsed);
    hs.sound('toggle');
  };
  collapse.addEventListener('click', toggle);

  const sorted: PlayerView[] = [];
  function fill(r: Row, p: PlayerView, rank: number, land: number, maxTiles: number): void {
    r.id = p.id;
    r.el.style.display = '';
    setText(r.rank, String(rank));
    setStyle(r.sw, 'background', hexToCss(p.color));
    setText(r.name, hs.name(p.id));
    const pct = (p.tiles / land) * 100;
    setText(r.pct, pct >= 10 ? `${pct.toFixed(1)}%` : `${pct.toFixed(2)}%`);
    setStyle(r.bar, 'transform', `scaleX(${(p.tiles / Math.max(1, maxTiles)).toFixed(3)})`);
    setStyle(r.bar, 'background', `linear-gradient(90deg, ${hexToCss(p.color)}55, transparent)`);
    setText(r.troops, formatCompact(p.troops));
    toggleClass(r.el, 'is-me', p.id === HUMAN_ID);
    const ally = hs.isAlly(p.id);
    toggleClass(r.el, 'is-ally', ally);
    const traitor = p.traitorTicks > 0;
    const sel = hs.selection.kind === 'nation' && hs.selection.id === p.id;
    toggleClass(r.el, 'is-selected', sel);
    const badgeKey = ally ? 'ally' : traitor ? 'traitor' : '';
    if (r.badge.dataset.k !== badgeKey) {
      r.badge.dataset.k = badgeKey;
      r.badge.replaceChildren(badgeKey === 'ally' ? icon('alliance') : badgeKey === 'traitor' ? icon('skull') : '');
      r.badge.className = `fu-lb-badge${badgeKey ? ` is-${badgeKey}` : ''}`;
    }
  }

  function refresh(): void {
    const view = ctx.sim.view;
    const land = view.world?.landTiles ?? 1;
    sorted.length = 0;
    for (const p of view.playerList) if (p.alive && p.tiles > 0) sorted.push(p);
    sorted.sort((a, b) => b.tiles - a.tiles);
    const maxTiles = sorted.length ? sorted[0].tiles : 1;
    let meIndex = -1;
    for (let i = 0; i < sorted.length; i++) if (sorted[i].id === HUMAN_ID) meIndex = i;
    for (let i = 0; i < ROWS; i++) {
      const p = sorted[i];
      if (p) fill(rows[i], p, i + 1, land, maxTiles);
      else {
        rows[i].id = 0;
        rows[i].el.style.display = 'none';
      }
    }
    const showPinned = meIndex >= ROWS;
    pinnedSep.style.display = showPinned ? '' : 'none';
    pinned.el.style.display = showPinned ? '' : 'none';
    if (showPinned) fill(pinned, sorted[meIndex], meIndex + 1, land, maxTiles);
  }

  return { el, refresh, toggle };
}
