/**
 * `POST /caps`: the daily and per-run caps Settings lets an operator edit, written into
 * the same `governor` block of the model-policy file `governorBudget()` already reads
 * (`policy.ts`). There is no separate console config for this half of caps -- editing
 * the file the Governor already enforces against is what makes a new daily cap actually
 * bind the next launch, not just repaint a number on the board.
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { policyPath, type GovernorBudget, type Policy } from '../policy.js';
import { recordAction, type ActionsLedger } from './actions-ledger.js';
import type { Caps } from '../../shared/console-model.js';

export interface CapsWriteDeps {
  journalPath: string;
  ledger: ActionsLedger;
  policyPath?: string;
  spentTodayUsd: () => number;
}

export function hardUsdOf(governor: GovernorBudget | undefined): number {
  if (governor?.hardUsd !== undefined) return governor.hardUsd;
  return (governor?.dailyUsd ?? 0) * 5;
}

function readPolicy(path: string): Policy {
  return JSON.parse(readFileSync(path, 'utf8')) as Policy;
}

function writePolicy(path: string, policy: Policy): void {
  writeFileSync(path, `${JSON.stringify(policy, null, 2)}\n`, 'utf8');
}

export type CapsWriteResponse = { status: number; body: Caps | { error: string; hardUsd: number } };

/**
 * `runUsd` is written to the `implement` class's own ceiling (the class most consoles
 * caps ever mean in practice) and mirrored to `default`, so a reader of `usdPerRun` that
 * checks either key sees the console's edit.
 */
export async function writeCaps(
  body: { dailyUsd?: number; runUsd?: number } | null, deps: CapsWriteDeps,
): Promise<CapsWriteResponse> {
  const path = deps.policyPath ?? policyPath();
  const policy = readPolicy(path);
  const governor: GovernorBudget = policy.governor ?? { dailyUsd: Number.POSITIVE_INFINITY, usdPerRun: {} };
  const hardUsd = hardUsdOf(governor);

  const nextDaily = body?.dailyUsd ?? governor.dailyUsd;
  const nextRun = body?.runUsd ?? governor.usdPerRun['implement'] ?? governor.usdPerRun['default'];

  if (body?.dailyUsd !== undefined && body.dailyUsd > hardUsd) {
    return { status: 422, body: { error: `$${body.dailyUsd} is above the org hard limit of $${hardUsd}`, hardUsd } };
  }
  if (body?.runUsd !== undefined && body.runUsd > hardUsd) {
    return { status: 422, body: { error: `$${body.runUsd} is above the org hard limit of $${hardUsd}`, hardUsd } };
  }

  const previous: { dailyUsd: number; runUsd: number | undefined } = {
    dailyUsd: governor.dailyUsd, runUsd: governor.usdPerRun['implement'] ?? governor.usdPerRun['default'],
  };

  const updated: GovernorBudget = {
    ...governor,
    dailyUsd: nextDaily,
    usdPerRun: {
      ...governor.usdPerRun,
      ...(nextRun !== undefined ? { implement: nextRun, default: nextRun } : {}),
    },
  };
  writePolicy(path, { ...policy, governor: updated });

  const { jid } = recordAction(deps.journalPath, deps.ledger, {
    kind: 'caps', text: `daily cap set to $${nextDaily}${nextRun !== undefined ? `, run cap to $${nextRun}` : ''}`,
    undo: { kind: 'restore-caps', payload: { dailyUsd: previous.dailyUsd, runUsd: previous.runUsd ?? null } },
  });

  return {
    status: 200,
    body: {
      dailyUsd: nextDaily,
      runUsd: nextRun ?? 0,
      hardUsd,
      enforcement: policy.governor ? 'on' : 'off',
      spentTodayUsd: deps.spentTodayUsd(),
      overrides: {},
    },
  };
}

/** The undo executor `restore-caps` in `command.ts`'s undo dispatcher calls. */
export function restoreCaps(
  previous: { dailyUsd: number; runUsd: number | null }, path?: string,
): void {
  const resolved = path ?? policyPath();
  const policy = readPolicy(resolved);
  const governor: GovernorBudget = policy.governor ?? { dailyUsd: previous.dailyUsd, usdPerRun: {} };
  const updated: GovernorBudget = {
    ...governor,
    dailyUsd: previous.dailyUsd,
    usdPerRun: {
      ...governor.usdPerRun,
      ...(previous.runUsd !== null ? { implement: previous.runUsd, default: previous.runUsd } : {}),
    },
  };
  writePolicy(resolved, { ...policy, governor: updated });
}
