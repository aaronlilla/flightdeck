import { describe, expect, it } from 'vitest';

import { routinesDir } from '../../../src/forge/paths.js';
import { loadRoutines, matchRoutines } from '../../../src/forge/self/routines.js';

/**
 * F.6 self-finding "repeated-work": forge-live-probe-8, -15, and -19 all ran the same
 * tool shape, several `Bash` calls, then an `AskUserQuestion`, then two `ToolSearch`
 * calls, then the run's own `forge_done`. That `AskUserQuestion` was never a real
 * question: the brief already says how the run ends (commit, push, open the draft PR,
 * call `forge_done`), so there is nothing left to ask about. The two `ToolSearch` calls
 * right after it show the run only found out it needed a deferred `forge_*` tool's
 * schema after it had already started, instead of looking that up at the top.
 *
 * The fix is a `routines/*.md` file a worker reads before it repeats that shape. Tagged
 * `general` so `queue-wire.ts#writeBrief` attaches it to every brief, same as
 * `verify-before-commit.md`.
 */
describe('routine catalog: forge run tool lookup', () => {
  it('tells a worker to resolve forge_* tool schemas up front and never pause on a question its own brief already answered', () => {
    const routines = loadRoutines(routinesDir());
    const matched = matchRoutines({ keywords: ['general'] }, routines);
    const hit = matched.find(
      (routine) =>
        routine.body.toLowerCase().includes('forge_done') &&
        routine.body.toLowerCase().includes('toolsearch'),
    );
    expect(hit).toBeDefined();
    expect(hit!.body.toLowerCase()).toContain('askuserquestion');
  });
});
