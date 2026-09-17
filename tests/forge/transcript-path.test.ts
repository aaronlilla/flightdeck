/**
 * The drift judge needs the run's real SDK transcript file. `cwdKey` has to match the
 * CLI's own encoding exactly, or the judge reads nothing and silently drifts back to
 * tool-names-only behaviour.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cwdKey, findTranscriptPath, readTranscriptTail, transcriptPathFor,
} from '../../src/forge/transcript-path.js';

describe('cwdKey', () => {
  it('replaces colons, backslashes and slashes with dashes', () => {
    expect(cwdKey('D:\\repos\\project')).toBe('D--repos-project');
    expect(cwdKey('D:\\repos\\project\\sub-dir')).toBe('D--repos-project-sub-dir');
  });

  it('handles a posix-style path the same way', () => {
    expect(cwdKey('/srv/checkouts/project')).toBe('-srv-checkouts-project');
  });
});

describe('transcriptPathFor', () => {
  it('joins configDir/projects/<cwd-key>/<sessionId>.jsonl', () => {
    const path = transcriptPathFor('D:\\fake\\config', 'D:\\fake\\worktree--x', 'sess-1');
    expect(path).toBe(join('D:\\fake\\config', 'projects', 'D--fake-worktree--x', 'sess-1.jsonl'));
  });
});

/**
 * Aaron, 2026-09-14: every queue run parked as "its log is empty with no work recorded"
 * within a minute of launching. The judge was handed the fleet login's folder, but runs
 * launch on a linked account and the SDK writes the transcript under that account's
 * folder, so the file never existed where it was looked for.
 */
describe('findTranscriptPath', () => {
  const CWD = 'D:\\fake\\worktree--bbz-304';
  const SESSION = 'b33b63bd-188c-49c8-877e-7d4129dc9f4f';

  it("finds the transcript under the account the run launched on, not only the fleet login's folder", () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-find-transcript-'));
    const fleet = join(root, 'fleet');
    const account = join(root, 'account');
    mkdirSync(join(fleet, 'projects'), { recursive: true });
    const expected = transcriptPathFor(account, CWD, SESSION);
    mkdirSync(join(account, 'projects', cwdKey(CWD)), { recursive: true });
    writeFileSync(expected, '{"type":"assistant"}\n');

    expect(findTranscriptPath([fleet, account], CWD, SESSION)).toBe(expected);
  });

  it('returns undefined when no folder has the transcript yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'forge-find-transcript-'));
    expect(findTranscriptPath([join(root, 'fleet'), join(root, 'account')], CWD, SESSION)).toBeUndefined();
  });
});

describe('readTranscriptTail', () => {
  it('returns the last N non-blank lines, oldest first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-transcript-'));
    const file = join(dir, 'sess.jsonl');
    writeFileSync(file, ['{"a":1}', '', '{"a":2}', '{"a":3}', '{"a":4}'].join('\n'));
    expect(readTranscriptTail(file, 2)).toBe('{"a":3}\n{"a":4}');
  });

  it('returns an empty string for a file that does not exist, never throws', () => {
    expect(readTranscriptTail('Z:\\nope\\nothing.jsonl', 40)).toBe('');
  });
});
