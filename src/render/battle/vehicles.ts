// FRONT ULTRA — ground battle: armored vehicles, artillery, air defence and helicopters (owner: battle).
// One instanced draw call per vehicle kind, one shared shader program (turret yaw, barrel elevation + recoil,
// rotor spin, terrain pitch/roll, burnt wrecks). Behaviour runs on the CPU (a few hundred vehicles at most):
// tank platoons that advance and duel across the line, APCs, self-propelled howitzer batteries firing salvos,
// SPAAG bursts, attack helicopters with rockets, supply trucks and armored columns rolling along the roads.

import * as THREE from 'three';
import {
  FastRng, GLSL_BATTLE_FRAG, GLSL_BATTLE_HEAD, GLSL_BATTLE_VERT, GLSL_ROT, GLSL_TAIL, hexToLinear, type BattleUniforms,
} from './common';
import type { Effects } from './effects';
import type { FrontGeom } from './front';
import {
  VEHICLE_PIVOTS, VehicleKind, antiAirGeometry, apcGeometry, artilleryGeometry, heliGeometry, tankGeometry, truckGeometry,
} from './models';

const vert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
${GLSL_ROT}
attribute vec2 aPart;
attribute vec3 aPivot;
attribute vec4 iA; // x y z yaw
attribute vec4 iB; // turretYaw (relative), barrelPitch, team, burnt
attribute vec4 iC; // pitch, roll, lastShotT, rotor speed
varying vec3 vN;
varying vec3 vPos;
varying float vMat;
varying float vTeam;
varying float vBurnt;
varying vec3 vObj;
void main() {
  vec3 p = position;
  vec3 n = normal;
  int part = int(aPart.x + 0.5);
  float tz = aPivot.x;
  if (part == 2) {
    vec3 piv = vec3(0.0, aPivot.y, aPivot.z);
    float rec = exp(-max(uTime - iC.z, 0.0) * 9.0) * step(iC.z, uTime) * 0.6;
    p.z -= rec;
    p = rotX(p - piv, -iB.y) + piv; n = rotX(n, -iB.y);
  }
  if (part == 1 || part == 2) {
    p.z -= tz;
    p = rotY(p, iB.x); n = rotY(n, iB.x);
    p.z += tz;
  }
  if (part == 3) { p = rotY(p, uTime * iC.w); n = rotY(n, uTime * iC.w); }
  if (part == 4) {
    vec3 piv = vec3(0.2, 1.2, -5.2);
    p = rotX(p - piv, uTime * iC.w * 2.3) + piv; n = rotX(n, uTime * iC.w * 2.3);
  }
  p = rotX(p, iC.x); n = rotX(n, iC.x);
  p = rotZ(p, iC.y); n = rotZ(n, iC.y);
  float ex = unitExaggeration(iA.xyz) * 0.85 + 0.15;
  p *= ex;
  p = rotY(p, iA.w); n = rotY(n, iA.w);
  vec3 wp = iA.xyz + p;
  vPos = wp;
  vN = n;
  vMat = aPart.y;
  vTeam = iB.z;
  vBurnt = iB.w;
  vObj = position;
  gl_Position = battleProject(wp);
}`;

const frag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
uniform vec3 uTeamCol[2];
uniform vec3 uPaint[2];
varying vec3 vN;
varying vec3 vPos;
varying float vMat;
varying float vTeam;
varying float vBurnt;
varying vec3 vObj;
void main() {
  battleFadeDiscard();
  int m = int(vMat + 0.5);
  int t = vTeam < 0.5 ? 0 : 1;
  vec3 team = uTeamCol[t];
  vec3 paint = uPaint[t];
  // Camouflage blotches on the paint.
  float c = bHash12(floor(vObj.xz * 0.9 + vObj.y * 1.3) + vTeam * 11.0);
  vec3 alb;
  float spec = 0.0;
  if (m == 0) { alb = paint * (c < 0.3 ? 0.62 : c < 0.6 ? 1.0 : 1.18); spec = 0.15; }
  else if (m == 1) alb = vec3(0.03, 0.03, 0.028);
  else if (m == 2) { alb = paint * 0.75 + 0.02; spec = 0.2; }
  else if (m == 3) { alb = vec3(0.02, 0.03, 0.035); spec = 1.0; }
  else if (m == 4) alb = vec3(0.018);
  else alb = team * 0.9;
  // Dust on the lower hull.
  alb = mix(alb, vec3(0.2, 0.16, 0.11), smoothstep(1.2, 0.2, vObj.y) * 0.45 * (1.0 - step(0.5, vBurnt)));
  if (vBurnt > 0.5) {
    alb = mix(vec3(0.028, 0.024, 0.02), vec3(0.09, 0.05, 0.03), c * 0.5);
    spec = 0.0;
  }
  float d = length(vPos - uCamL);
  float boost = smoothstep(uUnitScale.z * 1.5, uUnitScale.w * 1.6, d) * (1.0 - vBurnt);
  alb = mix(alb, team * 0.7 + 0.02, boost * 0.6);
  vec3 N = normalize(vN);
  vec3 col = battleShade(alb, N, vPos, 1.0, 1.0);
  vec3 V = normalize(uCamL - vPos);
  vec3 H = normalize(V + uSunDir);
  col += uSunCol * pow(max(dot(N, H), 0.0), 40.0) * spec * 0.6;
  col += uSunCol * pow(1.0 - max(dot(N, V), 0.0), 4.0) * 0.05;
  col = battleAir(col, vPos);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_TAIL}
}`;

export interface Vehicle {
  kind: VehicleKind;
  team: number;
  x: number; y: number; z: number;
  yaw: number;
  speed: number;
  maxSpeed: number;
  tx: number; tz: number;
  turret: number; // relative to hull
  pitch: number; // barrel elevation
  aimPitch: number;
  burnt: boolean;
  alive: boolean;
  lastShot: number;
  nextFire: number;
  nextMove: number;
  u: number; v: number;
  role: number; // 0 line, 1 column, 2 static battery, 3 wreck
  hover: number;
  seed: number;
  pathId: number;
  pathS: number;
  bodyPitch: number;
  bodyRoll: number;
  aimX: number; aimZ: number; aimY: number;
}

export interface Path {
  pts: Float32Array; // x,z pairs
  cum: Float32Array; // cumulative length
  length: number;
}

export function samplePath(p: Path, s: number, out: THREE.Vector3): THREE.Vector3 {
  const n = p.cum.length;
  s = Math.max(0, Math.min(p.length, s));
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  const seg = p.cum[hi] - p.cum[lo] || 1;
  const t = (s - p.cum[lo]) / seg;
  out.x = p.pts[lo * 2] + (p.pts[hi * 2] - p.pts[lo * 2]) * t;
  out.z = p.pts[lo * 2 + 1] + (p.pts[hi * 2 + 1] - p.pts[lo * 2 + 1]) * t;
  return out;
}

interface KindMesh {
  mesh: THREE.Mesh;
  iA: THREE.InstancedBufferAttribute;
  iB: THREE.InstancedBufferAttribute;
  iC: THREE.InstancedBufferAttribute;
  cap: number;
}

export interface VehiclesHost {
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  blocked(x: number, z: number): boolean;
  /** A target point for fire into the enemy of `team` (soldier or vehicle). */
  enemyTarget(team: number, rng: FastRng, out: THREE.Vector3): boolean;
  lod(x: number, y: number, z: number): number;
}

export interface Vehicles {
  readonly group: THREE.Group;
  readonly list: readonly Vehicle[];
  deploy(front: FrontGeom, counts: VehicleCounts, paths: Path[], seed: number, now: number): void;
  update(now: number, dt: number, front: FrontGeom, intensity: number, fx: Effects): void;
  setColors(a: number, b: number): void;
  clear(): void;
  /** Destroy the vehicle nearest to a blast (if any within radius): turns into a burning wreck. */
  blast(x: number, z: number, radius: number, now: number, fx: Effects): void;
  warmup(on: boolean): void;
  setCapacity(n: number): void;
}

export interface VehicleCounts {
  tanks: [number, number];
  apcs: [number, number];
  artillery: [number, number];
  aa: [number, number];
  helis: [number, number];
  trucks: [number, number];
  /** Armored column (tanks + APCs moving up a road) per side. */
  columns: [number, number];
  wrecks: number;
}

const KINDS: VehicleKind[] = [VehicleKind.Tank, VehicleKind.Apc, VehicleKind.Artillery, VehicleKind.AntiAir, VehicleKind.Heli, VehicleKind.Truck];

export function createVehicles(uniforms: BattleUniforms, host: VehiclesHost, capacity: number): Vehicles {
  const group = new THREE.Group();
  group.name = 'battle-vehicles';
  const teamCol = [new THREE.Vector3(), new THREE.Vector3()];
  const paint = [new THREE.Vector3(), new THREE.Vector3()];
  const mat = new THREE.ShaderMaterial({
    vertexShader: vert, fragmentShader: frag,
    uniforms: { ...uniforms, uTeamCol: { value: teamCol }, uPaint: { value: paint } },
  });
  mat.name = 'battle-vehicles';
  const builders: Record<VehicleKind, () => THREE.BufferGeometry> = {
    [VehicleKind.Tank]: tankGeometry,
    [VehicleKind.Apc]: apcGeometry,
    [VehicleKind.Artillery]: artilleryGeometry,
    [VehicleKind.AntiAir]: antiAirGeometry,
    [VehicleKind.Heli]: heliGeometry,
    [VehicleKind.Truck]: truckGeometry,
  };
  const meshes = new Map<VehicleKind, KindMesh>();
  let perKindCap = Math.max(16, capacity);

  function makeKind(kind: VehicleKind, cap: number): KindMesh {
    const base = builders[kind]();
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    geo.setAttribute('aPart', base.getAttribute('aPart'));
    const nv = base.getAttribute('position').count;
    const piv = VEHICLE_PIVOTS[kind];
    const pv = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      pv[i * 3] = piv.turretZ;
      pv[i * 3 + 1] = piv.barrelY;
      pv[i * 3 + 2] = piv.barrelZ;
    }
    geo.setAttribute('aPivot', new THREE.BufferAttribute(pv, 3));
    const mk = () => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    const iA = mk(), iB = mk(), iC = mk();
    geo.setAttribute('iA', iA);
    geo.setAttribute('iB', iB);
    geo.setAttribute('iC', iC);
    geo.instanceCount = 0;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    mesh.name = `battle-vehicle-${kind}`;
    return { mesh, iA, iB, iC, cap };
  }
  for (const k of KINDS) {
    const km = makeKind(k, perKindCap);
    meshes.set(k, km);
    group.add(km.mesh);
  }

  const list: Vehicle[] = [];
  const rng = new FastRng(77);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const uv2 = new THREE.Vector2();
  let paths: Path[] = [];
  let warm = false;

  function newVehicle(kind: VehicleKind, team: number, x: number, z: number, yaw: number, role: number): Vehicle {
    const v: Vehicle = {
      kind, team, x, y: host.heightAt(x, z), z, yaw, speed: 0,
      maxSpeed: kind === VehicleKind.Tank ? 6.5 : kind === VehicleKind.Apc ? 8 : kind === VehicleKind.Truck ? 9 : kind === VehicleKind.Heli ? 18 : 5,
      tx: x, tz: z, turret: 0, pitch: 0.02, aimPitch: 0.02, burnt: false, alive: true, lastShot: -100, nextFire: 0, nextMove: 0,
      u: 0, v: 0, role, hover: 0, seed: rng.next(), pathId: -1, pathS: 0, bodyPitch: 0, bodyRoll: 0, aimX: 0, aimZ: 0, aimY: 0,
    };
    list.push(v);
    return v;
  }

  function place(front: FrontGeom, team: number, u: number, v: number, out: THREE.Vector3): THREE.Vector3 {
    front.toXZ(u, team === 0 ? -v : v, out);
    let tries = 0;
    while (host.blocked(out.x, out.z) && tries++ < 6) front.toXZ(u + rng.range(-60, 60), (team === 0 ? -1 : 1) * (v + rng.range(0, 60)), out);
    return out;
  }

  function faceYaw(front: FrontGeom, team: number): number {
    const fx = team === 0 ? front.nx : -front.nx, fz = team === 0 ? front.nz : -front.nz;
    return Math.atan2(fx, fz);
  }

  function angDiff(a: number, b: number): number {
    let d = (b - a) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  }

  const kindCount = new Int32Array(8);
  function upload(): void {
    kindCount.fill(0);
    for (const v of list) {
      const km = meshes.get(v.kind)!;
      const i = kindCount[v.kind];
      if (i >= km.cap) continue;
      kindCount[v.kind] = i + 1;
      const A = km.iA.array as Float32Array, B = km.iB.array as Float32Array, C = km.iC.array as Float32Array;
      const o = i * 4;
      A[o] = v.x; A[o + 1] = v.y; A[o + 2] = v.z; A[o + 3] = v.yaw;
      B[o] = v.turret; B[o + 1] = v.pitch; B[o + 2] = v.team; B[o + 3] = v.burnt ? 1 : 0;
      C[o] = v.bodyPitch; C[o + 1] = v.bodyRoll; C[o + 2] = v.lastShot; C[o + 3] = v.kind === VehicleKind.Heli && !v.burnt ? 26 : 0;
    }
    for (const k of KINDS) {
      const km = meshes.get(k)!;
      const c = warm ? Math.max(1, kindCount[k]) : kindCount[k];
      (km.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = c;
      if (kindCount[k] === 0 && !warm) continue;
      // Upload only the live instances.
      for (const attr of [km.iA, km.iB, km.iC]) {
        attr.clearUpdateRanges();
        attr.addUpdateRange(0, Math.max(1, kindCount[k]) * 4);
        attr.needsUpdate = true;
      }
    }
  }

  function terrainPose(v: Vehicle): void {
    host.normalAt(v.x, v.z, nrm);
    const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    const ny = Math.max(0.3, nrm.y);
    const slopeF = -(nrm.x * fx + nrm.z * fz) / ny;
    const slopeR = -(nrm.x * rx + nrm.z * rz) / ny;
    v.bodyPitch = -Math.atan(slopeF);
    v.bodyRoll = Math.atan(slopeR);
  }

  const api: Vehicles = {
    group,
    list,
    setCapacity(n) {
      const c = Math.max(16, n);
      if (c === perKindCap) return;
      perKindCap = c;
      for (const k of KINDS) {
        const old = meshes.get(k)!;
        group.remove(old.mesh);
        old.mesh.geometry.dispose();
        const km = makeKind(k, c);
        meshes.set(k, km);
        group.add(km.mesh);
      }
    },
    setColors(a, b) {
      hexToLinear(a, teamCol[0]);
      hexToLinear(b, teamCol[1]);
      const olive = new THREE.Vector3(0.06, 0.065, 0.035);
      for (let t = 0; t < 2; t++) {
        const c = teamCol[t];
        const lum = Math.max(0.05, c.x * 0.2126 + c.y * 0.7152 + c.z * 0.0722);
        paint[t].copy(olive).lerp(c.clone().multiplyScalar(0.07 / lum), 0.16);
      }
    },
    deploy(front, counts, pathList, seed, now) {
      list.length = 0;
      paths = pathList;
      const r = new FastRng(seed);
      for (let team = 0; team < 2; team++) {
        const yaw0 = faceYaw(front, team);
        // Tank platoons in the fighting zone.
        let left = counts.tanks[team];
        let first = true;
        while (left > 0) {
          const pl = Math.min(left, 3 + r.int(2));
          // The first platoon of each side fights right where the battlefield is centred (under the camera).
          const u = first ? r.range(-220, 220) : Math.max(-1, Math.min(1, r.gauss() * 0.3)) * front.halfLen * 0.85;
          const v = first ? r.range(75, 150) : r.range(90, 380);
          first = false;
          for (let k = 0; k < pl; k++) {
            place(front, team, u + (k - pl / 2) * r.range(35, 60), v + r.range(-15, 25), tmp);
            const veh = newVehicle(VehicleKind.Tank, team, tmp.x, tmp.z, yaw0 + r.range(-0.3, 0.3), 0);
            veh.u = u + (k - pl / 2) * 45;
            veh.v = v;
            veh.nextMove = now + r.range(0, 10);
            veh.nextFire = now + r.range(1, 9);
            veh.turret = r.range(-0.3, 0.3);
          }
          left -= pl;
        }
        for (let k = 0; k < counts.apcs[team]; k++) {
          const u = Math.max(-1, Math.min(1, r.gauss() * 0.35)) * front.halfLen * 0.85;
          const v = r.range(220, 700);
          place(front, team, u, v, tmp);
          const veh = newVehicle(VehicleKind.Apc, team, tmp.x, tmp.z, yaw0 + r.range(-0.5, 0.5), 0);
          veh.u = u; veh.v = v;
          veh.nextMove = now + r.range(0, 15);
          veh.nextFire = now + r.range(2, 12);
        }
        // Artillery batteries (line abreast, far behind the line).
        let art = counts.artillery[team];
        while (art > 0) {
          const bat = Math.min(art, 4 + r.int(3));
          const u = r.range(-0.7, 0.7) * front.halfLen;
          const v = r.range(1500, 2300);
          for (let k = 0; k < bat; k++) {
            place(front, team, u + (k - bat / 2) * 45, v + r.range(-10, 10), tmp);
            const veh = newVehicle(VehicleKind.Artillery, team, tmp.x, tmp.z, yaw0 + r.range(-0.08, 0.08), 2);
            veh.u = u; veh.v = v;
            veh.pitch = veh.aimPitch = r.range(0.45, 0.7);
            veh.nextFire = now + r.range(0.5, 8) + k * 0.35;
          }
          art -= bat;
        }
        for (let k = 0; k < counts.aa[team]; k++) {
          const u = r.range(-0.6, 0.6) * front.halfLen;
          const v = r.range(700, 1400);
          place(front, team, u, v, tmp);
          const veh = newVehicle(VehicleKind.AntiAir, team, tmp.x, tmp.z, yaw0 + r.range(-0.6, 0.6), 2);
          veh.pitch = veh.aimPitch = r.range(0.6, 1.1);
          veh.nextFire = now + r.range(1, 10);
        }
        for (let k = 0; k < counts.helis[team]; k++) {
          const u = r.range(-0.5, 0.5) * front.halfLen;
          const v = r.range(450, 1100);
          place(front, team, u, v, tmp);
          const veh = newVehicle(VehicleKind.Heli, team, tmp.x, tmp.z, yaw0, 0);
          veh.u = u; veh.v = v;
          veh.hover = r.range(35, 85);
          veh.nextFire = now + r.range(2, 10);
          veh.nextMove = now + r.range(0, 8);
        }
        // Columns and supply trucks follow the roads (paths are oriented from the rear toward the front).
        const teamPaths = paths.map((p, i) => ({ p, i })).filter((q) => (q.i % 2) === team || paths.length === 1);
        if (teamPaths.length > 0) {
          for (let c = 0; c < counts.columns[team]; c++) {
            const pp = teamPaths[c % teamPaths.length];
            const len = 8 + r.int(8);
            const start = r.range(0.05, 0.3) * pp.p.length;
            for (let k = 0; k < len; k++) {
              const s = start - k * 28;
              if (s < 0) break;
              samplePath(pp.p, s, tmp);
              const kind = k % 4 === 3 ? VehicleKind.Apc : VehicleKind.Tank;
              const veh = newVehicle(kind, team, tmp.x, tmp.z, 0, 1);
              veh.pathId = pp.i;
              veh.pathS = s;
              veh.maxSpeed = 5.5;
            }
          }
          for (let k = 0; k < counts.trucks[team]; k++) {
            const pp = teamPaths[k % teamPaths.length];
            const s = r.range(0, 0.35) * pp.p.length;
            samplePath(pp.p, s, tmp);
            const veh = newVehicle(VehicleKind.Truck, team, tmp.x, tmp.z, 0, 1);
            veh.pathId = pp.i;
            veh.pathS = s;
            veh.maxSpeed = r.range(6, 9);
          }
        }
      }
      // Burnt wrecks in and near no-man's-land.
      for (let k = 0; k < counts.wrecks; k++) {
        const team = r.int(2);
        const u = r.gauss() * 0.4 * front.halfLen;
        const v = r.range(-60, 160);
        front.toXZ(u, team === 0 ? -v : v, tmp);
        if (host.blocked(tmp.x, tmp.z)) continue;
        const veh = newVehicle(r.chance(0.7) ? VehicleKind.Tank : VehicleKind.Apc, team, tmp.x, tmp.z, r.range(0, Math.PI * 2), 3);
        veh.burnt = true;
        veh.alive = false;
        veh.turret = r.range(-1.5, 1.5);
        veh.pitch = r.range(-0.1, 0.25);
      }
      for (const v of list) {
        if (v.kind === VehicleKind.Heli) v.y = host.heightAt(v.x, v.z) + v.hover;
        else terrainPose(v);
      }
      upload();
    },
    update(now, dt, front, intensity, fx) {
      if (list.length === 0 && !warm) return;
      const act = 0.35 + intensity * 0.9;
      for (const v of list) {
        if (!v.alive) continue;
        const enemyYaw = faceYaw(front, v.team);
        if (v.role === 1 && v.pathId >= 0 && paths[v.pathId]) {
          // Follow the road toward the front, then peel off into the line.
          const p = paths[v.pathId];
          v.speed += (v.maxSpeed - v.speed) * Math.min(1, dt * 0.8);
          v.pathS += v.speed * dt;
          if (v.pathS >= p.length - 5) {
            if (v.kind === VehicleKind.Truck) v.pathS = 0;
            else {
              v.role = 0;
              const c = front.coords(v.x, v.z, uv2);
              v.u = c.x;
              v.v = Math.abs(c.y);
              v.tx = v.x; v.tz = v.z;
            }
          }
          samplePath(p, v.pathS, tmp);
          samplePath(p, v.pathS + 6, tmp2);
          v.x = tmp.x;
          v.z = tmp.z;
          const want = Math.atan2(tmp2.x - tmp.x, tmp2.z - tmp.z);
          v.yaw += angDiff(v.yaw, want) * Math.min(1, dt * 4);
          v.y = host.heightAt(v.x, v.z);
          v.turret += angDiff(v.turret, 0) * Math.min(1, dt);
          terrainPose(v);
          continue;
        }
        if (v.kind === VehicleKind.Heli) {
          // Hover and strafe behind the own line, nose toward the enemy, rocket runs.
          if (now > v.nextMove) {
            v.nextMove = now + rng.range(6, 14);
            v.u = Math.max(-front.halfLen * 0.8, Math.min(front.halfLen * 0.8, v.u + rng.range(-250, 250)));
            v.v = Math.max(300, Math.min(1300, v.v + rng.range(-200, 200) * (v.team === 0 ? front.pushA : front.pushB)));
            front.toXZ(v.u, v.team === 0 ? -v.v : v.v, tmp);
            v.tx = tmp.x; v.tz = tmp.z;
          }
          const dx = v.tx - v.x, dz = v.tz - v.z;
          const d = Math.hypot(dx, dz);
          const sp = Math.min(v.maxSpeed, d * 0.25);
          if (d > 1) {
            v.x += (dx / d) * sp * dt;
            v.z += (dz / d) * sp * dt;
          }
          const ground = host.heightAt(v.x, v.z);
          const bob = Math.sin(now * 0.7 + v.seed * 20) * 2.5;
          v.y += (ground + v.hover + bob - v.y) * Math.min(1, dt * 1.5);
          v.yaw += angDiff(v.yaw, enemyYaw + Math.sin(now * 0.2 + v.seed * 9) * 0.25) * Math.min(1, dt * 0.8);
          // Lean into the motion.
          const fwd = (dx / Math.max(d, 1)) * Math.sin(v.yaw) + (dz / Math.max(d, 1)) * Math.cos(v.yaw);
          v.bodyPitch += (sp / v.maxSpeed * 0.25 * fwd - v.bodyPitch) * Math.min(1, dt * 2);
          v.bodyRoll += (Math.sin(now * 0.5 + v.seed * 7) * 0.06 - v.bodyRoll) * Math.min(1, dt);
          if (now > v.nextFire && host.enemyTarget(v.team, rng, tmp)) {
            v.nextFire = now + rng.range(4, 11) / act;
            v.lastShot = now;
            const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
            const salvo = 2 + rng.int(3);
            for (let k = 0; k < salvo; k++) {
              const side = k % 2 === 0 ? 1.7 : -1.7;
              const ox = v.x + c * side + s * 2, oz = v.z - s * side + c * 2;
              fx.rocket(ox, v.y - 0.4, oz, tmp.x + rng.range(-25, 25), tmp.z + rng.range(-25, 25), now + k * 0.18);
            }
          }
          continue;
        }
        if (v.role === 2) {
          // Static batteries.
          v.yaw += angDiff(v.yaw, enemyYaw) * Math.min(1, dt * 0.2);
          if (v.kind === VehicleKind.Artillery) {
            v.turret += angDiff(v.turret, Math.sin(v.seed * 40) * 0.12) * Math.min(1, dt);
            v.pitch += (v.aimPitch - v.pitch) * Math.min(1, dt * 1.5);
            if (now > v.nextFire) {
              v.nextFire = now + rng.range(7, 16) / act;
              v.lastShot = now;
              const yaw = v.yaw + v.turret;
              const ce = Math.cos(v.pitch), se = Math.sin(v.pitch);
              const dx = Math.sin(yaw) * ce, dz = Math.cos(yaw) * ce, dy = se;
              const ex = 1 + Math.min(2.2, Math.max(0, host.lod(v.x, v.y, v.z) < 0.5 ? 1 : 0));
              void ex;
              const mz = 9.4;
              const px = v.x + dx * mz, py = v.y + 2.4 + dy * mz, pz = v.z + dz * mz;
              // Target: deep into the enemy side, near the line.
              const tu = v.u + rng.range(-900, 900);
              const tv = rng.range(30, 700);
              front.toXZ(tu, v.team === 0 ? tv : -tv, tmp);
              fx.artilleryShot(px, py, pz, dx, dy, dz, tmp.x, tmp.z, now);
            }
          } else {
            // SPAAG: sweep the sky, burst fire.
            const t = now * 0.3 + v.seed * 30;
            v.turret += angDiff(v.turret, Math.sin(t) * 1.2) * Math.min(1, dt * 1.5);
            v.pitch += (0.55 + 0.4 * Math.sin(t * 1.3) - v.pitch) * Math.min(1, dt);
            if (now > v.nextFire) {
              v.nextFire = now + rng.range(2.5, 9) / act;
              v.lastShot = now;
              const yaw = v.yaw + v.turret;
              const ce = Math.cos(v.pitch), se = Math.sin(v.pitch);
              const dx = Math.sin(yaw) * ce, dz = Math.cos(yaw) * ce;
              const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
              for (const side of [-1.35, 1.35]) {
                const ox = v.x + c * side, oz = v.z - s * side;
                fx.aaBurst(ox + dx * 3.5, v.y + 2.4 + se * 3.5, oz + dz * 3.5, dx, se, dz, now, rng);
              }
            }
          }
          terrainPose(v);
          continue;
        }
        // Line vehicles (tanks, APCs): move between cover positions, duel across the line.
        if (now > v.nextMove) {
          v.nextMove = now + rng.range(10, 25);
          const push = v.team === 0 ? front.pushA : front.pushB;
          const minV = v.kind === VehicleKind.Tank ? 70 : 200;
          v.v = Math.max(minV, v.v - (push > 0.2 ? rng.range(10, 70) : rng.range(-30, 20)));
          v.u += rng.range(-40, 40);
          place(front, v.team, v.u, v.v, tmp);
          v.tx = tmp.x; v.tz = tmp.z;
        }
        const dx = v.tx - v.x, dz = v.tz - v.z;
        const d = Math.hypot(dx, dz);
        if (d > 4) {
          const want = Math.atan2(dx, dz);
          const da = angDiff(v.yaw, want);
          v.yaw += Math.sign(da) * Math.min(Math.abs(da), dt * 0.45);
          const align = Math.max(0, Math.cos(da));
          v.speed += (v.maxSpeed * align * Math.min(1, d / 30) - v.speed) * Math.min(1, dt * 0.7);
        } else {
          v.speed *= Math.max(0, 1 - dt * 1.5);
        }
        v.x += Math.sin(v.yaw) * v.speed * dt;
        v.z += Math.cos(v.yaw) * v.speed * dt;
        v.y = host.heightAt(v.x, v.z);
        terrainPose(v);
        // Turret tracks an aim point on the enemy side.
        if (v.aimX === 0 && v.aimZ === 0 || now > v.nextFire - 2.5 && v.aimY === 0) {
          if (host.enemyTarget(v.team, rng, tmp)) {
            v.aimX = tmp.x; v.aimZ = tmp.z; v.aimY = 1;
          }
        }
        const wantT = angDiff(v.yaw, Math.atan2(v.aimX - v.x, v.aimZ - v.z));
        v.turret += Math.sign(angDiff(v.turret, wantT)) * Math.min(Math.abs(angDiff(v.turret, wantT)), dt * 0.7);
        const dist = Math.hypot(v.aimX - v.x, v.aimZ - v.z);
        v.pitch += (Math.min(0.12, dist / 25000) - v.pitch) * Math.min(1, dt);
        if (now > v.nextFire && Math.abs(angDiff(v.turret, wantT)) < 0.05) {
          v.nextFire = now + (v.kind === VehicleKind.Tank ? rng.range(6, 14) : rng.range(3, 8)) / act;
          v.lastShot = now;
          v.aimY = 0;
          const yaw = v.yaw + v.turret;
          const dxs = Math.sin(yaw), dzs = Math.cos(yaw);
          const piv = VEHICLE_PIVOTS[v.kind];
          if (v.kind === VehicleKind.Tank) {
            const mz = 6.5;
            fx.tankShot(v.x + dxs * mz, v.y + piv.barrelY + 0.1, v.z + dzs * mz, dxs, 0.02, dzs, v.aimX + rng.range(-8, 8), v.aimZ + rng.range(-8, 8), now, rng.chance(0.3));
          } else {
            // Autocannon burst.
            const ty = host.heightAt(v.aimX, v.aimZ) + 1;
            for (let k = 0; k < 5; k++) {
              fx.tracer(v.x + dxs * 3, v.y + piv.barrelY, v.z + dzs * 3, v.aimX + rng.range(-10, 10), ty, v.aimZ + rng.range(-10, 10), 1100, 1, 0.5, 0.2, 0.1, now + k * 0.2);
              fx.muzzle(v.x + dxs * 3.2, v.y + piv.barrelY, v.z + dzs * 3.2, dxs, dzs, 1.4, 1, 0.75, 0.4, now + k * 0.2);
            }
          }
        }
      }
      upload();
    },
    blast(x, z, radius, now, fx) {
      let best: Vehicle | null = null, bd = radius * radius;
      for (const v of list) {
        if (!v.alive || v.kind === VehicleKind.Heli) continue;
        const d = (v.x - x) * (v.x - x) + (v.z - z) * (v.z - z);
        if (d < bd) { bd = d; best = v; }
      }
      if (best && rng.chance(0.5)) {
        best.alive = false;
        best.burnt = true;
        best.role = 3;
        best.speed = 0;
        fx.explosion(best.x, best.z, 2, now + 0.05, false);
        fx.addFire(best.x, best.y + 1.5, best.z, 2.2, 1.3, now + rng.range(60, 140), 1.6, true);
      }
    },
    clear() {
      list.length = 0;
      upload();
    },
    warmup(on) {
      warm = on;
      if (on) {
        // Ensure every kind has an instance so each program variant draws once.
        upload();
      } else upload();
    },
  };
  return api;
}
