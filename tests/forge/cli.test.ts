/**
 * The commands a person types.
 *
 * `stop --all` carries the weight. It is the control reached for when something is going
 * wrong, so the rows below pin the things that make it usable at that moment: it takes no
 * argument it could get wrong, it is safe to run twice, it says plainly when there was
 * nothing to stop, and it parks rather than kills so the work survives.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { forge } from '../../src/forge/cli.js';
import { Inbox } from '../../src/forge/inbox.js';
import { replay } from '../../src/forge/journal.js';
import { Lanes } from '../../src/forge/supervisor.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-cli-'));
  process.env['FORGE_HOME'] = home;
});

const lanes = () => new Lanes(join(home, 'lanes'));
const journal = () => join(home, 'fleet.jsonl');

describe('forge stop --all', () => {
  it('parks every run and says so', async () => {
    lanes().put('alpha', { column: 'c', session_id: 's1', started: Date.now() });
    lanes().put('beta', { column: 'd', session_id: 's2', started: Date.now() });

    const result = await forge(['stop', '--all']);

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/parked 2 run\(s\)/);
    expect(result.lines.join(' ')).toMatch(/all spend has stopped/);
    expect(lanes().get('alpha')?.verdict).toBe('parked');
  });

  it('is safe to run twice', async () => {
    lanes().put('alpha', { column: 'c', session_id: 's1' });
    await forge(['stop', '--all']);
    const again = await forge(['stop', '--all']);
    expect(again.code).toBe(0);
    expect(again.lines).toEqual(['nothing was running']);
  });

  it('says plainly when there was nothing to stop', async () => {
    const result = await forge(['stop', '--all']);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual(['nothing was running']);
  });

  it('refuses a bare stop, so nothing is half-stopped by a typo', async () => {
    lanes().put('alpha', { column: 'c', session_id: 's1' });
    const result = await forge(['stop']);
    expect(result.code).toBe(2);
    expect(lanes().get('alpha')?.verdict).toBeNull();
  });

  it('journals a handoff request for every run it parked', async () => {
    lanes().put('alpha', { column: 'c', session_id: 's1' });
    await forge(['stop', '--all']);
    const parked = replay(journal()).events.filter((e) => e.event === 'run.parked');
    expect(parked).toHaveLength(1);
    expect(parked[0]?.['handoffRequested']).toBe(true);
  });

  it('carries the reason into the record', async () => {
    lanes().put('alpha', { column: 'c', session_id: 's1' });
    await forge(['stop', '--all', 'the', 'window', 'is', 'nearly', 'spent']);
    expect(String(lanes().get('alpha')?.note)).toMatch(/window is nearly spent/);
  });
});

describe('forge status', () => {
  it('shows model, context and cost per lane', async () => {
    lanes().put('alpha', {
      column: 'c', model: 'claude-sonnet-5', context: 42_000, cost_usd: 1.25,
    });
    const result = await forge(['status']);
    const text = result.lines.join('\n');
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('42000');
    expect(text).toContain('$1.25');
  });

  it('says a lane needs Aaron rather than showing it as running', async () => {
    lanes().put('flappy', { column: 'c', needs_aaron: 'three bad starts' });
    expect((await forge(['status'])).lines.join('\n')).toContain('NEEDS AARON');
  });

  it('says so when nothing is running', async () => {
    expect((await forge(['status'])).lines).toEqual(['nothing is running']);
  });
});

describe('forge answer', () => {
  it('answers an open question', async () => {
    const entry = new Inbox(join(home, 'inbox'))
      .raise({ run: 'alpha', question: 'Which environment?' });

    const result = await forge(['answer', entry.key, 'staging']);

    expect(result.code).toBe(0);
    expect(new Inbox(join(home, 'inbox')).entry(entry.key)?.answer).toBe('staging');
  });

  it('refuses a key nobody asked', async () => {
    expect((await forge(['answer', 'nope', 'yes'])).code).toBe(1);
  });

  it('needs both a key and an answer', async () => {
    expect((await forge(['answer'])).code).toBe(2);
  });
});

describe('forge run', () => {
  it('refuses a brief that opens a websocket Monitor', async () => {
    const brief = join(home, 'bad.md');
    writeFileSync(brief, 'Open Monitor({ws:{url:"ws://127.0.0.1:4100"}}) first.\n', 'utf8');

    const result = await forge(['run', brief]);

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/monitor/i);
  });

  it('refuses a condition over the limit', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const result = await forge(['run', brief, 'x'.repeat(4001)]);
    expect(result.code).toBe(1);
  });

  it('pins the runtime version when it does start', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    const result = await forge(['run', brief]);

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/pinned to forge /);
    expect(result.lines.join(' ')).toMatch(/CLAUDE_CONFIG_DIR=/);
  });

  it('says which brief it could not read rather than failing silently', async () => {
    const result = await forge(['run', join(home, 'missing.md')]);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatch(/cannot read/);
  });
});

describe('an unknown command', () => {
  it('lists what there is', async () => {
    const result = await forge(['wat']);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatch(/stop --all/);
    expect(result.lines.join(' ')).toContain('4120');
  });
});
