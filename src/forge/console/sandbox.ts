/**
 * `GET /run/:id/sandbox`: what the prototype calls a sandbox is a git worktree here --
 * the nearest real thing this runner has. Path and branch come from the run's own chain
 * provision row, pid and session id from its registry row, and the log tail from the
 * newest file under its run directory, when one exists.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { ChainPacketState } from '../chain.js';
import type { RegistryRecord } from '../registry.js';
import type { LaneSandbox, SandboxLogLine, SandboxLogSeverity } from '../../shared/console-model.js';

export const SANDBOX_LOG_LINES = 40;

/** Exported so `journal-narrative.ts` can find the same packet this module already
 *  walks the chain for, rather than re-implementing the lookup. */
export function packetForRun(chain: Map<string, ChainPacketState>, run: string): ChainPacketState | undefined {
  for (const row of chain.values()) {
    if (row.launched?.runKey === run || row.packetId === run) return row;
  }
  return undefined;
}

export function computeSandbox(
  run: string, chain: Map<string, ChainPacketState>, registryRow: RegistryRecord | undefined,
): LaneSandbox | null {
  const packet = packetForRun(chain, run);
  const path = packet?.provisioned?.worktreePath ?? null;
  const branch = packet?.provisioned?.branch ?? null;
  const pid = registryRow?.pid ?? null;
  const sessionId = registryRow?.sessionId ?? null;
  if (!path && !branch && !pid && !sessionId) return null;
  // No cloud sandbox exists here to name a region or instance type for, so these are
  // the closest real facts this machine can offer instead of the prototype's fabricated
  // `us-east-1` / `c6i.large` strings: this runs locally, on whatever this process's own
  // platform and architecture are.
  return { id: run, path, branch, pid, sessionId, region: 'local', instanceType: `${process.platform}/${process.arch}` };
}

/** The newest file directly under `runsDir()/<run>/`, or `undefined` when the run has no
 *  directory yet -- a fresh run whose first turn has not written anything down. */
export function newestLogFile(runDirPath: string): string | undefined {
  if (!existsSync(runDirPath)) return undefined;
  let newest: { name: string; mtime: number } | undefined;
  for (const name of readdirSync(runDirPath)) {
    const full = join(runDirPath, name);
    const stat = statSync(full);
    if (!stat.isFile()) continue;
    if (!newest || stat.mtimeMs > newest.mtime) newest = { name: full, mtime: stat.mtimeMs };
  }
  return newest?.name;
}

/** The last `SANDBOX_LOG_LINES` lines of `path`, or `[]` for a log that does not exist. */
export function tailLog(path: string | undefined, limit = SANDBOX_LOG_LINES): string[] {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - limit));
}

const ERROR_LOG_RE = /\b(error|fail(?:ed|ure)?|exception|fatal)\b/i;
const RETRY_LOG_RE = /\bretr(?:y|ying|ies)\b/i;
const PROGRESS_LOG_RE = /\b(running|installing|building|compiling|starting|provisioning)\b/i;

/** A real line's severity, read off its own text rather than a per-line field this
 *  runner's logs do not carry -- the closest real signal to the prototype's info/
 *  progress/retry/error coloring. */
export function classifyLogSeverity(line: string): SandboxLogSeverity {
  if (ERROR_LOG_RE.test(line)) return 'error';
  if (RETRY_LOG_RE.test(line)) return 'retry';
  if (PROGRESS_LOG_RE.test(line)) return 'progress';
  return 'info';
}

/** `tailLog`, with each line tagged by `classifyLogSeverity` -- what the sandbox sheet
 *  actually reads. */
export function tailLogWithSeverity(path: string | undefined, limit = SANDBOX_LOG_LINES): SandboxLogLine[] {
  return tailLog(path, limit).map((text) => ({ text, severity: classifyLogSeverity(text) }));
}
