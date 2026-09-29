// FRONT ULTRA — headless check of the escort steering (command/ai.ts escortVehicle), no browser: an intruder drives
// north at 30 km/h for 60 s, then stops; two patrol vehicles escort it (blocker 90 m ahead, one 55 m abeam).
//   npx tsx tools/w5-escort-sim.ts [a|b|c]   a: already at their stations facing it; b: coming up from behind; c: from ahead
import * as THREE from 'three';
import { Brain } from '../src/command/ai.ts';
import { forwardOf } from '../src/command/world.ts';
function ent(x: number, z: number, yaw: number, sx: number, sz: number) {
  return { id: Math.random(), kind: 'ifv', alive: true, player: false, neutral: true, order: 'escort', team: 1, pos: new THREE.Vector3(x, 0, z), vel: new THREE.Vector3(), yaw, speed: 0, slot: new THREE.Vector3(sx, 0, sz), state: 0, stateT: 0, radius: 3.3, rig: {}, turretYaw: 0, tiltP: 0, tiltR: 0, moveT: new THREE.Vector3(), goal: new THREE.Vector3(), target: null } as any;
}
const P: any = { id: 1, kind: 'tank', alive: true, player: true, pos: new THREE.Vector3(0, 0, 0), yaw: 0, speed: 0, radius: 3.6, rig: {}, vel: new THREE.Vector3() };
// P faces north (-z). Lead station 90 ahead: (0,-90); facing the intruder (yaw = PI).
const sc = process.argv[2] ?? 'a';
const lead = sc === 'b' ? ent(0, 300, 0, 0, -90) : sc === 'c' ? ent(10, -600, Math.PI, 0, -90) : ent(0, -90, Math.PI, 0, -90);
const side = sc === 'b' ? ent(-60, 200, 0, 55, 25) : sc === 'c' ? ent(-30, -500, Math.PI, 55, 25) : ent(55, 25, Math.PI, 55, 25);
let minD = 1e9;
const w: any = { ents: [P, lead, side], player: P, ground: { heightAt: () => 10, normalAt: (_x: number, _z: number, o: THREE.Vector3) => o.set(0, 1, 0) }, fx: { dust() {} }, rng: { next: Math.random }, time: 0 };
const b = new Brain(w);
const f = new THREE.Vector3();
for (let i = 0; i < 90 * 30; i++) {
  const v = i < 60 * 30 ? 8.3 : 0;
  P.speed = v;
  forwardOf(P.yaw, f);
  P.pos.addScaledVector(f, v / 30);
  b.update(1 / 30);
  for (const e of [lead, side]) minD = Math.min(minD, e.pos.distanceTo(P.pos));
  if (i % 150 === 0) {
    const st = (e: any) => { const c = Math.cos(P.yaw), sn = Math.sin(P.yaw); return Math.hypot(e.pos.x - (P.pos.x + e.slot.x * c + e.slot.z * sn), e.pos.z - (P.pos.z - e.slot.x * sn + e.slot.z * c)); };
    console.log((i / 30).toFixed(0), [lead, side].map((e) => `d=${e.pos.distanceTo(P.pos).toFixed(0)} lag=${st(e).toFixed(0)} v=${e.speed.toFixed(1)} yaw=${(e.yaw * 57.3).toFixed(0)} st=${e.state}`).join(' | '));
  }
}
console.log('minD', minD.toFixed(1));
