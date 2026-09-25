// FRONT ULTRA — cursor-following widgets (owner: ui): the hover tooltip over nations (who, strength, relation,
// what a click will do), the placement/targeting chip in build and weapon modes, and the spawn reticle.
// Positions are applied with transforms from the latest hover; content is patched at most ~10 Hz.

import { h, setStyle, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { nationRelation } from './diplomacy';
import type { HudShared } from './shared';
import { HUMAN_ID, NUKE_DEFS, STRUCTURE_DEFS, UNIT_DEFS } from '../../shared/constants';
import { hexToCss } from '../../shared/color';
import { tileToLatLon } from '../../shared/geo';
import { countryName, formatCompact, formatNumber, t } from '../../shared/i18n';
import { isPlayableTerrain, isWaterTerrain } from '../../shared/terrain';
import { TerrainClass, TERRAIN_CLASS_MASK, UnitType } from '../../shared/types';

export interface CursorLayer {
  el: HTMLElement;
  update(state: 'spawn' | 'playing' | 'other'): void;
}

export function createCursorLayer(hs: HudShared): CursorLayer {
  const ctx = hs.ctx;
  // Tooltip
  const ttSw = h('i', { class: 'fu-tt-sw' });
  const ttName = h('div', { class: 'fu-tt-name' });
  const ttRel = h('div', { class: 'fu-tt-rel' });
  const ttStats = h('div', { class: 'fu-tt-stats fu-mono' });
  const ttTerrain = h('div', { class: 'fu-tt-terrain' });
  const ttAction = h('div', { class: 'fu-tt-action' });
  const tooltip = h('div', { class: 'fu-tt fu-glass fu-hidden' }, h('div', { class: 'fu-tt-head' }, ttSw, ttName, ttRel), ttStats, ttTerrain, ttAction);
  // Mode chip
  const chipIco = h('span', { class: 'fu-chip-ico' });
  const chipName = h('b');
  const chipCost = h('span', { class: 'fu-mono' });
  const chipWhy = h('div', { class: 'fu-chip-why' });
  const chip = h('div', { class: 'fu-chip fu-glass fu-hidden' }, h('div', { class: 'fu-chip-row' }, chipIco, chipName, chipCost), chipWhy);
  // Spawn reticle
  const retLabel = h('div', { class: 'fu-ret-label' });
  const retCoords = h('div', { class: 'fu-ret-coords fu-mono' });
  const reticle = h('div', { class: 'fu-reticle fu-hidden' },
    h('div', { class: 'fu-ret-ring' }), h('div', { class: 'fu-ret-ring fu-ret-ring--2' }), h('div', { class: 'fu-ret-cross' }),
    h('div', { class: 'fu-ret-text' }, retLabel, retCoords),
  );
  const el = h('div', { class: 'fu-cursor-layer' }, tooltip, chip, reticle);

  let lastKey = '';
  let lastPaint = 0;
  let chipKey = '';

  // Cached sizes: measured only right after the content changed (never every frame).
  const size = new Map<HTMLElement, { w: number; h: number; dirty: boolean }>();
  const markDirty = (node: HTMLElement) => {
    const s0 = size.get(node);
    if (s0) s0.dirty = true;
    else size.set(node, { w: 0, h: 0, dirty: true });
  };
  let lastPreview = '';
  let buildKey = '';
  let buildWhy: string | null = null;
  const place = (node: HTMLElement, x: number, y: number, dx: number, dy: number) => {
    let sz = size.get(node);
    if (!sz) {
      sz = { w: 0, h: 0, dirty: true };
      size.set(node, sz);
    }
    if (sz.dirty) {
      sz.w = node.offsetWidth;
      sz.h = node.offsetHeight;
      sz.dirty = false;
    }
    const w = sz.w, hh = sz.h;
    let px = x + dx, py = y + dy;
    if (px + w > window.innerWidth - 8) px = x - dx - w;
    if (py + hh > window.innerHeight - 8) py = y - dy - hh;
    setStyle(node, 'transform', `translate3d(${Math.round(px)}px, ${Math.round(py)}px, 0)`);
  };

  function terrainName(tile: number): string {
    const world = ctx.sim.view.world;
    if (!world) return '';
    const c = world.terrain[tile] & TERRAIN_CLASS_MASK;
    const k = c === TerrainClass.Mountains ? 'terrain.mountains' : c === TerrainClass.Hills ? 'terrain.hills' : c === TerrainClass.Plains ? 'terrain.plains' : c === TerrainClass.Ice ? 'terrain.ice' : 'terrain.water';
    const country = countryName(world.countries[world.country[tile]]);
    if (!country) return t(k);
    // Owned land that historically belongs to another country names it (DESIGN_V2 §10.3): «antes: Francia».
    const owner = ctx.sim.view.owner[tile];
    if (owner !== 0 && hs.name(owner) !== country) return `${t(k)} · ${t('tt.formerly', { country })}`;
    return `${t(k)} · ${country}`;
  }

  function paintTooltip(tile: number): void {
    const view = ctx.sim.view;
    const world = view.world;
    if (!world || tile < 0 || isWaterTerrain(world.terrain[tile]) || hs.radialOpen) {
      tooltip.classList.add('fu-hidden');
      return;
    }
    const owner = view.owner[tile];
    const now = performance.now();
    const key = `${owner}:${tile}:${hs.hover.islandLabel ?? ''}`;
    if (key === lastKey && now - lastPaint < 250) return;
    lastKey = key;
    lastPaint = now;
    tooltip.classList.remove('fu-hidden');
    markDirty(tooltip);
    // On a small-island marker the first line names the island, its size and its owner (DESIGN_V2 §10.6).
    setText(ttTerrain, hs.hover.islandLabel ?? terrainName(tile));
    const me = view.human;
    if (owner === 0) {
      setStyle(ttSw, 'background', 'transparent');
      setText(ttName, isPlayableTerrain(world.terrain[tile]) ? t('hud.neutralLand') : t('terrain.ice'));
      setText(ttRel, '');
      ttRel.className = 'fu-tt-rel';
      setText(ttStats, '');
      setText(ttAction, isPlayableTerrain(world.terrain[tile]) && me ? t('tt.expand', { n: formatCompact(me.troops * hs.attackRatio) }) : '');
      ttAction.className = 'fu-tt-action is-go';
      return;
    }
    const p = view.players[owner];
    if (!p) return;
    setStyle(ttSw, 'background', hexToCss(p.color));
    setText(ttName, owner === HUMAN_ID ? `${p.name} · ${t('rel.self')}` : hs.name(owner));
    const rel = nationRelation(hs, owner);
    setText(ttRel, owner === HUMAN_ID ? '' : t(`rel.${rel}`));
    ttRel.className = `fu-tt-rel fu-rel--${rel}`;
    const land = world.landTiles || 1;
    setText(ttStats, `⚔ ${formatCompact(p.troops)}   ▦ ${((p.tiles / land) * 100).toFixed(2)}%   ◈ ${formatCompact(p.gold)}`);
    if (owner === HUMAN_ID) {
      setText(ttAction, t('tt.own'));
      ttAction.className = 'fu-tt-action';
    } else if (rel === 'ally') {
      setText(ttAction, t('tt.ally'));
      ttAction.className = 'fu-tt-action is-ally';
    } else if (me) {
      const send = me.troops * hs.attackRatio;
      const odds = send / Math.max(1, p.troops);
      setText(ttAction, t('tt.attack', { n: formatCompact(send) }));
      ttAction.className = `fu-tt-action ${odds > 0.6 ? 'is-go' : odds > 0.25 ? 'is-risky' : 'is-bad'}`;
    }
  }

  function paintChip(): boolean {
    const m = hs.mode;
    const view = ctx.sim.view;
    const tile = hs.hover.tile;
    if (m.kind === 'build') {
      const d = STRUCTURE_DEFS[m.structure];
      // Re-validate only when the tile, the structure or the sim state changed (not every frame).
      const vk = `${m.structure}:${tile}:${view.tick}`;
      if (vk !== buildKey) {
        buildKey = vk;
        buildWhy = tile >= 0 ? hs.buildError(m.structure, tile) : 'msg.cannotBuild';
      }
      const why = buildWhy;
      const key = `b${m.structure}:${why}`;
      if (key !== chipKey) {
        chipKey = key;
        markDirty(chip);
        chipIco.replaceChildren(icon(d.id));
        setText(chipName, t(`structure.${d.id}`));
        setText(chipCost, formatNumber(view.structureCost(m.structure)));
        setText(chipWhy, why ? t(why) : t('chip.place'));
        toggleClass(chip, 'is-bad', !!why);
      }
      const pk = `b${m.structure}:${tile}:${!why}`;
      if (pk !== lastPreview) {
        lastPreview = pk;
        ctx.bus.emit('buildPreview', { structure: m.structure, tile, valid: !why });
      }
      return true;
    }
    if (m.kind === 'target') {
      const nd = NUKE_DEFS[m.weapon];
      const owner = tile >= 0 ? view.owner[tile] : 0;
      const ally = owner !== 0 && owner !== HUMAN_ID && hs.isAlly(owner);
      const own = owner === HUMAN_ID;
      const poor = (view.human?.gold ?? 0) < view.unitCost(m.weapon);
      const why = tile < 0 ? 'msg.invalidTarget' : ally ? 'msg.cannotNukeAlly' : poor ? 'msg.notEnoughGold' : own ? 'chip.ownTerritory' : null;
      const key = `t${m.weapon}:${why}:${owner}`;
      if (key !== chipKey) {
        chipKey = key;
        markDirty(chip);
        chipIco.replaceChildren(icon(UNIT_DEFS[m.weapon].id));
        setText(chipName, t(`unit.${UNIT_DEFS[m.weapon].id}`));
        setText(chipCost, formatNumber(view.unitCost(m.weapon)));
        const target = owner && owner !== HUMAN_ID ? hs.name(owner) : '';
        setText(chipWhy, why ? t(why) : target ? t('chip.fireAt', { name: target }) : t('chip.fire'));
        toggleClass(chip, 'is-bad', !!why && why !== 'chip.ownTerritory');
        toggleClass(chip, 'is-warn', why === 'chip.ownTerritory');
        chip.classList.add('is-weapon');
      }
      const pk = `t${m.weapon}:${tile}:${why}`;
      if (pk !== lastPreview) {
        lastPreview = pk;
        ctx.bus.emit('targetPreview', { weapon: m.weapon, tile, innerRadius: nd.innerRadius, outerRadius: nd.outerRadius, valid: !why || why === 'chip.ownTerritory' });
      }
      return true;
    }
    if (m.kind === 'order') {
      const u = view.units.get(m.unitId);
      if (!u) return false;
      const world = view.world;
      const water = tile >= 0 && world ? isWaterTerrain(world.terrain[tile]) : false;
      const valid = tile >= 0 && (u.type === UnitType.Warship ? water : u.type === UnitType.ArmoredDivision ? !water : true);
      const key = `o${m.unitId}:${valid}`;
      if (key !== chipKey) {
        chipKey = key;
        markDirty(chip);
        chipIco.replaceChildren(icon(UNIT_DEFS[u.type].id));
        setText(chipName, t(`unit.${UNIT_DEFS[u.type].id}`));
        setText(chipCost, '');
        const k = u.type === UnitType.ArmoredDivision ? 'hud.order.deploy' : u.type === UnitType.Warship ? 'hud.order.move' : 'hud.order.strike';
        setText(chipWhy, valid ? t(k) : t('msg.invalidTarget'));
        toggleClass(chip, 'is-bad', !valid);
      }
      const pk = `o${u.id}:${tile}:${valid}`;
      if (pk !== lastPreview) {
        lastPreview = pk;
        ctx.bus.emit('orderPreview', { unitId: u.id, unit: u.type, tile, valid });
      }
      return true;
    }
    chip.classList.remove('is-weapon');
    chipKey = '';
    lastPreview = '';
    return false;
  }

  function paintReticle(tile: number): void {
    const view = ctx.sim.view;
    const world = view.world;
    if (!world || tile < 0) {
      reticle.classList.add('fu-hidden');
      return;
    }
    reticle.classList.remove('fu-hidden');
    const owner = view.owner[tile];
    const ok = isPlayableTerrain(world.terrain[tile]) && (owner === 0 || owner === HUMAN_ID);
    toggleClass(reticle, 'is-bad', !ok);
    const cn = countryName(world.countries[world.country[tile]]);
    const water = isWaterTerrain(world.terrain[tile]);
    setText(retLabel, !ok ? (water ? t('spawn.water') : owner ? t('spawn.taken', { name: hs.name(owner) }) : t('spawn.invalid')) : cn || t('hud.neutralLand'));
    const ll = tileToLatLon(tile);
    setText(retCoords, `${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'}  ${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}`);
  }

  return {
    el,
    update(state) {
      const hv = hs.hover;
      const hasPointer = hv.clientX >= 0;
      if (state === 'spawn') {
        tooltip.classList.add('fu-hidden');
        chip.classList.add('fu-hidden');
        if (!hasPointer) {
          reticle.classList.add('fu-hidden');
          return;
        }
        paintReticle(hv.tile);
        setStyle(reticle, 'transform', `translate3d(${Math.round(hv.clientX)}px, ${Math.round(hv.clientY)}px, 0)`);
        return;
      }
      reticle.classList.add('fu-hidden');
      if (state !== 'playing' || !hasPointer) {
        tooltip.classList.add('fu-hidden');
        chip.classList.add('fu-hidden');
        return;
      }
      const moding = paintChip();
      toggleClass(chip, 'fu-hidden', !moding);
      if (moding) {
        tooltip.classList.add('fu-hidden');
        place(chip, hv.clientX, hv.clientY, 22, 18);
        return;
      }
      paintTooltip(hv.tile);
      if (!tooltip.classList.contains('fu-hidden')) place(tooltip, hv.clientX, hv.clientY, 20, 20);
    },
  };
}
