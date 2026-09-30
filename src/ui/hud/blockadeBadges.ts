// FRONT ULTRA — blockade chips on the map (owner item 30; owner: ui). Over every blockade zone (the hatched disc the
// units renderer draws) a small chip names the closed lane and who holds it, and says what it does right now:
//   ours           «Estrecho de Gibraltar · tu bloqueo» / «+1.012 oro/h · 3 apresados · 2 desviados»
//   against us     «Estrecho de Gibraltar · Argelia» / «te cuesta −430 oro/h · 2 apresados»
//   others         «Estrecho de Ormuz · Irán» / «4 detenidos»
// Hover: whom it stops and what it did per nation; click: the Guerra panel's «Mar» tab and the camera over the zone.
// Shown above 150 km in the strategic view.

import * as THREE from 'three';
import { h, setText, toggleClass } from '../dom';
import { tip } from '../tooltip';
import { hexToCss } from '../../shared/color';
import { HUMAN_ID } from '../../shared/constants';
import { latLonToVec3, tileXYToLatLon } from '../../shared/geo';
import { t } from '../../shared/i18n';
import { BLOCKADE_RADIUS_TILES, blockadeApplies, type BlockadeView } from '../../shared/naval';
import { blockadePlace, gold, specText, stopsText, viewRelations } from './navalInfo';
import type { HudShared } from './shared';

const MIN_ALT = 150;

interface Chip {
  id: number;
  el: HTMLElement;
  top: HTMLElement;
  sub: HTMLElement;
  pos: THREE.Vector3;
}

export function createBlockadeBadges(hs: HudShared): { el: HTMLElement; update(): void } {
  const ctx = hs.ctx;
  const el = h('div', { class: 'fu-blk-badges' });
  const chips = new Map<number, Chip>();
  const vc = new THREE.Vector3(), camPos = new THREE.Vector3();
  let acc = 1e9;

  function make(b: BlockadeView): Chip {
    const top = h('b');
    const sub = h('span');
    const c: Chip = { id: b.id, el: h('button', { class: 'fu-blk-badge fu-interactive' }, top, sub), top, sub, pos: new THREE.Vector3() };
    c.el.addEventListener('click', () => {
      hs.sound('click');
      hs.openSea();
      const cur = ctx.sim.view.blockades.find((x) => x.id === c.id);
      if (cur) {
        const ll = tileXYToLatLon(cur.x, cur.y);
        ctx.bus.emit('focusRequest', { lat: ll.lat, lon: ll.lon, altitudeKm: Math.min(1600, Math.max(700, ctx.cameraRig.getState().altitudeKm * 0.6)), durationMs: 1200 });
      }
    });
    tip(c.el, () => {
      const cur = ctx.sim.view.blockades.find((x) => x.id === c.id);
      if (!cur) return null;
      return {
        title: t('naval.badge.tipTitle', { place: blockadePlace(hs, cur), name: cur.owner === HUMAN_ID ? t('naval.badge.you') : hs.name(cur.owner) }),
        text: specText(hs, cur.spec),
        lines: [stopsText(cur), ...cur.nations.slice(0, 6).map((n) => `${hs.name(n.id)}: ${stopsText(n)}${n.piracy ? ` · ${t('naval.badge.piracy')}` : ''}`), t('naval.badge.click')],
      };
    });
    el.append(c.el);
    return c;
  }

  function paint(c: Chip, b: BlockadeView): void {
    const v = ctx.sim.view;
    const rel = viewRelations(v);
    const place = blockadePlace(hs, b);
    const against = b.owner !== HUMAN_ID && (blockadeApplies(rel, b.owner, b.spec, HUMAN_ID, 'trade') || blockadeApplies(rel, b.owner, b.spec, HUMAN_ID, 'transport'));
    setText(c.top, t(b.owner === HUMAN_ID ? 'naval.badge.ours' : 'naval.badge.theirs', { place, name: hs.name(b.owner) }));
    const me = b.nations.find((n) => n.id === HUMAN_ID);
    let sub: string;
    if (!b.active) sub = t('naval.badge.onWay');
    else if (b.owner === HUMAN_ID) sub = t('naval.badge.oursSub', { g: gold(b.goldPerHour), stops: stopsText(b) });
    else if (against) sub = me ? t('naval.badge.againstSub', { g: gold(me.lost), stops: stopsText(me) }) : t('naval.badge.againstNone');
    else sub = stopsText(b);
    setText(c.sub, sub);
    toggleClass(c.el, 'is-ours', b.owner === HUMAN_ID);
    toggleClass(c.el, 'is-against', against);
    c.el.style.setProperty('--blk-color', hexToCss(v.players[b.owner]?.color ?? 0x888888));
    // Anchor: the zone's northern edge.
    const ll = tileXYToLatLon(b.x, Math.max(0, b.y - BLOCKADE_RADIUS_TILES * 0.9));
    latLonToVec3(ll.lat, ll.lon, 1.004, c.pos);
  }

  return {
    el,
    update() {
      const v = ctx.sim.view;
      const alt = ctx.cameraRig.getState().altitudeKm;
      const on = ctx.app.state === 'playing' && v.phase === 'playing' && alt > MIN_ALT;
      toggleClass(el, 'fu-hidden', !on);
      if (!on) return;
      acc += ctx.frame.dt;
      if (acc > 0.5) {
        acc = 0;
        const seen = new Set<number>();
        for (const b of v.blockades) {
          if (b.endTick) continue;
          seen.add(b.id);
          const c = chips.get(b.id) ?? make(b);
          chips.set(b.id, c);
          paint(c, b);
        }
        for (const [id, c] of chips) {
          if (seen.has(id)) continue;
          c.el.remove();
          chips.delete(id);
        }
      }
      const cam = ctx.camera;
      camPos.copy(cam.position);
      const W = window.innerWidth, H = window.innerHeight;
      const occ = ctx.ui.getOccludedRects();
      for (const c of chips.values()) {
        const facing = vc.copy(camPos).sub(c.pos).dot(c.pos) > 0;
        vc.copy(c.pos).project(cam);
        const x = ((vc.x + 1) / 2) * W, y = ((1 - vc.y) / 2) * H;
        const w = c.el.offsetWidth || 150, hh = c.el.offsetHeight || 34;
        const x0 = x - w / 2, y0 = y - hh - 6;
        let ok = facing && vc.z < 1 && x0 > 2 && y0 > 2 && x0 + w < W - 2 && y0 + hh < H - 2;
        if (ok) ok = !occ.some((r) => x0 < r.right && x0 + w > r.left && y0 < r.bottom && y0 + hh > r.top);
        if (!ok) {
          if (c.el.style.display !== 'none') c.el.style.display = 'none';
          continue;
        }
        if (c.el.style.display === 'none') c.el.style.display = '';
        c.el.style.transform = `translate(${x0.toFixed(1)}px, ${y0.toFixed(1)}px)`;
      }
    },
  };
}
