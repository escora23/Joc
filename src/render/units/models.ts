// FRONT ULTRA — procedural low-poly models for every unit and structure (owner: units).
// Conventions:
//   * Units: forward = -Z, up = +Y, overall length normalized to 1 (bow at z = -0.5). The instance matrix scale is
//     the drawn length in world units. Waterline / ground at y = 0.
//   * Structures: footprint normalized to the [-0.5, 0.5]^2 XZ square, ground at y = 0, the "front" (quay side
//     for ports & naval yards) faces -Z. Instance scale = footprint size in world units.
// Paint masks (see geom.ts): team = nation color, glow = night lights, heat = engines / hot parts.

import * as THREE from 'three';
import { ModelBuilder } from './geom';

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

export const STRUCT_MODELS = [
  'cityBase', 'port', 'factory', 'defensePost', 'samSite', 'silo', 'airbase', 'armyBase', 'navalYard', 'radar',
  'radarDish', 'beacon',
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

function warship(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const beam = 0.13;
  // Hull: dark lower hull, gray topsides, nation-colored deck.
  m.hull(shipOutline(beam, 0.3, 0.04), -0.035, 0.0, 0.7, C.hullDark);
  m.hull(shipOutline(beam, 0.3, 0.04), 0.0, 0.045, 1.0, C.hull);
  m.hull(shipOutline(beam * 0.96, 0.3, 0.04).map(([x, z]) => [x, z] as [number, number]), 0.045, 0.05, 1.0, C.deck, { team: 0.75 });
  // Forward gun turret.
  m.cyl(0.028, 0.032, 0.022, 0, 0.05, -0.25, C.steel, 10);
  m.cylZ(0.005, 0.006, 0.09, 0, 0.062, -0.31, C.hullDark, 6);
  // VLS cells.
  m.block(0.07, 0.008, 0.06, 0, 0.05, -0.16, C.hullDark);
  // Stepped bridge superstructure.
  m.block(0.1, 0.05, 0.16, 0, 0.05, -0.04, C.offWhite);
  m.block(0.085, 0.035, 0.1, 0, 0.1, -0.06, C.offWhite);
  m.block(0.09, 0.012, 0.03, 0, 0.125, -0.1, C.glass, { glow: 0.5 });
  // Mast with radar arrays.
  m.cyl(0.006, 0.01, 0.12, 0, 0.135, -0.04, C.steel, 6);
  m.box(0.06, 0.012, 0.012, 0, 0.21, -0.04, C.black);
  m.sphere(0.012, 0, 0.26, -0.04, C.white, 8, 6, { heat: 0.12 });
  // Funnel.
  m.cyl(0.02, 0.026, 0.06, 0, 0.05, 0.09, C.hull, 8);
  m.cyl(0.021, 0.021, 0.012, 0, 0.11, 0.09, C.black, 8);
  // Aft gun + hangar + helipad.
  m.block(0.09, 0.04, 0.09, 0, 0.05, 0.2, C.offWhite);
  m.cyl(0.024, 0.028, 0.02, 0, 0.09, 0.2, C.steel, 10);
  m.cylZ(0.0045, 0.005, 0.07, 0, 0.1, 0.15, C.hullDark, 6);
  m.plate(0.11, 0.12, 0, 0.051, 0.39, C.hullDark, { team: 0.2 });
  // Navigation lights.
  m.sphere(0.006, 0.05, 0.1, -0.09, 0x33ff66, 4, 3, { heat: 0.4 });
  m.sphere(0.006, -0.05, 0.1, -0.09, 0xff3322, 4, 3, { heat: 0.4 });
  return m.build();
}

function transport(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const beam = 0.2;
  m.hull(shipOutline(beam, 0.2, 0.05), -0.04, 0.0, 0.72, C.red);
  m.hull(shipOutline(beam, 0.2, 0.05), 0.0, 0.06, 1.0, C.hull);
  // Well deck in nation color, landing craft inside.
  m.hull(shipOutline(beam * 0.88, 0.2, 0.05), 0.06, 0.064, 1.0, C.deck, { team: 0.85 });
  for (let i = 0; i < 3; i++) {
    m.block(0.07, 0.025, 0.1, i === 1 ? 0 : (i - 1) * 0.055, 0.064, -0.18 + i * 0.012, C.olive);
  }
  // Big stern superstructure block.
  m.block(0.17, 0.08, 0.16, 0, 0.064, 0.3, C.offWhite);
  m.block(0.14, 0.05, 0.09, 0, 0.144, 0.28, C.offWhite);
  m.block(0.15, 0.014, 0.02, 0, 0.17, 0.24, C.glass, { glow: 0.6 });
  m.cyl(0.006, 0.009, 0.1, 0, 0.194, 0.3, C.steel, 6);
  m.cyl(0.02, 0.024, 0.05, 0, 0.144, 0.38, C.hull, 8, { team: 0.6 });
  // Bow ramp.
  m.box(0.08, 0.008, 0.07, 0, 0.066, -0.36, C.hullDark);
  m.sphere(0.007, 0.08, 0.16, 0.22, 0x33ff66, 4, 3, { heat: 0.4 });
  m.sphere(0.007, -0.08, 0.16, 0.22, 0xff3322, 4, 3, { heat: 0.4 });
  return m.build();
}

function trade(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const beam = 0.16;
  m.hull(shipOutline(beam, 0.22, 0.05), -0.04, 0.0, 0.72, C.red);
  m.hull(shipOutline(beam, 0.22, 0.05), 0.0, 0.05, 1.0, C.black);
  m.hull(shipOutline(beam * 0.95, 0.22, 0.05), 0.05, 0.053, 1.0, C.deck);
  // Container stacks (colorful, not nation-tinted: they carry the world's goods).
  const cols = [0xb8452f, 0x2f6fb8, 0xd0a13a, 0x3d8f4f, 0x8f8f8f, 0xa0522d, 0x2a8a8a, 0xc0c0c0];
  let k = 0;
  for (let row = 0; row < 6; row++) {
    const z = -0.24 + row * 0.075;
    for (let col = -1; col <= 1; col++) {
      const hgt = 1 + ((row * 7 + col * 3 + 11) % 3);
      for (let h = 0; h < hgt; h++) {
        m.block(0.045, 0.022, 0.065, col * 0.048, 0.053 + h * 0.022, z, cols[k++ % cols.length]);
      }
    }
  }
  // Bridge at the stern, funnel with the nation band.
  m.block(0.15, 0.1, 0.07, 0, 0.053, 0.36, C.white);
  m.block(0.16, 0.014, 0.03, 0, 0.14, 0.33, C.glass, { glow: 0.6 });
  m.cyl(0.018, 0.022, 0.07, 0, 0.053, 0.44, C.black, 8);
  m.cyl(0.0185, 0.0185, 0.02, 0, 0.1, 0.44, C.white, 8, { team: 1 });
  return m.build();
}

// -------------------------------------------------------------------------------------------------
// Land vehicles & trains
// -------------------------------------------------------------------------------------------------

function tank(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Tracks.
  m.block(0.14, 0.12, 0.92, 0.2, 0, 0, C.track);
  m.block(0.14, 0.12, 0.92, -0.2, 0, 0, C.track);
  // Hull (sloped front via prism).
  m.block(0.4, 0.1, 0.8, 0, 0.08, 0.04, C.olive);
  m.push().translate(0, 0.18, -0.36).rotateY(Math.PI / 2).prism(0.4, 0.05, 0.16, 0, 0, 0, C.olive).pop();
  // Turret (nation colored) and barrel.
  m.block(0.34, 0.1, 0.36, 0, 0.18, 0.08, C.olive, { team: 0.8, flat: true });
  m.block(0.26, 0.06, 0.12, 0, 0.19, -0.16, C.olive, { team: 0.6 });
  m.cylZ(0.022, 0.028, 0.5, 0, 0.23, -0.38, C.oliveDark, 6);
  m.cyl(0.03, 0.03, 0.04, 0.08, 0.28, 0.12, C.oliveDark, 6);
  // Engine deck heat.
  m.block(0.2, 0.012, 0.12, 0, 0.18, 0.38, C.black, { heat: 0.08 });
  return m.build();
}

function loco(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(0.34, 0.06, 0.96, 0, 0.02, 0, C.black);
  // Streamlined high-speed nose.
  m.block(0.32, 0.26, 0.7, 0, 0.08, 0.12, C.white);
  m.push().translate(0, 0.08, -0.33).rotateY(Math.PI / 2).prism(0.32, 0.22, 0.26, 0, 0, 0, C.white).pop();
  m.block(0.33, 0.05, 0.9, 0, 0.18, 0.02, C.white, { team: 1 });
  m.block(0.3, 0.06, 0.12, 0, 0.22, -0.2, C.glass, { glow: 0.8 });
  m.sphere(0.03, 0.1, 0.12, -0.46, C.white, 4, 3, { heat: 0.5 });
  m.sphere(0.03, -0.1, 0.12, -0.46, C.white, 4, 3, { heat: 0.5 });
  return m.build();
}

function wagon(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(0.32, 0.05, 0.96, 0, 0.02, 0, C.black);
  m.block(0.3, 0.24, 0.9, 0, 0.07, 0, C.offWhite);
  m.block(0.31, 0.04, 0.9, 0, 0.18, 0, C.white, { team: 1 });
  m.block(0.305, 0.05, 0.8, 0, 0.12, 0, C.glass, { glow: 0.7 });
  return m.build();
}

// -------------------------------------------------------------------------------------------------
// Aircraft & missiles
// -------------------------------------------------------------------------------------------------

function fighter(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Fuselage.
  m.cylZ(0.012, 0.05, 0.62, 0, 0, -0.14, C.steel, 8);
  m.cylZ(0.05, 0.055, 0.34, 0, 0, 0.3, C.steel, 8);
  m.cylZ(0.0, 0.012, 0.08, 0, 0, -0.49, C.hullDark, 6);
  // Canopy.
  m.push().translate(0, 0.035, -0.2).scale(0.035, 0.03, 0.1).sphere(1, 0, 0, 0, C.glass, 8, 6, { glow: 0.3 }).pop();
  // Delta wings (nation colored upper surface), tailplanes, twin fins.
  m.wing([[0.03, -0.1], [0.36, 0.26], [0.34, 0.33], [0.04, 0.3]], -0.005, 0.014, C.steel, { team: 0.85 });
  m.wing([[-0.03, -0.1], [-0.04, 0.3], [-0.34, 0.33], [-0.36, 0.26]], -0.005, 0.014, C.steel, { team: 0.85 });
  m.wing([[0.04, 0.34], [0.16, 0.45], [0.15, 0.49], [0.04, 0.47]], 0.0, 0.01, C.steel, { team: 0.6 });
  m.wing([[-0.04, 0.34], [-0.04, 0.47], [-0.15, 0.49], [-0.16, 0.45]], 0.0, 0.01, C.steel, { team: 0.6 });
  m.push().translate(0.05, 0.02, 0).rotateZ(-0.35).fin([[0.26, 0], [0.44, 0.16], [0.49, 0.16], [0.46, 0]], 0, 0.01, C.steel, { team: 0.4 }).pop();
  m.push().translate(-0.05, 0.02, 0).rotateZ(0.35).fin([[0.26, 0], [0.44, 0.16], [0.49, 0.16], [0.46, 0]], 0, 0.01, C.steel, { team: 0.4 }).pop();
  // Afterburners.
  m.cylZ(0.024, 0.02, 0.03, 0.022, 0, 0.485, C.black, 6, { heat: 0.9 });
  m.cylZ(0.024, 0.02, 0.03, -0.022, 0, 0.485, C.black, 6, { heat: 0.9 });
  // Wingtip lights.
  m.sphere(0.01, 0.35, 0.0, 0.3, 0x33ff66, 4, 3, { heat: 0.5 });
  m.sphere(0.01, -0.35, 0.0, 0.3, 0xff3322, 4, 3, { heat: 0.5 });
  return m.build();
}

function bomber(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Flying wing: saw-tooth trailing edge (nation colored top), central body hump, 4 engine exhausts.
  const outline: [number, number][] = [
    [0, -0.5], [0.95, 0.16], [0.9, 0.24], [0.62, 0.1], [0.44, 0.26], [0.24, 0.1], [0, 0.26],
    [-0.24, 0.1], [-0.44, 0.26], [-0.62, 0.1], [-0.9, 0.24], [-0.95, 0.16],
  ];
  // Split the concave wing into convex pieces for the extrusion (shape triangulation handles concavity).
  m.wing(outline, -0.01, 0.03, C.hullDark, { team: 0.55 });
  m.push().translate(0, 0.02, -0.12).scale(0.16, 0.05, 0.38).sphere(1, 0, 0, 0, C.hullDark, 10, 6, { team: 0.3 }).pop();
  m.push().translate(0, 0.055, -0.28).scale(0.06, 0.02, 0.08).sphere(1, 0, 0, 0, C.glass, 8, 4, { glow: 0.4 }).pop();
  for (const x of [-0.3, -0.18, 0.18, 0.3]) {
    m.push().translate(x, 0.025, 0.02).scale(0.05, 0.03, 0.16).sphere(1, 0, 0, 0, C.hullDark, 8, 4).pop();
    m.box(0.05, 0.012, 0.02, x, 0.02, 0.17, C.black, { heat: 0.7 });
  }
  m.sphere(0.012, 0.93, 0.0, 0.2, 0x33ff66, 4, 3, { heat: 0.5 });
  m.sphere(0.012, -0.93, 0.0, 0.2, 0xff3322, 4, 3, { heat: 0.5 });
  const g = m.build();
  // Normalize: overall span is ~1.9, length ~0.76; keep length 1 = scale reference by scaling down a bit.
  g.scale(0.8, 0.8, 0.8);
  return g;
}

function drone(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cylZ(0.035, 0.03, 0.8, 0, 0, 0, C.offWhite, 6);
  m.push().translate(0, 0.02, -0.34).scale(0.04, 0.035, 0.08).sphere(1, 0, 0, 0, C.offWhite, 6, 4).pop();
  m.wing([[0.02, -0.08], [0.62, -0.03], [0.62, 0.02], [0.02, 0.04]], 0.01, 0.012, C.offWhite, { team: 0.8 });
  m.wing([[-0.02, -0.08], [-0.02, 0.04], [-0.62, 0.02], [-0.62, -0.03]], 0.01, 0.012, C.offWhite, { team: 0.8 });
  m.push().translate(0.04, 0.0, 0).rotateZ(-0.7).fin([[0.3, 0], [0.4, 0.14], [0.44, 0.14], [0.42, 0]], 0, 0.01, C.offWhite, { team: 0.5 }).pop();
  m.push().translate(-0.04, 0.0, 0).rotateZ(0.7).fin([[0.3, 0], [0.4, 0.14], [0.44, 0.14], [0.42, 0]], 0, 0.01, C.offWhite, { team: 0.5 }).pop();
  m.cylZ(0.02, 0.02, 0.04, 0, 0, 0.42, C.black, 6, { heat: 0.4 });
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

function port(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Land apron (z > -0.1) and piers stretching over the water (z < -0.1).
  m.block(1.0, 0.1, 0.6, 0, -0.08, 0.2, C.concrete);
  for (const x of [-0.32, 0.0, 0.32]) m.block(0.1, 0.06, 0.45, x, -0.042, -0.33, C.concreteDark);
  // Container yard.
  const cols = [0xb8452f, 0x2f6fb8, 0xd0a13a, 0x3d8f4f, 0x8f8f8f, 0xa0522d];
  let k = 0;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 6; c++) {
    const h = 1 + ((r * 5 + c * 3) % 3);
    m.block(0.07, 0.028 * h, 0.05, -0.36 + c * 0.1, 0.02, 0.3 + r * 0.07, cols[k++ % cols.length]);
  }
  // Warehouses with nation roofs.
  m.block(0.28, 0.07, 0.12, 0.3, 0.02, 0.05, C.offWhite);
  m.prism(0.28, 0.03, 0.12, 0.3, 0.09, 0.05, C.steel, { team: 0.8 });
  // Gantry cranes on the quay (nation colored).
  for (const x of [-0.18, 0.16]) {
    m.push().translate(x, 0.02, -0.08);
    m.block(0.018, 0.2, 0.018, -0.05, 0, -0.04, C.steel, { team: 0.9 });
    m.block(0.018, 0.2, 0.018, 0.05, 0, -0.04, C.steel, { team: 0.9 });
    m.block(0.018, 0.2, 0.018, -0.05, 0, 0.04, C.steel, { team: 0.9 });
    m.block(0.018, 0.2, 0.018, 0.05, 0, 0.04, C.steel, { team: 0.9 });
    m.block(0.13, 0.03, 0.1, 0, 0.2, 0, C.steel, { team: 0.9 });
    m.box(0.03, 0.02, 0.42, 0, 0.215, -0.1, C.steel, { team: 0.9 });
    m.block(0.04, 0.03, 0.04, 0, 0.23, 0.02, C.offWhite);
    m.sphere(0.008, 0, 0.26, -0.3, 0xff3322, 4, 3, { heat: 0.4 });
    m.pop();
  }
  // Moored cargo ship alongside the middle pier.
  m.push().translate(0.16, 0, -0.38).scale(0.1, 0.1, 0.1);
  m.block(0.8, 0.5, 3.2, 0, -0.3, 0, C.black);
  m.block(0.6, 0.35, 0.5, 0, 0.2, 1.2, C.white);
  m.pop();
  // Quay lights.
  m.block(1.0, 0.004, 0.02, 0, 0.02, -0.09, C.concrete, { glow: 1.0 });
  return m.build();
}

function factory(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(1.0, 0.1, 1.0, 0, -0.088, 0, C.concreteDark);
  // Main production hall with a saw-tooth roof.
  m.block(0.56, 0.12, 0.44, -0.12, 0.012, 0.1, C.brick);
  for (let i = 0; i < 5; i++) {
    m.push().translate(-0.12, 0.132, -0.08 + i * 0.09).prism(0.56, 0.05, 0.09, 0, 0, 0, C.steel, { team: 0.7 }).pop();
  }
  m.block(0.57, 0.02, 0.45, -0.12, 0.08, 0.1, C.glass, { glow: 0.9 });
  // Office block.
  m.block(0.24, 0.16, 0.16, 0.3, 0.012, 0.3, C.offWhite);
  m.block(0.245, 0.02, 0.165, 0.3, 0.12, 0.3, C.glass, { glow: 1 });
  // Storage tanks.
  m.cyl(0.07, 0.07, 0.1, 0.3, 0.012, -0.05, C.white, 12);
  m.cyl(0.07, 0.07, 0.1, 0.3, 0.012, -0.22, C.white, 12);
  m.dome(0.07, 0.3, 0.112, -0.05, C.white);
  m.dome(0.07, 0.3, 0.112, -0.22, C.white);
  // Smokestacks (red/white bands, aircraft warning lights).
  for (const [x, z] of [[-0.34, -0.3], [-0.2, -0.3], [-0.06, -0.3]]) {
    m.cyl(0.03, 0.04, 0.36, x, 0.012, z, C.offWhite, 10);
    m.cyl(0.031, 0.034, 0.04, x, 0.26, z, C.red, 10);
    m.cyl(0.031, 0.031, 0.03, x, 0.34, z, C.red, 10);
    m.sphere(0.012, x, 0.38, z, 0xff2211, 4, 3, { heat: 0.6 });
  }
  // Pipes.
  m.box(0.4, 0.015, 0.015, 0.02, 0.1, -0.16, C.steel);
  return m.build();
}

function defensePost(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Earthwork ring and hexagonal concrete bunker with gun slits.
  const berm = new THREE.TorusGeometry(0.38, 0.06, 4, 18);
  berm.rotateX(Math.PI / 2);
  berm.scale(1, 0.6, 1);
  m.add(berm, C.sand, { flat: true });
  m.cyl(0.24, 0.28, 0.12, 0, 0, 0, C.concrete, 6, { flat: true });
  m.cyl(0.2, 0.24, 0.05, 0, 0.12, 0, C.concreteDark, 6, { team: 0.7, flat: true });
  m.cyl(0.285, 0.285, 0.02, 0, 0.06, 0, C.black, 6);
  // Twin guns.
  m.cylZ(0.015, 0.018, 0.3, 0.05, 0.19, -0.2, C.hullDark, 6);
  m.cylZ(0.015, 0.018, 0.3, -0.05, 0.19, -0.2, C.hullDark, 6);
  m.block(0.16, 0.05, 0.14, 0, 0.17, -0.02, C.oliveDark);
  // Flag pole and nation flag.
  m.cyl(0.006, 0.006, 0.4, 0.2, 0.0, 0.2, C.steel, 4);
  m.box(0.004, 0.08, 0.13, 0.2, 0.35, 0.265, C.white, { team: 1 });
  // Sandbag nests.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    m.cyl(0.05, 0.06, 0.04, Math.cos(a) * 0.4, 0.02, Math.sin(a) * 0.4, C.sand, 7, { flat: true });
  }
  m.sphere(0.012, 0, 0.2, 0, 0xffcc66, 4, 3, { glow: 1 });
  return m.build();
}

function samSite(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.cyl(0.46, 0.5, 0.1, 0, -0.09, 0, C.sand, 20);
  // Four launcher trucks with raised canister packs in revetments.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    m.push().translate(Math.cos(a) * 0.3, 0.01, Math.sin(a) * 0.3).rotateY(-a + Math.PI / 2);
    m.block(0.2, 0.03, 0.03, 0, 0, 0.09, C.sand, { flat: true });
    m.block(0.1, 0.05, 0.2, 0, 0, 0, C.olive);
    m.block(0.09, 0.04, 0.05, 0, 0.05, -0.08, C.oliveDark);
    m.push().translate(0, 0.06, 0.03).rotateX(0.75);
    for (let c = 0; c < 4; c++) m.block(0.035, 0.035, 0.2, (c % 2 - 0.5) * 0.04, Math.floor(c / 2) * 0.037, 0, C.olive, { team: 0.8 });
    m.pop();
    m.pop();
  }
  // Central engagement radar (dome + panel).
  m.cyl(0.07, 0.08, 0.06, 0, 0.01, 0, C.offWhite, 10);
  m.dome(0.07, 0, 0.07, 0, C.white, 12, 5);
  m.push().translate(0, 0.16, 0.02).rotateX(-0.3).box(0.14, 0.12, 0.015, 0, 0, 0, C.hullDark, { team: 0.4 }).pop();
  m.sphere(0.01, 0, 0.23, 0, 0xff3322, 4, 3, { heat: 0.6 });
  return m.build();
}

function silo(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  // Hardened pad with three silo doors, one open with the missile nose showing.
  m.block(1.0, 0.1, 1.0, 0, -0.08, 0, C.concreteDark);
  m.block(0.9, 0.012, 0.9, 0, 0.02, 0, C.concrete);
  const pos: [number, number][] = [[-0.25, -0.2], [0.22, -0.2], [0, 0.22]];
  pos.forEach(([x, z], i) => {
    m.cyl(0.13, 0.15, 0.04, x, 0.02, z, C.concreteDark, 16);
    if (i === 0) {
      m.cyl(0.1, 0.1, 0.005, x, 0.06, z, C.black, 16);
      m.cyl(0.0, 0.06, 0.12, x, 0.02, z, C.white, 12);
      m.cyl(0.061, 0.061, 0.02, x, 0.02, z, C.white, 12, { team: 1 });
      // Open door leaning aside.
      m.push().translate(x + 0.18, 0.06, z).rotateZ(0.9).cyl(0.11, 0.11, 0.02, 0, 0, 0, C.concrete, 16).pop();
    } else {
      m.cyl(0.11, 0.12, 0.03, x, 0.06, z, C.steel, 16, { team: 0.55 });
      // Hazard stripes ring.
      m.cyl(0.125, 0.125, 0.006, x, 0.06, z, C.yellow, 16);
    }
  });
  // Control bunker and antenna.
  m.block(0.2, 0.08, 0.14, 0.3, 0.02, 0.3, C.concrete);
  m.block(0.21, 0.015, 0.145, 0.3, 0.07, 0.3, C.glass, { glow: 0.8 });
  m.cyl(0.005, 0.008, 0.3, 0.38, 0.1, 0.34, C.steel, 4);
  m.sphere(0.012, 0.38, 0.4, 0.34, 0xff2211, 4, 3, { heat: 0.8 });
  // Fence posts.
  for (let i = 0; i < 16; i++) {
    const t = i / 16, side = Math.floor(t * 4), f = (t * 4) % 1;
    const x = side === 0 ? -0.48 + f * 0.96 : side === 1 ? 0.48 : side === 2 ? 0.48 - f * 0.96 : -0.48;
    const z = side === 0 ? -0.48 : side === 1 ? -0.48 + f * 0.96 : side === 2 ? 0.48 : 0.48 - f * 0.96;
    m.block(0.012, 0.05, 0.012, x, 0.02, z, C.steel);
  }
  return m.build();
}

function airbase(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(1.0, 0.1, 0.5, 0, -0.094, 0.05, C.grass);
  m.block(1.0, 0.1, 0.16, 0, -0.09, -0.12, C.concreteDark);
  // Runway with markings and edge lights.
  m.block(1.0, 0.01, 0.12, 0, 0.004, -0.12, C.asphalt);
  for (let i = 0; i < 10; i++) m.plate(0.05, 0.008, -0.42 + i * 0.094, 0.0145, -0.12, C.white);
  m.plate(0.03, 0.09, -0.47, 0.0145, -0.12, C.white);
  m.plate(0.03, 0.09, 0.47, 0.0145, -0.12, C.white);
  m.plate(1.0, 0.006, 0, 0.0146, -0.178, C.white, { glow: 1.2 });
  m.plate(1.0, 0.006, 0, 0.0146, -0.062, C.white, { glow: 1.2 });
  // Taxiway & apron.
  m.block(0.8, 0.008, 0.04, 0, 0.004, 0.0, C.asphalt);
  m.block(0.5, 0.008, 0.16, 0.1, 0.004, 0.14, C.concreteDark);
  // Hangars (half-cylinders), nation-colored roofs.
  for (const x of [-0.08, 0.1, 0.28]) {
    const h = new THREE.CylinderGeometry(0.06, 0.06, 0.12, 10, 1, false, 0, Math.PI);
    h.rotateZ(Math.PI / 2);
    h.rotateY(Math.PI / 2);
    h.translate(x, 0.01, 0.26);
    m.add(h, C.steel, { team: 0.6 });
  }
  // Control tower.
  m.cyl(0.025, 0.03, 0.2, -0.36, 0.006, 0.2, C.offWhite, 8);
  m.cyl(0.05, 0.035, 0.04, -0.36, 0.2, 0.2, C.glass, 8, { glow: 1.2 });
  m.cyl(0.052, 0.052, 0.01, -0.36, 0.24, 0.2, C.offWhite, 8);
  m.sphere(0.01, -0.36, 0.26, 0.2, 0xff3322, 4, 3, { heat: 0.8 });
  // Parked jets on the apron.
  for (let i = 0; i < 4; i++) {
    const x = -0.05 + i * 0.1;
    m.push().translate(x, 0.014, 0.13).scale(0.08, 0.08, 0.08);
    m.box(0.12, 0.08, 1.0, 0, 0.05, 0, C.steel);
    m.wing([[0.05, -0.1], [0.45, 0.25], [0.45, 0.32], [0.05, 0.3]], 0.03, 0.03, C.steel, { team: 0.8 });
    m.wing([[-0.05, -0.1], [-0.05, 0.3], [-0.45, 0.32], [-0.45, 0.25]], 0.03, 0.03, C.steel, { team: 0.8 });
    m.pop();
  }
  // Fuel tanks.
  m.cyl(0.035, 0.035, 0.05, 0.42, 0.006, 0.24, C.white, 10);
  m.cyl(0.035, 0.035, 0.05, 0.42, 0.006, 0.14, C.white, 10);
  return m.build();
}

function armyBase(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(1.0, 0.1, 1.0, 0, -0.09, 0, C.sand);
  // Perimeter wall with corner towers.
  m.block(1.0, 0.05, 0.02, 0, 0.01, -0.49, C.concrete);
  m.block(1.0, 0.05, 0.02, 0, 0.01, 0.49, C.concrete);
  m.block(0.02, 0.05, 1.0, -0.49, 0.01, 0, C.concrete);
  m.block(0.02, 0.05, 1.0, 0.49, 0.01, 0, C.concrete);
  for (const [x, z] of [[-0.49, -0.49], [0.49, -0.49], [-0.49, 0.49], [0.49, 0.49]]) {
    m.block(0.06, 0.12, 0.06, x, 0.01, z, C.concreteDark);
    m.sphere(0.01, x, 0.14, z, 0xffcc66, 4, 3, { glow: 1.2 });
  }
  // Barracks rows.
  for (let r = 0; r < 3; r++) {
    m.block(0.32, 0.06, 0.08, -0.22, 0.01, -0.3 + r * 0.14, C.olive);
    m.prism(0.32, 0.03, 0.08, -0.22, 0.07, -0.3 + r * 0.14, C.oliveDark, { team: 0.7 });
    m.block(0.325, 0.012, 0.085, -0.22, 0.035, -0.3 + r * 0.14, C.glass, { glow: 0.9 });
  }
  // Vehicle park: rows of tanks.
  for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) {
    m.push().translate(0.12 + c * 0.1, 0.01, -0.3 + r * 0.16).scale(0.07, 0.07, 0.07);
    m.block(0.5, 0.2, 1.0, 0, 0, 0, C.olive);
    m.block(0.36, 0.14, 0.4, 0, 0.2, 0.05, C.olive, { team: 0.8 });
    m.cylZ(0.04, 0.05, 0.6, 0, 0.27, -0.4, C.oliveDark, 5);
    m.pop();
  }
  // Helipad.
  m.cyl(0.1, 0.1, 0.008, 0.25, 0.01, 0.28, C.asphalt, 16);
  m.plate(0.012, 0.08, 0.22, 0.019, 0.28, C.white);
  m.plate(0.012, 0.08, 0.28, 0.019, 0.28, C.white);
  m.plate(0.06, 0.012, 0.25, 0.019, 0.28, C.white);
  // HQ with flag.
  m.block(0.2, 0.1, 0.14, -0.22, 0.01, 0.3, C.concrete);
  m.block(0.205, 0.015, 0.145, -0.22, 0.07, 0.3, C.glass, { glow: 1 });
  m.cyl(0.005, 0.005, 0.3, -0.1, 0.01, 0.3, C.steel, 4);
  m.box(0.004, 0.07, 0.12, -0.1, 0.27, 0.36, C.white, { team: 1 });
  return m.build();
}

function navalYard(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(1.0, 0.11, 0.55, 0, -0.08, 0.22, C.concrete);
  // Dry dock basin opening onto the water (-Z) with a warship under construction.
  m.block(0.26, 0.004, 0.75, 0, 0.0, -0.12, C.water);
  m.block(0.04, 0.05, 0.75, -0.15, 0, -0.12, C.concreteDark);
  m.block(0.04, 0.05, 0.75, 0.15, 0, -0.12, C.concreteDark);
  m.push().translate(0, 0.005, -0.1).scale(0.62, 0.62, 0.62).rotateY(Math.PI);
  m.hull(shipOutline(0.25, 0.28, 0.04), 0, 0.06, 0.7, C.hull);
  m.block(0.14, 0.06, 0.2, 0, 0.06, -0.02, C.offWhite);
  m.block(0.02, 0.1, 0.02, 0, 0.12, -0.02, C.steel);
  m.pop();
  // Goliath gantry crane spanning the dock (nation colored).
  m.block(0.03, 0.34, 0.03, -0.2, 0, -0.05, C.steel, { team: 0.95 });
  m.block(0.03, 0.34, 0.03, 0.2, 0, -0.05, C.steel, { team: 0.95 });
  m.block(0.46, 0.05, 0.05, 0, 0.34, -0.05, C.steel, { team: 0.95 });
  m.block(0.06, 0.04, 0.06, 0.05, 0.3, -0.05, C.offWhite);
  m.sphere(0.01, -0.2, 0.4, -0.05, 0xff3322, 4, 3, { heat: 0.7 });
  m.sphere(0.01, 0.2, 0.4, -0.05, 0xff3322, 4, 3, { heat: 0.7 });
  // Workshops.
  m.block(0.22, 0.1, 0.18, -0.32, 0.03, 0.3, C.steel);
  m.prism(0.22, 0.04, 0.18, -0.32, 0.13, 0.3, C.hullDark, { team: 0.6 });
  m.block(0.22, 0.1, 0.18, 0.32, 0.03, 0.3, C.steel);
  m.prism(0.22, 0.04, 0.18, 0.32, 0.13, 0.3, C.hullDark, { team: 0.6 });
  m.block(0.225, 0.015, 0.185, 0.32, 0.08, 0.3, C.glass, { glow: 1 });
  m.block(0.225, 0.015, 0.185, -0.32, 0.08, 0.3, C.glass, { glow: 1 });
  return m.build();
}

function radar(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  m.block(0.8, 0.1, 0.8, 0, -0.088, 0, C.concreteDark);
  // Operations building, lattice tower and a radome.
  m.block(0.3, 0.1, 0.2, -0.18, 0.012, 0.2, C.offWhite);
  m.block(0.305, 0.015, 0.205, -0.18, 0.07, 0.2, C.glass, { glow: 1 });
  m.cyl(0.06, 0.1, 0.34, 0.1, 0.012, -0.05, C.steel, 4, { flat: true });
  m.cyl(0.07, 0.07, 0.03, 0.1, 0.35, -0.05, C.offWhite, 8, { team: 0.8 });
  m.cyl(0.1, 0.1, 0.06, -0.22, 0.012, -0.22, C.offWhite, 14);
  m.dome(0.1, -0.22, 0.07, -0.22, C.white, 14, 6);
  m.sphere(0.01, 0.1, 0.39, -0.05, 0xff2211, 4, 3, { heat: 0.7 });
  return m.build();
}

/** Rotating radar dish: a curved lattice reflector with its feed, pivot at the origin (sits on the tower). */
function radarDish(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const dish = new THREE.SphereGeometry(0.22, 14, 4, -0.9, 1.8, Math.PI / 2 - 0.35, 0.7);
  dish.scale(1, 1, 0.45);
  dish.translate(0, 0.1, 0.06);
  m.add(dish, C.white, { team: 0.3 });
  m.box(0.02, 0.1, 0.02, 0, 0.05, 0, C.steel);
  m.cylZ(0.006, 0.006, 0.14, 0, 0.1, -0.04, C.steel, 4);
  m.sphere(0.015, 0, 0.1, -0.1, C.hullDark, 6, 4);
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

const STRUCT_BUILDERS: Record<StructModelKey, () => THREE.BufferGeometry> = {
  cityBase, port, factory, defensePost, samSite, silo, airbase, armyBase, navalYard, radar, radarDish, beacon,
};

export function buildUnitModel(k: UnitModelKey): THREE.BufferGeometry {
  return UNIT_BUILDERS[k]();
}

export function buildStructModel(k: StructModelKey): THREE.BufferGeometry {
  return STRUCT_BUILDERS[k]();
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
