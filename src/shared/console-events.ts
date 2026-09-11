/**
 * The live spine between the server and the console: a slice-named event on the
 * `/events` socket that says which part of the board just changed, so the client
 * refetches that slice alone instead of everything on every frame.
 *
 * Shared by `src/forge/server.ts` (which publishes one after every mutating route it
 * handles), `src/console/stub-server.ts` (so the console's own tests and the e2e suite
 * see the same frames) and `src/console/App.tsx` (which maps a slice to one fetch).
 * The route table below is the one place that says which slices a write touches; the
 * contract test in `tests/forge/server-events.test.ts` walks an independent sample of
 * every write and fails the moment a route is missing from it.
 */

export type SliceName =
  | 'lanes'
  | 'queue'
  | 'integrations'
  | 'accounts'
  | 'conductor'
  | 'journal'
  | 'blockers'
  | 'caps'
  | 'proposals'
  | 'machine'
  | 'sync';

/** A type alias rather than an interface on purpose: an object type written this way
 *  is assignable to the server's `Record<string, unknown>` publish parameter. */
export type SliceEvent = {
  type: 'slice';
  slice: SliceName;
  /** Why it changed, in words: the route that ran and how it answered. */
  reason: string;
  at: number;
  /** The lane, item or integration the change is about, when the route names one. */
  ref?: string;
};

export function sliceEvent(slice: SliceName, reason: string, ref?: string): SliceEvent {
  return { type: 'slice', slice, reason, at: Date.now(), ...(ref ? { ref } : {}) };
}

export function isSliceEvent(event: unknown): event is SliceEvent {
  const row = event as { type?: unknown; slice?: unknown };
  return Boolean(row) && row.type === 'slice' && typeof row.slice === 'string';
}

export interface MutatingRoute {
  /** A name for the row, printed by the contract test when a route goes missing. */
  name: string;
  pattern: RegExp;
  slices: SliceName[];
}

/**
 * Every write the console can make and the slices it changes. A `ref` is the first
 * capture group of the pattern, when it has one. Order matters only for the reason
 * text: the first matching row names the event.
 */
export const MUTATING_ROUTES: readonly MutatingRoute[] = [
  { name: 'answer', pattern: /^\/answer$/, slices: ['lanes', 'conductor'] },
  { name: 'stop-all', pattern: /^\/stop$/, slices: ['lanes', 'journal'] },
  { name: 'send', pattern: /^\/send$/, slices: ['lanes'] },
  { name: 'amend', pattern: /^\/amend$/, slices: ['lanes', 'journal'] },
  { name: 'clear', pattern: /^\/clear$/, slices: ['lanes', 'journal'] },
  { name: 'router', pattern: /^\/router$/, slices: ['conductor'] },
  { name: 'command', pattern: /^\/command$/, slices: ['conductor', 'lanes', 'journal'] },
  { name: 'run-recheck', pattern: /^\/run\/([^/]+)\/recheck$/, slices: ['lanes'] },
  { name: 'run-retire', pattern: /^\/run\/([^/]+)\/(?:retire|unretire)$/, slices: ['lanes', 'journal'] },
  { name: 'run-cap', pattern: /^\/run\/([^/]+)\/cap$/, slices: ['lanes', 'caps', 'journal'] },
  { name: 'run-action', pattern: /^\/run\/([^/]+)\/(?:kill|pause|resume|merge|reopen|compact|verify|reaudit)$/, slices: ['lanes', 'journal'] },
  { name: 'retire-finished', pattern: /^\/retire-finished$/, slices: ['lanes', 'journal'] },
  { name: 'merge-ready', pattern: /^\/merge-ready$/, slices: ['lanes', 'journal'] },
  { name: 'caps', pattern: /^\/caps$/, slices: ['caps', 'journal'] },
  { name: 'integration-check', pattern: /^\/integrations\/([^/]+)\/check$/, slices: ['integrations'] },
  { name: 'integration-reconnect', pattern: /^\/integrations\/([^/]+)\/reconnect$/, slices: ['integrations', 'lanes', 'journal'] },
  { name: 'proposal', pattern: /^\/proposals\/([^/]+)\/(?:apply|dismiss|restore)$/, slices: ['proposals', 'journal'] },
  { name: 'journal-undo', pattern: /^\/journal\/([^/]+)\/undo$/, slices: ['journal', 'lanes', 'caps', 'proposals'] },
  { name: 'queue-add', pattern: /^\/queue$/, slices: ['queue'] },
  { name: 'queue-pause', pattern: /^\/queue\/(?:pause|resume)$/, slices: ['queue'] },
  { name: 'queue-item', pattern: /^\/queue\/([^/]+)\/(?:remove|retry|merge|promote)$/, slices: ['queue', 'lanes'] },
  { name: 'blocker', pattern: /^\/blockers\/([^/]+)\/(?:resolve|check)$/, slices: ['blockers', 'lanes'] },
  { name: 'accounts-connect', pattern: /^\/accounts\/connect$/, slices: ['accounts'] },
  { name: 'accounts-disconnect', pattern: /^\/accounts\/([^/]+)\/disconnect$/, slices: ['accounts'] },
  { name: 'sync-start', pattern: /^\/sync\/([^/]+)$/, slices: ['sync'] },
  { name: 'watcher-toggle', pattern: /^\/watcher\/(?:on|off)$/, slices: ['sync'] },
];

/**
 * The slice events a handled write should publish, or `null` for a request that is
 * not a console write (a GET, a static file, a path no route claims). `status` is the
 * response's own status: a refusal still publishes, since the board the operator is
 * looking at is what led to the refusal and a refetch is how it catches up.
 */
export function sliceEventsFor(method: string | undefined, path: string, status: number): SliceEvent[] | null {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  for (const route of MUTATING_ROUTES) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    const ref = match[1] ? decodeURIComponent(match[1]) : undefined;
    const reason = `${route.name} answered ${status}`;
    return route.slices.map((slice) => sliceEvent(slice, reason, ref));
  }
  return null;
}
