# FRONT ULTRA v2: qué ha cambiado

Este documento responde, punto por punto, a todo lo que nos dijiste después de jugar (docs/FEEDBACK-1.md): las 17
observaciones de la primera partida, la aclaración sobre los modelos 3D y las rondas de opinión 2 a 5 (puntos 18 a 32).
Para cada punto: **qué cambió** y **cómo verlo en el juego**. Al final, otras mejoras importantes y, con franqueza, lo
que todavía no está como nos gustaría.

Tu veredicto sobre la v1 fue «todo está bien hecho pero no está bien juntado». La v2 no es una lista de parches: es un
rediseño con un solo reloj, un solo modelo de guerra y paz, una sola fuente de cifras para cada frente y el modo mando
dentro del mismo mundo. El diseño completo, con todas las cifras, está en docs/DESIGN_V2.md.

Para seguir las indicaciones de «cómo verlo» basta con empezar una partida (Nueva partida › Fácil › Empezar) y fundar
la capital con «Sugerir un lugar». `F1` abre la ayuda y la enciclopedia en cualquier momento.

---

## Primera partida (puntos 1 a 17)

### 1. Todo iba demasiado rápido

**Qué cambió.** Hay un solo reloj para todo el juego: a 1× **un segundo real es una hora de juego**, y cada unidad se
mueve a su velocidad real en ese reloj. Una división marcha a 40 km/h (antes 82 km por segundo en pantalla), un tren a
100 km/h (antes 317-375), un buque de guerra a 55 km/h (antes 203-225), un mercante a 30 km/h y un convoy de invasión a
35 km/h (antes 253-271). Un frente avanza como mucho a 8 km/h. Los aviones van a su velocidad media de misión (cazas
450 km/h, bombarderos 400 km/h). Velocidades: pausa, 0,5× (nueva), 1×, 2× y 4×. Además:
- **Tiempo de observación**: al acercar la cámara por debajo de ~70 km, el mundo entero pasa a un minuto de juego por
  segundo, para que una batalla vista de cerca se mueva a un ritmo creíble.
- **Tiempo de crisis**: mientras vuela un arma nuclear el reloj se frena igual, a cualquier velocidad.
- Una partida Normal está pensada para 60-120 minutos a 1×, con opciones Corta y Larga en la pantalla de partida.

**Cómo verlo.** El reloj de arriba a la derecha dice «1 s = 1 h»; pasa el ratón por los botones de velocidad. Selecciona
una división y mira su ficha: velocidad en km/h y su equivalencia en pantalla. Acerca la cámara a un frente hasta que
aparezca «OBSERVACIÓN · 1 s = 1 min».

### 2. La estela de los barcos

**Qué cambió.** Cada barco dibuja su ruta con el **color de su dueño**, desde el puerto del que salió hasta donde está,
sin longitud máxima; delante, la ruta que le queda, en discontinuo. Al llegar (o al hundirse) la línea se mantiene 15
segundos y se desvanece; un hundimiento deja una pequeña cruz roja. Las rutas propias y las de quien está en guerra
contigo nunca se borran por falta de espacio. Los convoyes enemigos que van hacia ti tienen la línea con un borde rojo
que late.

**Cómo verlo.** Construye un puerto (`2`) y espera a que zarpe un mercante, o lanza una invasión naval (`B` sobre una
costa): la línea naranja (tu color) sale del puerto y llega hasta el barco.

### 3. Conquistas instantáneas

**Qué cambió.** El modelo de guerra es nuevo. Las conquistas avanzan por **frentes**: un avance máximo de 8 km/h, un
pasillo de ataque cuya anchura depende de las tropas comprometidas, un límite de casillas por instante y la logística.
Las probabilidades importan: por debajo de 1:1 no se avanza, el terreno frena (colinas, montañas, bosques, ríos) y el
defensor tiene una guarnición en cada frente que resiste. Medido sin interfaz: con el doble de tropas, conquistar media
nación del tamaño de la península lleva del orden de 1.000 horas de juego; con diez veces más, más de 600 (antes, 1,6
segundos). La mayor pérdida de una nación en un solo instante está acotada a unas pocas casillas. Entre naciones que no
están en guerra no cambia de manos ni una casilla (salvo tratados, capitulaciones y rebeliones).

**Cómo verlo.** Declara la guerra a un vecino y lanza una ofensiva: el frente avanza casilla a casilla, con la cifra en
km/h en su insignia. Cuando te ataquen a ti, tendrás horas de juego para reforzar el frente amenazado.

### 4. Iconos al alejar la cámara

**Qué cambió.** De lejos, cada unidad y estructura es un **icono 2D** claro con el marco de la convención OTAN según tu
relación con su dueño (propio: rectángulo; aliado: rectángulo discontinuo; en guerra: rombo; otros: cuadrado
redondeado), relleno con el color del dueño, nivel de la estructura en puntos y una barra de integridad cuando está
dañada. Los iconos del mismo dueño muy juntos se agrupan con un número y se despliegan al hacer clic. Entre 1.500 y 250
km los modelos 3D aparecen de forma gradual; por debajo, solo los modelos (ver la aclaración sobre los modelos 3D).

**Cómo verlo.** Aleja la cámara por encima de 1.500 km: iconos. Acércate a una ciudad tuya: el icono deja paso al
modelo.

### 5. Las nubes tapaban los territorios

**Qué cambió.** El ajuste *Nubes* tiene tres modos: **Estratégicas** (por defecto), Realistas y Ocultas. En el modo
estratégico las nubes desaparecen sobre tu territorio y sobre los frentes cuando la cámara está alta, se aclaran
mucho sobre el resto de la tierra y se mantienen sobre el océano, con transiciones suaves (no agujeros con forma de
país). Etiquetas, iconos, islas, frentes y avisos se dibujan siempre por encima de las nubes. Por debajo de ~800 km las
nubes son procedurales y nítidas, sin bloques pixelados.

**Cómo verlo.** Mira tu país desde 5.000 km: se lee entero aunque haya nubes alrededor. Cambia el modo en Ajustes ›
Juego › Nubes.

### 6. Islas pequeñas invisibles

**Qué cambió.** Cada isla pequeña (hasta 20 casillas, unas 480 en el mundo) tiene un **marcador** en pantalla: un anillo
relleno con el color del dueño o blanco si está libre, visible sobre las nubes. Los marcadores muy juntos se agrupan
en un archipiélago con su número. Al pasar el ratón se lee «Malta · 1 casilla · libre», y el clic o `B` actúan sobre la
isla. Las IA colonizan islas con convoyes, así que ya no quedan islas eternamente vacías (Hawái no se ocupaba nunca).

**Cómo verlo.** Mira el Caribe o el Egeo desde 3.000 km.

### 7. Controlar los vehículos era difícil

**Qué cambió.**
- Panel **Fuerzas** (`U`): todas tus unidades, con su misión, estado, tiempo de llegada e integridad, y un asesor que
  señala las unidades sin misión con un botón para darles una.
- Selección clara: clic sobre la unidad o su icono, Mayús para añadir, Mayús + arrastrar para un recuadro, doble clic
  para todas las de su tipo; `I` salta a la siguiente unidad sin misión.
- **Órdenes con clic derecho según el contexto**, con una ficha junto al cursor que dice qué orden se dará, su efecto,
  su riesgo y su tiempo de llegada, o por qué no se puede (en rojo, con el motivo).
- Las unidades participan de verdad en las batallas: una división unida a una ofensiva le suma potencia y velocidad
  (se ve en la vista previa y en la insignia del frente), y en la batalla vista de cerca cada división real cerca del
  frente se dibuja como sus carros y vehículos, en su posición.

**Cómo verlo.** Compra una división en el Arsenal, pulsa `U`, selecciónala y haz clic derecho en tu territorio y
después en un frente en guerra: la ficha cambia de «Mover» a «Unirse a la ofensiva».

### 8. El modo mando era una misión aparte

**Qué cambió.** El modo mando ya no tiene misiones guionizadas: se eliminaron por completo. Al tomar el control (`T`, o
«Al mando» en la ficha) apareces **donde está la unidad**, en tu territorio y en paz si lo estás. Puedes conducir de una
punta del país a otra (viaje acelerado ×10 a ×900 con piloto automático hacia un punto del mapa táctico) y la unidad de
la simulación se mueve contigo. Si te acercas a una frontera, el juego te avisa y pide confirmación antes de cruzar; al
cruzar sin permiso, la otra nación recibe la alerta y decide cómo responder (ver el punto 19). Las fuerzas enemigas que
encuentras son las de la simulación, en su sitio, y lo que destruyes cuenta en el mapa.

**Cómo verlo.** En paz, selecciona tu división, pulsa `T`: estás junto a tu base, «Territorio propio · en paz», con tus
pueblos y carreteras alrededor. Pulsa `M` y haz clic en un destino.

### 9. Unidades sin una utilidad real

**Qué cambió.** Cada unidad y estructura tiene un papel que se nota en la simulación y que su ficha explica (qué hace,
alcance, efecto actual, amenazas). Divisiones: refuerzan ofensivas y defienden sectores. Cazas: patrullas que derriban
bombarderos, drones y misiles, y superioridad aérea que acelera o frena un frente. Bombarderos: destruyen estructuras y
desangran frentes. Drones: apoyo cercano. Buques: bloqueos, escoltas y bombardeo de costa. Radar: anuncia las
incursiones aéreas al despegar. Se eliminó lo que existía «por estar» (los emoticonos, «Marcar objetivo»).

**Cómo verlo.** Pasa el ratón sobre cualquier botón de construcción o abre una ficha de unidad. La enciclopedia (`F1` ›
Enciclopedia) tiene una entrada por cada tipo, con las tablas reales del juego.

### 10. Territorio mal delimitado

**Qué cambió.** Relleno de territorio más fuerte (más alto cuanto más lejos está la cámara) que conserva el relieve;
**fronteras suaves** sin la escalera de casillas, más gruesas para ti; la tierra libre algo apagada para que la ocupada
destaque. Paleta de colores claros, con vecinos separados al menos 30° de tono y ninguna IA con un color parecido al
tuyo. Patrones con un solo significado: aliados (rayado ancho), en disputa (rayas finas animadas), ocupado (punteado).
Las naciones se leen también en el lado de noche. De cerca (8-40 km), el suelo tiene detalle real y cada lado de una
frontera lleva una banda del color de su dueño. Las etiquetas no se solapan ni quedan bajo el HUD.

**Cómo verlo.** Mira Europa desde 3.000 km y luego acércate a una frontera hasta 10 km.

### 11. Batallas rápidas y confusas

**Qué cambió.** Cada frente en guerra se ve desde la órbita como una **banda de dos colores** con chevrones que
apuntan hacia donde va el empuje y una **insignia** con quién ataca, la velocidad del avance, las divisiones de cada
lado y una barra de quién va ganando. Al acercarse aparece la batalla en el suelo: compuesta con los datos reales
(soldados en proporción a las tropas, cada división real dibujada en su posición), la línea en el mismo lugar que en la
simulación, el humo y los fogonazos a lo largo de la línea, y cada mitad del campo en el color de su nación. Una tira de
batalla resume «Frente de Zaragoza · Suiza (ataca) 506.100 ▶ Tú 160.300 (defiende) · avance 1,5 km/h · 2.º día de
combate».

**Cómo verlo.** En guerra, mira el frente desde 1.000 km, luego desde 200 km y por fin desde 20 km.

### 12. Ataques sin aviso ni lugar

**Qué cambió.** Las IA avisan antes de atacarte: tensión, exigencias y ultimátum, con 48-72 horas de juego de margen
según la dificultad. Cuando te atacan, el aviso **dice dónde** («Suiza ataca cerca de Zaragoza (España)»), aparece en el
mapa y en el minimapa, y lleva botones para ir allí, subir la prioridad del frente o tomar el mando. La **pausa
automática** (configurable) detiene el juego ante una declaración de guerra, un ultimátum, una amenaza a la capital o
un lanzamiento nuclear, con un aviso que explica por qué y qué hacer. Un registro (`L`) guarda todo.

**Cómo verlo.** Juega hasta que una IA se enfade contigo (o declara tú una guerra y espera la respuesta de sus
aliados): verás la tensión primero y la declaración después, con la partida en pausa.

### 13. Misiles por todas partes sin sentido

**Qué cambió.** Hay una **escalera de escalada**: guerra convencional, después ataques a ciudades y, como último paso,
armas nucleares, y cada paso necesita un motivo que se anuncia (una guerra larga, un ataque previo a sus ciudades, una
ofensiva propia fracasada). Las IA no lanzan nada contra quien no está en guerra con ellas. Tú solo puedes apuntar un
arma nuclear o un misil contra una nación con la que estás en guerra, y siempre tras una confirmación que dice a quién
alcanza (las naciones en paz dentro del radio, en rojo), la escalada que provoca y el coste diplomático. Atacar
objetivos civiles cuesta opinión y da motivo de guerra a la víctima y a sus aliados.

**Cómo verlo.** Construye un silo (`6`) y pulsa `Z` sin estar en guerra: el juego dice por qué no.

### 14. Diplomacia de verdad

**Qué cambió.** Panel **Naciones** (`N`) con la opinión de cada nación sobre ti y su desglose, su personalidad y sus
tratados. Puedes proponer pactos de no agresión, acuerdos comerciales, paso libre, alianzas, paz y tributos, pedir
ayuda a tus aliados o imponer un embargo. La otra nación **se lo piensa** («estudiando…») y contesta con sus razones,
escritas con palabras («Tu oro ayuda, pero aún no confiamos lo bastante en ti; un gesto más nos convencería»), con las
cifras en el tooltip. Las propuestas que te hacen esperan en la bandeja sin caducar en segundos. Declarar la guerra
abre un diálogo que dice el motivo, la reacción del mundo, los aliados que entrarán y el tiempo de movilización, y
cuando alguien te declara la guerra o te envía barcos o tanques tienes horas de juego (y la pausa automática) para
decidir.

**Cómo verlo.** Pulsa `N`, elige la nación más amistosa y propón un pacto de no agresión.

### 15. Modelos de infraestructura torcidos o hundidos; mejoras invisibles

**Qué cambió.** Cada estructura se **asienta en el terreno**: se orienta con la normal media del suelo bajo su huella,
se apoya en la altura media y una base con faldón llega hasta el punto más bajo, también cuando el modelo se dibuja más
grande de lo real a media distancia. Puertos y astilleros se deslizan hasta la línea de costa dibujada, con los muelles
en el agua. Cada tipo tiene una geometría distinta en los niveles 1, 2 y 3 (y la ciudad crece en altura y extensión
hasta el nivel 10), con los niveles en puntos bajo el icono y en la ficha. Mejorar dice antes cuánto cuesta, cuánto
tarda y qué gana («Mejorar a nivel 2 · más producción»), y el efecto se nota en la simulación.

**Cómo verlo.** Mejora una fábrica desde su ficha y acércate a 20 km: el modelo cambia y la ficha muestra la nueva
producción.

### 16. Cosas mal explicadas o que estaban «por estar»

**Qué cambió.**
- **Asesor militar**: un tutorial por pasos (fundar la capital, expandirse, la primera ciudad, los vecinos, el
  ejército, moverlo, el reloj, los frentes, el modo mando, la bandeja diplomática y las ofensivas) que **espera al
  jugador** en cada paso.
- **Ayuda** (`F1`) por temas y una **enciclopedia** con 22 entradas generadas de las tablas reales del juego.
- **Tooltips en todos los controles** (más de 670 revisados), con propósito y cifras; desgloses en la barra superior
  (de dónde sale el oro, cómo se reclutan las tropas).
- Se eliminó lo que no tenía función: emoticonos, «Marcar objetivo», las misiones guionizadas del modo mando y decenas
  de restos de la v1.

**Cómo verlo.** Empieza una partida nueva con el asesor activado (Ajustes › Juego) y sigue sus pasos.

### 17. Todo lo demás

**Qué cambió.** Entre otras cosas: guardar y continuar la partida (menú de pausa › Guardar; «Continuar» en el menú),
partidas que terminan (dominio, hegemonía o límite de tiempo según la duración elegida, con la cuenta atrás de la
hegemonía pública), una fase de despliegue que espera a que elijas y explica por qué no puedes fundar en tierra ajena,
población que importa (reclutamiento), textos sin «un(a) Puerto», pantalla final con cifras correctas, audio con avisos
distintos para cada peligro y sin saturar en las batallas. La lista completa de defectos de la auditoría y dónde se
resolvió cada uno está en docs/DESIGN_V2.md §15.

**Cómo verlo.** Juega una partida completa: el menú final y la vuelta al menú principal funcionan (lo comprobamos con
una partida entera, ver «Pruebas» al final).

---

## Aclaración: los modelos 3D se quedan

> «¿Cómo que has quitado el modelo 3D?? Yo no te he pedido eso.»

**Qué cambió.** Los modelos 3D no se han quitado: los iconos solo sustituyen a los modelos **de lejos**. De cerca, cada
unidad y estructura muestra su modelo, bien asentado y con su nivel visible, y **crece en pantalla** al acercarse: 34-46
píxeles a 300-600 km, 60 píxeles a 100 km y 72 desde 30 km hacia abajo (barcos algo más grandes, cada uno de los cuatro
carros de una división, los tres cazas de un escuadrón). Las ciudades son ahora una trama de manzanas con un centro de
edificios altos que se disuelve en casas con tejado hacia las afueras, sin el «posavasos» redondo. Las unidades se
apoyan en el terreno (un carro en una cresta ya no queda en el aire).

**Cómo verlo.** Acércate a 30 km de tu capital, de un puerto con barcos o de una división en marcha.

---

## Segunda ronda (puntos 18 a 25)

### 18. Al soltar el control, la unidad volvía a la base

**Qué cambió.** Al salir del modo mando la unidad **se queda exactamente donde la dejas**, con el mismo rumbo: una
división mantiene la posición (o se queda en la línea si está en un frente), un buque mantiene su posición y un avión
orbita sobre ese punto mientras le dure el combustible, y la ficha lo dice. Si la dejas dentro de otra nación en paz,
la incursión sigue, el aviso dice «sigue dentro de…» y puedes ordenarle salir. Ya no existe la vuelta automática.

**Cómo verlo.** Toma el mando de una división, conduce unos kilómetros y pulsa `Esc`: la cámara estratégica mira ese
lugar y la división está allí.

### 19. Respuesta a una incursión «en 6 horas»

**Qué cambió.** Al entrar sin permiso en tierra, aguas o espacio aéreo ajenos, al momento llega un aviso por radio con
**cuenta atrás en segundos reales**: 30 s en tierra, 25 s en el aire, 40 s en el mar y 15 s cerca de una capital. Si no
das la vuelta, la víctima envía **fuerzas reales desde sus bases más cercanas**: cazas despegados de su base aérea en
1-3 minutos, una patrulla terrestre en 1,5-5 minutos y un buque en 2-7 minutos; después, último aviso y fuego. Volar
sobre una capital rival nunca se ignora. El mapa estratégico aplica la misma regla: no deja enviar una patrulla aérea
sobre una nación en paz sin alianza ni paso libre, y lo explica.

**Cómo verlo.** En paz, toma el mando de un caza y vuela hacia el país vecino.

### 20. Escoltas que daban vueltas y embestían

**Qué cambió.** La fuerza de reacción terrestre son blindados de transporte y patrullas militares (y un carro si hace
falta) que se acercan a velocidades realistas (como mucho 55 km/h), toman posición, te escoltan a una distancia
sensata (nunca a menos de unos 50 m), cortan el camino, avisan y solo disparan si les disparas o hay guerra. Respetan la
física: no embisten, no giran en círculos. Los cazas interceptores vuelan en formación contigo y te avisan; los buques
te siguen y te avisan. Dispararles sigue siendo un acto de guerra.

**Cómo verlo.** Cruza una frontera en paz con un carro y no des la vuelta: tras la cuenta atrás llegan los vehículos.

### 21. Al tomar el mando delante de tanques enemigos, no estaban

**Qué cambió.** El modo mando toma sus fuerzas de la **misma fuente** que la batalla que ves en el mapa: las mismas
divisiones en las mismas posiciones y las mismas cifras de soldados por bando (medido: 2.625 / 608 soldados en el mapa y
en el modo mando, los 4 carros de la división enemiga, la misma distancia).

**Cómo verlo.** Acércate a un frente hasta ver la batalla en el suelo y pulsa «Tomar el control aquí» en la tira de
batalla.

### 22. La flecha amarilla tapaba la frontera

**Qué cambió.** La flecha de ataque es **fina** (unos 4-5 píxeles), semitransparente, se dibuja **por debajo** de las
fronteras y de la banda del frente y desaparece al bajar de 1.000 km, así que la frontera atacada y la línea del frente
se leen a cualquier distancia. Las flechas de invasión naval solo se dibujan para desembarcos reales que te afectan.

**Cómo verlo.** Lanza una ofensiva y acerca la cámara: la flecha se afina y se va.

### 23. Atacar era hacer clics sin parar

**Qué cambió.** Una ofensiva se lanza con **una acción deliberada**: el clic sobre la tierra enemiga abre un diálogo con
las tropas (25, 50, 75 o 100 %) y la intensidad (mantener la línea, sostenida, asalto total) y una vista previa: tropas
de cada lado, relación de fuerzas, anchura del ataque, km/h ahora y con el cambio, el máximo que permite el terreno (y
por qué más tropas ya no aceleran), bajas por día, tiempo hasta el objetivo y apoyo aéreo. Después **sigue sola** y se
gestiona desde la insignia del frente o el panel Guerra (`G`): reforzar, cambiar la intensidad, enviar divisiones,
apoyo aéreo, detener o retirarse. Un clic más sobre el mismo frente refuerza esa ofensiva y lo dice («reforzar nuestra
ofensiva con…»). El tutorial y los tooltips lo explican.

**Cómo verlo.** En guerra, haz clic en tierra enemiga junto al frente.

### 24. Los «detallitos»

**Qué cambió.** Una larga lista de pequeñas incoherencias corregidas en el modo mando y en los frentes: fichas de
órdenes que se salían de la pantalla, escoltas que abandonaban a su bombardero en el regreso, la orden de escolta de la
IA que siempre fallaba, contadores de divisiones bajo el lado equivocado de la insignia, un solo aviso agrupado cuando
una orden se rechaza para varias unidades, avisos que se pliegan solos, textos de lugares («a 0 km al N de tu capital»,
«la capital se traslada a Madrid» al perder Madrid) y muchos más (ver docs/V2-STATUS.md).

### 25. Misiones aéreas reales

**Qué cambió.** Desde el panel Fuerzas, el clic derecho o «Apoyo aéreo» en el panel Guerra, con una acción cada una:
- **Patrulla aérea** sobre una frontera, un frente o una ciudad: intercepta bombarderos, drones y misiles. Medido
  contra la IA real: con dos escuadrones patrullando, los bombardeos que llegan a su objetivo bajan de 22 a 16 y las
  bajas por bombardeo en el frente de 124.916 a 88.275.
- **Superioridad aérea** sobre un frente: el bando con más cazas en patrulla acelera su avance un 10 % (o frena el del
  enemigo un 8 %) y anula sus drones. El «✈» de la insignia del frente, en el color de quien domina el cielo, lo
  muestra.
- **Apoyo cercano** con drones: medido, +43 % de velocidad de avance en un frente llano.
- **Ataques con bombarderos escoltados**: sin escolta, 12 de 12 derribados por una patrulla enemiga; con escolta, 5.
- **Escolta** de otros aviones.
Cada misión dice antes su efecto, su riesgo (SAM, cazas y bases enemigas cerca) y su tiempo de llegada. Los aviones
vuelan a velocidades creíbles, gastan combustible (24 h de patrulla), vuelven a repostar y regresan solos a su misión;
dos escuadrones en la misma patrulla se relevan para no dejar huecos. La IA usa las mismas misiones contra ti.

**Cómo verlo.** Construye una base aérea (`7`), compra cazas y, en guerra, abre `G` › «Apoyo aéreo» en un frente.

---

## Tercera ronda (puntos 26 a 30)

### 26. Llegar a la acción en el modo mando

**Qué cambió.**
- Un **indicador siempre visible** bajo la brújula dice dónde está la lucha más cercana (frente, ofensiva o misión),
  a qué distancia y en qué dirección, con un anillo en el mundo o una flecha en el borde de la pantalla.
- **`G` «Ir al combate»** (o «Ir al frente más cercano» si estás lejos): la unidad marcha de verdad por la simulación,
  tras un fundido, hasta el punto más caliente de la línea, y la escena se construye allí, mirando al enemigo. Al
  llegar a contacto, el tiempo pasa a 1:1.
- Mapa táctico (`M`) donde haces clic en un destino.
- Tomar el mando desde una insignia de frente, el panel Guerra, una batalla o un aviso te deja **directamente en la
  acción** con la unidad que está allí.
Medido en el contenedor de pruebas, sin tarjeta gráfica: de pulsar «Tomar el mando» a tener al enemigo a 1-2 km, entre
77 y 110 segundos, de los que unos 60 son la construcción de la escena con renderizado por software; la marcha en sí
dura 18-42 segundos. En un ordenador con GPU debería quedar dentro del minuto (ver limitaciones).

**Cómo verlo.** En guerra, `G` › un frente › «Tomar el control aquí».

### 27. Destruir ciudades y estructuras

**Qué cambió.**
- Las estructuras tienen **integridad** con estados (con daños, daños graves, destruida): funcionan al 60 % o al 25 %,
  pierden un nivel al llegar a cero y en el nivel 1 quedan en ruinas, que se pueden reconstruir a mitad de precio. Se
  **reparan con oro** (+8 % por hora, tras una pausa de 2 h después del último impacto). Capturadas, cambian de dueño;
  arrasadas, desaparecen.
- Las ciudades pierden manzanas enteras, civiles y tropas.
- **Sin modo mando**: bombarderos, drones, misiles, buques que bombardean la costa y divisiones con la orden «Asaltar»
  o «Arrasar» hacen el daño.
- **En modo mando**: los proyectiles del carro, las bombas (`B`) y misiles del caza y los cañones del buque dañan las
  mismas estructuras y casas que ves, con fuego, humo, derrumbes y escombros, y el resultado vuelve a la simulación.
- Atacar objetivos civiles tiene **consecuencias diplomáticas** (opinión de la víctima, de sus aliados y del mundo,
  motivo de guerra durante 30 días, escalada) que un diálogo explica antes de confirmar.
- Los modelos 3D muestran el daño (más bajos, chamuscados, con escombros, humo y fuego).

**Cómo verlo.** En guerra, ordena a un bombardero atacar una fábrica enemiga y mira su ficha después; o toma el mando de
un carro y dispara explosivo (`2`) contra una estructura.

### 28. Misiones de guerra para todas las unidades

**Qué cambió.** Divisiones: mover, unirse a una ofensiva (que gana potencia y km/h; medido 4,0 → 5,1 km/h con dos
divisiones), defender un sector (medido: una ofensiva enemiga baja de 1,6 a 0,03 km/h), atacar hacia un punto,
mantener la posición, asaltar o arrasar una estructura. Aviones: las del punto 25 y atacar objetivos. Buques: bloquear,
escoltar, patrullar, bombardear la costa. Cada misión enseña antes su efecto, riesgo y tiempo de llegada, se ve en el
mapa (anillo del sector, ruta, objetivo), sigue sola hasta terminar y la IA usa las mismas.

**Cómo verlo.** Selecciona una división en guerra y haz clic derecho en distintos sitios: la ficha cambia de orden.

### 29. Mejoras propuestas por el equipo

- **a. Cifras coherentes.** Una sola fuente para cada frente: la insignia, el panel Guerra, la tira de batalla, la
  ficha junto al cursor y el diálogo de ofensiva dan los mismos km/h, la misma anchura y la misma relación de fuerzas.
  Una ofensiva sin avance dice «presionando: aún sin avance», nunca «avanzando» junto a «0 km/h».
- **b. La noche se lee.** En el mapa, el territorio y los modelos mantienen la luz de luna y las luces de las ciudades.
  En el modo mando: luces del vehículo (`L`), bengalas sobre los combates, el fuego de las estructuras dañadas y `N`
  para visión nocturna o térmica.
- **c. Resumen de operaciones.** El panel Fuerzas lista cada unidad con su misión, estado, llegada e integridad, y el
  asesor avisa de las unidades sin misión con un botón «Dar misión».
- **d. Informes tras la acción.** Al terminar una ofensiva, un ataque o una misión llega un informe al registro y a los
  avisos (resultado, duración, terreno ganado o perdido, bajas de ambos lados, daños), clicable para ir al lugar.
- **e. Tomar el mando desde cualquier sitio.** Ficha de unidad, misión, tira de batalla, insignia de frente, aviso. Al
  salir, la cámara estratégica mira ese lugar.

### 30. Guerra naval en las rutas marítimas

**Qué cambió.**
- **Bloqueos de rutas y estrechos**, no solo de puertos: Gibraltar, Suez, Bósforo, Ormuz, Malaca, el Canal de la
  Mancha, Panamá y Bab el-Mandeb, o cualquier tramo de mar. Suez y Panamá son canales navegables (antes un barco del
  Mediterráneo al mar Rojo daba la vuelta a África). Los mercantes afectados se desvían por la ruta larga (con la nueva
  ruta dibujada) o son detenidos. Medido: cerrar Gibraltar a un enemigo le recortó un 40 % sus ingresos por comercio.
- **Apresar o hundir**: un mercante abordado pasa a tu bandera y navega a tu puerto con su carga; un convoy abordado se
  da la vuelta (sus tropas vuelven) y uno hundido pierde sus tropas.
- **Bloqueo selectivo**: eliges a quién afecta (solo naciones en guerra contigo, por defecto; también las embargadas,
  una lista de naciones o todos menos los aliados), qué barcos (todos, mercantes o transportes) y si se aborda o se
  hunde. Antes de confirmar se ven las **ganancias** (comercio cortado, tropas detenidas) y los **costes** (opinión de
  cada nación afectada, aliados que se enfadarán, motivo de guerra, riesgo de guerra y tu comercio que un embargo
  cortaría). Las consecuencias siguen a lo que haces: detener solo barcos enemigos no enfada a nadie más.
- **Respuesta**: escoltas de convoyes, romper un bloqueo con tu flota o tu aviación, avisos situados cuando detienen
  tus barcos, y la IA bloquea estrechos por sí misma, protesta, embarga y llega a declarar la guerra por piratería.
- **En el mapa**: estrechos bloqueados con un disco rayado y su ficha («tu bloqueo / +990 oro/h · 5 apresados»);
  panel Guerra › **Mar** con todas las cuentas; la ficha del puerto dice el comercio perdido por hora.
- **En modo mando**, desde el buque: `E` dar el alto, `R` disparo de advertencia, `F` abordar (junto al mercante,
  despacio), `X` hundir.

**Cómo verlo.** En guerra, selecciona un buque de guerra y haz clic derecho en un estrecho: «Bloquear» abre el diálogo.

---

## Cuarta ronda (punto 31)

### 31. El modo mando pregunta ANTES de disparar

**Qué cambió.**
- Cada vez que aprietas el gatillo (cañón y ametralladora del carro, cañón, misiles y bombas del caza, cañón y misiles
  del buque), el juego comprueba el blanco bajo la retícula, el punto apuntado y la trayectoria balística. Si hay algo
  de una nación en paz (o una casa de una ciudad sin confirmar), **no sale nada** y se abre la pregunta.
- **«No disparar» cancela el disparo por completo**: sin fogonazo, sin sonido, sin proyectil, sin gastar munición, sin
  impacto, y el gatillo no vuelve a disparar solo. Un proyectil ya en el aire atraviesa a una fuerza en paz sin dañarla
  ni volver a preguntar.
- **`Intro` y `Esc` siempre significan «No disparar»**; la guerra o la piratería solo con un clic explícito o la tecla
  impresa en su botón.
- Ante un **mercante o un convoy en paz**, desde el buque, la pregunta sigue el modelo del punto 30: disparo de
  advertencia, abordar (si estás cerca), hundir (piratería, con sus costes), declarar la guerra o no disparar.
- La misma regla para el carro, el caza y el buque.
- **«Bloquear esta zona»** (`B`) desde el buque abre el diálogo de bloqueo del estrecho o la zona en la que estás, sin
  salir del modo mando. La barra de controles y un consejo la primera vez lo recuerdan.

**Cómo verlo.** En paz, toma el mando de un buque cerca de una ruta comercial y dispara a un mercante de otra nación:
pulsa `Intro` y comprueba que no ha salido ningún disparo.

---

## Quinta ronda (punto 32)

### 32. Combate en el modo mando: ejércitos a escala, legibles y físicos

**Qué cambió.**
- **Batallas a escala real.** Al llegar a una ofensiva o a un frente defendido hay cientos de soldados alrededor:
  medido en juego real, unas 1.240 figuras de los dos bandos al llegar (810 a menos de 600 m) y más de 500 en tu campo
  de visión, con el enemigo en su trinchera a unos cientos de metros y no detrás de una cresta. Trincheras, alambradas,
  cráteres, vehículos, artillería, humo y trazadoras, y el frente sigue con explosiones y humo hasta ±4,5 km. Los
  defensores ocupan trincheras y posiciones; los atacantes avanzan en oleadas por pelotones.
- **Encontrar la acción.** Cada batalla activa tiene su marcador en el mapa con «Tomar el control aquí». `G` te lleva al
  **tramo más caliente** de la línea (donde se dispara ahora) y busca un punto desde el que la cámara vea la lucha. Un
  indicador dice siempre dónde, a qué distancia y con qué intensidad: «Lo más duro, a 390 m · intensidad muy alta ·
  unos 77.000 nuestros y 240 enemigos en este tramo».
- **Soldados nuevos.** Proporciones reales, uniforme de campaña con chaleco, cartucheras, mochila y casco con borde,
  cara visible, camuflaje con un toque del color de su nación, armas; animaciones de correr, agacharse, disparar,
  tumbarse y caer al ser alcanzados, y un nivel de detalle que se mantiene a distancia de carro.
- **Disparar es satisfactorio y justo.** Marcado del blanco, marcas de impacto, indicador de distancia y avance para el
  cañón; el explosivo mata infantería en un radio y la ametralladora coaxial la siega; las bajas vuelven a la simulación.
- **Daño con sentido físico.** La ametralladora contra una ciudad o una fábrica hace un daño pequeño pero real
  (impactos, cristales rotos) y el HUD avisa de que es poco eficaz y sugiere el cañón o los bombarderos; las armas
  pesadas hacen proporcionalmente más.
- **Atropellos y embestidas.** El carro aplasta infantería, vehículos ligeros, vallas, muros, árboles y casas pequeñas
  según su masa y velocidad, con escombros y sonido, y embestir también daña tu vehículo. Contra una nación en paz es un
  incidente con la misma regla del punto 31 (Intro = «Frenar»).

**Cómo verlo.** En guerra, `G` › un frente con una ofensiva grande › «Tomar el control aquí», y después `G` en el modo
mando.

---

## Otras mejoras importantes

- **Ruptura del frente.** Si una ofensiva mantiene 5:1 durante una hora, la defensa se rompe: la guarnición se rinde o
  huye, el terreno frena la mitad y el defensor manda a la brecha todo lo que le sobra. Se anuncia con sus remedios.
- **Paces que dicen qué conserva cada uno.** «X e Y firman la paz sobre la línea del frente. X conserva N casillas que
  ocupó.» Una nación que capitula devuelve lo que había ocupado en sus otras guerras, y el aviso explica por qué.
- **Guerras con lógica geográfica.** Las IA atacan a sus vecinos; las guerras de ultramar quedan para grandes potencias
  navales, con su propio lenguaje («observa tus costas…»). Las naciones pequeñas se alían contra el vecino expansionista.
- **Mapa más rico de cerca.** Relieve con detalle, sombreado cartográfico, cubierta vegetal, campos de cultivo, nubes
  nítidas por debajo de 800 km y el reflejo del sol limitado al mar.
- **Mapa táctico** del modo mando al estilo de un plano de estado mayor: relieve, fronteras, el frente, carreteras y
  ferrocarril, pueblos con nombre, símbolos OTAN, escala, norte, destino con distancia y tiempo de marcha.
- **Guardar y continuar**, con la partida restaurada exactamente.
- **Avisos ordenados.** Como mucho cuatro avisos a la vista (los más graves y recientes), los informativos se pliegan,
  un aviso por frente, sin spam; los avisos de más de tres días de juego pasan solo al registro.
- **Clasificación de naciones** sin los territorios independientes mezclados (van en una línea plegada aparte).
- **Producción sin red**: la versión compilada funciona desde cualquier subcarpeta y no hace ninguna petición fuera de
  sus propios archivos.

## Pruebas de esta versión

- `npx tsc --noEmit` y `npm run build` sin errores; todas las claves de texto existen en español e inglés.
- **Versión de producción servida desde una subcarpeta** (`/juegos/front-ultra/`): carga con rutas relativas, **0 errores
  en la consola, 0 peticiones fuera de su propio servidor y 0 archivos que fallen**, en todas las ejecuciones.
- **Recorrido completo automático** (`tools/playtest.mjs`, la interfaz real con ratón y teclado, dos ejecuciones de unos
  40 minutos): menú, despliegue, expansión, diplomacia (propuesta con contraoferta razonada, pacto aceptado, paz blanca
  rechazada con su motivo), declaración de guerra con su diálogo, guerra recibida con pausa automática, clic en el aviso
  que lleva la cámara al lugar, guardar y continuar (estado idéntico), las diez estructuras, el arsenal, una división
  movida desde Fuerzas, una fábrica mejorada (220 → 440 oro/h y un modelo mayor), prioridad de un frente, armas
  nucleares (rechazadas en paz, con confirmación en guerra), ofensivas, modo mando (al salir, la división queda a 0,0 km
  de donde se dejó), invasión naval, propuesta desde el menú radial, paz con tributo, una propuesta de la IA aceptada en
  la bandeja y la pantalla final con vuelta al menú. Cada paso pasó en al menos una de las dos ejecuciones; los fallos
  sueltos fueron de la puesta en escena de la prueba (ver «Limitaciones»).
- **Una partida entera** jugada por un guion a través de la interfaz (`tools/fullgame.mjs`: duración Corta, Fácil, los
  primeros días a 1× y el resto a 4×, sin ayudas de depuración): 48.000 ticks (200 días de juego) en unos 25 minutos
  reales, con la pantalla final («Derrota · se ha alcanzado el límite de días: Estados Unidos es la nación más
  extensa») y la vuelta al menú principal, sin errores.
- Auditorías sin interfaz de las rondas anteriores: ritmo (conquista, profundidad, desgaste, imperios, partidas
  completas), diplomacia, modo mando, aire, ejércitos, batallas y guerra naval.

## Limitaciones conocidas (con franqueza)

- **Rendimiento en una GPU real sin medir.** Todo se ha probado en un contenedor sin tarjeta gráfica (renderizado por
  software, 1-3 segundos por fotograma a ras de suelo). El diseño apunta a 60 fps y las batallas del modo mando tienen
  límites (hasta unas 1.900 figuras con niveles de detalle), pero no hemos podido medirlo en un ordenador normal. Por
  lo mismo, el objetivo de «menos de un minuto desde tomar el mando hasta el contacto» solo se ha podido estimar.
- **Figuras y tropas no son uno a uno.** Para que una batalla parezca una batalla, un tramo con pocas tropas enemigas se
  dibuja con una densidad mínima de figuras (cada figura vale entonces menos de un soldado). Las cifras que da el
  juego son siempre las de la simulación.
- **El terreno manda en la primera vista.** En montaña (por ejemplo, los Pirineos) la escena depende de dónde termina la
  marcha; los árboles no se despejan en la zona de batalla. Un carro puede quedar inclinado en una ladera muy empinada.
- **Duración de las partidas.** Las partidas Normales de prueba terminaron por hegemonía entre 43.000 y 63.000 ticks
  (72-105 minutos a 1×) en dos de tres semillas; la tercera se alargó a unos 150 minutos. La primera guerra de una IA
  contra un jugador fuerte puede tardar más de lo previsto, porque la IA no declara guerras que no puede ganar.
- **Aire simplificado.** La superioridad aérea es «más cazas que el enemigo sobre el frente» (un ±10 %), no
  proporcional al número de escuadrones. No hay submarinos, así que no hay caza antisubmarina.
- **Geografía de las IA.** Una IA con nombre de país real puede crecer sobre la tierra de vecinos que no están en la
  partida (por ejemplo, «Suiza» con Toulouse si Francia no juega).
- **Pequeños detalles visuales.** Bajo nubes densas la línea de ruta de un barco se atenúa un poco; el destello de
  conquista tiene un borde de 1-2 píxeles a 1.500 km; la etiqueta «Guarnición del frente» del modo mando cuenta una zona
  más amplia (unos 90 km) que el indicador de batalla (16 km).
- **Un carro y una ciudad.** Con sus 20 proyectiles explosivos, un carro solo derriba unas pocas casas de una ciudad:
  las ciudades están pensadas para la artillería y los bombarderos; el trabajo del carro son las estructuras.
- **Una partida Corta puede acabar por el límite de días.** En la partida completa de prueba el jugador del guion apenas
  hizo nada (se expandió y esperó) y ninguna IA llegó a la hegemonía: a los 200 días ganó la nación más extensa
  (Estados Unidos, 15,8 % de la tierra). Con un jugador activo y en las pruebas sin interfaz, las partidas Cortas
  terminan antes por hegemonía, pero no está garantizado.
- **Pruebas automáticas sensibles a la puesta en escena.** En el recorrido completo, algunos pasos que preparan una
  situación (una ofensiva de la IA contra tu capital para oír la sirena, el orden en que aparecen los consejos del
  asesor, un clic que el renderizado por software lee como «mantener pulsado») fallan en una ejecución y pasan en otra.
  No son fallos del juego, pero tampoco son pruebas deterministas.
- **El asesor insiste con la bandeja.** Mientras tengas una propuesta pendiente, el consejo de la bandeja diplomática
  vuelve a aparecer cada vez que llega una nueva, hasta que respondes a una.
- **Las partidas se guardan en el navegador** (almacenamiento local): borrar los datos del sitio borra las partidas.
