// FRONT ULTRA — what a front means, in words and numbers (DESIGN_V2 §11.2, §11.3, §11.7; owner: ui, W6).
// Shared by the front badges on the globe, the Guerra y frentes panel and the ground battle's HUD strip, so the three
// always tell the same story: who attacks whom, who is winning (the tug-of-war share and the momentum), the MEASURED
// advance, the garrisons of both sides, and how long they have been fighting.

import { HUMAN_ID, MAP_H, MAP_W, TICKS_PER_GAME_DAY, TILE_KM } from '../../shared/constants';
import { publishedLineOffset } from '../../shared/localForces';
import { formatNumber, getLanguage, t } from '../../shared/i18n';
import type { GameView } from '../../shared/api';
import type { AttackView, FrontView } from '../../shared/types';

export interface FrontSides {
  /** The side pushing (the lead offensive's attacker; on a quiet front the war's aggressor, side a). */
  att: number;
  def: number;
  /** The lead offensive on the front, if any. */
  lead: AttackView | null;
  /** Both sides' offensives (a two-sided battle has two). */
  offA: AttackView | null;
  offB: AttackView | null;
  quiet: boolean;
  /** Attacker share of the tug of war 0..1: Pa / (Pa + Pd); quiet fronts: garrison share. */
  share: number;
  /** +1 the attacker is gaining ground, -1 the defender is, 0 nobody (|momentum| ≤ 0.1). */
  gaining: number;
  /** Garrisons (Gf) of the attacker and the defender on this front. */
  garAtt: number;
  garDef: number;
  divAtt: number;
  divDef: number;
  casAtt: number;
  casDef: number;
}

export function attackById(view: GameView, id: number): AttackView | null {
  if (!id) return null;
  for (const a of view.attacks) if (a.id === id) return a;
  return null;
}

export function sidesOf(view: GameView, f: FrontView): FrontSides {
  const offA = attackById(view, f.offensiveA), offB = attackById(view, f.offensiveB);
  const lead = offA && offB ? (offA.attackPower >= offB.attackPower ? offA : offB) : offA ?? offB;
  const att = lead ? lead.attacker : f.a;
  const aIsAtt = att === f.a;
  const quiet = f.quiet || !lead;
  let share: number;
  if (!quiet && f.pa + f.pd > 0) share = f.pa / (f.pa + f.pd);
  else {
    const ga = aIsAtt ? f.garrisonA : f.garrisonB, gd = aIsAtt ? f.garrisonB : f.garrisonA;
    share = ga + gd > 0 ? ga / (ga + gd) : 0.5;
  }
  const m = aIsAtt ? f.momentum : -f.momentum;
  return {
    att, def: aIsAtt ? f.b : f.a, lead, offA, offB, quiet, share: Math.max(0, Math.min(1, share)),
    gaining: quiet || Math.abs(m) <= 0.1 ? 0 : m > 0 ? 1 : -1,
    garAtt: aIsAtt ? f.garrisonA : f.garrisonB, garDef: aIsAtt ? f.garrisonB : f.garrisonA,
    divAtt: aIsAtt ? f.divisionsA : f.divisionsB, divDef: aIsAtt ? f.divisionsB : f.divisionsA,
    casAtt: aIsAtt ? f.casualtiesA : f.casualtiesB, casDef: aIsAtt ? f.casualtiesB : f.casualtiesA,
  };
}

/** Three-letter code of a player: the country's ISO3 («ESP»), «TÚ» / «YOU» for the human. */
export function isoOf(view: GameView, id: number): string {
  if (id === HUMAN_ID) return t('fr.you');
  const p = view.players[id];
  if (!p) return '—';
  const c = p.countryIndex > 0 || p.kind === 'nation' ? view.world?.countries[p.countryIndex] : undefined;
  if (c?.iso3 && p.kind === 'nation') return c.iso3.toUpperCase();
  return p.name.replace(/[^A-Za-zÀ-ÿ]/g, '').slice(0, 3).toUpperCase() || '—';
}

/** Days of fighting on the front (game days since it opened). */
export function combatDays(view: GameView, f: FrontView): number {
  return Math.max(0, (view.tick - f.startTick) / TICKS_PER_GAME_DAY);
}

/** «3.er día de combate» / «day 3 of fighting». */
export function combatDayText(view: GameView, f: FrontView): string {
  const d = Math.floor(combatDays(view, f)) + 1;
  return getLanguage() === 'es' ? t('fr.dayN', { n: ordinalEs(d) }) : t('fr.dayN', { n: ordinalEn(d) });
}

function ordinalEs(n: number): string {
  return n === 1 || n === 3 ? `${n}.er` : `${n}.º`;
}
function ordinalEn(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${s}`;
}

/** km/h with one decimal below 10. */
export function kmhText(v: number): string {
  return formatNumber(v, v < 9.95 ? 1 : 0);
}

/**
 * The measured advance as the badge, the panel and the strip show it: «▶ 5 km/h», «▶ 8 km/h · consolidando»,
 * «‖ estancado», «contacto», «movilizando», «en calma». `arrow` false drops the leading symbol.
 */
export function advanceText(view: GameView, f: FrontView, s: FrontSides, arrow = true): string {
  if (s.quiet) {
    // A war still in its aggressor's mobilization: the front is quiet, but not for long (§4.2, §11.2).
    const w = view.warBetween(f.a, f.b);
    if (w && view.tick < w.mobilizeUntilTick) {
      const h = (w.mobilizeUntilTick - view.tick) / 10;
      return t('fr.adv.mobilizingIn', { h: formatNumber(h, h < 10 ? 1 : 0) });
    }
    return t('fr.adv.quiet');
  }
  return offensiveStatus(view, s.lead!, f.advanceKmh, s.gaining, arrow);
}

/**
 * Feedback 3 (29a): the one status text of an offensive, from its state and ONE measured km/h (the front's line speed
 * when the offensive leads its front, else its own; see offensiveKmh). Every place that describes an offensive (badge,
 * Guerra panel front row and «Tu ofensiva» line, battle strip, dialogs, unit cards) calls it, so an offensive shown as
 * advancing never sits next to 0 km/h: below 0.05 km/h it reads «presionando: aún sin avance» (pressure building, no
 * tile fallen yet) or «estancado» when the sim marks it stalled.
 */
export function offensiveStatus(view: GameView, a: AttackView, kmh: number, gaining = 1, arrow = true): string {
  const sym = (g: number) => (arrow ? (g < 0 ? '◀ ' : '▶ ') : '');
  switch (a.state) {
    case 'mobilizing': return t('fr.adv.mobilizing');
    case 'embarking': case 'sailing': return t('fr.adv.sailing');
    case 'landing': return t('fr.adv.landing');
    case 'contact': return t('fr.adv.contact');
    case 'retreating': return t('fr.adv.retreating');
    case 'holding': return `${arrow ? '‖ ' : ''}${t('fr.adv.holding')}`;
    default: break;
  }
  void view;
  if (a.state === 'stalled') return `${arrow ? '‖ ' : ''}${t('fr.adv.stalled')}`;
  if (kmh < 0.05) return `${arrow ? '‖ ' : ''}${t(a.state === 'consolidating' ? 'fr.adv.consolidating' : 'fr.adv.pressing')}`;
  const g = gaining === 0 ? 1 : gaining;
  const base = `${sym(g)}${t('fr.adv.kmh', { v: kmhText(kmh) })}`;
  if (a.state === 'consolidating') return `${base} · ${t('fr.adv.consolidating')}${a.breakthrough ? ` · ${t('fr.adv.breakthrough')}` : ''}`;
  // §4.4b: the defence of the corridor has collapsed.
  if (a.breakthrough) return `${base} · ${t('fr.adv.breakthrough')}`;
  return base;
}

/** The measured km/h of an offensive (29a): its front's line speed when it leads that front, else its own EMA. */
export function offensiveKmh(view: GameView, a: AttackView): number {
  const f = a.frontKey ? view.frontByKey.get(a.frontKey) : undefined;
  if (f && (f.offensiveA === a.id || f.offensiveB === a.id) && sidesOf(view, f).lead?.id === a.id) return f.advanceKmh;
  return a.advanceKmh;
}

/** The point of the front a badge / camera uses: the middle of the contact line (continuous tile coords). */
export function frontAnchor(f: FrontView, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
  const n = f.samples.length >> 1;
  if (n === 0) {
    out.x = f.x;
    out.y = f.y;
    return out;
  }
  const m = Math.floor(n / 2);
  out.x = (((f.samples[m * 2] + f.dirX * 0.5) % MAP_W) + MAP_W) % MAP_W;
  out.y = Math.max(0, Math.min(MAP_H - 1e-3, f.samples[m * 2 + 1] + f.dirY * 0.5));
  return out;
}

/**
 * Where to look at a front from low altitude: where its lead offensive fights now (its live contact, on the offensive's
 * axis where the front's line and km/h are measured), else its anchor; moved onto the front's published sub-tile line
 * (FrontView.line, where the ground battle stands) when it lies along that line.
 */
export function frontFocus(view: GameView, f: FrontView): { x: number; y: number } {
  const p = frontAnchor(f);
  const lead = sidesOf(view, f).lead;
  if (lead && lead.frontKey === f.key && lead.contactX >= 0) {
    p.x = lead.contactX;
    p.y = lead.contactY;
  }
  const L = f.line;
  if (!L) return p;
  const o = publishedLineOffset(L, p.x, p.y, Math.max(L.tick, Math.min(L.tick + 6, view.simTime * 10)));
  if (Math.abs(o.alongKm) > L.halfKm + 10 || Math.abs(o.offsetKm) > 40) return p;
  const kmX = TILE_KM * Math.max(0.05, Math.cos(((90 - (p.y / MAP_H) * 180) * Math.PI) / 180));
  p.x = (((p.x + (o.offsetKm * L.e) / kmX) % MAP_W) + MAP_W) % MAP_W;
  p.y = Math.max(0, Math.min(MAP_H - 1e-3, p.y - (o.offsetKm * L.n) / TILE_KM));
  return p;
}

/** Tiles each side took on this front (from the offensives that pushed on it). */
export function frontTiles(view: GameView, f: FrontView, side: number): number {
  let n = 0;
  for (const a of view.attacks) if (a.frontKey === f.key && a.attacker === side) n += a.tilesTaken;
  return n;
}

/**
 * The human's fronts sorted by danger (§11.3): fronts where the human is losing ground first (the faster, the
 * earlier), then fronts under an enemy offensive, then by distance to the human's capital.
 */
export function humanFrontsByDanger(view: GameView): FrontView[] {
  const cap = view.human?.capitalTile ?? -1;
  const cx = cap >= 0 ? (cap % MAP_W) + 0.5 : 0, cy = cap >= 0 ? Math.floor(cap / MAP_W) + 0.5 : 0;
  const score = (f: FrontView): number => {
    const s = sidesOf(view, f);
    const humanDef = s.def === HUMAN_ID;
    let k = 0;
    if (humanDef && s.gaining > 0) k = 3000 + f.advanceKmh * 10;
    else if (humanDef && !s.quiet) k = 2000;
    else if (!s.quiet) k = 1000;
    let d = 0;
    if (cap >= 0) {
      let dx = Math.abs(f.x - cx);
      if (dx > MAP_W / 2) dx = MAP_W - dx;
      d = Math.hypot(dx, f.y - cy);
    }
    return k - Math.min(999, d);
  };
  return view.fronts.filter((f) => f.b !== 0 && (f.a === HUMAN_ID || f.b === HUMAN_ID)).sort((p, q) => score(q) - score(p) || p.key - q.key);
}

/** The ten hottest fronts of the world (Mundo tab): active first, by intensity and length. */
export function worldFronts(view: GameView, n = 10): FrontView[] {
  return view.fronts.filter((f) => f.b !== 0).sort((p, q) =>
    (q.quiet ? 0 : 1) - (p.quiet ? 0 : 1) || (q.intensity * Math.sqrt(q.length)) - (p.intensity * Math.sqrt(p.length)) || p.key - q.key).slice(0, n);
}

/** Troops rounded for display: 1.234.567 → «1,23 M», 184.000 → «184.000». */
export function troopsText(v: number): string {
  if (v >= 1e6) return `${formatNumber(v / 1e6, 2)} M`;
  return formatNumber(Math.round(v / 100) * 100);
}
