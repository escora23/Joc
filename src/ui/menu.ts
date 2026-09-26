// FRONT ULTRA — main menu and skirmish setup screens (owner: ui). Both sit over the live, slowly rotating Earth.

import { segmented, slider, toggleSwitch } from './controls';
import { loadSave, openCredits, openHelp, openLoadDialog, openSettings } from './dialogs';
import { latestSave } from '../app/autosave';
import { tip } from './tooltip';
import { h, setText, toggleClass } from './dom';
import { flag } from './flag';
import { icon } from './icons';
import { createLogo } from './logo';
import { tx } from './tx';
import { NATION_COLORS, nearestPaletteIndex } from '../data';
import type { GameContext } from '../shared/api';
import { hexToCss } from '../shared/color';
import type { UiSoundKind } from '../shared/events';
import { formatNumber, getLanguage, t } from '../shared/i18n';
import { DIFFICULTIES, type Difficulty, type GameDuration, type GameSpeed } from '../shared/types';

type Sound = (k: UiSoundKind) => void;

// -------------------------------------------------------------------------------------------------
// Main menu
// -------------------------------------------------------------------------------------------------
export function createMainMenu(ctx: GameContext, sound: Sound): HTMLElement {
  const item = (n: string, key: string, hintKey: string, onClick: () => void, primary = false) => {
    const b = h('button', { class: `fu-menu-item${primary ? ' is-primary' : ''}` },
      h('span', { class: 'fu-menu-n fu-mono' }, n),
      h('span', { class: 'fu-menu-label' }, tx(key), tx(hintKey, undefined, 'small')),
      h('span', { class: 'fu-menu-arrow' }, icon('chevronRight')),
    );
    b.addEventListener('mouseenter', () => sound('hover'));
    b.addEventListener('click', () => {
      sound(primary ? 'confirm' : 'click');
      onClick();
    });
    return b;
  };
  // v2 (W3, §12.8): «Continuar» resumes the latest save (autosave or a slot), «Cargar» lists them all.
  const cont = item('00', 'menu.continue', 'menu.continue.hint', () => {
    void latestSave().then((r) => {
      if (r) loadSave(ctx, r.blob);
    });
  }, true);
  cont.classList.add('fu-hidden', 'fu-menu-continue');
  const loadItem = item('05', 'menu.load', 'menu.load.hint', () => openLoadDialog(ctx, sound));
  loadItem.classList.add('fu-hidden');
  tip(cont, () => ({ title: t('menu.continue'), text: t('menu.continue.tip') }));
  tip(loadItem, () => ({ title: t('menu.load'), text: t('menu.load.tip') }));
  void latestSave().then((r) => {
    if (!r) return;
    const hint = cont.querySelector('small');
    if (hint) {
      const date = new Date(r.savedAt).toLocaleString(getLanguage() === 'es' ? 'es-ES' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
      hint.removeAttribute('data-i18n');
      hint.textContent = t('menu.continue.info', { nation: r.nation || '—', day: formatNumber(r.day), date });
    }
    cont.classList.remove('fu-hidden');
    loadItem.classList.remove('fu-hidden');
  });
  const play = item('01', 'menu.play', 'menu.play.hint', () => ctx.app.goto('setup'), true);
  const nav = h('nav', { class: 'fu-menu-nav' },
    cont,
    play,
    loadItem,
    item('02', 'menu.howto', 'menu.howto.hint', () => openHelp(ctx, sound)),
    item('03', 'menu.settings', 'menu.settings.hint', () => openSettings(ctx, sound)),
    item('04', 'menu.credits', 'menu.credits.hint', () => openCredits()),
  );

  const lang = segmented<'es' | 'en'>(
    [{ value: 'es', label: 'ES' }, { value: 'en', label: 'EN' }],
    getLanguage(),
    (l) => ctx.settings.set({ language: l }),
    sound as (k: 'click' | 'hover' | 'toggle' | 'slider') => void,
  );
  lang.el.classList.add('fu-lang');
  ctx.bus.on('languageChanged', (e) => lang.set(e.lang));

  // Live "world intel" card: real numbers from the loaded world.
  const w = ctx.world;
  const nations = w ? w.countries.filter((c) => c.index > 0 && c.tiles > 0).length : 0;
  const intel = h('div', { class: 'fu-menu-intel fu-glass fu-brackets' },
    h('div', { class: 'fu-panel-title' }, icon('globe'), tx('menu.intel')),
    h('div', { class: 'fu-intel-grid' },
      h('div', null, h('b', { class: 'fu-mono' }, formatNumber(nations)), tx('menu.intel.nations', undefined, 'small')),
      h('div', null, h('b', { class: 'fu-mono' }, formatNumber(w?.landTiles ?? 0)), tx('menu.intel.tiles', undefined, 'small')),
      h('div', null, h('b', { class: 'fu-mono' }, '80%'), tx('menu.intel.win', undefined, 'small')),
    ),
    h('div', { class: 'fu-intel-status' }, h('i'), tx('menu.intel.status')),
  );

  return h('div', { class: 'fu-menu' },
    h('div', { class: 'fu-menu-shade' }),
    h('div', { class: 'fu-menu-col' },
      createLogo({ size: 'menu' }),
      nav,
    ),
    intel,
    h('footer', { class: 'fu-menu-foot' },
      h('span', { class: 'fu-caps' }, 'v1.0.0'),
      h('span', { class: 'fu-menu-foot-sep' }),
      tx('menu.footer', undefined, 'span'),
      h('span', { style: 'flex:1' }),
      h('span', { class: 'fu-caps' }, tx('settings.language')),
      lang.el,
    ),
  );
}

// -------------------------------------------------------------------------------------------------
// Skirmish setup
// -------------------------------------------------------------------------------------------------
const NAME_POOL_ES = ['República del Alba', 'Mando Boreal', 'Liga del Acero', 'Unión Meridiana', 'Imperio Austral', 'Pacto de Hierro', 'Frente Ultra', 'Dominio Carmesí', 'Coalición Atlántica', 'Estado Libre de Nova'];
const NAME_POOL_EN = ['Dawn Republic', 'Boreal Command', 'Steel League', 'Meridian Union', 'Austral Empire', 'Iron Pact', 'Ultra Front', 'Crimson Dominion', 'Atlantic Coalition', 'Free State of Nova'];

const DIFF_SKULLS: Record<Difficulty, number> = { easy: 1, normal: 2, hard: 3, insane: 4 };

export function createSetup(ctx: GameContext, sound: Sound): HTMLElement {
  const s = { ...ctx.settings.get().setup };
  // Snap custom/legacy colors to the curated palette so a swatch is always selected.
  if (!NATION_COLORS.some((c) => c.hex === s.playerColor)) s.playerColor = NATION_COLORS[nearestPaletteIndex(s.playerColor)].hex;
  const snd = sound as (k: 'click' | 'hover' | 'toggle' | 'slider') => void;
  const save = () => ctx.settings.set({ setup: { ...s } });

  // --- preview card
  const pvFlag = h('div', { class: 'fu-setup-flag' });
  const pvName = h('div', { class: 'fu-setup-pvname' });
  const pvSummary = h('div', { class: 'fu-setup-pvsum fu-mono' });
  const pvColorName = h('span', { class: 'fu-setup-colorname' });
  const refreshPreview = () => {
    pvFlag.replaceChildren(flag(s.playerColor, 0));
    setText(pvName, s.playerName || t('setup.namePlaceholder'));
    const c = NATION_COLORS.find((x) => x.hex === s.playerColor);
    setText(pvColorName, c ? (getLanguage() === 'es' ? c.es : c.en) : hexToCss(s.playerColor).toUpperCase());
    setText(pvSummary, `${t(`difficulty.${s.difficulty}`).toUpperCase()} · ${t('setup.aiShort', { n: s.aiCount })} · ${s.tribeCount} ${t('setup.tribesShort')} · ${s.speed === 0.5 ? t('hud.speed.half') : `${s.speed}×`} · ${t(`setup.duration.${s.duration ?? 'normal'}`)}`);
    card.style.setProperty('--nation', hexToCss(s.playerColor));
  };

  // --- name
  const name = h('input', { class: 'fu-input', maxlength: 24, value: s.playerName, spellcheck: 'false', 'data-i18n-ph': 'setup.namePlaceholder', placeholder: t('setup.namePlaceholder') }) as HTMLInputElement;
  name.addEventListener('input', () => {
    s.playerName = name.value.trim().slice(0, 24);
    refreshPreview();
  });
  name.addEventListener('change', save);
  const dice = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--icon', 'data-i18n-title': 'setup.randomName', title: t('setup.randomName') }, icon('restart'));
  let nameIdx = Math.floor(Math.random() * NAME_POOL_ES.length);
  dice.addEventListener('click', () => {
    sound('click');
    nameIdx = (nameIdx + 1) % NAME_POOL_ES.length;
    s.playerName = (getLanguage() === 'es' ? NAME_POOL_ES : NAME_POOL_EN)[nameIdx];
    name.value = s.playerName;
    refreshPreview();
    save();
  });

  // --- colors
  const swatches = h('div', { class: 'fu-swatches' });
  const swEls: HTMLElement[] = [];
  for (const c of NATION_COLORS) {
    const b = h('button', { class: 'fu-swatch', style: `--c:${hexToCss(c.hex)}`, title: getLanguage() === 'es' ? c.es : c.en });
    b.addEventListener('click', () => {
      sound('click');
      s.playerColor = c.hex;
      swEls.forEach((x) => toggleClass(x, 'is-on', x === b));
      refreshPreview();
      save();
    });
    b.addEventListener('mouseenter', () => sound('hover'));
    if (c.hex === s.playerColor) b.classList.add('is-on');
    swEls.push(b);
    swatches.append(b);
  }

  // --- difficulty cards
  const diffWrap = h('div', { class: 'fu-diff' });
  const diffEls: HTMLElement[] = [];
  for (const d of DIFFICULTIES) {
    const pips = h('span', { class: 'fu-diff-pips' });
    for (let i = 0; i < 4; i++) pips.append(h('i', { class: i < DIFF_SKULLS[d] ? 'is-on' : '' }));
    const b = h('button', { class: `fu-diff-card fu-diff--${d}` }, pips, h('b', null, tx(`difficulty.${d}`)), tx(`difficulty.${d}.desc`, undefined, 'small'));
    b.addEventListener('click', () => {
      sound('click');
      s.difficulty = d;
      diffEls.forEach((x) => toggleClass(x, 'is-on', x === b));
      refreshPreview();
      save();
    });
    b.addEventListener('mouseenter', () => sound('hover'));
    if (d === s.difficulty) b.classList.add('is-on');
    diffEls.push(b);
    diffWrap.append(b);
  }

  // --- numbers
  const ai = slider({ min: 4, max: 64, step: 1, value: s.aiCount, format: (v) => String(v), sound: snd, onInput: (v) => { s.aiCount = v; refreshPreview(); } });
  ai.input.addEventListener('change', save);
  const tribes = slider({ min: 0, max: 120, step: 5, value: s.tribeCount, format: (v) => String(v), sound: snd, amber: true, onInput: (v) => { s.tribeCount = v; refreshPreview(); } });
  tribes.input.addEventListener('change', save);
  const speed = segmented<GameSpeed>(
    ([0.5, 1, 2, 4] as GameSpeed[]).map((v) => ({ value: v, label: v === 0.5 ? t('hud.speed.half') : `${v}×` })),
    s.speed,
    (v) => { s.speed = v; refreshPreview(); save(); },
    snd,
  );
  // v2 (W1): «Duración» (§4.18): victory thresholds and the time limit.
  if (!s.duration) s.duration = 'normal';
  const duration = segmented<GameDuration>(
    (['short', 'normal', 'long'] as GameDuration[]).map((v) => ({ value: v, labelKey: `setup.duration.${v}`, title: t(`setup.duration.tip.${v}`) })),
    s.duration,
    (v) => { s.duration = v; refreshPreview(); save(); },
    snd,
  );
  const nukes = toggleSwitch(s.nukes, (v) => { s.nukes = v; save(); }, snd);
  const events = toggleSwitch(s.worldEvents, (v) => { s.worldEvents = v; save(); }, snd);

  // --- actions
  const back = h('button', { class: 'fu-btn fu-btn--ghost' }, icon('chevronLeft'), tx('setup.back'));
  back.addEventListener('click', () => {
    sound('cancel');
    save();
    ctx.app.goto('menu');
  });
  const start = h('button', { class: 'fu-btn fu-btn--primary fu-setup-start' }, tx('setup.start'), icon('chevronRight'));
  let starting = false;
  start.addEventListener('click', () => {
    if (starting) return;
    starting = true;
    sound('confirm');
    if (!s.playerName) s.playerName = t('setup.namePlaceholder');
    save();
    start.classList.add('is-busy');
    ctx.app.startGame(ctx.app.makeConfig()).catch((err) => {
      console.error('[ui] startGame failed', err);
      starting = false;
      start.classList.remove('is-busy');
    });
  });
  start.addEventListener('mouseenter', () => sound('hover'));

  const field = (labelKey: string, ...ctl: HTMLElement[]) => h('div', { class: 'fu-field' }, h('div', { class: 'fu-panel-title' }, tx(labelKey)), ...ctl);
  const card = h('div', { class: 'fu-setup-card fu-glass' },
    pvFlag,
    h('div', { class: 'fu-setup-pvtext' }, tx('setup.yourNation', undefined, 'small'), pvName, pvSummary),
  );

  const panel = h('div', { class: 'fu-setup fu-glass fu-brackets fu-interactive' },
    h('header', { class: 'fu-setup-head' },
      h('div', null, tx('setup.kicker', undefined, 'div'), h('h1', null, tx('setup.title'))),
      card,
    ),
    h('div', { class: 'fu-setup-cols' },
      h('div', { class: 'fu-setup-col' },
        field('setup.name', h('div', { class: 'fu-name-row' }, name, dice)),
        field('setup.color', swatches, h('div', { class: 'fu-setup-colorrow' }, h('span', { class: 'fu-caps' }, tx('setup.selected')), pvColorName)),
        field('setup.difficulty', diffWrap),
      ),
      h('div', { class: 'fu-setup-col' },
        field('setup.aiCount', ai.el, tx('setup.aiCount.hint', undefined, 'small')),
        field('setup.tribes', tribes.el, tx('setup.tribes.hint', undefined, 'small')),
        field('setup.speed', speed.el),
        field('setup.duration', duration.el),
        field('setup.rules',
          h('div', { class: 'fu-toggle-row' }, icon('radiation'), h('span', null, tx('setup.nukes'), tx('setup.nukes.hint', undefined, 'small')), nukes.el),
          h('div', { class: 'fu-toggle-row' }, icon('hurricane'), h('span', null, tx('setup.events'), tx('setup.events.hint', undefined, 'small')), events.el),
        ),
      ),
    ),
  );
  // START is the first control in DOM order (Enter/automation), but laid out at the bottom right via CSS order.
  panel.prepend(h('footer', { class: 'fu-setup-foot' }, start, back, h('span', { class: 'fu-setup-spacer' }), tx('setup.startHint', undefined, 'small')));
  refreshPreview();
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && document.activeElement !== dice) start.click();
  };
  panel.addEventListener('keydown', onKey);
  return h('div', { class: 'fu-setup-screen' }, h('div', { class: 'fu-menu-shade fu-menu-shade--setup' }), panel);
}
