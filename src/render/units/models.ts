// FRONT ULTRA — procedural low-poly models for every unit and structure (owner: units).
// Conventions:
//   * Units: forward = -Z, up = +Y, overall length normalized to 1 (bow at z = -0.5). The instance matrix scale is
//     the drawn length in world units. Waterline / ground at y = 0.
//   * Structures: footprint normalized to the [-0.5, 0.5]^2 XZ square, ground at y = 0, the "front" (quay side
//     for ports & naval yards) faces -Z. Instance scale = footprint size in world units.
// Paint masks (see geom.ts): team = nation color, glow = night lights, heat = engines / hot parts.

import * as THREE from 'three';
import { ModelBuilder, type PaintOpts } from './geom';

// Palette (sRGB).
const C = {
  hull: 0x5d646c,
  hullDark: 0x3b4148,
  deck: 0x7d858c,
  steel: 0x8e959c,
  white: 0xe6e8ea,
  offWhite: 0xc9ccce,
  black: 0x17191c,
  red: 0x8a2a22,
  rust: 0x7b4a33,
  olive: 0x4d5a3a,
  oliveDark: 0x333c27,
  track: 0x22241f,
  concrete: 0x9a9890,
  concreteDark: 0x6c6a64,
  asphalt: 0x2e3033,
  glass: 0x2d4a5e,
  sand: 0xa89a78,
  grass: 0x4c5d34,
  water: 0x1e3b52,
  brick: 0x7a4b3a,
  yellow: 0xd9a520,
  orange: 0xc8641e,
};

/** Model keys: one InstancedMesh each. */
export const UNIT_MODELS = [
  'transport', 'trade', 'warship', 'tank', 'fighter', 'bomber', 'drone', 'cruise', 'icbm', 'warhead', 'sam',
  'loco', 'wagon',
] as const;
export type UnitModelKey = (typeof UNIT_MODELS)[number];

/** Structure types whose model changes with the level (1 / 2 / 3, §6.5); the key of level L > 1 is `${key}${L}`. */
export const LEVELLED = ['port', 'factory', 'defensePost', 'samSite', 'silo', 'airbase', 'armyBase', 'navalYard', 'radar'] as const;
export type LevelledKey = (typeof LEVELLED)[number];
export const STRUCT_MODELS = [
  'cityBase', 'port', 'factory', 'defensePost', 'samSite', 'silo', 'airbase', 'armyBase', 'navalYard', 'radar',
  'port2', 'factory2', 'defensePost2', 'samSite2', 'silo2', 'airbase2', 'armyBase2', 'navalYard2', 'radar2',
  'port3', 'factory3', 'defensePost3', 'samSite3', 'silo3', 'airbase3', 'armyBase3', 'navalYard3', 'radar3',
  'radarDish', 'beacon', 'pad', 'padRound',
] as const;
export type StructModelKey = (typeof STRUCT_MODELS)[number];

// -------------------------------------------------------------------------------------------------
// Ships
// -------------------------------------------------------------------------------------------------

function shipOutline(beam: number, bowLen: number, sternRound: number): [number, number][] {
  const b = beam / 2;
  return [
    [0, -0.5],
    [b * 0.55, -0.5 + bowLen * 0.45],
    [b * 0.92, -0.5 + bowLen],
    [b, -0.5 + bowLen + 0.08],
    [b, 0.5 - sternRound],
    [b * 0.85, 0.5],
    [-b * 0.85, 0.5],
    [-b, 0.5 - sternRound],
    [-b, -0.5 + bowLen + 0.08],
    [-b * 0.92, -0.5 + bowLen],
    [-b * 0.55, -0.5 + bowLen * 0.45],
  ];
}

/** Half-beam of a fine-bowed hull: 0 at the stem, full from `full` (0..1 of the length), a slightly narrower transom. */
function fineBeam(B: number, full: number, transom = 0.85): (t: number) => number {
  return (t) => {
    if (t < full) return B * Math.pow(Math.sin(((t / full) * Math.PI) / 2), 0.85);
    if (t > 0.88) return B * (1 - (1 - transom) * ((t - 0.88) / 0.12));
    return B;
  };
}

/**
 * A painted hull: anti-fouling below the waterline, a black boot-top at it, topsides above, and the deck.
 * Waterline at y = 0 (the sea surface the renderer places the ship on).
 */
function paintedHull(m: ModelBuilder, beam: (t: number) => number, deckY: (t: number) => number, keelY: number, flare: number,
  topsides: number, deck: number, deckTeam: number, bottom = 0x7a2e25): void {
  const base = { beam, deckY, keelY, flare };
  m.shipHull({ ...base, yBot: keelY, yTop: -0.004 }, bottom);
  m.shipHull({ ...base, yBot: -0.004, yTop: 0.007 }, 0x1b1d20);
  m.shipHull({ ...base, yBot: 0.007, yTop: 1 }, topsides);
  // Deck: a separate band at the very top so it can carry its own paint (and a touch of the nation color).
  m.push().translate(0, 0.0005, 0);
  m.shipHull({ ...base, yBot: 1, yTop: 1, deck: true, transom: false }, deck, { team: deckTeam });
  m.pop();
}

/** A deck-level grid of dark launch cells (VLS). */
function vls(m: ModelBuilder, x: number, y: number, z: number, nx: number, nz: number, cell: number): void {
  m.block(nx * cell + cell * 0.4, 0.004, nz * cell + cell * 0.4, x, y, z, 0x3a3f44);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
    m.block(cell * 0.7, 0.002, cell * 0.7, x + (i - (nx - 1) / 2) * cell, y + 0.004, z + (j - (nz - 1) / 2) * cell, 0x1c1f22);
  }
}

function warship(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A guided-missile destroyer: fine bow with sheer, navy-grey topsides, stepped stealth superstructure with the
  // phased-array mast, a 127 mm gun forward, launch cells fore and aft, one raked funnel, a hangar and flight deck.
  const beam = fineBeam(0.064, 0.36, 0.88);
  const deckY = (t: number) => 0.05 + 0.03 * Math.pow(1 - t, 2.6);
  const gray = 0x6d7780, light = 0x939ca4, dark = 0x2c3136;
  paintedHull(m, beam, deckY, -0.04, 0.5, gray, 0x50575d, 0.16);
  const dz = (z: number) => deckY(z + 0.5);
  // Hull numbers on the bow (white marks) and a nation stripe.
  for (const side of [1, -1]) {
    m.box(0.002, 0.018, 0.022, side * beam(0.14) * 0.97, 0.045, -0.355, 0xe8e8e8);
    m.box(0.002, 0.018, 0.012, side * beam(0.17) * 0.98, 0.045, -0.325, 0xe8e8e8);
    m.box(0.002, 0.012, 0.05, side * beam(0.22) * 0.99, 0.03, -0.27, light, { team: 1 });
  }
  // Forward gun: faceted mount and barrel.
  const gz = -0.28;
  m.frustum(0.046, 0.052, 0.03, 0.036, 0.022, 0, dz(gz) - 0.002, gz, light);
  m.cylZ(0.0035, 0.005, 0.085, 0, dz(gz) + 0.011, gz - 0.065, dark, 6);
  vls(m, 0, dz(-0.2) - 0.001, -0.2, 4, 3, 0.013);
  // Forward superstructure, bridge (glazed, nation-coloured roof) and the phased-array mast.
  const sy = dz(-0.06) - 0.003;
  m.frustum(0.108, 0.16, 0.092, 0.145, 0.05, 0, sy, -0.05, light);
  m.frustum(0.09, 0.075, 0.075, 0.06, 0.028, 0, sy + 0.05, -0.095, light);
  m.block(0.074, 0.003, 0.058, 0, sy + 0.078, -0.095, light, { team: 0.9 });
  m.box(0.078, 0.009, 0.004, 0, sy + 0.068, -0.132, 0x223344, { glow: 0.7 });
  m.frustum(0.07, 0.07, 0.03, 0.03, 0.085, 0, sy + 0.05, -0.035, light);
  // SPY array faces (dark octagons read as panels) on the four sides of the mast.
  for (const [x, z, ry] of [[0, -0.068, 0], [0, -0.002, Math.PI], [0.032, -0.035, Math.PI / 2], [-0.032, -0.035, -Math.PI / 2]] as [number, number, number][]) {
    m.push().translate(x, sy + 0.083, z).rotateY(ry).rotateX(-0.28);
    m.cyl(0.018, 0.018, 0.003, 0, 0, 0, 0x2a3036, 8);
    m.pop();
  }
  m.cyl(0.003, 0.005, 0.07, 0, sy + 0.135, -0.035, dark, 5);
  m.beam(-0.03, sy + 0.17, -0.035, 0.03, sy + 0.17, -0.035, 0.003, dark);
  m.sphere(0.009, 0, sy + 0.21, -0.035, 0xe6e8ea, 8, 6);
  // CIWS on the bridge front and the hangar roof.
  m.cyl(0.009, 0.01, 0.012, 0, sy + 0.05, -0.135, light, 8);
  m.dome(0.009, 0, sy + 0.062, -0.135, 0xe6e8ea, 8, 4);
  // Midships block with RHIBs, the raked funnel (nation band, black cap).
  const my = dz(0.08) - 0.003;
  m.frustum(0.092, 0.15, 0.08, 0.135, 0.044, 0, my, 0.08, light);
  for (const side of [1, -1]) {
    m.push().translate(side * 0.052, my + 0.02, 0.07).scale(0.012, 0.009, 0.034);
    m.sphere(1, 0, 0, 0, 0xd87830, 8, 5);
    m.pop();
  }
  m.frustum(0.05, 0.065, 0.036, 0.048, 0.05, 0, my + 0.044, 0.07, light);
  m.block(0.037, 0.012, 0.049, 0, my + 0.08, 0.071, light, { team: 1 });
  m.block(0.034, 0.006, 0.045, 0, my + 0.093, 0.072, 0x17191c, { heat: 0.1 });
  m.cyl(0.0025, 0.004, 0.06, 0, my + 0.044, 0.125, dark, 5);
  vls(m, 0, dz(0.22) - 0.001, 0.215, 4, 2, 0.013);
  // Hangar (nation-coloured roof), flight deck with its circle and centre line.
  const hy = dz(0.3) - 0.003;
  m.frustum(0.094, 0.085, 0.084, 0.078, 0.042, 0, hy, 0.29, light);
  m.block(0.082, 0.003, 0.074, 0, hy + 0.042, 0.29, light, { team: 1 });
  m.box(0.06, 0.03, 0.002, 0, hy + 0.017, 0.334, 0x33383d);
  m.cyl(0.008, 0.009, 0.01, 0.025, hy + 0.042, 0.27, light, 8);
  m.dome(0.008, 0.025, hy + 0.052, 0.27, 0xe6e8ea, 8, 4);
  const fy = dz(0.42) + 0.0015;
  const ring = new THREE.TorusGeometry(0.03, 0.0018, 3, 24);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, fy, 0.41);
  m.add(ring, 0xe8e8e8);
  m.plate(0.003, 0.14, 0, fy, 0.41, 0xe8c040);
  // Navigation lights.
  m.sphere(0.005, 0.047, sy + 0.06, -0.1, 0x33ff66, 4, 3, { heat: 0.4 });
  m.sphere(0.005, -0.047, sy + 0.06, -0.1, 0xff3322, 4, 3, { heat: 0.4 });
  return m.build();
}

function transport(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A landing ship: a full hull with a blunt bow door, a vehicle deck loaded with the invasion's armour and trucks,
  // the stern island (bridge, funnel with the nation band, cranes) and a nation stripe along the hull.
  const beam = fineBeam(0.085, 0.2, 0.92);
  const deckY = (t: number) => 0.07 + 0.016 * Math.pow(1 - t, 2);
  paintedHull(m, beam, deckY, -0.045, 0.62, 0x75808a, 0x505650, 0.2);
  const dz = (z: number) => deckY(z + 0.5);
  for (const side of [1, -1]) {
    m.box(0.002, 0.014, 0.52, side * 0.0855, 0.05, 0.02, 0xdadada, { team: 1 });
  }
  // Bow doors and ramp.
  m.frustum(0.09, 0.03, 0.06, 0.02, 0.02, 0, dz(-0.42) - 0.004, -0.42, 0x5e6870);
  // Vehicle deck: 3 rows of tanks and trucks (olive, nation tinted turrets).
  for (let r = 0; r < 5; r++) for (let c = -1; c <= 1; c++) {
    const z = -0.3 + r * 0.075, x = c * 0.05;
    const y = dz(z);
    if ((r + c) % 2 === 0) {
      m.block(0.034, 0.014, 0.058, x, y, z, 0x4d5a3a);
      m.block(0.024, 0.01, 0.026, x, y + 0.014, z + 0.004, 0x4d5a3a, { team: 0.7 });
      m.cylZ(0.002, 0.003, 0.03, x, y + 0.019, z - 0.024, 0x2b3024, 5);
    } else {
      m.block(0.028, 0.02, 0.06, x, y, z, 0x5b6446);
      m.block(0.028, 0.006, 0.018, x, y + 0.02, z - 0.02, 0x3a4130);
    }
  }
  // Stern island.
  const iy = dz(0.33) - 0.003;
  m.frustum(0.16, 0.15, 0.15, 0.14, 0.07, 0, iy, 0.36, 0xd8dcde);
  m.frustum(0.13, 0.08, 0.115, 0.07, 0.04, 0, iy + 0.07, 0.34, 0xd8dcde);
  m.box(0.12, 0.012, 0.004, 0, iy + 0.093, 0.303, 0x223344, { glow: 0.7 });
  m.block(0.1, 0.003, 0.06, 0, iy + 0.11, 0.34, 0xd8dcde, { team: 0.9 });
  m.cyl(0.003, 0.005, 0.07, 0, iy + 0.11, 0.35, 0x2c3136, 5);
  m.sphere(0.008, 0, iy + 0.18, 0.35, 0xe6e8ea, 8, 6);
  m.frustum(0.04, 0.05, 0.03, 0.04, 0.05, 0, iy + 0.07, 0.41, 0xd8dcde);
  m.block(0.031, 0.012, 0.041, 0, iy + 0.12, 0.41, 0xd8dcde, { team: 1 });
  m.block(0.028, 0.005, 0.037, 0, iy + 0.132, 0.41, 0x17191c, { heat: 0.1 });
  // Two deck cranes.
  for (const side of [1, -1]) {
    m.cyl(0.004, 0.005, 0.05, side * 0.06, dz(0.24), 0.24, 0xd9a520, 5);
    m.beam(side * 0.06, dz(0.24) + 0.05, 0.24, side * 0.03, dz(0.24) + 0.03, 0.14, 0.004, 0xd9a520);
  }
  m.sphere(0.006, 0.08, iy + 0.08, 0.3, 0x33ff66, 4, 3, { heat: 0.4 });
  m.sphere(0.006, -0.08, iy + 0.08, 0.3, 0xff3322, 4, 3, { heat: 0.4 });
  return m.build();
}

function trade(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A container ship: bulbous full hull (dark blue topsides, red bottom), bays of containers in the world's colours
  // (they carry everybody's goods), the white deckhouse aft and a funnel in the owner's colour.
  const beam = fineBeam(0.074, 0.22, 0.9);
  const deckY = (t: number) => 0.052 + 0.014 * Math.pow(1 - t, 2.4);
  paintedHull(m, beam, deckY, -0.05, 0.7, 0x1f3550, 0x5a3a2e, 0);
  const dz = (z: number) => deckY(z + 0.5);
  const cols = [0xb8452f, 0x2f6fb8, 0xd0a13a, 0x3d8f4f, 0x8f8f8f, 0xa0522d, 0x2a8a8a, 0xc0c0c0, 0x7c3f8f, 0xe07030];
  let k = 0;
  // One block per stack (colour per stack, a darker top tier): the look of a loaded deck at a fraction of the vertices.
  for (let bay = 0; bay < 9; bay++) {
    const z = -0.33 + bay * 0.068;
    const bw = Math.min(beam(z + 0.5) * 1.8, 0.13);
    const nx = Math.max(2, Math.round(bw / 0.022));
    for (let c = 0; c < nx; c++) {
      const hgt = 1 + ((bay * 7 + c * 3 + 11) % 4);
      const x = (c - (nx - 1) / 2) * 0.022;
      m.block(0.02, 0.0135 * hgt, 0.06, x, dz(z), z, cols[k++ % cols.length]);
    }
  }
  // Deckhouse aft with bridge wings, funnel in the owner's colour.
  const hy = dz(0.36) - 0.002;
  m.block(0.12, 0.09, 0.07, 0, hy, 0.37, 0xeceeee);
  m.block(0.15, 0.012, 0.03, 0, hy + 0.078, 0.345, 0xeceeee);
  m.box(0.12, 0.01, 0.003, 0, hy + 0.07, 0.334, 0x223344, { glow: 0.7 });
  m.cyl(0.003, 0.004, 0.05, 0, hy + 0.09, 0.38, 0x2c3136, 5);
  m.frustum(0.036, 0.05, 0.03, 0.042, 0.075, 0, hy, 0.44, 0xeceeee, { team: 1 });
  m.block(0.031, 0.008, 0.043, 0, hy + 0.075, 0.44, 0x17191c, { heat: 0.1 });
  // Forecastle and mast.
  m.block(0.05, 0.012, 0.03, 0, dz(-0.42), -0.41, 0x9aa0a4);
  m.cyl(0.002, 0.003, 0.05, 0, dz(-0.42), -0.4, 0xd9a520, 5);
  m.sphere(0.006, 0.07, hy + 0.08, 0.34, 0x33ff66, 4, 3, { heat: 0.4 });
  m.sphere(0.006, -0.07, hy + 0.08, 0.34, 0xff3322, 4, 3, { heat: 0.4 });
  return m.build();
}

// -------------------------------------------------------------------------------------------------
// Land vehicles & trains
// -------------------------------------------------------------------------------------------------

function tank(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A main battle tank (length 1 = hull + gun overhang): tracks with road wheels behind side skirts, a sloped glacis,
  // an angular wedge turret in the nation's colour with its bustle and cupola, and a long 120 mm gun.
  const olive = 0x56613f, oliveD = 0x3d4530, trackC = 0x1f211d;
  // A dark ground scar under the hull (churned earth and shade): separates the tank from land of any colour.
  m.push().translate(0, 0.002, 0.03).scale(1, 1, 1.9);
  m.cyl(0.25, 0.25, 0.002, 0, 0, 0, 0x2a2822, 10);
  m.pop();
  for (const side of [1, -1]) {
    m.block(0.075, 0.085, 0.7, side * 0.135, 0, 0.03, trackC);
    for (let i = 0; i < 6; i++) {
      m.push().translate(side * 0.174, 0.036, -0.24 + i * 0.1).rotateZ(Math.PI / 2);
      m.cyl(0.034, 0.034, 0.012, 0, -0.006, 0, 0x2c2f29, 10);
      m.pop();
    }
    m.cyl(0.03, 0.03, 0.074, side * 0.135, 0.045, -0.33, trackC, 8);
    m.box(0.012, 0.045, 0.6, side * 0.178, 0.078, 0.02, olive);
  }
  m.block(0.2, 0.09, 0.66, 0, 0.005, 0.03, oliveD);
  // Upper hull as a side profile: glacis, flat deck, sloped rear.
  m.fin([[-0.37, 0.085], [-0.3, 0.155], [0.36, 0.16], [0.39, 0.13], [0.38, 0.085]], 0, 0.36, olive);
  m.block(0.22, 0.006, 0.12, 0, 0.16, 0.3, 0x2a2d27, { heat: 0.05 });
  for (let i = 0; i < 4; i++) m.box(0.2, 0.004, 0.006, 0, 0.1635, 0.25 + i * 0.03, 0x1e201c);
  // Turret: wedge front, nation-coloured, bustle with stowage.
  m.slab([[-0.13, 0.13], [0.13, 0.13], [0.135, -0.07], [0.06, -0.19], [-0.06, -0.19], [-0.135, -0.07]], 0.16, 0.075, olive, { team: 0.7 });
  m.slab([[-0.11, 0.12], [0.11, 0.12], [0.115, -0.05], [0.05, -0.15], [-0.05, -0.15], [-0.115, -0.05]], 0.235, 0.01, olive, { team: 0.85 });
  m.block(0.2, 0.05, 0.07, 0, 0.17, 0.165, oliveD);
  m.block(0.07, 0.055, 0.045, 0, 0.17, -0.2, oliveD);
  m.cylZ(0.013, 0.017, 0.33, 0, 0.2, -0.38, oliveD, 8);
  m.cylZ(0.021, 0.021, 0.05, 0, 0.2, -0.36, oliveD, 8);
  m.cylZ(0.016, 0.016, 0.02, 0, 0.2, -0.54, 0x2b2f26, 8);
  // Commander's cupola with its sight and machine gun, gunner's sight box.
  m.cyl(0.028, 0.03, 0.022, 0.055, 0.245, 0.04, oliveD, 8);
  m.block(0.02, 0.018, 0.018, 0.055, 0.267, 0.02, 0x30352a);
  m.beam(0.055, 0.28, 0.02, 0.055, 0.28, -0.06, 0.006, 0x1c1e1a);
  m.block(0.03, 0.022, 0.03, -0.06, 0.245, -0.08, 0x30352a);
  m.box(0.022, 0.012, 0.004, -0.06, 0.258, -0.096, 0x223344, { glow: 0.5 });
  // Antennas and exhaust.
  m.beam(-0.09, 0.245, 0.12, -0.1, 0.38, 0.13, 0.004, 0x1c1e1a);
  m.block(0.12, 0.02, 0.01, 0, 0.1, 0.39, 0x1a1b18, { heat: 0.15 });
  return m.build();
}

function loco(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A freight locomotive in the national railway's livery: bogies with wheels, a long hood, the cab with its
  // windscreen, roof fans and a nation stripe along the body.
  m.block(0.26, 0.05, 0.94, 0, 0.035, 0, 0x2a2c2e);
  for (const z of [-0.3, 0.3]) {
    m.block(0.24, 0.05, 0.26, 0, 0, z, 0x1c1d1f);
    for (const dz of [-0.08, 0.08]) for (const side of [1, -1]) {
      m.push().translate(side * 0.125, 0.03, z + dz).rotateZ(Math.PI / 2);
      m.cyl(0.03, 0.03, 0.02, 0, -0.01, 0, 0x3a3c3e, 8);
      m.pop();
    }
  }
  m.block(0.28, 0.2, 0.78, 0, 0.085, 0.07, 0xd9dcdc);
  m.frustum(0.28, 0.14, 0.24, 0.1, 0.11, 0, 0.085, -0.39, 0xd9dcdc);
  m.box(0.24, 0.06, 0.004, 0, 0.23, -0.315, 0x1c2a36, { glow: 0.8 });
  m.block(0.285, 0.05, 0.93, 0, 0.13, 0.0, 0xd9dcdc, { team: 1 });
  for (let i = 0; i < 3; i++) m.cyl(0.05, 0.05, 0.012, 0, 0.285, 0.1 + i * 0.13, 0x3a3d40, 10);
  m.sphere(0.022, 0.08, 0.13, -0.47, 0xffffff, 6, 4, { heat: 0.5 });
  m.sphere(0.022, -0.08, 0.13, -0.47, 0xffffff, 6, 4, { heat: 0.5 });
  return m.build();
}

function wagon(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A container flat wagon with two containers (the freight that pays the factory).
  m.block(0.24, 0.035, 0.96, 0, 0.045, 0, 0x2a2c2e);
  for (const z of [-0.36, 0.36]) {
    m.block(0.22, 0.045, 0.18, 0, 0, z, 0x1c1d1f);
    for (const dz of [-0.05, 0.05]) for (const side of [1, -1]) {
      m.push().translate(side * 0.115, 0.028, z + dz).rotateZ(Math.PI / 2);
      m.cyl(0.028, 0.028, 0.018, 0, -0.009, 0, 0x3a3c3e, 8);
      m.pop();
    }
  }
  m.block(0.25, 0.2, 0.44, 0, 0.08, -0.235, 0x8a3b2c);
  m.block(0.25, 0.2, 0.44, 0, 0.08, 0.235, 0x2f5f8f, { team: 0.55 });
  return m.build();
}

// -------------------------------------------------------------------------------------------------
// Aircraft & missiles
// -------------------------------------------------------------------------------------------------

function fighter(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A multirole fighter (length 1, span ~0.66): lofted fuselage, bubble canopy, chin intake, cropped-delta wings and
  // tailplanes with the nation's colour on top, a single fin, wingtip missiles and the afterburner nozzle.
  const grey = 0x8b949c, dark = 0x3a4046;
  m.latheZ([[-0.5, 0], [-0.46, 0.012], [-0.4, 0.026], [-0.3, 0.04], [-0.18, 0.05], [-0.05, 0.056], [0.2, 0.056], [0.36, 0.05], [0.46, 0.042], [0.5, 0.04]], 0, 0, grey, 12, 0.82);
  m.latheZ([[-0.5, 0], [-0.47, 0.008], [-0.44, 0.012]], 0, 0, dark, 8, 0.82);
  m.push().translate(0, 0.036, -0.25).scale(0.028, 0.026, 0.1);
  m.sphere(1, 0, 0, 0, 0x2a3f55, 10, 6, { glow: 0.25 });
  m.pop();
  m.latheZ([[-0.12, 0.006], [-0.08, 0.02], [0.14, 0.03], [0.22, 0.02]], 0, 0.035, grey, 8, 0.7);
  m.frustum(0.06, 0.1, 0.066, 0.12, 0.04, 0, -0.062, -0.1, grey);
  m.box(0.056, 0.034, 0.004, 0, -0.042, -0.162, 0x121416);
  // Leading-edge root extensions, wings and tailplanes (nation colour on the upper surfaces).
  m.wing([[0.035, -0.34], [0.075, -0.12], [0.035, -0.1]], -0.004, 0.01, grey, { team: 0.5 });
  m.wing([[-0.035, -0.34], [-0.035, -0.1], [-0.075, -0.12]], -0.004, 0.01, grey, { team: 0.5 });
  m.wing([[0.04, -0.12], [0.33, 0.13], [0.33, 0.22], [0.04, 0.24]], -0.006, 0.012, grey, { team: 0.8 });
  m.wing([[-0.04, -0.12], [-0.04, 0.24], [-0.33, 0.22], [-0.33, 0.13]], -0.006, 0.012, grey, { team: 0.8 });
  m.wing([[0.04, 0.33], [0.17, 0.43], [0.17, 0.48], [0.04, 0.47]], -0.002, 0.008, grey, { team: 0.6 });
  m.wing([[-0.04, 0.33], [-0.04, 0.47], [-0.17, 0.48], [-0.17, 0.43]], -0.002, 0.008, grey, { team: 0.6 });
  m.fin([[0.2, 0.035], [0.38, 0.2], [0.45, 0.2], [0.49, 0.035]], 0, 0.009, grey, { team: 0.35 });
  // Wingtip missiles and a centreline tank.
  for (const x of [0.335, -0.335]) m.latheZ([[0.06, 0], [0.08, 0.008], [0.22, 0.008], [0.23, 0.006]], x, -0.004, 0xe0e2e4, 6);
  m.latheZ([[-0.12, 0], [-0.08, 0.018], [0.1, 0.018], [0.14, 0]], 0, -0.075, 0xb0b6bb, 8);
  // Nozzle with afterburner glow.
  m.cylZ(0.036, 0.03, 0.04, 0, 0, 0.51, dark, 10);
  m.cylZ(0.026, 0.026, 0.01, 0, 0, 0.53, 0x1a1a1a, 10, { heat: 0.9 });
  m.sphere(0.008, 0.33, 0.0, 0.2, 0x33ff66, 4, 3, { heat: 0.5 });
  m.sphere(0.008, -0.33, 0.0, 0.2, 0xff3322, 4, 3, { heat: 0.5 });
  return m.build();
}

function bomber(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A stealth flying wing: saw-tooth trailing edge, the blended centre body with its cockpit windows, dorsal
  // engine intakes and exhaust troughs; the nation's colour on the upper wing.
  const outline: [number, number][] = [
    [0, -0.5], [0.95, 0.16], [0.9, 0.24], [0.62, 0.1], [0.44, 0.26], [0.24, 0.1], [0, 0.26],
    [-0.24, 0.1], [-0.44, 0.26], [-0.62, 0.1], [-0.9, 0.24], [-0.95, 0.16],
  ];
  m.wing(outline, -0.01, 0.03, 0x3a3f45, { team: 0.55 });
  m.push().translate(0, 0.02, -0.1).scale(0.2, 0.06, 0.4);
  m.sphere(1, 0, 0, 0, 0x3a3f45, 14, 7, { team: 0.3 });
  m.pop();
  for (const x of [-0.04, 0.04]) m.box(0.03, 0.006, 0.02, x, 0.07, -0.33, 0x1c2a36, { glow: 0.5 });
  for (const x of [-0.22, -0.13, 0.13, 0.22]) {
    m.push().translate(x, 0.035, -0.04).scale(0.045, 0.028, 0.1);
    m.sphere(1, 0, 0, 0, 0x33383e, 8, 5);
    m.pop();
    m.box(0.04, 0.01, 0.012, x, 0.05, -0.12, 0x101214);
    m.box(0.05, 0.008, 0.07, x, 0.022, 0.12, 0x1c1e20, { heat: 0.5 });
  }
  m.sphere(0.012, 0.93, 0.0, 0.2, 0x33ff66, 4, 3, { heat: 0.5 });
  m.sphere(0.012, -0.93, 0.0, 0.2, 0xff3322, 4, 3, { heat: 0.5 });
  const g = m.build();
  g.scale(0.8, 0.8, 0.8);
  return g;
}

function drone(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A MALE drone: slender body with the satellite-link bulge, long straight wings, inverted V-tail, pusher propeller
  // and the sensor turret under the nose.
  // Mid-grey airframe (a white one burns out in sunlight from above) with nation-coloured wings and tail.
  const white = 0x8f959b;
  m.latheZ([[-0.42, 0], [-0.38, 0.03], [-0.3, 0.045], [-0.15, 0.04], [0.2, 0.032], [0.38, 0.018], [0.42, 0.012]], 0, 0, white, 10, 0.9);
  m.push().translate(0, 0.025, -0.3).scale(0.045, 0.04, 0.11);
  m.sphere(1, 0, 0, 0, white, 10, 6);
  m.pop();
  m.sphere(0.024, 0, -0.045, -0.3, 0x2a2d30, 8, 6);
  m.wing([[0.02, -0.07], [0.64, -0.035], [0.64, 0.025], [0.02, 0.05]], 0.012, 0.014, white, { team: 1 });
  m.wing([[-0.02, -0.07], [-0.02, 0.05], [-0.64, 0.025], [-0.64, -0.035]], 0.012, 0.014, white, { team: 1 });
  m.push().translate(0.02, -0.005, 0).rotateZ(-2.3).fin([[0.26, 0], [0.34, 0.16], [0.39, 0.16], [0.38, 0]], 0, 0.01, white, { team: 0.9 }).pop();
  m.push().translate(-0.02, -0.005, 0).rotateZ(2.3).fin([[0.26, 0], [0.34, 0.16], [0.39, 0.16], [0.38, 0]], 0, 0.01, white, { team: 0.9 }).pop();
  m.cylZ(0.014, 0.014, 0.02, 0, 0, 0.43, 0x2a2d30, 6, { heat: 0.2 });
  m.box(0.16, 0.012, 0.006, 0, 0, 0.445, 0x2a2d30);
  return m.build();
}

function cruise(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cylZ(0.04, 0.04, 0.82, 0, 0, 0.04, C.steel, 8);
  m.cylZ(0.0, 0.04, 0.12, 0, 0, -0.43, C.offWhite, 8);
  m.wing([[0.03, -0.05], [0.3, 0.06], [0.3, 0.1], [0.03, 0.08]], -0.01, 0.01, C.steel, { team: 0.8 });
  m.wing([[-0.03, -0.05], [-0.03, 0.08], [-0.3, 0.1], [-0.3, 0.06]], -0.01, 0.01, C.steel, { team: 0.8 });
  for (let i = 0; i < 4; i++) {
    m.push().rotateZ((i * Math.PI) / 2 + Math.PI / 4).fin([[0.34, 0.03], [0.44, 0.12], [0.48, 0.12], [0.48, 0.03]], 0, 0.012, C.steel).pop();
  }
  m.cylZ(0.032, 0.03, 0.03, 0, 0, 0.47, C.black, 8, { heat: 1.2 });
  return m.build();
}

function icbm(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Three-stage body: white with a nation band and black interstage rings.
  m.cylZ(0.06, 0.06, 0.34, 0, 0, 0.3, C.white, 12);
  m.cylZ(0.061, 0.061, 0.03, 0, 0, 0.12, C.black, 12);
  m.cylZ(0.055, 0.06, 0.28, 0, 0, -0.03, C.white, 12);
  m.cylZ(0.056, 0.056, 0.05, 0, 0, -0.07, C.white, 12, { team: 1 });
  m.cylZ(0.056, 0.056, 0.02, 0, 0, -0.18, C.black, 12);
  m.cylZ(0.0, 0.055, 0.26, 0, 0, -0.33, C.offWhite, 12);
  for (let i = 0; i < 4; i++) {
    m.push().rotateZ((i * Math.PI) / 2).fin([[0.34, 0.05], [0.46, 0.14], [0.5, 0.14], [0.5, 0.05]], 0, 0.014, C.hullDark).pop();
  }
  m.cylZ(0.05, 0.045, 0.04, 0, 0, 0.49, C.black, 10, { heat: 1.6 });
  return m.build();
}

function warhead(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Re-entry vehicle: dark ablative cone with a glowing hot nose.
  m.cylZ(0.0, 0.16, 0.7, 0, 0, 0.1, C.black, 10);
  m.cylZ(0.16, 0.14, 0.1, 0, 0, 0.5, C.hullDark, 10, { team: 0.7 });
  m.cylZ(0.0, 0.07, 0.22, 0, 0, -0.36, C.orange, 10, { heat: 1.4 });
  return m.build();
}

function sam(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cylZ(0.03, 0.035, 0.8, 0, 0, 0.05, C.white, 8);
  m.cylZ(0.0, 0.03, 0.14, 0, 0, -0.42, C.offWhite, 8);
  m.cylZ(0.036, 0.036, 0.06, 0, 0, -0.18, C.white, 8, { team: 1 });
  for (let i = 0; i < 4; i++) {
    m.push().rotateZ((i * Math.PI) / 2).fin([[0.36, 0.03], [0.44, 0.1], [0.48, 0.1], [0.48, 0.03]], 0, 0.01, C.steel).pop();
    m.push().rotateZ((i * Math.PI) / 2).fin([[-0.22, 0.03], [-0.16, 0.07], [-0.13, 0.07], [-0.13, 0.03]], 0, 0.008, C.steel).pop();
  }
  m.cylZ(0.03, 0.028, 0.03, 0, 0, 0.47, C.black, 8, { heat: 1.6 });
  return m.build();
}

// -------------------------------------------------------------------------------------------------
// Structures
// -------------------------------------------------------------------------------------------------

function cityBase(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Urban ground: dark asphalt with a foundation skirt (sits on sloped relief), glowing street grid at night and a
  // thin nation-colored ring road.
  m.cyl(0.47, 0.5, 0.1, 0, -0.096, 0, 0x34332f, 28);
  m.cyl(0.45, 0.45, 0.006, 0, 0, 0, 0x3a3a38, 28, { glow: 0.05 });
  const ring = new THREE.TorusGeometry(0.455, 0.0035, 3, 40);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.006, 0);
  m.add(ring, C.offWhite, { team: 0.7, glow: 0.3 });
  const inner = new THREE.TorusGeometry(0.26, 0.004, 3, 28);
  inner.rotateX(Math.PI / 2);
  inner.translate(0, 0.007, 0);
  m.add(inner, 0x55544f, { glow: 0.9 });
  // Radial avenues and a street grid.
  for (let i = 0; i < 4; i++) {
    m.push().rotateY((i * Math.PI) / 4).box(0.88, 0.002, 0.01, 0, 0.007, 0, 0x5b5a55, { glow: 0.55 }).pop();
  }
  for (let i = -3; i <= 3; i++) {
    const l = Math.sqrt(Math.max(0, 0.42 * 0.42 - (i * 0.11) ** 2)) * 2;
    m.box(l, 0.0015, 0.004, 0, 0.0065, i * 0.11, 0x4a4945, { glow: 0.35 });
    m.box(0.004, 0.0015, l, i * 0.11, 0.0065, 0, 0x4a4945, { glow: 0.35 });
  }
  // Park and river-side green.
  m.cyl(0.06, 0.06, 0.004, 0.18, 0.004, -0.14, 0x3d5a2e, 10);
  return m.build();
}

// Structures by level (DESIGN_V2 §6.5): every level adds visible capacity, so an upgrade shows on the model.
// Ground plates use muted, earthy tones that sit on any terrain (no saturated grass or sand carpets); the nation's
// colour goes on a few roofs and cranes so ownership reads from above; windows and runway lights glow at night.

const G = {
  gravel: 0x78725f,
  dryGrass: 0x76704f,
  grassDark: 0x686247,
  dirt: 0x7d6c52,
  concrete: 0x9d9b93,
  concreteDark: 0x75736b,
  asphalt: 0x333539,
  asphaltLight: 0x47494c,
  roof: 0x7b8086,
  wall: 0xb8b3a7,
  mark: 0xe9e6dc,
  yellow: 0xd6ae38,
  tree: 0x3f4c2d,
  earth: 0x87775a,
};

/** The ground plate of a facility: top at y = 0, a shallow skirt below (the foundation pad meets the relief). */
function plate(m: ModelBuilder, w: number, d: number, color: number, x = 0, z = 0): void {
  m.block(w, 0.05, d, x, -0.05, z, color);
}

/** A flat strip (road, taxiway, marking) from (x0, z0) to (x1, z1), width w, its top at y. */
function strip(m: ModelBuilder, x0: number, z0: number, x1: number, z1: number, w: number, y: number, color: number, o: PaintOpts = {}): void {
  const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz);
  m.push().translate((x0 + x1) / 2, 0, (z0 + z1) / 2).rotateY(Math.atan2(-dz, dx));
  m.block(len, 0.003, w, 0, y - 0.003, 0, color, o);
  m.pop();
}

/** A building: walls with a window band (lit at night) and a flat or gabled roof, optionally nation-tinted. */
function building(m: ModelBuilder, w: number, d: number, h: number, x: number, z: number, rot: number, wall: number, roof: number,
  roofTeam = 0, gable = false, y = 0): void {
  m.push().translate(x, y, z).rotateY(rot);
  m.block(w, h, d, 0, 0, 0, wall);
  m.box(w + 0.002, h * 0.2, d + 0.002, 0, h * 0.58, 0, 0x2b3a48, { glow: 0.8 });
  if (gable) m.prism(w + 0.006, Math.min(w, d) * 0.28, d + 0.006, 0, h, 0, roof, { team: roofTeam });
  else m.block(w + 0.004, 0.005, d + 0.004, 0, h, 0, roof, { team: roofTeam });
  m.pop();
}

/** A storage tank with a shallow roof. */
function storageTank(m: ModelBuilder, r: number, h: number, x: number, z: number, color = 0xdcdedb, y = 0): void {
  m.cyl(r, r, h, x, y, z, color, 14);
  m.push().translate(x, y + h, z).scale(1, 0.3, 1).dome(r, 0, 0, 0, color, 14, 3).pop();
}

/** A perimeter fence (thin dark walls) around a w x d rectangle. */
function fence(m: ModelBuilder, w: number, d: number, x = 0, z = 0, color = 0x4c4e50): void {
  const t = 0.004, h = 0.016;
  m.block(w, h, t, x, 0, z - d / 2, color);
  m.block(w, h, t, x, 0, z + d / 2, color);
  m.block(t, h, d, x - w / 2, 0, z, color);
  m.block(t, h, d, x + w / 2, 0, z, color);
}

/** A clump of trees (low-poly crowns). */
function trees(m: ModelBuilder, x: number, z: number, n: number, spread: number, seed: number): void {
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = spread * Math.sqrt(rnd()), k = 0.018 + 0.012 * rnd();
    m.push().translate(x + Math.cos(a) * r, k * 0.7, z + Math.sin(a) * r).scale(1, 1.25, 1);
    m.sphere(k, 0, 0, 0, i % 3 ? G.tree : 0x4a5733, 6, 4);
    m.pop();
  }
}

/** A small parked tank (a vehicle park reads as rows of these). Faces -Z; s = length. */
function miniTank(m: ModelBuilder, x: number, z: number, rot: number, s: number, team: number): void {
  m.push().translate(x, 0, z).rotateY(rot).scale(s, s, s);
  m.block(0.46, 0.17, 0.92, 0, 0, 0.02, 0x2a2c26);
  m.block(0.4, 0.08, 0.8, 0, 0.14, 0.04, 0x56613f);
  m.block(0.32, 0.1, 0.4, 0, 0.22, 0.08, 0x56613f, { team });
  m.cylZ(0.03, 0.04, 0.55, 0, 0.27, -0.36, 0x3d4530, 5);
  m.pop();
}

/** A truck (cab and box or tank body). Faces -Z; s = length. */
function truck(m: ModelBuilder, x: number, z: number, rot: number, s: number, body: number, team = 0): void {
  m.push().translate(x, 0, z).rotateY(rot).scale(s, s, s);
  m.block(0.34, 0.1, 1.0, 0, 0.04, 0, 0x26282a);
  m.block(0.36, 0.3, 0.26, 0, 0.1, -0.36, 0x56613f, { team });
  m.box(0.34, 0.08, 0.01, 0, 0.3, -0.495, 0x223344, { glow: 0.4 });
  m.block(0.38, 0.34, 0.68, 0, 0.1, 0.15, body);
  m.pop();
}

/** An arched hangar along Z (door facing -Z): w wide, d deep, h tall, nation-tinted roof. */
function archHangar(m: ModelBuilder, w: number, d: number, h: number, x: number, z: number, rot: number, roof: number, team: number): void {
  m.push().translate(x, 0, z).rotateY(rot);
  m.block(w, h * 0.35, d, 0, 0, 0, G.wall);
  const hg = new THREE.CylinderGeometry(w / 2, w / 2, d, 12, 1, false, 0, Math.PI);
  hg.rotateZ(Math.PI / 2);
  hg.rotateY(Math.PI / 2);
  hg.scale(1, (h * 0.65) / (w / 2), 1);
  hg.translate(0, h * 0.35, 0);
  m.add(hg, roof, { team });
  m.box(w * 0.8, h * 0.6, 0.004, 0, h * 0.32, -d / 2 - 0.001, 0x2a2d30);
  m.pop();
}

// ---- Airbase: 1 / 2 / 3 runways, 2 / 4 / 6 hardened shelters, 1 / 2 / 3 hangars (capacity 3 / 6 / 9 squadrons) ----

/** Draw a runway along X centered at the origin: shoulders, asphalt, edge and centre lines, threshold bars, lights. */
function runway(m: ModelBuilder, len: number, wid: number): void {
  m.block(len + 0.02, 0.003, wid + 0.018, 0, 0, 0, 0x5b5a4a);
  m.block(len, 0.004, wid, 0, 0.001, 0, G.asphalt);
  const y = 0.0052;
  for (let x = -len / 2 + 0.09; x < len / 2 - 0.08; x += 0.05) m.plate(0.026, 0.0028, x, y, 0, G.mark);
  for (const e of [-1, 1]) {
    const xe = e * (len / 2 - 0.022);
    for (let k = 0; k < 6; k++) m.plate(0.03, wid * 0.07, xe, y, (k - 2.5) * wid * 0.14, G.mark);
    for (const zz of [-0.25, 0.25]) m.plate(0.045, wid * 0.14, e * (len / 2 - 0.1), y, zz * wid, G.mark);
    m.plate(0.012, wid * 0.3, e * (len / 2 - 0.055), y, 0, G.mark);
  }
  for (const zz of [-1, 1]) {
    m.plate(len, 0.0022, 0, y, zz * (wid / 2 - 0.005), G.mark);
    m.plate(len, 0.002, 0, y - 0.0004, zz * (wid / 2 + 0.003), 0xffffff, { glow: 1.3 });
  }
}

function airbase(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  plate(m, 1, 1, G.dryGrass);
  for (const [x, z, w, d] of [[-0.28, 0.3, 0.34, 0.24], [0.28, 0.02, 0.2, 0.3], [-0.1, -0.44, 0.5, 0.06]] as [number, number, number, number][]) {
    m.block(w, 0.0015, d, x, 0, z, G.grassDark);
  }
  // Runways: A (main), B parallel (level 2), C crossing on the east side (level 3).
  m.push().translate(0, 0, -0.3);
  runway(m, 0.94, 0.07);
  m.pop();
  if (L >= 2) {
    m.push().translate(0, 0, -0.43);
    runway(m, 0.8, 0.055);
    m.pop();
    for (const x of [-0.37, 0.37]) strip(m, x, -0.43, x, -0.3, 0.02, 0.0045, G.asphaltLight);
  }
  if (L >= 3) {
    m.push().translate(0.43, 0, 0.12).rotateY(Math.PI / 2);
    runway(m, 0.7, 0.05);
    m.pop();
    strip(m, 0.36, -0.19, 0.43, -0.19, 0.022, 0.0045, G.asphaltLight);
    strip(m, 0.43, -0.265, 0.43, -0.19, 0.022, 0.0045, G.asphaltLight);
  }
  // Parallel taxiway with its links, yellow centre line.
  strip(m, -0.42, -0.19, 0.36, -0.19, 0.024, 0.0045, G.asphaltLight);
  strip(m, -0.42, -0.19, 0.36, -0.19, 0.0025, 0.0052, G.yellow);
  for (const x of [-0.42, -0.02, 0.36]) strip(m, x, -0.3, x, -0.19, 0.022, 0.0044, G.asphaltLight);
  // Apron (the parking slots of the docked squadrons), with lead-in lines.
  m.block(0.62, 0.004, 0.26, -0.13, 0.001, -0.02, G.concrete);
  strip(m, -0.02, -0.19, -0.02, -0.15, 0.024, 0.0048, G.asphaltLight);
  for (const [sx, sz] of AIRBASE_SLOTS) {
    strip(m, sx, sz - 0.075, sx, sz + 0.02, 0.0025, 0.0056, G.yellow);
    m.plate(0.04, 0.0025, sx, 0.0056, sz + 0.02, G.yellow);
  }
  // Hardened aircraft shelters behind the apron (doors facing the apron).
  for (let i = 0; i < 2 * L; i++) {
    const x = -0.4 + i * 0.1, z = 0.2;
    strip(m, x, 0.105, x, 0.165, 0.03, 0.0045, G.concreteDark);
    m.push().translate(x, 0, z);
    const hs = new THREE.CylinderGeometry(0.036, 0.04, 0.085, 10, 1, false, 0, Math.PI);
    hs.rotateZ(Math.PI / 2);
    hs.rotateY(Math.PI / 2);
    hs.scale(1, 0.8, 1);
    m.add(hs, 0x8e8c84, { team: 0.15 });
    m.box(0.05, 0.022, 0.003, 0, 0.011, -0.043, 0x26282a);
    m.pop();
  }
  // Maintenance hangars east of the apron (nation roofs), with their own apron.
  m.block(0.07, 0.004, 0.36, 0.215, 0.001, 0.02, G.concrete);
  for (let i = 0; i < L; i++) archHangar(m, 0.11, 0.14, 0.07, 0.3, -0.08 + i * 0.16, Math.PI / 2, G.roof, 0.6);
  // Control tower, operations, barracks, fuel farm, radar dome, fence and trees.
  const tx = 0.12, tz = 0.3;
  m.block(0.06, 0.03, 0.05, tx + 0.03, 0, tz, G.wall);
  m.cyl(0.014, 0.018, 0.1, tx, 0, tz, 0xd8d6cf, 8);
  m.cyl(0.03, 0.022, 0.028, tx, 0.1, tz, 0x2b3f52, 8, { glow: 1.2 });
  m.cyl(0.033, 0.033, 0.006, tx, 0.128, tz, 0xd8d6cf, 8, { team: 0.5 });
  m.sphere(0.005, tx, 0.14, tz, 0xff3322, 4, 3, { heat: 0.8 });
  building(m, 0.16, 0.07, 0.045, 0.0, 0.37, 0, G.wall, G.roof, 0.4);
  building(m, 0.12, 0.05, 0.035, 0.27, 0.34, 0, G.wall, G.roof, 0.2, true);
  building(m, 0.12, 0.05, 0.035, 0.27, 0.43, 0, G.wall, G.roof, 0.2, true);
  for (let i = 0; i < L + 1; i++) storageTank(m, 0.026, 0.035, -0.42 + (i % 2) * 0.065, 0.34 + Math.floor(i / 2) * 0.07, 0xdcdedb);
  m.cyl(0.006, 0.006, 0.07, -0.15, 0, 0.42, 0x8a8f94, 4);
  m.sphere(0.03, -0.15, 0.09, 0.42, 0xeeeeea, 10, 8);
  strip(m, 0.0, 0.33, 0.0, 0.49, 0.02, 0.0045, G.asphaltLight);
  fence(m, 0.98, 0.98);
  trees(m, -0.3, 0.44, 6, 0.05, 1);
  trees(m, 0.44, 0.44, L >= 3 ? 0 : 5, 0.04, 2);
  return m.build();
}

/**
 * Apron slots (model units, y = apron top) of the docked aircraft: 9 = the level-3 capacity, two rows facing the
 * taxiway (-Z). index.ts parks one aircraft per docked squadron here.
 */
export const AIRBASE_SLOTS: readonly [number, number][] = [
  [-0.4, -0.085], [-0.29, -0.085], [-0.18, -0.085], [-0.07, -0.085], [0.04, -0.085],
  [-0.4, 0.05], [-0.29, 0.05], [-0.18, 0.05], [-0.07, 0.05],
];

// ---- Port: 1 / 2 / 3 berths with 2 / 4 / 6 cranes, the container yard, warehouses and the rail spur -------------

function port(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Land side (z > -0.1): the terminal; water side (z < -0.1): the quay, piers, moored ships.
  m.block(1.0, 0.06, 0.6, 0, -0.06, 0.2, G.concreteDark);
  m.block(1.0, 0.012, 0.02, 0, -0.012, -0.1, 0x55534d);
  m.block(0.66, 0.003, 0.36, -0.12, 0, 0.17, G.asphaltLight);
  // Container stacks: 2 / 3 / 4 rows.
  const cols = [0xb8452f, 0x2f6fb8, 0xd0a13a, 0x3d8f4f, 0x8f8f8f, 0xa0522d, 0x2a8a8a, 0xc0c0c0, 0x7c3f8f];
  let k = 0;
  for (let r = 0; r < L + 1; r++) for (let c = 0; c < 9; c++) {
    const hgt = 1 + ((r * 5 + c * 3 + 1) % 4);
    m.block(0.06, 0.016 * hgt, 0.022, -0.4 + c * 0.07, 0.003, 0.04 + r * 0.07, cols[k++ % cols.length]);
    m.block(0.06, 0.016 * Math.max(1, hgt - 1), 0.022, -0.4 + c * 0.07, 0.003, 0.064 + r * 0.07, cols[(k + 4) % cols.length]);
  }
  // Warehouses (1 / 2 / 3) and the port authority building.
  for (let i = 0; i < L; i++) building(m, 0.2, 0.1, 0.055, 0.34, 0.03 + i * 0.13, 0, G.wall, G.roof, 0.5, true);
  building(m, 0.09, 0.07, 0.09, 0.4, 0.43, 0, 0xd2d4d2, G.roof, 0.3);
  // Rail spur along the back with container wagons.
  strip(m, -0.48, 0.44, 0.3, 0.44, 0.02, 0.004, 0x3c3a36);
  for (let i = 0; i < 2 + 2 * L; i++) m.block(0.07, 0.022, 0.018, -0.43 + i * 0.085, 0.004, 0.44, cols[(i * 3) % cols.length]);
  // Berths: the main quay (all levels), a finger pier (level 2) and a second pier with a breakwater (level 3).
  const berths: [number, number, number][] = [[-0.05, -0.128, 0]];
  if (L >= 2) berths.push([0.3, -0.3, Math.PI / 2]);
  if (L >= 3) berths.push([-0.33, -0.3, Math.PI / 2]);
  if (L >= 2) {
    m.block(0.08, 0.06, 0.38, 0.3, -0.055, -0.29, G.concreteDark);
    for (let i = 0; i < 5; i++) m.cyl(0.006, 0.006, 0.05, 0.3 + (i % 2 ? 0.035 : -0.035), -0.1, -0.12 - i * 0.07, 0x4a4c4e, 5);
  }
  if (L >= 3) {
    m.block(0.08, 0.06, 0.38, -0.33, -0.055, -0.29, G.concreteDark);
    // Rubble breakwater along the outer edge and its lighthouse.
    for (let i = 0; i < 9; i++) m.push().translate(-0.46 + i * 0.07, -0.03, -0.47).rotateY(i * 0.7).cyl(0.04, 0.05, 0.04, 0, 0, 0, 0x6d6a62, 6, { flat: true }).pop();
    m.cyl(0.012, 0.016, 0.1, 0.12, 0, -0.47, 0xe8e8e2, 8);
    m.cyl(0.0125, 0.0125, 0.02, 0.12, 0.04, -0.47, 0xb83a2c, 8);
    m.sphere(0.01, 0.12, 0.105, -0.47, 0xffe8a0, 6, 4, { heat: 0.8, glow: 1 });
  }
  // Moored container ships (hulls reach below the water line so they never float above the sea).
  const ship = trade();
  for (const [x, z, rot] of berths) {
    const along = rot === 0;
    m.push().translate(along ? x : x + 0.09, -0.007, along ? z : z - 0.02).rotateY(along ? Math.PI / 2 : 0).scale(0.3, 0.3, 0.3);
    m.merge(ship);
    m.pop();
  }
  ship.dispose();
  // Ship-to-shore gantry cranes (nation coloured), two per berth, booms over the water.
  const crane = (x: number, z: number, rot: number) => {
    m.push().translate(x, 0, z).rotateY(rot);
    for (const [lx, lz] of [[-0.03, -0.025], [0.03, -0.025], [-0.03, 0.035], [0.03, 0.035]]) m.block(0.008, 0.16, 0.008, lx, 0, lz, 0xc9ccce, { team: 0.85 });
    m.block(0.07, 0.012, 0.075, 0, 0.1, 0.005, 0xc9ccce, { team: 0.85 });
    m.block(0.07, 0.03, 0.03, 0, 0.16, 0.035, 0xc9ccce, { team: 0.85 });
    m.beam(0, 0.17, 0.05, 0, 0.17, -0.2, 0.012, 0xc9ccce, { team: 0.85 });
    m.beam(0, 0.23, 0.02, 0, 0.17, -0.19, 0.004, 0xc9ccce);
    m.beam(0, 0.23, 0.02, 0, 0.17, 0.05, 0.004, 0xc9ccce);
    m.block(0.02, 0.014, 0.02, 0, 0.155, -0.1, 0x2a2d30);
    m.sphere(0.005, 0, 0.235, 0.02, 0xff3322, 4, 3, { heat: 0.6 });
    m.pop();
  };
  crane(-0.2, -0.08, 0);
  crane(0.08, -0.08, 0);
  if (L >= 2) { crane(0.3, -0.22, -Math.PI / 2); crane(0.3, -0.38, -Math.PI / 2); }
  if (L >= 3) { crane(-0.33, -0.22, -Math.PI / 2); crane(-0.33, -0.38, -Math.PI / 2); }
  m.block(1.0, 0.003, 0.01, 0, 0.0, -0.45, 0xffffff, { glow: 1.0 });
  return m.build();
}

// ---- Factory: 1 / 2 / 3 halls, 2 / 4 / 6 stacks, 1 / 2 / 3 tanks; level 3 adds the cooling tower ---------------

function factory(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  plate(m, 1, 1, G.gravel);
  m.block(0.94, 0.003, 0.94, 0, 0, 0, G.concreteDark);
  // Production halls with saw-tooth roofs (glazed north lights glow at night, the sunny slopes nation-tinted).
  const halls: [number, number, number, number][] = [[-0.14, 0.1, 0.56, 0.26], [-0.14, -0.22, 0.56, 0.26], [0.3, -0.26, 0.26, 0.3]];
  for (let hIdx = 0; hIdx < L; hIdx++) {
    const [hx, hz, w, d] = halls[hIdx];
    m.block(w, 0.1, d, hx, 0.003, hz, 0x9a7a62);
    m.box(w + 0.002, 0.022, d + 0.002, hx, 0.06, hz, 0x2b3a48, { glow: 0.9 });
    const n = Math.max(3, Math.round(d / 0.065));
    for (let i = 0; i < n; i++) {
      const z = hz - d / 2 + (i + 0.5) * (d / n);
      m.push().translate(hx, 0.103, z);
      m.fin([[-d / n / 2, 0], [d / n / 2, 0], [d / n / 2, 0.045]], 0, w, G.roof, { team: 0.55 });
      m.box(w, 0.04, 0.003, 0, 0.022, d / n / 2 - 0.001, 0x2b3a48, { glow: 1 });
      m.pop();
    }
  }
  // Offices and the car park.
  building(m, 0.2, 0.12, 0.12, 0.33, 0.34, 0, 0xd6d8d6, G.roof, 0.3);
  m.block(0.16, 0.003, 0.1, 0.1, 0, 0.37, G.asphalt);
  const cars = [0xb8452f, 0x2f6fb8, 0xd0d0d0, 0x222222, 0x8f8f8f];
  for (let i = 0; i < 10; i++) m.block(0.014, 0.008, 0.025, 0.04 + (i % 5) * 0.03, 0.003, 0.34 + Math.floor(i / 5) * 0.06, cars[i % cars.length]);
  // Storage tanks with a pipe rack to the halls.
  const tankAt: [number, number][] = [[0.42, -0.02], [0.42, 0.11], [0.3, -0.03]];
  for (let i = 0; i < L; i++) storageTank(m, 0.05, 0.09, tankAt[i][0], tankAt[i][1], 0xe0e2de, 0.003);
  m.beam(0.14, 0.07, 0.04, 0.42, 0.07, 0.04, 0.008, 0x8e959c);
  // Smokestacks: two per level along the back edge (index.ts emits their smoke at these positions).
  for (let i = 0; i < 2 * L; i++) {
    const x = -0.42 + i * 0.08, z = 0.38;
    const hgt = 0.3 + 0.04 * (i % 2);
    m.cyl(0.024, 0.036, hgt, x, 0.003, z, 0xcfcfcb, 10);
    m.cyl(0.025, 0.029, 0.035, x, hgt - 0.09, z, 0xb03a2c, 10);
    m.cyl(0.0245, 0.0245, 0.03, x, hgt - 0.03, z, 0xb03a2c, 10);
    m.sphere(0.009, x, hgt + 0.008, z, 0xff2211, 4, 3, { heat: 0.6 });
  }
  // Level 3: a cooling tower (the new power plant) in the south-east corner.
  if (L >= 3) {
    m.lathe([[0.09, 0], [0.076, 0.08], [0.058, 0.17], [0.06, 0.21], [0.066, 0.25], [0.062, 0.25], [0.054, 0.2], [0.052, 0.1], [0.064, 0.01]], 0.24, 0.003, 0.17, 0xc9c6bd, 18);
  }
  // Rail spur with wagons (the freight the factory ships).
  strip(m, -0.47, 0.46, 0.47, 0.46, 0.02, 0.006, 0x3c3a36);
  for (let i = 0; i < 2 * L + 1; i++) m.block(0.07, 0.028, 0.02, -0.4 + i * 0.09, 0.006, 0.46, i % 2 ? 0x7b4a33 : 0x3b4148, { team: i === 0 ? 0.6 : 0 });
  return m.build();
}

// ---- Defense post: L1 earthwork ring, trenches and a one-gun bunker; L2 twin turret, tower, 3 artillery pits;
// L3 a concrete star fort and 6 pits --------------------------------------------------------------------------

function defensePost(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cyl(0.5, 0.5, 0.05, 0, -0.05, 0, G.dirt, 24);
  const berm = new THREE.TorusGeometry(0.38, 0.06, 4, 18);
  berm.rotateX(Math.PI / 2);
  berm.scale(1, 0.6, 1);
  m.add(berm, G.earth, { flat: true });
  // Zig-zag trench line outside the berm.
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    m.push().translate(Math.cos(a) * 0.46, 0.001, Math.sin(a) * 0.46).rotateY(-a + (i % 2 ? 0.55 : -0.55));
    m.block(0.1, 0.006, 0.02, 0, 0, 0, 0x3a3326, { flat: true });
    m.block(0.1, 0.012, 0.006, 0, 0, 0.013, 0x8a7a5a, { flat: true });
    m.pop();
  }
  if (L >= 3) {
    // Concrete fort: pentagonal walls with bastions.
    m.cyl(0.33, 0.36, 0.1, 0, 0, 0, G.concreteDark, 5, { flat: true });
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      m.cyl(0.07, 0.08, 0.12, Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35, G.concrete, 4, { flat: true });
    }
  }
  m.cyl(0.24, 0.28, 0.12, 0, L >= 3 ? 0.1 : 0, 0, G.concrete, 6, { flat: true });
  const top = L >= 3 ? 0.22 : 0.12;
  m.cyl(0.2, 0.24, 0.05, 0, top, 0, G.concreteDark, 6, { team: 0.7, flat: true });
  m.cyl(0.285, 0.285, 0.02, 0, top - 0.06, 0, 0x202224, 6);
  if (L >= 2) {
    m.cylZ(0.015, 0.018, 0.3, 0.05, top + 0.07, -0.2, 0x2c3136, 6);
    m.cylZ(0.015, 0.018, 0.3, -0.05, top + 0.07, -0.2, 0x2c3136, 6);
    m.block(0.16, 0.05, 0.14, 0, top + 0.05, -0.02, 0x3d4530);
  } else {
    m.cylZ(0.014, 0.016, 0.24, 0, top + 0.06, -0.17, 0x2c3136, 6);
    m.block(0.1, 0.04, 0.1, 0, top + 0.04, -0.02, 0x3d4530);
  }
  if (L >= 2) {
    m.cyl(0.035, 0.045, 0.34, -0.3, 0, 0.14, G.concreteDark, 6, { flat: true });
    m.cyl(0.06, 0.05, 0.05, -0.3, 0.34, 0.14, G.concrete, 6, { team: 0.6, flat: true });
  }
  m.cyl(0.006, 0.006, 0.4, 0.2, 0.0, 0.2, 0x8e959c, 4);
  m.box(0.004, 0.08, 0.13, 0.2, 0.35, 0.265, 0xe6e8ea, { team: 1 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    m.cyl(0.05, 0.06, 0.04, Math.cos(a) * 0.4, 0.02, Math.sin(a) * 0.4, 0x9a8a66, 7, { flat: true });
  }
  if (L >= 2) {
    for (let i = 0; i < 3 * (L - 1); i++) {
      const a = (i / (3 * (L - 1))) * Math.PI * 2 + 0.9;
      m.push().translate(Math.cos(a) * 0.43, 0.005, Math.sin(a) * 0.43).rotateY(-a - Math.PI / 2);
      m.cyl(0.075, 0.085, 0.035, 0, 0, 0, 0x9a8a66, 8, { flat: true });
      m.block(0.06, 0.04, 0.07, 0, 0.035, 0, 0x56613f, { team: 0.6 });
      m.cylZ(0.011, 0.013, 0.15, 0, 0.06, -0.09, 0x2c3136, 5);
      m.pop();
    }
  }
  m.sphere(0.012, 0, top + 0.08, 0, 0xffcc66, 4, 3, { glow: 1 });
  return m.build();
}

// ---- SAM site: 2 / 4 / 6 launchers in revetments around the engagement radar; L2 adds the search radar,
// L3 the tower-mounted low-altitude radar ------------------------------------------------------------------------

function samSite(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cyl(0.5, 0.5, 0.05, 0, -0.05, 0, 0x716c5a, 28);
  const ring = new THREE.TorusGeometry(0.24, 0.016, 3, 36);
  ring.rotateX(Math.PI / 2);
  ring.scale(1, 0.15, 1);
  m.add(ring, G.asphaltLight);
  strip(m, 0, 0.24, 0, 0.5, 0.03, 0.003, G.asphaltLight);
  const n = 2 * L;
  const r = 0.36;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / 4 + (L === 1 ? 0.6 : 0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    strip(m, Math.cos(a) * 0.25, Math.sin(a) * 0.25, x, z, 0.026, 0.003, G.asphaltLight);
    // Launcher facing outward (its -Z), in a horseshoe earth revetment open toward the ring road.
    m.push().translate(x, 0, z).rotateY(-a - Math.PI / 2);
    m.block(0.035, 0.04, 0.2, 0.075, 0, 0.0, G.earth, { flat: true });
    m.block(0.035, 0.04, 0.2, -0.075, 0, 0.0, G.earth, { flat: true });
    m.block(0.185, 0.04, 0.035, 0, 0, -0.1, G.earth, { flat: true });
    m.block(0.065, 0.028, 0.19, 0, 0.006, 0.01, 0x2a2c26);
    m.block(0.065, 0.04, 0.045, 0, 0.014, -0.07, 0x56613f, { team: 0.6 });
    m.push().translate(0, 0.045, 0.065).rotateX(1.05);
    for (let c = 0; c < 4; c++) {
      m.cylZ(0.015, 0.015, 0.16, (c % 2 - 0.5) * 0.032, Math.floor(c / 2) * 0.032, -0.08, 0x5e6947, 8);
      m.cylZ(0.0145, 0.0145, 0.005, (c % 2 - 0.5) * 0.032, Math.floor(c / 2) * 0.032, -0.161, 0xd8d6cf, 8, { team: 0.8 });
    }
    m.pop();
    m.pop();
  }
  // Engagement radar on its trailer (a raised phased-array face), command post, generators.
  m.block(0.05, 0.02, 0.1, 0, 0.004, 0.02, 0x2a2c26);
  m.push().translate(0, 0.03, -0.02).rotateX(-0.22);
  m.block(0.16, 0.14, 0.022, 0, 0, 0, 0x56613f, { team: 0.25 });
  m.box(0.13, 0.11, 0.004, 0, 0.07, -0.013, 0x2a3036);
  m.pop();
  truck(m, 0.1, 0.1, 0.4, 0.09, 0x56613f, 0.5);
  truck(m, -0.1, 0.1, -0.4, 0.08, 0x4a5236);
  truck(m, -0.13, -0.06, 0.2, 0.08, 0x4a5236);
  m.cyl(0.003, 0.004, 0.14, 0.14, 0, -0.08, 0x2c3136, 4);
  if (L >= 2) {
    // Search radar: a rotating panel on a mast truck.
    truck(m, 0.13, -0.08, -0.3, 0.1, 0x4a5236);
    m.cyl(0.005, 0.006, 0.06, 0.13, 0.04, -0.08, 0x2c3136, 5);
    m.push().translate(0.13, 0.1, -0.08).rotateY(0.6).rotateX(-0.3);
    m.block(0.1, 0.05, 0.012, 0, 0, 0, 0x6e7768, { team: 0.3 });
    m.pop();
  }
  if (L >= 3) {
    // Low-altitude radar on a tall lattice tower (the level-3 silhouette).
    const tx = -0.02, tz = 0.15, H = 0.34;
    for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.beam(tx + lx * 0.03, 0, tz + lz * 0.03, tx + lx * 0.01, H, tz + lz * 0.01, 0.005, 0x8e959c);
    for (let k = 1; k < 5; k++) {
      const y = (k / 5) * H, w = 0.03 - 0.02 * (k / 5);
      m.beam(tx - w, y, tz - w, tx + w, y, tz + w, 0.003, 0x8e959c);
      m.beam(tx + w, y, tz - w, tx - w, y, tz + w, 0.003, 0x8e959c);
    }
    m.push().translate(tx, H + 0.03, tz).rotateX(-0.2);
    m.block(0.1, 0.06, 0.014, 0, -0.03, 0, 0x56613f, { team: 0.5 });
    m.pop();
    m.sphere(0.006, tx, H + 0.07, tz, 0xff3322, 4, 3, { heat: 0.6 });
  }
  return m.build();
}

// ---- Missile silo: 1 / 2 / 3 silo doors (the first one open), the buried launch control centre, fences, towers ----

function silo(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // A pale concrete compound on dark gravel so it reads from 40 km; every level shows three silo cells (the level
  // arms 1 / 2 / 3 of them) and the erector gantry standing over the armed, open cell.
  plate(m, 1, 1, G.gravel);
  m.block(0.86, 0.004, 0.62, 0, 0, -0.12, G.concrete);
  fence(m, 0.96, 0.96);
  fence(m, 0.9, 0.9);
  strip(m, 0.0, 0.5, 0.0, 0.2, 0.05, 0.006, G.asphalt);
  strip(m, -0.28, -0.2, 0.28, -0.2, 0.05, 0.006, G.asphalt);
  strip(m, 0, 0.2, 0, -0.2, 0.05, 0.006, G.asphalt);
  const pads: [number, number][] = [[-0.26, -0.22], [0.26, -0.22], [0.0, 0.1]];
  for (let i = 0; i < 3; i++) {
    const [x, z] = pads[i];
    const armed = i < L;
    // The cell: a dark raised collar with a yellow/black hazard ring, whatever the level (an unarmed cell is closed
    // and unpainted).
    m.cyl(0.115, 0.12, 0.014, x, 0.004, z, 0x1b1c1e, 20);
    m.cyl(0.1, 0.1, 0.004, x, 0.018, z, armed ? G.yellow : 0x5a5c5e, 20);
    m.cyl(0.085, 0.085, 0.006, x, 0.02, z, G.concreteDark, 20);
    // Door rails for the sliding hatch.
    const rx = x + (x > 0.1 ? -0.08 : 0.08);
    m.block(0.3, 0.008, 0.014, rx, 0.018, z - 0.07, 0x3a3c3e);
    m.block(0.3, 0.008, 0.014, rx, 0.018, z + 0.07, 0x3a3c3e);
    if (armed && i === 0) {
      // Open: the hatch slid aside, the missile's nose in the owner's colours, the erector gantry over it.
      m.cyl(0.07, 0.07, 0.004, x, 0.026, z, 0x0c0d0e, 16);
      m.lathe([[0.05, 0], [0.05, 0.03], [0.038, 0.07], [0.015, 0.1], [0.001, 0.115]], x, 0.02, z, 0xf0f0ee, 12);
      m.cyl(0.0505, 0.0505, 0.016, x, 0.03, z, 0xe8e8e6, 12, { team: 1 });
      m.block(0.15, 0.035, 0.15, x + 0.18, 0.02, z, G.concreteDark, { team: 0.3 });
      m.block(0.152, 0.005, 0.152, x + 0.18, 0.055, z, G.yellow);
      // Erector / service gantry: two lattice legs and a nation-coloured bridge with its warning lights.
      for (const dz of [-0.09, 0.09]) m.block(0.022, 0.24, 0.022, x - 0.1, 0.02, z + dz, 0xc9ccce, { team: 0.6 });
      m.block(0.14, 0.03, 0.22, x - 0.04, 0.24, z, 0xc9ccce, { team: 0.9 });
      m.sphere(0.012, x - 0.1, 0.28, z - 0.09, 0xff3322, 4, 3, { heat: 0.8 });
      m.sphere(0.012, x - 0.1, 0.28, z + 0.09, 0xff3322, 4, 3, { heat: 0.8 });
    } else {
      // Closed: the massive hatch lid (yellow-topped when armed) with its hinge block.
      m.block(0.15, 0.04, 0.15, x, 0.02, z, G.concreteDark, { team: armed ? 0.3 : 0 });
      m.block(0.152, 0.005, 0.152, x, 0.06, z, armed ? G.yellow : 0x8a8880);
      m.block(0.09, 0.003, 0.09, x, 0.065, z, armed ? 0x1b1c1e : G.concreteDark);
      if (armed) {
        // A service mast with its warning light beside every armed cell.
        m.cyl(0.006, 0.008, 0.16, x - 0.12, 0.02, z + 0.08, 0x8e959c, 4);
        m.sphere(0.01, x - 0.12, 0.18, z + 0.08, 0xff3322, 4, 3, { heat: 0.8 });
      }
    }
  }
  // Buried launch control centre (grassed mound with its portal) and one antenna mast per level.
  m.frustum(0.24, 0.18, 0.16, 0.1, 0.05, 0.3, 0, 0.36, 0x6f6b53, { flat: true });
  for (const x of [0.25, 0.35]) m.cyl(0.008, 0.008, 0.07, x, 0.02, 0.38, G.concreteDark, 6);
  m.block(0.05, 0.03, 0.03, 0.3, 0, 0.26, G.concreteDark);
  m.box(0.03, 0.02, 0.002, 0.3, 0.012, 0.244, 0x151617);
  for (let i = 0; i < L; i++) {
    const ax = 0.42 - i * 0.05;
    m.cyl(0.004, 0.006, 0.26, ax, 0, 0.24, 0x8e959c, 4);
    m.sphere(0.008, ax, 0.26, 0.24, 0xff2211, 4, 3, { heat: 0.8 });
  }
  // Security building, guard towers, helipad.
  building(m, 0.12, 0.07, 0.045, -0.3, 0.36, 0, G.wall, G.roof, 0.4);
  for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [0.45, 0.45]]) {
    m.cyl(0.008, 0.01, 0.07, x, 0, z, 0x8e959c, 4);
    m.block(0.03, 0.02, 0.03, x, 0.07, z, G.wall);
    m.block(0.034, 0.004, 0.034, x, 0.09, z, G.roof);
  }
  m.cyl(0.06, 0.06, 0.004, -0.3, 0, 0.16, G.asphalt, 16);
  m.plate(0.01, 0.05, -0.318, 0.0045, 0.16, G.mark);
  m.plate(0.01, 0.05, -0.282, 0.0045, 0.16, G.mark);
  m.plate(0.036, 0.01, -0.3, 0.0045, 0.16, G.mark);
  if (L >= 3) building(m, 0.1, 0.12, 0.04, -0.12, 0.38, 0, G.wall, G.roof, 0.3, true);
  return m.build();
}

// ---- Army base: barracks rows, a vehicle park of 2 / 4 / 6 tank rows, sheds, HQ and parade ground; L2 the repair
// workshop, L3 the helicopter pads -------------------------------------------------------------------------------

function armyBase(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  plate(m, 1, 1, G.gravel);
  // Perimeter wall with corner towers and the gate.
  for (const [w, d, x, z] of [[1.0, 0.018, 0, -0.49], [0.42, 0.018, -0.29, 0.49], [0.42, 0.018, 0.29, 0.49], [0.018, 1.0, -0.49, 0], [0.018, 1.0, 0.49, 0]] as [number, number, number, number][]) {
    m.block(w, 0.04, d, x, 0, z, G.concrete);
  }
  for (const [x, z] of [[-0.49, -0.49], [0.49, -0.49], [-0.49, 0.49], [0.49, 0.49], [-0.08, 0.49], [0.08, 0.49]]) {
    m.block(0.05, 0.1, 0.05, x, 0, z, G.concreteDark);
    m.block(0.056, 0.006, 0.056, x, 0.1, z, G.roof, { team: 0.5 });
    m.sphere(0.008, x, 0.12, z, 0xffcc66, 4, 3, { glow: 1.2 });
  }
  strip(m, 0, 0.5, 0, -0.3, 0.05, 0.003, G.asphaltLight);
  strip(m, -0.45, -0.3, 0.45, -0.3, 0.035, 0.003, G.asphaltLight);
  // Barracks: two-storey blocks with nation roofs, one more row per level.
  for (let r = 0; r < L + 1; r++) {
    building(m, 0.3, 0.07, 0.06, -0.24, -0.2 + r * 0.11, 0, G.wall, G.roof, 0.55, true);
  }
  // Vehicle park: 2 / 4 / 6 rows of four tanks on concrete hardstands.
  m.block(0.36, 0.003, 0.08 + 0.075 * (2 * L - 1), 0.24, 0, -0.18 + (0.075 * (2 * L - 1)) / 2, G.concreteDark);
  for (let r = 0; r < 2 * L; r++) for (let c = 0; c < 4; c++) miniTank(m, 0.12 + c * 0.08, -0.18 + r * 0.075, 0, 0.06, 0.7);
  // Maintenance sheds (open front), and from level 2 the repair workshop.
  m.block(0.3, 0.06, 0.08, 0.26, 0.003, -0.41, G.roof, { team: 0.3 });
  m.box(0.28, 0.045, 0.003, 0.26, 0.025, -0.37, 0x1e2022);
  if (L >= 2) building(m, 0.16, 0.1, 0.08, -0.27, -0.41, 0, 0x8a8f94, G.roof, 0.4, true);
  // HQ, parade ground with the flag, water tower, fuel.
  m.block(0.22, 0.003, 0.14, -0.26, 0, 0.3, G.asphalt);
  building(m, 0.2, 0.08, 0.07, -0.26, 0.42, 0, 0xd2cfc6, G.roof, 0.3);
  m.cyl(0.004, 0.004, 0.24, -0.26, 0, 0.26, 0x8e959c, 4);
  m.box(0.003, 0.05, 0.08, -0.26, 0.21, 0.3, 0xe6e8ea, { team: 1 });
  m.cyl(0.004, 0.005, 0.12, 0.15, 0, 0.38, 0x8e959c, 4);
  m.cyl(0.03, 0.03, 0.04, 0.15, 0.12, 0.38, 0xc8c6be, 10);
  for (let i = 0; i < 2; i++) storageTank(m, 0.025, 0.03, 0.3 + i * 0.07, 0.4, 0xdcdedb);
  // Helipads (one, two from level 3).
  for (let i = 0; i < (L >= 3 ? 2 : 1); i++) {
    const hx = 0.28 + i * 0.12, hz = 0.3;
    m.cyl(0.045, 0.045, 0.004, hx, 0, hz, G.asphalt, 16);
    m.plate(0.008, 0.04, hx - 0.014, 0.0045, hz, G.mark);
    m.plate(0.008, 0.04, hx + 0.014, 0.0045, hz, G.mark);
    m.plate(0.028, 0.008, hx, 0.0045, hz, G.mark);
  }
  trees(m, -0.44, 0.2, 5, 0.04, 3);
  trees(m, 0.44, 0.1, 4, 0.03, 4);
  return m.build();
}

// ---- Naval yard: 1 / 2 / 3 dry docks, each with a warship being built; L2 a finished warship at the fitting-out
// quay; the goliath crane spans the docks ---------------------------------------------------------------------------

function navalYard(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // The yard's quay runs along the sea front (-Z, the edge placed on the drawn shoreline): every dry dock opens
  // through its caisson gate straight onto the water, and its basin runs on past the quay edge into the sea.
  m.block(1.0, 0.06, 0.96, 0, -0.06, 0.02, G.concreteDark);
  m.block(1.0, 0.014, 0.024, 0, -0.012, -0.46, 0x55534d);
  const docks = L === 1 ? [0] : L === 2 ? [-0.18, 0.18] : [-0.32, 0, 0.32];
  const w = L === 3 ? 0.18 : 0.22;
  const ship = warship();
  for (const dx of docks) {
    // The basin (flooded, sea-coloured) from the head wall to beyond the quay edge, its walls, the head wall at the
    // land end and the caisson gate (swung open, against the wall) at the sea end.
    m.block(w, 0.004, 0.94, dx, -0.004, -0.1, 0x1e3b52);
    m.block(0.025, 0.035, 0.84, dx - w / 2 - 0.012, 0, -0.04, G.concrete);
    m.block(0.025, 0.035, 0.84, dx + w / 2 + 0.012, 0, -0.04, G.concrete);
    m.block(w + 0.05, 0.035, 0.025, dx, 0, 0.37, G.concrete);
    m.block(0.02, 0.03, w * 0.7, dx - w / 2 + 0.01, 0, -0.44 + w * 0.35, 0x5a5c5e);
    // A warship under construction, its bow toward the open gate, scaffolding towers along it.
    m.push().translate(dx, 0.0, -0.02).scale(0.44, 0.44, 0.44);
    m.merge(ship);
    m.pop();
    for (const side of [-1, 1]) for (let k = 0; k < 3; k++) m.block(0.01, 0.06, 0.02, dx + side * (w / 2 - 0.012), 0.004, -0.14 + k * 0.12, 0xd6ae38);
  }
  // Level 2+: a finished warship moored at the fitting-out pier, out on the water beside the docks.
  if (L >= 2) {
    m.block(0.04, 0.03, 0.4, 0.49, -0.02, -0.66, G.concrete);
    m.push().translate(0.57, -0.012, -0.66).scale(0.4, 0.4, 0.4);
    m.merge(ship);
    m.pop();
  }
  ship.dispose();
  // Goliath gantry crane spanning the docks (nation coloured).
  const span = docks[docks.length - 1] + w / 2 + 0.05;
  const S0 = docks.length === 1 ? 0.2 : span;
  for (const x of [-S0, S0]) {
    m.block(0.03, 0.3, 0.03, x, 0, 0.0, 0xc9ccce, { team: 0.95 });
    m.block(0.03, 0.3, 0.03, x, 0, 0.1, 0xc9ccce, { team: 0.95 });
    m.block(0.04, 0.02, 0.14, x, 0, 0.05, 0x3a3c3e);
  }
  m.block(2 * S0 + 0.06, 0.05, 0.12, 0, 0.3, 0.05, 0xc9ccce, { team: 0.95 });
  m.block(0.06, 0.04, 0.08, 0.05, 0.26, 0.05, 0xe6e8ea);
  m.sphere(0.01, -S0, 0.36, 0.05, 0xff3322, 4, 3, { heat: 0.7 });
  m.sphere(0.01, S0, 0.36, 0.05, 0xff3322, 4, 3, { heat: 0.7 });
  // Fabrication halls and steel stock yard.
  for (let i = 0; i < 2 + (L >= 3 ? 1 : 0); i++) {
    const x = -0.34 + i * 0.34;
    building(m, 0.26, 0.12, 0.1, x, 0.43, 0, 0x8e959c, G.roof, 0.55, true);
  }
  m.block(1.0, 0.003, 0.01, 0, 0.0, -0.45, 0xffffff, { glow: 1.0 });
  return m.build();
}

// ---- Radar station: the rotating search radar on its lattice tower, 1 / 2 / 3 radomes; L3 adds the phased-array
// pyramid ---------------------------------------------------------------------------------------------------------

function radar(L: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  plate(m, 1, 1, G.gravel);
  fence(m, 0.94, 0.94);
  strip(m, -0.18, 0.2, -0.18, 0.45, 0.03, 0.003, G.asphaltLight);
  // Lattice tower carrying the rotating dish (index.ts puts the dish at (0.1, 0.38, -0.05)).
  const tx = 0.1, tz = -0.05, H = 0.38;
  for (const [lx, lz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) m.beam(tx + lx * 0.07, 0, tz + lz * 0.07, tx + lx * 0.03, H - 0.02, tz + lz * 0.03, 0.008, 0x9aa1a8);
  for (let k = 1; k < 6; k++) {
    const y = (k / 6) * (H - 0.02), w = 0.07 - 0.04 * (k / 6);
    for (const [a, b, c, d] of [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]]) m.beam(tx + a * w, y, tz + b * w, tx + c * w, y, tz + d * w, 0.004, 0x9aa1a8);
  }
  m.block(0.09, 0.02, 0.09, tx, H - 0.02, tz, 0xd2d4d2, { team: 0.8 });
  // Radomes (white spheres on drum bases).
  const domes: [number, number, number][] = [[-0.24, -0.22, 0.1], [0.26, 0.24, 0.09], [-0.28, 0.08, 0.085]];
  for (let i = 0; i < L; i++) {
    const [x, z, r] = domes[i];
    m.cyl(r * 0.85, r * 0.9, r * 0.5, x, 0, z, 0xc8c8c2, 14);
    const g = new THREE.SphereGeometry(r, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.72);
    g.translate(x, r * 0.5 + r * 0.62, z);
    m.add(g, 0xf2f2ee);
  }
  // Operations and power buildings, antenna masts.
  building(m, 0.22, 0.12, 0.06, -0.18, 0.3, 0, G.wall, G.roof, 0.45);
  building(m, 0.1, 0.08, 0.045, 0.02, 0.36, 0, 0x8a8f94, G.roof, 0.2, true);
  for (let i = 0; i < 2; i++) {
    m.cyl(0.003, 0.005, 0.2, 0.3 + i * 0.06, 0, -0.35, 0x8e959c, 4);
    m.sphere(0.006, 0.3 + i * 0.06, 0.2, -0.35, 0xff2211, 4, 3, { heat: 0.8 });
  }
  if (L >= 2) {
    // Height-finder: a second, slimmer mast with a tall nodding antenna (orange-trimmed), west of the main tower.
    const hx = -0.06, hz = -0.3;
    // (Its top stays under the rotating dish, which sweeps above y = 0.38.)
    m.cyl(0.02, 0.028, 0.19, hx, 0, hz, 0xa4aaaf, 8);
    m.block(0.05, 0.03, 0.05, hx, 0.19, hz, 0xd2d4d2, { team: 0.8 });
    m.push().translate(hx, 0.22, hz + 0.01).rotateX(-0.25);
    m.box(0.022, 0.13, 0.07, 0, 0.065, 0, 0xe4e6e6, { team: 0.2 });
    m.pop();
  }
  if (L >= 3) {
    // Early-warning phased-array building: a truncated pyramid with its dark array face toward -Z.
    const px = 0.25, pz = -0.22;
    m.frustum(0.24, 0.2, 0.12, 0.1, 0.2, px, 0, pz, 0xb8b6ae);
    m.push().translate(px, 0.1, pz - 0.075).rotateX(-0.45);
    m.cyl(0.075, 0.075, 0.01, 0, 0, 0, 0x2a3036, 16);
    m.pop();
    m.block(0.13, 0.006, 0.105, px, 0.2, pz, G.roof, { team: 0.7 });
  }
  m.sphere(0.01, tx, H + 0.02, tz, 0xff2211, 4, 3, { heat: 0.7 });
  return m.build();
}

/** Foundation pad (DESIGN_V2 §10.7): a unit block from y = -1 to 0 over the footprint, scaled per structure. */
function pad(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(1.0, 1.0, 1.0, 0, -1.0, 0, 0x6e6152, { flat: true });
  return m.build();
}

/** Round foundation for round footprints (cities, defense posts, SAM sites). */
function padRound(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cyl(0.5, 0.5, 1.0, 0, -1.0, 0, 0x6e6152, 32);
  return m.build();
}

/** Rotating radar dish: a curved lattice reflector with its feed, pivot at the origin (sits on the tower). */
function radarDish(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Rotating air-search antenna: a curved reflector with its bracing and feed horn, pivot at the origin (the tower top).
  // The reflector's back sits on the pivot; its concave face and feed horn look along +X.
  const dish = new THREE.SphereGeometry(0.15, 14, 4, -0.95, 1.9, Math.PI / 2 - 0.3, 0.6);
  dish.translate(0.13, 0.07, 0);
  m.add(dish, 0xe4e6e6, { team: 0.25 });
  m.box(0.03, 0.06, 0.03, 0, 0.0, 0, 0x8e959c);
  m.beam(-0.015, 0.05, 0, -0.03, 0.07, 0.09, 0.005, 0x8e959c);
  m.beam(-0.015, 0.05, 0, -0.03, 0.07, -0.09, 0.005, 0x8e959c);
  m.beam(-0.015, 0.07, 0, 0.09, 0.07, 0, 0.005, 0x8e959c);
  m.sphere(0.012, 0.095, 0.07, 0, 0x3a4046, 6, 4);
  return m.build();
}

function beacon(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const g = new THREE.OctahedronGeometry(0.5, 0);
  g.scale(1, 1.4, 1);
  g.translate(0, 0.9, 0);
  m.add(g, C.white, { team: 1, flat: true });
  return m.build();
}

const UNIT_BUILDERS: Record<UnitModelKey, () => THREE.BufferGeometry> = {
  transport, trade, warship, tank, fighter, bomber, drone, cruise, icbm, warhead, sam, loco, wagon,
};

const LEVEL_BUILDERS: Record<LevelledKey, (L: number) => THREE.BufferGeometry> = {
  port, factory, defensePost, samSite, silo, airbase, armyBase, navalYard, radar,
};
const STRUCT_BUILDERS: Partial<Record<StructModelKey, () => THREE.BufferGeometry>> = { cityBase, radarDish, beacon, pad, padRound };

export function buildUnitModel(k: UnitModelKey): THREE.BufferGeometry {
  return UNIT_BUILDERS[k]();
}

export function buildStructModel(k: StructModelKey): THREE.BufferGeometry {
  const plain = STRUCT_BUILDERS[k];
  if (plain) return plain();
  const m = /^([a-zA-Z]+?)([23])?$/.exec(k)!;
  return LEVEL_BUILDERS[m[1] as LevelledKey](m[2] ? Number(m[2]) : 1);
}

/** The model key of a structure type key at a level. */
export function levelKey(base: StructModelKey, level: number): StructModelKey {
  if (!(LEVELLED as readonly string[]).includes(base)) return base;
  const L = Math.max(1, Math.min(3, Math.floor(level)));
  return (L === 1 ? base : `${base}${L}`) as StructModelKey;
}

/** One skyscraper: a unit box (-0.5..0.5 XZ, 0..1 Y) with a rooftop block; instance-scaled per building. */
export function buildBuilding(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(1, 1, 1, 0, 0, 0, 0xb7b9b8);
  const g = m.build();
  return g;
}

/** Rooftop details for tall towers (spire + crown), instance-scaled with the tower. */
export function buildSpire(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(0.7, 0.06, 0.7, 0, 0, 0, 0x8a8f94, { team: 0.8 });
  m.cyl(0.03, 0.06, 0.5, 0, 0.06, 0, 0xc0c4c8, 4);
  m.sphere(0.06, 0, 0.58, 0, 0xff3322, 4, 3, { heat: 0.8 });
  return m.build();
}
