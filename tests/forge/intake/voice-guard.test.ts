/**
 * Requirement 4, voice half — every Jira write goes out in Aaron's voice; a write
 * carrying third-person "Aaron" phrasing or agent self-narration must never reach the
 * sink.
 *
 * `voiceGuard.ts` is Intake's own proven detector (order 2): watched red first against
 * `naiveSkipGuard`, a stub that always passes, then confirmed it actually catches the
 * two specimens the brief names. Separately, when the real machine hook
 * (`~/.claude/hooks/authorship_guard.py`) is present on this machine, this file also
 * shells out to it and checks it denies the same specimens — skipped, not failed, when
 * the hook is absent (true on CI and on any machine without this personal harness
 * installed), so `npm run verify` never depends on a file outside this repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { naiveSkipGuard, voiceGuard } from '../../../src/forge/intake/voiceGuard.js';

const THIRD_PERSON = 'Aaron reported on 2026-09-04 that the login screen crashes on cold start.';
const SESSION_NARRATION = 'I searched the codebase and found the bug during this session.';
const CLEAN = 'Filed the fix. The crash was a null check missing in LoginScreen.tsx.';

describe('naiveSkipGuard — the red specimen this stream watched fail', () => {
  it('passes everything, including the two specimens the real guard must catch', () => {
    expect(naiveSkipGuard(THIRD_PERSON).ok).toBe(true);
    expect(naiveSkipGuard(SESSION_NARRATION).ok).toBe(true);
  });
});

describe('voiceGuard — the proven detector', () => {
  it('denies third-person "Aaron ... reported/wrote" phrasing', () => {
    expect(voiceGuard(THIRD_PERSON).ok).toBe(false);
  });

  it('denies first-person session narration ("I searched", "this session")', () => {
    expect(voiceGuard(SESSION_NARRATION).ok).toBe(false);
  });

  it('passes clean, first-person-or-neutral text', () => {
    expect(voiceGuard(CLEAN).ok).toBe(true);
  });
});

const REAL_HOOK = join(homedir(), '.claude', 'hooks', 'authorship_guard.py');
const hookPresent = existsSync(REAL_HOOK);

describe.skipIf(!hookPresent)('the real machine hook (present on this box only)', () => {
  function deniesViaRealHook(body: string): boolean {
    const payload = JSON.stringify({
      tool_name: 'mcp__atlassian__addCommentToJiraIssue',
      tool_input: { comment: body },
      cwd: process.cwd(),
    });
    const out = execFileSync('python', [REAL_HOOK], { input: payload, encoding: 'utf8' });
    const parsed = JSON.parse(out);
    return parsed?.hookSpecificOutput?.permissionDecision === 'deny';
  }

  it('denies the third-person specimen', () => {
    expect(deniesViaRealHook(THIRD_PERSON)).toBe(true);
  });

  it('denies the session-narration specimen', () => {
    expect(deniesViaRealHook(SESSION_NARRATION)).toBe(true);
  });
});
