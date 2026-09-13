import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { queueSearch } from '../../src/forge/queue-wire.js';

/**
 * The Add box can search the board.
 *
 * Aaron, 2026-09-13: typed `project = BBZ AND assignee = currentUser() AND statusCategory
 * != Done` into the console's Add box and got back "jira not configured: missing
 * FORGE_JIRA_SITE, FORGE_JIRA_EMAIL, FORGE_JIRA_TOKEN" -- while the same server's own
 * ticket reader, built from the same credentials four lines earlier, was answering fine
 * and the Settings row read Connected.
 *
 * The credentials were never the problem. The server takes an optional search and falls
 * back to a stub that throws that sentence; the launcher never passed one, so the search
 * sources (`query`, `backlog`) could not work on any machine, configured or not. The
 * refusal named the one cause that was not true, which is worse than no message.
 *
 * Two rules below: the fallback's honesty is kept (an unconfigured machine still refuses
 * by name), and the launcher has to hand the server a real search.
 */
describe('the search behind a board query', () => {
  it('refuses by name when nothing is configured', async () => {
    const search = queueSearch(() => undefined);
    await expect(search.searchKeys('project = BBZ')).rejects.toThrow(/jira not configured: missing FORGE_JIRA/);
  });
});

describe('the launcher', () => {
  // Read rather than booted: `up` starts a listening server, a queue tick loop and a
  // watcher, so the wiring cannot be observed from a test without running the machine.
  // What is asserted is the defect itself -- the options object carrying no search at all.
  const cli = readFileSync(new URL('../../src/forge/cli.ts', import.meta.url), 'utf8');
  const options = cli.slice(cli.indexOf('new ForgeServer({'));

  it('hands the server a real board search', () => {
    expect(options.slice(0, options.indexOf('});')), 'no queueSearch in the server options')
      .toMatch(/queueSearch:\s*queueSearch\(/);
  });
});
