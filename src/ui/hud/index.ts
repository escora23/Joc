// FRONT ULTRA — in-game HUD assembly (owner: ui). Creates every widget once, lays them out, drives their
// refresh cadence (text 10 Hz, leaderboard/minimap 4 Hz, cursor per frame) and shows the right subset for
// the app state (spawn, playing, command).

import { openHelp, openPauseMenu, openSettings } from '../dialogs';
import { h, toggleClass } from '../dom';
import { closeAllModals, modalOpen, type ModalHandle } from '../modal';
import { createBuildBar } from './buildbar';
import { wireController } from './controller';
import { createCursorLayer } from './cursor';
import { createAlertCenter } from './alerts';
import { createCrisis } from './crisis';
import { createTicker } from './feed';
import { createNations } from './nations';
import { createLeaderboard } from './leaderboard';
import { createMinimap } from './minimap';
import { wireNews } from './news';
import { createRadial } from './radial';
import { createSelectionPanel } from './selection';
import { HudShared } from './shared';
import { createSpawnOverlay } from './spawn';
import { createTopBar } from './topbar';
import { createTutorial } from './tutorial';
import type { AppState, FrameInfo, GameContext } from '../../shared/api';
import type { UiSoundKind } from '../../shared/events';
import { t } from '../../shared/i18n';
import type { GameSpeed } from '../../shared/types';

export interface Hud {
  el: HTMLElement;
  shared: HudShared;
  setState(state: AppState): void;
  onGameStart(): void;
  onGameEnd(): void;
  update(frame: FrameInfo): void;
  /** Shots/tests: expose widgets for staging. */
  debug: {
    openRadial(x: number, y: number, tile: number): void;
    showTutorial(step?: string): void;
    pushNews(text: string, severity: 'info' | 'warning' | 'critical'): void;
  };
}

export function createHud(ctx: GameContext, sound: (k: UiSoundKind) => void): Hud {
  const hs = new HudShared(ctx, sound);
  let pauseMenu: ModalHandle | null = null;
  let resumeSpeed: GameSpeed = 1;

  const openPause = () => {
    if (pauseMenu) {
      pauseMenu.close();
      return;
    }
    const view = ctx.sim.view;
    resumeSpeed = view.speed === 0 ? 0 : view.speed;
    if (view.speed !== 0) ctx.app.setSpeed(0);
    pauseMenu = openPauseMenu(ctx, sound, () => {
      pauseMenu = null;
      if (resumeSpeed !== 0 && ctx.sim.running && (ctx.app.state === 'playing' || ctx.app.state === 'spawn')) ctx.app.setSpeed(resumeSpeed);
    });
  };

  const alerts = createAlertCenter(hs);
  const nations = createNations(hs, alerts);
  hs.openNations = (id) => nations.open(id);
  hs.openInbox = (pid) => nations.openInbox(pid);
  const top = createTopBar(hs, {
    pause: openPause,
    settings: () => openSettings(ctx, sound),
    help: () => openHelp(ctx, sound),
    nations: () => nations.toggle(),
    log: () => alerts.openLog(),
    pending: () => nations.pendingCount(),
  });
  const lb = createLeaderboard(hs);
  const mm = createMinimap(hs);
  const bb = createBuildBar(hs);
  const sel = createSelectionPanel(hs);
  const ticker = createTicker(hs);
  const crisis = createCrisis(hs, alerts);
  const radial = createRadial(hs);
  const cursor = createCursorLayer(hs);
  const spawn = createSpawnOverlay(hs);
  const tut = createTutorial(hs);
  const ripples = h('div', { class: 'fu-ripples' });
  const modeBanner = h('div', { class: 'fu-modebar fu-hidden' });

  wireNews(hs, ticker, alerts);
  alerts.onPing = (lat, lon, sev) => mm.ping(lat, lon, sev);
  ctx.bus.on('languageChanged', () => {
    tut.relabel();
    sel.invalidate();
    spawn.invalidate();
    hs.emit('mode');
  });
  wireController(hs, {
    openRadial: (x, y, tile) => radial.openAt(x, y, tile),
    closeRadial: () => radial.close(),
    radialOpen: () => radial.open,
    togglePauseMenu: openPause,
    toggleLeaderboard: () => lb.toggle(),
    toggleMinimap: () => mm.toggle(),
    openHelp: () => openHelp(ctx, sound),
    toggleNations: () => nations.toggle(),
    openLog: () => alerts.openLog(),
    closeNations: () => {
      if (!nations.isOpen) return false;
      nations.close();
      return true;
    },
    takeControl: () => sel.takeControl(),
    setBuildTab: (tb) => bb.setTab(tb),
    ripple: (x, y, kind) => {
      if (x < 0) return;
      const r = h('div', { class: `fu-ripple is-${kind}`, style: `left:${x}px;top:${y}px` }, h('i'), h('i'));
      ripples.append(r);
      window.setTimeout(() => r.remove(), 900);
    },
    modalOpen,
  });

  // Mode banner (what a click will do right now), shown above the build bar.
  hs.on('mode', () => {
    const m = hs.mode;
    toggleClass(modeBanner, 'fu-hidden', m.kind === 'none');
    if (m.kind === 'none') return;
    const esc = '<span class="fu-kbd">Esc</span>';
    const shift = '<span class="fu-kbd">⇧</span>';
    const key = m.kind === 'build' ? 'mode.build' : m.kind === 'target' ? 'mode.target' : 'mode.order';
    modeBanner.innerHTML = '';
    modeBanner.append(
      h('b', null, t(key)),
      h('span', { html: `${shift} ${t('mode.repeat')} · ${esc} ${t('mode.cancel')}` }),
    );
  });

  const layout = h('div', { class: 'fu-hud' },
    h('div', { class: 'fu-hud-top' }, top.el),
    h('div', { class: 'fu-hud-under' }, ticker.el, crisis.el, alerts.bannerEl),
    h('div', { class: 'fu-hud-tr' }, top.time, lb.el),
    h('div', { class: 'fu-hud-tl' }, alerts.feedEl),
    h('div', { class: 'fu-hud-left' }, tut.el),
    h('div', { class: 'fu-hud-bl' }, mm.el),
    h('div', { class: 'fu-hud-bottom' }, modeBanner, h('div', { class: 'fu-hud-bottom-row' }, bb.ratioEl, bb.el)),
    h('div', { class: 'fu-hud-br' }, sel.el),
    spawn.el,
    crisis.edge,
  );
  const el = h('div', { class: 'fu-hud-root' }, alerts.markersEl, layout, nations.el, cursor.el, ripples, radial.el);

  let state: AppState = 'boot';
  let acc10 = 0, acc4 = 0;

  function setState(s: AppState): void {
    state = s;
    el.dataset.state = s;
    const inGame = s === 'spawn' || s === 'playing' || s === 'command';
    toggleClass(el, 'fu-hidden', !inGame);
    if (s !== 'playing') {
      radial.close();
      if (hs.mode.kind !== 'none') hs.setMode({ kind: 'none' });
    }
    if (s === 'command') {
      closeAllModals();
      hs.flags.commandEntered = true;
    }
    if (s === 'playing') {
      lb.refresh();
      mm.refresh();
      top.refresh();
      bb.refresh();
    }
  }

  return {
    el,
    shared: hs,
    setState,
    onGameStart() {
      hs.attackRatio = 0.5;
      hs.emit('ratio');
      hs.select({ kind: 'none' });
      hs.setMode({ kind: 'none' });
      hs.flags.ratioChanged = false;
      hs.flags.radialOpened = false;
      hs.flags.commandEntered = false;
      mm.reset();
      tut.reset();
      top.rebuildFlag();
    },
    onGameEnd() {
      radial.close();
      hs.select({ kind: 'none' });
      hs.setMode({ kind: 'none' });
      ticker.clear();
      alerts.clear();
      crisis.clear();
      nations.close();
      if (pauseMenu) pauseMenu.close();
      ripples.replaceChildren();
    },
    update(frame) {
      if (state !== 'spawn' && state !== 'playing' && state !== 'command') return;
      const dt = frame.dt;
      acc10 += dt;
      acc4 += dt;
      cursor.update(state === 'spawn' ? 'spawn' : state === 'playing' ? 'playing' : 'other');
      ticker.update(dt);
      tut.tick(dt);
      alerts.update(dt);
      mm.frame();
      if (acc10 >= 0.1) {
        acc10 = 0;
        crisis.update();
        nations.update();
        if (state === 'spawn') spawn.refresh();
        else {
          top.refresh();
          bb.refresh();
          sel.refresh();
        }
      }
      if (acc4 >= 0.25) {
        acc4 = 0;
        mm.refresh();
        if (state !== 'spawn') lb.refresh();
      }
    },
    debug: {
      openRadial: (x, y, tile) => radial.openAt(x, y, tile),
      showTutorial: (step?: string) => tut.force(step),
      pushNews: (text, severity) => ticker.push({ text, severity }),
    },
  };
}
