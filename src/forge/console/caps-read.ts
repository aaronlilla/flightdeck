/**
 * `GET /caps`: the Governor's budget block, plus the per-run overrides the console
 * itself has written (S3's `POST /caps` and `POST /run/:id/cap`), folded into the one
 * shape the caps sheet renders.
 */
import { existsSync, readFileSync } from 'node:fs';

import type { GovernorBudget } from '../policy.js';
import type { Caps } from '../../shared/console-model.js';

/** `GovernorBudget` carries no `hardUsd` field of its own -- the policy file may still
 *  set one (a fleet-wide ceiling above which no cap, daily or per-run, may ever be
 *  raised), read here as a loose field rather than widening the shared type for one
 *  consumer. Absent, it defaults to five times the daily cap, per the brief. */
export function hardUsdFor(governor: GovernorBudget & { hardUsd?: number }): number {
  if (typeof governor.hardUsd === 'number') return governor.hardUsd;
  if (!Number.isFinite(governor.dailyUsd)) return Number.POSITIVE_INFINITY;
  return governor.dailyUsd * 5;
}

export interface CapsOverrides {
  dailyUsd?: number;
  runUsd?: number;
  perRun?: Record<string, number>;
}

export function capsOverridesPath(forgeHomeDir: string): string {
  return `${forgeHomeDir}/console/caps.json`;
}

export function readCapsOverrides(path: string): CapsOverrides {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CapsOverrides;
  } catch {
    return {};
  }
}

export interface CapsInput {
  governor: GovernorBudget & { hardUsd?: number };
  /** The `implement` class's per-run figure, the default `runUsd` falls back to when
   *  the console has set no override of its own. */
  implementClassName: string;
  overrides: CapsOverrides;
  spentTodayUsd: number;
  /** `true` when the policy file carries a `governor` block at all -- enforcement reads
   *  as `'off'` for an older fixture with none, never as a crash. */
  governorConfigured: boolean;
}

export function computeCaps(input: CapsInput): Caps {
  const hardUsd = hardUsdFor(input.governor);
  const dailyUsd = input.overrides.dailyUsd ?? input.governor.dailyUsd;
  const defaultRunUsd = input.governor.usdPerRun[input.implementClassName] ?? 0;
  const runUsd = input.overrides.runUsd ?? defaultRunUsd;
  return {
    dailyUsd,
    runUsd,
    hardUsd,
    enforcement: input.governorConfigured ? 'on' : 'off',
    spentTodayUsd: input.spentTodayUsd,
    overrides: input.overrides.perRun ?? {},
  };
}
