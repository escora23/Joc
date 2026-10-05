// FRONT ULTRA — place names for alerts, fronts and the nations panel (DESIGN_V2 §8.4; owner: ui, built by W3).
//
// describePlace(view, lat, lon) → «cerca de Lyon (Francia)» from the nearest place of src/data/places.ts within 150 km
// and the Natural Earth country under the point; otherwise «a 340 km al NE de Madrid», the bearing and distance from
// the viewer's capital (named by its own nearest place). Every located alert and front name uses it.

import { nearestPlace, placeKm } from '../data/places';
import { HUMAN_ID } from '../shared/constants';
import type { GameView } from '../shared/api';
import { latLonToTile, tileToLatLon, tileXYToLatLon } from '../shared/geo';
import { countryName, formatNumber, getLanguage, t } from '../shared/i18n';

export interface PlaceText {
  /** «cerca de Lyon (Francia)» / «a 340 km al NE de Madrid». */
  text: string;
  /** «Lyon», or «la zona situada a 340 km al NE de Madrid» when there is no place (a noun phrase either way). */
  name: string;
  /** True when `name` is a place's name; false when there is no place nearby (then `text` is the bare bearing). */
  named: boolean;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function placeName(p: { nameEs: string; nameEn: string }): string {
  return getLanguage() === 'es' ? p.nameEs : p.nameEn || p.nameEs;
}

/** Country (Natural Earth) under a point, '' at sea. */
function countryAt(view: GameView, lat: number, lon: number): string {
  const w = view.world;
  if (!w) return '';
  const tile = latLonToTile(lat, lon);
  return countryName(w.countries[w.country[tile]]);
}

/** `capitalTile` overrides the viewer's capital (verification: the «junto a tu capital» case far from any place). */
export function describePlace(view: GameView, lat: number, lon: number, viewer = HUMAN_ID, capitalTile?: number): PlaceText {
  const p = nearestPlace(lat, lon, 150);
  if (p) {
    const name = placeName(p);
    const country = countryAt(view, p.lat, p.lon);
    const text = country && country !== name ? t('place.near', { place: name, country }) : t('place.nearSame', { place: name });
    return { text, name, named: true };
  }
  const cap = capitalTile ?? view.players[viewer]?.capitalTile ?? -1;
  if (cap >= 0) {
    const c = tileToLatLon(cap);
    const cp = nearestPlace(c.lat, c.lon, 120);
    const from = cp ? placeName(cp) : t('place.yourCapital');
    const rawKm = placeKm(c.lat, c.lon, lat, lon);
    // At the capital itself a bearing reads as nonsense («a 0 km al N de tu capital»): name the capital instead, by its
    // place name or as «tu capital». Either way `name` is a noun a sentence can use («hacia tu capital»), so named.
    if (rawKm < 25) {
      const text = t('place.besideCapital', { from });
      return { text, name: from, named: true };
    }
    const km = Math.round(rawKm / 10) * 10;
    const y = Math.sin((lon - c.lon) * Math.PI / 180) * Math.cos(lat * Math.PI / 180);
    const x = Math.cos(c.lat * Math.PI / 180) * Math.sin(lat * Math.PI / 180) - Math.sin(c.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.cos((lon - c.lon) * Math.PI / 180);
    const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const dir = t(`place.dir.${DIRS[Math.round(brg / 45) % 8]}`);
    const text = t('place.bearing', { km: formatNumber(km), dir, from });
    return { text, name: t('place.area', { where: text }), named: false };
  }
  const country = countryAt(view, lat, lon);
  const text = country ? t('place.inCountry', { country }) : t('place.atSea');
  return { text, name: t('place.area', { where: text }), named: false };
}

/** Compass point (a translated «N», «NE»…) and the great-circle km from (lat0, lon0) to (lat1, lon1). */
function bearing(lat0: number, lon0: number, lat1: number, lon1: number): { km: number; dir: string } {
  const y = Math.sin((lon1 - lon0) * Math.PI / 180) * Math.cos(lat1 * Math.PI / 180);
  const x = Math.cos(lat0 * Math.PI / 180) * Math.sin(lat1 * Math.PI / 180) - Math.sin(lat0 * Math.PI / 180) * Math.cos(lat1 * Math.PI / 180) * Math.cos((lon1 - lon0) * Math.PI / 180);
  const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { km: placeKm(lat0, lon0, lat1, lon1), dir: t(`place.dir.${DIRS[Math.round(brg / 45) % 8]}`) };
}

const roundKm = (km: number): number => (km < 100 ? Math.max(10, Math.round(km / 5) * 5) : Math.round(km / 10) * 10);

/**
 * Gauntlet round 1: `to` described so it never repeats `fromName`, the place just named for another point (a lost
 * capital, an objective reached). Its own nearest place when that is a different one; otherwise the distance and
 * bearing from `fromName`'s point: «a 60 km al N de Madrid».
 */
export function describeApartFrom(view: GameView, from: { lat: number; lon: number }, fromName: string, to: { lat: number; lon: number }): PlaceText {
  const own = describePlace(view, to.lat, to.lon);
  if (own.name !== fromName) return own;
  const b = bearing(from.lat, from.lon, to.lat, to.lon);
  const text = b.km < 15 ? t('place.nearSame', { place: fromName }) : t('place.bearing', { km: formatNumber(roundKm(b.km)), dir: b.dir, from: fromName });
  return { text, name: text, named: false };
}

/**
 * Gauntlet round 1: where a new objective lies past the one just reached, without naming the same town twice: «120 km
 * más al N, hacia Nantes» (the nearest other place ahead within 250 km of the new point) or «120 km más al N».
 */
export function describeBeyond(view: GameView, x0: number, y0: number, x1: number, y1: number): { from: string; to: string } {
  const a = tileXYToLatLon(x0, y0), b = tileXYToLatLon(x1, y1);
  const from = describePlace(view, a.lat, a.lon), to = describePlace(view, b.lat, b.lon);
  if (to.name !== from.name) return { from: from.text, to: to.text };
  const g = bearing(a.lat, a.lon, b.lat, b.lon);
  const ahead = nearestPlace(b.lat, b.lon, 250, (p) => placeName(p) === from.name
    || placeKm(a.lat, a.lon, p.lat, p.lon) <= placeKm(a.lat, a.lon, b.lat, b.lon) * 0.8);
  const km = formatNumber(roundKm(g.km));
  return { from: from.text, to: ahead ? t('place.beyondToward', { km, dir: g.dir, place: placeName(ahead) }) : t('place.beyond', { km, dir: g.dir }) };
}

/**
 * A place to name a front by (W6): the nearest place to its middle within 150 km, else the nearest to any point of its
 * contact line within 150 km, else the nearest place within 450 km of its middle with the compass direction from it
 * («al NE de Poltava»). Null when nothing is within 450 km (open steppe, desert, ice).
 */
export function frontPlace(f: { x: number; y: number; samples: ArrayLike<number> }): { name: string; dir: string | null } | null {
  const mid = tileXYToLatLon(f.x, f.y);
  let p = nearestPlace(mid.lat, mid.lon, 150);
  if (!p) {
    let best: ReturnType<typeof nearestPlace> = null;
    for (let i = 0; i + 1 < f.samples.length; i += 2) {
      const ll = tileXYToLatLon(f.samples[i], f.samples[i + 1]);
      const q = nearestPlace(ll.lat, ll.lon, 150);
      if (q && (!best || q.km < best.km)) best = q;
    }
    p = best;
  }
  if (p) return { name: placeName(p), dir: null };
  const q = nearestPlace(mid.lat, mid.lon, 450);
  if (!q) return null;
  const y = Math.sin((mid.lon - q.lon) * Math.PI / 180) * Math.cos(mid.lat * Math.PI / 180);
  const x = Math.cos(q.lat * Math.PI / 180) * Math.sin(mid.lat * Math.PI / 180) - Math.sin(q.lat * Math.PI / 180) * Math.cos(mid.lat * Math.PI / 180) * Math.cos((mid.lon - q.lon) * Math.PI / 180);
  const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return { name: placeName(q), dir: t(`place.dir.${DIRS[Math.round(brg / 45) % 8]}`) };
}

/**
 * The viewer's capital as a noun phrase for the capital alerts: «tu capital, Madrid» (a place within 25 km), «tu
 * capital, cerca de Esmirna» (within 150 km) or «tu capital» — never a nearby town standing in for the capital.
 */
export function capitalPhrase(view: GameView, viewer = HUMAN_ID): string {
  const cap = view.players[viewer]?.capitalTile ?? -1;
  if (cap < 0) return t('place.yourCapital');
  const c = tileToLatLon(cap);
  const p = nearestPlace(c.lat, c.lon, 150);
  if (!p) return t('place.yourCapital');
  return t(placeKm(c.lat, c.lon, p.lat, p.lon) < 25 ? 'place.capitalIs' : 'place.capitalNear', { place: placeName(p) });
}

export function describeTile(view: GameView, tile: number, viewer = HUMAN_ID): PlaceText {
  const ll = tileToLatLon(tile);
  return describePlace(view, ll.lat, ll.lon, viewer);
}

export function describeXY(view: GameView, x: number, y: number, viewer = HUMAN_ID): PlaceText {
  const ll = tileXYToLatLon(x, y);
  return describePlace(view, ll.lat, ll.lon, viewer);
}

