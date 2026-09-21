/**
 * The feed's production wiring, specifically the claim switch. The specimens that matter
 * are the off ones: claiming assigns a real ticket on a shared board to a real person, so
 * every way of not being sure has to leave the feed reply-only.
 */
import { describe, expect, it } from 'vitest';

import { claimEnabled, claimRepos, feedNames } from '../../../src/forge/sync/feed-wire.ts';

const MAP = 'label:fd-e2e=aaronlilla/flightdeck,component:backend=ACME/backend,default=ACME/app';

describe('claimEnabled', () => {
  it('is off unless the variable says on', () => {
    expect(claimEnabled({})).toBe(false);
    expect(claimEnabled({ FORGE_JIRA_CLAIM: '' })).toBe(false);
    expect(claimEnabled({ FORGE_JIRA_CLAIM: 'true' })).toBe(false);
    expect(claimEnabled({ FORGE_JIRA_CLAIM: '1' })).toBe(false);
    expect(claimEnabled({ FORGE_JIRA_CLAIM: 'off' })).toBe(false);
  });

  it('is on for the exact word, whatever the case and spacing', () => {
    expect(claimEnabled({ FORGE_JIRA_CLAIM: 'on' })).toBe(true);
    expect(claimEnabled({ FORGE_JIRA_CLAIM: ' ON ' })).toBe(true);
  });
});

describe('claimRepos', () => {
  it('reads every distinct repo out of the intake map', () => {
    expect(claimRepos({ FORGE_INTAKE_REPO_MAP: MAP }).sort()).toEqual(
      ['ACME/app', 'ACME/backend', 'aaronlilla/flightdeck'].sort(),
    );
  });

  it('names nothing when the map is absent', () => {
    expect(claimRepos({})).toEqual([]);
  });

  it('names nothing when the map is malformed, rather than guessing', () => {
    // A broken map used to throw out of the poll. Reading it as no repos turns every
    // claim into a defer, which is the safe direction for a write to a shared board.
    expect(claimRepos({ FORGE_INTAKE_REPO_MAP: 'label:fd-e2e' })).toEqual([]);
    expect(claimRepos({ FORGE_INTAKE_REPO_MAP: 'nonsense:x=' })).toEqual([]);
  });

  it('does not repeat a repo two rules route to', () => {
    expect(claimRepos({ FORGE_INTAKE_REPO_MAP: 'label:a=ACME/app,default=ACME/app' })).toEqual(['ACME/app']);
  });
});

describe('feedNames', () => {
  it('prefers the configured names', () => {
    expect(feedNames('Aaron Lilla', { FORGE_JIRA_FEED_NAMES: 'Aaron, AL' })).toEqual(['Aaron', 'AL']);
  });

  it('falls back to the first word of the display name', () => {
    expect(feedNames('Aaron Lilla', {})).toEqual(['Aaron']);
    expect(feedNames('', {})).toEqual([]);
  });
});
