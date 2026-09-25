// FRONT ULTRA — live-translatable text nodes (owner: ui). Static labels are created with `tx(key)` and carry
// `data-i18n`; on 'languageChanged' the UI calls `retranslate(root)` so every visible label flips language
// without rebuilding the screens.

import { t } from '../shared/i18n';

export function tx(key: string, params?: Record<string, string | number>, tag = 'span'): HTMLElement {
  const el = document.createElement(tag);
  el.dataset.i18n = key;
  if (params) el.dataset.i18nParams = JSON.stringify(params);
  el.textContent = t(key, params);
  return el;
}

/** Re-apply translations to every [data-i18n] / [data-i18n-title] / [data-i18n-ph] element under root. */
export function retranslate(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n!;
    const params = el.dataset.i18nParams ? (JSON.parse(el.dataset.i18nParams) as Record<string, string | number>) : undefined;
    el.textContent = t(key, params);
  });
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle!);
  });
  root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh!);
  });
}
