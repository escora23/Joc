// FRONT ULTRA — command mode: take control of a tank / jet / warship (owner: command).
// STUB by the architect: a local battlefield scene (1 unit = 1 m) with a ground plane and a box vehicle you
// can drive with WASD; Esc requests exit. The command owner replaces it with the full third-person battles
// (terrain from real elevation, tank turret on mouse + ballistic shells, jet flight model, naval guns,
// enemy AI of the real enemy nation, own HUD in src/command/). Keep createCommandMode(ctx): CommandApi.

import * as THREE from 'three';
import type { CommandApi, CommandEnterParams, CommandResult, FrameInfo, GameContext } from '../shared/api';

export function createCommandMode(ctx: GameContext): CommandApi {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fb4d8);
  scene.fog = new THREE.Fog(0x8fb4d8, 200, 2500);
  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 5000);
  scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a3b28, 1.2));
  const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
  sun.position.set(300, 500, 200);
  scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x5d6b3a, roughness: 1 }));
  scene.add(ground);
  const vehicleMat = new THREE.MeshStandardMaterial({ color: 0x3fa9ff, roughness: 0.6, metalness: 0.3 });
  const vehicle = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.2, 7), vehicleMat);
  vehicle.position.y = 1.1;
  scene.add(vehicle);

  let active = false;
  let params: CommandEnterParams | null = null;
  let t0 = 0;
  const keys = new Set<string>();
  let hud: HTMLDivElement | null = null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (!active) return;
    keys.add(e.code);
    if (e.code === 'Escape') ctx.bus.emit('commandExitRequested', { reason: 'player' });
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);

  return {
    scene,
    camera,
    get active() {
      return active;
    },
    async init(progress) {
      progress(1);
    },
    async enter(p) {
      params = p;
      active = true;
      t0 = performance.now();
      vehicle.position.set(0, 1.1, 0);
      vehicle.rotation.set(0, 0, 0);
      vehicleMat.color.setHex(p.friendlyColor);
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('keyup', onKeyUp);
      hud = document.createElement('div');
      hud.style.cssText = 'position:absolute;left:50%;bottom:32px;transform:translateX(-50%);color:#fff;font:600 14px monospace;letter-spacing:.1em;text-shadow:0 0 6px #000;pointer-events:none;z-index:20';
      hud.textContent = `COMMAND MODE [${p.kind.toUpperCase()}] — WASD / ESC`;
      ctx.uiRoot.appendChild(hud);
    },
    exit(): CommandResult {
      active = false;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      keys.clear();
      hud?.remove();
      hud = null;
      const p = params!;
      return {
        unitId: p.unitId, kind: p.kind, enemy: p.enemy, tile: p.tile, troopsKilled: 0, unitsDestroyed: [],
        structuresDestroyed: [], unitLost: false, durationSec: (performance.now() - t0) / 1000,
      };
    },
    update(frame: FrameInfo) {
      if (!active) return;
      const dt = frame.dt;
      if (keys.has('KeyA')) vehicle.rotation.y += dt * 1.2;
      if (keys.has('KeyD')) vehicle.rotation.y -= dt * 1.2;
      const speed = (keys.has('KeyW') ? 14 : 0) - (keys.has('KeyS') ? 6 : 0);
      vehicle.translateZ(-speed * dt);
      const back = new THREE.Vector3(0, 6, 16).applyQuaternion(vehicle.quaternion);
      camera.position.copy(vehicle.position).add(back);
      camera.lookAt(vehicle.position.x, vehicle.position.y + 1.5, vehicle.position.z);
    },
    resize(w, h) {
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    },
  };
}
