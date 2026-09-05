/**
 * `forge intake --dry-run`: prints the writes Intake would make, and makes none of
 * them. Decision 1's Jira token does not exist yet (`FORGE_JIRA_TOKEN` is unset), so
 * this is the only mode the CLI ships in this stream — every write below is a plan, not
 * a call.
 */
export interface DryRunFinding {
  sourceId: string;
  what: string;
}

export function planIntakeWrites(findings: DryRunFinding[]): string[] {
  if (!findings.length) return ['nothing to do: the fixture carried no findings'];
  return findings.map((f) => `would create a ticket for ${f.sourceId}: ${f.what}`);
}
