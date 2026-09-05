/**
 * The one place the console talks to the server. Every write goes through
 * `call()`, so the token header and the redaction of a failed body are both
 * one function rather than repeated at every call site (decision 3 in the
 * goal brief: "all of that lives behind one `api.ts`").
 */
import { redactErrorBody } from './redact.js';
import type { ForgeState, InboxEntry, InboxState, RouterResult, RunDetail } from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function token(): string {
  if (typeof document === 'undefined') return '';
  return document.querySelector('meta[name="forge-token"]')?.getAttribute('content') ?? '';
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'x-forge-token': token() };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...init, headers: { ...headers, ...init?.headers } });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ApiError(response.status, redactErrorBody(body));
  }
  return (await response.json()) as T;
}

export function getState(): Promise<ForgeState> {
  return call<ForgeState>('/state');
}

export function getInbox(): Promise<InboxState> {
  return call<InboxState>('/inbox');
}

export function answer(key: string, answerText: string): Promise<InboxEntry> {
  return call<InboxEntry>('/answer', {
    method: 'POST',
    body: JSON.stringify({ key, answer: answerText }),
  });
}

export interface StopResult {
  stopped: string[];
}

/** Parks every run and engages the kill switch. Safe to call on an idle fleet. */
export function stopAll(reason: string): Promise<StopResult> {
  return call<StopResult>('/stop', { method: 'POST', body: JSON.stringify({ reason }) });
}

export function sendToRun(run: string, text: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('/send', { method: 'POST', body: JSON.stringify({ run, text }) });
}

/** Clears one lane's breaker, or every lane's, when `target` is `'all'`. */
export function clearLane(target: string): Promise<{ ok: boolean }> {
  const body = target === 'all' ? { all: true } : { lane: target };
  return call<{ ok: boolean }>('/clear', { method: 'POST', body: JSON.stringify(body) });
}

/** F3: retires one stale inbox ask (the console's Clear button on a dead-run entry).
 *  The server checks staleness again before moving anything -- this call only asks. */
export function retireAsk(key: string): Promise<{ ok: boolean }> {
  return call<{ ok: boolean }>('/clear', { method: 'POST', body: JSON.stringify({ inboxKey: key }) });
}

/** X3: the ticket sheet's own read -- packet, provenance, and the not-yet-wired
 *  plan/PR/council/comment fields, all `null` rather than omitted. */
export function getRun(id: string): Promise<RunDetail> {
  return call<RunDetail>(`/run/${encodeURIComponent(id)}`);
}

/** X4: a message typed into the rail thread. Answers `{ routed: false }` when the
 *  server's policy has the router off; the rail renders that as "router off". */
export function sendToRouter(text: string): Promise<RouterResult> {
  return call<RouterResult>('/router', { method: 'POST', body: JSON.stringify({ text }) });
}
