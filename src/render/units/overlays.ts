// FRONT ULTRA — tactical overlays on the globe (owner: units): selection rings, weapon targeting (blast radius
// rings with a rotating reticle), build-placement ghosts (holographic structure preview, green/red) and order
// paths (animated dashed great-circle toward the target). Everything is drawn on top (renderOrder 60) with an
// analytic horizon test instead of the depth buffer, so relief never hides a ring.

import * as THREE from 'three';
import { EARTH_RADIUS_KM, TILE_KM } from '../../shared/constants';
import { latLonToVec3, tangentFrame } from '../../shared/geo';
import type { LatLon } from '../../shared/types';
import { sharedUniforms } from './common';
import { createModelMaterial } from './material';
import { SurfaceRibbon } from './rails';

const MAX_RINGS = 64;

const VERT = /* glsl */ `
attribute vec4 iC;   // center dir xyz, radius (world units)
attribute vec4 iE;   // east xyz, min radius px
attribute vec4 iN;   // north xyz, style
attribute vec4 iCol; // rgb, alpha
attribute vec4 iX;   // lift (world units), dash count, spin, pulse phase
uniform float uPixelK;
varying vec2 vL;
varying vec4 vCol;
varying float vStyle;
varying vec4 vX;
varying vec3 vWorld;
varying float vPxR;
void main() {
  vec3 c = iC.xyz * (1.0 + iX.x);
  float dist = distance(cameraPosition, c);
  float r = max(iC.w, iE.w * uPixelK * dist);
  vec3 p = normalize(c + (iE.xyz * position.x + iN.xyz * position.y) * r) * (1.0 + iX.x);
  vL = position.xy;
  vCol = iCol;
  vStyle = iN.w;
  vX = iX;
  vWorld = p;
  vPxR = r / (uPixelK * dist);
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vL;
varying vec4 vCol;
varying float vStyle;
varying vec4 vX;
varying vec3 vWorld;
varying float vPxR;
void main() {
  if (dot(normalize(vWorld), cameraPosition - vWorld) < 0.0) discard;
  float r = length(vL);
  float ang = atan(vL.y, vL.x);
  float px = 1.0 / max(vPxR, 1.0);  // one pixel in ring units
  float a = 0.0;
  vec3 col = vCol.rgb;
  float pulse = 0.75 + 0.25 * sin(uTime * 4.0 + vX.w);
  if (vStyle < 0.5) {
    // Selection: crisp double ring with rotating dashes.
    float ring = 1.0 - smoothstep(px * 1.0, px * 2.2, abs(r - 1.0));
    float dash = step(0.35, fract((ang / 6.2831) * vX.y + uTime * vX.z));
    float inner = (1.0 - smoothstep(px * 0.6, px * 1.6, abs(r - 0.82))) * 0.5;
    a = ring * mix(0.45, 1.0, dash) + inner;
    a *= pulse;
  } else if (vStyle < 1.5) {
    // Blast inner radius: bright solid ring + hot fill.
    float ring = 1.0 - smoothstep(px * 1.2, px * 3.0, abs(r - 1.0));
    float fill = step(r, 1.0) * (0.10 + 0.08 * sin(r * 40.0 - uTime * 6.0));
    a = ring + fill * pulse;
  } else if (vStyle < 2.5) {
    // Blast outer radius: dashed ring + faint fill + rotating reticle ticks.
    float ring = 1.0 - smoothstep(px * 1.0, px * 2.4, abs(r - 1.0));
    float dash = step(0.45, fract((ang / 6.2831) * vX.y - uTime * vX.z));
    float fill = step(r, 1.0) * 0.05;
    float tick = 0.0;
    for (int i = 0; i < 4; i++) {
      float ta = float(i) * 1.5708 + uTime * 0.6;
      float da = abs(mod(ang - ta + 3.14159, 6.28318) - 3.14159);
      tick = max(tick, step(da * r, px * 1.6) * step(0.84, r) * step(r, 1.12));
    }
    a = ring * dash + fill + tick;
  } else {
    // Build footprint: soft disc.
    a = (1.0 - smoothstep(0.7, 1.0, r)) * 0.18 + (1.0 - smoothstep(px, px * 2.5, abs(r - 1.0))) * 0.8;
    a *= pulse;
  }
  a *= vCol.a;
  if (r > 1.25 || a < 0.01) discard;
  gl_FragColor = vec4(col * a * 1.6, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface RingSpec {
  lat: number;
  lon: number;
  /** Radius in km (the real radius) and the minimum on-screen radius in px. */
  radiusKm: number;
  minPx: number;
  style: 0 | 1 | 2 | 3;
  color: number;
  alpha: number;
  liftKm?: number;
  dashes?: number;
  spin?: number;
}

export class Overlays {
  readonly group = new THREE.Group();
  private geo: THREE.InstancedBufferGeometry;
  private mesh: THREE.Mesh;
  private aC: THREE.InstancedBufferAttribute;
  private aE: THREE.InstancedBufferAttribute;
  private aN: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private aX: THREE.InstancedBufferAttribute;
  private attrs: THREE.InstancedBufferAttribute[];
  private n = 0;
  readonly path: SurfaceRibbon;
  private ghosts = new Map<string, THREE.InstancedMesh>();
  private ghostMat: THREE.ShaderMaterial;
  private e = new THREE.Vector3();
  private no = new THREE.Vector3();
  private u = new THREE.Vector3();
  private c = new THREE.Color();
  private m4 = new THREE.Matrix4();
  private gp = new THREE.Vector3();
  private gb = new THREE.Vector3();
  private gs = new THREE.Vector3();

  constructor() {
    const ring = new THREE.RingGeometry(0, 1.25, 96, 3);
    const g = new THREE.InstancedBufferGeometry();
    g.index = ring.index;
    g.setAttribute('position', ring.getAttribute('position'));
    const mk = () => new THREE.InstancedBufferAttribute(new Float32Array(MAX_RINGS * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aC = mk();
    this.aE = mk();
    this.aN = mk();
    this.aCol = mk();
    this.aX = mk();
    g.setAttribute('iC', this.aC);
    g.setAttribute('iE', this.aE);
    g.setAttribute('iN', this.aN);
    g.setAttribute('iCol', this.aCol);
    g.setAttribute('iX', this.aX);
    this.attrs = [this.aC, this.aE, this.aN, this.aCol, this.aX];
    g.instanceCount = 0;
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      name: 'units-overlay-rings',
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uPixelK: sharedUniforms.uPixelK, uTime: sharedUniforms.uTime },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 61;
    this.path = new SurfaceRibbon(512, { widthKm: 1.2, minPx: 2.2, dash: 18, opacity: 0.95, lift: 0.3, depthTest: false, name: 'units-order-path', renderOrder: 62 });
    this.path.material.uniforms.uGlow.value = 0.6;
    this.ghostMat = createModelMaterial({ ghost: true });
    this.group.add(this.mesh, this.path.mesh);
  }

  /** Register the ghost geometry for a structure type (shares the structure's geometry). */
  addGhost(key: string, geo: THREE.BufferGeometry): void {
    const m = new THREE.InstancedMesh(geo, this.ghostMat, 1);
    m.visible = false;
    m.frustumCulled = false;
    m.renderOrder = 63;
    this.ghosts.set(key, m);
    this.group.add(m);
  }

  begin(): void {
    this.n = 0;
  }

  ring(s: RingSpec, radiusAt: (lat: number, lon: number) => number): void {
    if (this.n >= MAX_RINGS) return;
    const i = this.n++;
    tangentFrame(s.lat, s.lon, this.e, this.no, this.u);
    const r = radiusAt(s.lat, s.lon);
    const o = i * 4;
    const C = this.aC.array as Float32Array, E = this.aE.array as Float32Array, N = this.aN.array as Float32Array;
    const CO = this.aCol.array as Float32Array, X = this.aX.array as Float32Array;
    C[o] = this.u.x; C[o + 1] = this.u.y; C[o + 2] = this.u.z; C[o + 3] = s.radiusKm / EARTH_RADIUS_KM;
    E[o] = this.e.x; E[o + 1] = this.e.y; E[o + 2] = this.e.z; E[o + 3] = s.minPx;
    N[o] = this.no.x; N[o + 1] = this.no.y; N[o + 2] = this.no.z; N[o + 3] = s.style;
    this.c.setHex(s.color);
    CO[o] = this.c.r; CO[o + 1] = this.c.g; CO[o + 2] = this.c.b; CO[o + 3] = s.alpha;
    X[o] = r - 1 + (s.liftKm ?? 0.3) / EARTH_RADIUS_KM; X[o + 1] = s.dashes ?? 24; X[o + 2] = s.spin ?? 0.15; X[o + 3] = i * 1.7;
  }

  end(): void {
    this.geo.instanceCount = this.n;
    if (this.n > 0) for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, this.n * 4);
      a.needsUpdate = true;
    }
  }

  /** Show one structure ghost (key) at a lat/lon with a footprint size in km, or hide all (key null). */
  ghost(key: string | null, at: LatLon | null, sizeKm: number, minPx: number, valid: boolean, radiusAt: (lat: number, lon: number) => number, camPos: THREE.Vector3, pixelK: number): void {
    for (const [k, m] of this.ghosts) m.visible = k === key && !!at;
    if (!key || !at) return;
    const m = this.ghosts.get(key);
    if (!m) return;
    tangentFrame(at.lat, at.lon, this.e, this.no, this.u);
    const r = radiusAt(at.lat, at.lon);
    const p = latLonToVec3(at.lat, at.lon, r, this.gp);
    const dist = camPos.distanceTo(p);
    const size = Math.max(sizeKm / EARTH_RADIUS_KM, minPx * pixelK * dist);
    this.gb.copy(this.no).negate();
    this.m4.makeBasis(this.e, this.u, this.gb);
    this.gs.setScalar(size);
    this.m4.scale(this.gs);
    this.m4.setPosition(p);
    m.setMatrixAt(0, this.m4);
    m.instanceMatrix.needsUpdate = true;
    (this.ghostMat.uniforms.uGhostColor.value as THREE.Color).setRGB(valid ? 0.25 : 1.0, valid ? 1.0 : 0.22, valid ? 0.55 : 0.18);
  }

  warmup(on: boolean): void {
    for (const m of this.ghosts.values()) m.visible = on;
    if (on) this.geo.instanceCount = Math.max(1, this.geo.instanceCount);
  }
}

export const tilesToKm = (tiles: number): number => tiles * TILE_KM;
