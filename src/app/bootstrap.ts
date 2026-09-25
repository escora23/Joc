// FRONT ULTRA — application bootstrap, state machine and frame loop (owner: app).
// See ARCHITECTURE.md §4 (state machine) and §5 (frame loop). This file wires every subsystem together;
// subsystems never create each other.

import * as THREE from 'three';
import type {
  AppController, AppState, CommandEnterParams, FrameInfo, GameContext, ScriptedGameOptions, Subsystem,
} from '../shared/api';
import { DEFAULT_START_WORLD_TIME, HUMAN_ID, MAP_H, MAP_W, MENU_WORLD_TIME_SCALE, TICK_MS, UNIT_DEFS } from '../shared/constants';
import { EventBus, type GameEvents } from '../shared/events';
import { latLonToTile, tileAtXY, tileToLatLon, tileX, tileY, wrapX } from '../shared/geo';
import { setLanguage } from '../shared/i18n';
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
  const frame: FrameInfo = { now: performance.now(), dt: 0, time: 0, frame: 0, worldTime: DEFAULT_START_WORLD_TIME, simAlpha: 1, simTime: 0, simDt: 0 };
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
      await ctx.sim.start(config, ctx.world);
      for (const s of systems) s.onGameStart?.();
      bus.emit('gameStarted', { config });
      ctx.globe.setTerritoryOpacity(1);
      ctx.cameraRig.setMode('game');
      const phase = ctx.sim.view.phase;
      setState(phase === 'playing' ? 'playing' : 'spawn');
      if (!isShot) void ctx.cameraRig.flyTo({ lat: 30, lon: 10, altitudeKm: 14_000, tilt: 0, heading: 0 }, 1500);
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
    async enterCommandMode(unitId) {
      if (state !== 'playing' || ctx.command.active) return;
      const params = commandParams(unitId);
      if (!params) {
        bus.emit('uiSound', { kind: 'error' });
        return;
      }
      ctx.cameraRig.setMode('cinematic');
      input.setEnabled(false);
      await ctx.cameraRig.flyTo({ lat: params.lat, lon: params.lon, altitudeKm: 3, tilt: 1.2 }, isShot ? 1 : 2200);
      await ctx.post.fadeTo(1, isShot ? 1 : 350);
      ctx.sim.send({ type: 'unitControl', unitId, controlled: true });
      await ctx.command.enter(params);
      setState('command');
      bus.emit('commandEnter', { params });
      await ctx.post.fadeTo(0, isShot ? 1 : 500);
    },
    async exitCommandMode() {
      if (state !== 'command') return;
      await ctx.post.fadeTo(1, 300);
      const result = ctx.command.exit();
      ctx.sim.send({
        type: 'commandResult', unitId: result.unitId, kind: result.kind, enemy: result.enemy, tile: result.tile,
        troopsKilled: result.troopsKilled, unitsDestroyed: result.unitsDestroyed,
        structuresDestroyed: result.structuresDestroyed, unitLost: result.unitLost,
      });
      if (!result.unitLost) ctx.sim.send({ type: 'unitControl', unitId: result.unitId, controlled: false });
      setState('playing');
      bus.emit('commandExit', { result });
      await ctx.post.fadeTo(0, 400);
      await ctx.cameraRig.flyTo({ altitudeKm: 2500, tilt: 0.3 }, 2000);
      ctx.cameraRig.setMode('game');
      input.setEnabled(true);
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
        startWorldTimeSec: DEFAULT_START_WORLD_TIME,
        spawnTimeoutTicks: 900,
        autoSpawnTile: -1,
        instantStart: false,
        humanAutopilot: false,
        ...overrides,
      };
    },
  };
  let lastSpeed: GameSpeed = 1;

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
  (window as unknown as { __front: unknown }).__front = { ctx, app };
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

  function commandParams(unitId: number): CommandEnterParams | null {
    const view = ctx.sim.view;
    const u = view.units.get(unitId);
    if (!u || u.owner !== HUMAN_ID) return null;
    const kind = UNIT_DEFS[u.type].command;
    if (!kind) return null;
    const tile = tileAtXY(u.x, u.y);
    // Enemy: the dominant non-allied foreign owner around the unit (40 tiles, widening to 160 if the unit is deep
    // inside our own land), else the strongest hostile nation in the world — never a skirmish against nobody.
    const allies = view.human?.allies ?? [];
    const cx = tileX(tile), cy = tileY(tile);
    let enemy = 0;
    for (const radius of [40, 90, 160]) {
      const counts = new Map<number, number>();
      const step = radius > 40 ? 4 : 2;
      for (let dy = -radius; dy <= radius; dy += step) {
        for (let dx = -radius; dx <= radius; dx += step) {
          const y = cy + dy;
          if (y < 0 || y >= MAP_H || dx * dx + dy * dy > radius * radius) continue;
          const o = view.owner[y * MAP_W + wrapX(cx + dx)];
          if (o && o !== HUMAN_ID && !allies.includes(o)) counts.set(o, (counts.get(o) ?? 0) + 1 / (1 + Math.hypot(dx, dy) * 0.05));
        }
      }
      let best = 0;
      for (const [o, c] of counts) if (c > best) { best = c; enemy = o; }
      if (enemy) break;
    }
    if (!enemy) {
      let best = 0;
      for (const p of view.playerList) {
        if (p.alive && p.id !== HUMAN_ID && !allies.includes(p.id) && p.troops > best) { best = p.troops; enemy = p.id; }
      }
    }
    const ll = tileToLatLon(tile);
    const me = view.human!;
    const foe = view.players[enemy];
    return {
      unitId, unitType: u.type, kind, lat: ll.lat, lon: ll.lon, tile, owner: HUMAN_ID, enemy,
      friendlyColor: me.color, enemyColor: foe?.color ?? 0xcc3333, friendlyTroops: me.troops,
      enemyTroops: foe?.troops ?? 0, seed: hashString(`${view.config?.seed ?? 0}:${unitId}:${view.tick}`),
      worldTimeSec: frame.worldTime, difficulty: view.config?.difficulty ?? 'normal',
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
