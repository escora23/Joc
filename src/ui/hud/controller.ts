// FRONT ULTRA — gameplay input semantics (owner: ui). The app's input router only reports clicks/hovers on
// the world; this module decides what they mean: found the capital, expand/attack (with automatic naval
// invasion when there is no land border), place structures, fire weapons, order units, select things, open
// the radial diplomacy menu, plus every strategic hotkey from ARCHITECTURE.md §11.

import { isTyping } from '../dom';
import { attackNation } from './diplomacy';
import { needsDeclaration, openDeclareWar } from './declare';
import type { HudShared } from './shared';
import { HUMAN_ID, STRUCTURE_DEFS, UNIT_DEFS } from '../../shared/constants';
import { tileToLatLon } from '../../shared/geo';
import { t } from '../../shared/i18n';
import { isPlayableTerrain, isWaterTerrain } from '../../shared/terrain';
import { STRUCTURE_TYPES, StructureType, UnitType, type GameSpeed, type WeaponType } from '../../shared/types';

export interface ControllerHooks {
  openRadial(x: number, y: number, tile: number): void;
  closeRadial(): void;
  radialOpen(): boolean;
  togglePauseMenu(): void;
  toggleLeaderboard(): void;
  toggleMinimap(): void;
  openHelp(): void;
  takeControl(): void;
  setBuildTab(tab: 'build' | 'arsenal'): void;
  ripple(x: number, y: number, kind: 'attack' | 'expand' | 'build' | 'order' | 'fire' | 'spawn' | 'bad'): void;
  modalOpen(): boolean;
  /** v2 (W3): the nations drawer (N) and the alert log (L). closeNations returns true when it was open. */
  toggleNations?(): void;
  openLog?(): void;
  closeNations?(): boolean;
}

const WEAPON_HOTKEYS: Record<string, WeaponType> = {
  z: UnitType.AtomBomb as WeaponType,
  x: UnitType.HydrogenBomb as WeaponType,
  c: UnitType.Mirv as WeaponType,
  v: UnitType.CruiseMissile as WeaponType,
};
/** `+` / `-` step through these strategic speeds (§2.7). */
const SPEEDS: GameSpeed[] = [0.5, 1, 2, 4];

export function wireController(hs: HudShared, hooks: ControllerHooks): void {
  const ctx = hs.ctx;
  const bus = ctx.bus;
  const playing = () => ctx.app.state === 'playing';

  bus.on('worldHover', (e) => hs.setHover(e));

  bus.on('worldClick', (e) => {
    hs.setHover(e);
    const view = ctx.sim.view;
    const world = view.world;
    if (!world) return;
    // ---------------------------------------------------------------- spawn phase
    if (ctx.app.state === 'spawn') {
      if (e.button !== 0 || e.tile < 0) return;
      const owner = view.owner[e.tile];
      if (!isPlayableTerrain(world.terrain[e.tile]) || (owner !== 0 && owner !== HUMAN_ID)) {
        hs.sound('error');
        hooks.ripple(e.clientX, e.clientY, 'bad');
        // §12.6 (B02): say why, never a silent refusal.
        const p = owner > 0 ? view.players[owner] : null;
        const text = p ? t(p.kind === 'tribe' ? 'spawn.refuse.tribe' : 'spawn.refuse.nation', { name: hs.name(owner) }) : t('spawn.refuse.water');
        bus.emit('toast', { text, kind: 'warning', durationMs: 6000 });
        return;
      }
      ctx.sim.send({ type: 'spawn', tile: e.tile });
      hs.sound('confirm');
      hooks.ripple(e.clientX, e.clientY, 'spawn');
      return;
    }
    if (!playing()) return;
    if (hooks.radialOpen()) {
      hooks.closeRadial();
      if (e.button === 0) return;
    }
    // ---------------------------------------------------------------- right click: radial
    if (e.button === 2) {
      if (hs.mode.kind !== 'none') {
        hs.setMode({ kind: 'none' });
        hs.sound('cancel');
        return;
      }
      if (e.tile >= 0 && !isWaterTerrain(world.terrain[e.tile])) hooks.openRadial(e.clientX, e.clientY, e.tile);
      return;
    }
    if (e.button !== 0) return;
    const m = hs.mode;
    // ---------------------------------------------------------------- build placement
    if (m.kind === 'build') {
      const why = hs.buildError(m.structure, e.tile);
      if (why) {
        hs.sound('error');
        hooks.ripple(e.clientX, e.clientY, 'bad');
        bus.emit('toast', { text: t(why), kind: 'warning', durationMs: 2200 });
        return;
      }
      ctx.sim.send({ type: 'build', structure: m.structure, tile: e.tile });
      hs.sound('build');
      hooks.ripple(e.clientX, e.clientY, 'build');
      if (!e.shift) hs.setMode({ kind: 'none' });
      return;
    }
    // ---------------------------------------------------------------- weapon targeting
    if (m.kind === 'target') {
      if (e.tile < 0) return;
      const owner = view.owner[e.tile];
      if (owner !== 0 && owner !== HUMAN_ID && hs.isAlly(owner)) {
        hs.sound('error');
        bus.emit('toast', { text: t('msg.cannotNukeAlly'), kind: 'warning', durationMs: 2200 });
        return;
      }
      ctx.sim.send({ type: 'launch', weapon: m.weapon, targetTile: e.tile, siloId: -1 });
      hs.sound('confirm');
      hooks.ripple(e.clientX, e.clientY, 'fire');
      if (!e.shift) hs.setMode({ kind: 'none' });
      return;
    }
    // ---------------------------------------------------------------- unit orders
    if (m.kind === 'order' && e.unitId < 0 && e.structureId < 0) {
      const u = view.units.get(m.unitId);
      if (!u || e.tile < 0) {
        hs.setMode({ kind: 'none' });
        return;
      }
      if (u.type === UnitType.ArmoredDivision) ctx.sim.send({ type: 'deployArmor', unitId: u.id, targetTile: e.tile });
      else if (u.type === UnitType.Warship) ctx.sim.send({ type: 'moveUnit', unitId: u.id, tile: e.tile });
      else ctx.sim.send({ type: 'airStrike', unitId: u.id, targetTile: e.tile });
      hs.sound('confirm');
      hooks.ripple(e.clientX, e.clientY, 'order');
      if (!e.shift) hs.setMode({ kind: 'none' });
      return;
    }
    // ---------------------------------------------------------------- selection
    if (e.unitId >= 0) {
      const u = view.units.get(e.unitId);
      if (u) {
        hs.select({ kind: 'unit', id: u.id });
        hs.sound('click');
        const orderable = u.owner === HUMAN_ID && (u.type === UnitType.ArmoredDivision || u.type === UnitType.Warship || u.type === UnitType.FighterSquadron || u.type === UnitType.Bomber || u.type === UnitType.DroneSwarm);
        hs.setMode(orderable ? { kind: 'order', unitId: u.id } : { kind: 'none' });
        return;
      }
    }
    if (e.structureId >= 0 && view.structures.has(e.structureId)) {
      hs.select({ kind: 'structure', id: e.structureId });
      hs.sound('click');
      return;
    }
    // ---------------------------------------------------------------- attack / expand
    if (e.tile < 0 || isWaterTerrain(world.terrain[e.tile])) {
      if (hs.selection.kind !== 'none') hs.select({ kind: 'none' });
      return;
    }
    const owner = view.owner[e.tile];
    if (owner === HUMAN_ID) {
      if (hs.selection.kind !== 'none') hs.select({ kind: 'none' });
      return;
    }
    if (!isPlayableTerrain(world.terrain[e.tile])) return;
    const ok = attackNation(hs, owner, e.tile);
    hooks.ripple(e.clientX, e.clientY, ok ? (owner === 0 ? 'expand' : 'attack') : 'bad');
  });

  // ---- keyboard ---------------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const state = ctx.app.state;
    if (state === 'spawn' && (e.key === 'F1' || e.key === 'Escape')) {
      if (hooks.modalOpen()) return;
      e.preventDefault();
      if (e.key === 'F1') hooks.openHelp();
      else hooks.togglePauseMenu();
      return;
    }
    if (state !== 'playing') return;
    if (hooks.modalOpen() && e.key !== 'Escape') return;
    const key = e.key;
    const lower = key.toLowerCase();
    // Escape: cancel mode > close radial > deselect > pause menu
    if (key === 'Escape') {
      if (hooks.modalOpen()) return;
      e.preventDefault();
      if (hs.mode.kind !== 'none') {
        hs.setMode({ kind: 'none' });
        hs.sound('cancel');
      } else if (hooks.radialOpen()) hooks.closeRadial();
      else if (hooks.closeNations?.()) return;
      else if (hs.selection.kind !== 'none') {
        hs.select({ kind: 'none' });
        hs.sound('close');
      } else hooks.togglePauseMenu();
      return;
    }
    if (e.repeat) return;
    if (key === ' ' || e.code === 'Space') {
      e.preventDefault();
      ctx.app.togglePause();
      hs.sound('toggle');
      return;
    }
    const st = STRUCTURE_TYPES.find((s) => STRUCTURE_DEFS[s].hotkey === key);
    if (st !== undefined) {
      hooks.setBuildTab('build');
      const m = hs.mode;
      hs.setMode(m.kind === 'build' && m.structure === st ? { kind: 'none' } : { kind: 'build', structure: st });
      hs.sound('click');
      return;
    }
    const weapon = WEAPON_HOTKEYS[lower];
    if (weapon !== undefined) {
      const cfg = ctx.sim.view.config;
      const why = cfg && !cfg.nukes && weapon !== UnitType.CruiseMissile ? 'msg.nukesDisabled' : hs.ownStructures(StructureType.MissileSilo) === 0 ? 'msg.noSilo' : null;
      if (why) {
        hs.sound('error');
        bus.emit('toast', { text: t(why), kind: 'warning', durationMs: 2600 });
        return;
      }
      hooks.setBuildTab('arsenal');
      const m = hs.mode;
      hs.setMode(m.kind === 'target' && m.weapon === weapon ? { kind: 'none' } : { kind: 'target', weapon });
      hs.sound('click');
      return;
    }
    switch (lower) {
      case 't':
        hooks.takeControl();
        return;
      case 'b': {
        const tile = hs.hover.tile;
        if (tile < 0) return;
        const owner = ctx.sim.view.owner[tile];
        if (owner === HUMAN_ID) return;
        const shore = hs.nearestShoreOf(owner, tile, 20);
        // v2 (§4.11): a landing on a nation at peace opens the declaration first.
        if (needsDeclaration(hs, owner)) {
          openDeclareWar(hs, owner, shore >= 0 ? shore : tile, true);
          return;
        }
        ctx.sim.send({ type: 'boatAttack', targetTile: shore >= 0 ? shore : tile, ratio: hs.attackRatio });
        hs.sound('confirm');
        hooks.ripple(hs.hover.clientX, hs.hover.clientY, 'attack');
        return;
      }
      case '+':
      case '=': {
        const sp = ctx.sim.view.speed;
        const i = SPEEDS.indexOf(sp as GameSpeed);
        // From pause, + resumes at the slowest speed above it.
        ctx.app.setSpeed(i < 0 ? 1 : SPEEDS[Math.min(SPEEDS.length - 1, i + 1)]);
        hs.sound('click');
        return;
      }
      case '-':
      case '_': {
        const sp = ctx.sim.view.speed;
        const i = SPEEDS.indexOf(sp as GameSpeed);
        ctx.app.setSpeed(i < 0 ? 0.5 : SPEEDS[Math.max(0, i - 1)]);
        hs.sound('click');
        return;
      }
      case 'tab':
        e.preventDefault();
        hooks.toggleLeaderboard();
        return;
      case 'm':
        hooks.toggleMinimap();
        return;
      case 'n':
        hooks.toggleNations?.();
        return;
      case 'l':
        hooks.openLog?.();
        return;
      case 'h':
      case 'home': {
        const cap = ctx.sim.view.human?.capitalTile ?? -1;
        if (cap >= 0) {
          const ll = tileToLatLon(cap);
          bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: 3000, durationMs: 1200 });
          hs.sound('whoosh');
        }
        return;
      }
      case 'enter': {
        const tile = hs.hover.tile;
        const owner = tile >= 0 ? ctx.sim.view.owner[tile] : 0;
        if (owner && owner !== HUMAN_ID) hooks.openRadial(hs.hover.clientX, hs.hover.clientY, tile);
        return;
      }
      case 'f1':
      case '?':
        e.preventDefault();
        hooks.openHelp();
        return;
      default:
        break;
    }
    // Arrow/number keys for attack ratio fine tuning: [ and ]
    if (key === '[' || key === ']') {
      hs.setAttackRatio(hs.attackRatio + (key === ']' ? 0.05 : -0.05));
      hs.sound('slider');
    }
  });

  // ---- Shift + wheel: attack ratio (camera ignores wheel while Shift is held) ---------------------
  window.addEventListener('wheel', (e) => {
    if (!playing() || !e.shiftKey) return;
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (d === 0) return;
    hs.setAttackRatio(hs.attackRatio + (d < 0 ? 0.05 : -0.05));
    hs.sound('slider');
  }, { passive: true });

  // Units that die or get deselected drop out of order mode.
  bus.on('unitDestroyed', (e) => {
    const m = hs.mode;
    if (m.kind === 'order' && m.unitId === e.unitId) hs.setMode({ kind: 'none' });
  });
}

export function isCommandable(type: number): boolean {
  return !!UNIT_DEFS[type as UnitType]?.command;
}
