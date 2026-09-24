// FRONT ULTRA — i18n runtime. Spanish is the default language, English the toggle.
// Owner: shared. Dictionaries: the ui owner registers the main ones (src/ui/i18n/es.ts, en.ts).
// Other owners may register their OWN namespaced keys from their own directory
// (e.g. registerDictionary('es', { 'command.hud.ammo': 'Munición' })) — keys are merged.
//
// Keys are dotted ('menu.play'). Params: t('news.nuke', { a: 'Francia', b: 'Madrid' }) with "{a}" placeholders.
// Plural helper: keys may define '<key>.one' / '<key>.other'; tn(key, count, params) picks one.

import type { CountryDef, WorldData } from './types';

export type Lang = 'es' | 'en';
export const LANGS: readonly Lang[] = ['es', 'en'];
export type Dictionary = Record<string, string>;

const dicts: Record<Lang, Dictionary> = { es: {}, en: {} };
let current: Lang = 'es';
const listeners = new Set<(lang: Lang) => void>();
const missing = new Set<string>();

export function registerDictionary(lang: Lang, dict: Dictionary): void {
  Object.assign(dicts[lang], dict);
}

export function getLanguage(): Lang {
  return current;
}

export function setLanguage(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    document.documentElement.lang = lang;
  } catch {
    /* no DOM */
  }
  for (const fn of listeners) fn(lang);
}

export function onLanguageChange(fn: (lang: Lang) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function hasKey(key: string): boolean {
  return key in dicts[current] || key in dicts.es || key in dicts.en;
}

/** Translate. Falls back to Spanish, then English, then the key itself (logged once). */
export function t(key: string, params?: Record<string, string | number>): string {
  let s = dicts[current][key] ?? dicts.es[key] ?? dicts.en[key];
  if (s === undefined) {
    if (!missing.has(key)) {
      missing.add(key);
      console.warn(`[i18n] missing key "${key}"`);
    }
    s = key;
  }
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  return s;
}

/** Plural-aware translate: uses '<key>.one' when count === 1, otherwise '<key>.other' (then '<key>'). */
export function tn(key: string, count: number, params?: Record<string, string | number>): string {
  const k = count === 1 ? `${key}.one` : `${key}.other`;
  return t(hasKey(k) ? k : key, { count: formatNumber(count), ...params });
}

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const k = current + JSON.stringify(opts);
  let f = nfCache.get(k);
  if (!f) {
    f = new Intl.NumberFormat(current === 'es' ? 'es-ES' : 'en-US', opts);
    nfCache.set(k, f);
  }
  return f;
}

/** Locale-aware number (1.234.567 / 1,234,567). */
export function formatNumber(n: number, maxFractionDigits = 0): string {
  return nf({ maximumFractionDigits: maxFractionDigits }).format(n);
}

/** Compact number for HUDs: 950, 12,4K, 3,2M, 1,1B (locale separators). */
export function formatCompact(n: number): string {
  const a = Math.abs(n);
  if (a < 1_000) return formatNumber(Math.round(n));
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [v, suffix] of units) {
    if (a >= v) {
      const x = n / v;
      return nf({ maximumFractionDigits: Math.abs(x) < 10 ? 1 : 0 }).format(x) + suffix;
    }
  }
  return formatNumber(n);
}

/** mm:ss or h:mm:ss from seconds. */
export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function countryName(c: CountryDef | undefined, lang: Lang = current): string {
  if (!c) return '';
  return lang === 'es' ? c.nameEs || c.nameEn : c.nameEn || c.nameEs;
}

/** Localised display name for a player: nations use their country's name in the current language. */
export function playerName(p: { name: string; countryIndex: number; kind?: string }, world: WorldData | null): string {
  if (p.countryIndex > 0 && world && p.kind !== 'human') {
    const n = countryName(world.countries[p.countryIndex]);
    if (n) return n;
  }
  return p.name;
}
