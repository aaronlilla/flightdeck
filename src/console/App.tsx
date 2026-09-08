import type { JSX } from 'react';
/**
 * The console's root component: one store, fed from `/lanes`, `/thread`,
 * `/journal`, `/integrations`, `/caps`, `/proposals` on load and every 5s
 * after (the fallback). A `{ type: 'slice' }` frame on `/events` refetches that
 * one slice; any other named event refetches everything. A heartbeat frame marks
 * the feed live, stamps `feed.lastHeartbeatAt` and re-reads `/state` alone (the
 * build check); two failed fetches in a row, or the socket closing, flips
 * `feed.live` false.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';

import { ACTIONS, ActionsContext, EFFECT_SLICES, actionKey, errorText, showToast, type ActionSpec, type ActionsHost } from './actions.js';
import * as api from './api.js';
import { BlockersView } from './components/BlockersView.js';
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
import { QueueOffBanner } from './components/QueueOffBanner.js';
import { QueueView } from './components/QueueView.js';
import { SandboxSheet } from './components/SandboxSheet.js';
import { Settings } from './components/Settings.js';
import { TicketSheet } from './components/TicketSheet.js';
import { Toast } from './components/Toast.js';
import { TopBar } from './components/TopBar.js';
import { focusableIn, trapTab } from './focus-trap.js';
import { initialState, reducer, StoreContext, type ActionLink } from './store.js';
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

export function App({ eventStreamOptions }: AppProps = {}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const failCount = useRef(0);
  const servedBuildRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  // `refresh` is a stable `useCallback` with an empty dependency list (see below); it
  // reads the verbose flag through this ref rather than `state.verbose` directly for
  // the same reason `stateRef` exists, and `onToggleVerbose` sets it by hand a beat
  // ahead of the render that would otherwise catch it up, so the very next fetch it
  // triggers already asks for the mode the operator just clicked.
  const verboseRef = useRef(state.verbose);
  verboseRef.current = state.verbose;
  // A server round-trip confirm/plan card (from `POST /command`) is persisted to
  // `thread.jsonl` unresolved and never mutated there once its own button is clicked,
  // so a `/thread` replace would otherwise keep reviving it as "awaiting you" with live
  // buttons forever. Clicking Confirm/Run plan/Not now records the outcome here, keyed
  // by the card's own `k`, and every thread fetch re-applies it until it ages out.
  const resolvedOverridesRef = useRef<Map<string, { resolved: 'confirmed' | 'declined'; at: number }>>(new Map());
  const LOCAL_CARD_TTL_MS = 30_000;
  // Load-verify finding: the 5s poll and every `/events` frame both call `refresh`, with
  // nothing stopping either from starting a second one while the first is still waiting
  // on a slow `/lanes` (the response that a few thousand lanes over a few hundred
  // thousand journal events makes slow in the first place). Left unguarded, that pile-up
  // only compounds the load that caused it -- the fix is to skip a refresh outright
  // while one is already in flight, never to queue it.
  const refreshing = useRef(false);

  // The store re-attaches this page's own local cards on every `thread` replace (see
  // `localCards` in store.ts); the resolved-override patch above is the one thread
  // adjustment that still lives here.
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

  /** One slice, refetched on its own: what a `{ type: 'slice' }` frame asks for, and
   *  what an action's own effect refetches the moment it answers. */
  const refreshSlice = useCallback(async (slice: SliceName) => {
    try {
      switch (slice) {
        case 'lanes': {
          const lanes = await api.getLanes({ all: true });
          if (mounted.current) dispatch({ type: 'lanes', lanes: lanes.lanes, links: lanes.links });
          break;
        }
        case 'conductor': {
          const thread = await api.getThread({ verbose: verboseRef.current });
          if (mounted.current) dispatch({ type: 'thread', thread: applyResolved(thread.messages) });
          break;
        }
        case 'journal': {
          const journal = await api.getJournal();
          if (mounted.current) dispatch({ type: 'journal', journal: journal.rows });
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
        case 'accounts':
          // No accounts slice is read by this console yet; the frame is accepted so a
          // server publishing it is not an error here.
          break;
        default:
          break;
      }
    } catch {
      // A single slice failing to refetch is not a lost feed: the 5s poll reports
      // that on its own terms. Nothing here is swallowed into a green.
    }
  }, [applyResolved]);

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
      //
      // `allSettled`, not `all`: one endpoint 500ing must never throw the whole batch
      // away and blank a board whose lanes read came back fine (sweep #27). Each slice
      // dispatches on its own; a rejected one is skipped and named in a toast rather
      // than silently standing in for real data.
      const [lanesR, threadR, journalR, integrationsR, capsR, proposalsR, queueR, consoleStateR, blockersR] = await Promise.allSettled([
        api.getLanes({ all: true }),
        api.getThread({ verbose: verboseRef.current }), api.getJournal(), api.getIntegrations(), api.getCaps(),
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
      const journal = settled(journalR, 'journal');
      const integrations = settled(integrationsR, 'integrations');
      const caps = settled(capsR, 'caps');
      const proposals = settled(proposalsR, 'proposals');
      const queue = settled(queueR, 'queue');
      const consoleState = settled(consoleStateR, 'state');
      const blockers = settled(blockersR, 'blockers');

      failCount.current = failedSlices.length > 0 ? failCount.current + 1 : 0;
      const endedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
      dispatch({ type: 'fetch-latency', ms: Math.round(endedAt - startedAt) });
      if (lanes) dispatch({ type: 'lanes', lanes: lanes.lanes, links: lanes.links });
      // Local cards, their TTL and the operator-bubble dedupe live in the reducer's
      // own `thread` case now, so every replace gets them rather than this one call site.
      if (thread) dispatch({ type: 'thread', thread: applyResolved(thread.messages) });
      if (journal) dispatch({ type: 'journal', journal: journal.rows });
      if (integrations) dispatch({ type: 'integrations', integrations: integrations.items });
      if (caps) dispatch({ type: 'caps', caps });
      if (proposals) dispatch({ type: 'proposals', proposals });
      if (queue) dispatch({ type: 'queue', items: queue.items, paused: queue.paused, maxInFlight: queue.maxInFlight, pauseReason: queue.pauseReason });
      if (consoleState) dispatch({ type: 'queue-on', on: consoleState.queue_on });
      if (consoleState?.conductor) dispatch({ type: 'conductor-timeout', timeoutMs: consoleState.conductor.timeoutMs });
      if (blockers) dispatch({ type: 'blockers', blockers });
      // The server moved onto a new build (a restart, a self cutover): this page's
      // components are the old ones, so reload rather than paint new data with them.
      if (consoleState?.build) {
        if (servedBuildRef.current && servedBuildRef.current !== consoleState.build) {
          window.location.reload();
          return;
        }
        servedBuildRef.current = consoleState.build;
      }
      if (failedSlices.length > 0) {
        dispatch({
          type: 'toast',
          toast: {
            glyph: '✕', title: `could not load: ${failedSlices.join(', ')}`, sub: '', big: '', color: 'var(--block)',
          },
        });
        setTimeout(() => { if (mounted.current) dispatch({ type: 'toast', toast: null }); }, 4000);
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
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const stream = new EventStream(
      {
        onEvent: (event) => {
          if (isSliceEvent(event)) {
            void refreshSlice(event.slice);
            return;
          }
          if ((event as { type?: string }).type === 'heartbeat') {
            dispatch({ type: 'heartbeat', at: (event as { at?: number }).at ?? Date.now() });
            dispatch({ type: 'feed-live' });
            // The build check rides the heartbeat: `/state` alone, never every slice.
            void api.getState().then((consoleState) => {
              if (!mounted.current || !consoleState.build) return;
              if (servedBuildRef.current && servedBuildRef.current !== consoleState.build) {
                window.location.reload();
                return;
              }
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
    return () => {
      mounted.current = false;
      stream.stop();
      clearInterval(poll);
      clearInterval(clock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, refreshSlice]);

  const appendReceipt = useCallback((jid: string | null, text: string, undoable: boolean) => {
    dispatch({ type: 'thread-append', messages: [receiptCard(jid, text, undoable)], local: true });
  }, []);

  /** What every `useAction` in the tree needs from the page: the slice refetch, how
   *  to follow a link to an effect, and how to release a declined server confirm. */
  const actionsHost: ActionsHost = {
    refreshSlices: (slices) => { for (const slice of slices) void refreshSlice(slice); },
    follow: (link: ActionLink) => {
      if (link.kind === 'lane') dispatch({ type: 'sheet', sheet: { type: 'ticket', id: link.id } });
      else if (link.kind === 'view') dispatch({ type: 'view', view: link.view });
      else if (link.kind === 'journal') dispatch({ type: 'sheet', sheet: { type: 'journal', run: link.jid } });
      else if (typeof window !== 'undefined') window.open(link.href, '_blank', 'noopener');
    },
    release: (token) => { void api.sendCommand(`dismiss ${token}`).catch(() => undefined); },
  };

  // A person's name for a lane id or ticket key -- the ticket, else the title, else
  // null (the machine id it came from, never printed as a fallback). Every place the
  // board would otherwise echo a run id back at the operator (a Kill/Merge confirm, a
  // typed `kill <id>` command, a question's "from <id>" header) goes through this.
  const labelFor = useCallback((id: string): string | null => {
    const lane = state.lanes.find((l) => l.id === id) ?? state.archivedLanes.find((l) => l.id === id);
    if (!lane) return null;
    if (lane.ticket) return lane.ticket;
    if (lane.title) return lane.title.length > 60 ? `${lane.title.slice(0, 60)}…` : lane.title;
    return null;
  }, [state.lanes, state.archivedLanes]);

  // A toast shows the same text an action's own control shows, on views where the
  // rail is not mounted (queue, settings). The control's inline result is the primary
  // feedback; this is the glance-level copy.
  const queueToast = useCallback((text: string, ok: boolean) => showToast(dispatch, text, ok), []);

  // The prototype's own `handle(text)` -- confirm/decline resolution, else a
  // POST /command round trip -- runs identically whether the text was typed into
  // the composer or produced by a button/chip. Only the operator-bubble echo
  // differs by call site (`send()` vs. a direct method call), so that split lives
  // one level up in onRailSend/onRailCommand rather than here.
  const processCommand = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Every confirm, dismiss and run token lives in the server's own pending map, so
    // every one of them round-trips through `/command`; nothing is resolved locally.
    // Item 7: clicking a question's option (or typing a free-text answer) still
    // bypasses `onRailSend`'s operator bubble -- this is the one place that path
    // still needs one, since "Answered: <option>" is the one honest thing to say
    // the operator just did. Every other button here (reply/plan/confirm) still
    // echoes nothing, matching the design this rail already had.
    if (/^answer\s/i.test(trimmed)) {
      const card: Message = { k: `op-${Date.now()}-${Math.random()}`, type: 'operator', text: commandEcho(trimmed, { labelFor }), ts: Date.now(), source: 'operator' };
      dispatch({ type: 'thread-append', messages: [card], local: true });
    }
    // A model call takes seconds, and a rail that shows nothing for five seconds reads
    // as broken. A local working row goes up the moment the message leaves, tool
    // receipts stream in over the live feed underneath it, and it comes down when the
    // reply lands. If the class timeout passes first, the row says so. The composer's
    // own control reads `key` for pending and the reply for its inline result.
    const key = 'sendCommand:rail';
    const tokenAction = trimmed.match(/^(confirm|run|dismiss)\s+\S+$/i);
    const working: Message | null = tokenAction ? null : {
      k: `working-${Date.now()}-${Math.random()}`, type: 'thinking', text: 'Conductor is working…', ts: Date.now(), source: 'conductor',
    };
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    if (working) {
      dispatch({ type: 'thread-append', messages: [working], local: true });
      const seconds = Math.round(stateRef.current.conductorTimeoutMs / 1000);
      timeoutTimer = setTimeout(() => {
        const text = `the Conductor did not answer in ${seconds}s; the grammar answered instead…`;
        dispatch({ type: 'local-card-text', k: working.k, text });
      }, stateRef.current.conductorTimeoutMs);
    }
    const dropWorking = () => {
      if (!working) return;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      dispatch({ type: 'local-card-drop', k: working.k });
    };
    dispatch({ type: 'action-pending', key });
    void (async () => {
      try {
        const response = await api.sendCommand(trimmed);
        dropWorking();
        // The server echoes the operator's own card first (`ConsoleWrites.command`);
        // this rail already showed its own bubble, so only the answer is appended.
        const answer = response.cards.filter((card) => card.type !== 'operator');
        if (answer.length > 0) dispatch({ type: 'thread-append', messages: answer });
        const refused = answer.some((card) => card.type === 'refusal');
        dispatch({ type: 'action-result', key, result: { kind: 'done', ok: !refused, text: answer[0]?.text ?? 'no reply', jid: null, at: Date.now(), link: null } });
        // The card this command actioned lives only in `thread.jsonl`, unresolved:
        // see `resolvedOverridesRef` above for why `refresh()` needs this recorded
        // rather than patched once here.
        if (tokenAction) {
          const resolvedValue: 'confirmed' | 'declined' = /^dismiss\s/i.test(trimmed) ? 'declined' : 'confirmed';
          const target = stateRef.current.thread.find((m) => m.btns?.some((b) => b.cmd === trimmed));
          if (target) resolvedOverridesRef.current.set(target.k, { resolved: resolvedValue, at: Date.now() });
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

  // D2.2: TicketSheet's own run-thread `MessageCard` wires `onCommand` to
  // `(text) => onCommand(lane.id, text)` -- this same exact-match switch. A
  // question/plan/confirm card's own button sends free text like
  // `answer ask-bbz-118 nullable + backfill`, which matches none of the CTA
  // strings below. Rather than give the sheet a second entry point into
  // `processCommand`, anything this switch does not recognize as one of the
  // board's own CTA commands falls through to it -- the sheet and the rail end
  // up on the exact same command path either way.
  const onCommand = useCallback((id: string, cmd: string) => {
    const lane = state.lanes.find((l) => l.id === id);
    if (cmd === 'watch' || cmd === 'council' || cmd === 'gate-log' || cmd === 'answer') {
      dispatch({ type: 'sheet', sheet: { type: 'ticket', id, ...(cmd === 'council' ? { focus: 'audit' } : {}) } });
      return;
    }
    if (cmd === 'open-pr') {
      if (lane?.pr?.url && typeof window !== 'undefined') window.open(lane.pr.url, '_blank', 'noopener');
      return;
    }
    // A lane mutation (kill, merge, pause, resume, compact, verify, reopen, unretire,
    // reconnect) renders as `LaneCta`, which runs the catalog action where it was
    // clicked; a command reaching here that is none of the openers above is free text
    // from a card button and goes to the grammar.
    processCommand(cmd);
  }, [state.lanes, processCommand]);

  // Typed composer text (and the rail's quick-command chips, which the prototype
  // also routes through `send()`) echoes an operator bubble before processing.
  const onRailSend = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    // The stub and the real grammar both append only the reply/confirm/plan cards a
    // command produces to their own thread, never an echo of the operator's own text
    // (see `/command` above) -- so this bubble is client-only, exactly like a receipt.
    // It needs the same `localCardsRef` protection `appendReceipt` gives a receipt, or
    // the very next `refresh()` (the 5s poll, or the `/events` frame this command's own
    // side effect can trigger) drops it the moment `state.thread` is replaced wholesale.
    const card: Message = {
      k: `op-${Date.now()}-${Math.random()}`, type: 'operator', text: commandEcho(trimmed, { labelFor }), ts: Date.now(), source: 'operator',
    };
    dispatch({ type: 'thread-append', messages: [card], local: true });
    processCommand(trimmed);
  }, [processCommand, labelFor]);

  // Reply/plan/confirm/question buttons in the rail: the prototype wires these
  // straight to a method call, never to `send()`, so no fake operator bubble.
  const onRailCommand = useCallback((text: string) => { processCommand(text); }, [processCommand]);

  // Undo from a rail card or the journal sheet: the catalog entry, run without a
  // control of its own, so the receipt still lands in the rail and the slices refetch.
  /**
   * One catalog action run from here rather than from a control of its own, for the
   * two places where the button lives inside a child that takes a callback: the
   * journal's Undo and the ticket sheet's Amend. Same four promises as `useAction`,
   * minus the inline result, which the child renders itself.
   */
  const runCatalogAction = useCallback(<A extends unknown[], R>(
    spec: ActionSpec<A, R>, args: A, ref?: string,
  ): Promise<void> => {
    const key = actionKey(spec.id, ref);
    dispatch({ type: 'action-pending', key });
    return spec.call(args).then((result) => {
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

  const onUndo = useCallback((jid: string) => {
    void runCatalogAction(ACTIONS.undoJournal, [jid], jid);
  }, [runCatalogAction]);

  const onOpenJournal = useCallback((jid: string) => {
    dispatch({ type: 'sheet', sheet: { type: 'journal', run: jid } });
  }, []);

  const sheet = state.sheet;
  // An archived lane's sheet id never resolves off `state.lanes` alone -- a retired
  // lane leaves the live board, but its tile (Archived filter) still opens the sheet.
  const sheetLane = sheet && sheet.type !== 'journal' && sheet.type !== 'fleet-cost'
    ? state.lanes.find((l) => l.id === sheet.id) ?? state.archivedLanes.find((l) => l.id === sheet.id)
    : undefined;

  // The lane behind an open sheet can vanish off the board entirely -- retired and
  // then swept out of the archived list, or otherwise gone by the time the next poll
  // lands. Close cleanly with a receipt rather than leaving a blank sheet on screen.
  useEffect(() => {
    if (!sheet || sheet.type === 'journal' || sheet.type === 'fleet-cost' || sheetLane) return;
    dispatch({ type: 'sheet', sheet: null });
    appendReceipt(null, `${sheet.id} is no longer on the board.`, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet, sheetLane]);

  const needs = buildNeeds(state.lanes, state.integrations, (kind, id) => {
    if (kind === 'lane') dispatch({ type: 'sheet', sheet: { type: 'ticket', id } });
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

  // Sweep #11: a modal sheet had no focus trap -- Tab walked off it and onto the tiles
  // it covers. While a sheet is open, Tab (and Shift+Tab) cycles within it alone, and
  // focus lands inside it the moment it opens.
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

  const paletteItems = buildPaletteItems(
    state.paletteQuery, state.lanes, state.journal,
    (id) => dispatch({ type: 'sheet', sheet: { type: 'ticket', id } }),
    (view) => dispatch({ type: 'view', view }),
    onOpenJournal,
  );

  const repos = [...new Set(state.lanes.map((l) => l.repo).filter((r): r is string => Boolean(r)))];
  // The top bar's own live count, off the liveness ticker's `lane.live` rather than
  // the lane state, so a row whose process died reads as not live at once.
  const liveCount = state.lanes.filter((l) => l.live.alive).length;
  const settingsBadge = state.integrations.filter((i) => i.status === 'down').length;
  const reviewBadge = state.proposals?.rules.filter((r) => r.status === 'open').length ?? 0;
  const queueBadge = state.queue.filter((i) => i.state === 'parked' || i.state === 'failed').length;
  const blockersBadge = state.blockers?.blockers.filter((b) => b.state === 'open' && b.youCanResolve).length ?? 0;

  return (
    <StoreContext.Provider value={{ state, dispatch }}>
      <ActionsContext.Provider value={actionsHost}>
      <div className={`${state.theme} app`} tabIndex={-1}>
        <DisconnectedBanner feed={state.feed} onRetry={() => void refresh()} />
        <QueueOffBanner queueOn={state.queueOn} />
        <TopBar
          pending={state.pending}
          liveCount={liveCount}
          view={state.view} settingsBadge={settingsBadge} reviewBadge={reviewBadge} queueBadge={queueBadge}
          blockersBadge={blockersBadge}
          caps={state.caps} tokensToday={state.caps?.tokensToday ?? 0} feed={state.feed} now={state.now}
          fetchLatencyMs={state.fetchLatencyMs}
          theme={state.theme}
          verbose={state.verbose}
          onNav={(view) => dispatch({ type: 'view', view })}
          onOpenPalette={() => dispatch({ type: 'palette-open', open: true })}
          onOpenCost={() => dispatch({ type: 'sheet', sheet: { type: 'fleet-cost' } })}
          onToggleTheme={() => dispatch({ type: 'theme', theme: state.theme === 'thD' ? 'thL' : 'thD' })}
          onToggleVerbose={() => {
            verboseRef.current = !state.verbose;
            dispatch({ type: 'verbose', verbose: !state.verbose });
            void refresh();
          }}
        />
        <NeedsYou items={needs} blockersCount={blockersBadge} onOpenBlockers={() => dispatch({ type: 'view', view: 'blockers' })} />
        {state.view === 'board' ? (
          <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <Filters
                filter={state.filter} sort={state.sort} repos={repos} lanes={state.lanes}
                archivedLanes={state.archivedLanes} showProbes={state.showProbes} now={state.now}
                onFilter={(filter) => {
                  dispatch({ type: 'filter', filter });
                  if (filter === 'all') void refresh();
                  if (filter === 'archived') {
                    void api.getLanes({ archived: true }).then((r) => dispatch({ type: 'archived-lanes', lanes: r.lanes })).catch(() => undefined);
                  }
                }}
                onSort={(sort) => dispatch({ type: 'sort', sort })}
                onToggleProbes={() => dispatch({ type: 'toggle-probes' })}
              />
              <LanesGrid
                lanes={state.filter === 'archived' ? state.archivedLanes : state.lanes}
                filter={state.filter} sort={state.sort} feedLive={state.feed.live} now={state.now} showProbes={state.showProbes}
                onOpen={(id) => dispatch({ type: 'sheet', sheet: { type: 'ticket', id } })}
                onOpenCost={(id) => dispatch({ type: 'sheet', sheet: { type: 'cost', id } })}
                onCommand={onCommand}
                onTip={(tip) => dispatch({ type: 'tip', tip })}
              />
            </div>
            <ConductorRail
              thread={state.thread} feed={state.feed} now={state.now} composer={state.composer} verbose={state.verbose}
              onComposerChange={(text) => dispatch({ type: 'composer', text })}
              onSend={onRailSend}
              onCommand={onRailCommand}
              onUndo={onUndo}
              onOpenJournal={onOpenJournal}
              labelFor={labelFor}
            />
          </div>
        ) : null}
        {state.view === 'settings' ? (
          <Settings
            integrations={state.integrations} caps={state.caps} journalCount={state.journal.length}
            journal={state.journal} rules={state.proposals?.rules ?? []} lanes={state.lanes} feed={state.feed} now={state.now}
            onCheckAll={() => void refreshSlice('integrations')}
            onToast={queueToast}
            onOpenJournal={() => dispatch({ type: 'sheet', sheet: { type: 'journal' } })}
          />
        ) : null}
        {state.view === 'review' ? (
          <FlightReview proposals={state.proposals} now={state.now} onUndo={onUndo} />
        ) : null}
        {state.view === 'queue' ? (
          <QueueView
            items={state.queue} paused={state.queuePaused} pauseReason={state.queuePauseReason} maxInFlight={state.queueMaxInFlight}
            onToast={queueToast}
          />
        ) : null}
        {state.view === 'blockers' ? (
          <BlockersView
            blockers={state.blockers?.blockers ?? []} chains={state.blockers?.chains ?? []}
            // Deliberately never eager-refreshes here: the step's own local state
            // already shows "Resolved HH:MM · Started: ..." the moment this resolves
            // (see `BlockersView.tsx#StepButtons`), and an immediate refetch would
            // replace those props before that ever painted, collapsing a just-cleared
            // step straight into "Resolved today" with no transient in between. The
            // normal 5s poll (or the next `/events` heartbeat) picks up the real state
            // once the operator has had a chance to see the outcome of their own click.
          />
        ) : null}

        {state.sheet ? (
          <div
            // A standard modal: a full-screen scrim over everything, padding all round,
            // the dialog centred and capped to the viewport, and only the dialog's own
            // body scrolls. The scrim itself never scrolls, so the app behind it never moves.
            data-testid="sheet-scrim"
            style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'color-mix(in srgb,var(--bg) 62%,transparent)', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: 24, overflow: 'hidden' }}
            onClick={() => dispatch({ type: 'sheet', sheet: null })}
          >
            <div
              ref={sheetContainerRef} tabIndex={-1}
              style={{ outline: 'none', maxHeight: '100%', maxWidth: '100%', display: 'flex', minHeight: 0 }}
              onClick={(e) => e.stopPropagation()}
            >
              {state.sheet.type === 'ticket' && sheetLane ? (
                <TicketSheet
                  lane={sheetLane} feedLive={state.feed.live} now={state.now} verbose={state.verbose}
                  focus={state.sheet.focus}
                  onClose={() => dispatch({ type: 'sheet', sheet: null })}
                  onToggleVerbose={() => {
                    verboseRef.current = !state.verbose;
                    dispatch({ type: 'verbose', verbose: !state.verbose });
                    void refresh();
                  }}
                  onCommand={onCommand}
                  onOpenCost={(id) => dispatch({ type: 'sheet', sheet: { type: 'cost', id } })}
                  onOpenSandbox={(id) => dispatch({ type: 'sheet', sheet: { type: 'sandbox', id } })}
                  // The composer talks to the Conductor with the lane as context,
                  // never straight into an inbox nobody may read. The sheet renders
                  // the cards itself; `refresh()` picks up the rail's copy.
                  conductorTimeoutMs={state.conductorTimeoutMs}
                  onSendLane={async (id, textMsg) => {
                    const response = await api.sendCommand(textMsg, id);
                    void refresh();
                    return response;
                  }}
                  onAmendLane={(id, textMsg) => runCatalogAction(ACTIONS.amendRun, [id, textMsg], id)}
                  onOpenJournal={onOpenJournal}
                  onUndo={onUndo}
                  labelFor={labelFor}
                />
              ) : null}
              {state.sheet.type === 'cost' && sheetLane ? (
                <CostSheet lane={sheetLane} onClose={() => dispatch({ type: 'sheet', sheet: null })} />
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
                <SandboxSheet
                  lane={sheetLane} onClose={() => dispatch({ type: 'sheet', sheet: null })}
                  onCopiedPath={(path) => queueToast(`copied ${path} to clipboard`, true)}
                />
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
      </ActionsContext.Provider>
    </StoreContext.Provider>
  );
}
