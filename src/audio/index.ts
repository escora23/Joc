// FRONT ULTRA — procedural Web Audio subsystem (owner: audio). No audio files, ever.
// Game glue around SoundSystem: AudioContext lifecycle (created on the first user gesture), settings
// volumes & quality voice budget, the event-bus vocabulary → sounds, positional cues heard from the
// strategic camera, the battle ambience driven by fronts in view, the adaptive music director driven
// by war intensity (fronts, attacks, nukes, doomsday), sirens, command-mode vehicle engines and the
// nuclear silence-then-roar.

import * as THREE from 'three';
import type { AppState, AudioApi, CameraState, FrameInfo, GameContext, MusicMood, SfxCue } from '../shared/api';
import type { UiSoundKind } from '../shared/events';
import { HUMAN_ID } from '../shared/constants';
import { tileToLatLon, tileXYToLatLon } from '../shared/geo';
import { UnitType, type LatLon } from '../shared/types';
import type { QualityProfile } from '../shared/quality';
import { clamp01 } from './dsp';
import type { HeardFront } from './loops';
import type { MusicFamily } from './music';
import { SoundSystem } from './sound';
import { CUE_REF_KM, hear, type Heard } from './space';
import './shots';

const MAX_FRONTS = 24;

export function createAudio(ctx: GameContext): AudioApi {
  let ac: AudioContext | null = null;
  let snd: SoundSystem | null = null;
  let unlocked = false;
  let unlocking: Promise<void> | null = null;

  let appState: AppState = 'boot';
  let mood: MusicMood = 'silence';
  let endCuePlayed = false;
  const cam: CameraState = { lat: 20, lon: 0, altitudeKm: 20000, tilt: 0, heading: 0 };
  const heard: Heard = { gain: 0, pan: 0, lowpass: 20000, dist: 0, hidden: false, km: 0 };
  const ll: LatLon = { lat: 0, lon: 0 };

  // Adaptive state (seconds are frame.time, real time).
  let intensity = 0;
  let nukeHeat = 0;
  let attackHeat = 0;
  let nuclearUntil = 0;
  let doomsday = 0;
  let moodFloor = 0;
  let tickAcc = 0;
  let ambAcc = 0;
  let flybyAcc = 0;
  const flybyAt = new Map<number, number>();
  const sirenFor = new Set<number>();
  const fronts: HeardFront[] = [];
  for (let i = 0; i < MAX_FRONTS; i++) fronts.push({ pan: 0, far: 0, near: 0, intensity: 0, lat: 0, lon: 0 });

  // Command-mode vehicle tracking.
  const prevCamPos = new THREE.Vector3();
  const camFwd = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  let havePrevCam = false;
  let vehSpeed = 0;
  let boostKey = false;
  let commandKind: 'tank' | 'jet' | 'ship' | null = null;

  const now = () => ctx.frame?.time ?? performance.now() / 1000;
  let meter: AnalyserNode | null = null;
  let meterBuf: Float32Array<ArrayBuffer> | null = null;

  // Read-only diagnostics for playtests and automation (window.__fuAudio.stats()).
  (window as unknown as { __fuAudio: unknown }).__fuAudio = {
    stats() {
      let rmsDb = -120;
      if (meter) {
        meterBuf ??= new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(meterBuf);
        let e = 0;
        for (let i = 0; i < meterBuf.length; i++) e += meterBuf[i] * meterBuf[i];
        rmsDb = Math.round(10 * Math.log10(e / meterBuf.length + 1e-12) * 10) / 10;
      }
      return {
        state: ac?.state ?? 'none', unlocked, appState, mood, family: snd?.music.family ?? 'none',
        intensity: Math.round(intensity * 1000) / 1000, voices: snd?.eng.voices.length ?? 0,
        vehicle: commandKind, sirens: sirenFor.size, rmsDb,
      };
    },
  };

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  function applyVolumes(): void {
    if (!snd) return;
    const s = ctx.settings.get();
    snd.eng.setVolumes(s.masterVolume, s.musicVolume, s.sfxVolume, s.uiVolume);
  }

  function applyQuality(q: QualityProfile): void {
    if (snd) snd.eng.maxVoices = Math.max(8, q.maxVoices);
  }

  function targetFamily(): MusicFamily {
    switch (mood) {
      case 'silence': return 'silence';
      case 'menu': return 'menu';
      case 'command': return 'command';
      case 'nuclear': return 'nuclear';
      case 'victory': return 'victory';
      case 'defeat': return 'defeat';
      default: return now() < nuclearUntil || doomsday >= 0.85 ? 'nuclear' : 'game';
    }
  }

  function syncMusic(): void {
    if (!snd) return;
    const f = targetFamily();
    if (f === 'victory' || f === 'defeat') {
      if (!endCuePlayed) {
        endCuePlayed = true;
        if (f === 'victory') snd.music.victory(snd.now + 0.1);
        else snd.music.defeat(snd.now + 0.1);
      }
      return;
    }
    snd.music.setFamily(f, snd.now, f === 'nuclear' ? 1.5 : 3);
  }

  /** Positional cue on the globe heard from the strategic camera. */
  function playAt(cue: string, lat: number, lon: number, gain = 1, minGain = 0, delay = 0): void {
    if (!snd) return;
    hear(cam, lat, lon, CUE_REF_KM[cue] ?? 120, heard);
    let g = Math.max(minGain, heard.gain) * gain;
    if (appState === 'command') g *= 0.25;
    if (g < 0.02) return;
    snd.play(cue, g, { pan: heard.pan, lowpass: heard.lowpass, dist: heard.dist, at: snd.now + delay });
  }

  function playTile(cue: string, tile: number, gain = 1, minGain = 0, delay = 0): void {
    if (tile < 0) return;
    tileToLatLon(tile, ll);
    playAt(cue, ll.lat, ll.lon, gain, minGain, delay);
  }

  function playXY(cue: string, x: number, y: number, gain = 1, minGain = 0, delay = 0): void {
    tileXYToLatLon(x, y, ll);
    playAt(cue, ll.lat, ll.lon, gain, minGain, delay);
  }

  function inGame(): boolean {
    return appState === 'playing' || appState === 'command' || appState === 'spawn';
  }

  // ---------------------------------------------------------------------------------------------
  // Bus subscriptions
  // ---------------------------------------------------------------------------------------------

  const bus = ctx.bus;
  bus.on('settingsChanged', applyVolumes);
  bus.on('qualityChanged', (e) => applyQuality(e.quality));
  bus.on('cameraMoved', (c) => {
    cam.lat = c.lat;
    cam.lon = c.lon;
    cam.altitudeKm = c.altitudeKm;
    cam.tilt = c.tilt;
    cam.heading = c.heading;
  });
  bus.on('appState', (e) => {
    appState = e.state;
    if (e.state === 'spawn' && (mood === 'menu' || mood === 'silence')) api.setMood('calm');
    if (e.state !== 'command' && snd?.vehicle) snd.stopVehicle();
  });
  bus.on('uiSound', (e) => {
    if (!snd) return;
    const k: UiSoundKind = e.kind;
    if (appState === 'command') {
      // The command HUD reuses UI kinds for its cockpit tones.
      if (k === 'hover') return void snd.play('lockTone', 1);
      if (k === 'alert') return void snd.play('missileWarning', 1);
      if (k === 'notify') return void snd.play('killConfirm', 1);
      if (k === 'click') return void snd.play('hitMarker', 1);
    }
    snd.ui(k);
  });
  bus.on('news', (e) => {
    snd?.play('newsBleep', e.severity === 'critical' ? 1 : 0.8, { size: e.severity === 'critical' ? 2 : 1 });
  });
  bus.on('selectionChanged', (e) => {
    if (e.unitIds.length > 0 && appState === 'playing') snd?.play('radio', 0.9);
  });
  bus.on('gameStarted', () => {
    endCuePlayed = false;
    intensity = 0;
    nukeHeat = attackHeat = 0;
    nuclearUntil = 0;
    doomsday = 0;
  });
  bus.on('gameTornDown', () => {
    snd?.siren.stop();
    sirenFor.clear();
    snd?.amb.silence();
    snd?.stopVehicle();
    flybyAt.clear();
    endCuePlayed = false;
  });
  bus.on('gameEnded', (e) => {
    snd?.siren.stop();
    sirenFor.clear();
    api.setMood(e.humanWon ? 'victory' : 'defeat');
  });
  bus.on('commandEnter', (e) => {
    commandKind = e.params.kind;
    havePrevCam = false;
    vehSpeed = 0;
    snd?.startVehicle(e.params.kind);
  });
  bus.on('commandExit', () => {
    commandKind = null;
    snd?.stopVehicle();
  });

  // --- sim events --------------------------------------------------------------------------------
  bus.on('combat', (e) => {
    if (!snd || !inGame()) return;
    switch (e.kind) {
      case 'shell':
        playXY('navalGun', e.fromX, e.fromY, 0.8);
        if (e.hit) playXY('explosionSmall', e.toX, e.toY, 0.8, 0, 0.9);
        break;
      case 'artillery':
        playXY('artillery', e.fromX, e.fromY, 0.7);
        if (e.hit) playXY('explosionSmall', e.toX, e.toY, 0.7, 0, 1.1);
        break;
      case 'sam':
        playXY('samLaunch', e.fromX, e.fromY, 0.9);
        if (e.hit) playXY('explosionSmall', e.toX, e.toY, 0.6, 0, 1.4);
        break;
      case 'bomb':
        playXY('explosionLarge', e.toX, e.toY, 0.9);
        break;
      case 'strafe':
        playXY('jetCannon', e.toX, e.toY, 0.8);
        break;
    }
  });
  bus.on('unitDestroyed', (e) => {
    if (!snd || !inGame()) return;
    if (e.unit === UnitType.Shell || e.unit === UnitType.SamInterceptor || e.unit === UnitType.Train) return;
    const big = e.unit === UnitType.Warship || e.unit === UnitType.Bomber || e.unit === UnitType.TransportShip || e.unit === UnitType.TradeShip;
    playXY(big ? 'explosionLarge' : 'explosionSmall', e.x, e.y, 0.9, e.owner === HUMAN_ID ? 0.12 : 0);
  });
  bus.on('unitSpawned', (e) => {
    if (!snd || !inGame()) return;
    const mine = e.owner === HUMAN_ID;
    if (e.unit === UnitType.Warship && mine) playXY('shipHorn', e.x, e.y, 0.8, 0.35);
    else if ((e.unit === UnitType.FighterSquadron || e.unit === UnitType.Bomber) && mine) playXY('jetFlyby', e.x, e.y, 0.7, 0.3);
    else if (e.unit === UnitType.ArmoredDivision && mine) playXY('tankEngine', e.x, e.y, 0.8, 0.35);
    else if (e.unit === UnitType.CruiseMissile) playXY('missileLaunch', e.x, e.y, 0.8, mine ? 0.35 : 0);
    else if (e.unit === UnitType.SamInterceptor) playXY('samLaunch', e.x, e.y, 0.8);
  });
  bus.on('structureBuilt', (e) => {
    if (e.owner === HUMAN_ID) playTile('build', e.tile, 0.9, 0.55);
  });
  bus.on('structureUpgraded', (e) => {
    if (e.owner === HUMAN_ID) playTile('upgrade', e.tile, 0.9, 0.55);
  });
  bus.on('structureDestroyed', (e) => {
    playTile('explosionLarge', e.tile, 1, e.owner === HUMAN_ID || e.by === HUMAN_ID ? 0.25 : 0);
  });
  bus.on('structureCaptured', (e) => {
    if (e.to === HUMAN_ID) playTile('capture', e.tile, 0.8, 0.5);
  });
  bus.on('capitalCaptured', (e) => {
    if (e.by === HUMAN_ID) playTile('capture', e.tile, 1, 0.8);
    else if (e.playerId === HUMAN_ID) snd?.play('eliminated', 0.8);
  });
  bus.on('attackStarted', (e) => {
    if (e.attacker === HUMAN_ID) {
      snd?.play('attack', 0.8);
      attackHeat = Math.min(0.35, attackHeat + 0.12);
    } else if (e.defender === HUMAN_ID) {
      attackHeat = Math.min(0.45, attackHeat + 0.2);
    }
  });
  bus.on('boatLaunched', (e) => {
    if (e.owner === HUMAN_ID) playTile('shipHorn', e.fromTile, 0.7, 0.4);
  });
  bus.on('boatLanded', (e) => {
    if (e.owner === HUMAN_ID || e.defender === HUMAN_ID) playTile('gunfire', e.tile, 1, 0.3);
  });
  bus.on('allianceFormed', (e) => {
    if (e.a === HUMAN_ID || e.b === HUMAN_ID) snd?.play('alliance', 0.9);
  });
  bus.on('allianceRequested', (e) => {
    if (e.to === HUMAN_ID) snd?.ui('notify');
  });
  bus.on('allianceBroken', (e) => {
    if (e.victim === HUMAN_ID) snd?.play('betrayal', 1);
    else if (e.breaker === HUMAN_ID) snd?.play('betrayal', 0.55);
  });
  bus.on('nationEliminated', (e) => {
    if (e.playerId === HUMAN_ID) return;
    snd?.play('eliminated', e.by === HUMAN_ID ? 0.9 : 0.4);
  });
  bus.on('tradeCompleted', (e) => {
    if (e.owner === HUMAN_ID) snd?.play('coins', 0.5);
  });
  bus.on('goldBonus', (e) => {
    if (e.playerId === HUMAN_ID) snd?.play('coins', e.reason === 'train' ? 0.35 : 0.7);
  });
  bus.on('emote', (e) => {
    if (e.to === HUMAN_ID) snd?.ui('notify', 0.7);
  });
  bus.on('worldEvent', (e) => {
    if (!snd || !inGame()) return;
    if (e.stage === 'warning') {
      playXY('radar', e.x, e.y, 0.8, 0.4);
      return;
    }
    if (e.stage !== 'start') return;
    const min = e.players.includes(HUMAN_ID) ? 0.5 : 0.1;
    switch (e.kind) {
      case 'earthquake': playXY('earthquake', e.x, e.y, 1, min); break;
      case 'hurricane': playXY('thunder', e.x, e.y, 1, min); break;
      case 'rebellion': playXY('gunfire', e.x, e.y, 1, min); playXY('attack', e.x, e.y, 0.6, min); break;
      case 'goldRush': playXY('coins', e.x, e.y, 1, min); break;
      case 'pandemic': playXY('eliminated', e.x, e.y, 0.5, min); break;
      case 'doomsday': snd.play('eliminated', 0.8); break;
    }
  });
  bus.on('doomsday', (e) => {
    const prev = doomsday;
    doomsday = e.level;
    if (snd && Math.floor(e.level * 10) > Math.floor(prev * 10)) snd.play('eliminated', 0.35 + 0.5 * e.level);
  });
  bus.on('nukeLaunched', (e) => {
    nukeHeat = Math.min(0.6, nukeHeat + 0.25);
    playTile('nukeLaunch', e.fromTile, 1, e.owner === HUMAN_ID ? 0.6 : 0.08);
  });
  bus.on('nukeAlarm', (e) => {
    if (!snd) return;
    sirenFor.add(e.unitId);
    snd.siren.start(e.etaSec + 1.5, 1);
  });
  const endAlarm = (unitId: number) => {
    if (sirenFor.delete(unitId) && sirenFor.size === 0) snd?.siren.stop();
  };
  bus.on('nukeIntercepted', (e) => {
    const wasMine = sirenFor.has(e.unitId);
    endAlarm(e.unitId);
    playXY('explosionLarge', e.x, e.y, 1, e.owner === HUMAN_ID || wasMine ? 0.3 : 0.05);
  });
  bus.on('nukeDetonated', (e) => {
    endAlarm(e.unitId);
    if (!snd) return;
    tileXYToLatLon(e.x, e.y, ll);
    hear(cam, ll.lat, ll.lon, 1800, heard);
    const involved = e.targetOwner === HUMAN_ID || e.owner === HUMAN_ID;
    const size = e.weapon === UnitType.HydrogenBomb ? 1.6 : e.weapon === UnitType.MirvWarhead ? 0.8 : 1;
    // From orbit a nuke is still felt; up close it is overwhelming.
    let p = 0.35 + 0.65 * heard.gain;
    if (involved) p = Math.max(p, 0.7);
    if (appState === 'command') p *= 0.6;
    snd.nuke(p, size, heard.hidden, snd.now);
    nukeHeat = 1;
    if (involved || heard.gain > 0.3 || e.weapon === UnitType.HydrogenBomb) {
      nuclearUntil = now() + 55;
      syncMusic();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // Periodic analysis
  // ---------------------------------------------------------------------------------------------

  function updateIntensity(dt: number): void {
    const v = ctx.sim.view;
    let humanHeat = 0, worldHeat = 0;
    for (const f of v.fronts) {
      worldHeat += f.intensity;
      if (f.a === HUMAN_ID || f.b === HUMAN_ID) humanHeat += f.intensity * (f.b === HUMAN_ID ? 1.3 : 1);
    }
    let incoming = 0;
    for (const a of v.attacks) if (a.defender === HUMAN_ID) incoming++;
    nukeHeat *= Math.exp(-dt / 40);
    attackHeat *= Math.exp(-dt / 25);
    const target = clamp01(
      Math.max(moodFloor, 0.08 + 0.6 * Math.tanh(humanHeat / 1.6) + 0.18 * Math.tanh(worldHeat / 10) + 0.12 * Math.tanh(incoming / 2) + attackHeat + nukeHeat * 0.5),
    );
    // Swell fast, calm down slowly.
    const tau = target > intensity ? 5 : 28;
    intensity += (target - intensity) * (1 - Math.exp(-dt / tau));
    snd?.music.setIntensity(intensity, snd.now, 2.5);
  }

  function updateAmbience(dt: number): void {
    if (!snd) return;
    const v = ctx.sim.view;
    let n = 0;
    const level = appState === 'playing' || appState === 'spawn' ? 1 : 0;
    if (level > 0) {
      for (const f of v.fronts) {
        if (n >= MAX_FRONTS) break;
        if (f.intensity <= 0.02) continue;
        tileXYToLatLon(f.x, f.y, ll);
        hear(cam, ll.lat, ll.lon, 350, heard);
        if (heard.gain < 0.01) continue;
        const h = fronts[n++];
        h.far = heard.gain * Math.min(1, 0.4 + f.length / 60);
        h.near = 1 / (1 + (heard.km / 35) ** 2);
        h.pan = heard.pan;
        h.intensity = f.intensity;
        h.lat = ll.lat;
        h.lon = ll.lon;
      }
    }
    snd.amb.update(dt, fronts, n, cam.altitudeKm, level, ambSink);
  }
  const ambSink = (cue: string, lat: number, lon: number, g: number) => playAt(cue, lat, lon, g);

  function updateFlybys(): void {
    if (!snd || cam.altitudeKm > 500 || appState !== 'playing') return;
    const t = now();
    for (const u of ctx.sim.view.units.values()) {
      if (u.type !== UnitType.FighterSquadron && u.type !== UnitType.Bomber && u.type !== UnitType.DroneSwarm) continue;
      tileXYToLatLon(u.x, u.y, ll);
      hear(cam, ll.lat, ll.lon, CUE_REF_KM.jetFlyby, heard);
      if (heard.km > 220) continue;
      const last = flybyAt.get(u.id);
      if (last !== undefined && t - last < 12) continue;
      flybyAt.set(u.id, t);
      playAt('jetFlyby', ll.lat, ll.lon, u.type === UnitType.DroneSwarm ? 0.5 : 1);
    }
    if (flybyAt.size > 200) for (const [id, at] of flybyAt) if (t - at > 30) flybyAt.delete(id);
  }

  function updateVehicle(dt: number): void {
    if (!snd?.vehicle || !commandKind || dt <= 0) return;
    const c = ctx.command.camera;
    c.getWorldDirection(camFwd);
    camFwd.y = 0;
    camFwd.normalize();
    if (havePrevCam) {
      tmpV.copy(c.position).sub(prevCamPos);
      // Chase cameras orbit sideways when aiming: only motion along the view counts for ground/sea.
      const along = commandKind === 'jet' ? tmpV.length() : Math.abs(tmpV.dot(camFwd));
      const sp = along / dt;
      if (sp < 2000) vehSpeed += (sp - vehSpeed) * Math.min(1, dt * 3);
    }
    prevCamPos.copy(c.position);
    havePrevCam = true;
    const s01 = commandKind === 'tank' ? vehSpeed / 16 : commandKind === 'jet' ? (vehSpeed - 95) / 420 : vehSpeed / 16;
    const boost = commandKind === 'jet' ? (boostKey ? 1 : clamp01((vehSpeed - 380) / 120)) : 0;
    snd.vehicle.update(clamp01(s01), boost);
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Shift') boostKey = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') boostKey = false;
  });
  document.addEventListener('visibilitychange', () => {
    if (!ac || !unlocked) return;
    if (document.hidden) void ac.suspend().catch(() => undefined);
    else void ac.resume().catch(() => undefined);
  });

  // ---------------------------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------------------------

  const api: AudioApi = {
    get unlocked() {
      return unlocked;
    },
    async init(progress) {
      progress(1);
    },
    unlock() {
      if (ctx.app?.isShot) return Promise.resolve();
      if (unlocking) {
        const a = ac;
        if (a && a.state !== 'running') void a.resume().then(() => (unlocked = a.state === 'running')).catch(() => undefined);
        return unlocking;
      }
      unlocking = (async () => {
        try {
          const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (!AC) return;
          const a = new AC({ latencyHint: 'interactive' });
          ac = a;
          meter = a.createAnalyser();
          meter.fftSize = 2048;
          meter.connect(a.destination);
          snd = new SoundSystem(a, meter, (Math.random() * 0xffffffff) >>> 0);
          applyQuality(ctx.quality);
          applyVolumes();
          syncMusic();
          if (a.state !== 'running') await a.resume().catch(() => undefined);
          unlocked = a.state === 'running';
          a.addEventListener('statechange', () => (unlocked = a.state === 'running'));
        } catch (err) {
          console.warn('[audio] unavailable', err);
        }
      })();
      return unlocking;
    },
    play(cue: SfxCue, gain = 1) {
      if (!snd) return;
      if (cue === 'nukeDetonation') return snd.nuke(0.9 * gain, 1.3, false);
      if (cue === 'victory' || cue === 'defeat') return api.setMood(cue);
      snd.play(cue, gain);
    },
    playAt(cue: SfxCue, lat: number, lon: number, gain = 1) {
      if (!snd) return;
      if (cue === 'nukeDetonation') {
        hear(cam, lat, lon, 1800, heard);
        return snd.nuke(0.35 + 0.65 * heard.gain, 1.3, heard.hidden);
      }
      playAt(cue, lat, lon, gain);
    },
    setMood(m: MusicMood) {
      moodFloor = m === 'tension' ? 0.4 : m === 'war' ? 0.75 : 0;
      if (m === mood) return;
      if (m !== 'victory' && m !== 'defeat') endCuePlayed = false;
      mood = m;
      syncMusic();
    },
    duck(level: number, holdMs: number, releaseMs: number) {
      snd?.eng.duck(level, holdMs, releaseMs);
    },
    update(frame: FrameInfo) {
      if (!snd || !ac || ac.state !== 'running') return;
      const dt = frame.dt;
      snd.music.update();
      tickAcc += dt;
      ambAcc += dt;
      flybyAcc += dt;
      if (tickAcc >= 0.5) {
        if (ctx.sim.view.config && inGame()) updateIntensity(tickAcc);
        const f = targetFamily();
        if (f !== snd.music.family && f !== 'victory' && f !== 'defeat') syncMusic();
        snd.eng.sweep();
        tickAcc = 0;
      }
      if (ambAcc >= 0.1) {
        if (ctx.sim.view.config) updateAmbience(ambAcc);
        else snd.amb.silence();
        ambAcc = 0;
      }
      if (flybyAcc >= 0.5) {
        if (ctx.sim.view.config) updateFlybys();
        flybyAcc = 0;
      }
      if (appState === 'command') updateVehicle(dt);
    },
    onGameEnd() {
      snd?.siren.stop();
      snd?.stopVehicle();
    },
    setQuality(q: QualityProfile) {
      applyQuality(q);
    },
  };
  return api;
}
