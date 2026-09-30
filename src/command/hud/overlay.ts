// FRONT ULTRA — command mode: the strategic layer of the HUD (DESIGN_V2 §9.11; owner: W5-command-v2).
//
// Around the vehicle HUD (hud.ts: reticles, status, weapons, markers) this adds what ties command mode to the world:
//   top-left     unit name, place («cerca de Zaragoza (España)»), land status («Territorio propio · en paz»,
//                «Francia · en paz · INCURSIÓN», «Alemania · en guerra») and the clock chip («TÁCTICO 1:1»,
//                «VIAJE ×300 · 1 s = 5 min», «VIAJE ×300 (limitado por el terreno)») with its explanation;
//   top-right    the strategic alert strip (warning, danger and critical alerts) under the exit button, clear of the
//                compass tape: one row per alert (a repeat refreshes its row with ×n), rows fade out after 12 s;
//   centre       one-line notices (why time dropped to 1:1, a border ahead) and the decision dialogs (crossing a
//                border, firing first on a nation at peace, leaving command mode);
//   bottom       formation pips and integrity, the controls hint (H toggles it);
//   world        names of towns, bases and borders, the destination marker and, under the cursor, where a force
//                comes from («Guarnición del frente de Lyon · 1.840 tropas en la zona»).
// No objective counter, no operation name.

import * as THREE from 'three';
import { formatNumber, t } from '../../shared/i18n';
import type { CommandKind } from '../../shared/types';
import type { CivilLabel } from '../civil';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const CSS = /* css */ `
.fu-cmd-obj, .fu-cmd-mission, .fu-cmd-help, .fu-cmd-intro { display: none !important; }
/* In command mode the strategic alert feed is replaced by the command strip (top centre). */
body.fu-cmd-on .fu-alerts, body.fu-cmd-on .fu-bstrip { display: none !important; }
.fu-cmdx-labels { position: absolute; inset: 0; width: 100%; height: 100%; }
.fu-cmdx-info { top: 1rem; left: 1rem; padding: 0.6rem 0.9rem 0.65rem; min-width: 17rem; max-width: 27rem; }
.fu-cmdx-info .u { font: 700 1.02rem/1.2 var(--fu-font-display, sans-serif); letter-spacing: 0.06em; text-transform: uppercase; }
.fu-cmdx-info .p { font: 600 0.84rem/1.25 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); margin-top: 0.2rem; }
.fu-cmdx-info .l { display: flex; align-items: center; gap: 0.45rem; margin-top: 0.35rem; font: 700 0.78rem/1.2 var(--fu-font-cond, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; }
.fu-cmdx-info .l .sw { width: 0.7rem; height: 0.7rem; border-radius: 2px; flex: none; }
.fu-cmdx-info .l .inc { color: #1a0e00; background: #ffb53d; padding: 0.12rem 0.35rem; border-radius: 2px; letter-spacing: 0.16em; animation: fu-cmdx-blink 1.2s ease-in-out infinite; }
.fu-cmdx-info .l.war { color: #ff8a7a; }
.fu-cmdx-info .c { display: inline-flex; gap: 0.5rem; align-items: center; margin-top: 0.5rem; pointer-events: auto; cursor: help;
  font: 700 0.74rem/1 var(--fu-font-mono, monospace); letter-spacing: 0.1em; padding: 0.3rem 0.5rem; border-radius: 2px;
  background: rgba(63,208,255,0.12); border: 1px solid rgba(63,208,255,0.35); color: #aee9ff; }
.fu-cmdx-info .c.travel { background: rgba(255,181,61,0.14); border-color: rgba(255,181,61,0.45); color: #ffd58a; }
.fu-cmdx-info .c.thr { background: rgba(255,120,60,0.16); border-color: rgba(255,140,80,0.55); color: #ffb08a; }
.fu-cmdx-info .c.dec { background: rgba(255,255,255,0.1); border-color: rgba(255,255,255,0.35); color: #fff; }
.fu-cmdx-info .tm { font: 600 0.7rem/1 var(--fu-font-mono, monospace); color: var(--fu-text-dim, #7d91a8); margin-top: 0.4rem; }
.fu-cmdx-info .tr { font: 600 0.76rem/1.3 var(--fu-font, sans-serif); color: #ffd58a; margin-top: 0.35rem; }
.fu-cmdx-tip { position: absolute; top: calc(100% + 6px); left: 0; width: 24rem; padding: 0.55rem 0.7rem; display: none;
  font: 500 0.8rem/1.4 var(--fu-font, sans-serif); letter-spacing: 0; text-transform: none; color: var(--fu-text, #e8f2ff);
  background: rgba(6,10,16,0.94); border: 1px solid rgba(132,196,255,0.25); border-radius: 3px; z-index: 5; }
.fu-cmdx-info .c:hover .fu-cmdx-tip { display: block; }
.fu-cmdx-info .cw { position: relative; display: inline-block; }
.fu-cmdx-alerts { position: absolute; top: 3.6rem; right: 1rem; width: min(27rem, 36vw); display: flex; flex-direction: column; gap: 0.3rem; align-items: stretch; }
.fu-cmdx-alerts .a { display: flex; gap: 0.6rem; align-items: baseline; padding: 0.4rem 0.7rem; background: rgba(8,12,18,0.82);
  border-left: 3px solid #ffb53d; font: 600 0.82rem/1.3 var(--fu-font, sans-serif); animation: fu-cmdx-in 0.3s ease both; transition: opacity 0.6s; }
.fu-cmdx-alerts .a.danger { border-color: #ff6a4a; } .fu-cmdx-alerts .a.critical { border-color: #ff2a2a; background: rgba(40,6,6,0.85); }
.fu-cmdx-alerts .a b { font: 700 0.8rem/1.3 var(--fu-font-cond, sans-serif); letter-spacing: 0.05em; text-transform: uppercase; flex: none; }
.fu-cmdx-alerts .a span { color: var(--fu-text-2, #b3c4d6); }
.fu-cmdx-alerts .a { transition: opacity 0.8s ease; flex-wrap: wrap; row-gap: 0.1rem; }
.fu-cmdx-alerts .a i { font: 700 0.72rem/1.3 var(--fu-font-cond, sans-serif); font-style: normal; color: #ffd58a; margin-left: auto; flex: none; }
.fu-cmdx-alerts .back { align-self: flex-end; font: 700 0.64rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.24em; color: var(--fu-text-dim, #7d91a8); text-transform: uppercase; }
.fu-cmdx-notice { position: absolute; top: 27%; left: 50%; transform: translateX(-50%); padding: 0.5rem 1rem; text-align: center;
  font: 700 0.92rem/1.3 var(--fu-font-cond, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; color: #ffe0a0;
  background: rgba(10,8,4,0.7); border: 1px solid rgba(255,181,61,0.35); border-radius: 3px; opacity: 0; transition: opacity 0.4s; max-width: 46rem; }
.fu-cmdx-notice.show { opacity: 1; }
.fu-cmdx-notice.info { color: #bfeaff; border-color: rgba(63,208,255,0.35); background: rgba(4,10,16,0.7); }
.fu-cmdx-form { position: absolute; bottom: 1rem; left: 50%; transform: translateX(-50%); padding: 0.45rem 0.8rem; display: flex; gap: 0.7rem; align-items: center;
  font: 700 0.72rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.16em; text-transform: uppercase; }
.fu-cmdx-form .pips { display: flex; gap: 0.3rem; }
.fu-cmdx-form .pips i { width: 0.9rem; height: 0.55rem; border-radius: 1px; background: #45f0a0; box-shadow: 0 0 6px rgba(69,240,160,0.6); }
.fu-cmdx-form .pips i.me { background: #3fd0ff; box-shadow: 0 0 8px rgba(63,208,255,0.9); }
.fu-cmdx-form .pips i.lost { background: rgba(255,80,60,0.35); box-shadow: none; }
.fu-cmdx-form .pips i.ifv { width: 0.55rem; }
.fu-cmdx-help { position: absolute; bottom: 4.1rem; left: 50%; transform: translateX(-50%); padding: 0.4rem 0.9rem; text-align: center; max-width: 60rem;
  font: 600 0.78rem/1.55 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); background: rgba(5,9,15,0.6); border-radius: 3px; transition: opacity 0.8s; }
.fu-cmdx-help b { color: var(--fu-text, #e8f2ff); }
.fu-cmdx-dialog { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.35); pointer-events: auto; }
.fu-cmdx-dialog.show { display: flex; }
.fu-cmdx-dialog .card { width: min(34rem, 90vw); padding: 1.1rem 1.3rem 1rem; }
.fu-cmdx-dialog .card .h { font: 700 1.05rem/1.25 var(--fu-font-display, sans-serif); letter-spacing: 0.06em; text-transform: uppercase; }
.fu-cmdx-dialog .card .b { font: 500 0.9rem/1.5 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); margin-top: 0.6rem; }
.fu-cmdx-dialog .card .b2 { font: 600 0.84rem/1.45 var(--fu-font, sans-serif); color: #ffd58a; margin-top: 0.5rem; }
.fu-cmdx-dialog .card .btns { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 1rem; }
.fu-cmdx-dialog button { pointer-events: auto; cursor: pointer; padding: 0.5rem 0.95rem; font: 700 0.76rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.18em;
  text-transform: uppercase; color: var(--fu-text, #e8f2ff); background: rgba(8,14,22,0.8); border: 1px solid rgba(132,196,255,0.35); border-radius: 3px; }
.fu-cmdx-dialog button.pri { background: rgba(63,208,255,0.18); border-color: var(--fu-accent, #3fd0ff); }
.fu-cmdx-dialog button.danger { background: rgba(255,70,50,0.2); border-color: #ff6a4a; color: #ffd0c8; }
.fu-cmdx-dialog button kbd { font: 700 0.62rem/1 var(--fu-font-mono, monospace); margin-left: 0.45rem; opacity: 0.7; }
.fu-cmdx-title { position: absolute; left: 50%; bottom: 22%; transform: translateX(-50%); text-align: center; opacity: 0; transition: opacity 0.8s; }
.fu-cmdx-title.show { opacity: 1; }
.fu-cmdx-title .u { font: 700 1.9rem/1.15 var(--fu-font-display, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; text-shadow: 0 2px 18px rgba(0,0,0,0.8); }
.fu-cmdx-title .s { font: 600 1rem/1.4 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); margin-top: 0.35rem; text-shadow: 0 1px 8px rgba(0,0,0,0.9); }
.fu-cmdx-title .line { width: 16rem; height: 2px; margin: 0.6rem auto 0; background: linear-gradient(90deg, transparent, var(--fu-accent, #3fd0ff), transparent); }
.fu-cmdx-debrief { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); }
.fu-cmdx-debrief.show { display: flex; }
.fu-cmdx-debrief .card { width: min(30rem, 90vw); padding: 1rem 1.2rem; }
.fu-cmdx-debrief .hdr { font: 700 0.7rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.3em; color: var(--fu-text-dim, #7d91a8); }
.fu-cmdx-debrief .ttl { font: 700 1.25rem/1.2 var(--fu-font-display, sans-serif); letter-spacing: 0.06em; text-transform: uppercase; margin-top: 0.3rem; }
.fu-cmdx-debrief .r { display: flex; justify-content: space-between; gap: 1rem; padding: 0.35rem 0; border-bottom: 1px solid rgba(255,255,255,0.07); font: 600 0.86rem/1.3 var(--fu-font, sans-serif); }
.fu-cmdx-debrief .r span { color: var(--fu-text-2, #b3c4d6); } .fu-cmdx-debrief .r b { text-align: right; }
.fu-cmdx-debrief .r b.red { color: #ff8a7a; } .fu-cmdx-debrief .r b.green { color: #45f0a0; }
.fu-cmdx-debrief .f { font: 500 0.8rem/1.4 var(--fu-font, sans-serif); color: var(--fu-text-dim, #7d91a8); margin-top: 0.6rem; }
.fu-cmdx-loading { position: absolute; left: 50%; top: 55%; transform: translateX(-50%); font: 700 0.8rem/1 var(--fu-font-cond, sans-serif);
  letter-spacing: 0.24em; text-transform: uppercase; color: var(--fu-text-dim, #7d91a8); display: none; }
.fu-cmdx-loading.show { display: block; }
.fu-cmdx-radio { position: absolute; top: 6.6rem; left: 50%; transform: translateX(-50%); width: min(36rem, 56vw); padding: 0.55rem 0.8rem 0.6rem;
  background: rgba(10,8,4,0.86); border: 1px solid rgba(255,181,61,0.55); border-left: 4px solid #ffb53d; border-radius: 3px; display: none; }
.fu-cmdx-radio.show { display: block; animation: fu-cmdx-in 0.3s ease both; }
.fu-cmdx-radio.danger { border-color: rgba(255,106,74,0.6); border-left-color: #ff6a4a; }
.fu-cmdx-radio.critical { border-color: rgba(255,42,42,0.7); border-left-color: #ff2a2a; background: rgba(36,6,6,0.9); }
.fu-cmdx-radio .hd { display: flex; align-items: center; gap: 0.5rem; font: 700 0.7rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.18em; text-transform: uppercase; color: #ffd58a; }
.fu-cmdx-radio .hd .tag { color: #1a0e00; background: #ffb53d; padding: 0.14rem 0.35rem; border-radius: 2px; animation: fu-cmdx-blink 1.2s ease-in-out infinite; }
.fu-cmdx-radio.danger .hd .tag { background: #ff6a4a; } .fu-cmdx-radio.critical .hd .tag { background: #ff2a2a; color: #fff; }
.fu-cmdx-radio .m { font: 600 0.9rem/1.4 var(--fu-font, sans-serif); color: var(--fu-text, #e8f2ff); margin-top: 0.35rem; }
.fu-cmdx-radio .s { font: 500 0.78rem/1.35 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); margin-top: 0.25rem; }
.fu-cmdx-radio .cd { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.45rem; font: 700 0.74rem/1 var(--fu-font-mono, monospace); letter-spacing: 0.08em; color: #ffd58a; }
.fu-cmdx-radio .cd .bar { flex: 1; height: 5px; background: rgba(255,255,255,0.12); border-radius: 2px; overflow: hidden; }
.fu-cmdx-radio .cd .bar i { display: block; height: 100%; background: #ffb53d; transition: width 0.25s linear; }
.fu-cmdx-radio.danger .cd .bar i, .fu-cmdx-radio.critical .cd .bar i { background: #ff6a4a; }
.fu-cmdx-radio .cd .n { min-width: 4.5rem; text-align: right; font-size: 0.9rem; }
.fu-cmdx-radio .x { font: 700 0.72rem/1.2 var(--fu-font-cond, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; color: #aee9ff; margin-top: 0.4rem; }
/* Feedback 3 (#26): the nearest action — what, how far, which way — with «G Ir al combate». */
.fu-cmdx-combat { position: absolute; top: 1rem; left: 50%; transform: translateX(-50%); display: none; align-items: center; gap: 0.6rem;
  padding: 0.4rem 0.5rem 0.4rem 0.75rem; background: rgba(20,6,4,0.8); border: 1px solid rgba(255,106,74,0.55); border-radius: 3px;
  font: 700 0.78rem/1.2 var(--fu-font-cond, sans-serif); letter-spacing: 0.08em; text-transform: uppercase; color: #ffd0c4; max-width: 44rem; pointer-events: auto; }
.fu-cmdx-combat.show { display: flex; }
.fu-cmdx-combat .ic { width: 0.9rem; height: 0.9rem; border: 2px solid #ff6a4a; border-radius: 50%; flex: none; box-shadow: 0 0 8px rgba(255,106,74,0.7); }
.fu-cmdx-combat.contact .ic { background: #ff6a4a; animation: fu-cmdx-blink 0.9s ease-in-out infinite; }
.fu-cmdx-combat .w { display: flex; flex-direction: column; gap: 0.12rem; }
.fu-cmdx-combat .w small { font: 600 0.72rem/1.2 var(--fu-font, sans-serif); letter-spacing: 0; text-transform: none; color: #d9b8ae; }
.fu-cmdx-combat .d { font: 700 0.95rem/1 var(--fu-font-mono, monospace); color: #fff; letter-spacing: 0.02em; white-space: nowrap; }
.fu-cmdx-combat button { pointer-events: auto; cursor: pointer; padding: 0.4rem 0.65rem; font: 700 0.72rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.14em;
  text-transform: uppercase; color: #fff; background: rgba(255,90,60,0.28); border: 1px solid #ff6a4a; border-radius: 2px; white-space: nowrap; }
.fu-cmdx-combat button:hover { background: rgba(255,90,60,0.45); }
.fu-cmdx-combat button kbd { font: 700 0.64rem/1 var(--fu-font-mono, monospace); margin-right: 0.4rem; padding: 0.08rem 0.25rem; border: 1px solid rgba(255,255,255,0.5); border-radius: 2px; }
.fu-cmdx-combat button[hidden] { display: none; }
.fu-cmdx-transit { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(36rem, 88vw); padding: 1rem 1.2rem; display: none; }
.fu-cmdx-transit.show { display: block; animation: fu-cmdx-in 0.3s ease both; }
.fu-cmdx-transit .k { font: 700 0.68rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.3em; color: #ffb53d; text-transform: uppercase; }
.fu-cmdx-transit .h { font: 700 1.2rem/1.25 var(--fu-font-display, sans-serif); letter-spacing: 0.05em; text-transform: uppercase; margin-top: 0.35rem; }
.fu-cmdx-transit .b { font: 500 0.86rem/1.45 var(--fu-font, sans-serif); color: var(--fu-text-2, #b3c4d6); margin-top: 0.45rem; }
.fu-cmdx-transit .bar { height: 6px; margin-top: 0.8rem; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
.fu-cmdx-transit .bar i { display: block; height: 100%; background: linear-gradient(90deg, #ffb53d, #ff6a4a); }
.fu-cmdx-transit .n { display: flex; justify-content: space-between; margin-top: 0.45rem; font: 700 0.8rem/1 var(--fu-font-mono, monospace); color: #ffd58a; }
.fu-cmdx-transit .f { font: 600 0.72rem/1.3 var(--fu-font, sans-serif); color: var(--fu-text-dim, #7d91a8); margin-top: 0.6rem; }
.fu-cmdx-nv { position: absolute; top: 5.2rem; right: 1rem; padding: 0.3rem 0.55rem; display: none; font: 700 0.7rem/1 var(--fu-font-mono, monospace);
  letter-spacing: 0.14em; color: #aaffb0; background: rgba(4,20,6,0.8); border: 1px solid rgba(120,255,140,0.5); border-radius: 2px; }
.fu-cmdx-nv.show { display: block; }
.fu-cmdx-nv.thermal { color: #fff; background: rgba(30,30,30,0.85); border-color: rgba(255,255,255,0.5); }
@keyframes fu-cmdx-in { from { opacity: 0; transform: translateY(-0.4rem); } to { opacity: 1; transform: none; } }
@keyframes fu-cmdx-blink { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
`;

let cssDone = false;

export interface InfoState {
  unit: string;
  place: string;
  land: string;
  landColor: string;
  incursion: boolean;
  war: boolean;
  clock: string;
  clockKind: 'tactical' | 'travel' | 'throttled' | 'decision';
  localTime: string;
  travel: string;
}

/** The victim's radio during an incursion (owner feedback #19): who speaks, what, and the running countdown. */
export interface RadioState {
  severity: 'warning' | 'danger' | 'critical';
  from: string;
  message: string;
  sub?: string;
  countLabel?: string;
  /** Seconds left (game s = real s at ×1) and the whole span, for the bar. */
  remain?: number;
  total?: number;
  /** Already formatted remaining time. */
  remainText?: string;
  exit?: string;
}

/** Feedback 3 (#26): the nearest action for the HUD chip. */
export interface CombatChip {
  /** «Frente con Francia», «Combate: ofensiva sobre Lyon», «2.ª División acorazada (Francia)». */
  title: string;
  /** Second line (the mission's target, the way there). */
  sub: string;
  /** «14 km · NE». */
  dist: string;
  /** In contact now (enemy within reach): no travel button. */
  contact: boolean;
  /** Button label («Ir al combate», «Ir al frente más cercano»), empty = no button. */
  go: string;
}

export interface DebriefRow {
  label: string;
  value: string;
  cls?: 'red' | 'green';
}

export interface HoverInfo {
  x: number;
  y: number;
  text: string;
}

const P = new THREE.Vector3();

export class CommandOverlay {
  readonly root: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly info: HTMLDivElement;
  private readonly alerts: HTMLDivElement;
  private readonly notice: HTMLDivElement;
  private readonly form: HTMLDivElement;
  private readonly help: HTMLDivElement;
  private readonly dialog: HTMLDivElement;
  private readonly title: HTMLDivElement;
  private readonly debrief: HTMLDivElement;
  private readonly loading: HTMLDivElement;
  private readonly radio: HTMLDivElement;
  private readonly combat: HTMLDivElement;
  private readonly transit: HTMLDivElement;
  private readonly nv: HTMLDivElement;
  private lastCombat = '';
  /** «Ir al combate» clicked on the chip. */
  onGo: (() => void) | null = null;
  /** The world marker of the nearest action (scene position) and its text; null = none. */
  combatMarker: { pos: THREE.Vector3; text: string; contact: boolean } | null = null;
  private lastRadio = '';
  private noticeT = 0;
  private titleT = 0;
  private helpT = 0;
  private helpOn = true;
  private time = 0;
  private lastInfo = '';
  private lastForm = '';
  private alertList: { el: HTMLElement; t: number; key: string; n: number }[] = [];
  private dpr = 1;
  private w = 1;
  private h = 1;
  /** Open dialog: its resolver (the choice index). */
  private dialogResolve: ((i: number) => void) | null = null;
  private dialogKeys: string[] = [];

  constructor(parent: HTMLElement) {
    if (!cssDone) {
      cssDone = true;
      const s = document.createElement('style');
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    this.root = el('div', 'fu-cmd fu-cmdx fu-cmd-hidden');
    this.root.style.zIndex = '21';
    this.canvas = el('canvas', 'fu-cmdx-labels');
    this.g = this.canvas.getContext('2d')!;
    this.info = el('div', 'fu-cmd-panel fu-cmdx-info');
    this.alerts = el('div', 'fu-cmdx-alerts');
    this.notice = el('div', 'fu-cmdx-notice');
    this.form = el('div', 'fu-cmd-panel fu-cmdx-form');
    this.help = el('div', 'fu-cmdx-help');
    this.dialog = el('div', 'fu-cmdx-dialog fu-cmd-interactive');
    this.title = el('div', 'fu-cmdx-title');
    this.debrief = el('div', 'fu-cmdx-debrief');
    this.loading = el('div', 'fu-cmdx-loading', '');
    this.radio = el('div', 'fu-cmdx-radio');
    this.combat = el('div', 'fu-cmdx-combat fu-cmd-interactive');
    this.combat.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('button')) {
        ev.stopPropagation();
        this.onGo?.();
      }
    });
    this.transit = el('div', 'fu-cmd-panel fu-cmdx-transit');
    this.nv = el('div', 'fu-cmdx-nv');
    this.root.append(this.canvas, this.info, this.combat, this.nv, this.alerts, this.radio, this.transit, this.notice, this.form, this.help, this.title, this.loading, this.dialog, this.debrief);
    parent.appendChild(this.root);
  }

  show(kind: CommandKind): void {
    this.root.classList.remove('fu-cmd-hidden');
    document.body.classList.add('fu-cmd-on');
    this.alerts.innerHTML = '';
    this.alertList = [];
    this.debrief.classList.remove('show');
    this.dialog.classList.remove('show');
    this.setRadio(null);
    this.lastInfo = this.lastForm = '';
    this.helpOn = true;
    this.helpT = 0;
    this.help.innerHTML = `${bold(t(`command.help.${kind}`))}<br>${bold(t('command.help.common'))}`;
    this.help.style.opacity = '1';
  }

  /** The nearest-action chip (null hides it). */
  setCombat(c: CombatChip | null): void {
    const key = c ? JSON.stringify(c) : '';
    if (key === this.lastCombat) return;
    this.lastCombat = key;
    if (!c) {
      this.combat.classList.remove('show');
      return;
    }
    this.combat.className = `fu-cmdx-combat fu-cmd-interactive show${c.contact ? ' contact' : ''}`;
    this.combat.innerHTML = `<span class="ic"></span><div class="w"><span>${esc(c.title)}</span>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</div>
      <span class="d">${esc(c.dist)}</span><button ${c.go ? '' : 'hidden'}><kbd>G</kbd>${esc(c.go)}</button>`;
  }

  get combatText(): string {
    return this.combat.classList.contains('show') ? (this.combat.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  }

  /** The march card shown while the unit travels to the action behind the fade (null hides it). */
  setTransit(s: { title: string; body: string; pct: number; left: string; time: string; foot: string } | null): void {
    if (!s) {
      this.transit.classList.remove('show');
      return;
    }
    this.transit.classList.add('show');
    this.transit.innerHTML = `<div class="k">${esc(t('command.transit.kicker'))}</div><div class="h">${esc(s.title)}</div><div class="b">${esc(s.body)}</div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, s.pct)).toFixed(1)}%"></i></div>
      <div class="n"><span>${esc(s.left)}</span><span>${esc(s.time)}</span></div><div class="f">${esc(s.foot)}</div>`;
  }

  get transitText(): string {
    return this.transit.classList.contains('show') ? (this.transit.textContent ?? '').replace(/\s+/g, ' ').trim() : '';
  }

  /** Night-vision / thermal mode badge ('' hides it). */
  setVision(mode: '' | 'nv' | 'thermal', text: string): void {
    this.nv.className = `fu-cmdx-nv${mode ? ' show' : ''}${mode === 'thermal' ? ' thermal' : ''}`;
    this.nv.textContent = text;
  }

  hide(): void {
    this.setCombat(null);
    this.setTransit(null);
    this.setVision('', '');
    this.combatMarker = null;
    this.root.classList.add('fu-cmd-hidden');
    document.body.classList.remove('fu-cmd-on');
    this.closeDialog(-1);
  }

  resize(w: number, h: number): void {
    this.dpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  setLoading(on: boolean): void {
    this.loading.textContent = t('command.loading');
    this.loading.classList.toggle('show', on);
  }

  toggleHelp(): void {
    this.helpOn = !this.helpOn;
    this.helpT = 0;
  }

  setHelpText(kind: CommandKind, travel: boolean): void {
    const html = `${bold(t(travel ? 'command.help.travel' : `command.help.${kind}`))}<br>${bold(t('command.help.common'))}`;
    if (this.help.innerHTML !== html) this.help.innerHTML = html;
  }

  titleCard(unit: string, line: string): void {
    this.title.innerHTML = `<div class="u">${esc(unit)}</div><div class="line"></div><div class="s">${esc(line)}</div>`;
    this.title.classList.add('show');
    this.titleT = this.time + 3.4;
  }

  showNotice(text: string, seconds = 3.5, info = false): void {
    this.notice.textContent = text;
    this.notice.classList.toggle('info', info);
    this.notice.classList.add('show');
    this.noticeT = this.time + seconds;
  }

  get noticeText(): string {
    return this.notice.classList.contains('show') ? this.notice.textContent ?? '' : '';
  }

  /**
   * A strategic alert on the strip under the compass. The same alert again (same title: the strategic feed coalesces it
   * as «ahora ×n») refreshes its row with a counter instead of adding another; at most 3 rows, each fading out after
   * ALERT_S seconds.
   */
  pushAlert(severity: string, title: string, body: string): void {
    const key = `${severity}|${title}`;
    const old = this.alertList.find((a) => a.key === key);
    if (old) {
      old.n++;
      old.t = this.time;
      old.el.className = `a ${severity}`;
      old.el.style.opacity = '';
      old.el.innerHTML = `<b>${esc(title)}</b><span>${esc(body)}</span><i>×${old.n}</i>`;
      this.alerts.prepend(old.el);
      this.alertList.splice(this.alertList.indexOf(old), 1);
      this.alertList.unshift(old);
    } else {
      const e = el('div', `a ${severity}`, `<b>${esc(title)}</b><span>${esc(body)}</span>`);
      this.alerts.prepend(e);
      this.alertList.unshift({ el: e, t: this.time, key, n: 1 });
      while (this.alertList.length > 3) this.alertList.pop()!.el.remove();
    }
    let back = this.alerts.querySelector('.back') as HTMLElement | null;
    if (!back) {
      back = el('div', 'back', t('command.alerts.back'));
    }
    this.alerts.appendChild(back);
  }

  /** Rows on the alert strip (tools). */
  get alertRows(): { text: string; n: number }[] {
    return this.alertList.map((a) => ({ text: a.el.textContent ?? '', n: a.n }));
  }

  /** A modal choice. Resolves with the button index (keys: Enter = first, Escape = last). */
  ask(title: string, body: string, extra: string, buttons: { label: string; cls?: string; key?: string }[]): Promise<number> {
    this.closeDialog(-1);
    const btns = buttons.map((b, i) => `<button data-i="${i}" class="${b.cls ?? ''}">${esc(b.label)}${b.key ? `<kbd>${esc(b.key)}</kbd>` : ''}</button>`).join('');
    this.dialog.innerHTML = `<div class="card fu-cmd-panel"><div class="h">${esc(title)}</div><div class="b">${esc(body)}</div>${extra ? `<div class="b2">${esc(extra)}</div>` : ''}<div class="btns">${btns}</div></div>`;
    this.dialog.classList.add('show');
    this.dialogKeys = buttons.map((b) => b.key ?? '');
    return new Promise((resolve) => {
      this.dialogResolve = resolve;
      this.dialog.querySelectorAll('button').forEach((b) => {
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.closeDialog(Number((b as HTMLElement).dataset.i));
        });
      });
    });
  }

  get dialogOpen(): boolean {
    return !!this.dialogResolve;
  }

  /** Keyboard answer for the open dialog: Enter picks the first button, Escape the last. */
  dialogKey(code: string): boolean {
    if (!this.dialogResolve) return false;
    if (code === 'Enter' || code === 'NumpadEnter') this.closeDialog(0);
    else if (code === 'Escape') this.closeDialog(this.dialogKeys.length - 1);
    else return false;
    return true;
  }

  closeDialog(i: number): void {
    const r = this.dialogResolve;
    this.dialogResolve = null;
    this.dialog.classList.remove('show');
    this.dialog.innerHTML = '';
    r?.(i);
  }

  showDebrief(title: string, rows: DebriefRow[], foot: string): void {
    this.debrief.innerHTML = `<div class="card fu-cmd-panel"><div class="hdr">${esc(t('command.debrief2.title'))}</div><div class="ttl">${esc(title)}</div>
      ${rows.map((r) => `<div class="r"><span>${esc(r.label)}</span><b class="${r.cls ?? ''}">${esc(r.value)}</b></div>`).join('')}
      <div class="f">${esc(foot)}</div></div>`;
    this.debrief.classList.add('show');
  }

  setInfo(s: InfoState): void {
    const key = JSON.stringify(s);
    if (key === this.lastInfo) return;
    this.lastInfo = key;
    const cls = s.clockKind === 'tactical' ? '' : s.clockKind === 'throttled' ? 'thr' : s.clockKind === 'decision' ? 'dec' : 'travel';
    this.info.innerHTML = `<div class="u">${esc(s.unit)}</div><div class="p">${esc(s.place)}</div>
      <div class="l${s.war ? ' war' : ''}"><span class="sw" style="background:${s.landColor}"></span><span>${esc(s.land)}</span>${s.incursion ? `<span class="inc">${esc(t('command.land.incursion'))}</span>` : ''}</div>
      <div class="cw"><div class="c ${cls}" data-k="clock">${esc(s.clock)}<div class="fu-cmdx-tip">${esc(t('command.clock.tip'))}</div></div></div>
      ${s.travel ? `<div class="tr">${esc(s.travel)}</div>` : ''}
      <div class="tm">${esc(s.localTime)}</div>`;
  }

  /** The incursion radio panel, or null to hide it. */
  setRadio(r: RadioState | null): void {
    const key = r ? JSON.stringify({ ...r, remain: r.remain !== undefined ? Math.ceil(r.remain) : undefined }) : '';
    if (key === this.lastRadio) return;
    this.lastRadio = key;
    if (!r) {
      this.radio.classList.remove('show');
      this.radio.innerHTML = '';
      return;
    }
    this.radio.className = `fu-cmdx-radio show ${r.severity === 'warning' ? '' : r.severity}`;
    const pct = r.remain !== undefined && r.total ? Math.max(0, Math.min(100, (r.remain / r.total) * 100)) : -1;
    this.radio.innerHTML = `<div class="hd"><span class="tag">${esc(t('command.radio.tag'))}</span><span>${esc(r.from)}</span></div>
      <div class="m">${esc(r.message)}</div>${r.sub ? `<div class="s">${esc(r.sub)}</div>` : ''}
      ${pct >= 0 ? `<div class="cd"><span>${esc(r.countLabel ?? '')}</span><div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div><span class="n">${esc(r.remainText ?? '')}</span></div>` : ''}
      ${r.exit ? `<div class="x">${esc(r.exit)}</div>` : ''}`;
  }

  get radioText(): string {
    return this.radio.classList.contains('show') ? this.radio.textContent?.replace(/\s+/g, ' ').trim() ?? '' : '';
  }

  setFormation(kind: CommandKind, pips: ('me' | 'ok' | 'lost' | 'ifv' | 'ifvLost')[], integrity: number): void {
    const key = `${kind}${pips.join()}${Math.round(integrity * 100)}`;
    if (key === this.lastForm) return;
    this.lastForm = key;
    const alive = pips.filter((p) => p === 'me' || p === 'ok').length;
    const label = kind === 'ship' ? t('command.formation.ship') : t(`command.formation.${kind}`, { n: alive });
    this.form.innerHTML = `<span>${esc(label)}</span><div class="pips">${pips.map((p) => `<i class="${p === 'me' ? 'me' : p === 'lost' ? 'lost' : p === 'ifv' ? 'ifv' : p === 'ifvLost' ? 'ifv lost' : ''}"></i>`).join('')}</div>
      <span>${esc(t('command.formation.integrity', { pct: Math.round(integrity * 100) }))}</span>`;
  }

  get infoText(): string {
    return this.info.textContent ?? '';
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame
  // ---------------------------------------------------------------------------------------------
  /** World labels drawn in the last frame («text | sub · distance»), for tools. */
  readonly drawnLabels: string[] = [];
  update(dt: number, camera: THREE.PerspectiveCamera, labels: readonly CivilLabel[], waypoint: THREE.Vector3 | null, waypointText: string, hover: HoverInfo | null, kind: CommandKind): void {
    this.time += dt;
    if (this.noticeT && this.time > this.noticeT) {
      this.notice.classList.remove('show');
      this.noticeT = 0;
    }
    if (this.titleT && this.time > this.titleT) {
      this.title.classList.remove('show');
      this.titleT = 0;
    }
    this.helpT += dt;
    this.help.style.opacity = this.helpOn && this.helpT < 25 ? '1' : '0';
    // Rows fade out after ALERT_S and leave the strip; the «Esc» hint goes with the last one.
    for (let i = this.alertList.length - 1; i >= 0; i--) {
      const a = this.alertList[i];
      const age = this.time - a.t;
      if (age > ALERT_S + 1) {
        a.el.remove();
        this.alertList.splice(i, 1);
      } else if (age > ALERT_S) a.el.style.opacity = '0';
    }
    if (this.alertList.length === 0) this.alerts.querySelector('.back')?.remove();
    // World labels.
    const g = this.g, W = this.w, H = this.h;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const maxD = kind === 'jet' ? 120_000 : kind === 'ship' ? 60_000 : 32_000;
    const placed: { x: number; y: number; w: number }[] = [];
    const sorted = [...labels].map((l) => ({ l, d: camera.position.distanceTo(P.set(l.x, l.y, l.z)) })).filter((o) => o.d < maxD).sort((a, b) => rankOf(a.l) - rankOf(b.l) || a.d - b.d);
    this.drawnLabels.length = 0;
    for (const { l, d } of sorted) {
      P.set(l.x, l.y, l.z).project(camera);
      if (P.z > 1 || P.z < -1) continue;
      const x = (P.x * 0.5 + 0.5) * W, y = (-P.y * 0.5 + 0.5) * H;
      if (x < -50 || x > W + 50 || y < 60 || y > H - 40) continue;
      const big = l.kind === 'capital' || l.kind === 'city' || (l.kind === 'town' && d < maxD * 0.5);
      g.font = `700 ${big ? 13 : 11}px "Barlow Condensed", "Rajdhani", sans-serif`;
      const txt = l.text.toUpperCase();
      const w = g.measureText(txt).width;
      if (placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 8 && Math.abs(p.y - y) < 26)) continue;
      placed.push({ x, y, w });
      g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,0.55)';
      g.fillText(txt, x + 1, y + 1);
      g.fillStyle = l.kind === 'force' ? (l.tone === 'hostile' ? '#ff8a7a' : l.tone === 'neutral' ? '#ffc44a' : '#8fd8ff')
        : l.kind === 'border' ? '#ffd58a' : l.kind === 'base' ? '#e8f2ff' : '#fff6e0';
      g.fillText(txt, x, y);
      g.fillStyle = l.color;
      g.fillRect(x - 5, y + 5, 10, 3);
      if (l.sub) {
        g.font = '600 10px "Barlow", sans-serif';
        g.fillStyle = 'rgba(200,215,230,0.85)';
        g.fillText(`${l.sub} · ${d >= 1000 ? `${formatNumber(d / 1000, d < 10_000 ? 1 : 0)} km` : `${Math.round(d)} m`}`, x, y + 18);
      }
      this.drawnLabels.push(`${l.text}${l.sub ? ` | ${l.sub} · ${d >= 1000 ? `${formatNumber(d / 1000, d < 10_000 ? 1 : 0)} km` : `${Math.round(d)} m`}` : ''}`);
    }
    // Destination marker.
    if (waypoint) {
      P.copy(waypoint).project(camera);
      const on = P.z < 1 && P.z > -1;
      let x = (P.x * 0.5 + 0.5) * W, y = (-P.y * 0.5 + 0.5) * H;
      if (!on || x < 20 || x > W - 20 || y < 20 || y > H - 20) {
        // Off screen: an arrow on the edge toward it.
        const dx = on ? x - W / 2 : -(x - W / 2), dy = on ? y - H / 2 : -(y - H / 2);
        const a = Math.atan2(dy, dx);
        x = W / 2 + Math.cos(a) * (W / 2 - 40);
        y = H / 2 + Math.sin(a) * (H / 2 - 40);
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.fillStyle = 'rgba(255,213,138,0.95)';
        g.beginPath();
        g.moveTo(12, 0);
        g.lineTo(-6, -8);
        g.lineTo(-6, 8);
        g.closePath();
        g.fill();
        g.restore();
      } else {
        g.strokeStyle = 'rgba(255,213,138,0.95)';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, y - 12);
        g.lineTo(x + 9, y);
        g.lineTo(x, y + 12);
        g.lineTo(x - 9, y);
        g.closePath();
        g.stroke();
      }
      g.font = '700 11px "Barlow Condensed", sans-serif';
      g.fillStyle = 'rgba(255,213,138,0.95)';
      g.textAlign = 'center';
      g.fillText(waypointText, x, y - 18);
    }
    // The nearest action (#26): always on screen — a red ring on it, or an arrow on the edge pointing to it.
    const cm = this.combatMarker;
    if (cm) {
      P.copy(cm.pos).project(camera);
      const on = P.z < 1 && P.z > -1;
      let x = (P.x * 0.5 + 0.5) * W, y = (-P.y * 0.5 + 0.5) * H;
      const col = 'rgba(255,106,74,0.95)';
      g.textAlign = 'center';
      g.font = '700 12px "Barlow Condensed", sans-serif';
      if (!on || x < 30 || x > W - 30 || y < 70 || y > H - 50) {
        const dx = on ? x - W / 2 : -(x - W / 2), dy = on ? y - H / 2 : -(y - H / 2);
        const a = Math.atan2(dy, dx);
        x = W / 2 + Math.cos(a) * (W / 2 - 56);
        y = H / 2 + Math.sin(a) * (H / 2 - 56);
        g.save();
        g.translate(x, y);
        g.rotate(a);
        g.fillStyle = col;
        g.beginPath();
        g.moveTo(18, 0);
        g.lineTo(-8, -12);
        g.lineTo(-3, 0);
        g.lineTo(-8, 12);
        g.closePath();
        g.fill();
        g.restore();
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.fillText(cm.text, x + 1, y + 29);
        g.fillStyle = col;
        g.fillText(cm.text, x, y + 28);
      } else {
        const r = 11 + (cm.contact ? Math.sin(this.time * 6) * 2 : 0);
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, r, 0, Math.PI * 2);
        g.moveTo(x - r - 6, y);
        g.lineTo(x - r + 3, y);
        g.moveTo(x + r - 3, y);
        g.lineTo(x + r + 6, y);
        g.moveTo(x, y - r - 6);
        g.lineTo(x, y - r + 3);
        g.stroke();
        g.fillStyle = 'rgba(0,0,0,0.6)';
        g.fillText(cm.text, x + 1, y - r - 9);
        g.fillStyle = col;
        g.fillText(cm.text, x, y - r - 10);
      }
      this.drawnLabels.push(`combat: ${cm.text}`);
    }
    // Where the force under the cursor comes from.
    if (hover) {
      g.font = '600 12px "Barlow", sans-serif';
      const w = g.measureText(hover.text).width + 16;
      const x = Math.min(W - w - 8, hover.x + 14), y = Math.min(H - 30, hover.y + 12);
      g.fillStyle = 'rgba(6,10,16,0.88)';
      g.fillRect(x, y, w, 22);
      g.strokeStyle = 'rgba(132,196,255,0.35)';
      g.strokeRect(x + 0.5, y + 0.5, w - 1, 21);
      g.fillStyle = '#e8f2ff';
      g.textAlign = 'left';
      g.fillText(hover.text, x + 8, y + 15);
    }
  }
}

/** Seconds an alert row stays on the command HUD's strip. */
const ALERT_S = 12;

function rankOf(l: CivilLabel): number {
  return l.kind === 'border' ? -2 : l.kind === 'force' ? -1 : l.kind === 'capital' ? 0 : l.kind === 'city' ? 1 : l.kind === 'base' ? 2 : 3;
}

function bold(s: string): string {
  return esc(s).replace(/(^|· )([^·]+?)(?= [a-záéíóúñ])/giu, (m, a: string, b: string) => (b.length <= 14 ? `${a}<b>${b}</b>` : m));
}
