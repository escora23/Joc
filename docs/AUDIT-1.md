# AUDIT-1: play audit of the current build

Written by the play-auditor agent on 2026-09-25 against branch `wip/build`, commit `c2ea199` (the v1 integration build,
before any v2 work). Requirements are cited as **F1…F17** (`docs/FEEDBACK-1.md`). Code locations are in
`docs/CODEMAP.md`; this file is about what a player sees and what the numbers are. Every claim below comes from a
real session, a controlled headless experiment or a screenshot. Screenshots live in the gitignored `shots/audit/`
folder. Section 8 says how to regenerate them.

**Verdict.** The owner is right on every count, and the numbers are worse than his impression. At 1x a whole nation
falls in **1–2 seconds**. A passive or slow new player can be **erased with no attack and no warning** by the
encirclement rule. Units cross an ocean in **20 seconds**. The world goes from 65 factions to 30 in **2 minutes**, and a
full game ends in **23 minutes at 1x (6 real minutes at 4x)**. In my three real-UI sessions at Normal, the human lasted
3.4 min, 4.0 min and 26 s of play. The scripted playtest on Easy, with debug help, lasted 10 min. Command mode throws a peaceful tank near Barcelona into a
scripted mission against Tunisia, a country it does not border and is not at war with. Territory is often unreadable:
the fill is faint, the night side is black, clouds cover it and zoomed views show no ownership. The individual pieces
(globe, battle layer, command vehicles, HUD styling) are good. The rules and the time scale that tie them together are
what make it feel like an arcade.

---

## 1. What I played

Environment: 4-CPU container, no GPU. SwiftShader renders at 2–10 fps. The sim worker ran at 5–7 ticks/s of wall time
instead of 10 because two software-rendered browsers shared the CPUs (sim cost was ~1.2 ms/tick, so the sim itself is
not the problem). **All times below are converted to the design rate of 10 ticks/s at 1x** unless marked "wall".

| # | How | Setup | What happened | Evidence |
|---|---|---|---|---|
| S1 | Real UI (menu → setup → spawn), Playwright mouse/keys | Normal, 24 AI + 40 tribes, 1x | My spawn clicks came late. After 90 s the game **auto-spawned me in Newfoundland** without asking. At 3:05 the world was already painted and China held 6.8 %. Canada attacked with 323,544 troops at play-time 3:24: **capital lost 0.2 s later, nation eliminated 0.5 s after the attack started**. Game over. | `s1-spawn.png`, `s1-spawn-europe.png`, `s1-spawned.png`, `s1-autospawn-home.png`, `s1-hover-neutral.png`, `s1-expanding.png`, `s1-end.png` |
| S2 | Scripted game (`startScriptedGame`, autopilot) | Madrid, 1x | Debug-spawned one unit of every type and measured the speeds (§2.1). Zoom ladder over Madrid from 20,000 km to 8 km. | `s2-zoom-*.png` |
| S3 | Real UI | Normal, 1x | Clicked Madrid during the spawn phase. **Refused silently** (the "Spain" AI blob sits there), then auto-spawned in Quebec. Restarted and founded at Valladolid. I owned all of Iberia (897 tiles) by 1:20, then had no free land left. At 4:24 on the game clock (about 4 min of play) Germany attacked with 468,822 troops while I had 464,569 (my cap): **capital gone in 0.9 s, eliminated in 1.3 s**. | `s3-iberia-t800.png`, `s3-build-placement.png`, `s3-city-L1-*.png` |
| S4 | Scripted game, autopilot on | Easy, 1x | UI flows: Arsenal, buying armor, TAKE CONTROL, Esc/debrief, radial alliance, upgrade. The autopilot human reached 60 % of the land, then lost it to three rebellions in 6 min. **55,600 tiles went to 270 in 5.8 s.** | `s4-*.png`, `s5-*.png` |
| S6 | Real UI, 4x via the time buttons | Normal, founded near Paris | **Eliminated 26.6 s of game time after the start (6.6 s real at 4x), with no attack**. Czechia's expansion encircled the new nation and the encirclement rule annexed it. | recorder events (§2.4) |
| S7 | Scripted, passive | Easy | Space pause/resume works. B-key invasion works: a 239 km trip took 1.2 s. | `s7-invasion-a.png` |
| PT1/PT2 | `tools/playtest.mjs` (§6) | Easy, 1x/4x | 12/17 steps then abort. 21/29 steps with a longer screenshot timeout. | `shots/audit/playtest*/` |
| HL | Headless sim, `src/sim/test/pace-audit.mjs` and ad-hoc runners | 2 full games, 15 survival runs, controlled conquest | §2 | console output |

Registered shots captured: `structures, units, front, front-wide, command-tank, command-jet, command-ship, territory,
midgame, radial, nuke-alarm, territory-close` → `shots/audit/shots/`.

---

## 2. Measurements

### 2.1 Unit speeds (F1)

Sim speed is in tiles per tick. A tile is 25.0 km at the equator. At 1x there are 10 ticks per real second. "Measured" is
the great-circle distance per tick from a real run, at mid-latitudes, while the unit moves.

| Unit | tiles/tick | km per real second at 1x (nominal / measured) | at 4x | Real-world speed | Game speed ÷ real speed |
|---|---|---|---|---|---|
| Armored division | 0.35 | 88 / **82** | 350 km/s | ~40 km/h | ~7,900× |
| Transport ship | 1.2 | 300 / **253–271** | 1,200 km/s | ~35 km/h | ~27,000× |
| Trade ship | 1.0 | 250 / **184–250** | 1,000 km/s | ~25 km/h | ~33,000× |
| Warship | 0.9 | 225 / **203–225** | 900 km/s | ~55 km/h | ~14,000× |
| Train | 1.5 | 375 / **317–375** | 1,500 km/s | ~100 km/h | ~12,000× |
| Fighter squadron | 1.1 | 275 / **152 average, 220 peak** | 1,100 km/s | ~900 km/h | ~1,000× |
| Bomber | 0.7 | 175 / **130–140** | 700 km/s | ~800 km/h | ~650× |
| Drone swarm | 0.65 | 163 / **121–130** | 650 km/s | ~200 km/h | ~2,300× |
| Cruise missile | 1.6 | 400 / **292–313** | 1,600 km/s | ~880 km/h | ~1,300× |
| Atom bomb (ballistic) | 1.3 | 325 / **323** | 1,300 km/s | ICBM ~7 km/s | **~46×** |
| Hydrogen bomb | 1.2 | 300 / **300** | 1,200 km/s | ~7 km/s | ~43× |
| MIRV / warhead | 1.1 / 1.5 | 275 / 369 | 1,100 / 1,500 km/s | ~7 km/s | ~40–50× |
| SAM interceptor | 3.2 | 800 | 3,200 km/s | ~1.5 km/s | ~530× |
| Shell (tracer) | 5.0 | 1,250 / 762 | | | |

What this means for a player at 1x:
* Lisbon to New York by transport takes **18–21 s**. Madrid to Barcelona by tank takes 6 s. A train crosses Spain in 2 s.
* The scale is **incoherent between classes**. A tank moves 7,900× faster than a real tank, but a nuke only 46×
  faster than a real ICBM. So an ICBM is only 3.7× faster than a tank and about as fast as a transport ship.
* The sun takes 720 s per day, so 1 game-second is 2 world-minutes. Even on that clock a tank does ~2,500 km/h.
* The selection panel shows armor at **"315 km/h"** (`s4-tank-selected.png`). The real value is about 300,000 km/h per real hour.

### 2.2 Conquest speed (F3, F11)

| Case | Numbers |
|---|---|
| **Controlled, headless** (`pace-audit.mjs conquest --mult 2`). The human holds a 1,288-tile nation around Madrid (~620,000 km²) with 246,886 troops. The UK is given 2× those troops and attacks with 100 %. | First tile lost after **1 tick (0.1 s)**. Capital after **1.3 s**. **Half the land after 1.6 s**. 90 % after 1.9 s. At 4x: 0.03 / 0.33 / **0.40** / 0.47 s. Largest loss in one tick: **198 tiles**, i.e. ~950,000 km² per real second at the peak. Average ~660 tiles/s, about **one Italy per second**. `--mult` 1, 4 and 10 give identical times: odds don't change speed. |
| **Live S3**. Germany (468,822 troops) against my full-strength Spain (897 tiles, 464,569 troops, at the troop cap) | Capital lost after 0.9 s, **eliminated after 1.3 s**, ~690 tiles/s. A defender at full troop cap resists nothing, because defender troops are only drained per conquered tile (CODEMAP §4). |
| **Live S1**. Canada (323,544 troops) against my 75 tiles (127,030 troops) | Eliminated after **0.5 s**. Earlier, Canada gained 8,432 tiles in 7.3 s (1,155 tiles/s ≈ 450,000 km²/s). |
| **Live S1, AI against AI**. 184 attacks on defenders with ≥ 60 tiles | Median time for the defender to lose half its land: **8.6 s**. Defenders with ≥ 2,000 tiles: median **6.3 s** to half, **13.1 s** to elimination, p10 1.8 s. |
| **Empire collapse**, headless Normal full game | Niger held **60.6 % of the world at minute 20 and 0 % at minute 23**. Peru went from 28.8 % to 78 % in 3.3 min. |
| **Empire collapse**, S4 (Easy, human on autopilot) | 55,600 tiles → 270 tiles in **5.8 s** (tick 8500 → 8558). "Kazajistán Libre", a rebel state spun off the human by the third rebellion in 6 min, ended with 60 % of the world. |

### 2.3 Time between warning and impact (F12, F14)

| Threat to you | What the game shows | Warning → first loss at 1x | at 4x |
|---|---|---|---|
| Land attack | A toast "¡X nos ataca con N tropas!" **at the moment the attack starts**. No place, no marker. Throttled to one per attacker per 25 s. | **0.1 s** to the first tile, 0.9–1.3 s to the capital | 0.03 s / 0.2–0.3 s |
| Encirclement (pocket ≤ 900 tiles) | **Nothing.** No attack event, no toast. Just "¡Hemos perdido la capital!" and game over. | 0 | 0 |
| Naval invasion | Toast at launch ("¡Invasión naval de X (86K tropas)!") | median **3.2–3.7 s** to landing, p10 0.4–0.7 s | median 0.8–0.9 s |
| Nuke on your land | Alarm banner with a countdown and a siren (`shots/nuke-alarm.png`: good) | 11.7 s observed. Flight range 6–39 s, median 24–30 s | 2.9 s observed (1.5–10 s) |
| World event | Ticker warning | 10–64 s | 2.5–16 s |
| An AI asks you for an alliance | Toast with accept/decline | 20 s timeout | **5 s** |

### 2.4 How long the human survives

Live sessions, Normal: **3.4 min** (S1), **4.0 min** (S3), **26 s** (S6, founded near Paris, 4x: 6.6 s of real time).
PT2 on Easy with debug troop and gold grants: 10 min.

Headless passive human (founded, never plays), `pace-audit.mjs survival --seed 21`:

| Founded at | Easy | Normal | Hard |
|---|---|---|---|
| Madrid | 6.8 min, **encircled** | **40 s, encircled** | 2.4 min (1 attack) |
| Paris | 12.6 min, **encircled** | 3.9 min (1 attack) | 2.4 min (1 attack) |
| Berlin | **22 s, encircled** | 7.4 min | 2.4 min |
| Kansas | 10.2 min | 4.1 min | 5.5 min |
| Brasília | 7.9 min | 12.7 min | 2.5 min |

* On Hard, 4 of the 5 spawns die at **146–150 s**. The AI's no-attack grace period for the human is 150 s. It attacks the
  moment the grace ends and one attack is always enough.
* **4 of the 15 eliminations had no attack at all** (encirclement, `enclaves.ts`, pocket limit 900 tiles). The
  encirclement also ignores the human grace period.

### 2.5 Events per minute (F1, F11, F13)

| Event | Live S1, first 3.4 min, per game-min | Full Normal game (23.5 min), per game-min | Full Hard game (32.7 min), per game-min | Normal at 4x, per real min |
|---|---|---|---|---|
| attackStarted | **136** | 52.1 | 61.8 | 208 |
| New nation-vs-nation war pairs | — | 4.2 (99 in total) | 3.3 | 17 |
| nationEliminated | **11.7** (40 in 3.4 min; 65 → 30 factions in 2 min) | 1.70 | 1.41 | 6.8 |
| capitalCaptured | 1.8 | 1.32 | 0.86 | 5.3 |
| structureBuilt / destroyed | 35 / – | – / 5.4 | – / 11.8 | – / 22 |
| boatLaunched | 10.6 | 11.1 | 12.7 | 44 |
| allianceRequested / formed / rejected / expired | 3.2 / 1.5 / 1.5 / – | 3.95 / 1.83 / 2.04 / 1.06 | 3.98 / 1.71 / 2.26 / 1.10 | 16 / 7 / 8 / 4 |
| Nukes launched (atom/H/MIRV) + cruise | 0 | 0.42 + 0.17 | 0.76 + 0.70 | 1.7 + 0.7 |
| nukeDetonated | 0 | 0.51 | 1.25 | 2.0 |
| World events (start) | 0.6 | ~0.34 | ~0.4 | 1.4 |

PT1 (Easy, ~33 game-min) recorded 296 `nukeLaunched` events (cruise missiles and MIRV warheads included), 141
detonations, 155 interceptions, 92 world-event messages and 46 doomsday ticks. That is ~9 launches per game-minute in the late game.

### 2.6 AI behaviour (F13, F14)

* First attack on the human: 3.1 min (Hard) and 6.0 min (Normal) with the autopilot human. About 4 min in live S3.
* First nuke, not counting cruise missiles: 14.4 min (Normal), 9.4 min (Hard).
* Nukes tied to a live war (an attack between the pair in the previous 60 s): **50 % (Normal), 69 % (Hard)**. The rest hit
  nations the launcher is not currently fighting, often across continents: Niger → Germany, Sudan → Japan, Sudan → Brazil.
  One atom bomb on Turkey reported **52,567,876 casualties** (PT2) with no visible consequence beyond the scar.
* Alliances: 93 requests and 43 accepted in 23.5 min, and 25 expired. Nobody explains why an alliance is accepted, refused or ended.
* Rebellions: in S4 the leading human got three rebellions in 6 min (warning 30 s before each). The third spawned
  a successor state that took 60 % of the world.

### 2.7 Length of a full game (F1)

Headless games with the human on autopilot, stopped at the 80 % domination win:

| Difficulty | Game length | At 4x | Winner | Leader at 2 / 5 / 10 / 20 min |
|---|---|---|---|---|
| Normal (seed 11) | **23.5 min** | 5.9 real min | Peru, 80.1 % | Myanmar 10 % / Peru 29 % / Niger 33 % / Niger 61 % |
| Hard (seed 14) | **32.7 min** | 8.2 real min | Sudan, 80.3 % | USA 9 % / S. Korea 21 % / Sudan 29 % / Sudan 60 % |

Alive factions in the Normal game at 1 / 2 / 5 / 10 / 20 min: 53 / 38 / 29 / 28 / 28.

---

## 3. UI flows: do they work, and are they understandable?

| Flow | Works? | Understandable? What is wrong | Evidence |
|---|---|---|---|
| Spawn phase | Yes, on free land | The camera starts on the **night side over the North Pacific** (lat 51.8, lon −134) and the minimap is blank. AI nations are unlabeled blobs. Clicking where an AI already sits (**Madrid = "Spain"**) only gives an error beep and a red ripple, with no text. When the 90 s run out you are **auto-spawned at a random far place** (Newfoundland, Quebec) and nobody tells you. | `s1-spawn.png`, `s1-spawn-europe.png` |
| Expand / attack click | Yes | The tooltip says "CLIC: EXPANDIRSE CON 25K TROPAS" over land you cannot reach (hovering Spain from Newfoundland). The click then fails with "No hay tierra libre junto a tu frontera". | `s1-spawned.png`, `shots/units.png` |
| Build bar with the mouse | Yes. Ghost ring, "CLIC PARA CONSTRUIR", "COLOCANDO ESTRUCTURA ⇧ repetir · Esc cancelar". | Clear. But the tooltip gives only cost and a line of text. What each level adds is never said. | `s3-buildbar-hover.png`, `s3-build-placement.png` |
| Build hotkeys 1–0 | Yes, 10/10 in PT2 | | PT2 log |
| Arsenal → buy an armored division | Yes | The unit appears silently at the army base: no toast, no roster, no "unit ready". The tooltip showed a stale price (202.500 while the slot said 255K). | `s4-arsenal.png`, `s4-unit-bought.png` |
| Selecting a unit | Only by clicking its small 3D model. The click picked a different nearby division (the autopilot's). | The panel shows "FUERZA 800" (max HP, unexplained) and "VELOCIDAD 315 km/h" (false). | `s4-tank-selected.png` |
| TAKE CONTROL (T / button) | Technically yes. 2.2 s dive, then the command scene. | **Wrong by design (F8).** Tank at peace near Barcelona (41.51°N 2.14°E), on my own tile. The enemy chosen was **Tunisia**: 0 shared border edges, no war, no attack. HUD: "OPERACIÓN · BROKEN TEMPEST — Destruye 11 unidades enemigas para romper el frente", "FRENTE CONTRA TÚNEZ". The strategic unit stays frozen (state `Controlled`, same x/y) while you drive. The strategic war ran on for 5+ game minutes behind my back (cities lost, "¡Bangladés nos ataca…!"). Operation names are English inside the Spanish UI. | `s4-command-intro.png`, `s4-command-start.png`, `s4-command-driving.png`, `shots/command-tank.png` (enemy "Costa de Marfil"), `shots/command-ship.png` |
| Leaving command mode (Esc, Esc) | Yes. Combat report, then the climb to orbit. | | `s4-command-debrief.png` |
| Right-click radial | Yes. Atacar / Proponer alianza / Embargo / Donar / Emoticono / Marcar objetivo / Información. | "Marcar objetivo" and the emotes are never explained. | `shots/radial.png` |
| Proposing an alliance | Yes. Argentina never answered, and after the 200-tick (20 s) timeout the game said **"Argentina rechaza tu alianza"** plus an emote toast "Argentina: 👎 Mal". | No dialogue, no reason, no counter-offer (F14). | `s4-alliance-reply.png` |
| Upgrading a structure | Yes if you have the gold. | The button shows **no cost and no effect**. When I couldn't afford it, the only answer was a generic "no hay suficiente oro". SAM level 1 → 2: **no visible change** in the model. | `s4-upgrade-before.png`, `s4-upgrade-after.png` |
| Naval invasion (B over a coast) | Yes. 239 km in 1.2 s. | The wake is white and short. | `s7-invasion-a.png` |
| Pause (Space) and speed buttons | Yes | | S7, S6 |
| Tutorial ("Asesor militar", 6 steps) | Yes | Step 1/6 "Expande tu nación" appears ~2 min into the game, when the world is already carved up. | `s1-autospawn-home.png` |
| Nuke alarm | Yes. Banner "ALERTA NUCLEAR", countdown, target. | Good. The only warning that really works. | `shots/nuke-alarm.png` |

---

## 4. Visual inspection by requirement

* **F2 Ship trails.** Wakes are a white-blue ribbon that lives ~7 s and is ~5 model lengths long. The owner's color and
  the full route are missing. At 2,000–2,500 km they read as random white scratches across the sea (`s2-zoom-2000.png`,
  `s3-iberia-t800.png`, `s5-islands-caribbean.png`, `shots/units.png`).
* **F4 3D models when zoomed out.** Units are always 3D models held at a minimum pixel size. From 5,000–6,000 km,
  jets, tank columns and structures are toy-sized blobs larger than Corsica, cluttering Europe. Structures turn into black
  "discs" (`s2-zoom-6000.png`, `shots/territory.png`, `shots/territory-close.png`). There is no 2D icon or sprite layer.
* **F5 Clouds.** The cloud shell (opacity 0.96) is drawn over the territory. Newfoundland (my whole nation in S1) sat
  under cloud. Cloud blocks are visibly pixelated (`s1-autospawn-home.png`, `shots/territory-close.png`, `s3-city-L1-300.png`).
* **F6 Small islands.** At 2,500 km the Lesser Antilles are 1–3 px dots. Hawaii (21 land tiles) was still unowned at
  minute 17 and nearly invisible at 3,000 km. At night the Aegean islands vanish (`s5-islands-caribbean.png`,
  `s5-islands-pacific.png`, `s5-islands-aegean.png`). CODEMAP counts 226 single-tile islands.
* **F10 Territory delineation.**
  * The fill is faint. My own light-blue nation over Europe looks like natural terrain; only the neon border shows.
    Germany's France looked unowned in S3 (`shots/territory.png`, `s3-iberia-t800.png`). Dark colors are nearly invisible.
    Kazajistán Libre, holding 60 % of the world, is dark grey (`s5-front-2500-a.png`).
  * At 900 km and closer, ownership is hard to read: my land renders as terrain or as a flat blue plane with a hard rectangular seam
    (`s3-build-placement.png`, `s3-city-L1-60.png`, `s4-upgrade-before.png`). At 40 km and 8 km there is only a blurry brown
    ground with railway double lines and no hint of whose land it is (`s2-zoom-40.png`, `s2-zoom-8.png`).
  * The **night side is black**, because a day lasts 12 real minutes at 1x. Half of the planet (your nation, half the time)
    shows only neon borders (`playtest2/05-structures.png`, `s4-radial.png`, `s5-islands-aegean.png`).
  * Borders are a blocky tile staircase, and conquest flashes are big white pixel squares (`s5-front-2500-a.png`,
    `s7-invasion-a.png`). Some borders are artificial straight lines: the UK owned a diagonal strip from Normandy to
    Portugal (`shots/midgame.png`).
  * Labels overlap ("CHINA"/"INDIA" in `s2-zoom-20000.png`) and float on the limb ("SRI LANKA 687K" in `shots/territory.png`).
    Others hide under HUD panels: "ARGELIA" under the build bar, "ALEMANIA" under the leaderboard, "PORTUGAL" under the minimap.
    The cinematic chromatic aberration adds RGB fringes to label text near the screen edges.
* **F11 Battles.** From 2,500 km a front is an orange pixel blob with a few fireballs. You can't tell who attacks whom,
  which way it moves, or who is winning (`s5-front-2500-a.png`). At 600 km smoke columns fill the screen
  (`s5-front-600-b.png`). The ground battle at 2.5 km looks great (`shots/front.png`, `shots/front-wide.png`) but carries no
  nation labels, no front direction and no winner.
* **F13 Missiles.** The launch plume is sized to the camera distance *at launch*. My S2 launches from Madrid left a white
  blob ~600 km wide over Spain, and zooming to 700 km and 200 km turns the whole screen white (`s2-zoom-6000.png`,
  `s2-zoom-2000.png`, `s2-zoom-700.png`, `s2-zoom-200.png`). The nuke detonation itself looks good (`playtest2/07-atom.png`).
* **F15 Structures.** Each model is a flat piece on one anchor at the tile center, scaled up to 18–30 px on screen. On relief it floats
  or sinks (CODEMAP `pyr-*.png`). Close up the models look like toys on a blue plane (`shots/structures.png`,
  `s3-city-L1-60.png`, `s4-upgrade-before.png`). Upgrading SAM level 1 → 2 changes nothing visible (`s4-upgrade-after.png`).
* **F16 "Exists just because" / badly explained**, seen in play:
  * Radar's description is false (CODEMAP §24).
  * "FUERZA 800" and "315 km/h" in the unit panel.
  * Grammar: "Hemos capturado **un(a) Puerto**", "El enemigo ha capturado **nuestro(a) Ciudad**".
  * AI emotes pop up as toasts ("Dinamarca: 🎯 Objetivo", "Sudáfrica: 🎯 Objetivo").
  * The population number drives nothing.
  * Command operation names are in English ("BROKEN TEMPEST", "COBALT VANGUARD").
  * The end screen said **"TROPAS PERDIDAS 470"** after my nation was wiped out holding 127K troops (`s1-end.png`).

---

## 5. What already works (keep it)

* Menu, setup and end-screen presentation, the Spanish text, the HUD styling. The end screen's timelapse and territory graph are good.
* The nuke alarm banner and siren, and the nuke detonation visuals.
* The ground battle layer at 2.5 km and the command-mode vehicles, HUD and debrief, as visual assets.
* Build placement feedback, hotkeys, the radial layout, Space/speed controls, 0 console errors in PT2.

---

## 6. Integration failures (`tools/playtest.mjs`)

* **PT1** (repo tool as-is, with a second browser loading the CPUs): the run **aborted after 12/17 steps**.
  * The "structures overview" `page.screenshot` sits outside `step()`. Its 30 s default timeout threw and killed the run,
    so nukes, attacks, command mode, invasion, alliance, pause and the end screen never ran.
  * The "4x speed" step failed on the same screenshot timeout.
  * "build Port / Factory / DefensePost / MissileSilo" failed with "no valid build tile". The human's capital had been
    captured (tick 7458, Easy) despite **8 emergency land grants**.
* **PT2** (a scratch copy with a 240 s screenshot timeout): **21/29**.
  * Passed: boot, menu, setup, spawn, expansion, speed keys, all 10 structures, buying armor, atom bomb (detonated,
    52.6 M casualties), mid-game overview, end screen → menu.
  * Failed: hydrogen bomb ("neither detonated nor intercepted"). Turkey, the atom bomb's victim with 47 % of the world,
    struck back and eliminated the human (1,693 tiles) at tick 6002, taking the silo.
  * Every later step then failed because the game was over: attack at 50 %/75 % (the HUD was gone), TAKE CONTROL ("tank
    vanished"), exit command, invasion ("no coast"), alliance request, pause.
  * Console errors: 0.
* **Consequence**: the harness does not verify command mode, naval invasion, alliances or pause, because the human never
  survives long enough. I checked those manually (§3): they work mechanically.
* **Harness defects**: screenshots outside `step()` abort the whole run. The 30 s screenshot timeout is too short for
  SwiftShader. The script assumes a passive human survives ~20 min on Easy (it survives 22 s to 12 min, §2.4).

---

## 7. Defect list

Severity: **blocker** means the owner will reject the build over it. **Major** means clearly visible and hurts play.
**Minor** means polish.

| ID | F | Sev | Defect | Evidence |
|---|---|---|---|---|
| A01 | 3 | blocker | An attacker with 1.5–2× the troops takes half of a 1,288-tile nation in 1.6 s (0.4 s at 4x) and the capital in 1.3 s. Odds don't change the speed. | §2.2 controlled run |
| A02 | 3, 12 | blocker | Encirclement annexes whole nations, including the human with its capital and 100K+ troops, with no attack and no warning. It ignores the human grace period. | S6; §2.4 (4/15 runs); `enclaves.ts` |
| A03 | 1 | blocker | Units move 82–400 km per real second at 1x. Class speeds are mutually inconsistent (tank ×7,900 vs ICBM ×46 real). | §2.1 |
| A04 | 1, 11 | blocker | World tempo: 136 attacks/min and 11.7 eliminations/min at the start. 65 → 30 factions in 2 min. A full game lasts 23.5 min (5.9 real min at 4x). | §2.5, §2.7 |
| A05 | 3 | major | Defender troops don't resist. A full-cap defender equal in size to the attacker is erased in 1.3 s. | S3 |
| A06 | 11 | major | Empire-scale swings. A 60 %-of-the-world nation disappears in ~2.5 min. The human autopilot lost 55,600 tiles in 5.8 s. | §2.2 |
| A07 | 12 | blocker | Attacks on you are announced only by a toast, the same tick the first tile falls, with no location and no marker. Invasions land 3.2 s after the toast (0.8 s at 4x). | §2.3 |
| A08 | 12, 14 | major | The human grace period ends and a lethal attack follows at once. On Hard, 4/5 spawns die at 146–150 s. | §2.4 |
| B01 | 16 | major | The spawn phase opens on the dark Pacific with a blank minimap and unlabeled AI blobs. | `s1-spawn.png` |
| B02 | 16 | major | Clicks on AI-held land (e.g. Madrid) are refused with only a beep and ripple. On timeout the player is auto-spawned somewhere random and far (Newfoundland, Quebec) with no notice. | S1, S3 |
| B03 | 16 | minor | The tutorial starts ~2 min into the game. The expand tooltip offers expansion on land you cannot reach. | `s1-autospawn-home.png`, `s1-spawned.png` |
| C01 | 8 | blocker | TAKE CONTROL at peace inside your own land starts a scripted mission against a random non-neighbour: Tunisia, no border, no war. | `s4-command-*.png` |
| C02 | 8 | blocker | Command driving doesn't move the real unit (frozen). There is no border crossing and no alert. The strategic war keeps running unseen (5+ game-min of losses reported only as toasts). | S4 |
| C03 | 7 | major | There is no army roster. Bought units appear silently. Units can be found only by hunting 3D models, and a click can select the wrong unit. | S4 |
| C04 | 9, 16 | major | The unit panel lies or says nothing useful: "315 km/h", "Fuerza 800". Units' strategic role is not explained. | `s4-tank-selected.png` |
| C05 | 16 | minor | Command-mode operation names are in English inside the Spanish UI. | `s4-command-intro.png` |
| D01 | 10 | blocker | The territory fill is too faint (own and dark colors). Land owned by someone else looks unowned. At ≤ 900 km, ownership is not readable. | `shots/territory.png`, `s3-iberia-t800.png`, `s2-zoom-40.png` |
| D02 | 10 | major | The night side (half the globe, 12-min days) is black: nations and islands can't be read. | `playtest2/05-structures.png`, `s5-islands-aegean.png` |
| D03 | 10 | major | Blocky tile-staircase borders, white pixel-square conquest flashes, straight artificial borders. | `s5-front-2500-a.png`, `s7-invasion-a.png`, `shots/midgame.png` |
| D04 | 10 | major | Labels overlap, float on the globe limb and hide under HUD panels. Chromatic aberration adds RGB fringes to text. | `s2-zoom-20000.png`, `shots/territory.png`, `s3-iberia-t800.png` |
| D05 | 5 | blocker | Opaque clouds (0.96) are drawn over the territory and hide whole nations. | `s1-autospawn-home.png` |
| D06 | 6 | major | Small islands are invisible or 1–3 px. Remote islands stay unowned. | `s5-islands-*.png` |
| D07 | 4 | major | No 2D icon layer. From orbit, 3D units and structures clutter the map at toy scale. | `s2-zoom-6000.png`, `shots/territory-close.png` |
| D08 | 10, 17 | major | The close zoom (≤ 40 km) outside battles is a blurry low-res ground with nothing to read. At 45 km, owned land looks like water with a hard seam. | `s2-zoom-8.png`, `s4-upgrade-before.png` |
| E01 | 13 | major | The launch plume is scaled to the camera distance at launch: a ~600 km white blob that fills the screen when you zoom in. | `s2-zoom-700.png`, `s2-zoom-200.png` |
| E02 | 13 | major | 31–50 % of AI nukes hit nations the launcher isn't fighting, across continents. There is no escalation ladder or casus belli. The late game reaches ~9 launches per minute. | §2.6, PT1 |
| E03 | 11, 13 | major | A front seen from orbit is an orange pixel blob plus fireballs: no sides, no direction, no winner. At 600 km smoke hides everything. | `s5-front-*.png` |
| E04 | 16 | minor | Rebellions fire back-to-back against the leader (3 in 6 min), and one successor state took 60 % of the world. | S4 |
| F01 | 2 | major | Ship wakes are white, short (~7 s) and scattered. The owner's color and the full route are missing. | `shots/units.png`, `s3-iberia-t800.png` |
| G01 | 15 | major | Structures are flat models on a single anchor, scaled up to 18–30 px on screen. They float or sink on relief and look like toys on a plane. | `shots/structures.png`, CODEMAP `pyr-*.png` |
| G02 | 15, 16 | major | The upgrade button has no cost and no effect text. SAM level 1 → 2 has no visible change. The failure message is a generic "no gold". | `s4-upgrade-*.png` |
| H01 | 14 | blocker | Diplomacy has no dialogue or reasons. The AI let my request time out, then the game showed "rechaza tu alianza" plus a "👎 Mal" emote. AI requests to you expire in 20 s (5 s at 4x). | `s4-alliance-reply.png` |
| H02 | 14, 16 | minor | Emote spam as toasts ("Dinamarca: 🎯 Objetivo"). "Marcar objetivo" is unexplained. | `s4-command-intro.png` |
| I01 | 16 | minor | Gendered placeholders in toasts: "un(a) Puerto", "nuestro(a) Ciudad". | `s4-unit-bought.png` |
| I02 | 16 | minor | The Arsenal tooltip shows a stale price (202.500 while the slot says 255K). | S4 |
| I03 | 17 | minor | The end screen shows "TROPAS PERDIDAS 470" after being wiped out with 127K troops. | `s1-end.png` |
| I04 | 16 | minor | Radar's in-game description is false. The population number has no effect (CODEMAP §24). | CODEMAP |
| J01 | 17 | major | The playtest harness aborts on an unguarded screenshot timeout and assumes the human survives. Command mode, invasion, alliance and pause stay unverified. | §6 |

---

## 8. How to reproduce

* **Pace numbers (headless, seconds each)**: `src/sim/test/pace-audit.mjs` was added by this audit. It uses the cached
  WorldInit from `src/sim/test/world.mjs`.
  * `npx tsx src/sim/test/pace-audit.mjs conquest --mult 2` gives the §2.2 controlled run. Expected today:
    capital 13 ticks, half 16 ticks, 198 tiles in one tick.
  * `npx tsx src/sim/test/pace-audit.mjs survival --difficulty normal --seed 21 --lat 40.4 --lon -3.7` gives the §2.4 table (swap lat/lon/difficulty).
  * `npx tsx src/sim/test/pace-audit.mjs game --difficulty normal --seed 11` gives §2.5–2.7.
  * v2 targets to check against: no nation loses half its land to one attack in under a few game-minutes; encirclement
    never erases a nation without a visible siege; the passive-human survival floor is well above today's 22 s.
* **Screenshots**: run the dev server on port 5301, then `node tools/capture.mjs --url http://127.0.0.1:5301/ --shot
  structures,units,front,front-wide,command-tank,command-ship,territory,midgame,radial,nuke-alarm,territory-close --out
  shots/audit/shots --wait 8000 --timeout 240000`. With a second browser running, use a screenshot timeout of ≥ 240 s.
* **Live sessions** were driven by a persistent Playwright page. It used real mouse and keyboard on the canvas and HUD,
  and set the camera with `ctx.cameraRig.setState` in place of dragging. An in-page recorder wrapped `ctx.bus.emit`
  (events with tick and wall time), sampled `ctx.sim.view.playerList` every second, and accumulated unit displacement
  per type from `view.units` on every `simTick`.
