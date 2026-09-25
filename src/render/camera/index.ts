// FRONT ULTRA — strategic camera rig (owner: globe).
// Seamless orbit -> ground camera:
//   * grab-to-pan (the point under the cursor stays under the cursor) with release inertia,
//   * zoom to cursor with smooth log-space damping, auto-tilt toward the horizon while descending,
//   * right/middle drag: heading & tilt; WASD/arrows pan, Q/E rotate, R/F zoom; double-click flies there,
//   * cinematic flyTo (great-circle path, altitude hump on long hops, eased tilt/heading),
//   * trauma-based smooth shake, relief-aware ground clearance, dynamic near/far,
//   * menu mode: a slow cinematic three-quarter shot that tracks the sun (crescent, limb glow, sun on the
//     limb), blended smoothly into the game camera when a session starts.
// CameraState.altitudeKm is the distance from the camera to the ground target point (as in the contract).

import * as THREE from 'three';
import type { CameraMode, CameraRigApi, CameraState, FrameInfo, GameContext } from '../../shared/api';
import { CAMERA_MAX_ALT_KM, CAMERA_MIN_ALT_KM, EARTH_RADIUS_KM } from '../../shared/constants';
import { DEG, kmToUnits, latLonToVec3, slerpLatLon, sunDirection, tangentFrame, vec3ToLatLon } from '../../shared/geo';
import { angleDelta, clamp, damp, lerp, smoothstep } from '../../shared/math';
import type { LatLon } from '../../shared/types';

interface Flight {
  from: CameraState;
  to: CameraState;
  t: number;
  dur: number;
  hump: number;
  resolve: () => void;
}

const LOG_MIN = Math.log(CAMERA_MIN_ALT_KM);
/** Menu composition: camera distance (planet radii) and the screen angle of the sun around the planet. */
const MENU_DIST = 1.62;
const MENU_LAT = 28;
const MENU_LON_OFFSET = 167;
const MENU_LOOK_UP = 0.52;
const MENU_ROLL = 0.2;
const LOG_MAX = Math.log(CAMERA_MAX_ALT_KM);

/** Tilt the camera gets automatically at an altitude (0 above ~3000 km, toward the horizon near the ground). */
export function autoTilt(altKm: number): number {
  const t = clamp((Math.log10(3000) - Math.log10(Math.max(altKm, 0.1))) / (Math.log10(3000) - Math.log10(2)), 0, 1);
  return 1.22 * Math.pow(t, 1.15);
}

/** Max tilt allowed at an altitude. */
export function maxTilt(altKm: number): number {
  const k = smoothstep(Math.log(5), Math.log(14_000), Math.log(Math.max(altKm, 0.1)));
  return lerp(1.45, 0.5, k);
}

/** Optional override of the world time used by the menu composition (globe shots). */
let menuTimeOverride: number | null = null;
export function setMenuWorldTimeOverride(t: number | null): void {
  menuTimeOverride = t;
}

export function createCameraRig(ctx: GameContext): CameraRigApi {
  const camera = ctx.camera;
  camera.fov = 45;
  const state: CameraState = { lat: 25, lon: 0, altitudeKm: 16_000, tilt: 0, heading: 0 };
  const goal: CameraState = { ...state };
  let mode: CameraMode = 'menu';
  let inputEnabled = true;
  let flight: Flight | null = null;
  let menuBlend = 1;
  const last: CameraState = { lat: NaN, lon: NaN, altitudeKm: NaN, tilt: NaN, heading: NaN };
  const keys = new Set<string>();

  // Shake (trauma model).
  let trauma = 0, traumaDecay = 1;
  let shakeTime = 0;

  // Ground target radius (smoothed to avoid pops on relief).
  let targetR = 1;

  // Scratch.
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  const target = new THREE.Vector3(), fwd = new THREE.Vector3(), offset = new THREE.Vector3(), camUp = new THREE.Vector3();
  const rigPos = new THREE.Vector3(), rigQuat = new THREE.Quaternion();
  const menuPos = new THREE.Vector3(), menuQuat = new THREE.Quaternion();
  const m4 = new THREE.Matrix4();
  const sun = new THREE.Vector3();
  const tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
  const ll: LatLon = { lat: 0, lon: 0 }, ll2: LatLon = { lat: 0, lon: 0 };
  const shakeEuler = new THREE.Euler();
  const shakeQ = new THREE.Quaternion();
  const viewSize = new THREE.Vector2();

  // ---- input -----------------------------------------------------------------------------------
  interface Drag {
    button: number;
    x: number;
    y: number;
    lastX: number;
    lastY: number;
    grab: LatLon | null;
    moved: boolean;
  }
  let drag: Drag | null = null;
  let dragPending = false;
  const panVel = { lat: 0, lon: 0 };
  let lastMoveT = 0;
  const el = ctx.canvas;
  const active = () => inputEnabled && mode === 'game';

  el.addEventListener('pointerdown', (e) => {
    if (!active()) return;
    const grab = e.button === 0 ? ctx.globe.pickLatLon(e.clientX, e.clientY, { lat: 0, lon: 0 }) : null;
    drag = { button: e.button, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, grab, moved: false };
    panVel.lat = 0;
    panVel.lon = 0;
    flight?.resolve();
    flight = null;
  });
  window.addEventListener('pointerup', () => {
    if (drag && drag.button === 0 && performance.now() - lastMoveT > 90) {
      panVel.lat = 0;
      panVel.lon = 0;
    }
    drag = null;
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || !active()) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    dragPending = true;
  });
  el.addEventListener('wheel', (e) => {
    if (!active() || e.shiftKey) return;
    e.preventDefault();
    flight?.resolve();
    flight = null;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    zoomAt(e.clientX, e.clientY, Math.exp(clamp(dy, -400, 400) * 0.0016));
  }, { passive: false });
  el.addEventListener('dblclick', (e) => {
    if (!active()) return;
    const p = ctx.globe.pickLatLon(e.clientX, e.clientY, { lat: 0, lon: 0 });
    if (!p) return;
    const alt = clamp(goal.altitudeKm * 0.35, 3, CAMERA_MAX_ALT_KM);
    void api.flyTo({ lat: p.lat, lon: p.lon, altitudeKm: alt, tilt: Math.min(maxTilt(alt), Math.max(goal.tilt, autoTilt(alt))) }, 1400);
  });
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    keys.add(e.code);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  ctx.bus.on('focusRequest', (r) => {
    const alt = r.altitudeKm ?? Math.min(goal.altitudeKm, 3000);
    void api.flyTo({ lat: r.lat, lon: r.lon, altitudeKm: alt, tilt: Math.min(goal.tilt, maxTilt(alt)) }, r.durationMs ?? 1600);
  });

  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const oldAlt = goal.altitudeKm;
    const newAlt = clamp(oldAlt * factor, CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
    if (newAlt === oldAlt) return;
    const p = ctx.globe.pickLatLon(clientX, clientY, ll2);
    if (p) {
      // Move the target toward (zoom in) or away from (zoom out) the point under the cursor.
      const f = clamp(1 - newAlt / oldAlt, -1.5, 0.9);
      if (f > 0) {
        slerpLatLon(goal, p, f, ll);
        goal.lat = clamp(ll.lat, -88, 88);
        goal.lon = ll.lon;
      } else {
        goal.lat = clamp(goal.lat + (goal.lat - p.lat) * -f * 0.5, -88, 88);
        goal.lon += angleDeltaDeg(p.lon, goal.lon) * -f * 0.5;
      }
    }
    goal.tilt = clamp(goal.tilt + autoTilt(newAlt) - autoTilt(oldAlt), 0, maxTilt(newAlt));
    goal.altitudeKm = newAlt;
  }

  function angleDeltaDeg(a: number, b: number): number {
    let d = b - a;
    d -= 360 * Math.floor((d + 180) / 360);
    return d;
  }

  function processDrag(dt: number): void {
    if (!drag || !dragPending) return;
    dragPending = false;
    const d = drag;
    const dx = d.x - d.lastX, dy = d.y - d.lastY;
    d.lastX = d.x;
    d.lastY = d.y;
    if (dx === 0 && dy === 0) return;
    d.moved = true;
    const sens = ctx.settings.get().mouseSensitivity;
    if (d.button === 0) {
      const beforeLat = goal.lat, beforeLon = goal.lon;
      const cur = d.grab ? ctx.globe.pickLatLon(d.x, d.y, ll) : null;
      if (d.grab && cur) {
        goal.lat = clamp(goal.lat + (d.grab.lat - cur.lat), -88, 88);
        goal.lon += angleDeltaDeg(cur.lon, d.grab.lon);
      } else {
        const degPerPx = (goal.altitudeKm / EARTH_RADIUS_KM) * 0.07 * (180 / Math.PI) * 0.02 * sens;
        const c = Math.cos(goal.heading), s = Math.sin(goal.heading);
        goal.lat = clamp(goal.lat + (dy * c + dx * s) * degPerPx, -88, 88);
        goal.lon -= ((dx * c - dy * s) * degPerPx) / Math.max(0.2, Math.cos(goal.lat * DEG));
      }
      // Snap the view to the grab (no lag while dragging) and measure velocity for inertia.
      state.lat = goal.lat;
      state.lon = goal.lon;
      const idt = Math.max(dt, 1 / 240);
      const vLat = (goal.lat - beforeLat) / idt, vLon = angleDeltaDeg(beforeLon, goal.lon) / idt;
      panVel.lat = lerp(panVel.lat, vLat, 0.5);
      panVel.lon = lerp(panVel.lon, vLon, 0.5);
      lastMoveT = performance.now();
    } else {
      goal.heading += dx * 0.005 * sens;
      goal.tilt = clamp(goal.tilt + dy * 0.004 * sens, 0, maxTilt(goal.altitudeKm));
    }
  }

  // ---- placement ------------------------------------------------------------------------------
  function rigPose(s: CameraState, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    tangentFrame(s.lat, s.lon, east, north, up);
    const gr = ctx.globe.surfaceRadiusAt(s.lat, s.lon);
    targetR = Math.abs(targetR - gr) > 0.01 ? gr : targetR + (gr - targetR) * 0.25;
    target.copy(up).multiplyScalar(targetR);
    fwd.copy(north).multiplyScalar(Math.cos(s.heading)).addScaledVector(east, Math.sin(s.heading));
    const d = kmToUnits(s.altitudeKm);
    const tilt = s.tilt;
    offset.copy(up).multiplyScalar(Math.cos(tilt) * d).addScaledVector(fwd, -Math.sin(tilt) * d);
    outPos.copy(target).add(offset);
    // Keep clear of the relief (and never under the sea surface).
    vec3ToLatLon(outPos, ll);
    const ground = Math.max(1, ctx.globe.surfaceRadiusAt(ll.lat, ll.lon)) + kmToUnits(0.12);
    const r = outPos.length();
    if (r < ground) outPos.multiplyScalar(ground / r);
    camUp.copy(fwd).multiplyScalar(Math.cos(tilt)).addScaledVector(up, Math.sin(tilt)).normalize();
    m4.lookAt(outPos, target, camUp);
    outQuat.setFromRotationMatrix(m4);
  }

  // Menu: camera ~148 degrees around the polar axis from the sun, so the sun sits just off the limb.
  function menuPose(worldTime: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
    sunDirection(worldTime, sun);
    const sunLon = Math.atan2(-sun.z, sun.x) / DEG;
    // Low orbit, ~130 degrees around from the sun: the curved limb crosses the lower screen, the sun rises just
    // beyond it and the night side below shows the city lights.
    latLonToVec3(MENU_LAT, sunLon - MENU_LON_OFFSET, MENU_DIST, outPos);
    tmpV.copy(outPos).multiplyScalar(-1).normalize(); // toward the planet centre
    tmpV2.copy(sun).addScaledVector(tmpV, -sun.dot(tmpV)).normalize(); // toward the sun, in the screen plane
    // Look up from the centre toward the sun side so the limb sits in the lower part of the frame.
    offset.copy(tmpV).multiplyScalar(Math.cos(MENU_LOOK_UP)).addScaledVector(tmpV2, Math.sin(MENU_LOOK_UP));
    camUp.copy(tmpV2).addScaledVector(offset, -tmpV2.dot(offset)).normalize();
    // A slight roll so the horizon is not perfectly symmetric.
    camUp.applyAxisAngle(offset, MENU_ROLL);
    target.copy(outPos).add(offset);
    m4.lookAt(outPos, target, camUp);
    outQuat.setFromRotationMatrix(m4);
  }

  function nearFar(): void {
    const r = camera.position.length();
    vec3ToLatLon(camera.position, ll);
    const ground = ctx.globe.surfaceRadiusAt(ll.lat, ll.lon);
    const h = Math.max(r - ground, 1e-6);
    camera.near = clamp(h * 0.25, 1.5e-6, 0.4);
    const horizon = Math.sqrt(Math.max(r * r - 1, 0));
    camera.far = Math.max(horizon + 1.4, camera.near * 10);
  }

  function applyShake(dt: number, alt: number): void {
    if (trauma <= 0) return;
    shakeTime += dt;
    const k = trauma * trauma;
    const t = shakeTime * 22;
    const n1 = Math.sin(t * 1.13) * 0.6 + Math.sin(t * 2.71 + 1.3) * 0.4;
    const n2 = Math.sin(t * 1.37 + 2.1) * 0.6 + Math.sin(t * 3.07 + 0.7) * 0.4;
    const n3 = Math.sin(t * 0.91 + 4.2) * 0.6 + Math.sin(t * 2.33 + 2.9) * 0.4;
    shakeEuler.set(n1 * 0.035 * k, n2 * 0.035 * k, n3 * 0.05 * k);
    shakeQ.setFromEuler(shakeEuler);
    camera.quaternion.multiply(shakeQ);
    const posAmp = kmToUnits(alt) * 0.012 * k;
    camera.position.x += n2 * posAmp;
    camera.position.y += n3 * posAmp;
    camera.position.z += n1 * posAmp;
    trauma = Math.max(0, trauma - dt * traumaDecay);
  }

  function updateViewOffset(): void {
    ctx.renderer.getSize(viewSize);
    const W = viewSize.x, H = viewSize.y;
    if (menuBlend > 0.001 && W > 0 && H > 0) {
      // Push the planet to the right third on the menu (UI panels live on the left).
      camera.setViewOffset(W, H, -W * 0.06 * menuBlend, 0, W, H);
    } else if (camera.view && camera.view.enabled) {
      camera.clearViewOffset();
    }
  }

  function stepFlight(dt: number): void {
    const f = flight;
    if (!f) return;
    f.t += (dt * 1000) / f.dur;
    const k = Math.min(1, f.t);
    // Cinematic ease: slow start, confident middle, soft landing.
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const ep = 1 - Math.pow(1 - e, 1.4);
    slerpLatLon(f.from, f.to, ep, ll);
    state.lat = ll.lat;
    state.lon = ll.lon;
    const la = lerp(Math.log(f.from.altitudeKm), Math.log(f.to.altitudeKm), e);
    state.altitudeKm = clamp(Math.exp(la) + f.hump * Math.sin(Math.PI * e), CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
    state.tilt = lerp(f.from.tilt, f.to.tilt, e);
    state.heading = f.from.heading + angleDelta(f.from.heading, f.to.heading) * e;
    Object.assign(goal, state);
    if (f.t >= 1) {
      flight = null;
      f.resolve();
    }
  }

  const api: CameraRigApi = {
    camera,
    get mode() {
      return mode;
    },
    async init(progress) {
      rigPose(state, camera.position, camera.quaternion);
      progress(1);
    },
    update(frame: FrameInfo) {
      const dt = frame.dt;
      processDrag(dt);
      if (flight) {
        stepFlight(dt);
      } else {
        if (mode === 'game' && inputEnabled) {
          const pan = (goal.altitudeKm / EARTH_RADIUS_KM) * 32 * dt;
          const c = Math.cos(goal.heading), s = Math.sin(goal.heading);
          let fwdIn = 0, sideIn = 0;
          if (keys.has('KeyW') || keys.has('ArrowUp')) fwdIn += 1;
          if (keys.has('KeyS') || keys.has('ArrowDown')) fwdIn -= 1;
          if (keys.has('KeyD') || keys.has('ArrowRight')) sideIn += 1;
          if (keys.has('KeyA') || keys.has('ArrowLeft')) sideIn -= 1;
          if (fwdIn || sideIn) {
            goal.lat = clamp(goal.lat + (fwdIn * c - sideIn * s) * pan, -88, 88);
            goal.lon += ((fwdIn * s + sideIn * c) * pan) / Math.max(0.15, Math.cos(goal.lat * DEG));
            panVel.lat = 0;
            panVel.lon = 0;
          }
          if (keys.has('KeyQ')) goal.heading -= dt * 1.3;
          if (keys.has('KeyE')) goal.heading += dt * 1.3;
          if (keys.has('KeyR')) zoomAt(window.innerWidth / 2, window.innerHeight / 2, Math.exp(-dt * 1.6));
          if (keys.has('KeyF')) zoomAt(window.innerWidth / 2, window.innerHeight / 2, Math.exp(dt * 1.6));
        }
        // Release inertia.
        if (!drag && (panVel.lat !== 0 || panVel.lon !== 0)) {
          goal.lat = clamp(goal.lat + panVel.lat * dt, -88, 88);
          goal.lon += panVel.lon * dt;
          const fr = Math.exp(-3.8 * dt);
          panVel.lat *= fr;
          panVel.lon *= fr;
          if (Math.abs(panVel.lat) + Math.abs(panVel.lon) < 1e-3) panVel.lat = panVel.lon = 0;
        }
        goal.tilt = Math.min(goal.tilt, maxTilt(goal.altitudeKm));
        state.lat = damp(state.lat, goal.lat, 12, dt);
        const dl = angleDeltaDeg(state.lon, goal.lon);
        state.lon = state.lon + dl - dl * Math.exp(-12 * dt);
        const ls = Math.log(state.altitudeKm), lg = Math.log(goal.altitudeKm);
        state.altitudeKm = Math.exp(clamp(damp(ls, lg, 7, dt), LOG_MIN, LOG_MAX));
        state.tilt = damp(state.tilt, goal.tilt, 7, dt);
        state.heading = damp(state.heading, goal.heading, 8, dt);
      }
      state.lon = ((((state.lon + 180) % 360) + 360) % 360) - 180;
      if (Math.abs(goal.lon - state.lon) > 180) goal.lon = state.lon + angleDeltaDeg(state.lon, goal.lon);

      // Menu blend (smooth hand-off between the menu composition and the rig).
      menuBlend = damp(menuBlend, mode === 'menu' ? 1 : 0, 2.2, dt);
      if (menuBlend < 0.002) menuBlend = 0;
      if (menuBlend > 0.998) menuBlend = 1;

      rigPose(state, rigPos, rigQuat);
      if (menuBlend > 0) {
        menuPose(menuTimeOverride ?? frame.worldTime, menuPos, menuQuat);
        if (mode === 'menu') {
          // Keep the rig parked where the menu camera is so leaving the menu starts from there.
          vec3ToLatLon(menuPos, ll);
          state.lat = goal.lat = ll.lat;
          state.lon = goal.lon = ll.lon;
          state.altitudeKm = goal.altitudeKm = (menuPos.length() - 1) * EARTH_RADIUS_KM;
          state.tilt = goal.tilt = 0;
          rigPose(state, rigPos, rigQuat);
        }
        const b = menuBlend * menuBlend * (3 - 2 * menuBlend);
        camera.position.copy(rigPos).lerp(menuPos, b);
        camera.quaternion.copy(rigQuat).slerp(menuQuat, b);
      } else {
        camera.position.copy(rigPos);
        camera.quaternion.copy(rigQuat);
      }
      applyShake(dt, state.altitudeKm);
      camera.updateMatrixWorld();
      nearFar();
      updateViewOffset();
      camera.updateProjectionMatrix();

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
      state.altitudeKm = clamp(state.altitudeKm, CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
      Object.assign(goal, state);
      panVel.lat = panVel.lon = 0;
      if (mode !== 'menu') menuBlend = 0;
      targetR = ctx.globe.surfaceRadiusAt(state.lat, state.lon);
      rigPose(state, camera.position, camera.quaternion);
      camera.updateMatrixWorld();
      nearFar();
      updateViewOffset();
      camera.updateProjectionMatrix();
    },
    flyTo(to, durationMs = 1800) {
      flight?.resolve();
      const from = { ...state };
      const dest: CameraState = { ...state, ...to };
      dest.altitudeKm = clamp(dest.altitudeKm, CAMERA_MIN_ALT_KM, CAMERA_MAX_ALT_KM);
      // Long hops arc up so the planet curvature reads (and we never skim the ground).
      const ang = Math.acos(clamp(
        Math.sin(from.lat * DEG) * Math.sin(dest.lat * DEG) + Math.cos(from.lat * DEG) * Math.cos(dest.lat * DEG) * Math.cos((dest.lon - from.lon) * DEG), -1, 1));
      const distKm = ang * EARTH_RADIUS_KM;
      const hump = Math.max(0, distKm * 0.55 - Math.max(from.altitudeKm, dest.altitudeKm) * 0.5);
      return new Promise<void>((resolve) => {
        flight = { from, to: dest, t: 0, dur: Math.max(1, durationMs), hump, resolve };
      });
    },
    shake(intensity, durationMs) {
      if (!ctx.settings.get().screenShake) return;
      trauma = clamp(Math.max(trauma, intensity), 0, 1.2);
      traumaDecay = trauma / Math.max(0.05, durationMs / 1000);
    },
    setMode(m) {
      if (m === mode) return;
      if (m === 'menu') {
        flight?.resolve();
        flight = null;
      }
      mode = m;
      if (m !== 'game') drag = null;
    },
    setInputEnabled(on) {
      inputEnabled = on;
      if (!on) drag = null;
    },
  };
  return api;
}
