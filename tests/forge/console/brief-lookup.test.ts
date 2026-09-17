import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { briefFacts, briefIsSelfNamed, briefPathForLane, clearBriefFactsCache } from '../../../src/forge/console/briefLookup.js';

/**
 * A lane's own brief, found without its queue row.
 *
 * The escape, measured live on 2026-09-12: a board tile read `No ticket` over
 * `Untitled run` while the brief on disk behind it opened with a full sentence naming
 * the work and carried `ticket: BBZ-224` three lines down. The lane's brief is resolved
 * through the queue row whose `runKey` matches it, and that row is pruned when the item
 * finishes -- so a brief lane lost its title and its ticket at the moment it completed.
 */

const HEADING = '# Goal: card declines and Worldpay timeouts leave the API as real errors, not a bare 500';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brief-lookup-'));
  mkdirSync(join(dir, 'queue', 'briefs'), { recursive: true });
  return dir;
}

function writeBriefFile(dir: string, id: string, body: string): string {
  const path = join(dir, 'queue', 'briefs', `${id}.md`);
  writeFileSync(path, body, 'utf8');
  return path;
}

beforeEach(() => clearBriefFactsCache());

describe('which lanes name their own brief', () => {
  it('a pasted brief and a hotfix do', () => {
    expect(briefIsSelfNamed('queue-brief-1788955322484')).toBe(true);
    expect(briefIsSelfNamed('hotfix-1788955322484')).toBe(true);
  });

  it('a ticket lane does not — its brief is named by its packet, not its run key', () => {
    expect(briefIsSelfNamed('queue-BBZ-169-Q-c578de30')).toBe(false);
  });

  it('a manual run does not', () => {
    expect(briefIsSelfNamed('2026-09-09-readable-pr-rule-flightdeck')).toBe(false);
  });
});

describe('finding the file', () => {
  it('finds a brief lane its own brief with no queue row involved', () => {
    const dir = home();
    const path = writeBriefFile(dir, 'queue-brief-1788955322484', HEADING);
    expect(briefPathForLane(dir, 'queue-brief-1788955322484')).toBe(path);
  });

  it('answers null when the lane is not one that names its own brief', () => {
    const dir = home();
    writeBriefFile(dir, 'queue-BBZ-169-Q-c578de30', HEADING);
    expect(briefPathForLane(dir, 'queue-BBZ-169-Q-c578de30')).toBeNull();
  });

  it('answers null when no such file is on disk', () => {
    expect(briefPathForLane(home(), 'queue-brief-9999999999999')).toBeNull();
  });
});

describe('what the brief says about itself', () => {
  it('reads the ticket key off its own line', () => {
    const dir = home();
    const path = writeBriefFile(dir, 'queue-brief-1', `${HEADING}\n\nrepo: o/r\nticket: BBZ-224\n`);
    expect(briefFacts(path).ticket).toBe('BBZ-224');
  });

  it('answers null for a brief carrying no ticket line', () => {
    const dir = home();
    expect(briefFacts(writeBriefFile(dir, 'queue-brief-1', HEADING)).ticket).toBeNull();
  });

  it('answers null for a file that is not there, rather than throwing', () => {
    expect(briefFacts(join(home(), 'queue', 'briefs', 'gone.md')).ticket).toBeNull();
  });

  it('re-reads once the file changes, so a cached answer cannot go stale', () => {
    const dir = home();
    const path = writeBriefFile(dir, 'queue-brief-1', `${HEADING}\nticket: BBZ-224\n`);
    expect(briefFacts(path).ticket).toBe('BBZ-224');
    writeFileSync(path, `${HEADING}\nticket: BBZ-999\n`, 'utf8');
    // Move the stamp explicitly: two writes inside one filesystem tick can share an mtime.
    const later = new Date(Date.now() + 5_000);
    utimesSync(path, later, later);
    expect(briefFacts(path).ticket).toBe('BBZ-999');
  });
});
