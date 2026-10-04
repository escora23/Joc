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
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c4);
scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x5a5040, 1.4));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
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
const poses = [POSE.idle, POSE.walk, POSE.run, POSE.rush, POSE.aim, POSE.kneel, POSE.prone, POSE.dead];
const nations = [0x3f8fd8, 0xd84a3a, 0x2a9a4a];
for (let v = 0; v < 3; v++) {
  const geo = buildSoldierGeometry(v as 0 | 1 | 2, hi, v);
  const at = addSoldierInstancing(geo, poses.length);
  const im = new THREE.InstancedMesh(geo, mats.standard, poses.length);
  im.customDepthMaterial = mats.depth;
  im.castShadow = true;
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  poses.forEach((p, i) => {
    m.makeTranslation((i - (poses.length - 1) / 2) * 2.2, 0, (v - 1) * 3.2);
    im.setMatrixAt(i, m);
    const n = new THREE.Color(nations[v]);
    // The game's own uniform: row 0 and 2 ours, row 1 theirs.
    fieldUniform(v === 1 ? 1 : 0, nations[v], 0.13 * i + v * 0.31, c);
    im.setColorAt(i, c);
    at.anim.setXYZW(i, p, 0.1 * i, p === POSE.aim || p === POSE.kneel || p === POSE.prone ? T - 0.03 : -100, p === POSE.dead ? T - 0.25 - i * 0.1 : 0);
    at.band.setXYZW(i, n.r, n.g, n.b, 0.3);
  });
  scene.add(im);
}
const cam = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 500);
cam.position.set(Math.sin(AZ) * D * 1.6, 3 + D * 0.25, Math.cos(AZ) * D * 1.6);
cam.lookAt(0, 0.6, 0);
renderer.render(scene, cam);
(window as unknown as { __shotReady: boolean }).__shotReady = true;
