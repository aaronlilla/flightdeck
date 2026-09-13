import { describe, expect, it } from 'vitest';

import { readQueueInput } from '../../src/shared/queueInput.js';

/**
 * The queue's Add box takes one field and works out what was typed, because a dropdown
 * asking "is this a ticket key, a search or a brief?" is a question about the console's
 * own plumbing rather than about the work.
 *
 * The reading is shown back before anything is sent, so the cost of a wrong one is a
 * visible sentence rather than a wrong item on the board -- but a reading that is wrong
 * often enough is still a bad control, which is what this file holds the line on.
 */
describe('what the queue Add box makes of what was typed', () => {
  it('an empty box is nothing to add', () => {
    expect(readQueueInput('')).toBeNull();
    expect(readQueueInput('   \n  ')).toBeNull();
  });

  it('reads a bare ticket key, in whatever case it was typed', () => {
    expect(readQueueInput('BBZ-289')).toMatchObject({ source: 'ticket', input: 'BBZ-289' });
    expect(readQueueInput('  bbz-289 ')).toMatchObject({ source: 'ticket', input: 'BBZ-289' });
    expect(readQueueInput('SCRUM-4')).toMatchObject({ source: 'ticket', input: 'SCRUM-4' });
  });

  it('says which ticket it read, so a wrong reading is visible before it is sent', () => {
    expect(readQueueInput('bbz-289')?.says).toBe('Reads as the ticket BBZ-289.');
  });

  it('a sentence that merely contains a key is a brief, not that ticket', () => {
    // Sending this as a ticket key would quietly drop every word around it.
    expect(readQueueInput('BBZ-289 is wrong, the tip never reaches the ledger'))
      .toMatchObject({ source: 'brief' });
  });

  it('reads a Jira search', () => {
    expect(readQueueInput('project = BBZ AND status = "To Do"')).toMatchObject({ source: 'query' });
    expect(readQueueInput('assignee = currentUser() ORDER BY priority')).toMatchObject({ source: 'query' });
    expect(readQueueInput('labels in (mobile, urgent)')).toMatchObject({ source: 'query' });
  });

  it('does not mistake ordinary English for a search', () => {
    // "and", "in" and "was" all appear in prose; a search needs a field beside them.
    expect(readQueueInput('the tip is recorded and the balance is wrong'))
      .toMatchObject({ source: 'brief' });
    expect(readQueueInput('this was broken in the last release'))
      .toMatchObject({ source: 'brief' });
    expect(readQueueInput('the status bar is wrong'))
      .toMatchObject({ source: 'brief' });
  });

  it('reads anything else, including several lines, as a brief in the operator\'s words', () => {
    const pasted = 'The wallet screen shows a stale balance.\n\nSteps: open it twice.';
    expect(readQueueInput(pasted)).toMatchObject({ source: 'brief', input: pasted });
  });

  it('never mistakes a version or a date for a ticket key', () => {
    expect(readQueueInput('1-2')).toMatchObject({ source: 'brief' });
    expect(readQueueInput('2026-09-12')).toMatchObject({ source: 'brief' });
  });
});

describe('which repository a pasted brief belongs to', () => {
  it('says the default will be used when none is named, rather than leaving it unsaid', () => {
    expect(readQueueInput('the balance is stale')?.says)
      .toMatch(/Name a repository, or it goes to the default one/);
  });

  it('carries the named repository into the brief itself', () => {
    const reading = readQueueInput('the balance is stale', 'aaronlilla/flightdeck');
    expect(reading?.source).toBe('brief');
    expect(reading?.input).toBe(['repo: aaronlilla/flightdeck', '', 'the balance is stale'].join('\n'));
    expect(reading?.says).toBe('Reads as a brief, for aaronlilla/flightdeck.');
  });

  it('refuses something that is not a repository, rather than writing it into the brief', () => {
    const reading = readQueueInput('the balance is stale', 'flightdeck');
    expect(reading?.refused).toBe(true);
    expect(reading?.says).toMatch(/is not a repository; write it as owner\/name/);
    expect(reading?.input).not.toMatch(/repo:/);
  });

  it('ignores a named repository for a ticket, which is routed by its own key', () => {
    const reading = readQueueInput('BBZ-289', 'aaronlilla/flightdeck');
    expect(reading?.source).toBe('ticket');
    expect(reading?.input).toBe('BBZ-289');
  });

  it('takes a repository with dots and dashes in either half', () => {
    expect(readQueueInput('x', 'my-org/v2.react-native')?.refused).toBeUndefined();
  });
});
