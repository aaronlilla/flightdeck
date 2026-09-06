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
    entries.push({ t: now, text: `build failing ×${lane.fails} · $${lane.costUsd.toFixed(2)}`, color: 'var(--block)' });
  }

  return entries;
}
