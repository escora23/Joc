// FRONT ULTRA — command mode v2: TAKE CONTROL inside the real world (DESIGN_V2 §9; owner: W5-command-v2).
//
// Same unit, same place, same world, same consequences. Taking control puts you in one vehicle of the unit's
// formation at the unit's real position and heading, in a local scene streamed from the real heightfield around you
// (stream.ts) with the real towns, roads, rail, bases and borders (civil.ts). What you meet is what the simulation has
// there (forces.ts over shared/localForces.ts): at peace in your own land that is nobody. You may drive anywhere; the
// strategic unit moves with you (`controlledMove`, checked by the sim), what you destroy and what you lose goes back
// at once (`commandCasualties`, `controlledDamage`), and crossing a border is a real incursion the other nation answers
// (sim/command.ts). Time is tactical (1:1); without contact, + / − compress it for travel (×10 … ×900, the whole world
// with you), throttled so the terrain always keeps up, and it drops back to 1:1 on contact, when fired upon, near a
// border, on arrival and on important alerts. There are no missions, objectives, waves, operation names or scripted
// air strikes. Esc asks, shows a short report of what was already applied, and climbs back to the strategic map above
// the unit's new position.

import * as THREE from 'three';
import type { CommandApi, CommandEnterParams, CommandResult, FrameInfo, GameContext, SfxCue } from '../shared/api';
import { HUMAN_ID, MAP_H, MAP_W, TILE_KM, TRAVEL_RATES, UNIT_DEFS } from '../shared/constants';
import { battleCentre, subsolarPoint, sunDirection, tangentFrame, tileXYToLatLon } from '../shared/geo';
import { formatNumber, playerName, t } from '../shared/i18n';
import type { QualityProfile } from '../shared/quality';
import { Rng } from '../shared/rng';
import { easeInOutCubic } from '../shared/math';
import { deriveLocalForces, holderAt } from '../shared/localForces';
import { localSideText } from '../shared/localForcesText';
import { isWaterTerrain } from '../shared/terrain';
import type { CommandKind } from '../shared/types';
import { describePlace } from '../ui/places';
import { unitLabel } from '../ui/hud/news';
import { registerCommandStrings } from './strings';
import { makeDecalAtlas, makeNoiseTexture, makeParticleAtlas } from './env/textures';
import { computeAtmos, Sky, type Atmos } from './env/sky';
import { Water } from './env/water';
import { Scatter } from './env/scatter';
import { Grass } from './env/grass';
import { createMaterials, type CmdMaterials } from './models/materials';
import { Effects } from './fx/effects';
import { ENT_DEFS, forwardOf, World, type Ent } from './world';
import { Brain } from './ai';
import { CommandInput } from './input';
import { CommandHud } from './hud/hud';
import { CommandOverlay, type DebriefRow, type HoverInfo } from './hud/overlay';
import type { Controller, ControllerCtx } from './player/common';
import { TankController } from './player/tank';
import { JetController } from './player/jet';
import { ShipController } from './player/ship';
import { LocalFrame } from './frame';
import { Ground } from './stream';
import { Civil, type CivilLabel, type HouseRec, type StructRec } from './civil';
import { CIVILIAN_OPINION_ALLY, CIVILIAN_OPINION_VICTIM, CIVILIAN_OPINION_WORLD, CASUS_BELLI_TICKS, cityCivilianLoss, damageState } from '../shared/damage';
import type { Proj } from './world';
import { NightKit } from './night';
import { FLIGHT_CEILING_M, Forces } from './forces';
import { TacMap } from './tacmap';
import { fmtDur, wireIncursionAlerts } from './alerts';
import { alongRoute, atWar, combatTargets, planRoute, routeProgress, tileBearing, tileKm, type CombatTarget, type Route, type Targets } from './goto';

registerCommandStrings();

type Phase = 'idle' | 'intro' | 'play' | 'dying' | 'debrief' | 'transit';

/** Contact radius per vehicle (m): no time compression with a hostile inside it (§9.3). */
const CONTACT_M: Record<CommandKind, number> = { tank: 8000, jet: 40000, ship: 30000 };
/** Rebase the floating origin beyond this distance from the scene origin (m). */
const REBASE_M: Record<CommandKind, number> = { tank: 3000, jet: 24000, ship: 8000 };
/** Send the position at least every this many meters (§9.8). */
const MOVE_SEND_M: Record<CommandKind, number> = { tank: 200, jet: 2000, ship: 500 };
/** Moves also go out every half second of local game time (so ≥ 1 per second at ×1 whatever the frame rate). */
const MOVE_SEND_S = 0.5;
const STRUCT_KEY: Record<number, string> = { 0: 'city', 1: 'port', 2: 'factory', 3: 'defensePost', 4: 'samSite', 5: 'missileSilo', 6: 'airbase', 7: 'armyBase', 8: 'navalYard', 9: 'radar' };
/**
 * «Ir al combate» (owner feedback #3, item 26). The march stops this far short of the place (km): the enemy line is
 * then within the tank's gun range; an enemy unit, twice as far. Beyond HOP_KM more, the unit marches behind a fade on
 * the real clock (the whole world runs with it, like a strategic move); closer, the local autopilot drives.
 */
const STOP_KM: Record<CommandKind, number> = { tank: 1.2, jet: 12, ship: 8 };
const HOP_KM: Record<CommandKind, number> = { tank: 0.8, jet: 20, ship: 6 };
/** An enemy entity this close is contact: the chip says so and there is nothing to travel to. */
const REACH_M: Record<CommandKind, number> = { tank: 4000, jet: 15000, ship: 12000 };
/** Beyond this the chip offers «Ir al frente más cercano» (a far unit) instead of «Ir al combate». */
const FAR_KM: Record<CommandKind, number> = { tank: 25, jet: 150, ship: 60 };
/** A march takes about this many real seconds (the clock rate follows), between ×300 and ×3600. */
const TRANSIT_REAL_S = 6;
const TRANSIT_RATE_MIN = 300;
const TRANSIT_RATE_MAX = 3600;
/**
 * Feedback 3 (#27): what one hit of the controlled unit's weapons takes from a real structure (hp share, the sim's
 * scale: a tank's HE shell 5 %, AP 2 % (its 20 HE rounds take a level), a ship's gun 6 %, a jet's missile 12 %, a ship's missile 20 %, a bomb 30 %)
 * and from a city: each house knocked down 0.5 %, each city block collapsed (25 % of its houses down) 3 % more.
 */
const HIT_DMG = { he: 0.05, ap: 0.02, naval: 0.06, missile: 0.12, shipMissile: 0.2, bomb: 0.3 };
const HOUSE_DMG = 0.005;
const BLOCK_DMG = 0.03;
const BLOCK_DOWN_SHARE = 0.25;
/** Blast radius (m) that knocks down the houses around an impact. */
const BLAST_M = { he: 12, ap: 0, naval: 14, missile: 16, shipMissile: 24, bomb: 38 };
/** A border of a nation at peace closer than this drops travel to ×1 and warns (§9.7.1). */
const BORDER_WARN_M = 2000;

/** Internals exposed to shots and the verifier (window.__cmd in every session; not part of the shared contract). */
export interface CommandInternals {
  /** The sim's command clock at entry (game s; -1 = unknown). */
  readonly startCmdSec: number;
  /** The game context (tools: verifier and shots read the sim view through it). */
  readonly ctx: GameContext;
  readonly world: World;
  readonly fx: Effects;
  readonly hud: CommandHud;
  readonly overlay: CommandOverlay;
  readonly scatter: Scatter;
  readonly input: CommandInput;
  readonly ground: Ground;
  readonly civil: Civil;
  readonly forces: Forces;
  readonly frame: LocalFrame;
  controller: Controller | null;
  brain: Brain | null;
  readonly camera: THREE.PerspectiveCamera;
  /** Freeze local simulation time (renders keep going) and hold the sim's command clock: shots. */
  freeze: boolean;
  /** Shots: the next entry starts frozen. */
  freezeOnEnter: boolean;
  hold: boolean;
  readonly phase: string;
  skipIntro(): void;
  setPhaseTime(t: number): void;
  /** Advance the local scene by n fixed steps without input (staging). */
  simulate(steps: number, dt: number, beforeStep?: (i: number) => void): void;
  /** The same as clicking on the tactical map (lat/lon), or null to clear. */
  setWaypoint(lat: number, lon: number): void;
  clearWaypoint(): void;
  /** The same as pressing + / − until the requested travel rate (1, 10, 60, 300, 900). */
  requestRate(rate: number): boolean;
  /** Open the exit flow as if Esc was pressed and confirmed. */
  debrief(): void;
  atmos(): Atmos;
  /** Player position (lat, lon, heading deg) now. */
  where(): { lat: number; lon: number; heading: number; x: number; y: number };
  /** The entry parameters of this session (tools). */
  readonly params: CommandEnterParams | null;
  /** «Ir al combate» as if G was pressed (tools). */
  goCombat(): Promise<void>;
  /** The nearest action and the mission target as the HUD sees them (tools). */
  targets(): Targets & { chosen: CombatTarget | null };
  /** Moves sent and sim-view position changes per whole local second of driving (criterion 3). */
  cadence(): { sec: number; moves: number; views: number }[];
}

let internals: CommandInternals | null = null;
export function commandInternals(): CommandInternals | null {
  return internals;
}

interface Casualties {
  troops: number;
  unitHits: Map<number, number>;
  structureHits: Map<number, number>;
}

export function createCommandMode(ctx: GameContext): CommandApi {
  const scene = new THREE.Scene();
  scene.name = 'command';
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 30000);
  camera.position.set(0, 10, 20);
  const renderer = ctx.renderer;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4032, 1);
  const sun = new THREE.DirectionalLight(0xfff1dd, 3);
  sun.castShadow = ctx.quality.shadows > 0;
  sun.shadow.mapSize.set(Math.max(512, ctx.quality.shadows), Math.max(512, ctx.quality.shadows));
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);
  const fog = new THREE.FogExp2(0xa9c0d6, 0.0003);
  scene.fog = fog;

  let mats: CmdMaterials | null = null;
  let sky: Sky | null = null;
  let water: Water | null = null;
  let ground: Ground | null = null;
  let scatter: Scatter | null = null;
  let grass: Grass | null = null;
  let fx: Effects | null = null;
  let world: World | null = null;
  let hud: CommandHud | null = null;
  let overlay: CommandOverlay | null = null;
  let civil: Civil | null = null;
  let forces: Forces | null = null;
  let tacmap: TacMap | null = null;
  let warmMesh: THREE.Mesh | null = null;
  let pmrem: THREE.PMREMGenerator | null = null;
  let envRT: THREE.WebGLRenderTarget | null = null;
  const envScene = new THREE.Scene();
  const input = new CommandInput(ctx.canvas);
  const night = new NightKit(scene, ctx.canvas, () => mats);
  const frame = new LocalFrame();
  let atmos: Atmos = computeAtmos(new THREE.Vector3(0.4, 0.6, 0.3));

  // --- session state ---------------------------------------------------------------------------
  let active = false;
  let params: CommandEnterParams | null = null;
  let kind: CommandKind = 'tank';
  let phase: Phase = 'idle';
  let phaseT = 0;
  let controller: Controller | null = null;
  let brain: Brain | null = null;
  let freeze = false;
  /** Shots: enter already frozen (the sim's clock held from the first frame). */
  let freezeOnEnter = false;
  let exitRequested = false;
  let shakeAmt = 0;
  let lockBeepT = 0;
  let warnBeepT = 0;
  let fogBase = 0.0003;
  /** Formation: the vehicles of the unit (tanks / jets / the ship) and the division's IFVs. */
  let formation: Ent[] = [];
  let ifvs: Ent[] = [];
  /** Integrity of the controlled unit as last sent (0..1) and on entry. */
  let integrity = 1;
  let integrity0 = 1;
  let vehiclesLost = 0;
  let nextVehicleT = -1;
  // Clock and travel.
  let requested = 1;
  let effRate = 1;
  let throttled = false;
  let decision = false;
  let sentClock = { mode: '', rate: -1, throttled: false, at: 0 };
  let waypoint: THREE.Vector3 | null = null;
  let autopilot = false;
  let travelYawRate = 0;
  let travelGo = true;
  let lastDrop = '';
  /** Local game seconds (kept within ~2.5 s of the sim's command clock). */
  let localSec = 0;
  let startSec = 0;
  /** The sim's command clock at entry (game s): the debrief's game time counts on it. */
  let startCmdSec = -1;
  let startWall = 0;
  // Sync.
  let lastMoveWall = 0;
  /** Local game second of the last move sent: moves go out at least every MOVE_SEND_S of local time too. */
  let lastMoveLocal = -1e9;
  /**
   * Move cadence per local second of driving (criterion 3, measured in simulated time): moves sent and changes of the
   * controlled unit's position in the sim view, per whole local second while the vehicle moves (tools).
   */
  const cadence: { sec: number; moves: number; views: number }[] = [];
  let cadViewKey = '';
  function cadenceBucket(): { sec: number; moves: number; views: number } | null {
    const P = player();
    // At ×1 only (compressed travel covers many game seconds per frame by design).
    if (!P || Math.abs(P.speed) < 1 || phase !== 'play' || effRate !== 1) return null;
    const sec = Math.floor(localSec);
    let b = cadence[cadence.length - 1];
    if (!b || b.sec !== sec) {
      cadence.push((b = { sec, moves: 0, views: 0 }));
      if (cadence.length > 900) cadence.shift();
    }
    return b;
  }
  const lastMovePos = new THREE.Vector3();
  let lastCasWall = 0;
  const cas = new Map<number, Casualties>();
  const shipSent = new Map<Ent, number>();
  let lastForcesWall = 0;
  let lastInfoWall = 0;
  let lastMapWall = 0;
  let lastFiredSec = -1e9;
  // Borders and incursions.
  const confirmed = new Set<number>();
  const warned = new Map<number, number>();
  const freeNoticed = new Set<number>();
  const lastSafe = new THREE.Vector3();
  let landOwner = 0;
  let prevLandOwner = 0;
  let borderNear: { owner: number; distM: number; x: number; z: number } | null = null;
  // Stats for the report.
  let distanceM = 0;
  const prevPos = new THREE.Vector3();
  const killsBy = new Map<number, number>();
  let unitHitN = 0;
  let unitHitShare = 0;
  let structHitN = 0;
  // Feedback 3 (#27): damage to real structures and cities waiting for the next sync, and what the player allowed.
  const structPending = new Map<number, { dmg: number; blocks: number[] }>();
  const cityConfirmed = new Set<number>();
  const reportedBlocks = new Set<string>();
  let housesDown = 0;
  const structHitIds = new Set<number>();
  let rebaseN = 0;
  let travelCam = false;
  const travelCamPos = new THREE.Vector3();
  let travelCamInit = false;
  let hover: HoverInfo | null = null;
  let mouseX = -1, mouseY = -1;
  let localClock = '';
  // Getting to the action (#26).
  let targets: Targets = { nearest: null, mission: null };
  let targetsWall = 0;
  /** The action the player was sent to (entered from a badge, the Guerra panel, an alert…), until reached. */
  let entryGoal: CombatTarget | null = null;
  let goalLabel = '';
  let transitAbort = false;
  /** Tools: marches done (km, game s, real ms, stopped by). */
  const transits: { km: number; gameSec: number; realMs: number; rate: number; stop: string }[] = [];
  let lastUpdateWall = 0;

  /** Entered from a ground battle: the point the battle camera looked at and its two sides (null otherwise). */
  let battleFocus: { lat: number; lon: number; a: number; b: number } | null = null;
  /** Intro length (real s): the usual swoop, or from the battle view: hold on it, then glide down to the vehicle. */
  let introHold = 0;
  /** Say where the watched battle is once the intro has come down to the vehicle. */
  let battleNotice = false;
  /** Distance (km) and bearing (°) from the vehicle to the watched battle's centre (the one definition, #24). */
  function battleKm(Pn: Ent): { km: number; brg: number; x: number; z: number } | null {
    const bf = battleFocus;
    if (!bf) return null;
    const bp = frame.sceneOf(bf.lat, bf.lon, { x: 0, z: 0 });
    const dx = bp.x - Pn.pos.x, dz = bp.z - Pn.pos.z;
    return { km: Math.hypot(dx, dz) / 1000, brg: (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360, x: bp.x, z: bp.z };
  }
  const kmText = (km: number): string => formatNumber(km, km < 10 ? 1 : 0);
  function showBattleNotice(): void {
    const Pn = player();
    const bf = battleFocus;
    if (!Pn || !bf || !overlay || !world) return;
    const bk = battleKm(Pn)!;
    const { km, brg } = bk;
    const n = formatNumber(world.soldiersNear(bk.x, bk.z, 6000));
    // Far from it: a waypoint on its near edge at once (the HUD counts down the distance, M shows it; + drives there
    // in column when no enemy is within reach).
    if (km >= 1.5 && ground) {
      const f = Math.max(0, (km - 0.6) / km);
      const wx = Pn.pos.x + (bk.x - Pn.pos.x) * f, wz = Pn.pos.z + (bk.z - Pn.pos.z) * f;
      waypoint = new THREE.Vector3(wx, ground.surfaceAt(wx, wz) + 20, wz);
    }
    overlay.showNotice(km < 1.5 ? t('command.battle.here', { n })
      : t('command.battle.there', { km: kmText(km), dir: t(`command.dir.${Math.round(brg / 45) % 8}`), n }), 9, true);
  }
  let introDur = 3.1;
  const introFrom = new THREE.Vector3();
  const introTo = new THREE.Vector3();
  const introQFrom = new THREE.Quaternion();
  const introQTo = new THREE.Quaternion();
  const outroPos = new THREE.Vector3();
  const outroLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const lightTint = new THREE.Color();
  const lightTint2 = new THREE.Color();
  const cctx: ControllerCtx = {
    world: null as unknown as World, ground: null as unknown as Ground, fx: null as unknown as Effects, camera, input,
    sens: () => ctx.settings.get().mouseSensitivity ?? 1,
    invertY: () => !!ctx.settings.get().invertY,
    obstacles: [], shake: (a) => (shakeAmt = Math.min(1.5, shakeAmt + a)), speedCap: Infinity, viewW: 1600, viewH: 900,
  };

  window.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  // -----------------------------------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------------------------------
  function applyAtmosphere(a: Atmos, fogDensity: number): void {
    hemi.color.copy(a.skyAmbient);
    hemi.groundColor.copy(a.groundAmbient);
    hemi.intensity = a.ambientIntensity;
    sun.color.copy(a.lightColor);
    sun.intensity = a.lightIntensity;
    fog.color.copy(a.fog);
    fog.density = fogDensity;
    sky?.apply(a, 0.42);
    water?.apply(a, fogDensity);
    lightTint.copy(a.skyAmbient).multiplyScalar(a.ambientIntensity * 0.8);
    lightTint2.copy(a.lightColor).multiplyScalar(a.lightIntensity * 0.4 * Math.max(0.25, a.lightDir.y));
    lightTint.add(lightTint2);
    fx?.setAtmosphere(a.fog, fogDensity, lightTint);
    if (mats) mats.glass.envMapIntensity = 1.2 * (1 - a.night * 0.7);
  }

  function rebuildEnvironment(): void {
    if (!pmrem || !sky) return;
    envScene.clear();
    const m = new THREE.Mesh(sky.mesh.geometry, sky.material);
    m.scale.setScalar(50);
    m.frustumCulled = false;
    envScene.add(m);
    const prev = envRT;
    envRT = pmrem.fromScene(envScene, 0.04, 0.1, 200);
    scene.environment = envRT.texture;
    scene.environmentIntensity = 0.55 * (1 - atmos.night * 0.8);
    prev?.dispose();
  }

  function localSun(lat: number, lon: number, worldTime: number, out: THREE.Vector3): THREE.Vector3 {
    const s = sunDirection(worldTime, new THREE.Vector3());
    const e = new THREE.Vector3(), n = new THREE.Vector3(), u = new THREE.Vector3();
    tangentFrame(lat, lon, e, n, u);
    return out.set(s.dot(e), s.dot(u), -s.dot(n)).normalize();
  }

  function clockString(lon: number, worldTime: number): string {
    const ss = subsolarPoint(worldTime);
    let h = 12 + (lon - ss.lon) / 15;
    h = ((h % 24) + 24) % 24;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function sfx(cue: SfxCue, gain: number): void {
    if (ctx.app.isShot) return;
    try {
      ctx.audio.play(cue, gain);
    } catch {
      /* audio not ready */
    }
  }

  function nationName(id: number): string {
    const p = ctx.sim.view.players[id];
    return p ? playerName(p, ctx.world) : '—';
  }

  function colorCss(id: number): string {
    const p = ctx.sim.view.players[id];
    return `#${(p?.color ?? 0x888888).toString(16).padStart(6, '0')}`;
  }

  const player = (): Ent | null => world?.player ?? null;

  /** Continuous tile coords of a scene point. */
  function tileOf(x: number, z: number): { x: number; y: number } {
    return frame.tileOfScene(x, z, { x: 0, y: 0 });
  }

  function tileIndex(tx: number, ty: number): number {
    const y = Math.max(0, Math.min(MAP_H - 1, Math.floor(ty)));
    return y * MAP_W + ((Math.floor(tx) % MAP_W) + MAP_W) % MAP_W;
  }

  /** The owner of a water tile's coast (territorial waters): 0 = open sea. */
  function coastOwner(tile: number): number {
    const view = ctx.sim.view;
    const x = tile % MAP_W, y = (tile / MAP_W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= MAP_H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const o = view.owner[yy * MAP_W + (((x + dx) % MAP_W) + MAP_W) % MAP_W];
        if (o > 0) return o;
      }
    }
    return 0;
  }

  /** Whose ground (land, territorial water for ships, airspace = land below for jets) a tile is. */
  function ownerOfTile(tile: number): number {
    const view = ctx.sim.view;
    const w = ctx.world;
    const water = w ? isWaterTerrain(w.terrain[tile]) : false;
    if (water && kind !== 'jet') return coastOwner(tile);
    if (water && kind === 'jet') return 0;
    return view.owner[tile] ?? 0;
  }

  /** Crossing into this owner is an incursion (§9.7): foreign, not at war, no alliance or open borders. */
  /**
   * Who holds the ground under a scene point: at sea the coast's owner (territorial waters), on land holderAt — near our
   * own fronts the side of the drawn line the point is on (the same line the ground battle draws), else the tile's
   * owner (W6 final: one source of truth for the line, the ground and this HUD).
   */
  function holderOfScene(x: number, z: number): number {
    const tp = tileOf(x, z);
    const tile = tileIndex(tp.x, tp.y);
    const w = ctx.world;
    if (w && isWaterTerrain(w.terrain[tile])) return ownerOfTile(tile);
    return holderAt(ctx.sim.view, tp.x, tp.y, HUMAN_ID);
  }

  function incursionOwner(o: number): boolean {
    if (o <= 0 || o === HUMAN_ID) return false;
    const view = ctx.sim.view;
    const st = view.pairState(HUMAN_ID, o);
    if (st === 'war') return false;
    if (view.hasTreaty(HUMAN_ID, o, 'alliance') || view.hasTreaty(HUMAN_ID, o, 'openBorders') || view.human?.allies.includes(o)) return false;
    return true;
  }

  function stateWord(o: number): string {
    const view = ctx.sim.view;
    if (view.hasTreaty(HUMAN_ID, o, 'alliance') || view.human?.allies.includes(o)) return t('command.state.allied');
    if (view.hasTreaty(HUMAN_ID, o, 'openBorders')) return t('command.state.open');
    const st = view.pairState(HUMAN_ID, o);
    return t(`command.state.${st}`);
  }

  /** Nearest tile of a nation whose land is an incursion, within ~1 tile of the vehicle, with its distance (m). */
  function nearestBorder(p: THREE.Vector3): { owner: number; distM: number; x: number; z: number } | null {
    const tp = tileOf(p.x, p.z);
    const cx = Math.floor(tp.x), cy = Math.floor(tp.y);
    let best: { owner: number; distM: number; x: number; z: number } | null = null;
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 };
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tx = cx + dx, ty = cy + dy;
        if (ty < 0 || ty >= MAP_H) continue;
        const o = ownerOfTile(tileIndex(tx, ty));
        if (!incursionOwner(o)) continue;
        frame.sceneOfTile(tx, ty, a);
        frame.sceneOfTile(tx + 1, ty + 1, b);
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
        const ddx = Math.max(x0 - p.x, 0, p.x - x1), ddz = Math.max(z0 - p.z, 0, p.z - z1);
        const d = Math.hypot(ddx, ddz);
        if (!best || d < best.distM) best = { owner: o, distM: d, x: Math.max(x0, Math.min(x1, p.x)), z: Math.max(z0, Math.min(z1, p.z)) };
      }
    }
    return best;
  }

  function unitView() {
    return params ? ctx.sim.view.units.get(params.unitId) ?? null : null;
  }

  // -----------------------------------------------------------------------------------------------
  // Clock (§9.3)
  // -----------------------------------------------------------------------------------------------
  function focusTile(): { x: number; y: number } | undefined {
    const P = player();
    return P ? tileOf(P.pos.x, P.pos.z) : undefined;
  }

  function sendClock(now: number, force = false): void {
    // A decision dialog (and a frozen shot) holds the world still.
    const hold = decision || freeze;
    const mode = hold ? 'tactical' : effRate > 1 ? 'travel' : 'tactical';
    const rate = hold ? 0 : effRate;
    const changed = mode !== sentClock.mode || Math.abs(rate - sentClock.rate) > Math.max(0.5, sentClock.rate * 0.08) || throttled !== sentClock.throttled;
    if (!force && !changed && now - sentClock.at < 1000) return;
    ctx.sim.setClock(mode, rate, focusTile(), mode === 'travel' && throttled);
    sentClock = { mode, rate, throttled, at: now };
  }

  /** The sim's command clock now (game s), extrapolated from the last update. */
  function simSecNow(): number {
    const cv = ctx.sim.view.command;
    if (!cv) return localSec;
    const r = sentClock.rate > 0 ? sentClock.rate : 0;
    return cv.sec + Math.min(3, (performance.now() - ctx.sim.view.commandAt) / 1000) * r;
  }

  function inOwnOrFriendlyLand(): boolean {
    const o = landOwner;
    if (o === HUMAN_ID || o === 0) return true;
    const view = ctx.sim.view;
    return view.hasTreaty(HUMAN_ID, o, 'alliance') || view.hasTreaty(HUMAN_ID, o, 'openBorders') || !!view.human?.allies.includes(o);
  }

  function contactNow(): boolean {
    const P = player();
    if (!P || !forces) return false;
    const h = forces.nearestHostile(P.pos);
    if (h.dist < CONTACT_M[kind]) return true;
    return forces.simHostileWithin(ctx.sim.view, CONTACT_M[kind] / 1000);
  }

  function dropToTactical(reasonKey: string): void {
    if (requested <= 1 && effRate <= 1) return;
    requested = 1;
    effRate = 1;
    throttled = false;
    lastDrop = reasonKey;
    overlay?.showNotice(t(reasonKey), 3.5);
    sendClock(performance.now(), true);
  }

  /** + / −: step through ×1, ×10, ×60, ×300, ×900 with the rules of §9.3. */
  function stepRate(dir: 1 | -1): boolean {
    const steps = [1, ...TRAVEL_RATES];
    const i = Math.max(0, steps.indexOf(requested));
    const next = steps[Math.max(0, Math.min(steps.length - 1, i + dir))];
    return setRequested(next);
  }

  function setRequested(r: number): boolean {
    if (r <= 1) {
      requested = 1;
      effRate = 1;
      throttled = false;
      sendClock(performance.now(), true);
      return true;
    }
    if (contactNow() || ctx.sim.view.command === null) {
      overlay?.showNotice(t('command.travel.noContact'), 3);
      return false;
    }
    const inc = myIncursion();
    if (inc && !inc.left && inc.response !== 'war') {
      // The victim's warnings run in real seconds (owner feedback #19): no compression while they run.
      overlay?.showNotice(t('command.travel.incursion'), 3);
      return false;
    }
    if (performance.now() / 1000 - 0 < 0 || localSec - lastFiredSec < 30) {
      overlay?.showNotice(t('command.travel.noContact'), 3);
      return false;
    }
    if (r > 60 && !inOwnOrFriendlyLand()) {
      overlay?.showNotice(t('command.travel.foreignMax'), 3.5);
      r = 60;
    }
    if (r > 60 && !waypoint) {
      overlay?.showNotice(t('command.travel.needWaypoint'), 4);
      r = 60;
    }
    // A waypoint already set: compressing time starts the autopilot toward it.
    if (r > 60 || (waypoint && requested <= 1)) autopilot = true;
    const was = requested;
    requested = r;
    if (was <= 1) {
      effRate = Math.min(r, 10);
      const kmh = UNIT_DEFS[params!.unitType].speedKmh;
      overlay?.showNotice(t('command.travel.column', { kmh }), 3.2, true);
    }
    sendClock(performance.now(), true);
    return requested === r;
  }

  /** Terrain throttle (§9.4): never travel further in the next real second than the built terrain ahead reaches. */
  function updateThrottle(): void {
    const P = player();
    if (!P || !ground || requested <= 1) {
      throttled = false;
      return;
    }
    const cap = UNIT_DEFS[params!.unitType].speedKmh / 3.6;
    const fw = forwardOf(P.yaw, tmp);
    const ahead = ground.readyAheadM(P.pos.x, P.pos.z, fw.x, fw.z);
    const missing = ground.missingAround(P.pos.x, P.pos.z);
    const maxRate = Math.max(1, Math.floor(ahead / Math.max(1, cap * 1.0)));
    let e = effRate;
    if (missing > 0) e = Math.max(1, e / 2);
    else e = Math.min(requested, e * 2);
    e = Math.max(1, Math.min(e, maxRate, requested));
    throttled = e < requested;
    effRate = e;
  }

  // -----------------------------------------------------------------------------------------------
  // Sync (§9.8)
  // -----------------------------------------------------------------------------------------------
  function sendMove(now: number, force = false): void {
    const P = player();
    if (!P || !params || !P.alive) return;
    const moved = P.pos.distanceTo(lastMovePos);
    if (!force && now - lastMoveWall < 1000 && localSec - lastMoveLocal < MOVE_SEND_S && moved < MOVE_SEND_M[kind]) return;
    const tp = tileOf(P.pos.x, P.pos.z);
    // Never report a position across a peaceful border before the player confirmed the crossing (the frame's border
    // check puts the vehicle back on the line; a move sent in between would start an incursion in the sim).
    const o = ownerOfTile(tileIndex(tp.x, tp.y));
    if (incursionOwner(o) && !confirmed.has(o)) return;
    const heading = LocalFrame.headingOfYaw(P.yaw);
    const alt = kind === 'jet' ? Math.max(0, Math.min(1, P.pos.y / FLIGHT_CEILING_M)) : undefined;
    ctx.sim.send({ type: 'controlledMove', unitId: params.unitId, x: tp.x, y: tp.y, heading, ...(alt !== undefined ? { alt } : {}) });
    lastMoveWall = now;
    lastMoveLocal = localSec;
    const cb = cadenceBucket();
    if (cb) cb.moves++;
    lastMovePos.copy(P.pos);
  }

  function addCas(victim: number): Casualties {
    let c = cas.get(victim);
    if (!c) cas.set(victim, (c = { troops: 0, unitHits: new Map(), structureHits: new Map() }));
    return c;
  }

  function flushCasualties(now: number, force = false): void {
    if (!params || (!force && now - lastCasWall < 2000)) return;
    lastCasWall = now;
    for (const [victim, c] of cas) {
      if (c.troops <= 0 && c.unitHits.size === 0 && c.structureHits.size === 0) continue;
      ctx.sim.send({
        type: 'commandCasualties', unitId: params.unitId, victim, troops: Math.round(c.troops),
        unitHits: [...c.unitHits].map(([unitId, dmg]) => ({ unitId, dmg })),
        structureHits: [...c.structureHits].map(([structureId, dmg]) => ({ structureId, dmg })),
      });
    }
    cas.clear();
    // Structures and city blocks hit (#27): through the sim's one damage rule (level loss, rubble, losses, diplomacy).
    for (const [structureId, sp] of structPending) {
      let left = sp.dmg;
      for (const block of sp.blocks) {
        const d = Math.min(0.6, Math.max(BLOCK_DMG, left));
        ctx.sim.send({ type: 'commandStructureHit', unitId: params.unitId, structureId, dmg: d, block });
        left -= d;
      }
      while (left > 1e-4) {
        const d = Math.min(0.6, left);
        ctx.sim.send({ type: 'commandStructureHit', unitId: params.unitId, structureId, dmg: d });
        left -= d;
      }
    }
    structPending.clear();
  }

  // -----------------------------------------------------------------------------------------------
  // Structures and cities hit in command mode (owner feedback #3, item 27)
  // -----------------------------------------------------------------------------------------------
  const hitAt = new THREE.Vector3();
  let sceneryLog = 0;
  function weaponOf(p: Proj): keyof typeof HIT_DMG {
    if (p.kind === 'bomb') return 'bomb';
    if (p.kind === 'missile') return kind === 'ship' ? 'shipMissile' : 'missile';
    if (kind === 'ship') return 'naval';
    return p.ap ? 'ap' : 'he';
  }

  /** The world asks: did this shell / bomb / missile hit a building? The player's own hits damage the real thing. */
  function sceneryHit(p: Proj, a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3 | null {
    if (!civil) return null;
    const r = civil.hitTest(a, b, hitAt);
    if (!r) return null;
    if (p.player || p.owner?.formation) {
      if (sceneryLog++ < 40) console.info(`[command] ${p.kind} hit ${r.struct ? `structure ${r.struct.id}` : `house of city ${r.house?.cityId ?? 0} (owner ${r.house?.owner ?? 0})`} at ${hitAt.x.toFixed(0)},${hitAt.y.toFixed(0)},${hitAt.z.toFixed(0)}`);
      if (r.struct) hitStructure(r.struct, weaponOf(p));
      else if (r.house) hitHouse(r.house, weaponOf(p), hitAt);
    }
    return hitAt;
  }

  /** A round that landed next to a building still brings it down when the blast reaches it. */
  function groundBlast(p: Proj, at: THREE.Vector3): void {
    if (!civil || !(p.player || p.owner?.formation)) return;
    const w = weaponOf(p);
    const r = BLAST_M[w];
    if (r <= 0) return;
    const st = civil.structRecs.find((s) => Math.abs(at.x - s.x) < s.half + r * 0.5 && Math.abs(at.z - s.z) < s.half + r * 0.5);
    if (st) {
      hitStructure(st, w);
      return;
    }
    const near = civil.housesNear(at.x, at.z, r * 0.6);
    if (near.length) hitHouse(near[0], w, at);
  }

  function friendlyOwner(o: number): boolean {
    const view = ctx.sim.view;
    return o === HUMAN_ID || o <= 0 || view.hasTreaty(HUMAN_ID, o, 'alliance') || !!view.human?.allies.includes(o);
  }

  function pend(structureId: number, dmg: number, block = -1): void {
    let sp = structPending.get(structureId);
    if (!sp) structPending.set(structureId, (sp = { dmg: 0, blocks: [] }));
    sp.dmg += dmg;
    if (block >= 0) sp.blocks.push(block);
  }

  let lastHitNotice = '';
  function hitStructure(r: StructRec, w: keyof typeof HIT_DMG): void {
    if (friendlyOwner(r.owner)) return;
    if (ctx.sim.view.pairState(HUMAN_ID, r.owner) !== 'war') {
      // At peace: nothing is damaged before the player chooses war.
      void askFireFirst(r.owner);
      return;
    }
    pend(r.id, HIT_DMG[w]);
    structHitN++;
    structHitIds.add(r.id);
    hud?.hitMarker(false);
    const s = ctx.sim.view.structures.get(r.id);
    // The hit notice follows every hit (a newer one replaces it; any other notice is left alone).
    if (s && overlay && (!overlay.noticeText || overlay.noticeText === lastHitNotice)) {
      const after = Math.max(0, s.hp - (structPending.get(r.id)?.dmg ?? 0));
      lastHitNotice = t('command.hit.struct', { what: t(`structure.${STRUCT_KEY[s.type] ?? 'city'}`), nation: nationName(s.owner), pct: Math.round(after * 100), state: t(`card.dmg.${['intact', 'damaged', 'heavy', 'destroyed'][damageState(after)]}`) });
      overlay.showNotice(lastHitNotice, 2.5);
    }
  }

  function hitHouse(r: HouseRec, w: keyof typeof HIT_DMG, at: THREE.Vector3): void {
    if (!civil) return;
    const view = ctx.sim.view;
    const city = r.cityId ? view.structures.get(r.cityId) : undefined;
    const owner = city ? city.owner : r.owner;
    if (friendlyOwner(owner)) return;
    if (city && !cityConfirmed.has(city.id)) {
      void askCivilian(city.id);
      return;
    }
    if (!city && view.pairState(HUMAN_ID, owner) !== 'war') {
      void askFireFirst(owner);
      return;
    }
    const blast = BLAST_M[w];
    const victims = blast > 0 ? [r, ...civil.housesNear(at.x, at.z, blast).filter((h) => h !== r && h.cityId === r.cityId)] : [r];
    for (const h of victims) {
      civil.collapseHouse(h);
      housesDown++;
      if (!city) continue;
      pend(city.id, HOUSE_DMG);
      const key = `${city.id}:${h.block}`;
      if (!reportedBlocks.has(key) && civil.blockDown(city.id, h.block).share >= BLOCK_DOWN_SHARE) {
        reportedBlocks.add(key);
        pend(city.id, BLOCK_DMG, h.block);
        overlay?.showNotice(t('command.hit.block', { city: cityName(city.id) }), 3);
      }
    }
    if (city) {
      structHitN++;
      structHitIds.add(city.id);
    }
  }

  function cityName(id: number): string {
    const lab = civil?.towns.find((tw) => tw.cityId === id);
    return lab?.name || t('structure.city');
  }

  /** The first shot at a city asks, with the consequences in numbers (the sim applies them on the hit). */
  async function askCivilian(cityId: number): Promise<void> {
    if (decision) return;
    const view = ctx.sim.view;
    const city = view.structures.get(cityId);
    if (!city) return;
    const name = nationName(city.owner);
    const peace = view.pairState(HUMAN_ID, city.owner) !== 'war';
    const civ = cityCivilianLoss(city.level, 0.1);
    const allies = view.players[city.owner]?.allies.length ?? 0;
    const body = t('command.civil.body', {
      city: cityName(cityId), nation: name, civ: formatNumber(Math.round(civ / 100) * 100), v: Math.abs(CIVILIAN_OPINION_VICTIM),
      allies: allies > 0 ? t('command.civil.allies', { n: allies, a: Math.abs(CIVILIAN_OPINION_ALLY) }) : '', w: Math.abs(CIVILIAN_OPINION_WORLD), days: Math.round(CASUS_BELLI_TICKS / 240),
    });
    console.info(`[command] civilian target: asking — ${body}`);
    const i = await decide(t('command.civil.title', { city: cityName(cityId) }), body, peace ? t('command.civil.peace', { nation: name }) : t('command.civil.note'), [
      { label: t('command.civil.go'), cls: 'danger', key: 'Enter' },
      { label: t('command.civil.hold'), cls: 'pri', key: 'Esc' },
    ]);
    if (i !== 0) return;
    cityConfirmed.add(cityId);
    console.info(`[command] civilian target confirmed: city ${cityId} of ${city.owner}${peace ? ' (at peace: war)' : ''}`);
  }

  /** Smoke and flames of the damage in view (every frame; the nearest ten), and their light at night. */
  let fireLightWall = 0;
  const fireP = new THREE.Vector3();
  function burnFires(dt: number): void {
    const P = player();
    if (!civil || !fx || !P || dt <= 0) return;
    const R = kind === 'jet' ? 40_000 : kind === 'ship' ? 15_000 : 6000;
    const near = civil.fires.map((f) => ({ f, d: Math.hypot(f.x - P.pos.x, f.z - P.pos.z) })).filter((o) => o.d < R).sort((a, b) => a.d - b.d).slice(0, 10);
    for (const { f } of near) {
      fireP.set(f.x, f.y, f.z);
      if (f.heat >= 0.5) fx.burn(fireP, f.heat, dt, f.size);
      else fx.column(fireP, 0.6 + f.heat, dt);
    }
    const now = performance.now();
    if (atmos.night > 0.3 && now - fireLightWall > 400) {
      fireLightWall = now;
      for (const { f } of near.slice(0, 2)) if (f.heat >= 0.5) fx.light(fireP.set(f.x, f.y + 4, f.z), 40 * f.size, 0.6, 180 * f.size, 0xff8a3a);
    }
  }

  function setIntegrity(v: number, by = 0): void {
    if (!params) return;
    integrity = Math.max(0, Math.min(1, v));
    ctx.sim.send({ type: 'controlledDamage', unitId: params.unitId, integrity, ...(by ? { by } : {}) });
  }

  /** A kill: credit it to the sim when your formation made it; count your own losses. */
  function onKill(victim: Ent, killer: Ent | null, byPlayer: boolean): void {
    if (!hud || !params) return;
    if (victim.formation) {
      vehiclesLost++;
      const share = victim.kind === 'ifv' ? 0.1 : kind === 'jet' ? 1 / 3 : kind === 'ship' ? integrity : 0.25;
      setIntegrity(integrity - share, killer?.nation ?? 0);
      if (!victim.player) hud.feedEntry('ally', victim.kind, 0, colorCss(HUMAN_ID));
      return;
    }
    const credited = byPlayer || !!killer?.formation;
    if (credited && victim.team === 1 && !victim.neutral && victim.src) {
      const s = victim.src;
      const c = addCas(s.owner);
      if (victim.kind === 'soldier' || victim.kind === 'at') {
        c.troops += 25;
        killsBy.set(s.owner, (killsBy.get(s.owner) ?? 0) + 25);
      } else if (s.kind === 'division' || s.kind === 'squadron') {
        c.unitHits.set(s.id, (c.unitHits.get(s.id) ?? 0) + s.share);
        unitHitN++;
        unitHitShare += s.share;
      } else if (s.kind === 'qrf') {
        // A quick-reaction vehicle takes its crew and the soldiers riding in it (the sim's force loses them).
        const troops = Math.max(1, Math.round(s.share)) * 25;
        c.troops += troops;
        killsBy.set(s.owner, (killsBy.get(s.owner) ?? 0) + troops);
      } else if (s.kind === 'sam') {
        c.structureHits.set(s.id, (c.structureHits.get(s.id) ?? 0) + s.share);
        structHitN++;
      } else if (s.kind === 'ship') {
        const sent = shipSent.get(victim) ?? 0;
        if (sent < 1) c.unitHits.set(s.id, (c.unitHits.get(s.id) ?? 0) + (1 - sent));
        shipSent.set(victim, 1);
        unitHitN++;
        unitHitShare += 1 - sent;
      }
      const troops = victim.kind === 'soldier' || victim.kind === 'at' ? 25 : s.kind === 'qrf' ? Math.max(1, Math.round(s.share)) * 25 : Math.round(s.share * 100);
      hud.feedEntry('you', victim.kind, troops, '#ffb53d');
      if (victim.kind !== 'soldier' && victim.kind !== 'at') hud.killConfirm(victim.kind, troops);
      ctx.bus.emit('uiSound', { kind: 'notify' });
    } else if (victim.team === 1 && killer && victim.kind !== 'soldier') {
      hud.feedEntry('ally', victim.kind, 0, colorCss(HUMAN_ID));
    } else if (victim.team === 0 && victim.kind !== 'soldier' && victim.kind !== 'at') {
      hud.feedEntry('enemy', victim.kind, 0, colorCss(victim.nation));
    }
  }

  /** Enemy warships: every 25 % of hull lost is a hit on the real ship (§9.8). */
  function trackShipHits(): void {
    if (!world) return;
    for (const e of world.ents) {
      if (!e.alive || e.kind !== 'ship' || e.team !== 1 || !e.src || e.src.kind !== 'ship') continue;
      const lost = 1 - e.hp / e.maxHp;
      let sent = shipSent.get(e) ?? 0;
      while (lost - sent >= 0.25) {
        sent += 0.25;
        const c = addCas(e.src.owner);
        c.unitHits.set(e.src.id, (c.unitHits.get(e.src.id) ?? 0) + 0.25);
        unitHitN++;
        unitHitShare += 0.25;
      }
      shipSent.set(e, sent);
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Formation
  // -----------------------------------------------------------------------------------------------
  function makeController(e: Ent): Controller {
    return kind === 'tank' ? new TankController(e, cctx) : kind === 'jet' ? new JetController(e, cctx) : new ShipController(e, cctx);
  }

  function takeVehicle(e: Ent): void {
    if (!world) return;
    const old = world.player;
    if (old) old.player = false;
    e.player = true;
    e.order = 'front';
    world.player = e;
    controller = makeController(e);
    if (internals) internals.controller = controller;
    // Wingmen follow the new leader; the slots close up.
    const mates = formation.filter((m) => m.alive && m !== e);
    const slots = Forces.formationSlots(kind, mates.length + 1).slice(1);
    mates.forEach((m, i) => m.slot.copy(slots[i]));
    travelCamInit = false;
  }

  function nextVehicle(): boolean {
    const next = formation.find((m) => m.alive && !m.player);
    if (!next) return false;
    takeVehicle(next);
    phase = 'play';
    phaseT = 0;
    nextVehicleT = -1;
    return true;
  }

  // -----------------------------------------------------------------------------------------------
  // Entry
  // -----------------------------------------------------------------------------------------------
  /** Find ground (tank) or deep water (ship) near the entry point: the sim's 25 km tile and the local coast differ. */
  function findSpot(water: boolean): THREE.Vector3 {
    const g = ground!;
    const ok = (x: number, z: number) => {
      const h = g.heightAt(x, z);
      return water ? h < -5 && g.heightAt(x + 80, z) < -3 && g.heightAt(x - 80, z) < -3 && g.heightAt(x, z + 80) < -3 && g.heightAt(x, z - 80) < -3
        : h > 1 && g.normalAt(x, z, tmp2, 4).y > 0.85 && !civil!.structureAt(x, z);
    };
    if (ok(0, 0)) return new THREE.Vector3(0, 0, 0);
    for (let r = 40; r <= 4000; r += 40) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2 + r * 0.01;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (ok(x, z)) return new THREE.Vector3(x, 0, z);
      }
    }
    return new THREE.Vector3(0, 0, 0);
  }

  async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
    const t0 = performance.now();
    while (!cond()) {
      if (performance.now() - t0 > ms) return false;
      ground?.update(0, 0, 0, 0);
      await new Promise((r) => setTimeout(r, 16));
    }
    return true;
  }

  async function build(p: CommandEnterParams, relocating = false): Promise<void> {
    if (!ground || !scatter || !world || !fx || !water || !mats || !hud || !overlay || !civil || !forces) return;
    const q = ctx.quality;
    kind = p.kind;
    frame.set(p.lat, p.lon);
    world.reset();
    world.rng = new Rng((p.seed >>> 0) || 1);
    world.kind = kind;
    world.godMode = false;
    world.enemySkill = p.difficulty === 'easy' ? 0.6 : p.difficulty === 'hard' ? 1.3 : p.difficulty === 'insane' ? 1.6 : 1;
    world.playerDamageMul = p.difficulty === 'easy' ? 0.45 : p.difficulty === 'hard' ? 0.95 : p.difficulty === 'insane' ? 1.2 : 0.7;
    fx.clear();
    fx.seed(p.seed);
    fx.hearing = kind === 'jet' ? 2500 : kind === 'ship' ? 1800 : 500;
    const g = ground;
    fx.heightAt = (x, z) => g.heightAt(x, z);
    fx.normalAt = (x, z, o) => g.normalAt(x, z, o);
    ground.begin(frame, kind, q.commandDetail);
    scatter.resetStream();
    scatter.latHint = p.lat;
    grass?.configure(ground, kind === 'tank' ? q.commandDetail : 0);
    civil.begin(frame, ground, kind);
    scatter.keepOut = civil.keepOut;
    if (grass) grass.keepOut = civil.keepOut;
    forces.reset(kind, p.unitId);
    forces.setHandoff(p.battleHandoff);
    world.nationColor = (o) => ctx.sim.view.players[o]?.color ?? 0x888888;
    // Entered from a visible ground battle (§9.6): the point the battle camera looked at, for the first view, the
    // vehicle's facing and the battle's label in the world.
    const ho = p.battleHandoff;
    const keepFocus = relocating ? battleFocus : null;
    // The battle's focus: the middle of the soldiers it was drawing (where the two lines meet), else where its camera
    // looked, else its anchor.
    const bc = ho ? battleCentre(ho) : null;
    battleFocus = keepFocus ?? (ho && bc ? { lat: bc.lat, lon: bc.lon, a: ho.infantry[0]?.owner ?? 0, b: ho.infantry[1]?.owner ?? 0 } : null);
    // Terrain around the entry point first (the screen is faded out meanwhile).
    await waitFor(() => ground!.ringReady(0, 0, 1), ctx.app.isShot ? 90_000 : 30_000);
    // View distance and fog per vehicle.
    const viewDist = q.commandViewDistance;
    fogBase = kind === 'tank' ? 1.3 / (viewDist * 1.1) : kind === 'jet' ? 1.25 / (viewDist * 14) : 1.3 / (viewDist * 5);
    camera.far = kind === 'tank' ? 90_000 : kind === 'jet' ? 400_000 : 220_000;
    camera.near = kind === 'tank' ? 0.3 : kind === 'jet' ? 1.2 : 0.8;
    camera.updateProjectionMatrix();
    const [dn, df] = ground.depthSizes;
    water.configure(ground.depthNear, ground.depthFar, dn, df, df * 1.6, kind === 'ship' ? 1.3 : 1.0);
    ground.onDepth = () => water?.setDepth(ground!.depthNear, ground!.depthFar, ground!.depthCenterNear, ground!.depthCenterFar);
    const sunLocal = localSun(p.lat, p.lon, p.worldTimeSec, new THREE.Vector3());
    atmos = computeAtmos(sunLocal, atmos);
    applyAtmosphere(atmos, fogBase);
    rebuildEnvironment();
    localClock = clockString(p.lon, p.worldTimeSec);
    (ground.material.userData.scorch as { value: number }).value = 0;
    mats.setTeamColors(p.friendlyColor, p.enemyColor);
    world.setTeamTints(p.friendlyColor, p.enemyColor);
    // The player's vehicle at the unit's real position and heading; entered from a ground battle, turned toward the
    // battle it was watching (the division faces its front).
    let yaw = LocalFrame.yawOfHeading(p.heading ?? 0);
    if (battleFocus && kind === 'tank') {
      const bp = frame.sceneOf(battleFocus.lat, battleFocus.lon, { x: 0, z: 0 });
      if (Math.hypot(bp.x, bp.z) > 300) yaw = Math.atan2(-bp.x, -bp.z);
    }
    // The civil layout first (towns, bases, roads), so the vehicle never starts inside a building.
    civil.update(ctx.sim.view, 0, 0, performance.now(), 1);
    const spot = kind === 'jet' ? new THREE.Vector3() : findSpot(kind === 'ship');
    civil.clearDisc(spot.x, spot.z, kind === 'tank' ? 45 : 10);
    const vkind = kind === 'jet' ? 'jet' : kind === 'ship' ? 'ship' : 'tank';
    const alt = kind === 'jet' ? Math.max(ground.surfaceAt(0, 0) + ((p.alt ?? 0) > 0.05 ? 400 : 180), (p.alt ?? 0) * FLIGHT_CEILING_M) : undefined;
    const me = world.spawn(vkind, 0, spot.x, spot.z, yaw, alt);
    me.nation = HUMAN_ID;
    me.formation = true;
    me.src = { kind: 'formation', id: p.unitId, owner: HUMAN_ID, share: kind === 'jet' ? 1 / 3 : 0.25 };
    integrity0 = integrity = Math.max(0.01, Math.min(1, p.integrity ?? 1));
    const n = kind === 'tank' ? Math.max(1, Math.ceil(integrity * 4 - 1e-6)) : kind === 'jet' ? Math.max(1, Math.ceil(integrity * 3 - 1e-6)) : 1;
    formation = [me];
    ifvs = [];
    const slots = Forces.formationSlots(kind, n + (kind === 'tank' ? 2 : 0));
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    for (let i = 1; i < slots.length; i++) {
      const isIfv = kind === 'tank' && i >= n;
      const sl = slots[i];
      const x = me.pos.x + sl.x * cy + sl.z * sy, z = me.pos.z - sl.x * sy + sl.z * cy;
      const e = world.spawn(isIfv ? 'ifv' : vkind, 0, x, z, yaw, alt !== undefined ? alt + sl.y : undefined);
      e.nation = HUMAN_ID;
      e.formation = true;
      e.order = 'follow';
      e.slot.copy(sl);
      e.src = { kind: 'formation', id: p.unitId, owner: HUMAN_ID, share: isIfv ? 0.1 : kind === 'jet' ? 1 / 3 : 0.25 };
      if (isIfv) ifvs.push(e);
      else formation.push(e);
    }
    brain = new Brain(world);
    cctx.world = world;
    cctx.ground = ground;
    cctx.fx = fx;
    cctx.obstacles = scatter.houseList;
    cctx.speedCap = Infinity;
    takeVehicle(me);
    world.hooks = {
      onPlayerHit: (_e, kill) => {
        hud!.hitMarker(kill);
        if (!kill) ctx.bus.emit('uiSound', { kind: 'click' });
      },
      onKill: (victim, killer, byPlayer) => onKill(victim, killer, byPlayer),
      onPlayerDamaged: (amount, from) => {
        const P = player();
        if (P) hud!.damage(amount, P.pos, from);
        lastFiredSec = localSec;
        shakeAmt = Math.min(1.5, shakeAmt + amount / 40);
        if (requested > 1 || effRate > 1) dropToTactical('command.travel.fired');
      },
      onPlayerKilled: () => {
        phase = 'dying';
        phaseT = 0;
        hud!.showDestroyed();
        sfx('explosionLarge', 1);
        const more = formation.some((m) => m.alive && !m.player);
        nextVehicleT = more ? 3 : -1;
        if (more) overlay!.showNotice(t(kind === 'jet' ? 'command.next.jet' : 'command.next.tank', { s: 3 }), 3);
      },
      onNeutralHit: (e) => void askFireFirst(e.nation),
      sceneryHit: (pr, a, b) => sceneryHit(pr, a, b),
      groundBlast: (pr, at) => groundBlast(pr, at),
    };
    fx.hooks = {
      sound: (cue, gain) => sfx(cue, gain),
      shake: (a) => (shakeAmt = Math.min(1.5, shakeAmt + a * (ctx.settings.get().screenShake === false ? 0.3 : 1))),
    };
    // What is really here.
    forces.refresh(ctx.sim.view, me, 1, true);
    // Clock: tactical time, focus on the unit (fronts publish sub-tile progress there).
    requested = effRate = 1;
    throttled = decision = false;
    sentClock = { mode: '', rate: -1, throttled: false, at: 0 };
    sendClock(performance.now(), true);
    // HUD
    controller!.update(1 / 60, false);
    controller!.updateCamera(0);
    hud.show({ kind, opName: '', enemyName: '', enemyColor: '', friendlyName: '', friendlyColor: '', coords: '', localTime: localClock, objective: 0 },
      controller!.hud.weapons.map((w) => ({ key: w.key, label: w.label })));
    overlay.show(kind);
    world.syncRigs(0);
    // Bookkeeping
    lastSafe.copy(me.pos);
    prevPos.copy(me.pos);
    lastMovePos.copy(me.pos);
    waypoint = null;
    autopilot = false;
    landOwner = prevLandOwner = holderOfScene(me.pos.x, me.pos.z);
    if (incursionOwner(landOwner)) confirmed.add(landOwner);
    // A march to the action rebuilds the scene where it ended: the session's tallies and clocks go on.
    if (relocating) return;
    distanceM = 0;
    killsBy.clear();
    unitHitN = unitHitShare = structHitN = 0;
    structPending.clear();
    cityConfirmed.clear();
    reportedBlocks.clear();
    structHitIds.clear();
    housesDown = 0;
    vehiclesLost = 0;
    confirmed.clear();
    warned.clear();
    freeNoticed.clear();
    cas.clear();
    shipSent.clear();
    waypoint = null;
    autopilot = false;
    rebaseN = 0;
    lastFiredSec = -1e9;
    cadence.length = 0;
    lastMoveLocal = -1e9;
    localSec = startSec = ctx.sim.view.command?.sec ?? 0;
    startCmdSec = ctx.sim.view.command ? ctx.sim.view.command.sec : -1;
    startWall = performance.now();
    landOwner = prevLandOwner = holderOfScene(me.pos.x, me.pos.z);
    // Taking control inside foreign land (a unit left there, an incursion running): that border is already crossed.
    if (incursionOwner(landOwner)) confirmed.add(landOwner);
  }

  // -----------------------------------------------------------------------------------------------
  // Decisions (§9.7, §9.12)
  // -----------------------------------------------------------------------------------------------
  async function decide(title: string, body: string, extra: string, buttons: { label: string; cls?: string; key?: string }[]): Promise<number> {
    if (!overlay) return -1;
    decision = true;
    input.releaseLock();
    sendClock(performance.now(), true);
    const i = await overlay.ask(title, body, extra, buttons);
    decision = false;
    sendClock(performance.now(), true);
    return i;
  }

  async function askCross(owner: number): Promise<void> {
    const name = nationName(owner);
    const bodyKey = kind === 'jet' ? 'command.incursion.bodyAir' : kind === 'ship' ? 'command.incursion.bodyWater' : 'command.incursion.body';
    const i = await decide(t('command.incursion.title', { nation: name }), t(bodyKey, { nation: name }), '', [
      { label: t('command.incursion.cross'), cls: 'danger', key: 'Enter' },
      { label: t('command.incursion.back'), cls: 'pri', key: 'Esc' },
    ]);
    const P = player();
    console.info(`[command] border crossing into ${owner}: ${i === 0 ? 'cross' : 'back'} (${i})`);
    if (i === 0) {
      confirmed.add(owner);
      return;
    }
    // Go back: turn the vehicle around at the border.
    if (P) {
      P.pos.copy(lastSafe);
      P.yaw += Math.PI;
      P.speed = kind === 'jet' ? P.speed : 0;
      if (kind === 'jet') {
        P.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
        P.vel.multiplyScalar(-1);
        controller = makeController(P);
        if (internals) internals.controller = controller;
      }
      autopilot = false;
    }
  }

  async function askFireFirst(owner: number): Promise<void> {
    if (!owner || decision) return;
    const name = nationName(owner);
    const i = await decide(t('command.fire.title', { nation: name }), t('command.fire.body', { nation: name }), '', [
      { label: t('command.fire.declare'), cls: 'danger', key: 'Enter' },
      { label: t('command.fire.hold'), cls: 'pri', key: 'Esc' },
    ]);
    if (i !== 0) return;
    ctx.sim.send({ type: 'declareWar', target: owner });
    overlay?.showNotice(t('command.fire.declared', { nation: name }), 4);
    // The forces of that nation turn hostile as soon as the sim confirms the war (next refresh).
    lastForcesWall = 0;
  }

  async function requestExit(): Promise<void> {
    if (!active || exitRequested) return;
    if (phase === 'transit') {
      // Esc during a march stops it where the unit is.
      transitAbort = true;
      return;
    }
    if (overlay?.dialogOpen) {
      overlay.dialogKey('Escape');
      return;
    }
    if (tacmap?.isOpen) {
      tacmap.close();
      decision = false;
      sendClock(performance.now(), true);
      return;
    }
    if (!controller || !world || !hud) {
      exitRequested = true;
      ctx.bus.emit('commandExitRequested', { reason: 'player' });
      return;
    }
    if (phase === 'debrief') {
      exitRequested = true;
      ctx.bus.emit('commandExitRequested', { reason: 'player' });
      return;
    }
    if (phase === 'dying' || phase === 'intro') return;
    const inc = myIncursion();
    const extra = inc && !inc.left && inc.response !== 'war' ? t('command.exit.foreign', { nation: nationName(inc.victim) }) : '';
    const i = await decide(t('command.exit.title'), t(kind === 'jet' ? 'command.exit.bodyJet' : 'command.exit.body'), extra, [
      { label: t('command.exit.yes'), cls: 'pri', key: 'Enter' },
      { label: t('command.exit.no'), key: 'Esc' },
    ]);
    if (i === 0) beginDebrief(false);
  }

  function myIncursion() {
    const cv = ctx.sim.view.command;
    if (!cv || !params) return null;
    let best: (typeof cv.incursions)[number] | null = null;
    for (const inc of cv.incursions) if (inc.unitId === params.unitId && (!best || inc.id > best.id)) best = inc;
    return best;
  }

  function beginDebrief(lost: boolean): void {
    if (!world || !overlay || phase === 'debrief') return;
    phase = 'debrief';
    phaseT = 0;
    input.releaseLock();
    // Everything goes back now (the report shows applied numbers).
    sendMove(performance.now(), true);
    flushCasualties(performance.now(), true);
    // A unit left inside foreign land raises its «sigue dentro» crisis after the exit (alerts.ts, on commandExit).
    const rows: DebriefRow[] = [];
    rows.push({ label: t('command.debrief2.distance'), value: `${formatNumber(distanceM / 1000, distanceM < 10_000 ? 1 : 0)} km` });
    // Game time on the sim's command clock (the same seconds the incursion timers use), not the local step count.
    const cmdSec = ctx.sim.view.command?.sec;
    const gsec = cmdSec !== undefined && startCmdSec >= 0 ? Math.max(0, cmdSec - startCmdSec) : Math.max(0, localSec - startSec);
    const gm = Math.floor(gsec / 60), gh = Math.floor(gm / 60);
    rows.push({ label: t('command.debrief2.gameTime'), value: gh > 0 ? `${gh} h ${String(gm % 60).padStart(2, '0')} min` : `${gm} min ${String(Math.floor(gsec % 60)).padStart(2, '0')} s` });
    rows.push({ label: t('command.debrief2.kills'), value: String(world.stats.kills) });
    for (const [owner, troops] of killsBy) rows.push({ label: t('command.debrief2.equiv'), value: t('command.debrief2.troops', { troops: formatNumber(troops), nation: nationName(owner) }), cls: 'red' });
    if (unitHitN) rows.push({ label: t('command.debrief2.hits'), value: t('command.debrief2.hitsV', { n: unitHitN, pct: Math.round(unitHitShare * 100) }), cls: 'red' });
    if (structHitN) {
      // What the hits did in the sim (the structures' state now).
      const view = ctx.sim.view;
      const parts: string[] = [];
      for (const id of structHitIds) {
        const s = view.structures.get(id);
        parts.push(s ? `${s.type === 0 ? cityName(id) : t(`structure.${STRUCT_KEY[s.type] ?? 'city'}`)} ${Math.round(s.hp * 100)} %` : t('command.debrief2.destroyed'));
      }
      rows.push({ label: t('command.debrief2.structs'), value: t('command.debrief2.structsV', { n: structHitN, list: parts.slice(0, 3).join(', ') }), cls: 'red' });
      if (housesDown) rows.push({ label: t('command.debrief2.houses'), value: formatNumber(housesDown), cls: 'red' });
    }
    rows.push({
      label: t('command.debrief2.losses'),
      value: vehiclesLost ? t('command.debrief2.lossesV', { n: vehiclesLost, pct: Math.round(integrity * 100) }) : t('command.debrief2.noLosses'),
      cls: vehiclesLost ? 'red' : 'green',
    });
    const P = player();
    const title = lost ? t('command.debrief2.lost') : params ? unitLabel(params.unitType, unitView()?.serial ?? 0) : '';
    overlay.showDebrief(title, rows, `${t('command.debrief2.synced')} ${t('command.debrief2.return')}`);
    outroPos.copy(camera.position);
    camera.getWorldDirection(tmp);
    outroLook.copy(camera.position).addScaledVector(tmp, 60);
    if (P) outroLook.copy(P.pos);
    ctx.bus.emit('uiSound', { kind: 'whoosh' });
  }

  // -----------------------------------------------------------------------------------------------
  // Floating origin
  // -----------------------------------------------------------------------------------------------
  function maybeRebase(contact: boolean): void {
    const P = player();
    if (!P || !ground) return;
    const R = REBASE_M[kind];
    const d = Math.hypot(P.pos.x, P.pos.z);
    if (d < R || (contact && d < R * 4)) return;
    const c = ground.nearSize;
    const dx = Math.round(P.pos.x / c) * c, dz = Math.round(P.pos.z / c) * c;
    if (dx === 0 && dz === 0) return;
    frame.offX += dx;
    frame.offZ += dz;
    world?.rebase(dx, dz);
    ground.rebase(dx, dz);
    scatter?.rebase(dx, dz);
    grass?.rebase(dx, dz);
    civil?.rebase(dx, dz);
    controller?.rebase?.(dx, dz);
    fx?.clear();
    camera.position.x -= dx;
    camera.position.z -= dz;
    travelCamPos.x -= dx;
    travelCamPos.z -= dz;
    for (const v of [waypoint, lastSafe, lastMovePos, prevPos, outroPos, outroLook]) {
      if (!v) continue;
      v.x -= dx;
      v.z -= dz;
    }
    water?.setDepth(ground.depthNear, ground.depthFar, ground.depthCenterNear, ground.depthCenterFar);
    rebaseN++;
  }

  // -----------------------------------------------------------------------------------------------
  // Travel (×10 and above): the formation marches at the unit's strategic speed
  // -----------------------------------------------------------------------------------------------
  const TR_N = new THREE.Vector3();
  function passable(x: number, z: number): boolean {
    const g = ground!;
    const h = g.heightAt(x, z);
    if (kind === 'ship') return h < -4;
    if (kind === 'jet') return true;
    if (h < 0.6) return false;
    return g.normalAt(x, z, TR_N, 6).y > 0.78;
  }

  function travelStep(dtGame: number, realDt: number): void {
    const P = player();
    if (!P || !ground) return;
    const cap = UNIT_DEFS[params!.unitType].speedKmh / 3.6;
    // Steering: autopilot toward the waypoint, or A/D by hand (W go, S stop).
    const manual = input.down('KeyA') || input.down('KeyD') || input.down('ArrowLeft') || input.down('ArrowRight') || input.down('KeyW') || input.down('KeyS');
    if (manual && autopilot) {
      autopilot = false;
      overlay?.showNotice(t('command.travel.manual'), 2.5, true);
      if (requested > 60) {
        requested = 60;
        overlay?.showNotice(t('command.travel.manualMax'), 3.5);
      }
    }
    if (input.down('KeyW') || input.down('ArrowUp')) travelGo = true;
    if (input.down('KeyS') || input.down('ArrowDown')) travelGo = false;
    const steer = (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0) - (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0);
    travelYawRate += (steer * 0.7 - travelYawRate) * Math.min(1, realDt * 6);
    let wantYaw = P.yaw + travelYawRate * realDt;
    if (autopilot && waypoint) {
      const dx = waypoint.x - P.pos.x, dz = waypoint.z - P.pos.z;
      if (Math.hypot(dx, dz) < Math.max(150, cap * dtGame)) {
        autopilot = false;
        waypoint = null;
        travelGo = false;
        dropToTactical('command.travel.arrived');
        P.speed = 0;
        return;
      }
      wantYaw = Math.atan2(-dx, -dz);
      travelGo = true;
    }
    if (!travelGo) {
      P.speed = 0;
      P.vel.set(0, 0, 0);
      P.yaw = wantYaw;
      return;
    }
    let dist = cap * dtGame;
    const step = kind === 'jet' ? 250 : 20;
    let moved = 0;
    while (dist > 1e-3) {
      const s = Math.min(step, dist);
      let ok = false;
      // Straight on, else the gentlest detour (valleys and gentle slopes, around water).
      for (const off of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2]) {
        const y = wantYaw + off;
        const nx = P.pos.x - Math.sin(y) * s, nz = P.pos.z - Math.cos(y) * s;
        if (!passable(nx, nz) || !ground.nearReady(nx, nz)) continue;
        // Never into a nation at peace without the confirmation.
        const o = ownerOfTile(tileIndex(tileOf(nx, nz).x, tileOf(nx, nz).y));
        if (incursionOwner(o) && !confirmed.has(o)) {
          P.pos.copy(lastSafe);
          P.speed = 0;
          autopilot = false;
          void askCross(o);
          return;
        }
        P.pos.x = nx;
        P.pos.z = nz;
        P.yaw = y;
        ok = true;
        break;
      }
      if (!ok) {
        travelGo = false;
        break;
      }
      moved += s;
      dist -= s;
    }
    // Ground clamp, attitude.
    if (kind === 'tank') {
      P.pos.y = ground.heightAt(P.pos.x, P.pos.z);
      ground.normalAt(P.pos.x, P.pos.z, TR_N, 3);
      const cyw = Math.cos(P.yaw), syw = Math.sin(P.yaw);
      P.tiltP = -Math.atan2(TR_N.x * -syw + TR_N.z * -cyw, TR_N.y);
      P.tiltR = -Math.atan2(TR_N.x * cyw + TR_N.z * -syw, TR_N.y);
    } else if (kind === 'ship') {
      P.pos.y = 0;
      P.quat.setFromEuler(new THREE.Euler(0, P.yaw, 0, 'YXZ'));
    } else {
      const floor = ground.surfaceAt(P.pos.x, P.pos.z) + 500;
      P.pos.y += (Math.max(floor, P.pos.y) - P.pos.y) * Math.min(1, realDt * 2);
      P.quat.setFromEuler(new THREE.Euler(0, P.yaw, 0, 'YXZ'));
    }
    P.speed = dtGame > 0 ? moved / dtGame : 0;
    forwardOf(P.yaw, P.vel).multiplyScalar(P.speed);
    // Wingmen keep their slots (column march).
    const cyw = Math.cos(P.yaw), syw = Math.sin(P.yaw);
    for (const m of [...formation, ...ifvs]) {
      if (!m.alive || m === P) continue;
      const sl = m.slot;
      const tx = P.pos.x + sl.x * cyw + sl.z * syw, tz = P.pos.z - sl.x * syw + sl.z * cyw;
      m.pos.x = tx;
      m.pos.z = tz;
      m.yaw = P.yaw;
      m.speed = P.speed;
      m.vel.copy(P.vel);
      if (kind === 'jet') {
        m.pos.y = P.pos.y + sl.y;
        m.quat.copy(P.quat);
      } else if (kind === 'ship') m.pos.y = 0;
      else m.pos.y = ground.heightAt(tx, tz);
    }
  }


  // -----------------------------------------------------------------------------------------------
  // Getting to the action (owner feedback #3, item 26)
  // -----------------------------------------------------------------------------------------------
  function refreshTargets(force = false): void {
    const now = performance.now();
    if (!force && now - targetsWall < 500) return;
    targetsWall = now;
    const P = player();
    const uv = unitView();
    const tp = P ? tileOf(P.pos.x, P.pos.z) : uv ? { x: uv.x, y: uv.y } : null;
    if (!tp) return;
    targets = combatTargets(ctx.sim.view, tp.x, tp.y, kind, uv);
    if (entryGoal) entryGoal.km = tileKm(tp.x, tp.y, entryGoal.tx, entryGoal.ty);
  }

  /** An enemy the scene already shows within 15 km (the fight you can see), as a target in tile coords. */
  function sceneFoe(): CombatTarget | null {
    const P = player();
    if (!P || !forces) return null;
    const h = forces.nearestHostile(P.pos);
    if (!h.ent || h.dist > 15_000) return null;
    const tp = tileOf(h.ent.pos.x, h.ent.pos.z);
    return { kind: 'unit', tx: tp.x, ty: tp.y, km: h.dist / 1000, owner: h.ent.nation, order: h.ent.kind };
  }

  /**
   * Where «Ir al combate» goes: an enemy already in the scene, else the action the player was sent to, else the
   * mission when it is about as near, else the nearest action.
   */
  function chosenTarget(): CombatTarget | null {
    const foe = sceneFoe();
    if (foe && (!entryGoal || foe.km < entryGoal.km + 3)) return foe;
    if (entryGoal) return entryGoal;
    const { nearest, mission } = targets;
    // The mission's place counts while the unit is not there yet (standing in its sector, the fight is the nearest enemy).
    // A defended sector is own ground: it only leads when no fighting is known (the fight is where the enemy is).
    if (mission && mission.order === 'defend' && nearest) return nearest;
    if (mission && mission.km > STOP_KM[kind] + HOP_KM[kind] && (!nearest || mission.km <= nearest.km * 1.5 + 5)) return mission;
    return nearest;
  }

  function targetTitle(c: CombatTarget): string {
    if (c === entryGoal && goalLabel) return goalLabel;
    const nation = nationName(c.owner);
    if (c.kind === 'battle') return t('command.obj.battle', { nation });
    if (c.kind === 'front') return t('command.obj.front', { nation });
    if (c.kind === 'port') return t('command.obj.port', { nation });
    if (c.kind === 'unit' && !c.unitId && c.order) return t('command.obj.seen', { what: t(`command.type.${c.order}`), nation });
    if (c.kind === 'unit') {
      const u = c.unitId ? ctx.sim.view.units.get(c.unitId) : undefined;
      return t('command.obj.unit', { unit: u ? unitLabel(u.type, u.serial) : '', nation });
    }
    return t(`command.obj.mission.${c.order ?? 'move'}`, { nation });
  }

  const dirWord = (brg: number): string => t(`command.dir.${Math.round(brg / 45) % 8}`);

  /** The chip and the world marker of the nearest action, every 250 ms. */
  function updateCombat(): void {
    const P = player();
    if (!overlay || !P || !forces || !ground) return;
    refreshTargets();
    const h = forces.nearestHostile(P.pos);
    if (h.ent && h.dist < REACH_M[kind]) {
      const e = h.ent;
      const brg = (Math.atan2(e.pos.x - P.pos.x, -(e.pos.z - P.pos.z)) * 180 / Math.PI + 360) % 360;
      const dist = h.dist >= 1000 ? `${formatNumber(h.dist / 1000, 1)} km` : `${Math.round(h.dist / 10) * 10} m`;
      overlay.setCombat({ title: t('command.obj.contact', { what: t(`command.type.${e.kind}`), nation: nationName(e.nation) }), sub: t('command.obj.contactSub'), dist: `${dist} · ${dirWord(brg)}`, contact: true, go: '' });
      overlay.combatMarker = { pos: tmp3.copy(e.pos).setY(e.pos.y + e.height + 4), text: dist, contact: true };
      if (entryGoal && entryGoal.km < STOP_KM[kind] * 4) entryGoal = null;
      return;
    }
    const c = chosenTarget();
    if (!c) {
      overlay.setCombat(null);
      overlay.combatMarker = null;
      return;
    }
    const tp = tileOf(P.pos.x, P.pos.z);
    const brg = tileBearing(tp.x, tp.y, c.tx, c.ty);
    const km = c.km;
    const dist = `${formatNumber(km, km < 10 ? 1 : 0)} km · ${dirWord(brg)}`;
    const m = targets.mission;
    const sub = c !== m && m ? (m.km < 1 ? targetTitle(m) : t('command.obj.alsoMission', { what: targetTitle(m), km: formatNumber(m.km, 0) }))
      : c === m && targets.nearest && targets.nearest.km < c.km - 5 ? t('command.obj.nearer', { what: targetTitle(targets.nearest), km: formatNumber(targets.nearest.km, 0) })
        : km > FAR_KM[kind] ? t('command.obj.farSub', { h: formatNumber(km / UNIT_DEFS[params!.unitType].speedKmh, 1) }) : t('command.obj.nearSub');
    overlay.setCombat({ title: targetTitle(c), sub, dist, contact: false, go: t(km > FAR_KM[kind] ? 'command.go.front' : 'command.go.combat') });
    const sp = frame.sceneOfTile(c.tx, c.ty, { x: 0, z: 0 });
    const y = ground.surfaceAt(sp.x, sp.z);
    overlay.combatMarker = { pos: tmp3.set(sp.x, (Number.isFinite(y) ? Math.max(0, y) : 0) + (kind === 'jet' ? 400 : 40), sp.z), text: `${targetTitle(c)} · ${formatNumber(km, km < 10 ? 1 : 0)} km`, contact: false };
    if (entryGoal && km < STOP_KM[kind] + 0.6) entryGoal = null;
  }
  const tmp3 = new THREE.Vector3();

  /** A tile the march may cross: never water for a tank (land for a ship), never a nation at peace without leave. */
  function passableTile(tile: number): boolean {
    const w = ctx.world;
    const water = w ? isWaterTerrain(w.terrain[tile]) : false;
    if (kind === 'tank' && water) return false;
    if (kind === 'ship' && !water) return false;
    const o = ownerOfTile(tile);
    return !(incursionOwner(o) && !confirmed.has(o));
  }

  /** «Ir al combate» (G, or the chip's button). */
  async function goToCombat(): Promise<void> {
    if (marchLegs === 0) marchLegs = 1;
    if (phase !== 'play' || decision || !params || !overlay) return;
    const P = player();
    if (!P || !forces) return;
    refreshTargets(true);
    const h = forces.nearestHostile(P.pos);
    if (h.ent && h.dist < REACH_M[kind]) {
      overlay.showNotice(t('command.go.already', { m: formatNumber(Math.round(h.dist / 10) * 10) }), 3.5);
      return;
    }
    const c = chosenTarget();
    if (!c) {
      overlay.showNotice(t(ctx.sim.view.wars.some((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID) ? 'command.go.noneWar' : 'command.go.none'), 4.5, true);
      return;
    }
    const inc = myIncursion();
    if (inc && !inc.left && inc.response !== 'war') {
      overlay.showNotice(t('command.travel.incursion'), 3);
      return;
    }
    const tp = tileOf(P.pos.x, P.pos.z);
    const stop = c.kind === 'unit' && c.unitId ? STOP_KM[kind] * 2 : STOP_KM[kind];
    const title = targetTitle(c);
    const nearWaypoint = (): void => {
      const f = Math.max(0, (c.km - stop) / Math.max(0.001, c.km));
      const sp = frame.sceneOfTile(tp.x + ((c.tx - tp.x + MAP_W * 1.5) % MAP_W - MAP_W / 2) * f, tp.y + (c.ty - tp.y) * f, { x: 0, z: 0 });
      waypoint = new THREE.Vector3(sp.x, ground!.surfaceAt(sp.x, sp.z) + (kind === 'jet' ? 300 : 20), sp.z);
      autopilot = true;
      lastMapWall = 0;
    };
    // Near, or fired upon a moment ago: the local autopilot (the + key compresses time when nothing is in reach).
    if (c.km - stop < HOP_KM[kind] || localSec - lastFiredSec < 30) {
      nearWaypoint();
      const ok = contactNow() ? false : setRequested(inOwnOrFriendlyLand() ? 60 : 10);
      overlay.showNotice(t(ok ? 'command.go.driving' : 'command.go.drive', { what: title, km: formatNumber(Math.max(0, c.km - stop), 1) }), 4, true);
      return;
    }
    const route = planRoute(tp.x, tp.y, c.tx, c.ty, stop, passableTile, kind === 'jet' ? 4000 : 2500);
    if (!route || route.km < 0.5) {
      nearWaypoint();
      overlay.showNotice(t('command.go.noRoute', { what: title }), 5);
      return;
    }
    await marchTo(route, c, false);
  }

  /** Enemy units at war (of a kind this vehicle meets) within `km` of a point in tile coords. */
  function enemyNearTile(x: number, y: number, km: number): boolean {
    for (const u of ctx.sim.view.units.values()) {
      if (!atWar(ctx.sim.view, u.owner) || !(u.hp > 0)) continue;
      const fits = kind === 'tank' ? u.type === 3 : kind === 'ship' ? u.type === 2 : u.type === 4 || u.type === 5;
      if (fits && tileKm(x, y, u.x, u.y) < km) return true;
    }
    return false;
  }

  /**
   * During a march: where the next leg goes, judged from the sim alone (the scene is not rebuilt yet). The action the
   * player was sent to while it is not reached, else the nearest action (a defended sector never pulls away from a
   * fight); null when the unit is there, an enemy unit is in reach or no route exists.
   */
  function nextLegFromSim(): { route: Route; c: CombatTarget } | null {
    const uv = unitView();
    if (!uv) return null;
    if (enemyNearTile(uv.x, uv.y, kind === 'tank' ? 4 : kind === 'ship' ? 12 : 15)) return null;
    targets = combatTargets(ctx.sim.view, uv.x, uv.y, kind, uv);
    targetsWall = performance.now();
    if (entryGoal) entryGoal.km = tileKm(uv.x, uv.y, entryGoal.tx, entryGoal.ty);
    if (entryGoal && entryGoal.km < STOP_KM[kind] + HOP_KM[kind]) entryGoal = null;
    const { nearest, mission } = targets;
    const c = entryGoal ?? (mission && mission.order !== 'defend' && mission.km > STOP_KM[kind] + HOP_KM[kind] && (!nearest || mission.km <= nearest.km * 1.5 + 5) ? mission : nearest);
    if (!c) return null;
    const stop = c.kind === 'unit' && c.unitId ? STOP_KM[kind] * 2 : STOP_KM[kind];
    if (c.km - stop < HOP_KM[kind]) return null;
    const route = planRoute(uv.x, uv.y, c.tx, c.ty, stop, passableTile, kind === 'jet' ? 4000 : 2500);
    return route && route.km >= 0.5 ? { route, c } : null;
  }

  /**
   * The march: the unit really moves in the sim along the route at its strategic speed while the clock runs fast
   * (×300 … ×3600: the whole world with it, as a strategic move would), behind a fade with a progress card; then the
   * scene is rebuilt where it stopped. Stops on arrival, an enemy unit in reach, a critical alert or Esc.
   */
  async function marchTo(route: Route, c: CombatTarget, prebuild: boolean): Promise<{ x: number; y: number; heading: number } | null> {
    if (!params || !overlay) return null;
    const p0 = params;
    let title = targetTitle(c);
    const speed = UNIT_DEFS[p0.unitType].speedKmh;
    let hours = route.km / speed;
    let rate = Math.round(Math.max(TRANSIT_RATE_MIN, Math.min(TRANSIT_RATE_MAX, (hours * 3600) / TRANSIT_REAL_S)));
    const wall0 = performance.now();
    const prevPhase = phase;
    phase = 'transit';
    transitAbort = false;
    input.releaseLock();
    hud?.setCinematic(true);
    if (!prebuild) await ctx.post.fadeTo(1, ctx.app.isShot ? 1 : 450);
    // Nothing to draw behind the fade: the frames stay cheap and the sim gets the machine.
    scene.visible = false;
    console.info(`[command] march to ${title}: ${route.km.toFixed(1)} km by ${route.pts.length - 1} legs at ×${rate}`);
    requested = effRate = rate;
    throttled = false;
    decision = false;
    const focus = { x: route.pts[0].x, y: route.pts[0].y };
    ctx.sim.setClock('travel', rate, focus, false);
    sentClock = { mode: 'travel', rate, throttled: false, at: performance.now() };
    const sec0 = ctx.sim.view.command?.sec ?? 0;
    let lastSend = 0, km = 0, stopBy = 'arrived', stall = 0, lastKm = -1, stallSince = performance.now();
    let pt = alongRoute(route, 0);
    const reachKm = kind === 'tank' ? 5 : kind === 'ship' ? 25 : 60;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let legSec0 = sec0, kmDone = 0;
    for (let leg = 0; ; leg++) {
    for (;;) {
      await sleep(80);
      if (!active) {
        scene.visible = true;
        return null;
      }
      const uv = unitView();
      if (!uv || !(uv.hp > 0)) {
        stopBy = 'lost';
        break;
      }
      // Progress is where the sim has the unit (it checks every move against the speed and the game time since the
      // last one, and snaps a move beyond it); the next move asks for the point the clock allows by now.
      km = routeProgress(route, uv.x, uv.y);
      const cv = ctx.sim.view.command;
      const gs = cv ? Math.max(0, cv.sec - legSec0) : 0;
      const want = Math.min(route.km, Math.max(km, (speed * gs) / 3600));
      pt = alongRoute(route, want);
      const now = performance.now();
      if (now - lastSend > 150) {
        lastSend = now;
        ctx.sim.send({ type: 'controlledMove', unitId: p0.unitId, x: pt.x, y: pt.y, heading: pt.heading });
        if (now - sentClock.at > 1000) {
          ctx.sim.setClock('travel', rate, { x: uv.x, y: uv.y }, false);
          sentClock.at = now;
        }
      }
      if (km >= route.km - 0.25) break;
      if (transitAbort) {
        stopBy = 'player';
        break;
      }
      if (km > 2 && enemyNearTile(uv.x, uv.y, reachKm)) {
        stopBy = 'enemy';
        break;
      }
      // Nothing moves any more (blocked): stop where it is.
      if (Math.abs(km - lastKm) >= 0.01 || lastKm < 0) stallSince = now;
      stall = now - stallSince;
      lastKm = km;
      if (stall > 30000) {
        console.info(`[command] march stalled at ${km.toFixed(1)} km (sim ${cv?.sec.toFixed(0)} s, moves ${JSON.stringify(cv?.moves)}, log ${JSON.stringify(cv?.log.slice(-2))})`);
        stopBy = 'player';
        break;
      }
      const leftKm = Math.max(0, route.km - km);
      const leftH = leftKm / speed;
      overlay.setTransit({
        title: t('command.transit.title', { what: title }),
        body: t('command.transit.body', { km: formatNumber(route.km, 0), kmh: speed, h: formatNumber(hours, 1), rate }),
        pct: (km / route.km) * 100,
        left: t('command.transit.left', { km: formatNumber(leftKm, leftKm < 10 ? 1 : 0) }),
        time: t('command.transit.time', { h: leftH >= 1 ? `${formatNumber(leftH, 1)} h` : `${Math.round(leftH * 60)} min` }),
        foot: t('command.transit.foot'),
      });
    }
    kmDone += km;
    // Arrived, but the line moved during the march (fronts are alive) or the far view of it was coarse: the next leg
    // goes on behind the same fade, from where the sim has the unit (no scene rebuild in between; at most 4 legs).
    if (stopBy !== 'arrived' || leg >= 3) break;
    const nx = nextLegFromSim();
    if (!nx) break;
    console.info(`[command] march goes on to ${targetTitle(nx.c)}: ${nx.route.km.toFixed(1)} km more`);
    route = nx.route;
    c = nx.c;
    title = targetTitle(c);
    hours = route.km / speed;
    // A follow-on leg is short: it gets less real time than the first (the player is already waiting behind the card).
    rate = Math.round(Math.max(TRANSIT_RATE_MIN, Math.min(TRANSIT_RATE_MAX, (hours * 3600) / (TRANSIT_REAL_S * 0.4))));
    requested = effRate = rate;
    ctx.sim.setClock('travel', rate, { x: route.pts[0].x, y: route.pts[0].y }, false);
    sentClock = { mode: 'travel', rate, throttled: false, at: performance.now() };
    legSec0 = ctx.sim.view.command?.sec ?? legSec0;
    km = 0;
    lastKm = -1;
    stallSince = performance.now();
    pt = alongRoute(route, 0);
    }
    km = kmDone;
    // Tactical time again, where the sim has the unit.
    requested = effRate = 1;
    const uEnd = unitView();
    ctx.sim.setClock('tactical', 1, uEnd ? { x: uEnd.x, y: uEnd.y } : { x: pt.x, y: pt.y }, false);
    sentClock = { mode: 'tactical', rate: 1, throttled: false, at: performance.now() };
    await sleep(300);
    overlay.setTransit(null);
    scene.visible = true;
    const cv = ctx.sim.view.command;
    transits.push({ km, gameSec: cv ? cv.sec - sec0 : 0, realMs: performance.now() - wall0, rate, stop: stopBy });
    console.info(`[command] march ended (${stopBy}): ${km.toFixed(1)} km in ${((performance.now() - wall0) / 1000).toFixed(1)} real s`);
    const uv = unitView();
    if (stopBy === 'lost' || !uv) {
      phase = prevPhase;
      return null;
    }
    const at = { x: uv.x, y: uv.y, heading: pt.heading };
    if (!prebuild) await relocate(at, c, stopBy);
    else phase = prevPhase;
    return at;
  }

  /** After the swoop: taken to an action, finish the way to it; otherwise say where the nearest fighting is. */
  function afterIntro(): void {
    const P = player();
    if (!P || !overlay || !forces) return;
    refreshTargets(true);
    const h = forces.nearestHostile(P.pos);
    const contact = !!h.ent && h.dist < REACH_M[kind];
    if (entryGoal) {
      // Sent to an action: arrived there (the march ran behind the entry fade) or still short of it.
      const goal = entryGoal;
      if (goal.km < STOP_KM[kind] + HOP_KM[kind]) entryGoal = null;
      refreshTargets(true);
      const next = chosenTarget();
      if (!contact && next && next.km - STOP_KM[kind] >= HOP_KM[kind]) {
        marchLegs = 1;
        void goToCombat();
      } else arrivalNotice(next ?? goal, 'arrived');
      return;
    }
    const c = chosenTarget();
    if (!c || contact) return;
    const tp = tileOf(P.pos.x, P.pos.z);
    const dir = dirWord(tileBearing(tp.x, tp.y, c.tx, c.ty));
    overlay.showNotice(t(c.km > FAR_KM[kind] ? 'command.go.offerFar' : 'command.go.offer', { what: targetTitle(c), km: formatNumber(c.km, c.km < 10 ? 1 : 0), dir }), 7, true);
  }

  /** Rebuild the scene where a march ended and say where the action is. */
  async function relocate(at: { x: number; y: number; heading: number }, c: CombatTarget, stopBy: string): Promise<void> {
    if (!params) return;
    const ll = tileXYToLatLon(at.x, at.y);
    const p: CommandEnterParams = {
      ...params, lat: ll.lat, lon: ll.lon, x: at.x, y: at.y, heading: at.heading, integrity, battleHandoff: undefined,
      tile: Math.floor(at.y) * MAP_W + Math.floor(at.x), worldTimeSec: params.worldTimeSec,
    };
    params = p;
    try {
      await build(p, true);
    } catch (err) {
      console.error('[command] failed to rebuild the scene after the march', err);
    }
    if (internals) {
      internals.controller = controller;
      internals.brain = brain;
    }
    phase = 'play';
    phaseT = 0;
    // The march took game hours: the local clock catches up with the sim's.
    localSec = ctx.sim.view.command?.sec ?? localSec;
    hud?.setCinematic(false);
    updateInfo(performance.now());
    refreshTargets(true);
    arrivalNotice(c, stopBy);
    await ctx.post.fadeTo(0, ctx.app.isShot ? 1 : 500);
    // The line moved while the unit marched (fronts are alive): if the action is still out of reach, go on to where it
    // is now (at most four more legs, then the player drives). A goal reached is done: the live line leads from here.
    if (entryGoal && entryGoal.km < STOP_KM[kind] + HOP_KM[kind]) entryGoal = null;
    refreshTargets(true);
    const next = chosenTarget();
    const P = player();
    const inReach = !!P && !!forces && forces.nearestHostile(P.pos).dist < REACH_M[kind];
    if (stopBy === 'arrived' && next && !inReach && next.km - STOP_KM[kind] >= HOP_KM[kind] && marchLegs < 5) {
      marchLegs++;
      await goToCombat();
    } else marchLegs = 0;
  }
  let marchLegs = 0;

  function arrivalNotice(c: CombatTarget, stopBy: string): void {
    const P = player();
    if (!P || !overlay) return;
    const tp = tileOf(P.pos.x, P.pos.z);
    const km = tileKm(tp.x, tp.y, c.tx, c.ty);
    const dir = dirWord(tileBearing(tp.x, tp.y, c.tx, c.ty));
    overlay.showNotice(t(`command.transit.end.${stopBy === 'enemy' ? 'enemy' : stopBy === 'player' ? 'player' : 'arrived'}`, { what: targetTitle(c), km: formatNumber(km, 1), dir }), 6, stopBy !== 'enemy');
    // Face the action.
    const sp = frame.sceneOfTile(c.tx, c.ty, { x: 0, z: 0 });
    if (kind === 'tank' && Math.hypot(sp.x - P.pos.x, sp.z - P.pos.z) > 50) {
      P.yaw = Math.atan2(-(sp.x - P.pos.x), -(sp.z - P.pos.z));
      controller?.aimAt?.(tmp3.set(sp.x, ground!.surfaceAt(sp.x, sp.z) + 2, sp.z));
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Per-frame systems
  // -----------------------------------------------------------------------------------------------
  function step(dt: number, allowInput: boolean): void {
    if (!world || !fx || !controller || !brain) return;
    if (dt > 0) {
      brain.update(dt);
      controller.update(dt, allowInput);
      world.update(dt);
    }
    world.syncRigs(dt);
    fx.update(dt);
    world.renderProjectiles();
  }

  function placeShadowCamera(): void {
    const P = player();
    if (!P) return;
    const ext = kind === 'tank' ? 80 : kind === 'ship' ? 220 : 160;
    const texel = (ext * 2) / sun.shadow.mapSize.x;
    const x0 = Math.round(P.pos.x / texel) * texel, z0 = Math.round(P.pos.z / texel) * texel;
    sun.target.position.set(x0, P.pos.y, z0);
    sun.position.copy(sun.target.position).addScaledVector(atmos.lightDir, 600);
    const sc = sun.shadow.camera;
    sc.left = -ext;
    sc.right = ext;
    sc.top = ext;
    sc.bottom = -ext;
    sc.near = 10;
    sc.far = 1400;
    sc.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
  }

  function applyShake(dt: number): void {
    if (shakeAmt <= 0.001) return;
    const a = shakeAmt * shakeAmt;
    const k = kind === 'jet' ? 0.35 : 1;
    camera.position.x += (Math.random() - 0.5) * a * 0.9 * k;
    camera.position.y += (Math.random() - 0.5) * a * 0.9 * k;
    camera.rotateZ((Math.random() - 0.5) * a * 0.03);
    camera.rotateX((Math.random() - 0.5) * a * 0.02);
    shakeAmt = Math.max(0, shakeAmt - dt * 1.8);
  }

  function lockBeeps(dt: number): void {
    if (!controller || ctx.app.isShot || phase !== 'play') return;
    const h = controller.hud;
    lockBeepT -= dt;
    warnBeepT -= dt;
    if (h.lockState > 0 && lockBeepT <= 0) {
      lockBeepT = h.lockState === 2 ? 0.09 : 0.32 - h.lockProgress * 0.2;
      ctx.bus.emit('uiSound', { kind: 'hover' });
    }
    if (h.missileWarning && warnBeepT <= 0) {
      warnBeepT = 0.45;
      ctx.bus.emit('uiSound', { kind: 'alert' });
    }
  }

  /** Land status line, place and incursion state for the HUD. */
  function updateInfo(now: number): void {
    if (!overlay || !params) return;
    const P = player();
    if (!P) return;
    const view = ctx.sim.view;
    const ll = frame.latLonOfScene(P.pos.x, P.pos.z, { lat: 0, lon: 0 });
    const place = describePlace(view, ll.lat, ll.lon).text;
    const o = landOwner;
    const inc = myIncursion();
    const tile = tileIndex(tileOf(P.pos.x, P.pos.z).x, tileOf(P.pos.x, P.pos.z).y);
    const water = ctx.world ? isWaterTerrain(ctx.world.terrain[tile]) : false;
    let land: string;
    let war = false;
    if (o === HUMAN_ID) {
      const fr = forces?.last?.fronts[0];
      const other = fr ? (fr.a === HUMAN_ID ? fr.b : fr.b === HUMAN_ID ? fr.a : 0) : 0;
      if (kind === 'jet') land = t('command.land.ownAirspace');
      else if (water) land = t('command.land.ownWaters');
      else if (battleFocus && kind === 'tank') {
        // Entered from a battle: the distance is to that battle's centre, the same number as its label and notice.
        const bk = battleKm(P)!;
        const foe = battleFocus.a === HUMAN_ID ? battleFocus.b : battleFocus.a;
        land = t('command.land.ownBattle', { nation: nationName(foe), km: kmText(bk.km) });
      } else if (fr && other && fr.nearest.distKm < 60) land = t('command.land.ownFront', { nation: nationName(other), km: formatNumber(fr.nearest.distKm, 0) });
      else if (view.wars.some((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID)) land = t('command.land.ownWar');
      else land = t('command.land.own');
    } else if (o === 0) {
      land = water || kind === 'ship' ? t('command.land.sea') : t('command.land.unclaimed');
    } else {
      const st = view.pairState(HUMAN_ID, o);
      const name = nationName(o);
      war = st === 'war';
      if (kind === 'jet') land = t('command.land.airspace', { nation: name, state: stateWord(o) });
      else if (water) land = t('command.land.waters', { nation: name, state: stateWord(o) });
      else if (view.hasTreaty(HUMAN_ID, o, 'alliance') || view.human?.allies.includes(o)) land = t('command.land.allied', { nation: name });
      else if (view.hasTreaty(HUMAN_ID, o, 'openBorders')) land = t('command.land.open', { nation: name });
      else land = t(`command.land.${st}`, { nation: name });
    }
    const clockKind = decision ? 'decision' : effRate <= 1 && requested <= 1 ? 'tactical' : throttled ? 'throttled' : 'travel';
    const rate = Math.round(effRate);
    const span = rate >= 60 ? t('command.span.min', { n: formatNumber(rate / 60, rate % 60 ? 1 : 0) }) : t('command.span.s', { n: rate });
    const clock = clockKind === 'decision' ? t('command.clock.decision') : clockKind === 'tactical' ? t('command.clock.tactical')
      : clockKind === 'throttled' ? t('command.clock.throttled', { rate: Math.round(requested) }) : t('command.clock.travel', { rate, span });
    let travel = '';
    if (waypoint) {
      const d = Math.hypot(waypoint.x - P.pos.x, waypoint.z - P.pos.z);
      const hours = d / 1000 / UNIT_DEFS[params.unitType].speedKmh;
      const time = hours >= 1 ? `${formatNumber(hours, 1)} h` : `${Math.round(hours * 60)} min`;
      travel = `${autopilot ? `${t('command.travel.autopilot')} · ` : ''}${t('command.travel.eta', { km: formatNumber(d / 1000, d < 10_000 ? 1 : 0), time })}`;
    }
    updateRadio(inc, P);
    updateCombat();
    const uv = unitView();
    overlay.setInfo({
      unit: unitLabel(params.unitType, uv?.serial ?? 0), place, land, landColor: o ? colorCss(o) : '#6f8aa3',
      incursion: !!inc && !inc.left && inc.response !== 'war', war, clock, clockKind, localTime: `${localClock} · ${formatNumber(ll.lat, 2)}°, ${formatNumber(ll.lon, 2)}°`, travel,
    });
    const pips: ('me' | 'ok' | 'lost' | 'ifv' | 'ifvLost')[] = [];
    for (const m of formation) pips.push(m.player ? 'me' : m.alive ? 'ok' : 'lost');
    for (const m of ifvs) pips.push(m.alive ? 'ifv' : 'ifvLost');
    overlay.setFormation(kind, pips, integrity);
    overlay.setHelpText(kind, effRate > 1);
    void now;
  }

  /** The nearest way out of the victim's land (km and compass word), refreshed once a second. */
  let exitCache: { at: number; victim: number; text: string } = { at: 0, victim: 0, text: '' };
  function nearestExitText(victim: number, P: Ent): string {
    const now = performance.now();
    if (exitCache.victim === victim && now - exitCache.at < 1000) return exitCache.text;
    const tp = tileOf(P.pos.x, P.pos.z);
    const cx = Math.floor(tp.x), cy = Math.floor(tp.y);
    const a = { x: 0, z: 0 }, b = { x: 0, z: 0 };
    let best = Infinity, bx = 0, bz = 0;
    for (let r = 1; r <= 10 && best === Infinity; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const ty = cy + dy;
          if (ty < 0 || ty >= MAP_H) continue;
          const tile = tileIndex(cx + dx, ty);
          const water = ctx.world ? isWaterTerrain(ctx.world.terrain[tile]) : false;
          if (kind === 'tank' && water) continue;
          if (kind === 'ship' && !water) continue;
          if (ownerOfTile(tile) === victim) continue;
          frame.sceneOfTile(cx + dx, ty, a);
          frame.sceneOfTile(cx + dx + 1, ty + 1, b);
          const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
          const nx = Math.max(x0, Math.min(x1, P.pos.x)), nz = Math.max(z0, Math.min(z1, P.pos.z));
          const d = Math.hypot(nx - P.pos.x, nz - P.pos.z);
          if (d < best) {
            best = d;
            bx = nx - P.pos.x;
            bz = nz - P.pos.z;
          }
        }
      }
    }
    let text = '';
    if (best < Infinity) {
      const km = Math.max(0.1, best / 1000);
      const brg = (Math.atan2(bx, -bz) * 180 / Math.PI + 360) % 360;
      text = t('command.radio.exit', { km: formatNumber(km, km < 10 ? 1 : 0), dir: t(`command.dir.${Math.round(brg / 45) % 8}`) });
    }
    exitCache = { at: now, victim, text };
    return text;
  }

  let radioStage = '';
  /** The victim's radio (owner feedback #19): the warning with its countdown, the interception, the last warning. */
  let lastAlongWall = 0;
  let noEscortSince = 0;
  function updateRadio(inc: ReturnType<typeof myIncursion>, P: Ent): void {
    if (!overlay) return;
    if (!inc || inc.left) {
      overlay.setRadio(null);
      radioStage = '';
      return;
    }
    const name = nationName(inc.victim);
    const sec = simSecNow();
    const nearCapital = inc.capitalKm >= 0 && inc.capitalKm <= 80;
    const from = t(`command.radio.from.${inc.kind}`, { nation: name });
    const exit = inc.response === 'war' ? '' : nearestExitText(inc.victim, P);
    const q = inc.qrf;
    const stage = `${inc.id}:${inc.response}:${q?.arrived ? 1 : 0}`;
    if (stage !== radioStage) {
      radioStage = stage;
      ctx.bus.emit('uiSound', { kind: 'alert' });
    }
    if (inc.response === 'none') {
      const remain = Math.max(0, inc.decideAtSec - sec);
      overlay.setRadio({
        severity: 'warning', from, message: t(`command.radio.warn.${inc.kind}`, { nation: name }), sub: nearCapital ? t('command.radio.capital') : undefined,
        countLabel: t('command.radio.count.grace'), remain, total: Math.max(1, inc.decideAtSec - inc.enteredSec), remainText: fmtDur(remain), exit,
      });
    } else if (inc.response === 'intercept' && q && !q.arrived) {
      const remain = Math.max(0, q.arriveSec - sec);
      const km = Math.round(Math.max(1, tileKmBetween(q.fromX, q.fromY, inc) ));
      const source = t(`command.qrf.src.${q.source}`, { km: formatNumber(km) });
      const what = q.mode === 'sea' ? t(q.unitId ? 'command.qrf.what.warship' : 'command.qrf.what.boat')
        : t(q.heavy ? 'command.qrf.what.heavy' : 'command.qrf.what.patrol', { n: q.heavy ? q.vehicles - 1 : q.vehicles });
      const msg = q.mode === 'air' ? t('command.radio.intercept.air', { nation: name, source, t: fmtDur(remain) })
        : t(`command.radio.intercept.${inc.kind === 'ship' ? 'ship' : 'tank'}`, { nation: name, source, what, t: fmtDur(remain) });
      overlay.setRadio({
        severity: 'danger', from, message: msg, sub: t('command.radio.nofire'), countLabel: t('command.radio.count.eta'), remain,
        total: Math.max(1, q.arriveSec - q.dispatchSec), remainText: fmtDur(remain), exit,
      });
    } else if (inc.response === 'intercept' || (inc.response === 'protest' && inc.deadlineSec > 0)) {
      const remain = Math.max(0, inc.deadlineSec - sec);
      const escort = inc.response === 'intercept';
      const warnLen = nearCapital ? 30 : inc.kind === 'jet' ? 45 : 90;
      const total = escort ? warnLen : Math.max(1, inc.deadlineSec - inc.respondedSec);
      const mode = q?.mode === 'air' ? 'air' : inc.kind === 'ship' ? 'ship' : 'tank';
      // «Alongside» only when its vehicles really are (≈150 m on land, 600 m in the air, 1.5 km at sea); until then the
      // radio says how far they still are.
      const d = escort && forces ? forces.qrfDistance(inc.id, P.pos) : 0;
      const along = d <= (mode === 'air' ? 600 : mode === 'ship' ? 1500 : 150);
      // The sim's last warning starts only when a vehicle is really alongside here (owner feedback #20); a force the
      // scene could not place at all (no vehicle of it after 20 s) is reported as there so the incident can go on.
      if (inc.awaitingAlongside && q?.arrived) {
        const nowW = performance.now();
        if (!Number.isFinite(d)) noEscortSince ||= nowW;
        else noEscortSince = 0;
        if ((along || (noEscortSince && nowW - noEscortSince > 20_000)) && nowW - lastAlongWall > 1000) {
          lastAlongWall = nowW;
          ctx.sim.send({ type: 'escortAlongside', unitId: inc.unitId });
          console.info(`[command] escort alongside: ${Number.isFinite(d) ? Math.round(d) : '-'} m at game ${sec.toFixed(1)} s`);
        }
      }
      const distText = d >= 1000 ? `${formatNumber(d / 1000, d < 10_000 ? 1 : 0)} km` : `${Math.round(d / 10) * 10} m`;
      overlay.setRadio({
        severity: 'danger', from,
        message: escort ? (along || !Number.isFinite(d) ? t(`command.radio.escort.${mode}`, { nation: name }) : t(`command.radio.closing.${mode}`, { nation: name, d: distText })) : t('command.radio.protest', { nation: name }),
        sub: escort ? t('command.radio.nofire') : undefined,
        countLabel: t(escort ? 'command.radio.count.last' : 'command.radio.count.protest'), remain: inc.deadlineSec > 0 ? remain : undefined, total, remainText: fmtDur(remain), exit,
      });
    } else if (inc.response === 'engage') {
      overlay.setRadio({ severity: 'critical', from, message: t('command.radio.engage', { nation: name }), exit });
    } else if (inc.response === 'war') {
      overlay.setRadio({ severity: 'critical', from, message: t('command.radio.war', { nation: name }) });
    } else overlay.setRadio(null);
  }

  /** Km from the force's origin to the incursion's entry point (for «una base aérea a 180 km»). */
  function tileKmBetween(x: number, y: number, inc: NonNullable<ReturnType<typeof myIncursion>>): number {
    const u = unitView();
    const ux = u ? u.x : x, uy = u ? u.y : y;
    const lat = 90 - (((y + uy) / 2) / MAP_H) * 180;
    let dx = ux - x;
    if (dx > MAP_W / 2) dx -= MAP_W;
    else if (dx < -MAP_W / 2) dx += MAP_W;
    void inc;
    return Math.hypot(dx * TILE_KM * Math.cos((lat * Math.PI) / 180), (uy - y) * TILE_KM);
  }

  /** «Guarnición del frente de Lyon · 1.840 tropas en la zona» for the force under the cursor (or the crosshair). */
  function updateHover(): void {
    hover = null;
    if (!world || !forces?.last) return;
    const W = cctx.viewW, H = cctx.viewH;
    const mx = input.locked || mouseX < 0 ? W / 2 : mouseX, my = input.locked || mouseY < 0 ? H / 2 : mouseY;
    let best: Ent | null = null, bd = 34;
    for (const e of world.ents) {
      if (!e.alive || e.player) continue;
      tmp.copy(e.pos);
      tmp.y += e.height * 0.6;
      tmp.project(camera);
      if (tmp.z > 1 || tmp.z < -1) continue;
      const x = (tmp.x * 0.5 + 0.5) * W, y = (-tmp.y * 0.5 + 0.5) * H;
      const d = Math.hypot(x - mx, y - my);
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (!best || !best.src) return;
    const s = best.src;
    const view = ctx.sim.view;
    const name = nationName(s.owner);
    let text = '';
    if (s.kind === 'formation') text = t('command.src.formation', { unit: unitLabel(params!.unitType, unitView()?.serial ?? 0) });
    else if (s.kind === 'division' || s.kind === 'ship' || s.kind === 'squadron') {
      const u = view.units.get(s.id);
      text = t(s.kind === 'squadron' ? 'command.src.squadron' : s.kind === 'ship' ? 'command.src.ship' : 'command.src.division', {
        unit: u ? unitLabel(u.type, u.serial) : '', nation: name, pct: Math.round((u?.hp ?? 0) * 100),
      });
    } else if (s.kind === 'qrf') text = t('command.src.qrf', { nation: name });
    else if (s.kind === 'sam') text = t('command.src.sam', { nation: name });
    else if (s.kind === 'post') text = t('command.src.post', { nation: name });
    else {
      const side = forces.last.sides.find((sd) => sd.owner === s.owner);
      text = side ? `${name} · ${localSideText(side)}` : name;
    }
    hover = { x: mx, y: my, text };
  }

  /** Borders: approach warning, the confirmation to cross, free entries, leaving (§9.7). */
  function updateBorders(now: number): void {
    const P = player();
    if (!P || decision) return;
    const o = holderOfScene(P.pos.x, P.pos.z);
    prevLandOwner = landOwner;
    landOwner = o;
    if (incursionOwner(o) && !confirmed.has(o)) {
      // Blocked at the line until the player decides.
      P.pos.copy(lastSafe);
      P.speed = kind === 'jet' ? P.speed : 0;
      landOwner = prevLandOwner;
      void askCross(o);
      return;
    }
    lastSafe.copy(P.pos);
    if (o !== prevLandOwner) {
      if (o > 0 && o !== HUMAN_ID && !incursionOwner(o) && ctx.sim.view.pairState(HUMAN_ID, o) !== 'war' && !freeNoticed.has(o)) {
        freeNoticed.add(o);
        overlay?.showNotice(t('command.border.enterFree', { nation: nationName(o), state: stateWord(o) }), 3.5, true);
      } else if (prevLandOwner > 0 && prevLandOwner !== HUMAN_ID && incursionOwner(prevLandOwner)) {
        overlay?.showNotice(t('command.border.left', { nation: nationName(prevLandOwner) }), 3, true);
      }
    }
    borderNear = nearestBorder(P.pos);
    if (borderNear && borderNear.distM < BORDER_WARN_M && !confirmed.has(borderNear.owner) && borderNear.owner !== o) {
      const last = warned.get(borderNear.owner) ?? -1e9;
      if (now - last > 20_000) {
        warned.set(borderNear.owner, now);
        overlay?.showNotice(t('command.border.approach', { nation: nationName(borderNear.owner), state: stateWord(borderNear.owner), km: formatNumber(borderNear.distM / 1000, 1) }), 4);
      }
      if (requested > 1 || effRate > 1) dropToTactical('command.travel.border');
    }
  }

  // -----------------------------------------------------------------------------------------------
  // API
  // -----------------------------------------------------------------------------------------------
  const api: CommandApi = {
    scene,
    camera,
    get active() {
      return active;
    },
    async init(progress) {
      progress(0.05);
      const noise = makeNoiseTexture(256);
      noise.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      progress(0.25);
      const atlas = makeParticleAtlas();
      const decals = makeDecalAtlas();
      progress(0.45);
      mats = createMaterials(noise);
      sky = new Sky(noise);
      water = new Water(noise);
      ground = new Ground(noise);
      scatter = new Scatter(mats.prop);
      grass = new Grass();
      civil = new Civil(mats.prop);
      const q = ctx.quality;
      fx = new Effects(atlas, decals, Math.min(q.particles, 14000), q.decals, mats.wreck);
      world = new World(mats, ground, fx, new Rng(1));
      forces = new Forces(world, frame, ground);
      progress(0.8);
      scene.add(sky.mesh, ground.group, water.mesh, scatter.group, grass.mesh, civil.group, world.group, fx.group);
      hud = new CommandHud(ctx.uiRoot);
      hud.onExitClick = () => void requestExit();
      overlay = new CommandOverlay(ctx.uiRoot);
      tacmap = new TacMap(overlay.root);
      overlay.onGo = () => {
        marchLegs = 0;
        void goToCombat();
      };
      tacmap.onPick = (p) => {
        waypoint = p ? new THREE.Vector3(p.x, ground!.surfaceAt(p.x, p.z) + (kind === 'jet' ? 300 : 20), p.z) : null;
        autopilot = !!p && requested > 1;
        lastMapWall = 0;
      };
      input.onEscape = () => void requestExit();
      pmrem = new THREE.PMREMGenerator(renderer);
      applyAtmosphere(atmos, 0.0003);
      try {
        rebuildEnvironment();
      } catch (err) {
        console.warn('[command] environment map failed', err);
      }
      wireIncursionAlerts(ctx);
      const w = world, f = fx, hh = hud, ov = overlay;
      internals = {
        ctx, world: w, fx: f, hud: hh, overlay: ov, scatter, input, ground, civil, forces, frame, controller: null, brain: null, camera,
        atmos: () => atmos,
        get startCmdSec() {
          return startCmdSec;
        },
        get freeze() {
          return freeze;
        },
        set freeze(v: boolean) {
          freeze = v;
        },
        get freezeOnEnter() {
          return freezeOnEnter;
        },
        set freezeOnEnter(v: boolean) {
          freezeOnEnter = v;
        },
        simulate(steps, dt, before) {
          for (let i = 0; i < steps; i++) {
            before?.(i);
            step(dt, false);
            controller?.updateCamera(dt);
            f.flush();
          }
        },
        hold: false,
        get params() {
          return params;
        },
        cadence() {
          return cadence.map((c) => ({ ...c }));
        },
        goCombat: () => goToCombat(),
        targets() {
          refreshTargets(true);
          return { ...targets, chosen: chosenTarget() };
        },
        get phase() {
          return `${phase}:${phaseT.toFixed(2)}:${active}`;
        },
        setPhaseTime(tt: number) {
          phaseT = tt;
        },
        skipIntro() {
          phase = 'play';
          phaseT = 0;
          hh.setCinematic(false);
        },
        setWaypoint(lat: number, lon: number) {
          const p = frame.sceneOf(lat, lon, { x: 0, z: 0 });
          waypoint = new THREE.Vector3(p.x, ground!.surfaceAt(p.x, p.z) + 20, p.z);
          autopilot = requested > 1;
        },
        clearWaypoint() {
          waypoint = null;
          autopilot = false;
        },
        requestRate(r: number) {
          return setRequested(r);
        },
        debrief() {
          if (phase === 'play' || phase === 'intro') beginDebrief(false);
        },
        where() {
          const P = player();
          if (!P) return { lat: 0, lon: 0, heading: 0, x: 0, y: 0 };
          const ll = frame.latLonOfScene(P.pos.x, P.pos.z, { lat: 0, lon: 0 });
          const tp = tileOf(P.pos.x, P.pos.z);
          return { lat: ll.lat, lon: ll.lon, heading: (LocalFrame.headingOfYaw(P.yaw) * 180) / Math.PI, x: tp.x, y: tp.y };
        },
      };
      (window as unknown as { __cmd?: CommandInternals }).__cmd = internals;
      progress(1);
    },
    warmup(on) {
      if (!world || !fx || !scatter || !ground) return;
      world.warmup(on);
      fx.warmup(on);
      scatter.warmup(on);
      grass?.warmup(on);
      if (on) {
        warmMesh = ground.warmupMesh();
        scene.add(warmMesh);
        camera.position.set(0, 20, 40);
        camera.lookAt(0, 0, -20);
        camera.updateMatrixWorld();
      } else if (warmMesh) {
        scene.remove(warmMesh);
        warmMesh.geometry.dispose();
        warmMesh = null;
      }
    },
    async enter(p) {
      params = p;
      active = true;
      phase = 'intro';
      phaseT = 0;
      shakeAmt = 0;
      exitRequested = false;
      freeze = freezeOnEnter;
      freezeOnEnter = false;
      decision = false;
      nextVehicleT = -1;
      const w = ctx.canvas.clientWidth || window.innerWidth, h = ctx.canvas.clientHeight || window.innerHeight;
      cctx.viewW = w;
      cctx.viewH = h;
      camera.aspect = w / Math.max(1, h);
      camera.fov = 62;
      camera.updateProjectionMatrix();
      hud?.resize(w, h);
      overlay?.resize(w, h);
      // Taken at an action (#26/#29e): far from it, the unit marches there first (behind the fade the app left), and
      // the scene is built where it stops.
      entryGoal = null;
      goalLabel = '';
      targets = { nearest: null, mission: null };
      transits.length = 0;
      lastUpdateWall = 0;
      confirmed.clear();
      kind = p.kind;
      if (p.goal) {
        const ux = p.x ?? 0, uy = p.y ?? 0;
        goalLabel = p.goal.label;
        // The place of the action on the contact line itself (the one local derivation: the line the scene draws).
        let gx = p.goal.x, gy = p.goal.y;
        const glf = kind === 'tank' ? deriveLocalForces(ctx.sim.view, gx, gy, 30, HUMAN_ID) : null;
        const gfr = glf?.fronts.find((q) => atWar(ctx.sim.view, q.a === HUMAN_ID ? q.b : q.a) && (q.a === HUMAN_ID || q.b === HUMAN_ID));
        if (gfr) {
          gx = gfr.nearest.x;
          gy = gfr.nearest.y;
        }
        const gt = Math.floor(gy) * MAP_W + Math.floor(gx);
        const gfoe = gfr ? (gfr.a === HUMAN_ID ? gfr.b : gfr.a) : ctx.sim.view.owner[gt] ?? 0;
        entryGoal = { kind: 'battle', tx: gx, ty: gy, km: tileKm(ux, uy, gx, gy), owner: gfoe };
        if (entryGoal.km - STOP_KM[kind] >= HOP_KM[kind]) {
          const route = planRoute(ux, uy, gx, gy, STOP_KM[kind], passableTile, kind === 'jet' ? 4000 : 2500);
          if (route && route.km > 0.5) {
            overlay?.show(kind);
            const at = await marchTo(route, entryGoal, true);
            if (at) {
              const ll = tileXYToLatLon(at.x, at.y);
              p = { ...p, lat: ll.lat, lon: ll.lon, x: at.x, y: at.y, heading: at.heading, tile: Math.floor(at.y) * MAP_W + Math.floor(at.x), battleHandoff: undefined };
              params = p;
            }
          }
        }
      }
      try {
        await build(p);
      } catch (err) {
        console.error('[command] failed to build the local scene', err);
      }
      if (internals) {
        internals.controller = controller;
        internals.brain = brain;
      }
      input.reset();
      input.attach();
      if (hud) {
        hud.showLockHint = !ctx.app.isShot;
        hud.setCinematic(true);
      }
      // Title card: «1.ª División acorazada — cerca de Zaragoza (España) · Territorio propio · en paz».
      updateInfo(performance.now());
      if (overlay && params) {
        const P = player();
        const ll = P ? frame.latLonOfScene(P.pos.x, P.pos.z, { lat: 0, lon: 0 }) : { lat: p.lat, lon: p.lon };
        const place = describePlace(ctx.sim.view, ll.lat, ll.lon).text;
        const landText = overlay.infoText ? (overlay.root.querySelector('.fu-cmdx-info .l span:nth-child(2)')?.textContent ?? '') : '';
        overlay.titleCard(unitLabel(p.unitType, unitView()?.serial ?? 0), t('command.title.line', { place, land: landText }));
        const view = ctx.sim.view;
        const atWar = view.wars.some((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID);
        const peaceful = !atWar && (forces?.log.hostiles ?? 0) === 0 && landOwner === HUMAN_ID && !(forces?.last?.fronts.length);
        battleNotice = !!battleFocus && kind === 'tank';
        if (peaceful) {
          setTimeout(() => {
            // Not over a more important notice (a border ahead): the peaceful welcome is only for the quiet case.
            const nb = player() ? nearestBorder(player()!.pos) : null;
            if (!overlay?.noticeText && (!nb || nb.distM > 5000)) overlay?.showNotice(t('command.peace.notice'), 7, true);
          }, 3600);
        }
      }
      if (controller) {
        controller.updateCamera(0);
        introTo.copy(camera.position);
        introQTo.copy(camera.quaternion);
        const e = controller.ent;
        const k = kind === 'jet' ? 5 : kind === 'ship' ? 3 : 1;
        const bc = p.battleHandoff?.camera;
        if (bc && ground) {
          // The first view is the battle view the player was watching (same place, same look), held for a moment,
          // then the camera glides down to the vehicle: the soldiers and tanks of that battle are there (§9.6).
          const c0 = frame.sceneOf(bc.lat, bc.lon, { x: 0, z: 0 });
          const l0 = frame.sceneOf(bc.lookLat, bc.lookLon, { x: 0, z: 0 });
          introFrom.set(c0.x, ground.surfaceAt(c0.x, c0.z) + Math.max(150, Math.min(20_000, bc.altM)), c0.z);
          camera.position.copy(introFrom);
          camera.lookAt(tmp2.set(l0.x, ground.surfaceAt(l0.x, l0.z), l0.z));
          introHold = 2.2;
          introDur = 7.5;
        } else {
          camera.getWorldDirection(tmp);
          introFrom.copy(e.pos).addScaledVector(tmp, -140 * k);
          introFrom.y += 260 * k;
          camera.position.copy(introFrom);
          camera.lookAt(tmp2.copy(e.pos));
          introHold = 0;
          introDur = 3.1;
        }
        introQFrom.copy(camera.quaternion);
      }
      ctx.post.setExposure(1 + atmos.night * 1.5);
      sfx(kind === 'jet' ? 'jetFlyby' : kind === 'ship' ? 'shipHorn' : 'tankEngine', 0.8);
    },
    exit(): CommandResult {
      const p = params!;
      // Anything not yet sent goes now; the sim has already applied the rest.
      if (active) {
        sendMove(performance.now(), true);
        flushCasualties(performance.now(), true);
      }
      const lost = integrity <= 0.001;
      const result: CommandResult = {
        unitId: p.unitId, kind: p.kind, enemy: p.enemy, tile: p.tile, troopsKilled: 0, unitsDestroyed: [], structuresDestroyed: [],
        unitLost: lost, durationSec: (performance.now() - startWall) / 1000,
      };
      active = false;
      phase = 'idle';
      input.detach();
      hud?.hide();
      overlay?.hide();
      tacmap?.close();
      night.reset();
      scene.visible = true;
      transitAbort = true;
      world?.reset();
      fx?.clear();
      scatter?.resetStream();
      grass?.configure(null, 0);
      ground?.clear();
      civil?.clear();
      controller = null;
      brain = null;
      formation = [];
      ifvs = [];
      waypoint = null;
      if (internals) {
        internals.controller = null;
        internals.brain = null;
      }
      ctx.post.setExposure(1);
      return result;
    },
    update(fr: FrameInfo) {
      if (!active || !controller || !world || !fx || !hud || !overlay || !ground || !forces || !civil) return;
      const now = performance.now();
      const realDt = fr.dt;
      // The intro runs on the wall clock (a slow frame never stretches the swoop into half a minute).
      const wallDt = lastUpdateWall ? Math.min(0.5, (now - lastUpdateWall) / 1000) : realDt;
      lastUpdateWall = now;
      if (phase === 'transit') {
        // Marching behind the fade (marchTo drives it): only Esc (stop here) is read.
        input.endFrame();
        return;
      }
      if (!internals?.hold) phaseT += phase === 'intro' || phase === 'debrief' ? Math.max(realDt, wallDt) : realDt;
      const view = ctx.sim.view;
      // Keys that are not driving.
      if (overlay.dialogOpen) {
        if (input.hit('Enter') || input.hit('NumpadEnter')) overlay.dialogKey('Enter');
      } else if (phase === 'play') {
        if (input.hit('KeyM')) {
          tacmap!.toggle(kind);
          decision = tacmap!.isOpen;
          if (tacmap!.isOpen) input.releaseLock();
          sendClock(now, true);
          lastMapWall = 0;
        }
        if (input.hit('Equal') || input.hit('NumpadAdd') || input.hit('BracketRight')) stepRate(1);
        if (input.hit('Minus') || input.hit('NumpadSubtract') || input.hit('Slash')) stepRate(-1);
        if (input.hit('KeyH')) overlay.toggleHelp();
        if (input.hit('KeyG')) {
          marchLegs = 0;
          void goToCombat();
        }
        if (input.hit('KeyN')) {
          const m = night.cycleVision();
          ctx.post.setExposure((1 + atmos.night * 1.5) * night.exposureMul);
          overlay.setVision(m === 'off' ? '' : m, m === 'off' ? '' : t(`command.vision.${m}`));
          overlay.showNotice(t(`command.vision.${m}.notice`), 2.5, true);
        }
        if (input.hit('KeyL') && kind !== 'jet') {
          night.lightsOn = !night.lightsOn;
          overlay.showNotice(t(night.lightsOn ? 'command.lights.on' : 'command.lights.off'), 2.5, true);
        }
        if (input.hit('Tab') && kind !== 'ship') {
          // Next vehicle of the formation (alive), in slot order.
          const alive = formation.filter((m) => m.alive);
          if (alive.length > 1) {
            const i = alive.findIndex((m) => m.player);
            takeVehicle(alive[(i + 1) % alive.length]);
          }
        }
      } else if (phase === 'dying') {
        if (input.hit('Tab') && nextVehicleT >= 0) nextVehicle();
      }
      // Phases.
      let allowInput = false;
      if (phase === 'intro') {
        if (phaseT > introDur + 0.1) {
          phase = 'play';
          phaseT = 0;
          if (battleNotice) {
            battleNotice = false;
            showBattleNotice();
          } else afterIntro();
          hud.setCinematic(false);
        }
      } else if (phase === 'play') {
        allowInput = !decision;
      } else if (phase === 'dying') {
        if (nextVehicleT >= 0 && phaseT > nextVehicleT) nextVehicle();
        else if (nextVehicleT < 0 && phaseT > 2.6) {
          if (integrity > 0.001) setIntegrity(0);
          beginDebrief(true);
        }
      } else if (phase === 'debrief') {
        if (phaseT > 4.4 && !exitRequested) {
          exitRequested = true;
          ctx.bus.emit('commandExitRequested', { reason: integrity > 0.001 ? 'player' : 'killed' });
        }
      }
      const P = world.player;
      // --- Clock: rate, throttle, local game time locked to the sim's ---
      const contact = contactNow();
      if (requested > 1 || effRate > 1) {
        const incNow = myIncursion();
        if (contact) dropToTactical('command.travel.contact');
        else if (incNow && !incNow.left && incNow.response !== 'war') dropToTactical('command.travel.incursion');
        else if (!inOwnOrFriendlyLand() && requested > 60) {
          requested = 60;
          overlay.showNotice(t('command.travel.foreignMax'), 3);
        }
      }
      updateThrottle();
      sendClock(now);
      const paused = decision || freeze || phase === 'debrief';
      let dtGame = paused ? 0 : realDt * (phase === 'play' ? effRate : 1);
      if (phase === 'play' && view.command && !freeze) {
        const allowed = simSecNow() + 2.5 - localSec;
        // Travel is kinematic: on a slow frame (dt clamped to 0.1 s) the march catches up with the sim's clock, up to
        // one real second of travel per frame, so the rate shown is the rate travelled.
        if (effRate > 1 && !paused) dtGame = Math.max(dtGame, Math.min(view.command.sec - localSec, effRate));
        dtGame = Math.max(0, Math.min(dtGame, allowed));
      }
      localSec += dtGame;
      const travel = phase === 'play' && effRate > 1;
      cctx.speedCap = requested > 1 ? UNIT_DEFS[params!.unitType].speedKmh / 3.6 : Infinity;
      // --- Local simulation ---
      if (travel) {
        travelStep(dtGame, realDt);
        world.update(Math.min(dtGame, 0.1));
        world.syncRigs(realDt);
        fx.update(realDt);
        world.renderProjectiles();
      } else {
        const dt = dtGame;
        if (dt > 0) {
          const n = Math.min(6, Math.ceil(dt / (1 / 30)));
          for (let i = 0; i < n; i++) {
            step(dt / n, allowInput);
            if (i < n - 1) fx.discard();
          }
        } else step(0, allowInput);
        // Column-march cap also at ×1 right after travel (the tank decelerates, the sim checks the strategic speed).
        if (P && requested > 1) P.speed = Math.min(P.speed, cctx.speedCap);
      }
      forces.track(view, P ?? controller.ent, dtGame, effRate);
      trackShipHits();
      burnFires(freeze ? 0 : realDt);
      // --- Streaming and scenery ---
      if (P) {
        ground.update(P.pos.x, P.pos.z, P.vel.x, P.vel.z);
        const q = ctx.quality;
        scatter!.stream(ground, P.pos.x, P.pos.z, frame.offX, frame.offZ, kind === 'tank' ? 1600 : kind === 'jet' ? 9000 : 4500,
          kind === 'tank' ? 15 : kind === 'jet' ? 70 : 32, kind === 'tank' ? q.commandDetail : q.commandDetail * 0.4, kind === 'jet' ? 1.6 : 1, 2);
        grass?.update(P.pos, fr.time, frame.offX, frame.offZ);
        civil.update(view, P.pos.x, P.pos.z, now, fr.simAlpha);
        cctx.obstacles = civil.houseList.length ? [...scatter!.houseList, ...civil.houseList] : scatter!.houseList;
        const step2 = P.pos.distanceTo(prevPos);
        if (step2 < 5000) distanceM += step2;
        prevPos.copy(P.pos);
      }
      // --- Sim sync ---
      if (phase === 'play' || phase === 'dying') {
        sendMove(now);
        flushCasualties(now);
      }
      // The sim view's position of the controlled unit: count its changes per local second of driving (tools).
      {
        const uv = unitView();
        const key = uv ? `${uv.x.toFixed(5)},${uv.y.toFixed(5)}` : '';
        const cb = cadenceBucket();
        if (key !== cadViewKey) {
          cadViewKey = key;
          if (cb) cb.views++;
        }
      }
      if (now - lastForcesWall > 2000 && P && phase !== 'debrief') {
        lastForcesWall = now;
        forces.refresh(view, P, fr.simAlpha, false);
        // The unit's integrity may have changed in the sim (hits elsewhere): the formation follows (never grows).
        const uv = unitView();
        if (uv && uv.hp + 0.01 < integrity) integrity = uv.hp;
      }
      if (phase === 'play') {
        updateBorders(now);
        maybeRebase(contact);
      }
      // --- Camera ---
      if (phase === 'debrief') {
        const k = Math.min(1, phaseT / 4);
        const e = controller.ent;
        tmp2.copy(outroLook).sub(outroPos).setY(0);
        if (tmp2.lengthSq() < 1e-6) tmp2.set(0, 0, -1);
        tmp2.normalize();
        const back = kind === 'jet' ? 1800 : 420, up = kind === 'jet' ? 1300 : 260;
        tmp.copy(e.pos).addScaledVector(tmp2, -back);
        tmp.y += up;
        camera.position.copy(outroPos).lerp(tmp, easeInOutCubic(k) * 0.9);
        tmp.copy(e.pos).addScaledVector(tmp2, kind === 'jet' ? 1400 : 260);
        camera.lookAt(tmp.lerp(outroLook, 1 - easeInOutCubic(k)));
      } else if (travel && effRate >= 300 && P) {
        // High compression: the camera rises to 1–1.5 km behind the column and looks ahead.
        const fw = forwardOf(P.yaw, tmp2);
        const back = kind === 'jet' ? 2500 : kind === 'ship' ? 2200 : 1100, up = kind === 'jet' ? 900 : kind === 'ship' ? 900 : 1150;
        tmp.copy(P.pos).addScaledVector(fw, -back);
        tmp.y = Math.max(P.pos.y, ground.surfaceAt(tmp.x, tmp.z)) + up;
        if (!travelCamInit || !travelCam) {
          travelCamPos.copy(camera.position);
          travelCamInit = true;
        }
        travelCamPos.lerp(tmp, 1 - Math.exp(-2.5 * realDt));
        camera.position.copy(travelCamPos);
        tmp.copy(P.pos).addScaledVector(fw, kind === 'jet' ? 8000 : 3500);
        camera.lookAt(tmp);
        travelCam = true;
      } else {
        travelCam = false;
        controller.updateCamera(travel ? realDt : dtGame > 0 ? dtGame : realDt * 0);
        if (phase === 'intro') {
          introTo.copy(camera.position);
          introQTo.copy(camera.quaternion);
          const k = easeInOutCubic(Math.max(0, Math.min(1, (phaseT - introHold) / (introDur - introHold))));
          camera.position.copy(introFrom).lerp(introTo, k);
          camera.quaternion.copy(introQFrom).slerp(introQTo, k);
        }
      }
      // Lighter fog from high up (travel camera, jets).
      const camAgl = camera.position.y - ground.surfaceAt(camera.position.x, camera.position.z);
      const fd = fogBase * (camAgl > 300 ? Math.max(0.35, 1 - (camAgl - 300) / 1500) : 1);
      if (Math.abs(fd - fog.density) > fogBase * 0.02) applyAtmosphere(atmos, fd);
      applyShake(realDt);
      camera.updateMatrixWorld();
      // Night (#29b): own lights, illumination flares over the fighting.
      {
        const hN = P && kind !== 'jet' ? forces.nearestHostile(P.pos) : null;
        const cpos = hN?.ent && hN.dist < 4000 ? hN.ent.pos : null;
        night.update(freeze ? 0 : realDt, atmos, P && P.alive ? { pos: P.pos, yaw: P.yaw, kind } : null, cpos, fx, (x, z) => ground!.surfaceAt(x, z));
      }
      // The far crowd (soldiers handed over by a ground battle): scaled for this view, woken near the vehicle.
      world.updateCrowd(camera.position, P && P.alive ? P.pos : null, now);
      sky?.update(camera, fr.time);
      water?.update(camera, fr.time);
      fx.listener.copy(camera.position);
      placeShadowCamera();
      fx.flush();
      fx.ribbons.build(camera);
      lockBeeps(realDt);
      // --- HUD ---
      hud.update(freeze ? 0 : realDt, controller.hud, camera, world, localClock, Math.max(0, localSec - startSec), input.locked, realDt);
      if (now - lastInfoWall > 250) {
        lastInfoWall = now;
        updateInfo(now);
        updateHover();
      }
      const wpText = waypoint && P ? `${t('command.map.waypoint')} · ${formatNumber(Math.hypot(waypoint.x - P.pos.x, waypoint.z - P.pos.z) / 1000, 1)} km` : '';
      const labels: CivilLabel[] = borderNear && borderNear.distM < 4000 && P
        ? [...civil.labels, {
          x: borderNear.x, y: ground.surfaceAt(borderNear.x, borderNear.z) + 12, z: borderNear.z, text: t('command.label.border', { nation: nationName(borderNear.owner) }),
          sub: stateWord(borderNear.owner), kind: 'border' as const, color: colorCss(borderNear.owner), owner: borderNear.owner,
        }]
        : [...civil.labels];
      // The real units around you, named where they stand (the ones seen on the strategic map, owner feedback #21).
      for (const a of forces.realUnitAnchors()) {
        const uv = a.unitId ? view.units.get(a.unitId) : undefined;
        const name = a.qrf && !uv ? t('command.src.qrf', { nation: nationName(a.owner) }) : uv ? unitLabel(uv.type, uv.serial) : '';
        if (!name) continue;
        const tone = a.team === 0 ? 'own' as const : a.hostile ? 'hostile' as const : 'neutral' as const;
        labels.push({
          x: a.pos.x, y: a.pos.y + (kind === 'jet' ? 40 : 14), z: a.pos.z, text: name, sub: a.owner === HUMAN_ID ? '' : `${nationName(a.owner)} · ${stateWord(a.owner)}`,
          kind: 'force', tone, color: colorCss(a.owner), owner: a.owner,
        });
      }
      // The ground battle the player took control from, named where its line is (with how far it is).
      if (battleFocus) {
        const bp = frame.sceneOf(battleFocus.lat, battleFocus.lon, { x: 0, z: 0 });
        const f = battleFocus;
        labels.push({
          x: bp.x, y: ground.surfaceAt(bp.x, bp.z) + 60, z: bp.z, text: t('command.label.battle', { a: nationName(f.a), b: nationName(f.b) }),
          // (the overlay appends the distance, the same «a 15 km» as the notice and the HUD line)
          sub: t('command.label.battleSub', { n: formatNumber(world.soldiersNear(bp.x, bp.z, 6000)) }), kind: 'force', tone: 'hostile', color: colorCss(f.a === HUMAN_ID ? f.b : f.a), owner: f.a,
        });
      }
      overlay.update(realDt, camera, labels, waypoint, wpText, hover, kind);
      if (tacmap?.isOpen && now - lastMapWall > 500 && P) {
        lastMapWall = now;
        tacmap.draw(view, frame, ground, civil, P.pos, P.yaw, waypoint, params!.unitId);
      }
      input.endFrame();
      // --- Stats for tools (verifier, shots) ---
      if (fr.frame % 10 === 0 && P) {
        const ll = frame.latLonOfScene(P.pos.x, P.pos.z, { lat: 0, lon: 0 });
        const tp = tileOf(P.pos.x, P.pos.z);
        const inc = myIncursion();
        (window as unknown as { __cmdStats?: unknown }).__cmdStats = {
          kind, phase, lat: ll.lat, lon: ll.lon, x: tp.x, y: tp.y, heading: (LocalFrame.headingOfYaw(P.yaw) * 180) / Math.PI,
          speedKmh: P.speed * 3.6, alt: P.pos.y,
          hostiles: forces.log.hostiles, neutrals: forces.log.neutrals, friendlies: forces.log.friendlies, ents: world.ents.length,
          pools: forces.log, missingChunksAhead: ground.stats.missingAhead, chunkMsPerFrame: +ground.stats.chunkMsPerFrame.toFixed(2),
          chunkMsP95: +ground.p95().toFixed(2), chunksBuilt: ground.stats.built, nearBuilt: ground.stats.nearBuilt, workerMs: +ground.stats.workerMs.toFixed(1),
          chunkWorker: !ground.stats.mainThread, rate: effRate, requested, throttled, decision, clockMode: view.clock.mode, clockRate: view.clock.rate,
          localSec, simSec: view.command?.sec ?? -1, tick: view.tick, distanceM, waypointKm: waypoint ? Math.hypot(waypoint.x - P.pos.x, waypoint.z - P.pos.z) / 1000 : -1,
          autopilot, lastDrop, landOwner, border: borderNear, incursion: inc, integrity, formationAlive: formation.filter((m) => m.alive).length,
          vehiclesLost, moves: view.command?.moves ?? null, rebases: rebaseN, towns: civil.stats.towns, labels: civil.labels.length, civil: civil.stats,
          notice: overlay.noticeText, radio: overlay.radioText, info: overlay.infoText, dialog: overlay.dialogOpen, offX: frame.offX, offZ: frame.offZ,
          kills: world.stats.kills, killsBy: Object.fromEntries(killsBy), unitHitN, structHitN,
          soldiers: world.soldiersByNation(), handoff: forces.handoff ? Object.fromEntries(forces.handoff.counts) : null,
          alertRows: overlay.alertRows,
          combat: overlay.combatText, transit: overlay.transitText, transits: transits.map((x) => ({ ...x })),
          nearestHostileM: Math.round(forces.nearestHostile(P.pos).dist),
          night: +atmos.night.toFixed(2), vision: night.vision, lights: night.lightsOn, flares: night.flaresFired, fires: civil.fires.length,
          target: (() => {
            const c = chosenTarget();
            return c ? { kind: c.kind, km: +c.km.toFixed(2), title: targetTitle(c) } : null;
          })(),
        };
      }
    },
    resize(w, h) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      cctx.viewW = w;
      cctx.viewH = h;
      hud?.resize(w, h);
      overlay?.resize(w, h);
    },
    setQuality(q: QualityProfile) {
      sun.castShadow = q.shadows > 0;
      if (q.shadows > 0 && sun.shadow.mapSize.x !== q.shadows) {
        sun.shadow.mapSize.set(q.shadows, q.shadows);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
    },
  };
  // Important strategic alerts reach the command HUD and end time compression (§9.3, §9.11).
  const stripSeen = new Map<string, string>();
  ctx.bus.on('alert', (e) => {
    if (!active || !overlay) return;
    const a = e.input;
    if (a.severity !== 'warning' && a.severity !== 'danger' && a.severity !== 'critical') return;
    // The incursion of the unit you drive speaks on the radio panel instead (updateRadio).
    const own = a.kind === 'incursionResponse' && params && (a as { unitId?: number }).unitId === params.unitId;
    // The same news again while the sim has not moved (tactical time: minutes of local play can pass inside one tick)
    // is not news: it is not re-pushed (no «×16» climbing on a frozen situation).
    const key = `${a.groupKey ?? a.title}`;
    const sig = `${a.title}|${a.body ?? ''}|${ctx.sim.view.tick}`;
    if (stripSeen.get(key) === sig) return;
    stripSeen.set(key, sig);
    if (!own) overlay.pushAlert(a.severity, a.title, a.body ?? '');
    if (phase === 'transit') {
      // A march only stops for a critical alert (it runs on its own clock).
      if (a.severity === 'critical') transitAbort = true;
      return;
    }
    if (a.severity !== 'warning') dropToTactical('command.travel.alert');
  });
  void ENT_DEFS;
  return api;
}
