// FRONT ULTRA — screenshot staging registry (?shot=<name>).
// Owner: shared. Each owner registers its shots from `src/<dir>/shots.ts` (imported by src/app/shots.ts).
// The app runs the stager after loading finished (menu state, audio muted), waits `settleFrames` frames,
// then sets window.__shotReady = true which tools/capture.mjs waits for.
//
// Stagers must be deterministic: fixed seeds (ctx.app.startScriptedGame), fixed camera (ctx.cameraRig.setState),
// fixed world time, speed 0 when motion would make the image non-reproducible.

import type { GameContext } from './api';

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

declare global {
  interface Window {
    __shotReady?: boolean;
    __ready?: boolean;
    __fps?: number;
    __shotError?: string;
  }
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
