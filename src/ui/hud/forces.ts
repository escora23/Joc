// FRONT ULTRA — the Fuerzas panel, `U` (DESIGN_V2 §7.5; owner: ui, W4).
//
// Every own division, squadron (docked included), bomber, drone swarm, warship and convoy, grouped by what it is doing
// (En combate, En marcha, En patrulla, En base) with its name, place, state and ETA, integrity and the front it
// fights on; the units in production with their progress and ETA; the capacity per type. Tabs Tierra / Aire / Mar /
// Todo. Click: select and fly there; Shift+click: add to / remove from the selection; buttons: Tomar el mando, Volver.
// Debug hook: window.__fuForces (rows, count, production).

import { h, setStyle, setText, toggleClass } from '../dom';
import { icon, UNIT_ICON } from '../icons';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { unitLabel } from './news';
import type { HudShared } from './shared';
import {
  domainOf, effectLine, etaText, frontName, groupOf, isListedForce, placeOf, stateLine, stationOrder, structureName, unitName,
  type Domain, type ForceGroup,
} from './forcesInfo';
import { selectedUnitIds } from './orderCtl';
import { HUMAN_ID, UNIT_DEFS, structureLevel } from '../../shared/constants';
import { tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import { StructureType, UnitMode, UnitState, UnitType, type ProductionView, type UnitView } from '../../shared/types';

export interface ForcesPanel {
  el: HTMLElement;
  readonly isOpen: boolean;
  open(): void;
  close(): void;
  toggle(): void;
  update(): void;
}

type Tab = Domain | 'all';
const GROUPS: ForceGroup[] = ['combat', 'moving', 'patrol', 'base', 'production'];
const TABS: Tab[] = ['land', 'air', 'sea', 'all'];

interface Row {
  el: HTMLElement;
  place: HTMLElement;
  state: HTMLElement;
  bar: HTMLElement;
  pctEl: HTMLElement;
  front: HTMLElement;
  back: HTMLButtonElement | null;
}

export function createForces(hs: HudShared): ForcesPanel {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  let isOpen = false;
  let tab: Tab = 'all';
  let listKey = '';
  const rows = new Map<number, Row>();
  const prodRows = new Map<string, { el: HTMLElement; bar: HTMLElement; eta: HTMLElement }>();

  const closeBtn = h('button', { class: 'fu-close' }, icon('close'));
  closeBtn.addEventListener('click', () => close());
  tip(closeBtn, () => ({ title: t('common.close'), text: t('forces.close.tip'), hotkey: 'U / Esc' }));
  const tabBtns = new Map<Tab, { el: HTMLElement; n: HTMLElement }>();
  const tabsEl = h('div', { class: 'fu-nt-tabs' });
  for (const tb of TABS) {
    const n = h('span', { class: 'fu-fo-tabn fu-mono' });
    const b = h('button', { class: 'fu-nt-tab' }, tx(`forces.tab.${tb}`), n);
    b.addEventListener('click', () => {
      hs.sound('click');
      setTab(tb);
    });
    tip(b, () => ({ title: t(`forces.tab.${tb}`), text: t(`forces.tab.${tb}.tip`) }));
    tabBtns.set(tb, { el: b, n });
    tabsEl.append(b);
  }
  const body = h('div', { class: 'fu-nt-body fu-fo-body' });
  const foot = h('div', { class: 'fu-fo-foot' });
  const hint = h('div', { class: 'fu-fo-hint' }, icon('mouse'), tx('forces.hint'));
  const el = h('div', { class: 'fu-forces fu-glass fu-brackets fu-interactive fu-hidden' },
    h('div', { class: 'fu-nt-head' }, h('div', { class: 'fu-panel-title' }, icon('armoredDivision'), tx('forces.title')), h('span', { class: 'fu-kbd' }, 'U'), closeBtn),
    tabsEl, body, hint, foot,
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  function setTab(tb: Tab): void {
    tab = tb;
    for (const [k, v] of tabBtns) toggleClass(v.el, 'is-on', k === tb);
    listKey = '';
    update();
  }
  setTab('all');

  // ---- data ------------------------------------------------------------------------------------
  function forces(): UnitView[] {
    const out: UnitView[] = [];
    for (const u of view().units.values()) if (isListedForce(u) && u.state !== UnitState.Destroyed) out.push(u);
    out.sort((a, b) => a.type - b.type || a.serial - b.serial || a.id - b.id);
    return out;
  }
  const inTab = (type: UnitType) => tab === 'all' || domainOf(type) === tab;

  // ---- actions ---------------------------------------------------------------------------------
  function selectAndFly(u: UnitView, add: boolean): void {
    hs.sound('click');
    if (add) {
      const ids = selectedUnitIds(hs);
      const i = ids.indexOf(u.id);
      if (i >= 0) ids.splice(i, 1);
      else ids.push(u.id);
      hs.select({ kind: 'units', ids });
      return;
    }
    hs.select({ kind: 'unit', id: u.id });
    const ll = tileXYToLatLon(u.x, u.y);
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 900, durationMs: 1200 });
  }

  function makeRow(u: UnitView): Row {
    const def = UNIT_DEFS[u.type];
    const place = h('small', { class: 'fu-fo-place' });
    const state = h('span', { class: 'fu-fo-state' });
    const bar = h('i');
    const pctEl = h('span', { class: 'fu-mono' });
    const front = h('span', { class: 'fu-fo-front' });
    const btns = h('div', { class: 'fu-fo-btns' });
    let back: HTMLButtonElement | null = null;
    if (def.command) {
      const tc = h('button', { class: 'fu-btn fu-btn--xs' }, icon('takeControl')) as HTMLButtonElement;
      tip(tc, () => ({ title: t('hud.takeControl'), text: t(`hud.takeControl.${def.command}`), whyNot: u.state === UnitState.Controlled ? t('order.err.controlled') : null, hotkey: 'T' }));
      tc.addEventListener('click', (e) => {
        e.stopPropagation();
        hs.sound('whoosh');
        hs.flags.commandEntered = true;
        close();
        void ctx.app.enterCommandMode(u.id);
      });
      btns.append(tc);
    }
    if (u.type !== UnitType.TransportShip) {
      back = h('button', { class: 'fu-btn fu-btn--xs' }, icon('home')) as HTMLButtonElement;
      tip(back, () => ({ title: t('order.return'), text: t(`forces.return.${domainOf(u.type)}`) }));
      back.addEventListener('click', (e) => {
        e.stopPropagation();
        hs.sound('confirm');
        ctx.sim.send({ type: 'unitOrder', unitIds: [u.id], order: 'return', tile: -1, targetId: 0 });
      });
      btns.append(back);
    }
    const name = h('b', null, unitName(u));
    const rowEl = h('div', { class: 'fu-fo-row', 'data-unit': String(u.id) },
      h('span', { class: 'fu-fo-ico' }, icon(UNIT_ICON[u.type])),
      h('div', { class: 'fu-fo-main' },
        h('div', { class: 'fu-fo-line' }, name, front),
        state,
        place,
        h('div', { class: 'fu-fo-hp' }, h('div', { class: 'fu-sel-bar' }, bar), pctEl),
      ),
      btns,
    );
    rowEl.addEventListener('click', (e) => selectAndFly(u, e.shiftKey));
    rowEl.addEventListener('mouseenter', () => hs.sound('hover'));
    tip(rowEl, () => {
      const cur = view().units.get(u.id);
      if (!cur) return null;
      return { title: unitName(cur), text: t(UNIT_DEFS[cur.type].roleKey), lines: [effectLine(hs, cur), t('forces.row.tip')] };
    });
    return { el: rowEl, place, state, bar, pctEl, front, back };
  }

  function prodKey(q: ProductionView): string {
    return `${q.structureId}:${q.serial}:${q.unit}`;
  }

  function makeProdRow(q: ProductionView, last: boolean): { el: HTMLElement; bar: HTMLElement; eta: HTMLElement } {
    const s = view().structures.get(q.structureId);
    const bar = h('i');
    const eta = h('span', { class: 'fu-mono' });
    const btns = h('div', { class: 'fu-fo-btns' });
    if (last) {
      const c = h('button', { class: 'fu-btn fu-btn--xs' }, icon('close'));
      tip(c, () => ({ title: t('forces.cancel'), text: t('forces.cancel.tip') }));
      c.addEventListener('click', (e) => {
        e.stopPropagation();
        hs.sound('cancel');
        ctx.sim.send({ type: 'cancelProduction', structureId: q.structureId });
      });
      btns.append(c);
    }
    const r = h('div', { class: 'fu-fo-row is-prod' },
      h('span', { class: 'fu-fo-ico' }, icon(UNIT_ICON[q.unit])),
      h('div', { class: 'fu-fo-main' },
        h('div', { class: 'fu-fo-line' }, h('b', null, unitLabel(q.unit, q.serial))),
        h('small', { class: 'fu-fo-place' }, s ? structureName(hs, s) : ''),
        h('div', { class: 'fu-fo-hp' }, h('div', { class: 'fu-sel-bar is-amber' }, bar), eta),
      ),
      btns,
    );
    r.addEventListener('click', () => {
      if (!s) return;
      hs.sound('click');
      hs.select({ kind: 'structure', id: s.id });
      const ll = tileXYToLatLon((s.tile % 1600) + 0.5, Math.floor(s.tile / 1600) + 0.5);
      ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 900, durationMs: 1200 });
    });
    return { el: r, bar, eta };
  }

  // ---- capacity footer ---------------------------------------------------------------------------
  function capacity(): { key: string; n: number; cap: number }[] {
    const v = view();
    const caps = { land: 0, air: 0, sea: 0 };
    const used = { land: 0, air: 0, sea: 0 };
    for (const s of v.structures.values()) {
      if (s.owner !== HUMAN_ID || s.built < 1) continue;
      const c = structureLevel(s.type, s.level).capacity ?? 0;
      if (s.type === StructureType.ArmyBase) caps.land += c;
      else if (s.type === StructureType.Airbase) caps.air += c;
      else if (s.type === StructureType.NavalYard) caps.sea += c;
    }
    for (const u of v.units.values()) {
      if (u.owner !== HUMAN_ID || !isListedForce(u) || u.type === UnitType.TransportShip) continue;
      used[domainOf(u.type)]++;
    }
    for (const q of v.production) used[domainOf(q.unit)]++;
    return [
      { key: 'land', n: used.land, cap: caps.land },
      { key: 'air', n: used.air, cap: caps.air },
      { key: 'sea', n: used.sea, cap: caps.sea },
    ];
  }

  // ---- refresh -----------------------------------------------------------------------------------
  /**
   * Dock the drawer so it never hides the time controls or the selected unit's card (FEEDBACK-1 item 7): it starts
   * under the clock and speed widget, and while it is open the selection card moves to its left, above the build bar.
   */
  function dock(): void {
    const root = el.parentElement;
    if (!root) return;
    root.classList.toggle('is-forces-open', isOpen);
    if (!isOpen) return;
    const time = root.querySelector<HTMLElement>('.fu-hud-tr .fu-time');
    const tr = time?.getBoundingClientRect();
    const top = tr && tr.height > 0 ? Math.round(tr.bottom + 8) : 14;
    if (el.style.top !== `${top}px`) el.style.top = `${top}px`;
    const bar = root.querySelector<HTMLElement>('.fu-hud-bottom-row')?.getBoundingClientRect();
    const clear = bar && bar.height > 0 ? Math.round(window.innerHeight - bar.top + 10) : 14;
    root.style.setProperty('--fu-forces-w', `${Math.round(el.getBoundingClientRect().width)}px`);
    root.style.setProperty('--fu-forces-clear', `${clear}px`);
  }
  window.addEventListener('resize', () => dock());

  function update(): void {
    if (!isOpen) return;
    dock();
    const v = view();
    const list = forces();
    const counts: Record<Tab, number> = { land: 0, air: 0, sea: 0, all: 0 };
    for (const u of list) {
      counts[domainOf(u.type)]++;
      counts.all++;
    }
    for (const q of v.production) {
      counts[domainOf(q.unit)]++;
      counts.all++;
    }
    for (const [k, b] of tabBtns) setText(b.n, counts[k] ? String(counts[k]) : '');
    const shown = list.filter((u) => inTab(u.type));
    const prod = v.production.filter((q) => inTab(q.unit));
    const key = `${tab}|${shown.map((u) => `${u.id}:${groupOf(u)}`).join(',')}|${prod.map(prodKey).join(',')}`;
    if (key !== listKey) {
      listKey = key;
      const byGroup = new Map<ForceGroup, HTMLElement[]>();
      const keep = new Set<number>();
      for (const u of shown) {
        let r = rows.get(u.id);
        if (!r) rows.set(u.id, (r = makeRow(u)));
        keep.add(u.id);
        const g = groupOf(u);
        (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(r.el);
      }
      for (const id of [...rows.keys()]) if (!keep.has(id) && !v.units.has(id)) rows.delete(id);
      prodRows.clear();
      const lastAt = new Map<number, string>();
      for (const q of v.production) lastAt.set(q.structureId, prodKey(q));
      for (const q of prod) {
        const pr = makeProdRow(q, lastAt.get(q.structureId) === prodKey(q));
        prodRows.set(prodKey(q), pr);
        (byGroup.get('production') ?? byGroup.set('production', []).get('production')!).push(pr.el);
      }
      const children: HTMLElement[] = [];
      for (const g of GROUPS) {
        const items = byGroup.get(g);
        if (!items || !items.length) continue;
        children.push(h('div', { class: `fu-fo-group is-${g}` }, h('span', null, t(`forces.group.${g}`)), h('b', { class: 'fu-mono' }, String(items.length))), ...items);
      }
      if (!children.length) children.push(h('div', { class: 'fu-fo-empty' }, t(tab === 'all' ? 'forces.empty' : `forces.empty.${tab}`)));
      body.replaceChildren(...children);
    }
    // Live fields.
    const sel = new Set(selectedUnitIds(hs));
    for (const u of shown) {
      const r = rows.get(u.id);
      if (!r) continue;
      setText(r.state, stateLine(hs, u));
      setText(r.place, placeOf(hs, u));
      setStyle(r.bar, 'transform', `scaleX(${Math.max(0, Math.min(1, u.hp)).toFixed(3)})`);
      toggleClass(r.bar, 'is-low', u.hp < 0.3);
      setText(r.pctEl, `${Math.round(u.hp * 100)} %`);
      const fr = u.frontKey && (u.mode === UnitMode.Front || u.mode === UnitMode.Offensive || u.mode === UnitMode.Support) ? frontName(hs, u.frontKey) : '';
      setText(r.front, fr);
      toggleClass(r.el, 'is-sel', sel.has(u.id));
      if (r.back) toggleClass(r.back, 'fu-hidden', (u.mode === UnitMode.Docked || u.mode === UnitMode.Rearming) && !stationOrder(u));
    }
    for (const q of prod) {
      const pr = prodRows.get(prodKey(q));
      if (!pr) continue;
      const total = Math.max(1, q.readyTick - q.startTick);
      const started = v.tick >= q.startTick;
      const f = started ? Math.min(1, (v.tick - q.startTick) / total) : 0;
      setStyle(pr.bar, 'transform', `scaleX(${f.toFixed(3)})`);
      setText(pr.eta, started ? etaText(hs, q.readyTick - v.tick, false) : t('forces.queued', { eta: etaText(hs, q.readyTick - v.tick, false) }));
    }
    // Capacity footer.
    const cap = capacity();
    foot.replaceChildren(...cap.map((c) => {
      const full = c.cap > 0 && c.n >= c.cap;
      const line = h('div', { class: `fu-fo-cap${full ? ' is-full' : ''}` }, h('span', null, t(`forces.cap.${c.key}`)), h('b', { class: 'fu-mono' }, `${c.n}/${c.cap}`));
      tip(line, () => ({ title: t(`forces.cap.${c.key}`), text: t(`forces.cap.${c.key}.tip`) }));
      return line;
    }));
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    hs.forcesOpen = true;
    el.classList.remove('fu-hidden');
    listKey = '';
    update();
    hs.sound('open');
    ctx.bus.emit('panelToggled', { panel: 'forces', open: true });
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    hs.forcesOpen = false;
    el.classList.add('fu-hidden');
    dock();
    ctx.bus.emit('panelToggled', { panel: 'forces', open: false });
  }
  function toggle(): void {
    if (isOpen) close();
    else open();
  }

  (window as unknown as { __fuForces?: unknown }).__fuForces = {
    open, close, setTab: (tb: Tab) => setTab(tb),
    rows: () => {
      const out: { id: number; name: string; state: string; place: string; hp: number; group: ForceGroup; front: string }[] = [];
      for (const u of forces()) out.push({ id: u.id, name: unitName(u), state: stateLine(hs, u), place: placeOf(hs, u), hp: +u.hp.toFixed(3), group: groupOf(u), front: frontName(hs, u.frontKey) });
      return out;
    },
    count: () => forces().length,
    production: () => view().production.map((q) => ({ ...q, eta: q.readyTick - view().tick, name: unitLabel(q.unit, q.serial) })),
    dom: () => [...body.querySelectorAll('.fu-fo-row')].map((r) => (r as HTMLElement).innerText.replace(/\s+/g, ' ').trim()),
    capacity,
  };

  return {
    el,
    get isOpen() {
      return isOpen;
    },
    open, close, toggle, update,
  };
}


