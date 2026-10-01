// FRONT ULTRA — the nuclear launch confirmation (DESIGN_V2 §4.14, §5.10, §5.11; owner item 13: «misiles con sentido»).
//
// A nuclear weapon is launched only at a nation the human is at war with (the sim refuses anything else), and only
// after this dialog: the target and its owner, the escalation the war rises to, every nation with land inside the
// outer radius (naming those at peace with us: for them it is a nuclear attack and a casus belli), and the cost in
// opinion, coalitions and the doomsday clock.

import { h } from '../dom';
import { openModal } from '../modal';
import { describeTile } from '../places';
import { tip } from '../tooltip';
import { tx } from '../tx';
import type { HudShared } from './shared';
import { HUMAN_ID, MAP_H, MAP_W, NUKE_DEFS, TILE_KM, UNIT_DEFS } from '../../shared/constants';
import { MIRV_SPREAD } from '../../sim/balance';
import { formatNumber, t } from '../../shared/i18n';
import { UnitType, type WeaponType } from '../../shared/types';

/** Why the human may not aim this nuclear weapon at `tile` (null = it may), as an i18n key. */
export function nukeAimError(hs: HudShared, tile: number): string | null {
  const v = hs.ctx.sim.view;
  const o = v.owner[tile];
  const p = o > 0 ? v.players[o] : undefined;
  if (!p || p.kind === 'tribe' || o === HUMAN_ID) return 'msg.nukeNoTarget';
  if (v.pairState(HUMAN_ID, o) !== 'war') return 'msg.nukeNotAtWar';
  return null;
}

/** Owners (nations and tribes) with land within `r` tiles of `tile`. */
function ownersInRadius(hs: HudShared, tile: number, r: number): number[] {
  const v = hs.ctx.sim.view;
  const cx = tile % MAP_W, cy = Math.floor(tile / MAP_W);
  const out = new Set<number>();
  const ri = Math.ceil(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= MAP_H) continue;
    // Tiles shrink east-west with latitude: widen the scan so the radius is in surface kilometres.
    const lat = (90 - (y + 0.5) * (180 / MAP_H)) * (Math.PI / 180);
    const k = 1 / Math.max(0.2, Math.cos(lat));
    const rx = Math.ceil(ri * k);
    for (let dx = -rx; dx <= rx; dx++) {
      if ((dx / k) * (dx / k) + dy * dy > r * r) continue;
      const o = v.owner[y * MAP_W + (((cx + dx) % MAP_W) + MAP_W) % MAP_W];
      if (o > 0 && o !== HUMAN_ID) out.add(o);
    }
  }
  return [...out];
}

export function openNukeConfirm(hs: HudShared, weapon: WeaponType, tile: number, go: () => void): void {
  const v = hs.ctx.sim.view;
  const owner = v.owner[tile];
  const level = weapon === UnitType.AtomBomb ? 3 : 4;
  const r = weapon === UnitType.Mirv ? MIRV_SPREAD + NUKE_DEFS[UnitType.MirvWarhead].outerRadius : NUKE_DEFS[weapon].outerRadius;
  const hit = ownersInRadius(hs, tile, r);
  const neutral = hit.filter((o) => v.players[o]?.kind !== 'tribe' && v.pairState(HUMAN_ID, o) !== 'war');
  const war = v.warBetween(HUMAN_ID, owner);
  const ours = war ? (war.aggressor === HUMAN_ID ? war.escalationA : war.escalationB) : 0;
  const names = (ids: number[]) => ids.map((o) => hs.name(o)).filter(Boolean).join(', ');
  const body = [
    h('p', null, t('nuke.confirm.target', { place: describeTile(v, tile).name, owner: hs.name(owner) })),
    ours < level ? h('p', null, t('nuke.confirm.escalation', { owner: hs.name(owner), n: level, name: t(`escalation.short.${level}`) })) : null,
    h('p', null, t('nuke.confirm.hit', { km: formatNumber(Math.round(r * TILE_KM)), names: names(hit) || hs.name(owner) })),
    neutral.length ? h('p', { class: 'fu-civil-warn' }, t('nuke.confirm.neutral', { names: names(neutral) })) : null,
    h('p', { class: 'fu-civil-note' }, t('nuke.confirm.cost')),
  ];
  const cancel = h('button', { class: 'fu-btn' }, tx('common.cancel'));
  tip(cancel, () => ({ title: t('common.cancel'), text: t('nuke.confirm.cancel.tip') }));
  const fire = h('button', { class: 'fu-btn fu-btn--danger fu-nuke-fire' }, tx('nuke.confirm.fire'));
  tip(fire, () => ({ title: t('nuke.confirm.fire'), text: t('nuke.confirm.fire.tip', { g: formatNumber(v.unitCost(weapon)) }) }));
  const m = openModal({
    titleKey: 'nuke.confirm.title', titleParams: { weapon: t(`unit.${UNIT_DEFS[weapon].id}`) }, kickerKey: 'nuke.confirm.kicker',
    narrow: true, className: 'fu-civil-confirm fu-nuke-confirm', body, foot: [cancel, fire],
  });
  cancel.addEventListener('click', () => m.close());
  fire.addEventListener('click', () => {
    go();
    m.close();
  });
}
