// FRONT ULTRA — «Tomar el control aquí» (owner feedback #3, items 26 and 29e; owner: ui).
// One way in from every place the war shows up: a front badge (double click), a front row of the Guerra panel, the
// battle strip, an alert, a unit's mission. The app picks the best own unit for it (engaged there, else the nearest
// division) and command mode takes it to the action (app.enterCommandAt); the exit looks back at that place.

import { HUMAN_ID, MAP_H, MAP_W } from '../../shared/constants';
import { t } from '../../shared/i18n';
import type { GameView } from '../../shared/api';
import type { HudShared } from './shared';
import { frontName } from './forcesInfo';

/** The place of a front's action: an offensive's live contact on it (ours first), else the whole front. */
export function frontAction(view: GameView, key: number): { x: number; y: number; attackId?: number } | null {
  const f = view.frontByKey.get(key);
  if (!f || (f.a !== HUMAN_ID && f.b !== HUMAN_ID)) return null;
  const offs = view.attacks.filter((a) => a.frontKey === key && !a.naval && a.contactX >= 0 && (a.attacker === HUMAN_ID || a.defender === HUMAN_ID));
  offs.sort((p, q) => (p.attacker === HUMAN_ID ? 0 : 1) - (q.attacker === HUMAN_ID ? 0 : 1));
  const o = offs[0];
  if (o) return { x: o.contactX, y: o.contactY, attackId: o.attacker === HUMAN_ID ? o.id : undefined };
  return { x: f.x, y: f.y };
}

/** Take control at one of the human's fronts. */
export function takeControlAtFront(hs: HudShared, key: number): void {
  const ctx = hs.ctx;
  const a = frontAction(ctx.sim.view, key);
  if (!a) {
    hs.sound('error');
    return;
  }
  hs.sound('whoosh');
  hs.setMode({ kind: 'none' });
  void ctx.app.enterCommandAt({ x: a.x, y: a.y, label: t('hud.takeHere.front', { front: frontName(hs, key) || t('fr.front') }), frontKey: key, attackId: a.attackId });
}

/** Take control at a place (lat/lon): an alert, a battle. */
export function takeControlAtPlace(hs: HudShared, lat: number, lon: number, label: string, frontKey = 0): void {
  const ctx = hs.ctx;
  hs.sound('whoosh');
  hs.setMode({ kind: 'none' });
  const x = ((lon + 180) / 360) * MAP_W, y = ((90 - lat) / 180) * MAP_H;
  void ctx.app.enterCommandAt({ x, y, label, ...(frontKey ? { frontKey } : {}) });
}

/** Whether the human is at war (the buttons show only then). */
export function humanAtWar(view: GameView): boolean {
  return view.wars.some((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID);
}
