// FRONT ULTRA — command mode: shared materials (owner: command). Created once in init() so every program is
// compiled during the loading screen; per-session changes only touch uniforms / colors (never new programs).

import * as THREE from 'three';

export type Team = 0 | 1;

export interface CmdMaterials {
  /** Vehicle paint per team (vertex colors x camo tint x procedural 3-tone camo). */
  paint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  /** Naval gray per team. */
  shipPaint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  /** Aircraft paint per team (smooth, slight sheen). */
  jetPaint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  /** Team marking (nation color flag/stripe), slightly emissive so it reads at distance. */
  mark: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial];
  /** Burnt-out wreck. */
  wreck: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  /** Soldiers: vertex colors x instance color (team). */
  soldier: THREE.MeshStandardMaterial;
  /** Afterburner / rocket flame (additive HDR). */
  flame: THREE.ShaderMaterial;
  /** Concrete / props (vertex colors). */
  prop: THREE.MeshStandardMaterial;
  /** Missiles and bombs. */
  ordnance: THREE.MeshStandardMaterial;
  setTeamColors(friendly: number, enemy: number): void;
}

const CAMO_VERT_PARS = /* glsl */ `
varying vec3 vObjPos;
varying vec3 vObjN;
`;
const CAMO_FRAG_PARS = /* glsl */ `
uniform sampler2D uCamoNoise;
uniform float uCamoAmount;
uniform vec3 uCamoA;
uniform vec3 uCamoB;
uniform vec3 uCamoC;
uniform float uCamoScale;
varying vec3 vObjPos;
varying vec3 vObjN;
float camoTri(vec3 p, vec3 w) {
  return texture2D(uCamoNoise, p.zy).b * w.x + texture2D(uCamoNoise, p.xz).b * w.y + texture2D(uCamoNoise, p.xy).b * w.z;
}
float camoTri2(vec3 p, vec3 w) {
  return texture2D(uCamoNoise, p.zy).r * w.x + texture2D(uCamoNoise, p.xz).r * w.y + texture2D(uCamoNoise, p.xy).r * w.z;
}
`;
const CAMO_FRAG = /* glsl */ `
{
  vec3 op = vObjPos;
  vec3 w = abs(normalize(vObjN));
  w = w * w * w;
  w /= (w.x + w.y + w.z + 1e-4);
  // Hard-edged disruptive pattern: large blobs with a fine octave to break the edges.
  float n = camoTri(op * uCamoScale + vec3(0.21, 0.37, 0.53), w) * 0.8 + camoTri2(op * uCamoScale * 1.9, w) * 0.2;
  float t1 = smoothstep(0.42, 0.45, n);
  float t2 = smoothstep(0.575, 0.605, n);
  vec3 camo = mix(mix(uCamoA, uCamoB, t1), uCamoC, t2);
  // Grime streaks and paint fading
  float grime = texture2D(uCamoNoise, op.xz * 0.9 + op.y * 0.35).g;
  float streak = texture2D(uCamoNoise, vec2(op.x * 0.6 + op.z * 0.6, op.y * 0.08)).a;
  camo *= 0.82 + grime * 0.26 - smoothstep(0.55, 0.9, streak) * 0.12 * (1.0 - w.y);
  // Only painted parts (bright vertex colors) get the pattern; their brightness shades it (panels, sub-parts).
  float lum = max(vColor.r, max(vColor.g, vColor.b));
  float painted = smoothstep(0.25, 0.5, lum) * uCamoAmount;
  vec3 paintCol = camo * (lum / 0.86);
  diffuseColor.rgb = mix(diffuseColor.rgb, paintCol, painted);
#ifdef USE_COLOR_ALPHA
  // Dust and dried mud baked into the vertex alpha (see bakeDust).
  float dust = 1.0 - vColor.a;
  vec3 dustCol = mix(vec3(0.085, 0.066, 0.045), vec3(0.2, 0.165, 0.115), grime);
  diffuseColor.rgb = mix(diffuseColor.rgb, dustCol, dust * 0.7 * uCamoAmount);
  diffuseColor.a = 1.0;
#endif
}
`;

interface CamoUniforms {
  a: THREE.Color;
  b: THREE.Color;
  c: THREE.Color;
}

function camo(mat: THREE.MeshStandardMaterial, noise: THREE.Texture, amount: number, scale: number): CamoUniforms {
  const u: CamoUniforms = { a: new THREE.Color(1, 1, 1), b: new THREE.Color(1, 1, 1), c: new THREE.Color(1, 1, 1) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCamoNoise = { value: noise };
    shader.uniforms.uCamoAmount = { value: amount };
    shader.uniforms.uCamoScale = { value: scale };
    shader.uniforms.uCamoA = { value: u.a };
    shader.uniforms.uCamoB = { value: u.b };
    shader.uniforms.uCamoC = { value: u.c };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CAMO_VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position; vObjN = objectNormal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CAMO_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CAMO_FRAG}`);
  };
  // One program for every camo material: amount / scale / palette are uniforms.
  mat.customProgramCacheKey = () => 'fu-camo2';
  return u;
}

/** Camouflage palettes (sRGB hex): [team 0 (the player's side), team 1 (the enemy)]. */
const PALETTE = {
  // NATO three-tone (green / brown / black) vs a desert two-tone with olive patches.
  paint: [[0x4a5530, 0x5a4a2e, 0x2a2b26], [0xa08c62, 0x86744f, 0x62603f]],
  // Haze gray with faint mottling vs a warmer gray.
  navy: [[0x858d95, 0x7e868e, 0x747c84], [0x8e8a82, 0x87837b, 0x7c7870]],
  // Air-superiority two-tone grey vs a blue-grey splinter scheme.
  air: [[0x9aa2aa, 0x7b848d, 0x6a727b], [0xa9b8c2, 0x7f93a0, 0x62768a]],
  wreck: [0x2b2723, 0x1c1a18, 0x3b2d22],
} as const;

export function createMaterials(noise: THREE.Texture): CmdMaterials {
  const pals: { u: CamoUniforms; hex: readonly number[]; team: number }[] = [];
  const mk = (color: number, rough: number, metal: number, camoAmt: number, scale: number, hex: readonly number[] | null, team = -1) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, vertexColors: true });
    if (camoAmt > 0 && hex) {
      const u = camo(m, noise, camoAmt, scale);
      u.a.setHex(hex[0]);
      u.b.setHex(hex[1]);
      u.c.setHex(hex[2]);
      pals.push({ u, hex, team });
    }
    return m;
  };
  const paint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [
    mk(0xb4b4ac, 0.82, 0.04, 1, 0.2, PALETTE.paint[0], 0), mk(0xb4b4ac, 0.86, 0.03, 1, 0.16, PALETTE.paint[1], 1),
  ];
  const shipPaint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [
    mk(0x8a9098, 0.7, 0.08, 1, 0.05, PALETTE.navy[0], 0), mk(0x8c8a84, 0.7, 0.08, 1, 0.05, PALETTE.navy[1], 1),
  ];
  const jetPaint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [
    mk(0xb0b4b8, 0.58, 0.18, 1, 0.07, PALETTE.air[0], 0), mk(0xb0b4b8, 0.58, 0.18, 1, 0.07, PALETTE.air[1], 1),
  ];
  const markMk = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.0 });
  const mark: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [markMk(), markMk()];
  const wreck = mk(0x2a2622, 0.95, 0.15, 0.85, 0.22, PALETTE.wreck);
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.6 });
  const soldier = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true });
  // Afterburner plume: white-hot core at the nozzle, orange body, bluish tail, shock diamonds; soft at the
  // silhouette (view-angle falloff). Linear HDR, additive.
  const flame = new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vN;
      varying vec3 vV;
      void main() {
        float t = 1.0 - vUv.y;
        float rim = abs(dot(normalize(vN), normalize(vV)));
        float body = pow(rim, 1.4);
        float core = exp(-t * 5.5);
        float diamonds = 0.6 + 0.4 * smoothstep(0.45, 1.0, sin(t * 36.0) * 0.5 + 0.5) * (1.0 - t);
        vec3 hot = vec3(1.0, 0.9, 0.78) * 8.0;
        vec3 mid = vec3(1.0, 0.5, 0.2) * 3.4;
        vec3 cool = vec3(0.5, 0.42, 1.0) * 1.2;
        vec3 c = mix(mix(cool, mid, smoothstep(0.95, 0.35, t)), hot, core);
        float a = body * (1.0 - smoothstep(0.5, 1.0, t)) * diamonds;
        gl_FragColor = vec4(c * a, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const prop = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.02, vertexColors: true });
  const ordnance = new THREE.MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.5, metalness: 0.4 });

  const tmp = new THREE.Color();
  return {
    paint, shipPaint, jetPaint, mark, wreck, glass, soldier, flame, prop, ordnance,
    setTeamColors(friendly, enemy) {
      const cols = [friendly, enemy];
      // A faint cast of the nation color in the paint; the markings carry the full color.
      for (const p of pals) {
        if (p.team < 0) continue;
        tmp.setHex(cols[p.team]);
        p.u.a.setHex(p.hex[0]).lerp(tmp, 0.05);
        p.u.b.setHex(p.hex[1]).lerp(tmp, 0.04);
        p.u.c.setHex(p.hex[2]);
      }
      for (let t = 0; t < 2; t++) {
        mark[t].color.setHex(cols[t]).lerp(tmp.setRGB(0.25, 0.25, 0.25), 0.35);
        mark[t].emissive.setHex(cols[t]);
      }
    },
  };
}
