// FRONT ULTRA — subsystem API contracts (main thread).
// Owner: shared. Every subsystem implements exactly one of these interfaces through a factory
// `createX(ctx: GameContext): XApi` exported from its directory's index.ts (see ARCHITECTURE.md §3).
// Consumers may ONLY rely on what is declared here (plus shared/*). Owners may add extra exports for their
// own use, but other owners must not depend on them.

import type * as THREE from 'three';
import type { GameBus } from './events';
import type { PlayerCommand, SimDebugAction, TickUpdate } from './protocol';
import type { QualityProfile } from './quality';
import type { SettingsStore } from './settings';
import type {
  AllianceRequestView, AllianceView, AttackView, ClockView, CommandKind, Difficulty, FrontView, GameConfig, GamePhase,
  GameSpeed, LatLon, PairState, PlayerView, ScarView, SiegeView, StatsSample, StructureType, StructureView, Timelapse,
  UnitType, UnitView, WarView, WorldData, WorldEventView,
} from './types';

// =================================================================================================
// Frame & lifecycle
// =================================================================================================

export type AppState = 'boot' | 'loading' | 'menu' | 'setup' | 'spawn' | 'playing' | 'command' | 'ended';

export interface FrameInfo {
  /** performance.now() at frame start (ms). */
  now: number;
  /** Seconds since the previous frame, clamped to [0, 0.1]. */
  dt: number;
  /** Seconds since boot (real time, never pauses) — use for UI/idle animation. */
  time: number;
  frame: number;
  /**
   * World clock in seconds for the sun & anything tied to game time: in a session it is
   * config.startWorldTimeSec + interpolated sim time (stops when paused); on the menu it drifts slowly.
   */
  worldTime: number;
  /** Interpolation factor 0..1 between the previous and latest sim update (lerp prevX -> x). */
  simAlpha: number;
  /** Interpolated game seconds since the session started (0 outside sessions). */
  simTime: number;
  /** Game-time delta of this frame in seconds (0 when paused; dt * speed otherwise). */
  simDt: number;
  // --- v2 (W1): clocks for renderers (DESIGN_V2 §2.5) ---
  /** Interpolated game hours since the session started (tick / 10): the war clock and ETAs. */
  gameHours: number;
  /** Real seconds of this frame when the game is not paused, else 0: animation that looks the same at every speed. */
  visualDt: number;
}

export type ProgressFn = (fraction: number, label?: string) => void;

export interface Subsystem {
  /**
   * Heavy async setup during the loading screen: load/generate assets, create ALL materials and meshes
   * (so shaders can be compiled before the menu). Report progress 0..1. Called once, in parallel with
   * other subsystems' init (do not assume another subsystem finished init).
   */
  init(progress: ProgressFn): Promise<void>;
  /**
   * Shader warm-up: when on=true make every lazily-shown object visible (and in the frustum / frustumCulled=false)
   * so renderer.compileAsync() compiles its program; restore on on=false. Default: nothing to do.
   */
  warmup?(on: boolean): void;
  /** A game session started: ctx.sim.view has config/world; build per-game objects. */
  onGameStart?(): void;
  /** The session was torn down: remove/dispose every per-game object and listener. */
  onGameEnd?(): void;
  update(frame: FrameInfo): void;
  resize?(width: number, height: number, dpr: number): void;
  setQuality?(q: QualityProfile): void;
  dispose?(): void;
}

// =================================================================================================
// Sim client & game view (sim-core)
// =================================================================================================

export interface GameView {
  readonly config: GameConfig | null;
  readonly world: WorldData | null;
  readonly phase: GamePhase;
  readonly speed: GameSpeed;
  /** Latest applied tick. */
  readonly tick: number;
  /** 0..1 between the previous update and the next expected one. */
  readonly alpha: number;
  /** Interpolated game seconds since session start. */
  readonly simTime: number;
  /** Tile owners (TILE_COUNT), updated in place when updates are applied. */
  readonly owner: Uint16Array;
  /** Indexed by player id (holes are undefined). */
  readonly players: ReadonlyArray<PlayerView | undefined>;
  /** All players that ever existed, ordered by id. */
  readonly playerList: readonly PlayerView[];
  /** The human (id HUMAN_ID) or null before the session starts. */
  readonly human: PlayerView | null;
  readonly units: ReadonlyMap<number, UnitView>;
  readonly structures: ReadonlyMap<number, StructureView>;
  readonly attacks: readonly AttackView[];
  readonly fronts: readonly FrontView[];
  readonly scars: readonly ScarView[];
  readonly worldEvents: readonly WorldEventView[];
  readonly alliances: readonly AllianceView[];
  readonly allianceRequests: readonly AllianceRequestView[];
  /** 0..1 doomsday clock. */
  readonly doomsday: number;
  readonly spawnDeadlineTick: number;
  /** Winner id (0 = none yet). */
  readonly winner: number;
  /** Sampled every ~5 s of game time (end-screen graphs). */
  readonly history: readonly StatsSample[];
  readonly timelapse: Timelapse;
  ownerAt(tile: number): number;
  /** Current price for the human. */
  structureCost(type: StructureType): number;
  unitCost(type: UnitType): number;
  /** Worker-side ms for the last update's ticks (debug overlay). */
  readonly tickMs: number;
  // --- v2 (W1) ---
  /** The clock driving the world (mode, rate in game s per real s, tick period). */
  readonly clock: ClockView;
  /** Interpolated game hours since the session started (same as FrameInfo.gameHours). */
  readonly gameHours: number;
  /** Active wars, besieged pockets. */
  readonly wars: readonly WarView[];
  readonly sieges: readonly SiegeView[];
  /** Fronts by stable key. */
  readonly frontByKey: ReadonlyMap<number, FrontView>;
  /** Captured land still under occupation (72 h after capture, §4.13); the sim is the source of truth. */
  isOccupied(tile: number): boolean;
  occupiedCount(player: number): number;
  /** Pair state between two players ('peace' when none of war/truce applies). */
  pairState(a: number, b: number): PairState;
  /** The war between a and b (either side), or null. */
  warBetween(a: number, b: number): WarView | null;
}

export interface SimClientApi {
  readonly view: GameView;
  readonly running: boolean;
  /** Spawn the worker and start a session. Resolves once the worker is ready and the first update arrived. */
  start(config: GameConfig, world: WorldData): Promise<void>;
  /** Issue a command as the human (HUMAN_ID). */
  send(cmd: PlayerCommand): void;
  setSpeed(speed: GameSpeed): void;
  /** Run ticks as fast as possible (shots/playtests); resolves after the resync update was applied. */
  fastForward(ticks: number, onProgress?: ProgressFn): Promise<void>;
  /** Staging/debug action (shots, playtests). Applied immediately between ticks (also while paused). */
  debug(action: SimDebugAction): void;
  /** Apply buffered worker updates (called once per frame by app, first thing). Emits bus events. */
  pump(nowMs: number): void;
  /** Terminate the worker and reset the view. */
  stop(): void;
  // --- v2 (W1) ---
  /**
   * Request a clock mode (§2.2, §14.6): 'observation' from the camera altitude (focus = camera ground point, tile
   * coords), 'tactical' / 'travel' from command mode with a rate in game s per real s. Crisis is decided by the worker.
   */
  setClock(mode: 'strategic' | 'observation' | 'tactical' | 'travel', rate?: number, focus?: { x: number; y: number }, throttled?: boolean): void;
  /** Debug/measurement hook: called when an update ARRIVES from the worker (before the frame applies it). */
  onArrival: ((u: TickUpdate, atMs: number) => void) | null;
  /** The player's crisis / observation settings (the worker decides crisis time from them, §8.5). Kept across sessions. */
  setClockSettings(crisisTime: 'always' | 'mine' | 'off', observationTime: boolean): void;
  /** Serialise the running game (§12.8); resolves with the save blob. */
  save(): Promise<{ blob: ArrayBuffer; tick: number }>;
  /** Start a session from a save blob instead of a config (resolves once the restored world is shown). */
  load(blob: ArrayBuffer, world: WorldData): Promise<void>;
}

// =================================================================================================
// Render subsystems
// =================================================================================================

export interface CameraState {
  /** Point on the globe the camera looks at / orbits. */
  lat: number;
  lon: number;
  /** Camera altitude above the surface at the target, km (CAMERA_MIN_ALT_KM..CAMERA_MAX_ALT_KM). */
  altitudeKm: number;
  /** Radians: 0 = looking straight down, approaching PI/2 = looking at the horizon. */
  tilt: number;
  /** Radians: 0 = north up on screen, clockwise positive. */
  heading: number;
}

/** 'menu': slow auto-rotation, no input. 'game': player input. 'cinematic': scripted, no input. */
export type CameraMode = 'menu' | 'game' | 'cinematic';

export interface CameraRigApi extends Subsystem {
  /** The one strategic camera (same object as ctx.camera). */
  readonly camera: THREE.PerspectiveCamera;
  getState(out?: CameraState): CameraState;
  /** Jump immediately (shots, resets). */
  setState(s: Partial<CameraState>): void;
  /** Smooth cinematic flight; resolves on arrival. A newer flyTo cancels (resolves) the previous one. */
  flyTo(target: Partial<CameraState>, durationMs?: number): Promise<void>;
  shake(intensity: number, durationMs: number): void;
  setMode(mode: CameraMode): void;
  readonly mode: CameraMode;
  setInputEnabled(on: boolean): void;
}

export interface GlobeApi extends Subsystem {
  /** Root of every globe object in ctx.scene. */
  readonly root: THREE.Group;
  /** Tile under a screen point (client px), -1 when off-globe. Accounts for relief. */
  pickTile(clientX: number, clientY: number): number;
  pickLatLon(clientX: number, clientY: number, out?: LatLon): LatLon | null;
  /** Ground radius (world units) at lat/lon as rendered (== geo.surfaceRadius(sampleElevation)). */
  surfaceRadiusAt(lat: number, lon: number): number;
  /** Direction toward the sun this frame (world space, unit). */
  getSunDirection(out: THREE.Vector3): THREE.Vector3;
  /** Hover highlight (tile outline / owner glow), -1 = none. */
  setHoverTile(tile: number): void;
  /** Territory overlay opacity 0..1 (0 on the menu). */
  setTerritoryOpacity(v: number): void;
}

export interface PostApi extends Subsystem {
  /** Render a scene through the post pipeline to the screen (the ONLY way anything reaches the canvas). */
  render(scene: THREE.Scene, camera: THREE.Camera, frame: FrameInfo): void;
  /** Whiteout/colored flash (nukes). intensity 0..1+. */
  flash(intensity: number, durationMs: number, color?: number): void;
  /** Fade to/from black (0 = clear, 1 = black). Resolves when reached. */
  fadeTo(opacity: number, durationMs: number): Promise<void>;
  /** Extra exposure multiplier (1 = neutral), e.g. night-side dimming or command-mode grading. */
  setExposure(v: number): void;
}

export interface UnitsApi extends Subsystem {
  /** Unit under a screen point, -1 if none. */
  pickUnit(clientX: number, clientY: number): number;
  /** Structure under a screen point, -1 if none. */
  pickStructure(clientX: number, clientY: number): number;
  /** World position of a unit as rendered this frame (interpolated). false if unknown. */
  getUnitWorldPosition(unitId: number, out: THREE.Vector3): boolean;
  /**
   * The 2D icon under a screen point (DESIGN_V2 §10.7): a unit, a structure or a cluster of same-owner icons, null
   * when none within 14 px.
   */
  pickIcon?(clientX: number, clientY: number): IconPick | null;
  /** Spread a cluster's members around it so each can be clicked (closes on the next click elsewhere or after 8 s). */
  openIconFan?(hit: IconPick): void;
  closeIconFan?(): void;
}

export interface IconPick {
  kind: 'unit' | 'structure' | 'cluster';
  id: number;
  owner: number;
  members: number[];
  structure: boolean;
}

export type ExplosionKind = 'small' | 'medium' | 'large' | 'naval' | 'air';

export interface FxApi extends Subsystem {
  /** One-shot explosion on the globe surface. sizeKm ~ visual radius. */
  explosion(lat: number, lon: number, sizeKm: number, kind?: ExplosionKind): void;
  /** Tracer/projectile arc between two points (warship shells, SAM, artillery at strategic scale). */
  tracer(fromLat: number, fromLon: number, toLat: number, toLon: number, color?: number): void;
}

export interface BattleApi extends Subsystem {
  /** True while the ground battle layer is visible. */
  readonly active: boolean;
  /** 0..1 loudness/violence of what is on screen (audio uses it for the battle ambience). */
  readonly intensity: number;
}

// =================================================================================================
// Command mode
// =================================================================================================

export interface CommandEnterParams {
  unitId: number;
  unitType: UnitType;
  kind: CommandKind;
  lat: number;
  lon: number;
  tile: number;
  owner: number;
  /** Enemy player fought there (0 = none found: a training skirmish vs. nobody is not allowed; app picks one). */
  enemy: number;
  friendlyColor: number;
  enemyColor: number;
  friendlyTroops: number;
  enemyTroops: number;
  /** Deterministic seed for the local battlefield. */
  seed: number;
  worldTimeSec: number;
  difficulty: Difficulty;
}

export interface CommandResult {
  unitId: number;
  kind: CommandKind;
  enemy: number;
  tile: number;
  /** Strategic troops the player's kills are worth (already scaled). */
  troopsKilled: number;
  /** Strategic enemy unit ids destroyed (e.g. a warship sunk in a naval fight). */
  unitsDestroyed: number[];
  structuresDestroyed: number[];
  unitLost: boolean;
  durationSec: number;
}

export interface CommandApi extends Subsystem {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly active: boolean;
  /** Build the local battlefield for params and take input (pointer lock requested by the command owner). */
  enter(params: CommandEnterParams): Promise<void>;
  /** Tear down the battlefield, release input, return tallies. */
  exit(): CommandResult;
}

// =================================================================================================
// UI & audio
// =================================================================================================

export interface LoadingHandle {
  setProgress(fraction: number, label?: string): void;
  /**
   * Finish the loading screen. requireInput=true shows "press any key" and resolves on the first key/click
   * (this gesture also unlocks audio); false resolves right after the exit animation.
   */
  complete(requireInput: boolean): Promise<void>;
}

export interface UiApi extends Subsystem {
  /** Show the cinematic loading screen (called by app right after ui.init). */
  showLoading(): LoadingHandle;
  /** App state changed: show the matching screen (menu, setup, spawn HUD, HUD, command, end). */
  setState(state: AppState, prev: AppState): void;
  /**
   * Screen rectangles (client px) covered by visible HUD panels right now, so world overlays (nation labels) can stay
   * clear of them (DESIGN_V2 §10.10). Cheap to call every frame (refreshed at most 4 times a second).
   */
  getOccludedRects(): readonly DOMRect[];
}

export type SfxCue =
  | 'explosionSmall' | 'explosionLarge' | 'artillery' | 'gunfire' | 'tankEngine' | 'tankCannon' | 'jetFlyby'
  | 'jetCannon' | 'missileLaunch' | 'nukeLaunch' | 'nukeDetonation' | 'siren' | 'shipHorn' | 'navalGun'
  | 'build' | 'upgrade' | 'capture' | 'alliance' | 'betrayal' | 'eliminated' | 'coins' | 'earthquake'
  | 'thunder' | 'radar' | 'samLaunch' | 'victory' | 'defeat';

export type MusicMood = 'menu' | 'calm' | 'tension' | 'war' | 'nuclear' | 'command' | 'victory' | 'defeat' | 'silence';

export interface AudioApi extends Subsystem {
  readonly unlocked: boolean;
  /** Resume the AudioContext (must be called from a user gesture; app does it on the first input). */
  unlock(): Promise<void>;
  play(cue: SfxCue, gain?: number): void;
  /** Positional cue on the globe (attenuated by camera distance). */
  playAt(cue: SfxCue, lat: number, lon: number, gain?: number): void;
  setMood(mood: MusicMood): void;
  /** Momentary global duck (0 = silence .. 1 = normal), e.g. nuke silence-then-roar. */
  duck(level: number, holdMs: number, releaseMs: number): void;
}

// =================================================================================================
// App controller & shots
// =================================================================================================

export interface ScriptedGameOptions {
  seed?: number;
  aiCount?: number;
  tribeCount?: number;
  difficulty?: Difficulty;
  /** Where the human's capital goes (default Madrid). null = no human spawn (stay in spawn phase). */
  humanSpawn?: LatLon | null;
  /** Ticks to fast-forward after the spawn phase (0 = none). */
  ticks?: number;
  /** Keep the session in the spawn phase (spawn shot). */
  stayInSpawn?: boolean;
  /** Speed after staging (default 1; 0 freezes the scene for screenshots). */
  speed?: GameSpeed;
  /** World time (sun position) at the END of staging, i.e. the lighting you capture. Default: noon at 20°E. */
  worldTimeSec?: number;
  playerName?: string;
  playerColor?: number;
  nukes?: boolean;
  worldEvents?: boolean;
  /** Let the AI play the human during/after fast-forward (default true) so the human is alive & sizeable. */
  autopilot?: boolean;
  /** Radius in tiles of land granted around the human capital before fast-forward (default 18, 0 = none),
   *  plus a troop/gold bonus, so staged scenes always show a sizeable human nation. */
  headStart?: number;
}

export interface AppController {
  readonly state: AppState;
  readonly isShot: boolean;
  /** menu <-> setup navigation. */
  goto(state: 'menu' | 'setup'): void;
  /** setup -> spawn: starts the sim with config (UI builds it from the setup form). */
  startGame(config: GameConfig): Promise<void>;
  /** Deterministic session for shots & playtests (fixed seed, auto spawn, optional fast-forward). */
  startScriptedGame(opts: ScriptedGameOptions): Promise<void>;
  /** playing -> command: dive into the unit (must be the human's tank/jet/ship). */
  enterCommandMode(unitId: number): Promise<void>;
  /** command -> playing: climb back to orbit, apply results. */
  exitCommandMode(): Promise<void>;
  /** Any in-game state -> menu. */
  returnToMenu(): void;
  setSpeed(speed: GameSpeed): void;
  togglePause(): void;
  /** Build a GameConfig from defaults + settings.setup + overrides. */
  makeConfig(overrides?: Partial<GameConfig>): GameConfig;
}

// =================================================================================================
// Context
// =================================================================================================

export interface GameContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  /** The strategic world scene (globe, units, fx, battle). Command mode has its own scene. */
  readonly scene: THREE.Scene;
  /** The strategic camera (driven by cameraRig). */
  readonly camera: THREE.PerspectiveCamera;
  readonly bus: GameBus;
  readonly settings: SettingsStore;
  /** Current quality profile (replaced on change; listen to 'qualityChanged'). */
  readonly quality: QualityProfile;
  /** DOM root for all UI (above the canvas). */
  readonly uiRoot: HTMLElement;
  /** Loaded world (null until the loading screen finished the data step). */
  readonly world: WorldData | null;
  /** Latest frame info. */
  readonly frame: FrameInfo;

  readonly app: AppController;
  readonly sim: SimClientApi;
  readonly globe: GlobeApi;
  readonly cameraRig: CameraRigApi;
  readonly post: PostApi;
  readonly units: UnitsApi;
  readonly fx: FxApi;
  readonly battle: BattleApi;
  readonly command: CommandApi;
  readonly ui: UiApi;
  readonly audio: AudioApi;
}
