// FRONT ULTRA — first-minutes tutorial hints (owner: ui). A short sequence of contextual briefings; each one
// completes itself when the player does the thing (or after a while), and the whole tutorial can be skipped
// (Settings > Game toggles it).

import { h, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { HUMAN_ID } from '../../shared/constants';
import { t } from '../../shared/i18n';
import { StructureType, UnitType } from '../../shared/types';

interface Step {
  id: string;
  ico: string;
  /** Show only once this is true. */
  when(): boolean;
  /** Done when this is true (checked once per second). */
  done(elapsed: number): boolean;
}

export interface Tutorial {
  el: HTMLElement;
  reset(): void;
  tick(dt: number): void;
  /** Shots: show the current step immediately regardless of conditions. */
  force(): void;
  /** Re-apply the current step's texts (language change). */
  relabel(): void;
}

export function createTutorial(hs: HudShared): Tutorial {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  let startTiles = 0;
  const hasUnit = (types: number[]) => {
    for (const u of view().units.values()) if (u.owner === HUMAN_ID && types.includes(u.type)) return true;
    return false;
  };
  const steps: Step[] = [
    {
      id: 'expand', ico: 'attack', when: () => true,
      done: () => (view().human?.tiles ?? 0) > startTiles + 60 || view().attacks.some((a) => a.attacker === HUMAN_ID),
    },
    { id: 'ratio', ico: 'troops', when: () => true, done: (e) => hs.flags.ratioChanged || e > 28 },
    {
      id: 'city', ico: 'city', when: () => (view().human?.gold ?? 0) >= view().structureCost(StructureType.City) * 0.9,
      done: (e) => hs.ownStructures(StructureType.City, false) > 0 || e > 45,
    },
    { id: 'diplomacy', ico: 'alliance', when: () => true, done: (e) => hs.flags.radialOpened || e > 30 },
    {
      id: 'defense', ico: 'defensePost', when: () => (view().human?.tiles ?? 0) > startTiles + 200,
      done: (e) => hs.ownStructures(StructureType.DefensePost, false) + hs.ownStructures(StructureType.Port, false) > 0 || e > 35,
    },
    {
      id: 'command', ico: 'takeControl', when: () => hasUnit([UnitType.ArmoredDivision, UnitType.Warship, UnitType.FighterSquadron]),
      done: (e) => hs.flags.commandEntered || e > 45,
    },
  ];

  const count = h('span', { class: 'fu-mono' });
  const title = h('div', { class: 'fu-tut-title' });
  const text = h('p', { class: 'fu-tut-text' });
  const ico = h('div', { class: 'fu-tut-ico' });
  const next = h('button', { class: 'fu-btn fu-btn--sm' }, tx('tut.next'));
  const skip = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, tx('tut.skip'));
  const bar = h('i');
  const el = h('div', { class: 'fu-tut fu-glass fu-interactive fu-hidden' },
    h('div', { class: 'fu-tut-head' }, icon('help'), tx('tut.kicker'), count),
    h('div', { class: 'fu-tut-main' }, ico, h('div', null, title, text)),
    h('div', { class: 'fu-tut-foot' }, h('div', { class: 'fu-tut-progress' }, bar), skip, next),
  );

  let index = 0;
  let shownAt = -1;
  let acc = 0;
  let active = false;
  let pinned = false;

  const show = (i: number) => {
    const st = steps[i];
    setText(count, `${i + 1}/${steps.length}`);
    setText(title, t(`tut.${st.id}.title`));
    setText(text, t(`tut.${st.id}.text`));
    ico.replaceChildren(icon(st.ico));
    bar.style.transform = `scaleX(${(i + 1) / steps.length})`;
    el.classList.remove('fu-hidden', 'is-in');
    void el.offsetWidth;
    el.classList.add('is-in');
    hs.sound('notify');
  };
  const advance = () => {
    index++;
    shownAt = -1;
    el.classList.add('fu-hidden');
    if (index >= steps.length) active = false;
  };
  next.addEventListener('click', () => {
    hs.sound('click');
    advance();
  });
  skip.addEventListener('click', () => {
    hs.sound('cancel');
    active = false;
    el.classList.add('fu-hidden');
    ctx.settings.set({ tutorial: false });
  });

  return {
    el,
    reset() {
      pinned = false;
      index = 0;
      shownAt = -1;
      acc = 0;
      active = ctx.settings.get().tutorial && !ctx.app.isShot;
      startTiles = view().human?.tiles ?? 0;
      el.classList.add('fu-hidden');
    },
    relabel() {
      const st = steps[index];
      if (!st) return;
      setText(count, `${index + 1}/${steps.length}`);
      setText(title, t(`tut.${st.id}.title`));
      setText(text, t(`tut.${st.id}.text`));
    },
    force() {
      active = true;
      pinned = true;
      shownAt = view().simTime;
      show(index);
    },
    tick(dt) {
      if (pinned) return;
      if (!active || ctx.app.state !== 'playing') {
        toggleClass(el, 'fu-hidden', true);
        return;
      }
      acc += dt;
      if (acc < 1) return;
      acc = 0;
      if (!ctx.settings.get().tutorial) {
        active = false;
        return;
      }
      const st = steps[index];
      if (!st) {
        active = false;
        return;
      }
      const now = view().simTime;
      if (shownAt < 0) {
        if (!st.when()) return;
        if (st.done(0)) {
          advance();
          return;
        }
        shownAt = now;
        show(index);
        return;
      }
      el.classList.remove('fu-hidden');
      if (st.done(now - shownAt)) advance();
    },
  };
}
