// FRONT ULTRA — selection panel (owner: ui): contextual card for the selected unit, structure or nation with
// its live stats and actions. Armored divisions, warships and fighter squadrons get the big
// TOMAR EL CONTROL / TAKE CONTROL button (also the T key).

import { h, setStyle, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon, STRUCTURE_ICON, UNIT_ICON } from '../icons';
import { tx } from '../tx';
import { attackNation, breakAlliance, donate, focusNation, nationRelation, requestAlliance, toggleEmbargo } from './diplomacy';
import type { HudShared } from './shared';
import { HUMAN_ID, STRUCTURE_DEFS, UNIT_DEFS, WEAPONS } from '../../shared/constants';
import { hexToCss } from '../../shared/color';
import { tileXYToLatLon } from '../../shared/geo';
import { formatCompact, formatNumber, t } from '../../shared/i18n';
import { StructureType, UnitState, UnitType, type BuildableUnit, type StructureView, type UnitView, type WeaponType } from '../../shared/types';

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

export function createSelectionPanel(hs: HudShared): SelectionPanel {
  const ctx = hs.ctx;
  const el = h('div', { class: 'fu-sel fu-glass fu-brackets fu-interactive fu-hidden' });
  let builtFor = '';
  // Live fields patched by refresh()
  let live: Record<string, HTMLElement> = {};

  const close = () => {
    hs.sound('close');
    hs.select({ kind: 'none' });
    if (hs.mode.kind === 'order') hs.setMode({ kind: 'none' });
  };

  const header = (ico: SVGElement, title: string, sub: string, color: number) => {
    const closeBtn = h('button', { class: 'fu-close' }, icon('close'));
    closeBtn.addEventListener('click', close);
    return h('div', { class: 'fu-sel-head', style: `--oc:${hexToCss(color)}` },
      h('div', { class: 'fu-sel-ico' }, ico),
      h('div', { class: 'fu-sel-titles' }, h('div', { class: 'fu-sel-title' }, title), h('div', { class: 'fu-sel-sub' }, sub)),
      closeBtn,
    );
  };
  const meter = (key: string, cls = '') => {
    const fill = h('i');
    const val = h('span', { class: 'fu-mono' });
    live[key] = fill;
    live[`${key}Val`] = val;
    return h('div', { class: `fu-sel-meter ${cls}` }, h('div', { class: 'fu-sel-meter-top' }, tx(`hud.sel.${key}`, undefined, 'span'), val), h('div', { class: 'fu-sel-bar' }, fill));
  };
  const statCell = (key: string, labelKey: string) => {
    const v = h('b', { class: 'fu-mono' }, '—');
    live[key] = v;
    return h('div', { class: 'fu-sel-stat' }, tx(labelKey, undefined, 'small'), v);
  };
  const actionBtn = (ico: string, labelKey: string, fn: () => void, cls = '', params?: Record<string, string | number>) => {
    const b = h('button', { class: `fu-btn fu-btn--sm ${cls}` }, icon(ico), tx(labelKey, params));
    b.addEventListener('click', () => fn());
    b.addEventListener('mouseenter', () => hs.sound('hover'));
    return b;
  };

  // ---------------------------------------------------------------------------------------------
  function buildUnit(u: UnitView): void {
    const def = UNIT_DEFS[u.type];
    const own = u.owner === HUMAN_ID;
    const p = ctx.sim.view.players[u.owner];
    const children: HTMLElement[] = [
      header(icon(UNIT_ICON[u.type]), t(`unit.${def.id}`), own ? t('hud.sel.yours') : hs.name(u.owner), p?.color ?? 0x888888),
      meter('hp'),
      h('div', { class: 'fu-sel-stats' }, statCell('troops', 'hud.sel.strength'), statCell('state', 'hud.sel.status'), statCell('speed', 'hud.sel.speed')),
    ];
    if (own && def.command) {
      const tc = h('button', { class: 'fu-take-control' },
        h('span', { class: 'fu-tc-glow' }),
        icon('takeControl'),
        h('span', { class: 'fu-tc-text' }, tx('hud.takeControl'), tx(`hud.takeControl.${def.command}`, undefined, 'small')),
        h('span', { class: 'fu-kbd' }, 'T'),
      );
      tc.addEventListener('click', () => takeControl());
      tc.addEventListener('mouseenter', () => hs.sound('hover'));
      live.tc = tc;
      children.push(tc);
    }
    if (own && (u.type === UnitType.ArmoredDivision || u.type === UnitType.Warship || u.type === UnitType.FighterSquadron || u.type === UnitType.Bomber || u.type === UnitType.DroneSwarm)) {
      const orderKey = u.type === UnitType.ArmoredDivision ? 'hud.order.deploy' : u.type === UnitType.Warship ? 'hud.order.move' : 'hud.order.strike';
      const ob = actionBtn(u.type === UnitType.Warship ? 'move' : 'target', orderKey, () => {
        hs.sound('click');
        hs.setMode(hs.mode.kind === 'order' ? { kind: 'none' } : { kind: 'order', unitId: u.id });
      });
      live.order = ob;
      children.push(h('div', { class: 'fu-sel-actions' }, ob, actionBtn('globe', 'hud.sel.focus', () => focusUnit(u.id))));
      children.push(h('div', { class: 'fu-sel-hint' }, icon('mouse'), tx(`${orderKey}.hint`)));
    } else {
      children.push(h('div', { class: 'fu-sel-actions' }, actionBtn('globe', 'hud.sel.focus', () => focusUnit(u.id))));
    }
    el.replaceChildren(...children);
  }

  function focusUnit(id: number): void {
    const u = ctx.sim.view.units.get(id);
    if (!u) return;
    hs.sound('click');
    const ll = tileXYToLatLon(u.x, u.y);
    ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 900, durationMs: 1200 });
  }

  // ---------------------------------------------------------------------------------------------
  function buildStructure(s: StructureView): void {
    const def = STRUCTURE_DEFS[s.type];
    const own = s.owner === HUMAN_ID;
    const p = ctx.sim.view.players[s.owner];
    const children: HTMLElement[] = [
      header(icon(STRUCTURE_ICON[s.type]), t(`structure.${def.id}`), own ? t('hud.sel.yours') : hs.name(s.owner), p?.color ?? 0x888888),
      meter('hp'),
      meter('build', 'is-amber'),
      h('div', { class: 'fu-sel-stats' }, statCell('level', 'hud.sel.level'), statCell('cooldown', 'hud.sel.ready')),
      h('p', { class: 'fu-sel-desc' }, t(`structure.${def.id}.desc`)),
    ];
    if (own) {
      const acts = h('div', { class: 'fu-sel-actions' });
      if (def.maxLevel > 1) {
        const up = actionBtn('upgrade', 'hud.sel.upgrade', () => {
          ctx.sim.send({ type: 'upgrade', structureId: s.id });
          hs.sound('build');
        }, 'fu-btn--success');
        live.upgrade = up;
        acts.append(up);
      }
      acts.append(actionBtn('demolish', 'hud.sel.demolish', () => {
        ctx.sim.send({ type: 'demolish', structureId: s.id });
        hs.sound('cancel');
        hs.select({ kind: 'none' });
      }, 'fu-btn--danger'));
      children.push(acts);
      const prods = PRODUCES[s.type];
      if (prods) {
        const row = h('div', { class: 'fu-sel-prod' });
        for (const ut of prods) {
          const d = UNIT_DEFS[ut];
          const b = h('button', { class: 'fu-sel-prod-btn', title: t(`unit.${d.id}`) }, icon(UNIT_ICON[ut]), h('span', null, t(`unit.${d.id}`)), h('b', { class: 'fu-mono' }, formatCompact(ctx.sim.view.unitCost(ut))));
          b.addEventListener('click', () => {
            ctx.sim.send({ type: 'buildUnit', unit: ut, structureId: s.id });
            hs.sound('build');
          });
          row.append(b);
        }
        children.push(h('div', { class: 'fu-panel-title' }, tx('hud.sel.produce')), row);
      }
      if (s.type === StructureType.MissileSilo) {
        const row = h('div', { class: 'fu-sel-prod' });
        for (const w of WEAPONS) {
          const d = UNIT_DEFS[w];
          const b = h('button', { class: 'fu-sel-prod-btn is-weapon', title: t(`unit.${d.id}`) }, icon(UNIT_ICON[w]), h('span', null, t(`unit.${d.id}`)), h('b', { class: 'fu-mono' }, formatCompact(ctx.sim.view.unitCost(w))));
          b.addEventListener('click', () => {
            hs.sound('click');
            hs.setMode({ kind: 'target', weapon: w as WeaponType });
          });
          row.append(b);
        }
        children.push(h('div', { class: 'fu-panel-title' }, tx('hud.sel.launch')), row);
      }
    }
    el.replaceChildren(...children);
  }

  // ---------------------------------------------------------------------------------------------
  function buildNation(id: number): void {
    const view = ctx.sim.view;
    const p = view.players[id];
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

  // ---------------------------------------------------------------------------------------------
  function takeControl(): void {
    const sel = hs.selection;
    if (sel.kind !== 'unit') return;
    const u = ctx.sim.view.units.get(sel.id);
    if (!u || u.owner !== HUMAN_ID || !UNIT_DEFS[u.type].command) {
      hs.sound('error');
      return;
    }
    hs.sound('whoosh');
    hs.flags.commandEntered = true;
    hs.setMode({ kind: 'none' });
    void ctx.app.enterCommandMode(u.id);
  }

  function stateKey(u: UnitView): string {
    switch (u.state) {
      case UnitState.Moving: return 'ustate.moving';
      case UnitState.Attacking: return 'ustate.attacking';
      case UnitState.Returning: return 'ustate.returning';
      case UnitState.Launching: return 'ustate.launching';
      case UnitState.InFlight: return 'ustate.inFlight';
      case UnitState.Destroyed: return 'ustate.destroyed';
      case UnitState.Controlled: return 'ustate.controlled';
      case UnitState.Docked: return 'ustate.docked';
      default: return 'ustate.idle';
    }
  }

  function refresh(): void {
    const sel = hs.selection;
    const view = ctx.sim.view;
    let key = 'none';
    if (sel.kind === 'unit' && view.units.has(sel.id)) key = `u${sel.id}`;
    else if (sel.kind === 'structure' && view.structures.has(sel.id)) key = `s${sel.id}:${view.structures.get(sel.id)!.owner}`;
    else if (sel.kind === 'nation' && view.players[sel.id]?.alive) key = `n${sel.id}:${nationRelation(hs, sel.id)}`;
    if (key === 'none' && sel.kind !== 'none') {
      // Selected thing died / vanished.
      hs.select({ kind: 'none' });
      if (hs.mode.kind === 'order') hs.setMode({ kind: 'none' });
    }
    if (key !== builtFor) {
      builtFor = key;
      live = {};
      if (key === 'none') {
        el.classList.add('fu-hidden');
        return;
      }
      el.classList.remove('fu-hidden');
      el.classList.remove('is-in');
      void el.offsetWidth;
      el.classList.add('is-in');
      if (sel.kind === 'unit') buildUnit(view.units.get(sel.id)!);
      else if (sel.kind === 'structure') buildStructure(view.structures.get(sel.id)!);
      else if (sel.kind === 'nation') buildNation(sel.id);
    }
    if (key === 'none') return;
    const setMeter = (k: string, v: number, text: string) => {
      if (!live[k]) return;
      setStyle(live[k], 'transform', `scaleX(${Math.max(0, Math.min(1, v)).toFixed(3)})`);
      setText(live[`${k}Val`], text);
      toggleClass(live[k], 'is-low', v < 0.3);
    };
    if (sel.kind === 'unit') {
      const u = view.units.get(sel.id)!;
      const def = UNIT_DEFS[u.type];
      setMeter('hp', u.hp, `${Math.round(u.hp * 100)}%`);
      if (live.troops) setText(live.troops, u.troops > 0 ? formatCompact(u.troops) : formatNumber(Math.round(def.maxHp * u.hp)));
      if (live.state) setText(live.state, t(stateKey(u)));
      if (live.speed) setText(live.speed, `${Math.round(def.speed * 25 * 36)} km/h`);
      if (live.order) toggleClass(live.order, 'is-on', hs.mode.kind === 'order');
      if (live.tc) toggleClass(live.tc, 'is-disabled', u.state === UnitState.Controlled);
    } else if (sel.kind === 'structure') {
      const s = view.structures.get(sel.id)!;
      const def = STRUCTURE_DEFS[s.type];
      setMeter('hp', s.hp, `${Math.round(s.hp * 100)}%`);
      setMeter('build', s.built, s.built >= 1 ? t('hud.sel.operational') : `${Math.round(s.built * 100)}%`);
      if (live.level) setText(live.level, `${s.level} / ${def.maxLevel}`);
      if (live.cooldown) setText(live.cooldown, s.cooldown > 0 ? `${Math.round((1 - s.cooldown) * 100)}%` : t('hud.sel.readyNow'));
      if (live.upgrade) toggleClass(live.upgrade, 'is-disabled', s.level >= def.maxLevel || s.built < 1);
    } else if (sel.kind === 'nation') {
      const p = view.players[sel.id]!;
      const land = view.world?.landTiles ?? 1;
      if (live.troops) setText(live.troops, formatCompact(p.troops));
      if (live.land) setText(live.land, `${((p.tiles / land) * 100).toFixed(2)}%`);
      if (live.gold) setText(live.gold, formatCompact(p.gold));
      if (live.alliesN) setText(live.alliesN, String(p.allies.length));
    }
  }

  return { el, refresh, takeControl, invalidate: () => (builtFor = '') };
}
