/**
 * The one place the console talks to the server. Every write goes through
 * `call()`, so the token header and the redaction of a failed body are both
 * one function rather than repeated at every call site (decision 3 in the
 * goal brief: "all of that lives behind one `api.ts`").
 */
import { redactErrorBody } from './redact.js';
import type {
  ActionResult,
  Caps,
  CommandResponse,
  ConsoleStateSummary,
  IntegrationsResponse,
  JournalResponse,
  LanesResponse,
  ProposalsResponse,
  QueueAddRequest,
  QueueAddResponse,
  QueueResponse,
  ReconnectResponse,
  RunCostResponse,
  RunJournalResponse,
  RunPrResponse,
  RunSandboxResponse,
  RunThreadResponse,
  ThreadResponse,
} from '../shared/console-model.js';

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

/** D2.4: `/state`'s own `queue_on` flag -- the one field the web console needs out of
 *  the real server's much larger `/state`. Never carries the token: same rule the real
 *  server (and this stub) already apply to `/state`. */
export function getState(): Promise<ConsoleStateSummary> {
  return call<ConsoleStateSummary>('/state');
}

export function getLanes(params?: { all?: boolean; archived?: boolean }): Promise<LanesResponse> {
  if (params?.archived) return call<LanesResponse>('/lanes?archived=1');
  return call<LanesResponse>(params?.all ? '/lanes?all=1' : '/lanes');
}

export function getThread(): Promise<ThreadResponse> {
  return call<ThreadResponse>('/thread');
}

export function getJournal(params?: { since?: number; run?: string; limit?: number }): Promise<JournalResponse> {
  const query = new URLSearchParams();
  if (params?.since !== undefined) query.set('since', String(params.since));
  if (params?.run !== undefined) query.set('run', params.run);
  if (params?.limit !== undefined) query.set('limit', String(params.limit));
  const qs = query.toString();
  return call<JournalResponse>(`/journal${qs ? `?${qs}` : ''}`);
}

export function getIntegrations(): Promise<IntegrationsResponse> {
  return call<IntegrationsResponse>('/integrations');
}

export function getCaps(): Promise<Caps> {
  return call<Caps>('/caps');
}

export function getProposals(): Promise<ProposalsResponse> {
  return call<ProposalsResponse>('/proposals');
}

export function getRunThread(id: string): Promise<RunThreadResponse> {
  return call<RunThreadResponse>(`/run/${encodeURIComponent(id)}/thread`);
}

export function getRunPr(id: string): Promise<RunPrResponse> {
  return call<RunPrResponse>(`/run/${encodeURIComponent(id)}/pr`);
}

export function getRunSandbox(id: string): Promise<RunSandboxResponse> {
  return call<RunSandboxResponse>(`/run/${encodeURIComponent(id)}/sandbox`);
}

export function getRunCost(id: string): Promise<RunCostResponse> {
  return call<RunCostResponse>(`/run/${encodeURIComponent(id)}/cost`);
}

export function getRunJournal(id: string): Promise<RunJournalResponse> {
  return call<RunJournalResponse>(`/run/${encodeURIComponent(id)}/journal`);
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

export function killRun(id: string, reason: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/kill`, { reason });
}

export function pauseRun(id: string, reason?: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/pause`, reason ? { reason } : {});
}

export function resumeRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/resume`, {});
}

export function mergeRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/merge`, {});
}

export function reopenRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/reopen`, {});
}

export function unretireRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/unretire`, {});
}

export function compactRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/compact`, {});
}

export function verifyRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/verify`, {});
}

export function setRunCap(id: string, tokenCap: number): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/cap`, { tokenCap });
}

/**
 * The ticket sheet's own "message {lane.id}..." composer: `POST /send`, the server's
 * run-scoped delivery (`RunInbox.send`), never the board-wide `/command` classifier.
 * `/send` answers `{ ok: true }` only, so this shapes that into the same `ActionResult`
 * every other run action already returns, for `runAction`'s one receipt path.
 */
export function sendToRun(run: string, text: string): Promise<ActionResult> {
  return post<{ ok: boolean }>('/send', { run, text })
    .then((result) => ({ ok: result.ok, jid: null, message: `sent to ${run}`, undoable: false }));
}

/**
 * C.1's Amend action: `POST /amend`, which appends the text to the run's own brief (and
 * its Definition of Done) and delivers it through the run's inbox. Same `{ ok: true }`
 * shape as `/send`, folded into `ActionResult` the same way for `runAction`'s one
 * receipt path.
 */
export function amendRun(run: string, text: string): Promise<ActionResult> {
  return post<{ ok: boolean }>('/amend', { run, text })
    .then((result) => ({ ok: result.ok, jid: null, message: `amended ${run}`, undoable: false }));
}

export function setCaps(body: { dailyTokens?: number; runTokens?: number }): Promise<Caps> {
  return post<Caps>('/caps', body);
}

export function sendCommand(text: string): Promise<CommandResponse> {
  return post<CommandResponse>('/command', { text });
}

export function checkIntegration(id: string): Promise<IntegrationsResponse> {
  return post<IntegrationsResponse>(`/integrations/${encodeURIComponent(id)}/check`, {});
}

export function reconnectIntegration(id: string): Promise<ReconnectResponse> {
  return post<ReconnectResponse>(`/integrations/${encodeURIComponent(id)}/reconnect`, {});
}

export function applyProposal(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/proposals/${encodeURIComponent(id)}/apply`, {});
}

export function dismissProposal(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/proposals/${encodeURIComponent(id)}/dismiss`, {});
}

export function restoreProposal(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/proposals/${encodeURIComponent(id)}/restore`, {});
}

export function undoJournal(jid: string): Promise<ActionResult> {
  return post<ActionResult>(`/journal/${encodeURIComponent(jid)}/undo`, {});
}

export function getQueue(): Promise<QueueResponse> {
  return call<QueueResponse>('/queue');
}

export function addToQueue(body: QueueAddRequest): Promise<QueueAddResponse> {
  return post<QueueAddResponse>('/queue', body);
}

export function removeQueueItem(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/queue/${encodeURIComponent(id)}/remove`, {});
}

export function retryQueueItem(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/queue/${encodeURIComponent(id)}/retry`, {});
}

export function pauseQueue(): Promise<ActionResult> {
  return post<ActionResult>('/queue/pause', {});
}

export function resumeQueue(): Promise<ActionResult> {
  return post<ActionResult>('/queue/resume', {});
}

export function mergeQueueItem(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/queue/${encodeURIComponent(id)}/merge`, {});
}

export function promoteQueueItem(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/queue/${encodeURIComponent(id)}/promote`, {});
}
