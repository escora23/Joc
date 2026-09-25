// FRONT ULTRA — animated logo (emblem + wordmark), used by the loading screen and the main menu (owner: ui).
// The emblem strokes draw themselves (stroke-dashoffset on pathLength=1), the wordmark wipes in and a light
// sheen sweeps across once. Pure SVG + CSS; no raster art.

import { h, svgFrom } from './dom';
import { t } from '../shared/i18n';

const EMBLEM = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" fill="none">
  <defs>
    <linearGradient id="fuLogoFront" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffcf6b"/>
      <stop offset="1" stop-color="#ff7a2e"/>
    </linearGradient>
    <radialGradient id="fuLogoCore" cx="0.5" cy="0.45" r="0.6">
      <stop offset="0" stop-color="#3fd0ff" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#3fd0ff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="60" cy="60" r="40" fill="url(#fuLogoCore)" class="fu-logo-core"/>
  <g class="fu-logo-ring" stroke="#3fd0ff" stroke-width="1.2">
    <circle cx="60" cy="60" r="54" pathLength="1" stroke-opacity="0.55"/>
    <path d="M60 1v10M60 109v10M1 60h10M109 60h10" pathLength="1" stroke-width="1.6"/>
    <path d="M21.8 21.8l4.2 4.2M98.2 21.8l-4.2 4.2M21.8 98.2l4.2-4.2M98.2 98.2l-4.2-4.2" pathLength="1" stroke-opacity="0.5"/>
  </g>
  <g class="fu-logo-globe" stroke="#bfefff" stroke-width="1.1">
    <circle cx="60" cy="60" r="40" pathLength="1"/>
    <ellipse cx="60" cy="60" rx="17" ry="40" pathLength="1" stroke-opacity="0.7"/>
    <ellipse cx="60" cy="60" rx="31" ry="40" pathLength="1" stroke-opacity="0.45"/>
    <path d="M20 60h80" pathLength="1" stroke-opacity="0.7"/>
    <path d="M25.5 40h69M25.5 80h69" pathLength="1" stroke-opacity="0.45"/>
  </g>
  <path class="fu-logo-front" d="M16 76 L34 66 L41 73 L55 56 L63 63 L77 44 L85 50 L104 34" pathLength="1"
        stroke="url(#fuLogoFront)" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"/>
  <path class="fu-logo-arrow" d="M94 31 L106 32 L102 43" stroke="#ffb53d" stroke-width="4" stroke-linecap="square" pathLength="1"/>
</svg>`;

export interface LogoOptions {
  size?: 'hero' | 'menu';
  tagline?: boolean;
}

export function createLogo(opts: LogoOptions = {}): HTMLElement {
  const emblem = svgFrom(EMBLEM, 'fu-logo-emblem');
  const word = h('div', { class: 'fu-logo-word' },
    h('span', { class: 'fu-logo-a' }, 'FRONT'),
    h('span', { class: 'fu-logo-b' }, 'ULTRA'),
    h('i', { class: 'fu-logo-sheen' }),
  );
  const text = h('div', { class: 'fu-logo-text' }, word);
  if (opts.tagline !== false) {
    text.append(h('div', { class: 'fu-logo-tag' }, h('span', { 'data-i18n': 'app.tagline' }, t('app.tagline'))));
  }
  return h('div', { class: `fu-logo fu-logo--${opts.size ?? 'hero'}` }, emblem, text);
}
