// FRONT ULTRA — cursor-following widgets (owner: ui): the hover tooltip over nations (who, strength, relation,
// what a click will do), the placement/targeting chip in build and weapon modes, and the spawn reticle.
// Positions are applied with transforms from the latest hover; content is patched at most ~10 Hz.

import { h, setStyle, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { nationRelation } from './diplomacy';
import type { HudShared } from './shared';
import { STRUCT_IDS } from './forcesInfo';
import { chipText, previewOrders, selectedUnitIds, type OrderPreview } from './orderCtl';
import { structureName, unitName } from './forcesInfo';
import { describeXY } from '../places';
import { HUMAN_ID, NUKE_DEFS, OFFENSIVE_CONTACT_TICKS, STRUCTURE_DEFS, TILE_KM, UNIT_DEFS } from '../../shared/constants';
import { predictOffensive } from '../../shared/orders';
import { forecastOffensive } from './offensiveForecast';
import { viewRules } from '../../sim/rulesView';
import { hexToCss } from '../../shared/color';
import { tileToLatLon } from '../../shared/geo';
import { countryName, formatCompact, formatNumber, t } from '../../shared/i18n';
import { isPlayableTerrain, isWaterTerrain } from '../../shared/terrain';
import { TerrainClass, TERRAIN_CLASS_MASK } from '../../shared/types';

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
  let orderKey = '';
  let orderPv: OrderPreview | null = null;
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

  /**
   * §7.7: «CLIC: ofensiva con 120.000 (50 %) · relación 2,3 : 1 · frente de 6 casillas (150 km) · avance ≈ 5 km/h en
   * llano», red / amber / green by the ratio; «ofensiva preparada; empezará en 4 h» while mobilizing; the declaration at
   * peace; «Sin frontera…» when neither a border nor a coast is in reach. The corridor is drawn on the map.
   */
  function offensiveLine(owner: number, tile: number): { text: string; cls: string } {
    const view = ctx.sim.view;
    const me = view.human!;
    const send = me.troops * hs.attackRatio;
    const pctS = Math.round(hs.attackRatio * 100);
    const r = viewRules(view);
    const borders = hs.borders(owner);
    const emit = (valid: boolean, frontage: number, ratio: number) => {
      const k = `${tile}:${valid}:${Math.round(frontage)}:${ratio.toFixed(1)}`;
      if (k === offKey) return;
      offKey = k;
      ctx.bus.emit('offensivePreview', { tile, frontageTiles: frontage, ratio, valid });
    };
    if (owner !== 0 && view.players[owner]?.kind !== 'tribe' && view.pairState(HUMAN_ID, owner) !== 'war') {
      emit(false, 0, 0);
      return { text: t('tt.declare', { name: hs.name(owner) }), cls: 'is-risky' };
    }
    if (!borders) {
      const shore = hs.nearestShoreOf(owner, tile, 30);
      emit(false, 0, 0);
      if (shore < 0) return { text: t('tt.noBorder'), cls: 'is-bad' };
      return { text: t('tt.naval', { n: formatCompact(send), p: pctS }), cls: 'is-risky' };
    }
    const pr = predictOffensive(r, HUMAN_ID, owner, send, tile);
    if (owner === 0 || view.players[owner]?.kind === 'tribe' && pr.garrison <= 0) {
      const fr = Math.round(pr.frontageTiles);
      const km = formatNumber(Math.round(pr.frontageTiles * TILE_KM));
      emit(true, pr.frontageTiles, 3);
      return { text: t('tt.expandV2', { n: formatCompact(send), p: pctS, f: fr, km, v: formatNumber(pr.advanceKmh, 1) }), cls: 'is-go' };
    }
    // Gauntlet 29a: the same forecast as the offensive dialog and the Guerra panel (offensiveForecast.ts): a click here
    // reinforces our running offensive on that front, so its troops count; the speed is the one this ground allows.
    const fc = forecastOffensive(view, owner, tile, send);
    emit(true, fc.corridorTiles, fc.ratio);
    const mob = pr.startsInTicks - OFFENSIVE_CONTACT_TICKS;
    if (mob > 0 && !fc.running) return { text: t('tt.offensiveQueued', { h: formatNumber(Math.max(1, Math.round(mob / 10))), n: formatCompact(send) }), cls: 'is-risky' };
    const params = {
      n: formatCompact(send), p: pctS, r: formatNumber(fc.ratio, 1), f: Math.round(fc.corridorTiles), km: formatNumber(Math.round(fc.corridorKm)),
      v: formatNumber(fc.kmh, 1), ground: t(`g1.ground.${fc.ground}`),
    };
    // A reinforcement reads «now → after» (the Guerra panel shows the offensive as it is now: the same first number).
    let text = fc.running && fc.ratioNow > 0
      ? t('g1.tt.reinforceNow', { ...params, r0: formatNumber(fc.ratioNow, 1), km0: formatNumber(Math.round(fc.corridorKmNow)) })
      : t(fc.running ? 'g1.tt.reinforce' : 'g1.tt.offensive', params);
    if (fc.ratio < 1) text += ` · ${t('tt.offensive.stall')}`;
    else if (fc.saturated) text += ` · ${t('g1.tt.capped', { limit: t(`g1.limitBy.${fc.ground}`) })}`;
    return { text, cls: fc.ratio >= 2 ? 'is-go' : fc.ratio >= 1 ? 'is-risky' : 'is-bad' };
  }
  let offKey = '';
  function clearOffensive(): void {
    if (offKey === 'off') return;
    offKey = 'off';
    ctx.bus.emit('offensivePreview', { tile: -1, frontageTiles: 0, ratio: 0, valid: false });
  }

  /**
   * The pointer is on a unit or a structure (its icon or its model): a left click selects it (or fans out an icon
   * cluster) instead of acting on the land beneath, so the card says so — never «CLIC: declarar la guerra» over an enemy
   * silo. Returns false when nothing is picked there.
   */
  function paintPicked(): boolean {
    const hv = hs.hover;
    if ((hv.unitId < 0 && hv.structureId < 0) || hs.radialOpen) return false;
    const view = ctx.sim.view;
    const s = hv.structureId >= 0 ? view.structures.get(hv.structureId) : undefined;
    const u = !s && hv.unitId >= 0 ? view.units.get(hv.unitId) : undefined;
    if (!s && !u) return false;
    const now = performance.now();
    const key = `p${hv.unitId}:${hv.structureId}`;
    if (key === lastKey && now - lastPaint < 250) return true;
    lastKey = key;
    lastPaint = now;
    clearOffensive();
    tooltip.classList.remove('fu-hidden');
    markDirty(tooltip);
    const pick = ctx.units.pickIcon?.(hv.clientX, hv.clientY) ?? null;
    const cluster = pick && pick.kind === 'cluster' ? pick.members.length : 0;
    const owner = s ? s.owner : u!.owner;
    const p = view.players[owner];
    setStyle(ttSw, 'background', p ? hexToCss(p.color) : 'transparent');
    const own = owner === HUMAN_ID;
    const rel = own ? 'self' : nationRelation(hs, owner);
    if (cluster) setText(ttName, own ? t('tt.pick.cluster.own', { n: cluster }) : t('tt.pick.cluster', { n: cluster, name: hs.name(owner) }));
    else setText(ttName, s ? structureName(hs, s) : unitName(u!));
    setText(ttRel, own ? t('rel.self') : t(`rel.${rel}`));
    ttRel.className = `fu-tt-rel fu-rel--${rel}`;
    if (s && !cluster) setText(ttStats, `${own ? p?.name ?? '' : hs.name(owner)} · ${t('card.levelN', { n: s.level, max: STRUCTURE_DEFS[s.type].maxLevel })}`);
    else setText(ttStats, own ? '' : hs.name(owner));
    const x = s ? (s.tile % 1600) + 0.5 : u!.x, y = s ? Math.floor(s.tile / 1600) + 0.5 : u!.y;
    setText(ttTerrain, describeXY(view, x, y).text);
    const what = s ? 'structure' : 'unit';
    setText(ttAction, cluster ? t('tt.pick.fan', { n: cluster }) : own ? t(`tt.pick.own.${what}`) : t(`tt.pick.foreign.${what}`, { name: hs.name(owner) }));
    ttAction.className = 'fu-tt-action';
    return true;
  }

  function paintTooltip(tile: number): void {
    const view = ctx.sim.view;
    const world = view.world;
    if (paintPicked()) return;
    if (!world || tile < 0 || isWaterTerrain(world.terrain[tile]) || hs.radialOpen) {
      tooltip.classList.add('fu-hidden');
      clearOffensive();
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
    // Feedback 3 (#27): rubble of a destroyed structure: what it was, who destroyed it, when, and the rebuild price.
    const ruin = view.ruins.find((r) => r.tile === tile);
    if (ruin) {
      const h0 = Math.max(0, (view.tick - ruin.tick) / 10);
      const when = h0 >= 24 ? t('aar.days', { n: formatNumber(h0 / 24, 1) }) : t('aar.hours', { n: formatNumber(h0, 0) });
      setText(ttTerrain, `${t('ruin.title', { s: t(`structure.${STRUCT_IDS[ruin.type] ?? 'city'}`) })} — ${t('ruin.text', { name: ruin.by > 0 ? hs.name(ruin.by) : '—', when })}`);
    }
    const me = view.human;
    if (owner === 0) {
      setStyle(ttSw, 'background', 'transparent');
      setText(ttName, isPlayableTerrain(world.terrain[tile]) ? t('hud.neutralLand') : t('terrain.ice'));
      setText(ttRel, '');
      ttRel.className = 'fu-tt-rel';
      setText(ttStats, '');
      if (isPlayableTerrain(world.terrain[tile]) && me) {
        const o = offensiveLine(0, tile);
        setText(ttAction, o.text);
        ttAction.className = `fu-tt-action ${o.cls}`;
      } else setText(ttAction, '');
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
      clearOffensive();
      setText(ttAction, t('tt.own'));
      ttAction.className = 'fu-tt-action';
    } else if (rel === 'ally') {
      setText(ttAction, t('tt.ally'));
      ttAction.className = 'fu-tt-action is-ally';
    } else if (me) {
      // v2 (§7.7): what a left click does here, with the prediction the sim's rules give.
      const o = offensiveLine(owner, tile);
      setText(ttAction, o.text);
      ttAction.className = `fu-tt-action ${o.cls}`;
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
        toggleClass(chipWhy, 'is-long', false);
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
        toggleClass(chipWhy, 'is-long', false);
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
    // v2 (§7.3, §7.4): with own units selected, the chip previews what a right click orders (or the card's order mode
    // what the left click orders), with distance, ETA, road or rail and the exact reason when a unit cannot comply.
    const ids = m.kind === 'order' || m.kind === 'none' ? selectedUnitIds(hs) : [];
    if (ids.length && tile >= 0) {
      const hv = hs.hover;
      const forced = m.kind === 'order' ? m.order : undefined;
      const pk = `o${ids.join(',')}:${tile}:${hv.unitId}:${hv.structureId}:${hv.shift}:${forced ?? ''}:${view.tick}:${hs.orderNote && hs.orderNote.until > performance.now() ? hs.orderNote.text : ''}`;
      if (pk !== orderKey) {
        orderKey = pk;
        const pv = previewOrders(hs, ids, tile, hv.unitId, hv.structureId, hv.shift, forced);
        orderPv = pv;
        (window as unknown as { __fuOrderPreview?: unknown }).__fuOrderPreview = pv
          ? { tile, n: pv.n, m: pv.m, order: pv.order, plans: pv.plans.map((p) => ({ unitId: p.unitId, order: p.order, targetId: p.targetId, ok: !p.issue || !!p.issue.confirm, key: p.issue?.key ?? null })) }
          : null;
        if (pv) {
          const txt = chipText(hs, pv);
          // The refusal of the order just given, folded into one line on the chip for a few seconds.
          const note = hs.orderNote && hs.orderNote.until > performance.now() ? hs.orderNote : null;
          if (note) {
            txt.line = note.text;
            txt.bad = txt.bad || note.bad;
          }
          const key = `o${txt.title}|${txt.line}|${txt.bad}`;
          if (key !== chipKey) {
            chipKey = key;
            markDirty(chip);
            const lead = view.units.get(ids[0]);
            chipIco.replaceChildren(icon(forced ? 'target' : lead ? UNIT_DEFS[lead.type].id : 'target'));
            setText(chipName, txt.title);
            setText(chipCost, m.kind === 'order' ? t('chip.leftClick') : t('chip.rightClick'));
            setText(chipWhy, txt.line);
            toggleClass(chipWhy, 'is-long', txt.line.length > 70);
            toggleClass(chip, 'is-bad', txt.bad);
            toggleClass(chip, 'is-warn', !txt.bad && pv.n < pv.m);
          }
          const leadPlan = pv.plans.find((p) => !p.issue || p.issue.confirm) ?? pv.plans[0];
          const pvKey = `o${leadPlan?.unitId}:${tile}:${!txt.bad}:${pv.plans.length}`;
          if (pvKey !== lastPreview) {
            lastPreview = pvKey;
            ctx.bus.emit('orderPreview', { unitId: leadPlan?.unitId ?? -1, unit: view.units.get(leadPlan?.unitId ?? -1)?.type ?? -1, tile, valid: !txt.bad, unitIds: pv.plans.map((p) => p.unitId), valids: pv.plans.map((p) => !p.issue || !!p.issue.confirm), rail: !!leadPlan?.rail });
          }
        }
      }
      if (orderPv) return true;
    } else if (orderKey) {
      orderKey = '';
      orderPv = null;
      if (lastPreview.startsWith('o')) {
        lastPreview = '';
        ctx.bus.emit('orderPreview', { unitId: -1, unit: -1, tile: -1, valid: false });
      }
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
        clearOffensive();
        tooltip.classList.add('fu-hidden');
        place(chip, hv.clientX, hv.clientY, 22, 18);
        return;
      }
      paintTooltip(hv.tile);
      if (!tooltip.classList.contains('fu-hidden')) place(tooltip, hv.clientX, hv.clientY, 20, 20);
    },
  };
}
