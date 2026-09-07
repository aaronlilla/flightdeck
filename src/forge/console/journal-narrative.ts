/**
 * `GET /run/:id/journal`: the ticket sheet's "Journal" panel -- the run's own timeline
 * (polled from queue, sandbox provisioned or failed, branch pushed, gate opened, then a
 * state-specific closing line), read off the real journal and chain state rather than
 * filtered from the rail's reply/receipt cards (that filter is what it replaced -- see
 * `thread.ts`'s `computeRunThread`, still the source for the run's own thread column).
 *
 * Each line only appears once its event has actually happened. A run still mid-flight
 * gets a shorter list than a finished one, never a placeholder for a milestone that has
 * not happened yet.
 */
import type { ChainPacketState } from '../chain.js';
import type { ForgeEvent } from '../journal.js';
import type { JournalNarrativeEntry, Lane } from '../../shared/console-model.js';
import { fmtTokens } from '../../shared/format-tokens.js';
import { textFor } from './journal-route.js';

function firstEventAt(events: ForgeEvent[], name: string, matches: (row: ForgeEvent) => boolean): number | undefined {
  for (const row of events) {
    if (row.event === name && matches(row)) return row.at;
  }
  return undefined;
}

function lastEventAt(events: ForgeEvent[], name: string, matches: (row: ForgeEvent) => boolean): number | undefined {
  let found: number | undefined;
  for (const row of events) {
    if (row.event === name && matches(row)) found = row.at;
  }
  return found;
}

/** `run.*` rows carry `run`; `chain.*` rows carry `packetId` instead (a packet has not
 *  always launched a run yet), so a narrative line's timestamp is looked up by whichever
 *  key that event kind actually journals under. */
function byRun(events: ForgeEvent[], run: string, name: string): number | undefined {
  return firstEventAt(events, name, (row) => row.run === run);
}

function lastByRun(events: ForgeEvent[], run: string, name: string): number | undefined {
  return lastEventAt(events, name, (row) => row.run === run);
}

function byPacket(events: ForgeEvent[], packetId: string, name: string): number | undefined {
  return firstEventAt(events, name, (row) => row.packetId === packetId);
}

export function computeJournalNarrative(
  lane: Lane, events: ForgeEvent[], packet: ChainPacketState | undefined, now: number,
): JournalNarrativeEntry[] {
  const entries: JournalNarrativeEntry[] = [];
  const startedAt = byRun(events, lane.id, 'run.started') ?? lane.startedAt;
  entries.push({ t: startedAt, text: `polled ${lane.id} from queue`, color: 'var(--ink2)' });

  const packetId = packet?.packetId;
  const provisionedAt = packetId ? byPacket(events, packetId, 'chain.provisioned') : undefined;
  const blockedAt = packetId && packet?.blocked?.hop === 'provision' ? byPacket(events, packetId, 'chain.blocked') : undefined;
  if (provisionedAt !== undefined) {
    entries.push({ t: provisionedAt, text: `sandbox ${lane.sandbox?.id ?? lane.id} provisioned`, color: 'var(--ink2)' });
  } else if (blockedAt !== undefined) {
    entries.push({ t: blockedAt, text: `provision failed · ${packet?.blocked?.reason ?? 'blocked'}`, color: 'var(--block)' });
  }

  if (provisionedAt !== undefined && packetId) {
    const launchedAt = byPacket(events, packetId, 'chain.launched');
    if (launchedAt !== undefined) {
      const branch = packet?.provisioned?.branch ?? lane.id;
      entries.push({ t: launchedAt, text: `branch ${branch} pushed · ${lane.model}`, color: 'var(--ink2)' });
    }
  }

  const gatedAt = packetId ? byPacket(events, packetId, 'chain.gated') : undefined;
  if (gatedAt !== undefined) entries.push({ t: gatedAt, text: 'gate opened · council judge ×3', color: 'var(--ink2)' });

  if (lane.state === 'parked') {
    entries.push({ t: lastByRun(events, lane.id, 'run.parked') ?? lane.since, text: 'parked — needs human', color: 'var(--park)' });
  } else if (lane.state === 'merged') {
    const mergedAt = packetId ? lastEventAt(events, 'chain.merged', (row) => row.packetId === packetId) : undefined;
    entries.push({ t: mergedAt ?? lane.since, text: 'merged → main · jira updated', color: 'var(--merge)' });
  } else if (lane.state === 'killed') {
    entries.push({ t: lastByRun(events, lane.id, 'run.killed') ?? lane.endedAt ?? lane.since, text: 'killed · diff discarded', color: 'var(--block)' });
  } else if (lane.runaway) {
    entries.push({ t: now, text: `build failing ×${lane.fails} · ${fmtTokens(lane.tokens)} tokens`, color: 'var(--block)' });
  }

  return entries;
}

/** `warden.parked`/`liveness.stuck` rows this collapse targets -- the two event kinds
 *  a stuck-session trip re-fires on every liveness tick for as long as it stands. */
const WARDEN_CHIP_EVENTS = new Set(['warden.parked', 'liveness.stuck']);

/** A key that names no real Forge lane, only a bare OS process id -- `liveness.ts`'s own
 *  key for a fleet process nothing in the registry or the lane store recognizes. */
const BARE_PID_PATTERN = /^pid:\d+$/i;

export interface WardenChip {
  at: number;
  lane: string;
  text: string;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * H1.9: the conductor rail's own chip storm (`PID:51340 STUCK (STALE-SESSION)` x 20,
 * live on the board 2026-09-07) -- a stuck-session trip re-fires the same
 * `warden.parked`/`liveness.stuck` row on every liveness tick for as long as it stands,
 * and the rail rendered every one of them as its own chip.
 *
 * Every warden/liveness row for the same lane collapses into one chip, with a count and
 * the latest time once there is more than one; a row naming no real lane at all -- only
 * a bare `PID:<n>` key, never a registered run or lane -- never reaches the rail as a
 * chip, though it stays exactly as it was in the raw `/journal` feed, which this
 * function never touches.
 */
export function collapseWardenChips(events: ForgeEvent[]): WardenChip[] {
  const order: string[] = [];
  const byLane = new Map<string, ForgeEvent[]>();
  for (const row of events) {
    if (!WARDEN_CHIP_EVENTS.has(row.event)) continue;
    const lane = typeof row.run === 'string' && row.run ? row.run : String(row['key'] ?? '');
    if (!lane) continue;
    if (!byLane.has(lane)) {
      byLane.set(lane, []);
      order.push(lane);
    }
    byLane.get(lane)!.push(row);
  }

  const chips: WardenChip[] = [];
  for (const lane of order) {
    if (BARE_PID_PATTERN.test(lane)) continue;
    const rows = byLane.get(lane)!;
    const latest = rows[rows.length - 1]!;
    if (rows.length === 1) {
      chips.push({ at: latest.at, lane, text: textFor(latest) });
      continue;
    }
    chips.push({
      at: latest.at, lane,
      text: `${textFor(latest)} (×${rows.length}, latest ${clockTime(latest.at)})`,
    });
  }
  return chips;
}
