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
  /** R-61 item 1: the repo this PR was last read against, carried alongside the PR fact
   *  itself so a lane whose queue item has since left the active queue (archived) still
   *  has somewhere to read a repo from for its one final re-check -- `lane.repo` itself
   *  is `null` the moment no queue item and no chain packet supplies it. Unset for a row
   *  written before this field existed; such a row gets no final re-check until its next
   *  ordinary (queue-item-present) write fills it in. */
  repo?: string | null;
  /** R-61 item 1: epoch ms of the one-shot re-check fired once a finished lane's queue
   *  item is gone (`ConsoleReads#scheduleFinalPrCheck`) -- once set, that lane is never
   *  re-checked again, whatever the re-check found. A terminal correction, not a new
   *  perpetual poll. */
  finalCheckAt?: number;
}

export type Cache = Record<string, CacheRow>;

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
  /** 2026-09-07: the PR's own description, for the ticket sheet's "what was done"
   *  summary. `null` for a PR with an empty body, or read through a caller that never
   *  asked `gh` for it (`fromGh`'s own `GhPrLookup` shape has no body field at all). */
  body?: string | null;
  /** Item 1: epoch ms off `gh`'s own `mergedAt`, when the PR has merged. `null` for one
   *  that has not (or that `gh` did not report a time for). */
  mergedAt?: number | null;
  /** R-61 item 2: `gh`'s own `state === 'CLOSED'` -- a PR closed without merging.
   *  Optional so a specimen that never asked `gh` for `state` (every test predating
   *  this field) still type-checks; a real `gh` read always sets it. */
  closed?: boolean;
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
      pr = { ...pr, checks: detail.checks, merged: detail.merged, title: detail.title, verdict, mergedAt: detail.mergedAt ?? null, closed: detail.closed ?? undefined };
    } else {
      pr = { ...pr, checks: null, merged: null, title: null, verdict: null };
    }
  }
  return { pr, cache: { ...cache, [run]: { pr, at: now } } };
}

/**
 * Item 7: a queue-sourced lane already carries its own `repo` and PR number straight
 * off the queue's own log the moment the item is routed and provisioned -- no chain
 * packet, and no `gh pr list --head <branch>` lookup, is needed to find the PR at all.
 * `computeRunPr` above answers `null` for exactly this case (it only ever looks at a
 * chain packet's `provisioned.branch`), which is why `checks`/`verdict`/`merged`/`title`
 * never arrived for a queue lane: nothing ever called the detail read for one. This
 * reads the detail (and the attestation on disk for the PR's head) directly off the
 * `repo`/`basic` the caller already has, and caches the answer under the same `run`-keyed
 * cache `computeRunPr` uses so both routes agree.
 */
export async function computeQueuePr(
  run: string, repo: string, basic: LanePr, cache: Cache, now: number,
  detailLookup: GhDetailLookupFn, attestationReader?: AttestationReaderFn,
): Promise<{ pr: LanePr; cache: Cache }> {
  const detail = await detailLookup(repo, basic.no);
  if (!detail) return { pr: basic, cache: { ...cache, [run]: { pr: basic, at: now, repo } } };
  const verdict = attestationReader?.(repo, basic.no, detail.headSha)?.verdict ?? null;
  const pr: LanePr = { ...basic, checks: detail.checks, merged: detail.merged, title: detail.title, verdict, mergedAt: detail.mergedAt ?? null, closed: detail.closed ?? undefined };
  return { pr, cache: { ...cache, [run]: { pr, at: now, repo } } };
}

/** Item 11: `gh pr list --repo <repo> --head <branch> --state all --json
 *  number,url,isDraft,mergedAt,title,headRefOid` -- finds a PR (open, draft or
 *  already merged) for a branch, when nothing has recorded its number yet. Callers
 *  on Windows run this through a shell, same as `GhPrLookup`. */
export interface GhBranchPr {
  number: number;
  url: string;
  isDraft: boolean;
  mergedAt: string | null;
  title: string;
  headRefOid: string;
  /** R-61 item 2: `gh`'s own `state` -- 'CLOSED' without `mergedAt` is a PR closed
   *  without merging. Optional so a specimen predating this field still type-checks. */
  state?: string;
}

export type GhBranchLookupFn = (repo: string, branch: string) => Promise<GhBranchPr | undefined>;

/**
 * Item 11: a queue item's own `pr` field can stay unset even after the run it
 * drives has already opened one straight off its own branch -- the worker's own ask
 * says so ("PR #39 ... is open, draft, and mergeable"), but nothing ever wrote the
 * number back onto the item, so the tile and the sheet kept reading "no PR yet".
 *
 * Looks the PR up once by branch (`--state all`, so an already-merged PR is found
 * too, not only an open one) and caches the answer under the same `run`-keyed cache
 * every other PR read here shares, so a lane's PR reads the same everywhere from the
 * very next poll. `no PR found by branch` caches a `null` for the same TTL, exactly
 * like `computeRunPr` already does -- a lane with genuinely no PR is not re-looked-up
 * on every single poll.
 */
export async function computeBranchPr(
  run: string, repo: string, branch: string, cache: Cache, now: number, branchLookup: GhBranchLookupFn,
): Promise<{ pr: LanePr | null; cache: Cache }> {
  const cached = cache[run];
  if (cached && now - cached.at < PR_CACHE_TTL_MS) return { pr: cached.pr, cache };

  const found = await branchLookup(repo, branch);
  if (!found) return { pr: null, cache: { ...cache, [run]: { pr: null, at: now } } };

  const pr: LanePr = {
    no: found.number, url: found.url, draft: found.isDraft, merged: Boolean(found.mergedAt), title: found.title,
    mergedAt: found.mergedAt ? Date.parse(found.mergedAt) : null,
    // R-61 item 2: without this, a chain-only lane (discovered exclusively through a
    // branch lookup, never a queue item) whose PR closed without merging never gets a
    // `closed` fact at all, so `retireEligible`'s new check reads it as still open --
    // stuck exactly the way item 2 was written to stop. `undefined` (not `false`) when
    // a specimen's fake lookup omits `state` entirely, so every test predating this
    // field still type-checks unchanged.
    closed: found.state === undefined ? undefined : found.state === 'CLOSED',
  };
  return { pr, cache: { ...cache, [run]: { pr, at: now, repo } } };
}
