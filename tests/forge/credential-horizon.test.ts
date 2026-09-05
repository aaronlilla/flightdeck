/**
 * Single-flight credential recovery: one flow per account, everyone else parks behind it,
 * never a secret in the message.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlockerBoard } from '../../src/forge/blockers.js';
import { replayEvents } from '../../src/forge/contracts.js';
import { CredentialHorizon, readLoginLock } from '../../src/forge/credential-horizon.js';
import { Journal } from '../../src/forge/journal.js';

let home: string;
let journalPath: string;
let journal: Journal;
let parked: string[];
let resumed: string[];
let messages: string[];
let board: BlockerBoard;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-credential-'));
  process.env['FORGE_HOME'] = home;
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
  parked = [];
  resumed = [];
  messages = [];
  board = new BlockerBoard({
    journal,
    actuator: {
      park: async (run, reason) => { parked.push(`${run}:${reason}`); },
      resume: async (run, input) => { resumed.push(`${run}:${input}`); },
    },
  });
});

afterEach(() => {
  journal.close();
  delete process.env['FORGE_HOME'];
  rmSync(home, { recursive: true, force: true });
});

function horizon(startFlow = async () => ({ page: 'https://example.test/authorize' })) {
  return new CredentialHorizon({
    journal, blockers: board, notifyAaron: (m) => messages.push(m), startFlow,
  });
}

describe('no lapse', () => {
  it('takes no action and asks nothing: nothing is invoked unless a lapse is reported', () => {
    horizon();
    expect(messages).toEqual([]);
    expect(parked).toEqual([]);
  });
});

describe('a single lapse', () => {
  it('starts exactly one login flow and sends Aaron exactly one message naming the page', async () => {
    let starts = 0;
    const outcome = await horizon(async () => { starts += 1; return { page: 'https://example.test/authorize' }; })
      .onLapse('aws-example', 'r1', { pid: 424242, startedAt: 1 });

    expect(outcome).toBe('started');
    expect(starts).toBe(1);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/https:\/\/example\.test\/authorize/);
  });

  it('never leaks a secret shape into the Aaron-facing message', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc19pc19hX3NpZ25hdHVyZQ';
    const secretPage = `https://example.test/authorize?token=${jwt}`;
    await horizon(async () => ({ page: secretPage })).onLapse('aws-example', 'r1', { pid: 1, startedAt: 1 });
    expect(messages[0]).not.toContain(jwt);
    expect(messages[0]).toContain('[redacted]');
  });
});

describe('a second run lapsing on the same account mid-flight', () => {
  it('parks behind the first rather than starting its own flow', async () => {
    let starts = 0;
    const h = horizon(async () => { starts += 1; return { page: 'https://example.test/authorize' }; });

    const first = await h.onLapse('aws-example', 'r1', { pid: 424242, startedAt: 1 });
    const second = await h.onLapse(
      'aws-example', 'r2', { pid: 555555, startedAt: 2 },
    );

    expect(first).toBe('started');
    expect(second).toBe('parked');
    expect(starts).toBe(1);
    expect(parked).toEqual(['r2:blocked on credential:aws-example: login lapse on aws-example']);

    const { events } = replayEvents(readFileSync(journalPath, 'utf8'));
    expect(events.filter((e) => e.event === 'blocker.raised')).toHaveLength(1);
  });

  it('a stale lock (holder pid gone) is taken by the next lapse instead of parking behind it', async () => {
    let starts = 0;
    const h = new CredentialHorizon({
      journal, blockers: board, notifyAaron: (m) => messages.push(m),
      startFlow: async () => { starts += 1; return { page: 'https://example.test/authorize' }; },
      isAlive: () => false,
    });

    const first = await h.onLapse('aws-example', 'r1', { pid: 1, startedAt: 1 });
    const second = await h.onLapse('aws-example', 'r2', { pid: 2, startedAt: 2 });

    expect(first).toBe('started');
    expect(second).toBe('started');
    expect(starts).toBe(2);
  });
});

describe('tick', () => {
  it('does nothing while the provider probe is still invalid', async () => {
    const h = horizon();
    await h.onLapse('aws-example', 'r1', { pid: 1, startedAt: 1 });
    const resolved = await h.tick('aws-example', () => false);
    expect(resolved).toBe(false);
    expect(readLoginLock('aws-example')).toBeTruthy();
  });

  it('releases the lock and resumes every parked run in order once the probe is valid', async () => {
    const h = horizon();
    await h.onLapse('aws-example', 'r1', { pid: 424242, startedAt: 1 });
    await h.onLapse('aws-example', 'r2', { pid: 999, startedAt: 2 });
    await h.onLapse('aws-example', 'r3', { pid: 998, startedAt: 3 });

    const resolved = await h.tick('aws-example', () => true);

    expect(resolved).toBe(true);
    expect(readLoginLock('aws-example')).toBeUndefined();
    expect(resumed.map((line) => line.split(':')[0])).toEqual(['r2', 'r3']);
  });
});

describe('remind', () => {
  it('sends at most two reminders, then stays silent', () => {
    const h = horizon();
    expect(h.remind('aws-example', 'https://example.test/authorize')).toBe(true);
    expect(h.remind('aws-example', 'https://example.test/authorize')).toBe(true);
    expect(h.remind('aws-example', 'https://example.test/authorize')).toBe(false);
    expect(messages).toHaveLength(2);
  });
});
