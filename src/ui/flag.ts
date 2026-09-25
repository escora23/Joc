// FRONT ULTRA — nation "flag" emblem (owner: ui): a beveled pennant shield in the nation color with a
// chevron and star, generated as SVG so every nation (and the player's custom color) gets a crisp badge.

import { hexToCss, luminance, mixHex } from '../shared/color';
import { svgFrom } from './dom';

let uid = 0;

export function flagMarkup(color: number, variant = 0): string {
  const id = `fuFlag${++uid}`;
  const base = hexToCss(color);
  const dark = hexToCss(mixHex(color, 0x000000, 0.45));
  const light = hexToCss(mixHex(color, 0xffffff, 0.35));
  const ink = luminance(color) > 0.6 ? '#0b1420' : '#f4f9ff';
  const v = Math.abs(variant) % 3;
  const motif =
    v === 0
      ? `<path d="M6 13l10 6 10-6" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linejoin="miter" opacity=".9"/><path d="M16 5.5l1.5 3.1 3.4.5-2.5 2.4.6 3.4-3-1.6-3 1.6.6-3.4-2.5-2.4 3.4-.5z" fill="${ink}" opacity=".95"/>`
      : v === 1
        ? `<path d="M5 17h22" stroke="${ink}" stroke-width="3" opacity=".85"/><circle cx="16" cy="10.5" r="3.2" fill="${ink}" opacity=".95"/>`
        : `<path d="M16 4v26M5 12h22" stroke="${ink}" stroke-width="2.6" opacity=".85"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${light}"/><stop offset=".55" stop-color="${base}"/><stop offset="1" stop-color="${dark}"/></linearGradient></defs>
    <path d="M3 2h26v17c0 5.5-5.8 9.3-13 11-7.2-1.7-13-5.5-13-11z" fill="url(#${id})" stroke="rgba(255,255,255,.55)" stroke-width="1"/>
    ${motif}
    <path d="M3 2h26v5H3z" fill="rgba(255,255,255,.12)"/>
  </svg>`;
}

export function flag(color: number, variant = 0, cls = 'fu-flag'): SVGElement {
  return svgFrom(flagMarkup(color, variant), cls);
}
