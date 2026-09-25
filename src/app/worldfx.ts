// FRONT ULTRA — world-event overlays on the strategic globe (owner: app).
// The sim publishes renderable world events in ctx.sim.view.worldEvents (hurricanes, earthquakes, gold rushes,
// pandemics, rebellions). This integrator module draws them on the planet so they are visible in 3D, not just in
// the ticker: a spiralling cyclone with an eye and eyewall that tracks across the ocean, seismic shock rings, a
// shimmering gold-field ring with sparkles, a sickly contagion haze, and a pulsing red insurrection ring.
//
// One pooled mesh per slot (MAX_SLOTS), all sharing one shader program (materials are clones, so no compile at
// runtime). Each mesh is a unit disk bent onto the sphere in the vertex shader (no per-frame geometry work).

import * as THREE from 'three';
import type { FrameInfo, GameContext, Subsystem } from '../shared/api';
import { MAP_H, MAP_W } from '../shared/constants';
import { tangentFrame, tileXYToLatLon } from '../shared/geo';
import type { LatLon, WorldEventKind } from '../shared/types';

const MAX_SLOTS = 10;
const TILE_RAD = (Math.PI * 2) / MAP_W; // angular size of one tile at the equator

const KIND_ID: Record<WorldEventKind, number> = { hurricane: 0, earthquake: 1, goldRush: 2, pandemic: 3, rebellion: 4, doomsday: -1 };
/** Visual radius relative to the sim's gameplay radius. */
const KIND_SCALE = [1.55, 1.25, 1.15, 1.05, 1.2];
/** Shell radius (1 = sea level); above the relief so mountains do not swallow the overlay. */
const KIND_SHELL = [1.0042, 1.0034, 1.0034, 1.0036, 1.0034];

const vert = /* glsl */ `
uniform vec3 uCenter;
uniform vec3 uEast;
uniform vec3 uNorth;
uniform float uTanAng;
uniform float uShell;
varying vec2 vQ;
varying float vFacing;
void main() {
  vQ = position.xy;
  vec3 dir = normalize(uCenter + (uEast * position.x + uNorth * position.y) * uTanAng);
  vec3 world = dir * uShell;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  // Fade toward the limb / back side so overlays never show through the planet edge.
  vFacing = dot(dir, normalize(cameraPosition - world));
  gl_Position = projectionMatrix * mv;
}`;

const frag = /* glsl */ `
uniform float uKind;
uniform float uTime;
uniform float uProgress;
uniform float uMag;
uniform float uOpacity;
uniform float uSpin;
uniform float uLight;
uniform float uHeading;
varying vec2 vQ;
varying float vFacing;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}

void main() {
  float r = length(vQ);
  if (r > 1.0) discard;
  float facing = smoothstep(0.02, 0.2, vFacing);
  vec3 col = vec3(0.0);
  float a = 0.0;
  int kind = int(uKind + 0.5);
  float edge = 1.0 - smoothstep(0.82, 1.0, r);

  if (kind == 0) {
    // ---- Hurricane: log-spiral rain bands around a clear eye, rotating (sign = hemisphere).
    float ang = atan(vQ.y, vQ.x);
    float t = uTime * uSpin;
    float swirl = ang * uSpin + log(max(r, 0.02)) * 3.2 - t * 0.35;
    vec2 sp = vec2(cos(swirl), sin(swirl)) * (0.6 + r * 2.5);
    float bands = 0.5 + 0.5 * sin(ang * 2.0 * uSpin + log(max(r, 0.02)) * 7.0 - t * 0.9);
    float n = fbm(sp * 2.2 + vec2(t * 0.05, 0.0));
    float n2 = fbm(vQ * 7.0 + vec2(swirl * 0.6, 0.0));
    float core = smoothstep(1.0, 0.25, r);
    float dens = core * (0.45 + 0.55 * bands) * (0.55 + 0.75 * n) + 0.25 * n2 * core;
    dens = clamp(dens * 1.35 - 0.12, 0.0, 1.0);
    // The eye and its bright wall.
    float eye = smoothstep(0.05, 0.1, r);
    float wall = exp(-pow((r - 0.13) / 0.05, 2.0));
    dens = max(dens * eye, wall * 0.95);
    float cat = clamp(uMag / 5.0, 0.2, 1.0);
    dens *= mix(0.65, 1.0, cat) * edge;
    vec3 cloud = mix(vec3(0.62, 0.66, 0.72), vec3(1.0), n);
    col = cloud * (0.12 + 1.05 * uLight);
    a = dens * 0.92;
  } else if (kind == 1) {
    // ---- Earthquake: expanding shock rings from the epicentre, hot core.
    float s = 0.0;
    for (int i = 0; i < 3; i++) {
      float ph = fract(uTime * 0.28 + float(i) / 3.0);
      float w = 0.025 + ph * 0.05;
      s += exp(-pow((r - ph) / w, 2.0)) * (1.0 - ph) * (1.0 - ph);
    }
    float jag = 0.75 + 0.5 * noise(vec2(atan(vQ.y, vQ.x) * 6.0, uTime));
    float coreGlow = exp(-r * r / 0.012) * (0.6 + 0.4 * sin(uTime * 9.0));
    float life = 1.0 - smoothstep(0.55, 1.0, uProgress);
    col = vec3(1.0, 0.42, 0.08) * (s * jag * 2.2 + coreGlow * 3.0) + vec3(1.0, 0.8, 0.5) * coreGlow;
    a = 1.0;
    col *= life * edge;
  } else if (kind == 2) {
    // ---- Gold rush: dashed rotating perimeter, warm fill and sparkles.
    float ang = atan(vQ.y, vQ.x);
    float dash = step(0.45, fract(ang * 9.0 / 6.2832 + uTime * 0.06));
    float ring = exp(-pow((r - 0.9) / 0.018, 2.0)) * (0.35 + 0.65 * dash);
    float ring2 = exp(-pow((r - 0.8) / 0.008, 2.0)) * 0.5;
    vec2 cell = floor(vQ * 22.0);
    float h = hash(cell);
    float tw = pow(max(0.0, sin(uTime * (1.5 + h * 3.0) + h * 40.0)), 18.0) * step(0.82, h) * smoothstep(0.85, 0.3, r);
    vec2 f = fract(vQ * 22.0) - 0.5;
    float spark = tw * exp(-dot(f, f) * 60.0);
    float fill = smoothstep(0.9, 0.0, r) * 0.18 * (0.8 + 0.2 * sin(uTime * 2.0));
    col = vec3(1.0, 0.72, 0.18) * (ring * 2.4 + ring2 + fill) + vec3(1.0, 0.9, 0.55) * spark * 5.0;
    a = 1.0;
  } else if (kind == 3) {
    // ---- Pandemic: drifting cellular contagion haze with a pulsing quarantine edge.
    float n = fbm(vQ * 6.0 + vec2(uTime * 0.07, -uTime * 0.05));
    float cells = smoothstep(0.55, 0.8, n);
    float pulse = 0.65 + 0.35 * sin(uTime * 2.2 - r * 8.0);
    float ring = exp(-pow((r - 0.94) / 0.02, 2.0)) * (0.5 + 0.5 * sin(atan(vQ.y, vQ.x) * 24.0 + uTime * 2.0));
    col = vec3(0.45, 1.0, 0.25) * (cells * 0.55 * pulse + 0.08 * edge + ring * 1.4);
    a = 1.0;
    col *= edge + ring;
  } else {
    // ---- Rebellion: flickering red unrest and a hard pulsing perimeter.
    float ring = exp(-pow((r - 0.92) / 0.02, 2.0));
    float beat = 0.55 + 0.45 * sin(uTime * 5.0);
    float n = fbm(vQ * 9.0 + uTime * 0.3);
    float fires = smoothstep(0.62, 0.8, n) * smoothstep(0.95, 0.2, r) * (0.6 + 0.4 * sin(uTime * 13.0 + n * 30.0));
    col = vec3(1.0, 0.12, 0.08) * (ring * 2.2 * beat + 0.06 * edge) + vec3(1.0, 0.45, 0.1) * fires * 1.6;
    a = 1.0;
  }
  float o = uOpacity * facing;
  gl_FragColor = vec4(col * (kind == 0 ? 1.0 : o), a * (kind == 0 ? o : 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Slot {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  id: number;
  kind: number;
  /** Displayed (smoothed) tile position and radius. */
  x: number;
  y: number;
  radius: number;
  opacity: number;
  alive: boolean;
}

export interface WorldFx extends Subsystem {
  readonly root: THREE.Group;
}

export function createWorldFx(ctx: GameContext): WorldFx {
  const root = new THREE.Group();
  root.name = 'worldEvents';
  root.renderOrder = 35;
  ctx.scene.add(root);

  const geo = new THREE.PlaneGeometry(2, 2, 40, 40);
  const base = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uCenter: { value: new THREE.Vector3(1, 0, 0) },
      uEast: { value: new THREE.Vector3(0, 0, -1) },
      uNorth: { value: new THREE.Vector3(0, 1, 0) },
      uTanAng: { value: 0.05 },
      uShell: { value: 1.004 },
      uKind: { value: 0 },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uMag: { value: 1 },
      uOpacity: { value: 0 },
      uSpin: { value: 1 },
      uLight: { value: 1 },
      uHeading: { value: 0 },
    },
  });

  const slots: Slot[] = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const mat = base.clone();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 35;
    mesh.visible = false;
    root.add(mesh);
    slots.push({ mesh, mat, id: -1, kind: 0, x: 0, y: 0, radius: 0, opacity: 0, alive: false });
  }

  const ll: LatLon = { lat: 0, lon: 0 };
  const east = new THREE.Vector3(), north = new THREE.Vector3(), up = new THREE.Vector3();
  const sun = new THREE.Vector3();
  let warm = false;

  function place(s: Slot): void {
    tileXYToLatLon(s.x, s.y, ll);
    tangentFrame(ll.lat, ll.lon, east, north, up);
    const u = s.mat.uniforms;
    (u.uCenter.value as THREE.Vector3).copy(up);
    (u.uEast.value as THREE.Vector3).copy(east);
    (u.uNorth.value as THREE.Vector3).copy(north);
    const ang = Math.max(3, s.radius * KIND_SCALE[s.kind]) * TILE_RAD;
    u.uTanAng.value = Math.tan(Math.min(0.9, ang));
    u.uShell.value = KIND_SHELL[s.kind];
    u.uSpin.value = ll.lat >= 0 ? 1 : -1;
    ctx.globe.getSunDirection(sun);
    u.uLight.value = Math.max(0, Math.min(1, sun.dot(up) * 1.4 + 0.25));
  }

  function reset(): void {
    for (const s of slots) {
      s.alive = false;
      s.id = -1;
      s.opacity = 0;
      s.mesh.visible = false;
    }
  }

  return {
    root,
    async init() {},
    warmup(on) {
      warm = on;
      for (const s of slots) s.mesh.visible = on;
      if (on) for (const s of slots) s.mat.uniforms.uOpacity.value = 0;
    },
    onGameEnd: reset,
    update(frame: FrameInfo) {
      if (warm) return;
      const events = ctx.sim.view.worldEvents;
      for (const s of slots) s.alive = false;
      for (const e of events) {
        const kind = KIND_ID[e.kind];
        if (kind === undefined || kind < 0 || e.radius <= 0) continue;
        let s = slots.find((q) => q.id === e.id);
        if (!s) {
          s = slots.find((q) => q.id === -1 && q.opacity <= 0.001);
          if (!s) continue;
          s.id = e.id;
          s.kind = kind;
          s.x = e.x;
          s.y = e.y;
          s.radius = e.radius;
          s.opacity = 0;
          s.mat.blending = kind === 0 ? THREE.NormalBlending : THREE.AdditiveBlending;
          s.mat.uniforms.uKind.value = kind;
        }
        s.alive = true;
        // Smooth the 4-10 tick state updates (hurricanes move); handle the x wrap.
        let dx = e.x - s.x;
        if (dx > MAP_W / 2) dx -= MAP_W;
        else if (dx < -MAP_W / 2) dx += MAP_W;
        const k = Math.min(1, frame.dt * 2.5);
        s.x = (s.x + dx * k + MAP_W) % MAP_W;
        s.y = Math.max(0, Math.min(MAP_H, s.y + (e.y - s.y) * k));
        s.radius += (e.radius - s.radius) * k;
        const u = s.mat.uniforms;
        u.uProgress.value = e.progress;
        u.uMag.value = e.magnitude;
        u.uHeading.value = e.heading;
      }
      const t = frame.simTime;
      for (const s of slots) {
        if (s.id === -1) continue;
        const target = s.alive ? 1 : 0;
        s.opacity += (target - s.opacity) * Math.min(1, frame.dt * 1.8);
        if (!s.alive && s.opacity < 0.01) {
          s.id = -1;
          s.opacity = 0;
          s.mesh.visible = false;
          continue;
        }
        place(s);
        const u = s.mat.uniforms;
        u.uTime.value = t;
        u.uOpacity.value = s.opacity;
        s.mesh.visible = true;
      }
    },
  };
}
