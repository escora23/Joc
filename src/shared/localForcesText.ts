// FRONT ULTRA — texts for the shared local forces (src/shared/localForces.ts). Main thread only.
// `LocalForceSide.source` is one of these keys; its params carry {troops} (strategic troops in the zone) and
// {soldiers}. Consumers format the number and may prefix the front's name (ui/hud frontName).

import { formatNumber, registerDictionary, t } from './i18n';
import type { LocalForceSide } from './localForces';

registerDictionary('es', {
  'lf.src.front': 'Guarnición del frente · {troops} tropas en la zona',
  'lf.src.frontAt': 'Guarnición del {front} · {troops} tropas en la zona',
  'lf.src.offensive': 'Ofensiva en curso · {troops} tropas en la zona',
  'lf.src.offensiveAt': 'Ofensiva en el {front} · {troops} tropas en la zona',
  'lf.src.rear': 'Guarnición de retaguardia · {troops} tropas en la zona',
  'lf.src.posts': 'Puestos defensivos · {troops} tropas en la zona',
  'lf.src.none': 'Sin tropas en la zona',
});

registerDictionary('en', {
  'lf.src.front': 'Front garrison · {troops} troops in the area',
  'lf.src.frontAt': 'Garrison of the {front} · {troops} troops in the area',
  'lf.src.offensive': 'Offensive under way · {troops} troops in the area',
  'lf.src.offensiveAt': 'Offensive on the {front} · {troops} troops in the area',
  'lf.src.rear': 'Rear garrison · {troops} troops in the area',
  'lf.src.posts': 'Defense posts · {troops} troops in the area',
  'lf.src.none': 'No troops in the area',
});

/**
 * «Guarnición del Frente de Lyon · 1.840 tropas en la zona». `frontLabel` is the front's name as the HUD writes it
 * («Frente de Lyon» / «Lyon front»); without it the generic wording is used.
 */
export function localSideText(s: LocalForceSide, frontLabel?: string): string {
  const troops = formatNumber(Math.round(Number(s.sourceParams.troops ?? 0)));
  const atKey = `${s.source}At`;
  if (frontLabel && (s.source === 'lf.src.front' || s.source === 'lf.src.offensive')) {
    return t(atKey, { troops, front: lowerFirst(frontLabel) });
  }
  return t(s.source, { troops });
}

function lowerFirst(s: string): string {
  // The front's name continues the sentence: «Guarnición del frente de Lyon», «the front 370 km NW of Madrid».
  return /^(Frente|Front) /.test(s) ? 'f' + s.slice(1) : s;
}
