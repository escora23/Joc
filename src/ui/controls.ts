// FRONT ULTRA — reusable form controls (owner: ui): segmented buttons, sliders with live readouts, switches.

import { h, setText, toggleClass } from './dom';
import { tx } from './tx';

type Sound = (kind: 'click' | 'hover' | 'toggle' | 'slider') => void;

export interface Segmented<T> {
  el: HTMLElement;
  value: T;
  set(v: T): void;
}

export function segmented<T extends string | number>(
  options: { value: T; labelKey?: string; label?: string; title?: string }[],
  value: T,
  onChange: (v: T) => void,
  sound?: Sound,
): Segmented<T> {
  const el = h('div', { class: 'fu-seg' });
  const btns: HTMLButtonElement[] = [];
  const api: Segmented<T> = {
    el,
    value,
    set(v) {
      api.value = v;
      options.forEach((o, i) => toggleClass(btns[i], 'is-on', o.value === v));
    },
  };
  for (const o of options) {
    const b = h('button', { type: 'button', title: o.title ?? null }, o.labelKey ? tx(o.labelKey) : (o.label ?? String(o.value)));
    b.addEventListener('click', () => {
      if (api.value === o.value) return;
      sound?.('click');
      api.set(o.value);
      onChange(o.value);
    });
    b.addEventListener('mouseenter', () => sound?.('hover'));
    btns.push(b);
    el.append(b);
  }
  api.set(value);
  return api;
}

export interface Slider {
  el: HTMLElement;
  input: HTMLInputElement;
  set(v: number): void;
}

/** Range input with a filled track (CSS var --p) and a mono readout. */
export function slider(opts: {
  min: number; max: number; step: number; value: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  amber?: boolean;
  sound?: Sound;
}): Slider {
  const input = h('input', { type: 'range', class: `fu-range${opts.amber ? ' fu-range--amber' : ''}`, min: opts.min, max: opts.max, step: opts.step }) as HTMLInputElement;
  const out = h('span', { class: 'fu-mono fu-slider-val' });
  const paint = (v: number) => {
    input.style.setProperty('--p', `${((v - opts.min) / (opts.max - opts.min)) * 100}%`);
    setText(out, opts.format(v));
  };
  input.value = String(opts.value);
  paint(opts.value);
  let lastTick = 0;
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    opts.onInput(v);
    const now = performance.now();
    if (now - lastTick > 60) {
      lastTick = now;
      opts.sound?.('slider');
    }
  });
  return {
    el: h('div', { class: 'fu-slider' }, input, out),
    input,
    set(v) {
      input.value = String(v);
      paint(v);
    },
  };
}

export interface Switch {
  el: HTMLButtonElement;
  set(on: boolean): void;
}

export function toggleSwitch(on: boolean, onChange: (v: boolean) => void, sound?: Sound): Switch {
  const el = h('button', { type: 'button', class: 'fu-switch', role: 'switch' }) as HTMLButtonElement;
  let v = on;
  const set = (x: boolean) => {
    v = x;
    toggleClass(el, 'is-on', x);
    el.setAttribute('aria-checked', String(x));
  };
  set(on);
  el.addEventListener('click', () => {
    set(!v);
    sound?.('toggle');
    onChange(v);
  });
  return { el, set };
}

/** Label + hint on the left, control on the right. */
export function formRow(labelKey: string, control: HTMLElement, hintKey?: string): HTMLElement {
  return h('div', { class: 'fu-form-row' },
    h('div', { class: 'fu-form-label' }, tx(labelKey), hintKey ? tx(hintKey, undefined, 'small') : null),
    h('div', { class: 'fu-form-ctl' }, control),
  );
}
