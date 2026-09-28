// FRONT ULTRA — the Guerra y frentes panel, `G` (DESIGN_V2 §11.3; owner: ui, W6).
//
// Everything the player needs to run a war, in one drawer:
//   * GUERRAS: each war of the human with the enemy, who declared it, its goal and stated reason, the day count, the
//     escalation level of both sides (L0-L4), the war score and both sides' exhaustion; «Proponer paz» opens W3's
//     terms dialog, «Pedir ayuda» sends a call to arms to every ally not yet fighting that enemy.
//   * FRENTES of each war, sorted by danger (fronts where we lose ground first, then fronts under attack, then by
//     distance to our capital): the garrison of BOTH sides (published for quiet fronts too, so during the enemy's
//     mobilization the player sees where the enemy masses and where our troops stand), the redeployment in progress
//     («reforzando: 62 % → 80 % en 4 h»), the tug of war and momentum, the MEASURED km/h, tiles won and lost, the
//     divisions attached per side and the time since it opened. Buttons: Ir (fly there), Prioridad baja / normal /
//     alta (setFrontPriority: alta concentrates twice the troops per km there, arriving over ~6 h), Enviar divisiones
//     (our armored divisions with the time each needs to reach the front; one click attaches it), Contraofensiva (an
//     offensive from this front with the attack-force slider share; «Reforzar» when ours is already running),
//     Retirar (ends our offensive there: the troops come back in 2 h with a 10 % loss).
//   * MUNDO: the ten hottest fronts of the world, with the same reading and Ir.
// Opening it from a badge or an alert selects that front (bus 'frontSelected'). Debug hook: window.__fuFronts.

import { h, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { tip, type TipData } from '../tooltip';
import { tx } from '../tx';
import { askHelp, whyNotPropose } from './diplomacy';
import { etaText, frontName, unitName, placeOf } from './forcesInfo';
import {
  advanceText, combatDays, frontAnchor, frontTiles, humanFrontsByDanger, isoOf, sidesOf, troopsText, worldFronts,
  type FrontSides,
} from './frontsInfo';
import type { HudShared } from './shared';
import { openPeaceDialog } from './wardialogs';
import { hexToCss } from '../../shared/color';
import {
  DEFENSE_REDEPLOY_TICKS, FRONT_PRIORITY_WEIGHT, HUMAN_ID, MAP_H, MAP_W, TICKS_PER_GAME_DAY, UNIT_DEFS,
} from '../../shared/constants';
import { tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import { orderCheck, tileKm } from '../../shared/orders';
import { reasonText } from './orderCtl';
import { UnitState, UnitType, type FrontView, type UnitView, type WarView } from '../../shared/types';
import { viewRules } from '../../sim/rulesView';

export interface FrontsPanel {
  el: HTMLElement;
  readonly isOpen: boolean;
  open(key?: number): void;
  close(): void;
  toggle(): void;
  update(): void;
}

type Tab = 'mine' | 'world';

interface FrontRow {
  key: number;
  el: HTMLElement;
  name: HTMLElement;
  age: HTMLElement;
  chipA: HTMLElement;
  chipB: HTMLElement;
  dir: HTMLElement;
  barA: HTMLElement;
  barB: HTMLElement;
  adv: HTMLElement;
  gar: HTMLElement;
  redeploy: HTMLElement;
  tiles: HTMLElement;
  divs: HTMLElement;
  prio: HTMLButtonElement[];
  counter: HTMLButtonElement | null;
  retreat: HTMLButtonElement | null;
  send: HTMLButtonElement | null;
  sendList: HTMLElement | null;
  sendPaintMs: number;
}

interface WarCard {
  id: number;
  el: HTMLElement;
  day: HTMLElement;
  esc: HTMLElement;
  scoreBar: HTMLElement;
  scoreTxt: HTMLElement;
  exh: HTMLElement;
  help: HTMLButtonElement;
  fronts: HTMLElement;
  quietNote: HTMLElement;
}

const PRIO_LABEL = ['fr.prio.low', 'fr.prio.normal', 'fr.prio.high'];

export function createFrontsPanel(hs: HudShared): FrontsPanel {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  let isOpen = false;
  let tab: Tab = 'mine';
  let selected = 0;
  let listKey = '';
  const rows = new Map<number, FrontRow>();
  const wars = new Map<number, WarCard>();
  const expanded = new Set<number>();

  const closeBtn = h('button', { class: 'fu-close' }, icon('close'));
  closeBtn.addEventListener('click', () => close());
  tip(closeBtn, () => ({ title: t('common.close'), text: t('fr.close.tip'), hotkey: 'G / Esc' }));
  const tabBtns = new Map<Tab, HTMLElement>();
  const tabsEl = h('div', { class: 'fu-nt-tabs' });
  for (const tb of ['mine', 'world'] as Tab[]) {
    const b = h('button', { class: 'fu-nt-tab' }, tx(`fr.tab.${tb}`));
    b.addEventListener('click', () => {
      hs.sound('click');
      setTab(tb);
    });
    tip(b, () => ({ title: t(`fr.tab.${tb}`), text: t(`fr.tab.${tb}.tip`) }));
    tabBtns.set(tb, b);
    tabsEl.append(b);
  }
  const body = h('div', { class: 'fu-nt-body fu-war-body' });
  const intro = h('div', { class: 'fu-war-intro' }, tx('fr.intro'));
  const el = h('div', { class: 'fu-warpanel fu-glass fu-brackets fu-interactive fu-hidden' },
    h('div', { class: 'fu-nt-head' }, h('div', { class: 'fu-panel-title' }, icon('swords'), tx('fr.title')), h('span', { class: 'fu-kbd' }, 'G'), closeBtn),
    tabsEl, intro, body,
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  function setTab(tb: Tab): void {
    tab = tb;
    for (const [k, b] of tabBtns) toggleClass(b, 'is-on', k === tb);
    listKey = '';
    update();
  }
  setTab('mine');

  // ---- helpers ------------------------------------------------------------------------------------
  const enemyOf = (w: WarView): number => (w.aggressor === HUMAN_ID ? w.target : w.aggressor);
  const humanWars = (): WarView[] => view().wars.filter((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID);
  const pairOf = (f: FrontView, enemy: number) => (f.a === HUMAN_ID && f.b === enemy) || (f.b === HUMAN_ID && f.a === enemy);
  function fly(f: FrontView, alt = 900): void {
    const p = frontAnchor(f);
    const ll = tileXYToLatLon(p.x, p.y);
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: alt, durationMs: 1300 });
  }
  /** A tile `depth` tiles into `side`'s land from the middle of the front (the contact edge ± dir). */
  function tileInto(f: FrontView, side: number, depth: number): number {
    const p = frontAnchor(f);
    const s = side === f.b ? 1 : -1;
    const x = (((p.x + f.dirX * depth * s) % MAP_W) + MAP_W) % MAP_W;
    const y = Math.max(0, Math.min(MAP_H - 1, p.y + f.dirY * depth * s));
    return Math.floor(y) * MAP_W + Math.floor(x);
  }
  const humanSide = (f: FrontView) => (f.a === HUMAN_ID ? 0 : f.b === HUMAN_ID ? 1 : -1);
  function ownOffensive(s: FrontSides) {
    if (s.offA && s.offA.attacker === HUMAN_ID) return s.offA;
    if (s.offB && s.offB.attacker === HUMAN_ID) return s.offB;
    return null;
  }

  // ---- priority ----------------------------------------------------------------------------------
  /** The share this front would target if the human set it to `p` (the other fronts' weights unchanged). */
  function targetShareIf(f: FrontView, p: number): number {
    const hsd = humanSide(f);
    const cur = hsd === 0 ? f.priorityA : f.priorityB;
    const target = hsd === 0 ? f.targetShareA : f.targetShareB;
    const k = (FRONT_PRIORITY_WEIGHT[p] ?? 1) / (FRONT_PRIORITY_WEIGHT[cur] ?? 1);
    return target > 0 ? (target * k) / (1 - target + target * k) : 0;
  }
  function prioTip(key: number, p: number): TipData {
    const f = view().frontByKey.get(key);
    const title = t(PRIO_LABEL[p]);
    if (!f) return { title, text: t('fr.gone') };
    const hsd = humanSide(f);
    const share = hsd === 0 ? f.shareA : f.shareB, gar = hsd === 0 ? f.garrisonA : f.garrisonB;
    const cur = hsd === 0 ? f.priorityA : f.priorityB;
    const next = targetShareIf(f, p);
    const expect = share > 0.001 ? (gar * next) / share : gar;
    // With a single front the whole field army already stands there: priority only matters between fronts.
    const mine = view().fronts.filter((q) => q.b !== 0 && (q.a === HUMAN_ID || q.b === HUMAN_ID)).length;
    if (mine <= 1) {
      return {
        title: t('fr.prio.title', { level: title }), text: t(`fr.prio.${p}.tip`),
        now: [[t('fr.prio.now'), t(PRIO_LABEL[cur])], [t('fr.garrison.own'), formatNumber(Math.round(gar / 1000) * 1000)], [t('fr.share'), `${formatNumber(Math.round(share * 100))} %`]],
        lines: [t('fr.prio.single'), t('fr.prio.line')],
      };
    }
    return {
      title: t('fr.prio.title', { level: title }), text: t(`fr.prio.${p}.tip`),
      now: [[t('fr.prio.now'), t(PRIO_LABEL[cur])], [t('fr.garrison.own'), formatNumber(Math.round(gar / 1000) * 1000)], [t('fr.share'), `${formatNumber(Math.round(share * 100))} %`]],
      next: p === cur ? undefined : [[t('fr.share'), `${formatNumber(Math.round(next * 100))} %`], [t('fr.garrison.own'), `≈ ${formatNumber(Math.round(expect / 1000) * 1000)}`]],
      lines: [t('fr.prio.line')],
    };
  }
  function setPriority(key: number, p: number): void {
    const f = view().frontByKey.get(key);
    if (!f || humanSide(f) < 0) {
      hs.sound('error');
      return;
    }
    ctx.sim.send({ type: 'setFrontPriority', frontKey: key, priority: p as 0 | 1 | 2 });
    hs.sound('confirm');
    ctx.bus.emit('toast', { text: t('fr.prio.set', { front: frontName(hs, key), level: t(PRIO_LABEL[p]) }), kind: 'info', durationMs: 2600 });
  }

  // ---- divisions to send -----------------------------------------------------------------------------
  function candidates(f: FrontView): { u: UnitView; hours: number; why: string | null }[] {
    const v = view();
    const r = viewRules(v);
    const tile = tileInto(f, HUMAN_ID, 0.6);
    const out: { u: UnitView; hours: number; why: string | null }[] = [];
    const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
    for (const u of v.units.values()) {
      if (u.owner !== HUMAN_ID || u.type !== UnitType.ArmoredDivision || u.state === UnitState.Destroyed) continue;
      if (u.frontKey === f.key) continue;
      const km = tileKm(u.x, u.y, tx0, ty0);
      const issue = orderCheck(r, u.id, 'attach', tile, 0);
      out.push({ u, hours: km / UNIT_DEFS[u.type].speedKmh, why: issue && !issue.confirm ? reasonText(hs, issue) : null });
    }
    return out.sort((p, q) => (p.why ? 1 : 0) - (q.why ? 1 : 0) || p.hours - q.hours || p.u.id - q.u.id).slice(0, 6);
  }
  function paintSendList(row: FrontRow, f: FrontView): void {
    if (!row.sendList) return;
    const list = candidates(f);
    row.sendList.replaceChildren();
    if (!list.length) {
      row.sendList.append(h('div', { class: 'fu-war-note' }, t('fr.send.none')));
      return;
    }
    for (const c of list) {
      const btn = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, icon('armoredDivision'), t('fr.send.go')) as HTMLButtonElement;
      btn.disabled = !!c.why;
      tip(btn, () => ({ title: unitName(c.u), text: t('fr.send.tip'), now: [[t('fr.send.eta'), etaText(hs, Math.round(c.hours * 10))], [t('fr.send.integrity'), `${Math.round(c.u.hp * 100)} %`]], whyNot: c.why }));
      btn.addEventListener('click', () => {
        const ff = view().frontByKey.get(f.key);
        if (!ff) return;
        ctx.sim.send({ type: 'unitOrder', unitIds: [c.u.id], order: 'attach', tile: tileInto(ff, HUMAN_ID, 0.6), targetId: 0 });
        hs.sound('confirm');
        ctx.bus.emit('toast', { text: t('fr.send.done', { unit: unitName(c.u), front: frontName(hs, f.key), eta: etaText(hs, Math.round(c.hours * 10), false) }), kind: 'info', durationMs: 3200 });
        expanded.delete(f.key);
        listKey = '';
      });
      row.sendList.append(h('div', { class: 'fu-war-send' },
        h('div', { class: 'fu-war-send-name' }, h('b', null, unitName(c.u)), h('span', null, placeOf(hs, c.u))),
        h('span', { class: 'fu-mono fu-war-send-eta' }, etaText(hs, Math.round(c.hours * 10), false)),
        btn));
    }
  }

  // ---- rows ------------------------------------------------------------------------------------------
  function makeRow(f: FrontView, own: boolean): FrontRow {
    const name = h('div', { class: 'fu-war-fname' });
    const age = h('span', { class: 'fu-war-age fu-mono' });
    const chipA = h('span', { class: 'fu-fb-chip' }), chipB = h('span', { class: 'fu-fb-chip' });
    const dir = h('span', { class: 'fu-fb-dir' });
    const barA = h('i', { class: 'fu-fb-a' }), barB = h('i', { class: 'fu-fb-b' });
    const adv = h('span', { class: 'fu-war-adv fu-mono' });
    const gar = h('div', { class: 'fu-war-line' });
    const redeploy = h('div', { class: 'fu-war-line is-redeploy' });
    const tiles = h('span', { class: 'fu-war-tiles fu-mono' });
    const divs = h('div', { class: 'fu-war-line' });
    const key = f.key;
    const goBtn = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, icon('target'), tx('fr.go')) as HTMLButtonElement;
    goBtn.addEventListener('click', () => {
      const ff = view().frontByKey.get(key);
      if (!ff) return;
      hs.sound('whoosh');
      fly(ff);
    });
    tip(goBtn, () => ({ title: t('fr.go'), text: t('fr.go.tip') }));
    const row: FrontRow = { key, el: h('div'), name, age, chipA, chipB, dir, barA, barB, adv, gar, redeploy, tiles, divs, prio: [], counter: null, retreat: null, send: null, sendList: null, sendPaintMs: 0 };
    const actions = h('div', { class: 'fu-war-actions' }, goBtn);
    if (own) {
      const seg = h('div', { class: 'fu-seg fu-war-prio' });
      for (let p = 0; p < 3; p++) {
        const b = h('button', null, tx(PRIO_LABEL[p])) as HTMLButtonElement;
        b.dataset.prio = String(p);
        b.addEventListener('click', () => setPriority(key, p));
        tip(b, () => prioTip(key, p));
        seg.append(b);
        row.prio.push(b);
      }
      const send = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, icon('armoredDivision'), tx('fr.send')) as HTMLButtonElement;
      send.addEventListener('click', () => {
        hs.sound('click');
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        const ff = view().frontByKey.get(key);
        toggleClass(row.sendList!, 'fu-hidden', !expanded.has(key));
        if (ff && expanded.has(key)) paintSendList(row, ff);
      });
      tip(send, () => ({ title: t('fr.send'), text: t('fr.send.help') }));
      const counter = h('button', { class: 'fu-btn fu-btn--sm fu-btn--amber' }, icon('attack'), h('span')) as HTMLButtonElement;
      counter.addEventListener('click', () => {
        const ff = view().frontByKey.get(key);
        if (!ff) return;
        const enemy = ff.a === HUMAN_ID ? ff.b : ff.a;
        ctx.sim.send({ type: 'attack', target: enemy, ratio: hs.attackRatio, tile: tileInto(ff, enemy, 3) });
        hs.sound('confirm');
      });
      tip(counter, () => {
        const ff = view().frontByKey.get(key);
        const me = hs.human;
        const s = ff ? sidesOf(view(), ff) : null;
        const mine = s ? ownOffensive(s) : null;
        return {
          title: t(mine ? 'fr.reinforce' : 'fr.counter'), text: t(mine ? 'fr.reinforce.tip' : 'fr.counter.tip'),
          now: [[t('fr.counter.troops'), me ? troopsText(me.troops * hs.attackRatio) : '0'], [t('fr.counter.ratio'), `${Math.round(hs.attackRatio * 100)} %`]],
          lines: [t('fr.counter.line')],
        };
      });
      const retreat = h('button', { class: 'fu-btn fu-btn--sm fu-btn--danger' }, icon('exit'), tx('fr.retreat')) as HTMLButtonElement;
      retreat.addEventListener('click', () => {
        const ff = view().frontByKey.get(key);
        const s = ff ? sidesOf(view(), ff) : null;
        const mine = s ? ownOffensive(s) : null;
        if (!mine) {
          hs.sound('error');
          return;
        }
        ctx.sim.send({ type: 'retreat', attackId: mine.id });
        hs.sound('cancel');
      });
      tip(retreat, () => {
        const ff = view().frontByKey.get(key);
        const s = ff ? sidesOf(view(), ff) : null;
        const mine = s ? ownOffensive(s) : null;
        return { title: t('fr.retreat'), text: t('fr.retreat.tip'), now: mine ? [[t('fr.retreat.troops'), troopsText(mine.troops)], [t('fr.retreat.loss'), troopsText(mine.troops * 0.1)]] : undefined, whyNot: mine ? null : t('fr.retreat.none') };
      });
      actions.append(seg, send, counter, retreat);
      row.counter = counter;
      row.retreat = retreat;
      row.send = send;
      row.sendList = h('div', { class: 'fu-war-sendlist fu-hidden' });
    }
    row.el = h('div', { class: 'fu-war-front' },
      h('div', { class: 'fu-war-fhead' }, name, age),
      h('div', { class: 'fu-war-tug' }, chipA, dir, chipB, h('div', { class: 'fu-fb-bar' }, barA, barB), adv),
      gar, redeploy, h('div', { class: 'fu-war-line' }, divs, tiles), actions,
      ...(row.sendList ? [row.sendList] : []),
    );
    row.el.dataset.key = String(key);
    row.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      selected = key;
      for (const r of rows.values()) toggleClass(r.el, 'is-selected', r.key === key);
    });
    return row;
  }

  function paintRow(row: FrontRow, f: FrontView): void {
    const v = view();
    const s = sidesOf(v, f);
    setText(row.name, frontName(hs, f.key) || t('fr.front'));
    const days = combatDays(v, f);
    setText(row.age, days < 1 ? t('fr.age.hours', { n: formatNumber(Math.max(0, (v.tick - f.startTick) / 10), 0) }) : t('fr.age.days', { n: formatNumber(days, 1) }));
    const ca = v.players[s.att]?.color ?? 0x888888, cb = v.players[s.def]?.color ?? 0x888888;
    row.chipA.style.setProperty('--c', hexToCss(ca));
    row.chipB.style.setProperty('--c', hexToCss(cb));
    setText(row.chipA, isoOf(v, s.att));
    setText(row.chipB, isoOf(v, s.def));
    setText(row.dir, s.quiet ? '·' : s.gaining < 0 ? '◀' : s.gaining > 0 ? '▶' : '‖');
    row.barA.style.width = `${(s.share * 100).toFixed(1)}%`;
    row.barB.style.width = `${((1 - s.share) * 100).toFixed(1)}%`;
    row.barA.style.background = hexToCss(ca);
    row.barB.style.background = hexToCss(cb);
    setText(row.adv, advanceText(v, f, s));
    const hsd = humanSide(f);
    if (hsd >= 0) {
      const own = hsd === 0 ? f.garrisonA : f.garrisonB, their = hsd === 0 ? f.garrisonB : f.garrisonA;
      const enemy = hsd === 0 ? f.b : f.a;
      setText(row.gar, t('fr.garrisons', { own: troopsText(own), their: troopsText(their), enemy: hs.name(enemy) }));
      const share = hsd === 0 ? f.shareA : f.shareB, target = hsd === 0 ? f.targetShareA : f.targetShareB;
      const gap = target - share;
      if (Math.abs(gap) > 0.02) {
        // share moves 1/45 of the gap per tick: within 2 points after ln(|gap| / 0.02) × 45 ticks.
        const ticks = Math.log(Math.abs(gap) / 0.02) * DEFENSE_REDEPLOY_TICKS;
        setText(row.redeploy, t(gap > 0 ? 'fr.redeploy.up' : 'fr.redeploy.down', { from: formatNumber(Math.round(share * 100)), to: formatNumber(Math.round(target * 100)), eta: etaText(hs, Math.round(ticks), false) }));
        toggleClass(row.redeploy, 'fu-hidden', false);
      } else {
        setText(row.redeploy, t('fr.redeploy.steady', { share: formatNumber(Math.round(share * 100)) }));
        toggleClass(row.redeploy, 'fu-hidden', false);
      }
      const dOwn = hsd === 0 ? f.divisionsA : f.divisionsB, dTheir = hsd === 0 ? f.divisionsB : f.divisionsA;
      setText(row.divs, t('fr.divisions', { own: dOwn, their: dTheir }));
      const won = frontTiles(v, f, HUMAN_ID), lost = frontTiles(v, f, enemy);
      setText(row.tiles, t('fr.tiles', { won: formatNumber(won), lost: formatNumber(lost) }));
      const prio = hsd === 0 ? f.priorityA : f.priorityB;
      for (const b of row.prio) toggleClass(b, 'is-on', Number(b.dataset.prio) === prio);
      const mine = ownOffensive(s);
      if (row.counter) setText(row.counter.querySelector('span')!, t(mine ? 'fr.reinforce' : 'fr.counter'));
      if (row.retreat) toggleClass(row.retreat, 'fu-hidden', !mine);
    } else {
      setText(row.gar, t('fr.garrisons.world', { a: hs.name(s.att), ga: troopsText(s.garAtt), b: hs.name(s.def), gb: troopsText(s.garDef) }));
      toggleClass(row.redeploy, 'fu-hidden', true);
      setText(row.divs, t('fr.divisions.world', { a: s.divAtt, b: s.divDef }));
      setText(row.tiles, '');
    }
    toggleClass(row.el, 'is-quiet', s.quiet);
    toggleClass(row.el, 'is-losing', s.def === HUMAN_ID && s.gaining > 0);
    toggleClass(row.el, 'is-selected', f.key === selected);
    row.el.dataset.garOwn = String(hsd === 0 ? f.garrisonA : hsd === 1 ? f.garrisonB : 0);
    if (row.sendList && expanded.has(f.key) && performance.now() - row.sendPaintMs > 2000) {
      row.sendPaintMs = performance.now();
      paintSendList(row, f);
    }
  }

  // ---- war cards --------------------------------------------------------------------------------------
  function makeWar(w: WarView): WarCard {
    const enemy = enemyOf(w);
    const v = view();
    const color = v.players[enemy]?.color ?? 0x888888;
    const day = h('span', { class: 'fu-war-day fu-mono' });
    const esc = h('div', { class: 'fu-war-line fu-war-esc' });
    const scoreBar = h('i');
    const scoreTxt = h('span', { class: 'fu-mono' });
    const exh = h('div', { class: 'fu-war-line' });
    const peace = h('button', { class: 'fu-btn fu-btn--sm fu-btn--success' }, icon('alliance'), tx('fr.peace')) as HTMLButtonElement;
    peace.addEventListener('click', () => {
      hs.sound('click');
      openPeaceDialog(hs, enemy);
    });
    tip(peace, () => ({ title: t('fr.peace'), text: t('fr.peace.tip'), whyNot: whyNotPropose(hs, enemy, 'peace') }));
    const help = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, icon('users'), tx('fr.help')) as HTMLButtonElement;
    help.addEventListener('click', () => {
      const n = askHelp(hs, enemy);
      if (n > 0) ctx.bus.emit('toast', { text: t('fr.help.sent', { n, enemy: hs.name(enemy) }), kind: 'info', durationMs: 3000 });
    });
    tip(help, () => ({ title: t('fr.help'), text: t('fr.help.tip'), whyNot: helpWhy(enemy) }));
    const goal = w.aggressor === HUMAN_ID ? t('fr.war.declaredByUs') : t('fr.war.declaredOnUs', { name: hs.name(enemy) });
    const fronts = h('div', { class: 'fu-war-fronts' });
    const quietNote = h('div', { class: 'fu-war-note fu-hidden' }, tx('fr.noFront'));
    const el = h('div', { class: 'fu-war-card' },
      h('div', { class: 'fu-war-head' }, h('span', { class: 'fu-war-swatch', style: `background:${hexToCss(color)}` }), h('b', null, hs.name(enemy)), day),
      h('div', { class: 'fu-war-line' }, goal),
      h('div', { class: 'fu-war-line is-dim' }, t('fr.war.goal', { goal: t(`war.goal.${w.goal}`), reason: t(w.reasonKey) })),
      esc,
      h('div', { class: 'fu-war-score' }, h('span', null, tx('fr.score')), h('div', { class: 'fu-war-scorebar' }, scoreBar), scoreTxt),
      exh,
      h('div', { class: 'fu-war-actions' }, peace, help),
      fronts, quietNote,
    );
    tip(esc, () => ({ title: t('fr.esc.title'), text: t('fr.esc.tip'), lines: [0, 1, 2, 3, 4].map((l) => `L${l} · ${t(`escalation.short.${l}`)}`) }));
    el.dataset.war = String(w.id);
    return { id: w.id, el, day, esc, scoreBar, scoreTxt, exh, help, fronts, quietNote };
  }
  function helpWhy(enemy: number): string | null {
    const me = hs.human;
    if (!me || me.allies.length === 0) return t('fr.help.noAllies');
    return me.allies.some((a) => !whyNotPropose(hs, a, 'callToArms', 0, enemy)) ? null : t('fr.help.noneFree');
  }
  function paintWar(c: WarCard, w: WarView): void {
    const v = view();
    const weA = w.aggressor === HUMAN_ID;
    const days = Math.floor((v.tick - w.startTick) / TICKS_PER_GAME_DAY) + 1;
    const mob = v.tick < w.mobilizeUntilTick;
    setText(c.day, mob ? t('fr.war.mobilizing', { eta: etaText(hs, w.mobilizeUntilTick - v.tick, false) }) : t('fr.war.day', { n: days }));
    const ours = weA ? w.escalationA : w.escalationB, theirs = weA ? w.escalationB : w.escalationA;
    setText(c.esc, t('fr.esc', { ours: `L${ours}`, oursTxt: t(`escalation.short.${ours}`), theirs: `L${theirs}`, theirsTxt: t(`escalation.short.${theirs}`) }));
    const score = weA ? w.scoreA : -w.scoreA;
    c.scoreBar.style.left = score >= 0 ? '50%' : `${50 + score / 2}%`;
    c.scoreBar.style.width = `${Math.abs(score) / 2}%`;
    toggleClass(c.scoreBar, 'is-neg', score < 0);
    setText(c.scoreTxt, `${score > 0 ? '+' : ''}${Math.round(score)}`);
    const exO = weA ? w.exhaustionA : w.exhaustionB, exT = weA ? w.exhaustionB : w.exhaustionA;
    setText(c.exh, t('fr.exhaustion', { ours: formatNumber(Math.round(exO)), theirs: formatNumber(Math.round(exT)) }));
    c.help.disabled = !!helpWhy(enemyOf(w));
  }

  // ---- build / refresh -----------------------------------------------------------------------------------
  function rebuild(): void {
    const v = view();
    body.replaceChildren();
    rows.clear();
    wars.clear();
    if (tab === 'mine') {
      const ws = humanWars();
      if (!ws.length) {
        body.append(h('div', { class: 'fu-war-empty' }, h('b', null, t('fr.peaceTime')), h('span', null, t('fr.peaceTime.text'))));
        return;
      }
      const fronts = humanFrontsByDanger(v);
      // Wars in the order of their most dangerous front.
      const rank = (w: WarView) => {
        const i = fronts.findIndex((f) => pairOf(f, enemyOf(w)));
        return i < 0 ? 999 : i;
      };
      for (const w of [...ws].sort((p, q) => rank(p) - rank(q) || p.id - q.id)) {
        const c = makeWar(w);
        wars.set(w.id, c);
        body.append(c.el);
        const mine = fronts.filter((f) => pairOf(f, enemyOf(w)));
        toggleClass(c.quietNote, 'fu-hidden', mine.length > 0);
        for (const f of mine) {
          const r = makeRow(f, true);
          rows.set(f.key, r);
          c.fronts.append(r.el);
          if (expanded.has(f.key)) {
            toggleClass(r.sendList!, 'fu-hidden', false);
            paintSendList(r, f);
          }
        }
      }
    } else {
      for (const f of worldFronts(v)) {
        const r = makeRow(f, false);
        rows.set(f.key, r);
        body.append(r.el);
      }
      if (!rows.size) body.append(h('div', { class: 'fu-war-empty' }, h('b', null, t('fr.worldPeace'))));
    }
  }

  function currentKey(): string {
    const v = view();
    if (tab === 'mine') {
      const ws = humanWars().map((w) => w.id).join(',');
      const fs = humanFrontsByDanger(v).map((f) => f.key).join(',');
      return `m|${ws}|${fs}`;
    }
    return `w|${worldFronts(v).map((f) => f.key).join(',')}`;
  }

  /** Dock under the clock / speed widget and above the build bar, like the Fuerzas drawer (the speed stays clickable). */
  function dock(): void {
    const root = el.parentElement;
    if (!root) return;
    const tr = root.querySelector<HTMLElement>('.fu-hud-tr .fu-time')?.getBoundingClientRect();
    const top = tr && tr.height > 0 ? Math.round(tr.bottom + 8) : 14;
    if (el.style.top !== `${top}px`) el.style.top = `${top}px`;
    const bar = root.querySelector<HTMLElement>('.fu-hud-bottom-row')?.getBoundingClientRect();
    const bottom = bar && bar.height > 0 && bar.right > window.innerWidth - el.offsetWidth - 20 ? Math.round(window.innerHeight - bar.top + 10) : 14;
    if (el.style.bottom !== `${bottom}px`) el.style.bottom = `${bottom}px`;
  }

  function update(): void {
    if (!isOpen) return;
    dock();
    const v = view();
    const k = currentKey();
    if (k !== listKey) {
      listKey = k;
      rebuild();
    }
    for (const w of v.wars) {
      const c = wars.get(w.id);
      if (c) paintWar(c, w);
    }
    for (const [key, r] of rows) {
      const f = v.frontByKey.get(key);
      if (f) paintRow(r, f);
    }
  }

  function open(key?: number): void {
    if (key) {
      selected = key;
      const f = view().frontByKey.get(key);
      const mineF = !!f && (f.a === HUMAN_ID || f.b === HUMAN_ID);
      if ((tab === 'mine') !== mineF) setTab(mineF ? 'mine' : 'world');
    }
    if (!isOpen) {
      isOpen = true;
      el.classList.remove('fu-hidden');
      ctx.bus.emit('panelToggled', { panel: 'fronts', open: true });
    }
    listKey = '';
    update();
    if (key) rows.get(key)?.el.scrollIntoView({ block: 'nearest' });
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    el.classList.add('fu-hidden');
    ctx.bus.emit('panelToggled', { panel: 'fronts', open: false });
  }

  const api: FrontsPanel = {
    el,
    get isOpen() {
      return isOpen;
    },
    open,
    close,
    toggle() {
      if (isOpen) close();
      else open();
    },
    update,
  };
  try {
    (window as unknown as { __fuFronts?: unknown }).__fuFronts = {
      panel: api,
      rows: () => [...rows.keys()],
      wars: () => [...wars.keys()],
      text: () => el.textContent ?? '',
      selected: () => selected,
    };
  } catch {
    /* no window */
  }
  return api;
}
