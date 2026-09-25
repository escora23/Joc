// FRONT ULTRA — ground battle: streamed terrain patch (owner: battle).
//
// Two grids built from data.getLocalHeightfield around the anchor:
//   * fine   5.12 km, 20 m cells — where the fighting happens (units sample it on the GPU),
//   * coarse 16 km,   80 m cells — an outer ring (hole over the fine grid) whose rim melts into the globe:
//     heights blend to the globe's own relief surface and the albedo to the globe's Blue Marble tint, then the rim
//     dissolves with organic noise.
// Displayed height = local fine height + (RELIEF_EXAGGERATION - 1) * coarse real elevation, minus the Earth-curvature
// drop, so at large scale the patch sits exactly on the globe's exaggerated relief (same formula as surfaceRadius).
// Splatted ground material: sand, grass, woods and clearings (canopy relief), rock, snow, urban, dirt, wet mud; open
// ground becomes the field patchwork of ./fields (wheat, green cereal, ploughed soil, pasture, vineyards, mustard,
// margins and hedgerow bases), plus the no-man's-land belt along the contact line (churned mud, shell-hole field,
// trenches, scorch).

import * as THREE from 'three';
import { getLocalHeightfield, sampleElevation, type LocalHeightfield } from '../../data';
import type { WorldData } from '../../shared/types';
import {
  COARSE_RES, COARSE_SIZE_M, EXAG, FINE_RES, FINE_SIZE_M, GLSL_BATTLE_ATMO, GLSL_BATTLE_FRAG, GLSL_BATTLE_HEAD, GLSL_BATTLE_VERT,
  GLSL_TAIL, M_PER_DEG, OUTER_RES, OUTER_SIZE_M, R_M, srgbToLinear, type BattleUniforms,
} from './common';
import { GLSL_FIELDS } from './fields';
import { GLSL_TERRITORY_FILL } from '../globe/glsl';

const FINE_CELL = FINE_SIZE_M / (FINE_RES - 1);
const COARSE_CELL = COARSE_SIZE_M / (COARSE_RES - 1);
/** Coarse cells covered by the fine grid: [HOLE0, HOLE1). */
const HOLE0 = Math.round((COARSE_SIZE_M / 2 - FINE_SIZE_M / 2) / COARSE_CELL);
const HOLE1 = HOLE0 + Math.round(FINE_SIZE_M / COARSE_CELL);
const STEP = Math.round(COARSE_CELL / FINE_CELL);
const OUTER_CELL = OUTER_SIZE_M / (OUTER_RES - 1);
const OHOLE0 = Math.round((OUTER_SIZE_M / 2 - COARSE_SIZE_M / 2) / OUTER_CELL);
const OHOLE1 = OHOLE0 + Math.round(COARSE_SIZE_M / OUTER_CELL);
const OSTEP = Math.round(OUTER_CELL / COARSE_CELL);

const vert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
${GLSL_BATTLE_ATMO}
attribute float aRim;
attribute vec4 aTerr;
varying vec3 vPos;
varying vec3 vNrm;
varying float vRim;
varying vec4 vTerr;
varying vec3 vIns;
varying vec3 vTrans;
void main() {
  vPos = position;
  vNrm = normal;
  vRim = aRim;
  vTerr = aTerr;
#ifndef DEPTH_PASS
  battleAtmo(cameraPosition, battleAirPoint(position), normalize(uSunW), vIns, vTrans);
#endif
  gl_Position = battleProject(position);
}`;

const frag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
${GLSL_FIELDS}
uniform sampler2D uSplatA;
uniform sampler2D uSplatB;
uniform sampler2D uTint;
uniform sampler2D uDetail;
uniform vec4 uSplatInfo; // origin x, origin z, cell, res
uniform float uFarmland;
uniform float uWarScar;
uniform float uMeanLod;
// The next coarser grid's splat: blended in toward this grid's edge so grid seams never show.
uniform sampler2D uSplatA2;
uniform sampler2D uSplatB2;
uniform vec4 uSplatInfo2;
uniform float uHalf;
uniform float uDebugSplat;
uniform float uRimK;
varying vec3 vPos;
varying vec3 vNrm;
varying float vRim;
varying vec4 vTerr;
varying vec3 vIns;
varying vec3 vTrans;

const vec3 C_SAND = vec3(0.46, 0.38, 0.25);
const vec3 C_GRASS = vec3(0.105, 0.15, 0.045);
const vec3 C_FOREST = vec3(0.05, 0.07, 0.03);
const vec3 C_ROCK = vec3(0.24, 0.225, 0.2);
const vec3 C_SNOW = vec3(0.78, 0.8, 0.84);
const vec3 C_URBAN = vec3(0.2, 0.19, 0.18);
const vec3 C_DIRT = vec3(0.22, 0.155, 0.09);
const vec3 C_WET = vec3(0.09, 0.08, 0.055);

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
${GLSL_TERRITORY_FILL}

void main() {
  battleFadeDiscard();
  vec2 xz = vPos.xz;
  vec4 dA = texture2D(uDetail, xz / 23.0);
  vec4 dB = texture2D(uDetail, xz / 97.0 + 0.37);
  vec4 dC = texture2D(uDetail, xz / 480.0 + 0.71);
  if (vRim > 0.001) {
    float n = dC.g * 0.6 + dB.r * 0.4;
    if (n < vRim * uRimK * 1.05 - 0.02) discard;
  }
  vec2 suv = ((xz - uSplatInfo.xy) / uSplatInfo.z + 0.5) / uSplatInfo.w;
  vec4 sa = texture2D(uSplatA, suv);
  vec4 sb = texture2D(uSplatB, suv);
  float edgeK = smoothstep(0.55, 0.98, max(abs(xz.x), abs(xz.y)) / uHalf);
  if (edgeK > 0.0) {
    vec2 suv2 = ((xz - uSplatInfo2.xy) / uSplatInfo2.z + 0.5) / uSplatInfo2.w;
    sa = mix(sa, texture2D(uSplatA2, suv2), edgeK);
    sb = mix(sb, texture2D(uSplatB2, suv2), edgeK);
  }
  vec4 tintW = texture2D(uTint, suv);
  vec4 ra = textureLod(uSplatA, suv, uMeanLod);
  vec4 rb = textureLod(uSplatB, suv, uMeanLod);
  float waterK = tintW.a;

  // Pixel footprint (m): fades detail that would alias.
  float px = length(fwidth(vPos));
  float camDist = length(vPos - uCamL);
  // Far away the ground must look exactly like the globe around it: full regional-tint normalisation, flat shading.
  float farK = smoothstep(1500.0, 9000.0, camDist);
  float fineK = 1.0 - smoothstep(0.6, 3.5, px);
  float midK = 1.0 - smoothstep(4.0, 22.0, px);

  // --- per-material albedo with procedural variation ---------------------------------------------------
  float macro = dC.r;
  vec3 grass = mix(C_GRASS, vec3(0.16, 0.19, 0.06), smoothstep(0.35, 0.7, dB.g));
  grass = mix(grass, vec3(0.26, 0.23, 0.11), smoothstep(0.55, 0.85, macro) * 0.7);
  vec3 forest = C_FOREST * (0.6 + 0.8 * dB.r) * (0.75 + 0.5 * dA.b);
  vec3 rock = C_ROCK * (0.7 + 0.6 * dA.a) * (0.85 + 0.3 * dB.g);
  vec3 sand = C_SAND * (0.9 + 0.2 * dA.r);
  vec3 snow = C_SNOW * (0.95 + 0.08 * dA.r);
  vec3 urban = C_URBAN * (0.75 + 0.5 * dB.r);
  vec3 dirt = C_DIRT * (0.75 + 0.5 * dA.g);
  vec3 wet = C_WET * (0.9 + 0.2 * dA.r);

  float wsum = sa.r + sa.g + sa.b + sa.a + sb.r + sb.g + sb.b + sb.a + 1e-4;
  // Woodland: the forest share of the land cover becomes woods and clearings (thresholded noise), not a tint.
  float fw = sa.b / wsum;
  float canopyN = dB.r * 0.55 + dC.g * 0.45 + (dA.b - 0.5) * 0.12;
  float canopy = fw < 0.02 ? 0.0 : smoothstep(0.02, 0.1, fw - (canopyN - 0.25) * 1.4);
  float owsum = wsum - sa.b + 1e-4;
  vec3 open = (sand * sa.r + grass * sa.g + rock * sa.a + snow * sb.r + urban * sb.g + dirt * sb.b + wet * sb.a + grass * 1e-4) / owsum;
  vec4 crown = texture2D(uDetail, xz / 9.0 + 0.23);
  vec3 canopyCol = forest * (0.55 + 0.9 * crown.r) * mix(vec3(1.0), vec3(1.25, 1.1, 0.8), smoothstep(0.7, 0.95, crown.g) * 0.6);
  vec3 alb = mix(open, mix(forest, canopyCol, fineK), canopy);

  // --- farmland: the field patchwork (./fields), crops with furrows, margins, hedgerow bases, woodlots ------
  float farmK = uFarmland * (1.0 - smoothstep(14.0, 40.0, px));
  float fieldK = 0.0;
  float hedgeAo = 1.0;
  if (farmK > 0.01) {
    Field F = fieldAt(xz);
    float h = F.crop;
    // Across-the-furrow coordinate (furrows run along the long side of the field).
    float across = F.size.x > F.size.y ? F.uv.y * F.size.y : F.uv.x * F.size.x;
    float along = F.size.x > F.size.y ? F.uv.x * F.size.x : F.uv.y * F.size.y;
    float v1 = fHash(F.id.x, F.id.y, 11);
    vec3 crop;
    if (F.wood > 0.5) {
      crop = vec3(0.035, 0.05, 0.022) * (0.8 + 0.4 * dA.r);
    } else if (h < 0.3) {
      // Ripe wheat / stubble: gold, with combine swaths.
      crop = mix(vec3(0.3, 0.235, 0.105), vec3(0.36, 0.3, 0.15), v1) * (0.9 + 0.2 * dA.r);
      float sw = abs(fract(across / 6.0) - 0.5);
      crop *= mix(1.0, 0.9 + 0.1 * smoothstep(0.1, 0.25, sw), 1.0 - smoothstep(1.5, 4.0, px));
    } else if (h < 0.5) {
      // Green cereal with tramlines.
      crop = mix(vec3(0.07, 0.115, 0.03), vec3(0.1, 0.14, 0.04), v1) * (0.85 + 0.3 * dB.g);
      float tl = 1.0 - smoothstep(0.25, 0.6, abs(fract(across / 24.0) - 0.5) * 24.0);
      crop = mix(crop, vec3(0.13, 0.11, 0.07), tl * 0.6 * (1.0 - smoothstep(1.0, 3.0, px)));
    } else if (h < 0.66) {
      // Ploughed soil: furrows.
      crop = mix(vec3(0.12, 0.078, 0.046), vec3(0.16, 0.11, 0.065), v1) * (0.85 + 0.3 * dA.g);
      float fu = sin(across * 6.2832 / 0.9);
      crop *= 1.0 + 0.18 * fu * (1.0 - smoothstep(0.15, 0.5, px));
    } else if (h < 0.8) {
      // Pasture / meadow, mottled.
      crop = mix(vec3(0.085, 0.13, 0.04), vec3(0.13, 0.15, 0.055), smoothstep(0.3, 0.7, dB.r)) * (0.85 + 0.3 * dA.r);
    } else if (h < 0.88) {
      // Vineyard rows.
      float rowv = abs(fract(across / 2.2) - 0.5) * 2.0;
      vec3 vine = vec3(0.03, 0.055, 0.018), soil = vec3(0.17, 0.13, 0.085);
      float rk = 1.0 - smoothstep(0.35, 1.6, px);
      crop = mix(mix(vine, soil, 0.45), mix(vine, soil, smoothstep(0.35, 0.6, rowv)), rk);
    } else {
      // Mustard / sunflower / fallow.
      crop = mix(vec3(0.22, 0.2, 0.055), vec3(0.18, 0.16, 0.08), v1) * (0.9 + 0.2 * dB.r);
    }
    // Field margins (grass strips) and hedgerow bases.
    float edgeD = min(min(F.uv.x, 1.0 - F.uv.x) * F.size.x, min(F.uv.y, 1.0 - F.uv.y) * F.size.y);
    crop = mix(crop, vec3(0.08, 0.11, 0.035) * (0.8 + 0.4 * dA.g), (1.0 - smoothstep(1.2, 2.6, edgeD + dA.r)) * 0.8 * (1.0 - F.wood));
    // Hedgerow base: a broken strip of scrub (the trees themselves are instanced on the same lines).
    float hedge = (1.0 - smoothstep(1.2, 3.2, F.hedge + dA.g * 1.5)) * smoothstep(0.3, 0.55, dB.b + dA.r * 0.3);
    crop = mix(crop, vec3(0.045, 0.06, 0.025) * (0.7 + 0.6 * dA.b), hedge * 0.8);
    hedgeAo = 1.0 - hedge * 0.25;
    // Only where the land cover is open ground (not forest, town, rock, snow or water).
    // Organic edge where the fields give way to woods, towns or rock.
    float wild = (sa.a + sb.r + sb.g) / owsum + (dC.b - 0.5) * 0.35 + (dB.a - 0.5) * 0.15;
    fieldK = farmK * (1.0 - smoothstep(0.35, 0.75, wild)) * (1.0 - smoothstep(0.1, 0.35, waterK)) * (1.0 - canopy);
    alb = mix(alb, crop, fieldK);
  }
  // Regional tint normalisation: the ground color averaged over ~300 m (a coarse mip of this grid's own splat) is
  // matched to the globe's Blue Marble tint, while the finer splat variation (fields, woods, dirt) survives on top.
  vec3 grassMean = mix(C_GRASS * 1.2, vec3(0.155, 0.15, 0.062), uFarmland * 0.85);
  vec3 mean = (C_SAND * ra.r + grassMean * ra.g + C_FOREST * ra.b + C_ROCK * ra.a + C_SNOW * rb.r + C_URBAN * rb.g + C_DIRT * rb.b + C_WET * rb.a)
    / (ra.r + ra.g + ra.b + ra.a + rb.r + rb.g + rb.b + rb.a + 1e-4);

  // Regional tint (the globe's Blue Marble color, with the same close-up lift the globe applies).
  vec3 tint = toLin(tintW.rgb);
  float lt = luma(tint);
  tint = max(mix(vec3(lt), tint, 1.25), 0.0) * 1.2;
  vec3 ratio = clamp(tint / max(mean, vec3(0.01)), vec3(0.3), vec3(3.0));
  // Keep the land-cover patches from the data within a believable contrast of each other.
  alb = mix(alb, mean, 0.3 * (1.0 - fieldK));
  alb *= mix(vec3(1.0), ratio, mix(0.55, 1.0, farK));
  // With distance the ground converges to its regional average (like the globe's own texture): identical for every
  // grid, so the fine/coarse/outer seams disappear.
  alb = mix(alb, mean * ratio, smoothstep(2500.0, 14000.0, camDist) * 0.75);

  // --- detail normal --------------------------------------------------------------------------------------
  vec3 N = normalize(vNrm);
  float e = 0.004;
  float hx = texture2D(uDetail, xz / 23.0 + vec2(e, 0.0)).r - dA.r;
  float hz = texture2D(uDetail, xz / 23.0 + vec2(0.0, e)).r - dA.r;
  float bump = (0.35 + 0.8 * sa.a + 0.4 * sb.b) * fineK;
  N = normalize(N + vec3(-hx, 0.0, -hz) * bump * 6.0);
  float hx2 = texture2D(uDetail, xz / 97.0 + 0.37 + vec2(e, 0.0)).g - dB.g;
  float hz2 = texture2D(uDetail, xz / 97.0 + 0.37 + vec2(0.0, e)).g - dB.g;
  N = normalize(N + vec3(-hx2, 0.0, -hz2) * midK * 3.0);
  // Tree crowns: lumpy canopy relief.
  if (canopy > 0.01) {
    float cx = texture2D(uDetail, xz / 9.0 + 0.23 + vec2(e, 0.0)).r - crown.r;
    float cz = texture2D(uDetail, xz / 9.0 + 0.23 + vec2(0.0, e)).r - crown.r;
    N = normalize(N + vec3(-cx, 0.0, -cz) * canopy * midK * 14.0);
  }

  // --- no-man's-land: churned earth, shell holes, trenches, scorch ----------------------------------------
  vec2 fc = frontCoords(xz);
  float along = 1.0 - smoothstep(uFrontL * 0.75, uFrontL, abs(fc.x));
  float beltW = uBelt * (0.8 + 0.5 * dB.r);
  float belt = (1.0 - smoothstep(beltW * 0.55, beltW * 1.25, abs(fc.y))) * along * uWarScar * (1.0 - waterK);
  float ao = 1.0;
  if (belt > 0.001) {
    // Churned mud with surviving grass tufts.
    vec3 mud = mix(vec3(0.075, 0.058, 0.04), vec3(0.15, 0.115, 0.075), dA.r);
    float churn = belt * (0.35 + 0.55 * smoothstep(0.3, 0.75, dB.r + dA.g * 0.3) * (0.4 + 0.6 * (1.0 - smoothstep(0.0, beltW, abs(fc.y)))));
    alb = mix(alb, mud, churn);
    // Shell holes (small, overlapping, patchy) - the big fresh craters are decals.
    vec2 q2 = xz / 9.0 + 5.3 + (dC.rg - 0.5) * 4.0 + (dB.ba - 0.5) * 1.5;
    float w2 = texture2D(uDetail, q2 / 16.0).b;
    float centre = 1.0 - smoothstep(0.0, beltW * 1.1, abs(fc.y));
    float m2 = smoothstep(0.5 - 0.25 * centre, 0.62 - 0.25 * centre, texture2D(uDetail, xz / 57.0 + 0.61).g);
    float size2 = 0.16 + 0.12 * texture2D(uDetail, xz / 37.0).a;
    float cr = (1.0 - smoothstep(size2 * 0.4, size2, w2)) * m2 * belt;
    float rim = smoothstep(size2 * 0.85, size2, w2) * (1.0 - smoothstep(size2, size2 * 1.4, w2)) * m2 * belt;
    alb *= 1.0 - cr * 0.4;
    alb = mix(alb, vec3(0.16, 0.125, 0.085), rim * 0.35);
    float g2x = texture2D(uDetail, (q2 + vec2(0.25, 0.0)) / 16.0).b - w2;
    float g2z = texture2D(uDetail, (q2 + vec2(0.0, 0.25)) / 16.0).b - w2;
    N = normalize(N + vec3(g2x, 0.0, g2z) * 3.5 * (cr - rim * 0.5) * fineK);
    ao = 1.0 - cr * 0.3;
    // Scorch.
    float sc = smoothstep(0.6, 0.8, dB.r * 0.7 + dC.g * 0.5) * belt;
    alb = mix(alb, vec3(0.03, 0.026, 0.022), sc * 0.55);
  }
  // Broken zig-zag trench lines on both sides of the belt.
  float trK = along * uWarScar * (1.0 - waterK) * midK;
  if (trK > 0.001) {
    for (int s = 0; s < 2; s++) {
      float side = s == 0 ? -1.0 : 1.0;
      float zz = abs(fract(fc.x / 34.0 + float(s) * 0.37) - 0.5) * 2.0 - 0.5;
      float tv = side * (uBelt * 1.3 + 24.0) + zz * 6.0 + (dC.r - 0.5) * 8.0;
      float dtr = abs(fc.y - tv);
      float present = smoothstep(0.35, 0.5, texture2D(uDetail, vec2(fc.x / 900.0, float(s) * 0.5)).g);
      float trench = (1.0 - smoothstep(0.5, 0.9, dtr)) * present;
      float parapet = (1.0 - smoothstep(1.0, 3.2, dtr + dA.r)) * (1.0 - trench) * present;
      alb = mix(alb, vec3(0.2, 0.155, 0.1) * (0.8 + 0.4 * dA.g), parapet * trK * 0.75);
      alb = mix(alb, vec3(0.035, 0.028, 0.02), trench * trK * 0.75);
    }
  }

  // Water bed (the water surface is a separate mesh).
  alb = mix(alb, vec3(0.05, 0.06, 0.05), smoothstep(0.35, 0.8, waterK));

  // Rim: melt into the globe's own albedo (including its territory tint far out).
  alb = mix(alb, tint, smoothstep(0.0, 0.6, vRim));
  // Territory: the globe's own fill function (DESIGN_V2 §10.1 / §10.11), so the rim meets the globe without a seam.
  if (vTerr.a > 0.001) {
    float fa = vTerr.a + territoryFillBoost(alb, vTerr.rgb) * min(1.0, vTerr.a * 4.0);
    alb = territoryFill(alb, vTerr.rgb, fa);
  }

  // Crude slope/cavity occlusion from the macro noise.
  ao *= (0.8 + 0.2 * dB.r) * hedgeAo;
  // The globe shades with a smoothed relief normal: converge to it with distance (no darker 'stain' far out).
  N = normalize(mix(N, normalize(vec3(vNrm.x, vNrm.y * 2.5, vNrm.z)), farK));
  vec3 col = battleShade(alb, N, vPos, ao, 2.5);
  col = battleSmoke(col * vTrans + vIns, vPos);
  if (uDebugSplat > 0.5) col = uDebugSplat < 1.5 ? vec3(sa.b, sa.g, sb.g + sa.a) / wsum : vec3(sb.b, sa.r, sb.a) / wsum;
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_TAIL}
}`;

export interface TerrainPatch {
  readonly group: THREE.Group;
  /** Displayed heights (local y) on the fine and coarse grids. */
  readonly hFine: Float32Array;
  readonly hCoarse: Float32Array;
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3;
  /** Splat weights 0..1 at a point: [sand, grass, forest, rock, snow, urban, dirt, wet]; returns water 0..1. */
  splatAt(x: number, z: number, out: Float32Array): number;
  readonly minFine: number;
  readonly maxFine: number;
  readonly hasWater: boolean;
  readonly farmland: number;
  setWarScar(v: number): void;
  dispose(): void;
}

export interface TerrainShared {
  uniforms: BattleUniforms;
  detail: THREE.Texture;
  /** Materials (kept alive across patches; programs compiled once). */
  fineMat: THREE.ShaderMaterial;
  coarseMat: THREE.ShaderMaterial;
  outerMat: THREE.ShaderMaterial;
  waterMat: THREE.ShaderMaterial;
}

/** Territory owner color at a place (0xRRGGBB) and globe fill strength, or null for no owner. */
export type TerritoryFn = (lat: number, lon: number) => { color: number; fill: number } | null;

function makeMat(shared: BattleUniforms, detail: THREE.Texture, info: THREE.Vector4): THREE.ShaderMaterial {
  const dummy = new THREE.DataTexture(new Uint8Array([128, 128, 128, 0]), 1, 1);
  dummy.needsUpdate = true;
  const m = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      ...shared,
      uSplatA: { value: dummy },
      uSplatB: { value: dummy },
      uTint: { value: dummy },
      uDetail: { value: detail },
      uSplatInfo: { value: info },
      uFarmland: { value: 0 },
      uWarScar: { value: 1 },
      uMeanLod: { value: 0 },
      uSplatA2: { value: dummy },
      uSplatB2: { value: dummy },
      uSplatInfo2: { value: new THREE.Vector4(0, 0, 1, 1) },
      uHalf: { value: 1e9 },
      uDebugSplat: { value: typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('bsplat') ?? 0) : 0 },
    },
  });
  m.name = 'battle-terrain';
  return m;
}

const waterVert = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_VERT}
attribute float aDepth;
attribute float aRim;
varying vec3 vPos;
varying float vDepth;
varying float vRim;
void main() {
  vPos = position;
  vDepth = aDepth;
  vRim = aRim;
  gl_Position = battleProject(position);
}`;

const waterFrag = /* glsl */ `
${GLSL_BATTLE_HEAD}
${GLSL_BATTLE_FRAG}
uniform sampler2D uDetail;
uniform float uRimK;
varying vec3 vPos;
varying float vDepth;
varying float vRim;
void main() {
  battleFadeDiscard();
  if (vDepth < 0.0) discard;
  vec4 dC = texture2D(uDetail, vPos.xz / 480.0 + 0.71);
  if (vRim > 0.001 && dC.g < vRim * uRimK) discard;
  vec2 w1 = texture2D(uDetail, vPos.xz / 41.0 + vec2(uTime * 0.013, uTime * 0.007)).rg - 0.5;
  vec2 w2 = texture2D(uDetail, vPos.xz / 13.0 - vec2(uTime * 0.021, -uTime * 0.017)).rg - 0.5;
  vec3 N = normalize(vec3((w1.x + w2.x * 0.6) * 0.22, 1.0, (w1.y + w2.y * 0.6) * 0.22));
  vec3 V = normalize(uCamL - vPos);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 220.0) * 18.0;
  vec3 deep = vec3(0.006, 0.02, 0.028);
  vec3 shallow = vec3(0.03, 0.06, 0.05);
  vec3 body = mix(shallow, deep, smoothstep(0.0, 6.0, vDepth));
  vec3 col = body * (uSunCol * max(uSunDir.y, 0.0) * 0.6 + uSkyCol) ;
  vec3 sky = mix(uFogAnti, uFogSun, 0.5) * 1.6 + uSkyCol * 0.8;
  col = mix(col, sky, fres) + uSunCol * spec * max(uSunDir.y + 0.05, 0.0);
  col += battleLights(vPos, N) * 0.04;
  float foam = (1.0 - smoothstep(0.0, 0.8, vDepth)) * smoothstep(0.45, 0.7, texture2D(uDetail, vPos.xz / 7.0 + uTime * 0.02).r);
  col = mix(col, uSunCol * 0.25 + uSkyCol * 0.9, foam * 0.6);
  col = battleAir(col, vPos);
  gl_FragColor = vec4(col, 1.0);
  ${GLSL_TAIL}
}`;

export function createTerrainShared(uniforms: BattleUniforms, detail: THREE.Texture): TerrainShared {
  const fineMat = makeMat(uniforms, detail, new THREE.Vector4(-FINE_SIZE_M / 2, -FINE_SIZE_M / 2, FINE_CELL, FINE_RES));
  const coarseMat = makeMat(uniforms, detail, new THREE.Vector4(-COARSE_SIZE_M / 2, -COARSE_SIZE_M / 2, COARSE_CELL, COARSE_RES));
  const outerMat = makeMat(uniforms, detail, new THREE.Vector4(-OUTER_SIZE_M / 2, -OUTER_SIZE_M / 2, OUTER_CELL, OUTER_RES));
  const waterMat = new THREE.ShaderMaterial({
    vertexShader: waterVert,
    fragmentShader: waterFrag,
    uniforms: { ...uniforms, uDetail: { value: detail } },
  });
  waterMat.name = 'battle-water';
  return { uniforms, detail, fineMat, coarseMat, outerMat, waterMat };
}

function splatTex(data: Uint8Array, res: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, res, res, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

function heightTex(data: Float32Array, res: number): THREE.DataTexture {
  const t = new THREE.DataTexture(data, res, res, THREE.RedFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/** Triangle-exact interpolation on a grid (matches the mesh triangulation and the GLSL gridHeight). */
function gridSample(h: Float32Array, res: number, origin: number, cell: number, x: number, z: number): number {
  let gx = (x - origin) / cell, gz = (z - origin) / cell;
  const n = res - 1;
  gx = Math.min(Math.max(gx, 0), n - 0.001);
  gz = Math.min(Math.max(gz, 0), n - 0.001);
  const cx = Math.floor(gx), cz = Math.floor(gz);
  const fx = gx - cx, fz = gz - cz;
  const i = cz * res + cx;
  const a = h[i], b = h[i + 1], c = h[i + res], d = h[i + res + 1];
  if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
}

interface GridMeshOpts {
  h: Float32Array;
  res: number;
  cell: number;
  rim?: Float32Array;
  terr?: Float32Array;
  keep: (ci: number, cj: number) => boolean;
  mat: THREE.ShaderMaterial;
  name: string;
}

function gridMesh(o: GridMeshOpts): THREE.Mesh {
  const n = o.res;
  const half = ((n - 1) * o.cell) / 2;
  const pos = new Float32Array(n * n * 3);
  const nrm = new Float32Array(n * n * 3);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const k = i * n + j;
      pos[k * 3] = -half + j * o.cell;
      pos[k * 3 + 1] = o.h[k];
      pos[k * 3 + 2] = -half + i * o.cell;
    }
  }
  gridNormals(o.h, n, o.cell, nrm);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('aRim', new THREE.BufferAttribute(o.rim ?? new Float32Array(n * n), 1));
  g.setAttribute('aTerr', new THREE.BufferAttribute(o.terr ?? new Float32Array(n * n * 4), 4));
  g.setIndex(new THREE.BufferAttribute(gridIndices(n, o.keep), 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, o.mat);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  mesh.name = o.name;
  return mesh;
}

export function buildTerrain(world: WorldData, lat0: number, lon0: number, shared: TerrainShared, farmland: number, territory: TerritoryFn): TerrainPatch {
  const fine = getLocalHeightfield(lat0, lon0, FINE_SIZE_M / 1000, FINE_RES);
  const coarse = getLocalHeightfield(lat0, lon0, COARSE_SIZE_M / 1000, COARSE_RES);
  const outer = getLocalHeightfield(lat0, lon0, OUTER_SIZE_M / 1000, OUTER_RES);
  const cosLat0 = Math.max(0.01, Math.cos((lat0 * Math.PI) / 180));
  const exag = EXAG - 1;
  const R2 = 2 * R_M;
  const latOf = (z: number) => lat0 - z / M_PER_DEG;
  const lonOf = (x: number) => lon0 + x / (M_PER_DEG * cosLat0);

  // --- displayed heights ------------------------------------------------------------------------------------
  const hFine = new Float32Array(FINE_RES * FINE_RES);
  let minFine = Infinity, maxFine = -Infinity;
  for (let i = 0; i < FINE_RES; i++) {
    const z = -FINE_SIZE_M / 2 + i * FINE_CELL;
    const lat = latOf(z);
    for (let j = 0; j < FINE_RES; j++) {
      const x = -FINE_SIZE_M / 2 + j * FINE_CELL;
      const base = Math.max(0, sampleElevation(world, lat, lonOf(x)));
      const k = i * FINE_RES + j;
      const y = fine.heights[k] + exag * base - (x * x + z * z) / R2;
      hFine[k] = y;
      if (y < minFine) minFine = y;
      if (y > maxFine) maxFine = y;
    }
  }
  const halfC = COARSE_SIZE_M / 2;
  const hCoarse = new Float32Array(COARSE_RES * COARSE_RES);
  for (let i = 0; i < COARSE_RES; i++) {
    const z = -halfC + i * COARSE_CELL;
    const lat = latOf(z);
    for (let j = 0; j < COARSE_RES; j++) {
      const x = -halfC + j * COARSE_CELL;
      const base = Math.max(0, sampleElevation(world, lat, lonOf(x)));
      const k = i * COARSE_RES + j;
      hCoarse[k] = coarse.heights[k] + exag * base - (x * x + z * z) / R2;
    }
  }
  // Coarse vertices on the fine boundary take the fine heights exactly.
  for (let i = HOLE0; i <= HOLE1; i++) {
    for (let j = HOLE0; j <= HOLE1; j++) {
      hCoarse[i * COARSE_RES + j] = hFine[(i - HOLE0) * STEP * FINE_RES + (j - HOLE0) * STEP];
    }
  }
  const halfO = OUTER_SIZE_M / 2;
  const nO = OUTER_RES * OUTER_RES;
  const hOuter = new Float32Array(nO);
  const rimO = new Float32Array(nO);
  const terrO = new Float32Array(nO * 4);
  const col = new THREE.Vector3();
  for (let i = 0; i < OUTER_RES; i++) {
    const z = -halfO + i * OUTER_CELL;
    const lat = latOf(z);
    for (let j = 0; j < OUTER_RES; j++) {
      const x = -halfO + j * OUTER_CELL;
      const lon = lonOf(x);
      const base = Math.max(0, sampleElevation(world, lat, lon));
      const k = i * OUTER_RES + j;
      const rr = Math.sqrt(x * x + z * z) / halfO;
      const blend = smooth(0.45, 0.9, rr);
      const local = outer.heights[k] + exag * base;
      hOuter[k] = local + (EXAG * base - local) * blend - (x * x + z * z) / R2;
      rimO[k] = smooth(0.84, 0.995, rr);
      const t = territory(lat, lon);
      if (t) {
        col.set(srgbToLinear((t.color >> 16) & 255), srgbToLinear((t.color >> 8) & 255), srgbToLinear(t.color & 255));
        terrO[k * 4] = col.x;
        terrO[k * 4 + 1] = col.y;
        terrO[k * 4 + 2] = col.z;
        terrO[k * 4 + 3] = t.fill * smooth(0.3, 0.8, rr);
      }
    }
  }
  for (let i = OHOLE0; i <= OHOLE1; i++) {
    for (let j = OHOLE0; j <= OHOLE1; j++) {
      hOuter[i * OUTER_RES + j] = hCoarse[(i - OHOLE0) * OSTEP * COARSE_RES + (j - OHOLE0) * OSTEP];
    }
  }

  const group = new THREE.Group();
  group.name = 'battle-terrain';

  // --- textures ---------------------------------------------------------------------------------------------
  const texes: THREE.Texture[] = [];
  const setMat = (m: THREE.ShaderMaterial, f: LocalHeightfield, res: number) => {
    const a = splatTex(f.splatA, res), b = splatTex(f.splatB, res), t = splatTex(packTint(f), res);
    texes.push(a, b, t);
    m.uniforms.uSplatA.value = a;
    m.uniforms.uSplatB.value = b;
    m.uniforms.uTint.value = t;
    m.uniforms.uFarmland.value = farmland;
  };
  setMat(shared.fineMat, fine, FINE_RES);
  setMat(shared.coarseMat, coarse, COARSE_RES);
  setMat(shared.outerMat, outer, OUTER_RES);
  // Seam blending: fine -> coarse, coarse -> outer.
  const link = (m: THREE.ShaderMaterial, next: THREE.ShaderMaterial, half: number) => {
    m.uniforms.uSplatA2.value = next.uniforms.uSplatA.value;
    m.uniforms.uSplatB2.value = next.uniforms.uSplatB.value;
    (m.uniforms.uSplatInfo2.value as THREE.Vector4).copy(next.uniforms.uSplatInfo.value as THREE.Vector4);
    m.uniforms.uHalf.value = half;
  };
  link(shared.fineMat, shared.coarseMat, FINE_SIZE_M / 2);
  link(shared.coarseMat, shared.outerMat, COARSE_SIZE_M / 2);
  shared.outerMat.uniforms.uHalf.value = 1e9;
  shared.fineMat.uniforms.uMeanLod.value = 4;
  shared.coarseMat.uniforms.uMeanLod.value = 2;
  shared.outerMat.uniforms.uMeanLod.value = 0.5;
  const hTexF = heightTex(hFine, FINE_RES);
  const hTexC = heightTex(hCoarse, COARSE_RES);
  texes.push(hTexF, hTexC);
  shared.uniforms.uHFine.value = hTexF;
  shared.uniforms.uHCoarse.value = hTexC;

  // --- meshes -------------------------------------------------------------------------------------------------
  group.add(gridMesh({ h: hFine, res: FINE_RES, cell: FINE_CELL, keep: () => true, mat: shared.fineMat, name: 'battle-terrain-fine' }));
  group.add(gridMesh({
    h: hCoarse, res: COARSE_RES, cell: COARSE_CELL, mat: shared.coarseMat, name: 'battle-terrain-ring',
    keep: (ci, cj) => !(ci >= HOLE0 && ci < HOLE1 && cj >= HOLE0 && cj < HOLE1),
  }));
  group.add(gridMesh({
    h: hOuter, res: OUTER_RES, cell: OUTER_CELL, rim: rimO, terr: terrO, mat: shared.outerMat, name: 'battle-terrain-outer',
    keep: (ci, cj) => {
      if (ci >= OHOLE0 && ci < OHOLE1 && cj >= OHOLE0 && cj < OHOLE1) return false;
      const x = -halfO + (cj + 0.5) * OUTER_CELL, z = -halfO + (ci + 0.5) * OUTER_CELL;
      return Math.sqrt(x * x + z * z) < halfO;
    },
  }));
  // Skirts hide the T-junction cracks where a finer grid meets a coarser one.
  for (const [h, res, cell, half, mat] of [
    [hFine, FINE_RES, FINE_CELL, FINE_SIZE_M / 2, shared.fineMat],
    [hCoarse, COARSE_RES, COARSE_CELL, halfC, shared.coarseMat],
  ] as const) {
    const sm = new THREE.Mesh(skirt(h, res, cell, -half, 6), mat);
    sm.renderOrder = 10;
    sm.frustumCulled = false;
    group.add(sm);
  }

  const heightAt = (x: number, z: number): number => {
    if (Math.abs(x) <= FINE_SIZE_M / 2 && Math.abs(z) <= FINE_SIZE_M / 2) return gridSample(hFine, FINE_RES, -FINE_SIZE_M / 2, FINE_CELL, x, z);
    if (Math.abs(x) <= halfC && Math.abs(z) <= halfC) return gridSample(hCoarse, COARSE_RES, -halfC, COARSE_CELL, x, z);
    return gridSample(hOuter, OUTER_RES, -halfO, OUTER_CELL, x, z);
  };

  // --- water ------------------------------------------------------------------------------------------------
  let hasWater = false;
  for (let k = 0; k < outer.water.length; k++) if (outer.water[k] > 100 && outer.heights[k] < 0) { hasWater = true; break; }
  if (hasWater && !(typeof location !== 'undefined' && location.search.includes('bnowater'))) {
    const n = 181;
    const cell = (halfO * 2) / (n - 1);
    const pos = new Float32Array(n * n * 3);
    const depth = new Float32Array(n * n);
    const rim = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const k = i * n + j;
        const x = -halfO + j * cell, z = -halfO + i * cell;
        const sea = -(x * x + z * z) / R2;
        pos[k * 3] = x;
        pos[k * 3 + 1] = sea;
        pos[k * 3 + 2] = z;
        depth[k] = sea - heightAt(x, z);
        rim[k] = smooth(0.84, 0.995, Math.sqrt(x * x + z * z) / halfO);
      }
    }
    const idx = gridIndices(n, (ci, cj) => {
      const a = depth[ci * n + cj], b = depth[ci * n + cj + 1], c = depth[(ci + 1) * n + cj], d = depth[(ci + 1) * n + cj + 1];
      return Math.max(a, b, c, d) > -2;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    g.setAttribute('aRim', new THREE.BufferAttribute(rim, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const wm = new THREE.Mesh(g, shared.waterMat);
    wm.renderOrder = 11;
    wm.frustumCulled = false;
    wm.name = 'battle-water';
    group.add(wm);
  }

  const inv255 = 1 / 255;
  const patch: TerrainPatch = {
    group, hFine, hCoarse, minFine, maxFine, hasWater, farmland,
    heightAt,
    normalAt(x, z, out) {
      const e = 4;
      const hl = heightAt(x - e, z), hr = heightAt(x + e, z);
      const hd = heightAt(x, z - e), hu = heightAt(x, z + e);
      return out.set(hl - hr, 2 * e, hd - hu).normalize();
    },
    splatAt(x, z, out) {
      let f = outer, res = OUTER_RES, cell = OUTER_CELL, o = -halfO;
      if (Math.abs(x) <= FINE_SIZE_M / 2 && Math.abs(z) <= FINE_SIZE_M / 2) {
        f = fine; res = FINE_RES; cell = FINE_CELL; o = -FINE_SIZE_M / 2;
      } else if (Math.abs(x) <= halfC && Math.abs(z) <= halfC) {
        f = coarse; res = COARSE_RES; cell = COARSE_CELL; o = -halfC;
      }
      const j = Math.min(res - 1, Math.max(0, Math.round((x - o) / cell)));
      const i = Math.min(res - 1, Math.max(0, Math.round((z - o) / cell)));
      const k = i * res + j;
      for (let c = 0; c < 4; c++) {
        out[c] = f.splatA[k * 4 + c] * inv255;
        out[4 + c] = f.splatB[k * 4 + c] * inv255;
      }
      return f.water[k] * inv255;
    },
    setWarScar(v) {
      shared.fineMat.uniforms.uWarScar.value = v;
      shared.coarseMat.uniforms.uWarScar.value = v;
      shared.outerMat.uniforms.uWarScar.value = v;
    },
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const t of texes) t.dispose();
    },
  };
  return patch;
}

function packTint(f: LocalHeightfield): Uint8Array {
  const n = f.resolution * f.resolution;
  const out = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    out[k * 4] = f.tint[k * 3];
    out[k * 4 + 1] = f.tint[k * 3 + 1];
    out[k * 4 + 2] = f.tint[k * 3 + 2];
    out[k * 4 + 3] = f.heights[k] < 0 ? f.water[k] : Math.min(f.water[k], 90);
  }
  return out;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function gridNormals(h: Float32Array, n: number, cell: number, out: Float32Array): void {
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const l = h[i * n + Math.max(0, j - 1)], r = h[i * n + Math.min(n - 1, j + 1)];
      const u = h[Math.max(0, i - 1) * n + j], d = h[Math.min(n - 1, i + 1) * n + j];
      const dx = (j === 0 || j === n - 1 ? 1 : 2) * cell, dz = (i === 0 || i === n - 1 ? 1 : 2) * cell;
      let nx = -(r - l) / dx, ny = 1, nz = -(d - u) / dz;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len; ny /= len; nz /= len;
      const k = (i * n + j) * 3;
      out[k] = nx; out[k + 1] = ny; out[k + 2] = nz;
    }
  }
}

/** Two triangles per kept cell, diagonal b-c (see gridSample). */
function gridIndices(n: number, keep: (ci: number, cj: number) => boolean): Uint32Array {
  const tmp: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      if (!keep(i, j)) continue;
      const a = i * n + j, b = a + 1, c = a + n, d = c + 1;
      tmp.push(a, c, b, b, c, d);
    }
  }
  return Uint32Array.from(tmp);
}

function skirt(h: Float32Array, n: number, cell: number, origin: number, depth: number): THREE.BufferGeometry {
  const ring: [number, number][] = [];
  for (let j = 0; j < n; j++) ring.push([0, j]);
  for (let i = 1; i < n; i++) ring.push([i, n - 1]);
  for (let j = n - 2; j >= 0; j--) ring.push([n - 1, j]);
  for (let i = n - 2; i >= 1; i--) ring.push([i, 0]);
  const pos: number[] = [];
  const nrm: number[] = [];
  for (const [i, j] of ring) {
    const x = origin + j * cell, z = origin + i * cell, y = h[i * n + j];
    pos.push(x, y, z, x, y - depth, z);
    nrm.push(0, 1, 0, 0, 1, 0);
  }
  const m = ring.length;
  const idx: number[] = [];
  for (let k = 0; k < m; k++) {
    const k2 = (k + 1) % m;
    const a = k * 2, b = a + 1, c = k2 * 2, d = c + 1;
    idx.push(a, b, c, c, b, d, a, c, b, c, d, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aRim', new THREE.Float32BufferAttribute(new Float32Array(m * 2), 1));
  g.setAttribute('aTerr', new THREE.Float32BufferAttribute(new Float32Array(m * 2 * 4), 4));
  g.setIndex(idx);
  return g;
}
