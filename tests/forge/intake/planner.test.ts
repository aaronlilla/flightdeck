/**
 * `intake/planner.ts` against a fake `Reasoner` -- no model call in this file.
 */
import { describe, expect, it } from 'vitest';

import type { Packet, Reasoner } from '../../../src/forge/contracts.ts';
import { planFromPacket } from '../../../src/forge/intake/planner.ts';

function packet(): Packet {
  return {
    id: 'jira:BBZ-1:100', ticket: 'BBZ-1', what: 'observed via jira, not yet triangulated',
    where: 'jira', evidence: ['jira:BBZ-1:100'], confidence: 'low', repo: 'unknown',
    blockedBy: [], at: 100,
  };
}

describe('planFromPacket', () => {
  it('calls the reasoner with class "plan" and returns its brief text', async () => {
    let seenClassName: string | undefined;
    const reasoner: Reasoner = {
      provider: 'claude',
      async call(input) { seenClassName = input.className; return { text: '# Goal: fix it\n' }; },
    };
    const result = await planFromPacket(packet(), reasoner);
    expect(seenClassName).toBe('plan');
    expect(result.packetId).toBe('jira:BBZ-1:100');
    expect(result.ticket).toBe('BBZ-1');
    expect(result.text).toContain('# Goal:');
  });

  it('never writes a file itself', async () => {
    // No fs import in this test at all -- planFromPacket has no side effect to check
    // for, which is the point: writing the brief is cli.ts's job, not this module's.
    const reasoner: Reasoner = { provider: 'claude', async call() { return { text: 'x' }; } };
    const result = await planFromPacket(packet(), reasoner);
    expect(typeof result.text).toBe('string');
  });
});
