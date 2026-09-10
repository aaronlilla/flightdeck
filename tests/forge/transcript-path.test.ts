/**
 * The drift judge needs the run's real SDK transcript file. `cwdKey` has to match the
 * CLI's own encoding exactly, or the judge reads nothing and silently drifts back to
 * tool-names-only behaviour.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cwdKey, readTranscriptTail, transcriptPathFor } from '../../src/forge/transcript-path.js';

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
