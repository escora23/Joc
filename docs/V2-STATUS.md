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
- operational arrows as wide as the offensive's corridor; naval invasion arrows; mobilization arrows until mobilizeUntilTick;
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

1. front-orbit at 2500 km: the band shows both colours; chevrons point in the advance direction; an operational arrow as wide as the corridor (+-15%) runs from the attacker to the axis point; the badge shows both ISO3 codes, the tug-of-war bar and measured km/h; a reviewer names attacker, defender, direction and who is winning from the screenshot alone

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

See docs/FEEDBACK-1.md, section "Owner feedback #2", items 18–24 (release keeps position; fast, sensible incursion
response with warning + short grace + real interceptors; sensible escorts, no ramming trucks; command-mode entry
matches the enemies visible on the strategic/battle view; slimmer attack arrows that don't hide the front; a clear,
non-click-spam attack flow; small polish). Whoever works on command mode, fronts, integration or gauntlet fixes MUST
treat these as blockers. Order of work requested by the owner: finish the in-flight task, then fix 18–24 properly,
without another endless cycle.
