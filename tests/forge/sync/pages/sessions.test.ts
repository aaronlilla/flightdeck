import { describe, expect, test, vi } from 'vitest';

import { syncSessions } from '../../../../src/forge/sync/pages/sessions.js';
import type { SessionRow } from '../../../../src/forge/sessions/registry.js';
import type { FleetState } from '../../../../src/forge/journal.js';
import type { IngestDeps } from '../../../../src/forge/sessions/ingest.js';

function emptyFold(): FleetState {
  return { events: [], runs: {}, burn: {}, handoffs: 0, torn: 0, unknownModels: [], sessions: {} };
}

function makeIngest(): IngestDeps & { received: unknown[] } {
  const received: unknown[] = [];
  return {
    received,
    append: (row) => {
      received.push(row);
      return row as never;
    },
    lastStopFor: () => undefined,
    sweep: (sessionId: string) => {
      received.push({ swept: sessionId });
      return { releasedLocks: [] };
    },
    worktreeStatusFor: () => undefined,
  };
}

describe('syncSessions', () => {
  test('two live and one dead row: ended:1, ingest receives the vanished row, sweep called once', async () => {
    const scan: SessionRow[] = [
      { sessionId: 'a', cwd: 'D:/work/a', name: 'a', pid: 1 },
      { sessionId: 'b', cwd: 'D:/work/b', name: 'b', pid: 2 },
      { sessionId: 'c', cwd: 'D:/work/c', name: 'c', pid: 3, vanished: true },
    ] as SessionRow[];
    const ingest = makeIngest();
    let sweepCalls = 0;
    const sweep = vi.fn(async () => {
      sweepCalls += 1;
      return 'ok';
    });

    const result = await syncSessions({
      scan: () => scan,
      fold: () => emptyFold(),
      ingest,
      sweep,
    });

    expect(result.counts.live).toBe(2);
    expect(result.counts.ended).toBe(1);
    expect(ingest.received).toContainEqual(
      expect.objectContaining({ event: 'session.vanished', session: 'c' }),
    );
    expect(sweepCalls).toBe(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(result.message).toBe('watching every 5 s');
  });

  test('sweep throwing: counts still returned, message carries the error, no throw', async () => {
    const scan: SessionRow[] = [
      { sessionId: 'a', cwd: 'D:/work/a', name: 'a', pid: 1 },
    ] as SessionRow[];
    const ingest = makeIngest();
    const sweep = vi.fn(async () => {
      throw new Error('sweep boom');
    });

    const result = await expect(
      syncSessions({ scan: () => scan, fold: () => emptyFold(), ingest, sweep }),
    ).resolves.toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({ live: 1, ended: 0 }),
        message: expect.stringContaining('sweep boom'),
      }),
    );
  });
});
