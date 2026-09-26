// FRONT ULTRA — the nations drawer, `N` (DESIGN_V2 §5, §8.3; owner: ui, built by W3).
//
// Talking to other nations calmly, with time to think:
//   * NACIONES: every nation with its opinion of you (band and value), its personality, the treaties and the state of
//     the pair (peace, war, truce), tension and pending items;
//   * a nation's DETAIL: the opinion meter with every reason and its value (live, from the sim's `opinions`), the
//     treaties with their terms and countdowns, what its personality means, and the actions: propose (alliance, pact,
//     trade agreement, open borders) with an optional gold sweetener, demand, propose peace, ask for help (call to arms),
//     declare war, embargo, gift, leave a treaty. Every control explains itself and, when disabled, why;
//   * the INBOX: proposals, demands, ultimatums and calls to arms waiting for your answer with their countdown in game
//     hours and real seconds (never less than 60 unpaused real seconds), your proposals being studied («Francia está
//     estudiando tu propuesta…» with its deliberation), and the answers with their reasons.

import { h, setStyle, setText, toggleClass } from '../dom';
import { flag } from '../flag';
import { icon } from '../icons';
import { tip, type TipData } from '../tooltip';
import { tx } from '../tx';
import type { AlertCenter } from './alerts';
import { betrayalOf, openDeclareWar } from './declare';
import { answer, askHelp, donate, focusNation, leaveTreaty, nationRelation, propose, toggleEmbargo, whyNotPropose } from './diplomacy';
import { bandCentre, deliberationLeft, inboxCountdown, OPEN_STATUS, previewBand, proposalWhat, reasonLine, reasonsQuoted } from './inboxText';
import type { HudShared } from './shared';
import { goldField, openDemandDialog, openPeaceDialog } from './wardialogs';
import { ALLIANCE_NOTICE_TICKS, DELIBERATION_TICKS, HUMAN_ID, NAP_TICKS, opinionBand } from '../../shared/constants';
import { formatCompact, formatNumber, t } from '../../shared/i18n';
import type { PlayerView, ProposalView, TreatyKind } from '../../shared/types';

export interface NationsPanel {
  el: HTMLElement;
  readonly isOpen: boolean;
  open(id?: number): void;
  openInbox(proposalId?: number): void;
  toggle(): void;
  close(): void;
  update(): void;
  /** Items waiting for the human's answer. */
  pendingCount(): number;
}

const TREATY_ICON: Record<TreatyKind, string> = { alliance: 'alliance', nap: 'nap', trade: 'trade', openBorders: 'openBorders' };
const PROPOSABLE: TreatyKind[] = ['alliance', 'nap', 'trade', 'openBorders'];

function daysHours(ticks: number): string {
  const h = Math.max(0, Math.round(ticks / 10));
  if (h < 48) return t('time.hours', { n: formatNumber(h) });
  return t('time.days', { n: formatNumber(Math.round(h / 24)) });
}

export function createNations(hs: HudShared, alerts: AlertCenter): NationsPanel {
  const ctx = hs.ctx;
  const view = () => ctx.sim.view;
  let isOpen = false;
  let tab: 'list' | 'inbox' = 'list';
  let detailId = 0;

  const tabList = h('button', { class: 'fu-nt-tab is-on' }, icon('users'), tx('nations.tab.list'));
  const inboxN = h('span', { class: 'fu-nt-badge fu-mono fu-hidden' });
  const tabInbox = h('button', { class: 'fu-nt-tab' }, icon('inbox'), tx('nations.tab.inbox'), inboxN);
  const closeBtn = h('button', { class: 'fu-close' }, icon('close'));
  tip(tabList, () => ({ title: t('nations.tab.list'), text: t('nations.tab.list.tip'), hotkey: 'N' }));
  tip(tabInbox, () => ({ title: t('nations.tab.inbox'), text: t('nations.tab.inbox.tip'), now: [[t('inbox.pending'), String(pendingCount())]] }));
  tip(closeBtn, () => ({ title: t('common.close'), text: t('nations.close.tip'), hotkey: 'N / Esc' }));
  const listBox = h('div', { class: 'fu-nt-list' });
  const detailBox = h('div', { class: 'fu-nt-detail fu-hidden' });
  const inboxBox = h('div', { class: 'fu-nt-inbox fu-hidden' });
  const body = h('div', { class: 'fu-nt-body' }, listBox, detailBox, inboxBox);
  const el = h('div', { class: 'fu-nations fu-glass fu-brackets fu-interactive fu-hidden' },
    h('div', { class: 'fu-nt-head' }, h('div', { class: 'fu-panel-title' }, icon('globe'), tx('nations.title')), h('span', { class: 'fu-kbd' }, 'N'), closeBtn),
    h('div', { class: 'fu-nt-tabs' }, tabList, tabInbox),
    body,
  );
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  const name = (id: number) => (id === HUMAN_ID ? t('news.you') : hs.name(id));
  const opinionOf = (id: number) => view().opinions.get(id);

  function pendingCount(): number {
    let n = 0;
    for (const p of view().proposals.values()) if (p.to === HUMAN_ID && p.status === 'pending') n++;
    return n;
  }

  function showTab(tb: 'list' | 'inbox'): void {
    tab = tb;
    toggleClass(tabList, 'is-on', tb === 'list');
    toggleClass(tabInbox, 'is-on', tb === 'inbox');
    toggleClass(listBox, 'fu-hidden', tb !== 'list' || detailId !== 0);
    toggleClass(detailBox, 'fu-hidden', tb !== 'list' || detailId === 0);
    toggleClass(inboxBox, 'fu-hidden', tb !== 'inbox');
    refresh(true);
  }
  tabList.addEventListener('click', () => {
    hs.sound('click');
    if (tab === 'list' && detailId) {
      detailId = 0;
      clearPreview();
    }
    showTab('list');
  });
  tabInbox.addEventListener('click', () => {
    hs.sound('click');
    showTab('inbox');
  });
  closeBtn.addEventListener('click', () => close());

  // =================================================================================================
  // List
  // =================================================================================================
  const rows = new Map<number, HTMLElement>();
  function nations(): PlayerView[] {
    const v = view();
    return v.playerList.filter((p) => p.alive && p.kind === 'nation' && p.id !== HUMAN_ID);
  }
  function stateChip(id: number): HTMLElement {
    const v = view();
    const st = v.pairState(HUMAN_ID, id);
    const op = opinionOf(id);
    const chips = h('span', { class: 'fu-nt-chips' });
    if (st === 'war') chips.append(h('span', { class: 'fu-nt-chip is-war' }, icon('attack'), t('rel.war')));
    else if (st === 'truce') chips.append(h('span', { class: 'fu-nt-chip is-truce' }, icon('peace'), t('rel.truce')));
    for (const tr of v.treatiesBetween(HUMAN_ID, id)) chips.append(h('span', { class: `fu-nt-chip is-${tr.kind}${tr.leavingTick ? ' is-leaving' : ''}` }, icon(TREATY_ICON[tr.kind])));
    if (op?.tensionTick !== undefined && v.tick - op.tensionTick < 1200 && st !== 'war') chips.append(h('span', { class: 'fu-nt-chip is-tension' }, icon('megaphone')));
    if (v.human?.embargoes.includes(id)) chips.append(h('span', { class: 'fu-nt-chip is-embargo' }, icon('embargo')));
    return chips;
  }
  function opinionChip(id: number): HTMLElement {
    const op = opinionOf(id);
    const v = op?.score ?? 0;
    const band = opinionBand(v);
    return h('span', { class: `fu-op-chip is-${band}` }, h('b', { class: 'fu-mono' }, (v > 0 ? '+' : '') + v), t(`opinion.band.${band}`));
  }
  function nationTip(p: PlayerView): TipData {
    const op = opinionOf(p.id);
    const band = opinionBand(op?.score ?? 0);
    return {
      title: name(p.id),
      text: t(`opinion.band.${band}.means`),
      now: [[t('nations.opinion'), `${(op?.score ?? 0) > 0 ? '+' : ''}${op?.score ?? 0}`], [t('hud.troops'), formatCompact(p.troops)], [t('hud.territory'), formatNumber(p.tiles)]],
      lines: (op?.reasons ?? []).slice(0, 4).map((r) => reasonLine(hs, r)),
    };
  }
  function renderList(): void {
    const list = nations();
    const v = view();
    const rank = (p: PlayerView) => {
      const st = v.pairState(HUMAN_ID, p.id);
      let pend = 0;
      for (const q of v.proposals.values()) if (q.to === HUMAN_ID && q.from === p.id && q.status === 'pending') pend++;
      return (st === 'war' ? 1e6 : 0) + (pend ? 5e5 : 0) + (v.human?.allies.includes(p.id) ? 2e5 : 0) + p.tiles;
    };
    list.sort((a, b) => rank(b) - rank(a));
    const seen = new Set<number>();
    let prev: HTMLElement | null = null;
    for (const p of list) {
      seen.add(p.id);
      let r = rows.get(p.id);
      if (!r) {
        r = h('button', { class: 'fu-nt-row' });
        const id = p.id;
        r.addEventListener('click', () => {
          hs.sound('click');
          openDetail(id);
        });
        r.addEventListener('dblclick', () => focusNation(hs, id));
        tip(r, () => {
          const q = view().players[id];
          return q ? { ...nationTip(q), lines: [...nationTip(q).lines ?? [], t('nations.row.click')] } : null;
        });
        rows.set(p.id, r);
      }
      r.replaceChildren(
        flag(p.color, p.id),
        h('span', { class: 'fu-nt-name' }, h('b', null, name(p.id)), h('small', null, p.personality ? t(`personality.${p.personality}`) : '')),
        stateChip(p.id),
        opinionChip(p.id),
      );
      if (r.parentElement !== listBox || r.previousElementSibling !== prev) {
        if (prev) prev.after(r);
        else listBox.prepend(r);
      }
      prev = r;
    }
    for (const [id, r] of rows) {
      if (!seen.has(id)) {
        r.remove();
        rows.delete(id);
      }
    }
  }

  // =================================================================================================
  // Detail
  // =================================================================================================
  const dFlag = h('div', { class: 'fu-nd-flag' });
  const dName = h('div', { class: 'fu-nd-name' });
  const dPers = h('div', { class: 'fu-nd-pers' });
  const dState = h('div', { class: 'fu-nd-state' });
  const meterFill = h('i', { class: 'fu-nd-meter-fill' });
  const meterMark = h('b', { class: 'fu-nd-meter-mark' });
  const meterVal = h('span', { class: 'fu-nd-meter-val fu-mono' });
  const meter = h('div', { class: 'fu-nd-meter' }, h('div', { class: 'fu-nd-meter-track' }, h('span', { class: 'fu-nd-meter-zero' }), meterFill, meterMark), meterVal);
  const reasonsBox = h('div', { class: 'fu-nd-reasons' });
  const treatiesBox = h('div', { class: 'fu-nd-treaties' });
  const pendingBox = h('div', { class: 'fu-nd-pending' });
  const back = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--sm' }, icon('chevronLeft'), tx('nations.back'));
  const fly = h('button', { class: 'fu-btn fu-btn--ghost fu-btn--sm' }, icon('globe'), tx('hud.sel.focus'));
  tip(back, () => ({ title: t('nations.back'), text: t('nations.back.tip') }));
  tip(fly, () => ({ title: t('hud.sel.focus'), text: t('nations.fly.tip') }));
  tip(meter, () => {
    const op = opinionOf(detailId);
    const band = opinionBand(op?.score ?? 0);
    return { title: t('nations.opinion'), text: t('nations.opinion.tip'), now: [[t(`opinion.band.${band}`), `${(op?.score ?? 0) > 0 ? '+' : ''}${op?.score ?? 0}`]], lines: [t(`opinion.band.${band}.means`), t('nations.opinion.bands')] };
  });
  let gold = 0;
  const gf = goldField(hs, (g) => {
    gold = g;
    refreshActions();
  });

  interface Act { el: HTMLButtonElement; show(): boolean; why(): string | null; tip(): TipData; run(): void }
  const acts: Act[] = [];
  const act = (ico: string, key: string, cls: string, o: Omit<Act, 'el'>): Act => {
    const b = h('button', { class: `fu-btn fu-btn--sm ${cls}` }, icon(ico), tx(key)) as HTMLButtonElement;
    const a: Act = { el: b, ...o };
    tip(b, () => ({ ...a.tip(), whyNot: a.why() }));
    b.addEventListener('click', () => {
      if (a.why()) {
        hs.sound('error');
        return;
      }
      a.run();
      refresh(true);
    });
    acts.push(a);
    return a;
  };
  const atWar = () => view().pairState(HUMAN_ID, detailId) === 'war';
  const isAlly = () => !!view().human?.allies.includes(detailId);
  const ourEnemies = () => view().wars.filter((w) => w.aggressor === HUMAN_ID || w.target === HUMAN_ID).map((w) => (w.aggressor === HUMAN_ID ? w.target : w.aggressor));

  const proposeActs = PROPOSABLE.map((k) => act(TREATY_ICON[k], `nations.propose.${k}`, k === 'alliance' ? 'fu-btn--success' : '', {
    show: () => !view().hasTreaty(HUMAN_ID, detailId, k) && !(k === 'nap' && isAlly()) && !(k === 'openBorders' && isAlly()),
    why: () => whyNotPropose(hs, detailId, k, gold),
    tip: () => ({
      title: t(`nations.propose.${k}`), text: t(`treaty.${k}.effect`),
      now: [[t('nations.needs'), t(`treaty.${k}.accepts`)], [t('nations.opinionNow'), `${opinionOf(detailId)?.score ?? 0}`], [t('nations.delib'), t('proposal.delib', { lo: DELIBERATION_TICKS[k][0] / 10, hi: DELIBERATION_TICKS[k][1] / 10 })]],
      lines: [t(`treaty.${k}.duration`, { days: Math.round(NAP_TICKS / 240), notice: Math.round(ALLIANCE_NOTICE_TICKS / 10) }), gold > 0 ? t('gold.withSweetener', { gold: formatCompact(gold) }) : t('gold.sweetener.hint')],
    }),
    run: () => {
      propose(hs, detailId, k, { gold });
    },
  }));
  const peaceAct = act('peace', 'nations.peace', 'fu-btn--primary', {
    show: atWar, why: () => whyNotPropose(hs, detailId, 'peace'),
    tip: () => ({ title: t('nations.peace'), text: t('nations.peace.tip') }),
    run: () => void openPeaceDialog(hs, detailId),
  });
  const demandAct = act('demand', 'nations.demand', 'fu-btn--amber', {
    show: () => !atWar(), why: () => whyNotPropose(hs, detailId, 'demand'),
    tip: () => ({ title: t('nations.demand'), text: t('nations.demand.tip') }),
    run: () => void openDemandDialog(hs, detailId),
  });
  const helpAct = act('helpCall', 'nations.help', 'fu-btn--success', {
    show: () => isAlly(),
    why: () => {
      const en = ourEnemies();
      if (!en.length) return t('why.call.noWar');
      return en.every((e) => whyNotPropose(hs, detailId, 'callToArms', 0, e)) ? whyNotPropose(hs, detailId, 'callToArms', 0, en[0]) : null;
    },
    tip: () => ({ title: t('nations.help'), text: t('nations.help.tip'), now: [[t('nations.help.enemies'), ourEnemies().map((e) => name(e)).join(', ') || '—']] }),
    run: () => {
      for (const e of ourEnemies()) askHelp(hs, e, detailId);
    },
  });
  const warAct = act('attack', 'nations.declare', 'fu-btn--danger', {
    show: () => !atWar(), why: () => (view().phase !== 'playing' ? t('msg.notYet') : null),
    tip: () => ({ title: t('nations.declare'), text: t('nations.declare.tip'), lines: betrayalOf(hs, detailId) ? [t(`war.declare.betray.${betrayalOf(hs, detailId)}`, { name: name(detailId), hours: 72 })] : [] }),
    run: () => {
      const p = view().players[detailId];
      const naval = !hs.borders(detailId);
      const aim = p && p.capitalTile >= 0 ? p.capitalTile : -1;
      openDeclareWar(hs, detailId, aim >= 0 && !naval ? aim : -1, naval);
    },
  });
  const embargoAct = act('embargo', 'nations.embargo', '', {
    show: () => true, why: () => null,
    tip: () => ({ title: t(view().human?.embargoes.includes(detailId) ? 'dip.embargoOff' : 'dip.embargo'), text: t('nations.embargo.tip') }),
    run: () => toggleEmbargo(hs, detailId),
  });
  const giftAct = act('donate', 'nations.gift', '', {
    show: () => !atWar(), why: () => ((view().human?.gold ?? 0) < 1000 ? t('msg.notEnoughGold') : null),
    tip: () => {
      const me = view().human;
      const g = Math.floor((me?.gold ?? 0) * 0.1);
      return { title: t('nations.gift'), text: t('nations.gift.tip'), now: [[t('nations.gift.amount'), formatCompact(g)]] };
    },
    run: () => donate(hs, detailId, 'gold', 0.1),
  });
  const leaveActs = PROPOSABLE.filter((k) => k !== 'nap').map((k) => act('breakAlliance', `nations.leave.${k}`, 'fu-btn--ghost', {
    show: () => view().hasTreaty(HUMAN_ID, detailId, k),
    why: () => (k === 'alliance' && view().treatiesBetween(HUMAN_ID, detailId).some((x) => x.kind === 'alliance' && x.leavingTick > 0) ? t('why.leave.noticeGiven') : null),
    tip: () => ({ title: t(`nations.leave.${k}`), text: t(`nations.leave.${k}.tip`, { hours: Math.round(ALLIANCE_NOTICE_TICKS / 10) }) }),
    run: () => leaveTreaty(hs, detailId, k),
  }));
  const actionsBox = h('div', { class: 'fu-nd-actions' },
    h('div', { class: 'fu-nd-sec' }, tx('nations.sec.propose')),
    h('div', { class: 'fu-nd-grid' }, ...proposeActs.map((a) => a.el)),
    gf.el,
    h('div', { class: 'fu-nd-sec' }, tx('nations.sec.more')),
    h('div', { class: 'fu-nd-grid' }, peaceAct.el, demandAct.el, helpAct.el, warAct.el, embargoAct.el, giftAct.el, ...leaveActs.map((a) => a.el)),
  );
  detailBox.append(
    h('div', { class: 'fu-nd-top' }, back, fly),
    h('div', { class: 'fu-nd-head' }, dFlag, h('div', null, dName, dPers)),
    dState,
    h('div', { class: 'fu-nd-sec' }, tx('nations.sec.opinion')), meter, reasonsBox,
    h('div', { class: 'fu-nd-sec' }, tx('nations.sec.treaties')), treatiesBox,
    pendingBox,
    actionsBox,
  );
  back.addEventListener('click', () => {
    hs.sound('close');
    detailId = 0;
    showTab('list');
  });
  fly.addEventListener('click', () => {
    hs.sound('click');
    focusNation(hs, detailId);
  });

  function refreshActions(): void {
    for (const a of acts) {
      const show = !!detailId && a.show();
      toggleClass(a.el, 'fu-hidden', !show);
      toggleClass(a.el, 'is-disabled', show && !!a.why());
    }
    const em = view().human?.embargoes.includes(detailId);
    const lbl = embargoAct.el.querySelector('[data-i18n]') as HTMLElement;
    if (lbl) setText(lbl, t(em ? 'dip.embargoOff' : 'dip.embargo'));
  }

  function renderDetail(): void {
    const v = view();
    const p = v.players[detailId];
    if (!p || !p.alive) {
      detailId = 0;
      showTab('list');
      return;
    }
    dFlag.replaceChildren(flag(p.color, p.id));
    setText(dName, name(p.id));
    setText(dPers, p.personality ? `${t(`personality.${p.personality}`)} · ${t(`personality.${p.personality}.line`)}` : '');
    // State of the pair.
    const st = v.pairState(HUMAN_ID, p.id);
    const op = opinionOf(p.id);
    const bits: string[] = [];
    if (st === 'war') {
      const w = v.warBetween(HUMAN_ID, p.id);
      if (w) {
        const weA = w.aggressor === HUMAN_ID;
        bits.push(t('nations.state.war', { day: Math.floor(w.startTick / 240) + 1, score: (weA ? w.scoreA : -w.scoreA) > 0 ? `+${Math.round(weA ? w.scoreA : -w.scoreA)}` : `${Math.round(weA ? w.scoreA : -w.scoreA)}`, ours: Math.round(weA ? w.exhaustionA : w.exhaustionB), theirs: Math.round(weA ? w.exhaustionB : w.exhaustionA), goal: t(`war.goal.${w.goal}`) }));
      }
    } else if (st === 'truce') {
      const tr = (v as unknown as { truces?: { a: number; b: number; untilTick: number }[] }).truces?.find((x) => (x.a === HUMAN_ID && x.b === p.id) || (x.b === HUMAN_ID && x.a === p.id));
      bits.push(t('nations.state.truce', { left: tr ? daysHours(tr.untilTick - v.tick) : '' }));
    } else bits.push(t('nations.state.peace'));
    if (op?.tensionTick !== undefined && st !== 'war' && v.tick - op.tensionTick < 2400) bits.push(t('nations.state.tension', { text: t(op.tensionKey ?? 'tension.border', { name: name(p.id) }), ago: daysHours(v.tick - op.tensionTick) }));
    if (op?.noWarUntil) bits.push(t('nations.state.noWar', { left: daysHours(op.noWarUntil - v.tick) }));
    if (op?.refusals) bits.push(t('nations.state.refusals', { n: op.refusals }));
    if (p.traitorTicks > 0) bits.push(t('nations.state.traitor', { left: daysHours(p.traitorTicks) }));
    dState.replaceChildren(...bits.map((b, i) => h('div', { class: `fu-nd-stateline${i === 0 ? ` is-${st}` : ''}` }, b)));
    // Opinion meter and reasons.
    const score = op?.score ?? 0;
    const band = opinionBand(score);
    meter.dataset.band = band;
    const x = (score + 100) / 2;
    setStyle(meterMark, 'left', `${x}%`);
    setStyle(meterFill, 'left', `${Math.min(50, x)}%`);
    setStyle(meterFill, 'width', `${Math.abs(x - 50)}%`);
    setText(meterVal, `${score > 0 ? '+' : ''}${score} · ${t(`opinion.band.${band}`)}`);
    const rs = op?.reasons ?? [];
    reasonsBox.replaceChildren(...(rs.length ? rs.map((r) => h('div', { class: `fu-nd-reason ${(r.value ?? 0) >= 0 ? 'is-pos' : 'is-neg'}` }, h('span', null, reasonLine(hs, { ...r, value: undefined })), h('b', { class: 'fu-mono' }, `${(r.value ?? 0) > 0 ? '+' : (r.value ?? 0) < 0 ? '−' : ''}${Math.abs(r.value ?? 0)}`))) : [tx('nations.noReasons', undefined, 'div')]));
    // Treaties.
    const trs = v.treatiesBetween(HUMAN_ID, p.id);
    treatiesBox.replaceChildren(...(trs.length ? trs.map((tr) => {
      let term = t(`treaty.${tr.kind}.openEnded`);
      if (tr.kind === 'nap' && tr.untilTick > 0) term = t('treaty.ends', { left: daysHours(tr.untilTick - v.tick) });
      if (tr.leavingTick > 0) term = t('treaty.leaving', { left: daysHours(tr.leavingTick - v.tick), who: tr.leaver === HUMAN_ID ? t('news.you') : name(tr.leaver) });
      const row = h('div', { class: 'fu-nd-treaty' }, icon(TREATY_ICON[tr.kind]), h('b', null, t(`treaty.kind.${tr.kind}`)), h('span', null, term));
      tip(row, () => ({ title: t(`treaty.kind.${tr.kind}`), text: t(`treaty.${tr.kind}.effect`), lines: [t(`treaty.${tr.kind}.duration`, { days: Math.round(NAP_TICKS / 240), notice: Math.round(ALLIANCE_NOTICE_TICKS / 10) })] }));
      return row;
    }) : [tx('nations.noTreaties', undefined, 'div')]));
    // Open items with this nation.
    const open = [...v.proposals.values()].filter((q) => (q.from === p.id || q.to === p.id) && OPEN_STATUS(q.status));
    pendingBox.replaceChildren(...(open.length ? [h('div', { class: 'fu-nd-sec' }, tx('nations.sec.pending')), ...open.map((q) => inboxCard(q, false))] : []));
    refreshActions();
  }

  function openDetail(id: number): void {
    detailId = id;
    gold = 0;
    hs.select({ kind: 'nation', id });
    showTab('list');
  }

  // =================================================================================================
  // Inbox
  // =================================================================================================
  let highlight = 0;
  let preview = 0;
  function clearPreview(): void {
    if (preview) ctx.globe.setTileMarks?.('inbox-preview', null);
    preview = 0;
  }
  function inboxCard(p: ProposalView, full: boolean): HTMLElement {
    const v = view();
    const other = p.from === HUMAN_ID ? p.to : p.from;
    const P = v.players[other];
    const what = proposalWhat(hs, p);
    const card = h('div', { class: `fu-ib-card is-${p.status}${p.ultimatum ? ' is-ultimatum' : ''}${p.id === highlight ? ' is-hl' : ''}`, 'data-pid': p.id });
    const head = h('div', { class: 'fu-ib-head' }, P ? flag(P.color, other) : null, h('b', null, name(other)), h('span', { class: 'fu-ib-kind' }, t(`proposal.kind.${p.kind}`)));
    card.append(head);
    if (p.to === HUMAN_ID && p.status === 'pending') {
      const cd = inboxCountdown(hs, p);
      const title = p.ultimatum ? t('inbox.ultimatum', { name: name(other), what }) : p.kind === 'callToArms' ? t('proposal.incoming.callToArms', { name: name(other), enemy: name(p.target) }) : t(p.counterOf ? 'proposal.incoming.counter' : 'proposal.incoming', { name: name(other), what });
      card.append(h('div', { class: 'fu-ib-text' }, title));
      if (p.gold > 0) card.append(h('div', { class: 'fu-ib-sub' }, t('inbox.withGold', { gold: formatCompact(p.gold) })));
      card.append(h('div', { class: 'fu-ib-sub' }, t(`inbox.consequence.${p.kind === 'demand' ? (p.ultimatum ? 'ultimatum' : 'demand') : p.kind}`, { name: name(other), enemy: name(p.target) })));
      card.append(h('div', { class: 'fu-ib-cd fu-mono', 'data-cd': p.id }, cd.text));
      const yes = h('button', { class: 'fu-btn fu-btn--sm fu-btn--success' }, icon('check'), tx('toast.accept'));
      const no = h('button', { class: 'fu-btn fu-btn--sm fu-btn--danger' }, icon('close'), tx('toast.decline'));
      tip(yes, () => ({ title: t('toast.accept'), text: t(`inbox.accept.${p.kind === 'demand' ? 'demand' : p.kind}`, { name: name(other), what, enemy: name(p.target) }) }));
      tip(no, () => ({ title: t('toast.decline'), text: t(`inbox.decline.${p.kind === 'demand' ? (p.ultimatum ? 'ultimatum' : 'demand') : p.kind}`, { name: name(other) }) }));
      yes.addEventListener('click', () => {
        answer(hs, p.id, true);
        clearPreview();
      });
      no.addEventListener('click', () => {
        answer(hs, p.id, false);
        clearPreview();
      });
      const foot = h('div', { class: 'fu-ib-foot' }, yes, no);
      const band = p.kind === 'demand' && p.demand?.kind === 'cede' ? p.demand.tiles ?? 0 : p.kind === 'peace' && p.terms?.kind === 'cede' && p.terms.loser === HUMAN_ID ? p.terms.tiles ?? 0 : 0;
      if (band > 0) {
        const see = h('button', { class: 'fu-btn fu-btn--sm fu-btn--ghost' }, icon('eye'), tx('inbox.seeBand'));
        tip(see, () => ({ title: t('inbox.seeBand'), text: t('inbox.seeBand.tip', { tiles: formatNumber(band) }) }));
        see.addEventListener('click', () => {
          const tl = previewBand(hs, HUMAN_ID, other, band);
          ctx.globe.setTileMarks?.('inbox-preview', tl, 0xff4a4a, true);
          preview = p.id;
          const c = bandCentre(tl);
          if (c) ctx.bus.emit('focusRequest', { lat: c.lat, lon: c.lon, altitudeKm: 2400, durationMs: 1000 });
          hs.sound('click');
        });
        foot.prepend(see);
      }
      card.append(foot);
    } else if (p.from === HUMAN_ID && p.status === 'considering') {
      const span = Math.max(1, p.decideTick - p.createdTick);
      const done = Math.min(1, (v.tick - p.createdTick) / span);
      card.append(h('div', { class: 'fu-ib-text' }, t('proposal.studying', { name: name(other) })), h('div', { class: 'fu-ib-sub' }, what + (p.gold > 0 ? ` · ${t('inbox.withGold', { gold: formatCompact(p.gold) })}` : '')));
      card.append(h('div', { class: 'fu-ib-progress' }, h('i', { style: `transform:scaleX(${done.toFixed(3)})` })), h('div', { class: 'fu-ib-cd fu-mono' }, t('inbox.answerIn', { hours: formatNumber(deliberationLeft(hs, p)) })));
    } else {
      const sentence = p.from === HUMAN_ID ? t(`proposal.answer.${p.status}`, { name: name(other), what }) : p.status === 'expired' ? t('proposal.expired', { name: name(other), what }) : p.status === 'cancelled' ? t('proposal.cancelled', { name: name(other), what }) : t(p.status === 'accepted' ? 'proposal.youAccepted' : 'proposal.youRefused', { name: name(other), what });
      card.append(h('div', { class: 'fu-ib-text' }, sentence));
      const rq = p.to === HUMAN_ID && (p.status === 'accepted' || p.status === 'rejected') ? '' : reasonsQuoted(hs, p.reasons);
      if (rq && full) card.append(h('div', { class: 'fu-ib-sub' }, rq));
      if (full) card.append(h('div', { class: 'fu-ib-cd fu-mono' }, t('inbox.when', { day: Math.floor((p.resolvedTick || p.createdTick) / 240) + 1, hour: Math.floor(((p.resolvedTick || p.createdTick) % 240) / 10) })));
    }
    head.addEventListener('click', () => {
      if (other !== detailId || tab !== 'list') openDetail(other);
    });
    return card;
  }

  let inboxSig = '';
  function renderInbox(force: boolean): void {
    const v = view();
    const all = [...v.proposals.values()];
    const waiting = all.filter((p) => p.to === HUMAN_ID && p.status === 'pending').sort((a, b) => a.expiresTick - b.expiresTick);
    const studying = all.filter((p) => p.from === HUMAN_ID && p.status === 'considering');
    const done = all.filter((p) => !OPEN_STATUS(p.status)).sort((a, b) => (b.resolvedTick || b.createdTick) - (a.resolvedTick || a.createdTick)).slice(0, 20);
    const sig = [...waiting, ...studying, ...done].map((p) => `${p.id}:${p.status}`).join(',') + `|${highlight}`;
    if (sig === inboxSig && !force) {
      // Only the countdowns and progress move.
      for (const p of waiting) {
        const cd = inboxBox.querySelector(`[data-cd="${p.id}"]`) as HTMLElement | null;
        if (cd) setText(cd, inboxCountdown(hs, p).text);
      }
      return;
    }
    inboxSig = sig;
    const sec = (key: string, n: number) => h('div', { class: 'fu-nd-sec' }, t(key), h('span', { class: 'fu-mono' }, ` · ${n}`));
    inboxBox.replaceChildren(
      sec('inbox.sec.waiting', waiting.length),
      ...(waiting.length ? waiting.map((p) => inboxCard(p, true)) : [tx('inbox.none.waiting', undefined, 'div')]),
      sec('inbox.sec.studying', studying.length),
      ...(studying.length ? studying.map((p) => inboxCard(p, true)) : [tx('inbox.none.studying', undefined, 'div')]),
      sec('inbox.sec.history', done.length),
      ...(done.length ? done.map((p) => inboxCard(p, true)) : [tx('inbox.none.history', undefined, 'div')]),
    );
    inboxBox.querySelectorAll('.fu-nd-sec + div:not(.fu-ib-card)').forEach((e) => e.classList.add('fu-ib-empty'));
    if (highlight) inboxBox.querySelector(`[data-pid="${highlight}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  // =================================================================================================
  let acc = 0;
  let lastDetailSig = '';
  function refresh(force = false): void {
    const n = pendingCount();
    toggleClass(inboxN, 'fu-hidden', n === 0);
    setText(inboxN, String(n));
    if (!isOpen) return;
    if (tab === 'inbox') renderInbox(force);
    else if (detailId) {
      const v = view();
      let ps = '';
      for (const q of v.proposals.values()) if (q.from === detailId || q.to === detailId) ps += `${q.id}:${q.status},`;
      const op = v.opinions.get(detailId);
      const sig = `${Math.floor(v.tick / 50)}|${ps}|${v.treatiesBetween(HUMAN_ID, detailId).map((x) => `${x.kind}${x.leavingTick}`).join()}|${op?.score}|${op?.reasons.length}|${v.pairState(HUMAN_ID, detailId)}|${v.human?.embargoes.length}|${v.human?.allies.length}`;
      if (force || sig !== lastDetailSig) {
        lastDetailSig = sig;
        renderDetail();
      } else {
        refreshActions();
        for (const q of v.proposals.values()) {
          if (q.to !== HUMAN_ID || q.status !== 'pending') continue;
          const cd = detailBox.querySelector(`[data-cd="${q.id}"]`) as HTMLElement | null;
          if (cd) setText(cd, inboxCountdown(hs, q).text);
        }
      }
    } else if (force || acc % 10 === 0) renderList();
  }

  function open(id?: number): void {
    if (!isOpen) {
      isOpen = true;
      el.classList.remove('fu-hidden');
      hs.flags.nationsOpened = true;
      hs.sound('open');
      ctx.bus.emit('panelToggled', { panel: 'nations', open: true });
    }
    if (id && id !== HUMAN_ID && view().players[id]) openDetail(id);
    else showTab(tab);
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    clearPreview();
    el.classList.add('fu-hidden');
    hs.sound('close');
    ctx.bus.emit('panelToggled', { panel: 'nations', open: false });
  }
  alerts.onOpenProposal = (pid) => api.openInbox(pid);

  const api: NationsPanel = {
    el,
    get isOpen() {
      return isOpen;
    },
    open,
    openInbox(pid?: number) {
      highlight = pid ?? 0;
      open();
      const p = pid ? view().proposals.get(pid) : undefined;
      // An answered proposal of ours: show the nation it concerns; everything else: the inbox.
      if (p && p.from === HUMAN_ID && !OPEN_STATUS(p.status)) showTab('inbox');
      else showTab('inbox');
    },
    toggle() {
      if (isOpen) close();
      else open();
    },
    close,
    update() {
      acc++;
      refresh(false);
    },
    pendingCount,
  };
  ctx.bus.on('gameTornDown', () => {
    close();
    detailId = 0;
    rows.clear();
    listBox.replaceChildren();
    inboxSig = '';
  });
  (window as unknown as { __fuNations?: unknown }).__fuNations = {
    open: (id?: number) => open(id),
    inbox: () => api.openInbox(),
    text: () => el.innerText,
    opinion: (id: number) => view().opinions.get(id),
    pending: () => pendingCount(),
  };
  return api;
}
