/**
 * The Blockers view's detection: one `Blocker` per stuck fact the board already knows
 * about, chained by `blockedBy` and ordered root-first.
 *
 * Pure given its inputs, the same shape `lanes.ts`/`summary.ts` already use: nothing here
 * reads a file or shells out. The route layer (`blockers-route.ts`) gathers live
 * `DetectionInputs` from the inbox, the integrations registry, the lane view and an
 * injected `gh` reader, and hands them to `detectBlockers`.
 */
import { stripMachineIds } from '../../shared/humanize.js';
import { labelFor as sharedLabelFor } from './lanes.js';
import type { Blocker, BlockerKind } from '../../shared/console-model.js';

/** What `detectBlockers` returns per blocker before the route layer folds in
 *  persisted state (`state`, `checkedAt`, `resolvedAt`, `lastCheck`). */
export type BlockerSnapshot = Omit<Blocker, 'state' | 'checkedAt' | 'resolvedAt' | 'lastCheck'>;

export interface AskInput {
  key: string;
  question: string;
  answer?: string;
  runs: string[];
  ticket?: string;
  at: number;
}

export interface IntegrationInput {
  id: string;
  name: string;
  status: 'ok' | 'off' | 'down' | 'checking';
  cause: string | null;
  fix: string | null;
  fixLabel: string | null;
  since: number | null;
  dependents: string[];
}

export interface LaneInput {
  id: string;
  title: string | null;
  /** Item 8: the lane's own ticket key, when it has one -- `laneLabel` reads it ahead
   *  of `title` the same way the board's own `laneLabelFor` (`lanes.ts#labelFor`)
   *  already does everywhere else. Optional so a caller that has not wired it through
   *  yet still reads a lane by its title, same as before. */
  ticket?: string | null;
  repo: string | null;
  state: string;
  observedAt: number;
  pr: { no: number; checks: 'success' | 'failure' | 'pending' | null } | null;
  mergeable: { ok: true } | { ok: false; why: string } | null;
}

/** A GitHub Actions run refused inside 10s with a billing/spending-limit message,
 *  read through the route layer's injectable `gh run view --json conclusion,jobs`.
 *  Gathered before `detectBlockers` runs, so this module never shells out itself. */
export interface BillingSignalInput {
  repo: string;
  pr: number;
  runId: string;
  headSha: string;
  message: string;
}

export interface DetectionInputs {
  now: number;
  asks: AskInput[];
  integrations: IntegrationInput[];
  lanes: LaneInput[];
  billing: BillingSignalInput[];
  /** Lane ids with a live registry row right now -- backs `process` detection. */
  registryLive: Set<string>;
  jiraSite?: string;
}

const TEN_MINUTES_MS = 10 * 60_000;
const OWNER_WHY = /^controlled code: only (.+) merges this repo$/;

/** Item 8: every lane label on a blocker (`blocks[].label`, and every `Then:`/
 *  `Blocks:` sentence built off it below) goes through the same shared `labelFor` the
 *  rest of the board already uses -- a ticket key when the lane has one, else its
 *  title trimmed to 60 characters at a word boundary. The live view printed a
 *  120-character title twice per step; this is the one place that could still happen. */
function laneLabel(lane: LaneInput | undefined, id: string): string {
  return sharedLabelFor(id, () => (lane ? { ticket: lane.ticket ?? null, title: lane.title } : null));
}

function block(laneId: string, label: string): { laneId: string; label: string } {
  return { laneId, label };
}

/** Every lane blocked on this PR (repo + number), by their own title. */
function lanesOnPr(lanes: LaneInput[], repo: string, pr: number): LaneInput[] {
  return lanes.filter((lane) => lane.repo === repo && lane.pr?.no === pr);
}

function questionBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const laneById = new Map(inputs.lanes.map((lane) => [lane.id, lane]));
  return inputs.asks.filter((ask) => ask.answer === undefined).map((ask) => {
    const title = stripMachineIds(ask.question).slice(0, 90);
    const links = ask.ticket && inputs.jiraSite
      ? [{ label: ask.ticket, url: `${inputs.jiraSite}/browse/${ask.ticket}` }]
      : [];
    return {
      id: `question:${ask.key}`,
      kind: 'question' as BlockerKind,
      title: title || 'A question is waiting on you',
      detail: ask.question,
      youCanResolve: true,
      howToResolve: 'Answer it from the rail or here.',
      links,
      blocks: ask.runs.map((run) => block(run, laneLabel(laneById.get(run), run))),
      blockedBy: [],
      since: ask.at,
      thenWhat: 'Resumes the run once answered.',
    };
  });
}

function integrationBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const laneById = new Map(inputs.lanes.map((lane) => [lane.id, lane]));
  // Item 7: an integration nothing depends on -- Amplitude, context7, knowledge on the
  // live board -- belongs in Settings, not here. `row.dependents` is already the real
  // list (a lane whose `blockedBy` names this integration, folded in
  // `integrations.ts#dependentsByIntegration`); a down/off row with none has nothing
  // waiting on it.
  return inputs.integrations
    .filter((row) => (row.status === 'down' || row.status === 'off') && row.dependents.length > 0)
    .map((row) => ({
      id: `integration:${row.id}`,
      kind: 'integration' as BlockerKind,
      title: `${row.name} is not connecting`,
      detail: row.cause ?? `${row.name} failed its last health check.`,
      youCanResolve: true,
      howToResolve: row.fix ?? `${row.fixLabel ?? 'Reconnect'}, then click Resolved.`,
      links: [],
      blocks: row.dependents.map((laneId) => block(laneId, laneLabel(laneById.get(laneId), laneId))),
      blockedBy: [],
      since: row.since ?? inputs.now,
      thenWhat: `Resumes ${row.dependents.length} blocked lane(s).`,
    }));
}

function checksBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const seen = new Set<string>();
  const out: BlockerSnapshot[] = [];
  for (const lane of inputs.lanes) {
    if (!lane.repo || !lane.pr || lane.pr.checks !== 'failure') continue;
    const id = `checks:${lane.repo}#${lane.pr.no}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const onPr = lanesOnPr(inputs.lanes, lane.repo, lane.pr.no);
    const billing = inputs.billing.find((row) => row.repo === lane.repo && row.pr === lane.pr!.no);
    out.push({
      id,
      kind: 'checks' as BlockerKind,
      title: `Checks failing on PR #${lane.pr.no} (${lane.repo})`,
      detail: `PR #${lane.pr.no} on ${lane.repo} has failing checks.`,
      youCanResolve: true,
      howToResolve: 'Fix and push, or click Resolved to re-run checks.',
      links: [{ label: `PR #${lane.pr.no}`, url: `https://github.com/${lane.repo}/pull/${lane.pr.no}` }],
      blocks: onPr.map((l) => block(l.id, laneLabel(l, l.id))),
      blockedBy: billing ? [`billing:${lane.repo}`] : [],
      // Item 8: the failed run's own time, not the moment this view happened to poll
      // -- `inputs.now` read as "since a second ago" on every single refresh.
      since: lane.observedAt,
      thenWhat: onPr.length ? `Resumes ${onPr.map((l) => laneLabel(l, l.id)).join(', ')}.` : 'Resumes what was waiting on green checks.',
    });
  }
  return out;
}

function billingBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const seen = new Set<string>();
  const out: BlockerSnapshot[] = [];
  for (const row of inputs.billing) {
    const id = `billing:${row.repo}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const onPr = lanesOnPr(inputs.lanes, row.repo, row.pr);
    out.push({
      id,
      kind: 'billing' as BlockerKind,
      title: `GitHub Actions billing is off for ${row.repo}`,
      detail: `The verify jobs on PR #${row.pr} were refused: "${row.message}".`,
      youCanResolve: true,
      howToResolve: 'Turn billing back on at github.com/settings/billing, then click Resolved.',
      links: [{ label: 'GitHub billing settings', url: 'https://github.com/settings/billing' }],
      blocks: onPr.map((l) => block(l.id, laneLabel(l, l.id))),
      blockedBy: [],
      // Item 8: the failed run's own time when a lane on this PR is known; a billing
      // refusal caught with no lane recorded against it yet falls back to `now` rather
      // than guessing.
      since: onPr[0]?.observedAt ?? inputs.now,
      thenWhat: `Re-runs the checks on PR #${row.pr}${onPr.length ? `, then resumes ${onPr.map((l) => laneLabel(l, l.id)).join(', ')}.` : '.'}`,
    });
  }
  return out;
}

function ownerBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const out: BlockerSnapshot[] = [];
  for (const lane of inputs.lanes) {
    if (!lane.repo || !lane.pr || !lane.mergeable || lane.mergeable.ok) continue;
    const match = OWNER_WHY.exec(lane.mergeable.why);
    if (!match) continue;
    const owner = match[1]!;
    out.push({
      id: `owner:${lane.repo}#${lane.pr.no}`,
      kind: 'owner' as BlockerKind,
      title: `${owner} needs to merge PR #${lane.pr.no} on ${lane.repo}`,
      detail: `PR #${lane.pr.no} on ${lane.repo} is ready and waiting on ${owner}.`,
      youCanResolve: false,
      howToResolve: `Nudge ${owner} -- there is nothing to click here.`,
      links: [{ label: `PR #${lane.pr.no}`, url: `https://github.com/${lane.repo}/pull/${lane.pr.no}` }],
      blocks: [block(lane.id, laneLabel(lane, lane.id))],
      blockedBy: [],
      since: inputs.now,
      thenWhat: `Resumes once ${owner} merges.`,
    });
  }
  return out;
}

function processBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const out: BlockerSnapshot[] = [];
  for (const lane of inputs.lanes) {
    if (lane.state !== 'running' && lane.state !== 'handed-off') continue;
    if (inputs.registryLive.has(lane.id)) continue;
    if (inputs.now - lane.observedAt < TEN_MINUTES_MS) continue;
    out.push({
      id: `process:${lane.id}`,
      kind: 'process' as BlockerKind,
      title: `${laneLabel(lane, lane.id)} has no live process`,
      detail: `${laneLabel(lane, lane.id)} still reads ${lane.state} but nothing has reported in for over 10 minutes.`,
      youCanResolve: true,
      howToResolve: 'Click Resolved to relaunch it.',
      links: [],
      blocks: [block(lane.id, laneLabel(lane, lane.id))],
      blockedBy: [],
      since: lane.observedAt,
      thenWhat: `Relaunches ${laneLabel(lane, lane.id)}.`,
    });
  }
  return out;
}

/** `checks`/`question` blockers link back to `billing`/`checks` by PR number named in
 *  their own text -- a `question` mentioning "PR #39" when a `checks` or `billing`
 *  blocker already exists for #39 on some repo is blocked by it. */
function linkQuestionsToPrBlockers(blockers: BlockerSnapshot[]): void {
  const prBlockers = blockers.filter((b) => b.kind === 'checks' || b.kind === 'billing');
  for (const question of blockers) {
    if (question.kind !== 'question') continue;
    const match = /#(\d+)/.exec(question.detail);
    if (!match) continue;
    const pr = match[1]!;
    const owner = prBlockers.find((b) => b.id.endsWith(`#${pr}`) || (b.kind === 'billing' && question.detail.includes(b.title.split(' for ')[1] ?? '\0')));
    if (owner && !question.blockedBy.includes(owner.id)) question.blockedBy.push(owner.id);
  }
}

/**
 * Every currently-open blocker, from the live sources alone. A blocker whose cause is no
 * longer present in `inputs` simply does not appear here -- the route layer is what turns
 * "was open, now absent" into a `resolved` chain that still shows for a while.
 */
export function detectBlockers(inputs: DetectionInputs): BlockerSnapshot[] {
  const blockers = [
    ...billingBlockers(inputs),
    ...checksBlockers(inputs),
    ...questionBlockers(inputs),
    ...integrationBlockers(inputs),
    ...ownerBlockers(inputs),
    ...processBlockers(inputs),
  ];
  linkQuestionsToPrBlockers(blockers);
  return blockers;
}

/**
 * Root-first chains out of `blockedBy`: a blocker with nothing blocking it is a root, and
 * each chain walks forward through whatever names it in `blockedBy`. A blocker with no
 * dependents and nothing blocking it is its own one-step chain.
 */
export function orderChains(blockers: BlockerSnapshot[]): string[][] {
  const byId = new Map(blockers.map((b) => [b.id, b]));
  const blockedByOf = new Map(blockers.map((b) => [b.id, b.blockedBy.filter((id) => byId.has(id))]));
  const dependents = new Map<string, string[]>();
  for (const b of blockers) {
    for (const dep of blockedByOf.get(b.id) ?? []) {
      (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(b.id);
    }
  }
  const roots = blockers.filter((b) => (blockedByOf.get(b.id) ?? []).length === 0);
  const chains: string[][] = [];
  const placed = new Set<string>();
  for (const root of roots) {
    const chain: string[] = [];
    let current: string | undefined = root.id;
    while (current && !placed.has(current)) {
      chain.push(current);
      placed.add(current);
      const next: string[] = dependents.get(current) ?? [];
      current = next[0];
    }
    chains.push(chain);
  }
  // Any blocker not reached from a root (a cycle, or `blockedBy` naming an id that
  // never resolved to a root) still needs to render somewhere -- one-step chain each,
  // rather than silently dropped off the board.
  for (const b of blockers) {
    if (!placed.has(b.id)) {
      chains.push([b.id]);
      placed.add(b.id);
    }
  }
  return chains;
}
