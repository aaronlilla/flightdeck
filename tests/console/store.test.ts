import { describe, expect, it } from 'vitest';

import { initialState, reducer } from '../../src/console/store.js';
import type { Lane } from '../../src/shared/console-model.js';

function lanes(n: number): Lane[] {
  return Array.from({ length: n }, () => ({}) as Lane);
}

describe('store reducer', () => {
  it('flips the feed live once lanes load, then drops it on feed-lost', () => {
    let state = initialState();
    state = reducer(state, { type: 'lanes', lanes: [] });
    expect(state.loaded).toBe(true);
    state = reducer(state, { type: 'feed-lost', reason: 'unreachable' });
    expect(state.feed.live).toBe(false);
    expect(state.feed.reason).toBe('unreachable');
    // a second feed-lost while already down does not reset lostAt
    const lostAt = state.feed.lostAt;
    state = reducer(state, { type: 'feed-lost', reason: 'still unreachable' });
    expect(state.feed.lostAt).toBe(lostAt);
    state = reducer(state, { type: 'feed-live' });
    expect(state.feed.live).toBe(true);
    expect(state.feed.lostAt).toBeNull();
  });

  it('appends to the thread without dropping earlier messages', () => {
    let state = initialState();
    state = reducer(state, { type: 'thread', thread: [{ k: 'a', type: 'event', text: 'x', ts: 1, source: 'system' }] });
    state = reducer(state, { type: 'thread-append', messages: [{ k: 'b', type: 'event', text: 'y', ts: 2, source: 'system' }] });
    expect(state.thread.map((m) => m.k)).toEqual(['a', 'b']);
  });

  it('opens and closes a sheet', () => {
    let state = initialState();
    state = reducer(state, { type: 'sheet', sheet: { type: 'ticket', id: 'FLT-1' } });
    expect(state.sheet).toEqual({ type: 'ticket', id: 'FLT-1' });
    state = reducer(state, { type: 'sheet', sheet: null });
    expect(state.sheet).toBeNull();
  });

  it('toggles the theme', () => {
    let state = initialState();
    state = reducer(state, { type: 'theme', theme: 'thL' });
    expect(state.theme).toBe('thL');
  });

  // POLISH-2 #4: "today" is the default filter once a fleet grows past 12 lanes.
  describe('default filter on first load', () => {
    it('defaults to today when more than 12 lanes load', () => {
      let state = initialState();
      state = reducer(state, { type: 'lanes', lanes: lanes(13) });
      expect(state.filter).toBe('today');
    });

    it('stays on all at 12 lanes or fewer', () => {
      let state = initialState();
      state = reducer(state, { type: 'lanes', lanes: lanes(12) });
      expect(state.filter).toBe('all');
    });

    it('never overrides a filter the operator already chose', () => {
      let state = initialState();
      state = reducer(state, { type: 'filter', filter: 'running' });
      state = reducer(state, { type: 'lanes', lanes: lanes(13) });
      expect(state.filter).toBe('running');
    });

    it('does not reset the filter on a later poll once already loaded', () => {
      let state = initialState();
      state = reducer(state, { type: 'lanes', lanes: lanes(13) });
      state = reducer(state, { type: 'filter', filter: 'all' });
      state = reducer(state, { type: 'lanes', lanes: lanes(13) });
      expect(state.filter).toBe('all');
    });
  });
});
