// FRONT ULTRA — DOM user interface (owner: ui). Entry point: createUi(ctx): UiApi.
// Screens: cinematic loading → main menu over the live Earth → skirmish setup → spawn overlay → in-game HUD
// (top bar, attack ratio, build bar, selection, leaderboard, minimap, ticker, toasts, radial diplomacy, time
// controls, nuke alarm, tutorial) → end screen (stats, territory chart, timelapse). All strings via i18n.

import './fonts';
import './styles.css';
import './css/loading.css';
import './css/menu.css';
import './css/hud.css';
import './css/end.css';
import { h, leave, setText } from './dom';
import { createEndScreen, type EndScreen } from './end';
import { fontsReady } from './fonts';
import { createHud, type Hud } from './hud';
import { en } from './i18n/en';
import { es } from './i18n/es';
import { createLoadingScreen } from './loading';
import { createMainMenu, createSetup } from './menu';
import { createOcclusionTracker } from './occlusion';
import { closeAllModals, initModals } from './modal';
import { retranslate } from './tx';
import type { AppState, FrameInfo, GameContext, LoadingHandle, UiApi } from '../shared/api';
import type { UiSoundKind } from '../shared/events';
import { registerDictionary } from '../shared/i18n';
import { enW1, esW1 } from './i18n/w1';
import type { GameOverReason } from '../shared/types';

/** The HUD instance of the running UI (shots stage panels through it). */
let activeHud: Hud | null = null;
export function getHud(): Hud | null {
  return activeHud;
}

export function createUi(ctx: GameContext): UiApi {
  registerDictionary('es', es);
  registerDictionary('en', en);
  registerDictionary('es', esW1);
  registerDictionary('en', enW1);
  const root = ctx.uiRoot;
  const sound = (kind: UiSoundKind) => ctx.bus.emit('uiSound', { kind });
  initModals(root, (k) => sound(k));

  const screens = h('div', { class: 'fu-layer fu-screens' });
  const hud = createHud(ctx, sound);
  activeHud = hud;
  const fps = h('div', { class: 'fu-fps fu-mono fu-hidden' });
  // Screens first in DOM order (keyboard/tab order and automation start with the active screen).
  root.append(screens, hud.el, fps);

  const occlusion = createOcclusionTracker(root);
  let state: AppState = 'boot';
  let screen: HTMLElement | null = null;
  let end: EndScreen | null = null;
  let endReason: GameOverReason | null = null;

  function swapScreen(next: HTMLElement | null): void {
    if (screen) {
      const old = screen;
      old.classList.add('fu-screen-out');
      leave(old, 420);
    }
    screen = next;
    if (next) screens.append(next);
  }

  function renderState(next: AppState): void {
    if (end && next !== 'ended') {
      end.destroy();
      end = null;
    }
    switch (next) {
      case 'menu':
        swapScreen(createMainMenu(ctx, sound));
        break;
      case 'setup':
        swapScreen(createSetup(ctx, sound));
        break;
      case 'ended':
        closeAllModals();
        swapScreen(null);
        end = createEndScreen(ctx, sound, endReason);
        screens.append(end.el);
        sound('whoosh');
        break;
      default:
        swapScreen(null);
        break;
    }
    hud.setState(next);
  }

  ctx.bus.on('gameEnded', (e) => (endReason = e.reason));
  ctx.bus.on('gameStarted', () => (endReason = null));
  ctx.bus.on('languageChanged', () => {
    retranslate(root);
    // Screens with composed (non-keyed) strings are rebuilt in place.
    if (state === 'menu' || state === 'setup') renderState(state);
  });
  const applyFps = () => fps.classList.toggle('fu-hidden', !ctx.settings.get().showFps);
  ctx.bus.on('settingsChanged', applyFps);
  applyFps();
  let fpsAcc = 0;

  return {
    async init(progress) {
      await fontsReady(1200);
      progress(1);
    },
    showLoading(): LoadingHandle {
      return createLoadingScreen(root);
    },
    getOccludedRects() {
      return occlusion.rects();
    },
    setState(next: AppState) {
      state = next;
      occlusion.invalidate();
      document.body.dataset.state = next;
      renderState(next);
    },
    onGameStart() {
      hud.onGameStart();
    },
    onGameEnd() {
      hud.onGameEnd();
    },
    update(frame: FrameInfo) {
      hud.update(frame);
      if (!fps.classList.contains('fu-hidden')) {
        fpsAcc += frame.dt;
        if (fpsAcc > 0.5) {
          fpsAcc = 0;
          setText(fps, `${window.__fps ?? 0} FPS · ${ctx.sim.view.tickMs.toFixed(1)} ms/tick`);
        }
      }
    },
  };
}
