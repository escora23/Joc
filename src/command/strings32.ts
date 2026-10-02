// FRONT ULTRA — command mode strings for owner item 32 (battles at real scale, shooting, physical damage), es + en.

import { registerDictionary } from '../shared/i18n';

const es: Record<string, string> = {
  'command.battle.title': 'Batalla en la línea contra {nation}',
  'command.battle.sub': 'Intensidad {level} · a la vista {ours} nuestros y {theirs} enemigos (1 figura = 25 soldados)',
  'command.battle.hotSub': 'Lo más duro, a {d} · intensidad {level} · {ours} nuestros, {theirs} enemigos a la vista',
  'command.battle.level.0': 'baja',
  'command.battle.level.1': 'media',
  'command.battle.level.2': 'alta',
  'command.battle.level.3': 'muy alta',
  'command.battle.notice': 'Frente contra {nation}: {theirs} soldados enemigos y {ours} nuestros en {km} km de línea (cada figura son 25). {role}',
  'command.battle.role.attack': 'Nuestra ofensiva avanza en oleadas: apóyala con el cañón.',
  'command.battle.role.defend': 'Defendemos las trincheras: frena sus oleadas.',
  'command.battle.role.hold': 'Frente estable: dos líneas de trincheras intercambian fuego.',
  'command.hit.mgWeak': 'Ametralladora contra {what}: casi no le hace nada ({pct} % en pie). Usa el cañón con explosivo (2) o pide bombarderos.',
  'command.hit.mgCity': 'Ametralladora contra {city}: impactos en fachadas y ventanas, daño mínimo. Para dañarla de verdad, el cañón o la aviación.',
  'command.ram.soldier': 'Atropellado',
  'command.ram.vehicle': 'Embestida: {what} destrozado',
  'command.ram.hurt': 'Embestida: tu carro pierde {n} % de blindaje',
  'command.ram.obstacle': 'Has arrollado {what}',
  'command.ram.fence': 'una valla',
  'command.ram.tree': 'un árbol',
  'command.ram.house': 'una casa',
  'command.ram.peaceTitle': '¿Embestir a {nation}?',
  'command.ram.peaceBody': 'Ese {what} es de {nation}, con quien estás en paz. Arrollarlo es un acto de guerra, igual que dispararle.',
  'command.ram.stop': 'Frenar',
  'command.target.lock': 'BLANCO',
  'command.lead.he': 'apunta aquí',
};

const en: Record<string, string> = {
  'command.battle.title': 'Battle on the line against {nation}',
  'command.battle.sub': 'Intensity {level} · in view {ours} ours and {theirs} enemy (1 figure = 25 troops)',
  'command.battle.hotSub': 'Heaviest fighting {d} away · intensity {level} · {ours} ours, {theirs} enemy in view',
  'command.battle.level.0': 'low',
  'command.battle.level.1': 'medium',
  'command.battle.level.2': 'high',
  'command.battle.level.3': 'very high',
  'command.battle.notice': 'Front against {nation}: {theirs} enemy soldiers and {ours} of ours along {km} km of line (each figure is 25). {role}',
  'command.battle.role.attack': 'Our offensive advances in waves: support it with the cannon.',
  'command.battle.role.defend': 'We hold the trenches: stop their waves.',
  'command.battle.role.hold': 'Stable front: two trench lines trade fire.',
  'command.hit.mgWeak': 'Machine gun on {what}: it barely scratches it ({pct} % standing). Use the cannon with HE (2) or call in bombers.',
  'command.hit.mgCity': 'Machine gun on {city}: hits on walls and windows, minimal damage. To really hurt it, the cannon or aircraft.',
  'command.ram.soldier': 'Run over',
  'command.ram.vehicle': 'Rammed: {what} wrecked',
  'command.ram.hurt': 'Ramming: your tank loses {n} % armour',
  'command.ram.obstacle': 'You flattened {what}',
  'command.ram.fence': 'a fence',
  'command.ram.tree': 'a tree',
  'command.ram.house': 'a house',
  'command.ram.peaceTitle': 'Ram {nation}?',
  'command.ram.peaceBody': 'That {what} belongs to {nation}, at peace with you. Running it over is an act of war, the same as firing on it.',
  'command.ram.stop': 'Brake',
  'command.target.lock': 'TARGET',
  'command.lead.he': 'aim here',
};

let registered = false;
export function registerCommandStrings32(): void {
  if (registered) return;
  registered = true;
  registerDictionary('es', es);
  registerDictionary('en', en);
}
