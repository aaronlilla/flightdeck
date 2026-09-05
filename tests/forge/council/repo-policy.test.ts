/**
 * forge-council-live: the two allow-lists `forge council` and `forge gate --merge`
 * refuse against. Both default to empty in the checked-in policy file (fail-closed),
 * and both accept an operator's own environment override so a real repo name never has
 * to live in source (`check:agnostic`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { autoMergeAllowed, councilPolicy, repoAllowedForCouncil } from '../../../src/forge/council/risk.ts';

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv['FORGE_COUNCIL_REPOS'] = process.env['FORGE_COUNCIL_REPOS'];
  savedEnv['FORGE_COUNCIL_AUTOMERGE'] = process.env['FORGE_COUNCIL_AUTOMERGE'];
  delete process.env['FORGE_COUNCIL_REPOS'];
  delete process.env['FORGE_COUNCIL_AUTOMERGE'];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('councilPolicy allow-lists', () => {
  it('the checked-in default refuses every repo (fail-closed, no repo name in source)', () => {
    const policy = councilPolicy();
    expect(repoAllowedForCouncil('acme/widgets', policy)).toBe(false);
    expect(autoMergeAllowed('acme/widgets', policy)).toBe(false);
  });

  it('FORGE_COUNCIL_REPOS opens the review allow-list without touching the policy file', () => {
    process.env['FORGE_COUNCIL_REPOS'] = 'acme/widgets, acme/sprockets';
    const policy = councilPolicy();
    expect(repoAllowedForCouncil('acme/widgets', policy)).toBe(true);
    expect(repoAllowedForCouncil('acme/sprockets', policy)).toBe(true);
    expect(repoAllowedForCouncil('acme/gizmos', policy)).toBe(false);
  });

  it('FORGE_COUNCIL_AUTOMERGE opens the merge allow-list independently of the review list', () => {
    process.env['FORGE_COUNCIL_REPOS'] = 'acme/widgets';
    process.env['FORGE_COUNCIL_AUTOMERGE'] = 'acme/widgets';
    const policy = councilPolicy();
    expect(autoMergeAllowed('acme/widgets', policy)).toBe(true);
    expect(autoMergeAllowed('acme/sprockets', policy)).toBe(false);
  });

  it('codex stays off by default', () => {
    expect(councilPolicy().codex).toBe('off');
  });
});
