// FRONT ULTRA — spawn phase overlay (owner: ui; onboarding reworked by W3, DESIGN_V2 §12.6, B01/B02).
//
// In single player the spawn phase waits for the human: the AI nations already sit in their countries and nothing
// runs until you found your capital on free land. The briefing says so, «Sugerir un lugar» founds it on the free land
// nearest the centre of the view, clicks on a nation's land are explained (controller.ts), and once the capital is
// placed a 5-second ring counts down to the start (a click elsewhere still moves it). If a session ever uses a spawn
// deadline, the automatic placement also takes the free land nearest the view centre and says so.

import { h, setStyle, setText, toggleClass } from '../dom';
import { icon } from '../icons';
import { tip } from '../tooltip';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { HUMAN_ID, MAP_H, MAP_W } from '../../shared/constants';
import { countryName, t } from '../../shared/i18n';
import { isPlayableTerrain } from '../../shared/terrain';

export interface SpawnOverlay {
  el: HTMLElement;
  refresh(): void;
  invalidate(): void;
}

/** Free playable land nearest to a tile (square spiral, up to `r` tiles away), -1 when none. */
export function nearestFreeLand(hs: HudShared, center: number, r = 260): number {
  const view = hs.ctx.sim.view;
  const world = view.world;
  if (!world || center < 0) return -1;
  const cx = center % MAP_W, cy = (center / MAP_W) | 0;
  const ok = (x: number, y: number) => {
    if (y < 0 || y >= MAP_H) return -1;
    const lat = 90 - ((y + 0.5) / MAP_H) * 180;
    if (lat > 70 || lat < -56) return -1;
    const tl = y * MAP_W + ((x % MAP_W) + MAP_W) % MAP_W;
    return view.owner[tl] === 0 && isPlayableTerrain(world.terrain[tl]) ? tl : -1;
  };
  const lat0 = 90 - ((cy + 0.5) / MAP_H) * 180;
  const kx = Math.max(0.05, Math.cos((lat0 * Math.PI) / 180) ** 2);
  let best = -1, bd = Infinity;
  for (let ring = 0; ring <= r; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (const dx of Math.abs(dy) === ring ? rangeAll(ring) : [-ring, ring]) {
        const tl = ok(cx + dx, cy + dy);
        if (tl < 0) continue;
        const d = dx * dx * kx + dy * dy;
        if (d < bd) {
          bd = d;
          best = tl;
        }
      }
    }
    if (best >= 0 && ring * ring > bd * 1.2) break;
  }
  return best;
}
function rangeAll(r: number): number[] {
  const out: number[] = [];
  for (let i = -r; i <= r; i++) out.push(i);
  return out;
}

export function createSpawnOverlay(hs: HudShared): SpawnOverlay {
  const ctx = hs.ctx;
  const secs = h('div', { class: 'fu-sp-secs fu-mono' }, '--');
  const ring = h('div', { class: 'fu-sp-ring' }, secs, h('small', null, tx('spawn.seconds')));
  const title = h('h2', { class: 'fu-sp-title' });
  const text = h('p', { class: 'fu-sp-text' });
  const nations = h('span', { class: 'fu-mono' }, '0');
  const status = h('div', { class: 'fu-sp-status' }, h('i'), h('span', null, nations, ' ', tx('spawn.deployed')));
  const suggest = h('button', { class: 'fu-btn fu-btn--primary fu-btn--sm fu-sp-suggest fu-interactive' }, icon('flag'), tx('spawn.suggest'));
  tip(suggest, () => ({ title: t('spawn.suggest'), text: t('spawn.suggest.tip') }));
  const el = h('div', { class: 'fu-spawn fu-glass fu-brackets fu-interactive' },
    ring,
    h('div', { class: 'fu-sp-body' }, tx('spawn.kicker', undefined, 'div'), title, text, status, suggest),
  );
  el.querySelector('.fu-sp-body > div')!.classList.add('fu-sp-kicker');
  const hint = h('div', { class: 'fu-sp-hint' }, icon('mouse'), tx('spawn.clickHint'));
  const wrap = h('div', { class: 'fu-spawn-wrap' }, el, hint);

  const suggestTile = () => {
    const W = window.innerWidth, H = window.innerHeight;
    let c = ctx.globe.pickTile(W / 2, H / 2);
    if (c < 0) {
      const s = ctx.cameraRig.getState();
      c = Math.floor(((90 - s.lat) / 180) * MAP_H) * MAP_W + Math.floor(((s.lon + 180) / 360) * MAP_W);
    }
    return nearestFreeLand(hs, c);
  };
  suggest.addEventListener('click', () => {
    const tile = suggestTile();
    if (tile < 0) {
      hs.sound('error');
      ctx.bus.emit('toast', { text: t('spawn.noFreeLand'), kind: 'warning' });
      return;
    }
    hs.sound('confirm');
    ctx.sim.send({ type: 'spawn', tile });
  });

  let placed = -2;
  let autoSent = false;
  return {
    el: wrap,
    invalidate() {
      placed = -2;
    },
    refresh() {
      const view = ctx.sim.view;
      const me = view.human;
      const spawned = !!me?.spawned;
      const cap = me?.capitalTile ?? -1;
      if ((spawned ? cap : -1) !== placed) {
        placed = spawned ? cap : -1;
        toggleClass(el, 'is-placed', spawned);
        toggleClass(hint, 'fu-hidden', spawned);
        if (spawned && view.world) {
          const c = countryName(view.world.countries[view.world.country[cap]]);
          setText(title, t('spawn.placedTitle'));
          setText(text, t('spawn.placedText', { place: c || t('hud.neutralLand') }));
          setText(suggest.querySelector('[data-i18n]') as HTMLElement, t('spawn.suggestAgain'));
        } else {
          setText(title, t('spawn.title'));
          setText(text, t('spawn.waitHint'));
          setText(suggest.querySelector('[data-i18n]') as HTMLElement, t('spawn.suggest'));
        }
      }
      let n = 0;
      for (const p of view.playerList) if (p.spawned && p.id !== HUMAN_ID && p.kind === 'nation') n++;
      setText(nations, String(n));
      const left = view.spawnDeadlineTick > 0 && view.spawnDeadlineTick < 1e12 ? Math.max(0, (view.spawnDeadlineTick - view.tick) / 10) : -1;
      if (left >= 0 && left < 1e6) {
        setText(secs, String(Math.ceil(left)));
        const total = spawned ? 5 : Math.max(5, (view.config?.spawnTimeoutTicks ?? 900) / 10);
        setStyle(ring, '--p', `${Math.max(0, Math.min(1, left / total)) * 360}deg`);
        toggleClass(ring, 'is-low', left < 10);
        // A deadline about to run out: place on the free land nearest the view centre and say so (§12.6).
        if (!spawned && left < 1.2 && !autoSent) {
          const tile = suggestTile();
          if (tile >= 0) {
            autoSent = true;
            ctx.sim.send({ type: 'spawn', tile });
            ctx.bus.emit('toast', { text: t('spawn.autoPlaced'), kind: 'info', durationMs: 7000 });
          }
        }
      } else {
        setText(secs, '∞');
        setStyle(ring, '--p', '360deg');
        toggleClass(ring, 'is-low', false);
        autoSent = false;
      }
    },
  };
}
