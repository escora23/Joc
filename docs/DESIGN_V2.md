# FRONT ULTRA v2: game design

Written by the v2 lead designer and technical lead on 2026-09-25, from `docs/FEEDBACK-1.md` (the owner's verdict, cited
**F1…F17**), `docs/AUDIT-1.md` (measured defects, cited by their IDs **A01…J01**), `docs/CODEMAP.md` (where things live
today, cited **CM§n**), `PROMPT.md` and `ARCHITECTURE.md`.

**Authority.** This document decides what v2 does. Where it conflicts with `PROMPT.md` or `ARCHITECTURE.md`, this
document wins. `ARCHITECTURE.md` still governs the mechanics of the codebase (boot order, render passes, shaders compiled
at load, determinism, i18n, shots), with the ownership rule relaxed: each workstream (§16) owns an area but may edit any
file its task needs, keeping edits outside its area small and coherent.

**Verdict we are answering.** *"Todo está bien hecho pero no está bien juntado."* The pieces (globe, battle layer,
command vehicles, HUD) are good. The rules and the time scale that tie them together are what make the game feel like
a frantic arcade. v2 turns FRONT ULTRA into a deliberate, readable, realistic **geopolitical war simulator**: one clock,
wars that are declared and fought at a human pace, a map you can read at a glance, units with a job, diplomacy that
talks back, and a command mode that drops you into the real war at the unit's real position.

---

## 0. How to use this document

* **Notation.** `h` = game hours. `tick` = one simulation step (6 game minutes). "s at 1x" = real seconds at speed 1x.
  "tiles/h" = tiles per game hour. A tile is 25.0 km north–south everywhere and `25.0·cos(lat)` km east–west.
* **Numbers are starting values.** Workstreams may tune a number inside the range given next to it, or outside it with a
  written reason, as long as the targets of §3 are met. Whoever changes a number updates this file in the same commit.
* **The sim is authoritative.** The UI never guesses a rule the sim does not enforce. Where the UI must predict (order
  previews, build ghosts, attack odds), both sides call the same pure function in `src/shared` (§14.1).
* **Determinism rules of CM§2.3 still hold.** New randomness uses new `game.rng` forks appended after the existing ones.
* **Every player-facing string** goes through i18n in Spanish (default) and English, written naturally (§12.7).
* **Every new visual** gets a `?shot=` stager (§16 lists the new shots) and every new mechanic a headless measurement
  (§3 lists the tools).

---

## 1. Design pillars and what we cut

### 1.1 Pillars

| # | Pillar | The test a feature must pass | Feedback |
|---|---|---|---|
| P1 | **One world, one clock.** Every unit moves at a real speed on one game clock: at 1x, 1 real second = 1 game hour. Slower clocks (crisis, tactical) only slow the whole world down; they never make one unit class cheat. | Can I say how long it takes, in game hours, and does it match the real world within reason? | F1, F11 |
| P2 | **War is a decision.** Everyone starts at peace. Wars are declared, announced and fought along fronts that move at an operational pace. Force decides who wins and at what cost, never how many tiles fall in one frame. Wars end with treaties. | Could a player at peace lose land without first being told a war was coming? (Must be no.) | F3, F11, F12, F13, F14 |
| P3 | **Read the world at a glance.** Who owns what, where the fighting is, who is winning, and what is coming at you, at every zoom, day or night, under clouds. | Can a new player answer those four questions from one screenshot at 3,000 km? | F4, F5, F6, F10, F11, F2 |
| P4 | **Every piece has a job.** Every unit, building and level has a purpose you can feel on the map, stated in its tooltip with numbers. What has no purpose is cut. | Can the tooltip say what it does, with numbers, and can I see the effect on the map? | F7, F9, F15, F16 |
| P5 | **Time to think.** Warnings come before blows, alerts say where, the AI deliberates before answering, and the game can pause itself on the events that matter. | When something bad happens to me, did I get a located warning with enough time to react? | F12, F14 |
| P6 | **The real war is the war you fight.** Command mode is a window into the simulation at the unit's real position. What you meet there is what the simulation has there; what you do there changes the simulation. | Is anything in command mode invented, rather than derived from the sim? (Must be no.) | F7, F8 |

### 1.2 What we keep

The audit (AUDIT-1 §5) lists what already works. We keep it and build on it: menu, setup and end-screen presentation;
HUD styling; the nuke alarm banner, siren and detonation visuals; the ground battle layer at 2.5 km; the command-mode
vehicles, controllers, effects and HUD styling; build placement feedback and hotkeys; the radial layout; pause and
speed controls; the timelapse; the deterministic shot system.

### 1.3 What we cut or rework

| Today | v2 | Why |
|---|---|---|
| Conquest budget `B/(speedK·cost)` with the `max(1, ratio/20)` accelerator; up to 2,664 tiles in one tick (CM§4) | Absolute advance cap in km/h per front, force ratio decides speed up to the cap and decides casualties (§4.5) | F3, A01, A05 |
| Opposing attacks annihilate each other at launch | One two-sided battle per front (§4.8) | Unreadable, instant |
| Encirclement annexes pockets of ≤ 900 tiles and whole nations of ≤ 400 tiles in one step (`enclaves.ts`) | Sieges: announced, timed, fought (§4.12). No ownership change without a war, ever | A02 |
| Implicit "war" = any attack in the last 900–1,200 ticks | Explicit pair states: peace, war, truce, plus treaties (§4.1, §5.2) | F13, F14 |
| Nukes turn land neutral (700–1,150 km H-bomb radius) | Nukes kill, destroy and contaminate; land keeps its owner; realistic-but-readable radii (§4.14, §6.3) | A06, E02 |
| Timer-and-doomsday nukes, 50 % dice-roll cruise missiles | War plans, an escalation ladder with reasons, global caps (§5.10) | F13, E02 |
| Doomsday clock drives AI nukes | Doomsday clock measures real escalation (§5.11) | F13, F16 |
| Emotes as the only "conversation"; AI emote toasts; quick-chat on Enter | Diplomatic messages with reasons, an inbox, a nations panel (§5, §8). The `emote` command stays in the protocol, unused by the UI | F14, H02 |
| "Marcar objetivo" (`targetPlayer`), unexplained, with a broken message | "Pedir ayuda a los aliados" (call to arms), explained (§5.5) | H02 |
| Alliances expire after 10 min; requests to you expire in 20 s | Alliances are open-ended with a 48 h notice to leave; proposals wait 72 h in the inbox (§5.2, §5.3) | H01 |
| Scripted command missions, objectives, waves, friendly air strikes, English operation names | Command mode at the real position against real forces (§9) | F8, C01, C02, C05 |
| Decorative battle-layer armies | Battle composition from the real front and the real divisions (§11) | F11 |
| Population is a cosmetic number | Population drives recruitment and taxes; nukes and pandemics hurt it (§6.7) | I04 |
| Radar promises detection that does not exist | Radar gives early warning and extends SAM and interceptor reach (§6.2) | I04 |
| 3D models inflated to 18–46 px from orbit | NATO-style 2D icons from orbit, grounded real-size models close up (§10.7) | F4, D07 |
| White 7 s ship wakes | Owner-coloured route lines from departure to arrival (§10.8) | F2, F01 |
| Opaque clouds over the territory | Strategic cloud mode (§10.5) | F5, D05 |
| Random auto-spawn after 90 s, silent refusal on AI land | The spawn phase waits for you and explains refusals (§12.6) | B01, B02 |
| `src/sim/fallbackAi.ts` (461 lines, a second AI that ignores v2 rules) | Reduced to a no-op that logs the fault | CM§24 |
| `Settings.edgePan` toggle that nothing reads, `three-globe` dependency, `tools/.cap-battle*.mjs`, `tools/.crop-battle.mjs` | Removed | CM§24 |
| "Tribes" | Shown as **Territorios independientes / Independent territories**: stateless militias, no diplomacy, attackable without a declaration (§4.10) | Realism, F16 |
| Insane-difficulty cheats hidden | Kept, disclosed in the setup tooltip ("La IA recibe +18 % de oro") | F16 |

---

## 2. Time scale

### 2.1 The one clock

| Quantity | Value | Notes |
|---|---|---|
| Game time per tick | **6 game minutes** (`GAME_SECONDS_PER_TICK = 360`) | `TICK_MS = 100` and `UPDATE_INTERVAL_MS = 100` are unchanged |
| Ticks per game hour / day | 10 / 240 | `TICKS_PER_GAME_HOUR`, `TICKS_PER_GAME_DAY` |
| Speed 1x | 10 ticks per real second = **1 game hour per real second** | default |
| Speeds offered | pause, **0.5x**, 1x, 2x, 4x | 0.5x is new (`GameSpeed` gains `0.5`) |
| A tile | 25.0 km N–S; 25.0·cos(lat) km E–W | `TILE_KM` |
| Speed conversion | `tilesPerTick = kmh × 0.1 / 25.02 = kmh / 250.2` along a meridian | `kmhToTilesPerTick(kmh)` |
| Game length target | 60–120 real minutes at 1x on Normal = 3,600–7,200 game hours = 150–300 game days = 36,000–72,000 ticks | §3 |
| Visible day/night cycle | **Its own presentation clock**: one visual day lasts 1,200 s at 1x (20 real minutes; 5 min at 4x) | §2.6 |

The seed decision (1 real s = 1 game hour) is kept. Two consequences are made explicit:

* **Ballistic missiles cannot keep their real speed on the strategic clock.** A 30-minute ICBM flight would last 0.5 s.
  The seed also asked for "an ICBM flight of ~30 min lasting ~30 s = the warning window", which is impossible on a
  single fixed clock. v2 resolves it with **crisis time** (§2.2): while any nuclear weapon is in flight, the whole
  world clock slows by 60×. Every unit keeps its real speed, the ICBM flies its real 10–35 game minutes, and those
  minutes last 10–35 real seconds. This keeps pillar P1 (no unit class cheats) and gives the DEFCON moment the prompt
  asks for.
* **Aircraft are fast.** A jet at 900 km/h crosses Europe in 4 s at 1x. That is the honest consequence of the scale.
  Air war is therefore decided by preparation (patrols, SAM coverage, radar), not by reflexes, and air sorties leave
  their route lines on the map for 10 s so the player sees what happened (§10.8).

### 2.2 Clock modes

The sim advances by accumulating fractional ticks: every 100 ms of wall time the worker adds
`rate × 0.1 / 360` ticks, where `rate` is game seconds per real second, and runs the whole ticks accumulated.

| Mode | When | Rate (game s per real s) | Ticks per real s | What the player sees |
|---|---|---|---|---|
| Paused | Space, pause button, auto-pause | 0 | 0 | Commands still apply (plan on a frozen world) |
| Strategic | default | 3,600 × speed | 5 / 10 / 20 / 40 | HUD: `1x · 1 s = 1 h` |
| **Crisis** | Any atom bomb, H-bomb, MIRV or warhead in flight (setting `crisisTime`, §8.5) | 60 × speed | speed / 6 (1 tick every 6 s at 1x) | Amber banner `TIEMPO DE CRISIS · impacto en 0:21`; music drops to a drone; the world visibly slows |
| **Tactical** | Command mode with contact (§9.3) | 1 | 1/360 | Real time. Fronts elsewhere are effectively frozen |
| **Travel** | Command mode without contact, chosen by the player | 10 / 60 / 300 / 900 | 1/36 … 2.5 | `VIAJE ×300 · 1 s = 5 min` |

Crisis starts on the tick a nuclear weapon is launched and ends 2 real seconds after the last nuclear weapon in flight
detonates or is intercepted, then ramps back to strategic over 1.5 real seconds. Overlapping launches extend it.
Crisis never engages in command mode (tactical time is already slower).

### 2.3 Unit speeds and reference trips

Great-circle distances. "s at 1x" = game hours. In crisis time multiply by 60.

| Unit | Real-world reference | v2 speed | tiles/tick | Reference trips (real s at 1x) | v1 speed (tiles/tick) |
|---|---|---|---|---|---|
| Armored division, road march on own, allied or open-border land | Division road march incl. halts, ~30–45 km/h | **40 km/h** | 0.160 | Madrid→Barcelona 505 km: **12.6 s**. Lisbon→Barcelona 1,000 km: 25 s. Paris→Berlin 880 km: 22 s | 0.35 (82 km/s) |
| Armored division by rail (§6.2, Factory) | Military rail transfer | 100 km/h | 0.400 | Madrid→Barcelona 5 s. Paris→Berlin 8.8 s | – |
| Armored division attached to a front | Moves with the front | ≤ 8 km/h | ≤ 0.032 | see front row | – |
| Train (gold) | Freight train | 100 km/h | 0.400 | Crossing France 1,000 km: **10 s** | 1.5 |
| Transport convoy (naval invasion) | Troop convoy, 19 kn | **35 km/h** | 0.140 | Portsmouth→Normandy 170 km: 4.9 s (+6–12 s embarkation). Tunis→Palermo 310 km: 8.9 s. Lisbon→New York 5,420 km: **155 s (2 min 35 s)** | 1.2 |
| Trade ship | Container ship slow steaming, 16 kn | 30 km/h | 0.120 | Lisbon→New York 181 s. Gibraltar→Port Said 3,300 km: 110 s | 1.0 |
| Warship (naval group) | Destroyer cruise, 30 kn | 55 km/h | 0.220 | Lisbon→New York 99 s. Gibraltar→Port Said 60 s | 0.9 |
| Fighter squadron | Cruise Mach 0.85 / dash Mach 1.7 | 900 / 1,800 km/h | 3.60 / 7.19 | Madrid→Paris 1,054 km: 1.2 s (0.6 s dash). Lisbon→Moscow 3,900 km: **4.3 s** | 1.1 |
| Bomber | Subsonic bomber | 850 km/h | 3.40 | Madrid→Paris 1.24 s. Lisbon→Moscow 4.6 s | 0.7 |
| Drone swarm | MALE drones / loitering munitions | 200 km/h | 0.80 | 1,000 km: 5 s | 0.65 |
| Cruise missile | Tomahawk-class | 880 km/h | 3.52 | Madrid→Paris 1.2 s; max range 2,500 km: 2.8 s | 1.6 |
| Ballistic missile (atom bomb, H-bomb, MIRV) | Minimum-energy trajectory | flight time `T = clamp(7 + 2.5·d/1000, 8, 35)` game min, `flightTicks = ceil(T/6)` | – | Madrid→Paris: 2 ticks = 12 min → **12 s in crisis at 1x**. Beijing→Tokyo 2,100 km: 18 s. Moscow→Washington 7,820 km: **30 s** | 1.1–1.3 |
| SAM interceptor | Mach 4 | 5,000 km/h | 20.0 | Engagement at 200 km: 2.4 game min (2.4 s in crisis) | 3.2 |
| Front advance, cap | Fastest blitz, exaggerated ×2 | **8 km/h** (`ADVANCE_MAX_KMH`) | 0.032 | One 25 km tile per 3.1 s at 1x at the cap. Pyrenees→Madrid 400 km: 50 s at the cap, ~100 s typical | up to 0.64 × frontier per tick |
| Neutral expansion | Occupation march | 7.5 km/h (`NEUTRAL_ADVANCE_KMH`) | 0.030 | Valladolid→coast 350 km: 47 s | B/9 tiles per tick |

Purely visual projectiles (shells, SAM streaks, tracers from `combat` events) get a **minimum visual duration** of
0.4 real seconds so they stay visible at strategic speeds; they carry no sim state.

### 2.4 Other durations

| What | Game time | Ticks | Real time at 1x |
|---|---|---|---|
| City / Port / Factory / Defense post / SAM / Silo / Airbase / Army base / Naval yard / Radar construction | 5 / 5 / 6 / 5 / 30 / 10 / 12 / 10 / 12 / 8 h | 50 / 50 / 60 / 50 / 300 / 100 / 120 / 100 / 120 / 80 | same number of seconds |
| Upgrade | 50 % of the construction time | | |
| Unit production: armored division / fighter / bomber / drone swarm / warship | 8 / 6 / 10 / 4 / 16 h | 80 / 60 / 100 / 40 / 160 | |
| Silo reload by level 1/2/3 | 24 / 12 / 8 h | 240 / 120 / 80 | |
| SAM reload | 2 h | 20 | |
| Aircraft rearm: fighter / bomber / drone | 2 / 6 / 4 h | 20 / 60 / 40 | |
| Troop regrowth 10 % → 90 % of the cap | 33–79 h (unchanged formula; now read as "per 6 game minutes") | | 33–79 s |
| Defender mobilization at a new front | 6 h | 60 | 6 s |
| AI mobilization after declaring war (Easy/Normal/Hard/Insane) | 12 / 8 / 6 / 4 h | 120 / 80 / 60 / 40 | |
| Ultimatum deadline (Easy/Normal/Hard/Insane) | 36 / 24 / 16 / 12 h | 360 / 240 / 160 / 120 | |
| AI deliberation on a proposal | 4–24 h by kind (§5.3) | 40–240 | |
| Proposal to the human stays in the inbox | 72 h (peace 120 h; call to arms 24 h) | 720 / 1,200 / 240 | never expires while paused |
| Non-aggression pact | 30 days | 7,200 | 12 min |
| Truce after a peace treaty | 20 days | 4,800 | 8 min |
| Notice to leave an alliance | 48 h | 480 | |
| Occupation → integration of conquered land | 72 h | 720 | |
| Fallout (atom / H-bomb inner; outer ×0.5) | 30 / 60 days | 7,200 / 14,400 | 12 / 24 min |
| Human grace (no AI war declaration on you) Easy/Normal/Hard/Insane | 37.5 / 25 / 15 / 10 days | 9,000 / 6,000 / 3,600 / 2,400 | 15 / 10 / 6 / 4 min |
| AI clocks (war / build / military / naval / diplomacy, Normal) | 2.8 / 10 / 19 / 65 / 33 h | unchanged tick values (CM§7) | |
| Spawn phase | waits for the human (§12.6) | – | – |

### 2.5 Implementation rules for time

* **Speeds live in km/h.** `UNIT_DEFS[t].speedKmh` is the source of truth; `speed` (tiles/tick) is derived from it at
  module load. Nothing else hard-codes tiles/tick.
* **Movement uses a local metric.** Moving `s` km toward a heading moves `(s·sinθ / (TILE_KM·max(0.2, cos φ)),
  −s·cosθ / TILE_KM)` in tile coordinates (x east, y south). One helper, `advanceKm(u, targetX, targetY, km)` in
  `src/sim/spatial.ts`, is used by every mover (ships, trains, armor, aircraft, cruise missiles). Ballistic flights
  keep their progress-based great-circle `slerpTiles`.
* **Interpolation uses the tick period.** The client keeps `lastTickWallMs` (the wall time of the last update with
  `ticks > 0`) and `tickPeriodMs` (from `TickUpdate.clock`), and sets `alpha = clamp((now − lastTickWallMs) /
  tickPeriodMs, 0, 1)`. At 4x, several ticks arrive per update and `prev*` stays the previous update, as today.
* **Three clocks for renderers**, all in `FrameInfo`:
  * `frame.simTime` / `frame.simDt`: **presentation seconds** = ticks / 10 (1 per real second at 1x, 1/60 in crisis).
    Unchanged meaning for existing consumers (fire, smoke, unit animation), which therefore slow down in crisis.
  * `frame.gameHours`: new, `tick / 10` interpolated, for the war clock and ETAs.
  * `frame.visualDt`: new, `frame.dt` when the game is not paused, else 0. The battle layer and anything that should look
    the same at every speed use it (§11.6).
* **Per-tick rates stay per tick** (troop growth, gold, AI clocks). Their meaning is now "per 6 game minutes"; the
  values in §2.4 already account for it. Tooltips display rates **per game hour** (`×10`).
* **Staged shots.** Shots that fast-forward (`territory`, `midgame`, …) are retuned to the new pacing (W1, §16).

### 2.6 Day and night

The sun runs on the presentation clock: `frame.worldTime = startWorldTimeSec + simTime · (86,400 / 1,200)` with
`DAY_LENGTH_SEC = 1200` presentation seconds. One visual day is 20 real minutes at 1x. It never affects the sim. The
terminator therefore moves slowly enough not to strobe, and the night side stays readable by design (§10.4). In crisis
and tactical time the sun is effectively still. The HUD war clock (§2.7) is not the local solar time and does not claim
to be.

### 2.7 How the player sees time

* Top bar, next to the speed buttons: **`DÍA 12 · 14 h`** (elapsed war time: day 1 starts at 00 h) and the scale chip
  `1x · 1 s = 1 h` (0.5x: `1 s = 30 min`; crisis: `CRISIS · 1 s = 1 min`; command mode: `TÁCTICO · 1 s = 1 s` or
  `VIAJE ×300`).
* The speed buttons are pause, 0.5x, 1x, 2x, 4x. Hotkeys `+`/`-` step through `[0.5, 1, 2, 4]`, Space pauses.
* Every ETA and duration in the UI is written in game time and, in the tooltip, in real time at the current speed:
  "Llega en 12 h (12 s a 1x)".

---

## 3. Pacing targets

All headless numbers are measured with `src/sim/test/pace-audit.mjs` (updated by W1 so that attacks follow a war
declaration) and `src/sim/test/harness.mjs`, on the cached WorldInit, 24 AI nations + 40 independent territories.
"s at 1x" = ticks / 10.

### 3.1 Conquest (F3, A01, A05)

| # | Measurement | Target | v1 (audit) |
|---|---|---|---|
| T1 | `conquest --mult 2`: 1,288-tile nation around Madrid, attacker gets 2× its troops and commits 100 % | first tile lost ≥ **20 ticks** after the offensive starts; capital ≥ **600 ticks**; half the land ≥ **900 ticks**; 90 % ≥ 1,300 ticks | 1 / 13 / 16 / 19 ticks |
| T2 | `conquest --mult 10` | half ≥ **600 ticks** | 16 ticks |
| T3 | `conquest --mult 1` | the defender keeps ≥ 70 % of its land after 3,000 ticks | falls in 1.3 s |
| T4 | Odds matter: `t_half(mult 4) / t_half(mult 2)` | between 0.4 and 0.85 | 1.0 (identical) |
| T5 | Largest land loss of one nation in one tick, any run | ≤ `3 + 0.04 × frontier tiles` of that front | 2,664 tiles |
| T6 | Tiles changing owner between two players **not at war**, whole game | **0**, except peace-treaty cessions, capitulations, rebellions and cleanup of eliminated players (§4.17) | encirclement annexes |

### 3.2 Warning and survival (F12, A02, A07, A08)

| # | Measurement | Target |
|---|---|---|
| T7 | `survival` (passive human, never plays), spawns Madrid, Paris, Berlin, Kansas, Brasília, seed 21 | minimum over the 5 spawns: Easy ≥ 16 min (9,600 ticks), Normal ≥ **11 min (6,600 ticks)**, Hard ≥ 7 min; median Normal ≥ 15 min. v1: 22 s minimum |
| T8 | Eliminations of the human without a prior `warDeclared` against the human | **0** |
| T9 | Warning before an AI war on the human: a `tension` or `ultimatum` event from that AI to the human | ≥ 240 ticks before `warDeclared` on Easy/Normal, ≥ 120 on Hard/Insane |
| T10 | `warDeclared` → first offensive of the aggressor | ≥ the mobilization of §2.4 (Normal 80 ticks) |
| T11 | Naval invasion against the human: `invasionDetected` → landing | ≥ 80 ticks for any crossing ≥ 100 km (embarkation included) |
| T12 | Nuclear launch at the human: alarm → impact | ≥ 8 real seconds at 1x (crisis time) |
| T13 | Attack on the human: located alert shown | same client frame as `attackStarted`; the first tile falls ≥ 20 ticks later (T1) |

### 3.3 World tempo and game length (F1, F11, A04, A06)

| # | Measurement (full game, `game --difficulty normal --seed 11`, human on autopilot) | Target | v1 |
|---|---|---|---|
| T14 | Domination (80 %) or last-standing win | at **36,000–72,000 ticks** (60–120 min at 1x). Hard: 30,000–60,000 | 14,100 ticks (23.5 min) |
| T15 | AI nations alive at tick 6,000 (10 min) | ≥ 20 of 24 | 65→30 factions in 2 min |
| T16 | New player-vs-player offensives (`attackStarted`, excluding neutral land and independent territories) | ≤ 6 per 600 ticks on average, ≤ 12 in any 600-tick window | 136 per min |
| T17 | War declarations | ≤ 1.5 per 600 ticks on average; each carries a reason key | implicit |
| T18 | Neutral land claimed | 50 % of the initially neutral land by 2,400–4,800 ticks (4–8 min); 90 % by 6,000–12,000 | ~1:20 for Iberia |
| T19 | Empire stability: any nation with ≥ 5,000 tiles | never loses > 20 % of its tiles in any 1,200-tick window unless ≥ 2 wars are active against it or it capitulates | 55,600 → 270 tiles in 58 ticks |
| T20 | Rebel successor states | ≤ 15 % of the world's land each, ≤ 40 % of the parent's land | 60 % |

### 3.4 Missiles, bombing and events (F13, E02, E04)

| # | Measurement (full Normal game) | Target | v1 |
|---|---|---|---|
| T21 | AI nuclear launches (atom, H-bomb, MIRV; warheads not counted) | 0–8 per game; **100 %** by a launcher at war with the target owner, with a recorded escalation level ≥ 3 and a reason key | 50 % tied to a war |
| T22 | First AI nuclear launch | not before 18,000 ticks (30 min) unless it retaliates for a nuclear strike on itself or an ally | 8,449 ticks |
| T23 | Spacing and concurrency of AI nuclear launches | ≥ 480 ticks between two AI launches worldwide; ≤ 2 AI nuclear weapons in flight | ~9 launches per min late |
| T24 | AI cruise missiles | ≤ 3 per 600 ticks worldwide; 100 % at nations at war with the launcher | dice roll |
| T25 | AI bomber and drone strikes | 100 % on nations at war with the owner | – |
| T26 | World events | first ≥ 6,000 ticks; ≥ 4,800 ticks apart; ≤ 1 rebellion per nation per 7,200 ticks | first at 1,200 |

### 3.5 Measured in the browser

| # | Measurement | Target |
|---|---|---|
| T27 | Unit speeds (debug-spawned units, km per game hour at 30–50° latitude, `pace-audit speeds` mode or `__front` recorder) | within ±10 % of §2.3 for armor, transport, trade, warship, train, fighter, bomber, drone, cruise |
| T28 | Crisis time: atom bomb Madrid→Paris at 1x | `view.clock.mode === 'crisis'` during flight; flight lasts 10–20 real s; strategic again ≤ 4 real s after detonation |
| T29 | Alliance proposal from the human to an AI | "considerando…" shown at once; answer after 40–240 ticks with a reason sentence; no emote toast |

---

## 4. Warfare model

### 4.1 Pair states and what they allow

Every pair of players (nations and the human) has exactly one **state** and any number of **treaties** (§5.2).

| State | Enter | Leave | Land attacks | Air/missile/naval strikes | Divisions may enter their land | Trade |
|---|---|---|---|---|---|---|
| **Peace** (default at game start) | start; peace treaty after the truce | declaring war | no (the click opens the declaration dialog) | no | only with open borders or alliance | yes, unless embargoed |
| **War** | `declareWar` by either side, or joining an ally's war | peace treaty or capitulation | yes, after the aggressor's mobilization | yes, within the escalation level (§5.10) | yes, as part of a front (attached) | no |
| **Truce** | peace treaty | after 4,800 ticks → peace | no; declaring war during a truce is a **betrayal** | no | no | yes |

Independent territories (v1 "tribes") and unclaimed land are outside this table: they can be attacked at any time, have no
diplomacy and generate no news. Rebels are at war with their parent from birth and at peace with everyone else.

### 4.2 Declaring war

**Human flow.** Left-clicking land of a nation at peace (or pressing "Declarar la guerra" in the nations panel or the
radial) opens a confirmation dialog, never a silent attack:

> **¿Declarar la guerra a Francia?**
> * Francia y el mundo lo sabrán de inmediato (noticia mundial).
> * Relaciones: Francia −60; sus aliados −30; resto del mundo −10 si la guerra no tiene motivo (Francia no te es hostil).
> * Aliados de Francia que entrarán en guerra contigo: **Italia**, **Suiza**. Tus aliados recibirán tu llamada a las armas.
> * Tienes un **pacto de no agresión** con Francia: romperlo te marcará como **traidor** 72 h (defensa −25 %) y −15 de
>   reputación con todos.
> * Tu ofensiva empezará al confirmar, con **60.000 tropas (50 %)** hacia el punto indicado.
>
> [Declarar la guerra] [Cancelar]

**AI flow.** An AI never attacks a nation at peace without the sequence tension → (ultimatum) → declaration →
mobilization of §5.7. The declaration carries a war goal and a reason key; its mobilization window (§2.4) shows the
aggressor's troops massing at the border (§11.2) before the first offensive.

**Consequences, both flows:** `warDeclared` event with goal, reason and `mobilizeUntilTick`; worldwide news; relation
reasons (§5.1); auto-embargo between the pair (trade stops); defensive allies of the target receive a call to arms (§5.5);
breaking a NAP, alliance or truce marks the aggressor as traitor (§5.6).

### 4.3 Fronts and offensives

* A **front** is a contiguous contact zone between two players at war (clusters of border tiles, as in `sim/fronts.ts`).
  Fronts exist for every war, even when nobody is attacking ("quiet front"). They have a **stable key** (§14.2).
* An **offensive** is today's `Attack`: troops committed by one side to push one front toward an axis point (the click).
  Only offensives move fronts. One offensive per (attacker, defender, front); a second click on the same front
  reinforces it and moves the axis.
* A player's troops are split into **home troops** (`troops`, which defend all fronts and garrison the land) and
  **committed troops** (`attackingTroops`, inside offensives). The attack-ratio slider sets the share of home troops a
  new offensive takes (default **50 %**, was 30 %).

### 4.4 Local power

For an offensive `a` of attacker A against defender D on front `f`:

* **Attack power** `Pa = a.troops × atkPower(A) × (1 + 0.25·armorA_f, max +100 %) × (1 + 0.15 if drone support on f)
  × (1 + 0.15 if naval bombardment on f's coastal part)`.
* **Defender garrison** `Gf = D.troops × (1 − DEFENSE_REAR_SHARE) × share_f × mob_f`
  * `share_f = w_f·L_f / Σ(w_g·L_g)` over D's fronts with an enemy offensive, where `L` is the front length in contact
    tiles and `w` the front priority set by D (normal 1, high 2, low 0.5; §11.3). One front → share 1.
  * `DEFENSE_REAR_SHARE = 0.15` (15 % always stays in the rear).
  * `mob_f` ramps linearly from 0.5 to 1.0 over `DEFENSE_MOBILIZE_TICKS = 60` (6 h) after the offensive starts: the
    defender needs time to move troops.
  * Troops of D's own counter-offensive on the same front add to `Gf` (§4.8).
* **Defense power** `Pd = Gf × defensePower(D) × (1 + 0.25·armorD_f, max +100 %) × (0.75 if D is a traitor)
  × (0.6 inside a siege, §4.12)`.
* **Force ratio** `R = Pa / max(1, Pd)`.

### 4.5 The advance rule

* Front speed: `v = ADVANCE_MAX_KMH × clamp((R − 1) / (ADVANCE_FULL_RATIO − 1), 0, 1)`, with
  **`ADVANCE_MAX_KMH = 8`** (range 6–12) and **`ADVANCE_FULL_RATIO = 3`**. At R ≤ 1 the front does not move. At 2:1 it
  moves at 4 km/h, at 3:1 and above at the cap. **The number of troops never raises the speed above the cap.**
* Neutral land: `v = NEUTRAL_ADVANCE_KMH = 7.5` (range 5–10), independent of troops; each tile still costs troops as
  today (`mag / NEUTRAL_LOSS_DIV`).
* **Pressure model** (replaces the budget loop of `AttackSystem.stepAttack`). Every frontier tile `t` of an offensive
  accumulates pressure each tick and falls when its pressure reaches 1:

  `p[t] += min(ADVANCE_MAX_KMH, v × armor(t)) × axis(t) / (TILE_KM × 10 × terrain(t))`

  so a plains tile on the main axis at the cap falls after 31 ticks (3.1 s at 1x), which caps the **depth** speed of
  every part of the front, spearheads included, at 8 km/h:

  | Factor | Values |
  |---|---|
  | `terrain(t)` (time multiplier, ≥ 1) | plains 1.0, hills 1.6, mountains 2.6; extra ×1.5 above 3,000 m, ×1.5 river, ×2 tile with a structure (urban), ×1.5 / 1.75 / 2.0 inside a defense-post zone L1/L2/L3, ×2 fallout, ×3 the defender's capital, ×1.4 within 3 tiles of an attached **defending** division |
  | `armor(t)` | ×1.5 within 3 tiles of an attached **attacking** division (armor lets a weaker offensive reach the cap; it never exceeds it) |
  | `axis(t)` (≤ 1) | 1.0 within 3 tiles of the line from the front centroid to the axis point, 0.8 up to 10 tiles, 0.6 beyond (the front bulges toward the click) |

* **Smoothing and caps.** A newly exposed frontier tile starts with pressure `0.35 × p(neighbour just taken)` plus a
  deterministic jitter in [0, 0.15) (`rng.fork('sim-front')`), so a front does not flip in rows. At most
  `3 + ceil(0.04 × frontierSize)` tiles fall per offensive per tick; the rest wait (T5). Every offensive begins with a
  **contact phase** of `OFFENSIVE_CONTACT_TICKS = 10` (1 h, "las tropas avanzan hacia la línea") before pressure starts.
  `mopUp` of notches stays, limited by the same per-tick cap. Armor spearheads no longer take free tiles.
* **Data.** Pressure is kept per offensive for its frontier tiles only (a `Map<tile, number>` or a shared
  `Float32Array(TILE_COUNT)` stamped with the attack id). Cost is O(frontier) per tick, ~20,000 tile updates per tick
  in the busiest phase, well inside the 25 ms budget.
* **Result.** A 40-tile front at the cap loses ~1.3 tiles per tick, tile by tile, visibly. A far bigger enemy still needs
  about a minute of real time at 1x to reach a capital 400 km away, and the tiles closest to the click fall first, so
  the arrow of §11.2 points where the danger is.

### 4.6 Casualties

While an offensive is engaged (its frontier is not empty), every tick:

* engagement `E = ENGAGEMENT_RATE × min(Pa, Pd)` with **`ENGAGEMENT_RATE = 0.002`** (range 0.001–0.004; 2 % per game
  hour of the smaller side);
* attacker loses `E × sqrt(Pd / Pa) × terrainDefense × fortification`; defender loses `E × sqrt(Pa / Pd)`;
  * `terrainDefense`: plains 1.0, hills 1.2, mountains 1.5, urban 1.4 (average over the tiles taken in the last 10 ticks,
    plains when none);
  * `fortification`: defense-post zone ×1.5 / 1.75 / 2.0 by level;
* attacker losses come out of `a.troops`, defender losses out of `D.troops` (home troops);
* neutral land costs troops per tile as in v1; independent territories use the full model with their own troops.

The stronger side wins **and** bleeds less; nobody teleports.

### 4.7 Defense is active

* Home troops defend automatically, split across threatened fronts by length and priority (§4.4). A player at war on
  one front defends it with 85 % of its home troops after 6 h.
* The defender's tools, all explained in the Fronts panel (§11.3): **priority** per front (high/normal/low), attach
  **divisions** (+25 % each, and they slow the enemy ×1.4 around them), build **defense posts** (5 h), **counter-attack**
  (§4.8), ask **allies** for help, propose **peace**.
* Troop regrowth continues during war; conquered land lowers the defender's cap (fewer tiles).

### 4.8 Two-sided battles

If D launches an offensive against A on a front where A already attacks D, the two offensives form **one battle**:

* A's offensive sees `Pd = Gf(D) + D.counterTroops`; D's offensive sees `Pa' = D.counterTroops` against
  `Pd' = Gf(A) + 0.5 × a.troops` (troops on the attack defend worse).
* Only a side with `R > 1` advances; both take the casualties of §4.6 from the same engagement.
* The front's `momentum` (§14.2) tells who is gaining. There is no instant annihilation at launch.

### 4.9 Stall, retreat and the end of an offensive

* `R < 1` for 120 ticks (12 h) → state **stalled** (`offensive` event, stage `stalled`, alert for the human).
* Ends when `a.troops < 10 %` of the troops committed so far, or `R < 0.5` for 60 ticks: the survivors return home
  after 20 ticks with a 10 % loss (`RETREAT_LOSS`). No more "the rest die".
* Manual **retreat** (Fronts panel, or the offensive's card): troops return in 20 ticks with a 10 % loss.
* An offensive whose frontier empties (the defender is gone or the front closed) ends and returns its troops.

### 4.10 Neutral land and independent territories

* Unclaimed land is expanded into at `NEUTRAL_ADVANCE_KMH` (§4.5) for a troop cost per tile. No declaration.
* Independent territories (kind `tribe`) hold small troop pools. They are attacked with the full model, without a
  declaration, never make war on their own initiative against nations bigger than 3× their size, and do not appear in
  the diplomacy UI. Their label reads "Territorio independiente".

### 4.11 Naval invasions

1. **Order**: `B` over a coast or a click on land across water (§7). At peace this opens the declaration dialog.
2. **Embarkation**: at an own port within 600 km of the departure coast, 6 h; otherwise from the nearest own shore,
   12 h. The convoy (transport icon) is visible in port.
3. **Detection** (`invasionDetected`, §8.2): at embarkation if the departure point is inside the target's radar
   coverage (§6.2) or the target is the aggressor's neighbour across ≤ 400 km of water; otherwise when the convoy comes
   within 16 tiles (400 km) of the target coast. Minimum warning is therefore ~11 h.
4. **Crossing** at 35 km/h along the water path, which is sent to clients (`routes`, §14.5). Warships within 6 tiles
   intercept; escorting warships (same owner, within 3 tiles) give +50 % survival.
5. **Landing**: storming the first tile takes 2 h of pressure with coastal defense ×1.5 (defense posts apply). Then the
   beachhead is a normal front; it splits the defender's garrison share. Warships within 4 tiles of the beachhead give
   +15 % attack power (§4.4).
6. `MAX_BOATS = 3` convoys in flight per player.

### 4.12 Sieges (encirclement v2)

* A pocket of a player's land that has no sea access and is fully surrounded by players **at war with it** becomes
  **besieged** (`siege` event, stage `start`, alert and news). A pocket touching neutral land or a neutral third party is
  not a siege.
* Effects: `Pd ×0.6` on the pocket's fronts; the pocket's share of home troops (`tiles_pocket / tiles_total`) suffers
  2 % attrition per game hour; no construction inside.
* The pocket falls only through offensives at the normal capped rate. **Nothing is annexed in one step.** `enclaves.ts`
  `tryPocket` and `componentScan` annexation are removed.
* Neutral specks of ≤ 3 tiles fully enclosed by one player are absorbed as cleanup (no player involved).

### 4.13 Capitals, occupation, capitulation and elimination

* **Capital captured**: 15 % of gold looted (was 25 %), home troops −5 %, the capital moves to the largest city (or the
  deepest interior tile); news; the nation lives on.
* **Occupation**: a tile captured from a player is *occupied* for 720 ticks (72 h): it yields 25 % income and counts
  50 % for the troop cap. The owner texture's capture stamp (CM§15) already carries this; the globe draws it (§10.1).
* **Capitulation (AI only)**: an AI that has lost its capital **and** ≥ 70 % of its pre-war land **and** has exhaustion
  ≥ 80 capitulates to the enemy that took most of its land: its remaining land transfers to that enemy through a treaty,
  animated as a wave from the winner's border over 20 ticks, announced in the news. The human never capitulates
  automatically (it may propose surrender terms, §5.3).
* **Elimination**: when a player has 0 tiles.

### 4.14 Nuclear strikes and land

Nuclear detonations **never change ownership**. They destroy structures (inner radius), damage them (outer), kill troops
(the defender's garrison share in the radius: 60 % inner, 25 % outer) and civilians (70 % / 20 % of the tiles'
population), and leave fallout (§2.4): no income, no troop growth, no construction, advance ×0.5 (time ×2) through it.
Radii are in §6.3. This removes the empire-scale swings of A06.

### 4.15 War score, exhaustion and peace

* **War score** of A in the war with D, −100…+100: `60 × (tiles taken from D in this war / D's tiles at war start)
  − 60 × (tiles lost to D / A's tiles at war start) + 20 × (capital of D held) − 20 × (own capital lost)
  + 20 × tanh((troops killed − troops lost) / (A.maxTroops))`.
* **Exhaustion** of each side, 0…100: `+1 per 24 h at war + 40 × (war casualties / troop cap at war start)
  + 60 × (tiles lost in this war / tiles at war start)`, decaying 2 per 24 h at peace.
* **Peace treaties** (proposed from the nations panel or by the AI, §5.3):
  * **Paz blanca / White peace**: the war ends on the current lines.
  * **Cesión / Cession**: the loser also cedes a band of its tiles within 4 tiles of the current fronts, contiguous to the
    winner, capped at 15 % of the loser's land. The dialog shows the band on the map before sending.
  * **Tributo / Tribute**: 30 % of the loser's gold now plus 20 % of its income for 10 days (2,400 ticks).
* Peace ends the war, starts a 4,800-tick truce and emits `warEnded`. Allies who joined through a call to arms get their
  own peace with the same terms unless they refuse (then their war continues alone).

### 4.16 Protecting the human

* No AI declares war on the human before the grace of §2.4 (Normal 6,000 ticks). Tension messages may start 240 ticks
  before it ends.
* After the grace, the first war on the human needs ≥ 24 h of tension first (T9), and until tick 18,000 at most one AI
  (Easy/Normal) or two (Hard/Insane) may be at war with the human at once, allies joining through calls to arms included.
* The AI's `humanFocus` bias (CM§7) applies to target scoring only after tick 18,000.
* Nothing takes land from the human without a war (T6).

### 4.17 Invariants (checked by the harness)

1. `setOwner(t, new)` with `old ≠ 0`, `old ≠ new`, requires one of: `atWar(old, new)`, a treaty transfer (cession,
   capitulation), a rebellion, or `old` eliminated.
2. No tile flips twice in the same tick.
3. No AI offensive, strike, missile or naval invasion against a player it is not at war with.
4. No offensive of an aggressor before `mobilizeUntilTick`.
5. Losses per tick ≤ the cap of T5.

---

## 5. Diplomacy model and AI behaviour

### 5.1 Relations and opinion

Each AI nation holds an **opinion** of every other player, −100…+100, computed as the sum of **reasons**. Opinions are
not symmetric (France may like you while you are at war with its ally). The human has no opinion; the nations panel
shows each AI's opinion of the human with its reasons and values, updated live.

| Band | Opinion | What it means in play |
|---|---|---|
| Hostil | ≤ −50 | May build a casus belli against you, rejects everything but peace when losing |
| Fría | −50…−10 | Rejects alliances, may accept a NAP when threatened by someone else |
| Neutral | −10…+20 | Accepts trade agreements, considers NAPs |
| Cordial | +20…+50 | Accepts NAPs and open borders, considers alliances |
| Amistosa | ≥ +50 | Accepts alliances, answers calls to arms |

| Reason key (`diplo.reason.*`) | Value | Lasts / decays |
|---|---|---|
| `borderLong` (shared border > 60 contact tiles) | −10 | while true |
| `borderShort` (any shared border) | −3 | while true |
| `sizeThreat` (they have ≥ 2× our land and border us) | −5…−20 (scaled by ratio) | while true |
| `runawayLeader` (they hold > 30 % of the world) | −(0…30) × coalition | while true |
| `tradeAgreement` | +15 | while active |
| `tradeVolume` (per completed trade between us) | +1, max +10 | half-life 10 days |
| `alliance` / `nap` / `openBorders` | +25 / +10 / +5 | while active |
| `commonEnemy` (both at war with the same player) | +20 | while true |
| `atWar` | −60 | while at war |
| `pastWar` | −30 | half-life 20 days |
| `betrayedUs` | −60 | half-life 40 days |
| `reputationTraitor` (broke any treaty) | −15 | half-life 20 days |
| `unprovokedWar` (declared war on someone who was not hostile to them) | −10 | half-life 20 days |
| `nuclearUse` (used nukes on anyone) | −25 | half-life 30 days |
| `nukedUsOrAlly` | −90 | half-life 60 days |
| `incursion` (their units entered our land at peace, §9.7) | −15 | half-life 5 days |
| `gift` (gold or troops given; +1 per 5 % of one day of our income) | +1…+25 | half-life 10 days |
| `embargoOnUs` | −20 | while active |
| `rejectedUltimatum` / `acceptedUltimatum` | −15 / +10 | half-life 10 days |
| `refusedCallToArms` / `answeredCallToArms` | −20 / +20 | half-life 20 / 30 days |
| `personality` (affinity: traders like traders, conquerors distrust conquerors) | −10…+10 | permanent |

Decay is evaluated every 24 h (240 ticks). The sim stores reasons per AI brain (`SimPlayer.aiMemory`) and publishes
the human-facing ones (`opinions` in `TickUpdate`, §14.5).

### 5.2 Treaties

| Treaty | Effect | Duration | Leaving | AI accepts when (Normal) |
|---|---|---|---|---|
| **Alianza / Alliance** | No war between the pair; each is called to arms when the other is attacked; divisions may transit; aircraft may use each other's airspace; ally hatching on the map | open-ended | 48 h notice (no penalty beyond −20 opinion), or immediate by declaring war (betrayal) | opinion ≥ +35 and (common enemy or they are ≥ 1.5× our strength and not a threat) |
| **Pacto de no agresión / NAP** | No war between the pair | 30 days (7,200 ticks), renewable | cannot leave early without betrayal | opinion ≥ 0, or ≥ −20 when threatened by a third party |
| **Acuerdo comercial / Trade agreement** | Their ports trade with each other first; +20 % trade gold between them; +15 opinion | open-ended | immediate (−5 opinion) | opinion ≥ −10 and both own ports |
| **Paso libre / Open borders** | Divisions may cross the other's land; not an alliance | open-ended | immediate (−5 opinion) | opinion ≥ +20 |
| **Paz / Peace treaty** | Ends a war with terms (§4.15) | – | – | §5.7 step 8 |
| **Embargo** (unilateral, kept from v1) | No trade from the embargoing side | until lifted | immediate | – |

Wars end all treaties between the pair. A treaty event (`treatyChanged`) always carries a reason key.

### 5.3 Proposals, deliberation and answers

Every diplomatic request is a **proposal** with an id, a sender, a receiver, a kind (`alliance`, `nap`, `trade`,
`openBorders`, `peace` with terms, `callToArms` with a target, `demand` with a demand) and timestamps.

* **To an AI:** the proposal is shown at once in the sender's inbox as **"Francia está estudiando tu propuesta…"** with a
  progress bar. The AI decides at `decideTick`:

  | Kind | Deliberation |
  |---|---|
  | Trade agreement, open borders | 40–80 ticks (4–8 h) |
  | NAP | 60–120 ticks |
  | Peace | 60–180 ticks |
  | Alliance | 120–240 ticks |
  | Call to arms | 20–60 ticks |

  The answer (`proposal` event with status `accepted`, `rejected` or `countered`) always carries the **one or two
  strongest reasons** of the evaluation, as i18n keys with parameters. Examples:

  > *Francia acepta la alianza: «Compartimos un enemigo: Alemania».*
  > *Italia rechaza la alianza: «Tu ejército en nuestra frontera nos inquieta» (−10 frontera larga, −12 tamaño).*
  > *Marruecos no acepta una alianza, pero te ofrece un pacto de no agresión de 30 días.*
  > *Alemania rechaza la paz blanca: «Vamos ganando esta guerra» (puntuación de guerra +42). Aceptaría la cesión de la
  > franja de Cataluña.*

* **Counter-offers.** Alliance → NAP when opinion is between 0 and +35. Peace → cession or tribute when the AI's war
  score ≥ 25. White peace → accepted when both are exhausted.
* **To the human:** proposals wait in the **inbox** (§8.3) for 720 ticks (peace 1,200, call to arms 240) and never
  expire while paused. A toast announces them; auto-pause is optional (§8.5). Expiry is announced as expiry, never as a
  rejection.
* **Cooldown:** the same sender cannot repeat the same proposal kind to the same receiver for 240 ticks after a
  rejection.

### 5.4 Tension, demands and ultimatums

* **Tension** (`tension` event): the AI publicly states a grievance before any war: *«Alemania considera tus tropas en
  la frontera una provocación»*. It raises the pair to "tension" in the nations panel (an orange icon) and draws the
  AI's massing arrows once it mobilizes (§11.2).
* **Demand / ultimatum** (`proposal` of kind `demand`, with a deadline): *«Alemania exige que le cedas la franja de
  Cataluña (38 casillas) en 24 h. Si te niegas, declarará la guerra.»* Demand kinds: cede a border band (≤ 5 % of your
  land, shown on the map), pay tribute (20–40 % of your gold), break an alliance with X, lift an embargo, withdraw units
  from our land (after an incursion). Deadline by difficulty (§2.4).
* **Accepting** applies the demand, gives +10 opinion and 7,200 ticks without war from that AI. **Refusing** or
  letting it expire gives −15 opinion and, with probability by personality (conqueror 0.9, opportunist 0.8, nuker 0.7,
  trader 0.5, turtle 0.4), a declaration of war.

### 5.5 Calls to arms and alliance duties

* When a player is the **target** of a war declaration, each of its allies receives a call to arms (proposal kind
  `callToArms`). AI allies answer yes with probability `0.5 + 0.5·loyalty` if they border the aggressor or have a
  navy, `0.3 + 0.5·loyalty` otherwise. The human answers from the inbox.
* The human may also ask allies to join an existing war ("Pedir ayuda contra X", replaces "Marcar objetivo"). AI allies
  weigh opinion, their own exhaustion and the strength of X.
* Joining creates a war between the ally and the aggressor with goal `defense`, no betrayal and no unprovoked penalty.
  Refusing costs −20 opinion; three refusals end the alliance.

### 5.6 Betrayal and reputation

Declaring war while a NAP, alliance or truce is active is a **betrayal**: the traitor gets `traitorUntilTick` for 720
ticks (72 h; defense ×0.75 and a blinking border as in v1), `betrayedUs` −60 with the victim and `reputationTraitor` −15
with everyone. The AI keeps its word according to personality: before a betrayal the AI rolls `1 − loyalty` once per
war-decision cycle and only when the gain is large (target weak, not allied to the AI's friends).

### 5.7 The AI war pipeline

Replaces `ai/war.ts thinkWar` target selection for players (neutral expansion and independent territories keep the
current logic, re-timed).

1. **Candidates** every war clock (Normal 28 ticks): bordering or reachable players (naval reach `min(420, 90 +
   tick/18)` kept), scored by `scoreTarget` (troops, density, front length, grudges, opportunism, coalition) **plus**
   opinion (< −30 required unless the personality is conqueror and the target is ≤ 0.5× its strength).
2. **Casus belli / goal**: `border` (claim a band), `tribute`, `retaliation` (they attacked us or an ally, nuked,
   betrayed), `coalition` (target is the runaway leader), `conquest` (conqueror vs a much weaker neighbour),
   `liberation` (a rebel movement asks for help). The goal gives the reason key of every later message.
3. **Tension** message (§5.4). Always, ≥ 240 ticks before the declaration on Easy/Normal (T9).
4. **Ultimatum** with probability by personality (turtle 1.0, trader 1.0, nuker 0.8, conqueror 0.7, opportunist 0.6);
   otherwise the declaration follows the tension directly.
5. **Declaration** (`warDeclared`), then **mobilization** (§2.4): the AI assigns divisions, masses at the border, and may
   not start offensives before `mobilizeUntilTick`.
6. **War plan**: which fronts, commit ratio `0.25–0.6` of home troops by personality and difficulty `efficiency`,
   divisions attached to the main front, air and missile use within the escalation level (§5.10).
7. **Limits**: offensive wars at once: conqueror and opportunist 2, others 1 (defensive wars do not count); at most 1
   declaration per AI per 720 ticks; no new declaration while its exhaustion > 50; worldwide at most 1 new AI war per
   120 ticks before tick 18,000 and per 60 ticks after.
8. **Peace evaluation** every 240 ticks and on every peace proposal: sue for white peace at exhaustion ≥ 45 and war
   score ≤ 0; accept white peace at exhaustion ≥ 35 or when its goal is met; demand cession at war score ≥ 40 or tribute
   at ≥ 25; capitulate per §4.13.

### 5.8 Personalities

| Personality | Plays like | Wars | Diplomacy | Keeps its word | Nuclear posture |
|---|---|---|---|---|---|
| **Conquistador** (conqueror) | Expands by force, builds armies and army bases | Up to 2 offensive wars; `conquest` and `border` goals; peace only with gains | Few alliances, pragmatic NAPs with distant powers | loyalty 0.45 | Escalates to L3 when desperate |
| **Tortuga** (turtle) | Fortifies, grows cities, defends | Rarely declares; always issues ultimatums first | Seeks NAPs and alliances with neighbours | 0.92 | Retaliation only |
| **Comerciante** (trader) | Ports, factories, trade agreements | `tribute` and `border` goals when strong; accepts white peace early | Trade agreements with everyone it does not hate | 0.85 | Retaliation only |
| **Nuclear** (nuker) | Balanced, builds silos and SAMs | Normal | Cold | 0.6 | Reaches L3 soonest when losing; L4 in retaliation |
| **Oportunista** (opportunist) | Attacks whoever is already bleeding | Up to 2 wars; joins coalitions against the leader | Makes and breaks deals | 0.2 | Escalates when the enemy is weak |

The personality is shown in the nations panel with one explanatory line, so the human can anticipate behaviour.

### 5.9 Difficulty

Difficulty changes how well the AI plays (reaction, efficiency, clocks, `humanFocus` after tick 18,000, ultimatum
deadlines, mobilization, the human grace), never the time scale, the conquest cap, the escalation rules or the
information the player gets. Insane keeps its gold and troop bonus, disclosed in setup.

### 5.10 Escalation ladder

Each war has an escalation level per side, 0…4, raised by that side and announced (`escalation` event, news, alert to
the victim) with a reason key.

| Level | Allows | AI may reach it when | Human |
|---|---|---|---|
| **L0 Convencional** | Offensives, divisions, naval invasions, warships vs warships and transports | war declared | same |
| **L1 Ataques militares** | Bombers, drones, fighters' strikes and cruise missiles on **military** targets (divisions, airbases, army bases, naval yards, SAMs, silos, radars, defense posts, warships); shore bombardment | from `mobilizeUntilTick` | same; no prompt |
| **L2 Ataques estratégicos** | Bombers and cruise missiles on cities, ports, factories and rail | war ≥ 72 h, or the enemy reached L2 first, or goal `conquest` | allowed; the first L2 strike asks for confirmation ("Atacar objetivos civiles: −10 opinión mundial") |
| **L3 Nuclear táctico** | Atom bombs | enemy used a nuke on it or an ally in this war (**retaliation**), or **desperation**: lost ≥ 40 % of pre-war land or its capital in this war, war ≥ 120 h, personality `nukes` ≥ 0.4, and the global caps allow it | allowed; confirmation dialog listing the consequences (§5.11) |
| **L4 Nuclear estratégico** | H-bombs and MIRVs | retaliation for a nuclear strike on its own land by this enemy, or existential (capital lost **and** ≥ 60 % of pre-war land lost) with personality nuker or doomsday ≥ 0.7 | allowed; confirmation dialog |

**Global AI caps** (sim-enforced): first AI nuclear launch not before tick 18,000 unless retaliating for a nuke on
itself or an ally; ≥ 480 ticks between any two AI nuclear launches worldwide; ≤ 2 AI nuclear weapons in flight; ≤ 1
nuclear launch per AI per 720 ticks; cruise missiles ≤ 1 per AI per 120 ticks and ≤ 3 per 600 ticks worldwide; one
bomber sortie per squadron per rearm. Cruise missiles come from a war plan (a target list per war), never from a dice
roll per military tick. Silos are built by AIs only when their personality `nukes` ≥ 0.3 or when an enemy at war owns
silos (no more "every large nation builds silos").

### 5.11 Nuclear consequences and the doomsday clock

* **Using a nuke**: `nuclearUse` −25 opinion with everyone, `nukedUsOrAlly` −90 with the victim and its allies; every
  nation with opinion ≤ −50 of the user gains a `retaliation`/`coalition` casus belli; the victim's population and
  recruitment fall for weeks (§6.7). The end screen and the news count casualties.
* **Doomsday clock** now **measures** escalation instead of driving it: `level = min(1, 0.25 × (nuclear detonations in
  the last 30 days)^0.7 + 0.10 × (wars at L3 or above) + 0.004 × (total silo levels in the world))`, shown as minutes to
  midnight (`12 − 11.5 × level`). It only affects AI decisions at L4 (above) and the music.

### 5.12 World events

Kept (earthquake, hurricane, gold rush, pandemic, rebellion), each with a stated cause in its news and tooltip, and paced
by T26. Rebellions happen only where there is a cause: occupied land > 20 % of a nation's land, or exhaustion > 60, or a
nuclear strike on its land in the last 10 days. A rebellion takes only occupied or fallout tiles plus their region,
capped by T20, and forms a rebel movement at war with its parent. At most one rebellion per nation per 7,200 ticks.

---

## 6. Units and structures

### 6.1 Principles

* Every type answers three questions in its tooltip and encyclopedia entry: **what it is for**, **what it does in
  numbers now**, and **what the next level adds**. The same numbers drive the sim (single source of truth:
  `STRUCTURE_LEVELS` and `UNIT_DEFS` in `src/shared/constants.ts`, §14.1).
* Every effect has a **visible trace on the map** when the thing is selected or hovered: a range ring, a coverage
  disc, a patrol circle, a route line or an aura on the front.
* **Territory changes only through offensives, peace treaties, capitulation and rebellion.** Units support fronts; they
  never capture land on their own.
* Upgrade cost: `upgradeCost(type, level) = round(baseCost × (0.5 + 0.5 × level))` for going from `level` to
  `level + 1` (City 1→2: 125,000; 9→10: 625,000). Upgrading takes 50 % of the construction time and the structure keeps
  working meanwhile. Max levels: City 10, all others 3.

### 6.2 Structures

Construction times are in §2.4. Costs are v1's `STRUCTURE_DEFS` (base × (1 + step × owned), capped), unchanged.

| Structure | Purpose (tooltip first line) | Level 1 | Level 2 | Level 3 | Visible trace |
|---|---|---|---|---|---|
| **Ciudad / City** (max 10) | Population, recruitment and taxes; a rail station | +250,000 troop cap, +250 gold/h, +0.8 M population | same again per level (L10: +2.5 M cap) | | Skyline grows; name label; rail links |
| **Puerto / Port** | Maritime trade and naval logistics; rail station | 2 trade ships at a time; invasions embark here in 6 h; repairs ships within 3 tiles +5 %/h | 4 ships, trade chance ×2, cargo +20 %; embark 4 h | 6 ships, ×3, +40 %; embark 3 h | Trade routes (thin lines, §10.8) |
| **Fábrica / Factory** | Industry and the rail network: trains carry gold; divisions travel by rail | +160 gold/h; a train every 13 h; 1 division may travel by rail from the network at a time | +320 gold/h; every 6.5 h; 2 divisions | +480 gold/h; every 4.3 h; 3 divisions | Rail lines between stations (from the sim's rail graph, §14.5) |
| **Puesto defensivo / Defense post** | Fortified zone: slows enemy offensives and bleeds attackers | radius 3 tiles (75 km); inside, enemy advance time ×1.5 and attacker casualties ×1.5 | radius 4.5; ×1.75 / ×1.75 | radius 6; ×2 / ×2 | Hatched ring on selection and on hover of your land at war |
| **Batería SAM / SAM site** | Shoots down aircraft, cruise missiles and warheads in their final phase | vs aircraft and cruise missiles: 8 tiles (200 km), 70 % per interceptor; vs ballistic warheads: 5 tiles (125 km), 45 %; salvo 1; reload 2 h | 10 tiles, 75 %; 6 tiles, 55 %; salvo 2 | 12 tiles, 80 %; 8 tiles, 65 %; salvo 3 | Two rings (air, anti-ballistic) |
| **Silo de misiles / Missile silo** | Launches missiles; the level unlocks heavier weapons | cruise missiles and atom bombs; reload 24 h | + hydrogen bombs; reload 12 h | + MIRV; reload 8 h | Reach circles per weapon when targeting |
| **Base aérea / Airbase** | Hosts and repairs aircraft; scrambles fighters against raids | 3 squadrons; scramble radius 16 tiles (400 km, ×1.5 inside radar coverage); repairs +10 %/h | 6 squadrons | 9 squadrons | Scramble ring; hosted aircraft listed on its card |
| **Base del ejército / Army base** | Produces and repairs armored divisions; raises the troop cap | 2 divisions; +60,000 troop cap; repairs divisions within 5 tiles +1 %/h | 4; +120,000; +2 %/h | 6; +180,000; +3 %/h | Repair ring |
| **Astillero naval / Naval yard** | Produces and repairs warships | 2 warships; repairs within 3 tiles +2 %/h | 4; +4 %/h | 6; +6 %/h | Repair ring |
| **Radar** | Early warning and fire control (it does **not** reveal a fog of war; there is none) | coverage 20 tiles (500 km): inside it SAM range ×1.25, fighter scramble ×1.5; enemy convoys are detected at embarkation and air raids when they enter coverage; enemy divisions massing at your border inside coverage raise an alert | 28 tiles (700 km) | 36 tiles (900 km) | Coverage disc |

v1 defense-post radii (300–525 km) and SAM ranges (~1,000 km) were unrealistic and made single buildings cover whole
countries; the v2 numbers above replace them.

### 6.3 Units

| Unit | Purpose | Cost (v1 pricing kept) | Production | Speed | Reach | Effect in numbers | Integrity and losses |
|---|---|---|---|---|---|---|---|
| **División acorazada / Armored division** | Breaks fronts and holds them | 150,000 (+35 % per owned, max ×4) | 8 h at an army base | 40 km/h road; 100 km/h by rail; with the front when attached | own, allied and open-border land; enemy land only attached to a front | Attached within 3 tiles of a front: **attack** +25 % power and pressure ×1.5 (never above the cap); **defense** +25 % power and enemy advance time ×1.4 around it | 100 %; −1 % per game hour engaged (−2 % at the cap); a bomber strike −35 %; at 0 % it is destroyed; repairs at army bases |
| **Grupo naval / Warship** | Controls the sea: sinks convoys, blockades trade, bombards coasts | 250,000 (+100 % per owned, max ×4) | 16 h at a naval yard | 55 km/h | navigable water | Engages ships within 6 tiles; blockade: enemy trade ships and convoys within 6 tiles are stopped or sunk; bombardment: +15 % attack power on fronts within 4 tiles of it and −0.5 %/h of the local enemy garrison; escort: +50 % survival for own convoys within 3 tiles | 100 %; each hit −25 %; repairs at ports and yards |
| **Escuadrón de caza / Fighter squadron** | Air superiority: protects the sky over an area | 200,000 (+30 % per owned) | 6 h at an airbase | 900 km/h, 1,800 dash | 40 tiles (1,000 km) from its base | Persistent patrol (CAP) circle of 6 tiles (150 km): intercepts bombers and drones (60 % per engagement) and cruise missiles (45 %), fights fighters; scrambles from its base against raids within 16 tiles | 100 %; losses in dogfights and to SAMs; rearm 2 h |
| **Bombardero / Bomber** | Deep strikes on military (L1) and strategic (L2) targets | 350,000 (+35 % per owned) | 10 h | 850 km/h | 80 tiles (2,000 km) | Structure −0.55 hp (direct hit −1.1); division −35 % integrity; front sector: −3 % of the local enemy garrison | vulnerable to CAP and SAM; rearm 6 h |
| **Enjambre de drones / Drone swarm** | Cheap, persistent support over a front | 120,000 (+15 % per owned) | 4 h | 200 km/h | 40 tiles | Front support (persistent, radius 2 tiles): enemy local garrison −1 %/h; our advance there ×1.15 (under the cap), enemy advance ×0.85; or a one-way strike on a structure (−0.38, direct −0.6) | fragile; rearm 4 h |
| **Misil de crucero / Cruise missile** | Precise strike on one structure | 300,000 | from any silo | 880 km/h | 100 tiles (2,500 km) | Structure at the aim −1.2 hp; −0.4 within 1 tile | interceptable (SAM 70–80 % × 0.65, fighters 45 %) |
| **Bomba atómica / Atom bomb** | Tactical nuclear weapon (L3) | 750,000 | silo L1+ | ballistic (§2.3) | 220 tiles (5,500 km) | inner 3 tiles (75 km), outer 7 tiles (175 km); effects of §4.14 | terminal-phase SAM only |
| **Bomba de hidrógeno / H-bomb** | Strategic nuclear weapon (L4) | 5,000,000 | silo L2+ | ballistic | intercontinental | inner 7 tiles (175 km), outer 14 (350 km) | ×0.85 interception |
| **MIRV** | Strategic, overwhelms defenses (L4) | 25,000,000 (+10 M per launched) | silo L3 | ballistic | intercontinental | splits at 70 % of the flight into 10 warheads, 3/6 tiles each, spread 8 tiles | warheads ×0.7 |
| **Convoy de transporte / Transport convoy** | Carries a naval invasion | created by the invasion order | embarkation §4.11 | 35 km/h | water | carries the committed troops | sunk by 2 warship hits or 1 bomber strike: troops lost |
| **Mercante / Trade ship** | Gold from maritime trade | automatic (ports) | – | 30 km/h | water | `tradeGold(distance)` for both ports, +20 % with a trade agreement | captured by blockading enemy warships |
| **Tren / Train** | Gold from the rail network | automatic (factories) | – | 100 km/h | rail | `trainGold(pathTiles)` on arrival | links crossing enemy land are cut |
| **Interceptor SAM** | Automatic | – | – | 5,000 km/h | SAM range | – | – |

Divisions and fighter squadrons are shown as formations: a division is **4 tanks** (one per 25 % of integrity), a
squadron **3 jets**. Command mode uses the same formation (§9.9).

### 6.4 Orders by unit type

| Unit | Orders (right-click context in bold, §7.3) | Default behaviour when idle |
|---|---|---|
| Armored division | **Mover** (own/allied/open-border land; by rail when faster), **Unirse al frente** (attach to the front under the cursor), **Atacar hacia aquí** (attach to the nearest front and set its axis), Mantener, Volver a la base, Tomar el mando | Holds position; if a front of its owner is within 3 tiles, attaches to it for defense |
| Warship | **Mover**, **Patrullar zona**, **Bloquear** (enemy coast or sea lane), **Bombardear costa** (enemy coastal land at war), **Escoltar** (own convoy), Volver al puerto, Tomar el mando | Patrols 10 tiles around its yard; engages enemies at war in range |
| Fighter squadron | **Patrulla aérea aquí** (CAP circle), **Interceptar** (enemy aircraft), **Escoltar** (own bomber sortie), **Cambiar de base**, Volver, Tomar el mando | Docked; scrambles against raids in range |
| Bomber | **Atacar objetivo** (structure, division, front sector of a nation at war, within reach and escalation), Volver | Docked |
| Drone swarm | **Apoyar frente**, **Atacar objetivo**, Volver | Docked |
| Silo | **Lanzar** (weapon picker Z/X/C/V, target within reach; escalation rules §5.10) | – |

### 6.5 Looks: icon and model

| Type | Icon glyph (in a frame, §10.7) | 3D model (below the LOD threshold) and per-level change |
|---|---|---|
| City | three-building skyline | Existing `citySpec` skyline; footprint 2.5 km + 0.35 km per level; +7 buildings and taller spires per level |
| Port | anchor | Quay with 1/2/3 berths and cranes by level |
| Factory | gear with a chimney | 1/2/3 halls and smoking stacks |
| Defense post | bastion chevron | Bunker ring and trenches; L2 adds artillery pits; L3 a concrete fort |
| SAM site | upward arrow under an arc | 2/4/6 launchers around a radar truck |
| Missile silo | vertical missile in a circle | 1/2/3 silo doors |
| Airbase | plane over a runway | 1/2/3 runways, hangar rows |
| Army base | crossed swords over a flag | Barracks; vehicle park grows by level |
| Naval yard | anchor with a wrench | 1/2/3 dry docks |
| Radar | dish | 1/2/3 radomes |
| Armored division | NATO armor oval | 4 tanks in column (fewer as integrity falls) |
| Warship | hull silhouette | Destroyer model |
| Fighter | swept-wing plane | 3 jets in a V |
| Bomber | broad-wing plane | Bomber |
| Drone swarm | small chevrons | 7 drones |
| Transport convoy | hull with a "T" | Landing ship |
| Trade ship | hull with a coin | Cargo ship |
| Missiles | arrow (cruise), trefoil (nuclear) | Existing models and arcs |

Structures are **grounded** (§10.7): their up vector is the local terrain normal, their base vertices snap to the
relief, and they stand on a foundation pad whose skirt reaches the lowest ground point of the footprint.

### 6.6 Names

* Units get ordinal names from a per-owner, per-type counter: "1.ª División Acorazada" / "1st Armored Division",
  "Escuadrón de caza 3" / "Fighter Squadron 3", "Grupo de bombardeo 2", "Enjambre 4", "Grupo naval 1".
* Cities take the name of the nearest real place within 80 km not already used (`src/data/places.ts`, §14.9), else
  "Nueva {place}" for the nearest place within 250 km, else "Ciudad {n}".
* Fronts are named after the nearest place to their centroid: "Frente de Lyon". Offensives: "Ofensiva sobre Lyon".

### 6.7 Economy and population

* **Gold per game hour** (tooltip breakdown): base 1,000; per tile 0.5 (occupied tiles 25 %, fallout 0); per city
  level 250; per factory level 160; trade, trains and tribute as received; all multiplied by the kind and difficulty
  multipliers of v1.
* **Troop cap**: `100,000 + 2,000 × tiles^0.6` (occupied tiles count 50 %, fallout 20 %) `+ 250,000 × city levels +
  60,000 × army-base levels`, × kind multiplier.
* **Population** stops being cosmetic. Target population = 25,000 per tile + 800,000 per city level. Real population
  moves toward it by 0.2 % of the target per game hour. **Recruitment factor** = `clamp(population / target, 0.3, 1)`
  multiplies troop growth and tile taxes. Nukes and pandemics reduce population, so they hurt a nation for days. The
  top-bar tooltip says so.

---

## 7. Orders and selection UX

### 7.1 Mouse and keys in the strategic view

| Input | Action |
|---|---|
| Left click on land | The land action of v1, now war-aware: expand into neutral land; offensive against a nation at war or an independent territory; **declaration dialog** for a nation at peace (§4.2); naval invasion across water. The hover chip previews it (§7.7) |
| Left click on an own unit, its icon or its row | Select it (replaces the selection) |
| Shift + left click | Add or remove a unit from the selection |
| Shift + left drag | Box-select own units (the camera does not pan while Shift is held) |
| Double click on an own unit | Select all own units of that type on screen |
| Right click (no drag) with units selected | **Order** by context (§7.3); the preview is shown before the click |
| Right click with nothing selected | Diplomacy radial on the nation under the cursor (§5, §16.4) |
| Right or middle drag | Camera heading and tilt (unchanged) |
| `Esc` | Cancel the mode, clear the selection, close the top panel, then the pause menu |
| `U` | **Fuerzas** panel (§7.5) |
| `G` | **Guerra y frentes** panel (§11.3) |
| `N` | **Naciones** panel and diplomatic inbox (§5, §8.3) |
| `I` | Select and fly to the next idle unit |
| `T` | Take control of the selected division, squadron or warship (§9) |
| `1`…`0`, `Z/X/C/V`, `B`, `Space`, `+/-`, `Tab`, `M`, `H`, `F1`/`?` | As in v1 (build, weapons, invasion, pause, speed, leaderboard, minimap, capital, help). `Enter` no longer opens emotes |

### 7.2 Selection

* Clicking picks **icons** (§10.7) when they are drawn, models otherwise, within 14 px, own units first, then enemy
  units, then structures, then the tile. The nearest candidate to the cursor wins; ties go to the smaller icon.
* Selected units get an owner-coloured ring, their route and ETA line, and their range ring (§6.1).
* Docked aircraft are selectable from their airbase card and from the Fuerzas panel (fixes CM§11 blocker 1).
* Selecting a unit **does not** put the next left click into order mode any more. Orders are right-click, or a button on
  the unit card followed by a left click (for touchpads), with the mode banner explaining it.

### 7.3 Right-click order resolution

| Selection | Under the cursor | Order | Invalid reason (shown in red in the chip) |
|---|---|---|---|
| Division | Own, allied or open-border land | **Mover** (by rail when a connected station route is faster; the chip says "por ferrocarril") | – |
| Division | Enemy land at war within 3 tiles of a front | **Unirse al frente** | – |
| Division | Enemy land at war deeper | **Atacar hacia aquí** (attach to the nearest front, set its axis) | – |
| Division | Land of a nation at peace | – | "En paz con Francia: declara la guerra o pide paso libre" |
| Division | Water | – | "Las divisiones no navegan: usa una invasión naval (B)" |
| Division | Own army base | **Volver a la base** | – |
| Warship | Water | **Mover**; Shift: **Patrullar zona** | – |
| Warship | Water within 6 tiles of the coast of a nation at war | **Bloquear** | – |
| Warship | Enemy ship at war | **Atacar** | – |
| Warship | Coastal land of a nation at war | **Bombardear costa** | "Fuera de alcance (máx. 4 casillas de la costa)" |
| Fighter | Any point within reach | **Patrulla aérea aquí** | "Fuera de alcance: 1.000 km desde su base" (reach ring shown) |
| Fighter | Enemy aircraft at war | **Interceptar** | – |
| Fighter | Own bomber | **Escoltar** | – |
| Fighter | Own airbase | **Cambiar de base** | "Base llena (3/3)" |
| Bomber | Enemy structure, division or front sector at war, within reach, allowed by escalation | **Atacar objetivo** | "Objetivo civil: requiere escalada L2" (confirm dialog), "En paz con X" |
| Drone swarm | Enemy front at war | **Apoyar frente** | – |
| Drone swarm | Enemy structure at war | **Atacar objetivo** | – |
| Mixed selection | anything | Each unit gets the order that fits its type | Chip: "3 de 5 unidades pueden cumplir esta orden" |

Validation is one pure function shared by the UI preview and the sim: `orderError(ctx, unit, order, tile, targetId)` in
`src/shared/orders.ts` (§14.1). The sim still validates; the preview and the sim can no longer disagree (fixes the v1
"aircraft valid on own land" bug).

### 7.4 Order preview and acknowledgement

* The cursor chip shows the order, the distance, the ETA in game hours and in real seconds at the current speed, and the
  route mode: "Mover · 480 km · 12 h (12 s a 1x) · carretera".
* The preview line: great-circle dashed arc for aircraft and missiles; straight dashed line over land for divisions,
  red where it would cross land it may not enter; for ships a dashed great circle until the sim returns the real water
  path (`routes`, §14.5), which then replaces it.
* On acceptance the unit's route line becomes solid in the owner colour with the ETA at its end, and the radio "roger"
  cue plays. On rejection the chip flashes the sim's reason.

### 7.5 The Fuerzas panel (`U`)

A drawer on the right, 380 px wide (one drawer open at a time: Fuerzas, Guerra, Naciones).

* Tabs **Tierra / Aire / Mar / Todo**. Rows grouped by state: *En combate*, *En marcha*, *En patrulla*, *En base*,
  *En producción*.
* Row: icon, name, location ("cerca de Zaragoza"), state with ETA ("→ Frente de Lyon · 6 h"), integrity bar, the front
  it is attached to. Click: select and fly; Shift-click: multi-select; buttons: *Tomar el mando* (when eligible),
  *Volver*.
* *En producción*: one row per unit being built with a progress bar and ETA. When it completes: `unitReady` alert
  ("1.ª División Acorazada lista en la base de Zaragoza") with a *Ver* button (fixes C03).
* Footer: capacity per type ("Divisiones 3/4 — construye o mejora bases del ejército para más").

### 7.6 Unit and structure cards (bottom-right)

* **Unit card**: name, type, owner, the one-line purpose, state and ETA, integrity with a tooltip ("a 0 % la división se
  pierde; se repara en bases del ejército"), speed in km/h with its real-time equivalent ("40 km/h ≈ 40 km por segundo a
  1x"), reach, the effect it is producing now ("+25 % de potencia en el Frente de Lyon"), order buttons and *Tomar el
  mando*. No bogus "FUERZA 800" or "315 km/h" (fixes C04).
* **Structure card**: name, level pips, "Ahora:" effects in numbers, "Nivel 2:" effects in numbers, upgrade cost and
  time, the upgrade button (disabled with the exact reason: "Te faltan 42.000 de oro"), hosted units with select buttons
  (airbase aircraft, army-base divisions), production buttons with price and time (live price, fixes I02), demolish.

### 7.7 Offensives from the map

Hovering land shows what a left click will do, with the prediction computed by `predictOffensive(view, attacker,
defender, troops)` (§14.1):

* **"CLIC: ofensiva con 120.000 (50 %) · relación 2,3 : 1 · avance ≈ 5 km/h"**, coloured red (R < 1: "la ofensiva se
  estancará"), amber (1–2) or green (≥ 2).
* Over land of a nation at peace: **"CLIC: declarar la guerra a Francia…"**.
* Over unreachable land: **"Sin frontera: usa una invasión naval (B) o pide paso libre"** (never offers an expansion it
  cannot do; fixes B03).

### 7.8 Main flows

1. **Buy and deploy a division.** Build bar → *Arsenal* → *División acorazada* (price, 8 h) → row in *En producción* →
   alert "lista" → *Ver* selects it → right-click on the front → solid route, ETA → it attaches: its chip appears on the
   front badge (§11.2) and its aura ring on the map.
2. **Defend a front.** Alert "Alemania ataca cerca de Lyon" → click flies there; the Guerra panel highlights the front →
   *Prioridad alta*, *Enviar divisiones* (opens Fuerzas filtered to idle divisions with their ETA to this front),
   *Contraofensiva* (uses the slider), *Pedir ayuda a aliados*, *Proponer paz*.
3. **Air patrol.** Select a fighter squadron (panel or airbase card) → right-click over the front → the CAP circle is
   drawn; it intercepts raids entering it and rotates aircraft until recalled.
4. **Strike.** Select a bomber → hover an enemy airbase: chip "Atacar objetivo · 1.300 km · 1,5 h · riesgo: SAM (2)" →
   right-click → sortie line, strike, return, rearm 6 h; the result arrives as an alert.
5. **Naval invasion.** `B` over an enemy coast: chip "Invasión: embarque en Cádiz 6 h + travesía 9 h · 80.000 tropas" →
   click (declaration dialog if at peace) → convoy in port with a countdown → route line → landing alert → beachhead
   front appears in the Guerra panel.
6. **Blockade.** Select a warship → right-click near the enemy coast → blockade zone drawn; enemy trade ships entering
   are captured (alert with the gold taken).

---

## 8. Alerts, news, auto-pause and notifications

### 8.1 Alert model

An **alert** is a client-side object built from sim events: `{id, kind, severity, title, body, lat, lon, groupKey,
actors, createdTick, expiresTick?, acknowledged}`. One API creates them for every subsystem: bus event `alert` (§14.8),
owned by the UI. Severities: *info* (blue-grey), *warning* (amber), *danger* (red), *critical* (red, pulsing; eligible
for auto-pause).

### 8.2 Catalogue

Channels: **F** alert feed, **M** minimap ping, **G** globe marker (with an off-screen edge arrow for danger and critical),
**T** world news ticker, **I** diplomatic inbox, **S** sound (§13).

| Kind | Severity | Trigger | Example (es) | Channels | Auto-pause default |
|---|---|---|---|---|---|
| `warDeclared` on you | critical | `warDeclared` with target = you | «¡Alemania nos declara la guerra! Motivo: disputa fronteriza. Sus tropas estarán listas en 8 h.» | F M G T S | **on** |
| `tension` | warning | `tension` to you | «Alemania considera tus tropas en la frontera una provocación.» | F I | – |
| `ultimatum` | danger | demand proposal to you | «Ultimátum de Alemania: cede la franja de Cataluña en 24 h o habrá guerra.» (band drawn on the map) | F I M G S | **on** |
| `mobilization` | warning | enemy mobilizing against you | «Alemania concentra tropas en la frontera de los Pirineos.» | F M G | – |
| `offensive` on you | danger | `attackStarted` against you | «Alemania ataca cerca de Lyon con 320.000 tropas.» | F M G S | – |
| `frontLoss` milestones | warning | 10 / 25 / 50 % of your pre-war land lost on a front | «Frente de Lyon: hemos perdido el 10 % de nuestro territorio.» | F M | – |
| `capitalThreat` | critical | an enemy front within 5 tiles of your capital, or an offensive axis within 10 tiles of it | «¡El frente está a 110 km de Madrid!» | F M G S | **on** |
| `capitalLost` | critical | `capitalCaptured` of yours | «Hemos perdido Madrid. La capital se traslada a Sevilla.» | F T S | – |
| `siege` of yours | danger | `siege` start on your pocket | «Tropas cercadas en Bretaña: 42 casillas sin suministro.» | F M G | – |
| `invasionDetected` | danger | `invasionDetected` against you | «Convoy de Reino Unido rumbo a Galicia: 80.000 tropas, desembarco en ~9 h.» | F M G S | off |
| `landing` | danger | `boatLanded` on you | «Desembarco enemigo en Galicia.» | F M G S | – |
| `airRaid` | warning | enemy bombers or drones entering your radar coverage toward your land | «Bombarderos de Alemania se dirigen a Zaragoza.» | F M G | – |
| `structureHit` / `structureLost` | warning | strike damage, destruction, capture | «Un bombardeo ha destruido nuestro puerto de Cádiz.» | F M | – |
| `nukeAtYou` | critical | nuclear launch at your land (v1 alarm banner kept) | «ALERTA NUCLEAR · Madrid · impacto en 0:12» | banner, F M G S, crisis banner | **on** |
| `nukeWorld` | – | any other nuclear launch | «Rusia lanza un arma nuclear contra Japón.» | T, crisis banner | – |
| `proposal` received | info | proposal to you | «Francia propone una alianza.» | F I S | off |
| `proposalAnswered` | info / warning | answer to your proposal | «Italia rechaza tu alianza: "Tu ejército en nuestra frontera nos inquieta".» | F I S | – |
| `peaceOffer` | info | peace proposal to you | «Alemania propone una paz blanca.» | F I S | off |
| `callToArms` | warning | an ally asks you to join | «Portugal te pide ayuda contra Marruecos (24 h para responder).» | F I S | off |
| `unitReady` | info | production finished | «1.ª División Acorazada lista en la base de Zaragoza.» | F M | – |
| `unitLost` | warning | own unit destroyed | «Hemos perdido el Grupo naval 2 frente a Bretaña.» | F M | – |
| `offensiveStalled` / `offensiveEnded` | info | yours stalls or ends | «Nuestra ofensiva sobre Lyon se ha detenido: relación 0,8 : 1.» | F | – |
| `incursionResponse` | warning | the AI answers your incursion (§9.7) | «Francia protesta por la entrada de tu división y exige su retirada en 6 h.» | F I | – |
| `treatyExpiring` | info | NAP ends in 24 h | «Tu pacto de no agresión con Marruecos vence en 24 h.» | F I | – |
| `betrayal` | danger | a partner breaks a treaty with you | «¡Italia rompe nuestra alianza y nos declara la guerra!» | F T S | (covered by `warDeclared`) |
| `rebellion` in your land | danger | rebellion start | «Rebelión en Cataluña: la ocupación prolongada ha provocado un levantamiento.» | F M G T S | – |
| World news | – | wars declared, peace signed, capitulations, eliminations, capitals captured, alliances, rebellions, world events | «Alemania y Francia firman la paz: Francia cede Alsacia.» | T | – |

### 8.3 Channels

* **Alert feed** (top-left, replaces the v1 toasts): at most 5 visible, newest on top; grouped by `groupKey` (e.g. one
  entry per front, updating its numbers instead of stacking); icon, title, one-line body, age; clicking the entry flies
  the camera to it; `×` dismisses. Critical alerts stay until acknowledged; the rest fade after 20 real seconds and remain
  in the **Registro** log (bell icon, last 200 alerts, filterable).
* **Minimap**: pings (expanding circle, 1.5 s); persistent red marks for fronts on you; enemy convoys heading to you as
  red triangles with dashed routes; your capital; world events (v1).
* **Globe markers**: DOM elements projected at 10 Hz, a pulsing ring with the alert icon at the location; off-screen,
  an arrow on the screen edge points to it (danger and critical only). Front markers link to the front badge (§11.2).
* **Inbox** (inside the Naciones panel, badge with the count of pending items): every proposal, demand, call to arms and
  answer with its reason; pending items show their deadline countdown in game hours and real seconds.
* **Ticker**: world news, each clickable to fly when it has a place.

### 8.4 Place names

`describePlace(lat, lon, viewer)` (client, `src/ui/places.ts`) returns "cerca de Lyon (Francia)" using the nearest place
of `src/data/places.ts` within 150 km and the Natural Earth country under it, else "a 340 km al NE de Madrid" (bearing
and distance from the viewer's capital). Every located alert and front name uses it.

### 8.5 Auto-pause

Settings → *Juego* → *Pausa automática*, eight toggles: war declared on you (**on**), ultimatum (**on**), nuclear launch
at you (**on**), capital threatened (**on**), naval invasion against you (off), diplomatic proposal (off), peace offer
(off), call to arms (off). When one fires, the game pauses and a banner says why: «PAUSA AUTOMÁTICA · Alemania nos ha
declarado la guerra · [Ver] [Reanudar]». The camera never moves by itself. The same *Juego* tab holds
`crisisTime` (*Siempre* by default / *Solo si me afecta* / *Nunca*) and the cloud mode (§10.5).

### 8.6 Anti-spam rules

* One feed entry per front (updated), not per tile or per reinforcement.
* `frontLoss` only at 10 / 25 / 50 %.
* Combat sounds per front are capped (§13).
* World-level ticker items only for the categories of §8.2; no emotes, no "X: 🎯 Objetivo".

---

## 9. Command mode v2

### 9.1 Principles

Same unit, same place, same world, same consequences. Taking control of a division puts you **inside that division at
its real position**. If it is at peace in your own land, the scene is peaceful: your towns, your roads, your bases, no
enemies. You may drive it from one end of your country to the other. If you cross a border, that nation is alerted and
its AI decides what to do. Everything you meet is derived from the simulation at that place, and everything you do there
is written back to the simulation. There are no missions, objectives, waves, operation names or scripted air strikes.

### 9.2 Entry

* **Eligible**: own armored divisions (tank), fighter squadrons (jet) and warships (ship) with integrity > 0 and not in
  production. A docked squadron starts on its airbase runway.
* **Where**: TAKE CONTROL on the unit card, the Fuerzas panel row, or `T`.
* **Sequence** (`app.enterCommandMode`, rewritten `commandParams`): camera dive to the unit (2.2 s, kept) → fade → sim
  `unitControl {controlled: true}` → `command.enter(params)` with the unit's interpolated lat/lon and heading, its
  formation size, and a **context** (`peace`, `border`, `front`, `enemyLand`, `sea`, `air`) computed from the sim view.
  `enemy = 0` is legal and is the normal case at peace. → clock to tactical (§9.3) → a 2 s title card:
  «1.ª División Acorazada · cerca de Zaragoza · territorio propio · en paz».

### 9.3 Tactical time and travel mode

* **Tactical time (1:1)** is the default in command mode. One sim tick passes every 6 real minutes, so offensives
  elsewhere move less than 0.1 tile per real minute even at the cap: the war waits while you fight, instead of running
  unseen (fixes C02). Alerts still arrive in the command HUD (§9.11), and auto-pause still applies.
* **Travel mode** compresses time for movement: `+` / `-` step through **×10, ×60, ×300, ×900** (1 s = 10 s, 1 min,
  5 min, 15 min). The world clock runs at the same rate (×900 = 0.25x strategic), so nothing moves unfairly.
  * Allowed only without **contact**: no hostile entity within 8 km (ground), 40 km (air) or 30 km (sea), and no fire
    received in the last 30 s. In foreign land at peace or enemy land the maximum is ×60.
  * Manual driving is capped at ×60. ×300 and ×900 use the **autopilot** toward a waypoint set on the tactical map
    (`M`): the vehicle follows the terrain (valleys, gentle slopes) toward it; the chase camera rises to 1–1.5 km and
    looks ahead.
  * Drops to ×1 automatically on contact, when fired upon, 2 km before a border with a nation you are at peace with,
    on arrival, and on any critical alert.
  * Reference: an autopilot road march of 300 km at 40 km/h takes 7.5 game hours: 30 real seconds at ×900.
* The clock is set with a new worker message `{kind: 'clock', mode, rate}` (§14.6). Crisis time never engages in
  command mode; nuclear alarms still show.

### 9.4 Streaming terrain

| Vehicle | Near chunks | Mid ring | Horizon | Floating origin |
|---|---|---|---|---|
| Tank | 2 km chunks at 128² samples, 5 × 5 around the vehicle | 8 km chunks at 64² out to 24 km | one 120 km patch at 128², rebuilt every 15 km | recentre every 2 km |
| Jet | 8 km chunks at 128², 5 × 5 | 32 km chunks at 64² out to 100 km | 400 km patch, rebuilt every 60 km | every 10 km |
| Ship | water plane + 4 km land chunks only where there is coast | 16 km chunks | 200 km patch | every 2 km |

* Chunks come from `getLocalHeightfield(lat, lon, sizeKm, res)` (real relief, splat, biome). Adjacent chunks share edge
  samples and carry skirts. At most one chunk is built per frame, prefetching two chunks ahead in the travel direction.
  If a chunk costs more than 8 ms on the main thread, generation moves to the data worker (`src/data/worker.ts` gains a
  `localHeightfield` request).
* The old fixed build (`command/index.ts build`: 4.2 km patch and 44 km ring) is replaced by this streamer.

### 9.5 What you see when there is no war here

* Real relief, biomes, rivers and coast (existing generators).
* **Borders**: where tile ownership changes within 30 km, a painted border line with posts every 500 m, the neighbour's
  flag colour on the other side, and a crossing gate where a road meets it.
* **Towns**: every City structure within view at its real position, with its name and its level-driven size; villages
  scattered with a density taken from the NASA night-lights texture at that place (bright = dense, dark = empty); roads
  procedurally linking towns and villages, seeded by position (deterministic); rail lines from the sim's rail graph
  (§14.5), with trains when they pass.
* **Own assets** within view: bases, SAMs, silos, radars, ports and other own units at their real positions.
* No enemies unless §9.6 derives them.

### 9.6 Local forces derived from the simulation

The module `src/command/forces.ts` reads `ctx.sim.view` every 2 real seconds around the vehicle and keeps a **pool** per
source. Visible entities are spawned from the pool up to a budget; as they die, the pool refills from the remaining
strategic strength at that place. Conversion: **1 local soldier = 25 strategic troops** (ARCHITECTURE §15).

| Sim source | Condition | Local representation | Visible cap |
|---|---|---|---|
| Enemy front garrison | within 8 km of an active front (FrontView polyline) of a nation at war with you | infantry squads and AT teams on their side of the line; pool = `Gf × (view width along the front / front length) / 25` | 40 soldiers |
| Enemy rear garrison | in enemy land at war, away from fronts | patrols; pool = `0.15 × home troops / tiles × viewed tiles / 25`, plus 6 soldiers and 1 AT team per defense post within 25 km | 12 |
| Enemy divisions | real armored divisions within 30 km | 1 tank per 25 % integrity + 2 IFVs, at their real position and heading, following their strategic orders | 12 vehicles |
| Enemy aircraft | real squadrons whose patrol covers the place, or scrambled from an airbase at war within 150 km | 1 jet per third of integrity | 6 |
| Enemy warships | real warships within 40 km | the ship at its real position | 3 |
| Enemy SAM sites | real sites within 15 km (tank, ship) or within their range (jet) | launchers and radar at the real position | 3 sites |
| Enemy defense posts | real posts within 10 km | bunkers and trenches | – |
| Friendly forces | own front garrison and divisions on the same front | squads and tanks on your side | half the enemy budget |
| Incursion response | §9.7 decision "intercept" | quick-reaction force from the nearest victim town or post | 8–24 soldiers + real divisions within 30 km |

If every pool is empty, the scene is peaceful. There is no fallback "strongest nation in the world" (v1 `commandParams`).

### 9.7 Borders and incursions

1. **Approach.** At 2 km from the border of a nation you are at peace with, the HUD shows «Frontera con Francia (en paz)
   a 2 km» and travel drops to ×1.
2. **Confirm.** Crossing asks once per border per session: «Entrar en Francia sin permiso es una incursión. Francia
   recibirá una alerta y podrá protestar, enviar fuerzas o declararte la guerra.» [Cruzar] [Volver]. With an alliance or
   open borders there is no incursion, only a notice.
3. **Event.** The first `controlledMove` into a foreign tile makes the sim emit `borderIncursion {stage: 'entered'}` to
   both sides. The victim's AI (`aiDirector.onIncursion`) decides after 30–90 game seconds (0.5–1.5 real minutes at 1:1):
   * **Protest** (opinion ≥ −10, or turtle or trader): a message demanding withdrawal within 6 game hours; −15 opinion.
   * **Intercept** (opinion < −10, or the unit is ≥ 20 km inside, or conqueror or nuker): a quick-reaction force from
     the garrison moves in (arrives in 3–8 real minutes), real divisions within 30 km are ordered to the unit, fighters
     on patrol within 150 km vector to an intruding jet. They block and escort; they only fire if the victim also
     declares war.
   * **War** (opinion ≤ −50 and an aggressive personality): the victim declares war with reason `incursion`.
   Firing first on a nation at peace asks for confirmation and is a declaration of war by you.
4. The answer arrives as an `incursionResponse` alert (§8.2).
5. **Leaving** the foreign land ends it (`stage: 'left'`). Exiting command mode inside foreign land at peace gives the
   division an automatic order back to the nearest own tile; the incursion lasts until it has left. Ignoring a protest
   past its deadline escalates (intercept, then war, by personality).
6. **Jets** violate airspace (the land ownership below), with the same flow. **Ships** violate territorial waters: water
   tiles adjacent to a foreign coast; open sea never counts.

### 9.8 Synchronisation

| Direction | What | Protocol | Rate |
|---|---|---|---|
| local → sim | position and heading of the controlled unit (the unit really moves) | `controlledMove {unitId, x, y, heading}` | every 1 real s, or every 200 m (tank), 500 m (ship), 2 km (jet) |
| local → sim | enemy soldiers killed | `commandCasualties {victim, troops: soldiers × 25}` | aggregated every 2 real s |
| local → sim | enemy tanks, IFVs, jets, ships hit | `commandCasualties.unitHits [{unitId, dmg}]`: tank 0.25, IFV 0.10, jet 1/3, ship hit 0.25 of the unit | same |
| local → sim | structure parts destroyed | `commandCasualties.structureHits [{structureId, dmg}]`: SAM launcher 0.35, bunker 0.25, building 0.2 | same |
| local → sim | own formation losses | `controlledDamage {unitId, integrity}` | on change |
| sim → local | tiles flipping, divisions arriving, strikes, nukes at the place | re-read of `ctx.sim.view` | every 2 real s |

Worker-side, `controlledMove` and `commandCasualties` apply immediately, also between ticks (like paused commands
today). The controlled unit counts for front support like any unit (§6.3) and never captures tiles. Kills are credited
to `commandKills`. `commandResult` remains in the protocol and carries only what was not synced yet (normally nothing).

### 9.9 Formation and losses

You drive one vehicle of the formation: one of the division's tanks (1 per 25 % integrity), one of the squadron's jets
(1 per third), or the warship. The others follow as wingmen with the existing command AI. If your vehicle is destroyed,
the formation loses it in the sim (division −25 %, squadron −1/3, ship: each hit −25 %) and after 3 s (or `Tab`) you
continue in the next surviving vehicle. When none is left the unit is destroyed in the sim and command mode ends with
the debrief.

### 9.10 Controls (keyboard and mouse)

Existing bindings are kept; new keys are marked **new**.

| Tank | | Jet | | Ship | |
|---|---|---|---|---|---|
| W / S | throttle / brake-reverse | Mouse | aim point (mouse-aim instructor) | W / S (↑ / ↓) | engine telegraph, 5 steps |
| A / D | steer hull | W / S | throttle; Shift afterburner | A / D (← / →) | rudder |
| Mouse | turret and gun aim | A / D | roll override | Mouse | gun director aim |
| LMB | main gun | Q / E | yaw | LMB | main guns |
| RMB | gunner sight zoom | LMB | cannon | RMB | anti-ship missile / zoom |
| 1 / 2 | AP / HE shells | RMB | missile | | |
| Space | coaxial MG | F | flares | | |
| C | smoke | | | | |
| **M** | tactical map, set autopilot waypoint | **M** | tactical map, waypoint | **M** | tactical map, waypoint |
| **+ / −** | time compression (§9.3) | **+ / −** | time compression | **+ / −** | time compression |
| **Tab** | next vehicle of the formation | **Tab** | next jet | | |
| Esc | leave command mode | Esc | leave | Esc | leave |

The **tactical map** (`M`) is a 2D overlay of 60 km (tank), 300 km (jet) or 150 km (ship) around the vehicle: relief
shading, ownership and borders, towns, known forces as icons (§10.7), fronts; a click sets the autopilot waypoint.

### 9.11 HUD

* Top-left: unit name, place (`describePlace`), land status («territorio propio · en paz», «Francia · en paz ·
  INCURSIÓN», «Alemania · en guerra»), clock chip («TÁCTICO 1:1» / «VIAJE ×300»).
* Top-centre: compact strategic alert strip (critical and danger alerts from §8.2), with «Esc: volver al mapa».
* Bottom: formation status (4 tank pips), integrity, ammo; for jets fuel is not simulated beyond the squadron reach.
* Contact indicators: enemy direction markers, and the source of the local forces on hover («Guarnición del Frente de
  Lyon · 1.840 tropas en la zona»).
* No objective counter, no operation name.

### 9.12 Exit

`Esc` → «¿Volver al mapa estratégico?» → a short debrief (distance travelled, enemies destroyed and their strategic
equivalent, losses; all already applied) → climb to 2,500 km **above the unit's new position** → the previous strategic
speed is restored and the strategic renderers resync from `ctx.sim.view`.

### 9.13 Removed from command mode

`src/command/mission.ts` scripting (defensive lines 370–400 m ahead, enemy waves, friendly air strikes every 40–60 s,
artillery every 4–10 s, kill objectives), `OP_A`/`OP_B` operation names, the objective counter, and the app's "strongest
nation in the world" fallback enemy. The visual assets (vehicles, effects, props, HUD styling) stay.

---

## 10. Map readability spec

### 10.1 Territory fill

* The fill mixes the owner colour into the ground colour, keeping 30 % of the ground's luminance variation so relief
  stays visible: `col = mix(ground, owner × (0.7 + 0.3 × lum(ground) / lumAvg), fill)`. It replaces the weak
  luminance-preserving tint of `earth.ts` (CM§15, fill `0.26 + …`).
* `fill` by camera altitude (log-interpolated): ≥ 6,000 km **0.55**; 1,500 km 0.45; 300 km 0.35; ≤ 40 km 0.25. The
  human's land +0.05; hover +0.08.
* **Neutral land** is desaturated 35 % and darkened 10 % above 1,000 km, so owned land stands out.
* **Patterns** (one meaning each, listed in the map legend of the help screen):
  * allies: wide diagonal hatch in the ally's colour (v1);
  * **contested** (front heat > 0.1): narrow animated diagonal stripes, orange-red, 1.5 tiles deep;
  * **occupied** (capture stamp younger than 720 ticks, §4.13): a dot stipple in the owner's colour over 70 % fill;
  * fallout: the v1 scar.
* The battle terrain patch and the globe near patch use the same fill GLSL chunk, so there is no seam (§10.11).

### 10.2 Palette

* Nation colours are generated in OKLCH with lightness 0.60–0.82 and chroma ≥ 0.10; neighbouring countries get hues at
  least 30° apart (`src/data/palette.ts pickDistinctColors`, adjacency from the country raster). No dark colours.
* The human picks from 16 readable presets (or a custom colour clamped to the same range) with a live preview on the map.
* Rebels: the parent's hue rotated 25°, lightness 0.64, thin stripes. No more dark grey successor states.
* Independent territories: muted (chroma 0.05, lightness 0.60), label without troops.

### 10.3 Borders

* **Smooth borders.** For each fragment, the shader takes the 4 nearest owner texels with bilinear weights and computes
  the coverage `c` of the fragment's owner; the border lies at `c = 0.5`, its distance in pixels is
  `(c − 0.5) / fwidth(c)`. Corners round off and the 25 km staircase disappears at every strategic altitude. Below
  300 km a subtle 2–6 km noise perturbs the line so it reads like a real border.
* Widths: 1.4 px for others, **2.4 px for the human** with a 3 px inner glow; the border between two players at war with
  each other gets a thin dark core and both colours on each side (the front band of §11.2 draws on top).
* Coastlines get no border line.
* Optional **historical borders** overlay (Natural Earth countries): 0.8 px dotted grey lines below 3,000 km, on by
  default, so players can tell where France was.
* **Conquest flash**: captured tiles glow in the attacker's colour through the same bilinear coverage, fading over 2 real
  seconds. No white squares (fixes D03).

### 10.4 Night

Above 1,000 km the night side gets a bluish floor light of 0.22, the territory fill keeps 70 % of its day brightness as
emission, borders stay emissive and city lights stay. Below 1,000 km the floor fades to 0.1 to keep the night mood in
close views. Result: nations and islands are readable on the night side (fixes D02).

### 10.5 Clouds

Setting *Nubes*: **Estratégicas** (default), *Realistas*, *Ocultas*.

| Camera altitude | Over the human's land and over fronts | Over other land | Over ocean |
|---|---|---|---|
| > 2,500 km | 0 | × 0.2 | × 0.85 |
| 800–2,500 km | lerp | lerp | lerp |
| < 800 km | × 0.3 over fronts, × 0.6 elsewhere | × 0.6 | × 1 |

* The cloud shader samples the owner and heat textures under each cloud texel (uv offset by `uCloudOffset`). Cloud
  shadows follow the same factor.
* Realistic mode keeps v1's look but fixes the pixelated blocks: mipmaps, trilinear filtering and anisotropy on the
  cloud texture.
* Labels, icons, island markers, front overlays and alert markers always draw above clouds.

### 10.6 Small islands

* At game start the client computes land components once (4-connected playable tiles). Components of ≤ 20 tiles
  (~480 of the 557) get a **marker**.
* Marker: a screen-space ring of diameter `max(8 px, projected island size + 4 px)`, 1.5 px stroke; filled with the
  owner colour when owned, white outline when neutral; above clouds; hidden once the island itself is larger than 16 px.
  Markers within 10 px of each other merge into one archipelago marker with a count.
* Hover: «Malta · 1 casilla · libre»; left click and `B` act on the island tile (expand, invade).
* The ground shader draws a 1 px white shoreline around these components above 1,500 km.
* The AI settles neutral islands after the land race (`ai/naval.ts` adds reachable neutral islands to its targets), so
  that ≥ 80 % of components with ≥ 5 tiles are owned by tick 18,000 (Hawaii stayed neutral in v1).

### 10.7 Icons versus models (LOD)

| Camera altitude | Units | Structures |
|---|---|---|
| > 1,500 km | icons only | icons only |
| 900–1,500 km | icons; models fade in from 1,200 km (min 12 px) | icons only |
| 600–900 km | icons shrink to 14 px and float above the models | icons; models fade in from 900 km |
| 250–600 km | models; a 6 px owner pip above each | icons + models |
| < 250 km | models at real size below 60 km (min 12 px above) | models only; level pips on hover and selection |

* **Icon**: 22 px frame for units, 18 px for structures. Frame shape by relation to the viewer (NATO convention):
  **own = rectangle**, ally = rectangle with a dashed outline, **at war = diamond**, others = rounded square. Fill =
  owner colour; white glyph (dark glyph on light colours, contrast ≥ 4.5:1); glyphs from §6.5; structure level as 1–3
  dots under the frame (cities show the number); unit integrity as a 2 px bar when below 100 %; selection as a white
  outer ring; an hourglass badge while producing or building.
* **Clustering**: icons of the same owner and category within 26 px merge into one with a count badge; clicking fans
  them out.
* **Implementation**: an atlas drawn with canvas 2D at init (2048², 64 px cells), one instanced screen-space quad batch
  for units and one for structures (2 draw calls), `renderOrder 45` (above clouds 30 and atmosphere 40), depth test off,
  horizon test as `render/units/overlays.ts`. Picking uses the icon rectangles (§7.2).
* **Models** are no longer inflated to 16–46 px from orbit (CM§12): the `ANCHORED` min-pixel scaling applies only between
  the thresholds above.
* **Grounded structures** (fixes F15, G01): the up vector is the terrain normal averaged over the footprint (clamped to
  ≤ 15° from the radial), the anchor is the mean surface height of the footprint, and a foundation pad with a skirt
  reaches down to the lowest point (skirt depth = relief range under the footprint + 5 %). Footprints are real: 2.5–6 km.
  The near globe patch flattens relief under structure pads (pad mask) when available.

### 10.8 Routes and trails

* New trail style **`route`** (`render/fx/trails.ts`): owner colour, **2 px screen-space width** (convoys 3 px with an
  arrowhead every 150 px), no maximum length, a point every `max(20 km, routeLength / 200)`, from the departure point
  (`originX/Y`) to the current position, kept for 15 real seconds after arrival or sinking and faded out over 5 s
  (fixes F2). A sinking leaves a small red cross for 15 s.
* The remaining planned path (from `routes`, §14.5) is drawn dashed at 40 % opacity ahead of the ship.
* Trade ships: 1 px at 30 % opacity, only below 5,000 km. Warships: 1.5 px while moving; patrol and blockade zones as
  dashed circles when selected.
* Aircraft sorties: dashed base→target line in the owner colour while in flight and for 10 s after.
* Divisions: dashed route with the ETA at the end on hover and selection.
* Enemy convoys heading to you: the route line pulses with a red outline.
* The white wake stays, only below 300 km.
* Budget: at most 64 route trails (oldest fade first), drawn in the existing trail batch.

### 10.9 Fronts and attack arrows

Specified in §11.2 (they are the strategic level of the battle LOD).

### 10.10 Labels

* **Placement**: greedy by priority (the human, nations at war with the human, allies, then by land). A label is
  dropped (faded over 0.3 s) if its screen rectangle overlaps an already placed label, if it lies near the limb
  (`dot(normal, view) < 0.35`), or if it intersects a HUD panel (`ctx.ui.getOccludedRects()`). Recomputed at 4 Hz with
  hysteresis (a placed label keeps its slot unless a higher-priority label overlaps it by more than 30 %).
* **Content**: name and compact troops; ★ for the human; small crossed swords for nations at war with you; a handshake
  for allies. Independent territories: name only, smaller. Size 12–28 px by land.
* **No chromatic aberration in the strategic view**: the post pass sets CA to 0 outside command mode and cinematic
  shots, so text never gets RGB fringes.

### 10.11 Close zoom outside battles

* The fill continues (0.25–0.35) and borders become ground-projected 2–3 px lines with a dark outline.
* Below 200 km a procedural detail layer (albedo and normal noise at 200 m and 1.5 km, modulated by the relief and the
  biome) fades in over the NASA texture so the ground is not a blur.
* The globe near patch (`globe/index.ts placePatch`) and the battle terrain patch share the globe's fill and colour
  functions, so owned land never looks like a flat blue plane and there is no rectangular seam (fixes D08).

### 10.12 Effects readability

* **Launch plume**: sized in world units (6 km at ignition, growing to 20 km) with a minimum pixel size recomputed every
  frame, never more than 8 % of the screen height (fixes E01; the v1 `visKm()` froze the size at launch).
* Front smoke and flashes: §11.4.

### 10.13 Spawn-phase view

The camera opens at 12,000 km over Europe and Africa (lat 35°N, lon 15°E) with the presentation sun at noon there;
AI nations carry labels; free land is brightened with a slow pulse; the minimap shows owners. See §12.6 for the rules.

---

## 11. Battle LOD tie-in to real fronts and divisions

### 11.1 Altitude bands

| Camera altitude | What shows a front |
|---|---|
| > 2,500 km | Front bands, operational arrows, front badges (§11.2); contested stripes on the ground (§10.1) |
| 600–2,500 km | Same, plus icons of attached divisions and sparse flashes |
| 150–600 km | Far layer: flashes and fires along the band, capped smoke (§11.4), badges, division icons or models |
| 24–70 km (fade from 42) | Ground battle composed from real data (§11.5) |
| < 24 km | Full ground battle |

### 11.2 The front overlay seen from orbit

One overlay module (`src/render/battle/overlay.ts`, ≤ 4 draw calls), fed by `view.fronts` (stable keys, §14.2) and
`view.attacks`:

* **Front band** along the front polyline: 12 px wide above 2,500 km, 1.5 tiles in world space closer. Split lengthwise
  into the attacker's colour and the defender's colour. Animated chevrons move toward the side that is losing ground,
  at a speed proportional to the advance in km/h; no chevrons when momentum is within ±0.1. **Quiet fronts** (at war, no
  offensive): a dashed two-colour line.
* **Operational arrow** per offensive: a curved arrow from 3 tiles behind the attacker's line to the axis point, width
  6–18 px by `log10(committed troops)`, attacker colour with a dark outline, 70 % opacity. Naval invasions: an arrow
  along the convoy route ending at the landing.
* **Front badge** at the middle of the band: two colour chips with 3-letter codes (country ISO3; «TÚ» for the human), a
  tug-of-war bar (attacker share `Pa / (Pa + Pd)`), the advance («▶ 5 km/h» or «‖ estancado»), and division chips per
  side. Hover: names, troops per side, casualties, days of fighting, divisions. Click: select the front (camera and
  Guerra panel).
* **Mobilization arrows**: during an aggressor's mobilization window, short pulsing arrows on its side of the border.
* Visible above 150 km; hidden in command mode. A verifier must be able to say from one screenshot at 2,500 km who
  attacks whom, in which direction, and who is winning.

### 11.3 The Guerra y frentes panel (`G`)

* **Guerras**: each war with the enemy, goal and reason, day count, escalation level (L0–L4 icon), war score bar,
  exhaustion of both sides, *Proponer paz* (terms dialog), *Pedir ayuda a aliados*.
* **Frentes**: each front involving you (a *Mundo* tab lists the 10 hottest world fronts): name («Frente de Lyon»),
  sides, troops at the front on each side, momentum and km/h, tiles won and lost, divisions attached per side, time
  since it opened. Buttons with tooltips: *Ir*, *Prioridad* (baja / normal / alta, §4.4), *Enviar divisiones*,
  *Contraofensiva*, *Retirar* (own offensives).
* Sorted by danger: fronts on you losing ground first, then by distance to your capital.

### 11.4 Far layer (150–600 km)

`render/battle/far.ts`: flashes and fires only inside the front band, density proportional to intensity, more on the
side being pushed; at most 6 smoke columns per front in view, opacity ≤ 0.35, height ≤ 3 km; no screen-wide haze. At
600 km smoke never covers more than 25 % of the screen (fixes E03).

### 11.5 Ground battle composed from real data (< 70 km)

* **Anchor**: `nearestFront` by stable key, so the battle no longer re-anchors when cluster order changes.
* **Line**: the real front polyline in local coordinates, interpolated between updates. It moves with the real front
  (at the 8 km/h cap: 2.2 m per real second at 1x).
* **Infantry**: the quality budget split by `Pa / (Pa + Pd)` clamped to 0.2–0.8 (the real proportion; v1 clamped the
  troop share to 0.3–0.7).
* **Vehicles**: each side's **real** attached divisions within 50 km at their real positions relative to the anchor
  (1 tank per 25 % integrity + IFVs); generic vehicles only fill the quality budget in proportion to troops.
* **Air and sea**: real squadrons patrolling or striking over the front fly over; drone swarms supporting the front circle
  above; warships bombarding within range appear offshore with naval gunfire.
* Casualties stay visual (the sim decides the numbers); explosion rate follows the front intensity.

### 11.6 Battle clock

Battle animation uses `frame.visualDt` (real time while not paused): a battle looks the same at 0.5x and 4x and freezes
on pause (v1 advanced it by `frame.simDt`, which is now 60–3,600× faster).

### 11.7 Labels and HUD strip

Floating flags with nation names above each side's line, and a top strip: «FRENTE DE LYON · Alemania (ataca)
320.000 ▶ 180.000 Francia · avance 5 km/h · 3.er día de combate».

---

## 12. Explanations: tooltips, help, tutorial, encyclopedia

### 12.1 Tooltip standard

A shared component (`src/ui/tooltip.ts`, `data-tip` keys, 350 ms delay, Shift pins it) with: title; one-line purpose;
**Ahora** (current numbers); **Siguiente nivel** (numbers); cost and time; hotkey; and **Por qué no** when disabled
(«Te faltan 42.000 de oro», «Necesitas una base aérea con hueco libre», «Estás en paz con Francia»). Content functions
read `STRUCTURE_LEVELS`, `UNIT_DEFS` and live view data, never hand-written numbers. Every button, top-bar item, panel
control, build-bar and arsenal slot, map icon and pattern has one.

### 12.2 Top-bar breakdowns

* **Tropas**: at home / in offensives; the cap with its terms (base, territory, cities, army bases, occupation); growth
  per game hour and the recruitment factor from population.
* **Oro**: income per game hour by source (base, territory, occupied land, cities, factories, trade, trains, tribute).
* **Población**: current vs target; recruitment factor and what lowers it (nukes, pandemic, occupation).
* **Territorio**: % of the world; victory at 80 %.
* **Reloj**: the time scale and the clock mode (§2.7).
* **Guerras**: count with the highest escalation icon; click opens `G`.

### 12.3 Help (`F1` / `?`)

Short sections, each with a small SVG diagram where it helps: *Tiempo y velocidades*; *Guerra y paz*; *Frentes y
ofensivas* («con el triple de fuerza avanzas a la velocidad máxima, 8 km/h; con menos fuerza que el defensor, no
avanzas»); *Defensa*; *Unidades*; *Estructuras*; *Diplomacia*; *Escalada y armas nucleares*; *Alertas y pausa
automática*; *Modo mando*; *Leyenda del mapa* (icons, frames, patterns, colours).

### 12.4 Encyclopedia

A Help tab with one entry per unit and structure, generated from `UNIT_DEFS`, `STRUCTURE_LEVELS` and i18n: icon,
purpose, a stats table per level, what counters it («Contrarrestado por: cazas y baterías SAM»), its orders and hotkeys.

### 12.5 Tutorial ("Asesor militar")

State-driven, starts in the spawn phase, never advances on a timer, highlights the UI element involved, skippable, and
its progress is saved in settings.

| # | Step | Completes when |
|---|---|---|
| 1 | *Funda tu capital*: choose free land (highlighted); AI nations already sit in their countries | the human has spawned |
| 2 | *Expándete*: click free land; the slider sets how many troops you send | land ≥ 3× the starting land |
| 3 | *Construye una ciudad*: population, recruitment and gold | a city is built |
| 4 | *Conoce a tus vecinos*: open `N`, propose a trade agreement or a NAP | a proposal was sent |
| 5 | *Tu ejército*: build an army base, produce a division (8 h) | `unitReady` |
| 6 | *Mueve tu división*: `U`, select it, right-click where it should go | an accepted move order |
| 7 | *El reloj*: speeds, pause, pausa automática | the player clicks "Entendido" |
| 8 | *Alertas y frentes* (triggered by the first tension or war): open `G`, set a priority or send a division | one of those actions |
| 9 | *Modo mando*: take control of your division at peace, try travel mode | command mode entered |
| 10 | *Diplomacia* (triggered by the first proposal received): answer from the inbox | the proposal answered |

### 12.6 Spawn onboarding

* In single player the spawn phase waits for the human: AI nations are placed at start and nothing ticks for them until
  the human founds its capital. A **Sugerir un lugar** button picks the free land nearest the camera centre.
* Scripted sessions keep `autoSpawnTile`. If a spawn deadline is ever used, the automatic spawn takes the free land
  nearest the camera centre and says so in a toast (fixes B02).
* Clicking AI land: «Esta tierra pertenece a España (IA). Funda tu capital en tierra libre (resaltada).»
* Camera and labels per §10.13 (fixes B01).

### 12.7 Text quality rules

* Natural Spanish by default, English complete; every new key in both (`src/ui/i18n/es.ts`, `en.ts`, or the owner's
  namespaced dictionary).
* No gendered placeholders: nouns carry their gender (`structure.port.g = 'm'`) and messages have gendered variants
  (`msg.structureCaptured.m` / `.f`), fixing «un(a) Puerto» (I01).
* `t()` never leaves a raw `{param}`: in development it warns; in production a missing param becomes an empty string. The
  `msg.allyTarget` parameter bug is fixed; the setup's `"${n} IA"` and the command compass go through i18n.
* Numbers through `formatNumber` (es «120.000»), durations as game time plus real time (§2.7).
* The end screen reports troops lost correctly, including troops lost at elimination (I03).

---

## 13. Audio adjustments

| Situation | Cue or change |
|---|---|
| War declared on you | `warHorn`: two low brass blasts |
| Offensive on you | `klaxon`: short, once per front (not per reinforcement) |
| Invasion detected | `navalHorn` |
| Capital threatened | `capitalSiren` (distinct from the nuclear siren) |
| Ultimatum | `drum` hit |
| Diplomatic answer | `chimeGood` / `chimeBad` |
| Order accepted | `radioAck` («Recibido») |
| Unit ready | `readyBell` |
| Crisis time | music to a low drone with a heartbeat; world SFX low-passed at 1.2 kHz; the nuclear siren kept |
| Music moods | `calm` (no wars), `tension` (tension, ultimatum or mobilization against you), `war` (active fronts), `nuclear` (any war at L3+), plus `defeat` pressure when the capital is threatened |
| Combat density | `combat` cues ≤ 2 per real second per front in earshot and ≤ 6 in total; distant fronts as a rumble bed whose gain follows the summed intensity of fronts within 2,000 km of the camera |
| Travel mode | engine loop pitch follows the compression; a wind bed |
| Tactical time | strategic cues muted except alerts |
| Diagnostics | `__fuAudio.stats()` counts plays per cue |

---

## 14. Protocol and data changes

All changes are **additive** unless marked *(number change)* or *(value change)*. Each workstream adds its own block in
shared files, delimited by `// --- v2 (Wn): <topic> ---`, to keep concurrent edits apart. Both ends of the protocol
(`src/sim/game.ts buildUpdate` and `src/sim/client.ts apply`) are updated in the same commit as the fields.

### 14.1 `src/shared/constants.ts` and new shared helpers

```ts
// time (W1)
export const GAME_SECONDS_PER_TICK = 360;          // 6 game minutes
export const TICKS_PER_GAME_HOUR = 10;
export const TICKS_PER_GAME_DAY = 240;
export const kmhToTilesPerTick = (kmh: number): number => (kmh * GAME_SECONDS_PER_TICK / 3600) / TILE_KM;
export const hoursToTicks = (h: number): number => Math.round(h * TICKS_PER_GAME_HOUR);
export const CRISIS_SLOWDOWN = 60;
export const TRAVEL_RATES = [10, 60, 300, 900] as const;   // command-mode travel, game s per real s
export const DAY_LENGTH_SEC = 1200;                 // (number change) presentation seconds per visual day
// warfare (W1; shared because the UI predicts offensives)
export const ADVANCE_MAX_KMH = 8, NEUTRAL_ADVANCE_KMH = 7.5, ADVANCE_FULL_RATIO = 3;
// UnitDef gains: speedKmh, rangeKm (0 = n/a), productionTicks, roleKey. `speed` becomes kmhToTilesPerTick(speedKmh).
// StructureDef: buildTicks per §2.4 (value change); maxLevel 3 for Port and Factory (value change, was 5).
// NukeDef: inner/outer radii per §6.3 (value change), + rangeTiles.
export interface StructureLevelDef { /* per-type numeric effects of §6.2, e.g. rangeTiles, abmTiles, salvo, hitAir,
  hitBallistic, reloadTicks, capacity, troopCap, goldPerHour, repairPerHour, radiusTiles, timeMul, casualtyMul,
  weapons, tradeShips, embarkTicks, railSlots */ }
export const STRUCTURE_LEVELS: Record<StructureType, readonly StructureLevelDef[]>;   // W4, single source of truth
export function upgradeCost(type: StructureType, level: number): number;              // W4, §6.1
```

New worker-safe module **`src/shared/orders.ts`** (W4 with W1): the pure rules both the sim and the UI call.

```ts
export interface RulesView {            // implemented by Game (worker) and by an adapter over GameView (main)
  ownerOf(tile: number): number; pairState(a: number, b: number): PairState; hasTreaty(a: number, b: number, k: TreatyKind): boolean;
  escalation(a: number, b: number): number; unit(id: number): UnitLike | null; structureAt(tile: number): StructureLike | null;
  homeTroops(p: number): number; frontOf(tile: number): FrontLike | null;
}
export function orderError(r: RulesView, unitId: number, order: UnitOrderKind, tile: number, targetId: number): string | null; // i18n key
export function predictOffensive(r: RulesView, attacker: number, defender: number, troops: number, tile: number): { ratio: number; advanceKmh: number };
export function advanceKmh(ratio: number): number;                  // §4.5
export function ballisticFlightTicks(distanceKm: number): number;   // §2.3
export function canTransit(r: RulesView, unitOwner: number, tileOwner: number): boolean;   // own, ally, open borders
```

### 14.2 `src/shared/types.ts`

```ts
export type GameSpeed = 0 | 0.5 | 1 | 2 | 4;                              // + 0.5
export type ClockMode = 'strategic' | 'crisis' | 'tactical' | 'travel';
export interface ClockView { mode: ClockMode; rate: number; tickPeriodMs: number }  // rate = game s per real s
export type PairState = 'peace' | 'war' | 'truce';
export type TreatyKind = 'alliance' | 'nap' | 'trade' | 'openBorders';
export type WarGoal = 'border' | 'tribute' | 'conquest' | 'retaliation' | 'coalition' | 'liberation' | 'defense' | 'incursion';
export interface WarView { id: number; aggressor: number; target: number; parentWar: number; startTick: number;
  goal: WarGoal; reasonKey: string; mobilizeUntilTick: number; escalationA: number; escalationB: number;
  scoreA: number; exhaustionA: number; exhaustionB: number }
export interface TreatyView { a: number; b: number; kind: TreatyKind; sinceTick: number; untilTick: number; leavingTick: number }
export interface OpinionView { of: number; toward: number; score: number; reasons: { key: string; value: number; params?: Record<string, string | number> }[] }
export type ProposalKind = TreatyKind | 'peace' | 'callToArms' | 'demand';
export interface PeaceTerms { kind: 'white' | 'cede' | 'tribute' | 'capitulation'; tiles?: number; gold?: number; incomeShare?: number; ticks?: number }
export interface Demand { kind: 'cede' | 'tribute' | 'breakAlliance' | 'endEmbargo' | 'withdraw'; tiles?: number; gold?: number; target?: number }
export interface ProposalView { id: number; from: number; to: number; kind: ProposalKind; terms?: PeaceTerms; demand?: Demand;
  war?: number; target?: number; createdTick: number; decideTick: number; expiresTick: number;
  status: 'considering' | 'pending' | 'accepted' | 'rejected' | 'countered' | 'expired';
  reasons?: { key: string; value?: number; params?: Record<string, string | number> }[]; counterId?: number }
export type UnitOrderKind = 'move' | 'attach' | 'hold' | 'return' | 'cap' | 'intercept' | 'escort' | 'strike' | 'support'
  | 'patrol' | 'blockade' | 'bombard' | 'rebase';
// AttackView += x, y (axis point), frontKey, tilesTaken, tilesLost, ratio, advanceKmh, committed, etaTicks,
//   state: 'embarking' | 'sailing' | 'landing' | 'contact' | 'advancing' | 'stalled' | 'retreating'
// FrontView  += key (stable), momentum (-1..1, + = side a gaining), advanceKmh, startTick, pa, pd, casualtiesA,
//   casualtiesB, divisionsA, divisionsB, quiet, offensiveA, offensiveB, priorityA, priorityB
// UnitView   += mode, order, etaTicks, frontKey, home, serial
// FrameInfo (api.ts) += gameHours, visualDt
```

Stable front keys (W1): after clustering, each new cluster is matched to the previous clusters of the same pair by
centroid distance (< 8 tiles) and polyline overlap; a match keeps the key, otherwise a new key is allocated. Quiet fronts
(at war, no offensive) are computed every 20 ticks from border contact between the pair.

### 14.3 Commands (`PlayerCommand`)

```ts
| { type: 'declareWar'; target: number }                                                  // W1
| { type: 'propose'; target: number; kind: ProposalKind; terms?: PeaceTerms; demand?: Demand; war?: number; against?: number }  // W3
| { type: 'answer'; proposalId: number; accept: boolean }                                 // W3
| { type: 'leaveTreaty'; target: number; treaty: TreatyKind }                             // W3
| { type: 'setFrontPriority'; frontKey: number; priority: 0 | 1 | 2 }                     // W1 (UI in W6)
| { type: 'unitOrder'; unitIds: number[]; order: UnitOrderKind; tile: number; targetId: number }   // W4
| { type: 'controlledMove'; unitId: number; x: number; y: number; heading: number }       // W5
| { type: 'commandCasualties'; unitId: number; victim: number; troops: number;
    unitHits: { unitId: number; dmg: number }[]; structureHits: { structureId: number; dmg: number }[] }   // W5
| { type: 'controlledDamage'; unitId: number; integrity: number }                         // W5
```

`attack` against a nation at peace is rejected by the sim with `msg.notAtWar` (the UI declares first). `moveUnit`,
`deployArmor`, `airStrike`, `allianceRequest`, `allianceReply`, `breakAlliance`, `emote`, `targetPlayer` and
`commandResult` stay for compatibility; the AI may keep issuing the old unit commands, which W4 maps onto `unitOrder`.

### 14.4 Events (`SimEvent`)

```ts
| { type: 'warDeclared'; tick; war: number; aggressor: number; target: number; goal: WarGoal; reasonKey: string; mobilizeUntilTick: number; betrayal: boolean }
| { type: 'warEnded'; tick; war: number; a: number; b: number; winner: number; terms: PeaceTerms }
| { type: 'tension'; tick; from: number; to: number; reasonKey: string; params: Record<string, string | number> }
| { type: 'proposal'; tick; proposal: ProposalView }                    // created or status changed
| { type: 'treatyChanged'; tick; a: number; b: number; treaty: TreatyKind; active: boolean; reasonKey: string }
| { type: 'escalation'; tick; war: number; by: number; level: number; reasonKey: string }
| { type: 'siege'; tick; owner: number; by: number[]; stage: 'start' | 'end'; tiles: number; x: number; y: number }
| { type: 'offensive'; tick; attackId: number; attacker: number; defender: number; stage: 'stalled' | 'resumed' | 'ended'; x: number; y: number }
| { type: 'unitReady'; tick; unitId: number; unit: UnitType; owner: number; structureId: number; x: number; y: number }
| { type: 'invasionDetected'; tick; unitId: number; owner: number; target: number; toTile: number; etaTicks: number; troops: number; by: 'radar' | 'coast' | 'neighbour' }
| { type: 'borderIncursion'; tick; intruder: number; victim: number; unitId: number; tile: number; stage: 'entered' | 'left' | 'response'; response?: 'protest' | 'intercept' | 'war' }
| { type: 'clockChanged'; tick; mode: ClockMode; rate: number }
// attackStarted += frontKey?, x?, y?  (optional fields)
```

`FF_EVENT_TYPES` (fast-forward filter) keeps `warDeclared`, `warEnded`, `treatyChanged`, `proposal`, `escalation`.

### 14.5 `TickUpdate`

| Field | Type | When | Owner |
|---|---|---|---|
| `clock` | `ClockView` | always | W1 |
| `wars` | `WarView[]` | when changed | W1 |
| `fronts` | extended `FrontRecord` (§14.2) | every 5 ticks for offensives, every 20 for quiet fronts | W1 |
| `sieges` | `{owner, by: number[], x, y, tiles}[]` | when changed | W1 |
| `treaties` | `TreatyView[]` | when changed | W3 |
| `opinions` | `OpinionView[]` (AI opinions of the human only) | every 240 ticks and when changed | W3 |
| `proposals` | `ProposalView[]` involving the human | when changed | W3 |
| `units` | `UNIT_STRIDE` 14 → **20**: `UF.mode 14, order 15, eta 16, frontKey 17, home 18, serial 19` | always | W4 |
| `routes` | `{unitId, tiles: Int32Array}[]` (transferable), sent once per new path | when a path is planned | W4 |
| `rail` | `Int32Array` of station-id pairs (the sim's rail graph; replaces the client reconstruction) | when changed | W4 |
| `production` | `{structureId, unit, readyTick}[]` of the human | when changed | W4 |

### 14.6 `ToWorker`

* `speed` accepts `0.5`.
* `{ kind: 'clock'; mode: 'strategic' | 'tactical' | 'travel'; rate?: number }` (W1 implements, W5 calls it through
  `ctx.sim.setClock(mode, rate)`). Crisis is decided inside the worker.

### 14.7 `src/shared/simapi.ts` (sim-core ↔ sim-ai)

`SimGame` gains: `pairState(a, b)`, `atWar(a, b)`, `wars()`, `war(id)`, `escalation(a, b)`, `raiseEscalation(war, by,
level, reasonKey)`, `frontsOf(pid)`, `hasTreaty(a, b, kind)`, `treaties(pid)`, `diplomacy` (the W3 system's AI-facing
API: `opinion`, `addReason`, `propose`, `issueTension`, `issueUltimatum`), `war` (the W1 system's API: `declare`,
`makePeace`, `capitulate`, `warScore`, `exhaustion`). `AiDirector` gains optional `onProposal(p)` and
`onIncursion(e)`.

### 14.8 `src/shared/api.ts`, `events.ts`, `settings.ts`

* `GameView` gains `clock`, `wars`, `treaties`, `opinions`, `proposals`, `sieges`, `routes: Map<number, Int32Array>`,
  `rail`, `production`, `frontByKey`.
* `SimClientApi.setClock(mode, rate?)`; `AppController.setSpeed` accepts `0.5`.
* `CommandEnterParams` gains `context`, `heading`, `formation` (vehicles alive); `enemy = 0` is the normal peaceful case.
* `UiApi.getOccludedRects(): readonly DOMRect[]` (labels avoid HUD panels) and `UiApi.alert(input: AlertInput)`.
* `FrameInfo` gains `gameHours` and `visualDt` (§2.5).
* `AppEvents` gain `alert {input}`, `autoPaused {kind}`, `crisis {active, secondsLeft}`, `panelToggled {panel, open}`,
  `frontSelected {key}`.
* `Settings` gain `autoPause: Record<AutoPauseKind, boolean>` (§8.5), `clouds: 'strategic' | 'realistic' | 'hidden'`,
  `crisisTime: 'always' | 'mine' | 'off'`, `historicalBorders: boolean`, `tutorialProgress: number`. `edgePan` leaves the
  settings UI.

### 14.9 Data

* **`src/data/places.ts`** (W3): about 400 major world cities, hand-curated like the capitals table: `{nameEs, nameEn,
  lat, lon, iso3, rank}`, plus `nearestPlace(lat, lon, maxKm)`. Used for alerts, fronts, city names and command mode.
* **Night-lights sampler** (W5): `sampleNightLights(lat, lon)` on the main thread from `earth-night.jpg` pixels, for
  village density in command mode.
* **Land components** (W2): computed once per game on the client from `world.terrain` (islands, §10.6).
* **Local heightfield in the data worker** (W5) if chunk generation exceeds 8 ms (§9.4).

### 14.10 Contracts between workstreams

| Provider | API | Consumers | Stub until it lands |
|---|---|---|---|
| W1 | `src/sim/war.ts` `WarSystem`: `pairState`, `atWar`, `declare(aggressor, target, goal, reasonKey)`, `makePeace(a, b, terms)`, `capitulate(loser, winner)`, `warScore`, `exhaustion`, `escalation`, `raiseEscalation` | W3 (peace, AI war pipeline hooks), W4 (order legality), W5 (incursion war) | – (W1 lands it first) |
| W1 | Worker clock (`clock` message, `TickUpdate.clock`), `FrameInfo.gameHours/visualDt` | W5, W6, all renderers | – |
| W1 | Extended `FrontRecord` with stable keys, momentum and powers | W6, W3 (alerts), W5 (local forces) | W6 reads v1 fields with defaults |
| W3 | `src/sim/diplomacy.ts` `DiplomacySystem`: `hasTreaty`, `canTransit`, `opinion`, `addReason`, `propose`, `issueTension`, `issueUltimatum`; AI side `prepareWar(brain, target, goal)` which runs tension → ultimatum and calls `war.declare` | W1 (AI war pipeline), W4 (transit), W5 (incursion response) | W1 declares after a 240-tick `tension` event it emits itself |
| W3 | Alert API: bus `alert` / `ctx.ui.alert(AlertInput)` | W1, W4, W5, W6 | a toast |
| W4 | `unitSys.frontSupport(attackId)`: attached divisions, drone support, naval bombardment per side | W1 (§4.4) | W1 keeps the v1 `frontArmor` lists |
| W4 | `UF` extension, `routes`, `rail`, `production`, `unitOrder` | W2 (routes, icons), W5, W6 (divisions at fronts) | – |
| W2 | Icon layer and `pickUnit` via icons; `getOccludedRects` consumer | W4 (selection), W6 | v1 picking |
| W5 | `controlledMove`, `commandCasualties`, `controlledDamage` handling in the sim; `aiDirector.onIncursion` | – | – |

---

## 15. Traceability

Every FEEDBACK-1 item and every audit defect (blockers and majors are required; minors are included) maps to the section
that resolves it and to **one** workstream that is accountable for it.

| Item | Problem | Resolved in | Workstream |
|---|---|---|---|
| F1 | Units and everything too fast | §2, §3 | W1 |
| F2 | Ship trail in owner colour from departure to arrival | §10.8 (+ `routes` §14.5 from W4) | W2 |
| F3 | Conquest must be animated and bounded | §4.4–4.9, T1–T6 | W1 |
| F4 | 2D icons when zoomed out | §10.7 | W2 |
| F5 | Clouds hide territory | §10.5 | W2 |
| F6 | Small islands invisible | §10.6 | W2 |
| F7 | Hard to control, send and see units in battle | §7, §11.5 | W4 |
| F8 | Command mode is a separate scripted mission | §9 | W5 |
| F9 | Units lack a real use | §6 | W4 |
| F10 | Territory badly delineated | §10.1–10.4, §10.10–10.11 | W2 |
| F11 | Battles fast and unclear | §4.5–4.8, §11 | W6 |
| F12 | Attacks unannounced and unlocated | §8, T7–T13 | W3 |
| F13 | Missiles without sense | §5.10–5.11, T21–T25 | W1 |
| F14 | No real diplomacy, no time to think | §5.1–5.6, §8.3, §8.5 | W3 |
| F15 | Infrastructure models broken; upgrades invisible | §6.1–6.2, §6.5, §10.7 | W4 |
| F16 | Badly explained; things exist "just because" | §1.3, §12 | W3 |
| F17 | Everything else a demanding player would notice | §12.7, §13, J01 | W3 |
| A01 | Half a nation in 1.6 s, odds irrelevant | §4.5, T1–T4 | W1 |
| A02 | Encirclement annexes whole nations without attack | §4.12, T6, T8 | W1 |
| A03 | 82–400 km per real second, incoherent classes | §2.3, T27 | W1 |
| A04 | 136 attacks/min, 23.5-min games | §3.3, §5.7 | W1 |
| A05 | Defender troops do not resist | §4.4, §4.6, §4.7 | W1 |
| A06 | Empire-scale swings | §4.13–4.14, §5.12, T19–T20 | W1 |
| A07 | Attacks announced by an unlocated toast at first loss | §8.2–8.4, T13 | W3 |
| A08 | Lethal attack right after the grace period | §4.16, §5.7, T7, T9 | W1 |
| B01 | Spawn opens on the dark Pacific, blank minimap, unlabeled AI | §10.13, §12.6 | W3 |
| B02 | Silent refusal on AI land; random far auto-spawn | §12.6 | W3 |
| B03 | Tutorial starts late; expand tooltip lies | §12.5, §7.7 | W3 |
| C01 | Take control at peace starts a mission vs a random non-neighbour | §9.2, §9.6 | W5 |
| C02 | Driving does not move the real unit; war runs unseen | §9.3, §9.8 | W5 |
| C03 | No army list; silent unit production; wrong picks | §7.2, §7.5 | W4 |
| C04 | Unit panel shows false or meaningless stats | §7.6, §6.3 | W4 |
| C05 | English operation names in Spanish UI | §9.13 | W5 |
| D01 | Territory fill too faint | §10.1–10.2 | W2 |
| D02 | Night side black | §10.4 | W2 |
| D03 | Staircase borders, pixel flashes, straight borders | §10.3 | W2 |
| D04 | Labels overlap, sit on the limb, hide under HUD; CA fringes | §10.10 | W2 |
| D05 | Opaque clouds over territory | §10.5 | W2 |
| D06 | Small islands invisible; remote islands never owned | §10.6 | W2 |
| D07 | No 2D icon layer | §10.7 | W2 |
| D08 | Blurry close zoom; owned land looks like water with a seam | §10.11 | W2 |
| E01 | Launch plume fills the screen when zooming in | §10.12 | W6 |
| E02 | AI nukes on nations not at war; no ladder; late-game flood | §5.10–5.11, T21–T25 | W1 |
| E03 | Fronts from orbit unreadable; smoke hides everything at 600 km | §11.2–11.4 | W6 |
| E04 | Back-to-back rebellions; 60 % successor state | §5.12, T20, T26 | W1 |
| F01 | White, short ship wakes | §10.8 | W2 |
| G01 | Structures float, sink, toy-like | §6.5, §10.7 | W4 |
| G02 | Upgrade shows no cost or effect; no visible change | §6.1–6.2, §7.6 | W4 |
| H01 | No dialogue or reasons; 20 s expiry | §5.3, §8.3 | W3 |
| H02 | Emote spam; "Marcar objetivo" unexplained | §1.3, §5.5 | W3 |
| I01 | Gendered placeholders "un(a) Puerto" | §12.7 | W3 |
| I02 | Stale Arsenal price | §7.6 | W4 |
| I03 | End screen "TROPAS PERDIDAS 470" | §12.7 | W3 |
| I04a | Radar description false | §6.2 | W4 |
| I04b | Population drives nothing | §6.7 | W1 |
| J01 | Playtest harness aborts; assumes the human survives | §16 (W3 brief) | W3 |

---

## 16. Workstreams

Six workstreams implement v2. Each owns the areas below, may touch any file its task needs, and is accountable for the
traceability rows assigned to it in §15. Every workstream finishes with `npx tsc --noEmit` and `npm run build` clean, its
shots registered and captured, and its measurements reported in its commit messages.

### 16.1 Dependencies and order

1. **First commits (unblock the others):** W1 lands the time block (§14.1), the worker clock, `FrameInfo.gameHours` and
   `visualDt`, and the `WarSystem` API with pair states and `declareWar` gating; W3 lands the alert API (bus `alert`,
   feed) and the `DiplomacySystem` skeleton (`hasTreaty`, `canTransit`); W4 lands `src/shared/orders.ts`,
   `STRUCTURE_LEVELS` and the protocol additions (`UF` 14→20, `routes`, `rail`, `production`, `unitOrder`); W1 lands the
   extended `FrontRecord` with stable keys.
2. **Parallel work** after that, against the contracts of §14.10 (stubs listed there).
3. **Integration checkpoints:** when W1's pressure model lands, W6 re-measures its shots and W3 its attack alerts; when
   W3's `prepareWar` lands, W1 switches its AI pipeline from the stub; when W4's `frontSupport` lands, W1 switches the
   power terms of §4.4; W5 integrates last with W1's clock, W3's diplomacy and W4's unit data.
4. **Final pass:** W1 reruns every §3 measurement on the integrated build and retunes numbers inside their ranges.

### 16.2 W1-sim-pacing-warfare

**Scope:** §2, §3, §4, §5.7 (steps 1–2 and 5–8), §5.9–5.12, §6.7. Rows F1, F3, F13, A01–A06, A08, E02, E04, I04b.

**Brief.**
* **Time** (`src/shared/constants.ts` time block, `types.ts` `GameSpeed 0.5`/`ClockView`): `src/sim/worker.ts` fractional
  tick accumulator with modes strategic/crisis/tactical/travel and the `clock` message; crisis decided in the worker from
  nuclear weapons in flight (§2.2); `src/sim/client.ts` alpha from `tickPeriodMs`, `view.clock`; `src/app/bootstrap.ts`
  `setSpeed(0.5)`, `FrameInfo.gameHours` and `visualDt`; `src/ui/hud/topbar.ts` and `controller.ts` (`SPEEDS
  [0.5,1,2,4]`, «DÍA n · hh h», scale chip, crisis chip). `DAY_LENGTH_SEC = 1200` presentation seconds.
* **Speeds**: `UNIT_DEFS[t].speedKmh` per §2.3 with `speed = kmhToTilesPerTick(speedKmh)`; `advanceKm()` metric helper
  in `src/sim/spatial.ts` used by the low-level movers in `src/sim/units.ts` (one surgical change; W4 owns behaviours);
  ballistic `flightTicks` from `ballisticFlightTicks()`.
* **War state** (new `src/sim/war.ts`, API of §14.10): pair states, `declareWar` command, mobilization, betrayal
  detection (asks W3's treaties), war score and exhaustion (§4.15), `makePeace` with terms and truce, capitulation
  (§4.13), escalation levels; events `warDeclared`, `warEnded`, `escalation`, `siege`, `offensive`, `invasionDetected`,
  `clockChanged`; `TickUpdate.wars`, `sieges`, `clock`. `attack`/`boatAttack` against a nation at peace are rejected
  (`msg.notAtWar`).
* **Conquest** (`src/sim/attacks.ts`): local power §4.4 (home troops, rear share, front share with priority,
  mobilization ramp, `setFrontPriority`), the pressure model and contact phase §4.5, casualties §4.6, two-sided battles
  §4.8 (remove the launch annihilation), stall/retreat §4.9, per-tick cap; remove the `max(1, ratio/20)` accelerator,
  the budget loop and free spearhead tiles. Neutral land at `NEUTRAL_ADVANCE_KMH`. Naval invasion embarkation, detection
  and landing §4.11 (with W4's ports/radar data).
* **Sieges** (`src/sim/enclaves.ts`): §4.12; delete `tryPocket`/`componentScan` annexation (keep ≤ 3-tile neutral
  cleanup).
* **Fronts** (`src/sim/fronts.ts`): stable keys, quiet fronts every 20 ticks, momentum, `advanceKmh`, `pa`/`pd`,
  casualties, division counts (from W4's `frontSupport`), offensive ids.
* **Game** (`src/sim/game.ts`): invariant checker of §4.17 behind a debug flag, capital loss rework, occupation from
  the capture stamp (income 25 %, cap 50 %), population recruitment factor (§6.7, `economy.ts`), nuclear detonations
  keep ownership with fallout effects (`weapons.ts` detonate, radii from `NUKE_DEFS`).
* **AI** (`src/sim/ai/war.ts`, `military.ts`, `index.ts thinkNukes`, `naval.ts`, `economy.ts`, `profiles.ts`): the war
  pipeline of §5.7 (candidates with opinion, goals, calls W3's `prepareWar`; until it lands, emit a `tension` event
  itself and declare 240 ticks later), limits and caps, grace values (§2.4) and `humanFocus` after 18,000, war plans for
  air and missiles, the escalation ladder and global caps (§5.10), silo-building rule, invasions only at war, peace
  evaluation hooks used by W3.
* **Events** (`src/sim/events/*`): pacing T26, rebellion causes and caps (§5.12), doomsday as a measure (§5.11).
* **Cleanup**: `src/sim/fallbackAi.ts` reduced to a logged no-op.
* **Tools**: `src/sim/test/pace-audit.mjs` declares war before attacking and gains modes `speeds` and `invariants` and a
  report of T1–T27; `harness.mjs` dynamics checks updated; staged shot tick values retuned (`territory`, `midgame`,
  `front*`, `sim-*`) so they still show a developed world.
* **Order**: (1) time block, clock, 0.5x, crisis, interpolation, HUD clock; (2) speeds and metric; (3) WarSystem,
  gating, events, protocol; (4) pressure model, casualties, defense, two-sided battles, sieges, fronts fields; (5) AI war
  pipeline, grace, caps; (6) weapons, escalation, doomsday; (7) economy, population, occupation, capitulation, events;
  (8) measurement and retuning within the §4.5 ranges until §3 holds.

**Acceptance.**
1. `pace-audit conquest --mult 2`: first tile ≥ 20 ticks after the offensive starts; capital ≥ 600; half ≥ 900; 90 % ≥
   1,300; largest loss in one tick ≤ 3 + 0.04 × frontier.
2. `conquest --mult 10`: half ≥ 600 ticks. `--mult 1`: defender keeps ≥ 70 % of its land after 3,000 ticks.
   `t_half(mult 4) / t_half(mult 2)` in [0.4, 0.85].
3. `survival` on Madrid, Paris, Berlin, Kansas, Brasília (seed 21): minimum survival Easy ≥ 9,600 ticks, Normal ≥ 6,600,
   Hard ≥ 4,200; median Normal ≥ 9,000; every human elimination is preceded by a `warDeclared` on the human ≥ 60 ticks
   earlier and a `tension` or `ultimatum` ≥ 240 ticks before the declaration (Normal).
4. `invariants` over a full Normal game: 0 ownership changes between players not at war (cessions, capitulations,
   rebellions and cleanup excepted); 0 AI offensives, strikes, missiles or invasions against players not at war; 0
   aggressor offensives before `mobilizeUntilTick`.
5. `game --difficulty normal --seed 11`: win between 36,000 and 72,000 ticks; ≥ 20 of 24 AI nations alive at tick 6,000;
   player-vs-player `attackStarted` ≤ 6 per 600 ticks on average and ≤ 12 in any 600-tick window; 100 % of
   `warDeclared` carry a reason key.
6. Same game: AI nuclear launches ≤ 8, 100 % at a nation at war with a recorded escalation ≥ 3 and a reason key, none
   before tick 18,000 unless retaliating, ≥ 480 ticks apart, ≤ 2 in flight; AI cruise missiles ≤ 3 per 600 ticks, 100 %
   at war; first world event ≥ 6,000 ticks and events ≥ 4,800 apart; no rebel state above 15 % of the world.
7. Same game: no nation with ≥ 5,000 tiles loses more than 20 % of its tiles in any 1,200-tick window unless ≥ 2 wars
   are active against it or it capitulates.
8. `pace-audit speeds`: km per game hour at 30–50° latitude within ±10 % of §2.3 for armor, transport, trade ship,
   warship, train, fighter, bomber, drone and cruise missile; ballistic `flightTicks = ceil(clamp(7 + 2.5·d/1000, 8,
   35) / 6)`.
9. Browser, 1x, debug atom bomb Madrid→Paris: `__front.ctx.sim.view.clock.mode === 'crisis'` during the flight, the
   flight lasts 10–20 real seconds, strategic again ≤ 4 real seconds after detonation, crisis chip visible.
10. Speed controls offer pause, 0.5x, 1x, 2x, 4x; at 0.5x the sim advances 5 ticks per real second (±15 %, unloaded) and
    units interpolate smoothly; the top bar shows «DÍA n · hh h» and the scale chip.
11. A nuclear detonation changes no tile owner (headless owner-array diff) and its fallout blocks income, growth and
    construction on those tiles for the §2.4 duration.
12. The raw `attack` command against a nation at peace is rejected with `msg.notAtWar`; after `declareWar` it works;
    opposing offensives on one front no longer annihilate troops at launch (troops conserved on the launch tick).
13. `npx tsc --noEmit`, `npm run build` and `npx tsx src/sim/test/harness.mjs` pass; the retuned `territory`,
    `midgame`, `front` and `sim-war` shots still stage a developed world (verifier inspection).

### 16.3 W2-map-readability

**Scope:** §10.1–10.8, §10.10–10.11, §10.13. Rows F2, F4, F5, F6, F10, D01–D08, F01.

**Brief.**
* **Globe shader** (`src/render/globe/earth.ts`, `territory.ts`, `glsl.ts`): fill mixing and altitude curve (§10.1),
  neutral desaturation, contested stripes from the heat texture, occupied stipple from the capture stamp, smooth borders
  by bilinear coverage and `fwidth` (§10.3), human border 2.4 px with inner glow, war-border core, attacker-coloured
  conquest flash, night floor (§10.4), small-island shoreline, close-zoom detail layer (§10.11), and one shared fill GLSL
  chunk used by the near patch (`globe/index.ts placePatch`) and the battle patch rim (`render/battle/index.ts`).
* **Palette** (`src/data/palette.ts`, `src/ui/menu.ts`): OKLCH range, neighbour hue spacing, 16 human presets, rebel
  colours (§10.2).
* **Clouds** (`layers.ts`, `globe/index.ts`): strategic mode sampling owner and heat textures with the altitude table,
  realistic mode with mipmaps/trilinear/anisotropy, shadow factor, the `clouds` setting (§10.5).
* **Labels** (`labels.ts`) and **post** (`src/render/post`): greedy collision, limb culling, HUD-safe rectangles via
  `ctx.ui.getOccludedRects()` (implement it in `src/ui`), glyphs, no chromatic aberration in the strategic view (§10.10).
* **Icons** (new `src/render/units/icons.ts`; LOD thresholds in `render/units/index.ts`; picking in `app/input.ts` and
  `pickUnit`/`pickStructure`): code-drawn atlas, frames by relation, glyphs of §6.5, pips, integrity bar, selection ring,
  clustering, above clouds (§10.7). W4 owns the models, rings and grounding in the same renderer; agree on the LOD
  hand-off.
* **Islands** (new `src/render/globe/islands.ts`): components ≤ 20 tiles, markers, archipelago clustering, hover and
  click targets (§10.6); `src/sim/ai/naval.ts` adds reachable neutral islands to AI targets.
* **Routes** (`render/fx/trails.ts` new `route` style; `render/units/index.ts emitTrails`): full owner-coloured path from
  `originX/Y`, dashed planned path from `view.routes` (W4), trade, warship, aircraft and division lines, fades (§10.8).
* **Historical borders** overlay from the Natural Earth country raster and its setting.
* **Spawn view** (§10.13) together with W3's onboarding.
* **Shots** (new): `readability-europe`, `readability-night`, `clouds-strategic`, `islands-caribbean`, `islands-aegean`,
  `icons-europe` (1,500 and 6,000 km), `labels-world`, `routes-atlantic`, `borders-close`, `zoom-40`, `zoom-8`; plus a
  global shot parameter `&territory=0` that hides the overlay for ΔE measurements, and debug hooks `__labels.placed()`,
  `__islands.visible()`, `__units.stats()`.
* **Order**: (1) fill, palette, night; (2) clouds; (3) borders and flash; (4) labels and CA; (5) icons and picking; (6)
  islands; (7) route trails; (8) close zoom and seam; (9) shots and measurements.

**Acceptance.**
1. `readability-europe` (3,000 km, day): mean CIELAB ΔE between the shot and the same view with `&territory=0`, over
   owned land, ≥ 15 for every nation in view including the human's colour; ≥ 5 over neutral land.
2. `readability-night`: ΔE ≥ 10 over owned land on the night side; every border in view has contrast ≥ 3:1 against both
   neighbouring fills.
3. `clouds-strategic` at ≥ 2,500 km (default setting): over the human's land ΔE ≤ 3 against the same view with clouds
   hidden; over other land the cloud factor is ≤ 0.2 (uniform readback or pixel comparison).
4. `labels-world` (20,000 km): `__labels.placed()` rectangles do not overlap pairwise, none lies in the limb band, none
   intersects `ui.getOccludedRects()`; strategic post has chromatic aberration 0.
5. At ≥ 1,500 km `__units.stats()` reports 0 unit model instances drawn and one icon (or cluster membership) per live
   unit and structure in view; below 600 km unit models are drawn; icons draw above clouds; same-owner icons within
   26 px are clustered with a count.
6. Clicking an icon at 6,000 km selects that unit in 20 of 20 scripted trials.
7. `islands-caribbean` and `islands-aegean` (2,500–3,000 km): `__islands.visible()` equals the number of land components
   ≤ 20 tiles in view and each marker is ≥ 8 px; hovering shows the owner; in the full Normal headless game ≥ 80 % of
   components with ≥ 5 tiles are owned by tick 18,000.
8. `routes-atlantic`: a transport Lisbon→New York draws a continuous owner-coloured line from its departure point to the
   ship for the whole trip, kept ≥ 15 real s after arrival and gone within 5 s after that; the planned path ahead is
   dashed.
9. `borders-close` at 1,500 km and 300 km: no 25 km right-angle steps, constant line width (1.4 px, human 2.4 px),
   conquest flashes soft and attacker-coloured (verifier inspection).
10. `zoom-40` and `zoom-8` outside battles: owned land ΔE ≥ 8 against `&territory=0`, borders visible, no rectangular
    seam or flat blue plane between the near patch and the globe.
11. `spawn` shot: camera in daylight over Europe/Africa, AI nations labelled, minimap shows owners.
12. Palette check (node script over `pickDistinctColors` for 64 nations): every colour has OKLCH L in [0.60, 0.82] and
    C ≥ 0.10, and nations sharing a border differ by ≥ 30° of hue.
13. Icon layer ≤ 2 draw calls, island markers ≤ 1, cloud shader ≤ 2 extra texture samples; tsc and build clean.

### 16.4 W3-diplomacy-alerts-ux

**Scope:** §5.1–5.6, §5.7 steps 3–4 (content), §8, §12, §13, §14.9 places. Rows F12, F14, F16, F17, A07, B01, B02, B03,
H01, H02, I01, I03, J01.

**Brief.**
* **Diplomacy sim** (`src/sim/diplomacy.ts` → `DiplomacySystem`, API of §14.10): opinions with reasons (§5.1, stored in
  `aiMemory`, published as `opinions`), treaties (§5.2: NAP 7,200 ticks, open-ended alliances with 480-tick notice,
  trade agreements via `economy.ts tradeGold` +20 %, open borders and `canTransit`), proposals with deliberation,
  reasons and counter-offers (§5.3), tension and ultimatums (§5.4), calls to arms (§5.5), betrayal and reputation
  (§5.6); map the v1 alliance commands onto proposals; events `proposal`, `tension`, `treatyChanged`; `TickUpdate`
  `treaties`, `opinions`, `proposals`; reason keys in `src/sim/strings.ts` and the UI dictionaries.
* **AI diplomacy** (`src/sim/ai/diplomacy.ts`): evaluation returning the top reasons, counter-offers, `prepareWar(brain,
  target, goal)` for W1's pipeline (tension, optional ultimatum, then `war.declare`), peace decisions from W1's war
  score and exhaustion, answers to calls to arms; no emotes.
* **Places** (new `src/data/places.ts`, `src/ui/places.ts describePlace`, §8.4, §14.9).
* **UI**: new `src/ui/hud/nations.ts` (`N` drawer: list with opinion band, personality line, treaties, wars; detail with
  reasons and actions; the inbox with countdowns); `radial.ts` without emotes or «Marcar objetivo», with *Declarar la
  guerra*, *Proponer…*, *Proponer paz*, *Pedir ayuda*, *Embargo*, *Donar*, *Información*; the declaration dialog (§4.2)
  and the peace-terms dialog with the cession band drawn on the map (`ui/modal.ts`).
* **Alerts** (new `src/ui/hud/alerts.ts`): the model of §8.1 and bus `alert` API (land it first), the feed replacing
  `feed.ts` toasts, grouping, the Registro log, globe DOM markers with edge arrows, minimap pings, front marks and
  convoys (`minimap.ts`), `news.ts` rewired to §8.2, auto-pause (§8.5) with its banner, the crisis banner.
* **Settings** dialog tab *Juego* (auto-pause toggles, `crisisTime`, cloud mode and historical borders from W2).
* **Explanations**: `src/ui/tooltip.ts` and tooltips on every control, top-bar breakdowns (§12.1–12.2), Help rewrite
  and the Encyclopedia generated from `UNIT_DEFS` and `STRUCTURE_LEVELS` (§12.3–12.4), the state-driven tutorial
  (§12.5), spawn onboarding (§12.6: the sim's `stepSpawnPhase` waits for the human in single player, *Sugerir un
  lugar*, AI-land explanation; camera per §10.13 with W2).
* **Text** (§12.7): gendered variants, missing-param handling in `src/shared/i18n.ts`, `msg.allyTarget` fix, «IA»
  string, end-screen troops lost (I03).
* **Audio** (`src/audio/index.ts`, §13): new cues and moods; combat density caps shared with W6.
* **Playtest** (`tools/playtest.mjs`, J01): every screenshot inside `step()`, 240 s timeouts, a survivable flow, steps
  for war declaration, alliance proposal, alert click-to-fly, auto-pause and a peaceful command-mode entry.
* **Shots** (new): `diplomacy-panel`, `inbox`, `declare-war-dialog`, `peace-dialog`, `alert-attack`, `auto-pause`,
  `crisis-banner`, `help-encyclopedia`, `tutorial-spawn`.
* **Order**: (1) alert API and feed; (2) diplomacy sim model and protocol; (3) AI diplomacy and `prepareWar` with W1;
  (4) nations panel, inbox, radial, dialogs; (5) auto-pause, crisis banner, audio; (6) spawn onboarding; (7) tooltips,
  help, encyclopedia, tutorial; (8) text cleanup, end screen, playtest.

**Acceptance.**
1. Proposing an alliance to an AI shows «X está estudiando tu propuesta…» at once; the answer arrives 120–240 ticks later
   as a sentence with at least one reason (no raw key, no emote toast); a rejection with opinion between 0 and +35
   carries a NAP counter-offer.
2. AI proposals to the human stay in the inbox ≥ 720 ticks (peace 1,200), do not expire during 60 real seconds of pause,
   and expiry is labelled as expiry, never as a rejection.
3. A war declared on the human produces in the same frame a critical feed alert with reason and mobilization time, a
   minimap ping, a globe marker (edge arrow when off-screen), a ticker item, the `warHorn` cue, and, with the default
   settings, an auto-pause with its banner.
4. In the W1 survival runs' event logs, every AI war declaration on the human is preceded by a `tension` or ultimatum to
   the human ≥ 240 ticks earlier (Normal).
5. An offensive on the human creates one grouped alert per front with attacker, «cerca de <lugar>» (or bearing and
   distance from the capital) and troops; clicking it flies the camera to the front; the entry updates instead of
   stacking; `frontLoss` fires at 10, 25 and 50 %.
6. A naval invasion against the human raises `invasionDetected` with the landing place and an ETA within ±10 % of the
   actual landing tick.
7. Settings → *Juego* has the 8 auto-pause toggles with the §8.5 defaults, `crisisTime` and the cloud mode; each
   auto-pause kind, triggered by debug actions, pauses the game with a banner stating the reason.
8. The nations panel shows each AI's opinion of the human with reason lines and values; a gift, a trade agreement or a war
   declaration changes the listed reasons within one `opinions` update.
9. White peace, cession (band previewed on the map) and tribute can be proposed and are answered with a reason; an
   accepted peace emits `warEnded`, shows a 4,800-tick truce in the panel, and attacking during it opens the betrayal
   confirmation.
10. The radial has no emotes and no «Marcar objetivo»; a 20-minute playtest shows 0 emote toasts; *Pedir ayuda* sends a
    call to arms that allies answer with a reason.
11. Single-player spawn waits for the human (no random auto-spawn); clicking AI land shows the explanatory toast;
    *Sugerir un lugar* spawns on the free land nearest the camera centre.
12. A scripted hover over every build-bar slot, arsenal slot, top-bar item, radial item and panel button finds a tooltip
    with purpose and numbers (100 %); disabled controls state why; the gold and troops tooltips show per-hour
    breakdowns.
13. Help's encyclopedia lists every unit and structure with per-level stats generated from the shared tables; the
    tutorial starts in the spawn phase and advances only on the §12.5 conditions, never on a timer.
14. Over a full playtest, collected alert, toast and ticker texts in es and en contain 0 matches of
    `/\(a\)|\{[a-zA-Z]+\}/`; the end screen's troops lost equals the stats counter including losses at elimination.
15. `tools/playtest.mjs` completes all its steps on Easy in one run, including war declaration, alliance proposal, alert
    click-to-fly, auto-pause and a peaceful command-mode entry; `__fuAudio.stats()` shows `warHorn`, `klaxon`,
    `navalHorn`, `capitalSiren` and the chimes firing on their triggers.

### 16.5 W4-armies-orders

**Scope:** §6, §7, §10.7 (models and grounding), §14.1 `orders.ts`/`STRUCTURE_LEVELS`, §14.3 `unitOrder`, §14.5
`UF`/`routes`/`rail`/`production`. Rows F7, F9, F15, C03, C04, G01, G02, I02, I04a.

**Brief.**
* **Shared** (`src/shared/constants.ts`, new `src/shared/orders.ts`, `protocol.ts`): `STRUCTURE_LEVELS`,
  `upgradeCost`, `UNIT_DEFS.productionTicks/rangeKm/roleKey`; `RulesView`, `orderError`, `predictOffensive` (with W1's
  formulas), a `canTransit` shim until W3's lands; `unitOrder`, `unitReady`, `UF` 14→20, `routes`, `rail`,
  `production`. Land these first.
* **Sim units** (`src/sim/units.ts`): `unitOrder` dispatch; divisions (move over own/allied/open-border land, rail
  transfer at 100 km/h between connected stations, attach, attack-toward, hold, return, repairs); fighters (persistent
  CAP with rotation, intercept, escort, rebase); bombers (sorties within reach and escalation via W1's API); drones
  (persistent front support, strikes); warships (move, patrol, blockade, bombard, escort, return); the production queue
  with `unitReady`; ordinal serials; `frontSupport(attackId)` for W1; paths published as `routes`; the AI's v1 unit
  commands mapped onto `unitOrder`.
* **Structures** (`src/sim/economy.ts`, `weapons.ts`, `game.ts`): every effect of §6.2 read from `STRUCTURE_LEVELS`
  (SAM air and anti-ballistic ranges, salvo and hit chances; silo weapon unlocks and reload; capacities and repairs;
  defense-post radius and multipliers for W1's pressure model; port trade slots and embarkation; factory gold, trains
  and rail slots; radar coverage effects and detection feeding `invasionDetected` and air-raid alerts); upgrades at
  `upgradeCost` in 50 % of the build time; build rules shared through `orders.ts`.
* **UI**: new `src/ui/hud/forces.ts` (`U`, §7.5); `selection.ts` cards (§7.6, hosted aircraft, live prices);
  `controller.ts` (§7.1: right-click orders with a selection, radial otherwise; Shift+click, Shift+drag box, double-click
  type select, `I`); `cursor.ts` order chip from `orderError` with distance, ETA and route mode; `buildbar.ts` arsenal
  time and live price.
* **Rendering** (`src/render/units`): selection rings; effect rings and zones (§6.2, §6.3); division route and ETA
  lines; docked aircraft drawn at airbases and selectable; `models.ts` level geometry for every structure (§6.5);
  grounding (terrain normal, mean height, foundation skirt, real footprints, relief sampling shared from the globe);
  formations (4 tanks by integrity, 3 jets). W2 owns `icons.ts` and the LOD thresholds.
* **Tools and shots**: `pace-audit armor` mode; an order-parity script; debug hook `__units.grounding()`; shots
  `forces-panel`, `unit-card`, `structure-card-upgrade`, `orders-preview`, `structures-levels`, `pyr-city-40`,
  `pyr-air-40`, `cap-circle`, `blockade`.
* **Order**: (1) shared rules and protocol; (2) sim behaviours and production; (3) level effects and upgrades; (4)
  Fuerzas panel, selection, right-click orders and previews; (5) cards and tooltip data; (6) rings and route lines; (7)
  grounding and level models; (8) parity script and shots.

**Acceptance.**
1. The Fuerzas panel lists every own division, squadron (docked included), bomber, drone swarm, warship and convoy with
   name, state, place, ETA and integrity; the count equals the human's units in `view.units` minus missiles, trade ships
   and trains; clicking a row selects and flies to it.
2. A bought division appears under *En producción* with an 80-tick ETA and a `unitReady` alert naming the base when
   done; over 10 purchases the Arsenal price shown equals the gold charged.
3. Order parity: 50 random right-click orders across all unit types; for 100 % of them the client preview validity
   equals the sim's acceptance.
4. Docked bombers and drones are selectable from the airbase card and the panel, and a strike order on a target at war
   within reach flies, lowers the target's hp by the §6.3 amount, and returns.
5. Shift+drag selects all own units in the rectangle and one right-click orders all of them; the chip reports «n de m».
6. `pace-audit armor`: with one attached attacking division, the first 10 tiles along the axis fall in ≤ 0.75× the time
   and with ≤ 0.8× the attacker casualties per tile of the same run without it; a defending division in the sector
   raises the attacker's time per tile by ≥ 1.3×.
7. The unit card shows the role line, speed in km/h equal to §2.3 with its real-time equivalent, reach, current effect
   and integrity, and no «FUERZA» max-HP number; the structure card shows current and next-level effects in numbers,
   the upgrade cost (= `upgradeCost`) and time, and «Te faltan N de oro» when unaffordable.
8. Headless level checks: SAM L1/L2/L3 air ranges 8/10/12 tiles and salvo 1/2/3; silo L1 rejects the H-bomb, L2 accepts
   it, L3 unlocks the MIRV; airbase capacity 3/6/9; defense-post radius 3/4.5/6; radar coverage 20/28/36 and invasion
   detection at embarkation inside it.
9. `pyr-city-40`, `pyr-air-40` and `structures`: nothing floats or sinks (verifier), and `__units.grounding()` reports a
   maximum vertical error < 5 % of the footprint and an up-vector deviation from the terrain normal < 3° for every
   structure.
10. `structures-levels` shows distinct geometry for L1, L2 and L3 of every type (verifier) and level pips on icons and
    cards.
11. A division ordered between two rail-connected cities 600 km apart arrives in 6 h ± 10 % and is drawn on the rail
    line.
12. An enemy trade ship entering a blockading warship's 6-tile zone is captured (event, gold to the captor) and enemy
    convoys there are engaged; the zone is drawn when the warship is selected.
13. A fighter patrol persists until recalled (≥ 2,400 ticks headless) and intercepts ≥ 50 % of 20 enemy bomber sorties
    crossing its circle.
14. Selecting any unit or structure draws its effect ring or zone (SAM air and anti-ballistic, defense post, airbase
    scramble, CAP, blockade, repair); tsc and build clean.

### 16.6 W5-command-v2

**Scope:** §9, §14.3 (`controlledMove`, `commandCasualties`, `controlledDamage`), §14.6 (clock use), §14.9 (night-lights
sampler, worker heightfields). Rows F8, C01, C02, C05.

**Brief.**
* **Entry and exit** (`src/app/bootstrap.ts`, `src/shared/api.ts CommandEnterParams`): rewritten `commandParams` (real
  interpolated lat/lon and heading, context, formation size, `enemy = 0` legal, no "strongest nation" fallback); tactical
  clock on entry through `ctx.sim.setClock`; restore the speed on exit; climb above the unit's new position; strategic
  renderers resync.
* **Scene** (`src/command/index.ts`): drop `Mission`, `OP_A/OP_B`, objectives and waves (`mission.ts` removed or no
  longer imported); new `src/command/stream.ts` (chunk grid, LOD rings, floating origin, prefetch, skirts, per-chunk
  `getLocalHeightfield`, moved to the data worker if > 8 ms); new `src/command/civil.ts` (towns from City structures with
  place names, villages from `sampleNightLights`, deterministic roads, rail from `view.rail`, border lines with posts and
  gates); new `src/command/forces.ts` (pools per sim source, budgets, 1 soldier = 25 troops, real divisions, squadrons,
  ships, SAMs and posts at their real positions, §9.6).
* **AI and control** (`src/command/ai.ts`, `player/*.ts`, `input.ts`): wingmen formation; quick-reaction forces that
  block and escort unless at war; real enemy divisions follow their strategic orders; new keys `M` (tactical map and
  autopilot waypoint), `+`/`-` (travel compression with the contact rules of §9.3), `Tab` (next vehicle).
* **HUD** (`src/command/hud`): §9.11 (place, land status, INCURSIÓN, clock chip, strategic alert strip, formation pips,
  force-source hover); the objective counter removed; the tactical map overlay.
* **Incursions**: approach warning, confirmation dialog, fire-first confirmation that declares war (W1's API).
* **Sim side** (`src/sim/game.ts`, `units.ts`, `worker.ts` for the clock message owned by W1): apply `controlledMove`,
  `commandCasualties` and `controlledDamage` immediately between ticks; controlled units keep front support; emit
  `borderIncursion` on foreign tiles at peace; automatic return order on exit inside foreign land;
  `aiDirector.onIncursion` (protest, intercept or war after 30–90 game seconds, using W3's opinions and W1's `declare`;
  dispatch real divisions within 30 km and patrolling fighters within 150 km).
* **Text** (`src/command/strings.ts`): es/en for everything, compass through i18n.
* **Shots** (new): `command-peace` (tank near Zaragoza at peace), `command-border`, `command-front`, `command-travel`,
  `command-jet-cap`, `command-ship-coast`; update the existing command shots to the new entry.
* **Order**: (1) entry at the real position with `enemy = 0` and peaceful content; (2) remove mission scripting; (3)
  `controlledMove` sync and tactical clock; (4) streaming, travel mode, tactical map; (5) borders, incursions, AI
  response; (6) local forces, casualty sync, formation; (7) jet and ship contexts; (8) HUD, exit, debrief, shots.

**Acceptance.**
1. Taking control of a division at peace in own land builds the scene within 1 km of the unit's sim position with its
   heading; `__cmdStats.hostiles === 0`; own towns and bases within view distance appear at their real positions with
   their names.
2. No objective counter, operation name, reinforcement wave or scripted air strike appears in any context; every command
   HUD string exists in es and en.
3. Driving 20 km and exiting moves the strategic unit: its `view.units` position differs from the entry by 20 km ± 2 km
   in the driven direction, and `view.units` shows it moving during the drive (≥ 1 update per real second).
4. In command mode with contact `view.clock.mode === 'tactical'`; over 5 real minutes the sim advances ≤ 1 tick and no
   front elsewhere moves more than 1 tile; on exit the previous strategic speed is restored.
5. Travel mode in own land without contact: an autopilot waypoint 300 km away is reached in ≤ 40 real s at ×900 while
   the sim advances 75 ticks ± 15 %; compression drops to ×1 on contact, when fired upon and 2 km before a peaceful
   border.
6. Driving or autopiloting 50 km straight shows no holes or cracks (verifier on `command-travel` frames) and
   `__cmdStats.chunkBuildMs` averages < 8 ms per chunk (or chunks come from the data worker).
7. Crossing into a nation at peace shows the confirmation; after confirming, `borderIncursion` is emitted, the victim's AI
   answers within 30–90 game seconds (protest, intercept or war), and the human gets an `incursionResponse` alert; with
   an alliance or open borders no incursion is raised.
8. `command-front`: the logged local infantry pool equals `min(40, front garrison share / 25)` ± 10 %, and every real
   enemy division within 30 km appears as 1 tank per 25 % integrity at its real position.
9. Killing N enemy soldiers lowers that nation's troops by N × 25 (± 5 %) within 2 real seconds; destroying one tank of
   a real division lowers its integrity by 25 %; destroying a SAM launcher lowers the real SAM site's hp by 0.35.
10. Losing your tank lowers your division's integrity by 25 % in the sim and continues in the next tank (`Tab` or 3 s);
    losing the last one destroys the division in the sim and ends command mode with the debrief.
11. A fighter squadron on patrol starts at its real position and altitude; enemy aircraft appear only when real enemy
    squadrons cover the place or scramble from an airbase at war within 150 km; foreign airspace at peace triggers the
    incursion flow.
12. A warship at sea at peace shows a calm sea and the real coast when near; water adjacent to a foreign coast at peace
    triggers the incursion flow; open sea never does.
13. `Esc` shows the debrief with the synced numbers and climbs to 2,500 km above the unit's new position; the strategic
    view resyncs without artifacts (verifier); tsc and build clean.

### 16.7 W6-battle-clarity

**Scope:** §11, §10.12. Rows F11, E01, E03.

**Brief.**
* **Orbit overlay** (new `src/render/battle/overlay.ts`, ≤ 4 draw calls, above clouds, hidden in command mode): front
  bands split by colour with chevrons driven by `momentum` and `advanceKmh`, dashed quiet fronts, operational arrows per
  offensive (width by `log10` of the troops), naval invasion arrows, mobilization arrows until `mobilizeUntilTick`, front
  badges (ISO3 chips, tug-of-war bar `Pa / (Pa + Pd)`, advance text, division chips, hover details, click emits
  `frontSelected`).
* **Guerra y frentes panel** (new `src/ui/hud/fronts.ts`, `G`): wars (goal, reason, day, escalation, war score,
  exhaustion; *Proponer paz* and *Pedir ayuda* open W3's dialogs) and fronts (troops, momentum, km/h, tiles, divisions,
  time; *Ir*, *Prioridad* → `setFrontPriority`, *Enviar divisiones* → W4's Fuerzas filtered with ETAs, *Contraofensiva*,
  *Retirar*); *Mundo* tab; danger sort.
* **Far layer** (`src/render/battle/far.ts`): flashes and fires inside the band only, density by intensity, smoke caps
  (§11.4).
* **Ground battle** (`src/render/battle/index.ts`): anchor by stable key; line from the real polyline, interpolated and
  moving; infantry split by `Pa / (Pa + Pd)` clamped 0.2–0.8; real attached divisions within 50 km as tanks by
  integrity; real squadrons, drones and bombarding warships; `frame.visualDt` clock; nation banners and the top HUD strip
  (§11.7); patch rim through W2's shared fill chunk.
* **Launch plume** (`src/render/fx/index.ts launchPlume`): world-sized plume with a per-frame minimum-pixel clamp, ≤ 8 %
  of the screen height (§10.12).
* **Audio density** for combat cues per front (with W3 in `src/audio/index.ts`).
* **Inputs**: W1's extended `FrontRecord` (defaults until it lands) and W4's unit fields (`frontKey`, integrity).
* **Shots** (new): `front-orbit` (2,500 km over an active offensive), `front-600`, `fronts-panel`, `front-ground-real`,
  `front-mobilization`, `plume-zoom` (launch, then 700 km and 200 km).
* **Order**: (1) read the extended fronts and build the orbit overlay; (2) the Guerra panel; (3) far layer; (4) plume;
  (5) ground battle from real data and the visual clock; (6) banners, HUD strip, audio density; (7) shots and
  measurements.

**Acceptance.**
1. `front-orbit` at 2,500 km: the band shows both nation colours, chevrons point in the advance direction, an
   operational arrow runs from the attacker to the axis point, and the badge shows both ISO3 codes, the tug-of-war bar
   and the km/h; a reviewer names attacker, defender, direction and who is winning from the screenshot alone.
2. Chevrons and the badge bar follow `FrontView.momentum`: giving the defender enough troops (debug) to turn the battle
   reverses the chevrons within 20 ticks.
3. Quiet fronts draw as dashed two-colour lines; mobilization arrows appear on the aggressor's side during its
   mobilization window and disappear at `mobilizeUntilTick`.
4. The Guerra panel lists every war and every front involving the human with troops, momentum, km/h, tiles, divisions and
   time; *Ir* flies there; *Prioridad alta* raises that front's defensive share in the sim (`Gf` increases); *Retirar*
   ends an own offensive with a 10 % loss.
5. Front keys are stable: over a 600-tick offensive the badge and the panel entry keep the same key in ≥ 95 % of samples.
6. `front-600`: smoke and haze cover ≤ 25 % of the screen (pixel whiteness measurement) and flashes appear only within
   1.5 tiles of the front line.
7. `plume-zoom`: after a launch from Madrid, the plume never covers more than 8 % of the screen height at 700 km or
   200 km, and its world size stays ≤ 20 km.
8. `front-ground-real`: logged infantry split per side within ±10 % of `Pa / (Pa + Pd)` (clamped 0.2–0.8); every real
   attached division within 50 km appears as 1 tank per 25 % integrity at its real relative position; the local line lies
   within 2 km of the real polyline.
9. Battle effects per real second are the same at 0.5x and 4x (±15 %) and freeze on pause.
10. Nation banners float above each side's line and the HUD strip shows front name, sides, troops, advance speed and days
    of combat in es and en.
11. `__fuAudio.stats()` over 60 s near a busy front: ≤ 2 combat cues per real second per front and ≤ 6 in total.
12. The overlay uses ≤ 4 draw calls and allocates nothing per frame; tsc and build clean.
