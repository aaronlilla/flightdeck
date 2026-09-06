/**
 * `GET /caps`: whatever the console itself has overridden (`POST /caps`,
 * `POST /run/:id/cap`), folded into the one shape the caps sheet renders.
 *
 * Every figure here is a token count, never a dollar one. The policy file's own
 * `governor` block (`dailyUsd`/`usdPerRun`/`hardUsd` in `policy.ts`) prices a run
 * against a list rate for a real bill this flat-subscription fleet never actually
 * pays, and there is no honest exchange rate from that dollar figure to a token count
 * -- it would be a made-up conversion wearing a number's shape. So a cap this module
 * has not been told directly by the operator reads as uncapped (`Infinity`), never a
 * guess derived from the policy's dollar defaults. `governorConfigured` still crosses
 * over from `policy.ts` (via `reads.ts`) as a bare on/off signal for the enforcement
 * indicator -- the one fact from that file this module still needs.
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

import type { Caps } from '../../shared/console-model.js';

export interface CapsOverrides {
  dailyTokens?: number;
  runTokens?: number;
  hardTokens?: number;
  perRun?: Record<string, number>;
}

export function capsOverridesPath(forgeHomeDir: string): string {
  return join(forgeHomeDir, 'console', 'caps.json');
}

/**
 * Reads `caps.json`, migrating a file still shaped in dollars (`dailyUsd`, `runUsd`,
 * `hardUsd`, `perRun` values) forward rather than crashing on it: the old dollar-named
 * keys carry no honest token equivalent, so they are dropped -- an operator's dollar
 * cap silently becomes no cap at all rather than a token cap a thousand times too small
 * to ever mean anything. A `dailyTokens`/`runTokens`/`hardTokens`/`perRun` already in
 * the new shape reads straight through unchanged.
 */
export function readCapsOverrides(path: string): CapsOverrides {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    // A file an older console build wrote in dollars carries `dailyUsd`/`runUsd`/
    // `hardUsd` -- keys this shape no longer has at all. `perRun`'s own key name never
    // changed, so a legacy file's per-run figures are dollars too and get dropped along
    // with the rest of it, rather than kept and misread as a token count a thousand
    // times too small.
    const isLegacyShape = ['dailyUsd', 'runUsd', 'hardUsd'].some((key) => typeof parsed[key] === 'number');
    if (isLegacyShape) return {};
    const overrides: CapsOverrides = {};
    if (typeof parsed['dailyTokens'] === 'number') overrides.dailyTokens = parsed['dailyTokens'];
    if (typeof parsed['runTokens'] === 'number') overrides.runTokens = parsed['runTokens'];
    if (typeof parsed['hardTokens'] === 'number') overrides.hardTokens = parsed['hardTokens'];
    if (parsed['perRun'] && typeof parsed['perRun'] === 'object') {
      overrides.perRun = Object.fromEntries(
        Object.entries(parsed['perRun'] as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
    }
    return overrides;
  } catch {
    return {};
  }
}

/** The one place anything under `src/forge/console/` writes `caps.json` -- every write
 *  (`POST /caps`, a per-run cap, `ensureHardTokens`, an undo) goes through this, never a
 *  bespoke `writeFileSync` of its own, so the file's shape stays one thing. */
export function writeCapsOverrides(path: string, value: CapsOverrides): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** The org hard limit as the console actually enforces it: a console override when one
 *  is set, otherwise 5x the effective daily cap -- unless that daily cap is itself
 *  uncapped, in which case 5x infinity is still infinity, not a number `caps.json` can
 *  hold. */
export function effectiveHardTokens(overrides: CapsOverrides): number {
  if (typeof overrides.hardTokens === 'number') return overrides.hardTokens;
  const dailyTokens = overrides.dailyTokens ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(dailyTokens)) return Number.POSITIVE_INFINITY;
  return dailyTokens * 5;
}

export interface CapsInput {
  overrides: CapsOverrides;
  tokensToday: number;
  /** `true` when the policy file carries a `governor` block at all -- enforcement reads
   *  as `'off'` for an older fixture with none, never as a crash. Purely informational:
   *  it never changes any of the token figures below, only the on/off indicator. */
  governorConfigured: boolean;
}

export function computeCaps(input: CapsInput): Caps {
  const dailyTokens = input.overrides.dailyTokens ?? Number.POSITIVE_INFINITY;
  const runTokens = input.overrides.runTokens ?? Number.POSITIVE_INFINITY;
  const hardTokens = effectiveHardTokens(input.overrides);
  return {
    dailyTokens,
    runTokens,
    hardTokens,
    enforcement: input.governorConfigured ? 'on' : 'off',
    tokensToday: input.tokensToday,
    overrides: input.overrides.perRun ?? {},
    sources: {
      dailyTokens: input.overrides.dailyTokens !== undefined ? 'console' : 'policy',
      runTokens: input.overrides.runTokens !== undefined ? 'console' : 'policy',
      hardTokens: input.overrides.hardTokens !== undefined ? 'console' : 'policy',
    },
  };
}
