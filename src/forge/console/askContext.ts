import type { QueueItem } from '../../shared/console-model.js';

/**
 * Whether an open question still belongs to work that exists, and what that work is
 * called.
 *
 * The escape, measured live on 2026-09-12: the console offered 92 open questions and
 * **90 of them pointed at a queue item that no longer exists.** Aaron, looking at one of
 * them: "a question and answers that are so vague I could never possibly know what it's
 * about, it's a worthless question that can never be answered by a human reasonably
 * without extensive research."
 *
 * The wording was not the problem. "Once Joe and I agree numbers, is flipping
 * LAUNCH_CHECK_ENABLED to true part of this ticket?" is answerable the moment you know
 * WHICH ticket, and unanswerable without it -- and the only pointer the card carried was
 * `item:Q-dc5d6c90`, whose queue row had been pruned. Answering it would post to work
 * that has gone.
 *
 * This is the question-shaped twin of a confirm outliving its token. The same two
 * answers apply: an ask whose work is gone is not an ask, and one whose work is live
 * says which work it is.
 */

/** A run reference as an ask carries it: `item:Q-dc5d6c90`, or a lane id. */
export function queueIdFrom(source: string): string | null {
  const match = /^item:(\S+)$/.exec(source.trim());
  return match?.[1] ?? null;
}

export interface AskContext {
  /** True while the work this ask is about still exists. */
  live: boolean;
  /** What to call that work: its ticket key, else null. */
  label: string | null;
}

export interface AskLookupInput {
  items: QueueItem[];
  /** Every lane id the fleet still knows, retired or not. */
  laneIds: ReadonlySet<string>;
}

/**
 * Resolves one ask's run reference.
 *
 * An ask with no run reference at all reads as LIVE, not dead. Nothing about a missing
 * reference says the work is gone, and dropping an ask on that basis would hide a real
 * question — the fail-closed direction here is to keep asking.
 */
export function askContextFor(source: string, input: AskLookupInput): AskContext {
  const trimmed = source.trim();
  if (trimmed.length === 0 || trimmed === 'system') return { live: true, label: null };
  const queueId = queueIdFrom(trimmed);
  if (queueId !== null) {
    const item = input.items.find((row) => row.id === queueId);
    if (item) return { live: true, label: item.ticket };
    return { live: false, label: null };
  }
  // A lane reference: live while the fleet still knows the lane at all.
  if (input.laneIds.has(trimmed)) return { live: true, label: null };
  return { live: false, label: null };
}

/** Resolves the runs an ask names, worst case first: the first one that is live wins,
 *  and an ask naming no live run at all is dead. */
export function askContextForRuns(runs: readonly string[], input: AskLookupInput): AskContext {
  if (runs.length === 0) return { live: true, label: null };
  let label: string | null = null;
  for (const run of runs) {
    const context = askContextFor(run, input);
    if (context.live) return context;
    label = label ?? context.label;
  }
  return { live: false, label };
}
