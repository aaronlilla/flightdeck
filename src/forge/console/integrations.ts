/**
 * `GET /integrations`, `POST /integrations/:id/check`, `POST /integrations/:id/reconnect`.
 *
 * There is no `IntegrationStatus` concept anywhere else in this codebase yet
 * (`CONSOLE-MAP.md` section 8 confirms it), so this module is the first thing to declare
 * one: a row per integration in `~/.forge/console/integrations.json`, with a probe
 * function behind each row rather than a status this file invents on its own. Every
 * probe defaults to a real check (`gh auth status`, a Jira ping, `aws sts
 * get-caller-identity`, ...) and every default reads its target from an environment
 * variable (`FORGE_AWS_PROFILE`, `FORGE_JIRA_SITE`/`EMAIL`/`TOKEN`) rather than a name
 * written into source, per this repository's `check:agnostic` rule. A specimen replaces
 * the whole probe map, so no test here ever shells out or reaches the network.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { run as execRun, type RunRequest } from '../exec.js';
import { watchedProcesses } from '../fleetwatch.js';
import type { FleetProcess } from '../liveness.js';
import { fleetConfigDir } from '../paths.js';
import { appendOnce } from '../journal.js';
import { claudeMcpList, type McpRow } from './mcp-runner.js';import { integrationWordsFor } from '../../shared/integration-words.js';
import { consoleDir, recordAction, type ActionsLedger } from './actions-ledger.js';
import { narrateIntegrations } from './integrations-narrate.js';
import { missingSlackEnv, slackConfigFromEnv } from '../intake/slack.js';
import type { Narrator } from './narrate-store.js';
import type {
  Integration, IntegrationsResponse, IntegrationStatus, LanesResponse, McpConnState, ReconnectResponse,
} from '../../shared/console-model.js';

export function integrationsConfigPath(): string {
  return join(consoleDir(), 'integrations.json');
}

export interface ProbeResult {
  status: IntegrationStatus;
  latencyMs: number | null;
  /** Overrides the row's declared `desc` for this probe result, when a probe's own
   *  description depends on what it found (an stdio MCP server's "command found" vs
   *  "command not on PATH"). Undefined leaves the declaration's own `desc` in place. */
  desc?: string;
  /** Why this specific probe failed, in its own words: a missing env var, a non-zero
   *  exit, a non-OK response, instead of the same "is not reachable" every row would
   *  otherwise repeat. Undefined on an `ok` result, since there's nothing to explain. */
  detail?: string;
  /** A real, runtime-read identifier for what this probe checked, such as an AWS profile
   *  name or a Jira site, never a name written into source. Undefined for a probe with
   *  no scope of its own; a down integration with none isn't missing anything. */
  scope?: string;
  /** The real MCP connection state this probe found, for an `mcp`-kind row only.
   *  Undefined for every `conn`-kind probe, which has no such state to report. */
  mcpState?: McpConnState;
  /** The MCP CLI's own error text, verbatim, for an `mcp`-kind row whose `mcpState` is
   *  `failed`. Undefined for every other probe and every other `mcpState`. */
  lastError?: string;
}

/** The `{ok, detail}` shape a boolean-probe body returns to `timed`, which turns it into
 *  the `ProbeResult` every probe function above it returns. */
interface ProbeOutcome {
  ok: boolean;
  detail?: string;
  scope?: string;
  mcpState?: McpConnState;
  lastError?: string;
}

export type Probe = () => Promise<ProbeResult>;
export type Reconnect = () => Promise<void>;

export interface IntegrationDecl {
  id: string;
  kind: 'conn' | 'mcp';
  name: string;
  desc: string;
  reconnectLabel: string | null;
}

async function timed(fn: () => Promise<ProbeOutcome>, spawnFn?: RunRequest['spawnFn']): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const outcome = await Promise.race([
      fn(),
      new Promise<ProbeOutcome>((resolve) => {
        setTimeout(() => resolve({ ok: false, detail: 'timed out after 5s' }), 5000);
      }),
    ]);
    return {
      status: outcome.ok ? 'ok' : 'off', latencyMs: outcome.ok ? Date.now() - started : null,
      ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
      ...(outcome.scope !== undefined ? { scope: outcome.scope } : {}),
      ...(outcome.mcpState !== undefined ? { mcpState: outcome.mcpState } : {}),
      ...(outcome.lastError !== undefined ? { lastError: outcome.lastError } : {}),
    };
  } catch (error) {
    return { status: 'off', latencyMs: null, detail: error instanceof Error ? error.message : 'probe threw' };
  }
}

function ghProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const result = await execRun({
      argv: ['gh', 'auth', 'status'], cwd: process.cwd(), owner: 'console-integrations-gh',
      cls: 'script', ...(spawnFn ? { spawnFn } : {}),
    });
    return { ok: result.returncode === 0, detail: result.returncode === 0 ? undefined : `gh auth status exited ${result.returncode}` };
  }, spawnFn);
}

/** The `/rest/api/3/myself` url for a `FORGE_JIRA_SITE` value, whether it was written as a
 *  bare host (`acme.atlassian.net`) or with its scheme (`https://acme.atlassian.net`), the
 *  shape every other reader of that variable (`jiraUrl` in `lanes.ts`) already expects.
 *  Prefixing `https://` a second time built `https://https://...`, which made `fetch` throw
 *  and the row read `off` on a machine whose credentials were all set. */
export function jiraMyselfUrl(site: string): string {
  const host = site.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${host}/rest/api/3/myself`;
}

function jiraProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const site = process.env['FORGE_JIRA_SITE'];
    const email = process.env['FORGE_JIRA_EMAIL'];
    const token = process.env['FORGE_JIRA_TOKEN'];
    if (!site || !email || !token) return { ok: false, detail: 'FORGE_JIRA_SITE / FORGE_JIRA_EMAIL / FORGE_JIRA_TOKEN are not all set' };
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const response = await fetch(jiraMyselfUrl(site), {
      headers: { authorization: `Basic ${auth}` },
    });
    return { ok: response.ok, detail: response.ok ? undefined : `myself endpoint returned ${response.status}`, scope: site };
  }, spawnFn);
}

/** R-76: Pass to… needs all three Slack variables set and a bot in the questions
 *  channel. This row checks only that the variables are there -- the bot's membership is
 *  something only a real post finds out, and a probe that posted to prove itself would
 *  be exactly the unsolicited message this feature promises never to send. Neither the
 *  token nor any user id reaches the row's own text. */
function slackProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const missing = missingSlackEnv();
    if (missing.length) return { ok: false, detail: `${missing.join(' / ')} not set` };
    const names = Object.keys(slackConfigFromEnv()?.users ?? {});
    return { ok: true, scope: `${names.length} teammate${names.length === 1 ? '' : 's'} known` };
  }, spawnFn);
}

/**
 * `ok` when the fleet's own config dir (`FORGE_CONFIG_DIR`, default `~/.claude-fleet`)
 * holds credentials or a session file, or `forge status`'s own process classification
 * (`watchedProcesses`, `fleetwatch.ts`) sees a login or worker process; `off` only when
 * none of those is true. `existsSync(join(forgeHome(), 'logins'))` used to answer this,
 * which checks Forge's own single-flight login lock directory, not the fleet account at
 * all -- it read `off` on a machine that had a real fleet login, since that directory
 * only ever holds something during the few seconds a login flow is in flight.
 */
export function modelProviderProbeResult(deps: {
  exists?: (path: string) => boolean;
  readdir?: (path: string) => string[];
  processes?: () => FleetProcess[] | { ok: false; reason: string };
} = {}): boolean {
  const exists = deps.exists ?? existsSync;
  const readdir = deps.readdir ?? ((path: string) => readdirSync(path));
  const processesFn = deps.processes ?? watchedProcesses;

  const configDir = fleetConfigDir(exists);
  if (exists(join(configDir, '.credentials.json'))) return true;
  const sessionsDir = join(configDir, 'projects');
  if (exists(sessionsDir)) {
    try {
      if (readdir(sessionsDir).length > 0) return true;
    } catch {
      // A directory that vanished between the exists() check and the read is not a
      // session store to trust either way.
    }
  }

  const processes = processesFn();
  if (!Array.isArray(processes)) return false;
  return processes.some((proc) => proc.kind === 'login' || proc.kind === 'worker');
}

function modelProviderProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const ok = modelProviderProbeResult();
    return { ok, detail: ok ? undefined : 'no fleet login session or credentials found' };
  }, spawnFn);
}

function codexProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const result = await execRun({
      argv: ['codex', '--version'], cwd: process.cwd(), owner: 'console-integrations-codex',
      cls: 'script', ...(spawnFn ? { spawnFn } : {}),
    });
    return { ok: result.returncode === 0, detail: result.returncode === 0 ? undefined : 'codex --version failed' };
  }, spawnFn);
}

function awsProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const profile = process.env['FORGE_AWS_PROFILE'];
    if (!profile) return { ok: false, detail: 'FORGE_AWS_PROFILE is not set' };
    const result = await execRun({
      argv: ['aws', 'sts', 'get-caller-identity', '--profile', profile], cwd: process.cwd(),
      owner: 'console-integrations-aws', cls: 'script', ...(spawnFn ? { spawnFn } : {}),
    });
    return {
      ok: result.returncode === 0,
      detail: result.returncode === 0 ? undefined : `sts get-caller-identity failed for profile ${profile}`,
      scope: profile,
    };
  }, spawnFn);
}

/** Whether `command` resolves on PATH (`where` on Windows, `which` elsewhere), capped
 *  at 5s the same way every other probe here is. Exported so a specimen can inject a
 *  fake resolver rather than reaching a real PATH lookup. */
export async function commandOnPath(command: string, spawnFn?: RunRequest['spawnFn']): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = await Promise.race([
      execRun({
        argv: [finder, command], cwd: process.cwd(), owner: `console-integrations-mcp-${command}`,
        cls: 'script', ...(spawnFn ? { spawnFn } : {}),
      }).then((result) => result.returncode === 0),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 5000); }),
    ]);
    return found;
  } catch {
    return false;
  }
}

/** A `command`-declared (stdio) MCP server is probed by resolving that command on PATH,
 *  never by attempting to speak its stdio protocol -- there is nothing to connect to
 *  until something actually launches it. `found` reads `ok` with a `desc` saying so;
 *  otherwise `down`, since an MCP server the console cannot even find a binary for is a
 *  real outage, not merely "off" the way an unconfigured integration is. */
export function stdioMcpProbe(command: string, spawnFn?: RunRequest['spawnFn']): Probe {
  return async () => {
    const found = await commandOnPath(command, spawnFn);
    return {
      status: found ? 'ok' : 'down',
      latencyMs: null,
      desc: found ? 'stdio · command found' : 'stdio · command not on PATH',
    };
  };
}

/** The set of MCP server names/targets to declare rows for, read once from the fleet's
 *  own config dir's `.claude.json` (never the interactive account's, never
 *  `.credentials.json`) -- the server *list* only. The live status for each declared
 *  row comes from `claudeMcpList` (a real `claude mcp list`/`get` call) inside the
 *  probe below, not from this enumeration. */
function mcpServerSpecs(): Record<string, { url?: string; command?: string }> {
  const configDir = fleetConfigDir(existsSync);
  const claudeJson = join(configDir, '.claude.json');
  if (!existsSync(claudeJson)) return {};
  try {
    const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as {
      mcpServers?: Record<string, { url?: string; command?: string }>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Maps a `claudeMcpList` row's real connection state onto the console's existing
 *  (pre-widen) `IntegrationStatus` union: `connected` reads `ok`, everything else --
 *  needing login, pending approval, a real failure, or genuinely unknown -- reads
 *  `off` with the CLI's own status text carried in `detail`, matching how this probe
 *  already treated any non-`ok` MCP result before this change. W2 widens
 *  `IntegrationStatus` itself so these states stop being collapsed into `off`. */
/** Exported for the W2 round-trip specimen only; every runtime caller reaches this
 *  through `mcpProbes`. */
export function mcpConnStateDetail(name: string, row: McpRow | undefined): { ok: boolean; detail?: string; mcpState: McpConnState; lastError?: string } {
  if (!row) {
    return { ok: false, detail: `${name} is not in claude mcp list's own server table`, mcpState: 'unknown' };
  }
  if (row.state === 'connected') return { ok: true, mcpState: 'connected' };
  const label = row.state === 'needs-login' ? 'needs authentication'
    : row.state === 'pending-approval' ? 'pending approval'
    : row.state === 'failed' ? (row.lastError ?? 'failed')
    : 'connection state unknown';
  return {
    ok: false, detail: label, mcpState: row.state,
    ...(row.state === 'failed' ? { lastError: row.lastError ?? label } : {}),
  };
}

function mcpProbes(spawnFn?: RunRequest['spawnFn']): Record<string, { decl: IntegrationDecl; probe: Probe }> {
  const servers = mcpServerSpecs();
  const out: Record<string, { decl: IntegrationDecl; probe: Probe }> = {};
  for (const [name, spec] of Object.entries(servers)) {
    const id = `mcp-${name}`;
    const desc = spec.url ? `MCP server ${name}` : `stdio · ${spec.command ?? name}`;
    out[id] = {
      decl: { id, kind: 'mcp', name, desc, reconnectLabel: null },
      probe: () => timed(async () => {
        const result = await claudeMcpList({ spawnFn });
        if (!result.ok) {
          // `claude` unresolvable and the fallback file read also failed/missing: fall
          // back further to the old PATH/URL checks so a row still reports something
          // real rather than a blanket "down" the moment the CLI itself is unavailable.
          if (spec.command) {
            const found = await commandOnPath(spec.command, spawnFn);
            return { ok: found, detail: found ? undefined : 'stdio · command not on PATH' };
          }
          if (spec.url) {
            try {
              const response = await fetch(spec.url);
              return { ok: response.ok, detail: response.ok ? undefined : `${spec.url} returned ${response.status}` };
            } catch (error) {
              return { ok: false, detail: error instanceof Error ? error.message : `could not reach ${spec.url}` };
            }
          }
          return { ok: false, detail: 'claude mcp list unavailable and no fallback server list' };
        }
        const row = result.rows.find((r) => r.name === name);
        return mcpConnStateDetail(name, row);
      }),
    };
  }
  return out;
}

export interface IntegrationsDeps {
  journalPath: string;
  ledger: ActionsLedger;
  /** Absent, or null, means this console serves the rows' own template sentences. No
   *  route here ever awaits the narrator. */
  narrator?: Narrator | null;
  configPath?: string;
  spawnFn?: RunRequest['spawnFn'];
  /** Overrides the whole probe table. A specimen always sets this, so no test here
   *  reaches a real process or the network. */
  probes?: Record<string, Probe>;
  reconnects?: Record<string, Reconnect>;
  everyS?: number;
  /** The same lane view the board renders, so a down row can name the lanes actually
   *  blocked on it instead of a generic sentence. Undefined reads as no lanes blocked. */
  lanesView?: () => LanesResponse;
}

const BUILTIN_DECLS: IntegrationDecl[] = [
  { id: 'github', kind: 'conn', name: 'GitHub', desc: 'gh CLI auth + rate limit', reconnectLabel: 'Reconnect via SSO' },
  { id: 'jira', kind: 'conn', name: 'Jira', desc: 'FORGE_JIRA_* credentials', reconnectLabel: 'Reconnect' },
  { id: 'model-provider', kind: 'conn', name: 'Model provider', desc: 'fleet login', reconnectLabel: 'Reconnect via SSO' },
  { id: 'codex', kind: 'conn', name: 'Codex', desc: 'codex CLI', reconnectLabel: 'Reconnect' },
  { id: 'aws', kind: 'conn', name: 'AWS', desc: 'FORGE_AWS_PROFILE via SSO', reconnectLabel: 'Reconnect AWS via SSO' },
  { id: 'slack', kind: 'conn', name: 'Slack', desc: 'FORGE_SLACK_* for Pass to…', reconnectLabel: null },
];

function defaultProbes(spawnFn?: RunRequest['spawnFn']): Record<string, Probe> {
  return {
    github: ghProbe(spawnFn),
    jira: jiraProbe(spawnFn),
    'model-provider': modelProviderProbe(spawnFn),
    codex: codexProbe(spawnFn),
    aws: awsProbe(spawnFn),
    slack: slackProbe(spawnFn),
  };
}

/** The AWS SSO login argv, shared by the existing `reconnect()` path (`DEFAULT_RECONNECTS.aws`
 *  below) and W3's `POST /integrations/aws/connect` route, so the two never drift apart into
 *  two separate implementations of the same login. */
export function awsSsoLoginArgv(): string[] {
  return ['aws', 'sso', 'login', '--profile', process.env['FORGE_AWS_PROFILE'] ?? ''];
}

const DEFAULT_RECONNECTS: Record<string, string[]> = {
  aws: awsSsoLoginArgv(),
  github: ['gh', 'auth', 'login', '--web'],
};

export interface StoredRow {
  id: string;
  latencyMs: number | null;
  status: IntegrationStatus;
  checkedAt: number;
  since: number | null;
  /** A probe's own description of what it found, overriding the declaration's static
   *  `desc` for this row (a stdio MCP server's "command found" vs "command not on
   *  PATH"). Absent for every probe whose desc never varies by outcome. */
  desc?: string;
  /** Why the row is down, from the probe itself. Absent while the row is `ok`. */
  detail?: string;
  /** A real, runtime-read scope for this row (an AWS profile, a Jira site). Absent for
   *  a probe with no such scope. */
  scope?: string;
  /** The last time this row's probe returned `ok`. Null until it has, at least once. */
  lastHealthyAt: number | null;
  /** Consecutive non-`ok` probe results since the last `ok` one; reset to 0 on recovery. */
  retryCount: number;
  /** The real `claude mcp list`/`get` connection state for an `mcp`-kind row. Absent for
   *  every `conn`-kind row, which never sets it. */
  mcpState?: McpConnState;
  /** The MCP CLI's own error text for a `mcp`-kind row, verbatim. Absent for a `conn`-kind
   *  row, and for an `mcp` row with nothing to report. */
  lastError?: string;
}

interface StoredFile {
  rows: Record<string, StoredRow>;
}

function readStored(path: string): StoredFile {
  if (!existsSync(path)) return { rows: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredFile;
  } catch {
    return { rows: {} };
  }
}

function writeStored(path: string, value: StoredFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

/** The down-plate's cause/effect/fix, built from the probe's own detail and the lanes
 *  actually blocked on this row, rather than a sentence naming nothing but the
 *  integration itself. */
function downCopy(decl: IntegrationDecl, row: StoredRow | undefined, dependents: string[]): { cause: string; effect: string; fix: string } {
  const cause = row?.detail ?? `${decl.name} failed its health check`;
  const effect = dependents.length
    ? `${dependents.join(', ')} blocked on ${decl.name} · lanes not depending on it are unaffected`
    : `no lane is currently blocked on ${decl.name}`;
  const label = decl.reconnectLabel ?? 'Reconnect';
  const fix = decl.reconnectLabel
    ? `${label} → verify → ${dependents.length ? `${dependents.length} blocked lane(s)` : 'any blocked lanes'} resume`
    : `no reconnect command is wired for ${decl.name} yet`;
  return { cause, effect, fix };
}

/** Exported for the W2 round-trip specimen only; every runtime caller reaches this
 *  through `IntegrationsRegistry`. */
export function toIntegration(decl: IntegrationDecl, row: StoredRow | undefined, dependents: string[], canConnect: boolean): Integration {
  const built = buildIntegration(decl, row, dependents, canConnect);
  return { ...built, words: integrationWordsFor(built) };
}

function buildIntegration(decl: IntegrationDecl, row: StoredRow | undefined, dependents: string[], canConnect: boolean): Integration {
  const status = row?.status ?? 'checking';
  const down = status === 'down';
  const copy = down ? downCopy(decl, row, dependents) : null;
  return {
    id: decl.id,
    kind: decl.kind,
    name: decl.name,
    desc: row?.desc ?? decl.desc,
    latencyMs: row?.latencyMs ?? null,
    status,
    checkedAt: row?.checkedAt ?? 0,
    since: row?.since ?? null,
    cause: copy?.cause ?? null,
    effect: copy?.effect ?? null,
    fix: copy?.fix ?? null,
    fixLabel: down ? (decl.reconnectLabel ?? 'Reconnect') : null,
    scope: row?.scope ?? null,
    lastHealthyAt: row?.lastHealthyAt ?? null,
    retryCount: row?.retryCount ?? 0,
    dependents,
    step: null,
    canConnect,
    links: {},
    mcpState: row?.mcpState ?? null,
    lastError: row?.lastError ?? null,    words: { status: '', note: '' },
  };
}

export class IntegrationsRegistry {
  private readonly configPath: string;

  private readonly probes: Record<string, Probe>;

  private readonly reconnects: Record<string, Reconnect>;

  private readonly everyS: number;

  /** The refresh currently running behind a response, so ten polls do not start ten. */
  private refreshing: Promise<IntegrationsResponse> | undefined;

  constructor(private readonly deps: IntegrationsDeps) {
    this.configPath = deps.configPath ?? integrationsConfigPath();
    this.probes = deps.probes ?? { ...defaultProbes(deps.spawnFn), ...Object.fromEntries(
      Object.entries(mcpProbes(deps.spawnFn)).map(([id, entry]) => [id, entry.probe]),
    ) };
    this.reconnects = deps.reconnects ?? Object.fromEntries(
      Object.entries(DEFAULT_RECONNECTS).map(([id, argv]) => [id, async () => {
        await execRun({
          argv, cwd: process.cwd(), owner: `console-reconnect-${id}`, cls: 'script',
          ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
        });
      }]),
    );
    this.everyS = deps.everyS ?? 30;
  }

  private decls(): IntegrationDecl[] {
    const dynamic = this.deps.probes ? [] : Object.values(mcpProbes(this.deps.spawnFn)).map((entry) => entry.decl);
    return [...BUILTIN_DECLS, ...dynamic];
  }

  private dependentsOf(id: string): string[] {
    return this.dependentsByIntegration()[id] ?? [];
  }

  /** One pass over the lanes per request rather than one per integration row: with a
   *  couple of dozen rows and a few thousand lanes the per-row filter was the difference
   *  between a response and a stall. */
  private dependentsByIntegration(): Record<string, string[]> {
    // `blockedBy` (which lane is blocked on which integration) is the reads module's
    // computation off `run.blocked` reasons; `deps.lanesView` hands us that same result
    // rather than this module recomputing it from the journal a second time.
    const view = this.deps.lanesView?.();
    const grouped: Record<string, string[]> = {};
    if (!view) return grouped;
    for (const lane of view.lanes) {
      if (!lane.blockedBy) continue;
      (grouped[lane.blockedBy] ??= []).push(lane.id);
    }
    return grouped;
  }

  /** A probe shells out to `gh`, `aws` or an MCP command, so awaiting them inside a
   *  request makes every console poll wait on the slowest external tool. `list` therefore
   *  answers from what was last stored and kicks off a refresh behind the response; the
   *  next poll, five seconds later, picks the new values up. `force` (the operator's own
   *  "check now") still waits, because that is the one time they asked to. */
  async list(force = false): Promise<IntegrationsResponse> {
    if (!force) {
      const stored = readStored(this.configPath);
      const now = Date.now();
      const dependents = this.dependentsByIntegration();
      const items = narrateIntegrations(this.decls().map((decl) =>
        toIntegration(decl, stored.rows[decl.id], dependents[decl.id] ?? [], Boolean(this.reconnects[decl.id]))),
      this.deps.narrator ?? null);
      // Nothing awaits this, so a probe that rejects after the caller has moved on would
      // surface as an unhandled rejection and take the process down with it. A failed
      // probe is ordinary here: the row simply keeps its previous value until one works.
      void this.refreshStale().catch(() => undefined);
      return { items, checkedAt: now, everyS: this.everyS };
    }
    return this.refreshStale(true);
  }

  /** Probes every row whose stored result has aged out, all of them at once rather than
   *  one after another, and writes the results back. */
  private async refreshStale(force = false): Promise<IntegrationsResponse> {
    if (this.refreshing && !force) return this.refreshing;
    const run = this.probeStale(force);
    if (!force) {
      this.refreshing = run.catch(() => this.emptyResponse()).finally(() => { this.refreshing = undefined; });
      return this.refreshing;
    }
    return run;
  }

  /** What a failed background refresh resolves to, so a rejection never escapes. */
  private emptyResponse(): IntegrationsResponse {
    const stored = readStored(this.configPath);
    const dependents = this.dependentsByIntegration();
    const items = narrateIntegrations(this.decls().map((decl) =>
      toIntegration(decl, stored.rows[decl.id], dependents[decl.id] ?? [], Boolean(this.reconnects[decl.id]))),
      this.deps.narrator ?? null);
    return { items, checkedAt: Date.now(), everyS: this.everyS };
  }

  private async probeStale(force: boolean): Promise<IntegrationsResponse> {
    const stored = readStored(this.configPath);
    const now = Date.now();
    const due = this.decls().filter((decl) => {
      const existing = stored.rows[decl.id];
      return (force || !existing || now - existing.checkedAt > this.everyS * 1000)
        && this.probes[decl.id] !== undefined;
    });
    await Promise.all(due.map(async (decl) => {
      const existing = stored.rows[decl.id];
      {
        const probe = this.probes[decl.id];
        if (probe) {
          const result = await probe();
          const wasDown = existing?.status === 'down' || existing?.status === 'off';
          const nowUp = result.status === 'ok';
          stored.rows[decl.id] = {
            id: decl.id, latencyMs: result.latencyMs, status: result.status, checkedAt: now,
            since: (wasDown && nowUp) ? (existing?.since ?? now) : (existing?.since ?? now),
            lastHealthyAt: nowUp ? now : (existing?.lastHealthyAt ?? null),
            retryCount: nowUp ? 0 : (existing?.retryCount ?? 0) + 1,
            ...(result.desc !== undefined ? { desc: result.desc } : {}),
            ...(result.detail !== undefined ? { detail: result.detail } : {}),
            ...(result.scope !== undefined ? { scope: result.scope } : {}),
            ...(result.mcpState !== undefined ? { mcpState: result.mcpState } : {}),
            ...(result.lastError !== undefined ? { lastError: result.lastError } : {}),
          };
        }
      }
    }));
    writeStored(this.configPath, stored);
    const dependents = this.dependentsByIntegration();
    const items = narrateIntegrations(this.decls().map((decl) =>
      toIntegration(decl, stored.rows[decl.id], dependents[decl.id] ?? [], Boolean(this.reconnects[decl.id]))),
      this.deps.narrator ?? null);
    return { items, checkedAt: now, everyS: this.everyS };
  }

  async check(id: string): Promise<IntegrationsResponse> {
    const probe = this.probes[id];
    const stored = readStored(this.configPath);
    if (probe) {
      const result = await probe();
      const existing = stored.rows[id];
      const nowUp = result.status === 'ok';
      stored.rows[id] = {
        id, latencyMs: result.latencyMs, status: result.status, checkedAt: Date.now(),
        since: existing?.since ?? Date.now(),
        lastHealthyAt: nowUp ? Date.now() : (existing?.lastHealthyAt ?? null),
        retryCount: nowUp ? 0 : (existing?.retryCount ?? 0) + 1,
        ...(result.desc !== undefined ? { desc: result.desc } : {}),
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        ...(result.scope !== undefined ? { scope: result.scope } : {}),
        ...(result.mcpState !== undefined ? { mcpState: result.mcpState } : {}),
        ...(result.lastError !== undefined ? { lastError: result.lastError } : {}),
      };
      writeStored(this.configPath, stored);
    }
    return this.list(false);
  }

  /** W3's connect route calls this as an MCP login attempt moves from `connecting` to a
   *  terminal state. Merges the patch into the stored row (keeping `latencyMs`/`desc`/
   *  `scope`/etc. as they were), stamps `checkedAt`, and re-reads the list -- the same
   *  shape `check()` above already writes, minus running a probe first. Never accepts a
   *  `link`/URL field: the login link the connect route captures lives only in that
   *  route's own in-memory attempt record and never reaches this method, so it can never
   *  reach the stored row, a journal entry, or a published event through this path. */
  async applyConnectResult(
    id: string, patch: { mcpState?: McpConnState; lastError?: string; status?: IntegrationStatus },
  ): Promise<IntegrationsResponse> {
    const stored = readStored(this.configPath);
    const existing = stored.rows[id];
    const nowUp = patch.status === 'ok';
    stored.rows[id] = {
      id,
      latencyMs: existing?.latencyMs ?? null,
      status: patch.status ?? existing?.status ?? 'checking',
      checkedAt: Date.now(),
      since: existing?.since ?? Date.now(),
      lastHealthyAt: nowUp ? Date.now() : (existing?.lastHealthyAt ?? null),
      retryCount: nowUp ? 0 : (existing?.retryCount ?? 0) + (patch.status ? 1 : 0),
      ...(existing?.desc !== undefined ? { desc: existing.desc } : {}),
      ...(existing?.detail !== undefined ? { detail: existing.detail } : {}),
      ...(existing?.scope !== undefined ? { scope: existing.scope } : {}),
      ...(patch.mcpState !== undefined ? { mcpState: patch.mcpState } : (existing?.mcpState !== undefined ? { mcpState: existing.mcpState } : {})),
      ...(patch.lastError !== undefined ? { lastError: patch.lastError } : {}),
    };
    writeStored(this.configPath, stored);
    return this.list(false);
  }

  async reconnect(id: string): Promise<ReconnectResponse> {
    const decl = this.decls().find((d) => d.id === id);
    const steps = [
      { text: 'open sso', done: false },
      { text: 'verify', done: false },
      { text: 'resume lanes', done: false },
    ];
    const reconnectFn = this.reconnects[id];
    if (!reconnectFn) {
      const list = await this.list(false);
      const integration = list.items.find((item) => item.id === id) ?? toIntegration(
        decl ?? { id, kind: 'conn', name: id, desc: '', reconnectLabel: null }, undefined, [], false,
      );
      // W3: the honest answer. The old text read as a bug in the row; this one names
      // the row and the slice that will wire it, and the row hides its connect control
      // entirely (`canConnect: false`) so nobody has to click to find out.
      return { ok: false, integration, steps, message: `failed: no connect action for ${id} yet (S3)`, jid: null };
    }
    steps[0]!.done = true;
    await reconnectFn();
    steps[1]!.done = true;
    const after = await this.check(id);
    const integration = after.items.find((item) => item.id === id)!;
    steps[2]!.done = integration.status === 'ok';
    const { jid } = recordAction(this.deps.journalPath, this.deps.ledger, {
      kind: 'reconnect', text: `reconnected ${id}: now ${integration.status}`, undo: null, extra: { integration: id },
    });
    if (integration.status === 'ok') {
      appendOnce(this.deps.journalPath, { event: 'blocker.cleared', actor: 'console', reason: id });
    }
    return {
      ok: integration.status === 'ok', integration, steps,
      message: integration.status === 'ok' ? `${id} is back up` : `${id} is still ${integration.status}`,
      jid,
    };
  }
}
