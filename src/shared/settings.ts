// FRONT ULTRA — persistent player settings. localStorage access is always wrapped in try/catch:
// private windows, blocked storage and previews must still work (defaults are used).
// Owner: shared. The UI settings panel edits these through SettingsStore.set().

import type { Lang } from './i18n';
import type { QualityLevel } from './quality';
import type { Difficulty, GameDuration, GameSpeed } from './types';

export interface SetupPrefs {
  playerName: string;
  playerColor: number;
  difficulty: Difficulty;
  aiCount: number;
  tribeCount: number;
  speed: GameSpeed;
  nukes: boolean;
  worldEvents: boolean;
  /** v2 (W1): «Duración» of the game (victory thresholds and time limit). */
  duration: GameDuration;
}

/**
 * Cloud layer mode (DESIGN_V2 §10.5): 'strategic' thins clouds over the player's land, fronts and (from high
 * orbit) all land so territory stays readable; 'realistic' is the plain satellite cloud cover; 'hidden' removes it.
 */
export type CloudMode = 'strategic' | 'realistic' | 'hidden';

export interface Settings {
  language: Lang;
  quality: QualityLevel;
  /** 0..1 */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  uiVolume: number;
  /** Camera & command-mode mouse sensitivity multiplier (0.2..3). */
  mouseSensitivity: number;
  invertY: boolean;
  /** Camera edge-scrolling when the mouse touches the window border. */
  edgePan: boolean;
  showFps: boolean;
  /** First-minutes tutorial hints. */
  tutorial: boolean;
  /** Screen shake & flashes (accessibility). */
  screenShake: boolean;
  /** Last skirmish setup, restored in the setup screen. */
  setup: SetupPrefs;
  // --- v2 (W1): clock settings (DESIGN_V2 §8.5; the worker decides crisis and observation time from them) ---
  /** Crisis time while nuclear weapons fly: always (default), only if it concerns me, never. */
  crisisTime: 'always' | 'mine' | 'off';
  /** Observation time: the world runs at 1 game minute per real second while the camera is below ~70 km. */
  observationTime: boolean;
  /** Cloud layer mode (default 'strategic'). */
  clouds: CloudMode;
  /** Historical (real-world) borders overlay below 1,000 km (default off, DESIGN_V2 §10.3). */
  historicalBorders: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'es',
  quality: 'high',
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  uiVolume: 0.7,
  mouseSensitivity: 1,
  invertY: false,
  edgePan: false,
  showFps: false,
  tutorial: true,
  screenShake: true,
  setup: {
    playerName: 'Comandante',
    playerColor: 0xe48821,
    difficulty: 'normal',
    aiCount: 24,
    tribeCount: 40,
    speed: 1,
    nukes: true,
    worldEvents: true,
    duration: 'normal',
  },
  crisisTime: 'always',
  observationTime: true,
  clouds: 'strategic',
  historicalBorders: false,
};

const STORAGE_KEY = 'frontultra.settings.v1';

export type SettingsListener = (s: Settings, changed: (keyof Settings)[]) => void;

export interface SettingsStore {
  get(): Readonly<Settings>;
  set(patch: Partial<Settings>): void;
  subscribe(fn: SettingsListener): () => void;
  reset(): void;
}

function load(): Settings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      setup: { ...DEFAULT_SETTINGS.setup, ...(parsed.setup ?? {}) },
    };
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

function save(s: Settings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: settings live for this session only */
  }
}

/** Read a one-off override from the URL (?lang=en&quality=low) without persisting it. */
function applyUrlOverrides(s: Settings): Settings {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? '');
    const lang = q.get('lang');
    if (lang === 'es' || lang === 'en') s.language = lang;
    const quality = q.get('quality');
    if (quality === 'low' || quality === 'medium' || quality === 'high' || quality === 'ultra') s.quality = quality;
    if (q.get('fps') === '1') s.showFps = true;
  } catch {
    /* ignore */
  }
  return s;
}

export function createSettingsStore(): SettingsStore {
  let current = applyUrlOverrides(load());
  const listeners = new Set<SettingsListener>();
  return {
    get: () => current,
    set(patch) {
      const changed = (Object.keys(patch) as (keyof Settings)[]).filter(
        (k) => JSON.stringify(patch[k]) !== JSON.stringify(current[k]),
      );
      if (changed.length === 0) return;
      current = { ...current, ...patch };
      save(current);
      for (const fn of listeners) fn(current, changed);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    reset() {
      const prev = current;
      current = structuredClone(DEFAULT_SETTINGS);
      save(current);
      const changed = (Object.keys(current) as (keyof Settings)[]).filter(
        (k) => JSON.stringify(prev[k]) !== JSON.stringify(current[k]),
      );
      for (const fn of listeners) fn(current, changed);
    },
  };
}
