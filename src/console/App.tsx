import type { JSX } from 'react';
/**
 * The console's root component: one store, fed from `/lanes`, `/thread`,
 * `/journal`, `/integrations`, `/caps`, `/proposals` on load and every 5s
 * after (the fallback), refreshed early on any `/events` frame. A heartbeat
 * frame marks the feed live and stamps `feed.lastHeartbeatAt`; two failed
 * fetches in a row, or the socket closing, flips `feed.live` false.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import * as api from './api.js';
import { CommandPalette, buildPaletteItems } from './components/CommandPalette.js';
import { CostSheet } from './components/CostSheet.js';
import { DisconnectedBanner } from './components/DisconnectedBanner.js';
import { Filters } from './components/Filters.js';
import { FleetCostSheet } from './components/FleetCostSheet.js';
import { FlightReview } from './components/FlightReview.js';
import { HoverCard } from './components/HoverCard.js';
import { JournalSheet } from './components/JournalSheet.js';
import { ConductorRail } from './components/ConductorRail.js';
import { LanesGrid } from './components/LanesGrid.js';
import { NeedsYou, buildNeeds } from './components/NeedsYou.js';
import { QueueView } from './components/QueueView.js';
import { SandboxSheet } from './components/SandboxSheet.js';
import { Settings } from './components/Settings.js';
import { TicketSheet } from './components/TicketSheet.js';
import { Toast } from './components/Toast.js';
import { TopBar } from './components/TopBar.js';
import { initialState, reducer, StoreContext } from './store.js';
import type { Message } from '../shared/console-model.js';
import { EventStream, type EventStreamOptions } from './ws.js';

const POLL_MS = 5000;

export interface AppProps {
  eventStreamOptions?: EventStreamOptions;
}

function receiptCard(jid: string | null, text: string, undoable: boolean): Message {
  return { k: `local-${Date.now()}-${Math.random()}`, type: jid ? 'receipt' : 'refusal', text, ts: Date.now(), source: 'console', jid: jid ?? undefined, undoable };
}

export function App({ eventStreamOptions }: AppProps = {}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const [pendingConfirm, setPendingConfirm] = useState<{ k: string; id: string; cmd: 'kill' | 'merge'; card: Message } | null>(null);
  const failCount = useRef(0);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  // The confirm card is client-only until Confirm is clicked, but `refresh()` replaces
  // `state.thread` wholesale from the server's `/thread`, which never echoes it back.
  // `/events` fires on every journal event from every lane, including the one an
  // operator is mid-confirm on killing, so a refresh can land in the gap between the
  // card appearing and the click -- silently, with no error. Kept in a ref (rather than
  // read from `pendingConfirm` directly) because `refresh` is a stable `useCallback`
  // with no dependency on it.
  const pendingConfirmRef = useRef(pendingConfirm);
  pendingConfirmRef.current = pendingConfirm;
  // D2.1: `runAction` appends a receipt/refusal card (via `appendReceipt`) and then
  // immediately awaits `refresh()`. `refresh()` replaces `state.thread` wholesale from
  // `/thread`, which has no row for a client-only card the way it has none for the
  // confirm card above -- so without this, a 501's refusal card renders for one tick
  // and vanishes the instant that same `refresh()` call lands. Kept as a short-lived
  // list (same mechanism as `pendingConfirmRef`) rather than merged in forever: a card
  // ages out once the server's own thread has had a reasonable window to carry it, so
  // this never grows into a second, unbounded copy of the thread.
  const localCardsRef = useRef<Message[]>([]);
  const LOCAL_CARD_TTL_MS = 30_000;
  // Load-verify finding: the 5s poll and every `/events` frame both call `refresh`, with
  // nothing stopping either from starting a second one while the first is still waiting
  // on a slow `/lanes` (the response that a few thousand lanes over a few hundred
  // thousand journal events makes slow in the first place). Left unguarded, that pile-up
  // only compounds the load that caused it -- the fix is to skip a refresh outright
  // while one is already in flight, never to queue it.
  const refreshing = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      // Always the unwindowed `all=1` fetch: the server drops finished lanes older than
      // 24h out of the default `/lanes` response, and a board that fetched THAT while
      // showing every other filter off a stale unwindowed set (loaded back when the
      // filter was still "all") would leave the "all" chip's count -- and every other
      // chip's, since they all read the same array -- disagreeing with what the grid
      // actually renders. One dataset, filtered the same way everywhere, keeps every
      // chip's count equal to what clicking it would show (fidelity sweep #2).
      const [lanes, thread, journal, integrations, caps, proposals, queue] = await Promise.all([
        api.getLanes({ all: true }),
        api.getThread(), api.getJournal(), api.getIntegrations(), api.getCaps(), api.getProposals(), api.getQueue(),
      ]);
      if (!mounted.current) return;
      failCount.current = 0;
      const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      dispatch({ type: 'fetch-latency', ms: Math.round(endedAt - startedAt) });
      dispatch({ type: 'lanes', lanes: lanes.lanes });
      // Re-attach an unconfirmed confirm card the server's own `/thread` never carries,
      // rather than letting this refetch silently erase the last line of defence before
      // an irreversible action.
      const pending = pendingConfirmRef.current;
      let incomingThread = pending && !thread.messages.some((m) => m.k === pending.k)
        ? [...thread.messages, pending.card]
        : thread.messages;
      const cutoff = Date.now() - LOCAL_CARD_TTL_MS;
      localCardsRef.current = localCardsRef.current.filter((card) => card.ts >= cutoff);
      for (const card of localCardsRef.current) {
        if (!incomingThread.some((m) => m.k === card.k)) incomingThread = [...incomingThread, card];
      }
      dispatch({ type: 'thread', thread: incomingThread });
      dispatch({ type: 'journal', journal: journal.rows });
      dispatch({ type: 'integrations', integrations: integrations.items });
      dispatch({ type: 'caps', caps });
      dispatch({ type: 'proposals', proposals });
      dispatch({ type: 'queue', items: queue.items, paused: queue.paused, maxInFlight: queue.maxInFlight });
      dispatch({ type: 'feed-live' });
    } catch {
      if (mounted.current) {
        failCount.current += 1;
        if (failCount.current >= 2) dispatch({ type: 'feed-lost', reason: 'the fleet server is unreachable' });
      }
    } finally {
      refreshing.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const stream = new EventStream(
      {
        onEvent: (event) => {
          if ((event as { type?: string }).type === 'heartbeat') {
            dispatch({ type: 'heartbeat', at: (event as { at?: number }).at ?? Date.now() });
            dispatch({ type: 'feed-live' });
          }
          void refresh();
        },
        onStatusChange: (status) => {
          if (status === 'closed') dispatch({ type: 'feed-lost', reason: 'the live feed connection closed' });
        },
      },
      eventStreamOptions,
    );
    stream.start();
    const poll = setInterval(() => void refresh(), POLL_MS);
    const clock = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), 1000);
    return () => {
      mounted.current = false;
      stream.stop();
      clearInterval(poll);
      clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  const appendReceipt = useCallback((jid: string | null, text: string, undoable: boolean) => {
    const card = receiptCard(jid, text, undoable);
    localCardsRef.current = [...localCardsRef.current, card];
    dispatch({ type: 'thread-append', messages: [card] });
  }, []);

  const runAction = useCallback(async (fn: () => Promise<{ ok: boolean; jid: string | null; message: string; undoable: boolean }>) => {
    try {
      const result = await fn();
      appendReceipt(result.jid, result.message, result.undoable);
    } catch (caught) {
      const message = caught instanceof api.ApiError ? caught.message : 'the action did not go through';
      appendReceipt(null, message, false);
    }
    await refresh();
  }, [appendReceipt, refresh]);

  const onCommand = useCallback((id: string, cmd: string) => {
    const lane = state.lanes.find((l) => l.id === id);
    if (cmd === 'kill' || cmd === 'merge') {
      const k = `confirm-${id}-${Date.now()}`;
      const card: Message = {
        k, type: 'confirm', text: `${cmd === 'kill' ? 'Kill' : 'Merge'} ${id}?`, ts: Date.now(), source: 'console',
        blast: cmd === 'kill' ? 'discards the working diff and stops the sandbox.' : 'merges the PR and closes the ticket.',
      };
      // Kept alongside the card's own thread entry so `refresh()` can put it back
      // verbatim if a `/thread` refetch lands before the operator confirms.
      setPendingConfirm({ k, id, cmd, card });
      // The confirm card lives in the rail; a sheet's modal overlay sits above it and
      // would make Confirm/Not now unreachable, so the sheet closes the moment an
      // irreversible action starts.
      dispatch({ type: 'sheet', sheet: null });
      dispatch({ type: 'thread-append', messages: [card] });
      return;
    }
    if (cmd === 'watch' || cmd === 'council' || cmd === 'gate-log' || cmd === 'answer') {
      dispatch({ type: 'sheet', sheet: { type: 'ticket', id } });
      return;
    }
    if (cmd === 'open-pr') {
      if (lane?.pr?.url && typeof window !== 'undefined') window.open(lane.pr.url, '_blank', 'noopener');
      return;
    }
    if (cmd === 'reconnect-aws') {
      if (lane?.blockedBy) {
        void (async () => {
          try {
            const r = await api.reconnectIntegration(lane.blockedBy as string);
            appendReceipt(r.jid, r.message, false);
          } catch (caught) {
            appendReceipt(null, caught instanceof api.ApiError ? caught.message : 'reconnect did not go through', false);
          }
          await refresh();
        })();
      }
      return;
    }
    if (cmd === 'pause') void runAction(() => api.pauseRun(id));
    else if (cmd === 'resume') void runAction(() => api.resumeRun(id));
    else if (cmd === 'compact') void runAction(() => api.compactRun(id));
    else if (cmd === 'verify') void runAction(() => api.verifyRun(id));
    else if (cmd === 'reopen') void runAction(() => api.reopenRun(id));
  }, [state.lanes, appendReceipt, refresh, runAction]);

  const resolveConfirm = useCallback((k: string, confirmed: boolean) => {
    dispatch({
      type: 'thread',
      thread: state.thread.map((m) => (m.k === k ? { ...m, resolved: confirmed ? 'confirmed' : 'declined' } : m)),
    });
    if (confirmed && pendingConfirm && pendingConfirm.k === k) {
      const fn = pendingConfirm.cmd === 'kill' ? () => api.killRun(pendingConfirm.id, 'operator confirmed') : () => api.mergeRun(pendingConfirm.id);
      void runAction(fn);
    }
    setPendingConfirm(null);
  }, [state.thread, pendingConfirm, runAction]);

  // The prototype's own `handle(text)` -- confirm/decline resolution, else a
  // POST /command round trip -- runs identically whether the text was typed into
  // the composer or produced by a button/chip. Only the operator-bubble echo
  // differs by call site (`send()` vs. a direct method call), so that split lives
  // one level up in onRailSend/onRailCommand rather than here.
  const processCommand = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (pendingConfirm && trimmed.startsWith('confirm ')) { resolveConfirm(pendingConfirm.k, true); return; }
    if (pendingConfirm && trimmed.startsWith('decline ')) { resolveConfirm(pendingConfirm.k, false); return; }
    const confirmMatch = trimmed.match(/^confirm (.+)$/);
    const declineMatch = trimmed.match(/^decline (.+)$/);
    if (confirmMatch) { resolveConfirm(confirmMatch[1] as string, true); return; }
    if (declineMatch) { resolveConfirm(declineMatch[1] as string, false); return; }
    void (async () => {
      try {
        const response = await api.sendCommand(trimmed);
        if (response.cards.length > 0) dispatch({ type: 'thread-append', messages: response.cards });
      } catch (caught) {
        appendReceipt(null, caught instanceof api.ApiError ? caught.message : 'the command did not go through', false);
      }
      await refresh();
    })();
  }, [pendingConfirm, resolveConfirm, appendReceipt, refresh]);

  // Typed composer text (and the rail's quick-command chips, which the prototype
  // also routes through `send()`) echoes an operator bubble before processing.
  const onRailSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    dispatch({
      type: 'thread-append',
      messages: [{ k: `op-${Date.now()}-${Math.random()}`, type: 'operator', text: trimmed, ts: Date.now(), source: 'operator' }],
    });
    processCommand(trimmed);
  }, [processCommand]);

  // Reply/plan/confirm/question buttons in the rail: the prototype wires these
  // straight to a method call, never to `send()`, so no fake operator bubble.
  const onRailCommand = useCallback((text: string) => { processCommand(text); }, [processCommand]);

  const onUndo = useCallback((jid: string) => { void runAction(() => api.undoJournal(jid)); }, [runAction]);

  const onOpenJournal = useCallback((jid: string) => {
    dispatch({ type: 'sheet', sheet: { type: 'journal', run: jid } });
  }, []);

  const sheet = state.sheet;
  const sheetLane = sheet && sheet.type !== 'journal' && sheet.type !== 'fleet-cost'
    ? state.lanes.find((l) => l.id === sheet.id)
    : undefined;

  const needs = buildNeeds(state.lanes, state.integrations, (kind, id) => {
    if (kind === 'lane') dispatch({ type: 'sheet', sheet: { type: 'ticket', id } });
    else void (async () => {
      try {
        const r = await api.reconnectIntegration(id);
        appendReceipt(r.jid, r.message, false);
      } catch (caught) {
        appendReceipt(null, caught instanceof api.ApiError ? caught.message : 'reconnect did not go through', false);
      }
      await refresh();
    })();
  }, () => dispatch({ type: 'view', view: 'settings' }), state.now);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        dispatch({ type: 'palette-open', open: true });
        return;
      }
      if (e.key === 'Escape') {
        if (stateRef.current.paletteOpen) dispatch({ type: 'palette-open', open: false });
        else if (stateRef.current.sheet) dispatch({ type: 'sheet', sheet: null });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const paletteItems = buildPaletteItems(
    state.paletteQuery, state.lanes, state.journal,
    (id) => dispatch({ type: 'sheet', sheet: { type: 'ticket', id } }),
    (view) => dispatch({ type: 'view', view }),
    onOpenJournal,
  );

  const repos = [...new Set(state.lanes.map((l) => l.repo).filter((r): r is string => Boolean(r)))];
  const settingsBadge = state.integrations.filter((i) => i.status === 'down').length;
  const reviewBadge = state.proposals?.rules.filter((r) => r.status === 'open').length ?? 0;
  const queueBadge = state.queue.filter((i) => i.state === 'parked' || i.state === 'failed').length;

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <div className={`${state.theme} app`} tabIndex={-1}>
        <DisconnectedBanner feed={state.feed} onRetry={() => void refresh()} />
        <TopBar
          view={state.view} settingsBadge={settingsBadge} reviewBadge={reviewBadge} queueBadge={queueBadge}
          caps={state.caps} tokensToday={state.caps?.tokensToday ?? 0} feed={state.feed} now={state.now}
          fetchLatencyMs={state.fetchLatencyMs}
          theme={state.theme}
          onNav={(view) => dispatch({ type: 'view', view })}
          onOpenPalette={() => dispatch({ type: 'palette-open', open: true })}
          onOpenCost={() => dispatch({ type: 'sheet', sheet: { type: 'fleet-cost' } })}
          onToggleTheme={() => dispatch({ type: 'theme', theme: state.theme === 'thD' ? 'thL' : 'thD' })}
        />
        <NeedsYou items={needs} />
        {state.view === 'board' ? (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Filters
                filter={state.filter} sort={state.sort} repos={repos} lanes={state.lanes} now={state.now}
                onFilter={(filter) => { dispatch({ type: 'filter', filter }); if (filter === 'all') void refresh(); }}
                onSort={(sort) => dispatch({ type: 'sort', sort })}
              />
              <LanesGrid
                lanes={state.lanes} filter={state.filter} sort={state.sort} feedLive={state.feed.live} now={state.now}
                onOpen={(id) => dispatch({ type: 'sheet', sheet: { type: 'ticket', id } })}
                onOpenCost={(id) => dispatch({ type: 'sheet', sheet: { type: 'cost', id } })}
                onCommand={onCommand}
                onTip={(tip) => dispatch({ type: 'tip', tip })}
              />
            </div>
            <ConductorRail
              thread={state.thread} feed={state.feed} now={state.now} composer={state.composer}
              onComposerChange={(text) => dispatch({ type: 'composer', text })}
              onSend={onRailSend}
              onCommand={onRailCommand}
              onUndo={onUndo}
              onOpenJournal={onOpenJournal}
            />
          </div>
        ) : null}
        {state.view === 'settings' ? (
          <Settings
            integrations={state.integrations} caps={state.caps} journalCount={state.journal.length}
            journal={state.journal} rules={state.proposals?.rules ?? []} lanes={state.lanes} feed={state.feed} now={state.now}
            onCheck={(id) => void api.checkIntegration(id).then((r) => dispatch({ type: 'integrations', integrations: r.items }))}
            onReconnect={(id) => void (async () => {
              const r = await api.reconnectIntegration(id);
              appendReceipt(r.jid, r.message, false);
              await refresh();
            })()}
            onCheckAll={() => void refresh()}
            onSaveCaps={async (dailyTokens, runTokens) => {
              try {
                const caps = await api.setCaps({ dailyTokens, runTokens });
                dispatch({ type: 'caps', caps });
              } catch (caught) {
                appendReceipt(null, caught instanceof api.ApiError ? caught.message : 'caps did not save', false);
              }
            }}
            onOpenJournal={() => dispatch({ type: 'sheet', sheet: { type: 'journal' } })}
          />
        ) : null}
        {state.view === 'review' ? (
          <FlightReview
            proposals={state.proposals} now={state.now}
            onApply={(id) => void runAction(() => api.applyProposal(id)).then(() => refresh())}
            onDismiss={(id) => void runAction(() => api.dismissProposal(id))}
            onRestore={(id) => void runAction(() => api.restoreProposal(id))}
            onUndo={onUndo}
          />
        ) : null}
        {state.view === 'queue' ? (
          <QueueView
            items={state.queue} paused={state.queuePaused} maxInFlight={state.queueMaxInFlight}
            onAdd={(source, input) => void (async () => {
              try {
                const result = await api.addToQueue({ source, input });
                if (!result.ok) { appendReceipt(null, result.error ?? 'the add did not go through', false); }
              } catch (caught) {
                appendReceipt(null, caught instanceof api.ApiError ? caught.message : 'the add did not go through', false);
              }
              await refresh();
            })()}
            onRemove={(id) => void runAction(() => api.removeQueueItem(id))}
            onRetry={(id) => void runAction(() => api.retryQueueItem(id))}
            onPause={() => void runAction(() => api.pauseQueue())}
            onResume={() => void runAction(() => api.resumeQueue())}
          />
        ) : null}

        {state.sheet ? (
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 20, background: 'color-mix(in srgb,var(--bg) 62%,transparent)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '34px 20px', overflow: 'auto' }}
            onClick={() => dispatch({ type: 'sheet', sheet: null })}
          >
            <div onClick={(e) => e.stopPropagation()}>
              {state.sheet.type === 'ticket' && sheetLane ? (
                <TicketSheet
                  lane={sheetLane} feedLive={state.feed.live} now={state.now}
                  onClose={() => dispatch({ type: 'sheet', sheet: null })}
                  onCommand={onCommand}
                  onOpenCost={(id) => dispatch({ type: 'sheet', sheet: { type: 'cost', id } })}
                  onOpenSandbox={(id) => dispatch({ type: 'sheet', sheet: { type: 'sandbox', id } })}
                  onSendLane={(id, textMsg) => runAction(() => api.sendToRun(id, textMsg))}
                  onAmendLane={(id, textMsg) => runAction(() => api.amendRun(id, textMsg))}
                  onOpenJournal={onOpenJournal}
                  onUndo={onUndo}
                />
              ) : null}
              {state.sheet.type === 'cost' && sheetLane ? (
                <CostSheet lane={sheetLane} onClose={() => dispatch({ type: 'sheet', sheet: null })} onKill={(id) => onCommand(id, 'kill')} />
              ) : null}
              {state.sheet.type === 'fleet-cost' ? (
                <FleetCostSheet
                  lanes={state.lanes} tokensToday={state.caps?.tokensToday ?? 0}
                  onClose={() => dispatch({ type: 'sheet', sheet: null })}
                  onOpenLane={(id) => dispatch({ type: 'sheet', sheet: { type: 'ticket', id } })}
                />
              ) : null}
              {state.sheet.type === 'journal' ? (
                <JournalSheet rows={state.journal} run={state.sheet.run} onClose={() => dispatch({ type: 'sheet', sheet: null })} onUndo={onUndo} />
              ) : null}
              {state.sheet.type === 'sandbox' && sheetLane ? (
                <SandboxSheet lane={sheetLane} onClose={() => dispatch({ type: 'sheet', sheet: null })} onKill={(id) => onCommand(id, 'kill')} />
              ) : null}
            </div>
          </div>
        ) : null}

        {state.paletteOpen ? (
          <CommandPalette
            query={state.paletteQuery} items={paletteItems}
            onQueryChange={(q) => dispatch({ type: 'palette-query', query: q })}
            onClose={() => dispatch({ type: 'palette-open', open: false })}
          />
        ) : null}
        <Toast toast={state.toast} />
        <HoverCard tip={state.tip} />
      </div>
    </StoreContext.Provider>
  );
}
