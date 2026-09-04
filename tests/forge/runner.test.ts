/**
 * Two things a running worker needs that the old runtime could not do.
 *
 * A message into a live worker. Under the old runtime a note for a running session was
 * delivered before its next tool call, and a session parked at a prompt never made one,
 * so the message never arrived. Here an unread message is injected as `additionalContext`
 * on the very next tool call and marked read, so telling a worker "PR #31 conflicts with
 * master" reaches the model inside one turn rather than whenever it happens to re-read
 * its brief.
 *
 * Base drift. On 2026-09-04 `master` moved four commits under a forty-minute branch and
 * nobody noticed until a person ran `gh pr view` by hand. The supervisor asks instead, and
 * a `CONFLICTING` answer is a blocker rather than a surprise at merge time.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { RunInbox, injectMessages } from '../../src/forge/runinbox.js';
import { driftBlocker, readMergeable } from '../../src/forge/drift.js';
import { Inbox } from '../../src/forge/inbox.js';

let home: string;
let runInbox: RunInbox;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'forge-runner-'));
  process.env['FORGE_HOME'] = home;
  runInbox = new RunInbox('alpha');
});

describe('a message into a running worker', () => {
  it('reaches the very next tool call', async () => {
    runInbox.send('PR #31 conflicts with master; rebase before pushing');
    const output = await injectMessages('alpha', { tool_name: 'Bash' });

    expect(output?.hookSpecificOutput?.additionalContext)
      .toContain('PR #31 conflicts with master');
  });

  it('says nothing when there is nothing waiting', async () => {
    expect(await injectMessages('alpha', { tool_name: 'Bash' })).toBeUndefined();
  });

  it('delivers each message once', async () => {
    runInbox.send('the first thing');
    await injectMessages('alpha', { tool_name: 'Bash' });
    expect(await injectMessages('alpha', { tool_name: 'Bash' })).toBeUndefined();
  });

  it('delivers several waiting messages together rather than one per turn', async () => {
    runInbox.send('the first thing');
    runInbox.send('the second thing');
    const output = await injectMessages('alpha', { tool_name: 'Bash' });

    const text = output?.hookSpecificOutput?.additionalContext ?? '';
    expect(text).toContain('the first thing');
    expect(text).toContain('the second thing');
  });

  it('keeps them in the order they were sent', async () => {
    runInbox.send('first');
    runInbox.send('second');
    const text = (await injectMessages('alpha', { tool_name: 'Bash' }))
      ?.hookSpecificOutput?.additionalContext ?? '';
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
  });

  it('keeps one run\'s messages out of another\'s', async () => {
    runInbox.send('for alpha only');
    expect(await injectMessages('beta', { tool_name: 'Bash' })).toBeUndefined();
  });

  it('marks a message read only once it has been delivered', () => {
    runInbox.send('the thing');
    expect(runInbox.unread()).toHaveLength(1);
    runInbox.markRead(runInbox.unread().map((message) => message.id));
    expect(runInbox.unread()).toHaveLength(0);
  });

  it('never denies the tool call it rides on', async () => {
    runInbox.send('the thing');
    const output = await injectMessages('alpha', { tool_name: 'Bash' });
    expect(output?.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

describe('base drift', () => {
  it('reads MERGEABLE as no blocker', () => {
    expect(driftBlocker('alpha', 'MERGEABLE')).toBeUndefined();
  });

  it('files a blocker on CONFLICTING', () => {
    const blocker = driftBlocker('alpha', 'CONFLICTING');
    expect(blocker?.kind).toBe('blocker');
    expect(blocker?.question).toMatch(/conflict/i);
    expect(blocker?.run).toBe('alpha');
  });

  it('files a blocker on UNKNOWN as well, because unknown is not passing', () => {
    expect(driftBlocker('alpha', 'UNKNOWN')?.kind).toBe('blocker');
  });

  it('keys every run behind one base on the same wall', () => {
    const inbox = new Inbox(join(home, 'inbox'));
    const first = inbox.raise(driftBlocker('alpha', 'CONFLICTING')!);
    const second = inbox.raise(driftBlocker('alpha', 'CONFLICTING')!);
    expect(second.key).toBe(first.key);
    expect(inbox.open()).toHaveLength(1);
  });

  it('reads a mergeable field out of what gh actually prints', () => {
    expect(readMergeable('{"mergeable":"CONFLICTING"}')).toBe('CONFLICTING');
    expect(readMergeable('{"mergeable":"MERGEABLE"}')).toBe('MERGEABLE');
  });

  it('calls unreadable output UNKNOWN rather than assuming it is fine', () => {
    expect(readMergeable('gh: command not found')).toBe('UNKNOWN');
    expect(readMergeable('')).toBe('UNKNOWN');
    expect(readMergeable('{"other":"thing"}')).toBe('UNKNOWN');
  });
});
