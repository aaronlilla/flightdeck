/**
 * R-101: the self-test switch is an end time, so it turns itself off.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SELF_TEST_MAX_MINUTES, readSelfTestUntil, writeSelfTest } from '../../../src/forge/sync/feed-self-test.js';

const NOW = Date.parse('2026-09-14T09:00:00Z');

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'feed-self-test-')), 'jira-feed-self-test.json');
}

describe('feed self-test switch', () => {
  it('is off when never set', () => {
    expect(readSelfTestUntil(tempPath(), NOW)).toBeNull();
  });

  it('is on until its end time, and off from then on with nobody touching it', () => {
    const path = tempPath();
    const until = writeSelfTest(30, path, NOW);
    expect(until).toBe(NOW + 30 * 60_000);
    expect(readSelfTestUntil(path, NOW + 29 * 60_000)).toBe(until);
    expect(readSelfTestUntil(path, NOW + 30 * 60_000)).toBeNull();
  });

  it('turns off at 0 minutes, and clamps a long request to the maximum', () => {
    const path = tempPath();
    writeSelfTest(30, path, NOW);
    expect(writeSelfTest(0, path, NOW)).toBeNull();
    expect(readSelfTestUntil(path, NOW)).toBeNull();
    expect(writeSelfTest(100_000, path, NOW)).toBe(NOW + SELF_TEST_MAX_MINUTES * 60_000);
  });

  it('reads a corrupt file as off', () => {
    const path = tempPath();
    writeFileSync(path, '{nope', 'utf8');
    expect(readSelfTestUntil(path, NOW)).toBeNull();
  });
});
