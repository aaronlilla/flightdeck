/**
 * F.6 in the wild: the repeated-work finding fired on the shape
 * `tools:Bash>Bash>Bash>Bash>ToolSearch>AskUserQuestion>ToolSearch>mcp__forge__forge_done`,
 * seen across two live-probe tickets (`forge-live-probe-12`, `forge-live-probe-17`). Its
 * own instruction is "author a routine for it"; this test is the proof of that authoring.
 * A routine has to live in the tracked `routines/` directory, matched by a brief carrying
 * this shape's own words, and its body has to actually stop the repeat: resolve every
 * deferred tool before starting the finishing sequence, and never spend a turn asking
 * whether to commit, push, or open the PR when the brief already says to.
 */
import { describe, expect, it } from 'vitest';

import { routinesDir } from '../../../src/forge/paths.js';
import { loadRoutines, matchRoutines } from '../../../src/forge/self/routines.js';

describe('routine: forge live-probe finishing sequence', () => {
  const routines = loadRoutines(routinesDir());

  // The same keyword extraction `queue-wire.ts` runs over a brief's own text before
  // matching routines against it: lowercase words, `general` always included.
  const briefWords = [
    'general',
    ...`
      run forge-live-probe-12 verify the working tree deferred tools available
      forge_done evidence ticket branch push draft pr
    `.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g)!,
  ];

  it('matches a routine against a live-probe brief\'s own words', () => {
    const matched = matchRoutines({ keywords: briefWords }, routines);
    expect(matched.map((r) => r.slug)).toContain('forge-live-probe-finish');
  });

  it('tells the worker to resolve deferred tools before the finishing sequence, not one at a time inside it', () => {
    const routine = routines.find((r) => r.slug === 'forge-live-probe-finish');
    expect(routine).toBeDefined();
    expect(routine!.body.toLowerCase()).toContain('toolsearch');
  });

  it('tells the worker never to ask whether to commit, push or open the pr', () => {
    const routine = routines.find((r) => r.slug === 'forge-live-probe-finish');
    expect(routine).toBeDefined();
    expect(routine!.body.toLowerCase()).toMatch(/never ask whether/);
  });
});
