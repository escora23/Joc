// FRONT ULTRA — modal screens (owner: ui): settings, help, credits, keyboard shortcuts, pause menu, save and load,
// confirmations. All strings go through i18n; settings are applied through ctx.settings.set().
// v2 (W3): Settings > Juego holds the eight auto-pause toggles, crisis and observation time, the cloud mode and the
// historical borders (§8.5); Help is rewritten by sections (§12.3); Guardar / Cargar (§12.8).

import { formRow, segmented, slider, toggleSwitch } from './controls';
import { h } from './dom';
import { icon } from './icons';
import { openModal, type ModalHandle } from './modal';
import { tip } from './tooltip';
import { tx } from './tx';
import { mapLegend } from './legend';
import { listSaves, saveToSlot, type SaveRecord } from '../app/autosave';
import type { GameContext } from '../shared/api';
import { DIFFICULTY_INDEX, HUMAN_MOBILIZE_TICKS, TENSION_LEAD_TICKS } from '../shared/constants';
import type { UiSoundKind } from '../shared/events';
import { formatNumber, getLanguage, t, type Lang } from '../shared/i18n';
import type { QualityLevel } from '../shared/quality';
import type { CloudMode } from '../shared/settings';
import { AUTO_PAUSE_KINDS, type AutoPauseKind } from '../shared/types';

type Sound = (k: UiSoundKind) => void;

/** A settings row whose whole line explains itself on hover (label, purpose, current value). */
function row(labelKey: string, control: HTMLElement, hintKey?: string, tipKey?: string): HTMLElement {
  const r = formRow(labelKey, control, hintKey);
  tip(r, () => ({ title: t(labelKey), text: t(tipKey ?? hintKey ?? labelKey) }));
  return r;
}

// -------------------------------------------------------------------------------------------------
// Settings
// -------------------------------------------------------------------------------------------------
export function openSettings(ctx: GameContext, sound: Sound, onClose?: () => void, startTab = 'graphics'): ModalHandle {
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
  const sw = (key: 'invertY' | 'screenShake' | 'showFps' | 'tutorial') =>
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

  // Auto-pause (§8.5): eight toggles with their defaults.
  const ap = h('div', { class: 'fu-autopause-grid' });
  const apState = { ...s.autoPause };
  for (const k of AUTO_PAUSE_KINDS as readonly AutoPauseKind[]) {
    const sw2 = toggleSwitch(apState[k] ?? false, (v) => {
      apState[k] = v;
      ctx.settings.set({ autoPause: { ...apState } });
    }, snd);
    sw2.el.dataset.autopause = k;
    const r = h('div', { class: 'fu-autopause-row' }, tx(`settings.autoPause.${k}`, undefined, 'span'), sw2.el);
    tip(r, () => ({ title: t(`settings.autoPause.${k}`), text: t(`settings.autoPause.${k}.tip`), lines: [t('settings.autoPause.never')] }));
    ap.append(r);
  }

  const d = DIFFICULTY_INDEX[s.setup.difficulty];
  const pages: Record<string, HTMLElement> = {
    graphics: h('div', { class: 'fu-form' },
      row('settings.quality', quality.el, 'settings.quality.hint'),
      qualityHint,
      row('settings.screenShake', sw('screenShake'), 'settings.screenShake.hint'),
      row('settings.showFps', sw('showFps'), undefined, 'settings.showFps.tip'),
    ),
    audio: h('div', { class: 'fu-form' },
      row('settings.master', vol('masterVolume'), undefined, 'settings.master.tip'),
      row('settings.music', vol('musicVolume'), undefined, 'settings.music.tip'),
      row('settings.sfx', vol('sfxVolume'), undefined, 'settings.sfx.tip'),
      row('settings.uiVolume', vol('uiVolume'), undefined, 'settings.uiVolume.tip'),
    ),
    controls: h('div', { class: 'fu-form' },
      row('settings.sensitivity', sens, 'settings.sensitivity.hint'),
      row('settings.invertY', sw('invertY'), undefined, 'settings.invertY.tip'),
    ),
    game: h('div', { class: 'fu-form' },
      row('settings.language', lang.el, undefined, 'settings.language.tip'),
      row('settings.tutorial', sw('tutorial'), 'settings.tutorial.hint'),
      h('div', { class: 'fu-form-sub' }, tx('settings.autoPause'), tx('settings.autoPause.hint', undefined, 'small')),
      ap,
      row('settings.crisisTime', segmented<'always' | 'mine' | 'off'>(
        (['always', 'mine', 'off'] as const).map((v) => ({ value: v, labelKey: `settings.crisisTime.${v}` })),
        s.crisisTime ?? 'always', (v) => ctx.settings.set({ crisisTime: v }), snd,
      ).el, 'settings.crisisTime.tip'),
      row('settings.observationTime', toggleSwitch(s.observationTime ?? true, (v) => ctx.settings.set({ observationTime: v }), snd).el, 'settings.observationTime.tip'),
      row('settings.clouds', segmented<CloudMode>(
        (['strategic', 'realistic', 'hidden'] as const).map((v) => ({ value: v, labelKey: `settings.clouds.${v}` })),
        s.clouds ?? 'strategic', (v) => ctx.settings.set({ clouds: v }), snd,
      ).el, 'settings.clouds.tip'),
      row('settings.historicalBorders', toggleSwitch(s.historicalBorders ?? false, (v) => ctx.settings.set({ historicalBorders: v }), snd).el, 'settings.historicalBorders.tip'),
      h('p', { class: 'fu-form-note' }, t('settings.game.note', { mob: HUMAN_MOBILIZE_TICKS[d] / 10, lead: TENSION_LEAD_TICKS[d] / 10 })),
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
    tip(b, () => ({ title: t(`settings.tab.${id}`), text: t(`settings.tab.${id}.tip`) }));
    b.addEventListener('click', () => {
      sound('click');
      show(id);
    });
    tabBtns.push(b);
    tabs.append(b);
  }
  show(pages[startTab] ? startTab : 'graphics');
  const reset = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--sm' }, icon('restart'), tx('settings.reset'));
  const done = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.done'));
  tip(reset, () => ({ title: t('settings.reset'), text: t('settings.reset.tip') }));
  tip(done, () => ({ title: t('common.done'), text: t('settings.done.tip') }));
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
// Help (§12.3): short sections, with a diagram where it helps
// -------------------------------------------------------------------------------------------------
const HELP_SECTIONS: [string, string][] = [
  ['start', 'flag'],
  ['time', 'clock'],
  ['war', 'swords'],
  ['fronts', 'attack'],
  ['defense', 'shield'],
  ['units', 'armoredDivision'],
  ['structures', 'city'],
  ['economy', 'gold'],
  ['diplomacy', 'alliance'],
  ['escalation', 'radiation'],
  ['alerts', 'bell'],
  ['command', 'takeControl'],
  ['victory', 'crown'],
  ['legend', 'map'],
  ['keys', 'keyboard'],
];

const SVG_NS = 'http://www.w3.org/2000/svg';
function diagram(inner: string, w = 320, hgt = 90): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, 'svg');
  el.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  el.setAttribute('class', 'fu-help-svg');
  el.innerHTML = inner;
  return el;
}

function helpDiagram(id: string): SVGSVGElement | null {
  const txt = (x: number, y: number, s: string, c = '#b3c4d6', a = 'middle') => `<text x="${x}" y="${y}" fill="${c}" font-size="10" text-anchor="${a}" font-family="Barlow Condensed, sans-serif">${s}</text>`;
  switch (id) {
    case 'time': {
      // One real second = one game hour; crisis and observation slow the whole world to one minute.
      const bars = [['1x', 60, t('help.d.time.1x')], ['4x', 240, t('help.d.time.4x')], [t('help.d.time.crisis'), 1, t('help.d.time.crisisV')]] as const;
      let s = '';
      bars.forEach(([k, w, v], i) => {
        const y = 12 + i * 26;
        s += txt(40, y + 9, String(k), '#e8f2ff', 'end') + `<rect x="48" y="${y}" width="${Math.max(3, w)}" height="12" fill="${i === 2 ? '#ff4a4a' : '#3fd0ff'}" opacity=".8"/>` + txt(52 + Math.max(3, w), y + 10, String(v), '#b3c4d6', 'start');
      });
      return diagram(s);
    }
    case 'fronts': {
      // Frontage: one tile of corridor per 20,000 troops; the ratio decides the speed up to 8 km/h.
      let s = `<rect x="0" y="0" width="320" height="90" fill="#1a2330"/><path d="M160 0 C150 30 170 60 158 90" stroke="#ff4a4a" stroke-width="2" fill="none"/>`;
      s += `<path d="M60 45 L150 45" stroke="#ffb53d" stroke-width="10" opacity=".6"/><path d="M150 30 L175 45 L150 60Z" fill="#ffb53d"/>`;
      s += txt(100, 30, t('help.d.fronts.axis')) + txt(240, 30, t('help.d.fronts.defender')) + txt(100, 75, t('help.d.fronts.width')) + txt(240, 75, t('help.d.fronts.speed'));
      return diagram(s);
    }
    case 'escalation': {
      let s = '';
      for (let i = 0; i <= 4; i++) {
        const x = 8 + i * 62;
        s += `<rect x="${x}" y="${60 - i * 12}" width="54" height="${20 + i * 12}" fill="${['#3fd0ff', '#45f0a0', '#ffb53d', '#ff7a3d', '#ff4a4a'][i]}" opacity=".75"/>` + txt(x + 27, 88, `L${i}`, '#e8f2ff');
        s += txt(x + 27, 54 - i * 12, t(`escalation.short.${i}`), '#b3c4d6');
      }
      return diagram(s, 320, 94);
    }
    case 'diplomacy': {
      const bands = ['hostile', 'cold', 'neutral', 'cordial', 'friendly'];
      const cols = ['#ff4a4a', '#ff9a3d', '#9fb3c8', '#6fd6ff', '#45f0a0'];
      const edges = [-100, -50, -10, 20, 50, 100];
      let s = '';
      for (let i = 0; i < 5; i++) {
        const x0 = 10 + ((edges[i] + 100) / 200) * 300, x1 = 10 + ((edges[i + 1] + 100) / 200) * 300;
        s += `<rect x="${x0}" y="30" width="${x1 - x0 - 1}" height="16" fill="${cols[i]}" opacity=".8"/>` + txt((x0 + x1) / 2, 22, t(`opinion.band.${bands[i]}`), '#e8f2ff');
        s += txt(x0, 62, String(edges[i]), '#7d91a8');
      }
      return diagram(s + txt(310, 62, '+100', '#7d91a8'), 320, 70);
    }
    default:
      return null;
  }
}

export function openHelp(ctx: GameContext, sound: Sound, section = 'start', onClose?: () => void): ModalHandle {
  const nav = h('div', { class: 'fu-help-nav' });
  const content = h('div', { class: 'fu-help-content' });
  const d = DIFFICULTY_INDEX[ctx.sim.view.config?.difficulty ?? ctx.settings.get().setup.difficulty];
  const params = { mob: HUMAN_MOBILIZE_TICKS[d] / 10, lead: TENSION_LEAD_TICKS[d] / 10 };
  const btns: HTMLElement[] = [];
  const show = (id: string) => {
    btns.forEach((b) => b.classList.toggle('is-on', b.dataset.sec === id));
    const body = h('div', { class: 'fu-help-sec' }, h('h3', null, t(`help.${id}.title`)));
    if (id === 'legend') body.append(mapLegend());
    else if (id === 'keys') body.append(shortcutList());
    else {
      for (const para of t(`help.${id}.body`, params).split('\n')) body.append(h('p', null, para));
      const dg = helpDiagram(id);
      if (dg) body.append(dg);
    }
    content.replaceChildren(body);
    content.scrollTop = 0;
  };
  for (const [id, ico] of HELP_SECTIONS) {
    const b = h('button', { class: 'fu-help-tab', 'data-sec': id }, icon(ico), tx(`help.${id}.title`));
    tip(b, () => ({ title: t(`help.${id}.title`), text: t('help.nav.tip') }));
    b.addEventListener('click', () => {
      sound('click');
      show(id);
    });
    btns.push(b);
    nav.append(b);
  }
  const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.understood'));
  tip(ok, () => ({ title: t('common.understood'), text: t('help.close.tip') }));
  const m = openModal({ titleKey: 'help.title', kickerKey: 'help.kicker', body: h('div', { class: 'fu-help' }, nav, content), foot: [ok], wide: true, className: 'fu-help-modal', onClose });
  ok.addEventListener('click', () => m.close());
  show(HELP_SECTIONS.some(([id]) => id === section) ? section : 'start');
  return m;
}

/** v1 entry point kept for the main menu: the help opens on its first section. */
export function openHowTo(sound: Sound, onClose?: () => void, ctx?: GameContext): ModalHandle {
  if (ctx) return openHelp(ctx, sound, 'start', onClose);
  const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.understood'));
  const m = openModal({ titleKey: 'help.title', kickerKey: 'help.kicker', body: h('div', null, tx('help.start.body', { mob: 6, lead: 24 }, 'p'), mapLegend()), foot: [ok], wide: true, onClose });
  ok.addEventListener('click', () => m.close());
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
  [['N'], 'keys.nations'],
  [['L'], 'keys.log'],
  [['Space'], 'keys.pause'],
  [['+', '−'], 'keys.speed'],
  [['H'], 'keys.capital'],
  [['Tab'], 'keys.leaderboard'],
  [['M'], 'keys.minimap'],
  [['Enter'], 'keys.radial'],
  [['WASD'], 'keys.pan'],
  [['Q', 'E'], 'keys.rotate'],
  [['R', 'F'], 'keys.zoom'],
  [['⇧'], 'keys.pinTip'],
  [['Esc'], 'keys.escape'],
  [['F1'], 'keys.help'],
];

function shortcutList(): HTMLElement {
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
  return list;
}

export function openShortcuts(sound: Sound, onClose?: () => void): ModalHandle {
  const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.close'));
  const m = openModal({ titleKey: 'keys.title', kickerKey: 'keys.kicker', body: shortcutList(), foot: [ok], onClose });
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
export function confirmDialog(titleKey: string, textKey: string, okKey: string, onOk: () => void, sound: Sound, danger = true, params?: Record<string, string | number>): ModalHandle {
  const cancel = h('button', { class: 'fu-btn fu-btn--ghost' }, tx('common.cancel'));
  const ok = h('button', { class: `fu-btn ${danger ? 'fu-btn--danger' : 'fu-btn--primary'}` }, tx(okKey));
  const m = openModal({ titleKey, body: tx(textKey, params, 'p'), foot: [cancel, ok], narrow: true });
  cancel.addEventListener('click', () => m.close());
  ok.addEventListener('click', () => {
    sound('confirm');
    m.close();
    onOk();
  });
  return m;
}

// -------------------------------------------------------------------------------------------------
// Save and load (§12.8)
// -------------------------------------------------------------------------------------------------
const SLOTS = ['slot1', 'slot2', 'slot3'];

function saveLabel(r: SaveRecord): string {
  const date = new Date(r.savedAt).toLocaleString(getLanguage() === 'es' ? 'es-ES' : 'en-US', { dateStyle: 'short', timeStyle: 'short' });
  return t('save.row', { nation: r.nation || '—', day: formatNumber(r.day), date });
}

/** The three manual slots (the pause menu's «Guardar»). */
export function openSaveDialog(ctx: GameContext, sound: Sound): ModalHandle {
  const list = h('div', { class: 'fu-save-list' });
  const m = openModal({ titleKey: 'save.title', kickerKey: 'save.kicker', narrow: true, body: h('div', null, tx('save.explain', undefined, 'p'), list) });
  const paint = (saves: SaveRecord[]) => {
    list.replaceChildren();
    for (const k of SLOTS) {
      const r = saves.find((x) => x.key === k);
      const b = h('button', { class: 'fu-save-row fu-interactive' }, icon('save'), h('div', null, h('b', null, t(`save.slot.${k}`)), h('span', null, r ? saveLabel(r) : t('save.empty'))));
      tip(b, () => ({ title: t(`save.slot.${k}`), text: t(r ? 'save.overwrite.tip' : 'save.slot.tip') }));
      b.addEventListener('click', () => {
        const go = () => {
          sound('confirm');
          saveToSlot(ctx, k)
            .then(() => {
              m.close();
            })
            .catch((err) => ctx.bus.emit('toast', { text: t('save.failed', { why: String((err as Error)?.message ?? err) }), kind: 'danger' }));
        };
        if (r) confirmDialog('save.overwrite', 'save.overwrite.text', 'save.overwrite.ok', go, sound, false, { slot: t(`save.slot.${k}`) });
        else go();
      });
      list.append(b);
    }
  };
  listSaves().then(paint).catch(() => paint([]));
  return m;
}

/** Every save (autosave first when newest): «Cargar» on the main menu and in the pause menu. */
export function openLoadDialog(ctx: GameContext, sound: Sound): ModalHandle {
  const list = h('div', { class: 'fu-save-list' });
  const m = openModal({ titleKey: 'load.title', kickerKey: 'load.kicker', narrow: true, body: h('div', null, tx('load.explain', undefined, 'p'), list) });
  listSaves()
    .then((saves) => {
      if (!saves.length) list.append(tx('load.none', undefined, 'p'));
      for (const r of saves) {
        const b = h('button', { class: 'fu-save-row fu-interactive' }, icon(r.key === 'autosave' ? 'clock' : 'save'), h('div', null, h('b', null, t(r.key === 'autosave' ? 'save.slot.autosave' : `save.slot.${r.key}`)), h('span', null, saveLabel(r))));
        tip(b, () => ({ title: t('load.title'), text: t('load.row.tip', { day: r.day }) }));
        b.addEventListener('click', () => {
          sound('confirm');
          m.close();
          loadSave(ctx, r.blob);
        });
        list.append(b);
      }
    })
    .catch(() => list.append(tx('load.unavailable', undefined, 'p')));
  return m;
}

/** Resume a save; a save from another version or world is refused with a clear message, never half-loaded. */
export function loadSave(ctx: GameContext, blob: ArrayBuffer): void {
  if (!ctx.app.loadGame) return;
  ctx.app.loadGame(blob).then(
    () => ctx.bus.emit('toast', { text: t('load.done', { day: Math.floor(ctx.sim.view.tick / 240) + 1 }), kind: 'info', durationMs: 7000 }),
    (err: unknown) => {
      ctx.app.goto('menu');
      const ok = h('button', { class: 'fu-btn fu-btn--primary' }, tx('common.close'));
      const mm = openModal({ titleKey: 'load.failedTitle', narrow: true, body: h('p', null, t('load.failed', { why: String((err as Error)?.message ?? err) })), foot: [ok] });
      ok.addEventListener('click', () => mm.close());
    },
  );
}

// -------------------------------------------------------------------------------------------------
// Pause menu
// -------------------------------------------------------------------------------------------------
export function openPauseMenu(ctx: GameContext, sound: Sound, onClose: () => void): ModalHandle {
  const btn = (ico: string, key: string, cls = '') => h('button', { class: `fu-btn fu-pause-btn ${cls}` }, icon(ico), tx(key));
  const resume = btn('play', 'pause.resume', 'fu-btn--primary');
  const save = btn('save', 'pause.save');
  const load = btn('folder', 'pause.load');
  const settings = btn('settings', 'menu.settings');
  const help = btn('help', 'menu.howto');
  const quit = btn('exit', 'pause.quit', 'fu-btn--danger');
  const inCommand = ctx.app.state === 'command';
  if (inCommand) save.setAttribute('disabled', '');
  tip(resume, () => ({ title: t('pause.resume'), text: t('pause.resume.tip'), hotkey: 'Esc' }));
  tip(save, () => ({ title: t('pause.save'), text: t('pause.save.tip'), whyNot: inCommand ? t('pause.save.command') : null }));
  tip(load, () => ({ title: t('pause.load'), text: t('pause.load.tip') }));
  tip(settings, () => ({ title: t('menu.settings'), text: t('tb.settings.tip') }));
  tip(help, () => ({ title: t('menu.howto'), text: t('tb.help.tip'), hotkey: 'F1' }));
  tip(quit, () => ({ title: t('pause.quit'), text: t('pause.quit.tip') }));
  const m = openModal({
    titleKey: 'pause.title', kickerKey: 'pause.kicker', narrow: true, className: 'fu-pause',
    body: h('div', { class: 'fu-pause-list' }, resume, save, load, settings, help, h('div', { class: 'fu-pause-gap' }), quit),
    onClose,
  });
  for (const b of [resume, save, load, settings, help, quit]) b.addEventListener('mouseenter', () => sound('hover'));
  resume.addEventListener('click', () => m.close());
  save.addEventListener('click', () => {
    sound('click');
    openSaveDialog(ctx, sound);
  });
  load.addEventListener('click', () => {
    sound('click');
    openLoadDialog(ctx, sound);
  });
  settings.addEventListener('click', () => {
    sound('click');
    openSettings(ctx, sound);
  });
  help.addEventListener('click', () => {
    sound('click');
    openHelp(ctx, sound);
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
