/**
 * The two live escapes of 2026-09-10, as specimens. Both were read off a running console
 * before this file existed: `GET /sessions` listed 5 live rows while `claude agents --json`
 * listed 6 live pids, and 167 of its 169 rows carried no name.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { journalRegistryRows, planRegistryRows, type KnownSession } from '../../../src/forge/sessions/reconcile.js';
import { sessionStartedRow } from '../../../src/forge/sessions/started-row.js';
import type { SessionRow } from '../../../src/forge/sessions/registry.js';

const CONFIG_DIR = join('home', '.claude');
const WORKSPACE = join('workspace');
const REPO = join('workspace', 'repo');

function scanned(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: 'sess-1',
    pid: 4242,
    configDir: CONFIG_DIR,
    accountLabel: 'default',
    cwd: WORKSPACE,
    repo: REPO,
    worktree: REPO,
    branch: 'main',
    kind: 'interactive',
    name: 'dev-e2',
    status: 'idle',
    startedAt: 1,
    statusUpdatedAt: 1,
    ...overrides,
  };
}

describe('planRegistryRows', () => {
  it('journals a started row for a session the fold has never heard of', () => {
    const rows = planRegistryRows([scanned()], {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event: 'session.started', session: 'sess-1', pid: 4242, name: 'dev-e2' });
  });

  it('journals a vanished row once for a live session whose pid is gone, and not again', () => {
    const dead = scanned({ vanished: true });
    expect(planRegistryRows([dead], { 'sess-1': { status: 'live' } }))
      .toMatchObject([{ event: 'session.vanished', session: 'sess-1' }]);
    expect(planRegistryRows([dead], { 'sess-1': { status: 'ended' } })).toEqual([]);
  });

  it('brings a session back when the fold says ended but the process is alive', () => {
    // The 2026-09-10 escape: 24 `session.vanished` rows were written for dev-75 by the
    // pre-#140 probe. Its pid stayed alive the whole time, and no later tick ever said so.
    const known: Record<string, KnownSession> = { 'sess-1': { status: 'ended', name: 'dev-e2', pid: 4242 } };
    const rows = planRegistryRows([scanned()], known);
    expect(rows).toMatchObject([{ event: 'session.started', session: 'sess-1', pid: 4242, name: 'dev-e2' }]);
  });

  it('fills in identity the hook never carried, for a session already folded live', () => {
    // A hook reports first and names no session, so the fold holds a nameless live row.
    // Today that row is invisible on the board and uncomparable to `claude agents --json`.
    const known: Record<string, KnownSession> = { 'sess-1': { status: 'live' } };
    const rows = planRegistryRows([scanned()], known);
    expect(rows).toMatchObject([{ event: 'session.started', session: 'sess-1', name: 'dev-e2', pid: 4242 }]);
  });

  it('says nothing about a live session the fold already has right', () => {
    const known: Record<string, KnownSession> = {
      'sess-1': { status: 'live', name: 'dev-e2', pid: 4242, cwd: WORKSPACE },
    };
    expect(planRegistryRows([scanned()], known)).toEqual([]);
  });

  it('corrects a pid the fold learned from a hook process rather than the session file', () => {
    // `hooks/forge_report.py` reports the hook process's own pid; the session file holds
    // the terminal's. dev-e2 was folded as pid 70640 while its terminal ran as 11156.
    const known: Record<string, KnownSession> = { 'sess-1': { status: 'live', name: 'dev-e2', pid: 70640 } };
    const rows = planRegistryRows([scanned()], known);
    expect(rows).toMatchObject([{ event: 'session.started', session: 'sess-1', pid: 4242 }]);
  });

  it('skips a malformed record that names no session', () => {
    expect(planRegistryRows([scanned({ sessionId: '' })], {})).toEqual([]);
  });
});

describe('journalRegistryRows', () => {
  function deps() {
    const appended: Record<string, unknown>[] = [];
    const swept: string[] = [];
    return {
      appended,
      swept,
      append: (row: Record<string, unknown>) => {
        appended.push(row);
        return row as never;
      },
      lastStopFor: () => undefined,
      sweep: (sessionId: string) => {
        swept.push(sessionId);
        return { releasedLocks: ['rn-dev-loop'] };
      },
      worktreeStatusFor: () => undefined,
    };
  }

  it('releases the claims and locks of a session the scan found gone', () => {
    // The escape: the tick appended its vanished row raw, so nothing ever swept a
    // hard-killed session. 695 vanished rows on the live ledger, 2 cleanup rows.
    const d = deps();
    journalRegistryRows([{ event: 'session.vanished', actor: 'registry', session: 'sess-1', cwd: WORKSPACE }], d);
    expect(d.swept).toEqual(['sess-1']);
    expect(d.appended.map((row) => row['event']))
      .toEqual(['session.vanished', 'session.cleanup']);
    expect(d.appended[1]).toMatchObject({ exitClass: 'killed', releasedLocks: ['rn-dev-loop'] });
  });

  it('journals a started row without sweeping anything', () => {
    const d = deps();
    journalRegistryRows([sessionStartedRow(scanned())], d);
    expect(d.swept).toEqual([]);
    expect(d.appended.map((row) => row['event'])).toEqual(['session.started']);
  });
});
