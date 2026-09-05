/**
 * The protected-capability classifier the roadmap's dormancy condition names verbatim:
 * "a protected-capability list ... that its classifier checks against the proposed diff,
 * not the reported path" (`2026-09-04-forge-spine-sdk-workers.md:972-973`).
 *
 * `gotcha.ts`'s `classifyGotcha` is the trap this must not repeat: it only ever looks at
 * `where`, so a gotcha reported against an unrelated fixable file can still carry a
 * proposed edit that reaches into `src/forge/rules/` or a credential path, and the
 * path-only check has nothing to say about that. This classifier takes the diff itself --
 * every file it touches, and the text it adds -- and is built to be a strict superset of
 * `AARON_ONLY`'s caution: every path that check holds back is held back here too, checked
 * first and unconditionally, before this module's own finer categories run at all.
 */
import { matchesRiskyPath } from '../council/risk.js';
import { AARON_ONLY } from '../gotcha.js';
import { loadPolicy } from '../policy.js';

export type Capability = 'permission' | 'merge' | 'credential' | 'coordination' | 'policy' | 'acceptance-oracle';

export interface ProposedDiff {
  /** Every path the proposed change touches, added or modified. */
  files: string[];
  /** The diff's added-line text concatenated, for the cases a file glob cannot see: a
   *  helper edited to read a token env var rather than the credential file itself. */
  addedText?: string;
}

export interface CapabilityRule {
  capability: Capability;
  filePatterns: string[];
  symbolPatterns?: string[];
}

/**
 * Decision 6's own list, verbatim by category. Used only when the policy file (read
 * through `loadPolicy`, never edited by this stream) carries no `selfIteration.protected`
 * block of its own -- the same optional-override shape `council/risk.ts` already uses.
 */
export const DEFAULT_PROTECTED_CAPABILITIES: CapabilityRule[] = [
  {
    capability: 'permission',
    filePatterns: ['**/forge/rules/**', '**/sdkengine.ts'],
    symbolPatterns: ['PreToolUse', 'registerTool'],
  },
  {
    capability: 'merge',
    filePatterns: ['**/forge/council/gate*'],
    symbolPatterns: ['ExternalWrite'],
  },
  {
    capability: 'credential',
    filePatterns: ['**/forge/credential-horizon.ts', '**/forge/server-token', '**/forge/logins/**'],
    symbolPatterns: ['CredentialHorizon', 'FORGE_JIRA_TOKEN', 'serverTokenPath'],
  },
  {
    capability: 'coordination',
    filePatterns: ['**/forge/registry.ts', '**/forge/supervisor.ts'],
  },
  {
    capability: 'policy',
    filePatterns: ['**/model-policy.json', '**/forge/policy.ts'],
  },
  {
    capability: 'acceptance-oracle',
    filePatterns: ['**/forge/worker.ts', '**/tests/checks/**'],
    symbolPatterns: ['verifyDone'],
  },
];

export type CapabilityVerdict =
  | { allow: true }
  | { allow: false; capability: string; reason: string; matched: string };

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * The floor: any path `gotcha.ts`'s own `AARON_ONLY` list would hold for a person is held
 * here too, before this module's own categories are even consulted. This is what makes
 * "never more permissive than the path check it supplements" a property of the code
 * rather than a hope about which categories somebody remembered to list.
 */
function aaronOnlyFloor(files: string[]): CapabilityVerdict | undefined {
  for (const path of files) {
    for (const pattern of AARON_ONLY) {
      if (pattern.test(path)) {
        return {
          allow: false,
          capability: 'permission',
          reason: 'this path is on gotcha.ts\'s AARON_ONLY list: a guard, the model policy, settings, or the installer',
          matched: path,
        };
      }
    }
  }
  return undefined;
}

export function protectedCapabilities(policyPath?: string): CapabilityRule[] {
  try {
    const policy = loadPolicy(policyPath);
    const configured = policy.selfIteration?.protected;
    if (!configured) return DEFAULT_PROTECTED_CAPABILITIES;
    return Object.entries(configured).map(([capability, rule]) => ({
      capability: capability as Capability,
      filePatterns: rule.filePatterns,
      symbolPatterns: rule.symbolPatterns,
    }));
  } catch {
    return DEFAULT_PROTECTED_CAPABILITIES;
  }
}

/**
 * Denies the first capability the diff reaches into, checked in order: the AARON_ONLY
 * floor first, then each of decision 6's own categories. A diff that reaches into none
 * of them is allowed -- which only ever means "safe to draft", never "safe to merge",
 * since drafting and merging are gated by two entirely different mechanisms.
 */
export function classifyDiff(diff: ProposedDiff, rules: CapabilityRule[] = protectedCapabilities()): CapabilityVerdict {
  const files = diff.files.map(normalizePath);

  const floor = aaronOnlyFloor(diff.files);
  if (floor) return floor;

  for (const rule of rules) {
    for (const file of files) {
      const matched = matchesRiskyPath(file, rule.filePatterns);
      if (matched) {
        return { allow: false, capability: rule.capability, reason: `touches ${matched}`, matched: file };
      }
    }
    if (diff.addedText && rule.symbolPatterns) {
      for (const symbol of rule.symbolPatterns) {
        if (diff.addedText.includes(symbol)) {
          return { allow: false, capability: rule.capability, reason: `adds text mentioning ${symbol}`, matched: symbol };
        }
      }
    }
  }

  return { allow: true };
}
