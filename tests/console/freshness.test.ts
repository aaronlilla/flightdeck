import { describe, expect, it } from 'vitest';

import { ago, computeFreshness, freshnessStamp, hm } from '../../src/console/freshness.js';
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

  // Prototype's `fresh(l)`: `feed.live && l.heart && (now-l.verifiedAt)<15000`.
  it('is observed when the source has stopped heartbeating, even inside the window', () => {
    const now = 1_000_000;
    const f = computeFreshness(now - 3_000, now - 60_000, true, now, false);
    expect(f.verified).toBe(false);
    expect(f.at).toBe(now - 60_000);
  });

  it('defaults heart to true for callers with no heartbeat of their own', () => {
    const now = 1_000_000;
    const f = computeFreshness(now - 3_000, now - 60_000, true, now);
    expect(f.verified).toBe(true);
  });

  it('renders the two stamp forms the HANDOFF names', () => {
    const now = 1_000_000;
    const verified = computeFreshness(now - 4_000, now, true, now);
    expect(freshnessStamp(verified)).toBe('✓ verified 4s ago');
    const observed = computeFreshness(null, Date.parse('2026-01-01T09:05:00'), true, Date.parse('2026-01-01T09:05:00'));
    expect(freshnessStamp(observed)).toBe(`observed ${hm(Date.parse('2026-01-01T09:05:00'))}`);
  });
});

// Matches the prototype's `ago(ms)`: seconds under a minute, minutes under an hour,
// hours beyond that.
describe('ago', () => {
  it('renders seconds under a minute', () => {
    expect(ago(45_000)).toBe('45s');
  });

  it('renders minutes under an hour', () => {
    expect(ago(5 * 60_000)).toBe('5m');
  });

  it('renders hours beyond that', () => {
    expect(ago(3 * 3_600_000)).toBe('3h');
  });
});
