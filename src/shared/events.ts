// FRONT ULTRA — typed main-thread event bus and the full event vocabulary.
// Owner: shared. Main thread only (the worker has its own event list in protocol.ts).
//
// Dispatch is synchronous, in subscription order. Handlers must be cheap (queue work for update()).
// Payload objects may be reused by the emitter after dispatch: copy what you keep (esp. typed arrays).

import type { NukeWeapon, SimEventMap } from './protocol';
import type { Lang } from './i18n';
import type { QualityProfile } from './quality';
import type { Settings } from './settings';
import type { AppState, CameraState, CommandEnterParams, CommandResult } from './api';
import type { GameConfig, GameOverReason, GameSpeed, StructureType, UnitType, WeaponType } from './types';

export type Unsubscribe = () => void;

export class EventBus<M extends object> {
  private handlers = new Map<keyof M, Array<(payload: never) => void>>();

  on<K extends keyof M>(type: K, fn: (payload: M[K]) => void): Unsubscribe {
    let list = this.handlers.get(type);
    if (!list) {
      list = [];
      this.handlers.set(type, list);
    }
    list.push(fn as (payload: never) => void);
    return () => this.off(type, fn);
  }

  once<K extends keyof M>(type: K, fn: (payload: M[K]) => void): Unsubscribe {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  off<K extends keyof M>(type: K, fn: (payload: M[K]) => void): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn as (payload: never) => void);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    // Copy only when needed so handlers may unsubscribe during dispatch.
    const snapshot = list.length === 1 ? list : list.slice();
    for (let i = 0; i < snapshot.length; i++) {
      try {
        (snapshot[i] as (p: M[K]) => void)(payload);
      } catch (err) {
        console.error(`[bus] handler for "${String(type)}" threw`, err);
      }
    }
  }

  /** Resolves on the next emission of `type` (optionally matching a predicate). */
  wait<K extends keyof M>(type: K, pred?: (payload: M[K]) => boolean): Promise<M[K]> {
    return new Promise((resolve) => {
      const off = this.on(type, (p) => {
        if (pred && !pred(p)) return;
        off();
        resolve(p);
      });
    });
  }

  clear(): void {
    this.handlers.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Main-thread (app/render/ui) events
// ---------------------------------------------------------------------------------------------

export interface WorldPointerEvent {
  /** 0 = left, 1 = middle, 2 = right, -1 = hover (no button). */
  button: number;
  /** Tile under the pointer, -1 when off-globe. */
  tile: number;
  lat: number;
  lon: number;
  /** Unit / structure under the pointer, -1 when none (units have priority over structures over tiles). */
  unitId: number;
  structureId: number;
  clientX: number;
  clientY: number;
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  /** Set when the pointer is on a small-island marker (the tile is then the island's): «Malta · 1 casilla · libre». */
  islandLabel?: string;
}

export type UiSoundKind =
  | 'hover' | 'click' | 'confirm' | 'cancel' | 'error' | 'open' | 'close' | 'toggle' | 'slider'
  | 'build' | 'notify' | 'alert' | 'typewriter' | 'whoosh';

export type NewsSeverity = 'info' | 'warning' | 'critical';

export interface AppEvents {
  /** App state machine transition (emitted by app after the state changed). */
  appState: { state: AppState; prev: AppState };
  resize: { width: number; height: number; dpr: number };
  settingsChanged: { settings: Settings; changed: (keyof Settings)[] };
  languageChanged: { lang: Lang };
  qualityChanged: { quality: QualityProfile };

  /** A game session was created (sim running, ctx.sim.view populated with config/world). */
  gameStarted: { config: GameConfig };
  /** The session was torn down (return to menu). Renderers drop all game objects. */
  gameTornDown: Record<string, never>;
  /** Derived from the sim 'gameOver' event by app, before the state switches to 'ended'. */
  gameEnded: { winner: number; humanWon: boolean; reason: GameOverReason };
  /** Emitted by the sim client after applying an update (once per update, after all its events). */
  simTick: { tick: number; ticks: number };
  /**
   * Emitted by the sim client for every applied update with owner changes, BEFORE simTick.
   * packed[i] = packTileOwner(tile, newOwner) for i < count. The array is only valid during dispatch.
   * `full` = true when this is a resync (every tile may have changed: rebuild instead of patching).
   */
  tilesChanged: { packed: Uint32Array; count: number; full: boolean };
  speedChanged: { speed: GameSpeed };

  /** Input router (app): click on the world (not on DOM UI). */
  worldClick: WorldPointerEvent;
  /** Input router (app): pointer moved over the world (throttled to once per frame). */
  worldHover: WorldPointerEvent;

  /** UI: selection changed (renderers draw rings/highlights). */
  selectionChanged: { unitIds: number[]; structureId: number };
  /** UI: build placement preview. structure = -1 when placement mode ends. */
  buildPreview: { structure: StructureType | -1; tile: number; valid: boolean };
  /** UI: weapon targeting preview (blast radius circle on the globe). weapon = null ends targeting. */
  targetPreview: { weapon: WeaponType | null; tile: number; innerRadius: number; outerRadius: number; valid: boolean };
  /** Unit-order preview (move / deploy / strike path). unitId = -1 ends it. */
  orderPreview: { unitId: number; unit: UnitType | -1; tile: number; valid: boolean };

  /** Anyone -> camera: fly to a place (news item click, "go to capital", alerts). */
  focusRequest: { lat: number; lon: number; altitudeKm?: number; durationMs?: number };
  /** Camera: emitted when the camera state changed this frame (at most once per frame). */
  cameraMoved: CameraState;

  /** App: command mode starting (after the dive, before the first command frame). */
  commandEnter: { params: CommandEnterParams };
  /** Command mode -> app: the player wants out (Esc) or the unit died. App performs the exit. */
  commandExitRequested: { reason: 'player' | 'killed' | 'objective' };
  /** App: command mode finished; result already sent to the sim. */
  commandExit: { result: CommandResult };

  /** UI -> audio: interface sound. */
  uiSound: { kind: UiSoundKind };
  /** Anyone -> UI news ticker (UI also builds its own news from sim events). */
  news: { text: string; severity: NewsSeverity; lat?: number; lon?: number };
  /** Anyone -> UI toast. */
  toast: { text: string; kind: 'info' | 'success' | 'warning' | 'danger'; durationMs?: number };
  /** Sim client: a nuke was launched at a tile owned by the human (sirens, alarm UI). */
  nukeAlarm: { unitId: number; targetTile: number; etaSec: number; weapon: NukeWeapon };
  /** App: a ?shot= scene finished staging. */
  shotStaged: { name: string };
}

/** The complete main-thread vocabulary: app events + every sim event (keyed by SimEvent.type). */
export type GameEvents = AppEvents & SimEventMap;
export type GameEventName = keyof GameEvents;
export type GameBus = EventBus<GameEvents>;
