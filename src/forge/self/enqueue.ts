/**
 * A `SelfFinding` becomes ONE queue item. Off unless `FORGE_SELF_REPO` is set -- this
 * whole file is a no-op on a fleet that never named a self-repo, the same "absent means
 * never wired" discipline `queue.ts`'s own optional deps already keep.
 *
 * Unlike a Jira ticket or a pasted brief, a self finding already knows everything
 * `queue.ts`'s planning hop exists to discover: which repository, and what to put in the
 * brief. So this writes the brief file itself and appends a `QueueRow` with `briefPath`
 * and `repo` already set -- `advanceItem` (`intake/queue.ts`) sees a brief already on
 * the item and skips straight to provisioning, never calling a planner for something
 * this module already worked out.
 *
 * `maxInFlight` (default 1, `FORGE_SELF_MAX_IN_FLIGHT`) caps how many self items may be
 * `queued`/`planning`/`running` at once, counted the same way `QUEUE_IN_FLIGHT_STATES`
 * does for the intake queue in general -- one broken self-fix chewing through the fleet's
 * own worktrees is not a risk worth taking for code that fixes Forge itself.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { QueueItem } from '../../shared/console-model.js';
import { QUEUE_IN_FLIGHT_STATES } from '../intake/queue.js';
import type { QueueStore } from '../intake/queueStore.js';
import type { SelfFinding } from './analyze.js';
import type { FindingsLedger } from './ledger.js';
import { citesRoadmapId } from '../roadmap.js';

export interface SelfEnqueueDeps {
  store: QueueStore;
  /** Where this module writes the brief file for a finding it enqueues. Distinct from
   *  `queueBriefsDir()` (`paths.ts`), which is where the ordinary planner writes a
   *  brief it authored -- these are self-authored, never planned. */
  briefsDir: string;
  ledger: FindingsLedger;
  /** `FORGE_SELF_REPO`. Empty or unset means this stream is off: `enqueueFindings`
   *  records nothing and queues nothing. */
  selfRepo: string;
  maxInFlight: number;
  /** Minimum time between two self items, whatever became of the last one. */
  minGapMs?: number;
  clock(): number;
  /** Writes one row to the fleet journal, returning it -- the same shape `queue.ts`'s
   *  own `QueueRuntimeDeps.append` uses. */
  append(event: Record<string, unknown>): { id: string };
  /** R-02 guard #4: appends one line to `doctrine/ROADMAP.md`'s `## Proposed` section for
   *  a finding whose summary and evidence cite no `R-nn` id, instead of enqueuing it.
   *  Absent leaves this stream exactly as it was before guard #4 existed: a finding with
   *  no roadmap id still enqueues like any other. */
  appendProposed?: (line: string) => void;
}

function capitalizeFirst(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/** Deliverable 2: the heading is the finding's own summary sentence, capitalised --
 *  what a person needs to recognise the lane -- with the finding's kind on its own line
 *  below rather than buried in the heading itself. */
function briefText(finding: SelfFinding): string {
  return [
    `# ${capitalizeFirst(finding.summary.trim())}`,
    '',
    `Kind: ${finding.kind}`,
    '',
    '## Evidence',
    '',
    ...finding.evidence.map((line) => `- ${line}`),
    '',
    '## Definition of done',
    '',
    '- Write a failing test that reproduces this finding first. Run it and watch it fail.',
    '- Make the smallest change that turns the failing test green.',
    '- Never widen scope past what this finding names.',
  ].join('\n');
}

function countInFlightSelfItems(store: QueueStore, selfRepo: string): number {
  return store.all().filter((item) => item.repo === selfRepo && QUEUE_IN_FLIGHT_STATES.includes(item.state)).length;
}

function newSelfItemId(findingId: string): string {
  return `S-${findingId}`;
}

/**
 * Records every finding onto the ledger (idempotent -- a finding already recorded is a
 * no-op), then enqueues as many of the still-unenqueued ones as fit under `maxInFlight`,
 * in the order they were given. Returns only the items actually created this call.
 */
/** Kinds that describe how the fleet behaved, not a change to make: they stay in the
 *  findings ledger for a person to read and never become queue items. */
export const OBSERVATION_KINDS: ReadonlySet<string> = new Set(['token-outlier', 'repeated-work']);

export function enqueueFindings(findings: SelfFinding[], deps: SelfEnqueueDeps): QueueItem[] {
  if (!deps.selfRepo) return [];
  mkdirSync(deps.briefsDir, { recursive: true });

  const created: QueueItem[] = [];
  let inFlight = countInFlightSelfItems(deps.store, deps.selfRepo);
  // A parked or failed self item does not count as in flight, so the loop kept adding a
  // new one every tick and the board filled with them inside an hour (2026-09-07). One
  // new self item per `minGapMs` (default an hour), whatever became of the last one.
  const minGapMs = deps.minGapMs ?? 60 * 60_000;
  const newest = Math.max(0, ...deps.store.all().filter((item) => item.repo === deps.selfRepo).map((item) => item.createdAt));
  if (newest && deps.clock() - newest < minGapMs) return [];

  for (const found of findings) {
    const now = deps.clock();
    const row = deps.ledger.record(found, now);
    if (row.enqueuedItemId) continue;

    // Guard #4: a finding that cites no roadmap id has nothing in
    // doctrine/ROADMAP.md to attach to. It goes under `## Proposed` once, marked so a
    // later tick does not append it again, and is never turned into a queue item.
    if (deps.appendProposed && !row.proposedAt
      && !citesRoadmapId(`${found.summary}\n${found.evidence.join('\n')}`)) {
      const date = new Date(now).toISOString().slice(0, 10);
      deps.appendProposed(`- ${date}: ${found.signature} -- ${found.summary}`);
      deps.ledger.markProposed(found.id, now);
      continue;
    }
    if (row.proposedAt) continue;

    // A finding that is an observation rather than a defect is recorded in the ledger
    // and never handed to a worker. The first live token-outlier item (2026-09-07)
    // spent a session proving the number was by design, and the loop then queued one
    // per large run; each parked or blocked, and each was a card on the board.
    if (OBSERVATION_KINDS.has(found.kind)) continue;
    if (inFlight >= deps.maxInFlight) continue;

    const written = deps.append({ event: 'self.finding', actor: 'self', findingId: found.id, kind: found.kind });
    const id = newSelfItemId(found.id);
    const briefPath = join(deps.briefsDir, `${id}.md`);
    writeFileSync(briefPath, briefText(found), 'utf8');

    const item: QueueItem = {
      id, source: 'brief', input: found.summary, ticket: id, repo: deps.selfRepo, briefPath,
      branch: null, worktreePath: null, base: null, state: 'running', reason: null, runKey: null,
      pr: null, journalIds: written.id ? [written.id] : [], createdAt: now, updatedAt: now,
    };
    deps.store.append({ ...item, at: now });
    deps.ledger.markEnqueued(found.id, id, now);
    deps.append({ event: 'self.enqueued', actor: 'self', findingId: found.id, itemId: id });

    created.push(item);
    inFlight += 1;
  }

  return created;
}
