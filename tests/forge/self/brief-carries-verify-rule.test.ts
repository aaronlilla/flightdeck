/**
 * Item 7, 2026-09-12: a long check kills the run that starts it.
 *
 * Anything past the 120-second foreground limit is moved to the background, and a run
 * that ends its turn waiting on one dies on nudges with its work uncommitted. On one
 * ticket six runs wrote the whole change, passed their own tests, and died that way,
 * because the project's `verify` chains a type check, a lint pass and a full test run
 * at minutes each.
 *
 * The routine carrying the fix is on the trunk. What was missing is this: nothing
 * failed if it stopped reaching the worker. It arrives only because `general` is always
 * in the keyword list AND the routine is tagged `general`, and either half could change
 * silently. These specimens assert the brief a worker is actually handed, through the
 * same function `queue-wire.ts` writes to disk.
 */
import { describe, expect, it } from 'vitest';

import { routinesDir } from '../../../src/forge/paths.js';
import { briefWithRoutines, loadRoutines } from '../../../src/forge/self/routines.js';

const MOBILE_BRIEF = `# Goal: BBZ-169 close the player card drop-down on an outside tap

The drop-down stays open when the player taps outside it. Add the dismissal and a test.
`;

/** The routine is prose and wraps at the margin, so a phrase can carry a newline in
 *  the middle of it. A specimen that pinned the line breaks would fail on a reflow
 *  that changed nothing a worker reads. */
const flat = (text: string): string => text.replace(/\s+/g, ' ').toLowerCase();

describe('the brief a worker is handed carries the commit-first rule', () => {
  const routines = loadRoutines(routinesDir());
  const brief = briefWithRoutines(MOBILE_BRIEF, routines);

  it('tells the worker to commit and push before running the full check suite', () => {
    const body = flat(brief);
    const commitAt = body.indexOf('commit and push as soon as it is green');
    const verifyAt = body.indexOf("run the project's own `verify`");
    expect(commitAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(-1);
    expect(commitAt).toBeLessThan(verifyAt);
  });

  it('names the foreground limit that kills the run, not only "run fewer checks"', () => {
    expect(flat(brief)).toContain('120-second foreground limit');
  });

  it('forbids ending a turn waiting on a backgrounded check', () => {
    expect(flat(brief)).toMatch(/never launch a check in the background and end your turn/);
  });

  it('says what to do when the suite cannot finish in one foreground call', () => {
    expect(flat(brief)).toMatch(/cannot finish inside one foreground call/);
  });

  // Edge: a brief with no words in common with any routine still gets it, because
  // `general` is always in the keyword list. This is the property the whole delivery
  // rests on, and it was load-bearing without ever being asserted.
  it('reaches a brief whose own words match nothing', () => {
    const bare = briefWithRoutines('# Goal: zzz\n\nzzz.\n', routines);
    expect(flat(bare)).toContain('120-second foreground limit');
  });

  // Edge: the backend path passes a repoKind. The rule is not repo-specific and must
  // survive it.
  it('reaches a backend brief too', () => {
    const backend = briefWithRoutines(MOBILE_BRIEF, routines, 'backend');
    expect(flat(backend)).toContain('120-second foreground limit');
  });

  // Edge: no routines on disk at all. The brief comes back unchanged rather than
  // throwing, which is the existing contract -- but it means an empty routines
  // directory silently drops the rule, so the count is asserted above by the specimens
  // that do load it.
  it('returns the brief unchanged when there are no routines to attach', () => {
    expect(briefWithRoutines(MOBILE_BRIEF, [])).toBe(MOBILE_BRIEF);
  });
});
