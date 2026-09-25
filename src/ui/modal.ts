// FRONT ULTRA — modal dialog stack (owner: ui). Esc closes the top-most modal (the HUD checks `modalOpen()`
// before treating Esc as "open pause menu").

import { h, leave, type Child } from './dom';
import { icon } from './icons';
import { tx } from './tx';

export interface ModalOptions {
  titleKey: string;
  /** i18n parameters of the title (v2: «¿Declarar la guerra a {name}?»). */
  titleParams?: Record<string, string | number>;
  kickerKey?: string;
  body: Child | Child[];
  foot?: Child[];
  narrow?: boolean;
  wide?: boolean;
  className?: string;
  /** Called after the modal closed (any reason). */
  onClose?: () => void;
  /** Clicking the scrim closes (default true). */
  dismissable?: boolean;
}

export interface ModalHandle {
  el: HTMLElement;
  close(): void;
}

const stack: ModalHandle[] = [];
let host: HTMLElement | null = null;
let soundFn: ((k: 'open' | 'close') => void) | null = null;

export function initModals(root: HTMLElement, sound: (k: 'open' | 'close') => void): void {
  host = root;
  soundFn = sound;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || stack.length === 0) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stack[stack.length - 1].close();
  }, true);
}

export function modalOpen(): boolean {
  return stack.length > 0;
}

export function closeAllModals(): void {
  for (const m of [...stack].reverse()) m.close();
}

function kicker(key: string): HTMLElement {
  const k = tx(key, undefined, 'div');
  k.className = 'fu-caps fu-modal-kicker';
  return k;
}

export function openModal(opts: ModalOptions): ModalHandle {
  const closeBtn = h('button', { class: 'fu-close', title: 'Esc' }, icon('close'));
  const head = h('div', { class: 'fu-modal-head' },
    h('div', { style: 'flex:1;display:flex;flex-direction:column;gap:.45rem' },
      opts.kickerKey ? kicker(opts.kickerKey) : null,
      h('h2', null, tx(opts.titleKey, opts.titleParams)),
    ),
    closeBtn,
  );
  const bodyEl = h('div', { class: 'fu-modal-body' });
  const bodyChildren = Array.isArray(opts.body) ? opts.body : [opts.body];
  for (const c of bodyChildren) if (c !== null && c !== undefined && c !== false) bodyEl.append(typeof c === 'number' ? String(c) : c);
  const modal = h('div', {
    class: `fu-modal fu-glass fu-brackets fu-interactive${opts.narrow ? ' fu-modal--narrow' : ''}${opts.wide ? ' fu-modal--wide' : ''} ${opts.className ?? ''}`,
    role: 'dialog',
  }, head, bodyEl);
  if (opts.foot && opts.foot.length) {
    const foot = h('div', { class: 'fu-modal-foot' });
    for (const c of opts.foot) if (c) foot.append(typeof c === 'number' ? String(c) : c);
    modal.append(foot);
  }
  const scrim = h('div', { class: 'fu-modal-scrim' }, modal);
  let closed = false;
  const handle: ModalHandle = {
    el: modal,
    close() {
      if (closed) return;
      closed = true;
      const i = stack.indexOf(handle);
      if (i >= 0) stack.splice(i, 1);
      soundFn?.('close');
      leave(scrim, 230);
      opts.onClose?.();
    },
  };
  closeBtn.addEventListener('click', () => handle.close());
  if (opts.dismissable !== false) {
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) handle.close();
    });
  }
  (host ?? document.body).appendChild(scrim);
  stack.push(handle);
  soundFn?.('open');
  return handle;
}
