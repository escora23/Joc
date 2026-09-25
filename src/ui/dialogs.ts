// FRONT ULTRA — modal screens (owner: ui): settings, how to play, credits, keyboard shortcuts, pause menu,
// confirmations. All strings go through i18n; settings are applied through ctx.settings.set().

import { formRow, segmented, slider, toggleSwitch } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { openModal, type ModalHandle } from './modal';
import { tx } from './tx';
import type { GameContext } from '../shared/api';
import type { UiSoundKind } from '../shared/events';
import type { Lang } from '../shared/i18n';
import type { QualityLevel } from '../shared/quality';
import type { CloudMode } from '../shared/settings';
import { mapLegend } from './legend';

type Sound = (k: UiSoundKind) => void;

// -------------------------------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------------------------------
export function openSettings(ctx: GameContext, sound: Sound, onClose?: () => void): ModalHandle {
  const s = ctx.settings.get();
  const snd = sound as (k: 'click' | 'hover' | 'toggle' | 'slider') => void;
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  const quality = segmented<QualityLevel>(
    (['low', 'medium', 'high', 'ultra'] as QualityLevel[]).map((q) => ({ value: q, labelKey: `quality.${q}` })),
    s.quality,
    (q) => {
      ctx.settings.set({ quality: q });
      paintQuality(q);
    },
    snd,
  );
  const lang = segmented<Lang>(
    [{ value: 'es', label: 'Español' }, { value: 'en', label: 'English' }],
    s.language,
    (l) => ctx.settings.set({ language: l }),
    snd,
  );
  const vol = (key: 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'uiVolume') =>
    slider({ min: 0, max: 1, step: 0.01, value: s[key], format: pct, onInput: (v) => ctx.settings.set({ [key]: v }), sound: snd }).el;
  const sens = slider({
    min: 0.2, max: 3, step: 0.05, value: s.mouseSensitivity, format: (v) => `${v.toFixed(2)}×`,
    onInput: (v) => ctx.settings.set({ mouseSensitivity: v }), sound: snd,
  }).el;
  const sw = (key: 'invertY' | 'edgePan' | 'screenShake' | 'showFps' | 'tutorial') =>
    toggleSwitch(s[key], (v) => ctx.settings.set({ [key]: v }), snd).el;

  const qualityHint = h('div', { class: 'fu-quality-cards' });
  const qInfo: [QualityLevel, string][] = [['low', 'quality.low.desc'], ['medium', 'quality.medium.desc'], ['high', 'quality.high.desc'], ['ultra', 'quality.ultra.desc']];
  for (const [q, k] of qInfo) {
    const card = h('div', { class: 'fu-quality-card', 'data-q': q }, h('b', null, tx(`quality.${q}`)), tx(k, undefined, 'small'));
    card.addEventListener('click', () => {
      sound('click');
      quality.set(q);
      ctx.settings.set({ quality: q });
      paintQuality(q);
    });
    qualityHint.append(card);
  }
  function paintQuality(q: QualityLevel): void {
    qualityHint.querySelectorAll<HTMLElement>('.fu-quality-card').forEach((c) => c.classList.toggle('is-on', c.dataset.q === q));
  }
  paintQuality(s.quality);

  const pages: Record<string, HTMLElement> = {
    graphics: h('div', { class: 'fu-form' },
      formRow('settings.quality', quality.el, 'settings.quality.hint'),
      qualityHint,
      // v2 (W2): map readability (DESIGN_V2 §10.5 clouds, §10.3 historical borders).
      formRow('settings.clouds', segmented<CloudMode>(
        (['strategic', 'realistic', 'hidden'] as const).map((v) => ({ value: v, labelKey: `settings.clouds.${v}` })),
        s.clouds ?? 'strategic', (v) => ctx.settings.set({ clouds: v }), snd,
      ).el, 'settings.clouds.tip'),
      formRow('settings.historicalBorders', toggleSwitch(s.historicalBorders ?? false, (v) => ctx.settings.set({ historicalBorders: v }), snd).el, 'settings.historicalBorders.tip'),
      formRow('settings.screenShake', sw('screenShake'), 'settings.screenShake.hint'),
      formRow('settings.showFps', sw('showFps')),
    ),
    audio: h('div', { class: 'fu-form' },
      formRow('settings.master', vol('masterVolume')),
      formRow('settings.music', vol('musicVolume')),
      formRow('settings.sfx', vol('sfxVolume')),
      formRow('settings.uiVolume', vol('uiVolume')),
    ),
    controls: h('div', { class: 'fu-form' },
      formRow('settings.sensitivity', sens, 'settings.sensitivity.hint'),
      formRow('settings.invertY', sw('invertY')),
      formRow('settings.edgePan', sw('edgePan'), 'settings.edgePan.hint'),
    ),
    game: h('div', { class: 'fu-form' },
      formRow('settings.language', lang.el),
      formRow('settings.tutorial', sw('tutorial'), 'settings.tutorial.hint'),
      // v2 (W1): clock settings; the worker decides crisis and observation time from them (§8.5).
      formRow('settings.crisisTime', segmented<'always' | 'mine' | 'off'>(
        (['always', 'mine', 'off'] as const).map((v) => ({ value: v, labelKey: `settings.crisisTime.${v}` })),
        s.crisisTime ?? 'always', (v) => ctx.settings.set({ crisisTime: v }), snd,
      ).el, 'settings.crisisTime.tip'),
      formRow('settings.observationTime', toggleSwitch(s.observationTime ?? true, (v) => ctx.settings.set({ observationTime: v }), snd).el, 'settings.observationTime.tip'),
    ),
  };
  const tabs = h('div', { class: 'fu-tabs' });
  const content = h('div', { class: 'fu-tab-content' });
  const tabIcons: Record<string, string> = { graphics: 'monitor', audio: 'sound', controls: 'mouse', game: 'globe' };
  const tabBtns: HTMLElement[] = [];
  const show = (id: string) => {
    content.replaceChildren(pages[id]);
    tabBtns.forEach((b) => b.classList.toggle('is-on', b.dataset.tab === id));
  };
  for (const id of Object.keys(pages)) {
    const b = h('button', { class: 'fu-tab', 'data-tab': id }, icon(tabIcons[id]), tx(`settings.tab.${id}`));
    b.addEventListener('click', () => {
      sound('click');
      show(id);
    });
    tabBtns.push(b);
    tabs.append(b);
  }
  show('graphics');
  const reset = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--sm' }, icon('restart'), tx('settings.reset'));
  const done = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.done'));
  const m = openModal({
    titleKey: 'settings.title', kickerKey: 'settings.kicker', className: 'fu-settings',
    body: h('div', { class: 'fu-settings-layout' }, tabs, content), foot: [reset, done], onClose,
  });
  done.addEventListener('click', () => m.close());
  reset.addEventListener('click', () => {
    sound('confirm');
    const keepSetup = ctx.settings.get().setup;
    ctx.settings.reset();
    ctx.settings.set({ setup: keepSetup });
    m.close();
    openSettings(ctx, sound, onClose);
  });
  return m;
}

// -------------------------------------------------------------------------------------------------
// How to play
// -------------------------------------------------------------------------------------------------
const HOWTO: [string, string][] = [
  ['flag', 'howto.spawn'],
  ['attack', 'howto.expand'],
  ['troops', 'howto.ratio'],
  ['gold', 'howto.economy'],
  ['city', 'howto.structures'],
  ['boat', 'howto.naval'],
  ['alliance', 'howto.diplomacy'],
  ['atomBomb', 'howto.nukes'],
  ['takeControl', 'howto.command'],
  ['crown', 'howto.win'],
];

export function openHowTo(sound: Sound, onClose?: () => void): ModalHandle {
  const grid = h('div', { class: 'fu-howto' });
  HOWTO.forEach(([ico, key], i) => {
    grid.append(h('div', { class: 'fu-howto-card', style: `animation-delay:${i * 40}ms` },
      h('div', { class: 'fu-howto-ico' }, icon(ico)),
      h('div', null, h('h3', null, tx(`${key}.title`)), tx(`${key}.text`, undefined, 'p')),
    ));
  });
  const keys = h('button', { class: 'fu-btn fu-btn--ghost' }, icon('keyboard'), tx('howto.shortcuts'));
  const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.understood'));
  const body = h('div', null, grid, mapLegend());
  const m = openModal({ titleKey: 'howto.title', kickerKey: 'howto.kicker', body, foot: [keys, ok], wide: true, onClose });
  ok.addEventListener('click', () => m.close());
  keys.addEventListener('click', () => {
    sound('click');
    openShortcuts(sound);
  });
  return m;
}

// -------------------------------------------------------------------------------------------------
// Keyboard shortcuts
// -------------------------------------------------------------------------------------------------
const SHORTCUTS: [string[], string][] = [
  [['LMB'], 'keys.click'],
  [['RMB'], 'keys.rightClick'],
  [['⇧', 'Wheel'], 'keys.ratio'],
  [['1', '…', '0'], 'keys.build'],
  [['Z', 'X', 'C', 'V'], 'keys.weapons'],
  [['B'], 'keys.boat'],
  [['T'], 'keys.takeControl'],
  [['Space'], 'keys.pause'],
  [['+', '−'], 'keys.speed'],
  [['H'], 'keys.capital'],
  [['Tab'], 'keys.leaderboard'],
  [['M'], 'keys.minimap'],
  [['Enter'], 'keys.emotes'],
  [['WASD'], 'keys.pan'],
  [['Q', 'E'], 'keys.rotate'],
  [['R', 'F'], 'keys.zoom'],
  [['Esc'], 'keys.escape'],
  [['F1'], 'keys.help'],
];

export function openShortcuts(sound: Sound, onClose?: () => void): ModalHandle {
  const list = h('div', { class: 'fu-keys' });
  for (const [keys, label] of SHORTCUTS) {
    const kk = h('div', { class: 'fu-keys-k' });
    for (const k of keys) {
      if (k === '…') kk.append(h('span', { class: 'fu-keys-sep' }, '…'));
      else if (k === 'LMB' || k === 'RMB' || k === 'Wheel') kk.append(h('span', { class: 'fu-kbd fu-kbd--mouse' }, icon('mouse'), tx(`keys.${k}`)));
      else kk.append(h('span', { class: 'fu-kbd' }, k === 'Space' ? tx('keys.space') : k));
    }
    list.append(h('div', { class: 'fu-keys-row' }, kk, tx(label, undefined, 'div')));
  }
  const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.close'));
  const m = openModal({ titleKey: 'keys.title', kickerKey: 'keys.kicker', body: list, foot: [ok], onClose });
  ok.addEventListener('click', () => m.close());
  void sound;
  return m;
}

// -------------------------------------------------------------------------------------------------
// Credits
// -------------------------------------------------------------------------------------------------
export function openCredits(onClose?: () => void): ModalHandle {
  const rows: [string, string][] = [
    ['credits.design', 'credits.design.v'],
    ['credits.engine', 'credits.engine.v'],
    ['credits.imagery', 'credits.imagery.v'],
    ['credits.borders', 'credits.borders.v'],
    ['credits.fonts', 'credits.fonts.v'],
    ['credits.audio', 'credits.audio.v'],
    ['credits.inspiration', 'credits.inspiration.v'],
  ];
  const body = h('div', { class: 'fu-credits' },
    h('div', { class: 'fu-credits-hero' }, h('div', { class: 'fu-display' }, 'FRONT ULTRA'), tx('credits.tagline', undefined, 'p')),
    ...rows.map(([k, v]) => h('div', { class: 'fu-credits-row' }, tx(k, undefined, 'div'), tx(v, undefined, 'div'))),
    tx('credits.legal', undefined, 'p'),
  );
  const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.close'));
  const m = openModal({ titleKey: 'credits.title', kickerKey: 'credits.kicker', body, foot: [ok], onClose });
  ok.addEventListener('click', () => m.close());
  return m;
}

// -------------------------------------------------------------------------------------------------
// Confirmation
// -------------------------------------------------------------------------------------------------
export function confirmDialog(titleKey: string, textKey: string, okKey: string, onOk: () => void, sound: Sound, danger = true): ModalHandle {
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('common.cancel'));
  const ok = h('button', { class: `fu-btn ${danger ? 'fu-btn--danger' : 'fu-btn--primary'}` }, tx(okKey));
  const m = openModal({ titleKey, body: tx(textKey, undefined, 'p'), foot: [cancel, ok], narrow: true });
  cancel.addEventListener('click', () => m.close());
  ok.addEventListener('click', () => {
    sound('confirm');
    m.close();
    onOk();
  });
  return m;
}

// -------------------------------------------------------------------------------------------------
// Pause menu
// -------------------------------------------------------------------------------------------------
export function openPauseMenu(ctx: GameContext, sound: Sound, onClose: () => void): ModalHandle {
  const btn = (ico: string, key: string, cls = '') => h('button', { class: `fu-btn fu-pause-btn ${cls}` }, icon(ico), tx(key));
  const resume = btn('play', 'pause.resume', 'fu-btn--primary');
  const settings = btn('settings', 'menu.settings');
  const howto = btn('help', 'menu.howto');
  const keys = btn('keyboard', 'howto.shortcuts');
  const quit = btn('exit', 'pause.quit', 'fu-btn--danger');
  const m = openModal({
    titleKey: 'pause.title', kickerKey: 'pause.kicker', narrow: true, className: 'fu-pause',
    body: h('div', { class: 'fu-pause-list' }, resume, settings, howto, keys, h('div', { class: 'fu-pause-gap' }), quit),
    onClose,
  });
  for (const b of [resume, settings, howto, keys, quit]) b.addEventListener('mouseenter', () => sound('hover'));
  resume.addEventListener('click', () => m.close());
  settings.addEventListener('click', () => {
    sound('click');
    openSettings(ctx, sound);
  });
  howto.addEventListener('click', () => {
    sound('click');
    openHowTo(sound);
  });
  keys.addEventListener('click', () => {
    sound('click');
    openShortcuts(sound);
  });
  quit.addEventListener('click', () => {
    sound('click');
    confirmDialog('pause.quitTitle', 'pause.quitText', 'pause.quitConfirm', () => {
      m.close();
      ctx.app.returnToMenu();
    }, sound);
  });
  return m;
}
