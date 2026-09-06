import { describe, it, expect } from 'vitest';
import { decideQuitAction } from '../quit-rule';

describe('decideQuitAction', () => {
  it('stops the server when this app started it and nothing is live', () => {
    expect(decideQuitAction(true, false)).toEqual({ kind: 'stop-server-and-quit' });
  });

  it('leaves a started server running when a run is live', () => {
    expect(decideQuitAction(true, true)).toEqual({ kind: 'leave-server-and-quit', reason: 'run-live' });
  });

  it('never stops a server this app only attached to, live run or not', () => {
    expect(decideQuitAction(false, false)).toEqual({ kind: 'leave-server-and-quit', reason: 'attached' });
    expect(decideQuitAction(false, true)).toEqual({ kind: 'leave-server-and-quit', reason: 'attached' });
  });
});
