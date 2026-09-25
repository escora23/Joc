// FRONT ULTRA — end screen (owner: ui): VICTORIA / DERROTA with the reason, the player's campaign stats, a
// territory-over-time chart (canvas, one line per leading nation, the player highlighted) and a timelapse
// player of the world map (decoded from the sim client's RLE frames, play/pause/scrub).

import { h, setText, toggleClass } from './dom';
import { flag } from './flag';
import { icon } from './icons';
import { tx } from './tx';
import type { GameContext } from '../shared/api';
import { HUMAN_ID, MAP_H, MAP_W } from '../shared/constants';
import { hexToCss } from '../shared/color';
import type { UiSoundKind } from '../shared/events';
import { formatCompact, formatDuration, formatNumber, playerName, t } from '../shared/i18n';
import { isWaterTerrain } from '../shared/terrain';
import type { GameOverReason, PlayerView } from '../shared/types';

export interface EndScreen {
  el: HTMLElement;
  destroy(): void;
}

const MAX_LINES = 8;

export function createEndScreen(ctx: GameContext, sound: (k: UiSoundKind) => void, reason: GameOverReason | null): EndScreen {
  const view = ctx.sim.view;
  const me = view.human;
  const won = view.winner === HUMAN_ID;
  const winner = view.players[view.winner];
  const land = view.world?.landTiles ?? 1;
  const name = (p: PlayerView) => playerName(p, view.world);
  const r = reason ?? (won ? 'domination' : 'eliminated');

  // ---- header ---------------------------------------------------------------------------------------
  // v2 (§4.18): hegemony and the time limit have their own defeat lines.
  const subtitleKey = won ? `end.reason.win.${r}`
    : (r === 'hegemony' || r === 'timeLimit') && winner && winner.id !== HUMAN_ID ? `end.reason.lose.${r}`
    : r !== 'eliminated' && winner && winner.id !== HUMAN_ID ? 'end.reason.lose.winner' : 'end.reason.lose.eliminated';
  const headline = h('div', { class: `fu-end-head ${won ? 'is-win' : 'is-lose'}` },
    h('div', { class: 'fu-end-kicker' }, tx(won ? 'end.kicker.win' : 'end.kicker.lose')),
    h('h1', { class: 'fu-end-title' }, h('span', { 'data-text': t(won ? 'end.victory' : 'end.defeat') }, tx(won ? 'end.victory' : 'end.defeat'))),
    h('div', { class: 'fu-end-sub' },
      winner ? flag(winner.color, winner.id, 'fu-flag') : null,
      h('span', null, t(subtitleKey, { name: winner ? name(winner) : '' })),
    ),
  );

  // ---- stats ----------------------------------------------------------------------------------------
  const st = me?.stats;
  const peakPct = st ? (Math.max(st.peakTiles, me?.tiles ?? 0) / land) * 100 : 0;
  const statCards: [string, string, string][] = [
    ['clock', 'end.stat.time', formatDuration(view.simTime)],
    ['territory', 'end.stat.peak', `${peakPct.toFixed(1)}%`],
    ['flag', 'end.stat.conquered', formatNumber(st?.tilesConquered ?? 0)],
    ['swords', 'end.stat.killed', formatCompact(st?.troopsKilled ?? 0)],
    ['skull', 'end.stat.eliminated', formatNumber(st?.nationsEliminated ?? 0)],
    ['gold', 'end.stat.gold', formatCompact(st?.goldEarned ?? 0)],
    ['city', 'end.stat.built', formatNumber(st?.structuresBuilt ?? 0)],
    ['atomBomb', 'end.stat.nukes', formatNumber(st?.nukesLaunched ?? 0)],
    ['takeControl', 'end.stat.command', formatCompact(st?.commandKills ?? 0)],
    ['troops', 'end.stat.lost', formatCompact(st?.troopsLost ?? 0)],
  ];
  const stats = h('div', { class: 'fu-end-stats' });
  statCards.forEach(([ico, key, val], i) => {
    stats.append(h('div', { class: 'fu-end-stat', style: `animation-delay:${600 + i * 60}ms` },
      h('div', { class: 'fu-end-stat-ico' }, icon(ico)),
      h('div', null, tx(key, undefined, 'small'), h('b', { class: 'fu-mono' }, val)),
    ));
  });

  // ---- final standings --------------------------------------------------------------------------------
  const standings = h('div', { class: 'fu-end-standings' });
  const ranked = view.playerList.filter((p) => (p.kind === 'nation' || p.kind === 'human')).sort((a, b) => b.tiles - a.tiles || b.stats.peakTiles - a.stats.peakTiles);
  const meRank = ranked.findIndex((p) => p.id === HUMAN_ID);
  const shown = ranked.slice(0, 6);
  if (meRank >= 6 && me) shown.push(me);
  for (const p of shown) {
    const rank = ranked.indexOf(p) + 1;
    standings.append(h('div', { class: `fu-end-rank${p.id === HUMAN_ID ? ' is-me' : ''}${p.alive ? '' : ' is-dead'}` },
      h('span', { class: 'fu-mono fu-end-rank-n' }, String(rank)),
      flag(p.color, p.id, 'fu-flag'),
      h('span', { class: 'fu-end-rank-name' }, name(p)),
      h('span', { class: 'fu-mono fu-end-rank-v' }, p.alive ? `${((p.tiles / land) * 100).toFixed(1)}%` : '✝'),
    ));
  }

  // ---- chart ----------------------------------------------------------------------------------------
  const chart = h('canvas', { class: 'fu-end-chart' }) as HTMLCanvasElement;
  const legend = h('div', { class: 'fu-end-legend' });
  const hist = view.history;
  // Choose lines: the player + the nations with the highest peak share.
  const peaks: { id: number; peak: number }[] = [];
  for (const p of view.playerList) {
    if (p.kind !== 'nation' && p.kind !== 'human') continue;
    let peak = 0;
    for (const s of hist) peak = Math.max(peak, s.tiles[p.id] ?? 0);
    peaks.push({ id: p.id, peak });
  }
  peaks.sort((a, b) => b.peak - a.peak);
  const lines = peaks.filter((x) => x.id !== HUMAN_ID).slice(0, MAX_LINES - 1).map((x) => x.id);
  lines.unshift(HUMAN_ID);
  for (const id of lines) {
    const p = view.players[id];
    if (!p) continue;
    const item = h('div', { class: `fu-end-leg${id === HUMAN_ID ? ' is-me' : ''}` }, h('i', { style: `background:${hexToCss(p.color)}` }), h('span', null, name(p)));
    legend.append(item);
  }
  let highlight = HUMAN_ID;

  function drawChart(progress: number): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(10, Math.round(chart.clientWidth * dpr)), H = Math.max(10, Math.round(chart.clientHeight * dpr));
    if (chart.width !== W || chart.height !== H) {
      chart.width = W;
      chart.height = H;
    }
    const g = chart.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, W, H);
    const padL = 44 * dpr, padR = 14 * dpr, padT = 12 * dpr, padB = 24 * dpr;
    const cw = W - padL - padR, ch = H - padT - padB;
    let maxPct = 5;
    for (const id of lines) for (const s of hist) maxPct = Math.max(maxPct, ((s.tiles[id] ?? 0) / land) * 100);
    maxPct = Math.min(100, Math.ceil(maxPct / 10) * 10);
    // grid
    g.font = `${10 * dpr}px "JetBrains Mono", monospace`;
    g.textBaseline = 'middle';
    g.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + ch - (i / 4) * ch;
      g.strokeStyle = i === 0 ? 'rgba(160,200,240,0.35)' : 'rgba(160,200,240,0.09)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(padL, Math.round(y) + 0.5);
      g.lineTo(padL + cw, Math.round(y) + 0.5);
      g.stroke();
      g.fillStyle = 'rgba(160,190,220,0.6)';
      g.fillText(`${Math.round((maxPct * i) / 4)}%`, padL - 8 * dpr, y);
    }
    // 80% win line
    if (maxPct >= 80) {
      const y = padT + ch - (80 / maxPct) * ch;
      g.setLineDash([6 * dpr, 5 * dpr]);
      g.strokeStyle = 'rgba(255,181,61,0.6)';
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(padL + cw, y);
      g.stroke();
      g.setLineDash([]);
    }
    const n = hist.length;
    if (n < 2) return;
    const t0 = hist[0].tick, t1 = hist[n - 1].tick;
    const tx2 = (tick: number) => padL + ((tick - t0) / Math.max(1, t1 - t0)) * cw;
    // time labels
    g.textAlign = 'center';
    g.textBaseline = 'top';
    g.fillStyle = 'rgba(160,190,220,0.6)';
    for (let i = 0; i <= 4; i++) {
      const tick = t0 + ((t1 - t0) * i) / 4;
      g.fillText(formatDuration(tick / 10), padL + (cw * i) / 4, padT + ch + 7 * dpr);
    }
    const upto = Math.max(2, Math.round(n * progress));
    const order = [...lines].sort((a, b) => (a === highlight ? 1 : b === highlight ? -1 : 0));
    for (const id of order) {
      const p = view.players[id];
      if (!p) continue;
      const hi = id === highlight;
      g.strokeStyle = hexToCss(p.color);
      g.lineWidth = (hi ? 2.8 : 1.5) * dpr;
      g.globalAlpha = hi ? 1 : 0.62;
      g.lineJoin = 'round';
      if (hi) {
        g.shadowColor = hexToCss(p.color);
        g.shadowBlur = 10 * dpr;
      }
      g.beginPath();
      for (let i = 0; i < upto; i++) {
        const s = hist[i];
        const x = tx2(s.tick), y = padT + ch - (((s.tiles[id] ?? 0) / land) * 100 / maxPct) * ch;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      g.shadowBlur = 0;
      if (hi) {
        // Area under the highlighted line
        const last = hist[upto - 1];
        const grd = g.createLinearGradient(0, padT, 0, padT + ch);
        grd.addColorStop(0, `${hexToCss(p.color)}55`);
        grd.addColorStop(1, `${hexToCss(p.color)}00`);
        g.lineTo(tx2(last.tick), padT + ch);
        g.lineTo(tx2(hist[0].tick), padT + ch);
        g.closePath();
        g.fillStyle = grd;
        g.globalAlpha = 0.5;
        g.fill();
        g.globalAlpha = 1;
        const lx = tx2(last.tick), ly = padT + ch - (((last.tiles[id] ?? 0) / land) * 100 / maxPct) * ch;
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(lx, ly, 3.5 * dpr, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }
  }
  legend.querySelectorAll('.fu-end-leg').forEach((node, i) => {
    node.addEventListener('mouseenter', () => {
      highlight = lines[i];
      drawChart(1);
    });
    node.addEventListener('mouseleave', () => {
      highlight = HUMAN_ID;
      drawChart(1);
    });
  });

  // ---- timelapse ------------------------------------------------------------------------------------
  const tl = view.timelapse;
  const map = h('canvas', { class: 'fu-end-map', width: tl.width || 400, height: tl.height || 200 }) as HTMLCanvasElement;
  const playBtn = h('button', { class: 'fu-btn fu-btn--icon fu-btn--sm' }, icon('pause'));
  const scrub = h('input', { type: 'range', class: 'fu-range', min: 0, max: Math.max(0, tl.frameCount - 1), step: 1, value: 0 }) as HTMLInputElement;
  const tlTime = h('span', { class: 'fu-mono fu-end-tltime' }, '0:00');
  const mg = map.getContext('2d');
  const W = map.width, H = map.height;
  const img = mg ? mg.createImageData(W, H) : null;
  const px = img ? new Uint32Array(img.data.buffer) : new Uint32Array(0);
  const base = new Uint32Array(W * H);
  const owners = new Uint16Array(W * H);
  const lut = new Uint32Array(2048);
  const world = view.world;
  if (world) {
    const sx = MAP_W / W, sy = MAP_H / H;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const tt = world.terrain[Math.floor((y + 0.5) * sy) * MAP_W + Math.floor((x + 0.5) * sx)];
        base[y * W + x] = isWaterTerrain(tt) ? 0xff2a160a : 0xff4a4036;
      }
    }
  }
  for (const p of view.playerList) {
    const c = p.color;
    lut[p.id] = (255 << 24) | ((c & 255) << 16) | (((c >> 8) & 255) << 8) | ((c >> 16) & 255);
  }
  let frame = 0;
  let playing = tl.frameCount > 1;
  function drawFrame(i: number): void {
    if (!img || !mg || tl.frameCount === 0) return;
    tl.decode(i, owners);
    for (let k = 0; k < px.length; k++) {
      const o = owners[k];
      px[k] = o ? lut[o] || base[k] : base[k];
    }
    mg.putImageData(img, 0, 0);
    scrub.value = String(i);
    scrub.style.setProperty('--p', `${tl.frameCount > 1 ? (i / (tl.frameCount - 1)) * 100 : 100}%`);
    setText(tlTime, formatDuration(tl.frameTick(i) / 10));
  }
  const setPlaying = (on: boolean) => {
    playing = on && tl.frameCount > 1;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
  };
  playBtn.addEventListener('click', () => {
    sound('click');
    if (!playing && frame >= tl.frameCount - 1) frame = 0;
    setPlaying(!playing);
  });
  scrub.addEventListener('input', () => {
    setPlaying(false);
    frame = Number(scrub.value);
    drawFrame(frame);
  });

  // ---- actions --------------------------------------------------------------------------------------
  const menuBtn = h('button', { class: 'fu-btn fu-btn--ghost' }, icon('exit'), tx('end.backToMenu'));
  const againBtn = h('button', { class: 'fu-btn fu-btn--primary' }, icon('restart'), tx('end.playAgain'));
  menuBtn.addEventListener('click', () => {
    sound('click');
    ctx.app.returnToMenu();
  });
  againBtn.addEventListener('click', () => {
    sound('confirm');
    ctx.app.returnToMenu();
    ctx.app.goto('setup');
  });

  const el = h('div', { class: `fu-end ${won ? 'is-win' : 'is-lose'}` },
    h('div', { class: 'fu-end-bg' }),
    h('div', { class: 'fu-end-wrap' },
      h('div', { class: 'fu-end-top' }, headline, h('div', { class: 'fu-end-actions fu-interactive' }, menuBtn, againBtn)),
      h('div', { class: 'fu-end-grid' },
        h('section', { class: 'fu-end-panel fu-glass fu-brackets' }, h('div', { class: 'fu-panel-title' }, icon('chart'), tx('end.campaign')),
          h('div', { class: 'fu-end-me' }, me ? flag(me.color, 0, 'fu-flag') : null, h('div', null, h('b', null, me?.name ?? ''), h('small', null, t(`difficulty.${view.config?.difficulty ?? 'normal'}`)))),
          stats,
          h('div', { class: 'fu-panel-title fu-end-standings-title' }, icon('crown'), tx('end.standings')),
          standings),
        h('section', { class: 'fu-end-panel fu-glass fu-brackets fu-end-tl fu-interactive' }, h('div', { class: 'fu-panel-title' }, icon('globe'), tx('end.timelapse')),
          h('div', { class: 'fu-end-mapwrap' }, map, h('div', { class: 'fu-end-mapscan' })),
          h('div', { class: 'fu-end-tlbar' }, playBtn, scrub, tlTime)),
        h('section', { class: 'fu-end-panel fu-glass fu-brackets fu-end-chartpanel fu-interactive' }, h('div', { class: 'fu-panel-title' }, icon('chart'), tx('end.chart')),
          h('div', { class: 'fu-end-chartwrap' }, chart, legend)),
      ),
    ),
  );

  // Animate: chart draws in, timelapse plays at ~10 fps and loops with a pause at the end.
  let raf = 0;
  let t0 = -1;
  let lastFrameAt = 0;
  let holdUntil = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (t0 < 0) t0 = now;
    const p = Math.min(1, (now - t0 - 700) / 1600);
    if (p > 0 && p <= 1) drawChart(p < 1 ? 1 - Math.pow(1 - p, 3) : 1);
    if (playing && now - lastFrameAt > 110 && now > holdUntil) {
      lastFrameAt = now;
      drawFrame(frame);
      frame++;
      if (frame >= tl.frameCount) {
        frame = 0;
        holdUntil = now + 1800;
      }
    }
  };
  raf = requestAnimationFrame(loop);
  if (tl.frameCount > 0) drawFrame(0);
  toggleClass(el, 'has-no-timelapse', tl.frameCount === 0);
  requestAnimationFrame(() => drawChart(0.01));
  const onResize = () => drawChart(1);
  window.addEventListener('resize', onResize);

  return {
    el,
    destroy() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      el.remove();
    },
  };
}
