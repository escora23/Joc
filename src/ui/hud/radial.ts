// FRONT ULTRA — right-click radial menu (owner: ui). On a foreign nation: attack, alliance / break alliance,
// embargo, donate (sub-ring), emote (sub-ring), mark as target, info. On your own land: quick build ring.
// On unclaimed land: expand / land by sea. SVG annular wedges with icons, hover label in the hub.

import { h, s, setText } from '../dom';
import { flag } from '../flag';
import { EMOTE_GLYPH, icon, STRUCTURE_ICON } from '../icons';
import { attackNation, breakAlliance, donate, markTarget, nationRelation, requestAlliance, sendEmote, toggleEmbargo } from './diplomacy';
import { needsDeclaration, openDeclareWar } from './declare';
import type { HudShared } from './shared';
import { HUMAN_ID, STRUCTURE_DEFS } from '../../shared/constants';
import { hexToCss } from '../../shared/color';
import { formatCompact, t } from '../../shared/i18n';
import { EMOTES, STRUCTURE_TYPES, type EmoteId } from '../../shared/types';

interface RadialItem {
  id: string;
  label: string;
  ico?: string;
  glyph?: string;
  sub?: string;
  tone?: 'danger' | 'success' | 'amber';
  disabled?: boolean;
  run(): void | RadialItem[];
}

export interface Radial {
  el: HTMLElement;
  openAt(x: number, y: number, tile: number): void;
  close(): void;
  readonly open: boolean;
}

const R_IN = 38, R_OUT = 96;

function wedgePath(a0: number, a1: number, rIn: number, rOut: number): string {
  const p = (r: number, a: number) => `${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(rOut, a0)} A${rOut} ${rOut} 0 ${large} 1 ${p(rOut, a1)} L${p(rIn, a1)} A${rIn} ${rIn} 0 ${large} 0 ${p(rIn, a0)} Z`;
}

export function createRadial(hs: HudShared): Radial {
  const ctx = hs.ctx;
  const svg = s('svg', { viewBox: '-100 -100 200 200', class: 'fu-radial-svg' }) as SVGSVGElement;
  const icons = h('div', { class: 'fu-radial-icons' });
  const hubFlag = h('div', { class: 'fu-radial-flag' });
  const hubName = h('div', { class: 'fu-radial-name' });
  const hubLabel = h('div', { class: 'fu-radial-label' });
  const hubSub = h('div', { class: 'fu-radial-sub fu-mono' });
  const hub = h('div', { class: 'fu-radial-hub' }, hubFlag, hubName, hubLabel, hubSub);
  const el = h('div', { class: 'fu-radial fu-interactive fu-hidden' },
    h('div', { class: 'fu-radial-ring' }),
    svg, icons, hub,
  );
  let isOpen = false;
  let title = '';
  let stack: RadialItem[][] = [];

  function render(items: RadialItem[]): void {
    svg.replaceChildren();
    icons.replaceChildren();
    const n = items.length;
    const gap = n > 10 ? 0.035 : 0.05;
    const step = (Math.PI * 2) / n;
    const start = -Math.PI / 2 - step / 2;
    items.forEach((it, i) => {
      const a0 = start + i * step + gap / 2, a1 = start + (i + 1) * step - gap / 2;
      const path = s('path', { d: wedgePath(a0, a1, R_IN, R_OUT), class: `fu-wedge${it.tone ? ` is-${it.tone}` : ''}${it.disabled ? ' is-disabled' : ''}` });
      const am = (a0 + a1) / 2;
      const rm = (R_IN + R_OUT) / 2;
      const ic = h('div', {
        class: `fu-radial-ic${it.disabled ? ' is-disabled' : ''}${it.tone ? ` is-${it.tone}` : ''}`,
        style: `left:${50 + (Math.cos(am) * rm) / 2}%;top:${50 + (Math.sin(am) * rm) / 2}%;animation-delay:${i * 18}ms`,
      }, it.glyph ? h('span', { class: 'fu-radial-glyph' }, it.glyph) : icon(it.ico ?? 'info'), n <= 10 && !it.glyph ? h('span', { class: 'fu-radial-lbl' }, it.label) : null);
      const enter = () => {
        path.classList.add('is-hover');
        ic.classList.add('is-hover');
        setText(hubLabel, it.label);
        setText(hubSub, it.sub ?? '');
        hs.sound('hover');
      };
      const leaveFn = () => {
        path.classList.remove('is-hover');
        ic.classList.remove('is-hover');
        setText(hubLabel, '');
        setText(hubSub, '');
      };
      const click = (e: Event) => {
        e.stopPropagation();
        if (it.disabled) {
          hs.sound('error');
          return;
        }
        const res = it.run();
        if (Array.isArray(res)) {
          hs.sound('open');
          stack.push(res);
          render(res);
        } else close();
      };
      path.addEventListener('pointerenter', enter);
      path.addEventListener('pointerleave', leaveFn);
      path.addEventListener('click', click);
      svg.append(path);
      icons.append(ic);
    });
    setText(hubLabel, '');
    setText(hubSub, stack.length > 1 ? t('radial.back') : '');
    el.classList.remove('is-in');
    void el.offsetWidth;
    el.classList.add('is-in');
  }

  function nationItems(id: number, tile: number): RadialItem[] {
    const rel = nationRelation(hs, id);
    const p = ctx.sim.view.players[id]!;
    const me = hs.human;
    const ally = rel === 'ally';
    const items: RadialItem[] = [
      {
        id: 'attack', label: t('dip.attack'), ico: 'attack', tone: 'danger', disabled: ally,
        sub: me ? `${Math.round(hs.attackRatio * 100)}% · ${formatCompact(me.troops * hs.attackRatio)}` : '',
        run: () => void attackNation(hs, id, tile),
      },
      ally
        ? { id: 'break', label: t('dip.break'), ico: 'breakAlliance', tone: 'amber', sub: t('dip.break.sub'), run: () => breakAlliance(hs, id) }
        : { id: 'ally', label: t('dip.alliance'), ico: 'alliance', tone: 'success', disabled: p.kind !== 'nation', run: () => requestAlliance(hs, id) },
      { id: 'embargo', label: t(rel === 'embargoed' ? 'dip.embargoOff' : 'dip.embargo'), ico: 'embargo', run: () => toggleEmbargo(hs, id) },
      {
        id: 'donate', label: t('dip.donate'), ico: 'donate', disabled: !ally, sub: ally ? '' : t('dip.donate.allies'),
        run: () => [
          { id: 'g25', label: t('dip.donateGoldPct', { p: 25 }), ico: 'gold', sub: me ? formatCompact(me.gold * 0.25) : '', run: () => donate(hs, id, 'gold', 0.25) },
          { id: 'g50', label: t('dip.donateGoldPct', { p: 50 }), ico: 'gold', sub: me ? formatCompact(me.gold * 0.5) : '', run: () => donate(hs, id, 'gold', 0.5) },
          { id: 't25', label: t('dip.donateTroopsPct', { p: 25 }), ico: 'troops', sub: me ? formatCompact(me.troops * 0.25) : '', run: () => donate(hs, id, 'troops', 0.25) },
          { id: 't50', label: t('dip.donateTroopsPct', { p: 50 }), ico: 'troops', sub: me ? formatCompact(me.troops * 0.5) : '', run: () => donate(hs, id, 'troops', 0.5) },
        ],
      },
      { id: 'emote', label: t('dip.emote'), ico: 'emote', run: () => emoteItems(id) },
      { id: 'target', label: t('dip.target'), ico: 'target', tone: 'amber', disabled: ally, run: () => markTarget(hs, id) },
      { id: 'info', label: t('dip.info'), ico: 'info', run: () => hs.select({ kind: 'nation', id }) },
    ];
    return items;
  }

  function emoteItems(id: number): RadialItem[] {
    return EMOTES.map((e: EmoteId) => ({ id: e, label: t(`emote.${e}`), glyph: EMOTE_GLYPH[e], run: () => sendEmote(hs, id, e) }));
  }

  function buildItems(tile: number): RadialItem[] {
    const view = ctx.sim.view;
    return STRUCTURE_TYPES.map((st) => {
      const d = STRUCTURE_DEFS[st];
      const why = hs.buildError(st, tile);
      return {
        id: d.id, label: t(`structure.${d.id}`), ico: STRUCTURE_ICON[st], disabled: !!why,
        sub: why ? t(why) : `${formatCompact(view.structureCost(st))} · [${d.hotkey}]`,
        run: () => {
          ctx.sim.send({ type: 'build', structure: st, tile });
          hs.sound('build');
        },
      };
    });
  }

  function neutralItems(tile: number): RadialItem[] {
    const me = hs.human;
    return [
      { id: 'expand', label: t('dip.expand'), ico: 'attack', tone: 'success', sub: me ? `${Math.round(hs.attackRatio * 100)}% · ${formatCompact(me.troops * hs.attackRatio)}` : '', run: () => void attackNation(hs, 0, tile) },
      {
        id: 'boat', label: t('dip.boat'), ico: 'boat', sub: '[B]',
        run: () => {
          if (needsDeclaration(hs, ctx.sim.view.owner[tile])) openDeclareWar(hs, ctx.sim.view.owner[tile], tile, true);
          else ctx.sim.send({ type: 'boatAttack', targetTile: tile, ratio: hs.attackRatio });
          hs.sound('confirm');
        },
      },
    ];
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    hs.radialOpen = false;
    el.classList.add('fu-hidden');
    stack = [];
    hs.emit('radial');
  }

  function openAt(x: number, y: number, tile: number): void {
    const view = ctx.sim.view;
    if (tile < 0 || !view.human) return;
    const owner = view.owner[tile];
    let items: RadialItem[];
    hubFlag.replaceChildren();
    if (owner === HUMAN_ID) {
      items = buildItems(tile);
      title = t('radial.build');
      hubFlag.append(flag(view.human.color, 0));
      el.style.setProperty('--oc', hexToCss(view.human.color));
    } else if (owner === 0) {
      items = neutralItems(tile);
      title = t('hud.neutralLand');
      el.style.setProperty('--oc', '#9fb3c8');
    } else {
      const p = view.players[owner];
      if (!p) return;
      items = nationItems(owner, tile);
      title = hs.name(owner);
      hubFlag.append(flag(p.color, owner));
      el.style.setProperty('--oc', hexToCss(p.color));
    }
    setText(hubName, title);
    const size = el.offsetWidth || 300;
    const half = size / 2 + 8;
    const cx = Math.min(window.innerWidth - half, Math.max(half, x));
    const cy = Math.min(window.innerHeight - half, Math.max(half, y));
    el.style.left = `${cx}px`;
    el.style.top = `${cy}px`;
    el.classList.remove('fu-hidden');
    isOpen = true;
    hs.radialOpen = true;
    hs.flags.radialOpened = true;
    stack = [items];
    render(items);
    hs.sound('open');
    hs.emit('radial');
  }

  // Clicking the hub goes back one level (or closes); clicking outside closes.
  hub.addEventListener('click', (e) => {
    e.stopPropagation();
    if (stack.length > 1) {
      stack.pop();
      render(stack[stack.length - 1]);
      hs.sound('close');
    } else {
      close();
      hs.sound('close');
    }
  });
  window.addEventListener('pointerdown', (e) => {
    if (!isOpen) return;
    if (el.contains(e.target as Node)) return;
    close();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (isOpen && e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (stack.length > 1) {
        stack.pop();
        render(stack[stack.length - 1]);
      } else close();
    }
  }, true);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  return {
    el,
    openAt,
    close,
    get open() {
      return isOpen;
    },
  };
}
