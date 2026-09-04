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
import { RunInbox } from '../../src/forge/runinbox.js';
import { Lanes } from '../../src/forge/supervisor.js';
import type { SessionRequest } from '../../src/forge/worker.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-cli-'));
  process.env['FORGE_HOME'] = home;
  // Pinned to a directory that does not exist, so `status`'s real process-table scan
  // reads no session or credentials mtime from this machine's actual fleet login. None
  // of these specimens are about the config-dir choice itself; paths.test.ts covers that.
  process.env['FORGE_CONFIG_DIR'] = join(home, 'claude');
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

  it('pins the runtime version under --dry-run and calls no engine', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    const result = await forge(['run', brief, '--dry-run']);

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/pinned to forge /);
    expect(result.lines.join(' ')).toMatch(/CLAUDE_CONFIG_DIR=/);
  });

  it('says which config directory it chose and why', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    const result = await forge(['run', brief, '--dry-run']);

    expect(result.lines.join(' ')).toMatch(/config dir: .+ \((override|fleet|forge)\)/);
  });

  it('says which brief it could not read rather than failing silently', async () => {
    const result = await forge(['run', join(home, 'missing.md')]);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatch(/cannot read/);
  });

  it('with the fake engine injected, calls it once with the brief\'s content', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    const started: SessionRequest[] = [];
    const engine = {
      started,
      async run(config: SessionRequest) {
        started.push(config);
        return { sessionId: 'fake-session', turns: [{ text: 'done', context: 10, done: true }] };
      },
    };

    const result = await forge(['run', brief], { engine });

    expect(started).toHaveLength(1);
    expect((started[0] as { prompt: string }).prompt).toBe('# Goal\n\nDo the thing.\n');
    expect(result.code).toBe(0);
  });

  it('never calls the engine under --dry-run', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const started: SessionRequest[] = [];
    const engine = {
      started, async run(config: SessionRequest) { started.push(config); return { sessionId: 's', turns: [] }; },
    };

    await forge(['run', brief, '--dry-run'], { engine });

    expect(started).toHaveLength(0);
  });

  it('trips the breaker after three zero-turn starts and refuses a fourth', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const zeroTurnEngine = {
      started: [] as SessionRequest[],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: `s-${this.started.length}`, turns: [] };
      },
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await forge(['run', brief], { engine: zeroTurnEngine });
      expect(result.code).toBe(0);
    }
    const fourth = await forge(['run', brief], { engine: zeroTurnEngine });

    expect(fourth.code).toBe(1);
    expect(fourth.lines.join(' ')).toMatch(/refusing to start/);
    expect(zeroTurnEngine.started).toHaveLength(3);
  });

  it('clears the breaker once forge clear runs', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const zeroTurnEngine = {
      started: [] as SessionRequest[],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: `s-${this.started.length}`, turns: [] };
      },
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await forge(['run', brief], { engine: zeroTurnEngine });
    }
    await forge(['clear', 'ok']);
    const result = await forge(['run', brief], { engine: zeroTurnEngine });
    expect(result.code).toBe(0);
  });
});

describe('forge send', () => {
  it('leaves one unread message under the run\'s inbox dir', async () => {
    const result = await forge(['send', 'alpha', 'rebase before you push']);
    expect(result.code).toBe(0);

    const unread = new RunInbox('alpha').unread();
    expect(unread).toHaveLength(1);
    expect(unread[0]?.text).toBe('rebase before you push');
  });

  it('needs a run and text', async () => {
    expect((await forge(['send'])).code).toBe(2);
    expect((await forge(['send', 'alpha'])).code).toBe(2);
  });
});

describe('forge cutover', () => {
  it('retires the four spawn files given --from', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const src = join(home, 'coordination');
    mkdirSync(src, { recursive: true });
    const { CUTOVER_FILES } = await import('../../src/forge/cutover.js');
    for (const name of CUTOVER_FILES) writeFileSync(join(src, name), '# stub\n', 'utf8');

    const result = await forge(['cutover', '--from', src]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/retired 4 file\(s\)/);
  });

  it('needs a source directory', async () => {
    delete process.env['FORGE_COORDINATION_DIR'];
    const result = await forge(['cutover']);
    expect(result.code).toBe(2);
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
