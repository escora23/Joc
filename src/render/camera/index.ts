// FRONT ULTRA — strategic camera rig (owner: globe).
// STUB by the architect: orbit camera around a target lat/lon with altitude/tilt/heading, drag + wheel +
// keyboard input with inertia, flyTo, shake, dynamic near/far, cameraMoved events.
// The globe owner replaces it with the full seamless orbit -> ground camera (terrain-aware, horizon tilt,
// collision with relief, cinematic curves). Keep the export: createCameraRig(ctx): CameraRigApi.

import * as THREE from 'three';
import type { CameraMode, CameraRigApi, CameraState, FrameInfo, GameContext } from '../../shared/api';
import { CAMERA_MAX_ALT_KM, CAMERA_MIN_ALT_KM, EARTH_RADIUS_KM } from '../../shared/constants';
import { kmToUnits, latLonToVec3, tangentFrame } from '../../shared/geo';
import { clamp, damp, easeInOutCubic, lerp } from '../../shared/math';

export function createCameraRig(ctx: GameContext): CameraRigApi {
  const camera = ctx.camera;
  const state: CameraState = { lat: 25, lon: 0, altitudeKm: 16_000, tilt: 0, heading: 0 };
  const goal: CameraState = { ...state };
  let mode: CameraMode = 'menu';
  let inputEnabled = true;
  let flight: { from: CameraState; to: CameraState; t: number; dur: number; resolve: () => void } | null = null;
  let shakeAmp = 0, shakeUntil = 0, shakeDur = 1;
  const keys = new Set<string>();
  const last: CameraState = { lat: NaN, lon: NaN, altitudeKm: NaN, tilt: NaN, heading: NaN };

  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  const target = new THREE.Vector3(), fwd = new THREE.Vector3(), offset = new THREE.Vector3();

  // ---- input -----------------------------------------------------------------------------------
  let dragging: { button: number; x: number; y: number } | null = null;
  const el = ctx.canvas;
  el.addEventListener('pointerdown', (e) => {
    if (!inputEnabled || mode !== 'game') return;
    dragging = { button: e.button, x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => (dragging = null));
  window.addEventListener('pointermove', (e) => {
    if (!dragging || !inputEnabled || mode !== 'game') return;
    const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    const sens = ctx.settings.get().mouseSensitivity;
    if (dragging.button === 0) {
      const degPerPx = (goal.altitudeKm / EARTH_RADIUS_KM) * 0.09 * sens;
      const c = Math.cos(goal.heading), s = Math.sin(goal.heading);
      goal.lat = clamp(goal.lat + (dy * c + dx * s) * degPerPx, -85, 85);
      goal.lon -= (dx * c - dy * s) * degPerPx / Math.max(0.2, Math.cos((goal.lat * Math.PI) / 180));
    } else if (dragging.button === 2 || dragging.button === 1) {
      goal.heading += dx * 0.005 * sens;
      goal.tilt = clamp(goal.tilt + dy * 0.005 * sens, 0, maxTilt(goal.altitudeKm));
    }
  });
  el.addEventListener('wheel', (e) => {
    if (!inputEnabled || mode !== 'game' || e.shiftKey) return;
    e.preventDefault();
    goal.altitudeKm = clamp(goal.altitudeKm * Math.exp(e.deltaY * 0.0012), CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
    goal.tilt = Math.min(goal.tilt, maxTilt(goal.altitudeKm));
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  ctx.bus.on('focusRequest', (r) => {
    void api.flyTo({ lat: r.lat, lon: r.lon, altitudeKm: r.altitudeKm ?? Math.min(goal.altitudeKm, 3000) }, r.durationMs ?? 1600);
  });

  function maxTilt(altKm: number): number {
    // Tilt toward the horizon as we descend.
    return lerp(1.35, 0.0, clamp(Math.log10(altKm / 50) / Math.log10(20_000 / 50), 0, 1));
  }

  function place(s: CameraState, frame?: FrameInfo): void {
    tangentFrame(s.lat, s.lon, east, north, up);
    latLonToVec3(s.lat, s.lon, 1, target);
    fwd.copy(north).multiplyScalar(Math.cos(s.heading)).addScaledVector(east, Math.sin(s.heading));
    const d = kmToUnits(s.altitudeKm);
    offset.copy(up).multiplyScalar(Math.cos(s.tilt) * d).addScaledVector(fwd, -Math.sin(s.tilt) * d);
    camera.position.copy(target).add(offset);
    if (frame && shakeAmp > 0 && frame.now < shakeUntil) {
      const k = shakeAmp * ((shakeUntil - frame.now) / shakeDur) * d * 0.02;
      camera.position.x += (Math.random() - 0.5) * k;
      camera.position.y += (Math.random() - 0.5) * k;
      camera.position.z += (Math.random() - 0.5) * k;
    }
    camera.up.copy(s.tilt < 0.01 ? fwd : up);
    camera.lookAt(target);
    camera.near = Math.max(1e-6, d * 0.02);
    camera.far = 200;
    camera.updateProjectionMatrix();
  }

  const api: CameraRigApi = {
    camera,
    get mode() {
      return mode;
    },
    async init(progress) {
      place(state);
      progress(1);
    },
    update(frame: FrameInfo) {
      const dt = frame.dt;
      if (mode === 'menu') {
        goal.lon += dt * 2.2;
        state.lon = goal.lon;
      }
      if (flight) {
        flight.t += (dt * 1000) / flight.dur;
        const k = easeInOutCubic(Math.min(1, flight.t));
        state.lat = lerp(flight.from.lat, flight.to.lat, k);
        let dl = flight.to.lon - flight.from.lon;
        dl = ((dl + 540) % 360) - 180;
        state.lon = flight.from.lon + dl * k;
        state.altitudeKm = Math.exp(lerp(Math.log(flight.from.altitudeKm), Math.log(flight.to.altitudeKm), k));
        state.tilt = lerp(flight.from.tilt, flight.to.tilt, k);
        state.heading = lerp(flight.from.heading, flight.to.heading, k);
        Object.assign(goal, state);
        if (flight.t >= 1) {
          const f = flight;
          flight = null;
          f.resolve();
        }
      } else {
        if (mode === 'game' && inputEnabled) {
          const pan = (goal.altitudeKm / EARTH_RADIUS_KM) * 40 * dt;
          if (keys.has('KeyW') || keys.has('ArrowUp')) goal.lat = clamp(goal.lat + pan * Math.cos(goal.heading), -85, 85);
          if (keys.has('KeyS') || keys.has('ArrowDown')) goal.lat = clamp(goal.lat - pan * Math.cos(goal.heading), -85, 85);
          if (keys.has('KeyA') || keys.has('ArrowLeft')) goal.lon -= pan;
          if (keys.has('KeyD') || keys.has('ArrowRight')) goal.lon += pan;
          if (keys.has('KeyQ')) goal.heading -= dt * 1.2;
          if (keys.has('KeyE')) goal.heading += dt * 1.2;
          if (keys.has('KeyR')) goal.altitudeKm = clamp(goal.altitudeKm * Math.exp(-dt * 1.5), CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
          if (keys.has('KeyF')) goal.altitudeKm = clamp(goal.altitudeKm * Math.exp(dt * 1.5), CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
        }
        state.lat = damp(state.lat, goal.lat, 10, dt);
        state.lon = damp(state.lon, goal.lon, 10, dt);
        state.altitudeKm = Math.exp(damp(Math.log(state.altitudeKm), Math.log(goal.altitudeKm), 8, dt));
        state.tilt = damp(state.tilt, goal.tilt, 8, dt);
        state.heading = damp(state.heading, goal.heading, 8, dt);
      }
      place(state, frame);
      if (state.lat !== last.lat || state.lon !== last.lon || state.altitudeKm !== last.altitudeKm || state.tilt !== last.tilt || state.heading !== last.heading) {
        Object.assign(last, state);
        ctx.bus.emit('cameraMoved', { ...state });
      }
    },
    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
    getState(out) {
      return Object.assign(out ?? ({} as CameraState), state);
    },
    setState(s) {
      flight?.resolve();
      flight = null;
      Object.assign(state, s);
      Object.assign(goal, state);
      place(state);
    },
    flyTo(to, durationMs = 1800) {
      flight?.resolve();
      return new Promise<void>((resolve) => {
        flight = { from: { ...state }, to: { ...state, ...to }, t: 0, dur: Math.max(1, durationMs), resolve };
      });
    },
    shake(intensity, durationMs) {
      if (!ctx.settings.get().screenShake) return;
      shakeAmp = Math.max(shakeAmp * (shakeUntil > performance.now() ? 1 : 0), intensity);
      shakeDur = durationMs;
      shakeUntil = performance.now() + durationMs;
    },
    setMode(m) {
      mode = m;
    },
    setInputEnabled(on) {
      inputEnabled = on;
      if (!on) dragging = null;
    },
  };
  return api;
}
