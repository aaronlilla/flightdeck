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
}

const DEFAULT_COUNCIL_POLICY: CouncilPolicy = {
  smallMaxLines: 100,
  largeMinLines: 500,
  riskyPaths: ['**/features/wallet/**', '**/features/auth/**', '**/Financial/**'],
};

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

export function councilPolicy(): CouncilPolicy {
  const policy = loadPolicy() as unknown as { council?: Partial<CouncilPolicy> };
  return { ...DEFAULT_COUNCIL_POLICY, ...(policy.council ?? {}) };
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
