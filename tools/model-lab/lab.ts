// FRONT ULTRA — model lab (dev tool, not part of the game build). Renders the game's own procedural unit and
// structure models with the game's own model shader, in a grid of 3/4 views, so model changes can be judged in
// seconds instead of staging a whole game. Served by the Vite dev server:
//   http://127.0.0.1:5401/tools/model-lab/index.html?set=units|structs|air|small&el=35&az=35&team=e07b28
// `small=1` renders every cell at a small pixel size (the minimum on-screen size in play) to judge the silhouette.
import * as THREE from 'three';
import { AIRBASE_SLOTS, buildStructModel, buildUnitModel, levelKey, type StructModelKey, type UnitModelKey } from '../../src/render/units/models';
import { createModelMaterial, minPxScale } from '../../src/render/units/material';
import { sharedUniforms, env } from '../../src/render/units/common';

const q = new URLSearchParams(location.search);
const set = q.get('set') ?? 'units';
const elev = (Number(q.get('el') ?? 32) * Math.PI) / 180;
const azim = (Number(q.get('az') ?? 35) * Math.PI) / 180;
const team = new THREE.Color(`#${q.get('team') ?? 'e0782a'}`);
const land = new THREE.Color(`#${q.get('land') ?? '8f7d58'}`);
const sea = new THREE.Color(`#${q.get('sea') ?? '1d3f5c'}`);
const cellPx = Number(q.get('cell') ?? 0);
const fill = Number(q.get('fill') ?? 0.78);

interface Inst { key: string; unit: boolean; x: number; y: number; z: number; s: number; rot?: number; params?: [number, number, number, number] }
interface Entry { label: string; insts: Inst[]; extent: number; water?: boolean }

const TANK_OFFS = [[0, -1.0], [-0.7, 0.05], [0.7, 0.05], [0, 1.1]];
const unit = (key: UnitModelKey, x = 0, z = 0, s = 1, y = 0, rot = 0): Inst => ({ key, unit: true, x, y, z, s, rot });
const struct = (key: StructModelKey, s = 1): Inst => ({ key, unit: false, x: 0, y: 0, z: 0, s });

function unitEntries(): Entry[] {
  const out: Entry[] = [];
  out.push({ label: 'warship', insts: [unit('warship')], extent: 1.0, water: true });
  out.push({ label: 'transport (convoy)', insts: [unit('transport')], extent: 1.0, water: true });
  out.push({ label: 'trade ship', insts: [unit('trade')], extent: 1.0, water: true });
  out.push({ label: 'armored division (4 tanks)', insts: TANK_OFFS.map(([ox, oz]) => unit('tank', ox, oz)), extent: 3.0 });
  out.push({ label: 'tank', insts: [unit('tank')], extent: 1.0 });
  out.push({ label: 'fighter squadron (3)', insts: [unit('fighter', 0, 0, 1, 0.3), unit('fighter', -0.95, 0.85, 1, 0.3), unit('fighter', 0.95, 0.85, 1, 0.3)], extent: 2.6 });
  out.push({ label: 'fighter', insts: [unit('fighter', 0, 0, 1, 0.3)], extent: 1.0 });
  out.push({ label: 'bomber', insts: [unit('bomber', 0, 0, 1, 0.3)], extent: 1.6 });
  out.push({ label: 'drone', insts: [unit('drone', 0, 0, 1, 0.3)], extent: 1.3 });
  const sw: Inst[] = [];
  for (let j = 0; j < 7; j++) {
    const ang = j * 2.39996, rr = j === 0 ? 0 : 0.7 + 0.35 * (j % 3);
    sw.push(unit('drone', Math.cos(ang) * rr, Math.sin(ang) * rr + 0.3, 1, 0.3 + 0.1 * Math.sin(j)));
  }
  out.push({ label: 'drone swarm (7)', insts: sw, extent: 3.2 });
  out.push({ label: 'train', insts: [unit('loco'), unit('wagon', 0, 1.02), unit('wagon', 0, 2.04), unit('wagon', 0, 3.06)], extent: 4.2 });
  out.push({ label: 'cruise missile', insts: [unit('cruise', 0, 0, 1, 0.3)], extent: 1.0 });
  out.push({ label: 'icbm', insts: [unit('icbm', 0, 0, 1, 0.3)], extent: 1.0 });
  out.push({ label: 'sam interceptor', insts: [unit('sam', 0, 0, 1, 0.3)], extent: 1.0 });
  out.push({ label: 'warhead', insts: [unit('warhead', 0, 0, 1, 0.3)], extent: 1.0 });
  return out;
}

const STRUCTS: StructModelKey[] = ['port', 'factory', 'defensePost', 'samSite', 'silo', 'airbase', 'armyBase', 'navalYard', 'radar'];

function structEntries(filter: string | null): Entry[] {
  const out: Entry[] = [];
  const keys = filter ? STRUCTS.filter((k) => filter.split(',').includes(k)) : STRUCTS;
  for (const k of keys) for (const L of [1, 2, 3]) {
    const insts: Inst[] = [{ key: 'pad', unit: false, x: 0, y: 0, z: 0, s: 1.03, params: [1, 0, 1, 0] }, struct(levelKey(k, L))];
    if (k === 'radar') insts.push({ key: 'radarDish', unit: false, x: 0.1, y: 0.38, z: -0.05, s: 1 });
    if (k === 'airbase') {
      // Parked aircraft on the apron slots (as index.ts draws them: fighters, a bomber, drones).
      const n = 3 * L;
      for (let i = 0; i < n; i++) {
        const [sx, sz] = AIRBASE_SLOTS[i];
        const type: UnitModelKey = i % 3 === 1 ? 'bomber' : i % 3 === 2 ? 'drone' : 'fighter';
        insts.push({ key: type, unit: true, x: sx, y: 0.016, z: sz, s: AIRBASE_PARK[type] });
      }
    }
    out.push({ label: `${k} L${L}`, insts, extent: 1.15, water: k === 'port' || k === 'navalYard' });
  }
  if (!filter || filter.includes('city')) out.push({ label: 'city base', insts: [struct('cityBase')], extent: 1.1 });
  return out;
}

/** Parked aircraft size as a fraction of the airbase footprint (mirrors index.ts). */
const AIRBASE_PARK: Record<string, number> = { fighter: 0.1, bomber: 0.068, drone: 0.05 };

const only = q.get('only');
const entriesAll = set === 'units' ? unitEntries() : set === 'structs' ? structEntries(q.get('only')) : set === 'air' ? structEntries('airbase') : unitEntries();
const entries = set === 'units' && only ? entriesAll.filter((e) => only.split(',').some((o) => e.label.startsWith(o))) : entriesAll;

const W = innerWidth, H = innerHeight;
const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.autoClear = false;
document.body.append(renderer.domElement);

// Sun from the upper left behind the viewer (afternoon light), as the shader expects a world "up" = normalize(pos).
env.sunDir.set(Number(q.get('sx') ?? -0.45), Number(q.get('sy') ?? 0.75), Number(q.get('sz') ?? 0.5)).normalize();
sharedUniforms.uTime.value = 1000;
minPxScale.value = 0;

const unitMat = createModelMaterial();
const structMat = createModelMaterial({ anchored: true, minPx: 1 });
const geoCache = new Map<string, THREE.BufferGeometry>();
const geo = (key: string, isUnit: boolean) => {
  let g = geoCache.get(key);
  if (!g) {
    g = isUnit ? buildUnitModel(key as UnitModelKey) : buildStructModel(key as StructModelKey);
    geoCache.set(key, g);
  }
  return g;
};

const n = entries.length;
const cols = Number(q.get('cols') ?? Math.ceil(Math.sqrt((n * W) / H)));
const rows = Math.ceil(n / cols);
const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
const S = 0.01; // model size in world units (the globe radius is 1)
const P0 = new THREE.Vector3(0, 1, 0);

entries.forEach((e, i) => {
  const cx = (i % cols) * cw, cy = Math.floor(i / cols) * ch;
  const vw = cellPx > 0 ? Math.min(cw, cellPx * 1.6) : cw, vh = cellPx > 0 ? Math.min(ch, cellPx) : ch;
  const scene = new THREE.Scene();
  // Ground: a disc of land or sea around the model.
  const gm = new THREE.Mesh(new THREE.CircleGeometry(S * 40, 48), new THREE.MeshBasicMaterial({ color: e.water ? sea : land }));
  gm.rotation.x = -Math.PI / 2;
  gm.position.copy(P0).addScaledVector(new THREE.Vector3(0, 1, 0), -S * 0.004);
  if (e.water && !e.insts.some((x) => !x.unit)) gm.position.y += S * 0.002;
  scene.add(gm);
  if (e.water && e.insts.some((x) => !x.unit)) {
    // Half land, half sea for coastal structures (sea on -Z, the quay side).
    const lm = new THREE.Mesh(new THREE.PlaneGeometry(S * 80, S * 40), new THREE.MeshBasicMaterial({ color: land }));
    lm.rotation.x = -Math.PI / 2;
    lm.position.copy(P0).add(new THREE.Vector3(0, -S * 0.003, S * 20 - S * 0.1));
    scene.add(lm);
  }
  const byKey = new Map<string, Inst[]>();
  for (const it of e.insts) (byKey.get(it.key + (it.unit ? '#u' : '#s')) ?? byKey.set(it.key + (it.unit ? '#u' : '#s'), []).get(it.key + (it.unit ? '#u' : '#s'))!).push(it);
  const m4 = new THREE.Matrix4();
  for (const [k, list] of byKey) {
    const isUnit = k.endsWith('#u');
    const key = k.slice(0, -2);
    const g = geo(key, isUnit).clone();
    const params = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
    g.setAttribute('iParams', params);
    let anchor: THREE.InstancedBufferAttribute | null = null;
    if (!isUnit) {
      anchor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 4), 4);
      g.setAttribute('iAnchor', anchor);
    }
    const mesh = new THREE.InstancedMesh(g, isUnit ? unitMat : structMat, list.length);
    list.forEach((it, j) => {
      const s = (it.s * S);
      // Structure-relative unit instances (parked aircraft) are placed in structure units.
      const sc = e.insts.some((x) => !x.unit) ? S : S * (1 / 1);
      const pos = new THREE.Vector3(P0.x + it.x * sc, P0.y + it.y * sc, P0.z + it.z * sc);
      if (key === 'pad') {
        m4.makeScale(s, S * 0.04, s).setPosition(pos.clone().add(new THREE.Vector3(0, -0.006 * S, 0)));
      } else {
        m4.makeRotationY(it.rot ?? 0).scale(new THREE.Vector3(s, s, s)).setPosition(pos);
      }
      mesh.setMatrixAt(j, m4);
      mesh.setColorAt(j, key === 'pad' ? new THREE.Color(1, 1, 1) : team);
      const p = it.params ?? [1, 0, 1, 0.3];
      params.setXYZW(j, p[0], p[1], p[2], p[3]);
      if (anchor) anchor.setXYZW(j, P0.x, P0.y, P0.z, S);
    });
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  const cam = new THREE.PerspectiveCamera(30, vw / vh, S * 0.01, 10);
  const ext = e.extent * S;
  const d = ext / (fill * 2 * Math.tan((15 * Math.PI) / 180)) * Math.max(1, (vh / vw) * 1.2);
  const target = P0.clone().add(new THREE.Vector3(0, ext * 0.08, e.insts.length > 1 && e.insts.every((x) => x.unit) ? S * 0.5 * (e.label.startsWith('train') ? 3 : 0.3) : 0));
  cam.position.set(target.x + Math.sin(azim) * Math.cos(elev) * d, target.y + Math.sin(elev) * d, target.z + Math.cos(azim) * Math.cos(elev) * d);
  cam.up.set(0, 1, 0);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  sharedUniforms.uPixelK.value = (2 * Math.tan((15 * Math.PI) / 180)) / vh;
  const y = H - cy - ch;
  renderer.setViewport(cx, y + (ch - vh) / 2, vw, vh);
  renderer.setScissor(cx, y, cw, ch);
  renderer.setScissorTest(true);
  renderer.setClearColor(0x20262b);
  renderer.clear();
  renderer.render(scene, cam);
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = e.label;
  cap.style.left = `${cx + 6}px`;
  cap.style.top = `${cy + 6}px`;
  document.body.append(cap);
});
(window as unknown as { __labReady: boolean }).__labReady = true;
