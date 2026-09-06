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
  IntegrationsResponse,
  JournalResponse,
  LanesResponse,
  ProposalsResponse,
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

export function getLanes(params?: { all?: boolean }): Promise<LanesResponse> {
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

export function compactRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/compact`, {});
}

export function verifyRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/verify`, {});
}

export function setRunCap(id: string, capUsd: number): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/cap`, { capUsd });
}

export function setCaps(body: { dailyUsd?: number; runUsd?: number }): Promise<Caps> {
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
