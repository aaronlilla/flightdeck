import { describe, expect, it } from 'vitest';

import { classifyExit, classifyVanished, type SessionEndReason } from '../../../src/forge/sessions/exit.js';

const REASONS: SessionEndReason[] = ['clear', 'resume', 'logout', 'prompt_input_exit', 'other'];

describe('classifyExit', () => {
  const expected: Record<SessionEndReason, { withComplete: string; withoutComplete: string }> = {
    logout: { withComplete: 'done', withoutComplete: 'done' },
    clear: { withComplete: 'done', withoutComplete: 'abandoned' },
    resume: { withComplete: 'continuing', withoutComplete: 'continuing' },
    prompt_input_exit: { withComplete: 'done', withoutComplete: 'interrupted' },
    other: { withComplete: 'done', withoutComplete: 'unknown' },
  };

  for (const reason of REASONS) {
    it(`reason=${reason} closedWithComplete=true -> ${expected[reason].withComplete}`, () => {
      expect(classifyExit(reason, true)).toBe(expected[reason].withComplete);
    });
    it(`reason=${reason} closedWithComplete=false -> ${expected[reason].withoutComplete}`, () => {
      expect(classifyExit(reason, false)).toBe(expected[reason].withoutComplete);
    });
  }

  it('a vanished row with no SessionEnd classifies as killed', () => {
    expect(classifyVanished()).toBe('killed');
  });
});
