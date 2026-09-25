// FRONT ULTRA — command mode HUD styles (owner: command). Injected once; uses the ui owner's CSS variables.

export const HUD_CSS = /* css */ `
.fu-cmd { position: absolute; inset: 0; z-index: 20; pointer-events: none; overflow: hidden;
  font-family: var(--fu-font, 'Barlow', sans-serif); color: var(--fu-text, #e8f2ff); user-select: none; }
.fu-cmd.fu-cmd-hidden { display: none; }
.fu-cmd canvas.fu-cmd-vec { position: absolute; inset: 0; width: 100%; height: 100%; }
.fu-cmd-vig { position: absolute; inset: 0; opacity: 0; transition: opacity 0.12s linear;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(150,0,0,0.35) 75%, rgba(120,0,0,0.75) 100%); }
.fu-cmd-low { position: absolute; inset: 0; opacity: 0; animation: fu-cmd-pulse 1.1s ease-in-out infinite;
  background: radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(200,20,20,0.28) 100%); }
.fu-cmd-scope { position: absolute; inset: 0; opacity: 0; transition: opacity 0.15s;
  background: radial-gradient(circle at center, rgba(0,0,0,0) 0, rgba(0,0,0,0) 34vh, rgba(3,6,8,0.96) 34.4vh); }
.fu-cmd-letter { position: absolute; left: 0; right: 0; height: 0; background: #000; transition: height 0.8s var(--fu-ease, ease); }
.fu-cmd-letter.top { top: 0; } .fu-cmd-letter.bot { bottom: 0; }
.fu-cmd.fu-cmd-cine .fu-cmd-letter { height: 9vh; }
.fu-cmd.fu-cmd-cine .fu-cmd-panel, .fu-cmd.fu-cmd-cine .fu-cmd-help { opacity: 0 !important; }
@keyframes fu-cmd-pulse { 0%,100% { opacity: 0.25; } 50% { opacity: 1; } }

.fu-cmd-panel { position: absolute; background: linear-gradient(180deg, rgba(8,14,22,0.72), rgba(5,9,15,0.62));
  border: 1px solid rgba(132,196,255,0.18); border-radius: 3px; backdrop-filter: blur(8px) saturate(1.2);
  box-shadow: 0 0.5rem 1.6rem rgba(0,0,0,0.35); transition: opacity 0.6s; }
.fu-cmd-panel::before { content: ''; position: absolute; left: -1px; top: -1px; width: 10px; height: 10px;
  border-left: 2px solid var(--fu-accent, #3fd0ff); border-top: 2px solid var(--fu-accent, #3fd0ff); }
.fu-cmd-panel::after { content: ''; position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px;
  border-right: 2px solid var(--fu-accent, #3fd0ff); border-bottom: 2px solid var(--fu-accent, #3fd0ff); }

.fu-cmd-obj { top: 4.9rem; left: 50%; transform: translateX(-50%); padding: 0.45rem 1rem 0.55rem; min-width: 25rem; text-align: center; }
.fu-cmd-obj .t { font: 700 0.72rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.28em; color: var(--fu-accent-2, #ffb53d); }
.fu-cmd-obj .d { font: 600 0.98rem/1.25 var(--fu-font, sans-serif); margin-top: 0.3rem; letter-spacing: 0.02em; }
.fu-cmd-obj .bar { position: relative; height: 4px; background: rgba(255,255,255,0.1); margin-top: 0.45rem; }
.fu-cmd-obj .bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(90deg, #ffb53d, #ffd780);
  box-shadow: 0 0 10px rgba(255,181,61,0.8); transition: width 0.4s var(--fu-ease, ease); }
.fu-cmd-obj .n { position: absolute; right: 0.8rem; top: 0.42rem; font: 700 0.85rem/1 var(--fu-font-mono, monospace); color: #ffd780; }
.fu-cmd-obj.done { border-color: rgba(69,240,160,0.5); }
.fu-cmd-obj.done .t { color: var(--fu-success, #45f0a0); }
.fu-cmd-obj.done .bar i { background: var(--fu-success, #45f0a0); box-shadow: 0 0 10px rgba(69,240,160,0.8); }

.fu-cmd-mission { top: 1rem; left: 1rem; padding: 0.55rem 0.85rem 0.6rem 0.85rem; min-width: 15rem; }
.fu-cmd-mission .k { font: 700 0.66rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.26em; color: var(--fu-text-dim, #7d91a8); }
.fu-cmd-mission .v { font: 700 1.05rem/1.2 var(--fu-font-display, sans-serif); letter-spacing: 0.08em; margin-top: 0.2rem; text-transform: uppercase; }
.fu-cmd-mission .vs { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.45rem; font: 600 0.8rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.1em; text-transform: uppercase; }
.fu-cmd-mission .sw { width: 0.8rem; height: 0.8rem; border-radius: 2px; box-shadow: 0 0 8px currentColor; }
.fu-cmd-mission .clock { font: 600 0.72rem/1 var(--fu-font-mono, monospace); color: var(--fu-text-dim, #7d91a8); margin-top: 0.45rem; }

.fu-cmd-exit { position: absolute; top: 1rem; right: 1rem; pointer-events: auto; cursor: pointer; padding: 0.5rem 0.9rem;
  font: 700 0.74rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.22em; color: var(--fu-text, #e8f2ff); text-transform: uppercase;
  background: rgba(8,14,22,0.7); border: 1px solid rgba(132,196,255,0.3); border-radius: 3px; }
.fu-cmd-exit:hover { border-color: var(--fu-accent, #3fd0ff); color: var(--fu-accent, #3fd0ff); }
.fu-cmd-exit kbd { font: 700 0.66rem/1 var(--fu-font-mono, monospace); padding: 0.15rem 0.3rem; margin-left: 0.5rem; border: 1px solid currentColor; border-radius: 2px; opacity: 0.8; }

.fu-cmd-feed { position: absolute; top: 3.9rem; right: 1rem; width: 22rem; display: flex; flex-direction: column; align-items: flex-end; gap: 0.3rem; }
.fu-cmd-feed .e { display: flex; align-items: center; gap: 0.45rem; padding: 0.32rem 0.6rem; font: 700 0.76rem/1 var(--fu-font-cond, sans-serif);
  letter-spacing: 0.1em; text-transform: uppercase; background: rgba(6,10,16,0.66); border-left: 2px solid var(--c, #3fd0ff);
  animation: fu-cmd-feed-in 0.35s var(--fu-ease, ease) both; transition: opacity 0.6s; }
.fu-cmd-feed .e .who { color: var(--c, #3fd0ff); }
.fu-cmd-feed .e .arr { opacity: 0.6; }
.fu-cmd-feed .e .pts { font-family: var(--fu-font-mono, monospace); color: #ffd780; margin-left: 0.2rem; }
.fu-cmd-feed .e.you { background: rgba(40,28,6,0.72); }
.fu-cmd-feed .e.bad .who { color: var(--fu-danger, #ff4a4a); }
@keyframes fu-cmd-feed-in { from { opacity: 0; transform: translateX(1.5rem); } to { opacity: 1; transform: none; } }

.fu-cmd-status { left: 1rem; bottom: 1rem; padding: 0.7rem 0.9rem 0.75rem; width: 19rem; display: grid; grid-template-columns: 5.2rem 1fr; gap: 0.2rem 0.9rem; }
.fu-cmd-status .icon { grid-row: 1 / span 3; width: 5.2rem; height: 5.2rem; position: relative; }
.fu-cmd-status .icon svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.fu-cmd-status .lbl { font: 700 0.62rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.24em; color: var(--fu-text-dim, #7d91a8); }
.fu-cmd-status .hp { display: flex; align-items: baseline; gap: 0.4rem; }
.fu-cmd-status .hp b { font: 700 1.55rem/1 var(--fu-font-mono, monospace); }
.fu-cmd-status .hp span { font: 600 0.72rem/1 var(--fu-font-mono, monospace); color: var(--fu-text-dim, #7d91a8); }
.fu-cmd-status .hpbar { height: 5px; background: rgba(255,255,255,0.1); position: relative; overflow: hidden; }
.fu-cmd-status .hpbar i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--fu-success, #45f0a0); transition: width 0.25s, background 0.3s; }
.fu-cmd-status .row { display: flex; gap: 1rem; margin-top: 0.35rem; grid-column: 1 / span 2; }
.fu-cmd-status .row div { display: flex; flex-direction: column; gap: 0.25rem; }
.fu-cmd-status .row b { font: 700 1.05rem/1 var(--fu-font-mono, monospace); }
.fu-cmd-status .row b small { font-size: 0.62rem; color: var(--fu-text-dim, #7d91a8); margin-left: 0.2rem; }

.fu-cmd-weap { right: 1rem; bottom: 1rem; padding: 0.55rem 0.7rem; width: 17.5rem; display: flex; flex-direction: column; gap: 0.35rem; }
.fu-cmd-weap .w { display: grid; grid-template-columns: 2.4rem 1fr auto; align-items: center; gap: 0.5rem; padding: 0.3rem 0.4rem; border-radius: 2px; opacity: 0.62; }
.fu-cmd-weap .w.on { opacity: 1; background: rgba(63,208,255,0.1); box-shadow: inset 2px 0 0 var(--fu-accent, #3fd0ff); }
.fu-cmd-weap .w kbd { font: 700 0.62rem/1 var(--fu-font-mono, monospace); padding: 0.2rem 0; text-align: center; border: 1px solid rgba(255,255,255,0.35); border-radius: 2px; color: var(--fu-text-2, #b3c4d6); }
.fu-cmd-weap .w .nm { font: 700 0.74rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.16em; text-transform: uppercase; }
.fu-cmd-weap .w .ct { font: 700 1rem/1 var(--fu-font-mono, monospace); }
.fu-cmd-weap .w .rl { grid-column: 2 / span 2; height: 2px; background: rgba(255,255,255,0.1); position: relative; }
.fu-cmd-weap .w .rl i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--fu-accent-2, #ffb53d); }
.fu-cmd-weap .w .rl.ok i { background: var(--fu-accent, #3fd0ff); }

.fu-cmd-help { position: absolute; left: 50%; bottom: 1.2rem; transform: translateX(-50%); padding: 0.45rem 0.9rem; max-width: 46rem; text-align: center;
  font: 600 0.74rem/1.45 var(--fu-font-cond, sans-serif); letter-spacing: 0.08em; color: var(--fu-text-2, #b3c4d6);
  background: rgba(5,9,15,0.55); border-radius: 3px; transition: opacity 1.2s; }
.fu-cmd-help b { color: var(--fu-accent, #3fd0ff); }

.fu-cmd-warn { position: absolute; left: 50%; top: 31%; transform: translate(-50%, -50%); display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
.fu-cmd-warn div { font: 800 1.2rem/1 var(--fu-font-display, sans-serif); letter-spacing: 0.32em; padding: 0.4rem 1rem; color: #ff5a4a;
  border: 1px solid rgba(255,90,74,0.7); background: rgba(40,4,4,0.55); text-shadow: 0 0 12px rgba(255,60,40,0.9); animation: fu-cmd-blink 0.5s steps(2) infinite; }
.fu-cmd-warn div.amber { color: #ffc14a; border-color: rgba(255,193,74,0.7); background: rgba(40,28,4,0.55); text-shadow: 0 0 12px rgba(255,170,40,0.9); }
@keyframes fu-cmd-blink { 50% { opacity: 0.62; } }

.fu-cmd-banner { position: absolute; left: 50%; top: 22%; transform: translate(-50%, -50%); text-align: center; opacity: 0; transition: opacity 0.5s, transform 0.5s; }
.fu-cmd-banner.show { opacity: 1; transform: translate(-50%, -50%) scale(1); }
.fu-cmd-banner .big { font: 800 3.2rem/1 var(--fu-font-display, sans-serif); letter-spacing: 0.3em; color: var(--fu-success, #45f0a0);
  text-shadow: 0 0 24px rgba(69,240,160,0.8), 0 0 60px rgba(69,240,160,0.4); }
.fu-cmd-banner .sub { font: 600 0.95rem/1.4 var(--fu-font-cond, sans-serif); letter-spacing: 0.14em; margin-top: 0.6rem; color: var(--fu-text, #e8f2ff); text-transform: uppercase; }

.fu-cmd-killtxt { position: absolute; left: 50%; top: 63%; transform: translateX(-50%); text-align: center; font: 800 0.95rem/1 var(--fu-font-display, sans-serif);
  letter-spacing: 0.26em; color: #fff; text-shadow: 0 0 10px rgba(255,80,60,0.9); opacity: 0; transition: opacity 0.25s; }
.fu-cmd-killtxt b { color: #ffd780; font-family: var(--fu-font-mono, monospace); margin-left: 0.6rem; letter-spacing: 0.05em; }
.fu-cmd-killtxt.show { opacity: 1; }

.fu-cmd-lockhint { position: absolute; left: 50%; top: 64%; transform: translateX(-50%); font: 700 0.74rem/1 var(--fu-font-cond, sans-serif);
  letter-spacing: 0.2em; color: var(--fu-text-2, #b3c4d6); background: rgba(5,9,15,0.6); padding: 0.4rem 0.8rem; border-radius: 3px; }

.fu-cmd-intro { position: absolute; left: 6vw; top: 50%; transform: translateY(-50%); opacity: 0; transition: opacity 0.9s; }
.fu-cmd-intro.show { opacity: 1; }
.fu-cmd-intro .op { font: 700 0.8rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.5em; color: var(--fu-accent-2, #ffb53d); }
.fu-cmd-intro .name { font: 800 3.6rem/1 var(--fu-font-display, sans-serif); letter-spacing: 0.14em; margin-top: 0.5rem; text-shadow: 0 0 30px rgba(0,0,0,0.6); }
.fu-cmd-intro .line { width: 16rem; height: 2px; background: linear-gradient(90deg, var(--fu-accent, #3fd0ff), transparent); margin: 1rem 0; }
.fu-cmd-intro .row { font: 600 1rem/1.6 var(--fu-font-cond, sans-serif); letter-spacing: 0.16em; text-transform: uppercase; color: var(--fu-text-2, #b3c4d6); }
.fu-cmd-intro .row b { color: var(--fu-text, #e8f2ff); }
.fu-cmd-intro .mono { font-family: var(--fu-font-mono, monospace); letter-spacing: 0.06em; }

.fu-cmd-over { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.6s;
  background: radial-gradient(ellipse at center, rgba(4,8,14,0.55), rgba(2,4,8,0.88)); }
.fu-cmd-over.show { opacity: 1; }
.fu-cmd-over.dead { background: radial-gradient(ellipse at center, rgba(40,4,4,0.45), rgba(10,1,1,0.9)); }
.fu-cmd-over .card { width: 34rem; padding: 1.6rem 1.9rem 1.5rem; position: relative; }
.fu-cmd-over .hdr { font: 700 0.75rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.42em; color: var(--fu-accent-2, #ffb53d); }
.fu-cmd-over .ttl { font: 800 2.2rem/1.05 var(--fu-font-display, sans-serif); letter-spacing: 0.12em; margin-top: 0.5rem; text-transform: uppercase; }
.fu-cmd-over.dead .ttl { color: #ff5a4a; text-shadow: 0 0 20px rgba(255,60,40,0.6); }
.fu-cmd-over .rows { margin-top: 1.1rem; display: flex; flex-direction: column; gap: 0.5rem; }
.fu-cmd-over .r { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 1px solid rgba(132,196,255,0.12); padding-bottom: 0.45rem;
  font: 600 0.9rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.12em; text-transform: uppercase; color: var(--fu-text-2, #b3c4d6);
  animation: fu-cmd-feed-in 0.4s var(--fu-ease, ease) both; }
.fu-cmd-over .r b { font: 700 1.15rem/1 var(--fu-font-mono, monospace); color: var(--fu-text, #e8f2ff); letter-spacing: 0.02em; }
.fu-cmd-over .r b.red { color: #ff6a5a; } .fu-cmd-over .r b.green { color: var(--fu-success, #45f0a0); }
.fu-cmd-over .sum { margin-top: 1.1rem; font: 600 1.02rem/1.45 var(--fu-font, sans-serif); color: #ffd780; }
.fu-cmd-over .ret { margin-top: 1rem; font: 700 0.72rem/1 var(--fu-font-cond, sans-serif); letter-spacing: 0.3em; color: var(--fu-text-dim, #7d91a8); text-transform: uppercase; }
.fu-cmd-over .ret i { display: block; height: 2px; margin-top: 0.6rem; background: rgba(255,255,255,0.1); position: relative; overflow: hidden; }
.fu-cmd-over .ret i::after { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--fu-accent, #3fd0ff);
  transform-origin: left; animation: fu-cmd-prog var(--dur, 4s) linear both; }
@keyframes fu-cmd-prog { from { transform: scaleX(0); } to { transform: scaleX(1); } }
`;
