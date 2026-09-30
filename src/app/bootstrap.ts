// FRONT ULTRA — application bootstrap, state machine and frame loop (owner: app).
// See ARCHITECTURE.md §4 (state machine) and §5 (frame loop). This file wires every subsystem together;
// subsystems never create each other.

import * as THREE from 'three';
import type {
  AppController, AppState, CommandEnterParams, CommandGoal, FrameInfo, GameContext, ScriptedGameOptions, Subsystem,
} from '../shared/api';
import {
  DEFAULT_START_WORLD_TIME, HUMAN_ID, MAP_H, MAP_W, MENU_WORLD_TIME_SCALE, OBSERVATION_ENTER_KM, OBSERVATION_LEAVE_KM, TICK_MS, UNIT_DEFS,
} from '../shared/constants';
import { EventBus, type GameEvents } from '../shared/events';
import { latLonToTile, tileAtXY, tileToLatLon, tileX, tileXYToLatLon, tileY, worldTimeForSubsolarLon, wrapX } from '../shared/geo';
import { deriveLocalForces } from '../shared/localForces';
import { setLanguage, t } from '../shared/i18n';
import { tileKm as tileKmXY } from '../command/goto';
import { UNIT_ORDER_KINDS, UnitMode, UnitState, UnitType } from '../shared/types';
import { qualityProfile, type QualityProfile } from '../shared/quality';
import { hashString } from '../shared/rng';
import { createSettingsStore } from '../shared/settings';
import { runShotFromUrl, shotNameFromUrl } from '../shared/shots';
import { isPlayableTerrain } from '../shared/terrain';
import type { GameConfig, GameSpeed, WorldData } from '../shared/types';
import { loadWorldData } from '../data';
import { createSimClient } from '../sim/client';
import { createCameraRig } from '../render/camera';
import { createGlobe } from '../render/globe';
import { createPostPipeline } from '../render/post';
import { createUnitsRenderer } from '../render/units';
import { createFx } from '../render/fx';
import { createBattleRenderer } from '../render/battle';
import { createCommandMode } from '../command';
import { createUi } from '../ui';
import { createAudio } from '../audio';
import { createInputRouter } from './input';
import { createWorldFx } from './worldfx';
import { installProbes } from './probes';
import { installLocalForcesProbe } from './localForcesProbe';
import { installAutosave } from './autosave';
import { registerAllShots } from './shots';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MADRID = { lat: 40.42, lon: -3.7 };

export async function bootstrap(): Promise<void> {
  const host = document.getElementById('app') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  host.appendChild(canvas);
  const uiRoot = document.createElement('div');
  uiRoot.id = 'ui';
  host.appendChild(uiRoot);

  const settings = createSettingsStore();
  setLanguage(settings.get().language);
  const quality = qualityProfile(settings.get().quality);
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, stencil: false, depth: true, powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  const bus = new EventBus<GameEvents>();
  const scene = new THREE.Scene();
  scene.name = 'world';
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.001, 200);
  const frame: FrameInfo = {
    now: performance.now(), dt: 0, time: 0, frame: 0, worldTime: DEFAULT_START_WORLD_TIME, simAlpha: 1, simTime: 0, simDt: 0,
    gameHours: 0, visualDt: 0,
  };
  const isShot = shotNameFromUrl() !== null;

  let state: AppState = 'boot';
  const ctx = { renderer, canvas, scene, camera, bus, settings, quality, uiRoot, world: null, frame } as unknown as Mutable<GameContext>;

  // ---------------------------------------------------------------------------------------------
  // App controller
  // ---------------------------------------------------------------------------------------------
  const app: AppController = {
    get state() {
      return state;
    },
    isShot,
    goto(s) {
      if (s === 'menu' && state !== 'setup') return app.returnToMenu();
      setState(s);
    },
    async startGame(config) {
      if (!ctx.world) throw new Error('world not loaded');
      if (ctx.sim.running) teardownSession();
      const cs = settings.get();
      ctx.sim.setClockSettings(cs.crisisTime ?? 'always', cs.observationTime ?? true);
      await ctx.sim.start(config, ctx.world);
      for (const s of systems) s.onGameStart?.();
      bus.emit('gameStarted', { config });
      ctx.globe.setTerritoryOpacity(1);
      ctx.cameraRig.setMode('game');
      const phase = ctx.sim.view.phase;
      setState(phase === 'playing' ? 'playing' : 'spawn');
      // Spawn view (DESIGN_V2 §10.13): Europe and Africa from 12,000 km, in daylight (the sun starts at noon there).
      if (!isShot) void ctx.cameraRig.flyTo({ lat: 35, lon: 15, altitudeKm: 12_000, tilt: 0, heading: 0 }, 1500);
    },
    async startScriptedGame(opts: ScriptedGameOptions) {
      const world = ctx.world;
      if (!world) throw new Error('world not loaded');
      const spawnAt = opts.humanSpawn === undefined ? MADRID : opts.humanSpawn;
      const config = app.makeConfig({
        seed: opts.seed ?? 1337,
        aiCount: opts.aiCount ?? 24,
        tribeCount: opts.tribeCount ?? 40,
        difficulty: opts.difficulty ?? 'normal',
        speed: 1,
        nukes: opts.nukes ?? true,
        worldEvents: opts.worldEvents ?? true,
        // Lighting is specified for the end of the fast-forward: rewind the clock by the staged ticks.
        startWorldTimeSec: (opts.worldTimeSec ?? DEFAULT_START_WORLD_TIME) - ((opts.ticks ?? 0) * TICK_MS) / 1000,
        autoSpawnTile: spawnAt ? nearestPlayable(world, latLonToTile(spawnAt.lat, spawnAt.lon)) : -1,
        instantStart: !opts.stayInSpawn,
        humanAutopilot: opts.autopilot ?? true,
        spawnTimeoutTicks: opts.stayInSpawn ? 1e9 : 600,
        ...(opts.playerName ? { playerName: opts.playerName } : {}),
        ...(opts.playerColor !== undefined ? { playerColor: opts.playerColor } : {}),
      });
      await app.startGame(config);
      if (!opts.stayInSpawn && spawnAt) {
        if (ctx.sim.view.phase !== 'playing') await bus.wait('phaseChanged', (e) => e.phase === 'playing');
        const head = opts.headStart ?? 18;
        if (head > 0) {
          ctx.sim.debug({ type: 'conquer', playerId: HUMAN_ID, centerTile: config.autoSpawnTile, radius: head });
          ctx.sim.debug({ type: 'addTroops', playerId: HUMAN_ID, amount: 60_000 });
          ctx.sim.debug({ type: 'addGold', playerId: HUMAN_ID, amount: 2_000_000 });
        }
        if (opts.ticks && opts.ticks > 0) await ctx.sim.fastForward(opts.ticks);
      }
      ctx.sim.setSpeed(opts.speed ?? 1);
    },
    async enterCommandMode(unitId, goal) {
      if (state !== 'playing' || ctx.command.active) return;
      const u0 = ctx.sim.view.units.get(unitId);
      if (!u0 || u0.owner !== HUMAN_ID || !UNIT_DEFS[u0.type].command || !(u0.hp > 0)) {
        bus.emit('uiSound', { kind: 'error' });
        return;
      }
      // v2 (§9.2): the unit stops where it is in the sim first; the local scene is then built exactly there.
      ctx.sim.send({ type: 'unitControl', unitId, controlled: true });
      await waitSimUpdate(600);
      const params = commandParams(unitId, goal);
      if (!params) {
        ctx.sim.send({ type: 'unitControl', unitId, controlled: false });
        bus.emit('uiSound', { kind: 'error' });
        return;
      }
      ctx.cameraRig.setMode('cinematic');
      input.setEnabled(false);
      // From a visible ground battle the view stays on the battle: command mode's first view is this one (§9.6), and
      // it glides from there down to the unit. Otherwise the camera dives to the unit first.
      // Taken at a distant action (#26): no dive to the unit; the march to the action starts behind the fade.
      const far = !!params.goal && tileKmXY(params.x ?? 0, params.y ?? 0, params.goal.x, params.goal.y) > 12;
      if (!params.battleHandoff?.camera && !far) await ctx.cameraRig.flyTo({ lat: params.lat, lon: params.lon, altitudeKm: 3, tilt: 1.2 }, isShot ? 1 : 2200);
      await ctx.post.fadeTo(1, isShot ? 1 : 350);
      await ctx.command.enter(params);
      setState('command');
      bus.emit('commandEnter', { params });
      await ctx.post.fadeTo(0, isShot ? 1 : 500);
    },
    async enterCommandAt(target) {
      if (state !== 'playing' || ctx.command.active) return false;
      const id = unitForAction(target);
      if (!id) {
        bus.emit('uiSound', { kind: 'error' });
        bus.emit('toast', { text: t('command.at.none', { place: target.label }), kind: 'warning', durationMs: 4200 });
        return false;
      }
      // A whole front: the point of its line nearest the chosen unit (the offensive's contact when one is given).
      let gx = target.x, gy = target.y;
      const f = target.frontKey && !target.attackId ? ctx.sim.view.frontByKey.get(target.frontKey) : undefined;
      const u = ctx.sim.view.units.get(id);
      if (f && u) {
        let bd = Infinity;
        for (let i = 0; i + 1 < f.samples.length; i += 2) {
          const d = tileKmXY(u.x, u.y, f.samples[i], f.samples[i + 1]);
          if (d < bd) {
            bd = d;
            gx = f.samples[i];
            gy = f.samples[i + 1];
          }
        }
      }
      await app.enterCommandMode(id, { x: gx, y: gy, label: target.label });
      return true;
    },
    async exitCommandMode() {
      if (state !== 'command') return;
      await ctx.post.fadeTo(1, 300);
      // The speed chosen before command mode comes back (tactical time was only a clock mode).
      ctx.sim.setClock('strategic');
      const result = ctx.command.exit();
      // v2 (§9.8): kills, damage, losses and the position were synced while playing; release the unit. It stays
      // exactly where it was left, holding (a jet orbits the spot): owner feedback #18. An incursion goes on.
      if (!result.unitLost) ctx.sim.send({ type: 'unitControl', unitId: result.unitId, controlled: false });
      setState('playing');
      bus.emit('commandExit', { result });
      // Climb to 2,500 km above the unit's new position. The climb starts, still behind the fade, from 60 km above
      // it looking down: the camera left at the entry pose (3 km, tilted, where a ground battle had cut its hole in
      // the globe) would show one frame of black void. The fade lifts after the globe has rendered that pose.
      const u = ctx.sim.view.units.get(result.unitId);
      const at = u ? tileXYToLatLon(u.x, u.y) : null;
      if (at) {
        const cam = ctx.cameraRig.getState();
        ctx.cameraRig.setState({ ...cam, lat: at.lat, lon: at.lon, altitudeKm: 60, tilt: 0.3 });
      }
      await Promise.race([waitFrames(3), new Promise<void>((r) => setTimeout(r, 5000))]);
      await ctx.post.fadeTo(0, 400);
      // Feedback 3 (#29e): the strategic camera ends looking at the place of the action (the unit's new position), close
      // enough to read the front there, instead of a continental view.
      await ctx.cameraRig.flyTo(at ? { lat: at.lat, lon: at.lon, altitudeKm: EXIT_ALT_KM, tilt: 0.45 } : { altitudeKm: EXIT_ALT_KM, tilt: 0.45 }, 2000);
      ctx.cameraRig.setMode('game');
      input.setEnabled(true);
    },
    async loadGame(blob: ArrayBuffer) {
      if (!ctx.world) throw new Error('world not loaded');
      if (ctx.sim.running) teardownSession();
      await ctx.sim.load(blob, ctx.world);
      const config = ctx.sim.view.config ?? app.makeConfig();
      for (const s of systems) s.onGameStart?.();
      bus.emit('gameStarted', { config });
      ctx.globe.setTerritoryOpacity(1);
      ctx.cameraRig.setMode('game');
      setState('playing');
      const cap = ctx.sim.view.human?.capitalTile ?? -1;
      if (cap >= 0) {
        const ll = tileToLatLon(cap);
        void ctx.cameraRig.flyTo({ lat: ll.lat, lon: ll.lon, altitudeKm: 4000, tilt: 0, heading: 0 }, 1200);
      }
    },
    returnToMenu() {
      teardownSession();
      setState('menu');
    },
    setSpeed(speed: GameSpeed) {
      ctx.sim.setSpeed(speed);
    },
    togglePause() {
      if (ctx.sim.view.speed === 0) ctx.sim.setSpeed(lastSpeed || 1);
      else {
        lastSpeed = ctx.sim.view.speed;
        ctx.sim.setSpeed(0);
      }
    },
    makeConfig(overrides: Partial<GameConfig> = {}): GameConfig {
      const s = settings.get().setup;
      return {
        seed: (Date.now() ^ hashString(s.playerName)) >>> 0,
        playerName: s.playerName,
        playerColor: s.playerColor,
        difficulty: s.difficulty,
        aiCount: s.aiCount,
        tribeCount: s.tribeCount,
        speed: s.speed,
        nukes: s.nukes,
        worldEvents: s.worldEvents,
        duration: s.duration ?? 'normal',
        // Noon over the spawn view (§10.13).
        startWorldTimeSec: worldTimeForSubsolarLon(15),
        // §12.6: single player waits for the human to found its capital (no random auto-spawn).
        spawnTimeoutTicks: 0,
        autoSpawnTile: -1,
        instantStart: false,
        humanAutopilot: false,
        ...overrides,
      };
    },
  };
  let lastSpeed: GameSpeed = 1;
  /** Strategic camera altitude after command mode: the place of the action with its front readable (#29e). */
  const EXIT_ALT_KM = 900;

  // ---------------------------------------------------------------------------------------------
  // Subsystems (constructed in dependency-free order; they may only call each other from init/update)
  // ---------------------------------------------------------------------------------------------
  ctx.app = app;
  ctx.sim = createSimClient(bus);
  ctx.cameraRig = createCameraRig(ctx);
  ctx.post = createPostPipeline(ctx);
  ctx.globe = createGlobe(ctx);
  ctx.units = createUnitsRenderer(ctx);
  ctx.fx = createFx(ctx);
  ctx.battle = createBattleRenderer(ctx);
  ctx.command = createCommandMode(ctx);
  ctx.audio = createAudio(ctx);
  ctx.ui = createUi(ctx);
  const input = createInputRouter(ctx);
  const worldFx = createWorldFx(ctx);
  const systems: Subsystem[] = [ctx.cameraRig, ctx.post, ctx.globe, ctx.units, ctx.fx, ctx.battle, worldFx, ctx.command, ctx.audio, ctx.ui];
  const frontHook: Record<string, unknown> = { ctx, app };
  (window as unknown as { __front: unknown }).__front = frontHook;
  installProbes(ctx, frontHook);
  installLocalForcesProbe(ctx);
  registerAllShots();

  function setState(next: AppState): void {
    if (next === state) return;
    const prev = state;
    state = next;
    input.setEnabled(next === 'spawn' || next === 'playing');
    if (next === 'menu') {
      ctx.cameraRig.setMode('menu');
      ctx.globe.setTerritoryOpacity(0);
      ctx.audio.setMood('menu');
    } else if (next === 'playing') ctx.audio.setMood('calm');
    else if (next === 'command') ctx.audio.setMood('command');
    ctx.ui.setState(next, prev);
    bus.emit('appState', { state: next, prev });
  }

  function teardownSession(): void {
    if (ctx.command.active) ctx.command.exit();
    ctx.sim.stop();
    for (const s of systems) s.onGameEnd?.();
    bus.emit('gameTornDown', {});
    ctx.globe.setTerritoryOpacity(0);
    ctx.cameraRig.setMode('menu');
  }

  function nearestPlayable(world: WorldData, tile: number): number {
    if (isPlayableTerrain(world.terrain[tile])) return tile;
    const x0 = tileX(tile), y0 = tileY(tile);
    for (let r = 1; r < 60; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const y = y0 + dy;
          if (y < 0 || y >= world.height) continue;
          const t = y * world.width + wrapX(x0 + dx);
          if (isPlayableTerrain(world.terrain[t])) return t;
        }
      }
    }
    return tile;
  }

  /**
   * v2 (W5, §9.2): the entry into command mode at the unit's real, interpolated position and heading. `enemy` is only
   * the main foreign nation of the place (0 is the normal case at peace in your own land): everything the local scene
   * shows comes from the simulation there (src/shared/localForces.ts), never from this.
   */
  /** Resolves on the next sim update (or after `ms`). */
  function waitSimUpdate(ms: number): Promise<void> {
    const t0 = ctx.sim.view.tick;
    const w0 = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        if (ctx.sim.view.tick !== t0 || performance.now() - w0 > ms) resolve();
        else setTimeout(check, 30);
      };
      setTimeout(check, 120);
    });
  }

  /**
   * Feedback 3 (#26): the own unit that should take the player to an action. A division first (the ground fight is
   * where the action is): one engaged there (joined to that offensive, attached to that front, or already within
   * 40 km), else the nearest free one; a fighter squadron for an air target; a warship for a sea target.
   */
  function unitForAction(target: { x: number; y: number; frontKey?: number; attackId?: number; kind?: 'tank' | 'jet' | 'ship' }): number {
    const view = ctx.sim.view;
    const want = target.kind ?? 'tank';
    let best = 0, bestScore = Infinity;
    for (const u of view.units.values()) {
      if (u.owner !== HUMAN_ID || UNIT_DEFS[u.type].command !== want || !(u.hp > 0) || u.state === UnitState.Controlled) continue;
      if (want === 'jet' && u.type !== UnitType.FighterSquadron) continue;
      const km = tileKmXY(u.x, u.y, target.x, target.y);
      const order = u.order >= 0 ? UNIT_ORDER_KINDS[u.order] : '';
      let score = km;
      if (target.attackId && order === 'join' && u.mission === target.attackId) score *= 0.2;
      else if (target.frontKey && u.frontKey === target.frontKey && (u.mode === UnitMode.Front || u.mode === UnitMode.Offensive)) score *= 0.35;
      // A healthier unit is worth a detour of a few km.
      score *= 1.3 - 0.3 * u.hp;
      if (score < bestScore) {
        bestScore = score;
        best = u.id;
      }
    }
    return best;
  }

  function commandParams(unitId: number, goal?: CommandGoal): CommandEnterParams | null {
    const view = ctx.sim.view;
    const u = view.units.get(unitId);
    if (!u || u.owner !== HUMAN_ID) return null;
    const kind = UNIT_DEFS[u.type].command;
    if (!kind || !(u.hp > 0)) return null;
    // The unit is under control (frozen in the sim): its latest position is where it really is.
    const x = u.x, y = u.y;
    const ll = tileXYToLatLon(x, y);
    const tile = tileAtXY(x, y);
    const lf = deriveLocalForces(view, x, y, kind === 'jet' ? 150 : 30, HUMAN_ID);
    const fr = lf.fronts[0];
    const frontFoe = fr && fr.nearest.distKm < 30 ? (fr.a === HUMAN_ID ? fr.b : fr.b === HUMAN_ID ? fr.a : 0) : 0;
    const here = lf.point.owner !== HUMAN_ID ? lf.point.owner || lf.point.coastOwner : 0;
    const enemy = frontFoe || here || 0;
    const context: CommandEnterParams['context'] = kind === 'jet' ? 'air' : kind === 'ship' ? 'sea'
      : frontFoe ? 'front' : lf.point.relation === 'war' ? 'enemyLand' : lf.owners.some((o) => o.owner !== HUMAN_ID && o.owner > 0) ? 'border' : 'peace';
    const me = view.human!;
    const foe = enemy ? view.players[enemy] : undefined;
    const integrity = Math.max(0.01, Math.min(1, u.hp));
    const formation = kind === 'tank' ? Math.max(1, Math.ceil(integrity * 4 - 1e-6)) : kind === 'jet' ? Math.max(1, Math.ceil(integrity * 3 - 1e-6)) : 1;
    // Entered from a visible ground battle: the battle layer hands over what it was showing (§9.6).
    const handoff = ctx.battle.active ? ctx.battle.handoff?.() ?? undefined : undefined;
    return {
      unitId, unitType: u.type, kind, lat: ll.lat, lon: ll.lon, tile, owner: HUMAN_ID, enemy,
      friendlyColor: me.color, enemyColor: foe?.color ?? 0xcc3333, friendlyTroops: me.troops, enemyTroops: foe?.troops ?? 0,
      seed: hashString(`${view.config?.seed ?? 0}:${unitId}:${view.tick}`), worldTimeSec: frame.worldTime,
      difficulty: view.config?.difficulty ?? 'normal', heading: u.heading, x, y, integrity, formation, alt: u.alt, context,
      ...(handoff ? { battleHandoff: handoff } : {}),
      ...(goal ? { goal } : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Bus wiring
  // ---------------------------------------------------------------------------------------------
  bus.on('phaseChanged', (e) => {
    if (e.phase === 'playing' && state === 'spawn') {
      setState('playing');
      const cap = ctx.sim.view.human?.capitalTile ?? -1;
      if (cap >= 0 && !isShot) {
        const ll = tileToLatLon(cap);
        void ctx.cameraRig.flyTo({ lat: ll.lat, lon: ll.lon, altitudeKm: 4500, tilt: 0.25 }, 2000);
      }
    }
  });
  bus.on('gameOver', (e) => {
    bus.emit('gameEnded', { winner: e.winner, humanWon: e.winner === HUMAN_ID, reason: e.reason });
    if (state === 'command') void app.exitCommandMode().then(() => setState('ended'));
    else setState('ended');
  });
  bus.on('commandExitRequested', () => void app.exitCommandMode());

  settings.subscribe((s, changed) => {
    if (changed.includes('language')) {
      setLanguage(s.language);
      bus.emit('languageChanged', { lang: s.language });
    }
    if (changed.includes('quality')) applyQuality(qualityProfile(s.quality));
    if (changed.includes('crisisTime') || changed.includes('observationTime')) {
      ctx.sim.setClockSettings(s.crisisTime ?? 'always', s.observationTime ?? true);
    }
    bus.emit('settingsChanged', { settings: s, changed });
  });

  function applyQuality(q: QualityProfile): void {
    ctx.quality = q;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap));
    onResize();
    for (const s of systems) s.setQuality?.(q);
    bus.emit('qualityChanged', { quality: q });
  }

  function onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    const dpr = renderer.getPixelRatio();
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const s of systems) s.resize?.(w, h, dpr);
    bus.emit('resize', { width: w, height: h, dpr });
  }
  window.addEventListener('resize', onResize);

  const unlockAudio = () => {
    if (isShot) return;
    void ctx.audio.unlock();
  };
  window.addEventListener('pointerdown', unlockAudio);
  // HUD buttons must not keep keyboard focus: Space/Enter would re-activate the last clicked button on top of
  // the gameplay hotkey (e.g. Space = pause would also buy the unit you clicked last).
  window.addEventListener('click', (e) => {
    const el = e.target instanceof Element ? e.target.closest('button') : null;
    if (el && uiRoot.contains(el)) el.blur();
  });
  window.addEventListener('keydown', unlockAudio);

  // ---------------------------------------------------------------------------------------------
  // Frame loop
  // ---------------------------------------------------------------------------------------------
  let fpsAcc = 0, fpsFrames = 0;
  const frameWaiters: { n: number; resolve: () => void }[] = [];
  function loop(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - frame.now) / 1000));
    frame.now = now;
    frame.dt = dt;
    frame.time += dt;
    frame.frame++;
    ctx.sim.pump(now);
    const view = ctx.sim.view;
    const inSession = view.phase !== 'none';
    const prevSimTime = frame.simTime;
    frame.simAlpha = view.alpha;
    frame.simTime = inSession ? view.simTime : 0;
    frame.simDt = inSession ? Math.max(0, frame.simTime - prevSimTime) : 0;
    frame.gameHours = inSession ? view.gameHours : 0;
    frame.visualDt = inSession && view.clock.rate <= 0 ? 0 : dt;
    frame.worldTime = inSession
      ? (view.config?.startWorldTimeSec ?? DEFAULT_START_WORLD_TIME) + frame.simTime
      : frame.worldTime + dt * MENU_WORLD_TIME_SCALE;
    input.update();

    if (state === 'command') {
      ctx.command.update(frame);
      ctx.audio.update(frame);
      ctx.ui.update(frame);
      ctx.post.update(frame);
      ctx.post.render(ctx.command.scene, ctx.command.camera, frame);
    } else {
      ctx.cameraRig.update(frame);
      ctx.globe.update(frame);
      ctx.units.update(frame);
      ctx.fx.update(frame);
      ctx.battle.update(frame);
      worldFx.update(frame);
      ctx.audio.update(frame);
      ctx.ui.update(frame);
      ctx.post.update(frame);
      ctx.post.render(scene, camera, frame);
    }

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc >= 1) {
      window.__fps = Math.round(fpsFrames / fpsAcc);
      fpsAcc = 0;
      fpsFrames = 0;
    }
    for (let i = frameWaiters.length - 1; i >= 0; i--) {
      if (--frameWaiters[i].n <= 0) {
        frameWaiters[i].resolve();
        frameWaiters.splice(i, 1);
      }
    }
  }
  const waitFrames = (n: number) => new Promise<void>((resolve) => frameWaiters.push({ n, resolve }));

  // ---------------------------------------------------------------------------------------------
  // v2 (W1): observation time (§2.2) — looking closely slows the whole world down. Below 60 km of camera altitude the
  // worker runs the world at 1 game minute per real second (0.5 s ramp); above 85 km it returns to the chosen speed.
  // The camera's ground point is the focus where fronts publish their sub-tile progress (§11.5).
  // ---------------------------------------------------------------------------------------------
  let observing = false;
  let focusSentAt = 0;
  let focusX = -1, focusY = -1;
  const camState = { lat: 0, lon: 0, altitudeKm: 0, tilt: 0, heading: 0 };
  // Checked on a 100 ms timer rather than per frame: the camera state is set immediately on input, and a slow frame
  // must not delay the clock change.
  setInterval(() => updateObservationClock(performance.now()), 100);
  // v2 (§12.8): autosave every game day, at most once per 60 real seconds.
  installAutosave(ctx);
  function updateObservationClock(now: number): void {
    const view = ctx.sim.view;
    const eligible = state === 'playing' && view.phase === 'playing';
    if (!eligible) {
      if (observing) {
        observing = false;
        if (state !== 'command') ctx.sim.setClock('strategic');
      }
      return;
    }
    ctx.cameraRig.getState(camState);
    const alt = camState.altitudeKm;
    const want = observing ? alt < OBSERVATION_LEAVE_KM : alt < OBSERVATION_ENTER_KM;
    const fx = ((camState.lon + 180) / 360) * MAP_W, fy = ((90 - camState.lat) / 180) * MAP_H;
    if (want !== observing) {
      observing = want;
      focusX = fx;
      focusY = fy;
      focusSentAt = now;
      if (want) ctx.sim.setClock('observation', undefined, { x: fx, y: fy });
      else ctx.sim.setClock('strategic');
    } else if (observing && now - focusSentAt > 500 && Math.hypot(fx - focusX, fy - focusY) > 0.5) {
      focusX = fx;
      focusY = fy;
      focusSentAt = now;
      ctx.sim.setClock('observation', undefined, { x: fx, y: fy });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Boot -> loading -> menu
  // ---------------------------------------------------------------------------------------------
  await ctx.ui.init(() => undefined);
  const loading = ctx.ui.showLoading();
  setState('loading');
  onResize();
  renderer.setAnimationLoop(loop);

  const weights = { data: 0.3, globe: 0.3, others: 0.2, compile: 0.2 };
  const prog = { data: 0, globe: 0, others: 0, compile: 0 };
  // The status line follows the real pipeline: satellite download/decode and grid/country build (data worker),
  // then the globe's own textures, the remaining subsystems, and finally shader compilation.
  let dataLabel = 'data.download';
  let compiling = false;
  const report = () => {
    const label = compiling ? 'loading.shaders'
      : prog.data < 1 ? dataLabel
      : prog.globe < 1 ? 'loading.textures'
      : prog.others < 1 ? 'loading.systems'
      : 'loading.shaders';
    loading.setProgress(
      prog.data * weights.data + prog.globe * weights.globe + prog.others * weights.others + prog.compile * weights.compile,
      label,
    );
  };
  const others = systems.filter((s) => s !== ctx.globe && s !== ctx.ui);
  const otherProg = new Array(others.length).fill(0);
  try {
    await Promise.all([
      loadWorldData((f, l) => {
        prog.data = f;
        if (l) dataLabel = l;
        report();
      }).then((w) => {
        ctx.world = w;
        prog.data = 1;
        dataLabel = 'data.done';
        report();
      }),
      ctx.globe.init((f) => {
        prog.globe = f;
        report();
      }),
      ...others.map((s, i) =>
        s.init((f) => {
          otherProg[i] = f;
          prog.others = otherProg.reduce((a: number, b: number) => a + b, 0) / others.length;
          report();
        }),
      ),
    ]);
    compiling = true;
    report();
    for (const s of systems) s.warmup?.(true);
    await renderer.compileAsync(scene, camera);
    prog.compile = 0.6;
    report();
    await renderer.compileAsync(ctx.command.scene, ctx.command.camera);
    for (const s of systems) s.warmup?.(false);
    prog.compile = 1;
    report();
  } catch (err) {
    console.error('[app] loading failed', err);
  }

  // capture.mjs waits for __shotReady (shots) or __ready (plain page load: the "press any key" screen).
  if (!isShot) window.__ready = true;
  await loading.complete(!isShot);
  unlockAudio();
  setState('menu');
  if (isShot) await runShotFromUrl(ctx, waitFrames);
}
