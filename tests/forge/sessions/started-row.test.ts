import { describe, expect, it } from 'vitest';

import { sessionStartedRow } from '../../../src/forge/sessions/started-row.js';
import type { SessionRow } from '../../../src/forge/sessions/registry.js';

function scanRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 's1',
    pid: 3131,
    configDir: '/config/.claude',
    accountLabel: 'default',
    cwd: '/repos/flightdeck',
    repo: '/repos/flightdeck',
    worktree: '/repos/flightdeck',
    branch: 'main',
    kind: 'interactive',
    name: 's1',
    status: 'live',
    startedAt: undefined,
    statusUpdatedAt: undefined,
    ...overrides,
  };
}

describe('sessionStartedRow', () => {
  it('carries the scan row\'s pid into the session.started row', () => {
    const row = sessionStartedRow(scanRow({ pid: 3131 }));
    expect(row.pid).toBe(3131);
    expect(row.event).toBe('session.started');
    expect(row.session).toBe('s1');
  });
});
