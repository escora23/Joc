# FRONT ULTRA: code map for v2

Written by the code-cartographer agent from commit `c2ea199` (branch `wip/build`, 2026-09-25). Line numbers refer to
that commit. After edits, search for the quoted symbol instead. Use this file to find your way around, then read
the code itself.

* `docs/FEEDBACK-1.md` sets the requirements. Its items are cited here as **F1…F17**.
* `docs/DESIGN_V2.md`, once it exists, decides **what** v2 does. This file says **where** each thing lives today,
  **how** it works, **which numbers** drive it, and **what has to change for v2, with the risks**.
* Notation: `path:Lstart-Lend`. "Now" = current behaviour. "v2" = what FEEDBACK-1 requires in that area plus a suggested
  approach. "Risks" = what else breaks or needs retuning when you change it.

---

## 0. Measured facts: why the owner says "todo pasa muy rápido"

These numbers come from a headless run of the real sim. The run used `tsx`, `Game` from `src/sim/game.ts` and the cached
WorldInit from `src/sim/test/world.mjs`. Setup: seed 1337, 24 AI nations + 40 tribes, normal difficulty, human on
autopilot at Madrid, 9000 ticks (15 game minutes at 1x). Other numbers are computed from the constants. To reproduce,
see §23.

| Fact | Value |
|---|---|
| Largest conquest by **one attack in one tick** (0.1 s at 1x) | **2,664 tiles**: tick 4352, player 5 attacking Nicaragua, 214k troops, frontier 3,332 tiles |
| Largest land loss of a major nation in **1 s** at 1x | **25,062 tiles**: Nicaragua went from 27.5k to 2.5k tiles. In 5 s: 30,206 tiles |
| Human (autopilot) territory | 5,936 tiles at minute 5, **270 at minute 6** |
| Player-vs-player `attackStarted` in 15 min | 548, of which 29 were on the human |
| Transport ship Lisbon → New York (5,400 km) | **18 s** at 1x (1.2 tiles/tick = 300 km per real second) |
| Armored division | 88 km per real second. The HUD shows "315 km/h" (`ui/hud/selection.ts:L271` multiplies by 900) |
| Army regrowth from 10 % to 90 % of the troop cap | 33 s (60 tiles) to 79 s (30k tiles, 8 city levels) at 1x |
| First unprovoked nuke (normal) | tick 8,449 (~14 min). 4 launches by minute 15 |
| Land components (islands) | 557 total. **226 are a single tile**, 151 have 2–4 tiles, 101 have 5–20 |
| Full day/night cycle | 720 game-s = 12 real minutes at 1x |

Visual evidence (gitignored `shots/codemap/`, recipe in §23):
* `pyr-city-40.png` and `pyr-air-40.png`: a city and an airbase in the Pyrenees floating above the exaggerated relief (F15).
* `val-1500km.png`: the Iberian border and fill disappear under the Atlantic cloud band (F5), and 3D structure models
  clutter the view at 1,500 km (F4).
* `pyr-600km.png` and `pyr-2500km.png`: context views.

---

## 1. The machine in one page

| Dir | Lines | v1 owner key | Role |
|---|---|---|---|
| `src/shared` | 2.6k | shared | Contracts: types, constants/BALANCE, protocol, simapi, events, api, geo, rng, i18n, settings, shots |
| `src/data` | 3.4k | data | World build (NASA masks + Natural Earth) in a worker; `sampleElevation`, `getLocalHeightfield`, `getWorldAux` |
| `src/sim` (core) | 7.9k | sim-core | Worker simulation: `game.ts`, `attacks.ts`, `units.ts`, `weapons.ts`, `economy.ts`, `diplomacy.ts`, `fronts.ts`, `enclaves.ts`, `labels.ts`, `water.ts`, `client.ts` (main thread) |
| `src/sim/ai` | 3.5k | sim-ai | AI nations (brains, war, economy, military, naval, diplomacy) |
| `src/sim/events` | 1.1k | sim-ai | World events + doomsday clock |
| `src/app` | 0.9k | app | `bootstrap.ts` (state machine, frame loop, command-mode entry), `input.ts`, `worldfx.ts` (world-event overlays), `shots.ts` |
| `src/render/globe`, `camera`, `post` | 3.8k | globe | Earth shader + territory overlay, clouds/atmosphere, labels, camera rig, HDR post |
| `src/render/units`, `fx` | 5.4k | units | Instanced unit/structure models, rails, overlays; particles, trails, nukes |
| `src/render/battle` | 6.6k | battle | Ground battlefield near fronts (<70 km) + far flashes (<600 km) |
| `src/command` | 10.7k | command | Command mode: local world, AI, mission, vehicles, HUD |
| `src/ui` | 7.9k | ui | DOM HUD, menus, i18n tables |
| `src/audio` | 3.8k | audio | Procedural Web Audio |
| `tools` | 0.8k | app/architect | `capture.mjs`, `playtest.mjs` (+3 stray dot-files, §24) |

**Boot and frame loop** (`src/app/bootstrap.ts`)
* Construction L198-L211: sim client → cameraRig → post → globe → units → fx → battle → command → audio → ui, then
  the input router and `worldFx`. `systems` L211. Debug hook `window.__front = {ctx, app}` L212.
* Loading L422-L489: `Promise.all(loadWorldData, globe.init, other inits)` → `warmup(true)` → `compileAsync(scene)` →
  `compileAsync(command.scene)` → `warmup(false)` → `loading.complete` → menu → `runShotFromUrl`.
* `loop()` L366-L416: `sim.pump(now)` → `frame.simAlpha/simTime/simDt/worldTime` → `input.update()` → if state is
  `command`: command, audio, ui, post, `post.render(command.scene)`. Otherwise: cameraRig, globe, units, fx, battle,
  worldFx, audio, ui, post, `post.render(scene)`. The strategic renderers are **not updated** in command mode.
* `setState` L215-L228: the input router is enabled only in `spawn` and `playing`. Also sets the audio mood.

**Sim tick** (`src/sim/game.ts` `tick1()` L877-L922)
1. `nav.beginTick`
2. `flushHumanCommands`
3. `ai.tick`
4. `worldEvents.tick`, only if playing and `config.worldEvents`
5. In the spawn phase: `stepSpawnPhase` and return
6. `attacks.step`
7. `enclaves.step`
8. `unitSys.step`
9. `weapons.step`
10. `economy.step`
11. `diplomacy.step`
12. `labels.stage` on ticks where `tick % 10 < 3`
13. `fronts.update` every 5 ticks
14. `checkEliminations`
15. `checkWin`

---

## 2. Sim ↔ render protocol and determinism

### 2.1 Transport today
* **Worker** `src/sim/worker.ts`
  * `loop()` L57-L74 runs on `setInterval(UPDATE_INTERVAL_MS = 100)`. It runs one tick in the spawn phase,
    `speed` ticks while playing, and 0 while paused. When it runs 0 ticks it still applies queued human commands
    (you can plan on a frozen world) and posts an update every 5th interval, or immediately if an event was produced.
  * `held` L25: scripted sessions (autoSpawn + instantStart) freeze the clock until the client sends `speed` or
    `fastForward`. This makes shot staging deterministic.
  * `onmessage` L76-L141:
    * `init`
    * `command`: `game.queueHuman`, applied at the start of the next tick
    * `debug`: `applyDebug`, applied immediately
    * `speed`
    * `fastForward`: runs synchronously, posts 50-tick chunks with events filtered to `FF_EVENT_TYPES` (game.ts
      L49-52), then a full resync
    * `stop`
* **Packing**, `Game.buildUpdate` (game.ts L1048-L1136). Every update contains:
  * The owner delta (`packTileOwner`). When the delta exceeds `TILE_COUNT/8`, `fullOwners` is sent instead.
  * All players as Float64 rows (`PF`).
  * **All live units** as Float32 rows (`UF`), plus dying units once with state `Destroyed`.
  * `attacks` on every update with ticks > 0.

  Sent only when changed: `playerMeta`, `playerStats` (every 10 ticks), `structures` (full list), `fronts`,
  `scars` (also every 20 ticks), `worldEvents`, `alliances` + `allianceRequests`, `doomsday`, `spawnDeadlineTick`,
  `winner`. Every update carries its `events`.
* **Client** `src/sim/client.ts`
  * `worker.onmessage` only queues. `pump(now)` L403-L433 applies the queue at frame start through `apply()` L195-L327:
    1. The owner array, then `tilesChanged` (full or packed).
    2. Players.
    3. Units. `UnitView` objects are stable. `prev*` comes from the previous update, with a wrap fix at L272-L274.
    4. Lists.
    5. History every 50 ticks and a 400×200 RLE timelapse frame every 100 ticks.
    6. Each `SimEvent` re-emitted on the bus (`emitSim` L346-L355). `enrichMessage` L330-L344 fills
       `{playerName}/{structureName}/{weaponName}` from `params.player/structure/weapon` only.
    7. `nukeAlarm` for nukes aimed at the human.
    8. `simTick`.
  * Interpolation: `view.alpha = (now − lastUpdateAt)/100 ms` (L430), forced to 1 while paused or not playing. At 4x
    a unit jumps 4 ticks between two updates, and renderers lerp `prevX → x`.
  * `pendingSpeed` guard L190-L201: in-flight updates still carry the old speed and must not undo the new one.
* Shared definitions (`src/shared/protocol.ts`): `PlayerCommand` L24-L69, `SimEvent` L81-L116, `PF` L141-L159,
  `UF` L162-L178, `PlayerMeta` L181, `FrontRecord` L192, `TickUpdate` L208-L240, `SimDebugAction` L250-L262,
  `ToWorker`/`FromWorker` L264-L278. Views are in `src/shared/types.ts` (`UnitView` L300, `AttackView` L342,
  `FrontView` L352). Bus events: `src/shared/events.ts` `AppEvents` L101-L161.

### 2.2 What the client does NOT get today (v2 will need some of it)
* **Unit paths.** `Unit.path/pathI` (state.ts L152-L154) are never sent. The client only has `originX/Y` (spawn or
  launch point) and `targetX/Y`. Needed to show planned routes (F2) and order previews along real routes.
* **Attack location.** `AttackView` = {id, attacker, defender, troops, naval, startTick}, with no click point and no
  front position. Location exists only in `FrontView`, which is computed every 5 ticks, only for attacks on players,
  at most 3 clusters per attack. Needed for F12 (where am I being attacked).
* **The rail graph.** `Structure.rail` is never sent. The renderer re-derives the links on its own
  (`render/units/rails.ts buildRailLinks` L238-L275, a copy of `sim/economy.ts rebuildRail` L300-L331), so the two
  can disagree.
* **AI intentions and reasons.** The AI only "speaks" through emotes, alliance replies and `targetPlayer` messages
  (F14).
* **Unit behaviour mode.** The `Mode` enum (state.ts L119-L136) is not sent, only `UnitState`. Also missing: fuel,
  home base, capacity use.
* **Hosted aircraft.** Docked aircraft are sent as units, but nothing tells the UI which base hosts them (§11).

### 2.3 Determinism constraints (keep them)
* **Randomness.** Use only `game.rng` and its forks: `'sim-combat'`, `'sim-units'`, `'sim-economy'` (game.ts L142-L144),
  `'ai'` (ai/index.ts L34), `'world-events'` (events/index.ts L42), `'fallback-ai'`.
* **Fork order.** `Rng.fork` (shared/rng.ts L125-L128) seeds the child from the parent's *current* state (`a ^ d`).
  Create forks before the parent is consumed, and append new forks after the existing ones. Otherwise every existing
  stream changes and every staged shot changes with it.
* **No wall-clock in the sim.** No `Math.random` or `Date` in `src/sim` (verified). `worker.ts` uses
  `performance.now()` only for `tickMs`.
* **Iteration order.** Map/Set order is insertion order. It is deterministic, but it depends on history (e.g. `p.border`
  iteration in attacks, fronts and enclaves).
* **Human commands.** They land on the next tick after they arrive, so a live game is not replayable. Shots get
  determinism from `held` plus `SimDebugAction`s, and **every shot stager depends on the debug actions**
  (`conquer`, `spawnStructure`, `spawnUnit`, `launchNuke`, `worldEvent`, `addGold`, `addTroops`, `endGame`).
* **Worker-safe modules** (`shared/constants|types|protocol|simapi|geo|rng|terrain|math|color`) must not import three.js
  or touch the DOM.
* **One command path.** The AI must act only through `game.issue(pid, cmd)`, the same validation as the human.
  World events use the privileged mutations.
* **Budget.** ≤ 25 ms per tick at 1x with 64 AIs, and 4x must keep up. For reference, the 15-minute measurement above ran in 25 s
  of Node time.

### 2.4 Protocol additions v2 will probably need (additive; bump both ends)
* A `routes` field (unit id → waypoint tiles), sent once per new path. Needed for F2 route display and planned paths.
* Per-attack or per-front location plus progress: add `x, y` (click point or front centroid), `tilesTaken` and
  `tilesLost` to `AttackView`. Give fronts stable ids. Needed for F11 and F12.
* A diplomacy message event, e.g. `{type:'diplomacy', from, to, kind, reason, params, expiresTick}`, and a
  war/peace state per pair. Needed for F14.
* Command mode: a `controlledMove {unitId, x, y, heading}` command so the driven unit really moves in the sim, and a
  `borderViolation` / `intrusion` event when it crosses into another nation (F8).
* Hosted-unit info on structures (aircraft per airbase), or render docked aircraft as selectable (F7).

---

## 3. Time scale and unit speeds (F1)

**Now**
* `src/shared/constants.ts` L28-L39: `TICK_MS = 100`, `TICKS_PER_SECOND = 10`, `UPDATE_INTERVAL_MS = 100`,
  `DAY_LENGTH_SEC = 720` (12 real minutes per day at 1x), `DEFAULT_START_WORLD_TIME`.
* Speeds `GameSpeed = 0|1|2|4` (types.ts L110). Setup offers 1/2/4 (`ui/menu.ts` L173-L178). Hotkeys `+`/`-` step through
  `SPEEDS [1,2,4]` (`ui/hud/controller.ts` L35, L230-L245). `app.setSpeed/togglePause` are at bootstrap.ts L162-L171.
* Unit speeds are in tiles per tick at 1x (`UNIT_DEFS`, constants.ts L140-L156). 1 tile ≈ 25 km at the equator
  (`TILE_KM`), so 1 tile/tick = 250 km per real second.

  | Unit | Speed (tiles/tick) |
  |---|---|
  | transport | 1.2 |
  | trade | 1.0 |
  | warship | 0.9 |
  | armor | 0.35 |
  | fighter | 1.1 |
  | bomber | 0.7 |
  | drone | 0.65 |
  | cruise missile | 1.6 |
  | atom bomb | 1.3 |
  | H-bomb | 1.2 |
  | MIRV | 1.1 |
  | MIRV warhead | 1.5 |
  | SAM interceptor | 3.2 |
  | train | 1.5 |
  | shell | 5.0 |

  Nukes also have `minFlightTicks` (NUKE_DEFS L175-L181).
* Rates are expressed per tick all over the code:
  * troops and gold: `sim/balance.ts`
  * cooldowns: `balance.ts` L201-L236
  * AI decision clocks: `sim/ai/profiles.ts DIFFICULTY` L117-L142
  * AI phase constants: `war.ts` `LAND_RUSH_TICKS` L20, the opening grace at L127-L130, `humanGrace` in profiles
  * diplomacy timers: `BALANCE` L70-L74 and `balance.ts` L288-L297
  * world events: `events/index.ts` L30-L33, `earthquake.ts` 120/420, `goldrush.ts` 100/1800, `hurricane.ts` lifetime 1300-2000
  * fallout: `NUKE_DEFS.falloutTicks`
* **Three incompatible implicit time scales:**
  * The sun: 720 game-s per day, so 1 real second = 2 game minutes.
  * The HUD: km/h = `def.speed × 25 × 36` (selection.ts L271), so 1 real second ≈ 16.7 game minutes.
  * Troops, gold and conquest have no unit of time at all.
* **Render-side assumptions:**
  * Trail lifetimes are in **real** FX seconds (`fx/trails.ts TRAIL_STYLES` L42-L53). The FX clock is wall time and
    stops on pause (`units/common.ts refreshEnv`).
  * The battle clock advances by `frame.simDt` (`battle/index.ts` ~L679), so ground battles run 4× faster at 4x.
  * Command mode runs in real time.
  * The ticker clock shows `T+mm:ss` of sim time (`ui/hud/feed.ts` L96-L99).

**v2**
* Define **one** time scale (e.g. 1 real s at 1x = N game minutes). Derive everything from it: speeds from real km/h,
  the day length, cooldowns, AI clocks, alliance and event durations, and the HUD clock and speeds.
* Units must be slow enough to follow and to react to. §0 shows the order of magnitude: a transport that takes 18 s to
  cross the Atlantic is at least 10× too fast for "time to think".
* Consider a 0.5x speed and pause-on-event options.
* Prefer changing rates and speeds over `TICK_MS`. `UPDATE_INTERVAL_MS`, interpolation, history sampling
  (client.ts L25-L28) and every shot's `ticks:` staging assume 100 ms ticks.

**Risks**
* Slower movement changes AI timing: invasion reach grows with `g.tick/18` (naval.ts L28), and there are
  anti-stagnation boosts. It also changes the economy (trains and trade pay per trip) and the tests
  (`src/sim/test/harness.mjs` "dynamics" checks).
* Shots are staged with `fastForward(ticks)`, so a slower game shows emptier staged scenes. Shot tick counts need retuning.
* FX (trail lengths, wake life) assume fast movers.

---

## 4. Attack and conquest pipeline, rate limits (F3, F11, F12)

**Flow**
1. **UI** (`ui/hud/controller.ts` L141-L153 → `ui/hud/diplomacy.ts attackNation` L31-L61). A left click on foreign or
   neutral land sends `{type:'attack', target, ratio: hs.attackRatio, tile}` when `hs.borders(target)` is true. That
   check is an O(TILE_COUNT) scan cached for 800 ms (`hud/shared.ts` L176-L199). Otherwise it finds a shore with
   `nearestShoreOf` and sends a `boatAttack`. The default ratio is **0.3** (`hud/index.ts` L163), adjusted with Shift +
   wheel or `[` / `]`.
2. **Validation** (`sim/attacks.ts command` L51-L123):
   * checks the phase, that the target is not an ally, and `sharesBorder` (the contact matrix, game.ts L236-L254)
   * `troops = floor(p.troops × ratio)` leave the reserve
   * `onHostileAct` (L209-L218): hostility plus a 3000-tick automatic embargo
   * **opposing attacks annihilate each other** (L80-L97)
   * an existing attack on the same target is reinforced and its click point moved (L100-L110)
   * otherwise a new `Attack` is created (state.ts L213-L262) and seeded from `p.border` (`seedFromBorder` L242).
     This emits `attackStarted`.
3. **Per tick**, `step` L289-L306 → `stepAttack` L308-L476:
   * `ratio = D.troops / a.troops`.
   * `lossK = clamp(ratio, 0.6, 2) × (0.46·bigAtt·bigDef + 0.004·density) × traitor × tribe × defPower/atkPower`
   * `speedK = clamp(ratio, 0.82, 7.5) × max(1, ratio/20) / 8.4 × …` (L333-L345)
   * **Budget.** Each tick has `budget = 1`. Every tile costs `frac = speedK·tc.cost·costMul / B`, with
     `B = frontierSize + rng(5)`. So **tiles/tick ≈ B / (speedK·cost)**. A huge attack against plains
     (speedK = 0.0976, cost = 16) takes **~0.64 × the whole frontier every tick**. The only hard cap is
     `MAX_TILES_PER_ATTACK_TICK = 4000` (L28). For neutral land, `frac = clamp(2000·cost/troops, 18, 100)/(2B)`.
   * Extra tiles on top of that: `mopUp` (L509-L532) takes notches with 3+ attacker neighbours, and armor spearheads
     take `ARMOR_SPEARHEAD_TILES = 2` per division per tick (L373-L387).
   * Frontier priority (`addNeighbors` L251-L275): `tick + (rng(8)+10)·max(0.15, 1 − 0.5·mine + prio/2)` plus a click
     bias `min(1, d/90)·16`. The whole front advances at once, bulging slightly toward the click.
   * Losses (`takeTile` L486-L502). The attacker loses `tc.mag·lossK·lossMul` per tile. The defender loses
     `min(D.troops, density)` per tile.
   * **The defence is passive.** Defender troops never move to the threatened front. Only density (troops/tiles)
     matters, and the defender's only answer is a counter-attack that collides with the incoming one.
   * The attack ends when troops < the next tile's loss (`exhausted`: the rest die), when the heap is still empty
     after a reseed, or after 300 idle ticks.
4. **Encirclement** (`sim/enclaves.ts step` L26-L57). Every tick, pockets of up to 900 tiles fully surrounded by the
   attacker with no sea access are captured instantly (`tryPocket` L69-L118). Every 10 ticks one nation's components
   are scanned (`componentScan` L136-L190). A whole landlocked nation of up to 400 tiles surrounded by a 12×-larger
   enemy is annexed in one step. This also makes land flip "from one frame to the next".
5. **Capital loss** (game.ts `onCapitalLost` L666-L699): 25 % of gold is looted, 10 % of troops die, and the capital
   moves.
6. **Naval invasions** (`units.ts boatAttack` L129-L208):
   * `findLanding` searches up to 14 tiles for a coastal tile. Departure is the own coast in the same sea closest to
     the landing. `MAX_BOATS = 3`. Troops ≥ 50.
   * The transport's attack is created by `attacks.createNaval` and `attackStarted{naval}` is emitted **at launch**.
   * On arrival `attacks.land` L147-L189: storming the beach costs `60 + density`, then the normal frontier starts
     from the beach. `fronts.ts` only reports contact within 45 tiles of the landing.
7. **Output**: `attacks` every update, `fronts` every 5 ticks, `attackStarted` / `attackEnded`, `tilesChanged`.

**Constants** (`sim/balance.ts`)

| Constant | Line | Value |
|---|---|---|
| `terrainCombat` (plains / hills / mountains mag & cost, altitude > 3000 m and river multipliers) | L102-L127 | |
| `NEUTRAL_LOSS_DIV` | L130 | 5 |
| `NEUTRAL_COST_SCALE` | L131 | 2000 |
| `NEUTRAL_MIN_COST` / `NEUTRAL_MAX_COST` | L132-L133 | 18 / 100 |
| `ATTACK_LOSS_BASE` | L136 | 0.46 |
| `ATTACK_LOSS_PER_DENSITY` | L137 | 0.004 |
| `ATTACK_SPEED_DIV` | L138 | 8.4 |
| `largeTerritoryBonus` | L143 | |
| `DEFENSE_POST_LOSS_MUL` | L155 | 2.5 |
| `DEFENSE_POST_SPEED_MUL` | L156 | 2.2 |
| defense post radius | L157 | 12 / 16.5 / 21 tiles |
| `FALLOUT_*` | L162 | 3 / 2.5 |
| `ARMOR_RADIUS` | L166 | 9 |
| armor attack loss / cost multipliers | | 0.45 / 0.55 |
| armor defence multiplier | | 1.6 |
| `RETREAT_MALUS` | L177 | 0.25 |
| `AUTO_EMBARGO_TICKS` | L292 | 3000 |
| `HOSTILITY_TICKS` | L294 | 900 |
| `MAX_BOATS` | L295 | 3 |

**Measured**: see §0 (2,664 tiles in one tick; 25k tiles lost in 1 s).

**v2 (F3: bounded and animated; F11: slow and clear; F12: time to respond)**
* **Cap the advance in absolute terms.** Limit tiles per game-hour per unit of front length, independent of the force
  ratio. Remove the `max(1, ratio/20)` accelerator and the "frontier × 0.64 per tick" regime. The force ratio should
  decide **losses and who wins**, not "everything at once".
* **Add a contested / siege state per tile** before ownership flips (a progress value). Fronts then advance visibly and
  the overlay can draw contested land (F10).
* **Make defence active.** Garrisons should respond to the threatened sector (e.g. defender troops committed per front
  with a reaction delay), and armor or a "defend here" order should matter.
* **Encirclement** should become a timed siege with news and an alert, not instant annexation.
* **Every attack on the human** needs a location (the click point or the front centroid) in the protocol (§2.4).

**Risks**
* The AI war code (`ai/war.ts`) is tuned to the current speed: attack sizing, "feeding an attack that is already 1.6×
  the defender" (L154), the counter-attack thresholds (L57-L69) and the land-rush phase.
* The early game is a land race with neutral expansion at up to B/9 tiles per tick.
* `fronts.ts` intensity uses `conquestEma`, and the battle layer's `pushA/pushB` uses troop shares.
* `harness.mjs` dynamics checks.
* Shots staged with `fastForward` (territory shots expect big empires by tick 3000).

---

## 5. Troop growth and economy

**Now** (`sim/economy.ts step` L233-L295)
* **Troop cap**, `baseMaxTroops` (balance.ts L57-L63): `100k + 2000·tiles^0.6 + 250k per city level + 60k per army-base
  level`, times `kindCapMul` and modifiers. Fallout tiles count at 20 %.
* **Growth**, `troopGrowthPerTick` (L66-L71): `(10 + 0.25·troops^0.73)·(1 − troops/max)`. Troops above the cap bleed
  1 % per tick. Kind multipliers are at L21-L54. Fallout reduces growth.
* **Gold** per tick:
  * 100 base
  * 0.05 per tile
  * 25 per city level
  * 16 per factory level
  * times `kindGoldMul` and modifiers
  * `incomeEma` feeds the HUD
* **Trade**: `maybeTrade` L393-L415. Chance `1/380` per tick per port level, at most 3 ships per port level, partner
  ≥ 35 tiles away. `tradeGold` (balance.ts L230-L232) pays both sides. Warships of a hostile nation capture trade
  ships (units.ts `captureTrade` L706-L737).
* **Rail**:
  * `rebuildRail` L300-L331: stations are City, Port and Factory. `RAIL_MAX_LINK = 75` tiles (**1,875 km**), up to
    4 links, land-only line.
  * `dispatchTrain` L348-L388: every `130/level + rng(40)` ticks a factory sends a train to a random city or port up
    to 10 hops away.
  * `trainGold` (balance.ts L236-L239) pays on arrival; allies get 50 %.
* **Civilians / population** L263-L265: a cosmetic stat (top bar), also used as a nuke casualty count. No gameplay effect.
* **Construction** `built += 1/buildTicks`. Repairs start after 150 ticks without damage (0.0015/tick).

**Measured**: an army regrows from 10 % to 90 % of its cap in 33–79 s. This, together with conquest at thousands of
tiles per second, makes wars whiplash.

**v2**
* Tie growth to the new time scale.
* Give population a meaning (a recruitment pool, or morale), or drop it from the top bar.
* Explain every income source in the UI (tooltips on gold and troops with a breakdown).
* Make the rail network readable (the rails drawn today are a client-side reconstruction, §2.2).

**Risks**
* AI reserve logic (`ai/war.ts` L38-L44, `troopFill`).
* Structure prices (`STRUCTURE_DEFS`, constants.ts L102-L113; cost = base·(1 + step·owned)).
* Unit prices (`unitPrice`, balance.ts L249-L260).

---

## 6. Fronts: sim → globe heat → battle layer (F11)

**Sim fronts** (`sim/fronts.ts`, the whole file)
* Updated every 5 ticks (game.ts L915-L918), for attacks on players only. Neutral land is skipped, and so are boats
  still at sea.
* Contact tiles are the attacker's border tiles that touch the defender, strided so there are at most 6,000
  (`MAX_CONTACT`). They are clustered on a 6-tile grid (8-connected), and the 3 largest clusters are kept.
* Each cluster becomes a `FrontRecord` with:
  * `samples`: a polyline ordered by PCA, 1.5-tile bins, at most 64 points
  * a representative point
  * `dir`
  * `intensity` (L196-L204): from `conquestEma` / `lossEma` and recent conquests in the segment
  * `troopsA = a.troops·share`, and `troopsB`, an **estimate** of the defender (L213)
* `id = attack.id·4 + clusterIndex`. The id is **not stable**: clusters reorder.

**Globe heat and capture flash**
* `render/globe/territory.ts updateHeat` L257-L295 splats the samples into a 400×200 heat texture.
* `render/globe/earth.ts` L353-L363 draws fire along the border line where there is heat.
* A tile captured less than 60 ticks ago flashes (L364-L368, using the owner texture's stamp).

**Battle layer** (`render/battle/index.ts`)
* `update` L668-L785. Below `NEAR_BUILD_ALT = 70` km, `nearestFront` (L245-L281) picks the closest front within
  `30 + 1.2·alt` km and builds an `Anchor`.
* The generator `buildSteps` (L334-L428) streams in:
  * a terrain patch with the front ±6 km (`halfLen 6000`) and props
  * infantry: `battleInfantry·(0.55 + 0.45·activity)`, split by the troopsA/B share clamped to 0.3–0.7
  * vehicles, split by the same share, plus tank columns if either side has an ArmoredDivision within 350 km
    (`frontStats` L310-L332)
  * craters and fires
  * a 12 s prewarm
* `battleStep` (L443-L513) is a **procedural** war: small arms, mortars, off-map artillery and haze. Every 30 frames it
  re-reads `frontStats`, and the line visibly drifts (±400 m) toward the side losing troops.
* Fade: starts at 42 km, full at 24 km. The battle re-anchors after 3.2 km of sliding.
* `render/battle/far.ts`: between 16 and 600 km, artillery flashes, fires and smoke columns along every front in view.
* **The soldiers and tanks are decorative.** They are not the sim's units, their casualties don't count, and the battle
  vanishes when the attack ends.

**v2 (F11)**
* Fronts become first-class: stable ids, both sides' real committed troops, momentum, start time, casualties.
* The UI gets a battles list with click-to-focus. The globe gets a readable battle marker at every altitude (an icon
  plus a who-is-winning bar).
* The battle layer should show real units that are there (armor divisions, aircraft over the front) and a pace matching
  the new sim pace.

**Risks**
* Front ids flicker today.
* Fronts are only computed while an attack is running, so there is nothing for "at war but quiet" borders.
* `frontsFor` costs O(attacker border) every 5 ticks.
* The battle build is a multi-frame generator: keep it off the critical path.

---

## 7. AI: war, alliance and nuke decisions (F13, F14)

**Director** (`src/sim/ai/index.ts`)
* `createAiDirector` L33. `makeBrain` L50-L72 (brains are stored in `SimPlayer.aiMemory`).
* `think` L151-L189 runs independent jittered clocks per brain: war, build, naval, military, nukes (every
  `jitter(160)` ticks), diplomacy. Insane difficulty adds cheats (L146-L149).
* `onEvent` L194-L368 is the AI's senses:
  * `attackStarted` → grievance, trust, allies may take up `allyTarget`
  * `allianceRequested` → a queued reply
  * `allianceExpired` → renewal
  * `nukeLaunched` → retaliation, emergency SAM
  * emotes, donations, `msg.allyTarget`
  * world events (gold rush, rebellion)
  * doomsday
  * eliminations
* `tick` L384-L398 also plays the human when `config.humanAutopilot` is set (shots).
* Tables in `ai/profiles.ts`:

  | Table | Line | Content |
  |---|---|---|
  | `PERSONALITY` | L51-L77 | aggression, reserve, build weights, naval, nukes, nukeDelay, loyalty, diplomacy, opportunism, coalition, vengeance |
  | `DIFFICULTY` | L117-L142 | clocks (normal: war 28, build 100, military 190, naval 650, diplomacy 330 ticks), `reaction [30,90]`, `humanFocus`, `humanGrace` (easy 3600, normal 2400, hard 1500, insane 900 ticks), `nukeTick` (normal 8400), `nukeChance` |

**War** (`ai/war.ts thinkWar` L22-L164)
1. **Defence** L45-L71: counter-attack to annihilate the biggest incoming land assault, with
   `want = min(inc.top·1.08, troops·0.65)`, on hard+ and normal.
2. **Neutral land** L76-L93: a land rush for the first 900 ticks.
3. **Player war** L95-L163:
   * `scoreTarget` L187-L229: troop ratio and density, front length, grudges, traitors, coalition, `humanFocus`,
     opportunism, ally requests, gold rush
   * threshold with saturation and anti-stagnation
   * opening grace: the attacker needs 3.2× the target's troops before tick 1800 and 1.8× before tick 3600
   * `maxWars`
   * ratio clamped to 0.06–0.5
   * "no pinpricks" rule
* **There is no declaration of war and no warning.** The first sign is `attackStarted` (a toast for the human).

**Military** (`ai/military.ts thinkMilitary` L28-L178)
* Production: armor ≤ 2 per army-base level, then fighters, bombers and drones, then warships.
* Armor deploys to `front.aim` when above its reserve (offensive). On defence it holds the threatened front.
* Bombers and drones strike SAMs, silos and airbases first (scored by value and distance).
* Fighters fly CAP over the own front (AI only, §11).
* Warships sail to the enemy coast.
* **Cruise missiles** (L165-L177) are fired at enemy SAMs, silos and airbases in range with 50 % chance per military
  tick when gold ≥ 2.5× their cost.

**Nukes**
* `thinkNukes` L211-L273 has two paths:
  * **Retaliation**: `b.retaliate`, set when nuked or betrayed.
  * **Unprovoked**, after `nukeTick = diff.nukeTick × prof.nukeDelay × (1 − 0.45·doomsday) × (0.85 if any detonation)`
    (L207-L209):
    * pacing: 450·(1 − 0.6·doomsday) ticks between launches
    * will: `prof.nukes·(0.55 + 0.9·doomsday)·diff.nukeChance`
    * `pickNukeTarget` L276-L299: +3 for the enemy, **+2 `atWar`**, leader and coalition, grievance, +5 if they nuked
      us; threshold 3
* `atWar` (diplomacy.ts L21) is **any `attackStarted` between the pair in the last 1200 ticks**, so any border
  skirmish counts as war.
* `chooseNukeTarget` L302-L358 aims at cities, silos, the capital or behind the front. It avoids its own and allied land
  (`friendlyShare` ≤ 6 %) and applies a penalty under SAM umbrellas.
* Silos (`ai/economy.ts` L71-L79) are built after `nukeTick·nukeDelay·0.75·(1 − 0.5·doomsday)`. Every large nation
  (> 6000 tiles after tick 6600) builds them regardless of personality.
* Measured: first nuke at tick 8,449.

**Diplomacy** (`ai/diplomacy.ts`)
* `allianceOdds` L53-L84:
  * base `0.1 + 0.3·diplomacy + 0.35·trust`
  * −0.18 per betrayal, −0.3 if a traitor
  * strength: +0.2 for protectors
  * shared enemy +0.3
  * neighbouring rivals −0.25·aggression
  * at war: +0.1 if losing, else −0.45·aggression
  * runaway leader −(0.3 + 0.4·coalition)
  * too many allies −0.4 each
  * human bonus `(1 − humanFocus)·0.3`
  * grievance
* The reply (`resolveReply` L210-L219) comes after the difficulty's reaction delay (normal 3–9 s). For the human it
  comes with a `handshake` or `thumbsDown` **emote**. **No reason is given.**
* `thinkDiplomacy` L86-L204:
  * betrayal temptation L98-L125
  * seeking alliances L127-L150 (the human scores ×0.5)
  * embargoes and coalition, with `targetPlayer` against the leader, L152-L181
  * gold and troop help to allies L183-L196
  * taunt emotes
* `onEmote` L221-L252. `helpAlly` L254. `recordBetrayal` L274.

**Naval** (`ai/naval.ts thinkNaval` L12-L68): invasion reach `min(420, 90 + tick/18)`; empty coast first, then tribes,
then weak nations.

**Build** (`ai/economy.ts thinkBuild` L25-L117, `placeFor` L165-L223).

**v2 (F13, F14)**
* Wars need a state: declaration → mobilisation delay → war → ceasefire or peace. There should be an escalation ladder:
  conventional → cruise → nuclear, only when losing badly or when nuked or betrayed.
* Every aggressive act needs a reason key that the UI can show ("France attacks: border dispute + you are weak",
  "Russia launches in retaliation for …").
* Nukes should come from states of war and escalation, not a timer plus doomsday. Cruise missiles should come from war
  plans, not a 50 % dice roll per military tick.
* The AI must answer diplomacy with reasons and give the human time (see §8).

**Risks**
* The AI modules share `world.wars`, `relation.trust` and grievance semantics.
* The fallback AI (`sim/fallbackAi.ts`) is a second implementation that will not follow v2 rules (§24).
* The autopilot drives most shots and the playtest's human: its behaviour changes shots.

---

## 8. Diplomacy protocol (F14)

**Commands** (protocol.ts L46-L56): `allianceRequest`, `allianceReply`, `breakAlliance`, `embargo`, `donate`,
`emote`, `targetPlayer`.

**Sim** (`src/sim/diplomacy.ts`)
* `request` L37-L64:
  * the target must be a nation or the human, not a tribe
  * per-target cooldown `ALLIANCE_REQUEST_COOLDOWN = 300` ticks
  * auto-accepts if the target already asked us
  * the request expires after `allianceRequestTimeoutTicks = 200` (**20 s at 1x**), and expiry emits
    `allianceRejected`
* `reply` L66-L77.
* `form` L79-L96:
  * cancels the attacks between the two
  * clears hostility
  * the alliance lasts `allianceDurationTicks = 6000` (10 min), with an `msg.allianceExpiring` warning 300 ticks
    before the end
* `breakAlliance` L98-L108 marks the breaker as a traitor for 1800 ticks. `TRAITOR_LOSS_MUL 0.5` and
  `TRAITOR_SPEED_MUL 0.8` then apply when the traitor is the defender.
* `embargo` (permanent) L121-L133, and the automatic temporary embargo after being attacked (3000 ticks).
* `donate` L135-L157: 100-tick cooldown; troops can only go to allies.
* `emote` L159 (40-tick cooldown). `targetPlayer` L167-L178. `dropPlayer` L181. `step` L192-L226 (expiries).
* "War" today is implicit: `game.isHostile` (L558-L566) is true if the pair fought in the last 900 ticks, or one side
  embargoes or targets the other. There is no peace treaty, ceasefire or non-aggression pact, and no negotiation with
  terms.

**UI**
* Radial `nationItems` (`ui/hud/radial.ts` L113-L142): attack, alliance or break, embargo, donate (sub-ring: 25 or 50 %
  of gold or troops), emote (sub-ring of 16), mark target, info.
* Nation card (`ui/hud/selection.ts buildNation` L177-L200).
* Relation label (`ui/hud/diplomacy.ts nationRelation` L10-L22): `hostile` only while an attack between the pair is
  running.
* Incoming request toast with accept/decline and the sim's countdown (`ui/hud/feed.ts allianceRequest` L158-L184). Its
  timer follows the sim and freezes on pause (L201-L216).
* Outgoing requests show a "sent" toast. The answer arrives as `allianceFormed` or `allianceRejected` (a toast
  **without a reason**, `ui/hud/news.ts` L84-L86).

**v2 (F14)**
* A diplomacy panel or inbox per nation: relation state, history, pending proposals.
* Proposals: alliance, non-aggression, ceasefire, peace with terms. Replies come with reasons (i18n keys and params
  chosen by the AI).
* Deadlines long enough to think, and the game can pause while a decision is pending.
* AI demands and ultimatums before attacking.
* Emotes become flavour, not the channel.

**Risks**
* Alliance semantics are read in many places:
  * attacks: `cancelBetween`, ally checks
  * weapons: an ally can't be nuked; a nuke that hits more than 60 tiles of an ally breaks the alliance
    (weapons.ts L643)
  * units' targeting (`isHostile`)
  * economy: rail and trains across allies
  * territory palette: ally hatching
  * UI relation labels
  * the AI

---

## 9. Alerts, news, toasts, alarms (F12)

**Wiring** (`src/ui/hud/news.ts wireNews`, the whole file)
* Ticker (breaking news, clickable to focus when it has a location; `feed.ts createTicker` L32-L94):
  * `nationEliminated`
  * `capitalCaptured`
  * `allianceFormed` (others)
  * `allianceBroken`
  * `nukeLaunched` / `nukeDetonated`
  * `worldEvent`
  * `doomsday`
* Toasts (`feed.ts createToasts` L114-L228; at most 6; duplicates collapse; **a click dismisses**, it does not focus):
  * `message` (every sim `msg.*` for the human, L132-L137)
  * `allianceFormed` (human), `allianceRejected`, `allianceExpired`
  * `embargoChanged`, `donation`, emotes
  * `nukeIntercepted`
  * `commandResultApplied`
  * **`attackStarted` on the human** (L143-L150): `'toast.underAttack'` "¡{name} nos ataca con {n} tropas!", throttled
    to one every 25 s per attacker, **no location**
  * `boatLanded`
  * `structureCaptured`
* Nuke alarm banner with countdown, clickable to focus the target (`feed.ts createNukeAlarm` L248-L306), plus sirens
  (`audio/index.ts` L335-L341). `nukeAlarm` is raised by client.ts L351-L353.
* Minimap overlay (`ui/hud/minimap.ts drawOverlay` L161-L243): camera footprint, the human capital, missiles and nukes
  in flight, world events. **No attacks, fronts or enemy units.**
* Audio (`audio/index.ts` L272-L279): an attack on the human only raises the music's `attackHeat`. There is no specific
  alarm cue.

**v2 (F12)**
* An **"Under attack" panel** listing every attack or front on the human: attacker, troops on both sides, place,
  progress, time since start. Each entry focuses the camera.
* Pulsing markers on the globe and minimap at the attack location. Toasts that focus on click.
* An optional auto-pause (or slow-down) when a new nation attacks or a fleet is launched at you.
* A distinct alarm sound.
* Boats and aircraft heading for the human's land need an ETA. `boatLaunched` already has `toTile`.

**Risks**: toast spam (hundreds of attacks per game, §0). Group by attacker and front.

---

## 10. Units: what they really do in the sim (F9)

Everything is in `src/sim/units.ts` unless noted. `step` L599-L632 dispatches per type and skips `Controlled` units.

| Unit | Production / capacity | Behaviour today | Real effect |
|---|---|---|---|
| Transport | created by `boatAttack` L129-L208 | water path (`WaterNav.findPath`, hierarchical A*, 8 searches per tick budget); `stepTransport` L635-L671; `recallBoat` on retreat | carries the naval attack's troops; sunk → troops lost (`remove` L64-L77) |
| Trade ship | ports, `maybeTrade` | `stepTrade` L674-L703 | gold for both ports; hostile warships capture it |
| Warship | naval yard, 2 per level (`hasCapacity` L299-L305) | patrol ±28 tiles around its anchor; `acquireNavalTarget` L798-L823 (transports heading to us/allies always; warships or trade ships only if hostile) within 22 tiles; shells (range 16, cooldown 12, 240 dmg, 70–80 % hit, `weapons.fireShell` L444); shore bombardment every 25 ticks within 12 tiles if hostile (`shellCoast` L825-L848); heals near yards/ports | sinks invasions; kills `250 + 0.25 %` of the victim's troops per shore shell; damages structures 0.12 |
| Armored division | army base, 2 per level | `stepArmor` L851-L927: drives **only over own or allied land** (`advanceOverOwnLand` L930-L960), sliding along the border; at the front → `frontArmor`; every 40 ticks `armoredAssault` (attacks.ts L558-L570: starts an attack with ~10 % of the reserve, min 2000); tank duels within 2.5 tiles; overrun → 4 dmg/tick and retreat to the capital | attack loss ×0.45, cost ×0.55 within 9 tiles; +2 spearhead tiles/tick; defending armor ×1.6 attacker losses. **Real but invisible**: nothing on screen links it to the front's speed |
| Fighter squadron | airbase, 3 air units per level (shared) | docked → scramble vs threats within 45 tiles (×1.5 with radar) (`scramble` L1070-L1083); CAP (`moveUnit`, AI only) orbits and intercepts; strike = strafe; fuel 1200 ticks; range 170 tiles from base (`AIRCRAFT_STRIKE_RANGE` balance.ts L210) | intercepts bombers, drones, cruise missiles; dogfights |
| Bomber | airbase | `Mode.Strike` → `weapons.airStrikeImpact('bomb')` L500-L547 | structures within 2.6 tiles −0.55 hp (direct hit −1.1), units 340 dmg, troops `min(40k, 3 % + density·6)` |
| Drone swarm | airbase | suicide strike | troops `min(14k, 1.2 % + density·6)`, structures 0.38/0.6 |
| Cruise missile | silo, cooldown ×0.5 | `weapons.launch` L107-L142, `stepCruise` L199-L216; range 320 tiles | kills the structure at the aim point (1.2 dmg), 0.4 dmg within 3 tiles; troop loss `0.2·(1−e^(−5·hit/tiles))` |
| Nukes / MIRV | silo | ballistic great circle (`slerpTiles` L753), SAMs engage only in the terminal half (`TERMINAL_PHASE_T`), MIRV splits into 18 warheads at t = 0.62 (`splitMirv` L218-L274) | `detonate` L562-L693: tiles destroyed to neutral, fallout, troops and civilians killed, structures destroyed, scars |
| SAM interceptor | SAM site | `samEngage` L318-L353, `fireInterceptor` L355-L391 (hit rolled at launch) | interception |
| Train | factory | `stepTrain` L1132-L1177 along rail station ids | pays `trainGold` on arrival |
| Shell | warships | `stepShell` L469-L497 | damage |

**v2 (F7, F9)**
* Each unit needs a visible, explained purpose: a tooltip with numbers, and the effect shown on the map (e.g. an armor
  aura on the front, a warship's control zone, a fighter's CAP circle).
* Armor should be able to **advance into enemy land** and hold ground, instead of bouncing off the border.
* The human must be able to use every unit (see §11: docked aircraft can't be selected today).

---

## 11. Unit orders and selection UX (F7)

**Now**
* **Picking.** The input router (`app/input.ts` L27-L36, click = < 6 px and < 450 ms) calls `units.pickUnit` first
  (`render/units/index.ts` L1087-L1099): the nearest rendered unit within **18 px**, any owner, including missiles
  and trade ships. Then `pickStructure` (20 px), then the tile.
* **Selection.** `ui/hud/controller.ts` L126-L140. Selecting an own orderable unit **immediately enters `order`
  mode**. The next left click on the world (not on a unit or structure) sends:
  * `deployArmor` for armor
  * `moveUnit` for warships
  * `airStrike` for **every aircraft**, fighters included (L117-L119)

  Shift keeps the mode. Esc cancels. The mode banner is at `hud/index.ts` L105-L118.
* **Order preview.** `cursor.ts` ~L190-L214 → `orderPreview` → a dashed great-circle arc (units/index.ts L967-L979).
  Validity is client-side: aircraft are "valid" anywhere, but the sim rejects strikes on own or allied land with
  `msg.invalidTarget` (units.ts L380-L383).
* **Selection panel** (`ui/hud/selection.ts buildUnit` L73-L107): HP, strength, state, a bogus speed (L271), **TAKE
  CONTROL** for tank, jet or ship, an order button, and focus.
* **Hard blockers found in code:**
  1. **Docked aircraft can never be selected.** `updateUnits` skips docked air units and sets `hasPos = false`
     (units/index.ts L610-L614), and `pickUnit` ignores tracks without a position. Bombers and drones start docked
     (units.ts L285-L287) and never leave on their own, so **the human can never order them**. Fighters can only be
     grabbed while scrambling. The airbase card only offers production (selection.ts L145-L158), with no list of
     hosted aircraft.
  2. **Fighters can't be sent on CAP by the human.** `moveUnit` for fighters (units.ts L336-L347) is only issued by
     the AI.
  3. **Armor can only be sent over own or allied land**, and a plain move (`targetPlayer = −2`) isn't reachable from
     the UI.
  4. No multi-select, box select, control groups, army list, unit hotkeys, or "cycle idle units". Units move at 88–300
     km per real second, which makes them hard to click.
  5. `ustate.docked` reads "En puerto" for aircraft.

**v2 (F7)**
* An **army / forces panel** listing every own unit and structure-hosted unit with state, and a click to select and
  focus.
* Select by clicking the icon at any zoom (see §12), plus box select or a list multi-select.
* Right-click to order: move, attack, patrol, defend, retreat. Order validity shown before the click, matching sim rules.
* Hosted aircraft selectable from their airbase card.
* Explicit orders for armor to cross borders during war.

**Risks**
* `worldClick` semantics are centralised in `controller.ts`. Right-click currently opens the diplomacy radial (L69-L76).
* The picking radius depends on rendered sizes, which change if §12 switches to icons.
* Keep the sim authoritative (UI prechecks mirror sim rules today: `hud/shared.ts buildError` L143-L161 duplicates
  `game.ts buildError` L327-L345).

---

## 12. Unit rendering and LOD (F4)

**Now** (`src/render/units/index.ts`)
* Instanced procedural 3D models: 13 unit kinds and 12 structure kinds (`models.ts`), one `InstancedMesh` per kind,
  capacities at L37-L44.
* `updateUnits` L598-L695: lerps position, heading and altitude with `simAlpha`; builds the pose (`pose` L444-L500:
  guided weapons face their velocity, aircraft bank). Formations: fighters as a V of 3, drones as a swarm of 7, armor
  as 4 tanks, trains as a locomotive and 3 wagons.
* Size: `unitSizeKm` (`units/common.ts` L115-L120) = `max(realKm, minPx·pixelK·dist)`, clamped to `maxKm`
  (`UNIT_LOOK` L96-L112: minPx 16–46, maxKm 34–130), times `unitScaleK` (L576-L578, 0.65–1 by altitude).
* Tint: nation color through `aMask` + `instanceColor` (`material.ts`). Selection pulse. Damage darkening. No owner
  badge or unit-type icon.
* Structures:
  * Detailed models below `DETAIL_ALT_KM = 5200` km (±500 km hysteresis; L75-L76, L1057-L1063).
  * Above that, a **beacon** octahedron (2.2 km, min 9 px; L819-L823).
  * `minPxScale = clamp(1.15 − alt/9000, 0.55, 1)` (L1064).
* Everything is depth-tested at renderOrder 20. **Clouds (renderOrder 30) draw over units and structures.**
* Evidence: `shots/codemap/val-1500km.png`. At 1,500 km, clusters of 30-px 3D models overlap and are hard to read.

**v2 (F4)**
* Above a threshold altitude (e.g. ~1,500–3,000 km), crossfade to **2D map symbols**: per-type icons in the nation
  color, with an owner ring, a count or strength badge, and the selection state.
* Draw them in screen space above clouds (renderOrder > 40, with a horizon test like `overlays.ts`) and cluster them
  when they overlap.
* Structures get type icons too, with a level badge.
* The icon atlas must be generated by code (canvas → texture). One instanced sprite batch.

**Risks**
* Picking must use the icon positions.
* New materials must be created in `init` and warmed up (ARCHITECTURE §5.4).
* Trails and FX attach to model positions (`getUnitWorldPosition`, used by fx).
* Draw-call budget: units ≤ 60.

---

## 13. Ship routes and trails (F2)

**Now**
* `render/units/index.ts emitTrails` L506-L559. Ships emit a `'wake'` trail: `fx/trails.ts` L46, life 7 s, width
  0.12 → 2.6 km, **white-blue additive**, flat, maxPts 36, minSeg 0.6 km. It is capped at `maxLen = 5 × drawn size`
  (`TRAIL_LEN` L392), so it is **a short wake behind the ship, not a route**.
* Points are committed on each sim update (`sampleTrails` L584-L596, from `simTick`), and the head follows every frame.
* Trails are released when the unit disappears (`releaseTrack` L384-L389) and then fade.
* Missiles already use an owner-colored `'arc'` trail (life 70 s, maxPts 128, minSeg 20 km; emitted at L547-L551). That
  is the pattern to copy.
* `TrailSystem` (fx/trails.ts):
  * pool reuse needs `pts.length ≥ maxPts·3` (L237-L244)
  * batch capacity 48k/24k vertices (`fx/index.ts` L86)
  * lifetimes are in FX wall time (`env.fxTime`), so at 4x ships travel 4× farther per trail second

**v2 (F2)**
* A new `'route'` style in the **owner's color**, starting at the port of departure (`UnitView.originX/Y` is the spawn
  point for boats) and kept until arrival, then faded out (e.g. 10–20 s after arrival).
* No `maxLen`. Budget points by distance (adaptive `minSeg` by route length; ocean crossings are ~200 tiles).
* Optionally show the planned route ahead (needs paths in the protocol, §2.4).
* Keep a short white wake at close range for realism.
* Apply the same treatment to trade ships (fainter) and warships.

**Risks**: trail memory (166 boat launches in 15 min in §0), and wrap at the date line (points are 3D, so this is fine).

---

## 14. Structures: placement, orientation, models, upgrades (F15)

**Placement**
* UI build mode (`controller.ts` L81-L94) with a green/red ghost (`cursor.ts` L163 → `buildPreview` →
  `units/index.ts` L958-L965).
* Sim `game.ts buildError` L327-L345: the tile must be own playable land; coastal types need `nav.coastal`; not in
  fallout; not occupied; at least 3 tiles from any structure (`STRUCTURE_MIN_DIST2 = 9`); enough gold.
* The client mirrors these rules in `hud/shared.ts` L143-L161 (duplicated).
* The AI uses `ai/economy.ts placeFor` L165-L223.

**Rendering** (`units/index.ts updateStructures` L791-L857)
* The anchor is at the tile center at `globe.surfaceRadiusAt` (L813).
* The basis is the radial tangent frame (`tangentFrame`) rotated by `headingFor` (L706-L730: a random hash; ports and
  yards face the water).
* Scale `S = structKm/R` (L62-L66): base 5–13 km, +10 % per level. Cities are `10 + 1.3·level` km, so **11–23 km
  wide**.
* The `ANCHORED` material scales the model about the anchor up to `minPx` (`material.ts` L55-L59, `STRUCT_MIN_PX`
  L68-L71).
* City skylines: `citySpec` L732-L787 (10 + 7·level buildings, spires). Radar dishes rotate (L859-L874). Factories
  smoke, damaged structures smoulder (L876-L902).
* Models are in `models.ts` (conventions L1-L6: ground at y = 0, footprint normalised to 1, front toward −Z).

**Why structures look sideways, half-sunk or floating** (owner's report)
1. **Big flat footprints on exaggerated relief.** A 5–23 km flat model sits on a globe displaced with
   `RELIEF_EXAGGERATION = 4` (constants.ts L21). Over 10 km of mountains the exaggerated surface varies by
   kilometres, so one side floats and the other is buried. Evidence: `shots/codemap/pyr-city-40.png` (the city disc
   hovers over a valley) and `pyr-air-40.png` (the airbase floats).
2. **The model's "up" is the radial direction, not the terrain normal.** On slopes it reads as tilted, "de lado".
3. **Min-pixel scaling enlarges the flat model further when zoomed out.** At 1,500 km, 30 px ≈ 140 km, while the ground
   under it keeps its exaggerated relief and curvature (the sphere drops ~0.4 km over 70 km).
4. **The foundation skirts are shallow**: 0.08–0.1·S (e.g. `models.ts cityBase` L317-L343).
5. **The globe mesh itself is coarse far from the camera.** The near patch only exists below 2,600 km
   (`globe/index.ts placePatch` L265-L296), so models can also float or sink relative to the rendered surface at
   medium altitude.

**Upgrades** (`sim/economy.ts upgrade` L122-L147)
* `level++`, `hp = 1`, at the **price of a new building** (`structureCost(type, ownedCount)`).
* Effects per level:

  | Structure | Effect of each level |
  |---|---|
  | City | +250k troop cap, +25 gold/tick, +civilians |
  | Port | trade chance and max ships ×level, cargo |
  | Factory | train interval ÷level, cargo ×(0.8 + 0.2·level), +16 gold/tick |
  | Defense post | radius 12 → 16.5 → 21 tiles |
  | SAM | range ×(0.6 + 0.2·(level−1)), salvo = level, hit +4 % |
  | Silo | cooldown ÷level |
  | Airbase, army base, naval yard | capacity ×level |
  | Army base (also) | +60k troop cap |
  | Radar | maxLevel 1 |

* Visual change: only +10 % scale for non-city types (`structKm`). Cities grow buildings and height.
* The selection card shows "level x/max" and a generic description. **Nothing says what the next level gives.**
  → "no se ve una mejora real".

**v2 (F15)**
* Conform to the ground. Options:
  * Snap `ANCHORED` vertices with local y ≈ 0 to the terrain radius at their own lat/lon in the vertex shader. The
    relief texture would need to be shared from `render/globe/textures.ts`.
  * Flatten the relief under structure pads (a pad mask in the globe displacement).
* Realistic footprints (≤ 3–6 km) with icons for readability (§12) instead of inflating 3D models.
* Level-specific geometry: more launchers on SAMs, more hangars and runways on airbases, more quays and cranes on ports,
  more stacks on factories, extra silo doors.
* An upgrade tooltip: "Nivel 2 → +X".

**Risks**
* The relief texture is owned by the globe (`PlanetTextures.relief`) and would need to reach the units materials.
* The battle layer builds its own terrain below 70 km.
* The city building layout is cached per level (`cityCache`).
* Shaders must compile at load.

---

## 15. Territory overlay, borders, clouds (F5, F10)

**Data textures** (`render/globe/territory.ts`)
* Owner texture 1600×800 RGBA8: RG = owner id, BA = capture tick stamp. Patched from `tilesChanged` in 64×64 dirty
  blocks via `copyTextureToTexture` (L186-L224).
* Palette 2048×1: color plus flags human/ally/traitor/alive, refreshed at 4 Hz (L226-L255).
* Glow render target 800×400: edge detect + separable blur, rerun at most ~6 Hz (L308-L329).
* Heat texture 400×200 (L257-L295). Scars: a 16-entry uniform array (L297-L306).

**Shader** (in the Earth surface fragment shader, `render/globe/earth.ts` L257-L370)
* Fetches owners in 2×2 and computes an anti-aliased distance to the border (L261-L285).
* Fill (L320-L326): `(0.26 + 0.05·human + 0.07·hover)·(alive ? 1 : 0.5)` mixing a luminance-preserving tint. It is
  **weak from orbit**.
* Ally hatching (L329-L335).
* Border (L337-L348): a crisp line of `clamp(0.22/pxT, 0.75, 2.4)` px, plus an inner glow and a blurred glow.
* Traitor flashing (L346). Night-side faint glow (L350-L351). Front fire (L353-L363). Fresh-capture flash, 60 ticks
  (L364-L368).
* **Neutral land has no overlay at all.** Contested land is only shown by the heat and capture flash.
* Opacity: `globe.setTerritoryOpacity` (`globe/index.ts` L416-L419), damped; 0 on the menu.

**Labels**
* `render/globe/labels.ts`: name and troop count at the sim's label anchor (`sim/labels.ts`, pole of inaccessibility,
  staged over 3 ticks).
* 19–36 px, fades with size, horizon and overlap, and fades out below ~600 km (`zoomFade` L280).
* `depthTest: false`, so labels draw above clouds.

**Clouds** (`render/globe/layers.ts`)
* A cloud shell at radius `1 + 14/6371` (`glsl.ts ATMOSPHERE.cloudRadius` L20), renderOrder 30, alpha =
  `texture·0.96·fade`.
* `fade = smoothstep(45, 320, altKm)` (`globe/index.ts` L366-L368). **At every strategic altitude the clouds are
  fully opaque over the territory**, which lives in the ground shader, so fills, borders and front fire vanish under
  them. Evidence: `shots/codemap/val-1500km.png`.
* Cloud shadows also darken the ground (earth.ts L376-L384).
* Clouds drift (`CLOUD_PERIOD_SEC = 5400`, globe/index.ts L210).

**v2 (F5, F10)**
* (a) The cloud shader samples the owner and glow textures (the cloud uv is offset by `uCloudOffset`) and thins clouds
  over land, and strongly over borders and fronts. Alternatively offer a "strategic view" toggle or altitude rule.
* (b) Draw borders and fronts on a separate shell **above** the clouds (like `app/worldfx.ts`, which already uses shells
  at 1.0034–1.0042), or make the cloud pass skip territory pixels.
* (c) Fill strength by altitude, with near-flat colors from high orbit.
* (d) Hatching for contested and occupied land, desaturation for neutral land, and a clear owner name on hover.

**Risks**
* One extra full-sphere pass costs overdraw. Aerial perspective must stay consistent.
* The hover highlight uses `uHoverOwner` in the same shader.
* The battle terrain patch copies the fill strength (`battle/index.ts` L349-L354) so its rim matches: keep them in sync.

---

## 16. Islands (F6)

**Now**
* `src/data/grid.ts` builds land and water from the 1600×800 water mask. `src/data/rasterize.ts` L7-L10 stamps islands
  too small to contain a tile center onto the tile under their centroid.
* Measured: **226 single-tile land components and 151 of 2–4 tiles.** A 25 km tile is about 1–2 px from 5,000 km+.
* Owned islands get the same weak fill and a 0.75–2.4 px border. Neutral islands get nothing.
* The **hover tooltip** (`ui/hud/cursor.ts paintTooltip` L86-L136: terrain, country, owner) is the only way to notice
  them, exactly as the owner reported.

**v2**
* Screen-space island markers for land components smaller than N tiles: a min-size halo or dot, owner-colored,
  white-outlined when neutral.
* Clickable, so a naval invasion can target them.
* Cluster in archipelagos (Indonesia, Caribbean, Aegean).
* Compute the components once per game on the client from `world.terrain`.

**Risks**: clutter and picking conflicts with units and structures.

---

## 17. Command mode (F8)

**Entry**
* UI: TAKE CONTROL button or `T` (`selection.ts takeControl` L203-L215; tutorial step `tutorial.ts` L56-L57).
* `app.enterCommandMode` (bootstrap.ts L124-L140):
  1. `commandParams` L256-L298 picks the **enemy**: the dominant non-allied foreign owner within 40 tiles, widening to
     90 and then 160, **otherwise the strongest nation in the world**. The comment says "never a skirmish against
     nobody". This is exactly the owner's complaint: even deep inside your own peaceful land you are thrown into a
     battle.
  2. Camera `flyTo` 3 km, tilt 1.2, 2.2 s.
  3. Fade.
  4. `sim.send(unitControl)`: the unit freezes in the sim (units.ts `control` L414-L425; step skips `Controlled`).
  5. `command.enter(params)`.
  6. State becomes `command`.
* The contract (`api.ts CommandEnterParams` L223-L241) documents `enemy: 0 = none found: … not allowed; app picks one`.

**Local scene** (`src/command/index.ts build` L297-L400)
* Terrain from `data.getLocalHeightfield`:

  | Unit | Near patch | Far ring |
  |---|---|---|
  | tank | 4.2 km | 44 km |
  | jet | 36 km | 240 km |
  | ship | 20 km | 150 km |

  The scene is fixed around the entry point. **There is no streaming, so you can't drive anywhere.**
* Sun and atmosphere at the real place and time. Team colors.
* `Mission` (`src/command/mission.ts`) **scripts a battle** regardless of the real situation:
  * **tank** (L152-L195): an enemy defensive line 370–400 m out with sandbags, AT teams and infantry, 5 enemy tanks,
    IFVs, AA and trucks, prewrecked vehicles and craters, friendly tanks and squads
  * **jet** (L197-L233)
  * **ship** (L235-L265)
  * Director `update` L289-L365: reinforcement waves, friendly air strikes every 40–60 s, enemy artillery every 4–10 s,
    anti-ship raids
  * Kill objective of 10–14 (`DIFF` L13-L18)
  * Operation names `OP_A/OP_B` (index.ts L46-L47), English words shown in both languages
  * Intro card, debrief
* Link to the sim: `strategicUnitsFor` (L226-L237) takes up to 3 enemy strategic units **of the same command kind**
  within 22 tiles and links them to local groups. Destroying a whole group sends the unit id in
  `result.unitsDestroyed`.
* Local world: `command/world.ts` (`ENT_DEFS` L21-L33, troop values per kill). AI: `command/ai.ts`. Controllers:
  `command/player/tank|jet|ship.ts`. HUD: `command/hud/hud.ts`.

**Exit and result**
* Esc, the button or death → debrief (`requestExit` L248-L268, `beginDebrief` L270-L285).
* `commandExitRequested` → `app.exitCommandMode` (bootstrap L141-L157) → `command.exit()` L638-L668.
* `CommandResult.troopsKilled = Σ(victim ENT_DEFS.troops)·troopMul·(1.25 if objective)`, capped at 0.6·enemyTroops
  (`computeTroops` L287-L292). `unitsDestroyed`. `structuresDestroyed` is always `[]`. `unitLost`.
* The result goes to the sim as `commandResult` (`game.ts applyCommandResult` L787-L813: removes enemy troops, kills
  units, releases or kills the controlled unit). Then `unitControl` false, and the camera climbs to 2,500 km.
* While in command mode the sim keeps running, but the globe, units, fx and battle renderers are not updated
  (bootstrap L384-L389).

**v2 (F8)**
* Entering in your own territory with no enemies around must give a **peaceful** scene at the unit's real position.
  `enemy = 0` must become legal.
* **Local enemies must come from the sim**: enemy armor and troops at the nearby front (FrontView, units), enemy
  structures (defense posts, SAMs), aircraft actually in the area.
* **Drivable across the country**: stream or recenter heightfield tiles around the vehicle (floating origin), and add a
  sim command to move the controlled unit (§2.4) so the strategic map follows.
* **Border crossing** raises an event: the AI decides to respond (dispatch armor or aircraft, protest, declare war) and
  the human sees the alert.
* Drop the scripted waves, objectives and op names, or keep them only as flavour on a real engagement.

**Risks**
* The command directory (10.7k lines) is built around `Mission`.
* Time scale: a real-time tank crosses 100 km in ~1.7 h. v2 needs time compression, a "road march" mode, or a
  strategic-map move while in control.
* Returning must resync the renderers after a long absence (they tolerate gaps).
* Audio moods, and the `commandExitRequested` reasons (§24).

---

## 18. Camera rig (context for all visual changes)

`src/render/camera/index.ts`
* Controls: grab-pan with inertia; wheel zoom toward the cursor (ignored with Shift) in L154-L173; right or middle drag
  for heading and tilt; WASD / arrows / Q-E / R-F; double-click flies there (L133-L140).
* `focusRequest` bus handler L149-L152. `flyTo` L430. `shake` L444.
* Auto-tilt with altitude: `autoTilt` L38-L42, `maxTilt` L44-L48.
* Limits: 0.35–42,000 km (constants.ts L185-L186).
* **The `edgePan` setting exists in the UI but is never read** (§24).

---

## 19. Audio hooks

`src/audio/index.ts`, bus subscriptions L150-L360:
* UI sounds (command mode remaps hover, alert, notify and click to cockpit tones).
* News bleep. Radio chatter on unit selection.
* Positional combat cues from `combat` events: naval gun, artillery, SAM, bombs, strafe.
* Unit spawn and death cues.
* Structure built, upgraded, destroyed and captured.
* `attackStarted` changes `attackHeat` only.
* Boats, alliances and betrayal, eliminations, coins, emotes, world events, doomsday.
* Nuke launch, siren (`nukeAlarm`), interception, detonation (silence then roar).
* Command vehicle engines. The adaptive music mood follows intensity (~L383) and `setMood` (L518).
* Diagnostics: `window.__fuAudio.stats()`. Dev lab: `src/audio/lab.ts` plus the `audio-lab` / `audio-music` shots.

**v2**: a distinct "we are under attack" alarm, diplomacy message sounds, and quieter repeated combat cues at the new
pace.

---

## 20. HUD panels and in-game explanations (F16)

**Layout** (`src/ui/hud/index.ts` L120-L131)
* top bar: troops/max/growth, gold/income, territory %, population (`topbar.ts`)
* time controls (`topbar.time`)
* ticker + nuke alarm
* leaderboard (top 10, `leaderboard.ts`)
* toasts (top left)
* tutorial (left)
* minimap (bottom left, 400×200, `minimap.ts`)
* mode banner + attack-ratio slider + build bar with CONSTRUIR / ARSENAL tabs (`buildbar.ts`, tooltip reasons
  L126-L216)
* selection card (bottom right)
* spawn overlay, cursor tooltip and chip (`cursor.ts`), click ripples, radial menu

Refresh rates: text at 10 Hz, leaderboard and minimap at 4 Hz (L184-L208).

**Explanations today**
* Tutorial, 6 steps (`tutorial.ts` L40-L59): expand, ratio, city, diplomacy, defense, command.
* How to play (`ui/dialogs.ts openHowTo` L140; `howto.*` keys in `ui/i18n/es.ts` L128-L150).
* Loading tips `tip.*`.
* Structure and unit one-liners: `structure.*.desc` L472-L481 and `unit.*.desc` L499-L513 in es.ts.
* Hover tooltip: action and odds color (`cursor.ts` L119-L135).

**Gaps**
* Nothing explains upgrade effects, capacities, ranges or counters.
* No visible effect radius for defense posts, SAMs, radar or airbase range.
* No explanation of why the AI did something.
* The **Radar description promises detection** that does not exist (§24).

**v2 (F16)**
* Every mechanic gets a tooltip with numbers and a map visualisation (range rings when selecting or placing).
* A "why" for AI actions (reason keys).
* Remove or rework anything unexplained.

---

## 21. i18n

* **API** (`src/shared/i18n.ts`): `t(key, params)` L49-L60 falls back es → en → key and warns once. `{param}` is
  replaced; **a missing param stays literal**. `tn` does plurals, plus number formatting and `playerName`.
* **Dictionaries:**
  * `src/ui/i18n/es.ts` and `en.ts`: 472 keys each, registered in `ui/index.ts` L34-L35
  * `src/sim/strings.ts` (`msg.*` + fallback names; its comment says UI texts override)
  * `src/command/strings.ts`
  * `src/data/strings.ts`
  * `src/sim/ai/shots.ts` L21-L66: `ai.room.*` strings for a debug shot
* **Known problems:**
  * `msg.allyTarget` uses `{playerName}`, but the sim sends `{from, target}` (`sim/diplomacy.ts` L175), so the text
    shows a raw `{playerName}`.
  * Hardcoded player-facing text:
    * command operation names (index.ts L46-L47, L386)
    * the command HUD compass `CARDINAL` (hud.ts L24)
    * `"${n} IA"` in the setup summary (`ui/menu.ts` L108)
* **v2 rule**: every new string goes into both languages, namespaced by area.

---

## 22. World events and the doomsday clock (F13, F16)

* **Director** `src/sim/events/index.ts`:
  * the first event at 1200 + rng(600) ticks
  * then every 1200–2100 ticks (×0.6 if the leader holds > 40 % of the land)
  * at most 2 at once
  * picked from a bag: earthquake, hurricane, gold rush, pandemic, rebellion
  * `force()` for shots
* Implementations: `earthquake.ts`, `hurricane.ts`, `goldrush.ts`, `pandemic.ts`, `rebellion.ts` (unrest from
  overextension), and `places.ts` (real fault lines, cyclone basins, gold fields). Rendered by `app/worldfx.ts`.
* **Doomsday** (`events/doomsday.ts`):
  * activates when there has been a detonation and tick ≥ 6000, or 3+ silos exist and tick ≥ 7200, or tick ≥
    `doomsdayStartTick` 18000
  * the level feeds AI nuke timing and will (§7) and the news
* **v2**: these are "things that happen without a reason" unless they are explained. Rebellions from overextension and
  gold rushes have causes. Hurricanes and earthquakes are random. Doomsday currently **drives** nukes instead of
  measuring the world's escalation. Invert that: the clock should follow real escalation.

---

## 23. Shots, playtests, measurement tooling

* **Registry**: `src/shared/shots.ts` (`registerShot(name, owner, desc, stage, settleFrames)` L35, `runShotFromUrl`
  L88, `markShotReady` L80). Wiring: `src/app/shots.ts` imports the ui, data, globe, units, fx, battle, command and
  sim-ai shot modules. `sim/shots.ts` is imported by `sim/client.ts` and `audio/shots.ts` by `audio/index.ts`. Stager
  context: `{ctx, params, waitFrames, wait, setUiVisible}`.
* **59 shots**:

  | Owner | Shots |
  |---|---|
  | ui | loading, menu, setup, spawn, hud, radial, settings, howto, nuke-alarm, end, defeat |
  | globe | orbit, night, territory, territory-close, territory-war, horizon, horizon-himalaya, menu-bg |
  | units | units, units-orbit, structures (params `lat`, `lon`, `alt`, `tilt`, `heading`, `sun`), structures-night, nuke (`&after=N`), nuke-flash, nuke-launch, mirv |
  | battle | front, front-wide, front-high, front-night, front-auto |
  | command | command-tank, command-jet, command-ship, command-intro, command-debrief, command-fx, command-garage (`?cmdTimeScale=`) |
  | data | data-debug, data-terrain, data-coast, data-biome, data-europe, data-local |
  | sim-core | sim-europe, sim-map, sim-timelapse, sim-war |
  | sim-ai | ai-world, world-events, event-earthquake, event-rebellion, event-doomsday |
  | audio | audio-lab, audio-music |
  | app | midgame, world-events-3d |

  Global params: `&hud=0`, `&lang=en`, `&quality=`.
* **Staging**: `app.startScriptedGame` (bootstrap L90-L123): seed 1337, 24 AIs, human at Madrid, autopilot, a
  18-tile head start plus 60k troops and 2M gold, then `fastForward(ticks)`, then `setSpeed`.
* **Capture**: `tools/capture.mjs --url … --shot a,b --out dir --wait ms [--timeout ms --w --h]` waits for
  `__shotReady` or `__ready`.
* **Playtest**: `tools/playtest.mjs [--url http://127.0.0.1:5190/] [--out shots/playtest] [--steps N]` drives the real
  UI (menu → setup → spawn → attacks at several ratios → every structure → boat → nukes → alliance via the radial →
  armor + TAKE CONTROL → end). Its in-page helpers live in `window.__pt` (L90-L190).
* **Headless sim**:
  * `npx tsx src/sim/test/harness.mjs [--ais --tribes --minutes --seed --difficulty --fallback --nukes 0 --events 0]`
  * `src/sim/test/arsenal.mjs`
  * World cache: `src/sim/test/world.mjs` builds WorldInit once in headless Chromium and caches it under
    `node_modules/.cache/front-ultra-sim`
  * AI tests: `src/sim/ai/test/*.mjs`
  * Command balance: `npx tsx src/command/test/balance.ts tank normal 180`
* **Debug hooks**:
  * `window.__front` = {ctx, app}
  * `__shotReady`, `__ready`, `__shotError`, `__fps`
  * `__units`, `__fx` (DEV only)
  * `__cmd`, `__cmdStats` (shot sessions only)
  * `__fuAudio.stats()`, `__audioLab`
* **How the §0 numbers were made**:
  * A tsx script imported `Game` and `loadWorldInit`, ran `tick1()` + `buildUpdate(1)` for 9000 ticks, and tracked
    `a.conqueredThisTick`, per-player tile deltas over 10 and 50 ticks, and events.
  * Structure screenshots: a Playwright script opened `?shot=structures&hud=0`, used
    `__front.ctx.sim.debug({type:'conquer'|'spawnStructure'})` around (42.6°N, 0.5°E), and placed the camera with
    `cameraRig.setState`. The script must live where `playwright` resolves, i.e. the repo, or a folder with a
    `node_modules` symlink.

---

## 24. Dead code, "exists just because", duplicated logic, known bugs (F16)

**Dead or unused**
* `Settings.edgePan`: a toggle in `ui/dialogs.ts` L81 that the camera never reads.
* `FxApi.explosion` / `FxApi.tracer` (`shared/api.ts` L205-L210): nobody outside `render/fx` calls them. Battle and
  command have their own FX.
* `Structure.age` (sim/state.ts L99): incremented in economy.ts L283, never read.
* `CommandResult.structuresDestroyed`: always `[]` (command/index.ts L645).
* `commandExitRequested.reason`: `'objective'` and `'killed'` are emitted but app ignores the reason
  (bootstrap L318).
* The `three-globe` devDependency (package.json) is imported nowhere.
* `tools/.cap-battle.mjs`, `tools/.cap-battle-multi.mjs`, `tools/.crop-battle.mjs`: committed one-off scripts.
* `src/sim/fallbackAi.ts` (461 lines): a second, simpler AI that only runs if the sim-ai director throws
  (game.ts L189-L216) or with `--fallback`. It will silently diverge from v2 rules. Delete it, or reduce it to "do
  nothing".

**"Exists just because" (the owner will notice)**
* **Radar**: the description says "Detecta con antelación misiles y aviones enemigos", but there is no detection or
  fog of war. It only adds SAM range ×1.35, SAM hit +0.1 and airbase scramble range ×1.5. maxLevel 1.
* **Population / civilians**: a top-bar number with no gameplay effect beyond nuke casualty counts.
* **Emotes** (16) are the only "conversation" with nations. `targetPlayer` ("Marcar como objetivo") is opaque to the
  player and has a broken message (below).
* **Command mode's** scripted mission, objective counter, operation names, waves and friendly air strikes (F8).
* **Battle-layer armies** are decorative and not tied to sim units (F11).
* **World events and doomsday** (§22) are random pressure without a cause.
* **Insane cheats** (ai/index.ts L146-L149).
* **Trains** are visual gold carriers the player never interacts with. The rails drawn on the map are a client
  reconstruction.

**Duplicated logic** (keep it in sync or unify)
* Build rules: sim `game.ts buildError` vs UI `hud/shared.ts buildError`.
* Coastal rule: sim `WaterNav.coastal` vs UI `isCoastal`.
* Rail graph: sim `economy.ts rebuildRail` vs render `units/rails.ts buildRailLinks`.
* Built-in capitals list in `ai/setup.ts` and `fallbackAi.ts`.
* Unit prices: `balance.ts unitPrice` is used by both sim and client (fine), but the MIRV count is tracked separately
  on the client (`client.ts humanMirvs`).

**Known bugs found while mapping**
* `msg.allyTarget` shows a raw `{playerName}` (§21).
* Docked aircraft can't be selected, so bombers and drones are unusable by the human (§11).
* Aircraft order previews show "valid" on own land, but the sim rejects the strike (§11).
* The selection speed readout is wrong ("315 km/h" for armor, §3).
* Structures float or sink on relief (§14). Clouds hide territory (§15).

---

## 25. Suggested order and cross-cutting risks

1. **The time scale and conquest cap come first** (§3, §4, §5). They change every tuning downstream (AI, economy, FX,
   shots, harness). Rerun `src/sim/test/harness.mjs` and the §0 measurements after each change. Target something like
   "a nation never loses more than a few % of its land per game-minute to one attack".
2. **Protocol additions** (§2.4): add them all in one pass to limit churn. Update `buildUpdate`, `client.apply`,
   `types.ts` views and `tickUpdateTransferables`.
3. **Diplomacy and war states** (§7, §8) before alerts (§9), because alerts need reasons and war state.
4. **Readability**: icons (§12), clouds and territory (§15), islands (§16), routes (§13), structures conforming to the
   ground (§14).
5. **Command mode rework** (§17) last. It depends on the war state, real unit positions and the time scale.

**Global risks**
* Many shots and the playtest depend on current speeds and the autopilot. Retune the staged `ticks:` values and verify
  with capture.
* Shaders must still compile during loading: create any new material in `init` and warm it up.
* Keep `npx tsc --noEmit` and `npm run build` clean.
