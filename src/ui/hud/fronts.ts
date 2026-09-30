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
import { etaText, frontName, offensiveName, outlookOf, unitName, placeOf } from './forcesInfo';
import {
  advanceText, combatDays, frontAnchor, frontFocus, frontTiles, humanFrontsByDanger, isoOf, kmhText, offensiveKmh, offensiveStatus, sidesOf,
  troopsText, worldFronts, type FrontSides,
} from './frontsInfo';
import type { HudShared } from './shared';
import { openPeaceDialog } from './wardialogs';
import { openOffensiveDialog } from './offensiveDialog';
import { hexToCss } from '../../shared/color';
import {
  AIR_DENIAL_ADVANCE_MUL, AIR_SUPERIORITY_ADVANCE_MUL, BOMBER_GARRISON_SHARE, CAP_RADIUS_TILES, DEFENSE_REDEPLOY_TICKS,
  DRONE_ADVANCE_MUL, FRONT_PRIORITY_WEIGHT, HUMAN_ID, MAP_H, MAP_W, TICKS_PER_GAME_DAY, TILE_KM, UNIT_DEFS,
} from '../../shared/constants';
import { tileXYToLatLon } from '../../shared/geo';
import { formatNumber, t } from '../../shared/i18n';
import { offensiveOutlook, orderCheck, tileKm } from '../../shared/orders';
import { airThreat, reasonText } from './orderCtl';
import { UNIT_ORDER_KINDS, UnitMode, UnitState, UnitType, type AttackView, type FrontView, type UnitView, type WarView } from '../../shared/types';
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
  intSeg?: HTMLElement;
  ownLine?: HTMLElement;
  ownBox?: HTMLElement;
  retreat: HTMLButtonElement | null;
  send: HTMLButtonElement | null;
  sendList: HTMLElement | null;
  sendPaintMs: number;
  /** v2 (#25): the sky over the front, and the «Apoyo aéreo» list of own aircraft to send there. */
  air?: HTMLElement;
  airBtn?: HTMLButtonElement;
  airList?: HTMLElement;
  airPaintMs?: number;
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
  const airExpanded = new Set<number>();

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
    // On the front's line (where the ground battle stands when the player then zooms in).
    const p = frontFocus(view(), f);
    const ll = tileXYToLatLon(p.x, p.y);
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: alt, durationMs: 1300 });
  }
  /**
   * Where a division sent to this front joins it (the sim's 'attach': enemy land right at the contact, within
   * DIVISION_ATTACH_TILES of ours): beside our offensive's live contact when we have one there (it supports that
   * offensive), else facing the middle of the line outwards; the first enemy tile 0.6-1.5 tiles past the contact edge.
   * -1 when no stretch of the front faces enemy land.
   */
  function attachTile(f: FrontView, enemy: number): number {
    const v = view();
    const s = enemy === f.b ? 1 : -1;
    const pick = (x0: number, y0: number, dx: number, dy: number): number => {
      for (const depth of [0.6, 1, 1.5]) {
        const x = (((x0 + dx * depth) % MAP_W) + MAP_W) % MAP_W;
        const y = Math.max(0, Math.min(MAP_H - 1, y0 + dy * depth));
        const t0 = Math.floor(y) * MAP_W + Math.floor(x);
        if (v.owner[t0] === enemy) return t0;
      }
      return -1;
    };
    const mine = ownOffensive(sidesOf(v, f));
    if (mine && mine.contactX >= 0) {
      let dx = mine.x - mine.contactX, dy = mine.y - mine.contactY;
      if (dx > MAP_W / 2) dx -= MAP_W;
      else if (dx < -MAP_W / 2) dx += MAP_W;
      const l = Math.hypot(dx, dy);
      const t0 = l > 0.3 ? pick(mine.contactX, mine.contactY, dx / l, dy / l) : pick(mine.contactX, mine.contactY, f.dirX * s, f.dirY * s);
      if (t0 >= 0) return t0;
    }
    const n = f.samples.length >> 1;
    const mid = Math.floor(n / 2);
    for (let k = 0; k < n; k++) {
      const i = mid + (k % 2 ? 1 : -1) * Math.ceil(k / 2);
      if (i < 0 || i >= n) continue;
      // Side a's samples are its contact tiles: the contact edge is half a tile along dir from them.
      const ex = f.samples[i * 2] + f.dirX * 0.5, ey = f.samples[i * 2 + 1] + f.dirY * 0.5;
      const t0 = pick(ex, ey, f.dirX * s, f.dirY * s);
      if (t0 >= 0) return t0;
    }
    return -1;
  }
  /**
   * The axis point of an offensive from this front: enemy land 2-3 tiles past the contact, found from the middle of the
   * line outwards (-1 when no stretch of the front faces enemy land, the reason shown on the button).
   */
  function attackTile(f: FrontView, enemy: number): number {
    const v = view();
    const n = f.samples.length >> 1;
    const s = enemy === f.b ? 1 : -1;
    const mid = Math.floor(n / 2);
    for (let k = 0; k < n; k++) {
      const i = mid + (k % 2 ? 1 : -1) * Math.ceil(k / 2);
      if (i < 0 || i >= n) continue;
      for (const depth of [3, 2, 1.2]) {
        const x = (((f.samples[i * 2] + f.dirX * (0.5 + depth * s)) % MAP_W) + MAP_W) % MAP_W;
        const y = Math.max(0, Math.min(MAP_H - 1, f.samples[i * 2 + 1] + f.dirY * (0.5 + depth * s)));
        const t0 = Math.floor(y) * MAP_W + Math.floor(x);
        if (v.owner[t0] === enemy) return t0;
      }
    }
    return -1;
  }
  const humanSide = (f: FrontView) => (f.a === HUMAN_ID ? 0 : f.b === HUMAN_ID ? 1 : -1);
  function ownOffensive(s: FrontSides) {
    if (s.offA && s.offA.attacker === HUMAN_ID) return s.offA;
    if (s.offB && s.offB.attacker === HUMAN_ID) return s.offB;
    return null;
  }

  /** Feedback 3 (#28): « · apoyo: 2 divisiones (+50 % de potencia), 1 enjambre, 1 buque» (empty with no support). */
  function supportText(a: AttackView): string {
    const parts: string[] = [];
    const d = a.divAtk ?? 0, c = a.casAtk ?? 0, n = a.navalAtk ?? 0;
    if (d) parts.push(t('fr.support.div', { n: d, pct: Math.round((Math.min(2, 1 + 0.25 * d) - 1) * 100) }));
    if (c) parts.push(t('fr.support.cas', { n: c }));
    if (n) parts.push(t('fr.support.naval', { n }));
    return parts.length ? ` · ${t('fr.support', { list: parts.join(', ') })}` : ` · ${t('fr.support.none')}`;
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
  /** A point (continuous tile coords) within `tiles` of a front's contact line. */
  function nearFront(f: FrontView, x: number, y: number, tiles: number): boolean {
    if (x < 0) return false;
    for (let k = 0; k < f.samples.length; k += 2) {
      let dx = f.samples[k] + f.dirX * 0.5 - x;
      if (dx > MAP_W / 2) dx -= MAP_W;
      if (dx < -MAP_W / 2) dx += MAP_W;
      const dy = f.samples[k + 1] + f.dirY * 0.5 - y;
      if (dx * dx + dy * dy <= tiles * tiles) return true;
    }
    return false;
  }
  type SendCandidate = { u: UnitView; hours: number; why: string | null; onWay: boolean };
  function candidates(f: FrontView): SendCandidate[] {
    const v = view();
    const r = viewRules(v);
    const enemy = f.a === HUMAN_ID ? f.b : f.a;
    const tile = attachTile(f, enemy);
    if (tile < 0) return [];
    const out: SendCandidate[] = [];
    const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
    const attach = UNIT_ORDER_KINDS.indexOf('attach'), join = UNIT_ORDER_KINDS.indexOf('join');
    // Feedback 3 (#28): with our offensive on this front the division JOINS it (follows its spearhead, its power adds to
    // the offensive and the row shows the km/h it would bring); else it attaches to hold the line.
    const mine = ownOffensive(sidesOf(v, f));
    const order = mine ? 'join' : 'attach';
    for (const u of v.units.values()) {
      if (u.owner !== HUMAN_ID || u.type !== UnitType.ArmoredDivision || u.state === UnitState.Destroyed) continue;
      if (u.frontKey === f.key && !(mine && u.order !== join)) continue;
      if (mine && u.order === join && u.mission === mine.id && u.mode === UnitMode.Offensive) continue;
      const km = tileKm(u.x, u.y, tx0, ty0);
      // Already ordered to this front (an attach aimed within 3 tiles of its line): listed «En camino», not offered again.
      const onWay = (u.order === attach && nearFront(f, u.targetX, u.targetY, 3)) || (!!mine && u.order === join && u.mission === mine.id);
      const issue = onWay ? null : orderCheck(r, u.id, order, tile, mine ? mine.id : 0);
      out.push({ u, hours: km / UNIT_DEFS[u.type].speedKmh, why: onWay ? t('fr.send.onWayWhy') : issue && !issue.confirm ? reasonText(hs, issue) : null, onWay });
    }
    const rank = (c: SendCandidate): number => (!c.why ? 0 : c.onWay ? 1 : 2);
    return out.sort((p, q) => rank(p) - rank(q) || p.hours - q.hours || p.u.id - q.u.id).slice(0, 6);
  }
  /**
   * The list of divisions to send. Rebuilt only when the set of divisions (or whether each may go) changes; otherwise
   * each row's ETA and button are updated in place, so a row never changes under the pointer while the player clicks.
   */
  function paintSendList(row: FrontRow, f: FrontView): void {
    const listEl = row.sendList;
    if (!listEl) return;
    const list = candidates(f);
    // (The language is part of it: a switch re-labels the buttons.)
    const sig = `${t('fr.send.go')}|${ownOffensive(sidesOf(view(), f))?.id ?? 0}|` + (list.map((c) => `${c.u.id}:${c.onWay ? 2 : c.why ? 1 : 0}`).join(',') || 'none');
    if (listEl.dataset.sig === sig) {
      for (const c of list) {
        const el = listEl.querySelector<HTMLElement>(`.fu-war-send[data-unit="${c.u.id}"]`);
        const eta = el?.querySelector<HTMLElement>('.fu-war-send-eta');
        if (eta) setText(eta, etaText(hs, Math.round(c.hours * 10), false));
      }
      return;
    }
    listEl.dataset.sig = sig;
    listEl.replaceChildren();
    if (!list.length) {
      listEl.append(h('div', { class: 'fu-war-note' }, t('fr.send.none')));
      return;
    }
    for (const c of list) {
      const ownOff = ownOffensive(sidesOf(view(), f));
      const btn = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, icon('armoredDivision'), t(c.onWay ? 'fr.send.onWay' : ownOff ? 'fr.send.join' : 'fr.send.go')) as HTMLButtonElement;
      btn.disabled = !!c.why;
      const unitId = c.u.id;
      const current = (): SendCandidate | undefined => {
        const ff = view().frontByKey.get(f.key);
        return ff ? candidates(ff).find((q) => q.u.id === unitId) : undefined;
      };
      tip(btn, () => {
        const q = current() ?? c;
        const ff = view().frontByKey.get(f.key);
        const own = ff ? ownOffensive(sidesOf(view(), ff)) : null;
        if (own) {
          // Feedback 3 (#28): the preview of joining: its power and the km/h the offensive would reach.
          const now = offensiveKmh(view(), own), next = offensiveOutlook(outlookOf(own), { divisions: 1 });
          return {
            title: unitName(q.u), text: t('fr.send.join.tip', { off: offensiveName(hs, own) }),
            now: [[t('fr.send.eta'), etaText(hs, Math.round(q.hours * 10))], [t('fr.send.integrity'), `${Math.round(q.u.hp * 100)} %`]],
            next: [[t('fr.send.join.power'), `×${formatNumber(next.armorMul, 2)}`], [t('fr.send.join.kmh'), `${kmhText(now)} → ≈ ${kmhText(next.kmh)} km/h`]],
            lines: [t('fr.send.join.risk', { wear: formatNumber(0.2, 1) })], whyNot: q.why,
          };
        }
        return { title: unitName(q.u), text: t('fr.send.tip'), now: [[t('fr.send.eta'), etaText(hs, Math.round(q.hours * 10))], [t('fr.send.integrity'), `${Math.round(q.u.hp * 100)} %`]], whyNot: q.why };
      });
      btn.addEventListener('click', () => {
        const ff = view().frontByKey.get(f.key);
        const q = current();
        if (!ff || !q) return;
        const tile = attachTile(ff, ff.a === HUMAN_ID ? ff.b : ff.a);
        if (tile < 0 || q.why) {
          hs.sound('error');
          return;
        }
        const own = ownOffensive(sidesOf(view(), ff));
        ctx.sim.send({ type: 'unitOrder', unitIds: [unitId], order: own ? 'join' : 'attach', tile, targetId: own ? own.id : 0 });
        hs.sound('confirm');
        ctx.bus.emit('toast', { text: t(own ? 'fr.send.joinDone' : 'fr.send.done', { unit: unitName(q.u), front: frontName(hs, f.key), eta: etaText(hs, Math.round(q.hours * 10), false) }), kind: 'info', durationMs: 3200 });
        expanded.delete(f.key);
        listKey = '';
      });
      const item = h('div', { class: 'fu-war-send' },
        h('div', { class: 'fu-war-send-name' }, h('b', null, unitName(c.u)), h('span', null, placeOf(hs, c.u))),
        h('span', { class: 'fu-mono fu-war-send-eta' }, etaText(hs, Math.round(c.hours * 10), false)),
        btn);
      item.dataset.unit = String(unitId);
      listEl.append(item);
    }
  }

  // ---- aircraft to send (owner item #25) --------------------------------------------------------------
  /** «Cielo: …» — who patrols over this front, who owns the sky and what it does, the drones in support. */
  function airLine(f: FrontView, hsd: number): string {
    const own = (hsd === 0 ? f.airA : f.airB) ?? 0, their = (hsd === 0 ? f.airB : f.airA) ?? 0;
    const cOwn = (hsd === 0 ? f.casA : f.casB) ?? 0, cTheir = (hsd === 0 ? f.casB : f.casA) ?? 0;
    const enemy = hsd === 0 ? f.b : f.a;
    const sky = own > their ? t('fr.air.skyOwn', { pct: Math.round((AIR_SUPERIORITY_ADVANCE_MUL - 1) * 100) })
      : their > own ? t('fr.air.skyTheir', { enemy: hs.name(enemy), pct: Math.round((1 - AIR_DENIAL_ADVANCE_MUL) * 100) })
      : own > 0 ? t('fr.air.skyContested') : t('fr.air.skyNone');
    let line = t('fr.air', { own, their, sky });
    if (cOwn + cTheir > 0) line += ` · ${t('fr.air.cas', { own: cOwn, their: cTheir, pct: Math.round((DRONE_ADVANCE_MUL - 1) * 100) })}`;
    return line;
  }
  type AirCandidate = { u: UnitView; order: 'cap' | 'support' | 'strike'; hours: number; why: string | null; onWay: boolean };
  function airCandidates(f: FrontView): AirCandidate[] {
    const v = view();
    const r = viewRules(v);
    const enemy = f.a === HUMAN_ID ? f.b : f.a;
    const tile = attachTile(f, enemy);
    if (tile < 0) return [];
    const tx0 = (tile % MAP_W) + 0.5, ty0 = Math.floor(tile / MAP_W) + 0.5;
    const out: AirCandidate[] = [];
    for (const u of v.units.values()) {
      if (u.owner !== HUMAN_ID || u.state === UnitState.Destroyed) continue;
      const order = u.type === UnitType.FighterSquadron ? 'cap' : u.type === UnitType.DroneSwarm ? 'support' : u.type === UnitType.Bomber ? 'strike' : null;
      if (!order) continue;
      const base = v.structures.get(u.home);
      const docked = u.mode === UnitMode.Docked || u.mode === UnitMode.Rearming;
      const fx = docked && base ? (base.tile % MAP_W) + 0.5 : u.x, fy = docked && base ? Math.floor(base.tile / MAP_W) + 0.5 : u.y;
      const km = tileKm(fx, fy, tx0, ty0);
      const onWay = u.order === UNIT_ORDER_KINDS.indexOf(order) && nearFront(f, u.targetX, u.targetY, order === 'cap' ? CAP_RADIUS_TILES : 3);
      const issue = onWay ? null : orderCheck(r, u.id, order, tile, 0);
      out.push({ u, order, hours: km / UNIT_DEFS[u.type].speedKmh, why: onWay ? t('fr.airsend.onWayWhy') : issue && !issue.confirm ? reasonText(hs, issue) : null, onWay });
    }
    const rank = (c: AirCandidate): number => (!c.why ? 0 : c.onWay ? 1 : 2);
    return out.sort((p, q) => rank(p) - rank(q) || p.hours - q.hours || p.u.id - q.u.id).slice(0, 8);
  }
  function airEffect(order: 'cap' | 'support' | 'strike'): string {
    return order === 'cap' ? t('fr.airsend.cap.tip', { pct: Math.round((AIR_SUPERIORITY_ADVANCE_MUL - 1) * 100), km: formatNumber(Math.round(CAP_RADIUS_TILES * TILE_KM / 10) * 10) })
      : order === 'support' ? t('fr.airsend.support.tip', { pct: Math.round((DRONE_ADVANCE_MUL - 1) * 100) })
      : t('fr.airsend.strike.tip', { pct: Math.round(BOMBER_GARRISON_SHARE * 100) });
  }
  function paintAirList(row: FrontRow, f: FrontView): void {
    const listEl = row.airList;
    if (!listEl) return;
    const list = airCandidates(f);
    const sig = `${t('fr.airsend.cap')}|` + (list.map((c) => `${c.u.id}:${c.onWay ? 2 : c.why ? 1 : 0}`).join(',') || 'none');
    if (listEl.dataset.sig === sig) {
      for (const c of list) {
        const eta = listEl.querySelector<HTMLElement>(`.fu-war-send[data-unit="${c.u.id}"] .fu-war-send-eta`);
        if (eta) setText(eta, etaText(hs, Math.round(c.hours * 10), false));
      }
      return;
    }
    listEl.dataset.sig = sig;
    listEl.replaceChildren();
    if (!list.length) {
      listEl.append(h('div', { class: 'fu-war-note' }, t('fr.airsend.none')));
      return;
    }
    for (const c of list) {
      const btn = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, t(c.onWay ? 'fr.send.onWay' : `fr.airsend.${c.order}`)) as HTMLButtonElement;
      btn.disabled = !!c.why;
      const unitId = c.u.id, order = c.order;
      const current = (): AirCandidate | undefined => {
        const ff = view().frontByKey.get(f.key);
        return ff ? airCandidates(ff).find((q) => q.u.id === unitId) : undefined;
      };
      tip(btn, () => {
        const q = current() ?? c;
        const enemy = f.a === HUMAN_ID ? f.b : f.a;
        const tile = attachTile(f, enemy);
        const th = tile >= 0 ? airThreat(hs, (tile % MAP_W) + 0.5, Math.floor(tile / MAP_W) + 0.5, HUMAN_ID) : { sams: 0, fighters: 0, bases: 0 };
        return {
          title: `${unitName(q.u)} · ${t(`fr.airsend.${order}`)}`, text: airEffect(order),
          now: [[t('fr.send.eta'), etaText(hs, Math.round(q.hours * 10))], [t('fr.send.integrity'), `${Math.round(q.u.hp * 100)} %`],
            [t('fr.airsend.threat'), t('fr.airsend.threatV', { sams: th.sams, fighters: th.fighters, bases: th.bases })]],
          whyNot: q.why,
        };
      });
      btn.addEventListener('click', () => {
        const ff = view().frontByKey.get(f.key);
        const q = current();
        if (!ff || !q) return;
        const tile = attachTile(ff, ff.a === HUMAN_ID ? ff.b : ff.a);
        if (tile < 0 || q.why) {
          hs.sound('error');
          return;
        }
        ctx.sim.send({ type: 'unitOrder', unitIds: [unitId], order, tile, targetId: 0 });
        hs.sound('confirm');
        ctx.bus.emit('toast', { text: t(`fr.airsend.done.${order}`, { unit: unitName(q.u), front: frontName(hs, f.key), eta: etaText(hs, Math.round(q.hours * 10), false) }), kind: 'info', durationMs: 3600 });
        // The list stays open (several aircraft are often sent at once); the row now reads «En camino».
        listEl.dataset.sig = '';
        row.airPaintMs = 0;
      });
      const item = h('div', { class: 'fu-war-send' },
        h('div', { class: 'fu-war-send-name' }, h('b', null, unitName(c.u)), h('span', null, t(`fr.airsend.what.${c.order}`))),
        h('span', { class: 'fu-mono fu-war-send-eta' }, etaText(hs, Math.round(c.hours * 10), false)),
        btn);
      item.dataset.unit = String(unitId);
      listEl.append(item);
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
        const s = sidesOf(view(), ff);
        const mine = ownOffensive(s);
        // Our offensive keeps its axis; a new one aims 2-3 tiles into enemy land facing the middle of the front.
        const tile = mine ? Math.floor(mine.y) * MAP_W + ((Math.floor(mine.x) % MAP_W) + MAP_W) % MAP_W : attackTile(ff, enemy);
        if (tile < 0) {
          hs.sound('error');
          ctx.bus.emit('toast', { text: t('fr.offensive.none', { name: hs.name(enemy) }), kind: 'warning', durationMs: 3200 });
          return;
        }
        hs.sound('click');
        openOffensiveDialog(hs, enemy, tile);
      });
      tip(counter, () => {
        const ff = view().frontByKey.get(key);
        const s = ff ? sidesOf(view(), ff) : null;
        const mine = s ? ownOffensive(s) : null;
        const enemy = ff ? (ff.a === HUMAN_ID ? ff.b : ff.a) : 0;
        const why = ff && !mine && attackTile(ff, enemy) < 0 ? t('fr.offensive.none', { name: hs.name(enemy) }) : null;
        return { title: t(mine ? 'fr.offensive.manage' : 'fr.offensive'), text: t(mine ? 'fr.offensive.manage.tip' : 'fr.offensive.tip'), lines: [t('fr.counter.line')], whyNot: why };
      });
      // Intensity of our offensive here (#23): hold the line (halt) / sustained / all-out assault, one click each.
      const intSeg = h('div', { class: 'fu-seg fu-war-int' });
      for (const lv of [0, 1, 2] as const) {
        const b = h('button', null, tx(`off.int.${lv}`)) as HTMLButtonElement;
        b.dataset.int = String(lv);
        b.addEventListener('click', () => {
          const ff = view().frontByKey.get(key);
          const s = ff ? sidesOf(view(), ff) : null;
          const mine = s ? ownOffensive(s) : null;
          if (!mine) {
            hs.sound('error');
            return;
          }
          ctx.sim.send({ type: 'offensiveIntensity', attackId: mine.id, intensity: lv });
          hs.sound('confirm');
        });
        tip(b, () => ({ title: t(`off.int.${lv}`), text: t(`off.int.${lv}.tip`) }));
        intSeg.append(b);
      }
      row.intSeg = intSeg;
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
      row.ownLine = h('div', { class: 'fu-war-line fu-war-own' });
      row.ownBox = h('div', { class: 'fu-war-ownbox fu-hidden' }, row.ownLine, row.intSeg!);
      row.counter = counter;
      row.retreat = retreat;
      row.send = send;
      row.sendList = h('div', { class: 'fu-war-sendlist fu-hidden' });
      const airBtn = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost fu-war-airbtn' }, icon('fighterSquadron'), tx('fr.airsend')) as HTMLButtonElement;
      airBtn.addEventListener('click', () => {
        hs.sound('click');
        if (airExpanded.has(key)) airExpanded.delete(key);
        else airExpanded.add(key);
        const ff = view().frontByKey.get(key);
        toggleClass(row.airList!, 'fu-hidden', !airExpanded.has(key));
        if (ff && airExpanded.has(key)) paintAirList(row, ff);
      });
      tip(airBtn, () => ({ title: t('fr.airsend'), text: t('fr.airsend.help') }));
      actions.insertBefore(airBtn, counter);
      row.airBtn = airBtn;
      row.airList = h('div', { class: 'fu-war-sendlist fu-war-airlist fu-hidden' });
      row.air = h('div', { class: 'fu-war-line fu-war-air' });
    }
    row.el = h('div', { class: 'fu-war-front' },
      h('div', { class: 'fu-war-fhead' }, name, age),
      h('div', { class: 'fu-war-tug' }, chipA, dir, chipB, h('div', { class: 'fu-fb-bar' }, barA, barB), adv),
      gar, redeploy, h('div', { class: 'fu-war-line' }, divs, tiles), ...(row.air ? [row.air] : []), ...(row.ownBox ? [row.ownBox] : []), actions,
      ...(row.sendList ? [row.sendList] : []), ...(row.airList ? [row.airList] : []),
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
      if (row.counter) setText(row.counter.querySelector('span')!, t(mine ? 'fr.offensive.manage' : 'fr.offensive'));
      if (row.retreat) toggleClass(row.retreat, 'fu-hidden', !mine);
      if (row.ownBox) {
        toggleClass(row.ownBox, 'fu-hidden', !mine);
        if (mine) {
          // Feedback 3 (29a): the same status and km/h as the front row, the badge and the strip.
          setText(row.ownLine!, t('fr.own', {
            troops: troopsText(mine.troops), intensity: t(`off.int.${mine.intensity}`), ratio: formatNumber(mine.ratio, 1),
            state: offensiveStatus(v, mine, offensiveKmh(v, mine), 1, false),
          }) + supportText(mine));
          for (const b of row.intSeg!.querySelectorAll<HTMLButtonElement>('button')) {
            toggleClass(b, 'is-on', Number(b.dataset.int) === mine.intensity);
            b.disabled = mine.state === 'retreating';
          }
        }
      }
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
    if (row.air && hsd >= 0) setText(row.air, airLine(f, hsd));
    if (row.airList && airExpanded.has(f.key) && performance.now() - (row.airPaintMs ?? 0) > 2000) {
      row.airPaintMs = performance.now();
      paintAirList(row, f);
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
          if (airExpanded.has(f.key) && r.airList) {
            toggleClass(r.airList, 'fu-hidden', false);
            paintAirList(r, f);
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
