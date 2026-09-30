// FRONT ULTRA — command mode: stopping ships from a warship (owner item 30; owner: command).
//
// Driving a warship, the nearest merchant or troop convoy of another nation within 12 km gets a panel (right side) with
// who it is (flag, at war or at peace), how far, what it is doing, and four actions, each synced with the sim through
// the navalIntercept command (the sim validates distance and escorts and applies the consequences):
//   E  Dar el alto              ≤ 8 km   the radio call; it heaves to for inspection (it stops in the scene too)
//   R  Disparo de advertencia   ≤ 6 km   a real shell into the water ahead of its bow; it heaves to (at peace: −3 opinion)
//   F  Abordar                  ≤ 700 m, own speed ≤ 12 kn, the ship stopped: the boarding party's 8 s; a merchant
//                               becomes ours and sails to our nearest port with its cargo; a convoy turns back
//   X  Hundir                   ≤ 8 km   it goes down (at peace the game asks first: piracy, opinion, casus belli)
// Shelling it with the gun until it sinks is the same «Hundir» (index.ts onKill sends it). An escorted ship cannot be
// boarded. Nothing here fires by itself.

import * as THREE from 'three';
import type { GameView } from '../shared/api';
import { formatNumber, t } from '../shared/i18n';
import { PIRACY_OPINION } from '../shared/naval';
import type { PlayerCommand } from '../shared/protocol';
import { UnitMode, UnitType } from '../shared/types';
import { ballisticPitch, type Ent, type World } from './world';
import type { CommandOverlay } from './hud/overlay';
import { esc } from './hud/overlay';

const HAIL_M = 8000;
const WARN_M = 6000;
const SINK_M = 8000;
const BOARD_M = 700;
const BOARD_SPEED = 6.2;
const BOARD_S = 8;
const PANEL_M = 12000;
const SHELL_V = 780;

const CSS = /* css */ `
.fu-cmdx-icp { position: absolute; right: 1rem; top: 38%; width: min(22rem, 30vw); padding: 0.55rem 0.75rem 0.6rem; display: none;
  background: rgba(6,10,16,0.84); border: 1px solid rgba(132,196,255,0.28); border-left: 3px solid var(--c, #ffb53d); border-radius: 3px;
  font: 600 0.8rem/1.35 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); }
.fu-cmdx-icp.show { display: block; }
.fu-cmdx-icp .k { font: 700 0.62rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.22em; text-transform: uppercase; color: var(--fu-text-dim, #7d91a8); }
.fu-cmdx-icp .h { font: 700 0.98rem/1.2 var(--fu-font-display, sans-serif); letter-spacing: 0.05em; text-transform: uppercase; color: #fff; margin-top: 0.2rem; }
.fu-cmdx-icp .s { margin-top: 0.15rem; }
.fu-cmdx-icp .rel { font: 700 0.7rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.14em; text-transform: uppercase; }
.fu-cmdx-icp .rel.war { color: #ff8a7a; } .fu-cmdx-icp .rel.peace { color: #9fe0a8; }
.fu-cmdx-icp ul { list-style: none; margin: 0.45rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
.fu-cmdx-icp li { display: flex; gap: 0.5rem; align-items: baseline; }
.fu-cmdx-icp li kbd { font: 700 0.66rem/1 var(--fu-font-mono, monospace); padding: 0.1rem 0.3rem; border: 1px solid rgba(255,255,255,0.45); border-radius: 2px; color: #fff; flex: none; }
.fu-cmdx-icp li b { color: var(--fu-text, #e8f2ff); font-weight: 700; }
.fu-cmdx-icp li small { color: var(--fu-text-dim, #7d91a8); margin-left: auto; white-space: nowrap; }
.fu-cmdx-icp li.off { opacity: 0.45; }
.fu-cmdx-icp .w { margin-top: 0.4rem; color: #ffb0a3; font-size: 0.74rem; }
.fu-cmdx-icp .radio { margin-top: 0.4rem; padding: 0.3rem 0.45rem; background: rgba(63,208,255,0.1); border-left: 2px solid #3fd0ff; color: #cdefff; font-style: italic; font-size: 0.76rem; }
.fu-cmdx-icp .bar { height: 0.3rem; background: rgba(255,255,255,0.12); margin-top: 0.35rem; }
.fu-cmdx-icp .bar i { display: block; height: 100%; background: #ffb53d; }
`;
let cssDone = false;

export interface InterceptDeps {
  world: World;
  overlay: CommandOverlay;
  send(cmd: PlayerCommand): void;
  /** The controlled unit's id in the sim. */
  unitId: number;
  /** Name of a nation (localised) and its colour (css). */
  nameOf(owner: number): string;
  colorOf(owner: number): string;
  /** Our warship's display name («1.er Buque de guerra»). */
  shipName: string;
  sound(kind: 'radio' | 'confirm' | 'error'): void;
}

interface Boarding {
  ent: Ent;
  t: number;
}

export class ShipIntercept {
  private readonly panel: HTMLDivElement;
  private target: Ent | null = null;
  private boarding: Boarding | null = null;
  private radio = '';
  private radioT = 0;
  private asking = false;
  private lastHtml = '';
  /** Ships we hailed (unit id → seconds since): the reply comes once it heaves to. */
  private readonly hailed = new Map<number, number>();
  /** Tools: the last action sent and what the panel shows. */
  readonly log: { act: string; unitId: number; at: number }[] = [];

  constructor(private readonly d: InterceptDeps) {
    if (!cssDone) {
      cssDone = true;
      const s = document.createElement('style');
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.panel = document.createElement('div');
    this.panel.className = 'fu-cmdx-icp';
    d.overlay.root.appendChild(this.panel);
  }

  dispose(): void {
    this.panel.remove();
  }

  get text(): string {
    return this.panel.classList.contains('show') ? (this.panel.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  }

  get current(): Ent | null {
    return this.target;
  }

  /** The sim's view of the target (its unit), for the status line. */
  private simUnit(view: GameView, e: Ent) {
    return e.src ? view.units.get(e.src.id) : undefined;
  }

  private atWar(view: GameView, owner: number): boolean {
    return view.pairState(view.human?.id ?? 1, owner) === 'war';
  }

  update(dt: number, view: GameView, player: Ent, input: { hit(code: string): boolean }, allowInput: boolean): void {
    // The nearest foreign merchant / convoy within 12 km (not our own, not a prize already ours).
    let best: Ent | null = null, bd = PANEL_M;
    for (const e of this.d.world.ents) {
      if (!e.alive || (e.kind !== 'merchant' && e.kind !== 'transport') || e.team === 0 || e.src?.kind !== 'merchant') continue;
      const dd = e.pos.distanceTo(player.pos);
      if (dd < bd) {
        bd = dd;
        best = e;
      }
    }
    this.target = best;
    for (const [id, s] of this.hailed) this.hailed.set(id, s + dt);
    this.radioT = Math.max(0, this.radioT - dt);
    // Boarding in progress.
    if (this.boarding) {
      const b = this.boarding;
      b.t += dt;
      const dist = b.ent.pos.distanceTo(player.pos);
      if (!b.ent.alive || dist > BOARD_M * 1.35) {
        this.boarding = null;
        this.d.overlay.showNotice(t('naval.cmd.boardAbort'), 3);
        this.d.sound('error');
      } else if (b.t >= BOARD_S) {
        this.boarding = null;
        this.act('board', b.ent);
        this.d.overlay.showNotice(t(b.ent.kind === 'transport' ? 'naval.cmd.boardedConvoy' : 'naval.cmd.boarded'), 4, true);
        this.d.sound('confirm');
      }
    }
    if (!best) {
      this.paint('');
      return;
    }
    const e = best;
    const u = this.simUnit(view, e);
    const owner = e.nation;
    const war = this.atWar(view, owner);
    const hove = u?.mode === UnitMode.HoveTo;
    const dist = e.pos.distanceTo(player.pos);
    const slow = Math.abs(player.speed) <= BOARD_SPEED;
    const stopped = hove || e.speed < 1.2;
    const escorted = this.escorted(view, e);
    const can = {
      hail: dist <= HAIL_M && !hove,
      warn: dist <= WARN_M,
      board: dist <= BOARD_M && slow && stopped && !escorted && !this.boarding,
      sink: dist <= SINK_M,
    };
    // Radio reply once it heaves to after our call.
    const sid = e.src?.id ?? 0;
    if (hove && this.hailed.has(sid) && (this.hailed.get(sid) ?? 0) > 1.5) {
      this.hailed.delete(sid);
      this.say(t(e.kind === 'transport' ? 'naval.cmd.replyConvoy' : 'naval.cmd.reply', { name: this.d.nameOf(owner) }));
    }
    if (allowInput && !this.asking) {
      if (input.hit('KeyE')) this.tryAct('hail', e, can.hail, war);
      if (input.hit('KeyR')) this.tryAct('warn', e, can.warn, war, player);
      if (input.hit('KeyF')) this.tryAct('board', e, can.board, war);
      if (input.hit('KeyX')) this.tryAct('sink', e, can.sink, war);
    }
    // Panel.
    const what = t(e.kind === 'transport' ? 'naval.cmd.convoy' : 'naval.cmd.merchant', { name: this.d.nameOf(owner) });
    const status = !u ? '' : u.mode === UnitMode.HoveTo ? t('naval.cmd.st.hove') : u.mode === UnitMode.Detour ? t('naval.cmd.st.detour') : t('naval.cmd.st.sailing');
    const km = dist >= 1000 ? `${formatNumber(dist / 1000, 1)} km` : `${Math.round(dist)} m`;
    const li = (k: string, key: string, ok: boolean, why: string) => `<li class="${ok ? '' : 'off'}"><kbd>${k}</kbd><b>${esc(t(key))}</b><small>${esc(why)}</small></li>`;
    const whyBoard = escorted ? t('naval.cmd.why.escorted') : dist > BOARD_M ? t('naval.cmd.why.alongside') : !slow ? t('naval.cmd.why.slow') : !stopped ? t('naval.cmd.why.stop') : this.boarding ? t('naval.cmd.why.busy') : '';
    const html = `<div class="k">${esc(t('naval.cmd.kicker'))}</div><div class="h">${esc(what)}</div>
      <div class="s"><span class="rel ${war ? 'war' : 'peace'}">${esc(t(war ? 'naval.rel.war' : 'naval.rel.peace'))}</span> · ${esc(km)}${status ? ` · ${esc(status)}` : ''}${e.kind === 'transport' && u ? ` · ${esc(t('naval.cmd.troops', { n: formatNumber(Math.round(u.troops)) }))}` : ''}</div>
      <ul>${li('E', 'naval.cmd.hail', can.hail, hove ? t('naval.cmd.why.hove') : dist > HAIL_M ? t('naval.cmd.why.range', { km: 8 }) : '')}
      ${li('R', 'naval.cmd.warn', can.warn, dist > WARN_M ? t('naval.cmd.why.range', { km: 6 }) : '')}
      ${li('F', 'naval.cmd.board', can.board, whyBoard)}
      ${li('X', 'naval.cmd.sink', can.sink, dist > SINK_M ? t('naval.cmd.why.range', { km: 8 }) : '')}</ul>
      ${war ? `<div class="w" style="color:#b3c4d6">${esc(t('naval.cmd.warNote'))}</div>` : `<div class="w">${esc(t('naval.cmd.peaceNote', { name: this.d.nameOf(owner), v: Math.abs(PIRACY_OPINION.seize), vs: Math.abs(PIRACY_OPINION.sink) }))}</div>`}
      ${this.boarding ? `<div class="radio">${esc(t('naval.cmd.boarding', { s: Math.max(0, Math.ceil(BOARD_S - this.boarding.t)) }))}</div><div class="bar"><i style="width:${Math.min(100, (this.boarding.t / BOARD_S) * 100).toFixed(0)}%"></i></div>` : ''}
      ${this.radioT > 0 ? `<div class="radio">${esc(this.radio)}</div>` : ''}`;
    this.panel.style.setProperty('--c', this.d.colorOf(owner));
    this.paint(html);
  }

  private paint(html: string): void {
    if (html === this.lastHtml) return;
    this.lastHtml = html;
    this.panel.classList.toggle('show', !!html);
    if (html) this.panel.innerHTML = html;
  }

  private say(text: string): void {
    this.radio = text;
    this.radioT = 6;
    this.d.sound('radio');
  }

  /** An escort of its nation (a warship in the scene within 2 km of it). */
  private escorted(view: GameView, e: Ent): boolean {
    const id = e.src?.id ?? 0;
    for (const u of view.units.values()) {
      if (u.type !== UnitType.Warship || u.owner !== e.nation || u.mode !== UnitMode.Escort) continue;
      // The sim's escort sails with its ship: the same point within ~3 tiles.
      const s = view.units.get(id);
      if (s && Math.abs(u.x - s.x) + Math.abs(u.y - s.y) < 3) return true;
    }
    return false;
  }

  private tryAct(act: 'hail' | 'warn' | 'board' | 'sink', e: Ent, ok: boolean, war: boolean, player?: Ent): void {
    if (!ok) {
      this.d.sound('error');
      this.d.overlay.showNotice(t(`naval.cmd.cannot.${act}`), 2.5);
      return;
    }
    switch (act) {
      case 'hail':
        this.say(t('naval.cmd.hailText', { ship: this.d.shipName }));
        this.hailed.set(e.src?.id ?? 0, 0);
        this.act('hail', e);
        return;
      case 'warn':
        this.warningShot(e, player!);
        this.act('warn', e);
        this.say(t('naval.cmd.warnText'));
        return;
      case 'board':
        this.boarding = { ent: e, t: 0 };
        this.d.overlay.showNotice(t('naval.cmd.boardStart'), 3, true);
        this.d.sound('radio');
        return;
      case 'sink':
        if (war) {
          this.sink(e);
          return;
        }
        this.asking = true;
        void this.d.overlay.ask(t('naval.cmd.sinkAsk.title', { name: this.d.nameOf(e.nation) }), t('naval.cmd.sinkAsk.body', { vs: Math.abs(e.kind === 'transport' ? PIRACY_OPINION.sinkTroops : PIRACY_OPINION.sink), va: Math.abs(PIRACY_OPINION.ally), vw: Math.abs(PIRACY_OPINION.world) }), '',
          [{ label: t('naval.cmd.sinkAsk.go'), cls: 'danger', key: 'Enter' }, { label: t('common.cancel'), key: 'Esc' }]).then((i) => {
          this.asking = false;
          if (i === 0 && e.alive) this.sink(e);
        });
        return;
    }
  }

  /** It goes down in the scene; index.ts onKill sends the sinking to the sim. */
  private sink(e: Ent): void {
    const player = this.d.world.ents.find((x) => x.player) ?? null;
    this.d.world.kill(e, player, true);
  }

  private warningShot(e: Ent, player: Ent): void {
    const w = this.d.world;
    const from = new THREE.Vector3(), dir = new THREE.Vector3();
    w.muzzleOf(player, from, dir);
    // 250 m ahead of its bow, in the water.
    const fwd = new THREE.Vector3(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
    const aim = new THREE.Vector3().copy(e.pos).addScaledVector(fwd, 250 + e.radius);
    const dx = aim.x - from.x, dz = aim.z - from.z;
    const hd = Math.hypot(dx, dz);
    const pitch = ballisticPitch(hd, aim.y - from.y, SHELL_V, 9.81);
    dir.set(dx / hd * Math.cos(pitch), Math.sin(pitch), dz / hd * Math.cos(pitch)).normalize();
    w.fireShell(player, 0, from, dir, SHELL_V, 0, 0, false, false, 1.4);
  }

  private act(act: 'hail' | 'warn' | 'board' | 'sink', e: Ent): void {
    if (!e.src) return;
    this.d.send({ type: 'navalIntercept', unitId: this.d.unitId, targetId: e.src.id, act });
    this.log.push({ act, unitId: e.src.id, at: performance.now() });
  }
}
