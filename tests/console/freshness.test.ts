import { describe, expect, it } from 'vitest';

import { computeFreshness, freshnessStamp, hm } from '../../src/console/freshness.js';
import { VERIFIED_WINDOW_MS } from '../../src/shared/console-model.js';

describe('computeFreshness', () => {
  it('is verified when the feed is live and the heartbeat is fresh', () => {
    const now = 1_000_000;
    const f = computeFreshness(now - 3_000, now - 60_000, true, now);
    expect(f.verified).toBe(true);
    expect(f.at).toBe(now - 3_000);
  });

  it('is observed once the heartbeat crosses the verified window', () => {
    const now = 1_000_000;
    const f = computeFreshness(now - VERIFIED_WINDOW_MS - 1, now - 60_000, true, now);
    expect(f.verified).toBe(false);
    expect(f.at).toBe(now - 60_000);
  });

  it('is observed the instant the feed drops, even with a fresh heartbeat', () => {
    const now = 1_000_000;
    const f = computeFreshness(now - 1_000, now - 60_000, false, now);
    expect(f.verified).toBe(false);
  });

  it('is observed when nothing has ever verified this value', () => {
    const now = 1_000_000;
    const f = computeFreshness(null, now - 60_000, true, now);
    expect(f.verified).toBe(false);
    expect(f.at).toBe(now - 60_000);
  });

  it('renders the two stamp forms the HANDOFF names', () => {
    const now = 1_000_000;
    const verified = computeFreshness(now - 4_000, now, true, now);
    expect(freshnessStamp(verified)).toBe('✓ verified 4s ago');
    const observed = computeFreshness(null, Date.parse('2026-01-01T09:05:00'), true, Date.parse('2026-01-01T09:05:00'));
    expect(freshnessStamp(observed)).toBe(`observed ${hm(Date.parse('2026-01-01T09:05:00'))}`);
  });
});
