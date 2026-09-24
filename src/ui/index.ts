// FRONT ULTRA — DOM user interface (owner: ui).
// STUB by the architect: loading screen with progress, menu (play + language), skirmish setup form,
// spawn hint, a minimal HUD (troops/gold/territory, speed, attack ratio), world-click handling
// (spawn / attack / build hotkeys) and an end screen. The ui owner replaces it with the full sleek
// military HUD (build bar, selection panel, leaderboard, minimap, news ticker, toasts, radial diplomacy,
// settings, tutorial, end stats + graph + timelapse). Keep the export: createUi(ctx): UiApi.

import './styles.css';
import { en } from './i18n/en';
import { es } from './i18n/es';
import type { AppState, FrameInfo, GameContext, LoadingHandle, UiApi } from '../shared/api';
import { hexToCss, cssToHex } from '../shared/color';
import { HUMAN_ID, STRUCTURE_DEFS } from '../shared/constants';
import { formatCompact, registerDictionary, t } from '../shared/i18n';
import { DIFFICULTIES, STRUCTURE_TYPES, UnitType, type Difficulty, type GameSpeed } from '../shared/types';

type Attrs = Record<string, string | ((e: Event) => void)>;
function h(tag: string, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) el.append(c);
  return el;
}

export function createUi(ctx: GameContext): UiApi {
  registerDictionary('es', es);
  registerDictionary('en', en);
  const root = ctx.uiRoot;
  const layer = h('div', { class: 'fu-layer' });
  root.appendChild(layer);
  let state: AppState = 'boot';
  let attackRatio = 0.3;
  let hoverTile = -1;
  let hudRefs: { troops: HTMLElement; gold: HTMLElement; tiles: HTMLElement; income: HTMLElement; paused: HTMLElement } | null = null;
  let hudTimer = 0;

  const sound = (kind: 'click' | 'hover' | 'confirm' | 'error') => ctx.bus.emit('uiSound', { kind });
  const button = (label: string, onClick: () => void) =>
    h('button', { class: 'fu-btn', onclick: () => { sound('click'); onClick(); }, onmouseenter: () => sound('hover') }, label);

  function render(): void {
    layer.replaceChildren();
    hudRefs = null;
    switch (state) {
      case 'menu': {
        const langBtn = button(`${t('menu.language')}: ${ctx.settings.get().language.toUpperCase()}`, () => {
          ctx.settings.set({ language: ctx.settings.get().language === 'es' ? 'en' : 'es' });
        });
        layer.append(h('div', { class: 'fu-screen' },
          h('div', { class: 'fu-title' }, t('app.title')),
          h('div', { class: 'fu-sub' }, t('app.tagline')),
          h('div', { style: 'height:40px' }),
          button(t('menu.play'), () => ctx.app.goto('setup')),
          langBtn,
        ));
        break;
      }
      case 'setup': {
        const s = ctx.settings.get().setup;
        const name = h('input', { value: s.playerName, maxlength: '24' }) as HTMLInputElement;
        const color = h('input', { type: 'color', value: hexToCss(s.playerColor) }) as HTMLInputElement;
        const diff = h('select', {}, ...DIFFICULTIES.map((d) => h('option', { value: d }, t(`difficulty.${d}`)))) as HTMLSelectElement;
        diff.value = s.difficulty;
        const ai = h('input', { type: 'number', min: '4', max: '64', value: String(s.aiCount) }) as HTMLInputElement;
        const speed = h('select', {}, ...['1', '2', '4'].map((v) => h('option', { value: v }, `${v}x`))) as HTMLSelectElement;
        speed.value = String(s.speed);
        layer.append(h('div', { class: 'fu-screen' },
          h('div', { class: 'fu-title', style: 'font-size:40px' }, t('setup.title')),
          h('div', { class: 'fu-panel fu-interactive' },
            h('div', { class: 'fu-row' }, t('setup.name'), name),
            h('div', { class: 'fu-row' }, t('setup.color'), color),
            h('div', { class: 'fu-row' }, t('setup.difficulty'), diff),
            h('div', { class: 'fu-row' }, t('setup.aiCount'), ai),
            h('div', { class: 'fu-row' }, t('setup.speed'), speed),
          ),
          button(t('setup.start'), () => {
            const setup = {
              ...s,
              playerName: name.value.trim() || s.playerName,
              playerColor: cssToHex(color.value),
              difficulty: diff.value as Difficulty,
              aiCount: Math.max(4, Math.min(64, Number(ai.value) || s.aiCount)),
              speed: Number(speed.value) as GameSpeed,
            };
            ctx.settings.set({ setup });
            void ctx.app.startGame(ctx.app.makeConfig());
          }),
          button(t('setup.back'), () => ctx.app.goto('menu')),
        ));
        break;
      }
      case 'spawn':
        layer.append(h('div', { class: 'fu-panel fu-banner' }, t('spawn.hint')));
        break;
      case 'playing': {
        const stat = (k: string) => {
          const v = h('div', { class: 'v fu-mono' }, '0');
          return { el: h('div', { class: 'fu-stat' }, h('div', { class: 'k' }, t(k)), v), v };
        };
        const troops = stat('hud.troops'), gold = stat('hud.gold'), tiles = stat('hud.territory'), income = stat('hud.income');
        const paused = h('div', { class: 'fu-panel fu-banner', style: 'display:none' }, t('hud.paused'));
        const ratio = h('input', { type: 'range', min: '5', max: '100', value: String(Math.round(attackRatio * 100)) }) as HTMLInputElement;
        ratio.addEventListener('input', () => (attackRatio = Number(ratio.value) / 100));
        const speedBtns = ([0, 1, 2, 4] as GameSpeed[]).map((sp) => button(sp === 0 ? '||' : `${sp}x`, () => ctx.app.setSpeed(sp)));
        for (const b of speedBtns) b.style.minWidth = '56px';
        layer.append(
          h('div', { class: 'fu-panel fu-topbar' }, troops.el, gold.el, tiles.el, income.el),
          paused,
          h('div', { class: 'fu-bottom fu-panel fu-interactive' }, t('hud.attackRatio'), ratio, ...speedBtns),
        );
        hudRefs = { troops: troops.v, gold: gold.v, tiles: tiles.v, income: income.v, paused };
        break;
      }
      case 'ended': {
        const view = ctx.sim.view;
        const won = view.winner === HUMAN_ID;
        layer.append(h('div', { class: 'fu-screen fu-interactive', style: 'background:rgba(0,0,0,.55)' },
          h('div', { class: 'fu-title' }, t(won ? 'end.victory' : 'end.defeat')),
          button(t('end.backToMenu'), () => ctx.app.returnToMenu()),
        ));
        break;
      }
      default:
        break;
    }
  }

  // ---- world interaction ---------------------------------------------------------------------------
  ctx.bus.on('worldHover', (e) => (hoverTile = e.tile));
  ctx.bus.on('worldClick', (e) => {
    if (e.tile < 0) return;
    const view = ctx.sim.view;
    if (state === 'spawn' && e.button === 0) {
      ctx.sim.send({ type: 'spawn', tile: e.tile });
      return;
    }
    if (state !== 'playing' || e.button !== 0) return;
    const owner = view.owner[e.tile];
    if (owner === HUMAN_ID) return;
    ctx.sim.send({ type: 'attack', target: owner, ratio: attackRatio, tile: e.tile });
  });
  ctx.bus.on('message', (e) => {
    if (e.playerId === HUMAN_ID) sound('error');
  });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.tagName === 'INPUT' || state !== 'playing') return;
    if (e.code === 'Space') {
      e.preventDefault();
      ctx.app.togglePause();
      return;
    }
    const st = STRUCTURE_TYPES.find((s) => STRUCTURE_DEFS[s].hotkey === e.key);
    if (st !== undefined && hoverTile >= 0) {
      ctx.sim.send({ type: 'build', structure: st, tile: hoverTile });
      ctx.bus.emit('uiSound', { kind: 'build' });
    }
    if (e.key.toLowerCase() === 'z' && hoverTile >= 0) ctx.sim.send({ type: 'launch', weapon: UnitType.AtomBomb, targetTile: hoverTile, siloId: -1 });
  });
  ctx.bus.on('languageChanged', () => render());

  return {
    async init(progress) {
      progress(1);
    },
    showLoading(): LoadingHandle {
      const bar = h('div');
      const label = h('div', { class: 'fu-sub' }, '');
      const press = h('div', { class: 'fu-press', style: 'visibility:hidden' }, t('loading.pressAnyKey'));
      const screen = h('div', { class: 'fu-screen fu-loading' },
        h('div', { class: 'fu-title' }, t('app.title')),
        h('div', { class: 'fu-progress' }, bar),
        label,
        press,
      );
      root.appendChild(screen);
      return {
        setProgress(f, l) {
          bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
          if (l) label.textContent = t(l);
        },
        complete(requireInput) {
          bar.style.width = '100%';
          label.textContent = t('loading.ready');
          const finish = () =>
            new Promise<void>((resolve) => {
              screen.style.opacity = '0';
              setTimeout(() => {
                screen.remove();
                resolve();
              }, 600);
            });
          if (!requireInput) return finish();
          press.style.visibility = 'visible';
          return new Promise<void>((resolve) => {
            const go = () => {
              window.removeEventListener('keydown', go);
              window.removeEventListener('pointerdown', go);
              void finish().then(resolve);
            };
            window.addEventListener('keydown', go);
            window.addEventListener('pointerdown', go);
          });
        },
      };
    },
    setState(next) {
      state = next;
      render();
    },
    update(frame: FrameInfo) {
      if (!hudRefs) return;
      hudTimer += frame.dt;
      if (hudTimer < 0.1) return;
      hudTimer = 0;
      const p = ctx.sim.view.human;
      if (!p) return;
      hudRefs.troops.textContent = `${formatCompact(p.troops)} / ${formatCompact(p.maxTroops)}`;
      hudRefs.gold.textContent = formatCompact(p.gold);
      hudRefs.tiles.textContent = formatCompact(p.tiles);
      hudRefs.income.textContent = `+${formatCompact(p.income)}/s`;
      hudRefs.paused.style.display = ctx.sim.view.speed === 0 ? 'block' : 'none';
    },
  };
}
