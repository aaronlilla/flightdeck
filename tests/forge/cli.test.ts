/**
 * The commands a person types.
 *
 * `stop --all` carries the weight. It is the control reached for when something is going
 * wrong, so the rows below pin the things that make it usable at that moment: it takes no
 * argument it could get wrong, it is safe to run twice, it says plainly when there was
 * nothing to stop, and it parks rather than kills so the work survives.
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { forge } from '../../src/forge/cli.js';
import { Inbox } from '../../src/forge/inbox.js';
import { replayEvents } from '../../src/forge/contracts.js';
import { Journal, replay } from '../../src/forge/journal.js';
import { Registry } from '../../src/forge/registry.js';
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
  // Forge Jira stream: every specimen starts from "nothing configured" and opts in
  // explicitly, so a developer's own shell (or a prior specimen) never leaks a value in.
  for (const name of [
    'FORGE_JIRA_SITE', 'FORGE_JIRA_EMAIL', 'FORGE_JIRA_TOKEN', 'FORGE_JIRA_JQL',
    'FORGE_JIRA_QA_ACCOUNT', 'FORGE_JIRA_QA_TRANSITION', 'FORGE_INTAKE_REPO_MAP',
  ]) {
    delete process.env[name];
  }
});

const lanes = () => new Lanes(join(home, 'lanes'));
const journal = () => join(home, 'fleet.jsonl');
const registry = () => new Registry(join(home, 'registry'));

/** Admits a live registry row for `goal`, backed by this test process's own pid: what
 *  `forge stop --all` (P4.7/I8) actually reads to decide a run is live, never a lane
 *  record's own verdict. Each goal gets its own cwd, since the registry refuses a second
 *  live admission sharing a working tree. */
function admitLive(goal: string): void {
  registry().admit({
    goal, cwd: join(home, goal), briefPath: join(home, `${goal}.md`), pid: process.pid,
  });
}

describe('forge stop --all', () => {
  it('parks every live run and names the count, without claiming a live session was stopped', async () => {
    lanes().put('alpha', { column: 'c', session_id: 's1', started: Date.now() });
    lanes().put('beta', { column: 'd', session_id: 's2', started: Date.now() });
    admitLive('alpha');
    admitLive('beta');

    const result = await forge(['stop', '--all']);

    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/parked 2 run\(s\)/);
    // The falsifier this closes: no wording may claim spend already stopped while a
    // session could still be mid-turn.
    expect(result.lines.join(' ')).not.toMatch(/all spend has stopped/);
    // B.3.2/P4.7/I8: this process holds no live session for either run (a separate
    // `forge stop` invocation never does), so each is contacted through its own
    // goal-scoped inbox rather than directly. `reached` names whether that write
    // succeeded, which it does here, not whether the run has actually parked yet.
    expect(result.lines[0]).toMatch(/reached 2, unreachable 0/);
    expect(result.lines.join(' ')).toMatch(/reached {2}alpha/);
    expect(result.lines.join(' ')).toMatch(/reached {2}beta/);
    expect(result.lines.join(' ')).toMatch(/kill switch/i);
  });

  it('P4.7/I8: selects from the registry\'s live rows, never a lane record\'s own verdict', async () => {
    // The 2026-09-04 C1b failure: a lane file left from a finished chain still says
    // `verdict: 'done'`, but the goal is genuinely live right now (this test process's own
    // pid). `forge stop --all` must still reach it, and must list a stale registry row
    // (a dead pid, no live process behind it any more) separately, never as parked.
    lanes().put('forge-live-probe', { column: 'forge', verdict: 'done', ended: 1 });
    admitLive('forge-live-probe');
    registry().admit({
      goal: 'morning-run', cwd: join(home, 'morning-run'), briefPath: join(home, 'm.md'), pid: 999_999,
    });

    const result = await forge(['stop', '--all']);

    expect(result.lines[0]).toMatch(/parked 1 run\(s\)/);
    expect(result.lines[0]).toMatch(/1 stale/);
    expect(result.lines.join(' ')).toMatch(/reached {2}forge-live-probe/);
    expect(result.lines.join(' ')).toMatch(/stale {7}morning-run/);
  });

  it('is safe to run twice', async () => {
    admitLive('alpha');
    await forge(['stop', '--all']);
    const again = await forge(['stop', '--all']);
    expect(again.code).toBe(0);
    // The registry row survives a stop (only the run itself removes it, on exit), so a
    // second stop still reaches it rather than reporting nothing was running.
    expect(again.lines[0]).toMatch(/parked 1 run\(s\)/);
  });

  it('says plainly when there was nothing to stop', async () => {
    const result = await forge(['stop', '--all']);
    expect(result.code).toBe(0);
    expect(result.lines).toEqual([
      'nothing was running',
      'the kill switch is set: no new launch starts until forge clear --all',
    ]);
  });

  it('refuses a bare stop, so nothing is half-stopped by a typo', async () => {
    admitLive('alpha');
    const result = await forge(['stop']);
    expect(result.code).toBe(2);
    expect(replay(journal()).events.some((e) => e.event === 'run.parked')).toBe(false);
  });

  it('journals a handoff request for every live run it parked', async () => {
    admitLive('alpha');
    await forge(['stop', '--all']);
    const parked = replay(journal()).events.filter((e) => e.event === 'run.parked');
    expect(parked).toHaveLength(1);
    expect(parked[0]?.['handoffRequested']).toBe(true);
  });

  it('carries the reason into the record', async () => {
    admitLive('alpha');
    await forge(['stop', '--all', 'the', 'window', 'is', 'nearly', 'spent']);
    const parked = replay(journal()).events.find((e) => e.event === 'run.parked');
    expect(String(parked?.['reason'])).toMatch(/window is nearly spent/);
  });
});

describe('forge status', () => {
  it('shows model, context and cost per lane', async () => {
    lanes().put('alpha', {
      column: 'c', model: 'claude-sonnet-5', context: 42_000, cost_usd: 1.25,
    });
    const result = await forge(['status'], { processes: () => [] });
    const text = result.lines.join('\n');
    expect(text).toContain('claude-sonnet-5');
    expect(text).toContain('42000');
    expect(text).toContain('$1.25');
  });

  it('says a lane needs Aaron rather than showing it as running', async () => {
    lanes().put('flappy', { column: 'c', needs_aaron: 'three bad starts' });
    expect((await forge(['status'], { processes: () => [] })).lines.join('\n')).toContain('NEEDS AARON');
  });

  it('says so when nothing is running', async () => {
    expect((await forge(['status'], { processes: () => [] })).lines).toEqual(['nothing is running']);
  });

  /**
   * The actual incident: a CI runner's process probe outlasted vitest's 5-second test
   * timeout, and no specimen here had any way to avoid it -- `status` always called the
   * real reader with no override. `deps.processes` fixes that; this specimen proves the
   * fix is wired, not just declared, by counting calls on a fake reader rather than
   * timing anything (a sleep-based proof would either pass trivially pre-fix, since an
   * unwired dependency is never invoked either way, or make the suite itself flaky and
   * slow in exchange for no more certainty). If `status` ever stops reading through
   * `deps.processes` -- back to calling the real prober directly, or calling both -- this
   * count stops being exactly 1 and the specimen goes red.
   */
  it('reads the fleet through the injected processes reader, never the real process table', async () => {
    lanes().put('alpha', {
      column: 'c', model: 'claude-sonnet-5', context: 1_000, cost_usd: 0,
    });
    let calls = 0;
    const result = await forge(['status'], {
      processes: () => {
        calls += 1;
        return [];
      },
    });
    expect(calls).toBe(1);
    expect(result.lines.join('\n')).toContain('claude-sonnet-5');
  });

  /**
   * The 2026-09-05 escape, at the command that actually printed it: `forge status`
   * opened with three `STUCK stale-session` rows for pids that were never fleet
   * workers -- two of Aaron's own interactive terminals and the Chrome extension's
   * native host. Genericised from the real 2026-09-05 lines (`fleetwatch.test.ts`
   * carries the same three, plus a real SDK worker and a `claude login` for
   * comparison). None of the three should ever appear as STUCK; the two kinds status
   * still watches get exactly one row each, and everything else collapses into one
   * quiet line.
   */
  it('never reports an interactive terminal or the Chrome native host as STUCK, and says so in one line', async () => {
    const result = await forge(['status'], {
      processes: () => [
        '35256 C:\\Users\\<user>\\.local\\bin\\claude.exe --dangerously-skip-permissions',
        '50664 "C:\\Users\\<user>\\.local\\bin\\claude.exe"  "--chrome-native-host"',
        '31120 C:\\Users\\<user>\\.local\\bin\\claude.exe --dangerously-skip-permissions',
      ],
    });
    const text = result.lines.join('\n');
    expect(text).not.toContain('STUCK');
    expect(text).toContain('2 interactive claude sessions and 1 native host, not fleet, not watched');
  });

  it('still reports a real worker as STUCK stale-session, unaffected by the native-host quiet line', async () => {
    // A stale fleet session file, planted directly under this test's own FORGE_CONFIG_DIR
    // (set in beforeEach) -- what makes `watchedProcesses` read a real worker's
    // sessionFileMtime as more than staleSessionMs old.
    const account = process.env['FORGE_CONFIG_DIR']!;
    const sessionsDir = join(account, 'projects');
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, 'session.json');
    writeFileSync(sessionFile, '{}', 'utf8');
    const staleAt = new Date(Date.now() - 6 * 60_000);
    utimesSync(sessionFile, staleAt, staleAt);

    const result = await forge(['status'], {
      processes: () => [
        '40200 "C:\\Users\\<user>\\.local\\bin\\claude.exe" --output-format stream-json '
          + '--verbose --input-format stream-json',
        '50664 "C:\\Users\\<user>\\.local\\bin\\claude.exe"  "--chrome-native-host"',
      ],
    });
    const text = result.lines.join('\n');
    expect(text).toContain('STUCK  pid:40200');
    expect(text).toContain('stale-session');
    expect(text).not.toContain('interactive claude session');
    expect(text).toContain('1 native host, not fleet, not watched');
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
  it('B.3.9: refuses a non-numeric --max-context rather than launching with a NaN ceiling', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const result = await forge(['run', brief, '--max-context', 'abc']);
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/--max-context needs a number/);
    expect(lanes().get('ok')).toBeUndefined();
  });

  it('B.3.9: refuses a --max-turns with no value at all', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const result = await forge(['run', brief, '--max-turns']);
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/--max-turns needs a number/);
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

  it('item 8, 2026-09-05: refuses --auto-answer for a brief under a real goals directory', async () => {
    const goalsDir = join(home, 'goals');
    mkdirSync(goalsDir, { recursive: true });
    const brief = join(goalsDir, 'real-goal.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    const result = await forge(['run', brief, '--auto-answer', 'yes']);

    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/--auto-answer/);
  });

  it('item 8, 2026-09-05: allows --auto-answer for a brief under a goals directory\'s own logs/', async () => {
    const logsDir = join(home, 'goals', 'logs');
    mkdirSync(logsDir, { recursive: true });
    const brief = join(logsDir, 'probe.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    const result = await forge(['run', brief, '--dry-run', '--auto-answer', 'yes']);

    expect(result.code).toBe(0);
  });

  it('says which brief it could not read rather than failing silently', async () => {
    const result = await forge(['run', join(home, 'missing.md')]);
    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatch(/cannot read/);
  });

  it('with the fake engine injected, calls it once with the brief\'s content', async () => {
    const brief = join(home, 'ok.md');
    const briefText = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    writeFileSync(brief, briefText, 'utf8');

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
    expect((started[0] as { prompt: string }).prompt).toBe(briefText);
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
      // A zero-turn start never ran forge_done, so it parks: exit 2, per B.3.4.
      expect(result.code).toBe(2);
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
    // The clear let it launch again; it still parks with no turns, so exit 2, not a
    // refusal (1) and not done (0).
    expect(result.code).toBe(2);
  });

  it('I11: forge clear --phantoms removes a pid_N run directory with no registry row, journals the count, and leaves a real run alone', async () => {
    const runsPath = join(home, 'runs');
    mkdirSync(join(runsPath, 'pid_9999'), { recursive: true });
    writeFileSync(
      join(runsPath, 'pid_9999', 'park.json'),
      JSON.stringify({ key: 'warden:pid:9999', reason: 'stale session', at: Date.now() }),
      'utf8',
    );
    admitLive('r1');
    mkdirSync(join(runsPath, 'r1'), { recursive: true });

    const result = await forge(['clear', '--phantoms']);

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/removed 1 phantom/);
    expect(existsSync(join(runsPath, 'pid_9999'))).toBe(false);
    expect(existsSync(join(runsPath, 'r1'))).toBe(true);

    const state = replay(journal());
    const rows = state.events.filter((e) => e.event === 'phantoms.cleared');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['count']).toBe(1);
  });

  it('I11: forge clear --phantoms says plainly when there is nothing to clear', async () => {
    const result = await forge(['clear', '--phantoms']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/no phantom/);
  });

  /** Item 4, 2026-09-05: sets a lane file's mtime to `ageMs` in the past, which is what
   *  `forge clear --stale` and `forge status`'s age filter both read a lane's age from. */
  function ageLane(slug: string, ageMs: number): void {
    const path = join(home, 'lanes', `${slug}.json`);
    const at = new Date(Date.now() - ageMs);
    utimesSync(path, at, at);
  }

  it('forge clear --stale removes a finished lane over a day old with no registry row', async () => {
    lanes().put('old-finished', { column: 'forge', verdict: 'done' });
    ageLane('old-finished', 25 * 3_600_000);
    lanes().put('recent-finished', { column: 'forge', verdict: 'done' });
    lanes().put('old-registered', { column: 'forge', verdict: 'exhausted' });
    ageLane('old-registered', 25 * 3_600_000);
    admitLive('old-registered');
    lanes().put('old-never-finished', { column: 'forge' });
    ageLane('old-never-finished', 25 * 3_600_000);

    const result = await forge(['clear', '--stale']);

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/removed 1 stale lane/);
    expect(existsSync(join(home, 'lanes', 'old-finished.json'))).toBe(false);
    expect(existsSync(join(home, 'lanes', 'recent-finished.json'))).toBe(true);
    expect(existsSync(join(home, 'lanes', 'old-registered.json'))).toBe(true);
    expect(existsSync(join(home, 'lanes', 'old-never-finished.json'))).toBe(true);

    const state = replay(journal());
    const rows = state.events.filter((e) => e.event === 'lanes.cleared');
    expect(rows).toHaveLength(1);
    expect(rows[0]!['count']).toBe(1);
  });

  it('forge clear --stale says plainly when there is nothing to clear', async () => {
    const result = await forge(['clear', '--stale']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/no stale lane/);
  });

  it('forge status hides a lane over a day old', async () => {
    lanes().put('ancient', { column: 'forge', model: 'claude-sonnet-5', verdict: 'done' });
    ageLane('ancient', 25 * 3_600_000);
    lanes().put('fresh', { column: 'forge', model: 'claude-sonnet-5', verdict: 'done' });

    const hidden = await forge(['status'], { processes: () => [] });
    expect(hidden.lines.join('\n')).not.toContain('ancient');
    expect(hidden.lines.join('\n')).toContain('fresh');

    const shown = await forge(['status', '--all'], { processes: () => [] });
    expect(shown.lines.join('\n')).toContain('ancient');
  });

  it('refuses once forge stop --all has engaged the kill switch', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');

    await forge(['stop', '--all']);
    const result = await forge(['run', brief]);

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/kill switch/i);
  });

  it('starts again once forge clear --all has cleared the kill switch', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n', 'utf8');
    const started: SessionRequest[] = [];
    const engine = {
      started,
      async run(config: SessionRequest) {
        started.push(config);
        return { sessionId: 'fake-session', turns: [{ text: 'done', context: 10, done: true }] };
      },
    };

    await forge(['stop', '--all']);
    await forge(['clear', '--all']);
    const result = await forge(['run', brief], { engine });

    expect(result.code).toBe(0);
    expect(started).toHaveLength(1);
  });

  it('B.3.4: exits 2 when verification never passes and the run parks', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnpm run verify\n```\n', 'utf8');
    const engine = {
      started: [] as SessionRequest[],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: 'fake-session', turns: [{ text: 'done', context: 10, done: true }] };
      },
    };
    const exec = async () => ({
      ok: false, tail: 'FAIL', returncode: 1, argv: ['npm', 'run', 'verify'], owner: 'ok',
      startedAt: 0, durationMs: 1,
    });

    const result = await forge(['run', brief], { engine, exec });

    expect(result.code).toBe(2);
    expect(result.lines[0]).toMatch(/parked/);
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

describe('forge intake --dry-run', () => {
  it('prints the writes it would make and performs none of them', async () => {
    const result = await forge(['intake', '--dry-run']);
    expect(result.code).toBe(0);
  });

  it('refuses a form that is neither --dry-run nor --once', async () => {
    const result = await forge(['intake']);
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/--dry-run|--once/);
  });
});

describe('P4.7/I5: forge intake --once', () => {
  it('with no feeds configured, polls nothing and says so honestly', async () => {
    const result = await forge(['intake', '--once']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/0 source/);
  });

  it('with fixture feeds injected, journals source.observed, packet.written and external.intent', async () => {
    const intakeFeeds = [{
      name: 'jira' as const,
      fetchSince: async () => [{ id: 'BBZ-1', updated: 100 }],
    }];

    const result = await forge(['intake', '--once'], { intakeFeeds });

    expect(result.code).toBe(0);
    const state = replay(journal());
    expect(state.events.some((e) => e.event === 'source.observed')).toBe(true);
    expect(state.events.some((e) => e.event === 'packet.written')).toBe(true);
    expect(state.events.some((e) => e.event === 'external.intent')).toBe(true);
  });

  it('makes no live call: a fixture feed with no client behind it never throws a network error', async () => {
    const intakeFeeds = [{ name: 'sentry' as const, fetchSince: async () => [] }];
    const result = await forge(['intake', '--once'], { intakeFeeds });
    expect(result.code).toBe(0);
  });

  it('forge-council-live: a newly written packet gets a planned brief from a fake Reasoner answer', async () => {
    const intakeFeeds = [{
      name: 'jira' as const,
      fetchSince: async () => [{ id: 'BBZ-2', updated: 200 }],
    }];
    function fakePlannerQuery(text: string) {
      return ((params: { prompt: string | AsyncIterable<unknown>; options?: { model?: string; cwd?: string } }) => {
        const promptIter = params.prompt as AsyncIterable<unknown>;
        async function* generate() {
          yield {
            type: 'system', subtype: 'init', session_id: 'planner-cli-session',
            model: params.options?.model ?? '', cwd: params.options?.cwd ?? '', tools: [], slash_commands: [],
          };
          for await (const _pushed of promptIter) {
            yield {
              type: 'assistant', session_id: 'planner-cli-session',
              message: {
                model: params.options?.model ?? '',
                content: [{ type: 'text', text: JSON.stringify({ text }) }],
                usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
              },
            };
            yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 };
            return;
          }
        }
        return generate() as never;
      }) as never;
    }

    const result = await forge(['intake', '--once'], {
      intakeFeeds, reasonerQueryFn: fakePlannerQuery('# Goal: fix BBZ-2\n'),
    });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/planned a brief/);
    const state = replay(journal());
    const planned = state.events.find((e) => e.event === 'intake.planned');
    expect(planned).toBeTruthy();
    const briefPath = String(planned?.['briefPath']);
    expect(readFileSync(briefPath, 'utf8')).toContain('# Goal: fix BBZ-2');
  });
});

describe('R1: FORGE_INTAKE_REPO_MAP routing for forge intake --once', () => {
  it('with no map, prints one line per unrouted packet naming the ticket, labels and components', async () => {
    const intakeFeeds = [{
      name: 'jira' as const,
      fetchSince: async () => [{
        id: 'BBZ-6', updated: 100,
        detail: {
          summary: 'x', description: '', status: 'Open', issuetype: 'Bug', priority: 'High',
          labels: ['other'], components: ['api'],
        },
      }],
    }];
    const result = await forge(['intake', '--once'], { intakeFeeds });
    expect(result.code).toBe(0);
    const line = result.lines.join(' ');
    expect(line).toContain('BBZ-6');
    expect(line).toContain('other');
    expect(line).toContain('api');
  });

  it('a matching rule routes the ticket, and no unrouted line is printed for it', async () => {
    process.env['FORGE_INTAKE_REPO_MAP'] = 'label:mobile=owner/frontend';
    const intakeFeeds = [{
      name: 'jira' as const,
      fetchSince: async () => [{
        id: 'BBZ-7', updated: 100,
        detail: {
          summary: 'x', description: '', status: 'Open', issuetype: 'Bug', priority: 'High',
          labels: ['mobile'], components: [],
        },
      }],
    }];
    const result = await forge(['intake', '--once'], { intakeFeeds });
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).not.toMatch(/unrouted/);
  });
});

describe('Forge Jira stream: J1 env wiring for forge intake --once', () => {
  it('missing environment yields the honest zero-source line plus one line naming the missing variables, never their values', async () => {
    const result = await forge(['intake', '--once']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toMatch(/0 source.*\(none configured\)/);
    expect(result.lines.join(' ')).toContain('FORGE_JIRA_SITE');
    expect(result.lines.join(' ')).toContain('FORGE_JIRA_EMAIL');
    expect(result.lines.join(' ')).toContain('FORGE_JIRA_TOKEN');
  });

  it('with all three variables set, wires a real Jira feed through the injected fetch, with no site or token in the output', async () => {
    process.env['FORGE_JIRA_SITE'] = 'https://acme.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'bot@acme.test';
    process.env['FORGE_JIRA_TOKEN'] = 'a-real-looking-secret-token-value-123456';
    const fetchFn = (async () => new Response(JSON.stringify({
      issues: [{ key: 'BBZ-9', fields: { summary: 'x', updated: '2026-09-01T00:00:00.000Z' } }], isLast: true,
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await forge(['intake', '--once'], { fetchFn });

    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toContain('1 source(s): jira');
    expect(result.lines.join(' ')).not.toContain(process.env['FORGE_JIRA_TOKEN']);
    expect(result.lines.join(' ')).not.toContain('acme.atlassian.net');
  });
});

describe('Forge Jira stream: J4 forge intake --probe-jira', () => {
  it('prints displayName and accountId only, on success', async () => {
    process.env['FORGE_JIRA_SITE'] = 'https://acme.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'bot@acme.test';
    process.env['FORGE_JIRA_TOKEN'] = 'a-real-looking-secret-token-value-123456';
    const fetchFn = (async () => new Response(JSON.stringify({ displayName: 'Aaron Lilla', accountId: 'acc-1' }), {
      status: 200,
    })) as unknown as typeof fetch;

    const result = await forge(['intake', '--probe-jira'], { fetchFn });

    expect(result.code).toBe(0);
    expect(result.lines).toEqual(['Aaron Lilla', 'acc-1']);
  });

  it('a failing call exits 1 with the HTTP status and nothing else', async () => {
    process.env['FORGE_JIRA_SITE'] = 'https://acme.atlassian.net';
    process.env['FORGE_JIRA_EMAIL'] = 'bot@acme.test';
    process.env['FORGE_JIRA_TOKEN'] = 'a-real-looking-secret-token-value-123456';
    const fetchFn = (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch;

    const result = await forge(['intake', '--probe-jira'], { fetchFn });

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toContain('403');
  });
});

describe('F4: forge run releases what the engine held before it returns', () => {
  it('awaits the engine close() before forge() itself resolves', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n', 'utf8');

    let closed = false;
    let closedBeforeReturn = false;
    const engine = {
      started: [] as SessionRequest[],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: 'fake-session', turns: [{ text: 'shipped', context: 10, done: true }] };
      },
      async close() {
        // A resolved microtask delay: proves `forge()` genuinely awaits this rather than
        // firing it and moving on, which is exactly what let the SDK child outlive the
        // process in the live probe.
        await Promise.resolve();
        closed = true;
      },
    };

    const resultPromise = forge(['run', brief], { engine });
    closedBeforeReturn = closed;
    await resultPromise;

    expect(closedBeforeReturn).toBe(false);
    expect(closed).toBe(true);
  });

  it('the falsifier: a close() that is fired without awaiting would still read as done', async () => {
    // Same brief and engine shape, but this proves the specimen above is actually checking
    // something: an engine whose close() never resolves must make forge() hang rather than
    // silently return, or the await above is not being honoured at all.
    const brief = join(home, 'ok2.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n', 'utf8');

    const engine = {
      started: [] as SessionRequest[],
      async run(config: SessionRequest) {
        this.started.push(config);
        return { sessionId: 'fake-session', turns: [{ text: 'shipped', context: 10, done: true }] };
      },
      close: () => new Promise<void>(() => {}), // never resolves
    };

    const raced = await Promise.race([
      forge(['run', brief], { engine }).then(() => 'resolved' as const),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ]);
    expect(raced).toBe('timed-out');
  });
});

describe('forge decide', () => {
  it('refuses any action but kill, and refuses a bare run with no reason', async () => {
    const result = await forge(['decide', 'r1', 'nudge', 'because']);
    expect(result.code).toBe(2);
  });

  it('journals a decision.made row naming the run, kill and the reason, and returns its id', async () => {
    const result = await forge(['decide', 'r1', 'kill', 'stuck', 'for', 'an', 'hour']);
    expect(result.code).toBe(0);
    // decide is the only place a decision.made row is written: reading it back off the
    // real journal, rather than trusting the CLI's own printed line, is what proves the
    // id forge decide hands back is the same id a kill actually has to find later.
    const { events } = replayEvents(readFileSync(journal(), 'utf8'));
    const decision = events.find((event) => event.event === 'decision.made');
    expect(decision?.run).toBe('r1');
    expect(decision?.['action']).toBe('kill');
    expect(decision?.['reason']).toBe('stuck for an hour');
    expect(result.lines.join(' ')).toMatch(new RegExp(`decision ${decision?.id} recorded: kill r1`));
  });
});

describe('C2: forge chain', () => {
  function seedBlockedPacket(): void {
    const j = new Journal(journal());
    j.append({ event: 'intake.planned', actor: 'intake', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' });
    j.append({ event: 'chain.blocked', actor: 'chain', packetId: 'p1', hop: 'provision', reason: 'spawn npm ENOENT' });
    j.close();
  }

  it('with no packet id, prints the same chain rows forge status shows', async () => {
    seedBlockedPacket();
    const result = await forge(['chain']);
    expect(result.code).toBe(0);
    expect(result.lines.join(' ')).toContain('ABC-1');
  });

  it('retry journals chain.unblocked with the packet id and an optional reason', async () => {
    seedBlockedPacket();
    const result = await forge(['chain', 'retry', 'p1', '--reason', 'shell fix landed']);
    expect(result.code).toBe(0);

    const { events } = replayEvents(readFileSync(journal(), 'utf8'));
    const unblocked = events.find((event) => event.event === 'chain.unblocked');
    expect(unblocked?.['packetId']).toBe('p1');
    expect(unblocked?.['reason']).toBe('shell fix landed');
  });

  it('retry folds as not blocked and the row no longer shows the old reason', async () => {
    seedBlockedPacket();
    await forge(['chain', 'retry', 'p1']);

    // `processes: () => []` pins this to a genuinely clean fleet -- no lanes, no
    // waiting asks, no fleet notice -- which is exactly what a fresh CI runner looks
    // like and exactly the case that fell through `status`'s "nothing is running"
    // shortcut before that shortcut accounted for chain rows.
    const statusResult = await forge(['status'], { processes: () => [] });
    const chainLine = statusResult.lines.find((line) => line.includes('ABC-1'));
    expect(chainLine).toBeDefined();
    expect(chainLine).not.toContain('ENOENT');
  });

  it('2026-09-05 CI escape: forge status shows a chain packet even on an otherwise '
    + 'completely idle fleet (no lanes, no asks, no fleet notice)', async () => {
    seedBlockedPacket();
    const result = await forge(['status'], { processes: () => [] });
    expect(result.lines.join(' ')).not.toBe('nothing is running');
    expect(result.lines.join(' ')).toContain('ABC-1');
  });

  it('retry on an unknown packet id is refused with exit 2', async () => {
    const result = await forge(['chain', 'retry', 'no-such-packet']);
    expect(result.code).toBe(2);
  });

  it('retry with no packet id is refused with exit 2', async () => {
    const result = await forge(['chain', 'retry']);
    expect(result.code).toBe(2);
  });
});

describe('D2: forge chain skip', () => {
  function seedPlannedPacket(): void {
    const j = new Journal(journal());
    j.append({ event: 'intake.planned', actor: 'intake', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' });
    j.close();
  }

  function seedLaunchedPacket(): void {
    const j = new Journal(journal());
    j.append({ event: 'intake.planned', actor: 'intake', packetId: 'p1', ticket: 'ABC-1', repo: 'owner/name', briefPath: 'C:/briefs/p1.md' });
    j.append({ event: 'chain.provisioned', actor: 'chain', packetId: 'p1', worktreePath: 'C:/wt', branch: 'feature/abc-1', base: 'develop' });
    j.append({ event: 'chain.launched', actor: 'chain', packetId: 'p1', runKey: 'abc-1' });
    j.close();
  }

  it('journals chain.stopped with reason skipped, plus the given reason, for a planned packet', async () => {
    seedPlannedPacket();
    const result = await forge(['chain', 'skip', 'p1', '--reason', 'ticket merged hours ago']);
    expect(result.code).toBe(0);

    const { events } = replayEvents(readFileSync(journal(), 'utf8'));
    const stopped = events.find((event) => event.event === 'chain.stopped');
    expect(stopped?.['packetId']).toBe('p1');
    expect(String(stopped?.['reason'])).toContain('skipped');
    expect(String(stopped?.['reason'])).toContain('ticket merged hours ago');
  });

  it('a skipped planned packet folds as terminal and forge chain shows it skipped', async () => {
    seedPlannedPacket();
    await forge(['chain', 'skip', 'p1']);

    const result = await forge(['chain']);
    const row = result.lines.find((line) => line.includes('ABC-1'));
    expect(row).toBeDefined();
    expect(row).toContain('skipped');
  });

  it('a launched packet cannot be skipped: exit 2, points at forge stop', async () => {
    seedLaunchedPacket();
    const result = await forge(['chain', 'skip', 'p1']);
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/forge stop/);

    // Refused, so no chain.stopped row was written.
    const { events } = replayEvents(readFileSync(journal(), 'utf8'));
    expect(events.find((event) => event.event === 'chain.stopped')).toBeUndefined();
  });

  it('skip on an unknown packet id is refused with exit 2', async () => {
    const result = await forge(['chain', 'skip', 'no-such-packet']);
    expect(result.code).toBe(2);
  });

  it('skip with no packet id is refused with exit 2', async () => {
    const result = await forge(['chain', 'skip']);
    expect(result.code).toBe(2);
  });
});

describe('P4.7/I2: CredentialHorizon consulted before every launch', () => {
  it('refuses to launch a second run on an account whose login flow is already in flight', async () => {
    const { acquireLoginLock } = await import('../../src/forge/credential-horizon.js');
    const account = process.env['FORGE_CONFIG_DIR']!;
    acquireLoginLock(account, { pid: process.pid, startedAt: Date.now() }, () => true);

    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const result = await forge(['run', brief]);

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/credential horizon|login.*(flight|already)/i);
  });

  it('launches normally when no login flow is in flight for the account', async () => {
    const brief = join(home, 'ok.md');
    const briefText = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    writeFileSync(brief, briefText, 'utf8');
    const engine = { started: [] as SessionRequest[], async run(config: SessionRequest) { engine.started.push(config); return { sessionId: 's', turns: [{ text: 'done', context: 10, done: true }] }; } };

    const result = await forge(['run', brief], { engine });

    expect(result.code).toBe(0);
  });

  it('a stale lock (dead pid) never blocks a launch', async () => {
    const { acquireLoginLock } = await import('../../src/forge/credential-horizon.js');
    const account = process.env['FORGE_CONFIG_DIR']!;
    // A pid that is certainly not alive on this machine.
    acquireLoginLock(account, { pid: 999_999, startedAt: Date.now() }, () => false);

    const brief = join(home, 'ok.md');
    const briefText = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    writeFileSync(brief, briefText, 'utf8');
    const engine = { started: [] as SessionRequest[], async run(config: SessionRequest) { engine.started.push(config); return { sessionId: 's', turns: [{ text: 'done', context: 10, done: true }] }; } };

    const result = await forge(['run', brief], { engine });

    expect(result.code).toBe(0);
  });
});

describe('P4.7/I9: the conformance park is live on forge run', () => {
  it('parks and journals when the served model does not match the class, with no actuator injected by the test', async () => {
    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const engine = {
      started: [] as SessionRequest[],
      async run(config: SessionRequest) {
        engine.started.push(config);
        // A model this run's class does not ask for: worker.ts's own conformance check
        // fires on the very turn a served model stops matching, never after N turns.
        return { sessionId: 's', turns: [{ text: 'first turn', context: 10, model: 'claude-opus-5' }] };
      },
    };

    // I9's own falsifier: no `actuator` field exists on ForgeDeps, so this specimen has
    // no way to inject one -- the park has to come from cli.ts's own wiring or not at all.
    const result = await forge(['run', brief], { engine });

    expect(result.code).toBe(2);
    const { events } = replayEvents(readFileSync(journal(), 'utf8'));
    const parked = events.find((e) => e.event === 'warden.parked' || e.event === 'governor.parked');
    expect(parked).toBeTruthy();
    expect(result.lines.join(' ')).toMatch(/parked/);
  });
});

describe('P4.7/I3: checkBudget at admission', () => {
  it('refuses to launch when today\'s burn is already at or over the daily cap', async () => {
    const { Journal } = await import('../../src/forge/journal.js');
    const j = new Journal(journal());
    j.append({
      event: 'run.started', run: 'prior', actor: 'runner', model: 'claude-sonnet-5', className: 'triage',
    });
    j.append({
      event: 'result.usage', run: 'prior', actor: 'runner', model: 'claude-sonnet-5',
      modelUsage: { 'claude-sonnet-5': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUsd: 100_000 } },
    });
    j.close();

    const brief = join(home, 'ok.md');
    writeFileSync(brief, '# Goal\n\nDo the thing.\n', 'utf8');
    const result = await forge(['run', brief]);

    expect(result.code).toBe(1);
    expect(result.lines.join(' ')).toMatch(/budget|daily/i);
  });

  it('launches normally when nothing has been spent yet', async () => {
    const brief = join(home, 'ok.md');
    const briefText = '# Goal\n\nDo the thing.\n\n## Verification\n\n```\nnode -e process.exit(0)\n```\n';
    writeFileSync(brief, briefText, 'utf8');
    const engine = { started: [] as SessionRequest[], async run(config: SessionRequest) { engine.started.push(config); return { sessionId: 's', turns: [{ text: 'done', context: 10, done: true }] }; } };

    const result = await forge(['run', brief], { engine });
    expect(result.code).toBe(0);
  });
});

describe('forge reason', () => {
  /** A fake `query`: one assistant message answering the pushed prompt, then a
   *  `result`. Matches `ClaudeReasoner`'s own single-turn shape. */
  function fakeQuery(text: string) {
    const fn = ((params: { prompt: string | AsyncIterable<unknown>; options?: { model?: string; cwd?: string } }) => {
      const promptIter = params.prompt as AsyncIterable<unknown>;
      async function* generate() {
        yield {
          type: 'system', subtype: 'init', session_id: 'reason-cli-session',
          model: params.options?.model ?? '', cwd: params.options?.cwd ?? '', tools: [], slash_commands: [],
        };
        for await (const _pushed of promptIter) {
          yield {
            type: 'assistant', session_id: 'reason-cli-session',
            message: {
              model: params.options?.model ?? '',
              content: [{ type: 'text', text }],
              usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 },
            },
          };
          yield { type: 'result', subtype: 'success', is_error: false, duration_ms: 1, total_cost_usd: 0 };
          return;
        }
      }
      return generate() as never;
    }) as never;
    return fn;
  }

  it('prints the JSON answer and a journal row id on a valid reply', async () => {
    const result = await forge(
      ['reason', '--class', 'evaluate', 'still', 'on', 'task?'],
      { reasonerQueryFn: fakeQuery('{"text": "yes"}') },
    );
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(JSON.stringify({ text: 'yes' }));
    expect(result.lines[1]).toMatch(/^journal row: /);
    expect(result.lines[1]).not.toMatch(/not found/);
  });

  it('fails with the row id on an invalid reply, and refuses to spawn a real query', async () => {
    const result = await forge(
      ['reason', '--class', 'evaluate', 'not', 'valid', 'json'],
      { reasonerQueryFn: fakeQuery('not json') },
    );
    expect(result.code).toBe(1);
    expect(result.lines[0]).toMatch(/reply was not the required JSON object/);
    expect(result.lines[1]).toMatch(/^journal row: /);
    expect(result.lines[1]).not.toMatch(/not found/);
  });

  it('refuses with a usage line when --class or the prompt is missing', async () => {
    const result = await forge(['reason', '--class', 'evaluate']);
    expect(result.code).toBe(2);
    expect(result.lines.join(' ')).toMatch(/forge reason --class CLASS/);
  });
});

/**
 * F3: an ask whose every run is dead stays open forever, with nothing left to resume if
 * it were answered. `~/.forge/inbox/5ab5510a66092343.json` on 2026-09-04 was "Probe:
 * continue to the end?" asked by three runs, all long gone, and the console still showed
 * it as the one open ask.
 */
describe('F3: stale inbox asks', () => {
  it('forge status counts a stale ask separately from waiting', async () => {
    // A blocker merges across runs by wording alone, the shape the real dead entry was
    // in: three runs sharing one inbox key.
    new Inbox(join(home, 'inbox')).raise({
      run: 'forge-live-probe', kind: 'blocker', question: 'Probe: continue to the end?',
    });
    const result = await forge(['status'], { processes: () => [] });
    expect(result.lines.join('\n')).toMatch(/inbox: 1 waiting \(1 stale\)/);
  });

  it('forge status does not call a live ask stale', async () => {
    admitLive('forge-live-probe');
    new Inbox(join(home, 'inbox')).raise({
      run: 'forge-live-probe', kind: 'blocker', question: 'Probe: continue to the end?',
    });
    const result = await forge(['status'], { processes: () => [] });
    expect(result.lines.join('\n')).toMatch(/inbox: 1 waiting/);
    expect(result.lines.join('\n')).not.toMatch(/stale/);
  });

  it('forge clear --all retires a stale ask and journals inbox.retired', async () => {
    const inbox = new Inbox(join(home, 'inbox'));
    const raised = inbox.raise({
      run: 'forge-live-probe', kind: 'blocker', question: 'Probe: continue to the end?',
    });
    const result = await forge(['clear', '--all']);
    expect(result.code).toBe(0);
    expect(result.lines.join('\n')).toMatch(/retired 1 stale inbox ask/);
    expect(inbox.open()).toHaveLength(0);
    expect(existsSync(join(home, 'inbox', 'retired', `${raised.key}.json`))).toBe(true);

    const journaled = replay(journal());
    const retiredEvent = journaled.events.find((e) => e['event'] === 'inbox.retired');
    expect(retiredEvent).toMatchObject({ key: raised.key, runs: ['forge-live-probe'] });
  });

  it('forge clear --all never retires an ask still backed by a live run', async () => {
    admitLive('forge-live-probe');
    const inbox = new Inbox(join(home, 'inbox'));
    inbox.raise({ run: 'forge-live-probe', kind: 'blocker', question: 'Probe: continue to the end?' });
    const result = await forge(['clear', '--all']);
    expect(result.lines.join('\n')).toMatch(/no stale inbox asks found/);
    expect(inbox.open()).toHaveLength(1);
  });
});
