// FRONT ULTRA — the shared tooltip (DESIGN_V2 §12.1; owner: ui, built by W3).
//
// Every control explains itself the same way: a title, one line of purpose, «Ahora» (current numbers), «Siguiente
// nivel», cost and time, the hotkey, and «Por qué no» when the control is disabled. Content is a function evaluated when
// the tooltip opens and refreshed 4 times a second while it is shown, so numbers are live (never hand-written: content
// functions read UNIT_DEFS / STRUCTURE_LEVELS and the view).
//
//   tip(el, () => ({ title, text, now: [[label, value]], whyNot }))     — code-built controls
//   <button data-tip="key.title" data-tip-text="key.text">               — static markup (i18n keys)
//
// It appears after 350 ms of hover; holding Shift pins it (it stays where it is and can be read at leisure until the
// pointer leaves it or Esc). Debug: window.__fuTip() returns the visible tooltip's text.

import { h } from './dom';
import { t } from '../shared/i18n';

export interface TipData {
  title: string;
  /** One-line purpose. */
  text?: string;
  /** «Ahora»: current values. */
  now?: [string, string][];
  /** «Siguiente nivel». */
  next?: [string, string][];
  /** Free lines under the tables (formulas, breakdown notes). */
  lines?: string[];
  cost?: string;
  hotkey?: string;
  /** Why the control is disabled (red «Por qué no»). */
  whyNot?: string | null;
}

export type TipFn = () => TipData | null;

const registry = new WeakMap<Element, TipFn>();
const DELAY_MS = 350;

let host: HTMLElement | null = null;
let box: HTMLElement | null = null;
let current: Element | null = null;
let timer = 0;
let refresh = 0;
let pinned = false;
let lastText = '';

/** Attach a tooltip to an element (replaces any previous one and its native title). */
export function tip<T extends Element>(el: T, fn: TipFn): T {
  registry.set(el, fn);
  el.removeAttribute('title');
  (el as unknown as HTMLElement).dataset.hasTip = '1';
  return el;
}

function contentOf(el: Element): TipData | null {
  const fn = registry.get(el);
  if (fn) return fn();
  const key = (el as HTMLElement).dataset.tip;
  if (!key) return null;
  const textKey = (el as HTMLElement).dataset.tipText;
  return { title: t(key), text: textKey ? t(textKey) : undefined };
}

function findTarget(n: EventTarget | null): Element | null {
  let e = n instanceof Element ? n : null;
  while (e) {
    if (registry.has(e) || (e as HTMLElement).dataset?.tip) return e;
    e = e.parentElement;
  }
  return null;
}

function render(d: TipData): void {
  if (!box) return;
  const rows = (k: string, list: [string, string][]) =>
    h('div', { class: 'fu-tip-sec' }, h('div', { class: 'fu-tip-k' }, t(k)), ...list.map(([a, b]) => h('div', { class: 'fu-tip-row' }, h('span', null, a), h('b', { class: 'fu-mono' }, b))));
  const parts: (HTMLElement | null)[] = [
    h('div', { class: 'fu-tip-title' }, d.title, d.hotkey ? h('span', { class: 'fu-kbd' }, d.hotkey) : null),
    d.text ? h('div', { class: 'fu-tip-text' }, d.text) : null,
    d.now && d.now.length ? rows('tip.now', d.now) : null,
    d.next && d.next.length ? rows('tip.next', d.next) : null,
    ...(d.lines ?? []).map((l) => h('div', { class: 'fu-tip-line' }, l)),
    d.cost ? h('div', { class: 'fu-tip-cost' }, h('span', null, t('tip.cost')), h('b', { class: 'fu-mono' }, d.cost)) : null,
    d.whyNot ? h('div', { class: 'fu-tip-why' }, h('b', null, t('tip.whyNot')), ' ', d.whyNot) : null,
    pinned ? null : h('div', { class: 'fu-tip-pin' }, t('tip.pin')),
  ];
  box.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  lastText = box.innerText;
}

function place(el: Element): void {
  if (!box) return;
  const r = el.getBoundingClientRect();
  const bw = box.offsetWidth, bh = box.offsetHeight;
  const W = window.innerWidth, H = window.innerHeight;
  let x = r.left + r.width / 2 - bw / 2;
  let y = r.bottom + 8;
  if (y + bh > H - 6) y = r.top - bh - 8;
  if (y < 6) y = Math.min(H - bh - 6, r.bottom + 8);
  x = Math.max(6, Math.min(W - bw - 6, x));
  box.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}

function show(el: Element): void {
  const d = contentOf(el);
  if (!d || !box) return;
  current = el;
  render(d);
  box.classList.add('is-on');
  place(el);
  window.clearInterval(refresh);
  refresh = window.setInterval(() => {
    if (!current || !box || !current.isConnected) {
      hide(true);
      return;
    }
    const nd = contentOf(current);
    if (!nd) {
      hide(true);
      return;
    }
    render(nd);
    if (!pinned) place(current);
  }, 250);
}

function hide(force = false): void {
  if (pinned && !force) return;
  window.clearTimeout(timer);
  window.clearInterval(refresh);
  current = null;
  pinned = false;
  lastText = '';
  box?.classList.remove('is-on', 'is-pinned');
}

export function initTooltips(root: HTMLElement): void {
  if (host) return;
  host = root;
  box = h('div', { class: 'fu-tip' });
  root.append(box);
  document.addEventListener('pointerover', (e) => {
    if (pinned) return;
    const el = findTarget(e.target);
    if (el === current) return;
    window.clearTimeout(timer);
    if (!el) {
      hide();
      return;
    }
    if (current) hide();
    timer = window.setTimeout(() => show(el), DELAY_MS);
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (pinned && box && box.contains(e.target as Node)) return;
    hide(true);
  }, true);
  box.addEventListener('pointerleave', () => {
    if (pinned) hide(true);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift' && current && box?.classList.contains('is-on') && !pinned) {
      pinned = true;
      box.classList.add('is-pinned');
      const d = contentOf(current);
      if (d) render(d);
    } else if (e.key === 'Escape' && pinned) hide(true);
  });
  (window as unknown as { __fuTip?: unknown }).__fuTip = () => lastText;
  /** Verification: the tooltip text an element would show (without hovering). */
  (window as unknown as { __fuTipOf?: unknown }).__fuTipOf = (sel: string | Element) => {
    const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
    const d = el ? contentOf(el) : null;
    if (!d || !box) return null;
    const keep = box.innerHTML;
    render(d);
    const text = box.innerText;
    box.innerHTML = keep;
    return text;
  };
}

/** Elements (under root) that are interactive but have no tooltip: the sweep of §12.1. */
export function untipped(root: ParentNode): Element[] {
  const out: Element[] = [];
  root.querySelectorAll('button, input, .fu-interactive[data-tipme]').forEach((el) => {
    if (registry.has(el) || (el as HTMLElement).dataset.tip || (el as HTMLElement).title) return;
    if (findTarget(el.parentElement)) return;
    out.push(el);
  });
  return out;
}
