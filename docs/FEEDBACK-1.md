# Player feedback #1 (owner of the project, after playing the integration build)

This is the verbatim feedback from the project owner after playing the first playable build, followed by the
structured interpretation every agent must work from. The owner is Spanish-speaking; the verbatim text is Spanish.

## Verbatim

> varias cosas que me he dado cuenta probando el que me has pasado : todas las unidades Como Barcos, trenes etc.., van muy rapido en velocidad normal, otra Cosa con los Barcos es que el Trail que dejan deberia de empezar desdde que sale el Barco hasta que llega con el Color del Player, tambien cuando por ejemplo haces click sobre un jugador para conquistarlo y lo conquistas poco a poco, si es mucho mas masivo que tu y te tira todas sus tropas no hay animacion de un frame al otro se conquista toda tu zona sin que te de tiempo a Hacer nada, otra Cosa que vendria bien es que cuando quitas zoon que salgan sprites en Vez de los modelos 3d asi se ve todo mas claro o algun arreglo mejor. Laz zonas conquistadas o por conquistar o terriotrios si pasan nubes por encima no se ven del todo bien, hay islas pequeñas que hasta que no pasas el cursos por encima no sabes que están ahi. El tema del control de los vehiculos va un poco... además que es dificil empezar a controlar tus vehiculos o enviarlos a donde quieres y que no participan activamente en las batallas o al menos es dificil ver como... lo de los tanques cuando le das parece una mision aparte, es decir le das a controlar aunque estes en tu territorio y derepente estas en un campo de batalla? si se supone que está en el terriotrio y no nos atacan no entyiendo el porque, es decir yo tendria que poder controlar un tanque de una punta de mi terriotrio a otro y si quiero pasar la frontera con otro pais y a ellos llegarles una alerta y si quieren enviarme a alguien que me lo envien o no... no se si me explico, tendria que ver los ejercitos reales, no minijuegos predefinidos.... Todo pasa muy rapido, los vehiculos no parece que tengan una utilidad real, el terriotrio mal delineado, las batallas son rapidas y poco claras, no sabes muy bien de quien es que territorio, de repente te atacan y no tienes tiempo a responder, no sabes donde te estan atacando y te conquistan en menos de dos segundos un huevo de terriotorio... pierde lo realista del juego sabes, no se si me explico.... encima misil por aqui misil por alla, mola que haya bombardeos y tal, pero con sentido, es como que todo está bien hecho pero no está bien juntado.... Falta poder hablar con otras naciones en plan de poder hacer una alinaza tranquilamente y que si me la rechaza o me ataque tenga tiempo a pensar que hacer, o si me envian barcos o tanques o cosas asi, que de tiempo a pensar que hacer, es decir, tiene que ser como un simulador de la vida real asi de forma dicho un poco bruta. No tanto un call of duty que todo el rato matas matas y matas... Acaba de one-shotear el juego, no solo tengas en cuenta las cosas en las que me he fijado, sino arregla todos los aspectos del juego que creas que hay que mejorar, arreglar o cambiar y todo eso. Porcierto el modelo 3d de infraestructuras muchas veces está de lado sobre el territorio, o atraviesa la mitad el suelo o cosas así, encima cuando lo mejoras no se ve una mejora real ni en el funcionamiento ni en el modelado. Es como que todo está mal explicado y hay cosas que están por estar. No se si me explico. RAZONA Y ACABA DE ONE-SHOTEAR EL JUEGO, REVISA LA CONVERSACION DE NUEVO, NO TENGO PRISA, QUIERO QUE LO HAGAS BIEN. Por otra parte, muy contento con el trabajo hasta ahora

## What it means (every item is a hard requirement)

The core verdict: **"everything is well made but not well put together"**. The game must stop feeling like a
frantic arcade shooter and feel like a **real-world geopolitical/war simulator**: deliberate pace, readable
situation, time to think and react, every unit and building with a clear, visible purpose, and one coherent world.

1. **Pace is far too fast.** Ships, trains, planes and all units move far too fast at 1x. Conquest, battles and
   events happen too fast. Define a coherent time scale and slow everything to it.
2. **Ship route trails**: a ship's trail must be drawn in the owner's color along its whole route, from the port it
   left to where it arrives (and fade after).
3. **Conquest must be animated and bounded**: a far bigger enemy throwing all its troops must NOT swallow your
   territory from one frame to the next. Fronts advance progressively and visibly; the defender always has time
   to see where the attack is and respond.
4. **Zoomed out, show clear 2D icons/sprites instead of 3D models** (or a better solution) so the map is readable.
5. **Clouds must not hide territories**: owned / contested / neutral land must stay readable under clouds.
6. **Small islands must be visible** without hovering the cursor over them.
7. **Vehicle control is poor**: hard to start controlling your vehicles, hard to send them where you want, they do
   not visibly take part in battles.
8. **Command mode must not be a separate scripted mission.** Taking control of a tank inside your own territory,
   with no enemies around, must put you in YOUR territory at the unit's real position, peacefully. You must be able
   to drive it from one end of your country to the other, and if you cross a border the other nation gets an alert
   and decides whether to send forces to meet you. You fight the real armies of the simulation, not predefined
   mini-games.
9. **Units must have a real, understandable use** in the strategy game.
10. **Territory must be clearly delineated**: always obvious who owns what.
11. **Battles must be slower and clear**: where they are, who is fighting whom, who is winning.
12. **Attacks on you must be announced and located**: you must know where you are being attacked and have time to
    respond.
13. **Missiles and bombings must make sense**: tied to wars, escalation and reasons, not random missiles everywhere.
14. **Real diplomacy**: talk to nations calmly, propose alliances, receive answers with reasons; if they reject you
    or attack you, or send ships/tanks, you have time to think what to do.
15. **3D infrastructure models are broken**: sometimes lying sideways on the territory or half sunk into the ground.
    Upgrading must show a real visible improvement in both function and model.
16. **Things are badly explained and some things exist "just because"**: every mechanic must be explained in-game
    (tooltips, help, feedback) and have a reason to exist; remove or rework what doesn't.
17. Beyond this list: fix and improve **every other aspect** a demanding player would notice.

## Clarification from the owner (after seeing the icon layer)

> "como que has quitado el modelo 3d?? yo no te he pedido eso"

The 3D models must NOT be removed. Item 4 only asks for 2D icons/sprites **when zoomed out**. When the camera is
close, every unit and structure must show its proper, well-made 3D model, clearly visible, correctly grounded
(item 15) and with visible upgrade levels. Critics must check close-up views explicitly: if models are too small,
invisible or missing at close zoom, that is a blocker.
