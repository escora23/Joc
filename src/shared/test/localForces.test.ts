// FRONT ULTRA — unit test of the shared local forces (src/shared/localForces.ts) on a fixture view.
// Run: npx tsx src/shared/test/localForces.test.ts   (exits 1 on the first failure)
//
// Fixture: player 2 (east of x = 800) is at war with player 1 (the viewer, west of it) and pushes west on a straight
// north-south front with an offensive; player 3 is at peace with 1 and owns a coast in the far west. Everything the
// derivation returns is checked against the §14.11 formulas computed by hand here.

import { MAP_H, MAP_W, STRUCTURE_LEVELS, TILE_KM, DEFENSE_REAR_SHARE } from '../constants';
import {
  deriveLocalForces, deriveLocalForcesAt, visibleSplit, FRONT_BAND_KM, TROOPS_PER_SOLDIER,
  type LocalForces, type LocalForcesAttack, type LocalForcesFront, type LocalForcesStructure, type LocalForcesUnit,
  type LocalForcesView,
} from '../localForces';
import { StructureType, TerrainClass, UnitMode, UnitState, UnitType, type PairState, type TreatyKind } from '../types';
import { tileXYToLatLon } from '../geo';

let failures = 0, checks = 0;
function ok(cond: boolean, msg: string): void {
  checks++;
  if (!cond) {
    failures++;
    console.error(`FAIL ${msg}`);
  }
}
function near(a: number, b: number, tol: number, msg: string): void {
  ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ± ${tol}`);
}

// --- fixture ---------------------------------------------------------------------------------------------
const owner = new Uint16Array(MAP_W * MAP_H);
const terrain = new Uint8Array(MAP_W * MAP_H).fill(TerrainClass.Plains);
for (let y = 150; y < 250; y++) {
  for (let x = 700; x < 800; x++) owner[y * MAP_W + x] = 1;
  for (let x = 800; x < 900; x++) owner[y * MAP_W + x] = 2;
  // Player 3's coast: land x 300..309, sea (ocean, navigable) x 310..320.
  for (let x = 300; x < 310; x++) owner[y * MAP_W + x] = 3;
  for (let x = 310; x < 321; x++) terrain[y * MAP_W + x] = TerrainClass.Ocean | 0x20;
}
const tileOf = (x: number, y: number) => y * MAP_W + x;

const samples: number[] = [];
for (let y = 150.5; y < 250; y += 1.5) samples.push(800.5, y);
const nS = samples.length / 2;
const front: LocalForcesFront = {
  key: 42, a: 2, b: 1, x: 800.5, y: 200, length: 100, dirX: -1, dirY: 0, samples: Float32Array.from(samples),
  progress: new Uint8Array(nS).fill(51), garrisonA: 200_000, garrisonB: 100_000, momentum: 0.3, advanceKmh: 2.5,
  intensity: 0.7, quiet: false, offensiveA: 9, offensiveB: 0,
};
const attack: LocalForcesAttack = {
  id: 9, attacker: 2, defender: 1, troops: 50_000, x: 799, y: 200, originX: 805, originY: 200, frontKey: 42,
  frontageTiles: 4, state: 'advancing', naval: false, advanceKmh: 2.5,
};
const unit = (u: Partial<LocalForcesUnit> & Pick<LocalForcesUnit, 'id' | 'type' | 'owner' | 'x' | 'y'>): LocalForcesUnit => ({
  prevX: u.x, prevY: u.y, heading: 0, hp: 1, state: UnitState.Moving, mode: UnitMode.Moving, frontKey: 0,
  targetX: u.x, targetY: u.y, alt: 0, home: 0, serial: 1, ...u,
});
const units = new Map<number, LocalForcesUnit>([
  [1, unit({ id: 1, type: UnitType.ArmoredDivision, owner: 2, x: 800.0, y: 200.1, hp: 0.6, heading: -Math.PI / 2, mode: UnitMode.Offensive, frontKey: 42 })],
  [2, unit({ id: 2, type: UnitType.ArmoredDivision, owner: 1, x: 799.3, y: 199.9, hp: 1, mode: UnitMode.Front, frontKey: 42 })],
  // A fighter 10 tiles away whose air patrol is centred on the anchor: listed because its CAP covers it.
  [3, unit({ id: 3, type: UnitType.FighterSquadron, owner: 1, x: 790, y: 200, targetX: 799.6, targetY: 200.2, mode: UnitMode.Patrol, hp: 0.5 })],
  // Far warship, a missile at the anchor and a docked squadron nearby: none of them is a local force in the air.
  [4, unit({ id: 4, type: UnitType.Warship, owner: 2, x: 850, y: 200 })],
  [5, unit({ id: 5, type: UnitType.CruiseMissile, owner: 2, x: 799.5, y: 200 })],
  [6, unit({ id: 6, type: UnitType.FighterSquadron, owner: 1, x: 799.4, y: 200.1, mode: UnitMode.Docked, state: UnitState.Docked })],
  // A destroyed division at the anchor is gone.
  [7, unit({ id: 7, type: UnitType.ArmoredDivision, owner: 2, x: 799.6, y: 200, state: UnitState.Destroyed })],
  // A division moving between updates: alpha interpolates it.
  [8, unit({ id: 8, type: UnitType.ArmoredDivision, owner: 1, x: 799.0, y: 200, prevX: 798.0, prevY: 200 })],
]);
const st = (s: Partial<LocalForcesStructure> & Pick<LocalForcesStructure, 'id' | 'type' | 'owner' | 'tile'>): LocalForcesStructure =>
  ({ level: 1, hp: 1, built: 1, ...s });
const structures = new Map<number, LocalForcesStructure>([
  [11, st({ id: 11, type: StructureType.SamSite, owner: 1, tile: tileOf(795, 200) })],
  [12, st({ id: 12, type: StructureType.DefensePost, owner: 2, tile: tileOf(800, 200) })],
  [13, st({ id: 13, type: StructureType.DefensePost, owner: 2, tile: tileOf(801, 200), built: 0.5 })],
  [14, st({ id: 14, type: StructureType.City, owner: 1, tile: tileOf(760, 200) })],
]);
const pair = (a: number, b: number): PairState => ((a === 1 && b === 2) || (a === 2 && b === 1) ? 'war' : 'peace');
const view: LocalForcesView = {
  tick: 1234,
  world: { terrain },
  owner,
  players: [undefined, { id: 1, troops: 1_000_000, tiles: 10_000, alive: true }, { id: 2, troops: 2_000_000, tiles: 10_000, alive: true },
    { id: 3, troops: 300_000, tiles: 1_000, alive: true }],
  units,
  structures,
  attacks: [attack],
  fronts: [front],
  pairState: pair,
  hasTreaty: (_a: number, _b: number, _k: TreatyKind) => false,
  isOccupied: (t: number) => t === tileOf(799, 200),
};

// --- 1. a front between two nations at war ----------------------------------------------------------------
const AX = 799.5, AY = 200.0, R = 12;
const f: LocalForces = deriveLocalForces(view, AX, AY, R, 1);
const lat = tileXYToLatLon(AX, AY).lat;
const kmX = TILE_KM * Math.cos((lat * Math.PI) / 180);

ok(f.point.owner === 1 && f.point.kind === 'land' && f.point.relation === 'own' && !f.point.incursion, 'anchor is own land');
ok(f.point.occupied, 'anchor tile reports occupation');
ok(f.frontKey === 42 && f.fronts.length === 1, 'the front is found');
const lf = f.fronts[0];
// progress 51/255 = 0.2 of the tile being taken: the line is 0.5 + 0.2 tiles west of the sample column (x = 799.8).
near(lf.nearest.x, 799.8, 1e-3, 'sub-tile line position');
near(lf.nearest.eastKm, 0.3 * kmX, 0.05, 'line offset from the anchor, km');
near(lf.advanceBearing, (3 * Math.PI) / 2, 1e-6, 'side a advances west');
ok(Math.abs(Math.cos(lf.lineBearing)) > 0.999, 'the line runs north-south');
ok(lf.anchorSide === 1, 'the anchor is on the defender side of the line');
ok(lf.subTile, 'sub-tile progress was used');
const window = 2 * Math.sqrt((R + FRONT_BAND_KM) ** 2 - (0.3 * kmX) ** 2);
near(lf.windowKm, window, 0.05, 'front window length');
const lengthKm = front.length * TILE_KM;
const sA = f.sides.find((s) => s.owner === 2)!, sB = f.sides.find((s) => s.owner === 1)!;
ok(!!sA && !!sB, 'both sides present');
ok(f.sides[0].owner === 1, 'the viewer side comes first');
near(sA.pools.front, (front.garrisonA * window / lengthKm) / TROOPS_PER_SOLDIER, 0.1, 'attacker front pool');
near(sB.pools.front, (front.garrisonB * window / lengthKm) / TROOPS_PER_SOLDIER, 0.1, 'defender front pool');
// The window lies entirely inside the 4-tile corridor (the axis runs east-west through y = 200).
near(sA.pools.offensive, (attack.troops * window / (attack.frontageTiles * TILE_KM)) / TROOPS_PER_SOLDIER, 0.1, 'offensive pool');
ok(sB.pools.offensive === 0, 'no defender offensive pool');
const area = Math.PI * R * R, tileArea = kmX * TILE_KM;
near(sB.pools.rear, DEFENSE_REAR_SHARE * 1_000_000 / 10_000 * (sB.landShare * area / tileArea) / TROOPS_PER_SOLDIER, 0.1, 'rear pool');
ok(sB.landShare > 0.6 && sA.landShare > 0 && Math.abs(sA.landShare + sB.landShare - 1) < 1e-9, 'land shares');
ok(sA.pools.posts === 6 && sA.atTeams === 1 && sA.posts.length === 2, 'one built post within 25 km adds 6 soldiers and 1 AT team');
near(sA.infantry, sA.pools.front + sA.pools.offensive + sA.pools.rear + sA.pools.posts, 0.2, 'infantry is the sum of the pools');
near(sA.troops, sA.infantry * 25, 1, 'troops = soldiers × 25');
ok(sA.relation === 'war' && sA.pairState === 'war' && sB.relation === 'own', 'relations');
ok(sA.source === 'lf.src.offensive' && sB.source === 'lf.src.front', 'dominant pool names the source');
// Divisions: 60 % → 3 tanks + 2 IFVs; 100 % → 4 tanks.
ok(sA.divisions.length === 1 && sA.divisions[0].tanks === 3 && sA.divisions[0].ifvs === 2, 'enemy division 1 tank per 25 %');
ok(sB.divisions.some((d) => d.unitId === 2 && d.tanks === 4), 'own division');
ok(!f.units.some((u) => u.unitId === 7), 'destroyed units are gone');
ok(!f.units.some((u) => u.unitId === 5 || u.unitId === 4), 'missiles and far ships are not local forces');
const cap = f.units.find((u) => u.unitId === 3);
ok(!!cap && cap.reason === 'cap' && cap.jets === 2 && sB.aircraft.some((a) => a.unitId === 3 && a.jets === 2), 'fighter CAP over the anchor, 1 jet per third');
const docked = f.units.find((u) => u.unitId === 6);
ok(!!docked && !docked.airborne && !sB.aircraft.some((a) => a.unitId === 6), 'a docked squadron is listed but not in the air');
const sam = f.structures.find((s) => s.structureId === 11)!;
near(sam.rangeKm, (STRUCTURE_LEVELS[StructureType.SamSite][1].rangeTiles ?? 0) * TILE_KM, 1e-6, 'SAM range');
ok(sam.coversAnchor && sB.sams.includes(11), 'the SAM covers the anchor');
ok(!f.structures.some((s) => s.structureId === 14), 'a city 40 tiles away is out of the view');
ok(f.pairs.length === 1 && f.pairs[0].state === 'war', 'pair state 1-2 at war');
ok(!f.peaceful, 'a front is not peaceful');
ok(f.units.every((u, i) => i === 0 || f.units[i - 1].distKm <= u.distKm), 'units sorted by distance');

// Interpolation: alpha 0.5 puts unit 8 halfway (798.5); alpha 1 at its latest x.
const half = deriveLocalForces(view, AX, AY, 30, 1, { alpha: 0.5 }).units.find((u) => u.unitId === 8);
near(half?.x ?? -1, 798.5, 1e-9, 'alpha interpolation');

// Determinism: the same view gives the same result.
ok(JSON.stringify(deriveLocalForces(view, AX, AY, R, 1)) === JSON.stringify(f), 'pure and deterministic');
// Lat/lon entry point agrees with the tile-coords one.
const g = tileXYToLatLon(AX, AY);
const f2 = deriveLocalForcesAt(view, g.lat, g.lon, R, 1);
near(f2.sides[0].infantry, f.sides[0].infantry, 0.2, 'deriveLocalForcesAt agrees');

// visibleSplit: proportional, clamped 0.2-0.8, never more than the pools.
const split = visibleSplit(f, 40);
ok(split.reduce((a, b) => a + b, 0) === 40, 'budget filled when pools are larger');
const share = split[f.sides.indexOf(sB)] / 40;
ok(share >= 0.2 - 1e-9 && share <= 0.8 + 1e-9, 'split clamped');
const mk = (inf: number[]): LocalForces => ({ ...f, sides: inf.map((v, i) => ({ ...f.sides[0], owner: i + 1, infantry: v })) });
ok(JSON.stringify(visibleSplit(mk([900, 100]), 40)) === '[32,8]', 'clamp at 0.8 / 0.2');
ok(JSON.stringify(visibleSplit(mk([0, 100]), 40)) === '[0,40]', 'a side without troops shows none');
ok(JSON.stringify(visibleSplit(mk([6, 4]), 40)) === '[6,4]', 'few troops show few soldiers');
ok(JSON.stringify(visibleSplit(mk([500, 500]), 41)) === '[21,20]', 'rounding adds up');

// --- 2. peace, deep in own land -----------------------------------------------------------------------------
const p = deriveLocalForces(view, 740.5, 200.5, 30, 1);
ok(p.peaceful && p.fronts.length === 0 && p.frontKey === 0, 'deep own land is peaceful');
ok(p.sides.length === 1 && p.sides[0].owner === 1 && p.sides[0].pools.front === 0 && p.sides[0].pools.rear > 0, 'only the own rear garrison');
ok(p.point.relation === 'own' && p.owners[0].owner === 1 && p.owners[0].share === 1, 'own land all around');

// --- 3. foreign coast at peace and open sea ---------------------------------------------------------------
const c = deriveLocalForces(view, 310.5, 200.5, 10, 1);
ok(c.point.water && c.point.kind === 'territorial' && c.point.coastOwner === 3, 'water next to a coast is territorial');
ok(c.point.relation === 'peace' && c.point.incursion, 'entering a peaceful neighbour\'s waters is an incursion');
ok(c.waterShare > 0.4, 'water share');
const land3 = deriveLocalForces(view, 305.5, 200.5, 10, 1);
ok(land3.point.kind === 'land' && land3.point.incursion && land3.sides[0].owner === 3 && land3.sides[0].relation === 'peace', 'foreign land at peace');
const sea = deriveLocalForces(view, 315.5, 200.5, 10, 1);
ok(sea.point.kind === 'sea' && !sea.point.incursion && sea.point.relation === 'unclaimed', 'open sea');
const enemy = deriveLocalForces(view, 850.5, 200.5, 20, 1);
ok(enemy.point.relation === 'war' && !enemy.point.incursion, 'enemy land at war is not an incursion');
ok(enemy.sides.some((s) => s.owner === 2 && s.ships.includes(4)), 'the warship is local there');

// --- 4. the viewer changes the relations, not the pools -----------------------------------------------------
const f3 = deriveLocalForces(view, AX, AY, R, 3);
ok(f3.sides.find((s) => s.owner === 2)?.relation === 'peace' && f3.point.relation === 'peace', 'seen by a third nation');
near(f3.sides.find((s) => s.owner === 2)!.infantry, sA.infantry, 1e-9, 'pools do not depend on the viewer');

console.log(`localForces: ${checks - failures}/${checks} checks passed`);
if (failures) (globalThis as unknown as { process: { exit(c: number): void } }).process.exit(1);
