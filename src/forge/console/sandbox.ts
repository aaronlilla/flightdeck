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
import type { LaneSandbox } from '../../shared/console-model.js';

export const SANDBOX_LOG_LINES = 40;

function packetForRun(chain: Map<string, ChainPacketState>, run: string): ChainPacketState | undefined {
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
  return { id: run, path, branch, pid, sessionId };
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
