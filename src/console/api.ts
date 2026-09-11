/**
 * The one place the console talks to the server. Every write goes through
 * `call()`, so the token header and the redaction of a failed body are both
 * one function rather than repeated at every call site (decision 3 in the
 * goal brief: "all of that lives behind one `api.ts`").
 */
import { redactErrorBody } from './redact.js';
import type { SyncScope, SyncStateResponse, WatcherStatus as WatcherStatusModel } from './sync-types.js';
import type {
  AccountProvider,
  AccountsResponse,
  AccountUpdateRequest,
  AccountUpdateResponse,
  ActionResult,
  BlockersActionResult,
  BlockersResponse,
  Caps,
  CommandResponse,
  ConnectAttemptResponse,
  ConnectStartResponse,
  ConsoleStateSummary,
  DeleteFilesResponse,
  DisconnectResponse,
  IntegrationsResponse,
  LeftoversResponse,
  JournalResponse,
  LaneStory,
  LanesResponse,
  LaneSummary,
  MergeReadyReport,
  Message,
  ProposalsResponse,
  QueueAddRequest,
  QueueAddResponse,
  QueueResponse,
  ReauditResponse,
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

export function getThread(opts?: { verbose?: boolean }): Promise<ThreadResponse> {
  return call<ThreadResponse>(opts?.verbose ? '/thread?verbose=1' : '/thread');
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

export interface MachineProcessRowView {
  name: string;
  ageMs: number;
  commandLine: string;
  output: string;
  children: MachineProcessRowView[];
  pid?: number;
  ppid?: number;
}

export interface MachineSessionView {
  name?: string;
  repo: string | null;
  branch: string | null;
  status: string;
  startedAt?: number;
  root: MachineProcessRowView | null;
  sessionId?: string;
  pid?: number;
}

export interface MachineResponse {
  glance: string;
  readAt: number;
  intervalMs: number;
  sessions: MachineSessionView[];
  unregistered: MachineProcessRowView[];
}

export function getMachine(opts?: { verbose?: boolean }): Promise<MachineResponse> {
  const qs = opts?.verbose ? '?verbose=1' : '';
  return call<MachineResponse>(`/machine${qs}`);
}

export function getRunThread(id: string, opts?: { verbose?: boolean }): Promise<RunThreadResponse> {
  const qs = opts?.verbose ? '?verbose=1' : '';
  return call<RunThreadResponse>(`/run/${encodeURIComponent(id)}/thread${qs}`);
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

/** H2.4: the ticket sheet's Story section. */
export function getRunStory(id: string, opts?: { verbose?: boolean }): Promise<LaneStory> {
  const qs = opts?.verbose ? '?verbose=1' : '';
  return call<LaneStory>(`/run/${encodeURIComponent(id)}/story${qs}`);
}

/** 2026-09-07: the ticket sheet's own top summary block: what was done, the current
 *  status, whether it was audited, and whether it is proven ready to merge. */
export function getRunSummary(id: string): Promise<LaneSummary> {
  return call<LaneSummary>(`/run/${encodeURIComponent(id)}/summary`);
}

/** The sheet's Re-check button: re-reads the PR facts and drift now, bypassing the
 *  60-second PR cache the board's own poll relies on. */
export function recheckRun(id: string): Promise<LaneSummary> {
  return post<LaneSummary>(`/run/${encodeURIComponent(id)}/recheck`, {});
}

/** The sheet's Re-audit button: runs the council again on the run's current head. The
 *  result lands as a new attestation; the caller polls `getRunSummary` until the
 *  audit's own `head` matches the PR's current head. */
export function reauditRun(id: string): Promise<ReauditResponse> {
  return post<ReauditResponse>(`/run/${encodeURIComponent(id)}/reaudit`, {});
}

/** H2.3: what a bulk retire would do (`GET /retire-finished`), and doing it
 *  (`POST /retire-finished`). The preview's own shape isn't in the frozen shared
 *  contract yet -- named here rather than in console-model.ts, mirrored by the stub. */
export interface RetireFinishedPreview {
  items: { id: string; title: string | null }[];
}
export interface RetireFinishedResult extends ActionResult {
  retired: string[];
}
export function getRetireFinishedPreview(): Promise<RetireFinishedPreview> {
  return call<RetireFinishedPreview>('/retire-finished');
}
export function postRetireFinished(confirm?: string): Promise<Gated<RetireFinishedResult>> {
  return post<Gated<RetireFinishedResult>>('/retire-finished', withConfirm({}, confirm));
}

/** H2.3: what a bulk merge would do (`GET /merge-ready`, `MergeReadyReport` --
 *  already in the shared contract), and doing it (`POST /merge-ready`). The
 *  per-lane outcome shape matches the real server (src/forge/server.ts
 *  mergeReadyPost): one entry per lane a merge was actually attempted on. */
export interface MergeReadyResult extends ActionResult {
  outcomes: { id: string; ok: boolean; message: string }[];
}
export function getMergeReadyPreview(): Promise<MergeReadyReport> {
  return call<MergeReadyReport>('/merge-ready');
}
export function postMergeReady(confirm?: string): Promise<Gated<MergeReadyResult>> {
  return post<Gated<MergeReadyResult>>('/merge-ready', withConfirm({}, confirm));
}

export function getBlockers(): Promise<BlockersResponse> {
  return call<BlockersResponse>('/blockers');
}

export function resolveBlocker(id: string): Promise<BlockersActionResult> {
  return post<BlockersActionResult>(`/blockers/${encodeURIComponent(id)}/resolve`, {});
}

export function checkBlocker(id: string): Promise<BlockersActionResult> {
  return post<BlockersActionResult>(`/blockers/${encodeURIComponent(id)}/check`, {});
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

/**
 * An irreversible route answers 202 with this shape until the same request comes back
 * carrying `confirm: token`. The token lives in the server's own pending map, the one a
 * typed `confirm <token>` in the rail resolves too, so nothing irreversible ever runs on
 * a confirm the page made up for itself.
 */
export interface ConfirmPending {
  ok: false;
  pending: true;
  token: string;
  blast: string;
  card: Message;
}

export function isConfirmPending(value: unknown): value is ConfirmPending {
  const row = value as { pending?: unknown; token?: unknown };
  return Boolean(row) && row.pending === true && typeof row.token === 'string';
}

/** The answer an irreversible call gives: the real result once confirmed, or the
 *  pending confirm before that. */
export type Gated<T> = T | ConfirmPending;

function withConfirm(body: Record<string, unknown>, confirm: string | undefined): Record<string, unknown> {
  return confirm ? { ...body, confirm } : body;
}

export function killRun(id: string, reason: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>(`/run/${encodeURIComponent(id)}/kill`, withConfirm({ reason }, confirm));
}

/** `POST /stop`: every running lane parks with a handoff request and the kill switch
 *  engages. Irreversible, so it runs behind the same confirm as a kill. */
export function stopAll(confirm?: string): Promise<Gated<ActionResult & { stopped: string[] }>> {
  return post<Gated<ActionResult & { stopped: string[] }>>('/stop', withConfirm({ reason: 'stopped from the console' }, confirm));
}

/** `POST /run/:id/retire`: the lane leaves the board's default view. The undo is
 *  `unretireRun`, which is never gated. */
export function retireRun(id: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>(`/run/${encodeURIComponent(id)}/retire`, withConfirm({}, confirm));
}

export function pauseRun(id: string, reason?: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/pause`, reason ? { reason } : {});
}

export function resumeRun(id: string): Promise<ActionResult> {
  return post<ActionResult>(`/run/${encodeURIComponent(id)}/resume`, {});
}

export function mergeRun(id: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>(`/run/${encodeURIComponent(id)}/merge`, withConfirm({}, confirm));
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
 * C.1's Amend action: `POST /amend`, which appends the text to the run's own brief (and
 * its Definition of Done) and delivers it through the run's inbox. Same `{ ok: true }`
 * shape as `/send`, folded into `ActionResult` the same way for `runAction`'s one
 * receipt path.
 */
export function amendRun(run: string, text: string): Promise<ActionResult> {
  return post<{ ok: boolean }>('/amend', { run, text })
    .then((result) => ({ ok: result.ok, jid: null, message: `amended ${run}`, undoable: false }));
}

export function setCaps(body: { dailyTokens?: number; runTokens?: number }, confirm?: string): Promise<Gated<Caps>> {
  return post<Gated<Caps>>('/caps', withConfirm(body, confirm));
}

/** `run` is the lane whose sheet the text was typed into, so the Conductor agent gets
 *  it as context and "kill and remove this" has a "this". */
export function sendCommand(text: string, run?: string): Promise<CommandResponse> {
  return post<CommandResponse>('/command', run ? { text, run } : { text });
}

export function checkIntegration(id: string): Promise<IntegrationsResponse> {
  return post<IntegrationsResponse>(`/integrations/${encodeURIComponent(id)}/check`, {});
}

export function reconnectIntegration(id: string): Promise<ReconnectResponse> {
  return post<ReconnectResponse>(`/integrations/${encodeURIComponent(id)}/reconnect`, {});
}

/**
 * `GET /integrations/:id/connect/:attempt` -- a read, so it needs no `ACTIONS` catalog
 * entry (`tests/console/actions-catalog.test.ts` only scans this file's writes). The
 * matching `POST /integrations/:id/connect` deliberately does NOT live here: see
 * `IntegrationsPanel.tsx`'s own doc comment for why that call bypasses this module.
 */
export function getIntegrationConnectAttempt(id: string, attempt: string): Promise<{ state: string; link?: string; error?: string }> {
  return call<{ state: string; link?: string; error?: string }>(
    `/integrations/${encodeURIComponent(id)}/connect/${encodeURIComponent(attempt)}`,
  );
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

/** Needs-you fix: a stale ask (24h+ old, with no readable question) never resolves on
 *  its own -- `Dismiss` retires it off the inbox through the same `/clear` path a
 *  breaker-blocked lane already uses, so it stops sitting at the board forever. */
export function dismissAsk(inboxKey: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>('/clear', withConfirm({ inboxKey }, confirm));
}

export function getQueue(): Promise<QueueResponse> {
  return call<QueueResponse>('/queue');
}

export function addToQueue(body: QueueAddRequest): Promise<QueueAddResponse> {
  return post<QueueAddResponse>('/queue', body);
}

export function removeQueueItem(id: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>(`/queue/${encodeURIComponent(id)}/remove`, withConfirm({}, confirm));
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

export function mergeQueueItem(id: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>(`/queue/${encodeURIComponent(id)}/merge`, withConfirm({}, confirm));
}

export function promoteQueueItem(id: string, version: string, message: string, confirm?: string): Promise<Gated<ActionResult>> {
  return post<Gated<ActionResult>>(`/queue/${encodeURIComponent(id)}/promote`, withConfirm({ version, message }, confirm));
}

/** queue-throughput W3: the width stepper's write. 1-12 is enforced server-side
 *  (`queue-route.ts`); an out-of-range value comes back as a 400 `ApiError` with the
 *  message `maxInFlight must be an integer between 1 and 12`, same as any other
 *  refused action here. */
export function postQueueWidth(maxInFlight: number): Promise<ActionResult> {
  return post<ActionResult>('/queue/width', { maxInFlight });
}

export function getAccounts(): Promise<AccountsResponse> {
  return call<AccountsResponse>('/accounts');
}

export function connectAccount(provider: AccountProvider): Promise<ConnectStartResponse> {
  return post<ConnectStartResponse>('/accounts/connect', { provider });
}

export function getConnectAttempt(attemptId: string): Promise<ConnectAttemptResponse> {
  return call<ConnectAttemptResponse>(`/accounts/connect/${encodeURIComponent(attemptId)}`);
}

export function disconnectAccount(id: string): Promise<DisconnectResponse> {
  return post<DisconnectResponse>(`/accounts/${encodeURIComponent(id)}/disconnect`, {});
}

/** How much of this login the fleet may take. An omitted field is left alone;
 *  `maxConcurrent: 0` clears the ceiling. */
export function updateAccount(id: string, patch: AccountUpdateRequest): Promise<AccountUpdateResponse> {
  return call<AccountUpdateResponse>(`/accounts/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(patch),
  });
}

export function getLeftovers(): Promise<LeftoversResponse> {
  return call<LeftoversResponse>('/accounts/leftovers');
}

/** R-71: the board's own sync/watcher surfaces. `GET /sync` is the whole
 *  `SyncStateResponse`; the console never learns anything about a run beyond it. */
export function getSync(): Promise<SyncStateResponse> {
  return call<SyncStateResponse>('/sync');
}

/** The confirm-gated full re-sync: the first call posts without a token and gets
 *  back the same `ConfirmPending` shape every other irreversible action uses; the
 *  second call carries the server-issued token. */
export function fullResync(confirm?: string): Promise<Gated<{ started: boolean; id: string }>> {
  return post<Gated<{ started: boolean; id: string }>>('/sync/full', withConfirm({}, confirm));
}

/** A single page's re-sync. Never gated -- only the full wipe-and-restart is. */
export function resyncPage(scope: Exclude<SyncScope, 'full'>): Promise<{ started: boolean; id: string }> {
  return post<{ started: boolean; id: string }>(`/sync/${scope}`, {});
}

export function watcherOn(): Promise<WatcherStatusModel> {
  return post<WatcherStatusModel>('/watcher/on', {});
}

export function watcherOff(): Promise<WatcherStatusModel> {
  return post<WatcherStatusModel>('/watcher/off', {});
}

/** Removes one unlinked login's files. Takes the directory's NAME, never a path -- the
 *  console never learns where the configs root is, and the server never accepts one. */
export function deleteLeftover(name: string, confirm?: string): Promise<Gated<DeleteFilesResponse>> {
  return post<Gated<DeleteFilesResponse>>(
    `/accounts/leftovers/${encodeURIComponent(name)}/delete`, withConfirm({}, confirm),
  );
}
