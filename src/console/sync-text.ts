/**
 * Pure templates for the re-sync surfaces (R-71): the header watcher line, one row per
 * sync stage, and the card's run summary. No narration call, no `?verbose` register --
 * everything here renders straight from the value it is given.
 */
import type { SyncRunRecord, SyncStage, WatcherStatus } from './sync-types.js';

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function watcherLine(status: WatcherStatus, now: number): string {
  if (!status.on) return 'Watcher off';
  if (status.lastError) return `Watcher error: ${status.lastError}`;
  const last = status.lastPollAt !== undefined ? hhmm(status.lastPollAt) : '--:--';
  const count = status.lastCount ?? 0;
  const next = status.nextPollAt !== undefined
    ? Math.max(0, Math.round((status.nextPollAt - now) / 1000))
    : (status.lastPollAt !== undefined ? Math.max(0, Math.round((status.lastPollAt + status.pollSeconds * 1000 - now) / 1000)) : status.pollSeconds);
  return `Watching ${status.project ?? 'no project'} · last poll ${last} · ${count} owned · next in ${next} s`;
}

function countsText(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(', ');
}

export function stageLine(stage: SyncStage): string {
  if (stage.status === 'failed') return `${stage.name} · failed · ${stage.message ?? 'no message'}`;
  if (stage.status === 'skipped') return `${stage.name} · skipped`;
  if (stage.status === 'running') return `${stage.name} · running`;
  const counts = countsText(stage.counts);
  return counts ? `${stage.name} · ok · ${counts}` : `${stage.name} · ok`;
}

export function runSummary(run: SyncRunRecord | null): string {
  if (!run) return 'never synced';
  const failed = run.stages.find((s) => s.status === 'failed');
  if (failed) return `failed at ${failed.name} · ${failed.message ?? 'no message'}`;
  const running = run.stages.find((s) => s.status === 'running');
  if (running) return `running · ${running.name}`;
  if (run.ok) {
    const n = run.stages.length;
    return `synced ok · ${n} stage${n === 1 ? '' : 's'}`;
  }
  return 'sync did not complete';
}
