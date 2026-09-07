/**
 * `GET /run/:id/pr`: the pull request a run's chain packet landed, or the one `gh` finds
 * on the run's own branch when the chain has not recorded one yet.
 *
 * Shelling out to `gh` on every board poll would make the board's own refresh the thing
 * that rate-limits GitHub, so a lookup is cached for 60 seconds under
 * `~/.forge/console/pr-cache.json`, keyed by run id.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ChainPacketState } from '../chain.js';
import type { LanePr } from '../../shared/console-model.js';

export const PR_CACHE_TTL_MS = 60_000;

interface CacheRow {
  pr: LanePr | null;
  at: number;
}

type Cache = Record<string, CacheRow>;

export function prCachePath(forgeHomeDir: string): string {
  return join(forgeHomeDir, 'console', 'pr-cache.json');
}

export function readPrCache(path: string): Cache {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Cache;
  } catch {
    return {};
  }
}

export function writePrCache(path: string, cache: Cache): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cache, null, 2), 'utf8');
}

/** The `gh pr list` shape this reads. Callers on Windows run this through a shell (the
 *  same `spawn`-needs-a-shell trap every other CLI call in this repo works around). */
export interface GhPrLookup {
  number: number;
  url: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export type GhLookupFn = (branch: string) => Promise<GhPrLookup | undefined>;

/** H1.3: `gh pr view --json isDraft,mergedAt,statusCheckRollup,title,headRefOid` --
 *  the PR's own state as a person reads it on GitHub, distinct from `GhPrLookup`'s file
 *  counts (which come from `gh pr list`). `headSha` is what an attestation is keyed by,
 *  never the branch name. */
export interface GhPrDetail {
  headSha: string;
  isDraft: boolean;
  merged: boolean;
  title: string;
  checks: 'success' | 'failure' | 'pending';
}

export type GhDetailLookupFn = (repo: string, pr: number) => Promise<GhPrDetail | undefined>;

/** H1.3: the council's own last verdict on this exact head, off the attestation the
 *  gate wrote to disk. `undefined` when no attestation exists yet for this (repo, pr,
 *  head) -- a PR the council has not reviewed reads as "no verdict yet", never a guess. */
export interface AttestationVerdict {
  verdict: string;
}

export type AttestationReaderFn = (repo: string, pr: number, head: string) => AttestationVerdict | undefined;

/** Finds a chain packet whose `launched.runKey` (or `packetId`, for a run launched
 *  directly under its own name) matches `run`. */
function packetForRun(chain: Map<string, ChainPacketState>, run: string): ChainPacketState | undefined {
  for (const row of chain.values()) {
    if (row.launched?.runKey === run || row.packetId === run) return row;
  }
  return undefined;
}

function fromGh(found: GhPrLookup): LanePr {
  return {
    no: found.number, url: found.url, files: found.changedFiles,
    add: found.additions, del: found.deletions, draft: found.isDraft,
  };
}

/**
 * `run`'s PR: from the chain row when it has already merged (no PR number is ever
 * folded onto `ChainPacketState`, so a merged row can only say a merge happened, not
 * which PR) -- so a merged packet with no `gh` lookup available answers `null` rather
 * than a guess. Otherwise asks `gh pr list --head <branch>` for the packet's branch,
 * through `lookup`, caching the answer for `PR_CACHE_TTL_MS`.
 */
export async function computeRunPr(
  run: string, chain: Map<string, ChainPacketState>, cache: Cache, now: number, lookup: GhLookupFn,
  detailLookup?: GhDetailLookupFn, attestationReader?: AttestationReaderFn,
): Promise<{ pr: LanePr | null; cache: Cache }> {
  const cached = cache[run];
  if (cached && now - cached.at < PR_CACHE_TTL_MS) return { pr: cached.pr, cache };

  const packet = packetForRun(chain, run);
  const branch = packet?.provisioned?.branch;
  if (!branch) return { pr: null, cache: { ...cache, [run]: { pr: null, at: now } } };

  const found = await lookup(branch);
  if (!found) return { pr: null, cache: { ...cache, [run]: { pr: null, at: now } } };

  let pr = fromGh(found);
  // H1.3: the PR's own state as a person reads it on GitHub -- its checks, the
  // council's last verdict on this head, and whether it has merged. Only fetched when
  // this call is wired with both lookups (production always is; a specimen that omits
  // either keeps the bare `fromGh` shape, per the existing test above).
  if (detailLookup && packet?.repo) {
    const detail = await detailLookup(packet.repo, found.number);
    if (detail) {
      const verdict = attestationReader?.(packet.repo, found.number, detail.headSha)?.verdict ?? null;
      pr = { ...pr, checks: detail.checks, merged: detail.merged, title: detail.title, verdict };
    } else {
      pr = { ...pr, checks: null, merged: null, title: null, verdict: null };
    }
  }
  return { pr, cache: { ...cache, [run]: { pr, at: now } } };
}
