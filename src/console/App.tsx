import type { JSX } from 'react';
/**
 * The console's root: one store, fed from the server's read routes on load and every 5s,
 * with `/events` frames refetching a single slice. The frame is the design's
 * (`doctrine/design/Flightdeck Console.dc.html`): the chrome on top, the current view on
 * the left, the Conductor rail on the right, and the lane sheet over the board.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ACTIONS, ActionsContext, EFFECT_SLICES, actionKey, errorText, type ActionSpec, type ActionsHost } from './actions.js';
import * as api from './api.js';
import { BlockersView } from './components/BlockersView.js';
import { Chrome } from './components/Chrome.js';
import { ConductorRail, DEFAULT_COMMANDS, type RailCommand } from './components/ConductorRail.js';
import { FlightReview } from './components/FlightReview.js';
import { LanesGrid } from './components/LanesGrid.js';
import { buildNeeds } from './components/NeedsYou.js';
import { QueueView } from './components/QueueView.js';
import { Settings } from './components/Settings.js';
import { TicketSheet } from './components/TicketSheet.js';
import { focusableIn, trapTab } from './focus-trap.js';
import { blockerFor, type BoardCommand } from './laneVM.js';
import { initialState, reducer, StoreContext, type ActionLink, type View } from './store.js';
import { isSliceEvent, type SliceName } from '../shared/console-events.js';
import type { Message } from '../shared/console-model.js';
import { commandEcho } from '../shared/humanize.js';
import { EventStream, type EventStreamOptions } from './ws.js';

const POLL_MS = 5000;

export interface AppProps {
  eventStreamOptions?: EventStreamOptions;
}

function receiptCard(jid: string | null, text: string, undoable: boolean): Message {
  return { k: `local-${Date.now()}-${Math.random()}`, type: jid ? 'receipt' : 'refusal', text, ts: Date.now(), source: 'console', jid: jid ?? undefined, undoable };
}

const VIEWS: View[] = ['board', 'blockers', 'queue', 'review', 'settings'];

export function App({ eventStreamOptions }: AppProps = {}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const failCount = useRef(0);
  const servedBuildRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const resolvedOverridesRef = useRef<Map<string, { resolved: 'confirmed' | 'declined'; at: number }>>(new Map());
  const LOCAL_CARD_TTL_MS = 30_000;
  const refreshing = useRef(false);

  const applyResolved = useCallback((messages: Message[]): Message[] => {
    const cutoff = Date.now() - LOCAL_CARD_TTL_MS;
    for (const [k, override] of [...resolvedOverridesRef.current]) {
      if (override.at < cutoff) resolvedOverridesRef.current.delete(k);
    }
    if (resolvedOverridesRef.current.size === 0) return messages;
    return messages.map((m) => {
      const override = resolvedOverridesRef.current.get(m.k);
      return override && m.resolved === undefined ? { ...m, resolved: override.resolved } : m;
    });
  }, []);

  const refreshSlice = useCallback(async (slice: SliceName) => {
    try {
      switch (slice) {
        case 'lanes': {
          const lanes = await api.getLanes({ all: true });
          if (mounted.current) dispatch({ type: 'lanes', lanes: lanes.lanes, links: lanes.links, tokensToday: lanes.tokensToday });
          break;
        }
        case 'conductor': {
          const thread = await api.getThread();
          if (mounted.current) dispatch({ type: 'thread', thread: applyResolved(thread.messages) });
          break;
        }
        case 'integrations': {
          const integrations = await api.getIntegrations();
          if (mounted.current) dispatch({ type: 'integrations', integrations: integrations.items });
          break;
        }
        case 'caps': {
          const caps = await api.getCaps();
          if (mounted.current) dispatch({ type: 'caps', caps });
          break;
        }
        case 'proposals': {
          const proposals = await api.getProposals();
          if (mounted.current) dispatch({ type: 'proposals', proposals });
          break;
        }
        case 'queue': {
          const queue = await api.getQueue();
          if (mounted.current) dispatch({ type: 'queue', items: queue.items, paused: queue.paused, maxInFlight: queue.maxInFlight, pauseReason: queue.pauseReason });
          break;
        }
        case 'blockers': {
          const blockers = await api.getBlockers();
          if (mounted.current) dispatch({ type: 'blockers', blockers });
          break;
        }
        default:
          break;
      }
    } catch {
      // One slice failing to refetch is not a lost feed; the 5s poll judges that.
    }
  }, [applyResolved]);

  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const [lanesR, threadR, integrationsR, capsR, proposalsR, queueR, consoleStateR, blockersR] = await Promise.allSettled([
        api.getLanes({ all: true }), api.getThread(), api.getIntegrations(), api.getCaps(),
        api.getProposals(), api.getQueue(), api.getState(), api.getBlockers(),
      ]);
      if (!mounted.current) return;
      const failedSlices: string[] = [];
      const settled = <T,>(result: PromiseSettledResult<T>, name: string): T | undefined => {
        if (result.status === 'fulfilled') return result.value;
        failedSlices.push(name);
        return undefined;
      };
      const lanes = settled(lanesR, 'lanes');
      const thread = settled(threadR, 'thread');
      const integrations = settled(integrationsR, 'integrations');
      const caps = settled(capsR, 'caps');
      const proposals = settled(proposalsR, 'proposals');
      const queue = settled(queueR, 'queue');
      const consoleState = settled(consoleStateR, 'state');
      const blockers = settled(blockersR, 'blockers');
      failCount.current = failedSlices.length > 0 ? failCount.current + 1 : 0;
      if (lanes) dispatch({ type: 'lanes', lanes: lanes.lanes, links: lanes.links, tokensToday: lanes.tokensToday });
      if (thread) dispatch({ type: 'thread', thread: applyResolved(thread.messages) });
      if (integrations) dispatch({ type: 'integrations', integrations: integrations.items });
      if (caps) dispatch({ type: 'caps', caps });
      if (proposals) dispatch({ type: 'proposals', proposals });
      if (queue) dispatch({ type: 'queue', items: queue.items, paused: queue.paused, maxInFlight: queue.maxInFlight, pauseReason: queue.pauseReason });
      if (consoleState) dispatch({ type: 'queue-on', on: consoleState.queue_on });
      if (consoleState?.conductor) dispatch({ type: 'conductor-timeout', timeoutMs: consoleState.conductor.timeoutMs });
      if (consoleState) dispatch({ type: 'project', project: consoleState.project ?? null });
      if (blockers) dispatch({ type: 'blockers', blockers });
      if (consoleState?.build) {
        if (servedBuildRef.current && servedBuildRef.current !== consoleState.build) {
          window.location.reload();
          return;
        }
        servedBuildRef.current = consoleState.build;
      }
      if (failedSlices.length > 0) {
        dispatch({ type: 'thread-append', messages: [receiptCard(null, `Could not load ${failedSlices.join(', ')}.`, false)], local: true });
      }
      if (failCount.current >= 2) dispatch({ type: 'feed-lost', reason: 'the fleet server is unreachable' });
      else dispatch({ type: 'feed-live' });
    } catch {
      if (mounted.current) {
        failCount.current += 1;
        if (failCount.current >= 2) dispatch({ type: 'feed-lost', reason: 'the fleet server is unreachable' });
      }
    } finally {
      refreshing.current = false;
    }
  }, [applyResolved]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const stream = new EventStream(
      {
        onEvent: (event) => {
          if (isSliceEvent(event)) { void refreshSlice(event.slice); return; }
          if ((event as { type?: string }).type === 'heartbeat') {
            dispatch({ type: 'heartbeat', at: (event as { at?: number }).at ?? Date.now() });
            dispatch({ type: 'feed-live' });
            void api.getState().then((consoleState) => {
              if (!mounted.current || !consoleState.build) return;
              if (servedBuildRef.current && servedBuildRef.current !== consoleState.build) { window.location.reload(); return; }
              servedBuildRef.current = consoleState.build;
            }).catch(() => undefined);
            return;
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
    return () => { mounted.current = false; stream.stop(); clearInterval(poll); clearInterval(clock); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshSlice]);

  const appendReceipt = useCallback((jid: string | null, text: string, undoable: boolean) => {
    dispatch({ type: 'thread-append', messages: [receiptCard(jid, text, undoable)], local: true });
  }, []);

  const openLane = useCallback((id: string) => {
    dispatch({ type: 'view', view: 'board' });
    dispatch({ type: 'sheet', sheet: { type: 'ticket', id } });
    dispatch({ type: 'topic', topic: id });
  }, []);

  const actionsHost: ActionsHost = {
    refreshSlices: (slices) => { for (const slice of slices) void refreshSlice(slice); },
    follow: (link: ActionLink) => {
      if (link.kind === 'lane') openLane(link.id);
      else if (link.kind === 'view') dispatch({ type: 'view', view: link.view });
      else if (link.kind === 'url' && typeof window !== 'undefined') window.open(link.href, '_blank', 'noopener');
    },
    release: (token) => { void api.sendCommand(`dismiss ${token}`).catch(() => undefined); },
  };

  const labelFor = useCallback((id: string): string | null => {
    const lane = state.lanes.find((l) => l.id === id || l.ticket === id);
    if (!lane) return null;
    if (lane.ticket) return lane.ticket;
    if (lane.title) return lane.title.length > 60 ? `${lane.title.slice(0, 60)}…` : lane.title;
    return null;
  }, [state.lanes]);

  /** A typed command or a card button, round-tripped through `POST /command`. A working
   *  row goes up while the Conductor answers, and the reply cards land in the rail. */
  const processCommand = useCallback((text: string, run?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (/^answer\s/i.test(trimmed)) {
      const card: Message = { k: `op-${Date.now()}-${Math.random()}`, type: 'operator', text: commandEcho(trimmed, { labelFor }), ts: Date.now(), source: 'operator' };
      dispatch({ type: 'thread-append', messages: [card], local: true });
    }
    const key = 'sendCommand:rail';
    const tokenAction = trimmed.match(/^(confirm|run|dismiss)\s+\S+$/i);
    const working: Message | null = tokenAction ? null : { k: `working-${Date.now()}-${Math.random()}`, type: 'thinking', text: 'Conductor is working…', ts: Date.now(), source: 'conductor' };
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (working) {
      dispatch({ type: 'thread-append', messages: [working], local: true });
      const seconds = Math.round(stateRef.current.conductorTimeoutMs / 1000);
      timeoutTimer = setTimeout(() => dispatch({ type: 'local-card-text', k: working.k, text: `The Conductor did not answer in ${seconds}s; the grammar answered instead.` }), stateRef.current.conductorTimeoutMs);
    }
    const dropWorking = (): void => { if (!working) return; if (timeoutTimer) clearTimeout(timeoutTimer); dispatch({ type: 'local-card-drop', k: working.k }); };
    dispatch({ type: 'action-pending', key });
    void (async () => {
      try {
        const response = await api.sendCommand(trimmed, run);
        dropWorking();
        const answer = response.cards.filter((card) => card.type !== 'operator');
        if (answer.length > 0) dispatch({ type: 'thread-append', messages: answer });
        const refused = answer.some((card) => card.type === 'refusal');
        dispatch({ type: 'action-result', key, result: { kind: 'done', ok: !refused, text: answer[0]?.text ?? 'no reply', jid: null, at: Date.now(), link: null } });
        if (tokenAction) {
          const resolvedValue: 'confirmed' | 'declined' = /^dismiss\s/i.test(trimmed) ? 'declined' : 'confirmed';
          const target = stateRef.current.thread.find((m) => m.btns?.some((b) => b.cmd === trimmed));
          if (target) {
            resolvedOverridesRef.current.set(target.k, { resolved: resolvedValue, at: Date.now() });
            dispatch({ type: 'local-card-resolve', k: target.k, resolved: resolvedValue });
          }
        }
      } catch (caught) {
        dropWorking();
        const message = caught instanceof api.ApiError ? errorText(caught) : 'the command did not go through';
        appendReceipt(null, message, false);
        dispatch({ type: 'action-result', key, result: { kind: 'done', ok: false, text: message, jid: null, at: Date.now(), link: null } });
      }
      for (const slice of EFFECT_SLICES[ACTIONS.sendCommand.effect]) void refreshSlice(slice);
    })();
  }, [appendReceipt, refreshSlice, labelFor]);

  /** Typed text and chips echo an operator bubble first. `toLane` addresses the agent
   *  working that lane; the bubble says so. */
  const onRailSend = useCallback((text: string, toLane?: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const card: Message = { k: `op-${Date.now()}-${Math.random()}`, type: 'operator', text: commandEcho(trimmed, { labelFor }), ts: Date.now(), source: 'operator', ...(toLane ? { lane: toLane } : {}) };
    dispatch({ type: 'thread-append', messages: [card], local: true });
    // A longer answer typed under a topic that is waiting on one goes to that question
    // (the rail's own "type a longer answer below and press Send"), unless it reads as a
    // question or a command of its own.
    const topicLane = !toLane && stateRef.current.topic ? stateRef.current.lanes.find((l) => l.id === stateRef.current.topic) : undefined;
    const question = topicLane?.question;
    const looksLikeAsk = /\?\s*$/.test(trimmed) || /^(what|why|how|show|who|when|where|which|pause|resume|kill|merge|confirm|dismiss|run|answer|status|spend|cap|nudge|ask)\b/i.test(trimmed);
    if (question && !looksLikeAsk) { processCommand(`answer ${question.key} ${trimmed}`); return; }
    processCommand(trimmed, toLane);
  }, [processCommand, labelFor]);

  /** A card button, a chip or a question's answer: `open <view>` and `open lane <id>`
   *  are the page's own; everything else goes to the grammar. */
  const onRailCommand = useCallback((text: string) => {
    const open = /^open\s+(.+)$/i.exec(text.trim());
    if (open) {
      const target = open[1]!.trim();
      const laneMatch = /^lane\s+(.+)$/i.exec(target);
      if (laneMatch) { openLane(laneMatch[1]!.trim()); return; }
      const view = target.toLowerCase() as View;
      if (VIEWS.includes(view)) { dispatch({ type: 'view', view }); return; }
    }
    processCommand(text);
  }, [processCommand, openLane]);

  /**
   * One catalog action run from the board or a sheet. An irreversible action answers
   * with a confirm first; that confirm is the server's own card and lands in the rail,
   * where its buttons round-trip the token through `/command`.
   */
  const runCatalogAction = useCallback(<A extends unknown[], R>(spec: ActionSpec<A, R>, args: A, ref?: string, lane?: string): Promise<void> => {
    const key = actionKey(spec.id, ref);
    dispatch({ type: 'action-pending', key });
    return spec.call(args).then((result) => {
      if (api.isConfirmPending(result)) {
        dispatch({ type: 'thread-append', messages: [{ ...result.card, ...(lane ? { lane } : {}) }], local: true });
        if (lane) dispatch({ type: 'topic', topic: lane });
        dispatch({ type: 'action-result', key, result: { kind: 'confirm', token: result.token, blast: result.blast, at: Date.now() } });
        return;
      }
      const ok = spec.ok ? spec.ok(result) : true;
      const text = spec.text(result, args);
      const jid = spec.jid?.(result) ?? null;
      dispatch({ type: 'action-result', key, result: { kind: 'done', ok, text, jid, at: Date.now(), link: spec.link?.(args, result) ?? null } });
      appendReceipt(jid, text, false);
    }, (caught: unknown) => {
      const message = errorText(caught);
      dispatch({ type: 'action-result', key, result: { kind: 'done', ok: false, text: message, jid: null, at: Date.now(), link: null } });
      appendReceipt(null, message, false);
    }).then(() => { for (const slice of EFFECT_SLICES[spec.effect]) void refreshSlice(slice); });
  }, [appendReceipt, refreshSlice]);

  const onUndo = useCallback((jid: string) => { void runCatalogAction(ACTIONS.undoJournal, [jid], jid); }, [runCatalogAction]);

  const blockers = state.blockers?.blockers ?? [];

  /** The board card's one button. */
  const onBoardCommand = useCallback((id: string, cmd: BoardCommand) => {
    const lane = state.lanes.find((l) => l.id === id);
    if (cmd === 'watch' || cmd === 'answer') { openLane(id); return; }
    if (cmd === 'settings' || cmd === 'queue' || cmd === 'blockers') { dispatch({ type: 'view', view: cmd }); return; }
    if (cmd === 'open-pr') { if (lane?.pr?.url && typeof window !== 'undefined') window.open(lane.pr.url, '_blank', 'noopener'); return; }
    if (cmd.startsWith('open-url:')) { if (typeof window !== 'undefined') window.open(cmd.slice('open-url:'.length), '_blank', 'noopener'); return; }
    if (cmd === 'nudge') {
      const blocker = lane ? blockerFor(lane, blockers) : null;
      const who = blocker?.who ?? 'the owner';
      onRailSend(`Nudge ${who} about ${labelFor(id) ?? 'this lane'}: ${blocker?.howToResolve ?? 'it is waiting on them.'}`);
      return;
    }
    switch (cmd) {
      case 'merge': void runCatalogAction(ACTIONS.mergeRun, [id], id, id); break;
      case 'resume': void runCatalogAction(ACTIONS.resumeRun, [id], id, id); break;
      case 'compact': void runCatalogAction(ACTIONS.compactRun, [id], id, id); break;
      case 'verify': void runCatalogAction(ACTIONS.verifyRun, [id], id, id); break;
      case 'reopen': void runCatalogAction(ACTIONS.reopenRun, [id], id, id); break;
      case 'unretire': void runCatalogAction(ACTIONS.unretireRun, [id], id, id); break;
      case 'recheck': void runCatalogAction(ACTIONS.recheckRun, [id], id, id); break;
      case 'kill': void runCatalogAction(ACTIONS.killRun, [id, 'killed from the board'], id, id); break;
      default: break;
    }
  }, [state.lanes, blockers, openLane, runCatalogAction, onRailSend, labelFor]);

  const onLaneCommand = useCallback((id: string, text: string) => {
    dispatch({ type: 'topic', topic: id });
    processCommand(text);
  }, [processCommand]);

  const onSendLane = useCallback((id: string, text: string) => { onRailSend(text, id); }, [onRailSend]);

  const onStop = useCallback(() => { void runCatalogAction(ACTIONS.stopAll, [], 'fleet'); }, [runCatalogAction]);

  const sheet = state.sheet;
  const sheetLane = sheet?.type === 'ticket' ? state.lanes.find((l) => l.id === sheet.id) : undefined;
  useEffect(() => {
    if (!sheet || sheet.type !== 'ticket' || sheetLane) return;
    dispatch({ type: 'sheet', sheet: null });
    appendReceipt(null, `${labelFor(sheet.id) ?? 'That lane'} is no longer on the board.`, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, sheetLane]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape' && stateRef.current.sheet) dispatch({ type: 'sheet', sheet: null });
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const sheetContainerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!state.sheet) return;
    const container = sheetContainerRef.current;
    if (!container) return;
    const ring = focusableIn(container);
    (ring[0] ?? container).focus();
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== 'Tab' || !container) return;
      const next = trapTab(focusableIn(container), document.activeElement, e.shiftKey);
      if (next) { e.preventDefault(); next.focus(); }
    }
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [state.sheet]);

  const needs = buildNeeds(state.lanes, state.integrations, (_kind, id) => openLane(id));
  const activeLanes = state.lanes.filter((l) => l.retiredAt === null && l.state !== 'merged' && l.state !== 'killed');
  // A slot is taken by any lane still on the board, working or waiting.
  const working = activeLanes.length;
  const blockersBadge = blockers.filter((b) => b.state !== 'resolved').length;
  const badges: Partial<Record<View, number>> = { blockers: blockersBadge || undefined, board: needs.length || undefined };
  // A topic is usually a lane on the board; a card about a queued ticket that has not
  // started yet names the ticket itself.
  const topic = state.topic ? { id: state.topic, label: labelFor(state.topic) ?? (/^[A-Z][A-Z0-9_]*-\d+$/.test(state.topic) ? state.topic : 'this lane') } : null;
  const topicCard = topic ? [...state.thread].reverse().find((m) => (m.lane === topic.id || m.source === topic.id) && m.btns && m.btns.length > 0 && !m.resolved) : undefined;
  const commands: RailCommand[] = topic
    ? [...(topicCard?.btns ?? []).map((b) => ({ label: b.label, cmd: b.cmd })), { label: 'Show its story', cmd: `open lane ${topic.id}` }]
    : DEFAULT_COMMANDS;
  const queue = { items: state.queue, paused: state.queuePaused, pauseReason: state.queuePauseReason, maxInFlight: state.queueMaxInFlight, on: state.queueOn };

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <ActionsContext.Provider value={actionsHost}>
        <div className="app" data-theme={state.theme} data-testid="app">
          <Chrome view={state.view} badges={badges} feed={state.feed} project={state.project} queueOn={state.queueOn} now={state.now} onNav={(view) => dispatch({ type: 'view', view })} />
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            {state.view === 'board' ? (
              <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex' }}>
                <LanesGrid lanes={state.lanes} blockers={blockers} queue={queue} needs={needs} now={state.now} onOpen={openLane} onCommand={onBoardCommand} onLaneCommand={onLaneCommand} onQueue={() => dispatch({ type: 'view', view: 'queue' })} />
                {sheet?.type === 'ticket' && sheetLane ? (
                  <div ref={sheetContainerRef} tabIndex={-1} data-testid="sheet-scrim" style={{ position: 'absolute', inset: 0, background: 'var(--scrim)', outline: 'none' }} onClick={() => dispatch({ type: 'sheet', sheet: null })}>
                    <TicketSheet lane={sheetLane} now={state.now} onClose={() => dispatch({ type: 'sheet', sheet: null })} onCommand={onLaneCommand} onSendLane={onSendLane} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {state.view === 'blockers' ? <BlockersView blockers={blockers} chains={state.blockers?.chains ?? []} laneTitle={(id) => state.lanes.find((l) => l.id === id)?.title ?? null} onOpenSettings={() => dispatch({ type: 'view', view: 'settings' })} onSendToLane={onSendLane} /> : null}
            {state.view === 'queue' ? <QueueView items={state.queue} paused={state.queuePaused} pauseReason={state.queuePauseReason} maxInFlight={state.queueMaxInFlight} working={working} /> : null}
            {state.view === 'review' ? <FlightReview proposals={state.proposals} now={state.now} tokensToday={state.caps?.tokensToday} dailyTokens={state.caps?.dailyTokens} /> : null}
            {state.view === 'settings' ? <Settings integrations={state.integrations} caps={state.caps} now={state.now} maxInFlight={state.queueMaxInFlight} theme={state.theme} onTheme={(theme) => dispatch({ type: 'theme', theme })} /> : null}
            <ConductorRail
              thread={state.thread} feed={state.feed} now={state.now} composer={state.composer}
              onComposerChange={(text) => dispatch({ type: 'composer', text })}
              onSend={onRailSend} onCommand={onRailCommand} onUndo={onUndo} labelFor={labelFor}
              agentCount={activeLanes.length}
              topic={topic} recipient={state.recipient}
              onRecipient={(recipient) => dispatch({ type: 'recipient', recipient })}
              onTopic={(id) => dispatch({ type: 'topic', topic: id })}
              commands={commands} onStop={onStop}
            />
          </div>
        </div>
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}
