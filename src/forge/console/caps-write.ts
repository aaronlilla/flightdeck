/**
 * `POST /caps`: the daily and per-run token caps Settings lets an operator edit.
 *
 * FD-7 (2026-09-06): this used to write straight into the model-policy file's own
 * `governor` block, on the premise that editing the file the Governor already enforces
 * against is what makes a new cap actually bind. That premise cost a tracked file: a
 * smoke server running from a worktree wrote a real edit into that worktree's own
 * `src/forge/model-policy.json`, and the live server runs from the main checkout, where
 * the same write would dirty a tracked file and fight the next `git pull`. Every console
 * cap now lives in `~/.forge/console/caps.json` as an override instead
 * (`caps-read.ts`'s `CapsOverrides`). This module never opens `model-policy.json` at all,
 * for reading or writing: the policy's own `governor` block prices a run in dollars this
 * flat-subscription fleet never actually spends, and there is no honest exchange rate
 * from that figure into a token count, so a token cap is either something the operator
 * set here or it does not exist yet.
 */
import { forgeHome } from '../paths.js';
import { recordAction, type ActionsLedger } from './actions-ledger.js';
import {
  capsOverridesPath, computeCaps, effectiveHardTokens, readCapsOverrides, writeCapsOverrides,
  type CapsOverrides,
} from './caps-read.js';
import type { Caps } from '../../shared/console-model.js';

export interface CapsWriteDeps {
  journalPath: string;
  ledger: ActionsLedger;
  /** `~/.forge/console/caps.json`. The one file this module writes. */
  overridesPath?: string;
  tokensToday: () => number;
  /** Whether the policy file declares a `governor` block at all -- purely the caps
   *  sheet's on/off indicator, never a source for any of the token figures below.
   *  Defaults to `false` (enforcement reads "off") for a caller that does not pass it. */
  governorConfigured?: () => boolean;
}

function resolvedOverridesPath(deps: Pick<CapsWriteDeps, 'overridesPath'>): string {
  return deps.overridesPath ?? capsOverridesPath(forgeHome());
}

/**
 * The org hard token limit, computing and writing it into `~/.forge/console/caps.json`
 * (as 5x the daily cap) the first time no console override declares one, rather than
 * recomputing it fresh, and invisibly, on every single `GET /caps`. A value only ever
 * held in memory is not a number FD-7 can point at, and a value that silently moved
 * every time `dailyTokens` changed would be a worse trap than one that has to be edited
 * on purpose. Written once, it survives a later `dailyTokens` edit undisturbed, the same
 * way a person who actually typed a number would expect.
 *
 * Writes nothing when there is no daily cap to derive one from -- `5 * Infinity` is not
 * a number `caps.json` can hold, and there is nothing to make stable when nothing is
 * capped at all.
 */
export function ensureHardTokens(overridesPath: string): number {
  const overrides = readCapsOverrides(overridesPath);
  const hardTokens = effectiveHardTokens(overrides);
  if (typeof overrides.hardTokens === 'number' || !Number.isFinite(hardTokens)) return hardTokens;
  writeCapsOverrides(overridesPath, { ...overrides, hardTokens });
  return hardTokens;
}

export type CapsWriteResponse = { status: number; body: Caps | { error: string; hardTokens: number } };

/**
 * `runTokens` is written as the console's own override, read back wherever a per-run
 * token figure would otherwise apply. It never touches `model-policy.json`.
 */
export async function writeCaps(
  body: { dailyTokens?: number; runTokens?: number } | null, deps: CapsWriteDeps,
): Promise<CapsWriteResponse> {
  const overridesPath = resolvedOverridesPath(deps);
  const overrides = readCapsOverrides(overridesPath);
  const hardTokens = effectiveHardTokens(overrides);

  if (body?.dailyTokens !== undefined && body.dailyTokens > hardTokens) {
    return { status: 422, body: { error: `${body.dailyTokens} tokens is above the org hard limit of ${hardTokens}`, hardTokens } };
  }
  if (body?.runTokens !== undefined && body.runTokens > hardTokens) {
    return { status: 422, body: { error: `${body.runTokens} tokens is above the org hard limit of ${hardTokens}`, hardTokens } };
  }

  const previous = { dailyTokens: overrides.dailyTokens ?? null, runTokens: overrides.runTokens ?? null };
  const updated: CapsOverrides = { ...overrides };
  if (body?.dailyTokens !== undefined) updated.dailyTokens = body.dailyTokens;
  if (body?.runTokens !== undefined) updated.runTokens = body.runTokens;
  writeCapsOverrides(overridesPath, updated);

  const nextDaily = updated.dailyTokens ?? Number.POSITIVE_INFINITY;
  const nextRun = updated.runTokens ?? Number.POSITIVE_INFINITY;
  recordAction(deps.journalPath, deps.ledger, {
    kind: 'caps',
    text: `daily cap set to ${nextDaily} tokens${body?.runTokens !== undefined ? `, run cap to ${nextRun} tokens` : ''}`,
    undo: { kind: 'restore-caps', payload: { dailyTokens: previous.dailyTokens, runTokens: previous.runTokens } },
  });

  const after: Caps = computeCaps({
    overrides: updated, tokensToday: deps.tokensToday(), governorConfigured: deps.governorConfigured?.() ?? false,
  });
  return { status: 200, body: after };
}

/** The undo executor `restore-caps` in `command.ts`'s undo dispatcher calls: puts
 *  `dailyTokens`/`runTokens` back to whatever they were before the write being undone --
 *  `null` meaning no override existed, which removes the key entirely rather than
 *  writing `null` into the file. */
export function restoreCaps(
  previous: { dailyTokens: number | null; runTokens: number | null }, overridesPath?: string,
): void {
  const path = overridesPath ?? capsOverridesPath(forgeHome());
  const overrides = readCapsOverrides(path);
  const updated: CapsOverrides = { ...overrides };
  if (previous.dailyTokens === null) delete updated.dailyTokens;
  else updated.dailyTokens = previous.dailyTokens;
  if (previous.runTokens === null) delete updated.runTokens;
  else updated.runTokens = previous.runTokens;
  writeCapsOverrides(path, updated);
}
