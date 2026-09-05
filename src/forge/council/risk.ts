/**
 * Decision 5, `2026-09-04-forge-council.md`: lenses scale to diff risk so a model call
 * only happens where a judgment is actually needed. Thresholds and risky-path globs live
 * in `model-policy.json`'s `council` block, not hardcoded here, so tuning them is a data
 * change rather than a code change.
 *
 * The roadmap names the two boundary rules ("small" under 100 lines with no risky path;
 * anything risky forces Codex) but never states where "medium" ends and "large" begins.
 * `largeMinLines` is this stream's own assumption, not a sourced number -- see the goal
 * brief's Status section, which names it explicitly as unverified.
 */
import { loadPolicy } from '../policy.ts';

export type RiskLevel = 'small' | 'medium' | 'large';

export interface DiffRisk {
  level: RiskLevel;
  needsCodex: boolean;
  changedLines: number;
  matchedRiskyPath: string | null;
}

export interface CouncilPolicy {
  smallMaxLines: number;
  largeMinLines: number;
  riskyPaths: string[];
  /** Aaron 2026-09-04 16:40: the Codex lane stays off unless this is `'on'`. */
  codex: 'on' | 'off';
  /** Repos `forge council` will review at all. Empty (the checked-in default) is a
   *  refusal, not a bypass -- see the field's own comment in `policy.ts`. */
  allowedRepos: string[];
  /** Repos `forge gate --merge` may squash-merge autonomously. Same fail-closed default
   *  as `allowedRepos`. */
  autoMerge: string[];
}

const DEFAULT_COUNCIL_POLICY: CouncilPolicy = {
  smallMaxLines: 100,
  largeMinLines: 500,
  riskyPaths: ['**/features/wallet/**', '**/features/auth/**', '**/Financial/**'],
  codex: 'off',
  allowedRepos: [],
  autoMerge: [],
};

/** Comma-separated repo names from an operator's own environment, never from source
 *  (see `policy.ts`'s comment on `Policy['council']`). */
function envRepoList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export function councilPolicy(path?: string): CouncilPolicy {
  const policy = loadPolicy(path) as unknown as { council?: Partial<CouncilPolicy> };
  const configured = { ...DEFAULT_COUNCIL_POLICY, ...(policy.council ?? {}) };
  return {
    ...configured,
    allowedRepos: [...new Set([...configured.allowedRepos, ...envRepoList('FORGE_COUNCIL_REPOS')])],
    autoMerge: [...new Set([...configured.autoMerge, ...envRepoList('FORGE_COUNCIL_AUTOMERGE')])],
  };
}

/** `forge council` refuses a repo that is not on this list -- fail-closed, since the
 *  checked-in default is empty (see `policy.ts`). */
export function repoAllowedForCouncil(repo: string, policy: CouncilPolicy = councilPolicy()): boolean {
  return policy.allowedRepos.includes(repo);
}

/** `forge gate --merge` refuses a repo that is not on this list -- same fail-closed
 *  default, so a controlled-code repo (never added here) can never merge by omission
 *  rather than by an explicit block rule this file would have to name. */
export function autoMergeAllowed(repo: string, policy: CouncilPolicy = councilPolicy()): boolean {
  return policy.autoMerge.includes(repo);
}

export function matchesRiskyPath(path: string, riskyPaths: string[]): string | null {
  const normalized = path.replace(/\\/g, '/');
  for (const glob of riskyPaths) {
    if (globToRegExp(glob).test(normalized)) return glob;
  }
  return null;
}

export function diffRisk(input: { changedLines: number; paths: string[] }, policy: CouncilPolicy = councilPolicy()): DiffRisk {
  let matchedRiskyPath: string | null = null;
  for (const path of input.paths) {
    matchedRiskyPath = matchesRiskyPath(path, policy.riskyPaths);
    if (matchedRiskyPath) break;
  }

  const needsCodex = matchedRiskyPath !== null || input.changedLines >= policy.largeMinLines;

  let level: RiskLevel;
  if (input.changedLines < policy.smallMaxLines && !matchedRiskyPath) {
    level = 'small';
  } else if (input.changedLines >= policy.largeMinLines || matchedRiskyPath) {
    level = 'large';
  } else {
    level = 'medium';
  }

  return { level, needsCodex, changedLines: input.changedLines, matchedRiskyPath };
}

export function lensCountFor(risk: DiffRisk): number {
  return risk.level === 'small' ? 1 : 3;
}
