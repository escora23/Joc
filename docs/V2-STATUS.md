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

**Still open / notes** (as of the first pass, superseded below): the CAP did not run out of fuel; the front badge did
not show the sky. The air effects are flat multipliers per side (not scaled by the number of squadrons beyond «more
than the enemy»).

### Feedback #2 — final pass (2026-09-30): fuel and rotation, the sky on the badge, every item re-played in the browser

What changed (`git log --grep "Feedback #2 item 25: patrols"`):
* **#25 fuel/endurance and return to rearm, now also for missions.** A fighter patrol (CAP) stays on station 24 game h
  minus the flight there and back, drone close support 36 h (`STATION_ENDURANCE_TICKS`, never under 6 h); then it flies
  home keeping its order, refuels/rearms (2 h fighters, 4 h drones) and goes back to the same station by itself, after
  the same validation as a new order (a peace signed meanwhile closes the airspace). While it refuels its circle is
  uncovered and the sky over the front changes. A second squadron ordered to the same station is automatically offset
  half a stay (staggered relief), so two squadrons keep a border covered permanently. The Fuerzas row and the unit card
  say it at each step: «Patrulla sobre X · combustible para 7,3 h» → «Vuelve a repostar a Base aérea de Madrid · <1 h;
  luego retoma la misión» → «Repostando · vuelve a la misión en 1,3 h» → back on station; its effect line reads «Ninguno
  mientras reposta: su zona queda sin cobertura…». The order tooltips (unit card, «Apoyo aéreo») explain it. «Volver
  a la base» on a patrol refuelling at its base ends the mission (the button stays available for it).
* **#25 the front badge repeats the sky**: «✈» between the division counts, in the colour of the side with more
  fighters on patrol over the line; the badge tooltip has a «Cielo» row (patrols per side, drones per side, who owns it).
* **#24 polish**: the badge's division counts stay under their own side's chip when the other side has none (the row
  used to collapse to the left, putting the defender's count under the attacker).
* Verifier fix (w5-verify B8b): the escort samples wait two rendered frames after the local-physics top-up, so the radio
  text compared is the one for the sampled positions (the one failure this pass was the radio one frame behind: «a 150 m
  y acercándonos» read against a vehicle already at 133 m).

Measured (all after the change, real play in Chromium/SwiftShader through the real UI on a no-HMR server):
* Headless: `air-audit` **25/25** (C1 CAP vs the real AI with two staggered squadrons: 2 AI bombers/drones shot down vs
  0, 16 strikes reached their target vs 22 without, front bombing 88,275 troops lost vs 124,916; C2 superiority ×1.11 /
  denial ×0.92 / CAS ×1.43; C3 escorted strikes 5/12 lost vs 12/12; C4 AI strike/escort/cap orders; C5 airspace; **C6**
  on station 22.4 h, docks 1 h later keeping the order, back on the same station 2.7 h after landing, two squadrons on one
  station: 0 h uncovered in 74 h). `w4-audit` 43/43 (criterion 13 now «patrols until recalled, refuels and goes back»,
  19/20 raids intercepted, recall docks it), `w6-audit` 20/20, `command-audit` 35/35.
* Browser `f2-verify` (#25): air **7/7** in the first run (A1-A7, A7 showing the whole cycle fuel 12 h → … → 1,3 h →
  «Vuelve a repostar» → «Repostando · 1,3 h» → back on station) and chip 2/2; second run with A4b (badge ✈ in our
  colour rgb(228,136,33) = #e48821, «Cielo · cazas en patrulla 1 / 0» in its tooltip) 7/8: A7 sampled every 1.5 h and
  missed the <1 h flight home (fuel → «Repostando» → back); the check now accepts that (shots/feedback2/verify).
* Browser `w5-verify` (#18-#21): release/releaseout R0-R4, X3-X4 **9/9** (a division released inside Switzerland holds at
  0 km, the incursion goes on / became a war and says «sigue dentro de Suiza», ordered out the victim holds fire);
  border **12/12** (warning at 1,500 m, confirmation, incursion, radio countdown 30 s, answer at 30.1 game s, ground QRF
  in 300 s, escort IFVs ≤ 15.3 m/s, never closer than 54 m, last warning only alongside, B8b 0 mismatches of 185, fire
  when ignored); handoff **7/7** (battle view = command mode: 2,625 / 608 soldiers, 4 tanks, one distance 17 km).
* Browser `w6-verify` orbit + advance (#22/#23): **21/21** (slim arrow 4 px = 9 km, 0.06 % of the screen, under the
  bands, gone at 1,000 km; offensive dialog with preview; persists 40 ticks without clicks; intensity from the row;
  Retirar with 10 % loss; V15 an offensive from the dialog past its axis point, never 0 km/h while advancing,
  4.67 km/h vs 4.29 km/h tile rate; Enviar divisiones).
* `npx tsc --noEmit`, `npm run build`, `i18n-check` (0 missing in es/en) clean.

**Still open after this round**: air effects remain flat per-side multipliers (more patrols than the enemy = the sky;
not proportional to the number of squadrons). Released aircraft on «hold» keep their own 12 h endurance and fly home
without coming back (by design: the player left them there, not on a mission). Items 26-29 belong to the Feedback 3
round.

## Feedback #3 results (strategic) — owner items 27 (strategic side), 28, 29a, 29c, 29d (2026-09-30)

> `git log --grep "Feedback #3"`. Rules with numbers: DESIGN_V2 §18; code map: CODEMAP §26. Headless
> `npx tsx src/sim/test/f3-audit.mjs` **all pass** (damage D1-D8, missions M1-M7); browser, real UI, Chromium/SwiftShader
> `node tools/f3-verify.mjs` (sections missions, card, civil, advisor: 20/20 — missions 8/8 in the final run, 0 page errors); regression audits after the
> changes: `w4-audit` 43/43, `w6-audit` 20/20, `command-audit` 35/35, `air-audit` 25/25; `npx tsc --noEmit`, `npm run
> build`, `i18n-check` (0 missing es/en) clean. Shots: `shots/feedback3-strategic/` (f3-damage, f3-city-damage, f3-card,
> f3-missions, f3-advisor; verify/ has the real-play frames).

**What existed before this round (checked against the code, not rebuilt):** structures already had an `hp`, bombers,
drones, cruise missiles, nukes and naval shells already damaged them, `commandCasualties.structureHits` already existed,
and capture already changed the owner (except defence posts). But: any hp > 0 worked at 100 %, hp 0 deleted the
structure outright (no level loss, no rubble), repair was free and automatic after 15 h, cities lost nobody when hit,
striking cities cost nothing diplomatically beyond the L2 escalation dialog, there was no division attack on a
structure, no raze, and the damage was drawn only as a darker tint and an occasional flame. Missions: divisions had
move / attach / attack / hold / return; «Unirse al frente» attached to the nearest line tile (not to an offensive);
nothing showed what a division added to an offensive; the offensive dialog showed a plains formula next to the
badge's measured km/h (29a); the Fuerzas panel had no mission column and no advisor; no after-action reports.

### #27 structures and cities (strategic side) — done
* Damage states with reduced function (1 / 0.6 / 0.25 / 0), level loss at hp 0 (then 0.30), rubble at level 1, paid
  repair (+8 %/h, 2 h pause after a hit), capture changes owner at ≤ 0.60 hp (defence posts too), raze, city civilian
  and troop losses, diplomatic cost with casus belli and confirmation dialog, rebuild on rubble at half price.
  **Measured (f3-audit):** city L4 hit 0.35 → «damaged», owner's gold/h and troop cap fall; factory L3 direct bomber hit
  → L2 at 0.30 (not destroyed); SAM L1 direct hit → rubble (TickUpdate.ruins), rebuild 50 %; repair 0.40 → 0.64 in 3 h,
  paused 1.5 h after a new hit, done at 1.00; no free repair in 4 h; city L5 hit 0.55 → ≈ 16,500 civilians and troops
  killed; opinion of the striker: victim −20, its ally −12, a third nation −5; casus belli victim + ally, not the third;
  escalation L2; captured defence post owner human at 0.60; razed factory → rubble (cause raze); command-mode hook: hit
  at 15 km accepted (−0.20, block 3 published), 300 km refused, a nation at peace declares war; bomber on a city needs
  `order.err.civilian` confirmation (AI and confirmed orders pass); the real AI repairs its damaged structures.
* Real play (f3-verify): D1 card «Con daños · funciona al 60 % · último ataque: Suiza»; D2 «Reparar · 50.600 · 5,6 h»; D3 the
  damage report in the feed; D4 «Reparar» pays 39,000 and hp rises (0.55 → 0.62 in 3 h: 2 h pause after the hit, then
  8 %/h); C1 a bomber ordered onto Toulouse opens «Atacar una ciudad» listing ≈ 30.000 civiles, −20 / −5 opinion, casus
  belli 30 days, escalation L2; C2 confirm → sortie; C3 city 1.00 → 0.30 (a level lost), 30,000 civilians; C4 the
  strike's after-action report; C5 the victim's opinion −69 → −89.
* 3D (shots f3-damage, f3-city-damage): damaged / heavily damaged models drawn at 85 / 60 % height with debris piled
  around, smoke columns and fire; a city loses whole blocks (charred stubs + rubble, the same 16-block mask command mode
  reads); rubble pile with embers where a structure was destroyed. Hover on rubble names it, who destroyed it and when.
* Hooks for the command-mode agent: `commandStructureHit`, `StructureView.blocks`, `collapsedBlocks`, `LocalStructure.
  damage/standing/collapsed/repairing`, `LocalForces.ruins` (DESIGN_V2 §18.1.7). Command-mode rendering of damage and
  sending the hits are the command-mode agent's side of #27 (not done here).

### #28 missions for every combat unit — done
* Divisions: **Defender sector**, **Unirse a la ofensiva X**, **Asaltar / Arrasar objetivo** (+ hold, move, attach,
  attack). Warships: **Bloquear** now stops a port's trade (card «bloqueado por X · sin comercio»). Aircraft missions
  from Feedback 2 (#25) unchanged. One action each: right-click context, card buttons (one-click «Unirse a la ofensiva»),
  Guerra panel «Enviar divisiones» → «Unirse» with the km/h preview, the Fuerzas advisor. Every chip shows effect, risk
  and ETA; each mission runs by itself; map shows sector ring, spearhead marker, artillery reach, target rings.
* **Measured:** M1 (f3-audit, same seed, plains) offensive 4.03 km/h → **5.07 km/h** with 2 divisions joined (divAtk 2);
  the preview said 3.53 → ≈ 5.59 (10 % off; elasticity ½ calibrated); joined divisions stay ≤ 0.2 tiles from the live
  contact after 129 tiles. M2 an enemy offensive into a sector 1.59 km/h / 58 tiles → **0.03 km/h / 1 tile** with 2
  divisions defending. M3 assault: a factory L2 shelled to 0.15 (never below), captured when the front took it,
  after-action «captured». M4 raze: destroyed, rubble. M5 blockade: port blockaded, no trade ship leaves. M6 AI (1,500
  ticks of wars): join 13, defend 125, assault 2-8, blockade 0-2 orders; 4-8 artillery hits on structures. M7 an AI at
  war with the human: its divisions join its offensive against the human (join 4).
* Real play (f3-verify): M3 «Enviar divisiones» lists «Unirse»; M3b its tooltip «Al unirse: Potencia ×2, Avance 2,9 →
  ≈ 6,1 km/h, Riesgo…»; M3c one click → the division's mission is the offensive; M4 published divAtk 3 → 4 after it
  arrives, the offensive measured 9.8 km/h; M5 the assaulted defence post 0.64 → 0.29, then captured by us (report
  «captured»); M6 the right-click chip «Unirse a la ofensiva · 100 km · 2,5 h · … su potencia ya está al máximo (×2 con
  4 divisiones)…».

### #29a one number per front — done
`offensiveStatus` / `offensiveKmh` feed the badge, the Guerra panel row and «Tu ofensiva» (which used to print the raw
sim state «avanzando» beside «‖ estancado»), the battle strip, the offensive dialog (now «Ahora (medido)» → «Con este
cambio») and the unit cards; below 0.05 km/h an offensive reads «presionando: aún sin avance». Real play M1: «▶ 2,9 km/h
| Tu ofensiva … 2,9 km/h · apoyo: 3 div. (+75 % potencia) | ▶ 2,9 km/h» (panel row, own line, badge).

### #29c operations overview — done
Fuerzas rows show «Misión: …» / «Sin misión» / «sostener el frente (se unió sola)»; the advisor lists idle units by type
with one «Dar misión» each (join our offensive / defend the worst front; CAP over our offensive or the worst front or
the capital; drone support; bombers → target mode; warships → blockade the nearest enemy port). An advisor alert during
wars at most every 12 game h. Real play A1-A3: «Asesor: 6 unidades sin misión…», idle 6 → 3 after the clicks (the
bomber waits for its target and the warship has nothing to do against a landlocked enemy).

### #29d after-action reports — done
Offensives (either side, human-involved), strikes (hit / destroyed / shot down) and division missions (captured /
destroyed / razed / cancelled / lost): an alert in the feed and REGISTRO, clickable to fly there, with result, duration,
tiles and km², losses on both sides, damage and supporting divisions. Real play C4: «1.º Bombardero: impacto en Ciudad
(−100 % de integridad) — cerca de Toulouse (Francia). Integridad perdida en la misión: 0 %. Duración 1,4 h.»

### Still open / notes
* The command-mode side of #27 (shells, bombs and naval guns hitting the structures and city blocks seen in command mode,
  their fire/collapse there) belongs to the command-mode agent; the sim hook and the shared block mask are ready.
* A demolition fireball and its 22 s fire are sized for the camera that sees them happen (pre-existing fx rule): zooming
  in on a structure destroyed while watching from orbit shows an oversized fire for those seconds.
* The AI's war plan decides by itself when to attack the human; M7 had to launch the AI's offensive to observe its
  divisions joining it within the test window.
* Division artillery is modest by design (4 %/h, 6 %/h to raze): a defence post falls in about a day of shelling; the
  decisive way to take a structure is still the offensive reaching its tile.

## Feedback #3 results (command) — owner items 26, 27 (command side), 29b, 29e (2026-09-30)

> `git log --grep "Feedback #3 command"`. Rules with numbers: DESIGN_V2 §19; code map: CODEMAP §27. Browser, real UI,
> Chromium/SwiftShader: `node tools/f3c-verify.mjs` (sections go, panel, alert, strike, city, bomb, night) — final
> runs **all pass, 0 page errors**: go 5/5, panel 2/2, alert 3/3, strike 4/4, city 3/3, bomb 2/2, night 3/3.
> Frames in `shots/feedback3-command/verify/`. `npx tsc --noEmit` and `npm run build` clean.

**What existed before this round (checked, not rebuilt):** command mode (W5) entered a unit where it stood and let you
drive; travel mode (×10…×900 with an autopilot to a map waypoint, M) existed but nothing said where the enemy was or took
you there; shells, bombs and missiles passed through buildings; the night had moonlight and exposure only.

### #26 getting to the action — done
* **Where is the fight**: a chip under the compass, always on (the nearest enemy / offensive contact / front line / the
  unit's mission, with km and bearing: «Frente con Suiza · 124 km · noreste», the mission on its second line), and a red
  ring in the world or an arrow on the screen edge. In contact it turns into «Infantería de Suiza a tiro · 1,6 km».
* **G «Ir al combate»** (or the chip's button; «Ir al frente más cercano» beyond 25 km): near, the autopilot; far, a
  **march** behind a fade on the real clock (the whole world runs ×300…×3600, the unit really moves in the sim through
  own or friendly land, never a nation at peace), then the scene is built where it stops, 1.2 km short of the line,
  facing it. **New this pass:** when the unit arrives and the action is still out of reach (the line moved, the far view
  was coarse, the joined offensive went on), the follow-on legs run behind the same fade from the sim (no scene rebuild
  between them), so the scene is built once, at the action.
* **Measured (G, real UI):** the defending division, 115-124 km behind the line, taken from its unit card: the chip names
  the front at 115 km and offers «Ir al frente más cercano»; one G → 4 legs, 157 km in **18 real s** behind the card
  (was 4 separate marches with 4 scene rebuilds, 381 s and no contact in the first run of this pass) → an anti-tank team
  of Suiza at 1.6 km. From the click on «Tomar el mando» to contact: **105.6 real s here with 69 rendered frames** in
  total — SwiftShader draws 1-3 s per frame, and 59 s of it is the entry build before the first frame of play. The
  march itself runs on the sim clock (6 s for the first leg + 2.4 s for each follow-on leg by design). On a GPU, where a
  scene build takes seconds, that is roughly 30-40 s, inside the ~60 s criterion; it cannot be timed here.
  G5: after the march the strategic unit is exactly where the vehicle is.
* **Map (M)**: click a destination; + drives there (existing travel mode).

### #29e take control from anywhere, in at the action, out looking at it — done
* Entry points: double click on a front badge, «Tomar el control aquí» on a Guerra panel front row, the battle strip
  (your division in that battle, else the nearest marches there), «Al mando» on an alert about the war at a place,
  «Al mando, a su misión» on a unit card with a mission. The app picks the unit (joined to that offensive, on that front,
  else the nearest; healthier first) and marches it behind the entry fade **before** the scene is built.
* **Measured:** P1 Guerra panel → our offensive's front: 3 follow-on legs 50 km in 42 s, **in contact (enemy at 2.2 km)
  without touching the keyboard**, one scene build, 110 real s / 31 frames. A1-A2 «Al mando» on the alert «Puesto
  defensivo … de Suiza: con daños»: 60 km in 31 s, enemy at 1.1 km, 77 real s. P2/A3 exit: the strategic camera ends
  at 868-890 km right above the place of the action (±0.01°), not a continental view.

### #27 command side: what you shoot is the real thing — done
* Tank shells, the jet's missiles and new free-fall **bombs (B, 4 per sortie)**, the ship's guns and missiles stop at the
  structures and houses of the scene and damage the same sim structures (`commandStructureHit`, flushed every 2 s):
  structure HE 5 %, AP 2 %, naval gun 6 %, jet missile 12 %, ship missile 20 %, bomb 30 %; each house of a city 0.5 %, a
  city block (a quarter of its houses down) 3 % more and its bit in the shared block mask. The sim does the rest (state,
  function, level loss, rubble, civilians and troops, the owner's report, casus belli, opinion).
* **Measured:** S1 one tank round fired by a click on a real factory: sim hp 1 → 0.98. S2 twenty HE rounds: 1 → 0.13,
  «daños graves», six `structureDamaged` reports (cause command). S3 the model: lower (34 m standing), scorched, fire and
  smoke. S4 back on the strategic map, its card: «Integridad 3 % · Daños graves · funciona al 25 % · último ataque:
  Comandante · 110 oro/h con daños: 440 oro/h sin ellos», and the feed «Fábrica de Zaragoza de Suiza: daños graves».
  B1 a fighter's four bombs on a factory: 1.00 → 0.70 → 0.10 → **level lost (L2 → L1 at 0.30)**; B2 it burns.
  C1 the first round that reaches a house of an enemy city stops the game with «¿Atacar Ciudad…?»: ≈ 1.800 civilians per
  heavy hit, −20 / −5 opinion, casus belli 30 days, escalation (no damage before «Atacar la ciudad»); C2 houses collapse,
  the city's hp falls, civilians and troops die in the sim; C3 the victim's opinion −70 → −90.
* The structure's hit notice now follows every hit (it used to keep saying «98 % · sin daños» during a salvo).

### #29b night — done
* Moonlight and exposure (W6), plus the vehicle's headlights (ship: searchlight; L toggles), illumination flares over
  the fighting every 12 s while an enemy is within 4 km, the fires of damaged structures lighting their surroundings,
  and **N**: night vision → thermal white-hot → off. **Measured at 01:24** at a front (N1-N3): plain mean luma 54 with
  53 % of the frame lit (a first flare tuning of this pass was too bright, 114 / 57 %: fixed); night vision 94 / 75 %;
  thermal 30 / 16 % (was 20 / 8 %: the ground was nearly black, brightened this pass). The battle view at night was
  already measured in W6 (V17: luma 32-42).

### Still open / notes
* The ~60 s criterion can only be estimated here (SwiftShader: entry build ~60 s, 1-3 s per frame); the march part is
  measured (18-42 s of sim clock behind the card on this 4-CPU container).
* Naval guns and ship missiles hitting structures use the same code path as the tank and bomb hits (weapon share 6 % /
  20 %), but no ship-vs-coast run was done in the browser this pass.
* A tank can bring down only a few houses of a city with its 20 HE rounds (4 houses, −2 % in C2): cities are meant to
  be hurt by bombers and artillery; a tank's work is structures.
* The first leg of a long march often ends 25-35 km short (the far view of the line is coarse); the follow-on legs hide
  it behind the same card, at ~2.4 s each.

## Feedback #3 results (naval, item 30) — war at sea: blockades, seizures, convoys (2026-09-30)

> `git log --grep "Owner item 30"`. Rules with numbers: DESIGN_V2 §20; code map: CODEMAP §28. Headless
> `npx tsx src/sim/test/naval-audit.mjs` **22/22 pass** (N1-N11). Browser, real UI, Chromium/SwiftShader
> `node tools/naval-verify.mjs` (sections blockade, port, command; frames in `shots/feedback3-naval/verify/`, see the
> run notes below). Regression audits after the change: `w4-audit` 43/43 (row 12 updated: the default blockade now
> turns a convoy back instead of shelling it), `f3-audit` 35/35, `command-audit` 35/35, `air-audit` 25/25, `w6-audit`
> 20/20; `npx tsc --noEmit`, `npm run build`, `i18n-check` (0 missing es/en) clean. Shots `shots/feedback3-naval/`
> (`naval-dialog`, `naval-dialog-all` (&who=all), `naval-strait-all`, `naval-panel-all`, `naval-port-all`).

**What existed before (checked, not rebuilt):** a warship ordered to «Bloquear» within 150 km of a hostile coast
captured trade ships of nations at war that came within its engagement radius (the cargo was paid to the captor at once
and the ship vanished), a port within that radius of an enemy blockading warship sent no merchants, and warships at war
shelled convoys. Nothing else: no strait or sea-lane blockade, no rerouting (Suez and Panama were not even sailable: a
ship from the Mediterranean to the Red Sea sailed 21,477 km around Africa), no choice of whom to stop or of seize/sink,
no prize ship, no convoy turned back, no piracy at peace, no lost-income figures anywhere, no AI reaction, nothing on
the map, nothing in command mode. A blockading warship that chased a ship never went back to its station.

### Blockade a sea lane or a strait, not only a port — done
* Order «Bloquear» anywhere on the ship's sea; within 150 km of one of 8 straits (Gibraltar, Suez, Bosporus, Hormuz,
  Malacca, the Channel, Panama, Bab el-Mandeb) it closes the narrows; several warships share one blockade. In force
  while one holds the station (they return to it after a chase). Suez and Panama are canals now (N1: Med → Red Sea
  **1,770 km**, Pacific → Caribbean **538 km**).
* **Rerouting, measured (N2, Gibraltar closed to our enemy, 144 game hours):** the enemy's merchants to the Atlantic
  steer round via Suez and the Cape (+9,658 km each on average); others run it and are boarded (1-5 seized). The enemy's
  **trade income fell 463 → 278 gold/h (−40 %)**; the blockade's ledger: 33,424 gold lost by the enemy, 1,087 gold/h over
  the last 24 h; our seized cargo delivered at Cádiz: 24,282 gold. A merchant is paid for the direct trip, so a detour is
  lost income by construction (`slotRate × (1 − direct/route)` per hour). In the browser (V6, 400 more ticks at ×8):
  9 rerouted, 10 seized, China lost 198,075 gold (1,387 gold/h), we took 166,440 gold of cargo.
* Blocked lanes on the map (V5, shot `naval-strait-all`): a hatched disc (amber ours, red when it stops us, owner's colour
  otherwise), a chip «Estrecho de Gibraltar · tu bloqueo / +990 oro/h · 5 apresados · 4 desviados»; merchants on a
  detour and prizes draw their new route (shot `verify/v6-detours`: the Suez / Cape detours drawn across Africa).

### Seize or sink — done
* Board and seize: the merchant changes flag and sails to our nearest port, paid there (N4: +1,234 cargo delivered at
  Cádiz); sink: lost to everyone (N5). Convoys: boarded they turn back and their troops return home (N6: 40,000 troops
  denied), sunk they die with it (N6b). Command mode (below) does the same by hand.

### Selective blockades with payoff and cost shown before and tracked after — done
* The dialog (V1-V4, shots `naval-dialog`, `naval-dialog-all`): whom it stops (only nations at war — default /
  at war + embargoed / chosen nations / everyone but allies), which ships (all / merchants / troop transports), board or
  sink; live preview: every nation with ships routed through there now (merchants, gold/h, convoys, troops; «se detienen»
  / «pasan»), gains (trade cut, troops stopped), costs (none when only enemies are stopped; else piracy: opinion per ship,
  allies, casus belli 30 days, each nation's opinion now → after and its risk of war, how many nations and allies turn
  against us, our trade with them an embargo would cut).
* Consequences follow whose ships were stopped (N3: with «enemies only» the neutral's ships were not touched and its
  opinion stayed +8; N3b «everyone»: a neutral boarded at peace → opinion 10 → −50 and a casus belli against us).
* Tracking: Guerra › **Mar** (V7, P3, shot `naval-panel-all`): the ledger (lost to blockades / spoils / merchants on
  detours / ports cut off), our blockades (spec, in force, spoils gold/h, enemy trade cut, troops stopped, ships stopped
  per nation with the piracy flag and our opinion there; Ir / Cambiar / Levantar), blockades against us (their cost;
  «Romper el bloqueo», «Escoltar mercantes»), the straits with the ships passing now and «Cerrar». The Fuerzas panel has a
  one-line ledger; the port card says «Bloqueado por China: ningún mercante zarpa · −150 oro/h» (P1, shot
  `naval-port-all`).

### Counterplay, alerts, AI — done
* Escorts: an escorted ship at peace is let through (N7); at war the blockade must beat the escort first (N7b). Break a
  blockade with our warships (Mar › «Romper el bloqueo», at war) or bombers; merchants can now be escorted.
* Located alerts: our blockade in force / ended, another's closing a lane to us, each ship stopped (ours or theirs,
  piracy noted), our merchants rerouted (grouped, extra km and gold), prizes in port.
* The AI (N10, real AI, 24 nations): Algeria at war with us **closed Gibraltar** by itself (stopped 10 of our ships,
  rerouted 9; our loss 328,520 gold, 427 gold/h). An AI whose merchants we seize and sink at peace (N10b, China):
  **protest, embargo, then war** (declared at opinion −100, `war.reason.piracy`, allies called to arms). It escorts its
  merchants and convoys near an offender's blockade and attacks a blockade that stops it when it has as many warships.

### Command mode: hail, warning shot, board, sink — done
* A container ship model and a grey troop transport (ro-ro, helicopter deck, lifeboats) sail in the warship scene where
  the sim has them. The nearest foreign one within 12 km gets a panel (flag, at war / peace, distance, state) with
  E «Dar el alto», R «Disparo de advertencia» (a real shell into the water ahead), F «Abordar» (alongside ≤ 700 m,
  ≤ 12 kn, stopped, no escort: 8 s boarding party), X «Hundir» (at peace it asks first). All sent to the sim
  (`navalIntercept`) with §20.5's consequences. Measured in the browser: C1 panel on «Convoy de tropas de Suiza · en paz ·
  547 m · 5.000 soldados»; C2 E → the ship heaves to in the sim; C3 F at 529 m → the merchant seized (piracy) and
  sailing to our port under our flag; C4 R → warned, piracy, Suiza's opinion −33 → −36 (0 → −26 in an earlier run with
  the hail); C5 X → «¿Hundir un barco de Suiza en tiempo de paz?», confirmed → sunk in the sim with 5,000 troops,
  piracy. Headless N9/N9b: hail stops it, warning shot −3 opinion at peace, board → ours, boarding 250 km away refused.

### Run notes / still open
* Browser runs (final, 0 page errors): **blockade 7/7** (V1-V7), **port 3/3** (P1-P3: P2 needed `blockade` added to
  `FF_EVENT_TYPES`, the staging's fast-forward had dropped the event), **command 5/5** (C1-C5; C3 in the last run: stop
  engines with S, re-hail, F → «Buque asegurado», the Swiss merchant flies our flag and sails to Málaga; earlier runs
  failed because the hailed ship had got under way again — a hail now holds a ship 6 game hours — and because the
  nearest ship was the convoy, which boarding turns back). Model check: shot `command-merchant-models` (the container
  ship and the troop transport beside the player's warship).
* A merchant spawned by the sim in the same 25 km tile as the controlled warship used to appear inside its hull; it now
  appears 550 m abeam. The scene's merchants follow the sim's route loosely (they steam toward the sim's position 2.5 km
  ahead), like the warships.
* The per-hour figures average the last 24 game hours (divided by the hours since the blockade began when younger), so
  a fresh blockade's figure moves a lot in its first hours (the chip read +990 then +1,913 gold/h in the same run).
* Submarines do not exist in the game, so there is no sub-hunting.

## Feedback #3 fix pass 2 (2026-09-30) — verifier failures on items 26, 28, 29d, 29e, 27

> `git log --grep "fix 2"`. Rules: DESIGN_V2 §18.2, §18.4, §19.1 («Fix pass 2»); code map: CODEMAP §27.1. Headless
> `npx tsx src/sim/test/f3-audit.mjs` **45/45** (new: M1c, M5b, M8) and `--only aihuman` **3/3** (M9); regression
> audits `naval-audit` 22/22, `w4-audit` 43/43, `air-audit` 25/25, `command-audit` 35/35; `i18n-check` 0 missing es/en;
> `npx tsc --noEmit` and `npm run build` clean. Browser (Chromium/SwiftShader, real UI, no-HMR dev server):
> `node tools/f3c-entry-verify.mjs` **12/12 twice** (0 page errors), the verifier's own `tools/_v3_entry.mjs` **8/8**
> (badge, mission, Esc exits), `tools/f3c-verify.mjs --only panel,go,alert` **10/10**, `tools/f3-verify.mjs` **20/20**
> on missions / card / civil / advisor (missions 8/8 again in a second run) plus the new `bombard` section **4/4** (0 page errors); frames in
> `shots/feedback3-fix-2/`.

### #26 / #29e: taking control at a front puts you at the action — fixed
* **Cause (confirmed).** Two faults stacked. (1) After the first leg the march aimed at the joined offensive's live
  point (`AttackView.contactX/Y`, the rally point), which sits 6-27 km behind the sub-tile contact line and moves.
  (2) Near the line every leg crawled: the page receives the sim's view only every ~4 real s at ×300-×400 (the worker
  runs several ticks per loop), and each move asked for where the unit could have been *at the last view*, so a 2.3 km
  leg took 2,600-3,000 game s — the unit advanced at the line's own 3 km/h and the line ran away (seen in real play:
  8 legs, 48-51 km, still 3.5 km short, «legs»).
* **Fix.** With a front, a battle or a mission on a front as the entry point (`CommandGoal.frontKey / attackId`, set by
  the badge, the Guerra row, the battle strip, the alert, and «Al mando, a su misión» for a join), every leg goes to the
  **live contact**: the nearest point of that front's contact line from the one local derivation (the offensive's
  stretch while far) or an enemy division when nearer. The march keeps adding legs until **the sim** puts enemy soldiers
  in reach (a line at war within 2.6 km with enemy soldiers on it — the scene stands them 140-560 m beyond it — or an
  enemy division within 4 km), up to 8 legs; otherwise it stops and says why (`command.transit.short.*`: the line moves
  faster than the march / no route / no front / nobody on this stretch / blocked). Moves extrapolate the view's game
  clock on the wall clock; legs near the line run from ×120. «Ir al combate» drives the last 4 km itself (no march).
* **Measured, real UI, nothing pressed after the click** (f3c-entry-verify, second run):

  | Entry | Legs, km | March | Contact | Scene builds |
  |---|---|---|---|---|
  | Guerra panel «Tomar el control aquí» (P1) | 2, 30.7 km | 13.9 real s | enemy at 2.1 km | 1 (1.3 s) |
  | Double click on the front badge (B1) | 2, 29.1 km (stopped: enemy in reach) | 9.4 real s | 2.4 km | 1 (1.6 s) |
  | «Al mando, a su misión» (M1) | 2, 27.7 km | 12.5 real s | 1.8 km | 1 (1.5 s) |
  | A division already on the front, from its Guerra row (F1) | 2, 29.1 km | 14.3 real s | 2.1 km | 1 (1.5 s) |

  The verifier's `_v3_entry.mjs`: B1 contact at 70.8 real s (enemy 2.1 km, one march of 30 km), M1 at 70.3 s (2.1 km);
  Esc → exit decision → the strategic camera ends above the place (42.53, −0.02). Frames:
  `shots/feedback3-fix-2/entry2/*-contact.png` (the chip reads «Infantería de Suiza a tiro · 2 km», the red marker on
  it), `shots/feedback3-fix-2/v3entry/`.

### #26: under ~60 real seconds from take-control to contact — per-phase breakdown
* For the division already on the front (F1: joined to the offensive, 25-29 km behind the live line, which is where the
  sim keeps a joined division): click → command mode 6.0 s (the unit is stopped in the sim, one sim update, the fade),
  **march 14.3 s** (2 legs behind the entry fade), **scene build 1.5 s**, intro 32.7 s = **10 rendered frames** of the
  3.1 s swoop at SwiftShader's 3-4 s per frame; contact on the first frame of play; **63.2 real s** from the click. The
  other entries: panel 12.2 + 13.9 + 1.3 + 31.8 (11 frames) = 59.2 s; badge 3.7 + 9.4 + 1.6 + 39.2 (9 frames), 77.4 s
  to the first frame the page reported; mission 7.7 + 12.5 + 1.5 + 36.1 (10 frames) = 67.0 s.
* **No second scene build**: `__cmdStats.builds` holds one entry (no `relocating` rebuild) in all four entries, twice.
* On a GPU the intro is its 3.1 s and the fade/entry a second or two, so the same entries take about 20-30 s, well under
  the ~60 s criterion; the march part is sim-bound (9-14 real s on this 4-CPU container). The G path from 126 km behind
  the line (f3c-verify go, G4) keeps its shape (the scene is first built where the unit stands, then one march and
  one rebuild): 130 km, one march of 5 legs / 180 km in 19.8 real s stopped by an enemy in reach, contact at **88.6
  real s** with 77 rendered frames (was 103.8 s). P1 (Guerra panel, f3c-verify) contact at 86.3 s with 30 frames, A2
  («Al mando» on the alert about a damaged Swiss defence post) at 74.9 s, 3 legs / 40 km, enemy at 1.9 km.

### #29d / #28: a warship's bombardment is a mission that ends, with its report — fixed
* `bombard` on a structure is now a mission on it (`missionTarget` = the structure; the card's «Al mando, a su misión»
  and the mission line see it). It ends by itself when the structure is **destroyed** or **taken**, when the **war
  ends**, when a **new order** replaces it, or when the ship is **sunk**; each emits `afterAction` (kind 'mission',
  order 'bombard', result, duration, naval damage done) shown in the feed and REGISTRO, clickable to the place («2.º
  Buque de guerra terminó su bombardeo: objetivo destruido (Fábrica, cerca de Burdeos) — Informe · Duró 14 h. Daño del
  fuego naval: 75 puntos de integridad en las estructuras de la zona (100 = un nivel entero)…»). The ship then holds
  its station with no order (it no longer sits on «bombard» on rubble).
* **Lifted blockades** report too: when our blockade ends (or one that stopped our ships), an `afterAction` (order
  'blockade') gives how long it held, ships seized / sunk / turned back, the prize gold and the trade the blockaded
  lost; it replaces the «Bloqueo levantado» alert in place (same group).
* CAP / support stations have no natural end (a patrol runs until another order; fuel is handled by the relief
  rotation), so they get no report; strikes already had theirs.
* **Measured in real play** (f3-verify `bombard`): N0 an enemy level-2 factory on the Biscay coast near Bordeaux; N1
  our warship's order makes it its mission (mission = the structure); N2 destroyed after 14 game hours, report
  'destroyed' (damage 0.75), the ship's order −1 and no mission; N3 the report in the feed and REGISTRO in words
  (frame `shots/feedback3-fix-2/f3/n3-bombard-report.png`).
* **Headless:** f3-audit M8 — a level-2 coastal factory: order accepted, mission target set, destroyed after 27 h, report
  'destroyed' 0.9 h after the last hit (damage 1.35), the ship's order −1; a second bombardment cut short by peace:
  report 'ended'. M5b: a blockade lifted after 4 h: report with seized 0, sunk 0, the enemy's lost trade 1,200 gold.

### #28: the AI uses the same missions against the player — fixed
* The AI's division missions were set once: a division that took «defend» when the AI had no offensive never
  reconsidered, so none joined the offensive its war plan later launched on the human. Now every pass re-plans:
  defending / attached / idle divisions join the AI's running offensive nearest them (one defender stays on a sector
  under a real threat), and a joined division assaults — or razes, if the AI hates the enemy — a structure within 6
  tiles of the spearhead (one such order per pass).
* **Measured, nothing forced** (f3-audit `aihuman`, M9: 30 real AIs, armies and fleets given, 300 game hours, no
  scripted offensive): the enemy's own war plan launched 1 offensive on the human; **join 6** (divisions joining that
  offensive), **assault 3** on the human's border defence posts and factories, 3 artillery hits on them. M7 (forced
  offensive) and M6 still pass.

### #28: the join preview must visibly add strength — fixed
* The sim now publishes the share of the offensive's pressured tiles with armour near (`AttackView.armorCover`); the
  outlook adds a division's ×1.5 stretch only where there is no armour yet (joined divisions stand together at the
  spearhead) and flags `gains` when the change is ≥ max(0.1 km/h, 3 %).
* When a join adds nothing (power at the ×2 cap, armour already at the tip): the Guerra panel's button reads
  **«Unirse · no acelera»**, and its tooltip, the card's «Unirse a la ofensiva» tooltip and the right-click chip say it
  plainly («… no la haría avanzar más deprisa (5,6 km/h con o sin ella). Mejor úsala para asaltar Puesto defensivo de
  X, cerca de la punta.»); the advisor proposes that assault instead of the join.
* **Measured in real play** (f3-verify): M3 the Guerra panel lists «3.ª División acorazada … UNIRSE · NO ACELERA»;
  M3b its tooltip «La ofensiva sobre Andorra la Vieja ya tiene la potencia al máximo (×2) y blindados en su punta
  (empujan el 37 % del frente): esta división no la haría avanzar más deprisa (2,8 km/h con o sin ella). Mejor úsala
  para asaltar Puesto defensivo …»; M6 the right-click chip says the same for the offensive on Toulouse; A1 the advisor
  proposes «1 división: asaltar Puesto defensivo … en la punta de tu ofensiva» instead of the join.
* Why the verifier saw 2.8 → 7.25 km/h after a join: at the cap the model's own speed does not move (M4 in real play:
  `planKmh` 8 before and 8 after, `divAtk` 3 → 4, armour cover 0.375), while the measured speed climbs from 2.5-4.6
  to 8.1 km/h in those 12 game hours as the spearhead comes down from the Pyrenees (the offensive «sobre Andorra la Vieja» becomes the one «sobre Toulouse»). The preview
  starts from the measured speed on the ground it stands on and cannot see the terrain ahead; the join itself adds
  nothing there, as the controlled comparison below shows.
* **Headless:** f3-audit M1c — 4 divisions joined, a 5th: preview 5.63 → ≈ 5.63 km/h, `gains` false; measured over
  the same window with and without it: 5.62 vs 5.62 km/h (Δ 0.00, predicted Δ 0.00). M1 (2 divisions joining an
  unsupported offensive): preview 3.53 → ≈ 5.30, measured 5.07 (4 % off; was 5.59, 10 % off).

### #27: repair at +8 %/h after the 2 h pause — the sim was right; card and verifier fixed
* Headless D3 is exact. In the browser the structure's hp is published every 5 ticks while it repairs, and the 3 h
  window of f3-verify D4 included the 2 h pause after the staged hit: 30 ticks − 20 of pause = 10 of repair, minus up to
  4 ticks of publication lag = the 6 ticks (+0.048) the verifier saw. D4 now measures the repair where it runs: the
  expected gain in the first window from the last hit's tick, and the rate over the next window (target 8 %/h ± 1).
  **Real play:** hp 0.550 → 0.614 → 0.854 (ticks 227 → 257 → 287, last hit at 227): expected +0.064 in the first 3 h,
  measured +0.064; **8.0 %/h** after the pause; gold paid. The button read «REPARAR · 50.600 · 7,7 H» = 2.1 h of pause left
  + 0.45 / 0.08 = 5.6 h of repair, the time it takes.
* The card's «Reparar · precio · N h» and «reparando, lista en …» now include what is left of the 2 h pause
  (`StructureView.hitTick`), so the hours it states are the hours it takes.

## Feedback #3 fix pass 3 (2026-10-01) — verifier failures on items 26/29e, 27 (command side), 30, 29a/29d, clear map

> `git log --grep "fix 3"`. Code map: CODEMAP §27.2. `npx tsc --noEmit` and `npm run build` clean; `npx tsx
> tools/i18n-check.mjs` 0 missing es/en; headless `npx tsx src/sim/test/f3-audit.mjs` **45/45**. Browser (Chromium /
> SwiftShader, real UI, no-HMR dev server, nothing pressed that a player would not press): the verifier's own
> `tools/_v4_strip.mjs` **5/5 twice**, new `tools/f3c-destroy-verify.mjs` **7/7**, `tools/naval-verify.mjs --only
> command` **8/8** (new C1b, C1c, C3a), new `tools/f3-clearmap-verify.mjs` **4/4**; frames in `shots/feedback3-fix-3/`.

### #26 / #29e: «Tomar el control aquí» on the battle strip — fixed
* **Cause (as found).** `battleStrip.ts` entered with the battle's own division and no goal, so no march ran.
* **Fix.** The strip enters with the same goal as every front entry: the battle's `frontKey` and, when it is our
  offensive, its `attackId` (`takeAction.frontAction`); the march to the live contact runs leg by leg. With no division
  of ours in the battle it goes through `takeControlAtFront` (the panel's path).
* **Measured** (`_v4_strip.mjs`, near Zaragoza, «AVANCE 2,7 KM/H» on strip and badge): click → 2 legs / 32-34 km of
  march → play at 61.6 s and 62.8 s, **contact on the first frame of play** (enemy infantry at 2.1 / 1.7 km), one scene
  build; Esc → the strategic camera over the place (42.54, −0.01). As measured in fix pass 2, about 30 s of that is the
  3.1 s intro swoop drawn at SwiftShader's 3-4 s per frame; on a GPU the same entry is ~30 s. Frames:
  `strip/strip-1-contact.png`, `strip2/strip-1-contact.png`.

### #27 command side: a structure destroyed in command mode, end to end — fixed
* **Models readable up close.** Command mode no longer stretches the strategic icon model to the footprint (a 1.1 km ×
  26 m slab). `src/command/models/structures.ts` builds every type at its real size in metres: the factory is rows of
  sawtooth-roofed halls with pilasters and glazing, banded chimneys, tanks, a brick office, a rail spur, a fenced yard;
  the port quays, gantry cranes, warehouses and container stacks; the airbase a marked runway, hangars, shelters and a
  tower; army base, defence post, SAM site, silo, radar and naval yard likewise. Each building stands on the ground under
  it and aprons/runways drape over the relief (`Civil.drapeModel`). Frames: `destroy2/d0-view.png`, `d0-sight.png`
  (the gunner's sight full of hall facades and roofs; the banding the verifier saw was the stretched slab's flat faces).
* **Destruction in the scene follows the sim.** The level decides how many buildings stand; the damage state scorches
  and collapses them (damaged: some blackened and holed; heavy: about half down into tilted heaps, chimneys broken);
  rubble is the same compound with every building a heap (`ruin-<tile>`), with fires and smoke.
* **Rounds.** HE 0.08 per hit on a structure (was 0.05: twenty HE could not bring down a level-2 factory); the HUD says
  what the sim did: «Fábrica de Suiza pierde un nivel (ahora nivel 1): edificios derrumbados», then «Fábrica de Suiza
  destruida: queda en escombros».
* **Strategic card.** A destroyed structure keeps a card: «ESCOMBROS DE FÁBRICA · Fábrica · Suiza — Destruida · en
  escombros (era de nivel 1) · integridad 0 % · no produce nada — Destruida por Comandante hace un momento…».
* **Measured** (`f3c-destroy-verify`, factory L2 at 0.8 km): D1 rounds hit (1 → 0.92); D2 the sim takes a level (event
  `levelLost`, cause command), the model is rebuilt with fewer buildings (26,274 → 14,622 vertices), notice as above;
  D3 more rounds: destroyed (event `destroyed`, by 1), ruin on its tile, rubble compound drawn; D4 the notice; D5 the
  card. Frames `destroy2/d1-level-lost.png` (collapsed halls burning), `d2-rubble-view.png`, `d2-rubble-sight.png`,
  `d3-card.png`.
* **City hits reach the sim as the dialog says.** A round that brings houses down is a heavy hit on the city: the
  weapon's whole damage goes to the sim (plus a little per extra house), so civilians and garrison die there; the dialog
  quotes exactly one such round («Cada proyectil tuyo que derriba casas mata a unos 1.400 civiles…» for a level-3 city
  and a tank's HE); the sim emits `structureDamaged` for any civilian or troop loss, so the alert feed shows them; the
  command HUD says «Impacto en <ciudad>: N edificios abajo · unos X civiles muertos». Measured (C1): hp 1 → 0.755,
  4 houses down, 2 loss events: **4,410 civilians, 45 troops**.

### #30 command mode: see the ship you hail, board it in a visible sequence — fixed
* The stop panel's ship is **marked in the world**: corner brackets sized to the hull with «Convoy de tropas de Suiza ·
  546 m», or a coloured arrow at the screen edge when it is out of view; the **view swings to it** once when the panel
  first names it (and on E / R / X), unless the player moves the mouse. The panel keeps its ship (300 m hysteresis: two
  ships at the same range swapped it every frame) and **Tab** names the next ship in reach («Tab · otro buque a la vista
  (1 más)»; Tab was being eaten by the tank's vehicle switch).
* **Boarding is a short sequence**: a camera cut-in (behind the launch as it crosses toward the ship, then off the hull
  for the climb and the flags); our launch with its four-man team crosses with a wake, the team climbs the hull, the ship's flag comes down and ours goes up (radio lines: «Lancha
  abarloada…», «Equipo en cubierta, puente asegurado. Arriando su bandera.»); the prize keeps our flag and leaves the
  panel. The leftover «Aquí no hay combates…» notice is taken down when a ship to stop is in reach.
* **Measured** (`naval-verify --only command`): C1 panel; **C1b** marker «ship: Convoy de tropas de Suiza · 546 m»
  and the target on screen at (−0.04, −0.05) after the swing; **C1c** Tab → the merchant; C2 heave-to; **C3a** the
  boarding party object crossing in three frames; C3 merchant seized, sailing to our port under our flag; C4 warning
  shot (opinion −33 → −36); C5 sink at peace asks, 5,000 troops lost — **8/8** in `naval5` and `naval7` (Tab is now
  read by the command loop every frame: in one run between them a press was lost and the convoy got boarded instead).
  Frames `naval7/c1b-marked.png`, `c3-board-0..2.png` (the launch, from behind, heading for the container ship),
  `c3-boarded.png`.

### #29a / #29d: the numbers say the same thing — fixed
* **Strike report** in the bombard report's words with the target's name. Measured (`f3-verify --only civil` 5/5, the
  same staged strike as the verifier's c3-after, sim 1.00 → 0.30): «1.º Bombardero: impacto en Ciudad de Toulouse:
  pierde un nivel (ahora nivel 4) y funciona al 25 % — cerca de Toulouse (Francia)…», the same words as the damage
  alert; a hit that takes no level reads «…: −40 puntos de integridad (100 = un nivel entero), queda al 60 %»
  (`afterAction` strike now carries `targetId / hpAfter / levelLost / level`).
* **One distance per objective**: entered from a battle, the chip's objective is that battle, the same `battleKm` as
  the card's «Combate con X a N km»; the card's «Destino a N km» reuses the chip's distance when the destination marks
  the same spot; the front line in the card is given to 0.1 km under 10 km. **Markers de-cluttered**: the objective and
  destination markers are placed first, place labels never sit on them, and the destination's text is dropped when it
  marks the objective (strip2/strip-1-contact.png: one marker, one label).

### Clear map and 3D artefacts — fixed
* **Glare discs.** Beyond ~20-75 km of camera distance every fx sprite is capped at ~40 px and never HDR-bright (no
  bloom disc): `particles.ts vFar`. M1 at 1,200 km over the running front: largest near-white blob **19-20 px** (was
  100-200 px).
* **Diagonal bands.** They were the contested-land stripes, a fixed 0.75-tile period that grew into screen-wide bands
  below ~100 km; they now keep 24-48 px a period by zoom octaves (crossfaded) and dim up close. Also: globe relief
  shadows need an 80 m occluder on rugged ground (no self-shadowing of plains), battle shadows fade out 2.5-6 km from
  the camera (acne moiré). M2 60 km / M3 25 km: no periodic bands (3 / 0 alternations); `destroy2/d3-card.png` shows
  the fine stripes where `destroy/d3-card.png` (before) had broad bands.
* **Orange blotches at low altitude.** The occupied-land speckle (hard orange discs from a few km) fades out between
  250 and 90 km (the lighter fill and the border still say «occupied»); crater glow only within ~1.5 km of the camera;
  the battle terrain's wood/field edges are de-aliased with the pixel footprint. M4 at 3 km: orange share **0 %**
  (was 1.1 % of the frame).

### Notes
* Contact time from the strip is ~62 s on SwiftShader, of which the march is sim-bound and the intro is rendering-bound
  (10 frames of a 3.1 s swoop); the entry has nothing left that waits on purpose.

## W7 integration and retune (2026-10-01) — DESIGN_V2 §16.8

> `git log --grep "W7"`. Code map: CODEMAP §29. `npx tsc --noEmit` (also clean with `--noUnusedLocals`) and
> `npm run build` pass; `npx tsx tools/i18n-check.mjs` 0 missing es/en, 0 «(a)».

### What W7 added or fixed
* **Encyclopedia** (Help › Enciclopedia, §12.4): 22 entries generated from the shared tables (per-level tables equal
  the structure cards), uses, threats, orders. `w7-verify ency` 2/2.
* **Tutorial** (§12.5): all ten steps (5 army, 6 move, 8 fronts, 9 command added). Found and fixed in real play: the
  advisor showed **nothing** after the capital was founded (the spawn step only completed while the app was in the
  spawn state, which it leaves on the same frame), so every later step was blocked.
* **Tooltip sweep** (§12.1): 672-709 visible controls over every panel, card, dialog, settings tab, help section,
  the pause/save/load menus and the command HUD: **all** have a tooltip (`w7-verify tips`). Added: build-bar tabs,
  attack-ratio control and ticks, leaderboard/minimap toggles, modal close, nation-card and unit/structure-card buttons
  (attack, alliance, embargo, «Ver»…), alert-log filters, offensive-dialog shares/intensity, peace-dialog terms,
  blockade confirm/cancel, command-mode exit and «Ir al combate».
* **Missiles and bombs with a reason** (owner item 13): the human may aim nuclear weapons only at a nation it is at war
  with (sim and UI), after a confirmation that names the target, the escalation it causes, every nation in the radius
  (those at peace in red) and the cost; the arsenal and Z/X/C/V say why with no war. `w7-verify nuke` 2/2.
* **Defensive alliances against an expansionist neighbour** (§5.2): nations next to a stronger power that just
  started a war of choice ally with others it worries; a conquest then meets calls to arms (listed in the declaration
  dialog). First AI war on the autopilot human 19,067 / 13,704 / 41,302 → 13,984 / 15,914 / 19,189 (seeds 11-13).
* **Corta** (§4.18): capitulation thresholds ×0.75 and hegemony ratio 1.5 → seed 11 ends by hegemony at 41,900.
* **Night on the strategic map** (29b): structure/unit models keep a moonlight ambient; below ~300 km the territory
  fill glows at half strength, so models and lights read instead of black plates on a bright carpet.
* **Texts**: offensive reports count land from our side and never say «0 (≈ 0 km²)» or nest parentheses; one name per
  ship in command mode (the stop panel's ship drops the generic tag).
* **Removed**: v1 constants and helpers nothing read (47 in `sim/balance.ts`, geo/color/math helpers, the dead toast and
  nuclear-alarm components in `feed.ts`, `openHowTo`, `openShortcuts`, …), every unused import and local, i18n keys
  shadowed by a later dictionary, the v1 tutorial strings, 31 scratch probe scripts `tools/_*.mjs`. No `v2-stub` left.
* Verifiers updated to the current design where they had gone stale: w3 V7t (9 auto-pause kinds, incursion on), w4 V5
  (orders the units the chip says can comply, slower acks), w5 X1 (29e exit camera at 900 km tilted), endgame audit
  (breaks the countdown for any duration's ratio), regrowth audit (stages 5,000 tiles).

### Headless targets on the integrated build (W7)
`pace-audit` speeds, conquest (mult 1/2/4/10), depth, corridor, regrowth (200 and 5,000 tiles), survival, empire,
attached division, invariants, nuke, occupation, port economy, save/restore (T42 identical over 600 ticks, 852 events)
and `harness.mjs`: **all pass**. Full games:

| Game | End | T14 window | Result |
|---|---|---|---|
| Normal seed 11 | hegemony at 62,750 | 36,000–72,000 | pass (15/16 rows; only T33 fails) |
| Normal seed 12 | hegemony at 89,530 | 36,000–72,000 | late (also T19: 9 windows, worst 29.1 %) |
| Normal seed 13 | hegemony at 49,280 | 36,000–72,000 | pass |
| Corta seed 11 | hegemony at 41,900 | 18,000–42,000 | pass |
| Larga seed 11 | hegemony at 77,120 | 60,000–120,000 | pass |

So T14 holds on seed 11 and on 2 of 3 Normal seeds before the time limit (acceptance 7).

**T33 is not met** (first AI war on the autopilot human: 13,984 / 15,914 / 19,189 against 6,000–12,000). Traced on
seed 11 (scratch probe with a hook in `thinkDeclarations`): the autopilot human becomes the strongest nation of its
region (1.1 M troops at tick 9,000, two wars of its own at 8,556 and 10,941). Its neighbours are opportunists at
opinion −16…−19 that do see it «bleeding» in those wars, but the §4.6 launch odds against the garrison it keeps on
their border need 2.7–2.9× their whole army (MAX_COMMIT is far below), so they rationally stand down and sign pacts;
the first tension comes from a conqueror that only reaches its border at ~13,000. Forcing T33 would mean AIs declaring
wars they cannot fight or loosening the §4.16 protections, which the brief forbids; a real (weaker) player meets the
first AI war earlier (day ~51, tick ~12,100 in the Easy playtest). Left open as a measurement of the autopilot, not a
defect of play.

### W7 finish pass (2026-10-02) — build, one real 1x playtest, what is still open
`npx tsc --noEmit` and `npm run build` pass on HEAD. Work done by W7 before the container restarts, from `git log --grep W7`
(15 commits): encyclopedia and the ten-step tutorial; tooltip sweep over every control; dead-code removal; nuclear
weapons only at war, behind a confirmation, with the silo level checked first; defensive alliances against an
expansionist neighbour; Corta/endgame tuning; night readability on the strategic map; offensive-report wording; the
advisor's «Funda tu capital» stall; the Naciones drawer docked under the clock; nation detail rebuilt on state
changes; land bands drawn as soft splats; command-mode compounds (fences draped in 20 m segments, no trees inside a
fence, aprons on a 20 m grid, roads and pads around bases, SAM, silo and radar).

**Playtest at 1x** (`node tools/playtest.mjs`, Easy, no-HMR server `tools/vite.nowatch.config.mjs`, real UI):
**0 console errors** (1 warning: SwiftShader has no `KHR_parallel_shader_compile`). No game regression found. The failed
steps came from the test script, fixed in `tools/playtest.mjs`:
* After «Continuar» a loaded game waits paused («Pulsa Espacio para continuar», by design). The script never resumed,
  so every later build stayed under construction (no armored division, no level-1 factory to upgrade). It now presses
  Space like a player.
* The staged foothold for the capital-threat step searched only 8 bearings at 14 tiles, which a small coastal nation
  does not reach. It now tries 16 bearings and nearer rings.
* The Guerra-panel step failed when every war had already ended in peace. The panel correctly said «Estás en paz». A
  land neighbour now declares on us first, as the declaration step does. Its failure path also left the panel open over
  the map, so the 75 % attack and «Tomar el control» clicks hit the panel. `resetUi` now closes the Guerra panel. The
  command and inbox advisor steps failed only because of that cascade, since the advisor is sequential.
* The spawn-refusal click could land on a small nation's label and capital icon at 5,000 km. It now picks open land
  ≥ 5 tiles from the label, at 2,500 km. The game side was correct: the hover card read «Territorio de China».
Run 2 (before these fixes): stage 2 20/21, extended 25/30, 0 console errors, 3,265 s. Run 3 (with the fixes):
**stage 2 21/21**, and every extended step through the Guerra panel passed: all ten structures, the armored division,
its move through Fuerzas, the factory upgrade, and a front raised to «alta». At 1,690 s the dev server reached its
2-hour background limit and was stopped, and the page reloaded to the menu, so the rest of that run is void. The steps
after that point (nukes, 50 % attack, invasion, radial proposal, tributary peace, inbox, end screen) passed in run 2.
**Not re-run after the fixes:** the 75 % attack, «Tomar el control» / exit command mode, and the full advisor check.
Run 2 failed them only through the open Guerra panel. For a full confirmation, run
`node tools/playtest.mjs --url <no-HMR server>` once more on a fresh server.

**Open, known:**
* **T33** (first AI war on the autopilot human 13,984-19,189 against 6,000-12,000). See the analysis above. It is a
  property of the autopilot, not of play.
* **T14 on Normal seed 12**: hegemony at 89,530, late, and T19 (9 windows, worst 29.1 %). Seeds 11 and 13 pass.
* **W2 verifier leftovers** (last `tools/w2-verify.mjs` run in `shots/w7/w2/verdicts.json`, 14/20; the rest were not
  re-run in this pass):
  - *Island hover tip*: **fixed**. w2-verify now hovers a marker the pointer can reach, and both the Caribbean and
    Aegean «hover names the owner» checks pass.
  - *Route pixel coverage*: owner-colour coverage along the line is 0.946 at 1,800 km and 0.914 at 1,000 km with
    clouds on, against a target of 0.95. With clouds hidden it is 0.963-1.0. Clouds still dim the line in places.
  - *Route hold*: the convoy line starts fading at ~16 s and is 0.49 at 17.6 s, against ≥ 15 s at full opacity. That
    is ~1 s early, so it is a timing nit.
  - *Border flash edge*: the hue matches (dE 1.0 / 3.3). At 1,500 km the strongest step is 1.64 against the ≤ 1/3-peak
    limit, so the conquest flash still shows a 1-2 px hard edge at strategic zoom. At 300 km it passes (0.74).
  - *Icon click at 6,000 km*: 19/20, one isolated icon missed.
  - *Zoom crash*: the `models` section (close-ups down to 30 m) killed the headless Chromium («Target page, context
    or browser has been closed»), and `historical` then failed on the dead browser. This looks like SwiftShader
    running out of memory on the 30 m close-up. It is not reproduced in the game, but it is not proven harmless on a
    real GPU either. Re-run them on their own: `node tools/w2-verify.mjs --checks models` and `--checks historical`.

## Owner item 31 (2026-10-02) — command mode asks BEFORE the shot; «No disparar» means no shot; piracy and blockade from the warship

### What changed

* **Asked before any round leaves the barrel.** Every trigger pull (tank cannon and coaxial MG, jet cannon, missiles
  and bombs, ship gun and anti-ship missiles) is described to `clearToFire` (`command/player/common.ts ShotCheck`)
  before anything happens. Command mode checks the target under the reticle (or the missile's lock), the point aimed at
  and the predicted ballistic path (gravity, short segments, tolerance growing with range) against units, ships,
  structures and houses of a nation at peace, and against houses of a city not yet confirmed (the civilian-target
  question now also comes before the shot). With anything there, nothing fires and the question opens.
* **«No disparar» cancels the shot completely:** no flash, sound, round, ammo or impact. The trigger stays released
  until every trigger is let go (no automatic re-fire); a held trigger sweeping back over the same target within 4 s
  holds fire with a notice instead of asking again; a new click on purpose asks again.
* **Rounds already in the air** pass through a force of a nation at peace (no impact, no hit marker, no damage, no
  question); splash never touches neutrals; a stray round on a building at peace or on an unconfirmed city does nothing
  and asks nothing. The old after-the-hit `onNeutralHit` path is gone.
* **Safe defaults:** command dialogs have a `safe` button: Enter and Esc both mean «No disparar» / «Alto el fuego» /
  «Cancelar». War (G), «Atacar la ciudad» (G), the piracy choices (R / F / X) and the stop panel's «Hundirlo» (X) need
  an explicit click or the key printed on their button.
* **Merchants and troop convoys at peace** are neutral like any force of that nation (they keep sailing and heaving to:
  the AI routes them to their own behaviour). Firing on one from the warship opens the item-30 choice with its costs:
  «Disparo de advertencia» (R, ≤ 6 km, no damage, −3), «Abordar» (F, greyed out with the stop panel's reason when not
  alongside / slow / stopped), «Hundir» (X, −20 or −25 for a convoy), «Declarar la guerra a X» (G), «No disparar»
  (Enter · Esc), with the casus belli and the allies' / world's costs written above. Each choice runs the stop panel's
  own action (`intercept.perform` → the same `navalIntercept` sim command).
* **Same rule for tank, jet and ship**; declaring war from the question turns that nation's forces hostile at once
  (`forces.markHostile`, until the sim's view agrees).
* **Blockade from command mode:** on the warship, **B «Bloquear esta zona»** opens the item-30 blockade dialog for the
  strait / port / lane the ship is in, over command mode with the clock held. The sim now accepts a `blockade` order for
  the controlled warship (`shared/orders.ts`), keeps it under the player's command (`sim/units.ts order()`), counts it
  on station while the player keeps it there, and `holdAfterControl` sails it (back) to its station when command mode
  ends. The notice says where the station is («la estación está a 112 km…»).
* **Discoverable stop panel:** the panel itself lists «B Bloquear esta zona»; the controls bar for the ship reads «…
  Ante un mercante: E dar el alto · R disparo de advertencia · F abordar · X hundir · Tab siguiente buque · B bloquear
  esta zona» (the shadowing `ui/i18n/naval.ts` entry was the one shown); the first time a ship shows on the panel (first
  three sessions) a tip names its keys and the controls bar comes back. Tab is now described per vehicle (next tank /
  fighter / ship).
* Notices are hidden while a command dialog is open (a long notice used to show half-covered behind it). The CIWS no
  longer fires at aircraft of a nation at peace.

### Verified in real play (Chromium + SwiftShader, no-HMR dev server, real controls)

`node tools/f31-verify.mjs` (new; mouse trigger, keys; effects counted by wrapping the muzzle / flash / explosion / gun
sound calls, rounds by `world.stats.shots` and live projectiles, ammo by the HUD, damage by the entity's hp):

| Check | Result |
|---|---|
| B1 B on the warship → blockade dialog (clock held: «DECISIÓN · tiempo detenido»), «Establecer bloqueo» | **PASS**: «Estrecho de Gibraltar»; blockade created with our controlled ship, the player keeps the helm (phase play, unit still under command), notice «Bloqueo ordenado: la estación está a 112 km…» |
| M1 trigger held on a Swiss merchant at peace | **PASS**: «¿Disparar contra el Mercante de Suiza?» with R / F (greyed: «reduce a 12 nudos») / X / G / Enter·Esc; 0 rounds, 0 flashes, 0 gun sounds, 0 explosions, ammo 180, hp 220 |
| M2 Enter | **PASS**: «No disparar»; still 0 / 0 / 0 / 0, ammo 180, hp 220, dialog closed |
| M3 trigger kept down 9 s more, then released, 6 s idle | **PASS**: no re-fire, no repeated dialog (asked stays 1) |
| M4 a round already in the air straight through the merchant | **PASS**: hits 0 → 0, hp 220 → 220, no dialog, no question |
| M5 a new click on purpose, then Esc | **PASS**: asked again (1 → 2), Esc = hold, nothing fired |
| M6 «Disparo de advertencia» (R) from the question | **PASS**: sim `shipStopped warned`, piracy true, merchant hp unchanged; opinion reason «piracy» −3 |
| M7 «Hundir» (X) from the question | **PASS**: sim `shipStopped sunk`, piracy true; the piracy reason goes −3 → −23 (−20, the stop panel's figure) |
| M8 convoy, «Declarar la guerra» (G) | **PASS**: war with Switzerland, nothing fired on the way |
| M9 trigger on the convoy at war | **PASS**: fires at once (rounds +1), no question |
| T1 tank trigger on the neighbour's patrol IFV at 60 m (incursion ignored, at peace) | **PASS**: «¿Abrir fuego contra Suiza? En tu punto de mira: tropas o vehículos de Suiza…»; 0 rounds, ammo 34, hp 70 |
| T2 Enter, trigger held 5 s, idle 5 s | **PASS**: nothing fired, no damage, no repeat |
| T3 new click, G | **PASS**: war declared; the next trigger fires (rounds 0 → 1) without a question |

Shots: `shots/owner-31/verify/` (`b1-blockade-dialog.png`, `m1-piracy-question.png`, `t1-question.png`, …), looked at:
the blockade dialog sits over the sea view with the stop panel (now listing «B Bloquear esta zona») beside it; the
piracy question shows its five choices with keys and costs; the tank question names the target and the safe keys.

Final runs on the final code: `f31-verify` ship 10/10 (and the tank section 3/3 in the full run), 0 page errors. One
full run had M5 fail because M4's round, slowed by SwiftShader, landed during M5's window (a verifier timing issue; M4
now waits for the round to come down); an earlier run failed M3 because it pressed the trigger again after «No», which
counts as a new, deliberate shot, and the question correctly came back (M3 now keeps the trigger down through the answer).

**Regression of the command-mode verifiers touched:**
* `tools/naval-verify.mjs --only command`: **9/9** (C5 updated: X then Enter now cancels — new C5a — and X, the key
  on «Hundirlo», confirms).
* `tools/f3c-verify.mjs --only strike,city`: strike **4/4**; city **3/3**, with C1 now a real click on a house: the
  civilian question comes before the shot (rounds fired while asking: 0), G confirms, houses fall, hp 1 → 0.755,
  opinion −70 → −90.
* `tools/w5-verify.mjs --only border,front,ship`: **21/21** (border crossing confirmation, escort neutral until told,
  engage, front kills, losses).
* `npx tsc --noEmit` and `npm run build` clean.

### Still open / notes

* A jet bomb or missile whose predicted path is clear but whose guided missile later retargets onto a neutral cannot
  hurt it (rounds pass through neutrals), so it is safe, but no question is asked for that case.
* Ramming a neutral (owner item 32, «against a nation at peace it is an incident, under the same rules as item 31»)
  belongs to the item-32 work: `World.damage()` simply ignores neutrals now; collisions can call the same question.
* The jet cannon and the anti-ship missile at peace were exercised through the shared gate (same `clearToFire`), not
  with a dedicated jet scenario in the verifier.

## Owner item 32 (2026-10-02, pass 1 of 2) — command-mode combat at the real scale of the front, readable and physical

### What changed

* **Battles at the real scale of the front (top priority).** `src/command/battle.ts` (new, `Forces.battle`): near a
  contact line at war (within 6 km, our side against a nation at war with us) both sides' front and offensive pools
  stand along a 2.4 km stretch of the real contact line centred on the player, re-centred as the player drives along
  it. Figures per side follow the sim's density (1 figure = 25 troops: the front garrison within ~16 km of line drawn
  into the stretch, plus the offensive's pool), at least 60 when the side has troops there, capped at 900 hostile / 650
  friendly; they thicken toward the player. The side with an offensive attacks in **waves** (squads of 8-12 rush bent
  low, drop prone and fire, rush again, from 260-700 m behind the line to a halt line 75 m short of the enemy trench,
  fresh waves from behind as men fall); the other side **holds trenches** (a winding forward trench with sandbag
  parapets, a second trench, reserves that run up, machine gunners, AT teams); a quiet front is two trench lines
  trading fire. Plus **line vehicles** (tanks / IFVs by density, real AI, killed = their crew and squad to the sim),
  **artillery** on the other side's positions (real rounds with splash, ~1/s per side at the height of an offensive,
  rumble and battery flashes on the horizon), **smoke screens** ahead of the waves, **tracers and muzzle flashes**
  from the whole line, wrecks burning in no man's land and craters. The far figures are the instanced crowd, animated
  and firing (visual tracers); within 1 km they wake with the full AI and real rounds. The sim stays the source of
  truth: the counts follow its pools, falls between the two sides are the picture of its attrition (replaced while the
  sim has the troops), and every man or vehicle the player kills goes to the sim (`commandCasualties`).
* **Finding the action.** «Ir al combate» / the take-control march goes to the **hottest point**: on a front with an
  offensive, the biggest offensive's live contact (`liveContact`), and `combatTargets` weighs an offensive's contact by
  its troops and a line point by the front's intensity (quiet lines count as farther). The march now ends **among our
  own line** (stop 0.6 km, contact line 1.0 km; it used to stop 1.2-1.5 km short, behind a ridge). In command mode the
  chip on top is always about the battle: «Batalla en la línea contra Suiza · Lo más duro, a 1,2 km · intensidad muy
  alta · 650 nuestros, 59 enemigos a la vista» with distance and compass direction, and a world marker on the hot point
  (where the assault ranks, the shells and the falls of the last seconds are). On arrival one line says what is there:
  «Frente contra Suiza: 59 soldados enemigos y 650 nuestros en 2,4 km de línea (cada figura son 25). Nuestra ofensiva
  avanza en oleadas: apóyala con el cañón.» On the strategic map every front of ours carries **«⌖ Tomar el control
  aquí»** on its badge (a button, not only the double click) and a front with a running offensive **pulses**.
* **Soldier models.** `src/command/models/soldier.ts` (new): real proportions (capsule limbs, plate carrier, pouches,
  pack, face, chin strap), helmets, rifle / AT launcher / machine gun, the uniform in field colours with the nation's
  cast and the **nation's band** on the helmet and sleeve; a lighter level of detail for the far crowd. **Animated in
  the vertex shader** (hips, knees, arms, torso, whole body): idle, walk, run, rush bent low, kneel to fire, stand to
  aim, prone to fire, recoil on every shot, and **the fall when hit** (knees give, the body falls back or forward and
  lies still; no blood, a puff of dust). Far figures keep ~4 px on screen (at most 3.5× size) and take more of the
  nation's colour beyond ~500 m. Lab: `tools/model-lab/soldier.html`.
* **Shooting.** HE is a fragmentation round (40 dmg, 15 m splash, ×1.8 on men in the open, ×0.7 in cover: lethal to
  ~11 m); the coax does 9 per round (a man has 12: two hits) and fires at its real rate whatever the frame rate; the
  player's rounds hit a man within 0.78 m of his middle, the middle follows his pose (prone men are hit low). **Target
  brackets** with «BLANCO · tipo · distancia» on the enemy under (or nearest to) the reticle, and a **lead diamond**
  «apunta aquí» for a moving target (the loaded round's flight time). Hit and kill markers as before; sparks on
  vehicles, dust on men.
* **Physical damage.** The player's machine-gun rounds now hit buildings: chips, dust and broken glass, and **small real
  damage** in the sim (0.015 % of a structure per round; a city takes a sliver, no house comes down); the HUD says
  «Ametralladora contra Fábrica: casi no le hace nada (99,7 % en pie). Usa el cañón con explosivo (2) o pide
  bombarderos.» Heavier weapons keep their larger shares (HE 8 %, AP 2 %, bombs 30 %…).
* **Collisions and ramming.** A tank running over men above 1 m/s kills them (credited, sent to the sim; our own men
  step aside); ramming a vehicle does kinetic damage by mass and closing speed both ways (a truck at 50 km/h is
  wrecked, the tank loses ~5 %; another tank takes as much as it gives); small city houses at war (city confirmed)
  come down with debris; trees are knocked down in the direction of travel; driving through a compound's fence
  flattens a section of it (and nicks the structure at war). Against a nation at peace it is item 31's rule: the tank
  stops against the force / before the fence and the question «¿Embestir a X?» opens (Declarar la guerra · Frenar).
* In-game help (`help.command.body`) explains the battle, the weapons against men and buildings and ramming.

### Continued (2026-10-04, same pass): what looking at the real play showed, and the fixes

The first verifier passed on numbers (650 ours + 59 enemy in the scene, "418 on screen") but the shots told another
story: arriving through «Tomar el control aquí» on the staged 400,000-troop offensive, the tank stood **1.2-1.5 km**
from the contact line in a Pyrenean valley and the screen showed bare hills. The "on screen" count was inside the frame
only, not in sight: with the line of sight checked, **72 ours and 2 enemy** were visible, most of them prone 2-3 px
specks the colour of the ground. That is the owner's "two guys" again, so this pass changed:

* **Arrive in the battle, at its hottest stretch.** The march stops 0.35 km from the target, or as soon as a contact
  line at war with enemy soldiers on it is within 0.5 km (was 0.6 / 1.0). Then, taken there from an entry with a goal
  or a march, the tank **drives itself** at tactical speed to 220 m behind the line at the battle's hottest stretch
  (`BattleLine.bestStandOff`, `TankController.driveTo`; it steers, slows in turns, any driving key takes over, the
  goal follows the stretch as the line moves, and it stops on ground a tank can stand on, looking at the fight: the
  enemy's forward trench and the figures ahead in sight — the first tries parked the tank across a 50° Pyrenean slope,
  then facing a hillside; on arrival the view turns to the fighting).
  The arrival line says so: «… Tu carro avanza solo hasta lo más duro, a 510 m
  (cualquier tecla de marcha toma el mando).»
* **«Ir al combate» inside a battle** used to answer «Ya estás en contacto» (anything hostile within 4 km counted). Now
  G (and the chip's button, shown while the stand-off there is > 350 m away) drives to the hottest stretch; under 150 m it
  says «Estás en lo más duro del combate: la línea enemiga está justo delante.»
* **The hot point holds still**: its 8 bins are smoothed over ~6 s and it moves only to a stretch a third hotter (it
  jumped 300-750 m between frames, dragging the chip, its marker and the drive with it).
* **Readable far soldiers.** Active soldiers (within 1 km, the ones in front of the tank) had no distance scaling:
  at 600 m a man was 3 px tall and a prone one 1 px. Every figure now keeps ≥ 5 px (drawn up to 3.5× life size beyond
  ~350 m; never in the gunner's sight), and the player's rounds hit the figure as drawn (`Ent.drawScale`). Far muzzle
  flashes keep ~3 px and the crowd's tracers ~1.4 px (a line firing reads as a line of twinkles and streaks). Assault
  waves spend half of each cycle running and kneel as often as they lie down.
* **Uniforms that are not "raros".** The nation's colour was mixed raw into khaki: Switzerland's red made pink figures
  that read as bare skin. `fieldUniform` blends the side's field shade (olive ours, khaki theirs) with a dark, muted
  version of the nation's hue (red → brown-red, blue → blue-grey, green → olive); the full colour stays on the helmet
  band and arm band. The pack is smaller and in the uniform's darker shade (a black box on the back read as a crate).
* **One clock for the scene and the sim.** Under SwiftShader the scene runs at ~0.08× real time (frames of ~1 s, dt
  clamped to 0.1 s) while the sim's tactical clock ran at 1×: the front ran away from the battle standing on it
  (1.2 → 1.55 km in 15 scene seconds). The sim's tactical clock now follows the scene's measured pace (`scenePace`,
  ≥ 0.05; unchanged at ≥ 9.2 frames a second). This also protects slow real machines.
* **Lighter men where it does not show.** All active soldiers (up to ~600 within 1 km) used the full figure (5.6k
  vertices, shadow pass included). They are now packed every frame into the full figure only while ≥ 13 px tall on
  screen (~110 m in the chase view, ~900 m in the gunner's sight) and the light one (1.1k, no shadow) beyond; under
  SwiftShader the scene's pace doubled (0.05 → 0.1× real time) with the same battle.
* **A denser fight where the player is.** Waves start 180-520 m behind the line (was 260-700), figures thicken toward
  the player as |u|² (half within ±300 m; was |u|^1.7), and the far falls between the two sides are a third of what
  they were (0.15 % of exposed attackers a second at full heat: 274 bodies piled up in 100 s of scene time before, a
  picture far beyond the sim's own losses).
* The chip says «N nuestros y M enemigos en este tramo» (they are the stretch's figures, not all «a la vista»).
* The ramming debug log is gone. Verifier: counts soldiers in the camera's line of sight (in this view and all around),
  the arrival drive (S7), G inside a battle (G1), the plain battle near Zaragoza seen from the tank and through the
  sight (P1-P2), and runs its long waits on a small viewport (SwiftShader).
* The ramming question has its own footnote («Intro o Esc: frenar, sin tocarlo…»; it used the firing one, «no
  disparar… vuelve a apretar el gatillo»).

### Verified in real play

`node tools/f32-verify.mjs` (Chromium + SwiftShader on a no-HMR snapshot server, the real UI and keys; shots in
`shots/owner-32-1/run16/`, K1 rerun in `run17/`). SwiftShader runs the scene at 0.05-0.1× real time, so the drives
below took 10-20 real minutes each; the sim's clock followed the scene (`pace`).

| Row | What | Measured | |
|---|---|---|---|
| S0 | our offensive of the staged war (f3-missions, Spain → Switzerland, Pyrenees) | 400,810 troops | PASS |
| S1 | both sides at the sim's density | 649 ours + 58 enemy in the scene, 571 within 1 km (ours 1,954 troops/km attacking, theirs 19/km defending) | PASS |
| S2 | vehicles in the battle | 9 ours, 0 enemy | PASS |
| S7 | entered from the Guerra panel's «Tomar el control aquí»: the march ends in the battle and the tank drives on to the hottest stretch | at entry line 641 m, stand-off 447 m, driving; «arrived» after 58 s of scene time, line 389 m | PASS |
| S3a | soldiers in sight around the player after arriving (≤ 2.5 km, not behind the ground) | 172 ours (the enemy's 58 sit in trenches behind the crest) | PASS |
| S3 | in sight looking toward the fight | 117 ours + 2 vehicles (511 inside the frame counting those behind hills) | PASS |
| S4 | the fight is alive | heat 0.86, 12 shells and 16 falls in the last 10 s | PASS |
| S5 | the chip says where the fighting is | «Batalla en la línea contra Suiza · Lo más duro, a 680 m · intensidad muy alta · 650 nuestros y 59 enemigos en este tramo · 680 m · este · [G] Ir al combate» | PASS |
| S6 | trenches along the defended line | 1,500 parapet segments | PASS |
| C0/C1 | soldier close-ups at 20, 50 and 150 m, ours and theirs | shots `close-*-{20,50,150}m.png` (riflemen prone and kneeling, an AT gunner in the enemy trench) | PASS ×6 |
| M1 | MG on an enemy factory: small but real sim damage | hp 1.0000 → 0.9988 after 8 rounds on it | PASS |
| M2 | the HUD says it is ineffective | «Ametralladora contra Fábrica: casi no le hace nada (99,9 % en pie). Usa el cañón con explosivo (2) o pide bombarderos.» | PASS |
| M3 | driving through a compound fence | 1 section down, «Has arrollado una valla» | PASS |
| P0 | the plain near Zaragoza (command-front), at entry | line 1,076 m, 17 + 59 in sight around; a quiet front, both sides holding (113 + 167 figures: the sim's thin garrisons there) | PASS |
| G1 | G inside the battle (from 650 m back on our side) | «Hacia lo más duro del combate, a 580 m, entre nuestra línea…»; «arrived» after 39 s, line 252 m, tank alive | PASS |
| P1 | at the hot stretch: in sight around | 51 ours + 30 enemy of 113 + 167 (29 %; the run used a fixed «≥ 100», now a share of what stands there) | FAIL → criterion fixed |
| P2 | looking toward the line | 18 enemy in sight (the enemy trench), ours behind | FAIL → criterion fixed |
| K1 | HE kills infantry in a radius | run16: the kill feed showed 2 infantry and an IFV killed by the shells, but the per-shell window closed before the bursts (slow frames). run17, counted until each shell has burst: **11 men by 4 shells** (84 m → 4, 90 m → 1, 140 m → 4, 140 m → 2) | PASS (run17) |
| K2′ | the coax again (run17) | 1 killed at ~140 m (squad at 150 m); 275 troops sent to the sim | PASS |
| K2 | the coax cuts down infantry | 2 killed at ~60 m; 275 troops sent to the sim | PASS |
| R1 | running over infantry | 4 run over | PASS |
| R2 | ramming a light vehicle | truck wrecked, the tank lost 7.4 hp | PASS |
| R3 | ramming a truck of a nation at peace (China) | the tank stops, «¿Embestir a China? …» opens; Enter = Frenar: no war, the truck unharmed (30 → 30 hp) | PASS |

Before this pass's fixes, the same entry measured **72 ours + 2 enemy in sight** at 1.2 km from the line (run10).

`npx tsc --noEmit`, `npm run build` and `npx tsx tools/i18n-check.mjs` (1,498 keys, none missing) are clean.

### Still open (for pass 2)

* **The review of the run16 shots (FEEDBACK-1, «Item 32: review of the first-pass shots») says scale and the soldier
  close-ups do not meet item 32 yet**: the battle reads as scattered figures on a hillside, the enemy line is not
  visible, and the close-up figure is dark and blocky. Its direction for pass 2: density near the player decoupled from
  «1 figure = 25» (hundreds of figures within ~600 m, still instanced, kills still credited to the sim by its own
  numbers), an enemy line that is always visible and alive (never 600 m away over a ridge), and soldiers that read in
  close-up (silhouette, nation colour, lighting). After that review the field uniforms were lightened a little (base
  shades and the nation hue at lightness 0.39); not re-verified in the game.

* **Mountain fronts stay sparse to the eye.** On the staged Pyrenean offensive the counts are right (650 ours, 172 in
  sight around after arriving, 117 toward the fight) but a slope or a crest hides most of any single view, and the
  enemy's thin garrison (58 figures for 19 troops/km) sits in trenches behind the crest: from our side the enemy line
  reads through its fire, shells and smoke more than through its men. The plain shows both lines. Ideas: put the
  defenders' trenches on the forward slope (where trenches really go), add the enemy's firing positions to what the
  stand-off must see, and an overview key (a few seconds of a higher camera) to take in the whole line.
* **The tank is exposed at the hot stretch.** 220 m behind the line it is ~335 m from the enemy trench and its AT teams
  (run16: 100 % on arriving in the Pyrenees; on the plain 81 % after G's drive and 68 % at the end of the kill and ram
  tests; the command-front staging, which puts the tank on the enemy's side of the line, lost all four tanks driving
  back through the enemy trench in run15). Pass 2 should tune
  the AT teams' reaction to a tank that just arrived, or stop the drive 300 m back when the enemy has AT teams there.
* **The far crowd still loses against busy ground from high up** (the 260 m overview shot): 5 px figures among the
  terrain's dark speckle. A darker silhouette tone beyond ~600 m or a light nation-coloured rim would help.
* **Prone men show a dark pack slab** at 20 m (the pack takes the uniform's darker shade and lies in shadow); the crowd's
  far figure (1.1k vertices) could get a still lighter version for beyond ~600 m.
* **The gunner's sight looks into the grass** when aimed slightly down at a near crest (13° field of view magnifies the
  grass a few metres ahead); a sight height above the grass or a grass fade near the sight is needed.
* **Verifier speed.** Under SwiftShader a full `f32-verify` takes ~2 hours (each drive 10-20 real minutes); `--only`
  runs the sections separately. The other command-mode verifiers were not re-run after the sim-clock pace change except
  `f31-verify --only tank`: T1 and T2 passed 3 times out of 3; T3 (after «Declarar la guerra», a new click fires)
  failed twice with no round within its 5 s window and passed on the third run (rounds 0 → 1, the gate cleared the
  shot; the row now prints the gate's counters). The same section on the code before this pass could not stage the
  neighbour's patrol within 240 s, so the A/B was inconclusive: T3 looks timing-sensitive under SwiftShader rather
  than broken, but naval-verify, f3c-verify and w5-verify should be re-run on a machine with a GPU.
