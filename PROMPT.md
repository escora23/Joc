# FRONT ULTRA — master prompt

This is the prompt the whole build was run against. Every agent that worked on this repo received it.

---

I want you to build **FRONT ULTRA**: a real-time global-conquest war game that runs in the browser, at the level of **OpenFront.io** for its strategic depth and addictive expansion loop, crossed with the spectacle of **Supreme Commander** (seamless strategic zoom), **DEFCON** (the dread of nuclear war on a glowing world) and **Battlefield** (immersive, visceral combat up close). It should be utterly perfect, visually breathtaking, with every single thing done at AAA quality — from the loading screen to the living 3D Earth to the front lines to the nukes to the HUD to the sound to the moment you take control of a tank in the middle of a war, and anything else you could think of.

Fan out sub-agents and have sub-agents tackle each subsystem individually so that the game is utterly perfect. Loop on each item and have a separate sub-agent check it visually — screenshots from a real browser, and real playthroughs — to ensure it looks and plays triple A. That separate sub-agent must be a really harsh critic, and if something isn't triple A, it keeps going. Don't stop until each critic is utterly wowed when comparing the game with the references, literally side by side and blind: "which one looks better, which one would I rather play?" Do this in Three.js + TypeScript + Vite. Loop until it's utterly perfect.

## The game

**Premise.** The real Earth, as a living 3D planet. You found a nation anywhere on it and fight dozens of AI nations for the world, in real time, with a modern arsenal — from infantry pushing a front line to hydrogen bombs. At any moment you can zoom from orbit down to the ground and watch the war actually being fought, and you can dive into a single tank, fighter jet or warship and fight it yourself.

**Flow.** Cinematic loading screen → main menu over a live, slowly rotating Earth → skirmish setup (nation name, color, difficulty Easy/Normal/Hard/Insane, number of AI nations, game speed) → spawn phase (click anywhere on land to place your capital; AI nations appear at real countries, named after them) → the war → victory/defeat screen with stats, a territory-over-time graph and a timelapse replay of the world map. Pause and 1x/2x/4x speed at all times. Default UI language Spanish, with an English toggle.

**Strategic layer (OpenFront-style, deterministic, fixed-tick simulation in a Web Worker).**
- The Earth is a 1600×800 equirectangular tile grid built from real data: land/water from the NASA water mask, elevation from the NASA topology map (plains / hills / mountains change attack cost and defense), country shapes and names from Natural Earth.
- Nations have troops (logistic growth toward a cap from territory and cities), gold (income from territory, cities, trade, factories) and an attack-ratio slider. Attacks push a front line tile by tile into neutral land or enemies; cost depends on terrain and defender density. Naval invasions by transport ship.
- Structures: City, Port, Factory (rail network, trains carry gold), Defense Post, SAM Site, Missile Silo, Airbase, Army Base (armored divisions), Naval Yard, Radar.
- Units: transport ships, trade ships, warships, armored divisions, fighter squadrons, bombers, drone swarms, cruise missiles, atom bomb, hydrogen bomb, MIRV, SAM interceptors.
- Diplomacy: alliances, betrayal (with a traitor penalty), embargoes, donations, quick-chat emotes.
- AI nations with personalities (conqueror, turtle, trader, nuker, opportunist) scaled by difficulty.
- World events so there is always something happening: earthquakes, hurricanes at sea, rebellions, gold rushes, pandemics, a doomsday clock late game.
- Win at 80% of the world's land or last nation standing.

**The planet.** Photoreal Earth: day texture, relief lighting from real elevation, animated ocean with sun glint, night-side city lights (plus your own cities glowing), atmospheric scattering, moving cloud layer, stars and Milky Way, a sun that crosses the sky with a moving day/night terminator. Territories are painted onto the planet in nation colors with glowing borders, pulsing hot front lines where fighting happens, and nation names with troop counts laid over their land.

**Seamless zoom.** Smooth orbit → ground camera with inertia; the camera tilts toward the horizon as it descends. Near the ground over an active front, the war becomes visible: instanced infantry, tanks and artillery on terrain built from the real elevation, muzzle flashes, tracers, explosions, smoke, craters, burning cities — density driven by the real troop numbers on each side.

**Weapons you can see.** Ships with wakes, jets with contrails, missiles on ballistic arcs with smoke trails. Nukes are the peak: whiteout flash, fireball, mushroom cloud, a shockwave ring racing across the planet's surface, a scorched radioactive scar that fades over minutes, camera shake, the sound going silent then roaring back.

**Command mode — take control.** Select an armored division, a warship or a fighter squadron and press TAKE CONTROL: a cinematic dive from orbit into a third-person battle at that exact place on Earth. Drive a tank (turret on the mouse, shells with drop), fly a jet (flight model, guns and missiles) or command a warship (naval guns). The enemies are the real enemy nation you are at war with there; your kills remove real enemy troops/units from the strategic simulation, and if you die the unit is lost. Leave with a cinematic climb back to orbit.

**Interface.** Sleek military/sci-fi DOM HUD: animated, readable, glassy panels, monospace numerals, SVG icons. Top bar (troops, gold, income, population), attack-ratio slider, build bar with hotkeys, selection panel, leaderboard, minimap, breaking-news ticker ("BREAKING: France detonates a hydrogen bomb over Madrid"), alliance toasts, right-click diplomacy radial menu, time controls, settings (graphics preset Low/Medium/High/Ultra, volumes, sensitivity), first-minutes tutorial hints.

**Sound.** All procedural Web Audio, no audio files: adaptive music that swells as the war escalates, UI clicks, distance-attenuated artillery rumble, jet fly-bys, tank engines, sirens when a nuke is inbound on you, and the silence-then-roar of a detonation.

## Hard rules

- Runs in a normal desktop browser from a static build (`npm run build` → `dist/`), no server, no runtime network. The only art files are the NASA Earth textures in `public/textures`; every mesh, texture, effect and sound beyond that is generated by code.
- 60 fps on a mid-range laptop GPU on High; quality presets scale down. The simulation lives in a Web Worker. Shaders are compiled during the loading screen, never mid-game.
- Inspired by OpenFront.io but no OpenFront code is copied (its code is AGPL-licensed): mechanics are re-implemented from scratch.
- Every scene can be staged for a screenshot with `?shot=<name>` so critics can see it.
