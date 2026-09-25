// FRONT ULTRA — screenshot staging registry (?shot=<name>).
// Owner: shared. Each owner registers its shots from `src/<dir>/shots.ts` (imported by src/app/shots.ts).
// The app runs the stager after loading finished (menu state, audio muted), waits `settleFrames` frames,
// then sets window.__shotReady = true which tools/capture.mjs waits for.
//
// Stagers must be deterministic: fixed seeds (ctx.app.startScriptedGame), fixed camera (ctx.cameraRig.setState),
// fixed world time, speed 0 when motion would make the image non-reproducible.

import type { GameContext } from './api';
import type { CloudMode } from './settings';

export type ShotOwner =
  | 'data' | 'sim-core' | 'sim-ai' | 'globe' | 'units' | 'battle' | 'command' | 'ui' | 'audio' | 'app' | 'shared';

export interface ShotContext {
  readonly ctx: GameContext;
  /** URL params (extra knobs like &tick=3000 or &lat=40&lon=-3). */
  readonly params: URLSearchParams;
  waitFrames(n: number): Promise<void>;
  wait(ms: number): Promise<void>;
  /** Hide/show the whole DOM UI (pure 3D beauty shots). */
  setUiVisible(visible: boolean): void;
}

export interface ShotDef {
  name: string;
  owner: ShotOwner;
  description: string;
  /** Frames to render after the stager resolves before __shotReady (default 30). */
  settleFrames: number;
  stage: (s: ShotContext) => Promise<void>;
}

const registry = new Map<string, ShotDef>();

export function registerShot(
  name: string,
  owner: ShotOwner,
  description: string,
  stage: (s: ShotContext) => Promise<void>,
  settleFrames = 30,
): void {
  if (registry.has(name)) console.warn(`[shots] "${name}" registered twice; last one wins`);
  registry.set(name, { name, owner, description, stage, settleFrames });
}

export function getShot(name: string): ShotDef | undefined {
  return registry.get(name);
}

export function listShots(): ShotDef[] {
  return [...registry.values()];
}

/** The ?shot= value, or null. */
export function shotNameFromUrl(): string | null {
  try {
    return new URLSearchParams(location.search).get('shot');
  } catch {
    return null;
  }
}

export function shotParams(): URLSearchParams {
  try {
    return new URLSearchParams(location.search);
  } catch {
    return new URLSearchParams();
  }
}

// =================================================================================================
// Measurement view flags (DESIGN_V2 §14.8, §16.3). Read once from the URL of a ?shot= page and adjustable at
// runtime through window.__shotView (tools/readability.mjs captures every variant of one staged frame).
//   &freeze=1       fixed presentation time (shader animation, film grain, pulses), cloud offset and sun
//   &territory=0    the ground shows no territory overlay (fills, borders, stripes); labels and icons stay
//   &clouds=hidden|strategic|realistic   force a cloud mode
//   &mask=owner     the same frame as flat owner-id false colour (see OWNER_MASK below), nothing else drawn
// =================================================================================================

export type ShotMask = 'owner' | null;

export interface ShotView {
  freeze: boolean;
  territory: boolean;
  clouds: CloudMode | null;
  mask: ShotMask;
  /** Incremented on every change (consumers re-apply their state). */
  rev: number;
}

/**
 * Owner-mask encoding written by the ground shader in &mask=owner (exact 8-bit values, no tone mapping):
 *   space / sky                  (0, 0, 0)
 *   water                        (0, 0, 40)
 *   ice / unplayable land        (0, 0, 80)
 *   neutral land                 (0, 0, 120)
 *   owned land                   (owner & 255, owner >> 8, 160)
 * +20 on blue on the night side (sun below the horizon): class = floor(B / 40), night = B % 40 >= 20.
 * tools/readability.mjs decodes it.
 */
export const OWNER_MASK = { water: 40, ice: 80, neutral: 120, owned: 160, night: 20 } as const;

/** Presentation time (s) used while frozen: every time-driven shader animation shows the same frame. */
export const FROZEN_TIME_SEC = 1000;

function parseShotView(): ShotView {
  const v: ShotView = { freeze: false, territory: true, clouds: null, mask: null, rev: 0 };
  try {
    const q = new URLSearchParams(location.search);
    if (!q.get('shot')) return v;
    v.freeze = q.get('freeze') === '1';
    v.territory = q.get('territory') !== '0';
    const c = q.get('clouds');
    if (c === 'hidden' || c === 'strategic' || c === 'realistic') v.clouds = c;
    if (q.get('mask') === 'owner') v.mask = 'owner';
  } catch {
    /* no location (worker/tests) */
  }
  return v;
}

export const shotView: ShotView = parseShotView();

/** Change measurement flags at runtime (tools). */
export function setShotView(patch: Partial<Omit<ShotView, 'rev'>>): void {
  Object.assign(shotView, patch);
  shotView.rev++;
}

/** Real seconds for presentation animation, or a constant while &freeze=1. */
export function presentationTime(realSec: number): number {
  return shotView.freeze ? FROZEN_TIME_SEC : realSec;
}

declare global {
  interface Window {
    __shotView?: { get(): ShotView; set(patch: Partial<Omit<ShotView, 'rev'>>): void };
    __shotReady?: boolean;
    __ready?: boolean;
    __fps?: number;
    __shotError?: string;
  }
}

if (typeof window !== 'undefined') {
  window.__shotView = { get: () => ({ ...shotView }), set: setShotView };
}

export function markShotReady(): void {
  window.__shotReady = true;
}

/**
 * Run the stager for ?shot=<name>. Called by app once loading completed. Returns false when there is no
 * ?shot= param. Unknown names log an error, set window.__shotError and still mark ready (so capture ends).
 */
export async function runShotFromUrl(ctx: GameContext, waitFrames: (n: number) => Promise<void>): Promise<boolean> {
  const name = shotNameFromUrl();
  if (!name) return false;
  const def = registry.get(name);
  const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  if (!def) {
    const msg = `[shots] unknown shot "${name}". Known: ${[...registry.keys()].join(', ')}`;
    console.error(msg);
    window.__shotError = msg;
    markShotReady();
    return true;
  }
  try {
    const setUiVisible = (v: boolean) => {
      ctx.uiRoot.style.visibility = v ? 'visible' : 'hidden';
    };
    if (shotParams().get('hud') === '0') setUiVisible(false);
    await def.stage({ ctx, params: shotParams(), waitFrames, wait, setUiVisible });
    await waitFrames(def.settleFrames);
    ctx.bus.emit('shotStaged', { name });
  } catch (err) {
    console.error(`[shots] stager "${name}" failed`, err);
    window.__shotError = String(err);
  }
  markShotReady();
  return true;
}
