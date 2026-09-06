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
import { consoleDir, recordAction, type ActionsLedger } from './actions-ledger.js';
import type { Integration, IntegrationsResponse, IntegrationStatus, ReconnectResponse } from '../../shared/console-model.js';

export function integrationsConfigPath(): string {
  return join(consoleDir(), 'integrations.json');
}

export interface ProbeResult {
  status: IntegrationStatus;
  latencyMs: number | null;
}

export type Probe = () => Promise<ProbeResult>;
export type Reconnect = () => Promise<void>;

interface IntegrationDecl {
  id: string;
  kind: 'conn' | 'mcp';
  name: string;
  desc: string;
  reconnectLabel: string | null;
}

async function timed(fn: () => Promise<boolean>, spawnFn?: RunRequest['spawnFn']): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const ok = await Promise.race([
      fn(),
      new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 5000); }),
    ]);
    return { status: ok ? 'ok' : 'off', latencyMs: ok ? Date.now() - started : null };
  } catch {
    return { status: 'off', latencyMs: null };
  }
}

function ghProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const result = await execRun({
      argv: ['gh', 'auth', 'status'], cwd: process.cwd(), owner: 'console-integrations-gh',
      cls: 'script', ...(spawnFn ? { spawnFn } : {}),
    });
    return result.returncode === 0;
  }, spawnFn);
}

function jiraProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const site = process.env['FORGE_JIRA_SITE'];
    const email = process.env['FORGE_JIRA_EMAIL'];
    const token = process.env['FORGE_JIRA_TOKEN'];
    if (!site || !email || !token) return false;
    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const response = await fetch(`https://${site}/rest/api/3/myself`, {
      headers: { authorization: `Basic ${auth}` },
    });
    return response.ok;
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
  return () => timed(async () => modelProviderProbeResult(), spawnFn);
}

function codexProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const result = await execRun({
      argv: ['codex', '--version'], cwd: process.cwd(), owner: 'console-integrations-codex',
      cls: 'script', ...(spawnFn ? { spawnFn } : {}),
    });
    return result.returncode === 0;
  }, spawnFn);
}

function awsProbe(spawnFn?: RunRequest['spawnFn']): Probe {
  return () => timed(async () => {
    const profile = process.env['FORGE_AWS_PROFILE'];
    if (!profile) return false;
    const result = await execRun({
      argv: ['aws', 'sts', 'get-caller-identity', '--profile', profile], cwd: process.cwd(),
      owner: 'console-integrations-aws', cls: 'script', ...(spawnFn ? { spawnFn } : {}),
    });
    return result.returncode === 0;
  }, spawnFn);
}

function mcpProbes(): Record<string, { decl: IntegrationDecl; probe: Probe }> {
  const claudeJson = join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '.', '.claude.json');
  if (!existsSync(claudeJson)) return {};
  let servers: Record<string, { url?: string }> = {};
  try {
    const parsed = JSON.parse(readFileSync(claudeJson, 'utf8')) as { mcpServers?: Record<string, { url?: string }> };
    servers = parsed.mcpServers ?? {};
  } catch {
    return {};
  }
  const out: Record<string, { decl: IntegrationDecl; probe: Probe }> = {};
  for (const [name, spec] of Object.entries(servers)) {
    const id = `mcp-${name}`;
    out[id] = {
      decl: { id, kind: 'mcp', name, desc: `MCP server ${name}`, reconnectLabel: null },
      probe: () => timed(async () => {
        if (!spec.url) return false;
        try {
          const response = await fetch(spec.url);
          return response.ok;
        } catch {
          return false;
        }
      }),
    };
  }
  return out;
}

export interface IntegrationsDeps {
  journalPath: string;
  ledger: ActionsLedger;
  configPath?: string;
  spawnFn?: RunRequest['spawnFn'];
  /** Overrides the whole probe table. A specimen always sets this, so no test here
   *  reaches a real process or the network. */
  probes?: Record<string, Probe>;
  reconnects?: Record<string, Reconnect>;
  everyS?: number;
}

const BUILTIN_DECLS: IntegrationDecl[] = [
  { id: 'github', kind: 'conn', name: 'GitHub', desc: 'gh CLI auth + rate limit', reconnectLabel: 'Reconnect via SSO' },
  { id: 'jira', kind: 'conn', name: 'Jira', desc: 'FORGE_JIRA_* credentials', reconnectLabel: 'Reconnect' },
  { id: 'model-provider', kind: 'conn', name: 'Model provider', desc: 'fleet login', reconnectLabel: 'Reconnect via SSO' },
  { id: 'codex', kind: 'conn', name: 'Codex', desc: 'codex CLI', reconnectLabel: 'Reconnect' },
  { id: 'aws', kind: 'conn', name: 'AWS', desc: 'FORGE_AWS_PROFILE via SSO', reconnectLabel: 'Reconnect via SSO' },
];

function defaultProbes(spawnFn?: RunRequest['spawnFn']): Record<string, Probe> {
  return {
    github: ghProbe(spawnFn),
    jira: jiraProbe(spawnFn),
    'model-provider': modelProviderProbe(spawnFn),
    codex: codexProbe(spawnFn),
    aws: awsProbe(spawnFn),
  };
}

const DEFAULT_RECONNECTS: Record<string, string[]> = {
  aws: ['aws', 'sso', 'login', '--profile', process.env['FORGE_AWS_PROFILE'] ?? ''],
  github: ['gh', 'auth', 'login', '--web'],
};

interface StoredRow {
  id: string;
  latencyMs: number | null;
  status: IntegrationStatus;
  checkedAt: number;
  since: number | null;
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

function toIntegration(decl: IntegrationDecl, row: StoredRow | undefined, dependents: string[]): Integration {
  const status = row?.status ?? 'checking';
  return {
    id: decl.id,
    kind: decl.kind,
    name: decl.name,
    desc: decl.desc,
    latencyMs: row?.latencyMs ?? null,
    status,
    checkedAt: row?.checkedAt ?? 0,
    since: row?.since ?? null,
    cause: status === 'down' ? `${decl.name} is not reachable` : null,
    effect: status === 'down' ? `lanes depending on ${decl.name} are blocked` : null,
    fix: status === 'down' ? (decl.reconnectLabel ?? 'Reconnect') : null,
    fixLabel: status === 'down' ? (decl.reconnectLabel ?? 'Reconnect') : null,
    dependents,
    step: null,
    links: {},
  };
}

export class IntegrationsRegistry {
  private readonly configPath: string;

  private readonly probes: Record<string, Probe>;

  private readonly reconnects: Record<string, Reconnect>;

  private readonly everyS: number;

  constructor(private readonly deps: IntegrationsDeps) {
    this.configPath = deps.configPath ?? integrationsConfigPath();
    this.probes = deps.probes ?? { ...defaultProbes(deps.spawnFn), ...Object.fromEntries(
      Object.entries(mcpProbes()).map(([id, entry]) => [id, entry.probe]),
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
    const dynamic = this.deps.probes ? [] : Object.values(mcpProbes()).map((entry) => entry.decl);
    return [...BUILTIN_DECLS, ...dynamic];
  }

  private dependentsOf(_id: string): string[] {
    // `blockedBy` (which lane is blocked on which integration) is computed by the reads
    // module from `run.blocked` reasons; this module only reports the integration side.
    return [];
  }

  async list(force = false): Promise<IntegrationsResponse> {
    const stored = readStored(this.configPath);
    const now = Date.now();
    for (const decl of this.decls()) {
      const existing = stored.rows[decl.id];
      const stale = !existing || now - existing.checkedAt > this.everyS * 1000;
      if (force || stale) {
        const probe = this.probes[decl.id];
        if (probe) {
          const result = await probe();
          const wasDown = existing?.status === 'down' || existing?.status === 'off';
          const nowUp = result.status === 'ok';
          stored.rows[decl.id] = {
            id: decl.id, latencyMs: result.latencyMs, status: result.status, checkedAt: now,
            since: (wasDown && nowUp) ? (existing?.since ?? now) : (existing?.since ?? now),
          };
        }
      }
    }
    writeStored(this.configPath, stored);
    const items = this.decls().map((decl) => toIntegration(decl, stored.rows[decl.id], this.dependentsOf(decl.id)));
    return { items, checkedAt: now, everyS: this.everyS };
  }

  async check(id: string): Promise<IntegrationsResponse> {
    const probe = this.probes[id];
    const stored = readStored(this.configPath);
    if (probe) {
      const result = await probe();
      stored.rows[id] = { id, latencyMs: result.latencyMs, status: result.status, checkedAt: Date.now(), since: stored.rows[id]?.since ?? Date.now() };
      writeStored(this.configPath, stored);
    }
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
        decl ?? { id, kind: 'conn', name: id, desc: '', reconnectLabel: null }, undefined, [],
      );
      return { ok: false, integration, steps, message: `not wired: no reconnect command declared for ${id}`, jid: null };
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
