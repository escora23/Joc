# FRONT ULTRA v2: status and open items (orchestrator hand-off)

Stages 1-2 (W1 sim/pacing/warfare, W2 map readability, W3 diplomacy/alerts/UX, W4 armies/orders) are built and went through independent verification. This file lists what the last verifiers still failed, what builders reported as not done, and the briefs + acceptance criteria for the remaining workstreams W5 and W6. Every agent in the finishing run reads this file.

## Open verifier failures (latest verdict per workstream)

### verify:W3-diplomacy-alerts-ux:2

> **Resolved in the W3 close-out (2026-09-28).** Items 19, 5 and 14 are fixed (commits 84a45cc, c0cdcd3, af44207 and the close-out commit). On a no-HMR dev server (tools/vite.nowatch.config.mjs, which avoids mid-run reloads from other agents' edits), `node tools/playtest.mjs --stage2` passed **19/19 twice in a row** (1096 s and 1063 s, 0 console errors), and `node tools/w3-verify.mjs --lang both` passed **55/55** (es + en, 0 console errors), including V5d (capital named, no «0 km») and V14/V14b in both languages. The evidence below is kept for history.

- **19. tools/playtest.mjs completes its stage-2 steps on Easy in one run**
  - evidence: My run was `node tools/playtest.mjs --stage2 --url http://127.0.0.1:5333/ --out shots/W3-diplomacy-alerts-ux-verify/pt`. It ended 'stage 2: 16/19 steps passed', not the reported 15/15. FAIL 'expand into neutral land': no attackStarted within 12 s, although the hover card read «Clic: expandirse con 21K» (shot pt/fail-expand-into-neutral-land-…png). FAIL 'declare war through the §4.2 dialog': '.fu-declare-modal' appeared but only contained «DECLARACIÓN DE GUERRA», and the screenshot pt/15a-declare-dialog.png shows a nation/structure card for Estados Unidos instead of the dialog. FAIL 'white peace…' followed from that. I reproduced the cause in a probe (scratchpad/vv/p3.mjs): on the same enemy tile, 3 of 4 left clicks opened the dialog. The miss emitted worldClick with structureId 245, so input.pick resolved the click to an enemy structure and it was selected, while the hover card, computed moments earlier, still said «Clic: declarar la guerra a Estados Unidos». w3-verify also ended 46/48 in my run: V14 reported the speed buttons as 'missing' and V19 read empty cues. Both fit a mid-run Vite reload (HMR from another agent's edits reloaded my own probe too); the speed tooltips and all six cues check out separately.
  - required: Make the stage-2 playtest deterministic. Target tiles for the expansion and declaration clicks must have no structure, unit, island marker or icon cluster within the pick radius; check that with ctx.units.pickStructure/pickUnit/pickIcon at the projected point before clicking. After the click, retry with another tile when worldClick resolved to something else. In the game, make the hover card agree with what the click will do: when a foreign structure or unit is under the cursor, show its card or selection hint, not «Clic: declarar la guerra». Re-run the playtest twice in a row and get all stage-2 steps passing both times.

- **5. Offensive alert names the place («cerca de <lugar>» or bearing and distance from the capital)**
  - evidence: In the playtest's capital-threat step the alert read «¡Austria lanza una ofensiva hacia la zona situada a 0 km al N de tu capital! El frente está a 700 km». In src/ui/places.ts describePlace, km = Math.round(dist/10)*10, so any point within about 5 km of the capital renders as '0 km al N de tu capital' / '0 km N of your capital'.
  - required: In describePlace, when the distance rounds to under 10 km, return the capital itself: the capital's place name when nearestPlace finds one, otherwise «tu capital» / «your capital», with named=true and no bearing. Add this case to w3-verify V18 or V5 in both languages.

- **14. Tooltips on W3 UI with purpose and numbers, fully localized**
  - evidence: src/ui/hud/topbar.ts:97 hard-codes `${t('hud.pause')} (Space)`, so the Spanish pause-button tooltip reads «Pausa (Space)». Probe output: «PAUSA ESPACIO Pausa (Space) Nada caduca en pausa…». The top-bar stat tooltips themselves pass: troops show the recruitment formula, gold has a per-hour breakdown, territory has the «Ocupadas» line, and population is shown with the recruitment factor.
  - required: Replace the literal '(Space)' with t('keys.space') (it already exists and is used as the hotkey), or drop it since the hotkey chip already shows it.

### verify:W4-armies-orders:1

> **W4 final fix pass (2026-09-28).** The later verifier findings are fixed: (1) V7 rail reads the card inside the sim update where the division boards (mode 2), checking «100 km/h en tren» and «≈ 100 km por segundo a 1x»; (2) the Fuerzas drawer starts under the clock / speed widget and docks the unit card to its left, and V1 now checks the card and its order buttons are on top and the 5 speed buttons hit-testable with the drawer open; `node tools/w4-verify.mjs` on a no-HMR server passed **29/29 twice in a row** (shots/W4-fix-final/verify1, verify2). (3) The model gallery steps exact ticks (fastForward) to freeze the bomber and the drone swarm in cruise and picks a rail-network train; `tools/w4-closeups.mjs` exits 1 when a unit type is missing; aircraft are drawn under an 8-40 km camera (height capped at 40 % of the camera altitude), contrails are capped to thin tapered lines. (4) The bloom discs were a staged strike's fireball frozen by the pause plus lens ghosts: conventional fireballs are now 2.5 km (structure) / 0.9 km (bomb) with a pixel floor from orbit, and lens ghosts in the strategic view only while a nuke burns; the full close-up run (152 frames, every type staged, shots/W4-fix-final/closeups) has no bloom blobs. (5) Silo: three hazard-ringed cells and the erector gantry at every level on a pale apron; naval-yard docks run through the quay edge into the water (the yard is slid so its gates meet the drawn shore); trains are smaller than stations from afar, larger up close, and ride the drawn great-circle rail facing along the link; drones are grey with nation-coloured wings.

- **10. structures-levels shows distinct L1/L2/L3 geometry for every type, with level pips on icons and cards**
  - evidence: I recaptured the shot with a 400 s staging timeout (shots/W4-armies-orders-verify/structures-levels.png); it is identical to the builder's copy. It is a top-down view from far away. Each model is 30-60 px, and no structure icons or structure card appear anywhere, so there are no level pips to see. In the 3x crops, the L1/L2/L3 models in the defense-post and radar rows (around y=230 and y=380) are almost identical. The bottom row sits behind the build bar and one model is under the minimap. The only proof that levels differ is the vertex counts from __units.modelStats() (V10). The pips do exist in the game: dots under the icons in the forces-panel scene and ●●○ in the header of the factory card. But the required shot shows neither.
  - required: Reframe structures-levels: move the camera closer, or split the shot into several frames, so each type's L1/L2/L3 is large enough to tell apart. Keep every model clear of the HUD, or hide the HUD. Add their icons with level pips (for example an icon overlay at a zoom where icons and models both show, or a second frame at icon zoom). Open one structure card so its pips show. Then check the result by eye, not only by vertex counts.

- **5. Shift+drag selects all own units in the rectangle; one right-click orders them all; «n de m» (reproducibility of the builder's verifier)**
  - evidence: The game behaves correctly. In my own probe, Shift+drag from (420,160) selected 10 units, with the game running, paused and running again, and the chip read «6 DE 8 UNIDADES PUEDEN CUMPLIR ESTA ORDEN». But tools/w4-verify.mjs fails V5 every time after V3: 21/23 on the full run and 3/5 with --only V3,V5 ('0 selected, 8 in the box', empty chip). Cause: the drag starts at (300,120). By then the alerts stack at the top left (the rejection alerts from V3) covers that point: document.elementFromPoint(300,120) is .fu-alert. So pointerdown never reaches the canvas and no worldBox event fires. The builder's 'all pass' comes from targeted reruns only.
  - required: In tools/w4-verify.mjs V5, start the drag at a point clear of the HUD (for example 420,160 → 1250,700). Better: pick the corners from canvas pixels where document.elementFromPoint returns the canvas, or clear the alerts first. Then show that one full run passes 23/23.

- **7. The unit card shows km/h per section 2.3 (minor)**
  - evidence: A division moving by rail (mode 2) reads «En tren → Zaragoza · 1,1 h», yet its speed line still says «VELOCIDAD 40 km/h ≈ 40 km por segundo a 1x». Section 2.3 gives 100 km/h by rail, and the ETA shown is computed at rail speed, so the card contradicts itself. Everything else passes. Role, reach, current effect, integrity and endurance («≈ 21 días de combate») are present, and no FUERZA appears. Bomber, fighter and drone cards show mission and cruise speeds. The City, Port and Factory cards show gold per hour, the current and next level, and cost and time («MEJORAR A NIVEL 7 · 437.500 · 2,5 H», which equals upgradeCost). «Te faltan» appears when gold is short.
  - required: When the unit is in Rail mode, have speedLine and speedRealLine show the rail speed (100 km/h ≈ 100 km por segundo a 1x), or both road and rail speeds, with the i18n keys filled in es and en.

### verify:W2-map-readability:2

- **10. zoom-40 and zoom-8 outside battles: owned land dE >= 8, borders visible, no seam or flat blue plane**
  - evidence: The dE part passes: tools/w2-verify.mjs zoom check gives zoom-40 at 32.2 and zoom-8 at 34.0, with no seam and no flat blue plane. The builder's own regular-grid gate fails on zoom-8, though: autocorrelation peak 0.629 at lag [12,0], against a limit of 0.3 (zoom-40 is 0.204). You can see it in shots/W2-map-readability-verify/it2/verify/zoom-8-base.png. The purple occupied land is a dense, regular lattice of large bright ellipses with moire patches, and zoom-40-base.png shows the same moire squares inside the dot field. The occupied-land dots are kept about 9 px apart at every zoom, so at 8 km they become a fabric-like texture that dominates the view. The shot is also meant to be 'outside battles', yet it frames occupied, war-held land next to the human's border. Log: shots/W2-map-readability-verify/it2/verify.log, line starting 'FAIL  10'.
  - required: At close zoom (below about 50 km), fade the occupied-land pattern into a sparse, irregular, world-anchored pattern (or a low-contrast hatch with jitter) instead of a screen-regular dot lattice. The grid autocorrelation must drop below 0.3 on zoom-8 and the moire must go. Stage zoom-40 and zoom-8 on a genuinely peaceful border with no occupied or contested tiles in frame. Then rerun the zoom check and look at the PNGs.

- **13. Historical borders off by default; when on, drawn only below 1000 km and shown in the legend**
  - evidence: The behaviour passes: w2-verify reports defaultOn false, offAt600 0, onAt600 1, onAt1400 0. The legend entry points the player to the wrong place, though. src/ui/i18n/w2.ts:45 says 'Desactivada por defecto: actívala en Ajustes › Gráficos' and the English at line 84 says 'Settings › Graphics'. The toggle is actually in the Game tab: src/ui/dialogs.ts:126 puts row('settings.historicalBorders', ...) in the `game` form, labelled 'Juego' / 'Game'. A player following the in-game explanation will not find the switch.
  - required: Change legend.historical.text in both languages to point to Ajustes › Juego / Settings › Game, or move the toggle to the Graphics tab. Keep the tab labels and the legend consistent.

### verify:W1-sim-pacing-warfare:3

- **8: a domination or hegemony win in 36000-72000 ticks (T14, game --difficulty normal --seed 11)**
  - evidence: I re-ran `npx tsx src/sim/test/pace-audit.mjs game --difficulty normal --seed 11` at HEAD cb2c37e with a clean tree. Result: 'game over at tick 74210: hegemony, winner Iraq' and 'FAIL T14 ... hegemony at 74210, target [36000, 72000]'. 15 of 16 rows pass. The builder also admits T14 fails, although their run ended by the time limit at 96000. The code has changed since their report: declarations are now 102 against their 181, and capitulations 16 against their 13. So the builder's numbers no longer describe HEAD. The design also requires at least 2 of 3 seeds (11, 12, 13) to end by domination or hegemony, and nobody has shown that.
  - required: Get a Normal game to end by hegemony or domination between 36000 and 72000 ticks on seed 11, and on at least 2 of seeds 11/12/13. Do this without loosening T1-T5, T16, T17 or T19. Options: give AI war plans a late-game (after about 30000 ticks) consolidation drive against weakened neighbours after capitulations, or let the leader form offensive coalitions (coordinate with W3). Or shorten the hegemony hold / adjust the 3x rival rule in §4.18 with a documented rationale. The seed 11 game now misses by only 2210 ticks. Then re-run seeds 11, 12 and 13 and report each end tick.

- **10-13, 15-16 (browser checks: speedProbe on-screen speeds, crisis clock at 1x/4x, observation mode, T40 smoothness, top bar DÍA/hour bar, attack modal, isOccupied resync) and 20 (shots)**
  - evidence: I did not reproduce these in the browser. The builder's own report says the browser run passed 39/40, with the occupation check (A16) only passing after the staging was changed. That leaves no current single clean run on HEAD. The headless parts pass: pace-audit speeds 13/13, including ballistic flightTicks. tsc --noEmit and npm run build pass.
  - required: Produce one clean `node tools/w1-browser.mjs` run on the final HEAD with every check passing, including A16 without special staging. Attach the territory, midgame, front and sim-war shots from that same HEAD.

- **4: regrowth for a 5000-tile nation**
  - evidence: pace-audit regrowth measured a 4353-tile nation (3267 ticks, pass) rather than a 5000-tile one. The 200-tile case took 2473 ticks, just inside the [2400, 4800] window. Minor, but the audit does not test the stated size.
  - required: Stage a nation of at least 5000 tiles in the regrowth audit, or document why 4353 is representative.


## Builder-reported not done

### fix:W3-diplomacy-alerts-ux:1
> Close-out: w3-verify now runs in English too (55/55 with --lang both). The English front label reads «Front 370 km NW of Madrid». Front priority can be set from the offensive alert's and the auto-pause banner's «Prioridad alta» button (V5e); the Guerra panel control belongs to W6. arsenal `diplomacy` passes.
- T14 pace regression (game ends around tick 74210 against the 72000 bound) not re-measured; it belongs to the W1/W4 owners
- w3-verify not run in English; only the Spanish pass was run after these fixes
- No in-game control yet to set a front's priority, so the front-priority remedy named in the unrest, capital-threat and help texts cannot be acted on until one exists
- In English, W4's front label for an unnamed place reads «the area 370 km NW of Madrid front», which is still awkward

### build:W4-armies-orders
- arsenal.mjs `diplomacy` scenario still fails: it expects a 'requested' event. It belongs to W3 and was already failing before this work.
- A division travelling by rail was not measured separately in the browser. Only the headless check covers it: about 6.6 h for a 650 km trip.
- Parked aircraft on airbases are small at the 40 km camera height (pyr-air-40 shot); no minimum on-screen size was added.
- The last full run passed 16 of 23; I reran only the failing checks (V1, V4, V5, V7) after fixing the verifier, and they all passed. Timing-sensitive checks depend on machine load; the verifier now polls instead of sleeping.

### fix:W2-map-readability:2
- Did not rerun readability-europe or readability-night (criteria 1 and 2). The shader change only affects occupied land, and the flat tint used when zoomed far out is unchanged, so impact on those criteria should be minimal, but it is not measured.


## W5-command-v2: brief

Stage 3, beside W6, after both W3 and W4. Read DESIGN_V2 §9 (all), §2.2 (sub-tick and travel), §9.4 (budget and throttle), §9.6 (shared local forces), §9.8 (move clamp), §14.3, §14.6, §14.8, §14.11 and §16.6. Rows F8, C01, C02, C05. Use W3's opinions, places and alert API, W4's unit data and W1's clock, subStep hook and declare. Consume W6's src/shared/localForces.ts at your step 6; do not write a second derivation.

**Entry and exit:**
- commandParams with the real interpolated position and heading, context, formation, enemy = 0 legal, no strongest-nation fallback, and battleHandoff when entered from a visible battle;
- tactical clock through ctx.sim.setClock; restore the speed on exit;
- climb above the unit's new position; resync (the occupied stipple reads view.isOccupied).

**Scene:**
- Remove Mission, OP_A/OP_B, objectives and waves.
- New command/stream.ts: chunk grid, LOD rings, floating origin, prefetch, skirts, a 6 ms per-frame build budget, the data worker if a chunk exceeds 8 ms. Travel rate is throttled by stream readiness (halve per frame down to ×1 while the chunk ahead is missing), with the «VIAJE ×300 (limitado por el terreno)» chip.
- New command/civil.ts: towns with place names, villages from sampleNightLights, deterministic roads, rail from view.rail, borders with posts and gates.
- New command/forces.ts: spawning and budgets over deriveLocalForces() pools.

**Sub-tick** (register into W1's game.subStep): the controlled unit and its formation, incursion timers, the victim decision 30-90 game seconds after entry, quick-reaction forces (dispatch, movement, arrival 5-15 game minutes after dispatch), and moves of real units within 30 km. All delays are in game time.

**Control:**
- wingmen; M tactical map and autopilot waypoint; +/- travel compression with the §9.3 contact rules; Tab next vehicle;
- the travel speed limiter: at ×10 and above the vehicle's top speed is the unit's strategic speedKmh.

**HUD** (§9.11): place, land status, INCURSIÓN, clock chip with throttle, alert strip, formation pips, force-source hover.

**Incursions:** approach warning, confirmation, fire-first declaration; aiDirector.onIncursion (protest, intercept, war).

**Sim side:**
- controlledMove with the clamp maxKmh × elapsed game time × 1.1 (snap beyond; reject jumps > 5 km);
- commandCasualties and controlledDamage applied immediately;
- controlled units keep front support; borderIncursion events; automatic return order on exit in foreign land.

**Text:** es/en. **Shots:** command-peace, command-border, command-front, command-travel, command-jet-cap, command-ship-coast; update the existing command shots.

### Acceptance criteria

1. Taking control of a division at peace in own land builds the scene within 1 km of the sim position with its heading; __cmdStats.hostiles === 0; own towns and bases in view appear at real positions with names

2. No objective counter, operation name, reinforcement wave or scripted air strike in any context; every command HUD string exists in es and en

3. Driving 20 km and exiting moves the strategic unit 20 km +-2 km in the driven direction; view.units shows it moving during the drive (>= 1 update per real second)

4. With contact, clock.mode === 'tactical'; over 5 real minutes the sim advances <= 1 tick and no front elsewhere moves > 1 tile; the previous speed is restored on exit

5. Travel in own land, autopilot to a waypoint 300 km away at ×900: the sim advances 75 ticks +-15% during the trip (logical time, no wall-clock target); __cmdStats.missingChunksAhead === 0 at every sample (>= 1 Hz); the chip reads «limitado por el terreno» whenever throttled; compression drops to ×1 on contact, when fired upon, and 2 km before a peaceful border

6. __cmdStats.chunkMsPerFrame p95 <= 6 ms (or chunks come from the data worker); driving or autopiloting 50 km shows no holes or cracks (verifier on command-travel)

7. Crossing into a nation at peace shows the confirmation; borderIncursion is emitted; the victim decision is logged 30-90 game seconds after entry via subStep (also at ×1 between ticks); an intercepting QRF arrives 5-15 game minutes after dispatch; the human gets an incursionResponse alert; alliance or open borders raise no incursion

8. command-front: local pools equal deriveLocalForces() for the same point (no second derivation in src/command); infantry pool = min(40, front garrison share/25) +-10%; every real enemy division within 30 km appears as 1 tank per 25% integrity at its real position

9. Killing N soldiers lowers that nation's troops by N×25 (+-5%) within 2 real s; destroying a real division's tank lowers its integrity 25%; destroying a SAM launcher lowers the site's hp by 0.35

10. Losing your tank lowers the division's integrity 25% and play continues in the next tank (Tab or 3 s); losing the last one destroys the division in the sim and ends command mode with the debrief

11. A patrolling fighter starts at its real position and altitude; enemy aircraft appear only from real covering squadrons or a scramble from an airbase at war within 150 km; foreign airspace at peace triggers the incursion flow

12. A warship at sea at peace shows a calm sea and the real coast; water adjacent to a foreign coast at peace triggers the incursion flow; open sea never does

13. A scripted controlledMove beyond maxKmh×elapsed×1.1 is snapped (logged); a 6 km jump is rejected; in travel mode the vehicle never exceeds its unit's strategic speed

14. Pressing T on a division in a visible ground battle keeps the battle's entities: counts per side at the anchor agree within 10% between the battle view and command mode

15. Esc shows the debrief with synced numbers and climbs to 2500 km above the unit's new position; the view resyncs without artifacts and the occupied stipple is unchanged; tsc and build clean


## W5-command-v2: close-out (2026-09-28)

> Built by the W5 owner; `git log --grep W5`. CODEMAP §17 «v2 as built» maps the code. Verification:
> `npx tsx src/sim/test/command-audit.mjs` (headless, 23/23), `node tools/w5-verify.mjs [--only peace,travel,border,front,jet,ship]`
> (browser, SwiftShader, results merged into shots/W5-command-v2/verify.json), `npx tsx tools/i18n-check.mjs` (now also
> walks src/command and src/app: 1065 keys, none missing), shots `command-peace|border|front|travel|jet-cap|ship-coast`.
> Under SwiftShader a frame takes 1-3 s and the local step is clamped to 0.1 s, so checks stated in real seconds are
> reported, not asserted; game-time checks are exact.

1. **Entry at peace** (E1-E3): scene at 0.000 km from the sim position, «Territorio propio · en paz», 0 hostiles,
   23 towns / 12 roads / the army base around Zaragoza (command-peace). PASS.
2. **No scripted content** (E4 + i18n): no objective / wave / operation / air-strike text in the page; mission.ts and
   its strings removed; every command string in es and en (206/206). PASS.
3. **Drive 20 km** (D1): autopilot to a waypoint 20 km east at ×60: local 19.36 km, sim 19.32 km, gap 0 at arrival
   (drops to ×1 on arrival). PASS. View updates: 16 distinct sim positions in 66 real s (SwiftShader frames; moves are
   sent every 200 m or 1 s of frames).
4. **Tactical clock** (K1-K2): 25.4 game s in 30 real s, 0 ticks; exit sets the strategic clock and the speed chosen
   before is untouched (X2). PASS (30 s sampled, not 5 min).
5. **Travel ×900** (T1-T3): ×900 accepted with a waypoint; 28,779 game s → 80 ticks (expected 79.9); missing chunks
   ahead 0 at every 1 Hz sample; throttled while the terrain lagged (chip «limitado por el terreno»); 96 km travelled
   in 150 real s with the sim unit 0 km from the local one. PASS. The contact / fire / border drops exist
   (`dropToTactical`) but were not triggered in this run.
6. **Chunks** (T4): main-thread chunk work p95 2.2 ms, meshes built in the two terrain workers. PASS. Holes/cracks:
   judged on shots only (masks + skirts), no automated crack check.
7. **Incursion** (B1-B5 + audit I1-I3): warning at 1.5 km, the confirmation before the line (no incursion in the sim
   until «Cruzar»: fixed a move that slipped across before the answer), `borderIncursion` entered, protest 47 game s
   later via subStep with 0 ticks, the protest alert in the command HUD; QRF arrival 5-15 game min, open borders raise
   nothing (audit). PASS.
8. **Front forces** (F1, F1b): infantry shown 40 = min(40, 1206); pools equal `__localForces` (deriveLocalForces) at
   the same point; the real enemy division drawn as 4 tanks at its position. PASS.
9. **Kill sync** (F2, F3 + audit C1): soldier −25 troops, tank −25 % of its division, SAM 0.35 (audit). PASS (applied
   within the 2 s flush; real-time latency not asserted).
10. **Own losses** (F4, F5 + audit C2): −25 % and the next tank; the last one destroys the division, debrief, map. PASS.
11. **Jet** (J1-J2 + audit J1): 9,000 m at the real position; enemy aircraft only from squadrons (none airborne in the
    staged run, so J2 is vacuous); foreign airspace at peace raises a jet incursion (audit). PASS with that caveat.
12. **Ship** (S1 + audit S1): off Málaga in own territorial waters, calm sea, the real coast on the horizon; water next
    to a foreign coast at peace raises a ship incursion, open sea never (audit). PASS.
13. **Move clamp** (audit M1-M3): snapped beyond maxKmh × elapsed × 1.1 (logged), a 6 km jump rejected; travel checks
    the strategic 40 km/h. Change: a jump is now «> 5 km and > 2× the allowed distance», because travel at ×900 moves
    several km per message. PASS.
14. **Battle hand-off**: `commandParams.battleHandoff` from W6's `BattleApi.handoff()` caps the local infantry per side;
    NOT verified in the browser (needs a visible ground battle, T, and counts on both sides).
15. **Exit** (X1-X2): the report, then the camera at 2,500 km above the unit's new position (lat/lon within 0.01°),
    unit released, strategic clock. tsc and build clean. The occupied stipple after exit was not checked. PASS except
    that item.

Known limits: trains are simple boxes on view.rail; a docked squadron starts just after take-off; a floating-origin
rebase can make the texture noise pop; enemy aircraft in the jet front shot depend on real airborne squadrons.

## W5-command-v2: owner feedback #18-#21 (2026-09-29)

> `git log --grep "W5"` from b1d4e79 on. Headless `npx tsx src/sim/test/command-audit.mjs` 29/29; browser
> `node tools/w5-verify.mjs` (sections peace, travel, border, front, jet, ship, drops, escortsim, release, jetrelease,
> handoff; results in shots/W5-command-v2/verify.json); shots `command-escort`, `command-jet-intercept`.

* **#18 release keeps position** (`units.ts holdAfterControl`): no walk back, no return to base. A division holds (or
  goes back on the line if it stands on its war front), a warship keeps station, a jet flies a CAP over the spot
  (orbit ≈ 90 km, the game's CAP radius). Inside foreign land the incursion keeps running on the strategic map with
  the same game-second timings (strategic ticks advance it in 10 s steps) and an alert says the unit is still there.
  Verified: R1 (0.000 km moved after 20 s of strategic time, incursion still running), R2 (alert), R3 (CAP, alt > 0).
* **#19 fast, sensible response**: radio warning at the moment of entry with a countdown (grace 30 s land / 25 s air /
  40 s sea / 15 s within 80 km of the capital; time compression blocked during an incursion), then real forces from
  real bases: fighters (an airborne squadron within 300 km or the ready squadron of the nearest airbase within 800 km,
  moved along the track) in 1-3 min, a ground patrol from the nearest post / town / base in 1.5-5 min, a warship or a
  port's patrol boat in 2-7 min; then a last warning (90 s land, 45 s air, 90 s sea, 30 s at the capital) and fire
  (`engage`: its forces and SAMs fire at the intruder; 30 min of it = war) or war by personality / opinion. Verified:
  B4 radio at once, B5 answer at 30.1 game s, B6 5 min, B8/B9 last warning then engage; audit I1-I4, J2 (fighters
  from a real airbase in 3.0 min), S2 (sea: protest when nothing is in reach).
* **#20 escorts**: 2 APCs (or a tank and 2 APCs from an army base), fighters in ICAO positions (leader ahead-left,
  wingman back-right, wing rock on arrival), a ship abeam; the Brain drives them to stations around the intruder at
  ≤ 55 km/h with a 35 m keep-out; far away they follow the sim's road schedule; they never fire until `engage`/war;
  firing on them first stays an act of war; a blocker backs up or pulls aside rather than turning in front of the
  intruder, and goes round it (75 m abeam) to reach a station ahead. Verified: B7 (≤ 15 m/s in sight, neutral until
  told) and B10 (90 local s with the intruder driving straight at the blocker: 0 m/s of escort motion toward it inside
  40 m, ≤ 15 m/s, turns ≤ 64°/s, both at their stations 50-66 m away when it stops). Under SwiftShader local physics runs ~10× slower than real time, so
  the close-in approach is verified in local time (B10), not wall time.
* **#21 entry matches the world**: every real division, ship, squadron and quick-reaction force in the scene is named
  where it stands (world labels, red/amber/blue by relation), so the units seen on the map are findable; from a
  visible ground battle the hand-off keeps both sides' infantry with one scale into the scene's 240-a-side budget
  (H1) and the battle's real divisions with the same tanks (H2).
* Other criteria re-run: E1-E4, K1-K2, D1, X1-X2, T1-T4, B1-B3, F1-F5, J1-J2, S1 pass; T5a (drop to ×1 at 2 km from a
  peaceful border) and T5b (no compression with contact) now verified. Not verified: the occupied stipple after exit
  (criterion 15), a 5-minute tactical sample (30 s sampled). D2 logs snapped moves during ×60 autopilot under
  SwiftShader (the catch-up step); the sim ends 0 km from the local unit.

## W5-command-v2: fix pass 1 (2026-09-29) — verifier failures 14/#21, #20, #24, 3, #18 (air), 11

> `git log --grep "W5 fix pass 1"`. CODEMAP §17 «W5 fix pass 1». Browser results merge into
> shots/W5-command-v2/verify.json (`node tools/w5-verify.mjs --only handoff|escortsim|border|peace|jetrelease|jetsources`);
> headless `npx tsx src/sim/test/command-audit.mjs` 32/32 and `npx tsx tools/w5-escort-sim.ts a|b|c`.

1. **Criterion 14 / FEEDBACK #21 — the battle's entities, one for one (no rewording of the criterion).** The battle's
   hand-off now carries every living soldier it draws with its position (`BattleHandoff.soldiers`, from
   `infantry.exportAlive`) and the battle camera's pose. Command mode spawns all of them where they stood: the ones
   within 1 km of the vehicle as full entities with the AI, the rest in a cheap instanced crowd (`world.ts
   updateCrowd`, scaled with distance and tinted toward the nation colour like the battle view's masses) that wakes as
   the vehicle comes near (and sleeps again beyond 1.4 km); the fallen are replaced from behind their line. Entry shows
   the battle: the first view is the battle view itself (held 2.2 s, then a glide down to the vehicle), the vehicle
   faces the battle, a world label «Combate · Suiza contra Comandante · 3.226 soldados en la línea · 15 km» stands on
   it and a notice says where it is («La batalla que mirabas está a 15 km al norte…»). In the battle view a division's
   marker is clickable (selects it) and T with nothing selected takes command of your division nearest the line.
   Verified in real play (front-ground-real, live, T pressed in the battle view): **H0** T enters command mode;
   **H1** battle 2,627 Swiss / 599 own soldiers → command mode 2,627 / 599 (0 %), side centroids 0 m apart;
   **H2** division 90 with its 4 tanks; **H3** the vehicle faces the battle (0°), notice shown;
   **H4** (vehicle put 600 m from the soldiers' centre) 265 Swiss and 195 own soldiers woke with the AI, 2,362 and 404
   stayed in the crowd, totals unchanged. The division itself is 15 km from the battle's centre in the sim (its real
   position; a teleport would break the move clamp and the strategic map), which is why the entry frames the battle
   and points the vehicle at it instead of moving the unit. Shots h0-battle / h1-first-view / h2-command / h3-near-line
   in shots/W5-command-v2.
2. **FEEDBACK #20 — escorts.** `ai.ts escortVehicle` rewritten in the intruder's frame: from behind or beside it the
   escort overtakes in a lane 65 m to one side (never through the intruder), then merges into its station at ~45°;
   its speed is the intruder's plus the gap along the course (≤ 55 km/h), so it closes on a moving station and then
   holds it; ahead of its station or facing the intruder it pulls off to the roadside on its side, turns there and
   lets it come up; it backs up only when the intruder has stopped; within 40 m it never moves toward it. The verifier's
   old B10 moved the intruder twice (the tank controller's own coasting on top of the scripted 8.3 m/s: it was really
   driving at ~60 km/h); now it moves exactly 30 km/h. **B10b** (new): both escorts ≤ 60 m from their stations from
   45 to 60 local s — measured 0 / 0 m (lags 53 → 8 → 2 → 0 m by 30 s). **B10**: ram 0 m/s, ≤ 14.1 m/s, turns ≤ 34°/s.
   The radio says «Aquí la patrulla… no sigas avanzando» only with a vehicle within 150 m (600 m air, 1.5 km sea); until
   then «Patrulla de Suiza, a 2,9 km de ti y acercándonos…» — **B8b**: 90 samples, 0 mismatches in the wall-clock
   border run (where SwiftShader's ~10× slow local physics still keeps the patrol ~800 m out).
3. **FEEDBACK #24 — alert strip.** `overlay.pushAlert` keeps one row per alert (same severity and title): a repeat
   refreshes the row with «×n»; at most 3 rows, each fading out after 12 s; the strip moved to the top right under
   the exit button, clear of the compass tape and the heading (h2-command.png: one row «×15»).
4. **Criterion 3 — measured in simulated time.** Moves go out every 200 m, every real second or every 0.5 local
   second; `__cmd.cadence()` counts moves sent and changes of the unit in the sim view per local second of ×1 driving.
   **D2** PASS: 8 whole local seconds, ≥ 7 moves and ≥ 5 view updates in every one of them.
5. **FEEDBACK #18 (air) — holding at the spot, shown.** A released aircraft gets the order «hold»: it orbits 12 km around
   the spot (its 150 km patrol circle keeps intercepting) for 12 game hours (fighters; bombers 16, drones 24: the
   squadron rotates aircraft with its base), then flies home to refuel (to the nearest own airbase if its own is gone;
   with none anywhere it stays on station). The card reads «En espera sobre Zaragoza · autonomía 12 h» and explains
   it; the map draws the 12 km holding ring at the spot inside the patrol circle; the exit dialog says so. Verifier
   waits on `commandExit`. **R3** 11.4 km from the release point, order hold, **R3b** card text PASS; audit **J3**
   (12.0 km max in 20 ticks, endurance 120 → 100, home at the end).
6. **Criterion 11 — both sources staged.** Shot `command-jet-sources`: at war, an enemy squadron docked at its
   airbase 100 km away and another on patrol whose circle covers the fighter. Two fixes found by it: a scrambled
   squadron's group was dropped (and its jets despawned) on the next 2 s refresh, and a covering patrol farther than
   80 km was skipped because the shared derivation lists it as «near». **J2** PASS: 6 enemy jets, 3 from the scramble
   (unit 48), 3 from the patrol (unit 49), none from anywhere else.

Not changed: the verifier's handoff-real.mjs counted `world.ents` soldiers with `src.kind === 'pool'` — the hand-off
soldiers are exactly that (`dormant` marks the far ones), so the same script now counts them.

## W5-command-v2: fix pass 2 (2026-09-29) — verifier failures #18 (R1/R2), #20 (B7), 15, #24/#21

> `git log --grep "W5 fix pass 2"`. CODEMAP §17 «W5 fix pass 2». Browser: `node tools/w5-verify.mjs --only
> release,releaseout|border|handoff` (merged into shots/W5-command-v2/verify.json); headless
> `npx tsx src/sim/test/command-audit.mjs` 35/35 (new I1b, I5, I6).
>
> Final runs on HEAD (SwiftShader, one section per session): release + releaseout **9/9** (X3, X4, R0, R1, R1b, R2, R4),
> border **12/12** (B1-B9 with B7, B7b, B8b), handoff **7/7** (H0-H5), peace **11/11** (E1-E4, K1-K2, D1, D2, X1-X2);
> audit 35/35; `npx tsc --noEmit` and `npm run build` clean; i18n-check 1117 keys, none missing.

1. **FEEDBACK #18 — a unit left inside foreign land.** Three causes, three fixes. (a) *Proportional fire*: the flat 5 %
   per game minute is gone; a released unit under `engage` loses `1/90 × firepower ÷ its full strength` per game
   minute, with firepower in tank equivalents of what is really there (patrol APC 0.25, the tank leading a force 1, the
   squadron/warship carrying it, victim divisions within 3 km, SAM cover for aircraft). Two APCs take ~4 % of a
   division before the half hour of fire turns into a war. (b) *Time to react*: releasing a unit inside raises the
   critical row «Tu 1.ª División acorazada sigue dentro de Suiza» once the map is live and **pauses the game** (new
   auto-pause kind «Tu unidad dentro de otra nación», on by default, in Ajustes › Juego); the last warning and the
   opening of fire against a released unit are critical and pause too (the alert centre now also pauses when a
   grouped row turns into a different event). The row's body says what is happening (warned / under fire / at war)
   and how to get it out (click the alert to select it, right-click own land). (c) *Ordering it out works*: a released
   unit whose order takes it out of the victim's land is «leaving» — the victim holds its fire and all its clocks
   (grace, last warning, the half hour to war) while it drives out under escort; out, the rows clear and «Tu … ha
   salido de Suiza» is said. The «sigue dentro» row clears when the unit leaves or dies (bus `alertResolve`); if the
   incident became a war it stays, as a war row, until the unit is out or lost. An explicit «hold» is no longer
   overridden by the idle front attach (the division stays where it was left even at war).
   **R0** paused with «sigue dentro» on exit; **R1** 0.000 km moved after 20 s at ×1 (the verifier resumed without acting);
   **R1b** integrity 0.96 after the patrol's fire; **R2** the incident became a war after its half hour, the unit is
   still inside and the row says so; **R4** paused on exit, ordered home (unitOrder move, as a right-click on own land),
   resumed with the banner's button: out of Suiza, integrity 100 %, no war, «ha salido de Suiza» shown.
   Audit **I5** (36 game min under fire: ≤ 10 % lost or war), **I6** (ordered out: leaving, out, no damage, no war).
2. **FEEDBACK #20 — the last warning waits for the escort.** In command mode the sim's arrival no longer starts the
   countdown: the incursion waits (`awaitingAlongside`) until the client reports a vehicle of the force within station
   range in the scene (`escortAlongside`: 150 m on land, 600 m in the air, 1.5 km at sea; a force the scene could not
   place at all is reported after 20 s; the sim falls back after 30 game min). The radio says «a 2,2 km de ti y
   acercándonos» with no countdown until then. `forces.ts track()`: within 3 km of the player a sim-driven vehicle
   moves at most 55 km/h and only by the local frame's time (no catch-up jumps in view); a far catch-up step stops at
   the edge of sight. Border run: **B7** PASS (448 samples within 1.4 km, max 15.3 m/s, min 54 m, APCs, neutral),
   **B7b** PASS (countdown started with the nearest escort at 113 m, 212 game s after the sim's arrival, when it was
   2.2 km out), **B9** engage 298 s after the sim's arrival (= 88 s after alongside, the 90 s warning).
   Note: SwiftShader runs the local physics ~10× slower than real time while the sim's clock keeps real time; the
   border loop now tops the local world up by one local second per wall second (`__cmd.simulate`, no rendering) and
   samples after rendered frames. On a GPU the escort drives the last 3 km in ~3 min.
3. **Criterion 15 — exit.** Behind the fade the camera is set 60 km above the unit before the climb (the entry pose at
   3 km over the battle's hole in the globe rendered a void) and the fade lifts after three rendered frames: **X3** the
   centre's mean luma after the fade lifts 106-121 in every frame. The debrief's game time is the sim's command clock
   since entry: **X4** «0 min 56 s» vs 56.1 s.
4. **FEEDBACK #24 / #21 — one distance, no repeats.** The distance to a watched battle is measured to one point, the
   middle of the soldiers the battle view draws (`shared/geo.ts battleCentre`), and says so: the entry notice («a 15 km
   al norte (distancia a su centro)»), the HUD line («Territorio propio · combate con Suiza a 15 km»), the battle's
   world label («Combate · Suiza contra Comandante | 3226 soldados en la línea · 15 km», the overlay's distance to the same point) and the battle view's off-screen division marker («a 15 km del
   combate»). Otherwise the HUD says «línea del frente con Suiza a X km». Entering from a battle more than 1.5 km
   away sets the waypoint on its near edge at once. The command strip no longer re-pushes the same alert while the sim
   stands still, and `news.ts` refreshes an offensive entry only when the sim tick has moved. The `command-front` shot
   is staged on flat ground (41.8° N, 1.3° W): the sim reads the precise line under the unit before the walk, and the
   frame faces enemy infantry in line of sight (a kill and the enemy's fire arc in frame, the real enemy division
   labelled). **H5** (front-ground-real, T in the battle view): notice 15 km, HUD «combate con Suiza a 15 km», world label 15 km, measured 15.3 km, waypoint at 14.65 km (its near edge); H0-H4 still pass (2,627 / 599 soldiers one for one, 4 tanks, facing 0°, 274 / 199 woken near the line). The battle view's off-screen marker of the same division reads «▣ 1.ª División acorazada · Comandante · a 15 km del combate» (its centre distance 15.3 km; the Swiss division's «a 11 km del combate», 11.4 km — the old «12 km» was measured to the battle patch's origin).

## W6-battle-clarity: close-out (2026-09-28)

> Built in full by the W6 owner; commits 8379fc2 … (see `git log --grep W6`). CODEMAP §6 «W6 battle clarity» maps the code.
> Verification: `npx tsx src/sim/test/w6-audit.mjs` (headless, 7/7) and `node tools/w6-verify.mjs` (browser, SwiftShader,
> real staged wars), results in shots/W6-battle-clarity/verify/results.json. Summary per acceptance criterion:

1. **front-orbit** (V1a-c): two-colour band, chevrons in the sign of `momentum`, operational arrow 295 km wide for a
   295 km corridor, badge «CHE ▶ TÚ · ▶ 2,6 km/h · ▣2 ▣2» with the bar = Pa/(Pa+Pd) to 0.001. PASS.
2. **Chevrons follow momentum** (A2): momentum is now the fast EMA of the per-tick pressure each side's offensive adds
   (`sim/fronts.ts`, `Attack.pushThisTick`); a defender given 3 M troops that counter-attacks flips the chevrons in
   10 ticks. PASS (headless; the overlay draws `sign(momentum)` beyond ±0.1, V1a checks that mapping in the browser).
3. **Quiet dashed / mobilization arrows** (V3a-b): 2 pulsing arrows on the aggressor side during a 400-tick window, the
   quiet front dashed; 0 arrows after `mobilizeUntilTick`. PASS.
4. **Guerra panel** (V4a-f, A4a-e): G opens it; both garrisons on quiet fronts; Ir flies there; Prioridad alta sets
   priority 2 and raises the target share (0.77 → 0.86 with two fronts; with a single front the tooltip explains it
   already holds every field troop); Gf rises over ~60 ticks (A4c, 79 % of the 120-tick rise by tick 60); alta/baja
   during an enemy mobilization gives 1.50× the passive garrison (T34 via the panel's own command); Proponer paz opens
   W3's terms dialog; Pedir ayuda sends W3's call to arms; Contraofensiva launches ours and Retirar ends it (A4e:
   11.1 % loss, the sim's 10 % + rounding). PASS.
5. **Stable keys** (A5): 100 % of 120 samples over a 600-tick offensive. PASS.
6. **front-600** (V6a-b): smoke/haze 0.1 % of the screen whiter than the same frame without the battle layer; 20
   flashes, farthest 0.45 tiles from the line; ≤ 6 columns per front. PASS.
7. **plume-zoom** (V7): 3.7 % of the screen height at 700 km, 7.6 % at 200 km; world 7.5-8.3 km (≤ 20). PASS.
8. **front-ground-real** (V8a-c): infantry deployed = visibleSplit exactly (e.g. 1629/422); every real division within
   50 km drawn as 4 tanks + 2 IFVs, centroid within 57 m of its real position; drawn line = sim line. PASS.
9. **front-observation** (V9): clock `observation` (rate 60), the line moves continuously with 0 tile jumps at 37.9 m/s
   against advanceKmh × rate / 3.6 = 43.6 m/s (−13 %), on the plains theatre on the offensive's axis. PASS in the final
   run, but see the note below: earlier runs measured −20 to −35 %.
10. **Animation clock** (V10): battle time runs on wall time (not the 0.1 s-clamped frame dt), frozen on pause:
    1.000 s per real second at both 0.5x and 4x, 0 when paused. PASS.
11. **Banners and strip** (V11a-b): «Suiza · ataca» / «Comandante · defiende» and «Frente de Zaragoza · CHE Suiza (ataca)
    506.100 ▶ TÚ 160.300 Comandante (defiende) · avance 1,5 km/h · 2.º día de combate»; English «Zaragoza front …
    2nd day of fighting». PASS.
12. **Audio** (V12): combat cues capped at 2/s per front and 6/s in all (`__fuAudio.stats().combat`: max 2/s, 1 dropped
    in 60 s at 300 km, with `&audio=1`). PASS.
13. **Overlay** 2 draw calls, preallocated buffers; localForces test 56/56; tsc and build clean for W6's files.

**Note on T41 (criterion 9).** The battle line is the sim's sub-tile line (`FrontView.progress`, published near the
observation focus): the median offset of the polyline's vertices within 45 km of the anchor, read 4 times a second
over a 30 km window, glided from tick to tick (6 real s per tick in observation time) and never faster than 1.5× the
measured advance, so it moves continuously and never jumps a tile; the battle re-anchors (fade) once the line is
4.5 km from the patch centre. Two sim-side limits remain for W1/W7: (a) the published sub-tile polyline is noisy (its
1.5-tile bins re-form when a tile falls, and the median still jumps by several km between ticks), and (b)
`advanceKmh` is an EMA of fallen AREA over the corridor width, maxed over the front's offensives with a slow decay;
notch mop-up and caps make it read higher than the line's real depth speed (the raw sub-tile line averaged 25-40 m/s
where advanceKmh said 39-61 m/s). Suggested follow-up: publish one smoothed depth offset per front near the focus and
measure `advanceKmh` from it, so badge, panel, strip and battle agree by construction.

**Verification runs** (SwiftShader, 0.2-0.8 fps at ground level, shots/W6-battle-clarity/verify*): the last full run
passed 18/23; its five failures were verifier/staging issues (division count check, a banner correctly hidden behind a
HUD panel, a slow ally treaty, window alignment at 0.3 fps) and the T41 note above; after the fixes, orbit + panel +
audio + ground (17/17 except V9), mobilization (2/2) and observation (2/2) passed. Headless `w6-audit` 7/7.

**Open:** the sim-side T41 follow-up above. (`BattleApi.handoff()` is already passed by the app into
`CommandEnterParams.battleHandoff` and read by W5's command/forces.ts.)

## W6-battle-clarity: fix pass 1 (2026-09-29)

Verifier failures 8, 9, 11 and the language regression, fixed and re-verified: `node tools/w6-verify.mjs --obsRuns 3`
on a no-HMR server gives **31/31**, 0 page errors (shots/W6-battle-clarity-fix/verify/results.json).

- **T41 (criteria 8, 9).** `sim/frontLine.ts` publishes one smoothed depth offset per front (`FrontView.line`: every
  tick at the observation focus, every 5 on the lead offensive's axis) and `advanceKmh` IS that offset's speed, so the
  badge, panel, strip and battle agree by construction. The battle draws that line (interpolated to the drawn tick,
  snapping when > 2 km off, the tile-level crossing when a front has no published line). New battle anchors, including
  re-anchors while the line moves, now stand on the published line rather than on the tile-level one (up to a tile
  behind it). V8c against an independent FrontView reading: Δ 0 m; new V8d re-checks it at every one of 44 samples
  through each observation run: max Δ 0-4 m. V9 in 3 consecutive runs: −5.1 %, −7.4 %, −10.5 %, 0 jumps.
- **Staging.** front-ground-real is the Zaragoza front every run (fastForward staging, a division per side at the
  axis, HUD-aware framing). front-observation uses the same theatre: the camera 1.5 km behind the defenders facing the
  attack, the contact line and its soldiers mid-frame, and (shot only) a cameraman that pans with the line, which moves
  1-8 km per real minute under observation time. Fronts are named by a real place («Frente de Zaragoza»).
- **Banners (criterion 11).** V11a fails on any hidden banner; the new V11c checks both banners and the strip in the
  observation shot (3/3 clear). Banners get a third spot 450 m behind their line, for a camera low over its own side.
- **Bare globe under a low camera.** A battle re-anchored on the same front below 24 km is now swapped in one frame
  instead of fading out and streaming in over several frames, which showed the globe's flat, speckled surface.
  Under SwiftShader that frame takes seconds; on a GPU it is one longer frame.
- **Language switch (W1/W3).** The day label, alert buttons, ages and «Prioridad alta» labels repaint (V11b «DAY 3»,
  SHOW, HIGH PRIORITY). Alert titles and bodies keep the language they were reported in, like a news feed (W3's design).

## W6-battle-clarity: fix pass 2 (2026-09-29) — owner items #22, #23 and FEEDBACK #11 in real play

**Owner item #22 overrides the acceptance wording «an operational arrow as wide as the corridor (±15 %)»** (criterion 1
and the brief's overlay bullet): the arrow must not hide the front. Built and verified (shots/W6-battle-clarity-fix2/):

1. **Operational arrow** (`render/battle/overlay.ts`): a slim semi-transparent shaft (≤ 5 % of the corridor, clamped
   to 3.6-6 px) with a proportional head (3×) whose tip lands ON the axis point (plus a small ring there), the corridor
   as two faint dashed rails instead of a filled body, drawn under the front bands (renderOrder 42 < 43) and knocked out
   wherever a border or coast passes under it (the fragment samples the territory owner texture, so every border stays
   drawn), fading from 1,700 km and gone below 1,000 km. The corridor is never wider than its front
   (`AttackSystem.frontageOf` caps it at `Front.length`, `predictOffensive` too; the 16-tile front of the evidence got a
   40-tile corridor because frontage was bought with troops only). **V1b now measures the drawn pixels**: the arrows
   batch alone is toggled (every layer above it and the DOM HUD hidden for those frames, two frames per state so
   animation is excluded), then the shaft width across the stroke, the tip of the connected stroke against the projected
   axis point, the screen share and the draw order. **V1d**: arrow alpha 0 at 1,000 km. Result: see the table below.
2. **Contraofensiva / Retirar** (`sim/attacks.ts`): an offensive whose corridor loses contact (our own line fell back
   behind its origin: the evidence's «cancelled, ratio 0.08») re-forms on the contact nearest its axis point
   (`setAxis`) instead of dissolving; a launch with no contact in its corridor is refused up front with
   `msg.offensiveNoContact`; any sim end of a human offensive other than Retirar is told (`msg.offensiveNoContactEnded`,
   `msg.offensiveEndedPeace`); a broken human offensive (R < 0.5 for 60 ticks) no longer withdraws behind the player's
   back: it halts and holds the line with `msg.offensiveHalted` (the AI and the human autopilot keep the retreat).
   The panel's «Ofensiva…» aims 2-3 tiles into enemy land found along the front (never water or our own land), with the
   reason in the tooltip when no stretch faces enemy land. **V4f is robust**: launch from the panel, check the
   offensive is still running 40 ticks later (V4f1), change its intensity from the row (V4h), press Retirar and measure
   the troops that come home on the tick they arrive, in the browser (V4f).
3. **Owner item #23 (attack flow)**: `ui/hud/offensiveDialog.ts`. A click on enemy land at war (and the radial's
   Atacar, and the panel row's «Ofensiva…») opens the offensive dialog: front and objective place, troops 25/50/75/100 %
   of home troops, intensity (Sostenida / Asalto total; Mantener la línea for a running one), and the preview recomputed
   live: troops, the enemy garrison on that front, force ratio, attack width, expected km/h on plains, time to the
   objective, casualties per game day on both sides (§4.6), a verdict (advance / grind / will stall and hold). One
   «Lanzar ofensiva» sends one order; the offensive persists by itself. The Guerra panel row shows «Tu ofensiva: 65.000
   · Sostenida · relación 0,3 : 1 · manteniendo la línea» with Mantener la línea (= detener) / Sostenida / Asalto total
   (`offensiveIntensity`, sim: hold = no push, a quarter of the casualties, no stall/break clock; assault = +25 % power,
   +60 % own casualties), «Gestionar…» (reinforce with a chosen share, which also moves the axis) and Retirar. The badge
   opens that row. Shift+click keeps the instant launch for experienced players (said in the hover card). Tutorial step
   «Cómo se ataca» on the first war; tooltips on every control. `w6-audit` A7a-d (headless): corridor capped at the
   front (12.0 tiles on a 12-tile front with 1.6 M troops), assault ×1.250 power, hold pushes 0, a broken offensive holds
   with the message, and re-forms when its origin loses contact. **#23 is done** (W6 owns the fronts UI).
4. **FEEDBACK #11 in real play** (`render/battle/index.ts`, `ui/hud/battleStrip.ts`): a battle is built only under the
   view target (≤ max(8 km, 2.5 × altitude)) or in front of it on screen (≤ 5 × altitude + 4 km), never 44 km away
   outside the view; the **battle pointer** («➤ Frente de Zaragoza · la batalla está a 32 km [Ir a la batalla]») names
   and points to the battle when the camera is low and not looking at it, and its button glides down to 3 km facing the
   line from our side; a low, still camera over a built battle whose line is out of view or far down the view settles
   onto the line once per battle (keeping altitude, tilt and heading). The panel's Ir flies onto the published line.
   **V14** (new, no shot framing): V14a «Ir» then the mouse wheel to ~2 km; V14b camera put down 35 km behind the line;
   V14c the pointer's button. Soldiers counted on screen by projecting 200 per side with the game camera
   (`__battleDebug.soldiersOnScreen()`), banners by the HUD state.

**Results** (`node tools/w6-verify.mjs`, SwiftShader, no-HMR server; `npx tsx src/sim/test/w6-audit.mjs` 13/13;
`pace-audit depth` 7/7 and `attrition --mult 2` 1/1 with the corridor cap):
* orbit **15/15** (shots/W6-battle-clarity-fix2/v7o): V1b shaft 5 px = 11 km for a 375 km corridor on a 375 km front,
  drawn tip 6.8 px / 16 km from the projected axis point, arrow 0.05 % of the screen, arrows 42 < bands 43; V1d arrow
  alpha 0.000 at 1,000 km; V4g the dialog (ratio, km/h, casualties per day, verdict); V4f1 offensive 121 still running 40
  ticks later with no click; V4h intensity 0 set from the row; V4f Retirar: 65,742 in the offensive, 59,084 home = 10.1 %.
* ground + descent **8/8** (v7d): V8a-c, V11a-b unchanged; V14a battle 0.0 km from the view target after Ir + wheel,
  143/200 and 142/200 soldiers on screen, both banners clear; V14b pointer «Frente de Zaragoza · la batalla está a 32 km»,
  no battle built there; V14c after «Ir a la batalla»: 176/167 soldiers on screen, both banners clear.
* observation **4/4** (v8a, V9 −6.5 %, 0 jumps), mobilization / front-600 / plume **5/5** (v8b), 0 page errors.
* `tools/playtest.mjs` now confirms the offensive dialog after a click on enemy land (not re-run in full here).

## W6 final fix pass (2026-09-29) — W6-battle-clarity, verifier iteration 3 (score 5)

Every open failure of the third verification is fixed and re-verified in the real game (commits 7e8e06a … 24d7ebc,
`git log --grep "W6 final fix pass"`). Results on a no-HMR server (tools/vite.nowatch.config.mjs) with another
agent's browser running beside it: **`node tools/w6-verify.mjs` 40/40, 0 page errors** (shots/W6-fix-final/verify);
**`w6-audit` 20/20**; **`w4-audit --only save` 2/2** (both rows identical); localForces test 71/71; `tsc --noEmit` and
`npm run build` clean.

1. **Save regression (blocker)**: `FrontTracker.lines` (the `FrontLines` published-line state) is view data, skipped by
   the save (FrontTracker skip set, append-only order kept) and re-measured after a load (`focusChanged` + the next
   measurement publishes the line again). `w4-audit --only save` 2/2 identical; new **w6-audit A8** saves in the middle of
   an offensive with a published line: A8a saved (57 KB), A8b the restored game identical right after the load and for
   120 ticks (ownership, offensive, fronts, garrisons, troops), A8c the restored front publishes its line again
   (5.87 / 5.57 km/h). The playtest's save / Continuar step: see the last bullet.
2. **Arrow, axis and km/h while an offensive advances** (`sim/attacks.ts`, `sim/frontLine.ts`, `sim/fronts.ts`,
   `render/battle/overlay.ts`): the offensive's LIVE contact (where its axis ray meets its frontier now,
   `AttackView.contactX/Y`) drives its front key (the front its frontier is on), and its axis point moves forward along
   the advance once the line reaches or passes it (6 tiles ahead on the defender's land, the player told with
   `msg.offensiveObjective` «el objetivo avanza a …»). Each front with a live offensive measures ONE line on that live
   axis (window as wide as the corridor), so `advanceKmh` is the speed of the line the offensive is pushing: a front
   taking tiles never reads 0 km/h. Local forces count the offensive's pool on the front it fights. The arrow's tip
   lands on the axis point whenever it is ahead of the line; while the line stands on it the tip points at most 2 tiles
   ahead and only as far as the enemy's land goes (never onto sea or neutral ground). Headless **A9a-d**: 439 km past
   the origin, key right 67/67, axis on enemy land 67/67 (moved 3 times, told each time), 0 zero readings, 5.25 km/h vs
   4.17 km/h from the fallen area, line at the live contact 67/67, local offensive pool 14/14. **Real play V15**
   (offensive launched from the dialog on the plains theatre, 420 ticks): V15a contact 259 km from the origin (first
   axis point 66 km), key and arrow key = the front nearest the contact 20/20; V15b arrow tip and axis point on enemy
   land ahead of the line 20/20, axis moved forward twice; V15c 0 zero readings of 20, 4.67 km/h vs 4.29 km/h from the
   tiles, badge «TÚ▶GBR ▶ 2,2 km/h»; V15d the ground battle at the contact is on the offensive's front, split 304/1215 =
   our share 0.80 vs the front's troops (0.80 after the clamp). (fastForward drops per-tick messages by design, so the
   browser counts the axis moves from the samples; A9b checks the message.)
3. **Enviar divisiones** (`ui/hud/fronts.ts`): the target is a tile on the ENEMY side of the contact (along the running
   offensive's axis, else the middle of the front outward), which passes `divisionCheck`'s attach rules; a division
   already ordered there is listed «En camino» instead of offered again; the list updates ETAs in place so a row never
   changes under the pointer. **V16a** «3.ª División acorazada · a 710 km al NE de Madrid · 14 h · Enviar [enabled]»;
   **V16b** the click gives order attach (1) and the unit carries front key 1.
4. **i18n of the offensive messages**: the sim sends the player id and the raw ratio (`msg.offensiveNoContact`,
   `…Halted`, `…NoContactEnded`, `…EndedPeace`, `…Retreating`, `…Objective`); the alert feed names the player in the
   language (playerName) and writes the ratio with the locale decimal. Checked in the browser in both languages: «Nuestra
   ofensiva contra Suiza está rota (relación 0,4 : 1)…» / «Our offensive against Switzerland is broken (ratio 0.4 : 1)…».
5. **Ground battle at night** (`render/battle/*`): a moonlight fill with a minimum ambient, illumination flares over the
   line, brighter tracers and fires; both banners always on screen (a side out of view waits at the screen edge with an
   arrow toward it). New **V17** night staging (`&night=1`, the sun on the far side): V17a at the shot framing mean luma
   31, 12 % lit, 151/200 and 158/200 soldiers on screen, both banners clear; V17b at 450 m luma 40, 36 % lit, both banners
   clear (iteration 3's frame: luma 5, < 1 % lit, one banner).
6. **Prioridad alta in the browser**: V4c picks a front no enemy offensive drains and asserts the Gf rise against a
   no-priority baseline: Gf 18,388 → 60,190 after 60 ticks vs 53,868 projected from the 30 ticks before, target share
   0.244 → 0.419.
7. **Verifier robustness** (`tools/w6-verify.mjs`): every section is guarded (an exception is a failed row, the next
   section runs), every click goes through `uiClick` (normal click; on a starved renderer — one frame every 5-10 s with
   another browser busy, where a panel never passes Playwright's stability wait — a hit-tested mouse click on the
   element that is topmost at its centre), Ir polls for the camera to land, V4c re-stages when the front disappears.
   The full run passed with another agent's browser at ~200 % CPU beside it.
8. **Badge and chips** (`ui/hud/frontBadges.ts`, `render/units`): the badge stands off the band's whole screen
   polyline (not only the midpoint normal), clear of the mobilization arrows, the operational arrow, HUD panels and the
   nation names on the map, with a short leader line to the front; division icons from orbit stand beside the band on
   their own side. The reinforce-mode offensive dialog re-reads the running offensive on sim ticks while open.
9. **One source of truth for who holds the ground** (`shared/localForces.ts holderAt`, used by the ground battle, local
   forces and command mode): near our own fronts, inside the published line's window and within 1.5 tiles of it, the
   side of the drawn sub-tile line the point is on; elsewhere the tile's owner. A tank behind our drawn line reads our
   ground in the command HUD even while the sim still counts that 25 km tile as the enemy's (localForces test §6).

**Playtest** (`node tools/playtest.mjs --stage2`, real UI, two wars running at the save): **19/19 steps**, 0 console
errors; «Guardar» from the pause menu, quit, «Continuar»: «Guardado · día 35», tick 8214, 2,277 tiles, 30 treaties,
6 proposals, 24 opinions and 2 wars identical before and after (no worker error). Screens in shots/W6-fix-final/playtest.

**Not done / notes**: nothing open from iteration 3. The objective message is checked headless (A9b) because the
browser verifier steps exact ticks with fastForward, which by design drops per-tick messages; in normal play it reaches
the alert feed (the playtest's offensive logged `msg.offensiveObjective`).

## W6-battle-clarity: brief

**Landed (shared local forces):** `src/shared/localForces.ts` with `deriveLocalForces()` / `deriveLocalForcesAt()` /
`visibleSplit()` per §14.11, its unit test (`npx tsx src/shared/test/localForces.test.ts`), `window.__localForces` and
the texts in `src/shared/localForcesText.ts`; API in docs/CODEMAP.md §6. W6's first commit is done; W5 imports it at
its step 6 and must not write a second derivation.

Stage 3, beside W5, after both W3 and W4. Read DESIGN_V2 §11 (all), §10.12, §2.2 (observation time), §4.3-4.5 (corridors, measured km/h, sub-tile progress), §14.2, §14.5, §14.11 and §16.7. Rows F11, E01, E03.

**FIRST commit:** src/shared/localForces.ts with deriveLocalForces(view, x, y, radiusKm, viewer) and visibleSplit(forces, budget), per §14.11:
- pools: front garrison Gf × window/front length / 25; offensive committed × window/corridor width / 25; rear share; posts;
- real divisions as 1 tank per 25% integrity + 2 IFVs;
- pure, with a unit test on a fixture. W5 imports it.

**Orbit overlay** (render/battle/overlay.ts, ≤ 4 draw calls, above clouds, hidden in command mode):
- bands in both colours, with chevrons from momentum and measured advanceKmh;
- dashed quiet fronts;
- operational arrows (SUPERSEDED by owner item #22, see fix pass 2: a slim shaft tipped on the axis point, the corridor as faint rails, under the bands, gone below 1,000 km); naval invasion arrows; mobilization arrows until mobilizeUntilTick;
- badges: ISO3 chips, tug-of-war Pa/(Pa+Pd), measured km/h or «consolidando», division chips, hover details, click emits frontSelected.

**Guerra y frentes panel** (ui/hud/fronts.ts, G):
- wars: goal, reason, day, escalation, war score, exhaustion; Proponer paz and Pedir ayuda open W3's dialogs;
- fronts: garrisons per side (quiet fronts too), redeployment in progress, momentum, measured km/h, tiles, divisions, time;
- buttons: Ir; Prioridad (setFrontPriority, with its tooltip); Enviar divisiones (W4's Fuerzas filtered with ETAs); Contraofensiva; Retirar;
- Mundo tab; danger sort; W3 tooltips.

**Far layer** (far.ts): flashes and fires inside the band only; smoke caps.

**Ground battle** (battle/index.ts):
- anchor by stable key;
- the line at sub-tile precision from the per-vertex progress field, moving on the sim clock under observation time (133 m per real s at the cap), interpolated at measured advanceKmh;
- forces from deriveLocalForces; real divisions within 50 km; real squadrons, drones and bombarding warships;
- frame.visualDt for animation only;
- banners and HUD strip; patch rim via W2's fill chunk; battleHandoff to command mode.

**Launch plume:** world-sized, with a per-frame minimum-pixel clamp, ≤ 8% of screen height.

**Audio density** caps with W3.

**Shots:** front-orbit, front-600, fronts-panel, front-ground-real, front-mobilization, front-observation, plume-zoom. Use W2's &freeze=1 and &clouds=hidden params for measurements.

### Acceptance criteria

1. front-orbit at 2500 km: the band shows both colours; chevrons point in the advance direction; an operational arrow ~~as wide as the corridor (+-15%)~~ (owner item #22 overrides this wording: slim shaft, corridor as faint rails, never wider than the front) runs from the attacker to the axis point; the badge shows both ISO3 codes, the tug-of-war bar and measured km/h; a reviewer names attacker, defender, direction and who is winning from the screenshot alone

2. Chevrons and the badge bar follow FrontView.momentum: giving the defender enough troops (debug) reverses the chevrons within 20 ticks

3. Quiet fronts draw as dashed two-colour lines; mobilization arrows appear on the aggressor's side during mobilization and disappear at mobilizeUntilTick

4. The Guerra panel lists every war and every front involving the human with garrisons (also before any offensive), momentum, km/h, tiles, divisions and time. Ir flies there. Prioridad alta raises the front's target share and Gf rises over ~60 ticks. Setting alta/baja during an enemy mobilization reproduces T34 (>= 1.5x the passive garrison on the first offensive tick). Proponer paz and Pedir ayuda open W3's dialogs. Retirar ends an own offensive with a 10% loss

5. Front keys are stable: over a 600-tick offensive the badge and panel entry keep the same key in >= 95% of samples

6. front-600 with &clouds=hidden&freeze=1: smoke and haze cover <= 25% of the screen (whiteness against the same frame without the battle layer); flashes appear only within 1.5 tiles of the front line

7. plume-zoom: after a launch from Madrid, the plume never covers > 8% of screen height at 700 km or 200 km; its world size stays <= 20 km

8. front-ground-real: visible infantry per side within +-10% of visibleSplit() (clamped 0.2-0.8); every real division within 50 km appears as 1 tank per 25% integrity at its real relative position; the local line lies within 2 km of the sub-tile front position

9. front-observation: clock.mode === 'observation' and the on-screen line speed = advanceKmh × rate / 3600 km per real s +-15% (T41 line part); the line moves continuously, never in 25 km jumps

10. Battle animation per real second is the same at 0.5x and 4x (+-15%) and freezes on pause

11. Nation banners float above each side's line; the HUD strip shows front name, sides, troops, measured advance and days of combat in es and en

12. __fuAudio.stats() over 60 s near a busy front: <= 2 combat cues per real s per front and <= 6 in total

13. localForces.ts has a passing unit test; src/command has no second derivation of local forces; the overlay uses <= 4 draw calls and allocates nothing per frame; tsc and build clean

## Owner feedback #2 (added while W5/W6 were being verified)

See docs/FEEDBACK-1.md, section "Owner feedback #2", items 18–25 (item 25 added later: fighter/bomber missions — defend a border with CAP, attack the rival, CAS, strikes, escorts — must work end-to-end with visible, explained effects; see FEEDBACK-1.md) (release keeps position; fast, sensible incursion
response with warning + short grace + real interceptors; sensible escorts, no ramming trucks; command-mode entry
matches the enemies visible on the strategic/battle view; slimmer attack arrows that don't hide the front; a clear,
non-click-spam attack flow; small polish). Whoever works on command mode, fronts, integration or gauntlet fixes MUST
treat these as blockers. Order of work requested by the owner: finish the in-flight task, then fix 18–24 properly,
without another endless cycle.

## Owner feedback #3 (added while W5 fix pass 2 was running)

See docs/FEEDBACK-1.md, section "Owner feedback #3", items 26–29:
- 26: reach the action quickly in command mode ("Ir al combate", contact in under ~60 s from a front).
- 27: destroy cities and structures, in command mode and from the strategic map, with damage states, repair and
  consequences.
- 28: real war missions for every unit type (attack zone, defend sector, support offensive X, hold, blockade,
  escort, strike), with previews and measurable effects, also used by the AI.
- 29: team proposals: consistent front numbers, night readability, operations overview with idle-unit advisor,
  after-action reports, take control from anywhere.

The owner played without knowing what was in progress: check each item against the current code, prove what is
already done, and finish what is not. These are handled in the "Feedback 3" round, after Feedback 2 (18–25).

## Feedback #2 results (2026-09-29) — owner items 18-25

> `git log --grep "Feedback #2"`. Headless `npx tsx src/sim/test/air-audit.mjs` **21/21**; browser (real UI, SwiftShader,
> no-HMR server) `node tools/f2-verify.mjs` **air 6/6, chip 2/2**, 0 page errors (shots/feedback2/verify); regression
> audits after the changes: `w4-audit` 43/43, `w6-audit` 20/20, `command-audit` 35/35; `npx tsc --noEmit`, `npm run build`
> and `i18n-check` (0 missing) clean. Browser regressions: see the last bullet.

Items 18-23 were built and verified in real play by W5 fix pass 2 and the W6 final fix pass just before this round
(sections above); this round checked them against the code and re-ran what its changes could touch:

* **18 release keeps the unit where it was left** — `units.ts holdAfterControl`: no walk back, no return to base in
  any case (`sim/command.ts` has no walkBack/returning left); a division holds (or stays on the line of its war
  front), a warship keeps station, an aircraft orbits the spot for its endurance (12 h fighters) with the card and ring
  saying so; a unit left in foreign land keeps the incursion running, pauses the game with «sigue dentro» and can be
  ordered out. Evidence: w5-verify release/releaseout R0-R4, X3-X4, audit I5/I6, J3.
* **19 incursion response in real seconds** — warning at entry with a countdown (30 s land / 25 s air / 40 s sea /
  15 s near the capital; travel mode blocked during an incursion), real fighters from the nearest airbase in 1-3 min,
  ground patrol 1.5-5 min, warship 2-7 min, then last warning and fire. **New this round**: the strategic map can no
  longer send a patrol over a nation at peace without alliance / open borders (`order.err.airspace`, air-audit C5,
  f2-verify C2: «Espacio aéreo de China: sin alianza ni paso libre…»), so the strategic layer has no silent
  incursion the command mode would treat as one.
* **20 escorts** — APCs / a tank at ≤ 55 km/h, lane overtaking, stations, no ramming (B7, B10, B10b), fighters in
  formation; firing on them is an act of war.
* **21 entry matches the world** — battle hand-off one for one (H0-H5: 2,627 / 599 soldiers, the division's 4 tanks).
* **22 slim arrow under the bands** — V1b drawn-pixel measurement (5 px shaft, 0.05 % of the screen, gone below
  1,000 km). **23 attack flow** — offensive dialog with commitment and preview, managed from the badge / Guerra panel.
* **25 air missions, real and meaningful (this round's work)**:
  - *Air superiority*: fighters on a CAP whose circle covers an offensive's corridor count for their side; the side
    with more owns the sky: attacker's advance ×1.10 or ×0.90, and the other side's drone support stops counting
    (the patrol also shoots those drones down). Measured on one plains front, same seed (air-audit C2): baseline
    2.36 km/h / 100 tiles in 300 ticks; our patrol 2.61 km/h (×1.11); the enemy's patrol 2.18 km/h (×0.92); both
    patrols 2.36 (contested); 2 drone swarms in close support 3.37 km/h (×1.43: +15 % power and +15 % speed plus the
    garrison attrition); the same drones under the enemy's sky 2.18 (cas 0).
  - *CAP over a border against the real AI* (C1, the sim-ai director, not a script): 2,400 ticks of AI raids on our
    cities; with two squadrons patrolling the Pyrenees: 3 AI bombers/drones shot down (0 without), 9 strikes reached
    their target (19 without), front bombing 12,750 troops lost (87,633 without); both our squadrons were lost to its
    escorts — the risk is real and shown before ordering.
  - *Escorted strikes* (C3): a bomber destroys a factory (hp 1 → destroyed) and bleeds a front sector (557 troops);
    through an enemy patrol, 12 unescorted sorties: 12 lost, 1 on target; escorted: 5 lost, 7 on target (the escort
    now stays with its bomber all the way home and ties the interceptor up: ×0.3 kill chance, dogfight).
  - *The AI uses the same missions* (C4): strike 12-19, cap 3, escort 3 orders in a war; drones fly close support
    over its own running offensive.
  - *One clear action each, explained before confirming*: Guerra y frentes row «Cielo · cazas en patrulla: 1 tuyos,
    0 enemigos · superioridad aérea tuya (+10 % a tu avance, sus drones no cuentan)» and «Apoyo aéreo» (each aircraft
    with its mission, ETA, integrity and threat — SAM, enemy fighters, airbases — and one button: Patrullar / Apoyar /
    Bombardear); the offensive dialog's «Apoyo aéreo» row (the preview counts the sky and drones as the sim does);
    right-click chips «Patrulla: derriba bombarderos, drones y misiles que entren a 150 km… Riesgo medio: bases
    aéreas enemigas cerca: 1.»; the unit card's order tips. Real play (f2-verify): A1 the list, A2 the tooltip, A3
    one click each gives cap / support, A4 the row shows our superiority once the patrol is on station, A5 the dialog
    row, A6 with time running the AI sends its aircraft and our patrol shoots 2 of its bombers/drones down; C1/C2 the
    chips.
* **24 polish met along the way** — the order chip wrapped nothing and ran off the left of the screen with a long
  line; long explanations now wrap at 22 rem in sentence case (shots/feedback2/verify/c1-chip-war.png). An escort
  used to leave its bomber on the way home (where it was shot down). The AI's escort order was sent with no tile and
  always refused. The «Apoyo aéreo» list stays open after an order so several aircraft can be sent.

**Still open / notes**: the CAP itself does not run out of fuel (the squadron «rotates with its base», said in the
tooltip); only released aircraft on «hold» have an endurance clock. The front badge does not repeat the sky (the
Guerra panel row and the dialog do; the badge has no room). The air effects are flat multipliers per side (not scaled
by the number of squadrons beyond «more than the enemy»).
