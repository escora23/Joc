// FRONT ULTRA — texts for the sim's `msg.*` message keys (owner: sim-core). Main thread only.
// Registered by the sim client before the UI creates its own dictionaries, so the UI (which owns the final
// wording) can override any of them. Params are resolved by the client: {playerName}, {structureName}, {weaponName}.

import { registerDictionary } from '../shared/i18n';

const es: Record<string, string> = {
  'msg.allianceExpiring': 'La alianza con {playerName} está a punto de expirar',
  'msg.allyTarget': 'Tu aliado te pide atacar a {playerName}',
  'msg.baseFull': 'Base llena: tu {structureName} no tiene plazas libres',
  'msg.betrayed': '¡{playerName} ha roto vuestra alianza!',
  'msg.boatSunk': 'Nuestro transporte ha sido hundido',
  'msg.buildCoastal': 'Debe construirse en la costa',
  'msg.buildFallout': 'Zona radiactiva: no se puede construir',
  'msg.buildOccupied': 'Ya hay una estructura aquí',
  'msg.buildOwnLand': 'Solo puedes construir en tu territorio',
  'msg.buildTooClose': 'Demasiado cerca de otra estructura',
  'msg.cannotAllyTribe': 'Las tribus no firman alianzas',
  'msg.cannotAttackAlly': 'No puedes atacar a un aliado',
  'msg.cannotBuild': 'No se puede construir aquí',
  'msg.cannotNukeAlly': 'No puedes lanzar armas contra un aliado',
  'msg.capitalLost': '¡Hemos perdido la capital!',
  'msg.cooldown': 'Todavía no está listo',
  'msg.donateAlliesOnly': 'Solo puedes donar a tus aliados',
  'msg.invalidTarget': 'Objetivo no válido',
  'msg.maxBoats': 'Demasiados transportes en el mar',
  'msg.maxLevel': 'Nivel máximo alcanzado',
  'msg.noBorder': 'No tienes frontera con esa nación',
  'msg.noCoast': 'No hay costa alcanzable',
  'msg.noNeutralLand': 'No hay tierra libre junto a tu frontera',
  'msg.noPath': 'No hay ruta marítima hasta allí',
  'msg.noProducer': 'Necesitas un {structureName} operativo',
  'msg.noProducer.m': 'Necesitas un {structureName} operativo',
  'msg.noProducer.f': 'Necesitas una {structureName} operativa',
  // Per structure (the client picks these by the structure's id), so every sentence agrees in gender and number.
  'msg.noProducer.port': 'Necesitas un puerto operativo',
  'msg.noProducer.factory': 'Necesitas una fábrica operativa',
  'msg.noProducer.samSite': 'Necesitas una batería SAM operativa',
  'msg.noProducer.missileSilo': 'Necesitas un silo de misiles operativo',
  'msg.noProducer.airbase': 'Necesitas una base aérea operativa',
  'msg.noProducer.armyBase': 'Necesitas una base del ejército operativa',
  'msg.noProducer.navalYard': 'Necesitas un astillero naval operativo',
  'msg.divisionBlocked': 'La división se ha detenido: el terreno por delante ya no es transitable (cambió de manos o no hay paso)',
  'msg.noSilo': 'Necesitas un silo de misiles',
  'msg.notEnoughGold': 'Oro insuficiente',
  'msg.notEnoughTroops': 'Tropas insuficientes',
  'msg.notSpawned': 'Primero funda tu capital',
  'msg.notYet': 'Todavía no',
  'msg.nukeHit': '¡Impacto de {weaponName} en nuestro territorio!',
  'msg.nukeInbound': '¡{weaponName} en camino hacia nosotros!',
  'msg.nukeIntercepted': '{weaponName} interceptado',
  'msg.nukesDisabled': 'Las armas nucleares están desactivadas en esta partida',
  'msg.outOfRange': 'Fuera de alcance',
  'msg.siloCooldown': 'Los silos están recargando',
  'msg.spawnInvalid': 'Elige un punto de tierra firme',
  'msg.spawnTaken': 'Esa tierra ya tiene dueño',
  'msg.structureCaptured': 'El enemigo ha capturado nuestro {structureName}',
  'msg.structureCaptured.m': 'El enemigo ha capturado nuestro {structureName}',
  'msg.structureCaptured.f': 'El enemigo ha capturado nuestra {structureName}',
  'msg.structureLost': 'Hemos perdido un {structureName}',
  'msg.structureLost.m': 'Hemos perdido un {structureName}',
  'msg.structureLost.f': 'Hemos perdido una {structureName}',
  'msg.tradeCaptured': 'Un buque mercante ha sido capturado',
  'msg.underConstruction': 'Todavía en construcción',
};

const en: Record<string, string> = {
  'msg.allianceExpiring': 'Your alliance with {playerName} is about to expire',
  'msg.allyTarget': 'Your ally asks you to attack {playerName}',
  'msg.baseFull': 'Base full: {structureName} has no free slots',
  'msg.betrayed': '{playerName} has broken your alliance!',
  'msg.boatSunk': 'Our transport ship was sunk',
  'msg.buildCoastal': 'Must be built on the coast',
  'msg.buildFallout': 'Radioactive zone: cannot build',
  'msg.buildOccupied': 'There is already a structure here',
  'msg.buildOwnLand': 'You can only build on your own land',
  'msg.buildTooClose': 'Too close to another structure',
  'msg.cannotAllyTribe': 'Tribes do not sign alliances',
  'msg.cannotAttackAlly': 'You cannot attack an ally',
  'msg.cannotBuild': 'Cannot build here',
  'msg.cannotNukeAlly': 'You cannot fire weapons at an ally',
  'msg.capitalLost': 'Our capital has fallen!',
  'msg.cooldown': 'Not ready yet',
  'msg.donateAlliesOnly': 'You can only donate to allies',
  'msg.invalidTarget': 'Invalid target',
  'msg.maxBoats': 'Too many transports at sea',
  'msg.maxLevel': 'Maximum level reached',
  'msg.noBorder': 'You do not border that nation',
  'msg.noCoast': 'No reachable coast',
  'msg.noNeutralLand': 'No free land along your border',
  'msg.noPath': 'No sea route to that place',
  'msg.noProducer': 'You need an operational {structureName}',
  'msg.noProducer.port': 'You need an operational port',
  'msg.noProducer.factory': 'You need an operational factory',
  'msg.noProducer.samSite': 'You need an operational SAM battery',
  'msg.noProducer.missileSilo': 'You need an operational missile silo',
  'msg.noProducer.airbase': 'You need an operational airbase',
  'msg.noProducer.armyBase': 'You need an operational army base',
  'msg.noProducer.navalYard': 'You need an operational naval yard',
  'msg.divisionBlocked': 'The division has stopped: the land ahead can no longer be crossed (it changed hands or there is no passage)',
  'msg.noSilo': 'You need a missile silo',
  'msg.notEnoughGold': 'Not enough gold',
  'msg.notEnoughTroops': 'Not enough troops',
  'msg.notSpawned': 'Found your capital first',
  'msg.notYet': 'Not yet',
  'msg.nukeHit': '{weaponName} impact on our territory!',
  'msg.nukeInbound': '{weaponName} inbound!',
  'msg.nukeIntercepted': '{weaponName} intercepted',
  'msg.nukesDisabled': 'Nuclear weapons are disabled in this game',
  'msg.outOfRange': 'Out of range',
  'msg.siloCooldown': 'Silos are reloading',
  'msg.spawnInvalid': 'Pick a point on dry land',
  'msg.spawnTaken': 'That land is already taken',
  'msg.structureCaptured': 'The enemy captured our {structureName}',
  'msg.structureLost': 'We lost a {structureName}',
  'msg.tradeCaptured': 'A trade ship was captured',
  'msg.underConstruction': 'Still under construction',
};

/** Fallback structure/unit names when the UI dictionary lacks them. */
export const FALLBACK_NAMES_ES: Record<string, string> = {
  'structure.city': 'Ciudad', 'structure.port': 'Puerto', 'structure.factory': 'Fábrica',
  'structure.defensePost': 'Puesto defensivo', 'structure.samSite': 'Batería SAM', 'structure.missileSilo': 'Silo de misiles',
  'structure.airbase': 'Base aérea', 'structure.armyBase': 'Base militar', 'structure.navalYard': 'Astillero naval',
  'structure.radar': 'Radar', 'unit.atomBomb': 'Bomba atómica', 'unit.hydrogenBomb': 'Bomba de hidrógeno', 'unit.mirv': 'MIRV',
  'unit.mirvWarhead': 'Ojiva MIRV', 'unit.cruiseMissile': 'Misil de crucero',
};
export const FALLBACK_NAMES_EN: Record<string, string> = {
  'structure.city': 'City', 'structure.port': 'Port', 'structure.factory': 'Factory', 'structure.defensePost': 'Defense Post',
  'structure.samSite': 'SAM Site', 'structure.missileSilo': 'Missile Silo', 'structure.airbase': 'Airbase',
  'structure.armyBase': 'Army Base', 'structure.navalYard': 'Naval Yard', 'structure.radar': 'Radar',
  'unit.atomBomb': 'Atom bomb', 'unit.hydrogenBomb': 'Hydrogen bomb', 'unit.mirv': 'MIRV', 'unit.mirvWarhead': 'MIRV warhead',
  'unit.cruiseMissile': 'Cruise missile',
};

let registered = false;
export function registerSimStrings(): void {
  if (registered) return;
  registered = true;
  registerDictionary('es', { ...FALLBACK_NAMES_ES, ...es });
  registerDictionary('en', { ...FALLBACK_NAMES_EN, ...en });
}

/** Test tooling: the sim's own dictionaries (tools/i18n-check). */
export const SIM_STRINGS = { es, en };
