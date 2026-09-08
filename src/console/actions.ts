/**
 * The one contract every control in the console runs through. A catalog entry per
 * mutating call in `api.ts` says what the action is called, whether it can be undone,
 * what it changes and where the result should point; `useAction` runs it and keeps
 * four promises for whoever clicked:
 *
 * 1. the control reads pending within one render and stays disabled until the answer;
 * 2. the answer renders where the click happened, as the server's own message or the
 *    verbatim error, never a swallowed failure;
 * 3. the same answer lands in the rail as a receipt;
 * 4. an entry with `reversible: false` shows the server's confirm card first and runs
 *    nothing until the server-issued token goes back.
 *
 * Coverage is computed, not remembered: `tests/console/actions-catalog.test.ts` lists
 * every non-GET export of `api.ts` and fails on one missing from `ACTIONS`.
 */
import { createContext, useCallback, useContext, useRef } from 'react';

import * as api from './api.js';
import type { ActionLink, ActionOutcome, View } from './store.js';
import { useStore } from './store.js';
import type { SliceName } from '../shared/console-events.js';
import type { ActionResult, Message } from '../shared/console-model.js';

export type Effect = 'lane' | 'queue' | 'integration' | 'account' | 'caps' | 'conductor' | 'proposal' | 'blocker' | 'journal' | 'none';

/** Which slices an effect makes stale, for the refetch that follows a result. The
 *  server publishes the same slices over `/events`; this is the page's own copy so a
 *  result shows without waiting on the socket. */
export const EFFECT_SLICES: Record<Effect, SliceName[]> = {
  lane: ['lanes', 'journal'],
  queue: ['queue', 'lanes'],
  integration: ['integrations', 'lanes', 'journal'],
  account: ['accounts'],
  caps: ['caps', 'journal'],
  conductor: ['conductor', 'lanes', 'journal'],
  proposal: ['proposals', 'journal'],
  blocker: ['blockers', 'lanes'],
  journal: ['journal', 'lanes', 'caps', 'proposals'],
  none: [],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ActionSpec<A extends any[] = any[], R = unknown> {
  /** The `api.ts` export this entry covers. The catalog test keys on it. */
  id: string;
  label: string;
  /** A literal, never computed: the catalog test refuses anything else. */
  reversible: boolean;
  effect: Effect;
  /** The call itself. `confirm` is the server-issued token on the second pass. */
  call: (args: A, confirm?: string) => Promise<R>;
  /** The sentence the control shows and the rail records on success. */
  text: (result: R, args: A) => string;
  ok?: (result: R) => boolean;
  jid?: (result: R) => string | null;
  /** Where the effect can be seen. Absent means the default for the effect. */
  link?: (args: A, result: R | undefined) => ActionLink | null;
  /** Off for an action whose reply is already rail cards, so it is not echoed twice. */
  railReceipt?: boolean;
}

function fromActionResult(result: ActionResult): string {
  return result.message;
}

function okOf(result: { ok?: boolean }): boolean {
  return result.ok !== false;
}

function jidOf(result: { jid?: string | null }): string | null {
  return result.jid ?? null;
}

function laneLink(id: string): ActionLink {
  return { kind: 'lane', id, label: 'open lane' };
}

function viewLink(view: View, label: string): ActionLink {
  return { kind: 'view', view, label };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spec<A extends any[], R>(entry: ActionSpec<A, R>): ActionSpec<A, R> {
  return entry;
}

type Gated<T> = api.Gated<T>;

/** Text for a gated result once it is past the confirm. A pending never reaches
 *  `text`: `useAction` turns it into a confirm outcome first. */
function gatedText<T extends ActionResult>(result: Gated<T>): string {
  return api.isConfirmPending(result) ? 'awaiting confirm' : result.message;
}

function gatedOk<T extends { ok: boolean }>(result: Gated<T>): boolean {
  return api.isConfirmPending(result) ? false : result.ok;
}

function gatedJid<T extends { jid: string | null }>(result: Gated<T>): string | null {
  return api.isConfirmPending(result) ? null : result.jid;
}

export const ACTIONS = {
  recheckRun: spec<[string], Awaited<ReturnType<typeof api.recheckRun>>>({
    id: 'recheckRun', label: 'Re-check', reversible: true, effect: 'lane',
    call: ([id]) => api.recheckRun(id),
    text: (summary) => summary.next ? `re-checked: ${summary.next}` : 're-checked',
    link: ([id]) => laneLink(id),
  }),
  reauditRun: spec<[string], Awaited<ReturnType<typeof api.reauditRun>>>({
    id: 'reauditRun', label: 'Re-audit', reversible: true, effect: 'lane',
    call: ([id]) => api.reauditRun(id),
    text: (result) => (result.started ? 'audit started; the result lands as a new attestation' : (result.reason ?? 'audit did not start')),
    ok: (result) => result.started,
    link: ([id]) => laneLink(id),
  }),
  postRetireFinished: spec<[], Gated<api.RetireFinishedResult>>({
    id: 'postRetireFinished', label: 'Clean up', reversible: false, effect: 'lane',
    call: (_args, confirm) => api.postRetireFinished(confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('board', 'show archived'),
  }),
  postMergeReady: spec<[], Gated<api.MergeReadyResult>>({
    id: 'postMergeReady', label: 'Merge ready', reversible: false, effect: 'lane',
    call: (_args, confirm) => api.postMergeReady(confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('board', 'board'),
  }),
  resolveBlocker: spec<[string], Awaited<ReturnType<typeof api.resolveBlocker>>>({
    id: 'resolveBlocker', label: 'Resolved', reversible: true, effect: 'blocker',
    call: ([id]) => api.resolveBlocker(id),
    text: (result) => (result.ok ? `resolved${result.started.length ? `, restarted ${result.started.join(', ')}` : ''}` : `not yet: ${result.lastCheck ?? 'still blocked'}`),
    ok: (result) => result.ok,
    link: () => viewLink('blockers', 'blockers'),
  }),
  checkBlocker: spec<[string], Awaited<ReturnType<typeof api.checkBlocker>>>({
    id: 'checkBlocker', label: 'Check', reversible: true, effect: 'blocker',
    call: ([id]) => api.checkBlocker(id),
    text: (result) => (result.ok ? `clear${result.started.length ? `, restarted ${result.started.join(', ')}` : ''}` : `not yet: ${result.lastCheck ?? 'still blocked'}`),
    ok: (result) => result.ok,
    link: () => viewLink('blockers', 'blockers'),
  }),
  killRun: spec<[string, string], Gated<ActionResult>>({
    id: 'killRun', label: 'Kill', reversible: false, effect: 'lane',
    call: ([id, reason], confirm) => api.killRun(id, reason, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: ([id]) => laneLink(id),
  }),
  stopAll: spec<[], Gated<ActionResult & { stopped: string[] }>>({
    id: 'stopAll', label: 'Stop all', reversible: false, effect: 'lane',
    call: (_args, confirm) => api.stopAll(confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('board', 'board'),
  }),
  retireRun: spec<[string], Gated<ActionResult>>({
    id: 'retireRun', label: 'Retire', reversible: false, effect: 'lane',
    call: ([id], confirm) => api.retireRun(id, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('board', 'show archived'),
  }),
  pauseRun: spec<[string], ActionResult>({
    id: 'pauseRun', label: 'Pause', reversible: true, effect: 'lane',
    call: ([id]) => api.pauseRun(id), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  resumeRun: spec<[string], ActionResult>({
    id: 'resumeRun', label: 'Resume', reversible: true, effect: 'lane',
    call: ([id]) => api.resumeRun(id), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  mergeRun: spec<[string], Gated<ActionResult>>({
    id: 'mergeRun', label: 'Merge', reversible: false, effect: 'lane',
    call: ([id], confirm) => api.mergeRun(id, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: ([id]) => laneLink(id),
  }),
  reopenRun: spec<[string], ActionResult>({
    id: 'reopenRun', label: 'Reopen', reversible: true, effect: 'lane',
    call: ([id]) => api.reopenRun(id), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  unretireRun: spec<[string], ActionResult>({
    id: 'unretireRun', label: 'Unretire', reversible: true, effect: 'lane',
    call: ([id]) => api.unretireRun(id), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  compactRun: spec<[string], ActionResult>({
    id: 'compactRun', label: 'Compact', reversible: true, effect: 'lane',
    call: ([id]) => api.compactRun(id), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  verifyRun: spec<[string], ActionResult>({
    id: 'verifyRun', label: 'Verify', reversible: true, effect: 'lane',
    call: ([id]) => api.verifyRun(id), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  setRunCap: spec<[string, number], ActionResult>({
    id: 'setRunCap', label: 'Set cap', reversible: true, effect: 'caps',
    call: ([id, cap]) => api.setRunCap(id, cap), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  sendToRun: spec<[string, string], ActionResult>({
    id: 'sendToRun', label: 'Send', reversible: true, effect: 'lane',
    call: ([id, text]) => api.sendToRun(id, text), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  amendRun: spec<[string, string], ActionResult>({
    id: 'amendRun', label: 'Amend', reversible: true, effect: 'lane',
    call: ([id, text]) => api.amendRun(id, text), text: fromActionResult, ok: okOf, jid: jidOf, link: ([id]) => laneLink(id),
  }),
  setCaps: spec<[{ dailyTokens?: number; runTokens?: number }], Gated<Awaited<ReturnType<typeof api.getCaps>>>>({
    id: 'setCaps', label: 'Save caps', reversible: false, effect: 'caps',
    call: ([body], confirm) => api.setCaps(body, confirm),
    text: (caps) => (api.isConfirmPending(caps) ? 'awaiting confirm' : 'caps saved'),
    ok: (caps) => !api.isConfirmPending(caps),
    link: () => viewLink('settings', 'caps'),
  }),
  sendCommand: spec<[string], Awaited<ReturnType<typeof api.sendCommand>>>({
    id: 'sendCommand', label: 'Send', reversible: true, effect: 'conductor',
    call: ([text]) => api.sendCommand(text),
    text: (response) => response.cards[0]?.text ?? 'no reply',
    ok: (response) => !response.cards.some((card) => card.type === 'refusal'),
    railReceipt: false,
    link: () => null,
  }),
  checkIntegration: spec<[string], Awaited<ReturnType<typeof api.checkIntegration>>>({
    id: 'checkIntegration', label: 'Check', reversible: true, effect: 'integration',
    call: ([id]) => api.checkIntegration(id),
    text: (response, [id]) => {
      const row = response.items.find((item) => item.id === id);
      if (!row) return `${id} is not a known integration`;
      return `${row.name} is ${row.status}${row.latencyMs !== null ? ` (${row.latencyMs} ms)` : ''}`;
    },
    ok: (response) => response.items.length > 0,
    link: () => viewLink('settings', 'integrations'),
  }),
  reconnectIntegration: spec<[string], Awaited<ReturnType<typeof api.reconnectIntegration>>>({
    id: 'reconnectIntegration', label: 'Reconnect', reversible: true, effect: 'integration',
    call: ([id]) => api.reconnectIntegration(id),
    text: (response) => response.message,
    ok: (response) => response.ok,
    jid: (response) => response.jid,
    link: () => viewLink('settings', 'integrations'),
  }),
  applyProposal: spec<[string], ActionResult>({
    id: 'applyProposal', label: 'Apply rule', reversible: true, effect: 'proposal',
    call: ([id]) => api.applyProposal(id), text: fromActionResult, ok: okOf, jid: jidOf, link: () => viewLink('review', 'review'),
  }),
  dismissProposal: spec<[string], ActionResult>({
    id: 'dismissProposal', label: 'Dismiss', reversible: true, effect: 'proposal',
    call: ([id]) => api.dismissProposal(id), text: fromActionResult, ok: okOf, jid: jidOf, link: () => viewLink('review', 'review'),
  }),
  restoreProposal: spec<[string], ActionResult>({
    id: 'restoreProposal', label: 'Restore', reversible: true, effect: 'proposal',
    call: ([id]) => api.restoreProposal(id), text: fromActionResult, ok: okOf, jid: jidOf, link: () => viewLink('review', 'review'),
  }),
  undoJournal: spec<[string], ActionResult>({
    id: 'undoJournal', label: 'Undo', reversible: true, effect: 'journal',
    call: ([jid]) => api.undoJournal(jid), text: fromActionResult, ok: okOf, jid: jidOf,
    link: ([jid]) => ({ kind: 'journal', jid, label: 'journal' }),
  }),
  dismissAsk: spec<[string], Gated<ActionResult>>({
    id: 'dismissAsk', label: 'Dismiss', reversible: false, effect: 'lane',
    call: ([key], confirm) => api.dismissAsk(key, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('board', 'board'),
  }),
  addToQueue: spec<[Parameters<typeof api.addToQueue>[0]], Awaited<ReturnType<typeof api.addToQueue>>>({
    id: 'addToQueue', label: 'Add', reversible: true, effect: 'queue',
    call: ([body]) => api.addToQueue(body),
    text: (result) => (result.ok
      ? `added ${result.items.length} item${result.items.length === 1 ? '' : 's'} to the queue`
      : (result.error ?? 'the add did not go through')),
    ok: (result) => result.ok,
    link: () => viewLink('queue', 'queue'),
  }),
  removeQueueItem: spec<[string], Gated<ActionResult>>({
    id: 'removeQueueItem', label: 'Remove', reversible: false, effect: 'queue',
    call: ([id], confirm) => api.removeQueueItem(id, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('queue', 'queue'),
  }),
  retryQueueItem: spec<[string], ActionResult>({
    id: 'retryQueueItem', label: 'Retry', reversible: true, effect: 'queue',
    call: ([id]) => api.retryQueueItem(id), text: fromActionResult, ok: okOf, jid: jidOf, link: () => viewLink('queue', 'queue'),
  }),
  pauseQueue: spec<[], ActionResult>({
    id: 'pauseQueue', label: 'Pause queue', reversible: true, effect: 'queue',
    call: () => api.pauseQueue(), text: fromActionResult, ok: okOf, jid: jidOf, link: () => viewLink('queue', 'queue'),
  }),
  resumeQueue: spec<[], ActionResult>({
    id: 'resumeQueue', label: 'Resume queue', reversible: true, effect: 'queue',
    call: () => api.resumeQueue(), text: fromActionResult, ok: okOf, jid: jidOf, link: () => viewLink('queue', 'queue'),
  }),
  mergeQueueItem: spec<[string], Gated<ActionResult>>({
    id: 'mergeQueueItem', label: 'Merge', reversible: false, effect: 'queue',
    call: ([id], confirm) => api.mergeQueueItem(id, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('queue', 'queue'),
  }),
  promoteQueueItem: spec<[string, string, string], Gated<ActionResult>>({
    id: 'promoteQueueItem', label: 'Promote', reversible: false, effect: 'queue',
    call: ([id, version, message], confirm) => api.promoteQueueItem(id, version, message, confirm),
    text: gatedText, ok: gatedOk, jid: gatedJid,
    link: () => viewLink('queue', 'queue'),
  }),
} as const;

/** Every entry, erased to the shape the catalog test and generic callers read. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ACTION_LIST: ActionSpec<any, any>[] = Object.values(ACTIONS) as ActionSpec<any, any>[];

export type ActionId = keyof typeof ACTIONS;

/** The sentence an `ApiError` or any other rejection should show: the server's own
 *  words, already redacted by `api.ts`, never a generic "something went wrong". */
export function errorText(error: unknown): string {
  if (error instanceof api.ApiError) return error.message || `the server answered ${error.status}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function actionKey(id: string, ref?: string): string {
  return ref ? `${id}:${ref}` : id;
}

/**
 * What the page around a control provides: how to refetch the slices an effect made
 * stale, how to follow a link to the effect, and how to release a server-side confirm
 * the operator declined. `App.tsx` supplies all three; a test supplies fakes.
 */
export interface ActionsHost {
  refreshSlices: (slices: SliceName[]) => void;
  follow: (link: ActionLink) => void;
  release: (token: string) => void;
}

export const ActionsContext = createContext<ActionsHost>({
  refreshSlices: () => undefined,
  follow: () => undefined,
  release: () => undefined,
});

function receiptCard(jid: string | null, ok: boolean, text: string): Message {
  return {
    k: `local-${Date.now()}-${Math.random()}`, type: ok ? 'receipt' : 'refusal', text, ts: Date.now(),
    source: 'console', jid: jid ?? undefined, undoable: false,
  };
}

export interface ActionHandle<A extends unknown[], R = unknown> {
  /** Runs the action. For an irreversible one, the first run produces a confirm.
   *  A successful 'done' also carries the server's raw response as `raw`, for a
   *  caller that needs more than text/ok/jid (the ticket sheet's summary panel
   *  takes its fresh `LaneSummary` straight off `recheckRun`'s response this way,
   *  instead of fetching it again). */
  run: (...args: A) => Promise<ActionOutcome & { raw?: R }>;
  /** Sends the server-issued token back, running what the confirm was about. */
  confirm: () => Promise<(ActionOutcome & { raw?: R }) | null>;
  /** Declines the confirm and releases the server-side pending entry. */
  dismiss: () => void;
  clear: () => void;
  pending: boolean;
  result: ActionOutcome | null;
}

/**
 * Binds one catalog entry to one control. `ref` tells two controls for the same action
 * apart (a Kill on each of two lanes), so each renders its own pending and result.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useAction<A extends any[], R>(entry: ActionSpec<A, R>, ref?: string): ActionHandle<A, R> {
  const { state, dispatch } = useStore();
  const host = useContext(ActionsContext);
  const key = actionKey(entry.id, ref);
  const current = state.actions[key];
  const lastArgs = useRef<A | null>(null);
  const token = current?.result?.kind === 'confirm' ? current.result.token : null;

  const settle = useCallback((outcome: ActionOutcome, receipt: boolean) => {
    dispatch({ type: 'action-result', key, result: outcome });
    if (outcome.kind === 'done' && receipt && entry.railReceipt !== false) {
      dispatch({ type: 'thread-append', messages: [receiptCard(outcome.jid, outcome.ok, outcome.text)], local: true });
    }
    if (outcome.kind === 'done') host.refreshSlices(EFFECT_SLICES[entry.effect]);
    return outcome;
  }, [dispatch, key, entry, host]);

  const call = useCallback(async (args: A, confirm?: string): Promise<ActionOutcome & { raw?: R }> => {
    dispatch({ type: 'action-pending', key });
    try {
      const result = await entry.call(args, confirm);
      if (entry.reversible === false && api.isConfirmPending(result)) {
        return settle({ kind: 'confirm', token: result.token, blast: result.blast, at: Date.now() }, false);
      }
      const ok = entry.ok ? entry.ok(result) : true;
      const link = entry.link ? entry.link(args, result) : null;
      const outcome = { kind: 'done' as const, ok, text: entry.text(result, args), jid: entry.jid?.(result) ?? null, at: Date.now(), link, raw: result };
      settle(outcome, true);
      return outcome;
    } catch (caught) {
      const link = entry.link ? entry.link(args, undefined) : null;
      return settle({ kind: 'done', ok: false, text: errorText(caught), jid: null, at: Date.now(), link }, true);
    }
  }, [dispatch, key, entry, settle]);

  const run = useCallback(async (...args: A): Promise<ActionOutcome & { raw?: R }> => {
    if (state.actions[key]?.pending) return state.actions[key]!.result ?? { kind: 'done', ok: false, text: 'already running', jid: null, at: Date.now(), link: null };
    lastArgs.current = args;
    return call(args);
  }, [state.actions, key, call]);

  const confirm = useCallback(async (): Promise<(ActionOutcome & { raw?: R }) | null> => {
    if (!token || !lastArgs.current) return null;
    return call(lastArgs.current, token);
  }, [token, call]);

  const dismiss = useCallback(() => {
    if (token) host.release(token);
    dispatch({ type: 'action-result', key, result: { kind: 'done', ok: true, text: 'not now', jid: null, at: Date.now(), link: null } });
  }, [token, host, dispatch, key]);

  const clear = useCallback(() => dispatch({ type: 'action-clear', key }), [dispatch, key]);

  return { run, confirm, dismiss, clear, pending: current?.pending ?? false, result: current?.result ?? null };
}
