/**
 * The one store: a `useReducer` + context pair holding exactly the contract
 * types plus the UI state the board needs (view, filter, sort, the open
 * sheet, the palette, a hover tip, a toast, the theme, composer drafts).
 */
import { createContext, useContext, useReducer } from 'react';
import { RAIL_TYPES } from '../shared/rail-kinds.js';
import type { Dispatch } from 'react';
import type {
  AccountItem,
  BlockersResponse,
  Caps,
  Feed,
  Integration,
  JournalEntry,
  Lane,
  Message,
  ProposalsResponse,
  QueueItem,
} from '../shared/console-model.js';
import type { MachineResponse } from './api.js';
import type { SyncStateResponse } from '../shared/sync-contract.js';

export type View = 'board' | 'settings' | 'review' | 'queue' | 'blockers' | 'machine';
export type Filter = 'all' | 'needs-me' | 'running' | 'finished' | string;
export type Sort = 'cost' | 'age' | 'state';

export type SheetSpec =
  | { type: 'ticket'; id: string; focus?: 'audit' }
  | { type: 'cost'; id: string }
  | { type: 'fleet-cost' }
  | { type: 'journal'; run?: string }
  | { type: 'sandbox'; id: string };

export interface TipSpec {
  x: number;
  y: number;
  head: string;
  body: string;
  click: string;
  color?: string;
}

/** How long a card this page appended itself outlives a `/thread` replace. */
export const LOCAL_CARD_TTL_MS = 30_000;

export interface ToastSpec {
  glyph: string;
  title: string;
  sub: string;
  big: string;
  color?: string;
}

/** Where a control's own action stands: in flight, or finished with a result. Keyed
 *  in `State.actions` by the action id and the thing it was about, so the control that
 *  was clicked, and only that control, renders its pending state and its result. */
export interface ActionState {
  pending: boolean;
  startedAt: number;
  result: ActionOutcome | null;
}

/** What a control shows after its action answered: the server's own message or the
 *  verbatim error, a journal id when the server minted one, a link to the effect, or
 *  a server-side confirm still waiting on the operator. */
export type ActionOutcome =
  | { kind: 'done'; ok: boolean; text: string; jid: string | null; at: number; link: ActionLink | null }
  | { kind: 'confirm'; token: string; blast: string; at: number };

export type ActionLink =
  | { kind: 'lane'; id: string; label: string }
  | { kind: 'view'; view: View; label: string }
  | { kind: 'url'; href: string; label: string }
  | { kind: 'journal'; jid: string; label: string };

export interface State {
  lanes: Lane[];
  /** Per-control action state, see `ActionState`. */
  actions: Record<string, ActionState>;
  /** Cards this page appended itself (receipts, refusals, operator bubbles) that the
   *  server's own `/thread` never echoes back. A `thread` replace re-attaches any
   *  younger than `LOCAL_CARD_TTL_MS`, so a receipt survives the refetch that lands
   *  right behind the action that produced it. */
  localCards: Message[];
  feed: Feed;
  thread: Message[];
  /** R-75 item 1: the status cards that left the rail -- blockers, confirms, plans,
   *  decisions, PRs and open questions -- off `GET /thread`'s second field. The
   *  Needs-you strip reads them; the rail never does. */
  cards: Message[];
  journal: JournalEntry[];
  integrations: Integration[];
  accounts: AccountItem[];
  caps: Caps | null;
  proposals: ProposalsResponse | null;
  machine: MachineResponse | null;
  queue: QueueItem[];
  blockers: BlockersResponse | null;
  queuePaused: boolean;
  queuePauseReason: string | null;
  queueMaxInFlight: number;
  /** D2.4: `/state`'s own `queue_on` flag. Starts `true` so the "Queue is off" banner
   *  never flashes before the console's first `/state` fetch lands. */
  queueOn: boolean;
  /** Queue-paused visibility fix: `/state`'s own `queue_paused` flag, independent of the
   *  `/queue` slice's `queuePaused` (which the Queue view still uses). The header reads
   *  this one so a failed `/queue` poll in a shared refresh cycle never leaves it stuck
   *  on a stale value while `/state` keeps answering. Absent on `/state` (the stub
   *  server) reads as `false`, same as `queueOn`'s own default. */
  queuePausedOnState: boolean;
  /** R-71: the whole `GET /sync` response -- every scope's last run plus the watcher.
   *  `null` until the first fetch lands. */
  sync: SyncStateResponse | null;
  /** How long the rail waits for the Conductor before its working row says it did not
   *  answer; `/state`'s own `conductor.timeoutMs`. */
  conductorTimeoutMs: number;
  /** H2.2: probe lanes hide behind this toggle on every filter but Archived. */
  showProbes: boolean;
  /** H2.2: the Archived filter's own fetch (`GET /lanes?archived=1`) -- retired
   *  lanes never live in `lanes`, so the filter needs its own slot to render from. */
  archivedLanes: Lane[];
  loaded: boolean;
  now: number;
  /** 2026-09-08: what `Linkify` needs to turn a Jira key or a PR mention into a link --
   *  off the same `GET /lanes` response the board fetches. */
  links: { jiraSite: string | null; defaultRepo: string | null };
  /** Duration of the last `/lanes` fetch, for the feed stamp's latency fallback. */
  fetchLatencyMs: number | null;

  view: View;
  filter: Filter;
  sort: Sort;
  sheet: SheetSpec | null;
  paletteOpen: boolean;
  paletteQuery: string;
  tip: TipSpec | null;
  toast: ToastSpec | null;
  /** The design's two themes. Light by default; dark when the operator flipped it or
   *  the OS asks for it and nothing was flipped. */
  theme: 'light' | 'dark';
  composer: string;
  /** The rail's topic: the lane a typed message is about, and whether it goes to the
   *  Conductor or to the agent working that lane. */
  topic: string | null;
  recipient: 'conductor' | 'agent';
  /** `/state`'s own project: the key and Jira name the chrome shows. */
  project: { key: string; name: string | null } | null;
  laneComposer: Record<string, string>;
  /** 2026-09-08: plain by default -- every route answers human sentences, machine
   *  ids stripped. Verbose asks every read for `?verbose=1` instead: raw rows, ids
   *  intact. Remembered in `localStorage` the same way `theme` is. */
  verbose: boolean;
  /** 2026-09-08: one entry per action in flight, keyed by whatever `useAction` (or
   *  a hand-rolled equivalent, e.g. the reaudit poll) was given as its own key --
   *  the single source every busy button and the top bar's "Working: ..." line
   *  read from. A run/lane action's key is conventionally `${cmd}:${id}`. */
  pending: Record<string, { label: string; since: number }>;
}

export type Action =
  | { type: 'lanes'; lanes: Lane[]; tokensToday?: number; links?: State['links'] }
  | { type: 'thread'; thread: Message[]; cards?: Message[] }
  | { type: 'thread-append'; messages: Message[]; local?: boolean }
  /** Drops a card the page put up itself, from the thread and from the local list
   *  both. Filtering the thread alone puts it straight back: the `thread` case
   *  re-attaches every local card the server's copy does not carry, which is the
   *  whole point of that list and the reason a working row would not come down. */
  | { type: 'local-card-drop'; k: string }
  /** Rewrites one local card in place, keeping its key so nothing re-attaches a
   *  stale copy of it on the next refetch. */
  | { type: 'local-card-text'; k: string; text: string }
  /** Marks a card the page put up itself (a confirm off a board click) as answered, in
   *  the thread and in the local list both, so the next refetch keeps it answered. */
  | { type: 'local-card-resolve'; k: string; resolved: 'confirmed' | 'declined' }
  | { type: 'action-pending'; key: string }
  | { type: 'action-result'; key: string; result: ActionOutcome }
  | { type: 'action-clear'; key: string }
  | { type: 'journal'; journal: JournalEntry[] }
  | { type: 'integrations'; integrations: Integration[] }
  | { type: 'accounts'; accounts: AccountItem[] }
  | { type: 'caps'; caps: Caps }
  | { type: 'proposals'; proposals: ProposalsResponse }
  | { type: 'machine'; machine: MachineResponse }
  | { type: 'queue'; items: QueueItem[]; paused: boolean; maxInFlight: number; pauseReason?: string | null }
  | { type: 'blockers'; blockers: BlockersResponse }
  | { type: 'queue-on'; on: boolean }
  | { type: 'queue-paused-on-state'; paused: boolean }
  | { type: 'sync'; sync: SyncStateResponse }
  | { type: 'conductor-timeout'; timeoutMs: number }
  | { type: 'toggle-probes' }
  | { type: 'archived-lanes'; lanes: Lane[] }
  | { type: 'loaded' }
  | { type: 'tick'; now: number }
  | { type: 'fetch-latency'; ms: number }
  | { type: 'feed-live' }
  | { type: 'feed-lost'; reason: string }
  | { type: 'heartbeat'; at: number }
  | { type: 'view'; view: View }
  | { type: 'filter'; filter: Filter }
  | { type: 'sort'; sort: Sort }
  | { type: 'sheet'; sheet: SheetSpec | null }
  | { type: 'palette-open'; open: boolean }
  | { type: 'palette-query'; query: string }
  | { type: 'tip'; tip: TipSpec | null }
  | { type: 'toast'; toast: ToastSpec | null }
  | { type: 'theme'; theme: 'light' | 'dark' }
  | { type: 'topic'; topic: string | null; recipient?: 'conductor' | 'agent' }
  | { type: 'recipient'; recipient: 'conductor' | 'agent' }
  | { type: 'project'; project: { key: string; name: string | null } | null }
  | { type: 'composer'; text: string }
  | { type: 'lane-composer'; run: string; text: string }
  | { type: 'verbose'; verbose: boolean }
  | { type: 'pending-set'; key: string; label: string }
  | { type: 'pending-clear'; key: string };

function readStoredTheme(): 'light' | 'dark' {
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('fd.theme');
      if (stored === 'light' || stored === 'dark') return stored;
    }
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    // No storage or no media query support: light, the design's default.
  }
  return 'light';
}

function readStoredVerbose(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('flightdeck.verbose') === '1';
  } catch {
    return false;
  }
}

export function initialState(): State {
  return {
    lanes: [],
    feed: { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: null },
    thread: [],
    cards: [],
    journal: [],
    integrations: [],
    accounts: [],
    caps: null,
    proposals: null,
    machine: null,
    queue: [],
    blockers: null,
    queuePaused: false,
    queuePauseReason: null,
    queueMaxInFlight: 2,
    queueOn: true,
    queuePausedOnState: false,
    sync: null,
    conductorTimeoutMs: 120_000,
    showProbes: false,
    archivedLanes: [],
    actions: {},
    localCards: [],
    loaded: false,
    now: Date.now(),
    links: { jiraSite: null, defaultRepo: null },
    fetchLatencyMs: null,
    view: 'board',
    filter: 'all',
    sort: 'cost',
    sheet: null,
    paletteOpen: false,
    paletteQuery: '',
    tip: null,
    toast: null,
    theme: readStoredTheme(),
    composer: '',
    topic: null,
    recipient: 'conductor',
    project: null,
    laneComposer: {},
    verbose: readStoredVerbose(),
    pending: {},
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'lanes':
      return { ...state, lanes: action.lanes, loaded: true, links: action.links ?? state.links };
    case 'thread': {
      const cutoff = Date.now() - LOCAL_CARD_TTL_MS;
      const localCards = state.localCards.filter((card) => card.ts >= cutoff);
      let thread = action.thread;
      // R-75: a local card that is not a rail kind belongs to `cards`. Re-merging every
      // local card into `thread` alone dropped a confirm gate the page had just put up:
      // the poll replaced `cards`, and the rail filtered the re-merged copy straight out.
      let cards = action.cards ?? state.cards;
      for (const card of localCards.filter((m) => !RAIL_TYPES.has(m.type))) {
        if (!cards.some((m) => m.k === card.k)) cards = [...cards, card];
      }
      for (const card of localCards.filter((m) => RAIL_TYPES.has(m.type))) {
        if (thread.some((m) => m.k === card.k)) continue;
        // The server persists the operator's own card too (`ConsoleWrites.command`),
        // under its own key: once that copy arrives, the local bubble for the same
        // words sent moments before is the same message and must not show twice.
        if (card.type === 'operator' && thread.some((m) => m.type === 'operator' && m.text === card.text && Math.abs(m.ts - card.ts) < LOCAL_CARD_TTL_MS)) continue;
        thread = [...thread, card];
      }
      return { ...state, thread, cards, localCards };
    }
    case 'local-card-drop':
      return {
        ...state,
        thread: state.thread.filter((m) => m.k !== action.k),
        cards: state.cards.filter((m) => m.k !== action.k),
        localCards: state.localCards.filter((m) => m.k !== action.k),
      };
    case 'local-card-text':
      return {
        ...state,
        thread: state.thread.map((m) => (m.k === action.k ? { ...m, text: action.text } : m)),
        cards: state.cards.map((m) => (m.k === action.k ? { ...m, text: action.text } : m)),
        localCards: state.localCards.map((m) => (m.k === action.k ? { ...m, text: action.text } : m)),
      };
    case 'local-card-resolve':
      return {
        ...state,
        thread: state.thread.map((m) => (m.k === action.k ? { ...m, resolved: action.resolved } : m)),
        cards: state.cards.map((m) => (m.k === action.k ? { ...m, resolved: action.resolved } : m)),
        localCards: state.localCards.map((m) => (m.k === action.k ? { ...m, resolved: action.resolved } : m)),
      };
    case 'thread-append': {
      // R-75 item 1: a card that arrives by any path -- the command route's reply, a
      // card the page put up itself -- is split the same way the thread response is.
      // A refusal or a confirm appended here used to land straight in the rail.
      const toRail = action.messages.filter((m) => RAIL_TYPES.has(m.type));
      const toCards = action.messages.filter((m) => !RAIL_TYPES.has(m.type));
      return {
        ...state,
        thread: [...state.thread, ...toRail],
        cards: [...state.cards, ...toCards],
        localCards: action.local ? [...state.localCards, ...action.messages] : state.localCards,
      };
    }
    case 'action-pending':
      return { ...state, actions: { ...state.actions, [action.key]: { pending: true, startedAt: Date.now(), result: null } } };
    case 'action-result':
      return {
        ...state,
        actions: { ...state.actions, [action.key]: { pending: false, startedAt: state.actions[action.key]?.startedAt ?? Date.now(), result: action.result } },
      };
    case 'action-clear': {
      const { [action.key]: _dropped, ...rest } = state.actions;
      return { ...state, actions: rest };
    }
    case 'journal':
      return { ...state, journal: action.journal };
    case 'integrations':
      return { ...state, integrations: action.integrations };
    case 'accounts':
      return { ...state, accounts: action.accounts };
    case 'caps':
      return { ...state, caps: action.caps };
    case 'machine':
      return { ...state, machine: action.machine };
    case 'proposals':
      return { ...state, proposals: action.proposals };
    case 'queue':
      return {
        ...state, queue: action.items, queuePaused: action.paused, queueMaxInFlight: action.maxInFlight,
        queuePauseReason: action.pauseReason ?? null,
      };
    case 'blockers':
      return { ...state, blockers: action.blockers };
    case 'conductor-timeout':
      return { ...state, conductorTimeoutMs: action.timeoutMs };
    case 'queue-on':
      return { ...state, queueOn: action.on };
    case 'queue-paused-on-state':
      return { ...state, queuePausedOnState: action.paused };
    case 'sync':
      return { ...state, sync: action.sync };
    case 'toggle-probes':
      return { ...state, showProbes: !state.showProbes };
    case 'archived-lanes':
      return { ...state, archivedLanes: action.lanes };
    case 'loaded':
      return { ...state, loaded: true };
    case 'tick':
      // Sweep #10: "retry in Ns" never ticked down -- `feed-lost` set retryInS once
      // and nothing ever touched it again. The 5s poll in App.tsx already retries on
      // its own cadence regardless of feed state, so this wraps back to 5 the moment
      // it would hit 0 rather than freezing there, tracking that real retry rhythm.
      return {
        ...state, now: action.now,
        feed: (!state.feed.live && state.feed.retryInS !== null)
          ? { ...state.feed, retryInS: state.feed.retryInS <= 1 ? 5 : state.feed.retryInS - 1 }
          : state.feed,
      };
    case 'fetch-latency':
      return { ...state, fetchLatencyMs: action.ms };
    case 'feed-live':
      return { ...state, feed: { live: true, lostAt: null, reason: null, retryInS: null, lastHeartbeatAt: state.feed.lastHeartbeatAt } };
    case 'feed-lost':
      return state.feed.live
        ? { ...state, feed: { live: false, lostAt: Date.now(), reason: action.reason, retryInS: 5, lastHeartbeatAt: state.feed.lastHeartbeatAt } }
        : state;
    case 'heartbeat':
      return { ...state, feed: { ...state.feed, lastHeartbeatAt: action.at } };
    case 'view':
      return { ...state, view: action.view };
    case 'filter':
      return { ...state, filter: action.filter };
    case 'sort':
      return { ...state, sort: action.sort };
    case 'sheet':
      return { ...state, sheet: action.sheet };
    case 'palette-open':
      return { ...state, paletteOpen: action.open, paletteQuery: action.open ? state.paletteQuery : '' };
    case 'palette-query':
      return { ...state, paletteQuery: action.query };
    case 'tip':
      return { ...state, tip: action.tip };
    case 'toast':
      return { ...state, toast: action.toast };
    case 'theme':
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('fd.theme', action.theme);
      } catch {
        // Not remembered without storage; the flip still applies to this page.
      }
      return { ...state, theme: action.theme };
    case 'topic':
      return { ...state, topic: action.topic, recipient: action.topic === null ? 'conductor' : (action.recipient ?? state.recipient) };
    case 'recipient':
      return { ...state, recipient: action.recipient };
    case 'project':
      return { ...state, project: action.project };
    case 'composer':
      return { ...state, composer: action.text };
    case 'lane-composer':
      return { ...state, laneComposer: { ...state.laneComposer, [action.run]: action.text } };
    case 'verbose':
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('flightdeck.verbose', action.verbose ? '1' : '0');
      } catch {
        // localStorage unavailable (private mode, disabled site data): the toggle
        // still works for this session, it just won't be remembered.
      }
      return { ...state, verbose: action.verbose };
    case 'pending-set':
      return { ...state, pending: { ...state.pending, [action.key]: { label: action.label, since: Date.now() } } };
    case 'pending-clear': {
      if (!(action.key in state.pending)) return state;
      const rest = { ...state.pending };
      delete rest[action.key];
      return { ...state, pending: rest };
    }
    default:
      return state;
  }
}

export const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);

export function useStore(): { state: State; dispatch: Dispatch<Action> } {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreContext.Provider>');
  return ctx;
}

export function useStoreValue(): [State, Dispatch<Action>] {
  const { state, dispatch } = useStore();
  return [state, dispatch];
}

export { useReducer };
