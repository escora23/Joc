// FRONT ULTRA — place names for alerts, fronts and the nations panel (DESIGN_V2 §8.4; owner: ui, built by W3).
//
// describePlace(view, lat, lon) → «cerca de Lyon (Francia)» from the nearest place of src/data/places.ts within 150 km
// and the Natural Earth country under the point; otherwise «a 340 km al NE de Madrid», the bearing and distance from
// the viewer's capital (named by its own nearest place). Every located alert and front name uses it.

import { nearestPlace, placeKm } from '../data/places';
import { HUMAN_ID, MAP_W } from '../shared/constants';
import type { GameView } from '../shared/api';
import { latLonToTile, tileToLatLon, tileXYToLatLon } from '../shared/geo';
import { countryName, formatNumber, getLanguage, t } from '../shared/i18n';

export interface PlaceText {
  /** «cerca de Lyon (Francia)» / «a 340 km al NE de Madrid». */
  text: string;
  /** «Lyon» (or the bearing text when there is no place). */
  name: string;
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

export function describePlace(view: GameView, lat: number, lon: number, viewer = HUMAN_ID): PlaceText {
  const p = nearestPlace(lat, lon, 150);
  if (p) {
    const name = placeName(p);
    const country = countryAt(view, p.lat, p.lon);
    const text = country && country !== name ? t('place.near', { place: name, country }) : t('place.nearSame', { place: name });
    return { text, name };
  }
  const cap = view.players[viewer]?.capitalTile ?? -1;
  if (cap >= 0) {
    const c = tileToLatLon(cap);
    const cp = nearestPlace(c.lat, c.lon, 120);
    const from = cp ? placeName(cp) : t('place.yourCapital');
    const km = Math.round(placeKm(c.lat, c.lon, lat, lon) / 10) * 10;
    const y = Math.sin((lon - c.lon) * Math.PI / 180) * Math.cos(lat * Math.PI / 180);
    const x = Math.cos(c.lat * Math.PI / 180) * Math.sin(lat * Math.PI / 180) - Math.sin(c.lat * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.cos((lon - c.lon) * Math.PI / 180);
    const brg = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
    const dir = t(`place.dir.${DIRS[Math.round(brg / 45) % 8]}`);
    const text = t('place.bearing', { km: formatNumber(km), dir, from });
    return { text, name: text };
  }
  const country = countryAt(view, lat, lon);
  const text = country ? t('place.inCountry', { country }) : t('place.atSea');
  return { text, name: text };
}

export function describeTile(view: GameView, tile: number, viewer = HUMAN_ID): PlaceText {
  const ll = tileToLatLon(tile);
  return describePlace(view, ll.lat, ll.lon, viewer);
}

export function describeXY(view: GameView, x: number, y: number, viewer = HUMAN_ID): PlaceText {
  const ll = tileXYToLatLon(x, y);
  return describePlace(view, ll.lat, ll.lon, viewer);
}

/** Tile of continuous tile coords (wrapped). */
export function xyTile(x: number, y: number): number {
  const tx = ((Math.floor(x) % MAP_W) + MAP_W) % MAP_W;
  return Math.max(0, Math.floor(y)) * MAP_W + tx;
}
