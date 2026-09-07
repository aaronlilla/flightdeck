/**
 * The one store: a `useReducer` + context pair holding exactly the contract
 * types plus the UI state the board needs (view, filter, sort, the open
 * sheet, the palette, a hover tip, a toast, the theme, composer drafts).
 */
import { createContext, useContext, useReducer } from 'react';
import type { Dispatch } from 'react';
import type {
  Caps,
  Feed,
  Integration,
  JournalEntry,
  Lane,
  Message,
  ProposalsResponse,
  QueueItem,
} from '../shared/console-model.js';

export type View = 'board' | 'settings' | 'review' | 'queue';
export type Filter = 'all' | 'needs-me' | 'running' | 'finished' | string;
export type Sort = 'cost' | 'age' | 'state';

export type SheetSpec =
  | { type: 'ticket'; id: string }
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
  queuePaused: boolean;
  queuePauseReason: string | null;
  queueMaxInFlight: number;
  loaded: boolean;
  now: number;
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
}

export type Action =
  | { type: 'lanes'; lanes: Lane[]; tokensToday?: number }
  | { type: 'thread'; thread: Message[] }
  | { type: 'thread-append'; messages: Message[] }
  | { type: 'journal'; journal: JournalEntry[] }
  | { type: 'integrations'; integrations: Integration[] }
  | { type: 'caps'; caps: Caps }
  | { type: 'proposals'; proposals: ProposalsResponse }
  | { type: 'queue'; items: QueueItem[]; paused: boolean; maxInFlight: number; pauseReason?: string | null }
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
  | { type: 'lane-composer'; run: string; text: string };

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
    queuePaused: false,
    queuePauseReason: null,
    queueMaxInFlight: 2,
    loaded: false,
    now: Date.now(),
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
  };
}

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'lanes':
      return { ...state, lanes: action.lanes, loaded: true };
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
    case 'loaded':
      return { ...state, loaded: true };
    case 'tick':
      return { ...state, now: action.now };
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
