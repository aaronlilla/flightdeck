import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { humanizeParkReason, TILE_SENTENCE_LIMIT } from '../../src/shared/humanize.js';

/**
 * No screen prints a park reason in the words the machine wrote it in.
 *
 * Aaron, 2026-09-13: "the console constantly has stale or wrong or useless information."
 * A park reason is written once by whatever stopped a run and replayed for as long as the
 * row is on screen, so one bad line sits there for days. This was on the board, under
 * BLOCKED OR PARKED, hours after the tile above it had been cleaned up:
 *
 *   drift confirmed off-brief: The transcript tail is empty/contains no actual tool calls
 *   or edits shown, giving no evidence the agent did any work on the BBZ-289 queue row
 *   title fix or the specified branch/verification steps.
 *
 * The cleaning function existed and four server-side callers used it. The three components
 * that render a reason on screen did not, so the fix landed everywhere except the place a
 * person actually reads. Listing those three would leave the fourth, so the rule is
 * computed: a component that renders a reason has to clean it.
 */

function componentSources(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src/console'], { encoding: 'utf8' });
  return out.split(String.fromCharCode(10)).map((l) => l.trim()).filter((l) => l.endsWith('.tsx'));
}

/** `lane.reason` / `item.reason` / `row.reason` inside rendered output. A `title=` or
 *  `?? undefined` use is a tooltip or a guard, never the line a person reads. */
const RENDERS_REASON = /\{[^}]*\b\w+\.reason\b[^}]*\}/g;

describe('a park reason on its way to a screen', () => {
  const files = componentSources();

  it('finds the console\'s components at all', () => {
    expect(files.length, 'no components found -- the sweep is broken, not the code').toBeGreaterThan(5);
  });

  it.each(files.map((f) => [f] as const))('cleans every reason it renders (%s)', (file) => {
    const text = readFileSync(file, 'utf8');
    const uses = [...text.matchAll(RENDERS_REASON)]
      // The feed's own disconnect reason is this console's sentence, not a park reason
      // written by a run, and it is already short and plain.
      .filter((m) => !m[0].includes('feed.reason'))
      // A tooltip carries the full untouched text on purpose, so the whole reason stays
      // reachable when the visible line has been cut to one sentence.
      .filter((m) => !m[0].includes('?? undefined'));
    if (uses.length === 0) return;
    expect(
      text.includes('humanizeParkReason'),
      `${file} renders ${uses.length} reason(s) raw: ${uses[0]![0].slice(0, 90)}`,
    ).toBe(true);
  });
});

describe('what the cleaning actually does to the line that was on the board', () => {
  const REAL = 'drift confirmed off-brief: The transcript tail is empty/contains no actual '
    + 'tool calls or edits shown, giving no evidence the agent did any work on the BBZ-289 '
    + 'queue row title fix or the specified branch/verification steps..';

  it('fits a card and says it in words a person uses', () => {
    const said = humanizeParkReason(REAL);
    expect(said.length).toBeLessThanOrEqual(TILE_SENTENCE_LIMIT + 1);
    for (const word of ['drift', 'off-brief', 'transcript', 'the agent']) {
      expect(said.toLowerCase(), `"${said}" still says ${word}`).not.toContain(word);
    }
  });
});
