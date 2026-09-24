// FRONT ULTRA — units & structures on the globe (owner: units).
// STUB by the architect: one InstancedMesh of markers for structures and one for units, positioned from
// ctx.sim.view every frame (units interpolated with frame.simAlpha), screen-space picking.
// The units owner replaces it with real procedural meshes (ships with wakes, jets with contrails, missiles
// on ballistic arcs, structure models, selection rings, build ghosts, LOD). Keep createUnitsRenderer(ctx).

import * as THREE from 'three';
import type { FrameInfo, GameContext, UnitsApi } from '../../shared/api';
import { kmToUnits, tileToLatLon, tileXYToLatLon, latLonToVec3 } from '../../shared/geo';
import { lerp } from '../../shared/math';
import type { LatLon } from '../../shared/types';

const MAX_UNITS = 4096;
const MAX_STRUCTURES = 4096;

export function createUnitsRenderer(ctx: GameContext): UnitsApi {
  const root = new THREE.Group();
  root.name = 'units';
  ctx.scene.add(root);
  const unitMesh = new THREE.InstancedMesh(new THREE.ConeGeometry(0.5, 1.4, 6).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_UNITS);
  const structMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff }), MAX_STRUCTURES);
  for (const m of [unitMesh, structMesh]) {
    m.count = 0;
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    root.add(m);
  }
  const unitIds: number[] = [];
  const structIds: number[] = [];
  const unitPos = new Map<number, THREE.Vector3>();
  const structPos = new Map<number, THREE.Vector3>();
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), color = new THREE.Color();
  const ll: LatLon = { lat: 0, lon: 0 };
  const tmp = new THREE.Vector3();

  function markerScale(): number {
    const alt = ctx.cameraRig.getState().altitudeKm;
    return kmToUnits(Math.max(8, alt * 0.012));
  }

  function pickFrom(ids: number[], pos: Map<number, THREE.Vector3>, clientX: number, clientY: number): number {
    const r = ctx.canvas.getBoundingClientRect();
    let best = -1, bestD = 14 * 14;
    const camDir = tmp.copy(ctx.camera.position).normalize();
    for (const id of ids) {
      const w = pos.get(id);
      if (!w) continue;
      if (w.dot(camDir) < 0.1) continue; // far side of the planet
      p.copy(w).project(ctx.camera);
      const x = r.left + ((p.x + 1) / 2) * r.width, y = r.top + ((1 - p.y) / 2) * r.height;
      const d = (x - clientX) ** 2 + (y - clientY) ** 2;
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  return {
    async init(progress) {
      progress(1);
    },
    onGameEnd() {
      unitMesh.count = 0;
      structMesh.count = 0;
      unitPos.clear();
      structPos.clear();
    },
    update(frame: FrameInfo) {
      const view = ctx.sim.view;
      const k = markerScale();
      // Structures
      let n = 0;
      structIds.length = 0;
      for (const st of view.structures.values()) {
        if (n >= MAX_STRUCTURES) break;
        tileToLatLon(st.tile, ll);
        const v = structPos.get(st.id) ?? new THREE.Vector3();
        latLonToVec3(ll.lat, ll.lon, ctx.globe.surfaceRadiusAt(ll.lat, ll.lon) + k * 0.5, v);
        structPos.set(st.id, v);
        q.setFromUnitVectors(up, tmp.copy(v).normalize());
        s.setScalar(k * (0.6 + 0.4 * st.built));
        m4.compose(v, q, s);
        structMesh.setMatrixAt(n, m4);
        structMesh.setColorAt(n, color.setHex(view.players[st.owner]?.color ?? 0xffffff));
        structIds.push(st.id);
        n++;
      }
      structMesh.count = n;
      structMesh.instanceMatrix.needsUpdate = true;
      if (structMesh.instanceColor) structMesh.instanceColor.needsUpdate = true;
      // Units
      n = 0;
      unitIds.length = 0;
      const a = frame.simAlpha;
      for (const u of view.units.values()) {
        if (n >= MAX_UNITS) break;
        tileXYToLatLon(lerp(u.prevX, u.x, a), lerp(u.prevY, u.y, a), ll);
        const alt = lerp(u.prevAlt, u.alt, a);
        const v = unitPos.get(u.id) ?? new THREE.Vector3();
        latLonToVec3(ll.lat, ll.lon, 1 + k + alt * kmToUnits(400), v);
        unitPos.set(u.id, v);
        q.setFromUnitVectors(up, tmp.copy(v).normalize());
        s.setScalar(k);
        m4.compose(v, q, s);
        unitMesh.setMatrixAt(n, m4);
        unitMesh.setColorAt(n, color.setHex(view.players[u.owner]?.color ?? 0xffffff));
        unitIds.push(u.id);
        n++;
      }
      unitMesh.count = n;
      unitMesh.instanceMatrix.needsUpdate = true;
      if (unitMesh.instanceColor) unitMesh.instanceColor.needsUpdate = true;
      for (const id of unitPos.keys()) if (!view.units.has(id)) unitPos.delete(id);
      for (const id of structPos.keys()) if (!view.structures.has(id)) structPos.delete(id);
    },
    pickUnit(clientX, clientY) {
      return pickFrom(unitIds, unitPos, clientX, clientY);
    },
    pickStructure(clientX, clientY) {
      return pickFrom(structIds, structPos, clientX, clientY);
    },
    getUnitWorldPosition(unitId, out) {
      const v = unitPos.get(unitId);
      if (!v) return false;
      out.copy(v);
      return true;
    },
  };
}
