// FRONT ULTRA — command mode: TAKE CONTROL of a tank / fighter jet / warship (owner: command).
//
// A dedicated local scene (1 unit = 1 m) sharing the renderer and the post pipeline. On enter() it builds the
// battlefield at the unit's real position: terrain from data.getLocalHeightfield (tank ~4 km, jet ~36 km, ship ~20 km
// + a far ring to the horizon), splat-shaded, scattered with trees / houses / rocks from the real land cover; sky,
// sun, fog and water lit by the globe's sun at that place and time; the real enemy nation in its colors (local groups
// linked to real strategic units nearby). The player fights in third person with a full mission HUD; kills convert to
// strategic troops (CommandResult) that app sends to the sim. Intro: cinematic swoop from the dive into the chase
// camera (letterboxed title card). Exit: Esc / button / death -> after-action report + camera climb -> app climbs
// back to orbit.

import * as THREE from 'three';
import type { CommandApi, CommandEnterParams, CommandResult, FrameInfo, GameContext, SfxCue } from '../shared/api';
import { MAP_H, MAP_W, UNIT_DEFS } from '../shared/constants';
import { sunDirection, subsolarPoint, tangentFrame, tileX, tileY } from '../shared/geo';
import { hexToCss } from '../shared/color';
import { playerName, t } from '../shared/i18n';
import type { QualityProfile } from '../shared/quality';
import { Rng } from '../shared/rng';
import { easeInOutCubic } from '../shared/math';
import { getLocalHeightfield } from '../data';
import type { CommandKind } from '../shared/types';
import { registerCommandStrings } from './strings';
import { makeDecalAtlas, makeNoiseTexture, makeParticleAtlas } from './env/textures';
import { computeAtmos, Sky, type Atmos } from './env/sky';
import { createTerrainMaterial, Ground } from './env/ground';
import { Water } from './env/water';
import { Scatter } from './env/scatter';
import { Grass } from './env/grass';
import { createMaterials, type CmdMaterials } from './models/materials';
import { Effects } from './fx/effects';
import { World, type Ent } from './world';
import { Brain } from './ai';
import { Mission } from './mission';
import { CommandInput } from './input';
import { CommandHud, type MissionInfo } from './hud/hud';
import type { Controller, ControllerCtx } from './player/common';
import { TankController } from './player/tank';
import { JetController } from './player/jet';
import { ShipController } from './player/ship';

registerCommandStrings();

type Phase = 'idle' | 'intro' | 'play' | 'dying' | 'debrief';

const OP_A = ['IRON', 'STEEL', 'THUNDER', 'CRIMSON', 'SILENT', 'BROKEN', 'NORTHERN', 'BLACK', 'GRANITE', 'WINTER', 'COBALT', 'SCARLET'];
const OP_B = ['LANCE', 'ANVIL', 'TEMPEST', 'HAMMER', 'SPEAR', 'FALCON', 'TRIDENT', 'RAMPART', 'VANGUARD', 'SABRE', 'HALBERD', 'AURORA'];

/** Internals exposed to this directory's shot stagers (not part of the shared contract). */
export interface CommandInternals {
  readonly world: World;
  readonly fx: Effects;
  readonly hud: CommandHud;
  readonly scatter: Scatter;
  readonly input: CommandInput;
  controller: Controller | null;
  mission: Mission | null;
  brain: Brain | null;
  /** Advance the battle by n fixed steps without input (staging). */
  simulate(steps: number, dt: number, beforeStep?: (i: number) => void): void;
  /** Freeze simulation time (renders keep going): shots. */
  freeze: boolean;
  skipIntro(): void;
  /** Hold the current phase (intro / debrief) at its present time: staging. */
  hold: boolean;
  readonly phase: string;
  /** Stage: jump `t` seconds into the current phase (intro camera move, debrief climb); use with hold = true. */
  setPhaseTime(t: number): void;
  /** Open the after-action report as if the player pressed Esc. */
  debrief(): void;
  /** Shots: pin the next battle's seed and front bearing (compass degrees toward the enemy). */
  pin: { seed: number; bearingDeg: number } | null;
  readonly camera: THREE.PerspectiveCamera;
  atmos(): Atmos;
}

let internals: CommandInternals | null = null;
export function commandInternals(): CommandInternals | null {
  return internals;
}

export function createCommandMode(ctx: GameContext): CommandApi {
  const scene = new THREE.Scene();
  scene.name = 'command';
  const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.3, 30000);
  camera.position.set(0, 10, 20);
  const renderer = ctx.renderer;
  // Shadows are only cast by command-mode lights; enabling the renderer flag once at boot keeps program keys stable.
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
  let warmMesh: THREE.Mesh | null = null;
  let pmrem: THREE.PMREMGenerator | null = null;
  let envRT: THREE.WebGLRenderTarget | null = null;
  const envScene = new THREE.Scene();
  const input = new CommandInput(ctx.canvas);
  let atmos: Atmos = computeAtmos(new THREE.Vector3(0.4, 0.6, 0.3));

  let active = false;
  let params: CommandEnterParams | null = null;
  let phase: Phase = 'idle';
  let phaseT = 0;
  let controller: Controller | null = null;
  let brain: Brain | null = null;
  let mission: Mission | null = null;
  let rng = new Rng(1);
  let startTime = 0;
  let battleTime = 0;
  let shakeAmt = 0;
  let exitRequested = false;
  let freeze = false;
  let objectiveDone = false;
  let missionInfo: MissionInfo | null = null;
  let lockBeepT = 0;
  let warnBeepT = 0;
  let localClock = '';
  /** Test-only time scale (?cmdTimeScale=, shot sessions only). */
  let timeScale = 1;
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
    obstacles: [], shake: (a) => (shakeAmt = Math.min(1.5, shakeAmt + a)), radius: 2000, viewW: 1600, viewH: 900,
  };

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

  /** Yaw toward the enemy's territory around the unit (tile space: +x east, +y south). */
  function enemyYawFor(p: CommandEnterParams): number | null {
    const view = ctx.sim.view;
    if (!view.owner || view.owner.length === 0) return null;
    const cx = tileX(p.tile), cy = tileY(p.tile);
    let vx = 0, vz = 0, n = 0;
    for (let dy = -16; dy <= 16; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= MAP_H) continue;
      for (let dx = -16; dx <= 16; dx++) {
        const o = view.owner[y * MAP_W + ((((cx + dx) % MAP_W) + MAP_W) % MAP_W)];
        if (o !== p.enemy || (dx === 0 && dy === 0)) continue;
        const d = Math.hypot(dx, dy);
        vx += dx / (d * d);
        vz += dy / (d * d);
        n++;
      }
    }
    if (n === 0 || Math.hypot(vx, vz) < 1e-6) return null;
    return Math.atan2(-vx, -vz);
  }

  function strategicUnitsFor(p: CommandEnterParams): number[] {
    const view = ctx.sim.view;
    const out: number[] = [];
    const cx = tileX(p.tile), cy = tileY(p.tile);
    for (const u of view.units.values()) {
      if (u.owner !== p.enemy || UNIT_DEFS[u.type]?.command !== p.kind) continue;
      const dx = Math.abs(u.x - cx), dy = Math.abs(u.y - cy);
      if (Math.min(dx, MAP_W - dx) < 22 && dy < 22) out.push(u.id);
      if (out.length >= 3) break;
    }
    return out;
  }

  function sfx(cue: SfxCue, gain: number): void {
    if (ctx.app.isShot) return;
    try {
      ctx.audio.play(cue, gain);
    } catch {
      /* audio not ready */
    }
  }

  function requestExit(): void {
    if (!active) return;
    if (!controller || !world || !hud) {
      // The battlefield failed to build: leave immediately rather than trapping the player.
      if (!exitRequested) {
        exitRequested = true;
        ctx.bus.emit('commandExitRequested', { reason: 'player' });
      }
      return;
    }
    if (phase === 'debrief') {
      // Second press: leave right away.
      if (!exitRequested) {
        exitRequested = true;
        ctx.bus.emit('commandExitRequested', { reason: objectiveDone ? 'objective' : 'player' });
      }
      return;
    }
    if (phase === 'dying') return;
    beginDebrief(false);
  }

  function beginDebrief(lost: boolean): void {
    if (!world || !hud) return;
    phase = 'debrief';
    phaseT = 0;
    input.releaseLock();
    const st = world.stats;
    const troops = computeTroops();
    hud.showDebrief({
      kills: st.kills, troops, durationSec: battleTime, accuracy: st.shots > 0 ? Math.min(1, st.hits / Math.max(1, st.shots)) : 0,
      lost, strategic: st.strategicKilled.length, byKind: [...st.killsByKind.entries()].sort((a, b) => b[1] - a[1]),
    }, lost ? 3.8 : 4.4);
    outroPos.copy(camera.position);
    camera.getWorldDirection(tmp);
    outroLook.copy(camera.position).addScaledVector(tmp, 60);
    ctx.bus.emit('uiSound', { kind: 'whoosh' });
  }

  function computeTroops(): number {
    if (!world || !params || !mission) return 0;
    const raw = world.stats.troops * mission.troopMul * (objectiveDone ? 1.25 : 1);
    const cap = params.enemyTroops * 0.6;
    return Math.round(cap > 0 ? Math.min(cap, raw) : raw);
  }

  // -----------------------------------------------------------------------------------------------
  // Battle construction
  // -----------------------------------------------------------------------------------------------
  function build(p: CommandEnterParams): void {
    if (!ground || !scatter || !world || !fx || !water || !mats || !hud) return;
    const q = ctx.quality;
    const pin = internals?.pin ?? null;
    if (internals) internals.pin = null;
    rng = new Rng((pin ? pin.seed : p.seed) >>> 0 || 1);
    const kind: CommandKind = p.kind;
    // Terrain
    const detail = q.commandDetail;
    const nearKm = kind === 'tank' ? 4.2 : kind === 'jet' ? 36 : 20;
    const farKm = kind === 'tank' ? 44 : kind === 'jet' ? 240 : 150;
    const nearRes = kind === 'tank' ? (detail >= 0.8 ? 449 : detail >= 0.5 ? 353 : 257) : detail >= 0.5 ? 385 : 257;
    const near = getLocalHeightfield(p.lat, p.lon, nearKm, nearRes, { seed: 0 });
    const far = getLocalHeightfield(p.lat, p.lon, farKm, detail >= 0.5 ? 193 : 129, { seed: 0 });
    ground.build(near, far);
    const viewDist = q.commandViewDistance;
    const fogD = kind === 'tank' ? 1.3 / (viewDist * 1.1) : kind === 'jet' ? 1.25 / (viewDist * 14) : 1.3 / (viewDist * 5);
    camera.far = kind === 'tank' ? 26000 : kind === 'jet' ? 160000 : 90000;
    camera.near = kind === 'tank' ? 0.3 : kind === 'jet' ? 1.2 : 0.8;
    camera.updateProjectionMatrix();
    water.configure(ground.depthNear, ground.depthFar, nearKm * 1000, farKm * 1000, farKm * 1000 * 1.6, kind === 'ship' ? 1.3 : 1.0);
    // Sun & atmosphere at the real place and time
    const sunLocal = localSun(p.lat, p.lon, p.worldTimeSec, new THREE.Vector3());
    atmos = computeAtmos(sunLocal, atmos);
    applyAtmosphere(atmos, fogD);
    rebuildEnvironment();
    localClock = clockString(p.lon, p.worldTimeSec);
    (ground.material.userData.scorch as { value: number }).value = kind === 'tank' ? 1 : kind === 'jet' ? 0.4 : 0;
    // Teams
    mats.setTeamColors(p.friendlyColor, p.enemyColor);
    world.setTeamTints(p.friendlyColor, p.enemyColor);
    world.reset();
    world.rng = rng.fork('world');
    world.kind = kind;
    world.godMode = false;
    fx.clear();
    fx.seed(pin ? pin.seed : p.seed);
    fx.hearing = kind === 'jet' ? 2500 : kind === 'ship' ? 1800 : 500;
    const g = ground;
    fx.heightAt = (x, z) => g.heightAt(x, z);
    fx.normalAt = (x, z, o) => g.normalAt(x, z, o);
    // Mission
    const yaw = pin ? -(pin.bearingDeg * Math.PI) / 180 : enemyYawFor(p) ?? rng.next() * Math.PI * 2;
    mission = new Mission(world, rng.fork('mission'), {
      kind, difficulty: p.difficulty, enemyYaw: yaw, strategicUnits: strategicUnitsFor(p), enemyTroops: p.enemyTroops,
    });
    mission.onNotice = (key) => ctx.bus.emit('toast', { text: t(key), kind: key === 'command.airstrike' ? 'success' : 'warning', durationMs: 3500 });
    // Scenery (keep the spawn area clear)
    scatter.build(ground, near, rng.fork('scatter'), kind === 'tank' ? 2000 : kind === 'jet' ? 9000 : 6000,
      kind === 'tank' ? detail : detail * 0.35, [0, 0, 30], kind === 'jet' ? 1.6 : 1);
    grass?.configure(ground, near, kind === 'tank' ? detail : 0);
    const player = mission.build(scatter);
    brain = new Brain(world, mission.front);
    cctx.world = world;
    cctx.ground = ground;
    cctx.fx = fx;
    cctx.radius = mission.front.radius;
    cctx.obstacles = scatter.houseList;
    controller = kind === 'tank' ? new TankController(player, cctx) : kind === 'jet' ? new JetController(player, cctx) : new ShipController(player, cctx);
    // Hooks
    const h = hud;
    world.hooks = {
      onPlayerHit: (_e, kill) => h.hitMarker(kill),
      onKill: (victim, killer, byPlayer) => onKill(victim, killer, byPlayer),
      onPlayerDamaged: (amount, from) => {
        h.damage(amount, player.pos, from);
        shakeAmt = Math.min(1.5, shakeAmt + amount / 40);
      },
      onPlayerKilled: () => {
        phase = 'dying';
        phaseT = 0;
        h.showDestroyed();
        sfx('explosionLarge', 1);
      },
    };
    fx.hooks = {
      sound: (cue, gain) => sfx(cue, gain),
      shake: (a) => (shakeAmt = Math.min(1.5, shakeAmt + a * (ctx.settings.get().screenShake === false ? 0.3 : 1))),
    };
    // HUD
    const view = ctx.sim.view;
    const enemyP = view.players[p.enemy];
    const me = view.players[p.owner];
    missionInfo = {
      kind,
      opName: `${OP_A[rng.int(OP_A.length)]} ${OP_B[rng.int(OP_B.length)]}`,
      enemyName: enemyP ? playerName(enemyP, ctx.world) : '—',
      enemyColor: hexToCss(p.enemyColor),
      friendlyName: me ? playerName(me, ctx.world) : '—',
      friendlyColor: hexToCss(p.friendlyColor),
      coords: `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'}`,
      localTime: localClock,
      objective: mission.objective,
    };
    controller.update(1 / 60, false);
    controller.updateCamera(0);
    hud.show(missionInfo, controller.hud.weapons.map((w) => ({ key: w.key, label: w.label })));
    hud.setObjective(0, mission.objective, false);
    world.syncRigs(0);
  }

  function onKill(victim: Ent, killer: Ent | null, byPlayer: boolean): void {
    if (!hud || !mission || !world || !params) return;
    if (victim.player) return;
    const fColor = hexToCss(params.friendlyColor), eColor = hexToCss(params.enemyColor);
    if (byPlayer && victim.team === 1) {
      const troops = Math.round(victim.value * mission.troopMul);
      hud.feedEntry('you', victim.kind, troops, '#ffb53d');
      if (victim.kind !== 'soldier' && victim.kind !== 'at') hud.killConfirm(victim.kind, troops);
      ctx.bus.emit('uiSound', { kind: 'notify' });
      const done = world.stats.kills >= mission.objective;
      hud.setObjective(world.stats.kills, mission.objective, done);
      if (done && !objectiveDone) {
        objectiveDone = true;
        ctx.bus.emit('uiSound', { kind: 'confirm' });
      }
    } else if (victim.team === 1 && killer && victim.kind !== 'soldier') {
      hud.feedEntry('ally', victim.kind, 0, fColor);
    } else if (victim.team === 0 && victim.kind !== 'soldier' && victim.kind !== 'at') {
      hud.feedEntry('enemy', victim.kind, 0, eColor);
    }
  }

  // -----------------------------------------------------------------------------------------------
  // Per-frame
  // -----------------------------------------------------------------------------------------------
  function step(dt: number, allowInput: boolean): void {
    if (!world || !fx || !controller || !brain || !mission) return;
    if (dt > 0) {
      brain.update(dt);
      mission.update(dt);
      controller.update(dt, allowInput);
      world.update(dt);
    }
    world.syncRigs(dt);
    fx.update(dt);
    world.renderProjectiles();
  }

  function placeShadowCamera(): void {
    if (!controller) return;
    const focus = controller.ent.pos;
    const kind = params?.kind ?? 'tank';
    const ext = kind === 'tank' ? 80 : kind === 'ship' ? 220 : 160;
    // Snap to the shadow texel grid to avoid shimmering.
    const texel = (ext * 2) / sun.shadow.mapSize.x;
    const x0 = Math.round(focus.x / texel) * texel, z0 = Math.round(focus.z / texel) * texel;
    sun.target.position.set(x0, focus.y, z0);
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
    const k = params?.kind === 'jet' ? 0.35 : 1;
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

  const api: CommandApi = {
    scene,
    camera,
    get active() {
      return active;
    },
    async init(progress) {
      progress(0.05);
      const noise = makeNoiseTexture(256);
      // Sharp ground detail at grazing angles without shimmer.
      noise.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      progress(0.25);
      const atlas = makeParticleAtlas();
      const decals = makeDecalAtlas();
      progress(0.45);
      mats = createMaterials(noise);
      sky = new Sky(noise);
      water = new Water(noise);
      ground = new Ground(createTerrainMaterial(noise));
      scatter = new Scatter(mats.prop);
      grass = new Grass();
      const q = ctx.quality;
      fx = new Effects(atlas, decals, Math.min(q.particles, 14000), q.decals, mats.wreck);
      world = new World(mats, ground, fx, new Rng(1));
      progress(0.8);
      scene.add(sky.mesh, ground.group, water.mesh, scatter.group, grass.mesh, world.group, fx.group);
      hud = new CommandHud(ctx.uiRoot);
      hud.onExitClick = () => requestExit();
      input.onEscape = () => requestExit();
      pmrem = new THREE.PMREMGenerator(renderer);
      applyAtmosphere(atmos, 0.0003);
      try {
        rebuildEnvironment();
      } catch (err) {
        console.warn('[command] environment map failed', err);
      }
      const w = world, f = fx, hh = hud;
      internals = {
        world: w, fx: f, hud: hh, scatter, input, controller: null, mission: null, brain: null, camera, pin: null,
        atmos: () => atmos,
        get freeze() {
          return freeze;
        },
        set freeze(v: boolean) {
          freeze = v;
        },
        simulate(steps, dt, before) {
          for (let i = 0; i < steps; i++) {
            before?.(i);
            if (phase === 'play') battleTime += dt;
            step(dt, false);
            controller?.updateCamera(dt);
            f.flush();
          }
        },
        hold: false,
        get phase() {
          return `${phase}:${phaseT.toFixed(2)}:${active}`;
        },
        setPhaseTime(tt: number) {
          phaseT = tt;
        },
        debrief() {
          if (phase === 'play' || phase === 'intro') beginDebrief(false);
        },
        skipIntro() {
          phase = 'play';
          phaseT = 0;
          hh.setCinematic(false);
          if (missionInfo) hh.showIntro(missionInfo, false);
        },
      };
      // Shot / test sessions: expose the internals for inspection from the browser console.
      if (ctx.app.isShot) (window as unknown as { __cmd?: CommandInternals }).__cmd = internals;
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
      startTime = performance.now();
      battleTime = 0;
      shakeAmt = 0;
      exitRequested = false;
      objectiveDone = false;
      freeze = false;
      timeScale = 1;
      if (ctx.app.isShot) {
        const ts = Number(new URLSearchParams(location.search).get('cmdTimeScale'));
        if (ts > 0 && ts <= 8) timeScale = ts;
      }
      const w = ctx.canvas.clientWidth || window.innerWidth, h = ctx.canvas.clientHeight || window.innerHeight;
      cctx.viewW = w;
      cctx.viewH = h;
      camera.aspect = w / Math.max(1, h);
      camera.fov = 62;
      camera.updateProjectionMatrix();
      hud?.resize(w, h);
      try {
        build(p);
      } catch (err) {
        console.error('[command] failed to build the battlefield', err);
      }
      if (internals) {
        internals.controller = controller;
        internals.mission = mission;
        internals.brain = brain;
      }
      input.reset();
      input.attach();
      if (hud) {
        hud.showLockHint = !ctx.app.isShot;
        hud.setCinematic(true);
        if (missionInfo) hud.showIntro(missionInfo, true);
      }
      // Intro camera: from high above the unit (continuing the orbital dive) down into the chase camera.
      if (controller) {
        controller.updateCamera(0);
        introTo.copy(camera.position);
        introQTo.copy(camera.quaternion);
        const e = controller.ent;
        const k = p.kind === 'jet' ? 5 : p.kind === 'ship' ? 3 : 1;
        camera.getWorldDirection(tmp);
        introFrom.copy(e.pos).addScaledVector(tmp, -140 * k);
        introFrom.y += 260 * k;
        camera.position.copy(introFrom);
        camera.lookAt(tmp2.copy(e.pos));
        introQFrom.copy(camera.quaternion);
      }
      ctx.post.setExposure(1 + atmos.night * 1.5);
      sfx(p.kind === 'jet' ? 'jetFlyby' : p.kind === 'ship' ? 'shipHorn' : 'tankEngine', 0.8);
    },
    exit(): CommandResult {
      const p = params!;
      const lost = !!world?.player && !world.player.alive;
      const result: CommandResult = {
        unitId: p.unitId, kind: p.kind, enemy: p.enemy, tile: p.tile,
        troopsKilled: computeTroops(),
        unitsDestroyed: world ? [...world.stats.strategicKilled] : [],
        structuresDestroyed: [],
        unitLost: lost,
        durationSec: (performance.now() - startTime) / 1000,
      };
      active = false;
      phase = 'idle';
      input.detach();
      hud?.hide();
      world?.reset();
      fx?.clear();
      scatter?.clear();
      grass?.configure(null, null, 0);
      ground?.clear();
      controller = null;
      brain = null;
      mission = null;
      if (internals) {
        internals.controller = null;
        internals.mission = null;
        internals.brain = null;
      }
      ctx.post.setExposure(1);
      return result;
    },
    update(frame: FrameInfo) {
      if (!active || !controller || !world || !fx || !hud) return;
      const tStart = performance.now();
      const realDt = frame.dt;
      if (!internals?.hold) phaseT += realDt;
      let dt = freeze ? 0 : realDt;
      let allowInput = false;
      if (phase === 'intro') {
        if (phaseT > 3.2) {
          phase = 'play';
          phaseT = 0;
          hud.setCinematic(false);
          if (missionInfo) hud.showIntro(missionInfo, false);
        }
      } else if (phase === 'play') {
        allowInput = true;
        battleTime += dt;
      } else if (phase === 'dying') {
        dt *= 0.3;
        if (phaseT > 2.6) beginDebrief(true);
      } else if (phase === 'debrief') {
        dt *= 0.5;
        if (phaseT > (world.player?.alive ? 4.4 : 3.8) && !exitRequested) {
          exitRequested = true;
          ctx.bus.emit('commandExitRequested', { reason: world.player?.alive ? (objectiveDone ? 'objective' : 'player') : 'killed' });
        }
      }
      // Fixed-size substeps keep physics, AI and projectile sweeps stable at low frame rates.
      if (dt > 0) {
        dt *= timeScale;
        const n = Math.min(timeScale > 1 ? 8 : 4, Math.ceil(dt / (1 / 30)));
        for (let i = 0; i < n; i++) {
          step(dt / n, allowInput);
          if (i < n - 1) fx.discard();
        }
      } else step(0, allowInput);
      if (phase === 'debrief') {
        // Climb away from the battle, looking back down at it.
        const k = Math.min(1, phaseT / 4);
        const e = controller.ent;
        camera.position.copy(outroPos).lerp(tmp.copy(e.pos).add(tmp2.set(0, params?.kind === 'jet' ? 2500 : 700, 0)), easeInOutCubic(k) * 0.9);
        camera.lookAt(tmp.copy(outroLook).lerp(e.pos, k));
      } else {
        controller.updateCamera(dt);
        if (phase === 'intro') {
          introTo.copy(camera.position);
          introQTo.copy(camera.quaternion);
          const k = easeInOutCubic(Math.min(1, phaseT / 3.1));
          camera.position.copy(introFrom).lerp(introTo, k);
          camera.quaternion.copy(introQFrom).slerp(introQTo, k);
        }
      }
      applyShake(realDt);
      camera.updateMatrixWorld();
      sky?.update(camera, frame.time);
      water?.update(camera, frame.time);
      fx.listener.copy(camera.position);
      grass?.update(controller.ent.pos, frame.time);
      placeShadowCamera();
      fx.flush();
      fx.ribbons.build(camera);
      lockBeeps(realDt);
      hud.update(freeze ? 0 : realDt, controller.hud, camera, world, localClock, battleTime, input.locked, realDt);
      input.endFrame();
      if (ctx.app.isShot && frame.frame % 30 === 0) {
        // Debug counters for tests: JS cost of this update and the number of drawable objects.
        let draws = 0;
        scene.traverseVisible((o) => {
          if ((o as THREE.Mesh).isMesh && (!(o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.InstancedMesh).count > 0)) draws++;
        });
        (window as unknown as { __cmdStats?: unknown }).__cmdStats = {
          ms: +(performance.now() - tStart).toFixed(2), ents: world.ents.length, particles: fx.particles.live, draws,
        };
      }
    },
    resize(w, h) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      cctx.viewW = w;
      cctx.viewH = h;
      hud?.resize(w, h);
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
  return api;
}
