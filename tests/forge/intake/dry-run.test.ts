/**
 * Guardrails DoD: `forge intake --dry-run` prints the writes it would make, with no live
 * Jira, Sentry, CloudWatch or Codex call — the token named in decision 1
 * (`FORGE_JIRA_TOKEN`) does not exist yet, so dry-run is the only mode this stream ships.
 */
import { describe, expect, it } from 'vitest';

import { planIntakeWrites } from '../../../src/forge/intake/dryRun.js';

describe('planIntakeWrites', () => {
  it('describes each planned write without performing any of them', () => {
    const plan = planIntakeWrites([
      { sourceId: 'SENTRY-9001', what: 'Login screen crashes on cold start' },
      { sourceId: 'BBZ-140', what: 'Backlog item with no assignee' },
    ]);
    expect(plan).toEqual([
      'would create a ticket for SENTRY-9001: Login screen crashes on cold start',
      'would create a ticket for BBZ-140: Backlog item with no assignee',
    ]);
  });

  it('returns an explicit "nothing to do" line for an empty fixture, never a blank plan', () => {
    expect(planIntakeWrites([])).toEqual(['nothing to do: the fixture carried no findings']);
  });
});
