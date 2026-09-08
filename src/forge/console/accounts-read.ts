/**
 * `GET /accounts`: the registry, every account's window state and attribution folded
 * from the journal, and the Codex ledger, in the one shape the Accounts view renders.
 *
 * Read only. Nothing here opens a credential file or starts a login; the only way an
 * account is ever checked is the probe's SDK usage call (`accounts-probe.ts`), and
 * this route reports what that journaled.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { buildAccountsBoard } from '../accounts-board.js';
import { launchAccountId, loadAccounts } from '../accounts.js';
import { readProbeEnv } from '../accounts-probe.js';
import type { FleetState } from '../journal.js';
import type { AccountsResponse } from '../../shared/console-model.js';

/**
 * Where `codex_call.py` keeps its ledger. `FORGE_CODEX_LEDGER` names it outright;
 * otherwise it is derived from `FORGE_CODEX_CALL` (the tool's command prefix), which
 * ends in the script's path: the ledger sits at `../.goal-runs/codex/ledger.jsonl`
 * from the script's directory. Null when neither is set, and the Codex row then says
 * it has no ledger to read.
 */
export function codexLedgerPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env['FORGE_CODEX_LEDGER'];
  if (explicit) return explicit;
  const call = env['FORGE_CODEX_CALL'];
  if (!call) return null;
  const script = call.split(/\s+/).find((part) => /codex_call\.py$/i.test(part));
  if (!script) return null;
  return join(dirname(script), '..', '.goal-runs', 'codex', 'ledger.jsonl');
}

export function readCodexLedgerLines(path: string | null): string[] {
  if (!path || !existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return [];
  }
}

export interface AccountsReadInput {
  fleet: FleetState;
  now: number;
  env?: NodeJS.ProcessEnv;
  accountsPath?: string;
}

export function computeAccounts(input: AccountsReadInput): AccountsResponse {
  const env = input.env ?? process.env;
  const registry = input.accountsPath ? loadAccounts(input.accountsPath) : loadAccounts();
  const probe = readProbeEnv(env);
  const board = buildAccountsBoard({
    accounts: registry.accounts,
    fleet: input.fleet,
    codexLedgerLines: readCodexLedgerLines(codexLedgerPath(env)),
    now: input.now,
    launchAccount: launchAccountId(registry),
  });
  const lastProbe = [...input.fleet.events].reverse().find((row) => row.event === 'account.probe');
  return {
    ...board,
    registryPath: registry.path,
    registrySource: registry.source,
    registryError: registry.error ?? null,
    homeDir: homedir(),
    probe: { on: probe.enabled, everySeconds: probe.everySeconds, lastAt: lastProbe?.at ?? null },
  };
}
