// @vitest-environment jsdom
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

  // Sweep #10: "retry in Ns" never ticked down -- feed-lost set retryInS once and
  // nothing else ever touched it.
  it('counts retryInS down on each tick while the feed is down, wrapping back to 5', () => {
    let state = initialState();
    state = reducer(state, { type: 'feed-lost', reason: 'unreachable' });
    expect(state.feed.retryInS).toBe(5);
    state = reducer(state, { type: 'tick', now: 1 });
    expect(state.feed.retryInS).toBe(4);
    state = reducer(state, { type: 'tick', now: 2 });
    state = reducer(state, { type: 'tick', now: 3 });
    state = reducer(state, { type: 'tick', now: 4 });
    expect(state.feed.retryInS).toBe(1);
    state = reducer(state, { type: 'tick', now: 5 });
    expect(state.feed.retryInS).toBe(5);
  });

  it('never touches retryInS while the feed is live', () => {
    let state = initialState();
    state = reducer(state, { type: 'tick', now: 1 });
    expect(state.feed.retryInS).toBeNull();
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
    state = reducer(state, { type: 'theme', theme: 'dark' });
    expect(state.theme).toBe('dark');
  });

  it('starts plain and toggles verbose, remembering it in localStorage', () => {
    let state = initialState();
    expect(state.verbose).toBe(false);
    state = reducer(state, { type: 'verbose', verbose: true });
    expect(state.verbose).toBe(true);
    expect(localStorage.getItem('flightdeck.verbose')).toBe('1');
    state = reducer(state, { type: 'verbose', verbose: false });
    expect(state.verbose).toBe(false);
    expect(localStorage.getItem('flightdeck.verbose')).toBe('0');
  });

  it('reads a remembered verbose flag back on init', () => {
    localStorage.setItem('flightdeck.verbose', '1');
    expect(initialState().verbose).toBe(true);
    localStorage.removeItem('flightdeck.verbose');
  });

  describe('default filter on first load', () => {
    it('stays on all however many lanes load', () => {
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

describe('queue_paused off /state, independent of the /queue slice', () => {
  it('sets queuePausedOnState off the state slice without touching the /queue slice\'s own queuePaused', () => {
    let state = initialState();
    state = reducer(state, { type: 'queue', items: [], paused: false, maxInFlight: 2 });
    state = reducer(state, { type: 'queue-paused-on-state', paused: true });
    expect(state.queuePausedOnState).toBe(true);
    expect(state.queuePaused).toBe(false);
  });

  it('leaves queuePausedOnState alone when a later /queue slice update lands', () => {
    let state = initialState();
    state = reducer(state, { type: 'queue-paused-on-state', paused: true });
    state = reducer(state, { type: 'queue', items: [], paused: false, maxInFlight: 2 });
    expect(state.queuePausedOnState).toBe(true);
  });
});
