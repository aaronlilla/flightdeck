/**
 * R1: routes a ticket to a repository from `FORGE_INTAKE_REPO_MAP` so the planner stops
 * guessing (2026-09-05 07:55 gap). `cli.ts` parses the environment variable once and
 * passes the parsed rules into `runIntakeOnce`. This module never reads `process.env`
 * itself, the same separation `jira.ts` keeps for `FORGE_JIRA_*`, so no repository name,
 * label, project key or site ever lands in a tracked file, only in the launch line.
 *
 * The map is a comma-separated list of `rule=owner/name` entries, evaluated in order,
 * first match wins:
 *   - `label:<name>`: the ticket carries this label
 *   - `component:<name>`: the ticket carries this component
 *   - `type:<issuetype>`: the ticket's issue type matches
 *   - `key:<PROJECT>`: the ticket's key starts with this project prefix
 *   - `default`: always matches, so it only makes sense last
 * All name comparisons are case-insensitive. No map, or no rule matching, leaves the
 * packet's repository `'unknown'`.
 */
export type RepoRuleKind = 'label' | 'component' | 'type' | 'key' | 'default';

export interface RepoRule {
  kind: RepoRuleKind;
  /** Absent only for `default`. */
  value?: string;
  repo: string;
}

export interface RepoRouteInput {
  ticket: string;
  labels: string[];
  components: string[];
  issuetype: string;
}

const RULE_KINDS: readonly RepoRuleKind[] = ['label', 'component', 'type', 'key'];

/** Parses `FORGE_INTAKE_REPO_MAP`'s value into ordered rules. Throws on a malformed entry
 *  rather than silently dropping it: an operator's typo should fail loudly, not route
 *  tickets nowhere without a trace. */
export function parseRepoMap(raw: string | undefined): RepoRule[] {
  if (!raw || raw.trim().length === 0) return [];
  return raw.split(',').map((rawEntry) => {
    const entry = rawEntry.trim();
    const eq = entry.indexOf('=');
    if (eq === -1) {
      throw new Error(`FORGE_INTAKE_REPO_MAP: malformed entry "${entry}" (expected rule=owner/name)`);
    }
    const rulePart = entry.slice(0, eq).trim();
    const repo = entry.slice(eq + 1).trim();
    if (!repo) {
      throw new Error(`FORGE_INTAKE_REPO_MAP: malformed entry "${entry}" (empty repository)`);
    }
    if (rulePart.toLowerCase() === 'default') {
      return { kind: 'default' as const, repo };
    }
    const colon = rulePart.indexOf(':');
    if (colon === -1) {
      throw new Error(`FORGE_INTAKE_REPO_MAP: malformed rule "${rulePart}" (expected kind:value or default)`);
    }
    const kind = rulePart.slice(0, colon).trim().toLowerCase();
    const value = rulePart.slice(colon + 1).trim();
    if (!value) {
      throw new Error(`FORGE_INTAKE_REPO_MAP: malformed rule "${rulePart}" (empty value)`);
    }
    if (!(RULE_KINDS as string[]).includes(kind)) {
      throw new Error(`FORGE_INTAKE_REPO_MAP: unknown rule kind "${kind}" in "${rulePart}"`);
    }
    return { kind: kind as RepoRuleKind, value, repo };
  });
}

function projectKeyFor(ticket: string): string {
  const dash = ticket.indexOf('-');
  return dash === -1 ? ticket : ticket.slice(0, dash);
}

/** Evaluates the rules in order against one ticket's routing facts. Returns the first
 *  matching rule's repository, or `'unknown'` when the map is empty or nothing matches. */
export function routeRepo(rules: RepoRule[], input: RepoRouteInput): string {
  for (const rule of rules) {
    switch (rule.kind) {
      case 'label':
        if (input.labels.some((label) => label.toLowerCase() === rule.value!.toLowerCase())) return rule.repo;
        break;
      case 'component':
        if (input.components.some((component) => component.toLowerCase() === rule.value!.toLowerCase())) {
          return rule.repo;
        }
        break;
      case 'type':
        if (input.issuetype.toLowerCase() === rule.value!.toLowerCase()) return rule.repo;
        break;
      case 'key':
        if (projectKeyFor(input.ticket).toLowerCase() === rule.value!.toLowerCase()) return rule.repo;
        break;
      case 'default':
        return rule.repo;
    }
  }
  return 'unknown';
}

/**
 * A pasted brief has no ticket, so no label, component or key for the rules above to
 * match, and it used to land on the `default` repository every time. A brief names its
 * repository itself with one line in its first twenty, `repo: owner/name`, which wins
 * over the rules. Returns null when no such line exists or the value is not an
 * `owner/name` pair, and the caller falls back to `routeRepo`.
 */
export function repoFromBrief(text: string): string | null {
  const head = text.split(/\r?\n/, 20);
  for (const line of head) {
    const match = /^\s*repo\s*:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s*$/i.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * A brief written by hand for a real ticket carries no packet id the planner can hand
 * to Jira. Without this, the synthetic `queue-brief-<timestamp>`/`hotfix-<timestamp>` id
 * is all `routeRepo`, branch naming and `jiraHandoff` ever see, so a hand-written brief
 * never reaches its own ticket's Jira handoff. A `ticket: KEY-123` line anywhere in the
 * brief names that key; the brief file's own id stays synthetic and unique, only the
 * item's `ticket` field (routing, branch name, handoff) takes the real key. Returns
 * null without such a line, or when the value is not a Jira-shaped `PROJECT-123` key.
 */
export function ticketFromBrief(text: string): string | null {
  const match = /^ticket:\s*([A-Z][A-Z0-9_]*-\d+)\s*$/m.exec(text);
  return match ? match[1]! : null;
}

/**
 * Queue-throughput W1: every `after: <slug>` line in a brief, one per line, in the
 * order they appear. A queued item carrying these does not start until each slug
 * resolves -- see `runQueueTick` in `../intake/queue.ts` for how a slug is matched
 * and cleared. No such lines returns an empty array, the same as a brief with no
 * ordering requirement at all.
 */
export function parseAfterLines(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*after\s*:\s*(.+?)\s*$/i.exec(line);
    if (match) out.push(match[1]!);
  }
  return out;
}
