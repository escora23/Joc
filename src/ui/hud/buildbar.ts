// FRONT ULTRA — bottom command bar (owner: ui): attack-force slider (also Shift+wheel) and the build bar with
// two tabs: CONSTRUIR (10 structures, hotkeys 1-0) and ARSENAL (weapons Z/X/C/V + unit production).
// Every button shows its SVG icon, hotkey, live cost, and a disabled/locked state with the reason in its tooltip.

import { h, setText, toggleClass } from '../dom';
import { icon, STRUCTURE_ICON, UNIT_ICON } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { BUILDABLE_UNITS, NUKE_DEFS, STRUCTURE_DEFS, UNIT_DEFS, WEAPONS } from '../../shared/constants';
import { formatCompact, formatNumber, t } from '../../shared/i18n';
import { STRUCTURE_TYPES, StructureType, UnitType, type BuildableUnit, type WeaponType } from '../../shared/types';

export const WEAPON_KEYS: Record<WeaponType, string> = {
  [UnitType.AtomBomb]: 'Z',
  [UnitType.HydrogenBomb]: 'X',
  [UnitType.Mirv]: 'C',
  [UnitType.CruiseMissile]: 'V',
} as Record<WeaponType, string>;

interface Slot {
  el: HTMLButtonElement;
  cost: HTMLElement;
  count?: HTMLElement;
  kind: 'structure' | 'weapon' | 'unit';
  type: number;
}

export interface BuildBar {
  el: HTMLElement;
  ratioEl: HTMLElement;
  refresh(): void;
  setTab(tab: 'build' | 'arsenal'): void;
}

export function createBuildBar(hs: HudShared): BuildBar {
  const ctx = hs.ctx;

  // ---- attack ratio -----------------------------------------------------------------------------
  const ratioVal = h('span', { class: 'fu-ar-val fu-mono' }, '30');
  const ratioTroops = h('span', { class: 'fu-ar-troops fu-mono' }, '');
  const ratioInput = h('input', { type: 'range', class: 'fu-range fu-range--amber', min: 1, max: 100, step: 1, value: 30 }) as HTMLInputElement;
  const ticks = h('div', { class: 'fu-ar-ticks' });
  for (const v of [25, 50, 75]) {
    const b = h('button', { class: 'fu-ar-tick fu-mono', style: `left:${v}%` }, `${v}`);
    b.addEventListener('click', () => {
      hs.sound('click');
      hs.setAttackRatio(v / 100);
    });
    ticks.append(b);
  }
  ratioInput.addEventListener('input', () => {
    hs.setAttackRatio(Number(ratioInput.value) / 100);
  });
  const ratioEl = h('div', { class: 'fu-ar fu-glass fu-interactive', 'data-i18n-title': 'hud.ratio.tip', title: t('hud.ratio.tip') },
    h('div', { class: 'fu-ar-head' },
      h('span', { class: 'fu-caps' }, tx('hud.attackRatio')),
      h('span', { class: 'fu-ar-hint' }, h('span', { class: 'fu-kbd' }, '⇧'), '+', icon('mouse')),
    ),
    h('div', { class: 'fu-ar-main' }, h('div', { class: 'fu-ar-big' }, ratioVal, h('small', null, '%')), h('div', { class: 'fu-ar-side' }, ratioTroops, tx('hud.ratio.troops', undefined, 'small'))),
    h('div', { class: 'fu-ar-slider' }, ratioInput, ticks),
  );
  const paintRatio = () => {
    const v = Math.round(hs.attackRatio * 100);
    ratioInput.value = String(v);
    ratioInput.style.setProperty('--p', `${v}%`);
    setText(ratioVal, String(v));
    const troops = ctx.sim.view.human?.troops ?? 0;
    setText(ratioTroops, formatCompact(troops * hs.attackRatio));
  };
  hs.on('ratio', paintRatio);
  paintRatio();

  // ---- slots --------------------------------------------------------------------------------------
  const slots: Slot[] = [];
  const tip = h('div', { class: 'fu-bb-tip fu-glass' });
  const makeSlot = (kind: Slot['kind'], type: number, ico: string, key: string | null): Slot => {
    const cost = h('span', { class: 'fu-bb-cost fu-mono' }, '');
    const el = h('button', { class: `fu-bb-slot is-${kind}` },
      key ? h('span', { class: 'fu-bb-key' }, key) : null,
      h('span', { class: 'fu-bb-ico' }, icon(ico)),
      cost,
      h('span', { class: 'fu-bb-lock' }, icon('lock')),
    ) as HTMLButtonElement;
    const slot: Slot = { el, cost, kind, type };
    if (kind === 'unit' || kind === 'structure') {
      slot.count = h('span', { class: 'fu-bb-count fu-mono' }, '');
      el.append(slot.count);
    }
    el.addEventListener('click', () => activate(slot));
    el.addEventListener('mouseenter', () => {
      hs.sound('hover');
      showTip(slot);
    });
    el.addEventListener('mouseleave', () => tip.classList.remove('is-on'));
    slots.push(slot);
    return slot;
  };

  const buildRow = h('div', { class: 'fu-bb-row' });
  for (const st of STRUCTURE_TYPES) buildRow.append(makeSlot('structure', st, STRUCTURE_ICON[st], STRUCTURE_DEFS[st].hotkey).el);
  const arsenalRow = h('div', { class: 'fu-bb-row' });
  for (const w of WEAPONS) arsenalRow.append(makeSlot('weapon', w, UNIT_ICON[w], WEAPON_KEYS[w]).el);
  arsenalRow.append(h('div', { class: 'fu-bb-div' }));
  for (const u of BUILDABLE_UNITS) arsenalRow.append(makeSlot('unit', u, UNIT_ICON[u], null).el);

  const tabBuild = h('button', { class: 'fu-bb-tab' }, icon('city'), tx('hud.tab.build'));
  const tabArsenal = h('button', { class: 'fu-bb-tab' }, icon('atomBomb'), tx('hud.tab.arsenal'));
  const setTab = (tb: 'build' | 'arsenal') => {
    toggleClass(tabBuild, 'is-on', tb === 'build');
    toggleClass(tabArsenal, 'is-on', tb === 'arsenal');
    toggleClass(buildRow, 'fu-hidden', tb !== 'build');
    toggleClass(arsenalRow, 'fu-hidden', tb !== 'arsenal');
    tip.classList.remove('is-on');
  };
  tabBuild.addEventListener('click', () => { hs.sound('click'); setTab('build'); });
  tabArsenal.addEventListener('click', () => { hs.sound('click'); setTab('arsenal'); });
  setTab('build');

  const el = h('div', { class: 'fu-bb fu-glass fu-brackets fu-interactive' },
    h('div', { class: 'fu-bb-tabs' }, tabBuild, tabArsenal),
    h('div', { class: 'fu-bb-rows' }, buildRow, arsenalRow),
    tip,
  );

  // ---- behaviour ----------------------------------------------------------------------------------
  function reason(slot: Slot): string | null {
    const view = ctx.sim.view;
    const me = view.human;
    if (!me) return 'msg.notSpawned';
    if (slot.kind === 'structure') {
      if (me.gold < view.structureCost(slot.type as StructureType)) return 'msg.notEnoughGold';
      return null;
    }
    if (slot.kind === 'weapon') {
      if (view.config && !view.config.nukes && slot.type !== UnitType.CruiseMissile) return 'msg.nukesDisabled';
      if (hs.ownStructures(StructureType.MissileSilo) === 0) return 'msg.noSilo';
      if (me.gold < view.unitCost(slot.type as WeaponType)) return 'msg.notEnoughGold';
      return null;
    }
    const prod = UNIT_DEFS[slot.type as BuildableUnit].producedBy;
    if (prod !== -1 && hs.ownStructures(prod) === 0) return 'hud.needs';
    if (me.gold < view.unitCost(slot.type as BuildableUnit)) return 'msg.notEnoughGold';
    return null;
  }

  function activate(slot: Slot): void {
    const why = reason(slot);
    if (why && why !== 'msg.notEnoughGold') {
      hs.sound('error');
      showTip(slot);
      return;
    }
    if (slot.kind === 'structure') {
      const m = hs.mode;
      if (m.kind === 'build' && m.structure === slot.type) hs.setMode({ kind: 'none' });
      else hs.setMode({ kind: 'build', structure: slot.type as StructureType });
      hs.sound('click');
    } else if (slot.kind === 'weapon') {
      const m = hs.mode;
      if (m.kind === 'target' && m.weapon === slot.type) hs.setMode({ kind: 'none' });
      else hs.setMode({ kind: 'target', weapon: slot.type as WeaponType });
      hs.sound('click');
    } else {
      if (why) {
        hs.sound('error');
        return;
      }
      ctx.sim.send({ type: 'buildUnit', unit: slot.type as BuildableUnit, structureId: -1 });
      hs.sound('build');
      slot.el.classList.remove('is-pulse');
      void slot.el.offsetWidth;
      slot.el.classList.add('is-pulse');
    }
  }

  function showTip(slot: Slot): void {
    const view = ctx.sim.view;
    let name = '', desc = '', cost = 0, extra = '';
    if (slot.kind === 'structure') {
      const d = STRUCTURE_DEFS[slot.type as StructureType];
      name = t(`structure.${d.id}`);
      desc = t(`structure.${d.id}.desc`);
      cost = view.structureCost(slot.type as StructureType);
      extra = `${t('hud.hotkey')} ${d.hotkey}${d.coastal ? ` · ${t('hud.coastal')}` : ''}`;
    } else if (slot.kind === 'weapon') {
      const d = UNIT_DEFS[slot.type as WeaponType];
      name = t(`unit.${d.id}`);
      desc = t(`unit.${d.id}.desc`);
      cost = view.unitCost(slot.type as WeaponType);
      const nd = NUKE_DEFS[slot.type as WeaponType];
      extra = `${t('hud.hotkey')} ${WEAPON_KEYS[slot.type as WeaponType]}${nd.outerRadius > 0 ? ` · ${t('hud.blast', { r: Math.round(nd.outerRadius * 25) })}` : ''}`;
    } else {
      const d = UNIT_DEFS[slot.type as BuildableUnit];
      name = t(`unit.${d.id}`);
      desc = t(`unit.${d.id}.desc`);
      cost = view.unitCost(slot.type as BuildableUnit);
      if (d.producedBy !== -1) extra = t('hud.producedAt', { s: t(`structure.${STRUCTURE_DEFS[d.producedBy].id}`) });
      if (d.command) extra += ` · ${t('hud.controllable')}`;
    }
    const why = reason(slot);
    let whyText = '';
    if (why === 'hud.needs' && slot.kind === 'unit') {
      const d = UNIT_DEFS[slot.type as BuildableUnit];
      whyText = t('msg.noProducer', { structureName: t(`structure.${STRUCTURE_DEFS[d.producedBy as StructureType].id}`) });
    } else if (why) whyText = t(why);
    tip.replaceChildren(
      h('div', { class: 'fu-bb-tip-head' }, h('b', null, name), h('span', { class: `fu-mono ${why === 'msg.notEnoughGold' ? 'fu-neg' : 'fu-warn'}` }, icon('gold'), ` ${formatNumber(cost)}`)),
      h('p', null, desc),
      h('div', { class: 'fu-bb-tip-foot' }, extra),
      ...(whyText ? [h('div', { class: 'fu-bb-tip-why' }, icon('warning'), ` ${whyText}`)] : []),
    );
    const r = slot.el.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    tip.style.left = `${r.left + r.width / 2 - host.left}px`;
    tip.classList.add('is-on');
  }

  function refresh(): void {
    const view = ctx.sim.view;
    const me = view.human;
    if (!me) return;
    paintRatio();
    const m = hs.mode;
    for (const s of slots) {
      let cost = 0;
      if (s.kind === 'structure') cost = view.structureCost(s.type as StructureType);
      else cost = view.unitCost(s.type as WeaponType | BuildableUnit);
      setText(s.cost, formatCompact(cost));
      const why = reason(s);
      toggleClass(s.el, 'is-poor', why === 'msg.notEnoughGold');
      toggleClass(s.el, 'is-locked', !!why && why !== 'msg.notEnoughGold');
      const active = (s.kind === 'structure' && m.kind === 'build' && m.structure === s.type) || (s.kind === 'weapon' && m.kind === 'target' && m.weapon === s.type);
      toggleClass(s.el, 'is-active', active);
      if (s.count) {
        let n = 0;
        if (s.kind === 'structure') n = hs.ownStructures(s.type as StructureType, false);
        else n = hs.ownUnits(s.type);
        setText(s.count, n > 0 ? String(n) : '');
      }
    }
  }

  return { el, ratioEl, refresh, setTab };
}
