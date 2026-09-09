/**
 * Rounds: the Conductor's walk around the board.
 *
 * Aaron, 2026-09-08: "the warden or conductor should be auto clearing stale tickets or
 * items that don't actually need an answer, or things that aren't blocked need to be
 * restarted and finished." The warden tick (`warden-tick.ts`) parks; the blocker board
 * restarts what a cleared blocker was holding; nothing walked the whole queue and asked
 * of every row "is anything actually holding this?" This module is that walk.
 *
 * `planRounds` is pure: queue rows, lanes, blockers and a clock in, a sheet of findings
 * out, each with the one action that would clear it and the evidence for it in words.
 * `applyRounds` runs the mechanical actions through the queue's own functions -- the
 * same `retryItem`/`removeItem`/`retireLane` the buttons and the grammar call, never a
 * second implementation. An `ask` is never answered here: the classifier only says what
 * the question looks like, and the Conductor (or Aaron) reads it and decides.
 *
 * Every rule here is a "this is stale if X" with X printed on the sheet. A row nothing
 * matches is listed as healthy by name, so a quiet sheet reads as "checked, nothing to
 * do" and never as "did not look".
 */
import type { Blocker, Lane, QueueItem } from '../shared/console-model.js';
import { removeItem, retryItem } from './intake/queue.js';
import type { QueueStore } from './intake/queueStore.js';

export type RoundsKind =
  | 'done-still-open'
  | 'dead-worker'
  | 'stuck-after-finish'
  | 'unblocked'
  | 'ask'
  | 'orphan-lane'
  | 'zombie-lane';

export type RoundsAction = 'remove' | 'relaunch' | 'retry' | 'retire' | 'judge';

export interface RoundsFinding {
  kind: RoundsKind;
  action: RoundsAction;
  /** The queue item this acts on, when it is a queue item. */
  itemId: string | null;
  /** The lane (run key) this acts on, when it is a lane. */
  laneId: string | null;
  /** The ticket key or title a person recognises. */
  label: string;
  /** The evidence, in words. */
  why: string;
  /** For `ask`: the inbox key `answer_ask` takes, the question, and what the classifier
   *  thinks the answer is when the question reads as "I am done, may I stop". A
   *  suggestion is never applied by `applyRounds`. */
  ask?: { key: string | null; text: string; looksDone: boolean; suggested: string | null };
}

export interface RoundsParams {
  /** A running item whose run has shown no life for this long is dead. */
  silentAfterMs: number;
  /** A finished lane with no queue row older than this is board noise. */
  orphanAfterMs: number;
  /** How many times rounds may relaunch one item before a death stops being a launch
   *  problem and becomes a reading for the Conductor. */
  maxRelaunches: number;
}

export interface RoundsSheet {
  at: number;
  params: RoundsParams;
  findings: RoundsFinding[];
  /** Queue items nothing matched, by id, with why they were left alone. */
  healthy: Array<{ itemId: string; label: string; state: string; note: string }>;
  /** Items parked behind a blocker that is still open (not a question): waiting for
   *  real, named so a sheet never hides them. */
  waiting: Array<{ itemId: string; label: string; on: string }>;
}

export interface RoundsInput {
  now: number;
  items: QueueItem[];
  /** The archived-inclusive lanes view (`lanesResponse(true, true)`). */
  lanes: Lane[];
  blockers: Blocker[];
  params?: Partial<RoundsParams>;
  /** How many times rounds has already relaunched this item (the queue log's own
   *  `rounds:` park rows). Undefined means never, the same as zero. */
  priorRelaunches?: (itemId: string) => number;
}

export const DEFAULT_ROUNDS_PARAMS: RoundsParams = {
  silentAfterMs: 30 * 60_000,
  orphanAfterMs: 24 * 60 * 60_000,
  maxRelaunches: 2,
};

/** Park reasons the launcher writes for a collision with itself, not for anything a
 *  person did: a rebase against a dirty tree, two ticks planning the same item, a check
 *  that had not finished yet. Each one clears on its own by the next launch. */
const TRANSIENT_REASONS: Array<{ re: RegExp; words: string }> = [
  { re: /cannot rebase: You have unstaged changes/i, words: 'the launch rebased against a dirty tree' },
  { re: /already has a live run/i, words: 'two ticks planned it at once' },
  { re: /checks are pending/i, words: 'the gate refused on checks that had not finished' },
  { re: /ENOMEM|paging file|spawn UNKNOWN|EAGAIN/i, words: 'the machine was out of memory at launch' },
];

/** A ticket key inside a question, for labelling an ask whose lane is gone. */
const TICKET_IN_TEXT = /\b[A-Z][A-Z0-9]+-\d+\b/;

/** Questions that are really a completion report with a question mark on the end. */
const LOOKS_DONE = /already (merged|implemented|done|on develop|landed)|zero diff|nothing (left )?to ship|fully implemented|no code change|no (further |more )?work (is )?(needed|required|remain)/i;

const DONE_ANSWER = 'Nothing more to build. If the branch carries a diff, open the draft PR and hand over; '
  + 'if it does not, put the evidence (the PR that already landed it and the tests you ran) in your final report and stop.';

const TERMINAL_LANE_STATES = new Set<Lane['state']>(['killed', 'exhausted', 'done', 'unverified', 'merged']);
const DEAD_LANE_STATES = new Set<Lane['state']>(['killed', 'exhausted']);

function laneFor(item: QueueItem, lanes: Lane[]): Lane | undefined {
  if (!item.runKey) return undefined;
  const key = item.runKey;
  const mine = lanes.filter((lane) => lane.id === key || lane.id.startsWith(`${key}-`));
  if (!mine.length) return undefined;
  return mine.sort((a, b) => b.startedAt - a.startedAt)[0];
}

function labelOf(item: QueueItem, lane?: Lane): string {
  return item.ticket ?? lane?.title ?? item.input.split('\n')[0]!.replace(/^#\s*(Goal:\s*)?/i, '').slice(0, 70);
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 120 ? `${Math.round(m / 60)} h` : `${m} min`;
}

function blockersOn(item: QueueItem, lane: Lane | undefined, blockers: Blocker[]): Blocker[] {
  const keys = new Set<string>([item.id]);
  if (item.runKey) keys.add(item.runKey);
  if (lane) keys.add(lane.id);
  return blockers.filter((b) => b.blocks.some((x) => keys.has(x.laneId)
    || (item.runKey !== null && x.laneId.startsWith(`${item.runKey}-`))));
}

function askFinding(
  item: QueueItem | null, lane: Lane | undefined, question: { key: string | null; text: string }, label: string, whyOverride?: string,
): RoundsFinding {
  const looksDone = LOOKS_DONE.test(question.text);
  const why = whyOverride ?? (looksDone
    ? 'the worker asked a question that reads as a completion report; the brief already answers it'
    : 'the worker is waiting on an answer nobody has given');
  return {
    kind: 'ask', action: 'judge', itemId: item?.id ?? null, laneId: lane?.id ?? item?.runKey ?? null, label, why,
    ask: { key: question.key, text: question.text, looksDone, suggested: looksDone ? DONE_ANSWER : null },
  };
}

export function planRounds(input: RoundsInput): RoundsSheet {
  const params: RoundsParams = { ...DEFAULT_ROUNDS_PARAMS, ...input.params };
  const { now, lanes, blockers } = input;
  const findings: RoundsFinding[] = [];
  const healthy: RoundsSheet['healthy'] = [];
  const waiting: RoundsSheet['waiting'] = [];
  const claimedLanes = new Set<string>();

  for (const item of input.items) {
    if (item.state === 'done') continue;
    const lane = laneFor(item, lanes);
    if (item.runKey) {
      for (const l of lanes) if (l.id === item.runKey || l.id.startsWith(`${item.runKey}-`)) claimedLanes.add(l.id);
    }
    const label = labelOf(item, lane);
    const merged = item.pr?.merged === true || lane?.pr?.merged === true || lane?.state === 'merged';
    if (merged) {
      const no = item.pr?.no ?? lane?.pr?.no;
      findings.push({
        kind: 'done-still-open', action: 'remove', itemId: item.id, laneId: lane?.id ?? null, label,
        why: `its PR${no ? ` #${no}` : ''} has merged; the row is still ${item.state}`,
      });
      continue;
    }

    const mine = blockersOn(item, lane, blockers);
    const openQuestion = mine.find((b) => b.kind === 'question' && b.state !== 'resolved');
    const openOther = mine.filter((b) => b.kind !== 'question' && b.state !== 'resolved');
    const resolved = mine.filter((b) => b.state === 'resolved');

    if (item.state === 'running' || item.state === 'planning') {
      if (lane?.question) {
        findings.push(askFinding(item, lane, lane.question, label));
        continue;
      }
      if (openQuestion) {
        findings.push(askFinding(item, lane, { key: openQuestion.id.replace(/^question:/, ''), text: openQuestion.title }, label));
        continue;
      }
      const sinceUpdate = now - item.updatedAt;
      if (!lane) {
        if (sinceUpdate > params.silentAfterMs) {
          findings.push({
            kind: 'dead-worker', action: 'relaunch', itemId: item.id, laneId: item.runKey, label,
            why: `${item.state} for ${minutes(sinceUpdate)} with no run on the board`,
          });
        } else {
          healthy.push({ itemId: item.id, label, state: item.state, note: `${item.state} ${minutes(sinceUpdate)}, run not on the board yet` });
        }
        continue;
      }
      if (DEAD_LANE_STATES.has(lane.state)) {
        findings.push({
          kind: 'dead-worker', action: 'relaunch', itemId: item.id, laneId: lane.id, label,
          why: `the row says running but its run is ${lane.state}${lane.reason ? ` (${lane.reason.slice(0, 80)})` : ''}`,
        });
        continue;
      }
      if (lane.state === 'blocked' && lane.blockedBy) {
        waiting.push({ itemId: item.id, label, on: `${lane.blockedBy}${lane.reason ? `: ${lane.reason.slice(0, 80)}` : ''}` });
        continue;
      }
      if ((lane.state === 'running' || lane.state === 'blocked' || lane.state === 'paused') && !lane.live.alive) {
        const silent = now - lane.observedAt;
        // A warden park for a dead process (`blocked`, reason "its process is gone" and
        // the like) is a death already confirmed; the silent cap only applies while the
        // lane still reads `running` and could just be between events.
        const confirmedDead = lane.state !== 'running';
        if (confirmedDead || silent > params.silentAfterMs) {
          const prior = input.priorRelaunches?.(item.id) ?? 0;
          const why = confirmedDead
            ? `the row says running but the warden ${lane.state === 'paused' ? 'paused' : 'parked'} its run with no process${lane.reason ? ` (${lane.reason.slice(0, 90)})` : ''}`
            : `no process and nothing heard from the run for ${minutes(silent)} (cap ${minutes(params.silentAfterMs)})`;
          if (prior >= params.maxRelaunches) {
            findings.push({
              kind: 'dead-worker', action: 'judge', itemId: item.id, laneId: lane.id, label,
              why: `${why}; rounds already relaunched it ${prior} time${prior === 1 ? '' : 's'}, so the cause is not the launch`,
            });
          } else {
            findings.push({ kind: 'dead-worker', action: 'relaunch', itemId: item.id, laneId: lane.id, label, why });
          }
        } else {
          healthy.push({ itemId: item.id, label, state: item.state, note: `run quiet ${minutes(silent)}, under the ${minutes(params.silentAfterMs)} cap` });
        }
        continue;
      }
      if ((lane.state === 'done' || lane.state === 'unverified') && lane.endedAt !== null && now - lane.endedAt > params.silentAfterMs) {
        findings.push({
          kind: 'stuck-after-finish', action: 'judge', itemId: item.id, laneId: lane.id, label,
          why: `its run finished ${minutes(now - lane.endedAt)} ago${lane.pr ? ` with PR #${lane.pr.no}` : ' with no PR'} and the row never moved off ${item.state}`,
        });
        continue;
      }
      healthy.push({ itemId: item.id, label, state: item.state, note: lane.live.alive ? 'process alive' : `run ${lane.state}` });
      continue;
    }

    if (item.state === 'parked' || item.state === 'failed') {
      if (lane?.question) {
        findings.push(askFinding(item, lane, lane.question, label));
        continue;
      }
      if (openQuestion) {
        findings.push(askFinding(item, lane, { key: openQuestion.id.replace(/^question:/, ''), text: openQuestion.title }, label));
        continue;
      }
      if (openOther.length) {
        waiting.push({ itemId: item.id, label, on: openOther.map((b) => b.title).join('; ') });
        continue;
      }
      const transient = TRANSIENT_REASONS.find((t) => t.re.test(item.reason ?? ''));
      let why: string;
      if (resolved.length) why = `parked behind "${resolved[0]!.title}", which has since cleared`;
      else if (transient) why = `parked because ${transient.words}; nothing else is holding it`;
      else why = `parked ${minutes(now - item.updatedAt)} ago with no blocker on the board and no open question`;
      findings.push({ kind: 'unblocked', action: 'retry', itemId: item.id, laneId: lane?.id ?? null, label, why });
      continue;
    }

    healthy.push({ itemId: item.id, label, state: item.state, note: item.state === 'review' ? 'in review, PR not merged' : 'waiting its turn' });
  }

  for (const lane of lanes) {
    if (claimedLanes.has(lane.id) || lane.retiredAt) continue;
    if (TERMINAL_LANE_STATES.has(lane.state)) {
      const endedAt = lane.endedAt ?? lane.observedAt;
      if (now - endedAt > params.orphanAfterMs && (!lane.pr || lane.pr.merged) && !lane.heart) {
        findings.push({
          kind: 'orphan-lane', action: 'retire', itemId: null, laneId: lane.id, label: lane.title ?? lane.id,
          why: `${lane.state} ${minutes(now - endedAt)} ago, no queue row, ${lane.pr ? 'PR merged' : 'no PR'}`,
        });
      }
      continue;
    }
    if (lane.question && !lane.live.alive) {
      findings.push(askFinding(null, lane, lane.question, lane.title ?? lane.id, 'no queue row is waiting on it; the answer only clears the board'));
      continue;
    }
    if (!lane.live.alive && now - lane.observedAt > params.silentAfterMs) {
      findings.push({
        kind: 'zombie-lane', action: 'judge', itemId: null, laneId: lane.id, label: lane.title ?? lane.id,
        why: `reads ${lane.state} with no process for ${minutes(now - lane.observedAt)} and no queue row; a kill needs Confirm`,
      });
    }
  }

  // Questions still open on the blocker board whose lanes are not on the board at all
  // (retired, or never registered): nothing is waiting on the answer, and the open row
  // is what keeps the board looking blocked.
  const seenAskKeys = new Set(findings.filter((f) => f.ask?.key).map((f) => f.ask!.key));
  for (const b of blockers) {
    if (b.kind !== 'question' || b.state === 'resolved') continue;
    const key = b.id.replace(/^question:/, '');
    if (seenAskKeys.has(key)) continue;
    const laneIds = b.blocks.map((x) => x.laneId);
    if (laneIds.some((id) => claimedLanes.has(id))) continue;
    const onBoard = lanes.find((l) => laneIds.includes(l.id) && !l.retiredAt && l.live.alive);
    if (onBoard) continue;
    const boardLabel = b.blocks[0]?.label;
    const label = boardLabel && boardLabel !== 'a run' ? boardLabel : (TICKET_IN_TEXT.exec(b.title)?.[0] ?? laneIds[0] ?? key);
    findings.push(askFinding(null, undefined, { key, text: b.title }, label,
      'its run is gone from the board; the question is still open and nothing is waiting on the answer'));
  }

  return { at: now, params, findings, healthy, waiting };
}

// ---------------------------------------------------------------------------------------

export interface ApplyRoundsDeps {
  store: QueueStore;
  /** `retireLane(id, true, deps)` bound by the caller. */
  retire: (laneId: string) => { ok: boolean; message: string };
  journal: (event: Record<string, unknown>) => void;
  now?: () => number;
}

export interface RoundsReceipt {
  finding: RoundsFinding;
  applied: boolean;
  text: string;
}

/** Marks a running item parked with `reason`, then retries it. The retry lands on
 *  `running` with `retriedAt` set (`retryItem`'s own contract), which is what tells
 *  `advanceItem` to drop the dead run's key and launch a fresh worker instead of
 *  re-reading the dead run's verdict. */
export function relaunchItem(store: QueueStore, id: string, reason: string, now: number): QueueItem | undefined {
  const item = store.get(id);
  if (!item) return undefined;
  store.append({ id, at: now, state: 'parked', reason, updatedAt: now });
  return retryItem(store, id, now);
}

export function applyRounds(sheet: RoundsSheet, deps: ApplyRoundsDeps): RoundsReceipt[] {
  const now = (deps.now ?? Date.now)();
  const receipts: RoundsReceipt[] = [];
  for (const finding of sheet.findings) {
    let applied = false;
    let text: string;
    switch (finding.action) {
      case 'remove':
        applied = finding.itemId !== null && removeItem(deps.store, finding.itemId, now);
        text = applied ? `Cleared ${finding.label}: ${finding.why}.` : `Could not clear ${finding.label}: the row is gone already.`;
        break;
      case 'retry':
        applied = finding.itemId !== null && retryItem(deps.store, finding.itemId, now) !== undefined;
        text = applied ? `Restarted ${finding.label}: ${finding.why}.` : `Could not restart ${finding.label}: it is no longer parked.`;
        break;
      case 'relaunch':
        applied = finding.itemId !== null && relaunchItem(deps.store, finding.itemId, `rounds: ${finding.why}`, now) !== undefined;
        text = applied ? `Relaunched ${finding.label}: ${finding.why}.` : `Could not relaunch ${finding.label}: the row is gone.`;
        break;
      case 'retire': {
        const outcome = finding.laneId ? deps.retire(finding.laneId) : { ok: false, message: 'no lane' };
        applied = outcome.ok;
        text = applied ? `Archived ${finding.label}: ${finding.why}.` : `Could not archive ${finding.label}: ${outcome.message}`;
        break;
      }
      case 'judge':
      default:
        text = `${finding.label} needs a reading, not a rule: ${finding.why}.`;
        break;
    }
    if (applied) {
      deps.journal({
        event: 'rounds.applied', actor: 'conductor', kind: finding.kind, action: finding.action,
        ...(finding.itemId ? { item: finding.itemId } : {}), ...(finding.laneId ? { run: finding.laneId } : {}),
        why: finding.why,
      });
    }
    receipts.push({ finding, applied, text });
  }
  return receipts;
}

// ---------------------------------------------------------------------------------------

const KIND_WORDS: Record<RoundsKind, string> = {
  'done-still-open': 'Done but still on the queue',
  'dead-worker': 'Running with a dead worker',
  'stuck-after-finish': 'Finished but the queue never moved it',
  'unblocked': 'Parked with nothing holding it',
  'ask': 'Asking a question',
  'orphan-lane': 'Finished lanes with no queue row',
  'zombie-lane': 'Lanes that read running with no process',
};

const ACTION_WORDS: Record<RoundsAction, string> = {
  remove: 'clear the row', relaunch: 'relaunch', retry: 'restart', retire: 'archive the lane', judge: 'read and decide',
};

/** The sheet as a person reads it: findings grouped by kind, worst first, then what was
 *  left alone and why, so a short sheet still says what it looked at. */
export function formatRoundsSheet(sheet: RoundsSheet, mode: 'dry-run' | 'applied' = 'dry-run'): string[] {
  const lines: string[] = [];
  const order: RoundsKind[] = ['dead-worker', 'stuck-after-finish', 'ask', 'unblocked', 'done-still-open', 'zombie-lane', 'orphan-lane'];
  lines.push(`Rounds ${mode === 'dry-run' ? '(dry run, nothing changed)' : '(applied)'}: ${sheet.findings.length} finding${sheet.findings.length === 1 ? '' : 's'}, `
    + `${sheet.waiting.length} waiting on a real blocker, ${sheet.healthy.length} healthy. `
    + `Dead after ${minutes(sheet.params.silentAfterMs)} silent; orphan after ${minutes(sheet.params.orphanAfterMs)}.`);
  for (const kind of order) {
    const group = sheet.findings.filter((f) => f.kind === kind);
    if (!group.length) continue;
    lines.push('');
    lines.push(`${KIND_WORDS[kind]} (${group.length}) -> ${ACTION_WORDS[group[0]!.action]}`);
    for (const f of group) {
      lines.push(`  ${f.label}${f.itemId ? ` [${f.itemId}]` : f.laneId ? ` [${f.laneId}]` : ''}: ${f.why}`);
      if (f.ask) {
        lines.push(`    asked: ${f.ask.text.replace(/\s+/g, ' ').slice(0, 160)}`);
        if (f.ask.suggested) lines.push(`    suggested answer: ${f.ask.suggested}`);
      }
    }
  }
  if (sheet.waiting.length) {
    lines.push('');
    lines.push(`Waiting on a real blocker (${sheet.waiting.length}), left alone`);
    for (const w of sheet.waiting) lines.push(`  ${w.label} [${w.itemId}]: ${w.on}`);
  }
  if (sheet.healthy.length) {
    lines.push('');
    lines.push(`Healthy (${sheet.healthy.length}), left alone`);
    for (const h of sheet.healthy) lines.push(`  ${h.label} [${h.itemId}] ${h.state}: ${h.note}`);
  }
  return lines;
}
