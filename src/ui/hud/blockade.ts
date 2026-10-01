// FRONT ULTRA — the blockade order (owner item 30; owner: ui). Ordering warships to blockade a port, a strait or a
// stretch of a sea lane opens this dialog before anything is sent: whom the blockade stops (only the nations at war with
// us by default, so nobody else is turned against us), which ships, and whether they are boarded or sunk, with a live
// preview of what passes there now, what it would gain and cut, and what it would cost diplomatically (the same figures
// the sim applies: shared/naval.ts). Confirming sends one unitOrder with the spec.

import { h, toggleClass } from '../dom';
import { openModal } from '../modal';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { hexToCss } from '../../shared/color';
import { CASUS_BELLI_TICKS } from '../../shared/damage';
import { HUMAN_ID, TICKS_PER_GAME_DAY } from '../../shared/constants';
import { formatNumber, t } from '../../shared/i18n';
import {
  BLOCKADE_RADIUS_KM, DEFAULT_BLOCKADE, PIRACY_EMBARGO_OPINION, PIRACY_OPINION, PIRACY_WAR_OPINION,
  type BlockadeAction, type BlockadeShips, type BlockadeSpec, type BlockadeWho,
} from '../../shared/naval';
import { blockadePlace, gold, humanStops, ownShipsThrough, shipsThrough, tradeWith, zoneAt, type ShipsThrough } from './navalInfo';
import type { HudShared } from './shared';

/** Test / verification hook: the open dialog's state. */
interface DialogProbe {
  spec: BlockadeSpec;
  place: string;
  passing: ShipsThrough[];
  piracy: number[];
  text: () => string;
  set: (s: Partial<BlockadeSpec>) => void;
  confirm: () => void;
  cancel: () => void;
}
let probe: DialogProbe | null = null;
try {
  (window as unknown as { __fuBlockade?: unknown }).__fuBlockade = { current: () => probe };
} catch {
  /* no window */
}

export function openBlockadeDialog(hs: HudShared, ids: number[], tile: number, initial?: BlockadeSpec): void {
  const view = hs.ctx.sim.view;
  const zone = zoneAt(hs, tile);
  const place = blockadePlace(hs, zone);
  const spec: BlockadeSpec = { ...DEFAULT_BLOCKADE, ...(initial ?? {}) };
  if (spec.who === 'list' && !spec.nations) spec.nations = [];
  const passing = shipsThrough(view, zone.x, zone.y);
  // Nations offered in the list: those with ships here now, those at war with us, those we embargo.
  const offered = new Set<number>(passing.map((p) => p.owner));
  for (const p of view.playerList) {
    if (!p.alive || p.id === HUMAN_ID || p.kind === 'tribe') continue;
    if (view.pairState(HUMAN_ID, p.id) === 'war' || view.human?.embargoes.includes(p.id)) offered.add(p.id);
  }
  const nameOf = (id: number) => hs.name(id);

  // ---- fields -------------------------------------------------------------------------------------------------
  const seg = <K extends string>(keys: readonly K[], prefix: string, get: () => K, set: (k: K) => void) => {
    const el = h('div', { class: 'fu-seg fu-blk-seg' });
    const btns = new Map<K, HTMLElement>();
    for (const k of keys) {
      const b = h('button', { type: 'button' }, tx(`${prefix}.${k}`));
      b.addEventListener('click', () => {
        hs.sound('click');
        set(k);
        paint();
      });
      tip(b, () => ({ title: t(`${prefix}.${k}`), text: t(`${prefix}.${k}.tip`) }));
      btns.set(k, b);
      el.append(b);
    }
    return { el, paint: () => { for (const [k, b] of btns) toggleClass(b, 'is-on', k === get()); } };
  };
  const whoSeg = seg<BlockadeWho>(['war', 'embargo', 'list', 'all'], 'naval.who', () => spec.who, (k) => {
    spec.who = k;
    if (k === 'list') spec.nations = spec.nations ?? [...offered].filter((id) => view.pairState(HUMAN_ID, id) === 'war');
  });
  const shipsSeg = seg<BlockadeShips>(['all', 'trade', 'transports'], 'naval.ships', () => spec.ships, (k) => { spec.ships = k; });
  const actSeg = seg<BlockadeAction>(['seize', 'sink'], 'naval.action', () => spec.action, (k) => { spec.action = k; });
  const whoNote = h('div', { class: 'fu-blk-note' });
  const actNote = h('div', { class: 'fu-blk-note' });
  const list = h('div', { class: 'fu-blk-list fu-hidden' });
  for (const id of offered) {
    const p = view.players[id];
    if (!p) continue;
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.dataset.nation = String(id);
    cb.addEventListener('change', () => {
      const set = new Set(spec.nations ?? []);
      if (cb.checked) set.add(id);
      else set.delete(id);
      spec.nations = [...set];
      paint();
    });
    const rel = view.pairState(HUMAN_ID, id);
    list.append(h('label', { class: 'fu-blk-nation' }, cb, h('span', { class: 'fu-blk-chip', style: `background:${hexToCss(p.color)}` }), h('span', null, nameOf(id)),
      h('span', { class: `fu-blk-rel is-${rel}` }, t(`naval.rel.${rel === 'war' ? 'war' : view.players[HUMAN_ID]?.allies.includes(id) ? 'ally' : 'peace'}`))));
  }
  const preview = h('div', { class: 'fu-blk-preview' });

  function row(label: string, field: HTMLElement, note?: HTMLElement): HTMLElement {
    return h('div', { class: 'fu-blk-field' }, h('div', { class: 'fu-caps fu-blk-label' }, label), field, note ?? null);
  }

  // ---- preview ----------------------------------------------------------------------------------------------------
  function paint(): void {
    whoSeg.paint();
    shipsSeg.paint();
    actSeg.paint();
    toggleClass(list, 'fu-hidden', spec.who !== 'list');
    for (const cb of list.querySelectorAll<HTMLInputElement>('input[type=checkbox]')) cb.checked = (spec.nations ?? []).includes(Number(cb.dataset.nation));
    whoNote.textContent = t(`naval.who.${spec.who}.tip`);
    actNote.textContent = t(`naval.action.${spec.action}.tip`);
    preview.replaceChildren(...previewBody());
    go.className = `fu-btn ${piracyNations().length ? 'fu-btn--danger' : 'fu-btn--primary'}`;
    if (probe) probe.piracy = piracyNations();
  }

  /** Nations at peace with us whose ships passing now the spec would stop. */
  function piracyNations(): number[] {
    const out: number[] = [];
    for (const p of passing) {
      if (view.pairState(HUMAN_ID, p.owner) === 'war') continue;
      const stopT = p.trade > 0 && humanStops(view, spec, p.owner, 'trade');
      const stopC = p.convoys > 0 && humanStops(view, spec, p.owner, 'transport');
      if (stopT || stopC) out.push(p.owner);
    }
    return out;
  }

  function previewBody(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const li = (k: string, p: Record<string, string | number> = {}, cls = '') => h('li', cls ? { class: cls } : null, t(k, p));
    // What passes here now.
    out.push(h('div', { class: 'fu-caps fu-blk-label' }, t('naval.pv.passing')));
    if (!passing.length) out.push(h('div', { class: 'fu-blk-note' }, t('naval.pv.nobody')));
    else {
      const tbl = h('div', { class: 'fu-blk-table' });
      for (const p of passing.slice(0, 8)) {
        const P = view.players[p.owner];
        const rel = view.pairState(HUMAN_ID, p.owner) === 'war' ? 'war' : P && view.players[HUMAN_ID]?.allies.includes(p.owner) ? 'ally' : 'peace';
        const stopped = (p.trade > 0 && humanStops(view, spec, p.owner, 'trade')) || (p.convoys > 0 && humanStops(view, spec, p.owner, 'transport'));
        const what: string[] = [];
        if (p.trade) what.push(t('naval.pv.trade', { n: p.trade, g: gold(p.tradeGoldH) }));
        if (p.convoys) what.push(t('naval.pv.convoys', { n: p.convoys, troops: formatNumber(Math.round(p.troops / 1000) * 1000) }));
        tbl.append(h('div', { class: `fu-blk-trow${stopped ? ' is-stopped' : ''}` },
          h('span', { class: 'fu-blk-chip', style: `background:${hexToCss(P?.color ?? 0x888888)}` }),
          h('b', null, nameOf(p.owner)), h('span', { class: `fu-blk-rel is-${rel}` }, t(`naval.rel.${rel}`)),
          h('span', { class: 'fu-blk-what' }, what.join(' · ')),
          h('span', { class: 'fu-blk-verdict' }, t(stopped ? 'naval.pv.stopped' : 'naval.pv.passes'))));
      }
      out.push(tbl);
    }
    // Gains.
    let tradeN = 0, tradeG = 0, convN = 0, troops = 0;
    const names: string[] = [];
    for (const p of passing) {
      let any = false;
      if (p.trade && humanStops(view, spec, p.owner, 'trade')) {
        tradeN += p.trade;
        tradeG += p.tradeGoldH;
        any = true;
      }
      if (p.convoys && humanStops(view, spec, p.owner, 'transport')) {
        convN += p.convoys;
        troops += p.troops;
        any = true;
      }
      if (any) names.push(nameOf(p.owner));
    }
    out.push(h('div', { class: 'fu-caps fu-blk-label' }, t('naval.pv.gains')));
    const gains = h('ul', { class: 'fu-civil-list' });
    if (!tradeN && !convN) gains.append(li(spec.who === 'war' && !view.playerList.some((p) => p.alive && view.pairState(HUMAN_ID, p.id) === 'war') ? 'naval.pv.noWar' : 'naval.pv.nothingNow'));
    if (tradeN) gains.append(li(spec.action === 'seize' ? 'naval.pv.cut.seize' : 'naval.pv.cut.sink', { g: gold(tradeG), n: tradeN, names: names.join(', ') }));
    if (convN) gains.append(li(spec.action === 'seize' ? 'naval.pv.troops.seize' : 'naval.pv.troops.sink', { n: convN, troops: formatNumber(Math.round(troops / 1000) * 1000) }));
    gains.append(li('naval.pv.detour', { km: formatNumber(Math.round(BLOCKADE_RADIUS_KM)) }, 'is-dim'));
    out.push(gains);
    // Costs.
    out.push(h('div', { class: 'fu-caps fu-blk-label' }, t('naval.pv.costs')));
    const costs = h('ul', { class: 'fu-civil-list' });
    const pir = piracyNations();
    const peaceNames = view.playerList.filter((p) => p.alive && p.kind === 'nation' && p.id !== HUMAN_ID && view.pairState(HUMAN_ID, p.id) !== 'war');
    const anyPeace = spec.who === 'all' || (spec.who === 'embargo' && (view.human?.embargoes.length ?? 0) > 0) || (spec.who === 'list' && (spec.nations ?? []).some((n) => view.pairState(HUMAN_ID, n) !== 'war'));
    if (!pir.length && !anyPeace) costs.append(li('naval.pv.clean', {}, 'is-good'));
    else {
      const per = spec.action === 'sink' ? PIRACY_OPINION.sink : PIRACY_OPINION.seize;
      costs.append(li('naval.pv.piracy', { v: Math.abs(per), vc: Math.abs(spec.action === 'sink' ? PIRACY_OPINION.sinkTroops : PIRACY_OPINION.turnBack), va: Math.abs(PIRACY_OPINION.ally), days: Math.round(CASUS_BELLI_TICKS / TICKS_PER_GAME_DAY) }, 'is-bad'));
      let allies = 0, trade = 0;
      for (const id of pir) {
        const p = passing.find((x) => x.owner === id)!;
        const k = (humanStops(view, spec, id, 'trade') ? p.trade : 0) + (humanStops(view, spec, id, 'transport') ? p.convoys : 0);
        const op = view.opinions.get(id)?.score ?? 0;
        const after = Math.max(-100, op + per * k);
        const risk = after <= PIRACY_WAR_OPINION ? 'high' : after <= PIRACY_EMBARGO_OPINION ? 'mid' : 'low';
        costs.append(li('naval.pv.nation', { name: nameOf(id), n: k, op: Math.round(op), after: Math.round(after), risk: t(`naval.risk.${risk}`) }, `is-risk-${risk}`));
        allies += (view.players[id]?.allies ?? []).filter((a) => a !== HUMAN_ID).length;
        trade += tradeWith(view, id);
      }
      if (spec.who === 'all' && !pir.length) costs.append(li('naval.pv.allLater', { n: peaceNames.length }, 'is-bad'));
      if (pir.length) costs.append(li('naval.pv.angered', { n: pir.length, allies }, 'is-bad'));
      if (pir.length) costs.append(li('naval.pv.retaliation', { g: gold(trade) }, 'is-bad'));
    }
    const own = ownShipsThrough(view, zone.x, zone.y);
    if (own) costs.append(li('naval.pv.ownThrough', { n: own }, 'is-dim'));
    out.push(costs);
    return out;
  }

  // ---- modal ------------------------------------------------------------------------------------------------------
  const go = h('button', { class: 'fu-btn fu-btn--primary' }, tx('naval.go')) as HTMLButtonElement;
  const cancel = h('button', { class: 'fu-btn' }, tx('common.cancel'));
  tip(go, () => ({ title: t('naval.go'), text: t('w7.blockade.go.tip', { n: ids.length, place }) }));
  tip(cancel, () => ({ title: t('common.cancel'), text: t('dialog.cancel.tip') }));
  const m = openModal({
    titleKey: 'naval.dlg.title', titleParams: { place }, kickerKey: 'naval.dlg.kicker', narrow: false, className: 'fu-blk-dialog',
    body: [
      h('p', { class: 'fu-blk-intro' }, t('naval.dlg.intro', { n: ids.length, place, km: formatNumber(Math.round(BLOCKADE_RADIUS_KM)) })),
      row(t('naval.dlg.who'), whoSeg.el, whoNote), list,
      row(t('naval.dlg.ships'), shipsSeg.el),
      row(t('naval.dlg.action'), actSeg.el, actNote),
      preview,
    ],
    foot: [cancel, go],
    onClose: () => {
      probe = null;
    },
  });
  const send = () => {
    const s: BlockadeSpec = spec.who === 'list' ? { ...spec, nations: [...(spec.nations ?? [])] } : { who: spec.who, ships: spec.ships, action: spec.action };
    hs.ctx.sim.send({ type: 'unitOrder', unitIds: ids, order: 'blockade', tile, targetId: 0, blockade: s });
    hs.sound('confirm');
    m.close();
  };
  go.addEventListener('click', send);
  cancel.addEventListener('click', () => m.close());
  probe = {
    spec, place, passing, piracy: [],
    text: () => m.el.textContent ?? '',
    set: (s) => {
      Object.assign(spec, s);
      paint();
    },
    confirm: send,
    cancel: () => m.close(),
  };
  paint();
}
