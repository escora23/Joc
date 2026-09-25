// FRONT ULTRA — inline SVG icon set (owner: ui). 24x24 line icons drawn for the game, stroke = currentColor.
// Every icon is original; use `icon(name)` to get a fresh <svg> element.

import { svgFrom } from './dom';
import { StructureType, UnitType } from '../shared/types';

const A = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const P: Record<string, string> = {
  // ---- structures
  city: '<path d="M3 21h18"/><path d="M5 21V10l4-2v13"/><path d="M9 21V5l6-2v18"/><path d="M15 21v-9l4 1.5V21"/><path d="M11.5 7h1M11.5 10h1M11.5 13h1M6.8 12.5h.4M6.8 15.5h.4M16.8 15.5h.4"/>',
  port: '<circle cx="12" cy="5" r="2"/><path d="M12 7v13"/><path d="M8 11h8"/><path d="M4.5 14.5A7.5 7.5 0 0 0 12 20a7.5 7.5 0 0 0 7.5-5.5"/><path d="M3 15.5l1.5-1 1.5 1.5M21 15.5l-1.5-1-1.5 1.5"/>',
  factory: '<path d="M3 21V11l5 3v-3l5 3v-3l5 3V4h3v17z"/><path d="M3 21h18"/><path d="M7 17.5h2M12 17.5h2"/><path d="M18.5 4c0-1.3.9-2 2-2"/>',
  defensePost: '<path d="M12 2.5l7.5 3v6c0 4.6-3.2 8.4-7.5 10-4.3-1.6-7.5-5.4-7.5-10v-6z"/><path d="M9 12l2.2 2.2L15.5 9.8"/>',
  samSite: '<path d="M3 20h18"/><path d="M6 20l2-5h8l2 5"/><path d="M9 15l6.5-9"/><path d="M12 15l6-8"/><path d="M15.5 6l1.6-2.4 1.1.8L16.7 7"/><path d="M18 7l1.6-2.4 1.1.8L19.2 8"/>',
  missileSilo: '<path d="M12 2c2 2 3 4.6 3 7.5V16H9V9.5C9 6.6 10 4 12 2z"/><path d="M9 13l-2.5 3v2H9M15 13l2.5 3v2H15"/><path d="M10.5 19l-.5 2.5M13.5 19l.5 2.5M12 19v3"/><circle cx="12" cy="9" r="1.2"/>',
  airbase: '<path d="M12 2.5c.9 0 1.4.8 1.4 2V9l7.1 4.2v2L13.4 13v4.3l2.4 1.8V21L12 20l-3.8 1v-1.9l2.4-1.8V13l-7.1 2.2v-2L10.6 9V4.5c0-1.2.5-2 1.4-2z"/>',
  armyBase: '<path d="M3 16h18l-2 4H5z"/><path d="M5 16l1.5-4h9l1.5 4"/><path d="M9 12V9.5h5V12"/><path d="M14 10.5h7"/><circle cx="7" cy="18" r=".4"/><circle cx="12" cy="18" r=".4"/><circle cx="17" cy="18" r=".4"/>',
  navalYard: '<path d="M2 17l2.5 4h15L22 17z"/><path d="M5 17v-3h9l2-3h3v6"/><path d="M8 14V9h4v5"/><path d="M10 9V5"/><path d="M4 3v10M4 3h7"/>',
  radar: '<path d="M4.5 19.5a10.6 10.6 0 0 1 0-15z" transform="rotate(20 12 12)"/><path d="M12 12l6-6"/><circle cx="12" cy="12" r="1.3"/><path d="M15.5 4.5a8 8 0 0 1 4 4M14.6 7.3a4.8 4.8 0 0 1 2.2 2.2"/><path d="M9 21h6M12 13.3V21"/>',
  // ---- units
  warship: '<path d="M2 15h20l-3 5H5z"/><path d="M6 15v-3h10v3"/><path d="M9 12V8h4v4"/><path d="M13 9.5h5"/><path d="M11 8V4"/><path d="M3 22c1.5-.8 3-.8 4.5 0s3 .8 4.5 0 3-.8 4.5 0 3 .8 4.5 0"/>',
  armoredDivision: '<path d="M3 15h18l-1.8 4.5H4.8z"/><path d="M5.5 15l1.2-3.5h9l1.8 3.5"/><path d="M11 11.5V9h4.5v2.5"/><path d="M15.5 10h6"/><circle cx="7" cy="17.3" r=".6"/><circle cx="12" cy="17.3" r=".6"/><circle cx="17" cy="17.3" r=".6"/>',
  fighterSquadron: '<path d="M12 2l1.5 5.5 7.5 5v2l-7.5-2.2V17l2.5 2v1.8L12 20l-4 .8V19l2.5-2v-4.7L3 14.5v-2l7.5-5z"/>',
  bomber: '<path d="M12 3c.8 0 1.3 1 1.3 2.3V9L22 12.5v1.8l-8.7-2.2v5.2l3 2V21L12 20l-4.3 1v-1.7l3-2v-5.2L2 14.3v-1.8L10.7 9V5.3C10.7 4 11.2 3 12 3z"/><path d="M6 12.3v2M18 12.3v2"/>',
  droneSwarm: '<path d="M12 9.5l2.5 2.5-2.5 2.5-2.5-2.5z"/><path d="M5 5l2.5 2.5L5 10 2.5 7.5zM19 5l2.5 2.5L19 10l-2.5-2.5zM5 14l2.5 2.5L5 19l-2.5-2.5zM19 14l2.5 2.5L19 19l-2.5-2.5z"/><path d="M7.5 7.5l2 2M16.5 7.5l-2 2M7.5 16.5l2-2M16.5 16.5l-2-2" stroke-dasharray="1 1.6"/>',
  transportShip: '<path d="M2 14h20l-3 5H5z"/><path d="M5 14V9h8v5"/><path d="M13 11h5v3"/><path d="M7 9V6h3v3"/>',
  tradeShip: '<path d="M2 15h20l-3 5H5z"/><path d="M4.5 15v-4h4v4M9 15v-4h4v4M13.5 15v-4h4v4"/><path d="M6.5 11V8h4v3M11 11V8h4v3"/><path d="M18 11V5"/>',
  // ---- weapons
  atomBomb: '<circle cx="12" cy="12" r="1.8"/><path d="M12 9.5c-1.3-2.6-1.5-5.2 0-6.5 1.5 1.3 1.3 3.9 0 6.5z"/><path d="M14.2 13.2c2.9.2 5.2 1.4 5.6 3.3-1.9.6-4-.8-5.6-3.3z"/><path d="M9.8 13.2c-1.6 2.5-3.7 3.9-5.6 3.3.4-1.9 2.7-3.1 5.6-3.3z"/><circle cx="12" cy="12" r="9.5"/>',
  hydrogenBomb: '<path d="M8 20h8"/><path d="M10.5 20v-4.2c-3-.5-5.5-2.6-5.5-5.3C5 7 8 4.5 12 4.5S19 7 19 10.5c0 2.7-2.5 4.8-5.5 5.3V20"/><path d="M8 10.5c1.3.8 2.6 1.2 4 1.2s2.7-.4 4-1.2"/><path d="M12 2v2.5"/>',
  mirv: '<path d="M12 2l2 4v4h-4V6z"/><path d="M10 10l-5 6M12 10v8M14 10l5 6"/><path d="M4 16.5l1-1.2 1.2 1 -1 1.2zM11.3 18.5h1.4v1.6h-1.4zM17.8 16.3l1.2-1 1 1.2-1.2 1z"/><path d="M3 22h18" stroke-dasharray="1.5 2"/>',
  cruiseMissile: '<path d="M3 16l12.5-8.5c1.5-1 3.5-1 5 .1l.5.4-1.6 2.3c-.8 1.2-2 2-3.3 2.4L4 17.5z"/><path d="M6.5 14.3l-1-3 2.5-.8 1 2.2M9.5 15.8l.5 3 -2.4.5-.8-2.3"/><path d="M3 16l-1 .5"/>',
  // ---- resources & HUD
  troops: '<circle cx="9" cy="7" r="3"/><path d="M3.5 20v-1.5A5.5 5.5 0 0 1 9 13a5.5 5.5 0 0 1 5.5 5.5V20"/><circle cx="17" cy="8" r="2.4"/><path d="M16 13.2a4.5 4.5 0 0 1 5 4.5V20"/>',
  gold: '<ellipse cx="12" cy="6.5" rx="7" ry="3"/><path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/><path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
  territory: '<path d="M4 5.5l5-2 6 2 5-2v15l-5 2-6-2-5 2z"/><path d="M9 3.5v15M15 5.5v15"/>',
  population: '<path d="M3 21h18"/><path d="M5 21V9l7-5 7 5v12"/><path d="M9.5 21v-6h5v6"/><path d="M9.5 11h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  // ---- actions
  attack: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 1.5v5M12 17.5v5M1.5 12h5M17.5 12h5"/>',
  alliance: '<path d="M2.5 12.5l3.5-3.8 3.2 1.3 2.3-1.8a2 2 0 0 1 2.6.1l4 3.6"/><path d="M21.5 12.5l-2.2-2.4"/><path d="M5.8 15.5l2.5 2.3a1.3 1.3 0 0 0 1.8-.1l.2-.2a1.3 1.3 0 0 0 1.8.1l.5-.5a1.3 1.3 0 0 0 1.8 0l3-3.2"/><path d="M9.5 11.5l2.5 2.5M11.5 16l-1.8-1.8M14 14.4l-1.6-1.6"/><path d="M2.5 12.5L5.8 15.5"/>',
  breakAlliance: '<path d="M9.5 14.5l-3 3a3 3 0 0 1-4.2-4.2l3-3"/><path d="M14.5 9.5l3-3a3 3 0 0 1 4.2 4.2l-3 3"/><path d="M8 3l1 3M3 8l3 1M16 21l-1-3M21 16l-3-1"/>',
  embargo: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/><path d="M8.5 9.5h5a2 2 0 0 1 0 4h-3a2 2 0 0 0 0 4h5" transform="translate(0 -1.5)"/>',
  donate: '<rect x="3.5" y="9" width="17" height="4" rx=".5"/><path d="M5 13v8h14v-8"/><path d="M12 9v12"/><path d="M12 9c-1.5-3.5-5.5-4.5-5.5-2 0 1.4 2.5 2 5.5 2zM12 9c1.5-3.5 5.5-4.5 5.5-2 0 1.4-2.5 2-5.5 2z"/>',
  emote: '<circle cx="12" cy="12" r="9"/><path d="M8.2 14.3c2.2 2.3 5.4 2.3 7.6 0"/><path d="M9 9.5v.5M15 9.5v.5" stroke-width="2.2"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.2" stroke-width="2.2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  check: '<path d="M4.5 12.5l5 5L19.5 7"/>',
  upgrade: '<path d="M12 4l6 6h-3.5v5h-5v-5H6z"/><path d="M7 19h10M8.5 21.5h7"/>',
  demolish: '<path d="M4 7h16M9.5 7V4.5h5V7"/><path d="M6 7l1 13.5h10L18 7"/><path d="M10 11v6M14 11v6"/>',
  takeControl: '<path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="6"/><path d="M10.2 9.2l5 2.8-5 2.8z" fill="currentColor"/>',
  move: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  pause: '<path d="M8 5v14M16 5v14" stroke-width="2.6"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none"/>',
  fast: '<path d="M3 5l8.5 7L3 19z" fill="currentColor" stroke="none"/><path d="M12 5l8.5 7L12 19z" fill="currentColor" stroke="none"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.3 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.6-2.7 4.3"/><path d="M12 17.5v.2" stroke-width="2.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="1.5"/><path d="M6 10h.5M9 10h.5M12 10h.5M15 10h.5M18 10h.5M7.5 14h9" stroke-width="1.8"/>',
  warning: '<path d="M12 3L2 20.5h20z"/><path d="M12 10v5"/><path d="M12 17.8v.2" stroke-width="2.2"/>',
  radiation: '<circle cx="12" cy="12" r="1.8"/><path d="M12 9.2L9 4a9 9 0 0 1 6 0z"/><path d="M14.4 13.4l6 .2a9 9 0 0 1-3 5.2z"/><path d="M9.6 13.4l-3 5.4a9 9 0 0 1-3-5.2z"/>',
  crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 10H5z"/><path d="M5 21h14"/>',
  skull: '<path d="M12 3a7.5 7.5 0 0 0-7.5 7.5c0 2.6 1.3 4.5 3 5.6V19h9v-2.9c1.7-1.1 3-3 3-5.6A7.5 7.5 0 0 0 12 3z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/><path d="M10 19v2.5M14 19v2.5M12 14.5v1"/>',
  news: '<rect x="3" y="4.5" width="15" height="15" rx="1"/><path d="M18 8.5h3v9.5a1.5 1.5 0 0 1-3 0z"/><path d="M6 8.5h9M6 12h9M6 15.5h5"/>',
  map: '<path d="M3 6l6-2.5 6 2.5 6-2.5v14.5l-6 2.5-6-2.5-6 2.5z"/><path d="M9 3.5V18M15 6v14.5"/>',
  flag: '<path d="M5 21V3.5"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  sound: '<path d="M4 9.5h4l5-4v13l-5-4H4z"/><path d="M16.5 9a4.5 4.5 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="1.2"/><path d="M8 21h8M12 17v4"/>',
  mouse: '<rect x="6" y="2.5" width="12" height="19" rx="6"/><path d="M12 6v4"/>',
  gamepad: '<path d="M6.5 7h11a4.5 4.5 0 0 1 4.3 5.8l-1.3 4.5a2.5 2.5 0 0 1-4.3.9L14.5 16h-5l-1.7 2.2a2.5 2.5 0 0 1-4.3-.9l-1.3-4.5A4.5 4.5 0 0 1 6.5 7z"/><path d="M7.5 10v4M5.5 12h4M15.5 11h.2M17.5 13h.2" stroke-width="1.8"/>',
  users: '<circle cx="12" cy="7.5" r="3.5"/><path d="M5 20.5v-1a7 7 0 0 1 14 0v1"/>',
  bolt: '<path d="M13 2L4.5 13.5H11l-1 8.5 8.5-11.5H12z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M6.5 15.5l4-5 3.5 3 6-7.5"/>',
  exit: '<path d="M14 4h5a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 19 20h-5"/><path d="M10 16.5L5.5 12 10 7.5M5.5 12H16"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 3.5v5h5"/>',
  shield: '<path d="M12 2.5l7.5 3v6c0 4.6-3.2 8.4-7.5 10-4.3-1.6-7.5-5.4-7.5-10v-6z"/>',
  swords: '<path d="M3 3l10 10M3 3v4l9 9M3 3h4l9 9"/><path d="M21 3L14.5 9.5M21 3v4l-4 4M21 3h-4l-4 4"/><path d="M13 16l-3.5 3.5M16 13l3.5 3.5M8 18l-2 2M18 16l2 2" /><path d="M5.5 16.5l2 2M16.5 18.5l2-2"/>',
  boat: '<path d="M2 15h20l-3 5H5z"/><path d="M12 15V3l6 9h-6"/><path d="M12 6L7 12h5"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  chevronUp: '<path d="M5 15l7-7 7 7"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="1.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  earthquake: '<path d="M2 12h3l2-5 3 10 3-13 3 11 2-3h4"/>',
  hurricane: '<path d="M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0"/><path d="M14.5 12c0-5-3-8-8-8 2 1.5 3 3 3.2 5M9.5 12c0 5 3 8 8 8-2-1.5-3-3-3.2-5"/>',
  rebellion: '<path d="M8 21V11"/><path d="M5 11h6l-1-3 3-5 1.5 3.5L18 8l-2 3h3"/><path d="M4 21h16"/>',
  goldRush: '<path d="M6 19h12l-2-6H8z"/><path d="M9 13l-1-4h8l-1 4"/><path d="M12 3v3M8 5l1 2M16 5l-1 2"/>',
  pandemic: '<circle cx="12" cy="12" r="5"/><path d="M12 7V3.5M12 17v3.5M7 12H3.5M17 12h3.5M8.5 8.5L6 6M15.5 15.5L18 18M8.5 15.5L6 18M15.5 8.5L18 6"/><circle cx="10.5" cy="11" r=".6"/><circle cx="13.5" cy="13" r=".6"/>',
};

export type IconName = keyof typeof P | string;

export function icon(name: IconName, cls = 'fu-ico'): SVGElement {
  const body = P[name] ?? P.info;
  return svgFrom(`<svg ${A}>${body}</svg>`, cls);
}

export function iconMarkup(name: IconName): string {
  return `<svg ${A} class="fu-ico" aria-hidden="true">${P[name] ?? P.info}</svg>`;
}

export const STRUCTURE_ICON: Record<StructureType, string> = {
  [StructureType.City]: 'city',
  [StructureType.Port]: 'port',
  [StructureType.Factory]: 'factory',
  [StructureType.DefensePost]: 'defensePost',
  [StructureType.SamSite]: 'samSite',
  [StructureType.MissileSilo]: 'missileSilo',
  [StructureType.Airbase]: 'airbase',
  [StructureType.ArmyBase]: 'armyBase',
  [StructureType.NavalYard]: 'navalYard',
  [StructureType.Radar]: 'radar',
};

export const UNIT_ICON: Record<UnitType, string> = {
  [UnitType.TransportShip]: 'transportShip',
  [UnitType.TradeShip]: 'tradeShip',
  [UnitType.Warship]: 'warship',
  [UnitType.ArmoredDivision]: 'armoredDivision',
  [UnitType.FighterSquadron]: 'fighterSquadron',
  [UnitType.Bomber]: 'bomber',
  [UnitType.DroneSwarm]: 'droneSwarm',
  [UnitType.CruiseMissile]: 'cruiseMissile',
  [UnitType.AtomBomb]: 'atomBomb',
  [UnitType.HydrogenBomb]: 'hydrogenBomb',
  [UnitType.Mirv]: 'mirv',
  [UnitType.MirvWarhead]: 'mirv',
  [UnitType.SamInterceptor]: 'samSite',
  [UnitType.Train]: 'factory',
  [UnitType.Shell]: 'target',
};

/** Emote glyphs (drawn with system emoji fonts where available, with a text fallback). */
export const EMOTE_GLYPH: Record<string, string> = {
  wave: '👋', thumbsUp: '👍', thumbsDown: '👎', laugh: '😂', angry: '😠', skull: '💀', heart: '❤️', handshake: '🤝',
  fire: '🔥', nuke: '☢️', clown: '🤡', crown: '👑', peace: '☮️', target: '🎯', shock: '😱', cry: '😢',
};
