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
  flame: THREE.MeshBasicMaterial;
  /** Concrete / props (vertex colors). */
  prop: THREE.MeshStandardMaterial;
  /** Missiles and bombs. */
  ordnance: THREE.MeshStandardMaterial;
  setTeamColors(friendly: number, enemy: number): void;
}

const CAMO_VERT_PARS = /* glsl */ `
varying vec3 vObjPos;
`;
const CAMO_FRAG_PARS = /* glsl */ `
uniform sampler2D uCamoNoise;
uniform float uCamoAmount;
varying vec3 vObjPos;
`;
const CAMO_FRAG = /* glsl */ `
{
  vec3 op = vObjPos;
  float cn = texture2D(uCamoNoise, op.xz * 0.055 + op.y * 0.045 + vec2(0.13, 0.71)).b;
  float cn2 = texture2D(uCamoNoise, op.zy * 0.05 + op.x * 0.03).a;
  float band = cn * 0.7 + cn2 * 0.3;
  vec3 camo = band < 0.42 ? vec3(0.62, 0.66, 0.55) : (band < 0.58 ? vec3(1.0) : vec3(0.86, 0.80, 0.66));
  float grime = texture2D(uCamoNoise, op.xz * 0.6 + op.y * 0.5).g;
  camo *= 0.86 + grime * 0.22;
  // Only painted parts (bright vertex colors) get camo; dark metal / rubber stays as is.
  float painted = smoothstep(0.25, 0.5, max(vColor.r, max(vColor.g, vColor.b)));
  diffuseColor.rgb *= mix(vec3(1.0), camo, painted * uCamoAmount);
  // Dust / dirt toward the bottom of the vehicle.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.25, 0.18), smoothstep(1.1, 0.2, op.y) * 0.35 * uCamoAmount);
}
`;

function camo(mat: THREE.MeshStandardMaterial, noise: THREE.Texture, amount: number): void {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uCamoNoise = { value: noise };
    shader.uniforms.uCamoAmount = { value: amount };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${CAMO_VERT_PARS}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvObjPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${CAMO_FRAG_PARS}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${CAMO_FRAG}`);
  };
  mat.customProgramCacheKey = () => `fu-camo-${amount}`;
}

export function createMaterials(noise: THREE.Texture): CmdMaterials {
  const mk = (color: number, rough: number, metal: number, camoAmt: number) => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, vertexColors: true });
    if (camoAmt > 0) camo(m, noise, camoAmt);
    return m;
  };
  const paint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [mk(0x6a7050, 0.78, 0.25, 1), mk(0x7a7460, 0.78, 0.25, 1)];
  const shipPaint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [mk(0x8a9098, 0.62, 0.35, 0.25), mk(0x8c8a84, 0.62, 0.35, 0.25)];
  const jetPaint: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [mk(0x8d949c, 0.45, 0.45, 0.35), mk(0x8e8a80, 0.45, 0.45, 0.35)];
  const markMk = () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, metalness: 0.05, emissive: 0xffffff, emissiveIntensity: 0.0 });
  const mark: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] = [markMk(), markMk()];
  const wreck = mk(0x2a2622, 0.95, 0.15, 0.6);
  const glass = new THREE.MeshStandardMaterial({ color: 0x1a2a3a, roughness: 0.08, metalness: 0.9, envMapIntensity: 1.6 });
  const soldier = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, vertexColors: true });
  const flame = new THREE.MeshBasicMaterial({
    color: new THREE.Color(6, 3.2, 1.4), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
  });
  const prop = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.02, vertexColors: true });
  const ordnance = new THREE.MeshStandardMaterial({ color: 0xd8dcd6, roughness: 0.5, metalness: 0.4 });

  const tmp = new THREE.Color();
  const base = [new THREE.Color(0x4f5a38), new THREE.Color(0x8a7d5c)];
  const navy = [new THREE.Color(0x7f8891), new THREE.Color(0x8b877e)];
  const air = [new THREE.Color(0x8a939c), new THREE.Color(0x9a8f7c)];
  return {
    paint, shipPaint, jetPaint, mark, wreck, glass, soldier, flame, prop, ordnance,
    setTeamColors(friendly, enemy) {
      const cols = [friendly, enemy];
      for (let t = 0; t < 2; t++) {
        tmp.setHex(cols[t]);
        paint[t].color.copy(base[t]).lerp(tmp, 0.06);
        shipPaint[t].color.copy(navy[t]).lerp(tmp, 0.04);
        jetPaint[t].color.copy(air[t]).lerp(tmp, 0.05);
        mark[t].color.setHex(cols[t]).lerp(tmp.setRGB(0.25, 0.25, 0.25), 0.35);
        mark[t].emissive.setHex(cols[t]);
      }
    },
  };
}
