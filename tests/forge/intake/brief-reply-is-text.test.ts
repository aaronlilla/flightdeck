/**
 * R-101 escape, 2026-09-14: the two callers that want a brief back -- the interview's
 * `writeBrief` and the one-shot `planFromPacket` -- read `text` as the brief itself, so
 * they must ask the reasoner for text rather than inherit the JSON-object default that
 * rejected 57 of 83 real briefs.
 */
import { describe, expect, it } from 'vitest';

import type { Packet, Reasoner } from '../../../src/forge/contracts.js';
import { writeBrief } from '../../../src/forge/intake/interview.js';
import { planFromPacket } from '../../../src/forge/intake/planner.js';

const PACKET: Packet = {
  id: 'queue-ABC-7', ticket: 'ABC-7', what: 'Add a doc file (Task, Low, Backlog)', where: 'jira',
  evidence: ['ABC-7', 'Create docs/x.md.'], confidence: 'low', repo: 'owner/tools', blockedBy: [], at: 1,
};

function recording(): Reasoner & { shapes: (string | undefined)[] } {
  const shapes: (string | undefined)[] = [];
  return {
    provider: 'claude',
    shapes,
    async call(input) {
      shapes.push(input.replyShape);
      return { text: '# Goal: Add a doc file' };
    },
  };
}

describe('brief writers ask for a text reply', () => {
  it('writeBrief', async () => {
    const reasoner = recording();
    const brief = await writeBrief(PACKET, [], reasoner);
    expect(reasoner.shapes).toEqual(['text']);
    // The reasoner's own text is preserved, plus the tier line ensureTierLine adds
    // (opt/tier: complexity routing is on by default, no config to skip it).
    expect(brief.text).toContain('# Goal: Add a doc file');
    expect(brief.text).toContain('tier: standard');
  });

  it('planFromPacket', async () => {
    const reasoner = recording();
    await planFromPacket(PACKET, reasoner);
    expect(reasoner.shapes).toEqual(['text']);
  });
});
