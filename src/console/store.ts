/**
 * The one store: a `useReducer` + context pair holding exactly the contract
 * types plus the UI state the board needs (view, filter, sort, the open
 * sheet, the palette, a hover tip, a toast, the theme, composer drafts).
 */
import { createContext, useContext, useReducer } from 'react';
import type { Dispatch } from 'react';
import type {
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

export type View = 'board' | 'settings' | 'review' | 'queue' | 'blockers';
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

export interface ToastSpec {
  glyph: string;
  title: string;
  sub: string;
  big: string;
  color?: string;
}

export interface State {
  lanes: Lane[];
  feed: Feed;
  thread: Message[];
  journal: JournalEntry[];
  integrations: Integration[];
  caps: Caps | null;
  proposals: ProposalsResponse | null;
  queue: QueueItem[];
  blockers: BlockersResponse | null;
  queuePaused: boolean;
  queuePauseReason: string | null;
  queueMaxInFlight: number;
  /** D2.4: `/state`'s own `queue_on` flag. Starts `true` so the "Queue is off" banner
   *  never flashes before the console's first `/state` fetch lands. */
  queueOn: boolean;
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
  theme: 'thD' | 'thL';
  composer: string;
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
  | { type: 'thread'; thread: Message[] }
  | { type: 'thread-append'; messages: Message[] }
  | { type: 'journal'; journal: JournalEntry[] }
  | { type: 'integrations'; integrations: Integration[] }
  | { type: 'caps'; caps: Caps }
  | { type: 'proposals'; proposals: ProposalsResponse }
  | { type: 'queue'; items: QueueItem[]; paused: boolean; maxInFlight: number; pauseReason?: string | null }
  | { type: 'blockers'; blockers: BlockersResponse }
  | { type: 'queue-on'; on: boolean }
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
  | { type: 'theme'; theme: 'thD' | 'thL' }
  | { type: 'composer'; text: string }
  | { type: 'lane-composer'; run: string; text: string }
  | { type: 'verbose'; verbose: boolean }
  | { type: 'pending-set'; key: string; label: string }
  | { type: 'pending-clear'; key: string };

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
    journal: [],
    integrations: [],
    caps: null,
    proposals: null,
    queue: [],
    blockers: null,
    queuePaused: false,
    queuePauseReason: null,
    queueMaxInFlight: 2,
    queueOn: true,
    showProbes: false,
    archivedLanes: [],
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
    theme: (typeof localStorage !== 'undefined' && localStorage.getItem('fd.theme') === 'thL') ? 'thL' : 'thD',
    composer: '',
    laneComposer: {},
    verbose: readStoredVerbose(),
    pending: {},
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'lanes':
      return { ...state, lanes: action.lanes, loaded: true, links: action.links ?? state.links };
    case 'thread':
      return { ...state, thread: action.thread };
    case 'thread-append':
      return { ...state, thread: [...state.thread, ...action.messages] };
    case 'journal':
      return { ...state, journal: action.journal };
    case 'integrations':
      return { ...state, integrations: action.integrations };
    case 'caps':
      return { ...state, caps: action.caps };
    case 'proposals':
      return { ...state, proposals: action.proposals };
    case 'queue':
      return {
        ...state, queue: action.items, queuePaused: action.paused, queueMaxInFlight: action.maxInFlight,
        queuePauseReason: action.pauseReason ?? null,
      };
    case 'blockers':
      return { ...state, blockers: action.blockers };
    case 'queue-on':
      return { ...state, queueOn: action.on };
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
      if (typeof localStorage !== 'undefined') localStorage.setItem('fd.theme', action.theme);
      return { ...state, theme: action.theme };
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
