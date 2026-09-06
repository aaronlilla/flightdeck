/**
 * `GET /caps`: the Governor's budget block, plus whatever the console itself has
 * overridden (`POST /caps`, `POST /run/:id/cap`), folded into the one shape the caps
 * sheet renders.
 *
 * FD-7 (2026-09-06): `POST /caps {"dailyUsd":450}` against a smoke server running from a
 * worktree changed that worktree's own tracked `src/forge/model-policy.json` (500 ->
 * 450) -- a live server runs from the main checkout, so the same write there would dirty
 * a tracked file and collide with the next pull. Every console cap, including the org
 * hard limit, now lives in `~/.forge/console/caps.json` instead: a real override under
 * `FORGE_HOME`, never a line in a file git tracks.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { GovernorBudget } from '../policy.js';
import type { Caps } from '../../shared/console-model.js';

/** `GovernorBudget` carries no `hardUsd` field of its own -- the policy file may still
 *  declare one by hand (a fleet-wide ceiling above which no cap, daily or per-run, may
 *  ever be raised), read here as a loose field rather than widening the shared type for
 *  one consumer. Absent, it defaults to five times the daily cap, per the brief. */
export function hardUsdFor(governor: GovernorBudget & { hardUsd?: number }): number {
  if (typeof governor.hardUsd === 'number') return governor.hardUsd;
  if (!Number.isFinite(governor.dailyUsd)) return Number.POSITIVE_INFINITY;
  return governor.dailyUsd * 5;
}

export interface CapsOverrides {
  dailyUsd?: number;
  runUsd?: number;
  hardUsd?: number;
  perRun?: Record<string, number>;
}

export function capsOverridesPath(forgeHomeDir: string): string {
  return join(forgeHomeDir, 'console', 'caps.json');
}

export function readCapsOverrides(path: string): CapsOverrides {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CapsOverrides;
  } catch {
    return {};
  }
}

/** The one place anything under `src/forge/console/` writes `caps.json` -- every write
 *  (`POST /caps`, a per-run cap, `ensureHardUsd`, an undo) goes through this, never a
 *  bespoke `writeFileSync` of its own, so the file's shape stays one thing. */
export function writeCapsOverrides(path: string, value: CapsOverrides): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The org hard limit as the console actually enforces it: a console override when one
 *  is set, otherwise `hardUsdFor` against the policy's own governor block computed at
 *  the *effective* daily cap (a console override of `dailyUsd`, when there is one, moves
 *  this too -- 5x a number nobody actually set as a limit is not the ceiling). */
export function effectiveHardUsd(governor: GovernorBudget & { hardUsd?: number }, overrides: CapsOverrides): number {
  if (typeof overrides.hardUsd === 'number') return overrides.hardUsd;
  const dailyUsd = overrides.dailyUsd ?? governor.dailyUsd;
  return hardUsdFor({ ...governor, dailyUsd });
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
  const dailyUsd = input.overrides.dailyUsd ?? input.governor.dailyUsd;
  const defaultRunUsd = input.governor.usdPerRun[input.implementClassName] ?? 0;
  const runUsd = input.overrides.runUsd ?? defaultRunUsd;
  const hardUsd = effectiveHardUsd(input.governor, input.overrides);
  return {
    dailyUsd,
    runUsd,
    hardUsd,
    enforcement: input.governorConfigured ? 'on' : 'off',
    spentTodayUsd: input.spentTodayUsd,
    overrides: input.overrides.perRun ?? {},
    sources: {
      dailyUsd: input.overrides.dailyUsd !== undefined ? 'console' : 'policy',
      runUsd: input.overrides.runUsd !== undefined ? 'console' : 'policy',
      hardUsd: input.overrides.hardUsd !== undefined ? 'console' : 'policy',
    },
  };
}
