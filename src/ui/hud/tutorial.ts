// FRONT ULTRA — the tutorial engine, «Asesor militar» (DESIGN_V2 §12.5; owner: ui, engine by W3, B03).
//
// A state machine driven by the real game state, never by a timer: each step shows while its trigger holds, highlights
// the control involved and completes when the player actually does the thing. It starts in the spawn phase, can be
// skipped, and its progress is a bit set saved in the settings (tutorialProgress), so a finished step never returns.
// Steps 1–4, 7 and 10 need nothing from later stages; 5, 6, 8 and 9 (production, the Fuerzas panel, the Guerra panel,
// command mode) are added by W7 through `steps` with the same shape.

import { h, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { tip } from '../tooltip';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { HUMAN_ID } from '../../shared/constants';
import { t } from '../../shared/i18n';
import { StructureType } from '../../shared/types';

export interface TutorialStep {
  /** Bit index in settings.tutorialProgress (the §12.5 number). */
  n: number;
  id: string;
  ico: string;
  /** App state the step belongs to. */
  state: 'spawn' | 'playing';
  /** The step may show now (it also waits for every earlier sequential step, unless `interrupt`). */
  when(): boolean;
  /** Completed by what the player did. */
  done(): boolean;
  /** CSS selector of the control to highlight. */
  highlight?: string;
  /** A triggered step (10) shows as soon as its trigger holds, before the sequence. */
  interrupt?: boolean;
  /** The step ends with an «Entendido» button (7). */
  ack?: boolean;
}

export interface Tutorial {
  el: HTMLElement;
  reset(): void;
  tick(dt: number): void;
  /** Shots: show the current step immediately regardless of conditions. */
  force(stepId?: string): void;
  relabel(): void;
}

export function createTutorial(hs: HudShared): Tutorial {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  let startTiles = 0;
  let acked = new Set<string>();
  const pendingProposal = () => {
    for (const p of view().proposals.values()) if (p.to === HUMAN_ID && p.status === 'pending') return true;
    return false;
  };
  const steps: TutorialStep[] = [
    {
      n: 1, id: 'spawn', ico: 'flag', state: 'spawn', highlight: '.fu-sp-suggest',
      when: () => ctx.app.state === 'spawn', done: () => !!view().human?.spawned,
    },
    {
      n: 2, id: 'expand', ico: 'attack', state: 'playing', highlight: '.fu-ar',
      when: () => true,
      done: () => startTiles > 0 && (view().human?.tiles ?? 0) >= startTiles * 3,
    },
    {
      n: 3, id: 'city', ico: 'city', state: 'playing', highlight: '.fu-bb-row .fu-bb-slot.is-structure:first-child',
      when: () => true, done: () => hs.ownStructures(StructureType.City, false) > 0,
    },
    {
      n: 4, id: 'neighbours', ico: 'globe', state: 'playing', highlight: '.fu-nations-btn',
      when: () => true, done: () => hs.flags.proposalSent,
    },
    {
      n: 7, id: 'clock', ico: 'clock', state: 'playing', highlight: '.fu-time-seg', ack: true,
      when: () => true, done: () => acked.has('clock'),
    },
    {
      n: 10, id: 'inbox', ico: 'inbox', state: 'playing', highlight: '.fu-nations-btn', interrupt: true,
      when: () => pendingProposal(), done: () => hs.flags.proposalAnswered,
    },
  ];

  const count = h('span', { class: 'fu-mono' });
  const title = h('div', { class: 'fu-tut-title' });
  const text = h('p', { class: 'fu-tut-text' });
  const ico = h('div', { class: 'fu-tut-ico' });
  const ack = h('button', { class: 'fu-btn fu-btn--sm fu-btn--primary' }, tx('common.understood'));
  const skip = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, tx('tut.skip'));
  tip(skip, () => ({ title: t('tut.skip'), text: t('tut.skip.tip') }));
  tip(ack, () => ({ title: t('common.understood'), text: t('tut.ack.tip') }));
  const bar = h('i');
  const el = h('div', { class: 'fu-tut fu-glass fu-interactive fu-hidden' },
    h('div', { class: 'fu-tut-head' }, icon('help'), tx('tut.kicker'), count),
    h('div', { class: 'fu-tut-main' }, ico, h('div', null, title, text)),
    h('div', { class: 'fu-tut-foot' }, h('div', { class: 'fu-tut-progress' }, bar), skip, ack),
  );

  let current: TutorialStep | null = null;
  let acc = 0;
  let forced = false;
  let lit: Element | null = null;

  const progress = () => ctx.settings.get().tutorialProgress ?? 0;
  const isDone = (s: TutorialStep) => (progress() & (1 << s.n)) !== 0;
  const markDone = (s: TutorialStep) => ctx.settings.set({ tutorialProgress: progress() | (1 << s.n) });
  const enabled = () => ctx.settings.get().tutorial && !ctx.app.isShot;

  function light(sel?: string): void {
    const target = sel ? document.querySelector(sel) : null;
    if (target === lit) return;
    lit?.classList.remove('fu-tut-hl');
    lit = target;
    lit?.classList.add('fu-tut-hl');
  }

  function show(s: TutorialStep): void {
    current = s;
    const seq = steps.filter((x) => !x.interrupt);
    const idx = seq.indexOf(s);
    setText(count, s.interrupt ? '' : `${idx + 1}/${seq.length}`);
    setText(title, t(`tut.${s.id}.title`));
    setText(text, t(`tut.${s.id}.text`));
    ico.replaceChildren(icon(s.ico));
    toggleClass(ack, 'fu-hidden', !s.ack);
    bar.style.transform = `scaleX(${s.interrupt ? 1 : (idx + 1) / seq.length})`;
    el.classList.remove('fu-hidden', 'is-in');
    void el.offsetWidth;
    el.classList.add('is-in');
    hs.sound('notify');
  }
  function hide(): void {
    current = null;
    el.classList.add('fu-hidden');
    light();
  }

  ack.addEventListener('click', () => {
    if (!current) return;
    hs.sound('click');
    acked.add(current.id);
    hs.flags.speedUnderstood = true;
  });
  skip.addEventListener('click', () => {
    hs.sound('cancel');
    hide();
    ctx.settings.set({ tutorial: false });
  });

  /** The step to show now: a triggered interrupt first, else the first sequential step not done. */
  function pick(): TutorialStep | null {
    const st = ctx.app.state;
    for (const s of steps) if (s.interrupt && s.state === st && !isDone(s) && s.when()) return s;
    for (const s of steps) {
      if (s.interrupt || isDone(s)) continue;
      if (s.state !== st) return null;
      return s.when() ? s : null;
    }
    return null;
  }

  (window as unknown as { __fuTutorial?: unknown }).__fuTutorial = () => ({ step: current?.id ?? '', n: current?.n ?? 0, progress: progress(), highlighted: lit ? (lit as HTMLElement).className : '' });

  return {
    el,
    reset() {
      forced = false;
      acked = new Set();
      startTiles = 0;
      hide();
    },
    relabel() {
      if (!current) return;
      setText(title, t(`tut.${current.id}.title`));
      setText(text, t(`tut.${current.id}.text`));
    },
    force(stepId?: string) {
      forced = true;
      const s = steps.find((x) => x.id === stepId) ?? steps[0];
      show(s);
      light(s.highlight);
    },
    tick(dt) {
      if (forced) {
        if (current) light(current.highlight);
        return;
      }
      acc += dt;
      if (acc < 0.5) return;
      acc = 0;
      const st = ctx.app.state;
      if (!enabled() || (st !== 'spawn' && st !== 'playing')) {
        if (current) hide();
        return;
      }
      const me = view().human;
      if (me?.spawned && startTiles === 0 && view().phase === 'playing') startTiles = Math.max(1, me.tiles);
      // Completion first (the player may do the thing before the step is shown: it never appears then).
      for (const s of steps) if (!isDone(s) && s.state === st && s.done()) markDone(s);
      const next = pick();
      if (!next) {
        if (current) hide();
        return;
      }
      if (next !== current) show(next);
      light(next.highlight);
    },
  };
}
