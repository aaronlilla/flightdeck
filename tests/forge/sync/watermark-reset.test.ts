/**
 * R-68 item 2: `resetWatermarks(dir)` deletes every `*.watermark.json` in `dir` and
 * nothing else, returning what it deleted.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resetWatermarks } from '../../../src/forge/intake/watermarkStore.js';

describe('resetWatermarks', () => {
  it('deletes two watermark files and keeps an unrelated one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sync-watermark-reset-'));
    writeFileSync(join(dir, 'jira.watermark.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'sentry.watermark.json'), '{}', 'utf8');
    writeFileSync(join(dir, 'briefs.json'), '{}', 'utf8');

    const deleted = resetWatermarks(dir);

    expect(deleted.sort()).toEqual(['jira.watermark.json', 'sentry.watermark.json']);
    expect(existsSync(join(dir, 'jira.watermark.json'))).toBe(false);
    expect(existsSync(join(dir, 'sentry.watermark.json'))).toBe(false);
    expect(existsSync(join(dir, 'briefs.json'))).toBe(true);
  });

  it('a missing directory returns an empty list rather than throwing', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'sync-watermark-reset-')), 'missing');
    expect(resetWatermarks(dir)).toEqual([]);
  });
});
