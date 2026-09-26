// FRONT ULTRA — tile marks on the globe (DESIGN_V2 §4.15, §5.12, §8.2; owner: globe, added by W3).
//
// Named sets of tiles drawn as pulsing squares on the ground: the band of land a peace treaty or a demand would cede
// (previewed before sending), the region of an unrest warning, a demanded band in an ultimatum. One THREE.Points object
// per set, sized to the tile (sizeAttenuation) with a pixel floor so a band still reads from 3,000 km. Built at init
// with a placeholder point so the shader compiles with the others at load.

import * as THREE from 'three';
import { tileToLatLon } from '../../shared/geo';
import { latLonToVec3 } from '../../shared/geo';

const vert = /* glsl */ `
uniform float uScale;
uniform float uMinPx;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(uMinPx, uScale / -mv.z);
}`;

const frag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uPulse;
void main() {
  vec2 d = abs(gl_PointCoord - 0.5) * 2.0;
  float m = max(d.x, d.y);
  if (m > 1.0) discard;
  float edge = smoothstep(0.62, 0.95, m);
  float pulse = mix(1.0, 0.55 + 0.45 * sin(uTime * 4.0), uPulse);
  gl_FragColor = vec4(uColor, (0.38 + 0.5 * edge) * pulse);
}`;

export interface TileMarks {
  group: THREE.Group;
  set(key: string, tiles: ArrayLike<number> | null, color?: number, pulse?: boolean): void;
  update(timeSec: number, viewportH: number, fovDeg: number): void;
  clear(): void;
}

const TILE_WORLD = 25.02 / 6371;

export function createTileMarks(radiusAt: (lat: number, lon: number) => number): TileMarks {
  const group = new THREE.Group();
  group.name = 'tile-marks';
  group.renderOrder = 6;
  const sets = new Map<string, THREE.Points>();
  const ll = { lat: 0, lon: 0 };
  const v = new THREE.Vector3();

  const make = (): THREE.Points => {
    const mat = new THREE.ShaderMaterial({
      vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false,
      uniforms: { uColor: { value: new THREE.Color(0xffb53d) }, uTime: { value: 0 }, uPulse: { value: 1 }, uScale: { value: 1 }, uMinPx: { value: 3 } },
    });
    const pts = new THREE.Points(new THREE.BufferGeometry(), mat);
    pts.frustumCulled = false;
    pts.renderOrder = 6;
    return pts;
  };

  // Placeholder (compiled at load, then emptied on the first clear).
  const warm = make();
  warm.geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  warm.visible = true;
  sets.set('__warm', warm);
  group.add(warm);

  function set(key: string, tiles: ArrayLike<number> | null, color = 0xffb53d, pulse = true): void {
    const old = sets.get(key);
    if (old) {
      group.remove(old);
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
      sets.delete(key);
    }
    if (!tiles || tiles.length === 0) return;
    const pos = new Float32Array(tiles.length * 3);
    for (let i = 0; i < tiles.length; i++) {
      tileToLatLon(tiles[i], ll);
      latLonToVec3(ll.lat, ll.lon, radiusAt(ll.lat, ll.lon) + 0.0006, v);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z;
    }
    const pts = make();
    pts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = pts.material as THREE.ShaderMaterial;
    (m.uniforms.uColor.value as THREE.Color).setHex(color);
    m.uniforms.uPulse.value = pulse ? 1 : 0;
    sets.set(key, pts);
    group.add(pts);
  }

  return {
    group,
    set,
    update(timeSec, viewportH, fovDeg) {
      // Point size in px of one tile at distance z: TILE_WORLD × (viewportH / 2) / tan(fov / 2) / z.
      const scale = (TILE_WORLD * viewportH * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
      for (const [k, p] of sets) {
        if (k === '__warm') continue;
        const m = p.material as THREE.ShaderMaterial;
        m.uniforms.uTime.value = timeSec;
        m.uniforms.uScale.value = scale * 1.05;
        m.uniforms.uMinPx.value = 2.5;
      }
    },
    clear() {
      for (const k of [...sets.keys()]) set(k, null);
    },
  };
}
