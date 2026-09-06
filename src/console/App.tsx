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
  const [pendingConfirm, setPendingConfirm] = useState<{ k: string; id: string; cmd: 'kill' | 'merge' } | null>(null);
  const failCount = useRef(0);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refresh = useCallback(async () => {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    try {
      const [lanes, thread, journal, integrations, caps, proposals] = await Promise.all([
        stateRef.current.filter === 'all' ? api.getLanes({ all: true }) : api.getLanes(),
        api.getThread(), api.getJournal(), api.getIntegrations(), api.getCaps(), api.getProposals(),
      ]);
      if (!mounted.current) return;
      failCount.current = 0;
      const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      dispatch({ type: 'fetch-latency', ms: Math.round(endedAt - startedAt) });
      dispatch({ type: 'lanes', lanes: lanes.lanes });
      dispatch({ type: 'thread', thread: thread.messages });
      dispatch({ type: 'journal', journal: journal.rows });
      dispatch({ type: 'integrations', integrations: integrations.items });
      dispatch({ type: 'caps', caps });
      dispatch({ type: 'proposals', proposals });
      dispatch({ type: 'feed-live' });
    } catch {
      if (!mounted.current) return;
      failCount.current += 1;
      if (failCount.current >= 2) dispatch({ type: 'feed-lost', reason: 'the fleet server is unreachable' });
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
    dispatch({ type: 'thread-append', messages: [receiptCard(jid, text, undoable)] });
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
      setPendingConfirm({ k, id, cmd });
      // The confirm card lives in the rail; a sheet's modal overlay sits above it and
      // would make Confirm/Not now unreachable, so the sheet closes the moment an
      // irreversible action starts.
      dispatch({ type: 'sheet', sheet: null });
      dispatch({
        type: 'thread-append',
        messages: [{
          k, type: 'confirm', text: `${cmd === 'kill' ? 'Kill' : 'Merge'} ${id}?`, ts: Date.now(), source: 'console',
          blast: cmd === 'kill' ? 'discards the working diff and stops the sandbox.' : 'merges the PR and closes the ticket.',
        }],
      });
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

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <div className={`${state.theme} app`} tabIndex={-1}>
        <DisconnectedBanner feed={state.feed} onRetry={() => void refresh()} />
        <TopBar
          view={state.view} settingsBadge={settingsBadge} reviewBadge={reviewBadge}
          caps={state.caps} spentTodayUsd={state.caps?.spentTodayUsd ?? 0} feed={state.feed} now={state.now}
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
            onCheck={(id) => void api.checkIntegration(id).then((r) => dispatch({ type: 'integrations', integrations: r.items }))}
            onReconnect={(id) => void (async () => {
              const r = await api.reconnectIntegration(id);
              appendReceipt(r.jid, r.message, false);
              await refresh();
            })()}
            onCheckAll={() => void refresh()}
            onSaveCaps={async (dailyUsd, runUsd) => {
              try {
                const caps = await api.setCaps({ dailyUsd, runUsd });
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
            proposals={state.proposals}
            onApply={(id) => void runAction(() => api.applyProposal(id)).then(() => refresh())}
            onDismiss={(id) => void runAction(() => api.dismissProposal(id))}
            onRestore={(id) => void runAction(() => api.restoreProposal(id))}
            onUndo={onUndo}
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
                  onSendLane={(id, textMsg) => onRailSend(textMsg)}
                />
              ) : null}
              {state.sheet.type === 'cost' && sheetLane ? (
                <CostSheet lane={sheetLane} onClose={() => dispatch({ type: 'sheet', sheet: null })} onKill={(id) => onCommand(id, 'kill')} />
              ) : null}
              {state.sheet.type === 'fleet-cost' ? (
                <FleetCostSheet
                  lanes={state.lanes} spentTodayUsd={state.caps?.spentTodayUsd ?? 0}
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
