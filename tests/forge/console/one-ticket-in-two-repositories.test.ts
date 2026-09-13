import { describe, expect, it } from 'vitest';

import { linkSiblings, holdState, type SiblingItem } from '../../../src/forge/console/siblings.js';

/**
 * One ticket, two repositories.
 *
 * A ticket whose fix needs both halves becomes two queue items, and until now they were
 * two unrelated rows that happened to share a key: `repo` and `ticket` are each a single
 * string on an item, so nothing joined them. The board showed two tickets. Worse, nothing
 * stopped the frontend half merging before the backend half it calls into existed
 * (Aaron, 2026-09-13: the backend request opens and the frontend is held until it merges).
 *
 * These rules are deliberately repository-agnostic. Which half waits for which is the
 * caller's decision, carried as `waitingFor`, because this repository must not know the
 * names of anybody's projects.
 */
function item(over: Partial<SiblingItem> & Pick<SiblingItem, 'id'>): SiblingItem {
  return { ticket: 'ABC-1', repo: 'owner/front', state: 'queued', waitingFor: null, ...over };
}

describe('linking the two halves of one ticket', () => {
  it('links two open items on the same ticket in different repositories', () => {
    const linked = linkSiblings([
      item({ id: 'a', repo: 'owner/front' }),
      item({ id: 'b', repo: 'owner/back' }),
    ]);

    expect(linked['a']?.sibling).toBe('b');
    expect(linked['b']?.sibling).toBe('a');
  });

  it('leaves an item with no counterpart alone', () => {
    const linked = linkSiblings([item({ id: 'a' })]);
    expect(linked['a']?.sibling).toBeNull();
  });

  // Two items in the SAME repository on one ticket are a split of that repository's own
  // work, not two halves of a cross-repository ticket. Linking them would say the board
  // is waiting on something it is not.
  it('does not link two items in the same repository', () => {
    const linked = linkSiblings([
      item({ id: 'a', repo: 'owner/front' }),
      item({ id: 'b', repo: 'owner/front' }),
    ]);

    expect(linked['a']?.sibling).toBeNull();
    expect(linked['b']?.sibling).toBeNull();
  });

  // Three items on one ticket cannot be paired without guessing which two belong
  // together, and a wrong guess holds the wrong half. Reported, never guessed.
  it('refuses to pair three items on one ticket, and says so', () => {
    const linked = linkSiblings([
      item({ id: 'a', repo: 'owner/front' }),
      item({ id: 'b', repo: 'owner/back' }),
      item({ id: 'c', repo: 'owner/infra' }),
    ]);

    for (const id of ['a', 'b', 'c']) {
      expect(linked[id]?.sibling, id).toBeNull();
      expect(linked[id]?.ambiguous, id).toMatch(/three|3/i);
    }
  });

  it('ignores an item with no ticket rather than pairing the ticketless ones together', () => {
    const linked = linkSiblings([
      item({ id: 'a', ticket: null, repo: 'owner/front' }),
      item({ id: 'b', ticket: null, repo: 'owner/back' }),
    ]);

    expect(linked['a']?.sibling).toBeNull();
    expect(linked['b']?.sibling).toBeNull();
  });

  // A finished half is still the same ticket and still worth showing joined -- the link
  // is what makes the board read as one ticket in two places. What a finished half stops
  // doing is holding the other one, which is `holdState`'s business, not this one's.
  it('still links a half that has finished', () => {
    const linked = linkSiblings([
      item({ id: 'a', repo: 'owner/front' }),
      item({ id: 'b', repo: 'owner/back', state: 'done' }),
    ]);

    expect(linked['a']?.sibling).toBe('b');
  });
});

describe('holding the half that has to wait', () => {
  const front = item({ id: 'a', repo: 'owner/front', waitingFor: 'b' });

  it('holds an item whose sibling has not finished, naming what it waits for', () => {
    const state = holdState(front, [front, item({ id: 'b', repo: 'owner/back', state: 'running' })]);

    expect(state.held).toBe(true);
    expect(state.why).toMatch(/owner\/back/);
  });

  it('releases it the moment the sibling is done', () => {
    const state = holdState(front, [front, item({ id: 'b', repo: 'owner/back', state: 'done' })]);

    expect(state.held).toBe(false);
    expect(state.why).toBe('');
  });

  // A sibling that is not there any more must not hold anything for ever. Silently
  // releasing would be worse -- the reason it was held has not been met, it has gone
  // missing -- so it releases and says which.
  it('releases, and says so, when the sibling it waits for is gone', () => {
    const state = holdState(front, [front]);

    expect(state.held).toBe(false);
    expect(state.why).toMatch(/no longer|gone|not here/i);
  });

  it('holds nothing that is not waiting for anything', () => {
    const alone = item({ id: 'a' });
    expect(holdState(alone, [alone]).held).toBe(false);
  });

  // A failed sibling is not a finished one. Releasing on `failed` would let the half that
  // depends on it merge into a gap.
  it('keeps holding when the sibling failed rather than finished', () => {
    const state = holdState(front, [front, item({ id: 'b', repo: 'owner/back', state: 'failed' })]);

    expect(state.held).toBe(true);
    expect(state.why).toMatch(/failed/i);
  });

  it('keeps holding when the sibling is parked on a question', () => {
    const state = holdState(front, [front, item({ id: 'b', repo: 'owner/back', state: 'parked' })]);

    expect(state.held).toBe(true);
  });
});
