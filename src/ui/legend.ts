// FRONT ULTRA — map legend of the help screen (owner: ui, v2 W2). Every pattern and line the globe draws has one
// meaning (DESIGN_V2 §10.1, §10.3, §10.6-10.8); each entry shows a small code-drawn sample next to its explanation, so
// the player can match what they see on the map. Samples are inline SVG in the same colours the globe uses.

import { h } from './dom';
import { tx } from './tx';

const NS = 'http://www.w3.org/2000/svg';
const W = 64, H = 36;
const GROUND = '#3d4a2c';
const A = '#e48a2a'; // a human-like orange
const B = '#4f8fe0'; // another nation
const C = '#58b86a'; // a third one

function svg(inner: string): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.setAttribute('width', String(W));
  el.setAttribute('height', String(H));
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('fu-legend-svg');
  el.innerHTML = inner;
  return el;
}

/** Two fills side by side, meeting along a slightly curved border. */
function halves(left: string, right: string, opacity = 0.55): string {
  return `<rect width="${W}" height="${H}" fill="${GROUND}"/>`
    + `<path d="M0 0H30C34 12 28 24 33 36H0Z" fill="${left}" opacity="${opacity}"/>`
    + `<path d="M30 0H64V36H33C28 24 34 12 30 0Z" fill="${right}" opacity="${opacity}"/>`;
}
const EDGE = 'M30 0C34 12 28 24 33 36';

function stripes(id: string, color: string, gap: number, width: number, angle: number, opacity: number): string {
  return `<defs><pattern id="${id}" width="${gap}" height="${gap}" patternUnits="userSpaceOnUse" patternTransform="rotate(${angle})">`
    + `<rect width="${width}" height="${gap}" fill="${color}" opacity="${opacity}"/></pattern></defs>`;
}

const SAMPLES: Record<string, () => SVGSVGElement> = {
  own: () => svg(halves(A, B, 0.6)
    + `<path d="M28 0C32 12 26 24 31 36" stroke="${A}" stroke-width="5" fill="none" opacity="0.45"/>`
    + `<path d="${EDGE}" stroke="${A}" stroke-width="2.4" fill="none"/>`),
  border: () => svg(halves(B, C)
    + `<path d="M29.4 0C33.4 12 27.4 24 32.4 36" stroke="${B}" stroke-width="1.4" fill="none"/>`
    + `<path d="M30.6 0C34.6 12 28.6 24 33.6 36" stroke="${C}" stroke-width="1.4" fill="none"/>`),
  war: () => svg(halves(B, C)
    + `<path d="M28.6 0C32.6 12 26.6 24 31.6 36" stroke="${B}" stroke-width="1.6" fill="none"/>`
    + `<path d="M31.4 0C35.4 12 29.4 24 34.4 36" stroke="${C}" stroke-width="1.6" fill="none"/>`
    + `<path d="${EDGE}" stroke="#15100c" stroke-width="1.4" fill="none"/>`),
  contested: () => svg(stripes('lgC', '#ff6a2a', 6, 2.4, 45, 0.9) + halves(B, C)
    + `<rect x="14" width="36" height="${H}" fill="url(#lgC)"/>`),
  occupied: () => svg(`<defs><pattern id="lgO" width="7" height="7" patternUnits="userSpaceOnUse">`
    + `<circle cx="3.5" cy="3.5" r="1.7" fill="${A}"/></pattern></defs>`
    + `<rect width="${W}" height="${H}" fill="${GROUND}"/><rect width="${W}" height="${H}" fill="${A}" opacity="0.38"/>`
    + `<rect width="${W}" height="${H}" fill="url(#lgO)"/>`),
  ally: () => svg(stripes('lgA', '#a8e8b4', 9, 2, -45, 0.7) + `<rect width="${W}" height="${H}" fill="${GROUND}"/>`
    + `<rect width="${W}" height="${H}" fill="${C}" opacity="0.55"/><rect width="${W}" height="${H}" fill="url(#lgA)"/>`),
  rebel: () => svg(stripes('lgR', '#1c1a18', 4, 1.2, 45, 0.6) + `<rect width="${W}" height="${H}" fill="${GROUND}"/>`
    + `<rect width="${W}" height="${H}" fill="#c9a24a" opacity="0.6"/><rect width="${W}" height="${H}" fill="url(#lgR)"/>`),
  flash: () => svg(halves(A, B)
    + `<defs><radialGradient id="lgF"><stop offset="0" stop-color="#ffd9a8"/><stop offset="0.5" stop-color="${A}" stop-opacity="0.8"/>`
    + `<stop offset="1" stop-color="${A}" stop-opacity="0"/></radialGradient></defs>`
    + `<ellipse cx="38" cy="18" rx="16" ry="13" fill="url(#lgF)"/>`),
  fallout: () => svg(`<rect width="${W}" height="${H}" fill="${GROUND}"/>`
    + `<defs><radialGradient id="lgX"><stop offset="0" stop-color="#0a0c06"/><stop offset="0.7" stop-color="#101406"/>`
    + `<stop offset="0.85" stop-color="#7cff2a" stop-opacity="0.8"/><stop offset="1" stop-color="#7cff2a" stop-opacity="0"/></radialGradient></defs>`
    + `<circle cx="32" cy="18" r="16" fill="url(#lgX)"/>`),
  island: () => svg(`<rect width="${W}" height="${H}" fill="#0d2744"/>`
    + `<circle cx="18" cy="18" r="6" fill="${A}" stroke="#fff" stroke-width="1.5"/>`
    + `<circle cx="44" cy="18" r="8" fill="none" stroke="#fff" stroke-width="1.5"/>`
    + `<text x="44" y="21.5" font-size="9" font-weight="700" text-anchor="middle" fill="#fff">4</text>`),
  icons: () => svg(`<rect width="${W}" height="${H}" fill="#1a2330"/>`
    + `<rect x="3" y="11" width="14" height="14" fill="${A}" stroke="#fff" stroke-width="1.2"/>`
    + `<rect x="18.5" y="11" width="14" height="14" fill="${C}" stroke="#fff" stroke-width="1.2" stroke-dasharray="2.5 1.8"/>`
    + `<path d="M41 9.5L49 18L41 26.5L33 18Z" fill="#d8453a" stroke="#fff" stroke-width="1.2"/>`
    + `<rect x="50" y="11" width="12" height="14" rx="4" fill="${B}" stroke="#fff" stroke-width="1.2"/>`),
  route: () => svg(`<rect width="${W}" height="${H}" fill="#0d2744"/>`
    + `<path d="M4 28C14 26 20 14 32 14" stroke="${A}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`
    + `<path d="M32 14C44 14 50 10 60 7" stroke="${A}" stroke-width="2" fill="none" stroke-dasharray="4 3" opacity="0.55"/>`
    + `<circle cx="32" cy="14" r="3.2" fill="#fff" stroke="${A}" stroke-width="1.5"/>`),
  historical: () => svg(halves(B, B)
    + `<path d="M14 0C22 14 38 18 50 36" stroke="#c9c9c9" stroke-width="1.1" fill="none" stroke-dasharray="2 2.2"/>`),
};

const ORDER = ['own', 'border', 'war', 'contested', 'occupied', 'ally', 'rebel', 'flash', 'fallout', 'island', 'icons', 'route', 'historical'];

/** The legend section appended to the «Cómo jugar» screen. */
export function mapLegend(): HTMLElement {
  const grid = h('div', { class: 'fu-legend' });
  for (const k of ORDER) {
    grid.append(h('div', { class: 'fu-legend-row' },
      h('div', { class: 'fu-legend-sample' }, SAMPLES[k]()),
      h('div', null, tx(`legend.${k}.title`, undefined, 'b'), tx(`legend.${k}.text`, undefined, 'p')),
    ));
  }
  return h('section', { class: 'fu-legend-wrap' },
    h('h3', { class: 'fu-legend-title' }, tx('legend.title')),
    tx('legend.kicker', undefined, 'div'),
    grid,
  );
}
