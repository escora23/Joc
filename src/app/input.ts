// FRONT ULTRA — input router (owner: app).
// Turns canvas pointer events into 'worldClick' / 'worldHover' bus events with picking resolved
// (unit > structure > tile). The camera rig handles drags/wheel/keys itself; a pointer that moved more
// than CLICK_SLOP px or was held longer than CLICK_MS is a drag, not a click.

import type { GameContext } from '../shared/api';
import type { WorldPointerEvent } from '../shared/events';
import { latLonToTile } from '../shared/geo';
import type { LatLon } from '../shared/types';

const CLICK_SLOP = 6;
const CLICK_MS = 450;

export interface InputRouter {
  setEnabled(on: boolean): void;
  update(): void;
}

export function createInputRouter(ctx: GameContext): InputRouter {
  const canvas = ctx.canvas;
  let enabled = false;
  let down: { x: number; y: number; t: number; button: number } | null = null;
  let hover: { x: number; y: number; shift: boolean; ctrl: boolean; alt: boolean } | null = null;
  let hoverDirty = false;
  const ll: LatLon = { lat: 0, lon: 0 };

  function pick(button: number, x: number, y: number, shift: boolean, ctrl: boolean, alt: boolean): WorldPointerEvent {
    const hit = ctx.globe.pickLatLon(x, y, ll);
    const tile = hit ? latLonToTile(hit.lat, hit.lon) : -1;
    const unitId = ctx.units.pickUnit(x, y);
    const structureId = unitId >= 0 ? -1 : ctx.units.pickStructure(x, y);
    return {
      button, tile, lat: hit ? hit.lat : 0, lon: hit ? hit.lon : 0, unitId, structureId,
      clientX: x, clientY: y, shift, ctrl, alt,
    };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!enabled || !d || d.button !== e.button) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (moved > CLICK_SLOP || performance.now() - d.t > CLICK_MS) return;
    ctx.bus.emit('worldClick', pick(e.button, e.clientX, e.clientY, e.shiftKey, e.ctrlKey || e.metaKey, e.altKey));
  });
  canvas.addEventListener('pointermove', (e) => {
    hover = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
    hoverDirty = true;
  });
  canvas.addEventListener('pointerleave', () => {
    hover = null;
    hoverDirty = true;
  });
  ctx.bus.on('cameraMoved', () => (hoverDirty = true));

  return {
    setEnabled(on) {
      enabled = on;
      if (!on) down = null;
    },
    update() {
      if (!enabled || !hoverDirty) return;
      hoverDirty = false;
      const e = hover
        ? pick(-1, hover.x, hover.y, hover.shift, hover.ctrl, hover.alt)
        : { button: -1, tile: -1, lat: 0, lon: 0, unitId: -1, structureId: -1, clientX: -1, clientY: -1, shift: false, ctrl: false, alt: false };
      ctx.globe.setHoverTile(e.tile);
      ctx.bus.emit('worldHover', e);
    },
  };
}
