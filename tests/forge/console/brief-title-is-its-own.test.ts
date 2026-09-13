import { describe, expect, it } from 'vitest';

import { firstBodyParagraph, titleFromHeading } from '../../../src/forge/console/lanes.js';

/**
 * A lane is named by its own brief, and by nothing appended to it.
 *
 * Measured on the live console, 2026-09-12: a brief reading "A queue row whose ticket has
 * no title read yet shows the ticket key twice" went onto the board as "An emulator
 * cannot see a bottom-chrome bug". Every brief carries standing notes under `## Routines`
 * and each note has its own `# ` heading, so the title reader -- which took the first
 * `# ` line anywhere in the file -- named the lane after a note that had nothing to do
 * with it. The board said something false and nothing on the screen admitted it.
 *
 * The specimen below is the shape of a real brief: the operator's words at the top, then
 * the appended section.
 */
const APPENDED = `
## Routines



# An emulator cannot see a bottom-chrome bug

A simulator reports no system navigation inset. A real handset does.

# Another standing note

Its body.
`;

describe('what a lane calls itself', () => {
  it('takes a plain-paragraph brief from its own first line, never from an appended note', () => {
    const brief = `The wallet balance is stale after a second visit.\n${APPENDED}`;
    expect(titleFromHeading(brief, null)).toBeNull();
    expect(firstBodyParagraph(brief)).toBe('The wallet balance is stale after a second visit.');
  });

  it('takes a heading brief from its own heading', () => {
    const brief = `# Keep the Rewards tab up when rewards is unreachable\n\nBody.\n${APPENDED}`;
    expect(titleFromHeading(brief, null)).toBe('Keep the Rewards tab up when rewards is unreachable');
  });

  it('reads a heading through leading blank lines, which a written file has', () => {
    expect(titleFromHeading('\n\n#  Spaced out\n\nBody.\n', null)).toBe('Spaced out');
  });

  it('strips the ticket key a heading repeats', () => {
    expect(titleFromHeading('# BBZ-12: Fix the header\n\nBody.\n', 'BBZ-12')).toBe('Fix the header');
  });

  it('names nothing rather than naming a section, when the brief opens with one', () => {
    // A brief that is nothing but appended sections never said what it was about, and
    // saying so is better than borrowing the first sentence underneath.
    expect(titleFromHeading(APPENDED, null)).toBeNull();
    expect(firstBodyParagraph(APPENDED)).toBeNull();
  });

  it('does not read past the brief\'s own words into the section below them', () => {
    const brief = `One line about the bug.\n\n## Routines\n\nSomething else entirely.\n`;
    expect(firstBodyParagraph(brief)).toBe('One line about the bug.');
  });

  it('falls back to the first body line when the heading is only a kind slug', () => {
    const brief = '# health-repeat\n\nThe same check failed four runs running.\n';
    expect(titleFromHeading(brief, null)).toBe('The same check failed four runs running.');
  });
});
