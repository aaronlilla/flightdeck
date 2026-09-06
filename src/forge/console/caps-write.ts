/**
 * `POST /caps`: the daily and per-run caps Settings lets an operator edit.
 *
 * FD-7 (2026-09-06): this used to write straight into the model-policy file's own
 * `governor` block, on the premise that editing the file the Governor already enforces
 * against is what makes a new cap actually bind. That premise cost a tracked file: a
 * smoke server running from a worktree wrote a real edit into that worktree's own
 * `src/forge/model-policy.json`, and the live server runs from the main checkout, where
 * the same write would dirty a tracked file and fight the next `git pull`. Every console
 * cap now lives in `~/.forge/console/caps.json` as an override instead
 * (`caps-read.ts`'s `CapsOverrides`); `policy.ts`'s `effectiveGovernorBudget` is what
 * makes that override actually bind at admission, not a write to the policy file itself.
 * This module never opens `model-policy.json` for writing.
 */
import { forgeHome } from '../paths.js';
import { governorBudget, policyPath } from '../policy.js';
import { recordAction, type ActionsLedger } from './actions-ledger.js';
import {
  capsOverridesPath, computeCaps, effectiveHardUsd, readCapsOverrides, writeCapsOverrides,
  type CapsOverrides,
} from './caps-read.js';
import type { Caps } from '../../shared/console-model.js';

export interface CapsWriteDeps {
  journalPath: string;
  ledger: ActionsLedger;
  /** Where the Governor's own defaults come from. Read-only: never written here. */
  policyPath?: string;
  /** `~/.forge/console/caps.json`. The one file this module writes. */
  overridesPath?: string;
  spentTodayUsd: () => number;
}

function resolvedPolicyPath(deps: Pick<CapsWriteDeps, 'policyPath'>): string {
  return deps.policyPath ?? policyPath();
}

function resolvedOverridesPath(deps: Pick<CapsWriteDeps, 'overridesPath'>): string {
  return deps.overridesPath ?? capsOverridesPath(forgeHome());
}

/**
 * `governor.hardUsd`, computing and writing it into `~/.forge/console/caps.json` (as 5x
 * the *effective* daily cap -- a console override of `dailyUsd`, when one exists, moves
 * this too) the first time neither the policy file nor a console override declares one,
 * rather than recomputing it fresh, and invisibly, on every single `GET /caps`. A value
 * only ever held in memory is not a number FD-7 can point at, and a value that silently
 * moved every time `dailyUsd` changed would be a worse trap than one that has to be
 * edited on purpose. Written once, it survives a later `dailyUsd` edit undisturbed, the
 * same way a person who actually typed a number would expect.
 *
 * Answers positive infinity, and writes nothing, when the effective daily cap itself is
 * unbounded (`5 * Infinity` is not a number `caps.json` can hold) -- there is nothing to
 * make stable when nothing is capped at all.
 */
export function ensureHardUsd(policyFilePath: string, overridesPath: string): number {
  const overrides = readCapsOverrides(overridesPath);
  if (typeof overrides.hardUsd === 'number') return overrides.hardUsd;
  const governor = governorBudget(policyFilePath);
  if (typeof governor.hardUsd === 'number') return governor.hardUsd;
  const dailyUsd = overrides.dailyUsd ?? governor.dailyUsd;
  if (!Number.isFinite(dailyUsd)) return Number.POSITIVE_INFINITY;
  const hardUsd = dailyUsd * 5;
  writeCapsOverrides(overridesPath, { ...overrides, hardUsd });
  return hardUsd;
}

export type CapsWriteResponse = { status: number; body: Caps | { error: string; hardUsd: number } };

/**
 * `runUsd` is written as the console's own override, read back wherever `implement`'s
 * per-run figure would otherwise apply -- the class most consoles caps ever mean in
 * practice. It never touches the policy file's own `usdPerRun` map.
 */
export async function writeCaps(
  body: { dailyUsd?: number; runUsd?: number } | null, deps: CapsWriteDeps,
): Promise<CapsWriteResponse> {
  const policyFilePath = resolvedPolicyPath(deps);
  const overridesPath = resolvedOverridesPath(deps);
  const governor = governorBudget(policyFilePath);
  const overrides = readCapsOverrides(overridesPath);
  const implementClassName = 'implement';
  const hardUsd = effectiveHardUsd(governor, overrides);

  if (body?.dailyUsd !== undefined && body.dailyUsd > hardUsd) {
    return { status: 422, body: { error: `$${body.dailyUsd} is above the org hard limit of $${hardUsd}`, hardUsd } };
  }
  if (body?.runUsd !== undefined && body.runUsd > hardUsd) {
    return { status: 422, body: { error: `$${body.runUsd} is above the org hard limit of $${hardUsd}`, hardUsd } };
  }

  const previous = { dailyUsd: overrides.dailyUsd ?? null, runUsd: overrides.runUsd ?? null };
  const updated: CapsOverrides = { ...overrides };
  if (body?.dailyUsd !== undefined) updated.dailyUsd = body.dailyUsd;
  if (body?.runUsd !== undefined) updated.runUsd = body.runUsd;
  writeCapsOverrides(overridesPath, updated);

  const nextDaily = updated.dailyUsd ?? governor.dailyUsd;
  const nextRun = updated.runUsd ?? governor.usdPerRun[implementClassName] ?? governor.usdPerRun['default'];
  recordAction(deps.journalPath, deps.ledger, {
    kind: 'caps', text: `daily cap set to $${nextDaily}${body?.runUsd !== undefined ? `, run cap to $${nextRun}` : ''}`,
    undo: { kind: 'restore-caps', payload: { dailyUsd: previous.dailyUsd, runUsd: previous.runUsd } },
  });

  const governorConfigured = Number.isFinite(governor.dailyUsd) || Object.keys(governor.usdPerRun).length > 0;
  const after: Caps = computeCaps({
    governor, implementClassName, overrides: updated, spentTodayUsd: deps.spentTodayUsd(), governorConfigured,
  });
  return { status: 200, body: after };
}

/** The undo executor `restore-caps` in `command.ts`'s undo dispatcher calls: puts
 *  `dailyUsd`/`runUsd` back to whatever they were before the write being undone -- `null`
 *  meaning no override existed, which removes the key entirely rather than writing
 *  `null` into the file. */
export function restoreCaps(
  previous: { dailyUsd: number | null; runUsd: number | null }, overridesPath?: string,
): void {
  const path = overridesPath ?? capsOverridesPath(forgeHome());
  const overrides = readCapsOverrides(path);
  const updated: CapsOverrides = { ...overrides };
  if (previous.dailyUsd === null) delete updated.dailyUsd;
  else updated.dailyUsd = previous.dailyUsd;
  if (previous.runUsd === null) delete updated.runUsd;
  else updated.runUsd = previous.runUsd;
  writeCapsOverrides(path, updated);
}
