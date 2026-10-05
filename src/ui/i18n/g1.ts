// FRONT ULTRA — texts of the gauntlet round 1 UI fixes (hover / offensive dialog / Guerra panel forecast, capital and
// objective places, diplomatic answers in words, folded order refusals, alert feed, leaderboard of nations).
// Spanish is the default; English complete. Registered last, so a key here replaces an older wording.

export const esG1: Record<string, string> = {
  // ---- one forecast of an offensive (offensiveForecast.ts) -------------------------------------------------------
  'g1.ground.plains': 'llano',
  'g1.ground.hills': 'colinas',
  'g1.ground.mountains': 'montaña',
  'g1.ground.river': 'llano con ríos',
  'g1.ground.high': 'alta montaña',
  'g1.limitBy.plains': 'la velocidad máxima de avance y la logística',
  'g1.limitBy.hills': 'el terreno de colinas',
  'g1.limitBy.mountains': 'el terreno de montaña',
  'g1.limitBy.river': 'los ríos de ese tramo',
  'g1.limitBy.high': 'la alta montaña',
  'g1.off.corridor': '{km} km (el frente mide {front} km)',
  'g1.off.kmh': '≈ {v} km/h en {ground}',
  'g1.off.limit.ground': 'Limitado por {limit}: máx. ≈ {cap} km/h. Por encima de 3 : 1 más tropas no aceleran el avance: ensanchan el ataque (hasta lo que mide el frente) y reducen tus bajas.',
  'g1.off.limit.plains': 'Ya avanza al máximo (≈ {cap} km/h; lo limitan {limit}). Por encima de 3 : 1 más tropas no aceleran: ensanchan el ataque (hasta lo que mide el frente) y reducen tus bajas.',
  'g1.tt.offensive': 'CLIC: preparar ofensiva con {n} ({p} %): relación {r} : 1 · ataque de {km} km de ancho · avance ≈ {v} km/h en {ground} · MAYÚS+CLIC: lanzarla ya',
  'g1.tt.reinforce': 'CLIC: reforzar nuestra ofensiva con {n} ({p} %): relación {r} : 1 · ataque de {km} km de ancho · avance ≈ {v} km/h en {ground} · MAYÚS+CLIC: enviarlas ya',
  'g1.tt.capped': 'más tropas no aceleran: el ritmo lo marca {limit}',
  'g1.fr.capped': 'al máximo que permite {limit}',
  'fr.own': 'Tu ofensiva: {troops} · {intensity} · relación {ratio} : 1 · ataque de {km} km · {state}',

  // ---- places that never repeat themselves -------------------------------------------------------------------
  'place.beyond': '{km} km más al {dir}',
  'place.beyondToward': '{km} km más al {dir}, hacia {place}',
  'alert.capitalLost.movedBearing': 'La capital se traslada {where}. {name} se hace con el botín.',

  // ---- diplomatic answers in words; the figures go to the tooltip ------------------------------------------------
  'answer.trust.close': 'Aún no confiamos lo bastante en ti; un gesto más nos convencería',
  'answer.trust.far': 'Todavía no confiamos en ti; harán falta tiempo y gestos de buena voluntad',
  'answer.trust.none': 'No nos fiamos de ti en absoluto',
  'answer.trust.close.gold': 'Tu oro ayuda, pero aún no confiamos lo bastante en ti; un gesto más nos convencería',
  'answer.trust.far.gold': 'Tu oro no basta: todavía no confiamos en ti',
  'answer.trust.none.gold': 'Ningún oro compra nuestra confianza ahora mismo',
  'answer.lowOpinion': 'Opinión de ti: {score}; para aceptar hace falta {need}',
  'answer.lowOpinionGold': 'Opinión de ti: {base}, +{value} por tu oro = {score}; para aceptar hace falta {need}',
  'answer.goodRelations.say': 'Nuestras relaciones son buenas',
  'answer.noQuarrel.say': 'No tenemos nada contra vosotros',
  'answer.exhausted.say': 'Nuestro pueblo está agotado por la guerra',
  'answer.winning.say': 'Vamos ganando esta guerra',
  'answer.notTired.say': 'Todavía podemos luchar',
  'answer.losing.say': 'La guerra está perdida para nosotros',
  'answer.canResist.say': 'Aún podemos resistir',
  'g1.answer.detail': 'Las cifras de su respuesta',

  // ---- one line per refused order ---------------------------------------------------------------------------
  'g1.order.refusedAll': 'Orden rechazada para {n} unidades: {why}',
  'g1.order.refusedSome': '{n} de {m} unidades no cumplen la orden: {why}',

  // ---- alert feed ----------------------------------------------------------------------------------------------
  'g1.alerts.more': '+{n} avisos más',
  'g1.alerts.more.tip': 'Solo se ven los cuatro avisos más graves y recientes; los demás siguen aquí y en el Registro (campana). Clic para abrir el Registro.',

  // ---- leaderboard -----------------------------------------------------------------------------------------------
  'g1.lb.tribes': 'Territorios independientes',
  'g1.lb.tribesN': 'Independientes ({n})',
  'g1.lb.tribes.tip': 'Milicias sin Estado: no hacen diplomacia ni atacan a nadie, solo defienden su tierra. No cuentan en la clasificación de naciones. Columnas: cuántos territorios quedan, su parte de la tierra emergida y sus tropas en total. Clic para ver las mayores.',
};

export const enG1: Record<string, string> = {
  'g1.ground.plains': 'plains',
  'g1.ground.hills': 'hills',
  'g1.ground.mountains': 'mountains',
  'g1.ground.river': 'river country',
  'g1.ground.high': 'high mountains',
  'g1.limitBy.plains': 'the top speed of an advance and its logistics',
  'g1.limitBy.hills': 'the hilly ground',
  'g1.limitBy.mountains': 'the mountain terrain',
  'g1.limitBy.river': 'the rivers on that stretch',
  'g1.limitBy.high': 'the high mountains',
  'g1.off.corridor': '{km} km (the front is {front} km long)',
  'g1.off.kmh': '≈ {v} km/h in {ground}',
  'g1.off.limit.ground': 'Limited by {limit}: at most ≈ {cap} km/h. Above 3 : 1 more troops do not speed the advance up: they widen the attack (up to the length of the front) and cut your casualties.',
  'g1.off.limit.plains': 'Already advancing at full speed (≈ {cap} km/h, set by {limit}). Above 3 : 1 more troops do not speed it up: they widen the attack (up to the length of the front) and cut your casualties.',
  'g1.tt.offensive': 'CLICK: plan an offensive with {n} ({p} %): ratio {r} : 1 · attack {km} km wide · advance ≈ {v} km/h in {ground} · SHIFT+CLICK: launch it now',
  'g1.tt.reinforce': 'CLICK: reinforce our offensive with {n} ({p} %): ratio {r} : 1 · attack {km} km wide · advance ≈ {v} km/h in {ground} · SHIFT+CLICK: send them now',
  'g1.tt.capped': 'more troops will not speed it up: {limit} sets the pace',
  'g1.fr.capped': 'as fast as {limit} allows',
  'fr.own': 'Your offensive: {troops} · {intensity} · ratio {ratio} : 1 · attack {km} km wide · {state}',

  'place.beyond': '{km} km further {dir}',
  'place.beyondToward': '{km} km further {dir}, toward {place}',
  'alert.capitalLost.movedBearing': 'The capital moves to a site {where}. {name} takes the spoils.',

  'answer.trust.close': 'We do not trust you quite enough yet; one more gesture would convince us',
  'answer.trust.far': 'We do not trust you yet; it will take time and some goodwill',
  'answer.trust.none': 'We do not trust you at all',
  'answer.trust.close.gold': 'Your gold helps, but we do not trust you quite enough yet; one more gesture would convince us',
  'answer.trust.far.gold': 'Your gold is not enough: we do not trust you yet',
  'answer.trust.none.gold': 'No amount of gold buys our trust right now',
  'answer.lowOpinion': 'Their opinion of you: {score}; {need} needed to accept',
  'answer.lowOpinionGold': 'Their opinion of you: {base}, +{value} for your gold = {score}; {need} needed to accept',
  'answer.goodRelations.say': 'Our relations are good',
  'answer.noQuarrel.say': 'We have no quarrel with you',
  'answer.exhausted.say': 'Our people are exhausted by the war',
  'answer.winning.say': 'We are winning this war',
  'answer.notTired.say': 'We can still fight',
  'answer.losing.say': 'The war is lost for us',
  'answer.canResist.say': 'We can still resist',
  'g1.answer.detail': 'The figures behind their answer',

  'g1.order.refusedAll': 'Order refused for {n} units: {why}',
  'g1.order.refusedSome': '{n} of {m} units cannot carry out the order: {why}',

  'g1.alerts.more': '+{n} more alerts',
  'g1.alerts.more.tip': 'Only the four most serious and recent alerts are shown; the others are still here and in the Log (bell). Click to open the Log.',

  'g1.lb.tribes': 'Independent territories',
  'g1.lb.tribesN': 'Independent ({n})',
  'g1.lb.tribes.tip': 'Stateless militias: they do no diplomacy and attack nobody, they only defend their land. They are not ranked among the nations. Columns: how many remain, their share of the land and their troops in all. Click to see the largest.',
};
