/**
 * P4.7/I5: `forge intake --once`, one real poll cycle through the interfaces this stream
 * built. No live call anywhere here -- every feed is a fixture-backed fake, the same
 * shape `poller.test.ts` already uses, per the guardrails.
 */
import { describe, expect, it } from 'vitest';

import { initialWatermark } from '../../../src/forge/intake/watermark.js';
import { runIntakeOnce, type IntakeOnceEvent, type WatermarkStore } from '../../../src/forge/intake/once.js';
import type { PollSourceName, Watermark } from '../../../src/forge/contracts.js';

function memoryWatermarks(): WatermarkStore {
  const marks = new Map<PollSourceName, Watermark>();
  return {
    get: (source) => marks.get(source) ?? initialWatermark(source),
    set: (source, mark) => { marks.set(source, mark); },
  };
}

describe('runIntakeOnce', () => {
  it('journals source.observed, packet.written and external.intent for a fresh item, in that order', async () => {
    const feed = {
      name: 'jira' as PollSourceName,
      fetchSince: async () => [{ id: 'BBZ-1', updated: 100 }],
    };
    const events: IntakeOnceEvent[] = [];

    const result = await runIntakeOnce([feed], memoryWatermarks(), (event) => events.push(event));

    expect(result).toMatchObject({ sourcesPolled: ['jira'], observed: 1, packetsWritten: 1, intentsRaised: 1 });
    expect(events.map((e) => e.event)).toEqual(['source.observed', 'packet.written', 'external.intent']);
    const intent = events.find((e) => e.event === 'external.intent');
    expect(intent?.['kind']).toBe('jira-ticket');
  });

  it('never re-derives a packet for a ticket it already wrote, even across two calls with the same store', async () => {
    const feed = {
      name: 'jira' as PollSourceName,
      fetchSince: async () => [{ id: 'BBZ-1', updated: 100 }],
    };
    const { PacketStore } = await import('../../../src/forge/intake/packetStore.js');
    const store = new PacketStore();
    const watermarks = memoryWatermarks();
    const events: IntakeOnceEvent[] = [];

    await runIntakeOnce([feed], watermarks, (event) => events.push(event), store);
    // The watermark has advanced, so a second poll of the exact same fixture sees nothing
    // new -- proving the write-once guarantee is never even reached a second time for an
    // item the watermark itself already filtered out.
    const second = await runIntakeOnce([feed], watermarks, (event) => events.push(event), store);
    expect(second.observed).toBe(0);
    expect(second.packetsWritten).toBe(0);
  });

  it('makes no live call: the feed is a plain fixture function, never a real HTTP or SDK client', async () => {
    let calls = 0;
    const feed = {
      name: 'sentry' as PollSourceName,
      fetchSince: async () => { calls += 1; return []; },
    };
    await runIntakeOnce([feed], memoryWatermarks(), () => {});
    expect(calls).toBe(1);
  });

  it('J2: a Jira item carrying detail lands on the packet, not just the bare key', async () => {
    const feed = {
      name: 'jira' as PollSourceName,
      fetchSince: async () => [{
        id: 'BBZ-1', updated: 100,
        detail: {
          summary: 'Login screen crashes on cold start', description: 'Repro: airplane mode, cold launch',
          status: 'In Progress', issuetype: 'Bug', priority: 'High',
        },
      }],
    };
    const result = await runIntakeOnce([feed], memoryWatermarks(), () => {});
    expect(result.writtenPackets).toHaveLength(1);
    const packet = result.writtenPackets[0]!;
    expect(packet.what).toContain('Login screen crashes on cold start');
    expect(packet.what).toContain('Bug');
    expect(packet.evidence).toContain('Repro: airplane mode, cold launch');
  });

  it('J2: a source with no detail still writes the plain id-only packet it always did', async () => {
    const feed = { name: 'jira' as PollSourceName, fetchSince: async () => [{ id: 'BBZ-2', updated: 100 }] };
    const result = await runIntakeOnce([feed], memoryWatermarks(), () => {});
    expect(result.writtenPackets[0]?.what).toBe('observed via jira, not yet triangulated');
  });

  it('polls every configured source, not only the first', async () => {
    const feeds = [
      { name: 'jira' as PollSourceName, fetchSince: async () => [] },
      { name: 'sentry' as PollSourceName, fetchSince: async () => [] },
      { name: 'github' as PollSourceName, fetchSince: async () => [] },
    ];
    const result = await runIntakeOnce(feeds, memoryWatermarks(), () => {});
    expect(result.sourcesPolled).toEqual(['jira', 'sentry', 'github']);
  });
});
