// FRONT ULTRA — bottom command bar (owner: ui): attack-force slider (also Shift+wheel) and the build bar with
// two tabs: CONSTRUIR (10 structures, hotkeys 1-0) and ARSENAL (weapons Z/X/C/V + unit production).
// Every button shows its SVG icon, hotkey, live cost, and a disabled/locked state with the reason in its tooltip.

import { h, setText, toggleClass } from '../dom';
import { icon, STRUCTURE_ICON, UNIT_ICON } from '../icons';
import { tx } from '../tx';
import { tip as sharedTip, type TipData } from '../tooltip';
import { etaText, levelEffects, reachLine, speedLine, structurePurpose } from './forcesInfo';
import type { HudShared } from './shared';
import { siloError } from './nukeConfirm';
import { BUILDABLE_UNITS, HUMAN_ID, NUKE_DEFS, STRUCTURE_DEFS, UNIT_DEFS, WEAPONS } from '../../shared/constants';
import { formatCompact, formatNumber, hasKey, inSentence, t } from '../../shared/i18n';
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
  time?: HTMLElement;
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
    sharedTip(b, () => ({ title: `${v} %`, text: t('w7.ratio.tick', { v, n: formatNumber(Math.round((ctx.sim.view.human?.troops ?? 0) * v / 100)) }) }));
    b.addEventListener('click', () => {
      hs.sound('click');
      hs.setAttackRatio(v / 100);
    });
    ticks.append(b);
  }
  ratioInput.addEventListener('input', () => {
    hs.setAttackRatio(Number(ratioInput.value) / 100);
  });
  const ratioEl = h('div', { class: 'fu-ar fu-glass fu-interactive' },
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
  sharedTip(ratioEl, () => ({
    title: t('hud.attackRatio'), text: t('hud.ratio.tip'),
    now: [[t('w7.ratio.send'), `${Math.round(hs.attackRatio * 100)} % · ${formatNumber(Math.round((ctx.sim.view.human?.troops ?? 0) * hs.attackRatio))}`]],
  }));
  hs.on('ratio', paintRatio);
  paintRatio();

  // ---- slots --------------------------------------------------------------------------------------
  const slots: Slot[] = [];
  const makeSlot = (kind: Slot['kind'], type: number, ico: string, key: string | null): Slot => {
    const cost = h('span', { class: 'fu-bb-cost fu-mono' }, '');
    const el = h('button', { class: `fu-bb-slot is-${kind}`, 'data-slot': `${kind}-${type}` },
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
    if (kind === 'unit') {
      slot.time = h('span', { class: 'fu-bb-time fu-mono' }, etaText(hs, UNIT_DEFS[type as BuildableUnit].productionTicks, false));
      el.append(slot.time);
    }
    el.addEventListener('click', () => activate(slot));
    el.addEventListener('mouseenter', () => hs.sound('hover'));
    // v2 (W4): the shared tooltip (§12.1) with live numbers: purpose, level-1 effects, price, time, why not.
    sharedTip(el, () => slotTip(slot));
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
  };
  sharedTip(tabBuild, () => ({ title: t('hud.tab.build'), text: t('w7.tab.build.tip'), hotkey: '1 … 0' }));
  sharedTip(tabArsenal, () => ({ title: t('hud.tab.arsenal'), text: t('w7.tab.arsenal.tip'), hotkey: 'Z X C V' }));
  tabBuild.addEventListener('click', () => { hs.sound('click'); setTab('build'); });
  tabArsenal.addEventListener('click', () => { hs.sound('click'); setTab('arsenal'); });
  setTab('build');

  const el = h('div', { class: 'fu-bb fu-glass fu-brackets fu-interactive' },
    h('div', { class: 'fu-bb-tabs' }, tabBuild, tabArsenal),
    h('div', { class: 'fu-bb-rows' }, buildRow, arsenalRow),
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
      // Missiles and bombs follow wars (owner item 13): with no war, no target.
      if (!view.wars.some((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID)) return slot.type === UnitType.CruiseMissile ? 'msg.notAtWar' : 'msg.nukeNotAtWar';
      // A silo whose level does not carry this weapon (the hydrogen bomb and the MIRV need upgraded silos).
      if (siloError(hs, slot.type as WeaponType)?.key === 'msg.siloLevelNeed') return 'msg.siloLevelNeed';
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
      // Say why at the click too (the tooltip says it on hover): «necesitas una base aérea», «solo en guerra»…
      const whyNot = slotTip(slot).whyNot;
      if (whyNot) ctx.bus.emit('toast', { text: whyNot, kind: 'warning', durationMs: 3000 });
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

  function slotTip(slot: Slot): TipData {
    const view = ctx.sim.view;
    const why = reason(slot);
    let whyNot: string | null = null;
    if (why === 'hud.needs' && slot.kind === 'unit') {
      const d = UNIT_DEFS[slot.type as BuildableUnit];
      const sd = STRUCTURE_DEFS[d.producedBy as StructureType];
      whyNot = hasKey(`msg.noProducer.${sd.id}`) ? t(`msg.noProducer.${sd.id}`) : t('msg.noProducer', { structureName: inSentence(t(`structure.${sd.id}`)), g: t(`structure.${sd.id}.g`) === 'f' ? 'f' : 'm' });
    } else if (why === 'msg.notEnoughGold') {
      const cost = slot.kind === 'structure' ? view.structureCost(slot.type as StructureType) : view.unitCost(slot.type as BuildableUnit);
      whyNot = t('card.missingGold', { n: formatNumber(Math.ceil(cost - (view.human?.gold ?? 0))) });
    } else if (why === 'msg.siloLevelNeed') {
      const se = siloError(hs, slot.type as WeaponType);
      whyNot = se ? t(se.key, se.params) : t('msg.siloLevel');
    } else if (why) whyNot = t(why);
    if (slot.kind === 'structure') {
      const st = slot.type as StructureType;
      const d = STRUCTURE_DEFS[st];
      return {
        title: t(`structure.${d.id}`), text: structurePurpose(st), now: levelEffects(st, 1),
        lines: [t('bb.buildTime', { h: etaText(hs, d.buildTicks) }), d.coastal ? t('hud.coastal') : ''].filter(Boolean),
        cost: formatNumber(view.structureCost(st)), hotkey: d.hotkey, whyNot,
      };
    }
    const d = UNIT_DEFS[slot.type as BuildableUnit | WeaponType];
    if (slot.kind === 'weapon') {
      const nd = NUKE_DEFS[slot.type as WeaponType];
      return {
        title: t(`unit.${d.id}`), text: t(d.roleKey), lines: [t(`unit.${d.id}.desc`), nd.outerRadius > 0 ? t('hud.blast', { r: Math.round(nd.outerRadius * 25) }) : ''].filter(Boolean),
        cost: formatNumber(view.unitCost(slot.type as WeaponType)), hotkey: WEAPON_KEYS[slot.type as WeaponType], whyNot,
      };
    }
    const ud = d as (typeof UNIT_DEFS)[BuildableUnit];
    return {
      title: t(`unit.${ud.id}`), text: t(ud.roleKey),
      now: [[t('card.prodTime'), etaText(hs, ud.productionTicks)], [t('card.speed'), speedLine(slot.type as BuildableUnit)], [t('card.reach'), reachLine(slot.type as BuildableUnit)]],
      lines: [t('hud.producedAt', { s: t(`structure.${STRUCTURE_DEFS[ud.producedBy as StructureType].id}`) }), t('bb.unit.after')],
      cost: formatNumber(view.unitCost(slot.type as BuildableUnit)), whyNot,
    };
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
