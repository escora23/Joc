// FRONT ULTRA — soldier lab (dev tool): the command-mode soldier (models/soldier.ts) in every pose and variant, in
// the nation colours, with the game's own animated material. ?t=<world seconds>&d=<camera distance m>&az=<deg>
import * as THREE from 'three';
import { addSoldierInstancing, buildSoldierGeometry, fieldUniform, makeSoldierMaterials, POSE } from '../../src/command/models/soldier';

const q = new URLSearchParams(location.search);
const T = Number(q.get('t') ?? 0.3);
const D = Number(q.get('d') ?? 9);
const AZ = (Number(q.get('az') ?? 30) * Math.PI) / 180;
const hi = q.get('lod') !== 'far';
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c4);
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x4a4032, 1.1));
const sun = new THREE.DirectionalLight(0xfff1dd, 3.3);
sun.position.set(6, 10, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
scene.add(sun);
const g = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x7a7354 }));
g.rotation.x = -Math.PI / 2;
g.receiveShadow = true;
scene.add(g);
const mats = makeSoldierMaterials();
mats.time.value = T;
// &fill=r,g,b: the sky fill as command mode sets it (the game's daylight: ~0.16,0.22,0.33).
if (q.get('fill')) mats.fill.value.setRGB(...(q.get('fill')!.split(',').map(Number) as [number, number, number]));
const one = q.get('one');
const poses = one !== null ? [Number(one)] : [POSE.idle, POSE.walk, POSE.run, POSE.rush, POSE.aim, POSE.kneel, POSE.prone, POSE.dead];
const nations = one !== null ? [Number(q.get('nation') ?? '0x3f8fd8')] : [0x3f8fd8, 0xd84a3a, 0x2a9a4a];
const variants = one !== null ? [Number(q.get('v') ?? 0)] : [0, 1, 2];
variants.forEach((v, vi) => {
  const geo = buildSoldierGeometry(v as 0 | 1 | 2, hi, v);
  const at = addSoldierInstancing(geo, poses.length);
  const im = new THREE.InstancedMesh(geo, mats.standard, poses.length);
  im.customDepthMaterial = mats.depth;
  im.castShadow = true;
  im.receiveShadow = true;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  poses.forEach((p, i) => {
    m.makeTranslation((i - (poses.length - 1) / 2) * 2.2, 0, (vi - (variants.length - 1) / 2) * 3.2);
    im.setMatrixAt(i, m);
    const n = new THREE.Color(nations[vi]);
    // The game's own uniform: row 0 and 2 ours, row 1 theirs.
    const team = one !== null ? Number(q.get('team') ?? 0) : vi === 1 ? 1 : 0;
    fieldUniform(team as 0 | 1, nations[vi], 0.13 * i + vi * 0.31, c);
    im.setColorAt(i, c);
    at.anim.setXYZW(i, p, 0.1 * i, p === POSE.aim || p === POSE.kneel || p === POSE.prone ? T - 0.03 : -100, p === POSE.dead ? T - 0.25 - i * 0.1 : 0);
    at.band.setXYZW(i, n.r, n.g, n.b, 0.3 + vi * 0.21 + i * 0.07);
  });
  scene.add(im);
});
const cam = new THREE.PerspectiveCamera(one !== null ? 40 : 36, innerWidth / innerHeight, 0.1, 2000);
if (one !== null) {
  // In front of the man (he faces -Z), az to his left, from about a tank commander's eye height.
  cam.position.set(-Math.sin(AZ) * D, 1.6 + D * 0.12, -Math.cos(AZ) * D);
  cam.lookAt(0, 0.85, 0);
} else {
  cam.position.set(Math.sin(AZ) * D * 1.6, 3 + D * 0.25, Math.cos(AZ) * D * 1.6);
  cam.lookAt(0, 0.6, 0);
}
renderer.render(scene, cam);
(window as unknown as { __shotReady: boolean }).__shotReady = true;
