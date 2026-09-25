// FRONT ULTRA — tiny DOM helpers for the UI (owner: ui). No framework: a hyperscript `h()`, an SVG
// helper, and a few text/number utilities that avoid touching the DOM when nothing changed.

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | EventListener | null | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement;
export function h(tag: string, attrs: Attrs | null = null, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag: string, attrs: Attrs | null = null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el: Element, attrs: Attrs): void {
  for (const k in attrs) {
    const v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') {
      el.addEventListener(k.startsWith('on') ? k.slice(2) : k, v);
    } else if (k === 'class') {
      el.setAttribute('class', String(v));
    } else if (k === 'html') {
      el.innerHTML = String(v);
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

/** Parse an SVG markup string (icons) into an element. */
export function svgFrom(markup: string, cls = 'fu-ico'): SVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = markup.trim();
  const el = tpl.content.firstElementChild as SVGElement;
  el.setAttribute('class', cls);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** Set textContent only when it changed (avoids layout/style invalidation). */
export function setText(el: HTMLElement | SVGElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function setStyle(el: HTMLElement, prop: string, value: string): void {
  if (el.style.getPropertyValue(prop) !== value) el.style.setProperty(prop, value);
}

/** True when the keyboard event target is a text field (hotkeys must be ignored). */
export function isTyping(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return (tag === 'INPUT' && (t as HTMLInputElement).type !== 'range' && (t as HTMLInputElement).type !== 'checkbox') || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

/** Remove an element after its CSS exit animation (class `is-leaving`). */
export function leave(el: HTMLElement, ms = 260): void {
  if (el.classList.contains('is-leaving')) return;
  el.classList.add('is-leaving');
  window.setTimeout(() => el.remove(), ms);
}

export function clearChildren(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
