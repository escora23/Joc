// FRONT ULTRA — unit and structure cards, bottom-right (DESIGN_V2 §7.6; owner: ui, rebuilt by W4).
//
// UNIT CARD: name with its ordinal, type and owner, the one-line purpose, state and ETA, integrity (with what it means),
// speed in km/h with its real-time equivalent (aircraft: mission and cruise speeds), reach, the effect it produces now
// («+25 % de potencia en el Frente de Lyon»), for divisions the endurance («≈ 20 días de combate»), order buttons and
// TOMAR EL MANDO. No max-HP «FUERZA» number, no cruise speed passed off as the map speed (C04).
// GROUP CARD (several units): the mix by type, «clic derecho para ordenar a todas», Mantener and Volver for all.
// STRUCTURE CARD: name, level pips, purpose, «Ahora» and «Nivel N» effects in numbers (gold per hour for Ports,
// Factories and Cities), the upgrade cost (= upgradeCost) and time with the exact reason when it cannot be paid («Te
// faltan 42.000 de oro»), hosted units with select buttons, production with the live price and time, demolish.
// NATION CARD: unchanged from W3.

import { h, setStyle, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon, STRUCTURE_ICON, UNIT_ICON } from '../icons';
import { tip } from '../tooltip';
import { tx } from '../tx';
import { attackNation, breakAlliance, donate, focusNation, nationRelation, requestAlliance, toggleEmbargo } from './diplomacy';
import {
  effectLine, enduranceLine, etaText, goldPerHour, homeName, hostedUnits, integrityHelp, levelEffects, maxLevel, placeOf,
  offensiveName, outlookOf, reachLine, speedLine, speedRealLine, stateLine, stationOrder, structId, structureName, structurePurpose, unitId, unitName,
} from './forcesInfo';
import { selectedUnitIds } from './orderCtl';
import { kmhText, offensiveKmh } from './frontsInfo';
import { DAMAGE_IDS, LEVEL_LOSS_HP, REPAIR_PER_HOUR, damageState, functionFactor, repairCost, repairHours } from '../../shared/damage';
import { offensiveOutlook, tileKm } from '../../shared/orders';
import type { HudShared } from './shared';
import { HUMAN_ID, STRUCTURE_DEFS, UNIT_DEFS, WEAPONS, structureLevel, upgradeCost, upgradeTicks } from '../../shared/constants';
import { hexToCss } from '../../shared/color';
import { tileXYToLatLon } from '../../shared/geo';
import { formatCompact, formatNumber, t } from '../../shared/i18n';
import {
  StructureType, UnitMode, UnitState, UnitType, type AttackView, type BuildableUnit, type StructureView, type UnitOrderKind, type UnitView, type WeaponType,
} from '../../shared/types';

export interface SelectionPanel {
  el: HTMLElement;
  refresh(): void;
  /** Force a rebuild on the next refresh (language change). */
  invalidate(): void;
  takeControl(): void;
}

const PRODUCES: Partial<Record<StructureType, BuildableUnit[]>> = {
  [StructureType.ArmyBase]: [UnitType.ArmoredDivision],
  [StructureType.Airbase]: [UnitType.FighterSquadron, UnitType.Bomber, UnitType.DroneSwarm],
  [StructureType.NavalYard]: [UnitType.Warship],
};
const HOSTS = new Set<StructureType>([StructureType.ArmyBase, StructureType.Airbase, StructureType.NavalYard]);

/** Card buttons that put the next left click into order mode (touchpads, §7.2), per unit type. */
const CARD_ORDERS: Partial<Record<UnitType, UnitOrderKind[]>> = {
  [UnitType.ArmoredDivision]: ['move', 'defend', 'attack', 'assault'],
  [UnitType.Warship]: ['move', 'patrol', 'blockade', 'bombard'],
  [UnitType.FighterSquadron]: ['cap'],
  [UnitType.Bomber]: ['strike'],
  [UnitType.DroneSwarm]: ['support', 'strike'],
};
const ORDER_ICON: Partial<Record<UnitOrderKind, string>> = {
  move: 'move', attack: 'attack', patrol: 'patrol', blockade: 'shield', bombard: 'target', cap: 'patrol', strike: 'target', support: 'bolt',
  defend: 'shield', assault: 'target', join: 'attack',
};

interface Why { gold: boolean; text: string }

export function createSelectionPanel(hs: HudShared): SelectionPanel {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  const el = h('div', { class: 'fu-sel fu-glass fu-brackets fu-interactive fu-hidden' });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  let builtFor = '';
  let live: Record<string, HTMLElement> = {};
  const sigs: Record<string, string> = {};

  const close = () => {
    hs.sound('close');
    hs.select({ kind: 'none' });
    if (hs.mode.kind === 'order') hs.setMode({ kind: 'none' });
  };

  const header = (ico: Element, title: string, sub: string, color: number, extra?: HTMLElement) => {
    const closeBtn = h('button', { class: 'fu-close' }, icon('close'));
    closeBtn.addEventListener('click', close);
    tip(closeBtn, () => ({ title: t('common.close'), hotkey: 'Esc' }));
    return h('div', { class: 'fu-sel-head', style: `--oc:${hexToCss(color)}` },
      h('div', { class: 'fu-sel-ico' }, ico),
      h('div', { class: 'fu-sel-titles' }, h('div', { class: 'fu-sel-title' }, title), h('div', { class: 'fu-sel-sub' }, sub), extra ?? null),
      closeBtn,
    );
  };
  const meter = (key: string, labelKey: string, cls = '', help?: () => string) => {
    const fill = h('i');
    const val = h('span', { class: 'fu-mono' });
    live[key] = fill;
    live[`${key}Val`] = val;
    const m = h('div', { class: `fu-sel-meter ${cls}` }, h('div', { class: 'fu-sel-meter-top' }, tx(labelKey, undefined, 'span'), val), h('div', { class: 'fu-sel-bar' }, fill));
    if (help) tip(m, () => ({ title: t(labelKey), text: help() }));
    live[`${key}Box`] = m;
    return m;
  };
  const line = (key: string, labelKey: string, cls = '') => {
    const v = h('span', { class: 'fu-w4-val' });
    live[key] = v;
    return h('div', { class: `fu-w4-line ${cls}` }, tx(labelKey, undefined, 'small'), v);
  };
  const actionBtn = (ico: string, labelKey: string, fn: () => void, cls = '', params?: Record<string, string | number>) => {
    const b = h('button', { class: `fu-btn fu-btn--sm ${cls}` }, icon(ico), tx(labelKey, params));
    b.addEventListener('click', () => fn());
    b.addEventListener('mouseenter', () => hs.sound('hover'));
    return b;
  };
  const pips = (level: number, max: number) => {
    const p = h('span', { class: 'fu-w4-pips' });
    if (max > 3) p.append(h('b', { class: 'fu-mono' }, t('card.levelN', { n: level, max })));
    else for (let i = 1; i <= max; i++) p.append(h('i', { class: i <= level ? 'is-on' : '' }));
    return p;
  };

  function sendOrder(ids: number[], order: UnitOrderKind): void {
    if (!ids.length) return;
    ctx.sim.send({ type: 'unitOrder', unitIds: ids, order, tile: -1, targetId: 0 });
    hs.sound('confirm');
  }

  // =================================================================================================
  // Unit card
  // =================================================================================================
  function buildUnit(u: UnitView): void {
    const def = UNIT_DEFS[u.type];
    const own = u.owner === HUMAN_ID;
    const p = view().players[u.owner];
    const children: (HTMLElement | null)[] = [
      header(icon(UNIT_ICON[u.type]), u.serial > 0 ? unitName(u) : t(`unit.${def.id}`), `${t(`unit.${def.id}`)} · ${own ? t('hud.sel.yours') : hs.name(u.owner)}`, p?.color ?? 0x888888),
      h('p', { class: 'fu-sel-desc fu-w4-role' }, t(def.roleKey)),
    ];
    const state = h('div', { class: 'fu-w4-state' });
    live.state = state;
    children.push(state);
    children.push(meter('hp', 'card.integrity', '', () => integrityHelp(u.type)));
    const onRail = u.mode === UnitMode.Rail;
    const speedVal = h('span', null, speedLine(u.type, onRail));
    const speedReal = h('em', null, speedRealLine(u.type, onRail));
    live.speedVal = speedVal;
    live.speedReal = speedReal;
    const speed = h('div', { class: 'fu-w4-line' }, tx('card.speed', undefined, 'small'), h('span', { class: 'fu-w4-val' }, speedVal, speedReal));
    tip(speed, () => ({ title: t('card.speed'), text: t(def.airborne ? 'card.speed.air.tip' : u.type === UnitType.ArmoredDivision ? 'card.speed.div.tip' : 'card.speed.tip') }));
    children.push(h('div', { class: 'fu-w4-lines' },
      speed,
      h('div', { class: 'fu-w4-line' }, tx('card.reach', undefined, 'small'), h('span', { class: 'fu-w4-val' }, reachLine(u.type))),
      line('effect', 'card.effect', 'is-effect'),
      u.type === UnitType.ArmoredDivision ? line('endurance', 'card.enduranceLabel') : null,
      line('place', 'card.where'),
    ));
    if (own && def.command) {
      const tc = h('button', { class: 'fu-take-control' },
        h('span', { class: 'fu-tc-glow' }),
        icon('takeControl'),
        h('span', { class: 'fu-tc-text' }, tx('hud.takeControl'), tx(`hud.takeControl.${def.command}`, undefined, 'small')),
        h('span', { class: 'fu-kbd' }, 'T'),
      );
      tc.addEventListener('click', () => takeControl());
      tc.addEventListener('mouseenter', () => hs.sound('hover'));
      tip(tc, () => ({ title: t('hud.takeControl'), text: t('card.takeControl.tip'), hotkey: 'T' }));
      live.tc = tc;
      children.push(tc);
    }
    if (own && u.type !== UnitType.TransportShip) {
      const acts = h('div', { class: 'fu-sel-actions fu-w4-orders' });
      for (const o of CARD_ORDERS[u.type] ?? []) {
        const b = actionBtn(ORDER_ICON[o] ?? 'target', `order.${o}`, () => {
          hs.sound('click');
          const m = hs.mode;
          hs.setMode(m.kind === 'order' && m.order === o ? { kind: 'none' } : { kind: 'order', unitId: u.id, order: o });
        });
        b.dataset.order = o;
        tip(b, () => ({ title: t(`order.${o}`), text: t(`order.${o}.tip`), lines: [t('card.orderButton.tip')] }));
        acts.append(b);
      }
      if (u.type === UnitType.ArmoredDivision) {
        // Feedback 3 (#28): one click joins our nearest running offensive (the button says which, and what it adds).
        const join = actionBtn('attack', 'order.join', () => {
          const a = nearestOwnOffensive(u);
          if (!a) {
            hs.sound('error');
            return;
          }
          ctx.sim.send({ type: 'unitOrder', unitIds: [u.id], order: 'join', tile: -1, targetId: a.id });
          hs.sound('confirm');
        });
        tip(join, () => {
          const cur = view().units.get(u.id) ?? u;
          const a = nearestOwnOffensive(cur);
          if (!a) return { title: t('order.join'), text: t('order.join.tip'), whyNot: t('order.err.joinNone') };
          const now = offensiveKmh(view(), a), next = offensiveOutlook(outlookOf(a, now), { divisions: 1 });
          const km = tileKm(cur.x, cur.y, a.contactX >= 0 ? a.contactX : a.x, a.contactX >= 0 ? a.contactY : a.y);
          return {
            title: t('order.join'), text: t('order.join.tip'),
            now: [[t('card.join.target'), offensiveName(hs, a)], [t('card.join.eta'), etaText(hs, Math.round((km / UNIT_DEFS[cur.type].speedKmh) * 10))]],
            nextKey: 'tip.next.join', next: [[t('fr.send.join.power'), `×${formatNumber(next.armorMul, 2)}`], [t('fr.send.join.kmh'), `${kmhText(now)} → ≈ ${kmhText(next.kmh)} km/h`]],
            lines: [t('fr.send.join.risk', { wear: formatNumber(0.2, 1) })],
          };
        });
        live.join = join;
        acts.append(join);
        const hold = actionBtn('shield', 'order.hold', () => sendOrder([u.id], 'hold'));
        tip(hold, () => ({ title: t('order.hold'), text: t('order.hold.tip') }));
        acts.append(hold);
      }
      const back = actionBtn('home', 'order.return', () => sendOrder([u.id], 'return'));
      tip(back, () => ({ title: t('order.return'), text: t(`order.return.tip.${u.type === UnitType.ArmoredDivision ? 'land' : u.type === UnitType.Warship ? 'sea' : 'air'}`) }));
      live.back = back;
      acts.append(back);
      children.push(acts);
      children.push(h('div', { class: 'fu-sel-hint' }, icon('mouse'), tx('card.rightClick')));
    }
    children.push(h('div', { class: 'fu-sel-actions' }, actionBtn('globe', 'hud.sel.focus', () => focusUnit(u.id))));
    el.replaceChildren(...children.filter((c): c is HTMLElement => !!c));
  }

  /** Our running land offensive whose live contact is nearest to the unit (Feedback 3 «Unirse a la ofensiva»). */
  function nearestOwnOffensive(u: UnitView): AttackView | null {
    let best: AttackView | null = null, bd = Infinity;
    for (const a of view().attacks) {
      if (a.attacker !== HUMAN_ID || a.naval || a.defender <= 0 || a.state === 'retreating') continue;
      const d = tileKm(u.x, u.y, a.contactX >= 0 ? a.contactX : a.x, a.contactX >= 0 ? a.contactY : a.y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }

  function refreshUnit(u: UnitView): void {
    setText(live.state, stateLine(hs, u));
    setMeter('hp', u.hp, `${Math.round(u.hp * 100)} %`);
    if (live.speedVal) setText(live.speedVal, speedLine(u.type, u.mode === UnitMode.Rail));
    if (live.speedReal) setText(live.speedReal, speedRealLine(u.type, u.mode === UnitMode.Rail));
    if (live.effect) setText(live.effect, effectLine(hs, u));
    if (live.endurance) setText(live.endurance, enduranceLine(u));
    if (live.place) setText(live.place, placeOf(hs, u));
    if (live.tc) toggleClass(live.tc, 'is-disabled', u.state === UnitState.Controlled);
    if (live.join) toggleClass(live.join, 'is-disabled', !nearestOwnOffensive(u));
    if (live.back) toggleClass(live.back, 'is-disabled', (u.mode === UnitMode.Docked || u.mode === UnitMode.Rearming) && !stationOrder(u));
    const m = hs.mode;
    for (const b of el.querySelectorAll<HTMLElement>('[data-order]')) toggleClass(b, 'is-on', m.kind === 'order' && m.order === b.dataset.order);
  }

  // =================================================================================================
  // Group card (several own units)
  // =================================================================================================
  function buildGroup(ids: number[]): void {
    const v = view();
    const byType = new Map<UnitType, number>();
    for (const id of ids) {
      const u = v.units.get(id);
      if (u) byType.set(u.type, (byType.get(u.type) ?? 0) + 1);
    }
    const mix = h('div', { class: 'fu-w4-mix' });
    for (const [type, n] of byType) mix.append(h('span', { class: 'fu-w4-mixi' }, icon(UNIT_ICON[type]), h('b', { class: 'fu-mono' }, `${n}`), t(`unit.${unitId(type)}`)));
    const list = h('div', { class: 'fu-w4-hosted' });
    live.groupList = list;
    el.replaceChildren(
      header(icon('users'), t('card.group.title', { n: ids.length }), t('hud.sel.yours'), v.human?.color ?? 0x3fa9f5),
      mix,
      list,
      h('div', { class: 'fu-sel-actions' },
        actionBtn('shield', 'order.hold', () => sendOrder(ids.filter((id) => v.units.get(id)?.type === UnitType.ArmoredDivision), 'hold')),
        actionBtn('home', 'order.return', () => sendOrder(ids, 'return')),
      ),
      h('div', { class: 'fu-sel-hint' }, icon('mouse'), tx('card.group.hint')),
    );
  }

  function refreshGroup(ids: number[]): void {
    const v = view();
    const sig = ids.join(',');
    if (sigs.group === sig) {
      ids.forEach((id, i) => {
        const u = v.units.get(id);
        const small = live.groupList.children[i]?.querySelector('small');
        if (u && small) setText(small as HTMLElement, stateLine(hs, u));
      });
      return;
    }
    sigs.group = sig;
    live.groupList.replaceChildren(...ids.map((id) => {
      const u = v.units.get(id);
      if (!u) return h('div');
      const r = h('button', { class: 'fu-w4-hrow' }, icon(UNIT_ICON[u.type]), h('span', null, h('b', null, unitName(u)), h('small', null, stateLine(hs, u))), h('span', { class: 'fu-mono' }, `${Math.round(u.hp * 100)} %`));
      r.addEventListener('click', () => {
        hs.sound('click');
        hs.select({ kind: 'unit', id });
      });
      return r;
    }));
  }

  function focusUnit(id: number): void {
    const u = view().units.get(id);
    if (!u) return;
    hs.sound('click');
    const ll = tileXYToLatLon(u.x, u.y);
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 900, durationMs: 1200 });
  }

  // =================================================================================================
  // Structure card
  // =================================================================================================
  function structLive(s: StructureView): { tradeShips?: number; trains?: number; radar?: boolean } {
    const v = view();
    const out: { tradeShips?: number; trains?: number; radar?: boolean } = {};
    if (s.type === StructureType.Port || s.type === StructureType.Factory) {
      let n = 0;
      const want = s.type === StructureType.Port ? UnitType.TradeShip : UnitType.Train;
      for (const u of v.units.values()) if (u.type === want && u.home === s.id) n++;
      if (s.type === StructureType.Port) out.tradeShips = n;
      else out.trains = n;
    }
    if (s.type === StructureType.SamSite || s.type === StructureType.Airbase) {
      // Inside own radar coverage the ranges grow (§6.2).
      const sx = (s.tile % 1600) + 0.5, sy = Math.floor(s.tile / 1600) + 0.5;
      const cl = Math.cos((90 - (sy / 800) * 180) * Math.PI / 180);
      for (const r of v.structures.values()) {
        if (r.type !== StructureType.Radar || r.owner !== s.owner || r.built < 1) continue;
        const cov = structureLevel(r.type, r.level).coverageTiles ?? 0;
        let dx = Math.abs((r.tile % 1600) + 0.5 - sx);
        if (dx > 800) dx = 1600 - dx;
        const dy = Math.floor(r.tile / 1600) + 0.5 - sy;
        if ((dx * cl) ** 2 + dy * dy <= cov * cov) out.radar = true;
      }
    }
    return out;
  }

  function buildStructure(s: StructureView): void {
    const def = STRUCTURE_DEFS[s.type];
    const own = s.owner === HUMAN_ID;
    const p = view().players[s.owner];
    const max = maxLevel(s.type);
    const pipsBox = h('span');
    live.pips = pipsBox;
    const children: HTMLElement[] = [
      header(icon(STRUCTURE_ICON[s.type]), structureName(hs, s), `${t(`structure.${def.id}`)} · ${own ? t('hud.sel.yours') : hs.name(s.owner)}`, p?.color ?? 0x888888, pipsBox),
      h('p', { class: 'fu-sel-desc fu-w4-role' }, structurePurpose(s.type)),
      meter('build', 'hud.sel.build', 'is-amber'),
      meter('upg', 'card.upgrading', 'is-amber'),
      meter('hp', 'hud.sel.hp', '', () => t('card.structHp.tip')),
    ];
    // Feedback 3 (#27): damage state, the share of its effects it still delivers, who hit it, the repair.
    const dmg = h('div', { class: 'fu-w4-dmg' });
    live.dmg = dmg;
    tip(dmg, () => {
      const cur = view().structures.get(s.id);
      if (!cur) return null;
      const st = damageState(cur.hp);
      return { title: t(`card.dmg.${DAMAGE_IDS[st]}`), text: t('card.dmg.tip'), lines: [t('card.dmg.rule', { lv: LEVEL_LOSS_HP * 100 })] };
    });
    children.push(dmg);
    const gold = h('div', { class: 'fu-w4-gold' });
    live.gold = gold;
    children.push(gold);
    const now = h('div', { class: 'fu-w4-eff' });
    const next = h('div', { class: 'fu-w4-eff is-next' });
    live.now = now;
    live.next = next;
    children.push(now, next);
    if (own) {
      const rep = h('button', { class: 'fu-btn fu-btn--sm fu-w4-repair' }, icon('upgrade'), h('span')) as HTMLButtonElement;
      rep.addEventListener('click', () => {
        const cur = view().structures.get(s.id);
        if (!cur || rep.classList.contains('is-disabled')) {
          hs.sound('error');
          return;
        }
        ctx.sim.send({ type: 'repairStructure', structureId: s.id });
        hs.sound('build');
      });
      tip(rep, () => {
        const cur = view().structures.get(s.id);
        if (!cur) return null;
        return {
          title: t('card.repair.title'), text: t('card.repair.tip', { p: Math.round(REPAIR_PER_HOUR * 100) }), cost: formatNumber(repairCost(cur.type, cur.level, cur.hp)),
          now: [[t('card.repair.time'), etaText(hs, Math.round(repairHours(cur.hp) * 10))]], whyNot: repairWhy(cur),
        };
      });
      live.repair = rep;
      children.push(h('div', { class: 'fu-sel-actions' }, rep));
    }
    if (own && max > 1) {
      const up = h('button', { class: 'fu-btn fu-btn--sm fu-btn--success fu-w4-up' }, icon('upgrade'), h('span'));
      up.addEventListener('click', () => {
        if (up.classList.contains('is-disabled')) {
          hs.sound('error');
          return;
        }
        ctx.sim.send({ type: 'upgrade', structureId: s.id });
        hs.sound('build');
      });
      tip(up, () => {
        const cur = view().structures.get(s.id);
        if (!cur) return null;
        const nl = Math.min(max, cur.level + 1);
        return {
          title: t('card.upgrade.title', { n: nl }), text: t('card.upgrade.tip'), cost: formatNumber(upgradeCost(cur.type, cur.level)),
          now: [[t('card.upgrade.time'), etaText(hs, upgradeTicks(cur.type))]], next: levelEffects(cur.type, nl, structLive(cur)), whyNot: upgradeWhy(cur),
        };
      });
      live.upgrade = up;
      const why = h('div', { class: 'fu-w4-why' });
      live.upWhy = why;
      children.push(h('div', { class: 'fu-sel-actions' }, up), why);
    }
    if (HOSTS.has(s.type)) {
      const hosted = h('div', { class: 'fu-w4-hosted' });
      const hostedTitle = h('div', { class: 'fu-panel-title' });
      live.hosted = hosted;
      live.hostedTitle = hostedTitle;
      children.push(hostedTitle, hosted);
    }
    const prods = PRODUCES[s.type];
    if (own && prods) {
      const row = h('div', { class: 'fu-sel-prod' });
      for (const ut of prods) {
        const d = UNIT_DEFS[ut];
        const price = h('b', { class: 'fu-mono' });
        const time = h('small', { class: 'fu-mono' }, etaText(hs, d.productionTicks, false));
        const b = h('button', { class: 'fu-sel-prod-btn', 'data-unit': String(ut) }, icon(UNIT_ICON[ut]), h('span', null, t(`unit.${d.id}`)), price, time);
        live[`price${ut}`] = price;
        live[`prod${ut}`] = b;
        b.addEventListener('click', () => {
          const cur = view().structures.get(s.id);
          const why = cur ? prodWhy(cur, ut) : null;
          if (why) {
            hs.sound('error');
            return;
          }
          ctx.sim.send({ type: 'buildUnit', unit: ut, structureId: s.id });
          hs.sound('build');
        });
        tip(b, () => {
          const cur = view().structures.get(s.id);
          return {
            title: t(`unit.${d.id}`), text: t(d.roleKey), cost: formatNumber(view().unitCost(ut)),
            now: [[t('card.prodTime'), etaText(hs, d.productionTicks)], [t('card.speed'), speedLine(ut)], [t('card.reach'), reachLine(ut)]],
            whyNot: cur ? prodWhy(cur, ut)?.text ?? null : null,
          };
        });
        row.append(b);
      }
      const queue = h('div', { class: 'fu-w4-queue' });
      live.queue = queue;
      children.push(h('div', { class: 'fu-panel-title' }, tx('hud.sel.produce')), row, queue);
    }
    if (own && s.type === StructureType.MissileSilo) {
      const row = h('div', { class: 'fu-sel-prod' });
      for (const w of WEAPONS) {
        const d = UNIT_DEFS[w];
        const price = h('b', { class: 'fu-mono' });
        live[`price${w}`] = price;
        const b = h('button', { class: 'fu-sel-prod-btn is-weapon', 'data-weapon': String(w) }, icon(UNIT_ICON[w]), h('span', null, t(`unit.${d.id}`)), price);
        live[`w${w}`] = b;
        b.addEventListener('click', () => {
          if (b.classList.contains('is-disabled')) {
            hs.sound('error');
            return;
          }
          hs.sound('click');
          hs.setMode({ kind: 'target', weapon: w as WeaponType });
        });
        tip(b, () => {
          const cur = view().structures.get(s.id);
          const ok = cur ? (structureLevel(cur.type, cur.level).weapons ?? []).includes(w as WeaponType) : false;
          return { title: t(`unit.${d.id}`), text: t(d.roleKey), cost: formatNumber(view().unitCost(w)), whyNot: ok ? null : t('card.silo.needsLevel', { n: w === UnitType.Mirv ? 3 : 2 }) };
        });
        row.append(b);
      }
      children.push(h('div', { class: 'fu-panel-title' }, tx('hud.sel.launch')), row);
    }
    const acts = h('div', { class: 'fu-sel-actions' });
    if (own) {
      const dem = actionBtn('demolish', 'hud.sel.demolish', () => {
        ctx.sim.send({ type: 'demolish', structureId: s.id });
        hs.sound('cancel');
        hs.select({ kind: 'none' });
      }, 'fu-btn--danger');
      tip(dem, () => ({ title: t('hud.sel.demolish'), text: t('card.demolish.tip') }));
      acts.append(dem);
    }
    acts.append(actionBtn('globe', 'hud.sel.focus', () => {
      hs.sound('click');
      const ll = tileXYToLatLon((s.tile % 1600) + 0.5, Math.floor(s.tile / 1600) + 0.5);
      ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 700, durationMs: 1200 });
    }));
    children.push(acts);
    el.replaceChildren(...children);
  }

  function repairWhy(s: StructureView): string | null {
    if (s.built < 1) return t('card.upgrade.building');
    if (s.hp >= 0.999) return t('card.repair.none');
    if (s.repairing) return t('card.repair.busy');
    const cost = repairCost(s.type, s.level, s.hp);
    const gold = view().human?.gold ?? 0;
    if (gold < cost) return t('card.missingGold', { n: formatNumber(Math.ceil(cost - gold)) });
    return null;
  }

  function upgradeWhy(s: StructureView): string | null {
    const max = maxLevel(s.type);
    if (s.level >= max) return t('card.upgrade.max');
    if (s.built < 1) return t('card.upgrade.building');
    if ((s.upgrade ?? 0) > 0) return t('card.upgrade.busy');
    const cost = upgradeCost(s.type, s.level);
    const gold = view().human?.gold ?? 0;
    if (gold < cost) return t('card.missingGold', { n: formatNumber(Math.ceil(cost - gold)) });
    return null;
  }

  function prodWhy(s: StructureView, ut: BuildableUnit): Why | null {
    if (s.built < 1) return { gold: false, text: t('card.upgrade.building') };
    const cap = structureLevel(s.type, s.level).capacity ?? 0;
    const used = hostedCount(s);
    if (used >= cap) return { gold: false, text: t('card.baseFull', { n: used, cap }) };
    const cost = view().unitCost(ut);
    const gold = view().human?.gold ?? 0;
    if (gold < cost) return { gold: true, text: t('card.missingGold', { n: formatNumber(Math.ceil(cost - gold)) }) };
    return null;
  }

  function hostedCount(s: StructureView): number {
    let n = hostedUnits(hs, s).length;
    for (const q of view().production) if (q.structureId === s.id) n++;
    return n;
  }

  function refreshStructure(s: StructureView): void {
    const v = view();
    const max = maxLevel(s.type);
    const lvSig = `${s.level}:${max}`;
    if (sigs.pips !== lvSig) {
      sigs.pips = lvSig;
      live.pips.replaceChildren(pips(s.level, max));
    }
    setMeter('hp', s.hp, `${Math.round(s.hp * 100)} %`);
    {
      const st = damageState(s.hp);
      const parts = [t(`card.dmg.${DAMAGE_IDS[st]}`), t('card.dmg.fn', { p: Math.round(functionFactor(s.hp) * 100) })];
      if (s.repairing) parts.push(t('card.repairing', { eta: etaText(hs, Math.round(repairHours(s.hp) * 10), false) }));
      else if (s.hitBy && st > 0) parts.push(t('card.dmg.hitBy', { name: hs.name(s.hitBy) }));
      if (s.blockadedBy) parts.push(t('card.blockaded', { name: hs.name(s.blockadedBy) }));
      setText(live.dmg, parts.join(' · '));
      live.dmg.dataset.state = String(st);
      toggleClass(live.dmg, 'fu-hidden', s.built < 1);
      if (live.repair) {
        const why = repairWhy(s);
        setText(live.repair.lastElementChild as HTMLElement, s.repairing ? t('card.repair.busy') : s.hp >= 0.999 ? t('card.repair.none') : t('card.repair.btn', { cost: formatNumber(repairCost(s.type, s.level, s.hp)), h: formatNumber(repairHours(s.hp), 1) }));
        toggleClass(live.repair, 'is-disabled', !!why);
        toggleClass(live.repair, 'fu-hidden', s.hp >= 0.999 && !s.repairing);
      }
    }
    setMeter('build', s.built, s.built >= 1 ? t('hud.sel.operational') : `${Math.round(s.built * 100)} %`);
    toggleClass(live.buildBox, 'fu-hidden', s.built >= 1);
    const up = s.upgrade ?? 0;
    setMeter('upg', up, up > 0 ? t('card.upgradingTo', { n: s.level + 1, p: Math.round(up * 100) }) : '');
    toggleClass(live.upgBox, 'fu-hidden', !(up > 0));
    const lv = structLive(s);
    const full = goldPerHour(s.type, s.level);
    // Feedback 3: a damaged structure earns at its function; the card says so next to the intact figure.
    const fnNow = s.built >= 1 ? functionFactor(s.hp) : 1;
    const gph = Math.round(full * fnNow);
    const goldSig = `${gph}:${full}:${s.level}`;
    if (sigs.gold !== goldSig) {
      sigs.gold = goldSig;
      live.gold.replaceChildren(...(full > 0 ? [icon('gold'), h('b', { class: 'fu-mono' }, t('card.goldPerHour', { n: formatNumber(gph) })),
        h('small', null, fnNow < 1 ? t('card.dmg.goldOf', { full: formatNumber(full) }) : t(`card.gold.${structId(s.type)}`))] : []));
      toggleClass(live.gold, 'fu-hidden', full <= 0);
    }
    const effSig = `${s.level}:${JSON.stringify(lv)}:${fnNow}`;
    if (sigs.eff !== effSig) {
      sigs.eff = effSig;
      const rows = (list: [string, string][]) => list.map(([a, b]) => h('div', { class: 'fu-w4-er' }, h('span', null, a), h('b', { class: 'fu-mono' }, b)));
      live.now.replaceChildren(h('div', { class: 'fu-w4-eh' }, fnNow < 1 ? t('card.dmg.now', { n: s.level, p: Math.round(fnNow * 100) }) : t('card.now', { n: s.level })), ...rows(levelEffects(s.type, s.level, lv)));
      if (s.level < max) live.next.replaceChildren(h('div', { class: 'fu-w4-eh' }, t('card.nextLevel', { n: s.level + 1 })), ...rows(levelEffects(s.type, s.level + 1, { radar: lv.radar })));
      else live.next.replaceChildren(h('div', { class: 'fu-w4-eh' }, t('card.upgrade.maxShort')));
    }
    if (live.upgrade) {
      const why = upgradeWhy(s);
      const lbl = s.level >= max ? t('card.upgrade.maxShort') : t('card.upgrade.btn', { n: s.level + 1, cost: formatNumber(upgradeCost(s.type, s.level)), h: formatNumber(upgradeTicks(s.type) / 10, 1) });
      setText(live.upgrade.lastElementChild as HTMLElement, lbl);
      toggleClass(live.upgrade, 'is-disabled', !!why);
      setText(live.upWhy, why && s.level < max ? why : '');
    }
    if (live.hosted) {
      const hosted = hostedUnits(hs, s);
      const cap = structureLevel(s.type, s.level).capacity ?? 0;
      setText(live.hostedTitle, t('card.hosted', { n: hostedCount(s), cap }));
      const sig = hosted.map((u) => `${u.id}:${u.mode}`).join(',');
      if (sigs.hosted !== sig) {
        sigs.hosted = sig;
        live.hosted.replaceChildren(...(hosted.length ? hosted.map((u) => {
          const r = h('button', { class: 'fu-w4-hrow', 'data-unit': String(u.id) }, icon(UNIT_ICON[u.type]), h('span', null, h('b', null, unitName(u)), h('small', null, stateLine(hs, u))), h('span', { class: 'fu-mono' }, `${Math.round(u.hp * 100)} %`));
          r.addEventListener('click', (e) => {
            hs.sound('click');
            if (e.shiftKey) hs.select({ kind: 'units', ids: [...selectedUnitIds(hs), u.id] });
            else hs.select({ kind: 'unit', id: u.id });
          });
          tip(r, () => ({ title: unitName(u), text: t('card.hosted.tip') }));
          return r;
        }) : [h('div', { class: 'fu-fo-empty' }, t('card.hosted.none'))]));
      }
    }
    const prods = PRODUCES[s.type];
    if (prods && live.queue) {
      for (const ut of prods) {
        setText(live[`price${ut}`], formatCompact(v.unitCost(ut)));
        const why = prodWhy(s, ut);
        toggleClass(live[`prod${ut}`], 'is-disabled', !!why && !why.gold);
        toggleClass(live[`prod${ut}`], 'is-poor', !!why && why.gold);
      }
      const q = v.production.filter((p) => p.structureId === s.id);
      const qSig = q.map((p) => `${p.unit}:${p.serial}`).join(',');
      if (sigs.queue !== qSig) {
        sigs.queue = qSig;
        live.queue.replaceChildren(...q.map((p) => h('div', { class: 'fu-w4-qrow' }, icon(UNIT_ICON[p.unit]), h('span', null, t(`unit.${unitId(p.unit)}`)), h('div', { class: 'fu-sel-bar' }, h('i')), h('span', { class: 'fu-mono' }))));
      }
      q.forEach((p, i) => {
        const r = live.queue.children[i] as HTMLElement | undefined;
        if (!r) return;
        const f = v.tick >= p.startTick ? Math.min(1, (v.tick - p.startTick) / Math.max(1, p.readyTick - p.startTick)) : 0;
        setStyle(r.querySelector('i') as HTMLElement, 'transform', `scaleX(${f.toFixed(3)})`);
        setText(r.lastElementChild as HTMLElement, etaText(hs, p.readyTick - v.tick, false));
      });
    }
    if (s.type === StructureType.MissileSilo && s.owner === HUMAN_ID) {
      for (const w of WEAPONS) {
        if (live[`price${w}`]) setText(live[`price${w}`], formatCompact(v.unitCost(w)));
        const ok = (structureLevel(s.type, s.level).weapons ?? []).includes(w as WeaponType);
        if (live[`w${w}`]) toggleClass(live[`w${w}`], 'is-disabled', !ok);
      }
    }
  }

  // =================================================================================================
  // Nation card (W3)
  // =================================================================================================
  const statCell = (key: string, labelKey: string) => {
    const v = h('b', { class: 'fu-mono' }, '—');
    live[key] = v;
    return h('div', { class: 'fu-sel-stat' }, tx(labelKey, undefined, 'small'), v);
  };
  function buildNation(id: number): void {
    const v = view();
    const p = v.players[id];
    if (!p) return;
    const rel = nationRelation(hs, id);
    const persona = p.personality ? t(`personality.${p.personality}`) : t(`kind.${p.kind}`);
    const children: HTMLElement[] = [
      header(flag(p.color, id, 'fu-flag'), hs.name(id), persona, p.color),
      h('div', { class: `fu-rel fu-rel--${rel}` }, tx(`rel.${rel}`)),
      h('div', { class: 'fu-sel-stats fu-sel-stats--4' },
        statCell('troops', 'hud.troops'), statCell('land', 'hud.territory'), statCell('gold', 'hud.gold'), statCell('alliesN', 'hud.sel.allies')),
    ];
    if (id !== HUMAN_ID) {
      const acts = h('div', { class: 'fu-sel-actions fu-sel-actions--grid' });
      acts.append(actionBtn('attack', 'dip.attack', () => attackNation(hs, id), 'fu-btn--danger'));
      if (rel === 'ally') acts.append(actionBtn('breakAlliance', 'dip.break', () => breakAlliance(hs, id), 'fu-btn--amber'));
      else if (p.kind === 'nation') acts.append(actionBtn('alliance', 'dip.alliance', () => requestAlliance(hs, id), 'fu-btn--success'));
      acts.append(actionBtn('embargo', rel === 'embargoed' ? 'dip.embargoOff' : 'dip.embargo', () => { toggleEmbargo(hs, id); builtFor = ''; }));
      if (rel === 'ally') acts.append(actionBtn('donate', 'dip.donateGold', () => donate(hs, id, 'gold', 0.25)));
      acts.append(actionBtn('globe', 'hud.sel.focus', () => { hs.sound('click'); focusNation(hs, id); }));
      children.push(acts);
    }
    el.replaceChildren(...children);
  }

  // =================================================================================================
  function takeControl(): void {
    const ids = selectedUnitIds(hs);
    let u = ids.length === 1 ? view().units.get(ids[0]) : undefined;
    // Nothing selected while watching a ground battle: T takes command of your division in that battle (the one
    // nearest the line you are looking at), so its soldiers and tanks are kept (owner feedback #21).
    if (!u && ids.length === 0) {
      const bv = ctx.battle.active ? ctx.battle.view?.() ?? null : null;
      let best = Infinity;
      for (const d of bv?.divisions ?? []) {
        const du = view().units.get(d.unitId);
        if (!du || du.owner !== HUMAN_ID || !UNIT_DEFS[du.type].command || d.km >= best) continue;
        best = d.km;
        u = du;
      }
    }
    if (!u || u.owner !== HUMAN_ID || !UNIT_DEFS[u.type].command) {
      hs.sound('error');
      return;
    }
    hs.sound('whoosh');
    hs.flags.commandEntered = true;
    hs.setMode({ kind: 'none' });
    void ctx.app.enterCommandMode(u.id);
  }

  function setMeter(k: string, v: number, text: string): void {
    if (!live[k]) return;
    setStyle(live[k], 'transform', `scaleX(${Math.max(0, Math.min(1, v)).toFixed(3)})`);
    setText(live[`${k}Val`], text);
    toggleClass(live[k], 'is-low', v < 0.3);
  }

  function refresh(): void {
    const sel = hs.selection;
    const v = view();
    let key = 'none';
    if (sel.kind === 'unit' && v.units.has(sel.id)) key = `u${sel.id}`;
    else if (sel.kind === 'units') {
      const ids = sel.ids.filter((id) => v.units.has(id));
      if (ids.length !== sel.ids.length) {
        hs.select({ kind: 'units', ids });
        return;
      }
      key = `g${ids.join(',')}`;
    } else if (sel.kind === 'structure' && v.structures.has(sel.id)) key = `s${sel.id}:${v.structures.get(sel.id)!.owner}`;
    else if (sel.kind === 'nation' && v.players[sel.id]?.alive) key = `n${sel.id}:${nationRelation(hs, sel.id)}`;
    if (key === 'none' && sel.kind !== 'none') {
      hs.select({ kind: 'none' });
      if (hs.mode.kind === 'order') hs.setMode({ kind: 'none' });
    }
    if (key !== builtFor) {
      builtFor = key;
      live = {};
      for (const k of Object.keys(sigs)) delete sigs[k];
      if (key === 'none') {
        el.classList.add('fu-hidden');
        return;
      }
      el.classList.remove('fu-hidden');
      el.classList.remove('is-in');
      void el.offsetWidth;
      el.classList.add('is-in');
      if (sel.kind === 'unit') buildUnit(v.units.get(sel.id)!);
      else if (sel.kind === 'units') buildGroup(sel.ids);
      else if (sel.kind === 'structure') buildStructure(v.structures.get(sel.id)!);
      else if (sel.kind === 'nation') buildNation(sel.id);
    }
    if (key === 'none') return;
    if (sel.kind === 'unit') refreshUnit(v.units.get(sel.id)!);
    else if (sel.kind === 'units') refreshGroup(sel.ids);
    else if (sel.kind === 'structure') refreshStructure(v.structures.get(sel.id)!);
    else if (sel.kind === 'nation') {
      const p = v.players[sel.id]!;
      const land = v.world?.landTiles ?? 1;
      if (live.troops) setText(live.troops, formatCompact(p.troops));
      if (live.land) setText(live.land, `${((p.tiles / land) * 100).toFixed(2)}%`);
      if (live.gold) setText(live.gold, formatCompact(p.gold));
      if (live.alliesN) setText(live.alliesN, String(p.allies.length));
    }
  }

  (window as unknown as { __fuCard?: unknown }).__fuCard = {
    text: () => el.innerText,
    hosted: () => [...el.querySelectorAll<HTMLElement>('.fu-w4-hrow')].map((r) => Number(r.dataset.unit)),
    clickHosted: (id: number) => el.querySelector<HTMLElement>(`.fu-w4-hrow[data-unit="${id}"]`)?.click(),
    home: (id: number) => {
      const u = view().units.get(id);
      return u ? homeName(hs, u) : '';
    },
    refresh,
  };

  return { el, refresh, takeControl, invalidate: () => (builtFor = '') };
}
