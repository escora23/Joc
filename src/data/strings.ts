// FRONT ULTRA — data-layer i18n strings (owner: data). Loading-screen stage labels and debug-shot legends.

import { registerDictionary } from '../shared/i18n';

const ES: Record<string, string> = {
  'data.download': 'Descargando imágenes de satélite',
  'data.decode': 'Descodificando mapas de la NASA',
  'data.water': 'Leyendo máscara oceánica',
  'data.relief': 'Leyendo relieve',
  'data.coast': 'Midiendo costas',
  'data.biomes': 'Clasificando biomas',
  'data.countries': 'Trazando fronteras',
  'data.aux': 'Preparando terreno local',
  'data.done': 'Mapa listo',
  'data.debug.political': 'Mapa político',
  'data.debug.terrain': 'Clases de terreno',
  'data.debug.biome': 'Biomas',
  'data.debug.coast': 'Distancia a la costa',
};

const EN: Record<string, string> = {
  'data.download': 'Downloading satellite imagery',
  'data.decode': 'Decoding NASA maps',
  'data.water': 'Reading ocean mask',
  'data.relief': 'Reading relief',
  'data.coast': 'Measuring coastlines',
  'data.biomes': 'Classifying biomes',
  'data.countries': 'Drawing borders',
  'data.aux': 'Preparing local terrain',
  'data.done': 'Map ready',
  'data.debug.political': 'Political map',
  'data.debug.terrain': 'Terrain classes',
  'data.debug.biome': 'Biomes',
  'data.debug.coast': 'Distance to coast',
};

let done = false;
export function registerDataStrings(): void {
  if (done) return;
  done = true;
  registerDictionary('es', ES);
  registerDictionary('en', EN);
}
