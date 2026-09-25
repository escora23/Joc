// FRONT ULTRA — command mode HUD (owner: command).
// DOM panels (mission, objective, kill feed, vehicle status, weapons, warnings, banners, intro card, after-action
// report) refreshed at ~10 Hz, plus one full-screen vector canvas redrawn every frame for the fast symbology:
// compass tape, per-vehicle reticles (tank range reticle + reload ring + gun indicator, jet HUD with pitch ladder /
// flight-path / pipper / lock diamond, naval crosshair + impact point + lead indicator), unit markers, hit markers,
// damage direction arcs and the boundary arrow.

import * as THREE from 'three';
import type { CommandKind } from '../../shared/types';
import { formatNumber, t } from '../../shared/i18n';
import { ENT_DEFS, type Ent, type EntKind, type World } from '../world';
import type { HudState } from '../player/common';
import { HUD_CSS } from './style';

let styleInjected = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/** Unit kinds whose Spanish name is feminine (fragata, patrullera, batería, infantería). */
const FEMININE = new Set<EntKind>(['ship', 'boat', 'battery', 'soldier']);
const TMP = new THREE.Vector3();
const TMP2 = new THREE.Vector3();
const LAD_F = new THREE.Vector3();
const LAD_R = new THREE.Vector3();
const LAD_D = new THREE.Vector3();
const LAD_P = new THREE.Vector3();

interface FeedEntry {
  el: HTMLElement;
  t: number;
}

export interface MissionInfo {
  kind: CommandKind;
  opName: string;
  enemyName: string;
  enemyColor: string;
  friendlyName: string;
  friendlyColor: string;
  coords: string;
  localTime: string;
  objective: number;
}

export interface DebriefData {
  kills: number;
  troops: number;
  durationSec: number;
  accuracy: number;
  lost: boolean;
  strategic: number;
  byKind: [EntKind, number][];
}

const ICONS: Record<CommandKind, { body: string; top: string }> = {
  tank: {
    body: `<rect x="31" y="14" width="9" height="72" rx="2" fill="currentColor" opacity="0.55"/><rect x="60" y="14" width="9" height="72" rx="2" fill="currentColor" opacity="0.55"/>
      <path d="M39 18 L61 18 L61 84 L39 84 Z" fill="currentColor" opacity="0.85"/>`,
    top: `<g><circle cx="50" cy="54" r="12" fill="currentColor"/><rect x="47.5" y="8" width="5" height="40" rx="1.5" fill="currentColor"/></g>`,
  },
  jet: {
    body: `<path d="M50 6 L55 30 L56 44 L88 64 L88 70 L56 62 L55 78 L66 88 L66 92 L50 88 L34 92 L34 88 L45 78 L44 62 L12 70 L12 64 L44 44 L45 30 Z" fill="currentColor" opacity="0.85"/>`,
    top: '',
  },
  ship: {
    body: `<path d="M50 4 C58 18 61 30 61 46 L61 88 L39 88 L39 46 C39 30 42 18 50 4 Z" fill="currentColor" opacity="0.8"/>
      <rect x="44" y="40" width="12" height="16" fill="currentColor" opacity="0.5"/><rect x="45" y="62" width="10" height="10" fill="currentColor" opacity="0.5"/>`,
    top: `<g><circle cx="50" cy="26" r="4.5" fill="currentColor"/><rect x="49" y="10" width="2" height="16" fill="currentColor"/></g>`,
  },
};

export class CommandHud {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly vig: HTMLDivElement;
  private readonly low: HTMLDivElement;
  private readonly scope: HTMLDivElement;
  private readonly obj: HTMLDivElement;
  private readonly objBar: HTMLElement;
  private readonly objN: HTMLElement;
  private readonly objT: HTMLElement;
  private readonly objD: HTMLElement;
  private readonly mission: HTMLDivElement;
  private readonly clock: HTMLElement;
  private readonly feed: HTMLDivElement;
  private readonly status: HTMLDivElement;
  private readonly weap: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly warn: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly killTxt: HTMLDivElement;
  private readonly lockHint: HTMLDivElement;
  private readonly intro: HTMLDivElement;
  private readonly over: HTMLDivElement;
  readonly exitBtn: HTMLButtonElement;
  private feedList: FeedEntry[] = [];
  /** Pooled marker labels (no per-frame object allocation). */
  private readonly labelPool: { x: number; y: number; w: number; txt: string; score: number }[] = Array.from({ length: 64 }, () => ({ x: 0, y: 0, w: 0, txt: '', score: 0 }));
  private labels: { x: number; y: number; w: number; txt: string; score: number }[] = [];
  private compassGrad: CanvasGradient | null = null;
  private compassGradX = -1;
  private hits: { t: number; kill: boolean }[] = [];
  private dmgDirs: { t: number; yaw: number }[] = [];
  private vigLevel = 0;
  private domAcc = 1;
  private killTxtT = 0;
  private time = 0;
  private kind: CommandKind = 'tank';
  private weapNodes: { row: HTMLElement; ct: HTMLElement; rl: HTMLElement; bar: HTMLElement }[] = [];
  private statusNodes: Record<string, HTMLElement> = {};
  private dpr = 1;
  private w = 1;
  private h = 1;
  private helpT = 0;
  private objTotal = 1;
  private lastWarn = '';
  onExitClick: () => void = () => undefined;
  /** Hide the "click to aim" hint (shots, pointer locked). */
  showLockHint = false;

  constructor(parent: HTMLElement) {
    if (!styleInjected) {
      styleInjected = true;
      const s = document.createElement('style');
      s.textContent = HUD_CSS;
      document.head.appendChild(s);
    }
    this.root = el('div', 'fu-cmd fu-cmd-hidden');
    this.canvas = el('canvas', 'fu-cmd-vec');
    this.g = this.canvas.getContext('2d')!;
    this.vig = el('div', 'fu-cmd-vig');
    this.low = el('div', 'fu-cmd-low');
    this.scope = el('div', 'fu-cmd-scope');
    this.obj = el('div', 'fu-cmd-panel fu-cmd-obj');
    this.objT = el('div', 't');
    this.objD = el('div', 'd');
    const bar = el('div', 'bar');
    this.objBar = el('i');
    bar.appendChild(this.objBar);
    this.objN = el('div', 'n');
    this.obj.append(this.objT, this.objD, bar, this.objN);
    this.mission = el('div', 'fu-cmd-panel fu-cmd-mission');
    this.clock = el('div', 'clock');
    this.feed = el('div', 'fu-cmd-feed');
    this.status = el('div', 'fu-cmd-panel fu-cmd-status');
    this.weap = el('div', 'fu-cmd-panel fu-cmd-weap');
    this.help = el('div', 'fu-cmd-help');
    this.warn = el('div', 'fu-cmd-warn');
    this.banner = el('div', 'fu-cmd-banner');
    this.killTxt = el('div', 'fu-cmd-killtxt');
    this.lockHint = el('div', 'fu-cmd-lockhint');
    this.intro = el('div', 'fu-cmd-intro');
    this.over = el('div', 'fu-cmd-over');
    this.exitBtn = el('button', 'fu-cmd-exit fu-cmd-interactive');
    this.exitBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.onExitClick();
    });
    const letterT = el('div', 'fu-cmd-letter top');
    const letterB = el('div', 'fu-cmd-letter bot');
    this.root.append(
      this.canvas, this.scope, this.vig, this.low, this.obj, this.mission, this.feed, this.status, this.weap, this.help, this.warn,
      this.banner, this.killTxt, this.lockHint, this.intro, letterT, letterB, this.exitBtn, this.over,
    );
    parent.appendChild(this.root);
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------
  show(info: MissionInfo, weapons: { key: string; label: string }[]): void {
    this.kind = info.kind;
    this.root.classList.remove('fu-cmd-hidden');
    this.root.classList.remove('fu-cmd-cine');
    this.feed.innerHTML = '';
    this.feedList = [];
    this.hits = [];
    this.dmgDirs = [];
    this.vigLevel = 0;
    this.helpT = 0;
    this.objTotal = info.objective;
    this.over.className = 'fu-cmd-over';
    this.over.innerHTML = '';
    this.banner.className = 'fu-cmd-banner';
    this.obj.classList.remove('done');
    this.objT.textContent = t('command.objective.short');
    this.objD.textContent = t('command.objective', { n: info.objective });
    this.objN.textContent = `0 / ${info.objective}`;
    this.objBar.style.width = '0%';
    this.mission.innerHTML = `<div class="k">${t('command.intro.op')} · ${esc(info.opName)}</div>
      <div class="v">${t(`command.vehicle.${info.kind}`)}</div>
      <div class="vs"><span class="sw" style="background:${info.friendlyColor};color:${info.friendlyColor}"></span>${esc(info.friendlyName)}
      <span style="opacity:.5">vs</span><span class="sw" style="background:${info.enemyColor};color:${info.enemyColor}"></span>${esc(info.enemyName)}</div>`;
    this.mission.appendChild(this.clock);
    this.exitBtn.innerHTML = `${t('command.exit')}<kbd>ESC</kbd>`;
    this.help.innerHTML = t(`command.help.${info.kind}`).replace(/([A-Z0-9/]{1,4}|ESC|WASD|Clic der\.|Right-click|Click|Clic|Ratón|Mouse|Espacio|Space)(?=\s)/g, '<b>$1</b>');
    this.help.style.opacity = '1';
    // Status panel
    const hpLbl = info.kind === 'jet' ? 'command.hp.jet' : info.kind === 'ship' ? 'command.hp.ship' : 'command.hp';
    const icon = ICONS[info.kind];
    const r1 = info.kind === 'jet'
      ? `<div><span class="lbl">${t('command.speed')}</span><b data-k="spd">0<small>km/h</small></b></div><div><span class="lbl">${t('command.alt')}</span><b data-k="alt">0<small>m</small></b></div><div><span class="lbl">${t('command.throttle')}</span><b data-k="thr">0<small>%</small></b></div>`
      : info.kind === 'ship'
        ? `<div><span class="lbl">${t('command.speed')}</span><b data-k="spd">0<small>kn</small></b></div><div><span class="lbl">${t('command.telegraph')}</span><b data-k="tel" style="font-size:.85rem">—</b></div><div><span class="lbl">${t('command.rudder')}</span><b data-k="rud">0°</b></div>`
        : `<div><span class="lbl">${t('command.speed')}</span><b data-k="spd">0<small>km/h</small></b></div><div><span class="lbl">${t('command.range')}</span><b data-k="rng">—<small>m</small></b></div>`;
    this.status.innerHTML = `<div class="icon"><svg viewBox="0 0 100 100" data-k="svg" style="color:#9fdcff"><g data-k="hull">${icon.body}</g><g data-k="tur">${icon.top}</g></svg></div>
      <span class="lbl">${t(hpLbl)}</span>
      <div class="hp"><b data-k="hp">100</b><span>%</span></div>
      <div class="hpbar"><i data-k="hpbar"></i></div>
      <div class="row">${r1}</div>`;
    this.statusNodes = {};
    this.status.querySelectorAll<HTMLElement>('[data-k]').forEach((n) => (this.statusNodes[n.dataset.k!] = n));
    // Weapons panel
    this.weap.innerHTML = '';
    this.weapNodes = [];
    for (const w of weapons) {
      const row = el('div', 'w');
      const ct = el('span', 'ct', '0');
      const rl = el('div', 'rl');
      const bar = el('i');
      rl.appendChild(bar);
      row.append(el('kbd', '', w.key), el('span', 'nm', t(w.label)), ct, rl);
      this.weap.appendChild(row);
      this.weapNodes.push({ row, ct, rl, bar });
    }
    this.domAcc = 1;
  }

  hide(): void {
    this.root.classList.add('fu-cmd-hidden');
    this.intro.classList.remove('show');
  }

  setCinematic(on: boolean): void {
    this.root.classList.toggle('fu-cmd-cine', on);
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  // ---------------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------------
  hitMarker(kill: boolean): void {
    this.hits.push({ t: this.time, kill });
    if (this.hits.length > 8) this.hits.shift();
  }

  killConfirm(kind: EntKind, troops: number): void {
    // Spanish agreement: the feminine unit names take DESTRUIDA.
    this.killTxt.innerHTML = `${t(`command.type.${kind}`)} ${t(FEMININE.has(kind) ? 'command.killF' : 'command.kill')}<b>+${formatNumber(troops)}</b>`;
    this.killTxt.classList.add('show');
    this.killTxtT = this.time + 1.8;
  }

  feedEntry(who: 'you' | 'ally' | 'enemy', victim: EntKind, troops: number, colorHex: string): void {
    const e = el('div', `e ${who === 'you' ? 'you' : ''} ${who === 'enemy' ? 'bad' : ''}`);
    e.style.setProperty('--c', colorHex);
    const whoTxt = who === 'you' ? t('command.feed.you') : who === 'ally' ? t('command.feed.allies') : t('command.feed.enemy');
    e.innerHTML = `<span class="who">${esc(whoTxt)}</span><span class="arr">▸</span><span>${t(`command.type.${victim}`)}</span>${who === 'you' ? `<span class="pts">+${formatNumber(troops)}</span>` : ''}`;
    this.feed.prepend(e);
    this.feedList.unshift({ el: e, t: this.time });
    while (this.feedList.length > 7) this.feedList.pop()!.el.remove();
  }

  damage(amount: number, playerPos: THREE.Vector3, from: THREE.Vector3 | null): void {
    this.vigLevel = Math.min(1, this.vigLevel + amount / 40);
    if (from) {
      const yaw = Math.atan2(from.x - playerPos.x, -(from.z - playerPos.z)); // compass bearing
      this.dmgDirs.push({ t: this.time, yaw });
      if (this.dmgDirs.length > 6) this.dmgDirs.shift();
    }
  }

  setObjective(done: number, total: number, complete: boolean): void {
    this.objN.textContent = `${Math.min(done, total)} / ${total}`;
    this.objBar.style.width = `${Math.min(100, (done / Math.max(1, total)) * 100)}%`;
    if (complete && !this.obj.classList.contains('done')) {
      this.obj.classList.add('done');
      this.objT.textContent = t('command.objective.done');
      this.showBanner(t('command.objective.done'), t('command.objective.doneSub'), 6);
    }
  }

  private bannerT = 0;
  showBanner(big: string, sub: string, seconds: number): void {
    this.banner.innerHTML = `<div class="big">${esc(big)}</div><div class="sub">${esc(sub)}</div>`;
    this.banner.classList.add('show');
    this.bannerT = this.time + seconds;
  }

  showIntro(info: MissionInfo, on: boolean): void {
    if (on) {
      this.intro.innerHTML = `<div class="op">${t('command.intro.op')}</div><div class="name">${esc(info.opName)}</div><div class="line"></div>
        <div class="row"><b>${t(`command.kind.${info.kind}`)}</b> · ${esc(t('command.intro.front', { enemy: info.enemyName }))}</div>
        <div class="row mono">${esc(info.coords)} · ${esc(t('command.intro.local', { time: info.localTime }))}</div>`;
    }
    this.intro.classList.toggle('show', on);
  }

  showDestroyed(): void {
    this.over.className = 'fu-cmd-over dead';
    this.over.innerHTML = `<div class="card"><div class="hdr">${t('command.debrief.status')}</div><div class="ttl">${t('command.destroyed')}</div>
      <div class="sum" style="color:#ffb0a8">${t('command.destroyedSub')}</div></div>`;
    requestAnimationFrame(() => this.over.classList.add('show'));
  }

  showDebrief(d: DebriefData, seconds: number): void {
    const sum = d.kills > 0
      ? t('command.debrief.summary', { n: d.kills, troops: formatNumber(d.troops) })
      : t('command.debrief.none');
    const mins = Math.floor(d.durationSec / 60), secs = Math.floor(d.durationSec % 60);
    const kinds = d.byKind.map(([k, n], i) => `<div class="r" style="animation-delay:${0.25 + i * 0.07}s"><span>${t(`command.type.${k}`)}</span><b>× ${n}</b></div>`).join('');
    this.over.className = `fu-cmd-over${d.lost ? ' dead' : ''}`;
    this.over.innerHTML = `<div class="card fu-cmd-panel">
      <div class="hdr">${t('command.debrief')}</div>
      <div class="ttl">${d.lost ? t('command.destroyed') : t(`command.vehicle.${this.kind}`)}</div>
      <div class="rows">
        <div class="r"><span>${t('command.debrief.kills')}</span><b>${d.kills}</b></div>
        ${kinds}
        <div class="r"><span>${t('command.debrief.troops')}</span><b class="red">${d.troops > 0 ? '−' : ''}${formatNumber(d.troops)}</b></div>
        ${d.strategic > 0 ? `<div class="r"><span>${t('command.debrief.strategic', { n: '' }).replace(/[:：]\s*$/, '')}</span><b class="red">${d.strategic}</b></div>` : ''}
        <div class="r"><span>${t('command.debrief.acc')}</span><b>${Math.round(d.accuracy * 100)}%</b></div>
        <div class="r"><span>${t('command.debrief.time')}</span><b>${mins}:${String(secs).padStart(2, '0')}</b></div>
        <div class="r"><span>${t('command.debrief.status')}</span><b class="${d.lost ? 'red' : 'green'}">${d.lost ? t('command.debrief.lost') : t('command.debrief.intact')}</b></div>
      </div>
      <div class="sum">${esc(sum)}</div>
      <div class="ret">${t('command.debrief.return')}<i style="--dur:${seconds}s"></i></div>
    </div>`;
    requestAnimationFrame(() => this.over.classList.add('show'));
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------------------------
  update(dt: number, s: HudState, camera: THREE.PerspectiveCamera, world: World, localClock: string, battleSec: number, locked: boolean, realDt = dt): void {
    this.time += dt;
    this.helpT += dt;
    if (this.helpT > 14) this.help.style.opacity = '0';
    this.vigLevel = Math.max(0, this.vigLevel - dt * 0.8);
    this.vig.style.opacity = String(Math.min(1, this.vigLevel * 1.2));
    this.low.style.opacity = s.hp / s.maxHp < 0.3 && s.hp > 0 ? '1' : '0';
    this.low.style.display = s.hp / s.maxHp < 0.3 && s.hp > 0 ? 'block' : 'none';
    this.scope.style.opacity = s.zoom ? '1' : '0';
    if (this.killTxtT && this.time > this.killTxtT) {
      this.killTxt.classList.remove('show');
      this.killTxtT = 0;
    }
    if (this.bannerT && this.time > this.bannerT) {
      this.banner.classList.remove('show');
      this.bannerT = 0;
    }
    for (const f of this.feedList) if (this.time - f.t > 7) f.el.style.opacity = '0';
    this.lockHint.style.display = this.showLockHint && !locked ? 'block' : 'none';
    this.domAcc += realDt;
    if (this.domAcc >= 0.1) {
      this.domAcc = 0;
      const m = Math.floor(battleSec / 60), sec = Math.floor(battleSec % 60);
      this.updateDom(s, `${localClock} · ${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`);
    }
    this.draw(s, camera, world);
  }

  private updateDom(s: HudState, clock: string): void {
    this.lockHint.textContent = t('command.clickToAim');
    this.clock.textContent = clock;
    const n = this.statusNodes;
    const frac = Math.max(0, s.hp / s.maxHp);
    if (n.hp) n.hp.textContent = String(Math.ceil(frac * 100));
    if (n.hpbar) {
      n.hpbar.style.width = `${frac * 100}%`;
      n.hpbar.style.background = frac > 0.6 ? 'var(--fu-success, #45f0a0)' : frac > 0.3 ? 'var(--fu-accent-2, #ffb53d)' : 'var(--fu-danger, #ff4a4a)';
    }
    if (n.svg) n.svg.style.color = frac > 0.6 ? '#9fdcff' : frac > 0.3 ? '#ffc070' : '#ff6a5a';
    if (n.tur) n.tur.setAttribute('transform', `rotate(${(s.turretRel * 180) / Math.PI} 50 ${this.kind === 'ship' ? 26 : 54})`);
    if (n.spd) n.spd.firstChild!.textContent = String(Math.round(s.speedKmh));
    if (n.rng) n.rng.firstChild!.textContent = s.rangeM > 0 && s.rangeM < 4990 ? String(Math.round(s.rangeM / 10) * 10) : '—';
    if (n.alt) n.alt.firstChild!.textContent = formatNumber(Math.round(s.altM));
    if (n.thr) {
      n.thr.firstChild!.textContent = String(Math.round(s.throttle * 100));
      n.thr.style.color = s.afterburner ? '#ffb53d' : '';
    }
    if (n.tel) n.tel.textContent = t(`command.tel.${s.telegraph}`);
    if (n.rud) n.rud.textContent = `${Math.round(s.rudder * 35)}°`;
    for (let i = 0; i < this.weapNodes.length && i < s.weapons.length; i++) {
      const w = s.weapons[i], node = this.weapNodes[i];
      node.ct.textContent = w.max > 99 ? formatNumber(w.count) : String(w.count);
      node.row.classList.toggle('on', w.active);
      node.bar.style.width = `${Math.round(Math.min(1, w.ready) * 100)}%`;
      node.rl.classList.toggle('ok', w.ready >= 1);
    }
    // Warnings
    const warns: string[] = [];
    if (s.missileWarning) warns.push(`<div>${t('command.missileWarning')}</div>`);
    if (s.pullUp) warns.push(`<div>${t('command.pullUp')}</div>`);
    if (s.boundary) warns.push(`<div class="amber">${t('command.boundary')}</div>`);
    if (s.stall && this.kind === 'jet') warns.push(`<div class="amber">${t('command.stall')}</div>`);
    const html = warns.join('');
    if (html !== this.lastWarn) {
      this.warn.innerHTML = html;
      this.lastWarn = html;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Vector overlay
  // ---------------------------------------------------------------------------------------------
  private draw(s: HudState, camera: THREE.PerspectiveCamera, world: World): void {
    const g = this.g;
    const W = this.w, H = this.h;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (this.root.classList.contains('fu-cmd-cine')) return;
    const cx = W / 2, cy = H / 2;
    this.drawMarkers(g, camera, world, W, H);
    this.drawCompass(g, s, cx);
    if (s.kind === 'tank') this.drawTank(g, s, cx, cy);
    else if (s.kind === 'jet') this.drawJet(g, s, camera, cx, cy);
    else this.drawShip(g, s, cx, cy);
    // Hit markers
    for (const h of this.hits) {
      const age = this.time - h.t;
      if (age > 0.35) continue;
      const a = 1 - age / 0.35;
      const r0 = 9 + age * 20, r1 = r0 + 11;
      g.strokeStyle = h.kill ? `rgba(255,70,50,${a})` : `rgba(255,255,255,${a})`;
      g.lineWidth = h.kill ? 3 : 2;
      g.beginPath();
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        g.moveTo(cx + sx * r0 * 0.7071, cy + sy * r0 * 0.7071);
        g.lineTo(cx + sx * r1 * 0.7071, cy + sy * r1 * 0.7071);
      }
      g.stroke();
    }
    // Damage direction arcs
    for (const d of this.dmgDirs) {
      const age = this.time - d.t;
      if (age > 1.4) continue;
      const a = 1 - age / 1.4;
      const rel = d.yaw - s.heading - Math.PI / 2;
      g.strokeStyle = `rgba(255,50,40,${a * 0.9})`;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(cx, cy, 120, rel - 0.28, rel + 0.28);
      g.stroke();
    }
    // Boundary arrow
    if (s.boundary) {
      const rel = -s.boundaryDir - s.heading - Math.PI / 2;
      const r = 150;
      const x = cx + Math.cos(rel) * r, y = cy + Math.sin(rel) * r;
      g.save();
      g.translate(x, y);
      g.rotate(rel + Math.PI / 2);
      g.fillStyle = 'rgba(255,193,74,0.9)';
      g.beginPath();
      g.moveTo(0, -14);
      g.lineTo(10, 8);
      g.lineTo(-10, 8);
      g.closePath();
      g.fill();
      g.restore();
    }
  }

  private drawMarkers(g: CanvasRenderingContext2D, camera: THREE.PerspectiveCamera, world: World, W: number, H: number): void {
    const maxD = this.kind === 'jet' ? 14000 : this.kind === 'ship' ? 20000 : 2600;
    const cx = W / 2, cy = H / 2;
    g.font = '700 11px "Barlow Condensed", "Rajdhani", sans-serif';
    g.textAlign = 'center';
    for (const e of world.ents) {
      if (!e.alive || e.player) continue;
      const d = camera.position.distanceTo(e.pos);
      const inf = e.kind === 'soldier' || e.kind === 'at';
      // Infantry only gets a marker up close (it would carpet the screen otherwise); friendlies are quieter.
      if (d > (inf ? (e.kind === 'at' ? 260 : 190) : maxD)) continue;
      if (e.team === 0 && d > (this.kind === 'tank' ? 700 : maxD * 0.5)) continue;
      if (e.team === 0 && inf && d > 90) continue;
      TMP.copy(e.pos);
      TMP.y += ENT_DEFS[e.kind].air ? 12 : e.height + (inf ? 1.0 : 3.2);
      TMP2.copy(TMP).project(camera);
      if (TMP2.z > 1 || TMP2.z < -1) continue;
      const x = (TMP2.x * 0.5 + 0.5) * W, y = (-TMP2.y * 0.5 + 0.5) * H;
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      if (e.team === 1) {
        if (inf) {
          // Small diamond; AT teams (a real threat to armor) are brighter and tagged.
          const sz = e.kind === 'at' ? 3.6 : 2.6;
          g.fillStyle = e.kind === 'at' ? 'rgba(255,90,60,0.95)' : 'rgba(255,80,60,0.75)';
          g.beginPath();
          g.moveTo(x, y - sz);
          g.lineTo(x + sz, y);
          g.lineTo(x, y + sz);
          g.lineTo(x - sz, y);
          g.closePath();
          g.fill();
          if (e.kind === 'at' && d < 170) {
            g.fillStyle = 'rgba(255,150,140,0.9)';
            g.fillText('AT', x, y - 6);
          }
          continue;
        }
        const sz = d < 250 ? 7 : d < 700 ? 6 : 5;
        g.fillStyle = 'rgba(255,70,55,0.95)';
        g.strokeStyle = 'rgba(40,0,0,0.8)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(x, y + sz);
        g.lineTo(x - sz, y - sz * 0.6);
        g.lineTo(x + sz, y - sz * 0.6);
        g.closePath();
        g.stroke();
        g.fill();
        const near = Math.abs(x - cx) < 150 && Math.abs(y - cy) < 110;
        if (near || d < (this.kind === 'tank' ? 420 : this.kind === 'jet' ? 2500 : 4000)) {
          const txt = `${t(`command.type.${e.kind}`)}  ${d >= 1000 ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m'}`;
          const wTxt = g.measureText(txt).width;
          const score = Math.hypot(x - cx, y - cy) + d * 0.05;
          if (this.labels.length < this.labelPool.length) {
            const L = this.labelPool[this.labels.length];
            L.x = x;
            L.y = y - 11;
            L.w = wTxt;
            L.txt = txt;
            L.score = score;
            this.labels.push(L);
          }
        }
      } else {
        const sz = inf ? 2.5 : 5;
        g.fillStyle = 'rgba(80,190,255,0.85)';
        g.beginPath();
        g.moveTo(x, y + sz);
        g.lineTo(x - sz, y - sz * 0.6);
        g.lineTo(x + sz, y - sz * 0.6);
        g.closePath();
        g.fill();
      }
    }
    // Labels: closest to the crosshair first, skip any that would overlap a placed one.
    this.labels.sort(byScore);
    let placed = 0;
    for (let i = 0; i < this.labels.length && placed < 3; i++) {
      const L = this.labels[i];
      let clash = false;
      for (let j = 0; j < placed; j++) {
        const P = this.labels[j];
        if (Math.abs(P.x - L.x) < (P.w + L.w) / 2 + 6 && Math.abs(P.y - L.y) < 14) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      this.labels[placed++] = L;
      g.fillStyle = 'rgba(0,0,0,0.6)';
      g.fillText(L.txt, L.x + 1, L.y + 1);
      g.fillStyle = 'rgba(255,150,140,0.95)';
      g.fillText(L.txt, L.x, L.y);
    }
    this.labels.length = 0;
    // Incoming guided missiles aimed at the player: bright warning chevrons.
    for (const p of world.projs) {
      if (!p.alive || p.kind !== 'missile' || p.team === 0 || !p.target?.player) continue;
      TMP2.copy(p.pos).project(camera);
      if (TMP2.z > 1) continue;
      const x = (TMP2.x * 0.5 + 0.5) * W, y = (-TMP2.y * 0.5 + 0.5) * H;
      g.strokeStyle = 'rgba(255,60,40,0.95)';
      g.lineWidth = 2;
      g.strokeRect(x - 9, y - 9, 18, 18);
    }
  }

  private drawCompass(g: CanvasRenderingContext2D, s: HudState, cx: number): void {
    const y0 = 20, wdt = 460, half = wdt / 2;
    const pxPerRad = wdt / 1.6;
    g.save();
    g.beginPath();
    g.rect(cx - half, y0 - 4, wdt, 40);
    g.clip();
    if (!this.compassGrad || this.compassGradX !== cx) {
      const grd = g.createLinearGradient(cx - half, 0, cx + half, 0);
      grd.addColorStop(0, 'rgba(232,242,255,0)');
      grd.addColorStop(0.15, 'rgba(232,242,255,0.85)');
      grd.addColorStop(0.85, 'rgba(232,242,255,0.85)');
      grd.addColorStop(1, 'rgba(232,242,255,0)');
      this.compassGrad = grd;
      this.compassGradX = cx;
    }
    const grad = this.compassGrad;
    g.strokeStyle = grad;
    g.fillStyle = grad;
    g.lineWidth = 1.2;
    g.font = '700 12px "Barlow Condensed", "Rajdhani", sans-serif';
    g.textAlign = 'center';
    const hdg = s.heading;
    const deg = ((hdg * 180) / Math.PI + 3600) % 360;
    const start = Math.floor(deg - 50);
    g.beginPath();
    for (let a = start; a <= deg + 50; a++) {
      if (a % 5 !== 0) continue;
      const x = cx + ((a - deg) * Math.PI / 180) * pxPerRad;
      const major = a % 15 === 0;
      g.moveTo(x, y0 + 14);
      g.lineTo(x, y0 + (major ? 4 : 9));
      if (a % 45 === 0) {
        const idx = (((a / 45) % 8) + 8) % 8;
        g.fillText(CARDINAL[idx], x, y0 + 28);
      } else if (major) {
        g.fillText(String(((a % 360) + 360) % 360), x, y0 + 28);
      }
    }
    g.stroke();
    // Hull heading marker
    if (s.kind !== 'jet') {
      let rel = ((s.hullHeading - hdg) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      rel = Math.max(-0.8, Math.min(0.8, rel));
      const x = cx + rel * pxPerRad;
      g.fillStyle = 'rgba(69,240,160,0.9)';
      g.fillRect(x - 5, y0 + 15, 10, 3);
    }
    g.restore();
    g.fillStyle = '#ffb53d';
    g.beginPath();
    g.moveTo(cx, y0 + 16);
    g.lineTo(cx - 5, y0 + 23);
    g.lineTo(cx + 5, y0 + 23);
    g.closePath();
    g.fill();
    g.font = '700 13px "JetBrains Mono", monospace';
    g.fillStyle = 'rgba(232,242,255,0.95)';
    g.fillText(String(Math.round(deg) % 360).padStart(3, '0'), cx, y0 - 1);
  }

  private drawTank(g: CanvasRenderingContext2D, s: HudState, cx: number, cy: number): void {
    const green = s.zoom ? 'rgba(20,20,20,0.95)' : 'rgba(232,242,255,0.95)';
    g.lineWidth = s.zoom ? 1.5 : 2;
    g.strokeStyle = green;
    g.shadowColor = 'rgba(0,0,0,0.7)';
    g.shadowBlur = s.zoom ? 0 : 3;
    if (s.zoom) {
      // Gunner sight: fine cross, range ladder, mil ticks.
      const R = this.h * 0.34;
      g.strokeStyle = 'rgba(10,14,12,0.95)';
      g.beginPath();
      g.moveTo(cx - R, cy);
      g.lineTo(cx - 14, cy);
      g.moveTo(cx + 14, cy);
      g.lineTo(cx + R, cy);
      g.moveTo(cx, cy + 14);
      g.lineTo(cx, cy + R);
      g.stroke();
      g.beginPath();
      for (let i = 1; i <= 8; i++) {
        const x = i * (R / 9);
        g.moveTo(cx + x, cy - 5);
        g.lineTo(cx + x, cy + 5);
        g.moveTo(cx - x, cy - 5);
        g.lineTo(cx - x, cy + 5);
      }
      g.stroke();
      g.beginPath();
      g.moveTo(cx - 10, cy + 10);
      g.lineTo(cx, cy);
      g.lineTo(cx + 10, cy + 10);
      g.stroke();
      g.fillStyle = 'rgba(255,90,40,0.95)';
      g.font = '700 13px "JetBrains Mono", monospace';
      g.textAlign = 'left';
      g.fillText(s.rangeM < 4990 ? `${Math.round(s.rangeM / 10) * 10} m` : '----', cx + 22, cy + 30);
    } else {
      g.beginPath();
      g.moveTo(cx - 22, cy);
      g.lineTo(cx - 8, cy);
      g.moveTo(cx + 8, cy);
      g.lineTo(cx + 22, cy);
      g.moveTo(cx, cy + 8);
      g.lineTo(cx, cy + 20);
      g.stroke();
      g.beginPath();
      g.arc(cx, cy, 1.6, 0, Math.PI * 2);
      g.fillStyle = green;
      g.fill();
      // Range readout
      g.font = '700 12px "JetBrains Mono", monospace';
      g.textAlign = 'left';
      g.fillStyle = 'rgba(232,242,255,0.9)';
      g.fillText(s.rangeM < 4990 ? `${Math.round(s.rangeM / 10) * 10}m` : '—', cx + 30, cy + 4);
    }
    // Reload ring
    const R = 34;
    g.shadowBlur = 0;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.arc(cx, cy, R, -Math.PI / 2, Math.PI * 1.5);
    g.stroke();
    g.strokeStyle = s.reload >= 1 ? 'rgba(63,208,255,0.75)' : 'rgba(255,181,61,0.95)';
    g.beginPath();
    g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, s.reload));
    g.stroke();
    if (s.reload < 1) {
      // Beside the ring (not under it): the target usually sits just below the crosshair.
      g.font = '700 10px "Barlow Condensed", sans-serif';
      g.textAlign = 'left';
      g.fillStyle = 'rgba(255,181,61,0.95)';
      g.fillText(t('command.reload'), cx + R + 8, cy - R + 10);
    }
    // Gun indicator (where the shell will actually land)
    if (s.gun.visible) {
      const dx = s.gun.x - cx, dy = s.gun.y - cy;
      const onTarget = dx * dx + dy * dy < 36;
      g.lineWidth = 2;
      g.strokeStyle = onTarget ? 'rgba(69,240,160,0.95)' : 'rgba(255,255,255,0.8)';
      g.shadowColor = 'rgba(0,0,0,0.8)';
      g.shadowBlur = 3;
      g.beginPath();
      g.arc(s.gun.x, s.gun.y, 9, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(s.gun.x - 14, s.gun.y);
      g.lineTo(s.gun.x - 9, s.gun.y);
      g.moveTo(s.gun.x + 9, s.gun.y);
      g.lineTo(s.gun.x + 14, s.gun.y);
      g.stroke();
      g.shadowBlur = 0;
    }
  }

  private drawJet(g: CanvasRenderingContext2D, s: HudState, camera: THREE.PerspectiveCamera, cx: number, cy: number): void {
    const col = 'rgba(120,255,170,0.95)';
    const dim = 'rgba(120,255,170,0.55)';
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = 1.6;
    g.shadowColor = 'rgba(40,255,120,0.6)';
    g.shadowBlur = 4;
    // Aim reticle (mouse aim) at screen center
    g.beginPath();
    g.arc(cx, cy, 14, 0, Math.PI * 2);
    g.moveTo(cx + 2, cy);
    g.arc(cx, cy, 2, 0, Math.PI * 2);
    g.stroke();
    // Pitch ladder, world-stabilized: each rung is the projection of a real direction at that elevation along the
    // view heading, so the horizon bar lies on the actual horizon in this third-person view.
    camera.getWorldDirection(LAD_F);
    LAD_F.y = 0;
    if (LAD_F.lengthSq() < 1e-6) LAD_F.set(0, 0, -1);
    LAD_F.normalize();
    LAD_R.set(-LAD_F.z, 0, LAD_F.x);
    g.save();
    g.beginPath();
    g.rect(cx - 230, cy - 190, 460, 380);
    g.clip();
    g.font = '600 11px "JetBrains Mono", monospace';
    for (let p = -60; p <= 60; p += 10) {
      const pr = (p * Math.PI) / 180;
      LAD_D.copy(LAD_F).multiplyScalar(Math.cos(pr));
      LAD_D.y = Math.sin(pr);
      LAD_P.copy(camera.position).addScaledVector(LAD_D, 1000).project(camera);
      if (LAD_P.z > 1 || LAD_P.z < -1) continue;
      const x = (LAD_P.x * 0.5 + 0.5) * this.w, y = (-LAD_P.y * 0.5 + 0.5) * this.h;
      if (Math.abs(x - cx) > 260 || Math.abs(y - cy) > 230) continue;
      LAD_P.copy(camera.position).addScaledVector(LAD_D, 1000).addScaledVector(LAD_R, 20).project(camera);
      const ang = Math.atan2(-LAD_P.y * 0.5 * this.h - (y - this.h * 0.5), (LAD_P.x * 0.5 + 0.5) * this.w - x);
      g.save();
      g.translate(x, y);
      g.rotate(ang);
      if (p === 0) {
        g.strokeStyle = col;
        g.lineWidth = 1.6;
        g.beginPath();
        g.moveTo(-210, 0);
        g.lineTo(-34, 0);
        g.moveTo(34, 0);
        g.lineTo(210, 0);
        g.stroke();
      } else {
        g.strokeStyle = dim;
        g.fillStyle = dim;
        g.lineWidth = 1.3;
        g.setLineDash(p < 0 ? [6, 5] : []);
        g.beginPath();
        g.moveTo(-88, 0);
        g.lineTo(-38, 0);
        g.lineTo(-38, p > 0 ? 7 : -7);
        g.moveTo(88, 0);
        g.lineTo(38, 0);
        g.lineTo(38, p > 0 ? 7 : -7);
        g.stroke();
        g.setLineDash([]);
        g.textAlign = 'right';
        g.fillText(String(Math.abs(p)), -94, 4);
        g.textAlign = 'left';
        g.fillText(String(Math.abs(p)), 94, 4);
      }
      g.restore();
    }
    g.restore();
    // Nose marker (W)
    if (s.gun.visible) {
      const x = s.gun.x, y = s.gun.y;
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x - 20, y);
      g.lineTo(x - 9, y);
      g.lineTo(x - 4, y + 6);
      g.lineTo(x, y);
      g.lineTo(x + 4, y + 6);
      g.lineTo(x + 9, y);
      g.lineTo(x + 20, y);
      g.stroke();
    }
    // Speed / altitude tapes
    g.font = '700 15px "JetBrains Mono", monospace';
    g.lineWidth = 1.5;
    g.strokeStyle = col;
    g.textAlign = 'center';
    const boxes: [number, string, string][] = [
      [cx - 290, String(Math.round(s.speedKmh)), 'KM/H'],
      [cx + 290, String(Math.round(s.altM)), 'M'],
    ];
    for (const [x, v, u] of boxes) {
      g.strokeRect(x - 42, cy - 13, 84, 26);
      g.fillText(v, x, cy + 6);
      g.font = '600 10px "Barlow Condensed", sans-serif';
      g.fillText(u, x, cy + 26);
      g.font = '700 15px "JetBrains Mono", monospace';
    }
    // G and throttle
    g.font = '700 12px "JetBrains Mono", monospace';
    g.textAlign = 'left';
    g.fillText(`G ${s.gLoad.toFixed(1)}`, cx - 330, cy + 58);
    g.fillText(`${Math.round(s.throttle * 100)}%${s.afterburner ? ' AB' : ''}`, cx - 330, cy + 76);
    // Lock / lead
    if (s.lockState > 0 && s.lock.visible) {
      const locked = s.lockState === 2;
      const x = s.lock.x, y = s.lock.y;
      g.strokeStyle = locked ? 'rgba(255,70,50,0.98)' : col;
      g.lineWidth = locked ? 2.5 : 1.6;
      const r = locked ? 16 : 28 - s.lockProgress * 12;
      g.beginPath();
      g.moveTo(x, y - r);
      g.lineTo(x + r, y);
      g.lineTo(x, y + r);
      g.lineTo(x - r, y);
      g.closePath();
      g.stroke();
      g.font = '700 11px "Barlow Condensed", sans-serif';
      g.textAlign = 'center';
      g.fillStyle = locked ? 'rgba(255,70,50,0.98)' : col;
      g.fillText(locked ? t('command.lock') : t('command.locking'), x, y + r + 14);
      g.fillText(`${(s.rangeM / 1000).toFixed(1)} km`, x, y - r - 6);
    }
    if (s.lead.visible) {
      g.strokeStyle = col;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.lead.x, s.lead.y, 10, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(s.lead.x, s.lead.y, 1.8, 0, Math.PI * 2);
      g.fill();
    }
    g.shadowBlur = 0;
  }

  private drawShip(g: CanvasRenderingContext2D, s: HudState, cx: number, cy: number): void {
    const c = 'rgba(232,242,255,0.95)';
    g.strokeStyle = c;
    g.lineWidth = 1.6;
    g.shadowColor = 'rgba(0,0,0,0.7)';
    g.shadowBlur = 3;
    g.beginPath();
    g.moveTo(cx - 40, cy);
    g.lineTo(cx - 10, cy);
    g.moveTo(cx + 10, cy);
    g.lineTo(cx + 40, cy);
    g.moveTo(cx, cy - 26);
    g.lineTo(cx, cy - 10);
    g.moveTo(cx, cy + 10);
    g.lineTo(cx, cy + 26);
    g.stroke();
    // range ladder ticks
    g.beginPath();
    for (let i = 1; i <= 4; i++) {
      g.moveTo(cx - 5, cy + 10 + i * 8);
      g.lineTo(cx + 5, cy + 10 + i * 8);
    }
    g.stroke();
    g.font = '700 12px "JetBrains Mono", monospace';
    g.textAlign = 'left';
    g.fillStyle = c;
    g.fillText(s.rangeM < 21000 ? `${(s.rangeM / 1000).toFixed(2)} km` : '—', cx + 48, cy + 4);
    // Reload ring
    const R = 44;
    g.shadowBlur = 0;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = s.reload >= 1 ? 'rgba(63,208,255,0.75)' : 'rgba(255,181,61,0.95)';
    g.beginPath();
    g.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, s.reload));
    g.stroke();
    g.shadowBlur = 3;
    // Shell impact point (where the barrel is laid)
    if (s.gun.visible) {
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.lineWidth = 2;
      g.beginPath();
      g.arc(s.gun.x, s.gun.y, 8, 0, Math.PI * 2);
      g.stroke();
    }
    // Lead indicator
    if (s.lead.visible) {
      const x = s.lead.x, y = s.lead.y;
      g.strokeStyle = 'rgba(255,181,61,0.98)';
      g.fillStyle = 'rgba(255,181,61,0.98)';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, y - 10);
      g.lineTo(x + 10, y);
      g.lineTo(x, y + 10);
      g.lineTo(x - 10, y);
      g.closePath();
      g.stroke();
      g.font = '700 10px "Barlow Condensed", sans-serif';
      g.textAlign = 'center';
      g.fillText(t('command.lead'), x, y + 23);
    }
    if (s.lockState > 0 && s.lock.visible) {
      const locked = s.lockState === 2;
      const x = s.lock.x, y = s.lock.y;
      g.strokeStyle = locked ? 'rgba(255,70,50,0.98)' : 'rgba(232,242,255,0.8)';
      g.lineWidth = locked ? 2.5 : 1.5;
      const r = locked ? 20 : 34 - s.lockProgress * 14;
      g.strokeRect(x - r, y - r, r * 2, r * 2);
      g.font = '700 11px "Barlow Condensed", sans-serif';
      g.textAlign = 'center';
      g.fillStyle = g.strokeStyle;
      g.fillText(locked ? t('command.lock') : t('command.locking'), x, y - r - 6);
    }
    g.shadowBlur = 0;
  }
}

function byScore(a: { score: number }, b: { score: number }): number {
  return a.score - b.score;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export type { Ent };
