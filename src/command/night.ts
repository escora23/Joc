// FRONT ULTRA — command mode at night (owner feedback #3, item 29b; owner: command).
//
// A night scene must stay readable, never a near-black screen:
//   * the vehicle's own lights (headlights / a searchlight on the ship), on by themselves after dusk, L toggles them;
//   * illumination flares over the fighting: while an enemy is within 4 km at night, a flare pops above the contact
//     every ~12 s and drifts down under its parachute for ~25 s, lighting the ground around it (as the battle view does);
//   * the fires of damaged structures and burning wrecks light their surroundings (index.ts burnFires, effects);
//   * N cycles the sights: off → night vision (green, amplified) → thermal (white-hot: vehicles and soldiers glow
//     against a dark, cold ground) → off. Both are a view filter on the 3D canvas; the HUD stays as it is.
// Moonlight itself comes from env/sky.ts (computeAtmos) and the exposure boost of index.ts.

import * as THREE from 'three';
import type { CmdMaterials } from './models/materials';
import type { Effects } from './fx/effects';
import type { Atmos } from './env/sky';

export type VisionMode = 'off' | 'nv' | 'thermal';

const NV_FILTER = 'grayscale(1) sepia(1) hue-rotate(58deg) saturate(3.2) brightness(2.1) contrast(1.12)';
const THERMAL_FILTER = 'grayscale(1) contrast(1.55) brightness(1.05)';
const FLARE_EVERY_S = 12;
const FLARE_LIFE_S = 26;

interface Flare {
  pos: THREE.Vector3;
  life: number;
  light: THREE.PointLight;
}

export class NightKit {
  vision: VisionMode = 'off';
  lightsOn = true;
  /** Tools: flares fired this session. */
  flaresFired = 0;
  private readonly head: THREE.SpotLight;
  private readonly headTarget = new THREE.Object3D();
  private readonly flares: Flare[] = [];
  private flareT = 4;
  private readonly saved = new Map<THREE.MeshStandardMaterial, { e: THREE.Color; i: number }>();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene, private readonly canvas: HTMLCanvasElement, private readonly mats: () => CmdMaterials | null) {
    this.head = new THREE.SpotLight(0xfff0d6, 0, 220, 0.42, 0.55, 1);
    this.head.castShadow = false;
    this.head.target = this.headTarget;
    scene.add(this.head, this.headTarget);
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xfff4dc, 0, 1600, 1);
      l.castShadow = false;
      scene.add(l);
      this.flares.push({ pos: new THREE.Vector3(), life: 0, light: l });
    }
  }

  /** N: off → night vision → thermal → off. Returns the new mode. */
  cycleVision(): VisionMode {
    this.setVision(this.vision === 'off' ? 'nv' : this.vision === 'nv' ? 'thermal' : 'off');
    return this.vision;
  }

  setVision(m: VisionMode): void {
    this.vision = m;
    this.canvas.style.filter = m === 'nv' ? NV_FILTER : m === 'thermal' ? THERMAL_FILTER : '';
    // Thermal: bodies and engines are hot (emissive white), the ground stays cold.
    const M = this.mats();
    const hot: THREE.MeshStandardMaterial[] = M ? [...M.paint, ...M.shipPaint, ...M.jetPaint, M.soldier, M.wreck] : [];
    for (const mat of hot) {
      if (m === 'thermal') {
        if (!this.saved.has(mat)) this.saved.set(mat, { e: mat.emissive.clone(), i: mat.emissiveIntensity });
        mat.emissive.setRGB(1, 1, 1);
        mat.emissiveIntensity = mat === M!.wreck ? 0.35 : 0.9;
      } else {
        const s = this.saved.get(mat);
        if (s) {
          mat.emissive.copy(s.e);
          mat.emissiveIntensity = s.i;
        }
      }
    }
    if (m !== 'thermal') this.saved.clear();
  }

  /** Exposure multiplier the sights add (night vision amplifies light; thermal does not need it). */
  get exposureMul(): number {
    return this.vision === 'nv' ? 1.6 : this.vision === 'thermal' ? 0.55 : 1;
  }

  /**
   * Per frame. `vehicle`: the player's vehicle (position, yaw) or null; `contact`: the nearest enemy position within
   * 4 km, or null; `ground`: surface height.
   */
  update(dt: number, atmos: Atmos, vehicle: { pos: THREE.Vector3; yaw: number; kind: 'tank' | 'jet' | 'ship' } | null, contact: THREE.Vector3 | null, fx: Effects | null, ground: (x: number, z: number) => number): void {
    const dark = Math.max(0, Math.min(1, (atmos.night - 0.35) / 0.4));
    // Headlights / searchlight (not on a jet: its instruments and the moon do).
    if (vehicle && vehicle.kind !== 'jet' && this.lightsOn && dark > 0) {
      const fwx = -Math.sin(vehicle.yaw), fwz = -Math.cos(vehicle.yaw);
      const up = vehicle.kind === 'ship' ? 12 : 2.4;
      this.head.position.set(vehicle.pos.x + fwx * 3, vehicle.pos.y + up, vehicle.pos.z + fwz * 3);
      const reach = vehicle.kind === 'ship' ? 500 : 60;
      this.headTarget.position.set(vehicle.pos.x + fwx * reach, vehicle.pos.y + (vehicle.kind === 'ship' ? 0 : 0.5), vehicle.pos.z + fwz * reach);
      this.headTarget.updateMatrixWorld();
      this.head.intensity = (vehicle.kind === 'ship' ? 900 : 90) * dark;
      this.head.distance = vehicle.kind === 'ship' ? 1500 : 220;
      if (fx) {
        // The lamps themselves.
        const sx = Math.cos(vehicle.yaw) * 1.3, sz = -Math.sin(vehicle.yaw) * 1.3;
        fx.particles.glow(this.head.position.x + sx, this.head.position.y - 0.9, this.head.position.z + sz, 0.5, 5, 4.6, 3.8, 0.9 * dark);
        fx.particles.glow(this.head.position.x - sx, this.head.position.y - 0.9, this.head.position.z - sz, 0.5, 5, 4.6, 3.8, 0.9 * dark);
      }
    } else this.head.intensity = 0;
    // Illumination flares over the fighting.
    this.flareT -= dt;
    if (dark > 0.2 && contact && this.flareT <= 0) {
      this.flareT = FLARE_EVERY_S;
      const f = this.flares.find((x) => x.life <= 0) ?? this.flares[0];
      f.pos.set(contact.x + (Math.random() - 0.5) * 300, ground(contact.x, contact.z) + 380, contact.z + (Math.random() - 0.5) * 300);
      f.life = FLARE_LIFE_S;
      this.flaresFired++;
    }
    for (const f of this.flares) {
      if (f.life <= 0) {
        f.light.intensity = 0;
        continue;
      }
      f.life -= dt;
      f.pos.y -= 9 * dt;
      f.pos.x += 1.5 * dt;
      const k = Math.min(1, f.life / 3, (FLARE_LIFE_S - f.life) / 1.2 + 0.1);
      f.light.position.copy(f.pos);
      f.light.intensity = 2600 * k * Math.max(0.3, dark);
      if (fx) {
        fx.particles.glow(f.pos.x, f.pos.y, f.pos.z, 9, 9, 8, 6, k);
        fx.particles.glow(f.pos.x, f.pos.y, f.pos.z, 32, 1.4, 1.3, 1, 0.5 * k);
      }
    }
  }

  /** Leaving command mode: lights off, sights off. */
  reset(): void {
    this.setVision('off');
    this.head.intensity = 0;
    for (const f of this.flares) {
      f.life = 0;
      f.light.intensity = 0;
    }
    this.flareT = 4;
    this.flaresFired = 0;
    this.lightsOn = true;
    void this.scene;
    void this.tmp;
  }
}
